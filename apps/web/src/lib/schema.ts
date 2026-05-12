export const H1B_SCHEMA = [
  { name: 'employer', type: 'TEXT' },
  { name: 'job_title', type: 'TEXT' },
  { name: 'country', type: 'TEXT' },
  { name: 'work_location', type: 'TEXT' },
  { name: 'wage', type: 'DOUBLE' },
  { name: 'status', type: 'TEXT' },
  { name: 'year', type: 'INTEGER' },
  { name: 'fiscal_year', type: 'INTEGER' },
  { name: 'fiscal_quarter', type: 'INTEGER' },
] as const

export function buildSqlGenerationPrompt(
  schema: readonly { name: string; type: string }[],
  tableName: string,
) {
  const columns = schema.map((column) => `${column.name} ${column.type}`).join(',\n')

  return `You are a SQL generator for DuckDB.
Return valid SQL only. No markdown. No prose.

You can query ONLY this table and schema:
Table: ${tableName}
Columns:
${columns}

Rules:
- Use only the listed columns.
- Never use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE.
- Always return a SELECT query.
- If the user asks for approvals, use status LIKE 'Certified%'.
- If the user asks for applications/filings, count all rows (COUNT(*)) and do not add a status filter unless user explicitly asks.
- If the user asks for denials, use status = 'Denied'.
- If the user says "starting with X", use ILIKE 'X%' on the relevant text column.
- If the user asks for FY/Fiscal periods (example: FY2026 Q1), filter on fiscal_year and fiscal_quarter.
- For "top" requests, use ORDER BY aggregate DESC and LIMIT 10 unless user states a different limit.
`
}
