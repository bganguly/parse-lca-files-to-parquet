const FORBIDDEN_SQL = /(insert|update|delete|drop|alter|create|copy|attach|detach|pragma|load|install)\b/i

export function validateGeneratedSql(sql: string) {
  const trimmed = sql.trim().replace(/;+$/, '')

  if (!trimmed) {
    throw new Error('Generated SQL is empty.')
  }

  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('Only SELECT queries are allowed in this prototype.')
  }

  if (FORBIDDEN_SQL.test(trimmed)) {
    throw new Error('Generated SQL contains forbidden statements.')
  }
}
