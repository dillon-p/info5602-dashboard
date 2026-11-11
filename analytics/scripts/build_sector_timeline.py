#!/usr/bin/env python3
"""Build the Question 7 sector-level Yes response timeline for the dashboard."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from statistics import fmean
from typing import Any, Iterable, Sequence

from openpyxl import load_workbook


SOURCE_PATH = Path(__file__).resolve().parents[1] / "notebooks" / "Sector.xlsx"
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "public" / "data" / "sector_ai_adoption.json"
QUESTION_ID = 7
EXCLUDED_SECTOR = "XX"
WEEK_PATTERN = re.compile(r"^\d{6}$")


def parse_week(value: Any) -> tuple[int, int]:
    week_text = str(value).strip()
    if not WEEK_PATTERN.fullmatch(week_text):
        raise ValueError(f"Invalid weekly column header: {value!r}")

    year, week = int(week_text[:4]), int(week_text[4:])
    if not 1 <= week <= 53:
        raise ValueError(f"Invalid week number in column header: {value!r}")
    return year, week


def parse_estimate(value: Any) -> tuple[str, float | None]:
    if value is None or value == ".":
        return "missing", None
    if value == "S":
        return "suppressed", None
    if not isinstance(value, str) or not value.endswith("%"):
        raise ValueError(f"Unexpected Question 7 response estimate: {value!r}")

    try:
        percentage = float(value[:-1])
    except ValueError as error:
        raise ValueError(f"Invalid percentage estimate: {value!r}") from error

    if not math.isfinite(percentage) or not 0 <= percentage <= 100:
        raise ValueError(f"Percentage estimate is outside the 0–100 range: {value!r}")
    return "estimate", percentage


def build_timeline(
    headers: Sequence[Any],
    rows: Iterable[Sequence[Any]],
) -> dict[str, Any]:
    weeks = [parse_week(header) for header in headers]
    if len(set(weeks)) != len(weeks):
        raise ValueError("The workbook contains duplicate weekly column headers.")

    estimates_by_sector: dict[str, Sequence[Any]] = {}
    question: str | None = None
    for row in rows:
        if len(row) < 5 + len(weeks):
            raise ValueError("A Question 7 row has fewer values than the weekly headers.")
        if row[1] != QUESTION_ID:
            continue

        if not isinstance(row[2], str) or not row[2].strip():
            raise ValueError("A Question 7 row has no question text.")
        if question is None:
            question = row[2].strip()
        elif question != row[2].strip():
            raise ValueError("Question 7 rows have inconsistent question text.")
        if row[4] != "Yes":
            continue

        sector = str(row[0]).strip()
        if not sector:
            raise ValueError("A Question 7 Yes row has no sector code.")
        if sector == EXCLUDED_SECTOR:
            continue
        if sector in estimates_by_sector:
            raise ValueError(f"Duplicate Question 7 Yes row for sector {sector!r}.")
        estimates_by_sector[sector] = row[5 : 5 + len(weeks)]

    if not estimates_by_sector:
        raise ValueError("The workbook contains no Question 7 Yes estimates for NAICS sectors.")

    weekly_values: list[dict[str, Any]] = []
    for index, (year, week) in sorted(enumerate(weeks), key=lambda item: item[1]):
        available: list[float] = []
        suppressed_count = 0
        for values in estimates_by_sector.values():
            status, percentage = parse_estimate(values[index])
            if status == "estimate" and percentage is not None:
                available.append(percentage)
            elif status == "suppressed":
                suppressed_count += 1

        if not available and suppressed_count == 0:
            continue

        weekly_values.append(
            {
                "year": year,
                "week": week,
                "yesPercent": round(fmean(available), 3) if available else None,
                "availableSectorCount": len(available),
                "lowConfidenceSectorCount": suppressed_count,
            }
        )

    return {
        "schemaVersion": 1,
        "questionId": QUESTION_ID,
        "question": question,
        "sectorCount": len(estimates_by_sector),
        "weeks": weekly_values,
    }


def build_from_workbook(source_path: Path = SOURCE_PATH) -> dict[str, Any]:
    if not source_path.is_file():
        raise FileNotFoundError(f"Sector workbook does not exist: {source_path}")

    workbook = load_workbook(source_path, read_only=True, data_only=True)
    if "Response Estimates" not in workbook.sheetnames:
        raise ValueError("The Sector workbook is missing the Response Estimates sheet.")

    worksheet = workbook["Response Estimates"]
    header = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True))
    if len(header) < 6:
        raise ValueError("The Response Estimates sheet has no weekly columns.")
    return build_timeline(header[5:], worksheet.iter_rows(min_row=2, values_only=True))


def write_timeline(timeline: dict[str, Any], output_path: Path = OUTPUT_PATH) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(timeline, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    timeline = build_from_workbook()
    write_timeline(timeline)
    print(f"Wrote {len(timeline['weeks'])} Question 7 weekly estimates to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
