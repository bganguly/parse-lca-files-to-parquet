# H1B LCA Parquet Pipeline

Pipeline-only repository that downloads official H-1B LCA disclosures, normalizes them into CSV, builds parquet outputs, and uploads parquet to S3.

## What This Repo Does

- Downloads DOL LCA quarterly XLSX files.
- Normalizes DOL records into a combined CSV dataset.
- Builds both single-file parquet and year-partitioned parquet.
- Uploads parquet outputs to S3.
- Optionally builds a local-only employer-to-possible-country parquet mapping (heuristic).

## Pipeline Diagram

![Pipeline flow](docs/images/pipeline-flow.png)

## Prerequisites

- Python 3.10+
- AWS CLI configured (`aws configure`) for S3 operations
- Python packages: `openpyxl`, `pyarrow`

Install Python dependencies:

```bash
python3 -m pip install --user openpyxl pyarrow
```

## Quick Start

Run guidance:

> [!IMPORTANT]
> - If this is your first time working on this repo, use the usual 3-args flow (`bucket-name`, `aws-region`, `version-tag`).
> - If you have done this before, first check whether parquet already exists (local `data/parquet/` and/or in your S3 bucket). If it exists, run an independent repeat flow where you only parse new XLSX data and upload refreshed parquet artifacts, instead of treating every run as a full first-time bootstrap.

To fetch all quarters from FY2020 Q1 through the current quarter dynamically:

```bash
month=$(date +%-m); year=$(date +%Y)
if (( month >= 10 )); then end_fy=$((year + 1)); else end_fy=$year; fi
if (( month >= 10 )); then fq=1; elif (( month >= 7 )); then fq=4; elif (( month >= 4 )); then fq=3; else fq=2; fi
python3 scripts/fetch_official_h1b_data.py --start-fy 2020 --start-quarter 1 --end-fy $end_fy --end-quarter $fq --parallel-downloads 4 --parallel-normalize 2
```

Default goal (recommended): build and upload parquet to S3 in one flow:

```bash
npm run infra:up -- [bucket-name] [aws-region] [version-tag]
```

Example with all three values:

```bash
npm run infra:up -- h1b-lca-parquet-prod us-east-1 full_multi_fiscal_noempty_countrynull_$(date +%Y%m%d)
```

- If `bucket-name` is omitted, a unique bucket is created automatically.
- If `version-tag` is provided, cache-busted URLs are also printed.

Local-only pipeline (no S3 upload):

```bash
npm run pipeline:run
```

This local-only command executes:

1. `npm run fetch:official-data`
2. `npm run build:parquet`

Typical end-to-end runtime is about 20-25 minutes (depending on network and machine).

After fetch/normalize completes, temporary local quarter XLSX and intermediate normalized CSV files are removed automatically.

## Commands

- Fetch and normalize official source data:

```bash
npm run fetch:official-data
```

- Build parquet from normalized CSV:

```bash
npm run build:parquet
```

- Optional: build local-only employer country mapping parquet (not uploaded to S3):

```bash
npm run build:employer-country-map
```

This mapping is heuristic and based on country frequencies seen in DOL rows for each employer name.

- Upload parquet to S3:

```bash
npm run upload:s3:parquet -- <your-bucket-name> <aws-region> [version-tag]
```

Example with all three values:

```bash
npm run upload:s3:parquet -- h1b-lca-parquet-prod us-east-1 full_multi_fiscal_noempty_countrynull_$(date +%Y%m%d)
```

If `version-tag` is provided, the script also prints cache-busted URLs with `?v=<version-tag>`.

- End-to-end infra flow (fetch + parquet + bucket setup + upload):

```bash
npm run infra:up -- [bucket-name] [aws-region] [version-tag]
```

- Tear down infra bucket and objects:

```bash
npm run infra:down -- [bucket-name] [aws-region]
```

- Optional CloudFront in front of S3:

```bash
npm run create:cloudfront -- <your-bucket-name> <aws-region>
```

## Data Layout

The pipeline writes to `data/`:

- `data/manifest.json` — tracks the last successfully processed fiscal quarter; committed to git
- `data/dol_lca_h1b_combined.csv` — combined normalized CSV (gitignored; rebuilt on each run)
- `data/parquet/dol_lca_h1b_combined.parquet`
- `data/parquet/dol_lca_h1b_combined_partitioned/`
- `data/local_parquet/employer_possible_country_mapping.parquet` (local-only; not included in S3 upload sync)

## Official Data Sources

- DOL LCA disclosure quarterly XLSX:
  `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY{FY}_Q{Q}.xlsx`

## Parallel Fetch/Normalize Tuning

Conservative defaults for older 16 GB Macs:

```bash
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 4 --parallel-normalize 2
```

Example for faster ingest:

```bash
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 6 --parallel-normalize 3
```
