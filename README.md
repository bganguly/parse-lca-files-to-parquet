# H1B Natural Language Query System (No Database Prototype)

Natural language -> SQL (LLM) -> DuckDB-WASM -> table/chart visualization in the browser.

## Monorepo Structure

- `apps/web`: React + TypeScript frontend

## What This Prototype Supports

- Natural language query input
- LLM SQL generation constrained to known schema
- Deterministic SQL safety validation
- DuckDB query execution directly over raw CSV
- Result table + automatic chart preview
- Query history sidebar
- Works with static local path (`/data/h1b_sample.csv`) or remote CSV URL

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Start app

```bash
npm run dev
```

3. Open the shown local URL (usually `http://localhost:5173`).

## Dataset Schema

The query generator and SQL validator assume one table named `h1b_raw` with columns:

- employer (TEXT)
- job_title (TEXT)
- country (TEXT)
- work_location (TEXT)
- wage (DOUBLE)
- status (TEXT)
- year (INTEGER)

## LLM Configuration

In the app UI:

- Leave API key empty to use deterministic fallback query generation.
- Add an OpenAI-compatible key to use live LLM SQL generation via chat completions.

## Example Query

`top employers by H1B approvals in 2023`

Expected behavior:

- SQL is generated
- SQL is executed on the CSV
- aggregate table appears
- bar chart is rendered
