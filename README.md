# H1B LCA Parquet Pipeline

Pipeline-only repository that downloads official H-1B LCA disclosures, normalizes them into CSV, builds parquet outputs, and uploads parquet to S3.

## What This Repo Does

- Downloads DOL LCA quarterly XLSX files.
- Normalizes DOL records into a combined CSV dataset.
- Builds both single-file parquet and year-partitioned parquet.
- Uploads parquet outputs to S3.

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

> - **First time:** Run the full 3-args flow below. This downloads all quarters from FY2020, builds parquet, creates the S3 bucket, and uploads. The manifest is written automatically at the end — commit it.
>   ```bash
>   npm run infra:up -- [bucket-name] [aws-region] [version-tag]
>   ```
>   Example:
>   ```bash
>   npm run infra:up -- h1b-lca-parquet-prod us-east-1 full_multi_fiscal_noempty_countrynull_$(date +%Y%m%d)
>   ```
>   - If `bucket-name` is omitted, a unique bucket is created automatically.
>   - If `version-tag` is provided, cache-busted URLs are also printed.
>   - Typical end-to-end runtime is about 20-25 minutes. Temporary XLSX and intermediate CSV files are removed automatically.
> - **Incremental (2nd+ run, new quarters only):** Just run `npm run infra:up` again with the same args. The fetch script reads `data/manifest.json` and only downloads quarters newer than the last recorded one — no manual range args needed.
> - **Full rebuild from scratch (2nd+ run):** Reset the manifest, delete existing outputs, then run infra:up:
>   ```bash
>   echo '{"start_fy":2020,"start_quarter":1,"last_fy":2019,"last_quarter":4,"updated_at":"'$(date +%Y-%m-%d)'"}' > data/manifest.json
>   rm -f data/dol_lca_h1b_combined.csv && rm -rf data/parquet/
>   npm run infra:up -- [bucket-name] [aws-region] [version-tag]
>   ```
>   Commit the updated manifest after the run.

## Commands

```bash
# Fetch and normalize official source data
npm run fetch:official-data

# Build parquet from normalized CSV
npm run build:parquet

# Upload parquet to S3 (version-tag optional; prints cache-busted URLs if provided)
npm run upload:s3:parquet -- <bucket-name> <aws-region> [version-tag]

# End-to-end: fetch + parquet + bucket setup + upload
npm run infra:up -- [bucket-name] [aws-region] [version-tag]

# Tear down infra bucket and objects
npm run infra:down -- [bucket-name] [aws-region]
```

## Data Layout

The pipeline writes to `data/`:

- `data/manifest.json` — tracks the last successfully processed fiscal quarter; committed to git
- `data/dol_lca_h1b_combined.csv` — combined normalized CSV (gitignored; rebuilt on each run)
- `data/parquet/dol_lca_h1b_combined.parquet`
- `data/parquet/dol_lca_h1b_combined_partitioned/`

## Official Data Sources

- DOL LCA disclosure quarterly XLSX:
  `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY{FY}_Q{Q}.xlsx`  
  e.g. [LCA_Disclosure_Data_FY2026_Q1.xlsx](https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY2026_Q1.xlsx)

## Parallel Fetch/Normalize Tuning

```bash
# Conservative defaults (older 16 GB Macs)
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 4 --parallel-normalize 2

# Faster ingest
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 6 --parallel-normalize 3
```
