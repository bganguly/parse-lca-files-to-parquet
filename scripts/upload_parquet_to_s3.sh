#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <s3-bucket-name> [region]"
  exit 1
fi

BUCKET="$1"
REGION="${2:-us-east-1}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARQUET_DIR="$ROOT_DIR/apps/web/public/data/parquet"

if [[ ! -d "$PARQUET_DIR" ]]; then
  echo "Parquet directory not found: $PARQUET_DIR"
  echo "Run: npm run build:parquet"
  exit 1
fi

echo "Uploading parquet files to s3://$BUCKET/data/parquet ..."
aws s3 sync "$PARQUET_DIR" "s3://$BUCKET/data/parquet" \
  --region "$REGION" \
  --delete \
  --cache-control "public,max-age=300,must-revalidate"

echo "Upload complete."
echo "Single parquet URL: https://$BUCKET.s3.$REGION.amazonaws.com/data/parquet/dol_lca_h1b_fy2026_q1.parquet"
echo "Partition root URL: https://$BUCKET.s3.$REGION.amazonaws.com/data/parquet/dol_lca_h1b_fy2026_q1_partitioned/year=*/part-*.parquet"
