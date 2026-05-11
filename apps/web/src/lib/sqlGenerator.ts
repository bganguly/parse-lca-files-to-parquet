type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  apiKey?: string
  model?: string
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

function parseStartsWithPrefix(queryLower: string) {
  const quotedMatch = queryLower.match(/starting\s+with\s+["']([a-z0-9 _.-]+)["']/i)
  const plainMatch = queryLower.match(/starting\s+with\s+([a-z0-9_.-]+)/i)
  const match = quotedMatch ?? plainMatch

  if (!match) {
    return null
  }

  return match[1].trim()
}

function applyStartsWithEmployerConstraint(sql: string, queryLower: string) {
  const startsWithPrefix = parseStartsWithPrefix(queryLower)

  if (!startsWithPrefix) {
    return sql
  }

  const normalizedPrefix = startsWithPrefix.toLowerCase()
  const existingPrefixRegex = /employer\s+i?like\s+'([^']*)%'/i
  const existingPrefixMatch = sql.match(existingPrefixRegex)

  if (existingPrefixMatch) {
    const existingPrefix = existingPrefixMatch[1].trim().toLowerCase()

    if (existingPrefix === normalizedPrefix) {
      return sql
    }

    return sql.replace(existingPrefixRegex, `employer ILIKE '${normalizedPrefix}%'`)
  }

  const constraint = ` employer ILIKE '${normalizedPrefix}%'`
  const boundaryRegex = /\b(group\s+by|order\s+by|limit)\b/i
  const boundaryMatch = boundaryRegex.exec(sql)
  const boundaryIndex = boundaryMatch?.index ?? sql.length
  const head = sql.slice(0, boundaryIndex)
  const tail = sql.slice(boundaryIndex)

  if (/\bwhere\b/i.test(head)) {
    return `${head} AND${constraint} ${tail}`.trim()
  }

  return `${head} WHERE${constraint} ${tail}`.trim()
}

function deterministicFallbackSql(query: string) {
  const q = query.toLowerCase()
  const yearMatch = q.match(/(20\d{2})/)
  const yearFilter = yearMatch ? ` AND year = ${yearMatch[1]}` : ''
  const startsWithPrefix = parseStartsWithPrefix(q)
  const employerPrefixFilter = startsWithPrefix
    ? ` AND employer ILIKE '${startsWithPrefix.toLowerCase()}%'`
    : ''

  if (q.includes('top') && q.includes('employer') && q.includes('approval')) {
    return `SELECT employer, COUNT(*) AS approvals
FROM h1b_raw
WHERE status LIKE 'Certified%'${yearFilter}${employerPrefixFilter}
GROUP BY employer
ORDER BY approvals DESC
LIMIT 10`
  }

  if (q.includes('approval') && q.includes('country')) {
    return `SELECT country, COUNT(*) AS approvals
FROM h1b_raw
WHERE status LIKE 'Certified%'${yearFilter}
GROUP BY country
ORDER BY approvals DESC`
  }

  if (q.includes('approval rate') && q.includes('year')) {
    return `SELECT year,
  ROUND(
    100.0 * SUM(CASE WHEN status LIKE 'Certified%' THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) AS approval_rate
FROM h1b_raw
GROUP BY year
ORDER BY year`
  }

  if (q.includes('average') && q.includes('wage')) {
    return `SELECT job_title, ROUND(AVG(wage), 2) AS avg_wage
FROM h1b_raw
WHERE wage IS NOT NULL${q.includes('certified') ? " AND status LIKE 'Certified%'" : ''}
GROUP BY job_title
ORDER BY avg_wage DESC
LIMIT 20`
  }

  return 'SELECT * FROM h1b_raw LIMIT 100'
}

export async function generateSqlFromNl(input: SqlGenerationInput) {
  const trimmedQuery = input.query.trim()
  const queryLower = trimmedQuery.toLowerCase()

  if (!trimmedQuery) {
    throw new Error('Query cannot be empty.')
  }

  if (!input.apiKey) {
    const fallbackSql = deterministicFallbackSql(trimmedQuery)
    return applyStartsWithEmployerConstraint(fallbackSql, queryLower)
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

  const cleanedSql = content.replace(/```sql|```/gi, '').trim()
  return applyStartsWithEmployerConstraint(cleanedSql, queryLower)
}
