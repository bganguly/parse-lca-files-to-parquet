#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <s3-bucket-name> [region] [version-tag]"
  exit 1
fi

BUCKET="$1"
REGION="${2:-us-east-1}"
VERSION_TAG="${3:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARQUET_DIR="$ROOT_DIR/data/parquet"
DATASET_STEM="dol_lca_h1b_combined"
SINGLE_PARQUET_URL="https://$BUCKET.s3.$REGION.amazonaws.com/data/parquet/$DATASET_STEM.parquet"
PARTITION_ROOT_URL="https://$BUCKET.s3.$REGION.amazonaws.com/data/parquet/${DATASET_STEM}_partitioned/year=*/part-*.parquet"

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
echo "Single parquet URL: $SINGLE_PARQUET_URL"
echo "Partition root URL: $PARTITION_ROOT_URL"

if [[ -n "$VERSION_TAG" ]]; then
  echo "Single parquet URL (cache-busted): ${SINGLE_PARQUET_URL}?v=$VERSION_TAG"
  echo "Partition root URL (cache-busted): ${PARTITION_ROOT_URL}?v=$VERSION_TAG"
fi
