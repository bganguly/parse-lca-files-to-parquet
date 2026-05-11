# H1B Natural Language Query System (No Database Prototype)

![Status](https://img.shields.io/badge/status-prototype-orange)
![Frontend](https://img.shields.io/badge/frontend-react%20%2B%20typescript-0b7285)
![Engine](https://img.shields.io/badge/query%20engine-duckdb--wasm-c2410c)
![Build](https://img.shields.io/badge/build-passing-2b8a3e)

Natural language -> SQL (LLM) -> DuckDB-WASM -> table/chart visualization in the browser.

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

## Quick Start

1. Install dependencies

```bash
npm install
```

2. Fetch official datasets and build normalized CSV

```bash
python3 -m pip install --user openpyxl
npm run fetch:official-data
```

This command downloads official files from DOL and USCIS and converts DOL's XLSX into a normalized CSV for the app.

3. Build parquet files (single + year partitioned)

```bash
python3 -m pip install --user pyarrow
npm run build:parquet
```

This generates:

- `apps/web/public/data/parquet/dol_lca_h1b_fy2026_q1.parquet`
- `apps/web/public/data/parquet/dol_lca_h1b_fy2026_q1_partitioned/year=YYYY/part-*.parquet`

4. Start app

```bash
npm run dev
```

5. Open the shown local URL (usually `http://localhost:5173`).

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
