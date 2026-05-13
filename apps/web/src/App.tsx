import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { DUCKDB_H1B_TABLE, duckDbEngine } from './lib'
import { H1B_SCHEMA, buildSqlGenerationPrompt } from './lib/schema'
import { generateSqlFromNl, type LlmProvider } from './lib/sqlGenerator'
import { validateGeneratedSql } from './lib/sqlSafety'

type QueryResult = {
  columns: string[]
  rows: Record<string, unknown>[]
}

type QueryRun = {
  id: string
  question: string
  sql: string
  result: QueryResult | null
  error: string | null
  ranAt: string
}

const STARTER_QUERIES = [
  'top employers by H1B approvals in 2023',
  'show approvals by country',
  'approval rate by year',
  'average wage by job_title for certified cases',
]

const PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
]

const MODEL_PRESETS_BY_PROVIDER: Record<LlmProvider, readonly string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini', 'o3', 'o3-mini', 'o1'],
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
  openrouter: [
    'gpt-4o-mini',
    'gpt-4o',
    'gpt-4.1',
    'o4-mini',
    'o3-mini',
    'claude-3-7-sonnet-latest',
    'claude-sonnet-4-20250514',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'grok-3',
  ],
}

const CUSTOM_MODEL_VALUE = '__custom_model__'

const DEFAULT_DATASET_URL =
  'https://h1b-nlq-parquet-577479071532-20260511.s3.us-east-1.amazonaws.com/data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1.parquet?v=full_multi_fiscal_noempty_countrynull_20260512'

