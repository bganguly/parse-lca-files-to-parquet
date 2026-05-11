# H1B Natural Language Query System (No Database Prototype)

![Status](https://img.shields.io/badge/status-prototype-orange)
![Frontend](https://img.shields.io/badge/frontend-react%20%2B%20typescript-0b7285)
![Engine](https://img.shields.io/badge/query%20engine-duckdb--wasm-c2410c)
![Build](https://img.shields.io/badge/build-passing-2b8a3e)

Natural language -> SQL (LLM) -> DuckDB-WASM -> table/chart visualization in the browser.

## Quick Copy

Minimal UI run:

```sh
npm run ui:min
```

Infra up from scratch (optional bucket and region args):

```sh
npm run infra:up -- [bucket-name] [aws-region]
```

Infra teardown:

```sh
npm run infra:down -- [bucket-name] [aws-region]
```

## Monorepo Structure

- `apps/web`: React + TypeScript frontend

## What This Prototype Supports

- Natural language query input
- LLM SQL generation constrained to known schema
- Deterministic SQL safety validation
- DuckDB query execution directly over raw CSV and Parquet
- Result table + automatic chart preview
- Query history sidebar
- Uses official U.S. government disclosure sources (DOL and USCIS)

## Minimal UI Run

If you only want to see the UI with real official data, run one command:

```bash
npm run ui:min
```

This will:

- install required Python and npm dependencies,
- fetch official DOL/USCIS sources,
- build parquet files,
- start the dev server.

Open the local URL shown in terminal (usually `http://localhost:5173`).

## Infra From Scratch (S3 Parquet)

Bring everything up from scratch (data fetch + parquet build + S3 bucket + upload):

```bash
npm run infra:up -- [bucket-name] [aws-region]
```

- `bucket-name` is optional. If omitted, a unique bucket name is generated.
- `aws-region` defaults to `us-east-1`.

Tear everything down (delete objects + bucket):

```bash
npm run infra:down -- [bucket-name] [aws-region]
```

- If no args are given, it uses `.infra/state.env` from the last `infra:up` run.

## S3 + CloudFront Deployment (Parquet)

1. Upload parquet files to S3:

```bash
npm run upload:s3:parquet -- <your-bucket-name> <aws-region>
```

2. (Optional now, recommended for production) Create a CloudFront distribution in front of S3:

```bash
npm run create:cloudfront -- <your-bucket-name> <aws-region>
```

For development, you can use S3 URLs directly. CloudFront is best added before production traffic to improve latency and cache behavior.

## Official Data Sources Used

- DOL LCA disclosure (salary, employer, job/location fields):
	https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q1.xlsx
- USCIS H-1B Employer Data Hub CSV (approval/denial trend source):
	https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv

The fetch script writes files to [apps/web/public/data](apps/web/public/data):

- dol_lca_h1b_fy2026_q1.csv (normalized to app schema)
- uscis_h1b_employer_data_hub_2023.csv (raw USCIS export)
- parquet/dol_lca_h1b_fy2026_q1.parquet (optimized single-file analytics)
- parquet/dol_lca_h1b_fy2026_q1_partitioned/ (year-partitioned parquet layout)

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
