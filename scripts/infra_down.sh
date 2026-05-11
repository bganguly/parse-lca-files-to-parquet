#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STATE_FILE="$ROOT_DIR/.infra/state.env"

BUCKET="${1:-}"
REGION="${2:-}"

if [[ -z "$BUCKET" && -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  BUCKET="${BUCKET:-}"
  REGION="${REGION:-us-east-1}"
fi

REGION="${REGION:-us-east-1}"

if [[ -z "$BUCKET" ]]; then
  echo "Usage: $0 <bucket-name> [region]"
  echo "Or run infra:up first so .infra/state.env can be used automatically."
  exit 1
fi

echo "[infra:down] bucket: $BUCKET"
echo "[infra:down] region: $REGION"

echo "[infra:down] removing objects..."
AWS_PAGER="" aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" || true

echo "[infra:down] removing policy/cors/public-access-block..."
AWS_PAGER="" aws s3api delete-bucket-policy --bucket "$BUCKET" --region "$REGION" || true
AWS_PAGER="" aws s3api delete-bucket-cors --bucket "$BUCKET" --region "$REGION" || true
AWS_PAGER="" aws s3api delete-public-access-block --bucket "$BUCKET" --region "$REGION" || true

echo "[infra:down] deleting bucket..."
AWS_PAGER="" aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"

if [[ -f "$STATE_FILE" ]]; then
  rm -f "$STATE_FILE"
  rmdir "$ROOT_DIR/.infra" >/dev/null 2>&1 || true
fi

echo "[infra:down] done"