function App() {
  const [query, setQuery] = useState('top employers by H1B approvals in 2023')
  const [datasetPath, setDatasetPath] = useState(DEFAULT_DATASET_URL)
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('openai')
  const [llmModel, setLlmModel] = useState('gpt-4o-mini')
  const [bypassGuardsByProvider, setBypassGuardsByProvider] = useState<Record<LlmProvider, boolean>>({
    openai: false,
    anthropic: true,
    openrouter: false,
  })
  const [isRunning, setIsRunning] = useState(false)
  const [latestRun, setLatestRun] = useState<QueryRun | null>(null)
  const [history, setHistory] = useState<QueryRun[]>([])
  const modelPresets = MODEL_PRESETS_BY_PROVIDER[llmProvider]
  const usesCustomModel = !modelPresets.includes(llmModel)
  const bypassSqlGuards = bypassGuardsByProvider[llmProvider]

  const chartConfig = useMemo(() => {
    const result = latestRun?.result

    if (!result || result.rows.length === 0 || result.columns.length < 2) {
      return null
    }

    const [firstColumn, ...restColumns] = result.columns
    const numericColumns = restColumns.filter((column) =>
      result.rows.every((row) => {
        const value = row[column]
        return typeof value === 'number' || (!Number.isNaN(Number(value)) && value !== null)
      }),
    )

    const numericColumn =
      numericColumns.find((column) => /count|total|approval|application|record|rate|avg|sum|wage/i.test(column)) ??
      numericColumns[numericColumns.length - 1]

    if (!numericColumn) {
      return null
    }

    const dimensionColumns = result.columns.filter((column) => column !== numericColumn)

    const hasFiscalYearQuarter =
      result.columns.includes('fiscal_year') && result.columns.includes('fiscal_quarter')

    const toChartValue = (row: Record<string, unknown>) => {
      const raw = row[numericColumn]
      const normalized = Number(raw)
      return Number.isFinite(normalized) ? normalized : 0
    }

    if (hasFiscalYearQuarter) {
      const otherDimensions = dimensionColumns.filter(
        (column) => column !== 'fiscal_year' && column !== 'fiscal_quarter',
      )
      const chartRows = result.rows.map((row) => ({
        ...row,
        quarter_label: `FY${String(row.fiscal_year ?? '')} Q${String(row.fiscal_quarter ?? '')}`,
        chart_label:
          otherDimensions.length > 0
            ? `FY${String(row.fiscal_year ?? '')} Q${String(row.fiscal_quarter ?? '')} · ${otherDimensions
                .map((column) => String(row[column] ?? ''))
                .join(' · ')}`
            : `FY${String(row.fiscal_year ?? '')} Q${String(row.fiscal_quarter ?? '')}`,
        chart_value: toChartValue(row),
      }))

      return {
        labelKey: 'chart_label',
        valueKey: 'chart_value',
        chartType: 'bar',
        data: chartRows,
      } as const
    }

    const isTimeSeries = /year|month|date/i.test(firstColumn)
    const isAggregateQuery = /\bgroup\s+by\b|\bcount\s*\(|\bsum\s*\(|\bavg\s*\(|\bmin\s*\(|\bmax\s*\(|\brow_number\s*\(/i.test(
      latestRun?.sql ?? '',
    )

    return {
      labelKey:
        dimensionColumns.length > 1
          ? 'chart_label'
          : (dimensionColumns[0] ?? firstColumn),
      valueKey: 'chart_value',
      chartType: isAggregateQuery ? 'bar' : isTimeSeries ? 'line' : 'bar',
      data: result.rows.map((row) => ({
        ...row,
        chart_label: dimensionColumns.map((column) => String(row[column] ?? '')).join(' · '),
        chart_value: toChartValue(row),
      })),
    } as const
  }, [latestRun])

  const runQuery = async () => {
    if (!query.trim()) {
      return
    }

    setIsRunning(true)

    let generatedSql = ''

    try {
      generatedSql = await generateSqlFromNl({
        query,
        schemaPrompt: buildSqlGenerationPrompt(H1B_SCHEMA, DUCKDB_H1B_TABLE),
        apiKey: llmApiKey,
        provider: llmProvider,
        model: llmModel,
        bypassSqlGuards,
      })

      validateGeneratedSql(generatedSql)

      await duckDbEngine.loadDatasetToH1bTable(datasetPath)
      const result = await duckDbEngine.executeSql(generatedSql)

      const run: QueryRun = {
        id: crypto.randomUUID(),
        question: query,
        sql: generatedSql,
        result,
        error: null,
        ranAt: new Date().toISOString(),
      }

      setLatestRun(run)
      setHistory((previous) => [run, ...previous].slice(0, 25))
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to run query.'
      const missingFilesPattern = /No files found that match the pattern/i
      const message = missingFilesPattern.test(rawMessage)
        ? `${rawMessage}\nHint: run "npm run ui:min" to generate local parquet files, or use an S3 parquet URL.`
        : rawMessage
      const run: QueryRun = {
        id: crypto.randomUUID(),
        question: query,
        sql: generatedSql,
        result: null,
        error: message,
        ranAt: new Date().toISOString(),
      }

      setLatestRun(run)
      setHistory((previous) => [run, ...previous].slice(0, 25))
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <main className="app-shell">
      <section className="hero-band">
        <div>
          <p className="eyebrow">No-DB Analytical Prototype</p>
          <h1>H1B Natural Language Query System</h1>
          <p className="subtitle">
            Natural language to SQL to DuckDB execution on raw CSV/Parquet data, then structured
            table and chart output (fiscal quarters in use).
          </p>
        </div>
      </section>

      <section className="grid-layout">
        <article className="panel settings-panel">
          <h2>Runtime Config</h2>
          <label>
            Dataset URL or local static path
            <input
              value={datasetPath}
              onChange={(event) => setDatasetPath(event.target.value)}
              placeholder={DEFAULT_DATASET_URL}
            />
          </label>
          <label>
            LLM Provider
            <select
              value={llmProvider}
              onChange={(event) => {
                const nextProvider = event.target.value as LlmProvider
                setLlmProvider(nextProvider)

                const nextPresets = MODEL_PRESETS_BY_PROVIDER[nextProvider]
                if (!nextPresets.includes(llmModel)) {
                  setLlmModel(nextPresets[0] ?? '')
                }
              }}
            >
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            LLM Model
            <select
              value={usesCustomModel ? CUSTOM_MODEL_VALUE : llmModel}
              onChange={(event) => {
                const value = event.target.value
                if (value === CUSTOM_MODEL_VALUE) {
                  setLlmModel('')
                  return
                }
                setLlmModel(value)
              }}
            >
              {modelPresets.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              <option value={CUSTOM_MODEL_VALUE}>Custom model id...</option>
            </select>
            {(usesCustomModel || !llmModel) && (
              <input
                value={llmModel}
                onChange={(event) => setLlmModel(event.target.value)}
                placeholder="Enter custom model id"
              />
            )}
            <small>
              Provider routes: OpenAI uses OpenAI API, Anthropic uses Anthropic Messages API,
              OpenRouter uses OpenRouter chat completions.
            </small>
          </label>
          <label>
            LLM API key (required)
            <input
              value={llmApiKey}
              onChange={(event) => setLlmApiKey(event.target.value)}
              type="password"
              placeholder="Required: sk-..."
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={bypassSqlGuards}
              onChange={(event) => {
                const checked = event.target.checked
                setBypassGuardsByProvider((previous) => ({
                  ...previous,
                  [llmProvider]: checked,
                }))
              }}
            />
            Bypass SQL guard rewrites for this provider
          </label>
          <div className="suggestions">
            {STARTER_QUERIES.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  setQuery(suggestion)
                  setLatestRun(null)
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </article>

        <article className="panel query-panel">
          <h2>Ask in Natural Language</h2>
          <div className="query-row">
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="show approvals by country"
              rows={4}
            />
            <button type="button" onClick={runQuery} disabled={isRunning || !llmApiKey.trim()}>
              {isRunning ? 'Running...' : !llmApiKey.trim() ? 'Enter API Key' : 'Run Query'}
            </button>
          </div>

          {latestRun && (
            <div className="run-summary">
              <p>
                <strong>Generated SQL</strong>
              </p>
              <pre>{latestRun.sql || '-- SQL generation failed before output --'}</pre>
              {latestRun.error && <p className="error-text">{latestRun.error}</p>}
            </div>
          )}
        </article>

        <article className="panel result-panel">
          <h2>Results</h2>

          {!latestRun?.result && <p>Run a query to see results.</p>}

          {latestRun?.result && (() => {
            const result = latestRun.result

            return (
              <>
                <p className="result-meta">
                  {result.rows.length} rows · {result.columns.length} columns
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {result.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 100).map((row, index) => (
                        <tr key={index}>
                          {result.columns.map((column) => (
                            <td key={`${index}-${column}`}>{String(row[column] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {chartConfig && (
                  <div className="chart-wrap">
                    <h3>Chart Preview</h3>
                    <ResponsiveContainer width="100%" height={300}>
                      {chartConfig.chartType === 'line' ? (
                        <LineChart data={chartConfig.data}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey={chartConfig.labelKey} />
                          <YAxis tickFormatter={(value) => Number(value).toLocaleString()} width={72} />
                          <Tooltip formatter={(value) => Number(value).toLocaleString()} />
                          <Legend />
                          <Line
                            type="monotone"
                            dataKey={chartConfig.valueKey}
                            stroke="#d97706"
                            strokeWidth={2}
                          />
                        </LineChart>
                      ) : (
                        <BarChart data={chartConfig.data}>
                          <CartesianGrid strokeDasharray="3 3" />
                          <XAxis dataKey={chartConfig.labelKey} />
                          <YAxis tickFormatter={(value) => Number(value).toLocaleString()} width={72} />
                          <Tooltip formatter={(value) => Number(value).toLocaleString()} />
                          <Legend />
                          <Bar dataKey={chartConfig.valueKey} fill="#d97706" />
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )
          })()}
        </article>

        <article className="panel history-panel">
          <h2>Query History</h2>
          {history.length === 0 && <p>No runs yet.</p>}
          <ul>
            {history.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(run.question)
                    setLatestRun(run)
                  }}
                >
                  {run.question}
                </button>
                <small>{new Date(run.ranAt).toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  )
}

export default App
