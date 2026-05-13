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
import { validateGeneratedSql } from './lib/sqlSafety'

type LlmProvider = 'openai' | 'anthropic' | 'openrouter'

type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  datasetPath?: string
  apiKey?: string
  model?: string
  provider?: LlmProvider
}

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

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const MAX_API_ATTEMPTS = 3

type ApiErrorPayload = {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

function extractSqlOnly(rawContent: string) {
  const withoutFences = rawContent.replace(/```sql|```/gi, '').trim()
  const selectOrWithMatch = withoutFences.match(/\b(select|with)\b[\s\S]*/i)
  const candidate = (selectOrWithMatch?.[0] ?? withoutFences).trim()
  return candidate.replace(/;+\s*$/, '')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureModelCompatible(provider: LlmProvider, model: string) {
  const normalized = model.trim().toLowerCase()

  if (provider === 'openai') {
    const isLikelyNonOpenAiModel =
      normalized.startsWith('claude') || normalized.startsWith('gemini') || normalized.startsWith('grok')

    if (isLikelyNonOpenAiModel) {
      throw new Error(
        `Model "${model}" is not available on the OpenAI endpoint. Use an OpenAI model (gpt/o series) or switch provider to Anthropic/OpenRouter.`,
      )
    }
  }

  if (provider === 'anthropic' && !normalized.startsWith('claude')) {
    throw new Error(
      `Model "${model}" is not a Claude model. Anthropic provider expects Claude model ids. Use a Claude model or switch provider.`,
    )
  }
}

async function parseApiError(response: Response) {
  let message = `LLM request failed with status ${response.status}`
  let type = ''
  let code = ''

  try {
    const payload = (await response.json()) as ApiErrorPayload
    const error = payload.error
    if (error?.message) {
      message = error.message
    }
    type = error?.type ?? ''
    code = error?.code ?? ''
  } catch {
    // Keep status-based defaults when payload is not JSON.
  }

  return { message, type, code }
}

function formatApiError(provider: LlmProvider, status: number, message: string, type: string, code: string) {
  if (status === 401) {
    return `${provider} authentication failed. Verify your API key is valid and active.`
  }

  if (status === 429) {
    const quotaHint =
      code === 'insufficient_quota' || /insufficient_quota/i.test(message)
        ? 'No remaining API quota. Add billing/credits and retry.'
        : 'Rate limit hit. Wait a moment and retry.'

    return `${provider} request limited: ${quotaHint} Message: ${message} (type=${type || 'unknown'}, code=${code || 'unknown'}).`
  }

  return `${provider} request failed (${status}): ${message}`
}

function formatNetworkFetchError(provider: LlmProvider, message: string) {
  if (provider === 'anthropic') {
    return (
      'Network fetch failed for Anthropic from browser. This is usually a CORS/browser restriction for direct API calls. ' +
      'Use OpenRouter for browser-based Claude access, or route Anthropic requests through your backend proxy. ' +
      'You can also use the downloadable plain HTML fallback form at /downloads/llm-request-form.html. ' +
      `Original error: ${message}`
    )
  }

  if (provider === 'openrouter') {
    return (
      'Network fetch failed for OpenRouter. Check internet connectivity, browser extensions/ad blockers, and endpoint access. ' +
      `Original error: ${message}`
    )
  }

  return `Network fetch failed for OpenAI. Check connectivity and browser network restrictions. Original error: ${message}`
}

async function requestOpenAiCompatibleSql(
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  useOpenRouterHeaders = false,
) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(useOpenRouterHeaders
        ? {
            'HTTP-Referer': 'http://localhost',
            'X-Title': 'H1B NLQ Prototype',
          }
        : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Return only a single read-only DuckDB SQL query.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })
}

async function requestAnthropicSql(apiKey: string, model: string, prompt: string) {
  return fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      temperature: 0,
      system: 'Return only a single read-only DuckDB SQL query.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  })
}

function resolveProvider(provider?: LlmProvider): LlmProvider {
  return provider ?? 'openai'
}

async function generateSqlFromNl(input: SqlGenerationInput) {
  const trimmedQuery = input.query.trim()
  if (!trimmedQuery) {
    throw new Error('Query cannot be empty.')
  }

  if (!input.apiKey?.trim()) {
    throw new Error('LLM API key is required.')
  }

  const provider = resolveProvider(input.provider)
  const model = input.model || 'gpt-4o-mini'
  const activeDatasetPath = input.datasetPath?.trim() ?? ''
  ensureModelCompatible(provider, model)

  const datasetRuntimeHint = activeDatasetPath
    ? `Runtime dataset URL: ${activeDatasetPath}\nIf you use read_parquet(), use exactly this URL.`
    : 'Runtime dataset URL is not provided. Prefer querying the table defined in schema.'

  const prompt = `You are a SQL expert. Given this schema:\n${input.schemaPrompt}\n\n${datasetRuntimeHint}\n\nConvert this question to SQL (DuckDB syntax).\nYou may query the schema table directly, or read_parquet() only with the runtime dataset URL above.\n\nQuestion:\n"${trimmedQuery}"\n\nReturn ONLY the SQL query, nothing else.`

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    let response: Response

    try {
      response =
        provider === 'anthropic'
          ? await requestAnthropicSql(input.apiKey, model, prompt)
          : await requestOpenAiCompatibleSql(
              provider === 'openrouter' ? OPENROUTER_CHAT_COMPLETIONS_URL : OPENAI_CHAT_COMPLETIONS_URL,
              input.apiKey,
              model,
              prompt,
              provider === 'openrouter',
            )
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Unknown network error'
      throw new Error(formatNetworkFetchError(provider, rawMessage), { cause: error })
    }

    if (!response.ok) {
      const parsedError = await parseApiError(response)
      const isRetryable =
        (response.status === 429 || response.status === 503) &&
        parsedError.code !== 'insufficient_quota' &&
        !/insufficient_quota/i.test(parsedError.message)

      if (isRetryable && attempt < MAX_API_ATTEMPTS) {
        await sleep(500 * attempt)
        continue
      }

      throw new Error(
        formatApiError(provider, response.status, parsedError.message, parsedError.type, parsedError.code),
      )
    }

    if (provider === 'anthropic') {
      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>
      }

      const content = (data.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()

      if (!content) {
        throw new Error('anthropic did not return SQL output.')
      }

      return extractSqlOnly(content)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) {
      throw new Error(`${provider} did not return SQL output.`)
    }

    return extractSqlOnly(content)
  }

  throw new Error(`${provider} request failed after multiple attempts.`)
}

function App() {
  const [query, setQuery] = useState('top employers by H1B approvals in 2023')
  const [datasetPath, setDatasetPath] = useState(DEFAULT_DATASET_URL)
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmProvider, setLlmProvider] = useState<LlmProvider>('openai')
  const [llmModel, setLlmModel] = useState('gpt-4o-mini')
  const [isRunning, setIsRunning] = useState(false)
  const [latestRun, setLatestRun] = useState<QueryRun | null>(null)
  const [history, setHistory] = useState<QueryRun[]>([])
  const modelPresets = MODEL_PRESETS_BY_PROVIDER[llmProvider]
  const usesCustomModel = !modelPresets.includes(llmModel)

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
        datasetPath,
        apiKey: llmApiKey,
        provider: llmProvider,
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
              Download fallback plain HTML form:{' '}
              <a href="/downloads/llm-request-form.html" download>
                llm-request-form.html
              </a>
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
