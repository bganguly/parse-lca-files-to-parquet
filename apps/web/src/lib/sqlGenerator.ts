export type LlmProvider = 'openai' | 'anthropic'

type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  datasetPath?: string
  apiKey?: string
  model?: string
  provider?: LlmProvider
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
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
        `Model "${model}" is not available on the OpenAI endpoint. ` +
          'Use an OpenAI model (gpt/o series) or switch provider to Anthropic.',
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
    // Keep status-based defaults when payload is not JSON.
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

function formatNetworkFetchError(provider: LlmProvider, message: string) {
  if (provider === 'anthropic') {
    return (
      'Network fetch failed for Anthropic from browser. This is usually a CORS/browser restriction for direct API calls. ' +
      'Route Anthropic requests through your backend proxy for browser use. ' +
      'You can also use the downloadable plain HTML fallback form at /downloads/llm-request-form.html. ' +
      `Original error: ${message}`
    )
  }

  return `Network fetch failed for OpenAI. Check connectivity and browser network restrictions. Original error: ${message}`
}

async function requestOpenAiCompatibleSql(
  apiKey: string,
  model: string,
  prompt: string,
) {
  return fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

export async function generateSqlFromNl(input: SqlGenerationInput) {
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
          : await requestOpenAiCompatibleSql(input.apiKey, model, prompt)
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
