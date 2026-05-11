type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  apiKey?: string
  model?: string
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

function deterministicFallbackSql(query: string) {
  const q = query.toLowerCase()
  const yearMatch = q.match(/(20\d{2})/)
  const yearFilter = yearMatch ? ` AND year = ${yearMatch[1]}` : ''

  if (q.includes('top') && q.includes('employer') && q.includes('approval')) {
    return `SELECT employer, COUNT(*) AS approvals
FROM h1b_raw
WHERE status = 'Certified'${yearFilter}
GROUP BY employer
ORDER BY approvals DESC
LIMIT 10`
  }

  if (q.includes('approval') && q.includes('country')) {
    return `SELECT country, COUNT(*) AS approvals
FROM h1b_raw
WHERE status = 'Certified'${yearFilter}
GROUP BY country
ORDER BY approvals DESC`
  }

  if (q.includes('approval rate') && q.includes('year')) {
    return `SELECT year,
  ROUND(
    100.0 * SUM(CASE WHEN status = 'Certified' THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) AS approval_rate
FROM h1b_raw
GROUP BY year
ORDER BY year`
  }

  if (q.includes('average') && q.includes('wage')) {
    return `SELECT job_title, ROUND(AVG(wage), 2) AS avg_wage
FROM h1b_raw
WHERE wage IS NOT NULL${q.includes('certified') ? " AND status = 'Certified'" : ''}
GROUP BY job_title
ORDER BY avg_wage DESC
LIMIT 20`
  }

  return 'SELECT * FROM h1b_raw LIMIT 100'
}

export async function generateSqlFromNl(input: SqlGenerationInput) {
  const trimmedQuery = input.query.trim()

  if (!trimmedQuery) {
    throw new Error('Query cannot be empty.')
  }

  if (!input.apiKey) {
    return deterministicFallbackSql(trimmedQuery)
  }

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: input.schemaPrompt,
        },
        {
          role: 'user',
          content: trimmedQuery,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('LLM did not return SQL output.')
  }

  return content.replace(/```sql|```/gi, '').trim()
}
