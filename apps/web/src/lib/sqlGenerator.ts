type SqlGenerationInput = {
  query: string
  schemaPrompt: string
  apiKey?: string
  model?: string
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'

type FiscalPeriod = {
  fiscalYear: number
  fiscalQuarter?: number
}

function parseStartsWithPrefix(queryLower: string) {
  const quotedMatch = queryLower.match(/starting\s+with\s+["']([a-z0-9 _.-]+)["']/i)
  const plainMatch = queryLower.match(/starting\s+with\s+([a-z0-9_.-]+)/i)
  const match = quotedMatch ?? plainMatch

  if (!match) {
    return null
  }

  return match[1].trim()
}

function parseFiscalPeriod(queryLower: string): FiscalPeriod | null {
  const match = queryLower.match(/\b(?:fy|fiscal\s+year)\s*(20\d{2})(?:\s*q([1-4]))?\b/i)

  if (!match) {
    return null
  }

  const fiscalYear = Number(match[1])
  const fiscalQuarter = match[2] ? Number(match[2]) : undefined

  return { fiscalYear, fiscalQuarter }
}

function parseRequestedLimit(queryLower: string): number | null {
  const topMatch = queryLower.match(/\btop\s+(\d{1,4})\b/i)
  const limitMatch = queryLower.match(/\blimit\s+(\d{1,4})\b/i)
  const value = topMatch?.[1] ?? limitMatch?.[1]

  if (!value) {
    return null
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return Math.min(parsed, 1000)
}

function extractCalendarYearFilter(queryLower: string) {
  const fiscalPeriod = parseFiscalPeriod(queryLower)
  if (fiscalPeriod) {
    return ''
  }

  const yearMatch = queryLower.match(/(20\d{2})/)
  return yearMatch ? ` AND year = ${yearMatch[1]}` : ''
}

function extractFiscalFilter(queryLower: string) {
  const fiscalPeriod = parseFiscalPeriod(queryLower)
  if (!fiscalPeriod) {
    return ''
  }

  return ` AND fiscal_year = ${fiscalPeriod.fiscalYear}${
    fiscalPeriod.fiscalQuarter !== undefined ? ` AND fiscal_quarter = ${fiscalPeriod.fiscalQuarter}` : ''
  }`
}

function extractEmployerPrefixFilter(queryLower: string) {
  const startsWithPrefix = parseStartsWithPrefix(queryLower)
  return startsWithPrefix ? ` AND employer ILIKE '${startsWithPrefix.toLowerCase()}%'` : ''
}

function isTopEmployersApplicationsIntent(queryLower: string) {
  const hasTopOrBottom = /\b(top|bottom)\b/i.test(queryLower)
  const hasEmployer = queryLower.includes('employer')
  const hasApplications = /(application|applications|filing|filings|lca)/i.test(queryLower)
  const hasApprovals = /(approval|approvals|approved|certified)/i.test(queryLower)

  return hasTopOrBottom && hasEmployer && hasApplications && !hasApprovals
}

function isTopBottomEmployersGenericIntent(queryLower: string) {
  const hasTopOrBottom = /\b(top|bottom)\b/i.test(queryLower)
  const hasEmployer = queryLower.includes('employer')
  const hasApplications = /(application|applications|filing|filings|lca)/i.test(queryLower)
  const hasApprovals = /(approval|approvals|approved|certified)/i.test(queryLower)
  const hasPercent = /(percent|percentage|share)/i.test(queryLower)

  return hasTopOrBottom && hasEmployer && !hasApplications && !hasApprovals && !hasPercent
}

function isEmployerPercentageIntent(queryLower: string) {
  const hasEmployer = queryLower.includes('employer')
  const hasPercent = /(percent|percentage|share)/i.test(queryLower)

  return hasEmployer && hasPercent
}

function isTopEmployersApprovalsByYearIntent(queryLower: string) {
  const hasTop = queryLower.includes('top')
  const hasEmployer = queryLower.includes('employer')
  const hasApprovals = /(approval|approvals|approved|certified)/i.test(queryLower)
  const asksByYear = /\b(by|per|each)\s+year\b|\byearly\b/i.test(queryLower)

  return hasTop && hasEmployer && hasApprovals && asksByYear
}

function isCountIntent(queryLower: string) {
  const asksForCount = /\b(how\s+many|count|number\s+of|total)\b/i.test(queryLower)
  const asksAboutH1b = /\b(h-?1bs?|hi1bs?|h1bs?|lca|application|applications|filing|filings)\b/i.test(
    queryLower,
  )

  return asksForCount && asksAboutH1b
}

function isCountsByQuarterIntent(queryLower: string) {
  const asksByQuarter = /\b(by|per)\s+quarter\b|\bquarterly\b/i.test(queryLower)
  const asksAboutH1b = /\b(h-?1bs?|hi1bs?|h1bs?|lca|application|applications|filing|filings)\b/i.test(
    queryLower,
  )
  const asksForCount = /\b(count|counts|how\s+many|number\s+of|total|list|show)\b/i.test(queryLower)

  return asksByQuarter && asksAboutH1b && asksForCount
}

function isCountsByYearIntent(queryLower: string) {
  const asksByYear = /\b(by|per)\s+year\b|\byearly\b/i.test(queryLower)
  const asksAboutH1b = /\b(h-?1bs?|hi1bs?|h1bs?|lca|application|applications|filing|filings)\b/i.test(
    queryLower,
  )
  const asksForCount = /\b(count|counts|how\s+many|number\s+of|total|list|show)\b/i.test(queryLower)

  return asksByYear && asksAboutH1b && asksForCount
}

function extractYearOrFiscalFilter(queryLower: string) {
  const fiscalPeriod = parseFiscalPeriod(queryLower)
  if (fiscalPeriod) {
    return ''
  }

  const yearMatch = queryLower.match(/(20\d{2})/)
  return yearMatch ? ` AND (year = ${yearMatch[1]} OR fiscal_year = ${yearMatch[1]})` : ''
}

function buildCountIntentSql(queryLower: string) {
  const yearOrFiscalFilter = extractYearOrFiscalFilter(queryLower)
  const fiscalFilter = extractFiscalFilter(queryLower)
  const employerPrefixFilter = extractEmployerPrefixFilter(queryLower)

  return `SELECT COUNT(*) AS total_h1b_records
FROM h1b_raw
WHERE 1=1${yearOrFiscalFilter}${fiscalFilter}${employerPrefixFilter}`
}

function buildCountsByQuarterSql(queryLower: string) {
  const yearOrFiscalFilter = extractYearOrFiscalFilter(queryLower)
  const fiscalFilter = extractFiscalFilter(queryLower)

  return `SELECT fiscal_year, fiscal_quarter, COUNT(*) AS total_h1b_records
FROM h1b_raw
WHERE 1=1${yearOrFiscalFilter}${fiscalFilter}
GROUP BY fiscal_year, fiscal_quarter
ORDER BY fiscal_year, fiscal_quarter`
}

function buildCountsByYearSql(queryLower: string) {
  const fiscalPeriod = parseFiscalPeriod(queryLower)

  if (fiscalPeriod) {
    return `SELECT fiscal_year AS year, COUNT(*) AS total_h1b_records
FROM h1b_raw
WHERE fiscal_year = ${fiscalPeriod.fiscalYear}${
      fiscalPeriod.fiscalQuarter !== undefined
        ? ` AND fiscal_quarter = ${fiscalPeriod.fiscalQuarter}`
        : ''
    }
GROUP BY fiscal_year
ORDER BY fiscal_year`
  }

  return `SELECT year, COUNT(*) AS total_h1b_records
FROM h1b_raw
GROUP BY year
ORDER BY year`
}

function buildTopEmployersApplicationsSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower) ?? 10
  const yearFilter = extractCalendarYearFilter(queryLower)
  const fiscalFilter = extractFiscalFilter(queryLower)
  const employerPrefixFilter = extractEmployerPrefixFilter(queryLower)
  const employerExpr = "COALESCE(NULLIF(TRIM(employer), ''), 'N/A - Employer Not Published')"
  const orderDirection = /\bbottom\b/i.test(queryLower) ? 'ASC' : 'DESC'

  return `SELECT ${employerExpr} AS employer, COUNT(*) AS applications
FROM h1b_raw
WHERE 1=1${yearFilter}${fiscalFilter}${employerPrefixFilter}
GROUP BY 1
ORDER BY applications ${orderDirection}
LIMIT ${requestedLimit}`
}

function buildEmployerPercentageSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower) ?? 10
  const yearFilter = extractCalendarYearFilter(queryLower)
  const fiscalFilter = extractFiscalFilter(queryLower)
  const employerPrefixFilter = extractEmployerPrefixFilter(queryLower)
  const employerExpr = "COALESCE(NULLIF(TRIM(employer), ''), 'N/A - Employer Not Published')"
  const orderDirection = /\bbottom\b/i.test(queryLower) ? 'ASC' : 'DESC'

  return `SELECT
  ${employerExpr} AS employer,
  COUNT(*) AS applications,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS application_share_pct
FROM h1b_raw
WHERE 1=1${yearFilter}${fiscalFilter}${employerPrefixFilter}
GROUP BY 1
ORDER BY application_share_pct ${orderDirection}
LIMIT ${requestedLimit}`
}

