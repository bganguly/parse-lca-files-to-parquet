export type LlmProvider = 'openai' | 'anthropic' | 'openrouter'

type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  apiKey?: string
  model?: string
  provider?: LlmProvider
  bypassSqlGuards?: boolean
}

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

function parseRequestedLimit(queryLower: string): number {
  const topMatch = queryLower.match(/\btop\s+(\d{1,4})\b/i)
  const limitMatch = queryLower.match(/\blimit\s+(\d{1,4})\b/i)
  const value = topMatch?.[1] ?? limitMatch?.[1]
  const parsed = value ? Number(value) : 10

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10
  }

  return Math.min(parsed, 1000)
}

function isTopBottomEmployersByYearIntent(queryLower: string) {
  const hasTopOrBottom = /\b(top|bottom)\b/i.test(queryLower)
  const hasEmployer = queryLower.includes('employer')
  const asksByYear = /\b(by|per|each)\s+years?\b|\byearly\b/i.test(queryLower)
  const asksByQuarter = /\bquarter\b|\bq[1-4]\b/i.test(queryLower)
  const hasWage = /\b(wage|wages|salary|salaries)\b/i.test(queryLower)

  return hasTopOrBottom && hasEmployer && asksByYear && !asksByQuarter && !hasWage
}

function isTopBottomEmployersByWageYearIntent(queryLower: string) {
  const hasTopOrBottom = /\b(top|bottom)\b/i.test(queryLower)
  const hasEmployer = queryLower.includes('employer')
  const asksByYear = /\b(by|per|each)\s+years?\b|\byearly\b/i.test(queryLower)
  const asksByQuarter = /\bquarter\b|\bq[1-4]\b/i.test(queryLower)
  const hasWage = /\b(wage|wages|salary|salaries)\b/i.test(queryLower)

  return hasTopOrBottom && hasEmployer && hasWage && asksByYear && !asksByQuarter
}

function isTopBottomEmployersByYearQuarterIntent(queryLower: string) {
  const hasTopOrBottom = /\b(top|bottom)\b/i.test(queryLower)
  const hasEmployer = queryLower.includes('employer')
  const hasYear = /\byears?\b/i.test(queryLower)
  const hasQuarter = /\bquarter\b|\bq[1-4]\b/i.test(queryLower)

  return hasTopOrBottom && hasEmployer && hasYear && hasQuarter
}

function buildTopEmployersByYearSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower)
  const employerExpr = "COALESCE(NULLIF(TRIM(employer), ''), 'N/A - Employer Not Published')"
  const orderDirection = /\bbottom\b/i.test(queryLower) ? 'ASC' : 'DESC'
  const topStatusFilter = /\btop\b/i.test(queryLower) ? " AND status LIKE 'Certified%'" : ''

  return `WITH ranked AS (
  SELECT
    fiscal_year,
    ${employerExpr} AS employer,
    COUNT(*) AS applications,
    ROW_NUMBER() OVER (PARTITION BY fiscal_year ORDER BY COUNT(*) ${orderDirection}) AS rank_in_year
  FROM h1b_raw
  WHERE 1=1${topStatusFilter}
  GROUP BY fiscal_year, 2
)
SELECT fiscal_year, employer, applications
FROM ranked
WHERE rank_in_year <= ${requestedLimit}
ORDER BY fiscal_year, applications ${orderDirection}, employer`
}

function buildTopEmployersByWageYearSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower)
  const employerExpr = "COALESCE(NULLIF(TRIM(employer), ''), 'N/A - Employer Not Published')"
  const orderDirection = /\bbottom\b/i.test(queryLower) ? 'ASC' : 'DESC'
  const topStatusFilter = /\btop\b/i.test(queryLower) ? " AND status LIKE 'Certified%'" : ''

  return `WITH ranked AS (
  SELECT
    fiscal_year,
    ${employerExpr} AS employer,
    ROUND(AVG(wage), 2) AS avg_wage,
    ROW_NUMBER() OVER (PARTITION BY fiscal_year ORDER BY AVG(wage) ${orderDirection}) AS rank_in_year
  FROM h1b_raw
  WHERE wage IS NOT NULL${topStatusFilter}
  GROUP BY fiscal_year, 2
)
SELECT fiscal_year, employer, avg_wage
FROM ranked
WHERE rank_in_year <= ${requestedLimit}
ORDER BY fiscal_year, avg_wage ${orderDirection}, employer`
}

function buildTopEmployersByYearQuarterSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower)
  const employerExpr = "COALESCE(NULLIF(TRIM(employer), ''), 'N/A - Employer Not Published')"
  const orderDirection = /\bbottom\b/i.test(queryLower) ? 'ASC' : 'DESC'
  const topStatusFilter = /\btop\b/i.test(queryLower) ? " AND status LIKE 'Certified%'" : ''

  return `WITH ranked AS (
  SELECT
    fiscal_year,
    fiscal_quarter,
    ${employerExpr} AS employer,
    COUNT(*) AS applications,
    ROW_NUMBER() OVER (PARTITION BY fiscal_year, fiscal_quarter ORDER BY COUNT(*) ${orderDirection}) AS rank_in_period
  FROM h1b_raw
  WHERE 1=1${topStatusFilter}
  GROUP BY fiscal_year, fiscal_quarter, 3
)
SELECT fiscal_year, fiscal_quarter, employer, applications
FROM ranked
WHERE rank_in_period <= ${requestedLimit}
ORDER BY fiscal_year, fiscal_quarter, applications ${orderDirection}, employer`
}

function enforceTopEmployersByYearIntent(sql: string, queryLower: string) {
  if (!isTopBottomEmployersByYearIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersByYearSql(queryLower)
}

function enforceTopEmployersByWageYearIntent(sql: string, queryLower: string) {
  if (!isTopBottomEmployersByWageYearIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersByWageYearSql(queryLower)
}

function enforceTopEmployersByYearQuarterIntent(sql: string, queryLower: string) {
  if (!isTopBottomEmployersByYearQuarterIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersByYearQuarterSql(queryLower)
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
        `Model "${model}" is not available on the OpenAI endpoint. ` +
          'Use an OpenAI model (gpt/o series) or switch provider to Anthropic/OpenRouter.',
      )
    }
  }

  if (provider === 'anthropic' && !normalized.startsWith('claude')) {
    throw new Error(
      `Model "${model}" is not a Claude model. Anthropic provider expects Claude model ids. ` +
        'Use a Claude model or switch provider.',
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
    // Ignore parse failures and keep status-based message.
  }

  return { message, type, code }
}

function formatApiError(
  provider: LlmProvider,
  status: number,
  message: string,
  type: string,
  code: string,
) {
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

async function requestOpenAiCompatibleSql(
  endpoint: string,
  apiKey: string,
  model: string,
  prompt: string,
  useOpenRouterHeaders = false,
) {
  const response = await fetch(endpoint, {
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

  return response
}

async function requestAnthropicSql(apiKey: string, model: string, prompt: string) {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
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

  return response
}

function resolveProvider(provider?: LlmProvider): LlmProvider {
  return provider ?? 'openai'
}

function applySqlGuards(sql: string, queryLower: string) {
  return enforceTopEmployersByYearQuarterIntent(
    enforceTopEmployersByYearIntent(enforceTopEmployersByWageYearIntent(sql, queryLower), queryLower),
    queryLower,
  )
}

export async function generateSqlFromNl(input: SqlGenerationInput) {
  const trimmedQuery = input.query.trim()
  const queryLower = trimmedQuery.toLowerCase()

  if (!trimmedQuery) {
    throw new Error('Query cannot be empty.')
  }

  if (!input.apiKey?.trim()) {
    throw new Error('LLM API key is required.')
  }

  const provider = resolveProvider(input.provider)
  const model = input.model || 'gpt-4o-mini'
  const bypassSqlGuards = input.bypassSqlGuards ?? false
  ensureModelCompatible(provider, model)

  const prompt = `You are a SQL expert. Given this schema:\n${input.schemaPrompt}\n\nConvert this question to SQL (DuckDB syntax, reading from parquet on S3):\n"${trimmedQuery}"\n\nReturn ONLY the SQL query, nothing else.`

  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt += 1) {
    const response =
      provider === 'anthropic'
        ? await requestAnthropicSql(input.apiKey, model, prompt)
        : await requestOpenAiCompatibleSql(
            provider === 'openrouter' ? OPENROUTER_CHAT_COMPLETIONS_URL : OPENAI_CHAT_COMPLETIONS_URL,
            input.apiKey,
            model,
            prompt,
            provider === 'openrouter',
          )

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

      const extractedSql = extractSqlOnly(content)
      return bypassSqlGuards ? extractedSql : applySqlGuards(extractedSql, queryLower)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content?.trim()

    if (!content) {
      throw new Error(`${provider} did not return SQL output.`)
    }

    const extractedSql = extractSqlOnly(content)
    return bypassSqlGuards ? extractedSql : applySqlGuards(extractedSql, queryLower)
  }

  throw new Error(`${provider} request failed after multiple attempts.`)
}
