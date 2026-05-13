#!/usr/bin/env python3
import argparse
import csv
import pathlib
import re
from collections import Counter

import pyarrow as pa
import pyarrow.parquet as pq

UNKNOWN_COUNTRY_MARKERS = {"", "unknown", "n/a", "na", "null", "none"}
SUFFIX_PATTERN = re.compile(
    r"\b(INC|INCORPORATED|LLC|L\.L\.C\.|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLC|PTE|PVT|PRIVATE)\b",
    re.IGNORECASE,
)


def canonicalize_employer(name: str) -> str:
    normalized = name.upper().strip()
    normalized = re.sub(r"[^A-Z0-9\s]", " ", normalized)
    normalized = SUFFIX_PATTERN.sub(" ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def canonicalize_country(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    normalized = re.sub(r"\s+", " ", text.upper())
    if normalized.lower() in UNKNOWN_COUNTRY_MARKERS:
        return ""
    return normalized


def confidence_from_share(share: float) -> str:
    if share >= 0.75:
        return "high"
    if share >= 0.50:
        return "medium"
    return "low"


def build_mapping(input_csv: pathlib.Path, output_parquet: pathlib.Path, top_k: int) -> None:
    if not input_csv.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")

    country_counts_by_employer: dict[str, Counter] = {}
    raw_employer_example: dict[str, str] = {}

    with input_csv.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)

        required_fields = {"employer", "country"}
        missing = required_fields.difference(reader.fieldnames or set())
        if missing:
            raise ValueError(
                f"Input CSV is missing required fields: {', '.join(sorted(missing))}"
            )

        for row in reader:
            employer_raw = (row.get("employer") or "").strip()
            if not employer_raw:
                continue

            employer_key = canonicalize_employer(employer_raw)
            if not employer_key:
                continue

            country_key = canonicalize_country(row.get("country") or "")
            if not country_key:
                continue

            if employer_key not in country_counts_by_employer:
                country_counts_by_employer[employer_key] = Counter()
                raw_employer_example[employer_key] = employer_raw

            country_counts_by_employer[employer_key][country_key] += 1

    rows: list[dict[str, object]] = []

    for employer_key, counts in country_counts_by_employer.items():
        total = sum(counts.values())
        if total == 0:
            continue

        ranked = counts.most_common(top_k)

        for rank, (country, count) in enumerate(ranked, start=1):
            share = count / total
            rows.append(
                {
                    "employer_raw_example": raw_employer_example[employer_key],
                    "employer_normalized": employer_key,
                    "possible_country": country,
                    "country_observation_count": count,
                    "country_share": share,
                    "possible_country_rank": rank,
                    "total_country_observations": total,
                    "confidence": confidence_from_share(share),
                    "method": "country_frequency_from_dol_rows",
                }
            )

    output_parquet.parent.mkdir(parents=True, exist_ok=True)

    table = pa.Table.from_pylist(
        rows,
        schema=pa.schema(
            [
                ("employer_raw_example", pa.string()),
                ("employer_normalized", pa.string()),
                ("possible_country", pa.string()),
                ("country_observation_count", pa.int64()),
                ("country_share", pa.float64()),
                ("possible_country_rank", pa.int32()),
                ("total_country_observations", pa.int64()),
                ("confidence", pa.string()),
                ("method", pa.string()),
            ]
        ),
    )

    pq.write_table(table, output_parquet, compression="zstd")

    print("Built local-only employer-country mapping parquet:", output_parquet)
    print("Rows:", table.num_rows)
    print(
        "Note: This is a heuristic possible-country mapping derived from DOL country frequencies, not legal domicile/HQ truth."
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--in-csv",
        default="data/dol_lca_h1b_fy2020_q1_to_fy2026_q1.csv",
        help="Input normalized DOL CSV path.",
    )
    parser.add_argument(
        "--out",
        default="data/local_parquet/employer_possible_country_mapping.parquet",
        help="Output parquet path (local-only, not uploaded by S3 sync script).",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=3,
        help="How many possible countries to keep per employer.",
    )
    args = parser.parse_args()

    if args.top_k < 1:
        raise ValueError("--top-k must be >= 1")

    root = pathlib.Path(__file__).resolve().parents[1]
    input_csv = root / args.in_csv
    output_parquet = root / args.out

    build_mapping(input_csv=input_csv,
                  output_parquet=output_parquet, top_k=args.top_k)


if __name__ == "__main__":
    main()