function buildTopEmployersApprovalsByYearSql(queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower) ?? 10

  return `WITH ranked AS (
  SELECT
    year,
    employer,
    COUNT(*) AS approvals,
    ROW_NUMBER() OVER (PARTITION BY year ORDER BY COUNT(*) DESC) AS rank_in_year
  FROM h1b_raw
  WHERE status LIKE 'Certified%'
  GROUP BY year, employer
)
SELECT year, employer, approvals
FROM ranked
WHERE rank_in_year <= ${requestedLimit}
ORDER BY year, approvals DESC, employer`
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

function normalizeEmployerEquality(sql: string) {
  return sql.replace(/\bemployer\s*=\s*'([^']+)'/gi, (_match, employerValue: string) => {
    const normalized = employerValue.trim().replace(/'/g, "''")

    if (!normalized) {
      return "employer = ''"
    }

    return `employer ILIKE '%${normalized}%'`
  })
}

function applyFiscalPeriodConstraint(sql: string, queryLower: string) {
  const fiscal = parseFiscalPeriod(queryLower)

  if (!fiscal) {
    return sql
  }

  const { fiscalYear, fiscalQuarter } = fiscal
  let constrainedSql = sql

  const exactYearRegex = new RegExp(`\\byear\\s*=\\s*${fiscalYear}\\b`, 'i')
  if (exactYearRegex.test(constrainedSql)) {
    constrainedSql = constrainedSql
      .replace(new RegExp(`\\s+AND\\s+year\\s*=\\s*${fiscalYear}\\b`, 'ig'), '')
      .replace(new RegExp(`\\bWHERE\\s+year\\s*=\\s*${fiscalYear}\\s+AND\\s+`, 'ig'), 'WHERE ')
      .replace(new RegExp(`\\bWHERE\\s+year\\s*=\\s*${fiscalYear}\\b`, 'ig'), '')
  }

  const fiscalYearRegex = /fiscal_year\s*=\s*\d{4}/i
  const fiscalQuarterRegex = /fiscal_quarter\s*=\s*[1-4]/i

  if (fiscalYearRegex.test(constrainedSql)) {
    constrainedSql = constrainedSql.replace(fiscalYearRegex, `fiscal_year = ${fiscalYear}`)
  }

  if (fiscalQuarter !== undefined && fiscalQuarterRegex.test(constrainedSql)) {
    constrainedSql = constrainedSql.replace(fiscalQuarterRegex, `fiscal_quarter = ${fiscalQuarter}`)
  }

  const missingFiscalYear = !/fiscal_year\s*=\s*\d{4}/i.test(constrainedSql)
  const missingFiscalQuarter =
    fiscalQuarter !== undefined && !/fiscal_quarter\s*=\s*[1-4]/i.test(constrainedSql)

  if (!missingFiscalYear && !missingFiscalQuarter) {
    return constrainedSql
  }

  const conditions = [`fiscal_year = ${fiscalYear}`]
  if (fiscalQuarter !== undefined) {
    conditions.push(`fiscal_quarter = ${fiscalQuarter}`)
  }

  const constraint = ` ${conditions.join(' AND ')}`
  const boundaryRegex = /\b(group\s+by|order\s+by|limit)\b/i
  const boundaryMatch = boundaryRegex.exec(constrainedSql)
  const boundaryIndex = boundaryMatch?.index ?? constrainedSql.length
  const head = constrainedSql.slice(0, boundaryIndex)
  const tail = constrainedSql.slice(boundaryIndex)

  if (/\bwhere\b/i.test(head)) {
    return `${head} AND${constraint} ${tail}`.trim()
  }

  return `${head} WHERE${constraint} ${tail}`.trim()
}

