# H1B LCA Parquet Pipeline

Pipeline-only repository that downloads official H-1B LCA disclosures, normalizes them into CSV, builds parquet outputs, and uploads parquet to S3.

## What This Repo Does

- Downloads DOL LCA quarterly XLSX files.
- Downloads USCIS H-1B Employer Data Hub CSV.
- Normalizes DOL records into a combined CSV dataset.
- Builds both single-file parquet and year-partitioned parquet.
- Uploads parquet outputs to S3.

## Prerequisites

- Python 3.10+
- AWS CLI configured (`aws configure`) for S3 operations
- Python packages: `openpyxl`, `pyarrow`

Install Python dependencies:

```bash
python3 -m pip install --user openpyxl pyarrow
```

## Quick Start

Run the full local data pipeline:

```bash
npm run pipeline:run
```

This executes:

1. `npm run fetch:official-data`
2. `npm run build:parquet`

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
- `data/uscis_h1b_employer_data_hub_2023.csv`
- `data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1.parquet`
- `data/parquet/dol_lca_h1b_fy2020_q1_to_fy2026_q1_partitioned/`

## Official Data Sources

- DOL LCA disclosure quarterly XLSX:
  `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY{FY}_Q{Q}.xlsx`
- USCIS H-1B Employer Data Hub CSV:
  `https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv`

## Parallel Fetch/Normalize Tuning

Example for faster ingest:

```bash
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 6 --parallel-normalize 3
```

Conservative defaults for older 16 GB Macs:

```bash
python3 scripts/fetch_official_h1b_data.py --parallel-downloads 4 --parallel-normalize 2
```
