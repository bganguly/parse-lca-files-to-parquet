#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <s3-bucket-name> [region]"
  exit 1
fi

BUCKET="$1"
REGION="${2:-us-east-1}"
ORIGIN_DOMAIN="$BUCKET.s3.$REGION.amazonaws.com"

DIST_CONFIG_JSON="$(mktemp)"
cat > "$DIST_CONFIG_JSON" <<JSON
{
  "CallerReference": "h1b-parquet-$(date +%s)",
  "Aliases": {"Quantity": 0},
  "DefaultRootObject": "",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "s3-origin",
        "DomainName": "$ORIGIN_DOMAIN",
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "S3OriginConfig": {"OriginAccessIdentity": ""},
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": false}
      }
    ]
  },
  "OriginGroups": {"Quantity": 0},
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"], "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}},
    "Compress": true,
    "CachePolicyId": "658327ea-f89d-4fab-a63d-7e88639e58f6"
  },
  "CacheBehaviors": {"Quantity": 0},
  "CustomErrorResponses": {"Quantity": 0},
  "Comment": "H1B parquet distribution",
  "Logging": {"Enabled": false, "IncludeCookies": false, "Bucket": "", "Prefix": ""},
  "PriceClass": "PriceClass_100",
  "Enabled": true,
  "ViewerCertificate": {"CloudFrontDefaultCertificate": true},
  "Restrictions": {"GeoRestriction": {"RestrictionType": "none", "Quantity": 0}},
  "WebACLId": "",
  "HttpVersion": "http2",
  "IsIPV6Enabled": true
}
JSON

echo "Creating CloudFront distribution for $ORIGIN_DOMAIN ..."
aws cloudfront create-distribution --distribution-config "file://$DIST_CONFIG_JSON"
rm -f "$DIST_CONFIG_JSON"

echo "Done. Update bucket policy/CORS to allow CloudFront and browser access."
