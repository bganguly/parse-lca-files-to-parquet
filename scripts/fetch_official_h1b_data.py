#!/usr/bin/env python3
import argparse
import csv
import pathlib
import re
import subprocess
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor

from openpyxl import load_workbook

DOL_LCA_XLSX_URL_TEMPLATE = "https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_FY{fy}_Q{quarter}.xlsx"
USCIS_CSV_URL = "https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-2023.csv"


def download_file(url: str, target: pathlib.Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "curl",
            "-L",
            "--fail",
            url,
            "-o",
            str(target),
        ],
        check=True,
    )


def ensure_download(url: str, target: pathlib.Path, force_download: bool) -> None:
    if not force_download and target.exists() and target.stat().st_size > 0:
        print(f"Reusing cached source: {target.name}")
        return

    print(f"Downloading: {target.name}")
    download_file(url, target)


def as_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def parse_number(value):
    text = as_text(value)
    if not text:
        return ""
    normalized = re.sub(r"[$,\s]", "", text)
    try:
        return float(normalized)
    except ValueError:
        return ""


def parse_year(row: dict, fallback_year: int) -> int:
    candidates = [
        row.get("CASE_SUBMITTED"),
        row.get("RECEIVED_DATE"),
        row.get("DECISION_DATE"),
        row.get("BEGIN_DATE"),
        row.get("END_DATE"),
        row.get("CASE_RECEIVED_DATE"),
    ]

    for value in candidates:
        text = as_text(value)
        match = re.search(r"(20\d{2})", text)
        if match:
            return int(match.group(1))

    return fallback_year


def resolve_employer_name(row: dict, status: str) -> str:
    employer = as_text(row.get("EMPLOYER_NAME")
                       or row.get("EMPLOYER_NAME_DECLARED"))

    if employer:
        return employer

    alternate_name = as_text(
        row.get("TRADE_NAME_DBA")
        or row.get("SECONDARY_ENTITY_BUSINESS_NAME")
        or row.get("LAWFIRM_NAME_BUSINESS_NAME")
        or row.get("PREPARER_BUSINESS_NAME")
    )

    if alternate_name:
        return alternate_name

    # Many FY2026 Q1 rows are not adjudicated yet and omit employer in the disclosure extract.
    if not status:
        return "N/A - Employer Not Published"

    return ""


def iter_fiscal_quarters(start_fy: int, start_quarter: int, end_fy: int, end_quarter: int) -> Iterator[tuple[int, int]]:
    fy = start_fy
    quarter = start_quarter

    while (fy < end_fy) or (fy == end_fy and quarter <= end_quarter):
        yield fy, quarter

        quarter += 1
        if quarter > 4:
            fy += 1
            quarter = 1


