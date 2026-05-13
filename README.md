# H1B LCA Parquet Pipeline

Pipeline-only repository that downloads official H-1B LCA disclosures, normalizes them into CSV, builds parquet outputs, and uploads parquet to S3.

## What This Repo Does

- Downloads DOL LCA quarterly XLSX files.
- Normalizes DOL records into a combined CSV dataset.
- Builds both single-file parquet and year-partitioned parquet.
- Uploads parquet outputs to S3.
- Builds a local-only employer-to-possible-country parquet mapping (heuristic).

## Prerequisites

- Python 3.10+
- AWS CLI configured (`aws configure`) for S3 operations
- Python packages: `openpyxl`, `pyarrow`

Install Python dependencies:

```bash
python3 -m pip install --user openpyxl pyarrow
```

## Quick Start

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

- Build local-only employer country mapping parquet (not uploaded to S3):

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

- `data/dol_lca_h1b_fy2020_q1_to_fy2026_q1.csv`
- `data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1.parquet`
- `data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1_partitioned/`
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