function applyRequestedLimit(sql: string, queryLower: string) {
  const requestedLimit = parseRequestedLimit(queryLower)

  if (!requestedLimit) {
    return sql
  }

  const limitRegex = /\blimit\s+\d+\b/i
  if (limitRegex.test(sql)) {
    return sql.replace(limitRegex, `LIMIT ${requestedLimit}`)
  }

  if (/\btop\b/i.test(queryLower)) {
    return `${sql.trim()} LIMIT ${requestedLimit}`
  }

  return sql
}

function applyTopEmployersApplicationsConstraint(sql: string, queryLower: string) {
  if (!isTopEmployersApplicationsIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersApplicationsSql(queryLower)
}

function applyTopBottomEmployersGenericConstraint(sql: string, queryLower: string) {
  if (!isTopBottomEmployersGenericIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersApplicationsSql(queryLower)
}

function applyEmployerPercentageConstraint(sql: string, queryLower: string) {
  if (!isEmployerPercentageIntent(queryLower)) {
    return sql
  }

  return buildEmployerPercentageSql(queryLower)
}

function applyTopEmployersApprovalsByYearConstraint(sql: string, queryLower: string) {
  if (!isTopEmployersApprovalsByYearIntent(queryLower)) {
    return sql
  }

  return buildTopEmployersApprovalsByYearSql(queryLower)
}

function applyCountIntentConstraint(sql: string, queryLower: string) {
  if (!isCountIntent(queryLower)) {
    return sql
  }

  return buildCountIntentSql(queryLower)
}

function applyCountsByQuarterConstraint(sql: string, queryLower: string) {
  if (!isCountsByQuarterIntent(queryLower)) {
    return sql
  }

  return buildCountsByQuarterSql(queryLower)
}

function applyCountsByYearConstraint(sql: string, queryLower: string) {
  if (!isCountsByYearIntent(queryLower)) {
    return sql
  }

  return buildCountsByYearSql(queryLower)
}

function deterministicFallbackSql(query: string) {
  const q = query.toLowerCase()
  const yearFilter = extractCalendarYearFilter(q)
  const fiscalFilter = extractFiscalFilter(q)
  const employerPrefixFilter = extractEmployerPrefixFilter(q)

  if (isCountsByYearIntent(q)) {
    return buildCountsByYearSql(q)
  }

  if (isCountsByQuarterIntent(q)) {
    return buildCountsByQuarterSql(q)
  }

  if (isCountIntent(q)) {
    return buildCountIntentSql(q)
  }

  if (isTopEmployersApplicationsIntent(q)) {
    return buildTopEmployersApplicationsSql(q)
  }

  if (isTopBottomEmployersGenericIntent(q)) {
    return buildTopEmployersApplicationsSql(q)
  }

  if (isEmployerPercentageIntent(q)) {
    return buildEmployerPercentageSql(q)
  }

  if (isTopEmployersApprovalsByYearIntent(q)) {
    return buildTopEmployersApprovalsByYearSql(q)
  }

  if (q.includes('top') && q.includes('employer') && q.includes('approval')) {
    return `SELECT employer, COUNT(*) AS approvals
FROM h1b_raw
WHERE status LIKE 'Certified%'
${yearFilter}${fiscalFilter}${employerPrefixFilter}
GROUP BY employer
ORDER BY approvals DESC
LIMIT 10`
  }

  if (q.includes('approval') && q.includes('country')) {
    return `SELECT country, COUNT(*) AS approvals
FROM h1b_raw
WHERE status LIKE 'Certified%'${yearFilter}${fiscalFilter}
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
    return applyStartsWithEmployerConstraint(
      applyCountsByYearConstraint(
        applyCountsByQuarterConstraint(
          applyCountIntentConstraint(
            applyTopEmployersApplicationsConstraint(
              applyTopBottomEmployersGenericConstraint(
                applyEmployerPercentageConstraint(
                  applyTopEmployersApprovalsByYearConstraint(
                    applyRequestedLimit(
                      applyFiscalPeriodConstraint(normalizeEmployerEquality(fallbackSql), queryLower),
                      queryLower,
                    ),
                    queryLower,
                  ),
                  queryLower,
                ),
                queryLower,
              ),
              queryLower,
            ),
            queryLower,
          ),
          queryLower,
        ),
        queryLower,
      ),
      queryLower,
    )
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
  return applyStartsWithEmployerConstraint(
    applyCountsByYearConstraint(
      applyCountsByQuarterConstraint(
        applyCountIntentConstraint(
          applyTopEmployersApplicationsConstraint(
            applyTopBottomEmployersGenericConstraint(
              applyEmployerPercentageConstraint(
                applyTopEmployersApprovalsByYearConstraint(
                  applyRequestedLimit(
                    applyFiscalPeriodConstraint(normalizeEmployerEquality(cleanedSql), queryLower),
                    queryLower,
                  ),
                  queryLower,
                ),
                queryLower,
              ),
              queryLower,
            ),
            queryLower,
          ),
          queryLower,
        ),
        queryLower,
      ),
      queryLower,
    ),
    queryLower,
  )
}
