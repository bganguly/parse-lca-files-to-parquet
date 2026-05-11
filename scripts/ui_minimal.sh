#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[ui] installing python deps (openpyxl, pyarrow)..."
python3 -m pip install --user openpyxl pyarrow

echo "[ui] installing npm deps..."
npm install

echo "[ui] fetching official datasets..."
npm run fetch:official-data

echo "[ui] building parquet..."
npm run build:parquet

echo "[ui] starting dev server..."
npm run dev
