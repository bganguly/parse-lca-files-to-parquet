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

> [!IMPORTANT]
> - If this is your first time working on this repo, use the usual 3-args flow (`bucket-name`, `aws-region`, `version-tag`).
> - **Incremental fetching is automatic.** `data/manifest.json` tracks the last processed fiscal quarter. On every run, the fetch script reads the manifest and only downloads quarters that are newer than the last recorded one — no manual range args needed.

To rebuild everything from scratch (re-download all quarters, regenerate all parquet):

```bash
# 1. Reset the manifest to before FY2020 Q1 so the fetch script re-downloads all quarters
echo '{"start_fy":2020,"start_quarter":1,"last_fy":2019,"last_quarter":4,"updated_at":"'$(date +%Y-%m-%d)'"}' > data/manifest.json

# 2. Delete any existing combined CSV and parquet outputs
rm -f data/dol_lca_h1b_combined.csv
rm -rf data/parquet/

# 3. Run the full pipeline
npm run infra:up -- [bucket-name] [aws-region] [version-tag]
```

> **Note:** After the run completes, `data/manifest.json` will be updated automatically to the latest quarter. Commit it to git to preserve the new state.

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
