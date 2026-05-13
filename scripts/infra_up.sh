#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REGION="${2:-us-east-1}"
VERSION_TAG="${3:-}"
ACCOUNT_ID="$(AWS_PAGER="" aws sts get-caller-identity --query Account --output text)"
BUCKET="${1:-h1b-nlq-parquet-${ACCOUNT_ID}-$(date +%Y%m%d%H%M%S)}"
STATE_DIR="$ROOT_DIR/.infra"
STATE_FILE="$STATE_DIR/state.env"
SINGLE_PARQUET_URL="https://$BUCKET.s3.$REGION.amazonaws.com/data/parquet/dol_lca_h1b_combined.parquet"

echo "[infra:up] region: $REGION"
echo "[infra:up] bucket: $BUCKET"
if [[ -n "$VERSION_TAG" ]]; then
  echo "[infra:up] version tag: $VERSION_TAG"
fi

echo "[infra:up] installing python deps (openpyxl, pyarrow)..."
python3 -m pip install --user openpyxl pyarrow

echo "[infra:up] fetching official datasets..."
npm run fetch:official-data

echo "[infra:up] building parquet datasets..."
npm run build:parquet

if AWS_PAGER="" aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "[infra:up] bucket already exists: $BUCKET"
else
  echo "[infra:up] creating bucket..."
  if [[ "$REGION" == "us-east-1" ]]; then
    AWS_PAGER="" aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    AWS_PAGER="" aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
fi

echo "[infra:up] configuring bucket policy/CORS for browser parquet reads..."
AWS_PAGER="" aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

cat > /tmp/h1b_bucket_policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadParquet",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::$BUCKET/data/parquet/*"]
    }
  ]
}
EOF
AWS_PAGER="" aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/h1b_bucket_policy.json

cat > /tmp/h1b_cors.json <<EOF
{
  "CORSRules": [
    {
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag", "Accept-Ranges", "Content-Range"],
      "MaxAgeSeconds": 3000
    }
  ]
}
EOF
AWS_PAGER="" aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration file:///tmp/h1b_cors.json

echo "[infra:up] uploading parquet to S3..."
bash scripts/upload_parquet_to_s3.sh "$BUCKET" "$REGION" "$VERSION_TAG"

mkdir -p "$STATE_DIR"
cat > "$STATE_FILE" <<EOF
BUCKET=$BUCKET
REGION=$REGION
ACCOUNT_ID=$ACCOUNT_ID
EOF

echo "[infra:up] done"
echo "[infra:up] state file: $STATE_FILE"
echo "[infra:up] S3 parquet URL: $SINGLE_PARQUET_URL"
if [[ -n "$VERSION_TAG" ]]; then
  echo "[infra:up] S3 parquet URL (cache-busted): ${SINGLE_PARQUET_URL}?v=$VERSION_TAG"
fi
