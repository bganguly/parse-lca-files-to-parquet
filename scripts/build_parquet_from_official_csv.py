#!/usr/bin/env python3
import argparse
import pathlib

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as csv
import pyarrow.dataset as ds
import pyarrow.parquet as pq

SPARSE_TEXT_COLUMNS = ("country",)
MISSING_TEXT_MARKERS = ("", "unknown", "n/a", "na", "null", "none")
MISSING_RATIO_THRESHOLD = 0.90


def null_sparse_text_columns(table: pa.Table) -> pa.Table:
    if table.num_rows == 0:
        return table

    updated = table

    for column_name in SPARSE_TEXT_COLUMNS:
        column_index = updated.schema.get_field_index(column_name)
        if column_index < 0:
            continue

        col = updated[column_name]
        normalized = pc.utf8_lower(
            pc.utf8_trim_whitespace(pc.fill_null(col, "")))
        missing_mask = pc.is_in(
            normalized, value_set=pa.array(MISSING_TEXT_MARKERS))
        missing_count = pc.sum(pc.cast(missing_mask, pa.int64())).as_py() or 0
        missing_ratio = missing_count / updated.num_rows

        if missing_ratio >= MISSING_RATIO_THRESHOLD:
            updated = updated.set_column(
                column_index,
                column_name,
                pa.nulls(updated.num_rows, type=pa.string()),
            )
            print(
                f"Column '{column_name}' is {missing_ratio:.3%} missing/unknown; writing NULLs to parquet instead of placeholders."
            )

    return updated


def build_parquet(csv_path: pathlib.Path, output_dir: pathlib.Path, max_rows: int | None) -> None:
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    table = csv.read_csv(
        csv_path,
        convert_options=csv.ConvertOptions(
            column_types={
                "employer": pa.string(),
                "job_title": pa.string(),
                "country": pa.string(),
                "work_location": pa.string(),
                "wage": pa.float64(),
                "status": pa.string(),
                "year": pa.int32(),
                "fiscal_year": pa.int32(),
                "fiscal_quarter": pa.int32(),
            }
        ),
    )

    if max_rows is not None:
        table = table.slice(0, max_rows)

    table = null_sparse_text_columns(table)

    dataset_stem = csv_path.stem
    single_parquet = output_dir / f"{dataset_stem}.parquet"
    pq.write_table(table, single_parquet, compression="zstd")

    partition_dir = output_dir / f"{dataset_stem}_partitioned"
    if partition_dir.exists():
        for child in sorted(partition_dir.rglob("*"), reverse=True):
            if child.is_file():
                child.unlink()
            elif child.is_dir():
                child.rmdir()
        partition_dir.rmdir()

    ds.write_dataset(
        table,
        base_dir=str(partition_dir),
        format="parquet",
        partitioning=ds.partitioning(
            pa.schema([("year", pa.int32())]), flavor="hive"),
        existing_data_behavior="overwrite_or_ignore",
    )

    status_counts = pc.value_counts(table["status"])
    print("Built single parquet:", single_parquet)
    print("Built partitioned parquet dir:", partition_dir)
    print("Rows:", table.num_rows)
    print("Status counts:", status_counts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        default="data/dol_lca_h1b_combined.csv",
        help="Path to normalized CSV input.",
    )
    parser.add_argument(
        "--out",
        default="data/parquet",
        help="Output directory for parquet files.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Optional row cap while building parquet.",
    )
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parents[1]
    csv_path = root / args.csv
    out_dir = root / args.out

    build_parquet(csv_path, out_dir, args.max_rows)


if __name__ == "__main__":
    main()
