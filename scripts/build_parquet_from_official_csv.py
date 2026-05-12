#!/usr/bin/env python3
import argparse
import pathlib

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as csv
import pyarrow.dataset as ds
import pyarrow.parquet as pq


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
            }
        ),
    )

    if max_rows is not None:
        table = table.slice(0, max_rows)

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
        default="apps/web/public/data/dol_lca_h1b_fy2020_q1_to_fy2026_q1.csv",
        help="Path to normalized CSV input.",
    )
    parser.add_argument(
        "--out",
        default="apps/web/public/data/parquet",
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