def convert_dol_xlsx_to_normalized_csv(
    source_xlsx: pathlib.Path,
    output_handle,
    write_header: bool,
    fallback_year: int,
    fallback_quarter: int,
    max_rows: int | None,
) -> int:
    workbook = load_workbook(filename=source_xlsx,
                             read_only=True, data_only=True)
    worksheet = workbook.worksheets[0]

    rows_iter = worksheet.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if not header:
        raise RuntimeError("DOL workbook has no header row.")

    headers = [as_text(value) for value in header]

    writer = csv.writer(output_handle)
    if write_header:
        writer.writerow(
            [
                "employer",
                "job_title",
                "country",
                "work_location",
                "wage",
                "status",
                "year",
                "fiscal_year",
                "fiscal_quarter",
            ]
        )

    count = 0

    for row_values in rows_iter:
        if not any(value is not None and as_text(value) for value in row_values):
            continue

        row = {headers[index]: row_values[index]
               for index in range(min(len(headers), len(row_values)))}

        visa_class = as_text(row.get("VISA_CLASS")).upper()
        if visa_class and visa_class not in {"H-1B", "H-1B1", "E-3"}:
            continue

        status = as_text(row.get("CASE_STATUS") or row.get("STATUS"))
        employer = resolve_employer_name(row, status)
        job_title = as_text(row.get("JOB_TITLE") or row.get("SOC_TITLE"))
        country = as_text(row.get("WORKSITE_COUNTRY") or row.get(
            "COUNTRY_OF_CITIZENSHIP") or "Unknown")
        city = as_text(row.get("WORKSITE_CITY"))
        state = as_text(row.get("WORKSITE_STATE"))
        work_location = ", ".join([part for part in [city, state] if part])
        wage = (
            parse_number(row.get("WAGE_RATE_OF_PAY_FROM"))
            or parse_number(row.get("WAGE_RATE_OF_PAY_TO"))
            or parse_number(row.get("PREVAILING_WAGE"))
        )
        year = parse_year(row, fallback_year)

        writer.writerow(
            [
                employer,
                job_title,
                country,
                work_location,
                wage,
                status,
                year,
                fallback_year,
                fallback_quarter,
            ]
        )
        count += 1

        if max_rows is not None and count >= max_rows:
            break

    workbook.close()
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-rows", type=int, default=None)
    parser.add_argument("--start-fy", type=int, default=2020)
    parser.add_argument("--start-quarter", type=int, default=1)
    parser.add_argument("--end-fy", type=int, default=2026)
    parser.add_argument("--end-quarter", type=int, default=1)
    parser.add_argument("--parallel-downloads", type=int, default=4)
    parser.add_argument("--force-download", action="store_true")
    args = parser.parse_args()

    if args.start_quarter < 1 or args.start_quarter > 4:
        raise ValueError("--start-quarter must be between 1 and 4")
    if args.end_quarter < 1 or args.end_quarter > 4:
        raise ValueError("--end-quarter must be between 1 and 4")
    if (args.start_fy, args.start_quarter) > (args.end_fy, args.end_quarter):
        raise ValueError("start fiscal quarter must be <= end fiscal quarter")
    if args.parallel_downloads < 1:
        raise ValueError("--parallel-downloads must be >= 1")

    root = pathlib.Path(__file__).resolve().parents[1]
    data_dir = root / "apps" / "web" / "public" / "data"
    source_dir = data_dir / "sources"
    source_dir.mkdir(parents=True, exist_ok=True)

    dataset_stem = f"dol_lca_h1b_fy{args.start_fy}_q{args.start_quarter}_to_fy{args.end_fy}_q{args.end_quarter}"

    dol_csv_path = data_dir / f"{dataset_stem}.csv"
    uscis_csv_path = data_dir / "uscis_h1b_employer_data_hub_2023.csv"

    print("Downloading USCIS H-1B Employer Data Hub CSV...")
    download_file(USCIS_CSV_URL, uscis_csv_path)

    fiscal_quarters = list(
        iter_fiscal_quarters(args.start_fy, args.start_quarter,
                             args.end_fy, args.end_quarter)
    )

    quarter_jobs: list[tuple[int, int, pathlib.Path, str]] = []
    for fy, quarter in fiscal_quarters:
        filename = f"LCA_Disclosure_Data_FY{fy}_Q{quarter}.xlsx"
        quarter_url = DOL_LCA_XLSX_URL_TEMPLATE.format(fy=fy, quarter=quarter)
        quarter_xlsx = source_dir / filename
        quarter_jobs.append((fy, quarter, quarter_xlsx, quarter_url))

    print(f"Preparing {len(quarter_jobs)} DOL quarter files with parallel downloads={args.parallel_downloads}...")
    with ThreadPoolExecutor(max_workers=args.parallel_downloads) as executor:
        futures = [
            executor.submit(ensure_download, quarter_url, quarter_xlsx, args.force_download)
            for _, _, quarter_xlsx, quarter_url in quarter_jobs
        ]
        for future in futures:
            future.result()

    total_rows = 0
    output_written = False

    dol_csv_path.parent.mkdir(parents=True, exist_ok=True)
    with dol_csv_path.open("w", newline="", encoding="utf-8") as output_handle:
        for index, (fy, quarter, quarter_xlsx, _quarter_url) in enumerate(quarter_jobs):

            print(f"Converting FY{fy} Q{quarter} to normalized rows...")
            row_cap = None
            if args.max_rows is not None:
                remaining = max(args.max_rows - total_rows, 0)
                row_cap = remaining
            converted = convert_dol_xlsx_to_normalized_csv(
                source_xlsx=quarter_xlsx,
                output_handle=output_handle,
                write_header=(index == 0),
                fallback_year=fy,
                fallback_quarter=quarter,
                max_rows=row_cap,
            )
            output_written = output_written or converted > 0
            total_rows += converted

            if args.max_rows is not None and total_rows >= args.max_rows:
                break

    if not output_written:
        raise RuntimeError(
            "No DOL rows were written. Check source files and conversion logic.")

    # Remove older single-quarter normalized CSV if present to avoid confusion.
    legacy_csv = data_dir / "dol_lca_h1b_fy2026_q1.csv"
    if legacy_csv.exists() and legacy_csv != dol_csv_path:
        legacy_csv.unlink()

    print("Done.")
    print(f"USCIS CSV: {uscis_csv_path}")
    print(
        f"DOL fiscal quarter range: FY{args.start_fy} Q{args.start_quarter} -> FY{args.end_fy} Q{args.end_quarter}")
    print(f"DOL normalized CSV rows: {total_rows}")
    print(f"DOL normalized CSV: {dol_csv_path}")


if __name__ == "__main__":
    main()
