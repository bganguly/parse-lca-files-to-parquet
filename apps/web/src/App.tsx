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
import { generateSqlFromNl } from './lib/sqlGenerator'
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

const DEFAULT_DATASET_URL =
  'https://h1b-nlq-parquet-577479071532-20260511.s3.us-east-1.amazonaws.com/data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1.parquet?v=full_multi_fiscal_noempty_y2020plus_20260512'

function App() {
  const [query, setQuery] = useState('top employers by H1B approvals in 2023')
  const [datasetPath, setDatasetPath] = useState(DEFAULT_DATASET_URL)
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmModel, setLlmModel] = useState('gpt-4o-mini')
  const [isRunning, setIsRunning] = useState(false)
  const [latestRun, setLatestRun] = useState<QueryRun | null>(null)
  const [history, setHistory] = useState<QueryRun[]>([])

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
        model: llmModel,
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
            table and chart output.
          </p>
          <p className="subtitle">Fiscal quarter mapping: Q1 Oct-Dec, Q2 Jan-Mar, Q3 Apr-Jun, Q4 Jul-Sep.</p>
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
            LLM Model
            <input
              value={llmModel}
              onChange={(event) => setLlmModel(event.target.value)}
              placeholder="gpt-4o-mini"
            />
          </label>
          <label>
            LLM API key (optional: uses deterministic fallback when empty)
            <input
              value={llmApiKey}
              onChange={(event) => setLlmApiKey(event.target.value)}
              type="password"
              placeholder="sk-..."
            />
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
            <button type="button" onClick={runQuery} disabled={isRunning}>
              {isRunning ? 'Running...' : 'Run Query'}
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
