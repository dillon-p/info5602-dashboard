#!/usr/bin/env python3
"""Download the latest public dashboard snapshot for local development."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from analytics.scripts.refresh_data import OUTPUT_PATH, number, validate_snapshot, write_snapshot


DEFAULT_SNAPSHOT_URL = (
    "https://dillon-p.github.io/info5602-dashboard/data/colorado-emissions.json"
)
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024


def download_snapshot(url: str, output_path: Path = OUTPUT_PATH) -> dict[str, Any]:
    separator = "&" if "?" in url else "?"
    request = urllib.request.Request(
        f"{url}{separator}_={time.time_ns()}",
        headers={
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "Colorado-ECHO-Emissions-Dashboard/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read(MAX_DOWNLOAD_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Public snapshot download failed (HTTP {error.code}).") from None
    except (TimeoutError, urllib.error.URLError) as error:
        detail = error.reason if isinstance(error, urllib.error.URLError) else error
        raise RuntimeError(f"Public snapshot download failed: {detail}.") from None

    if len(body) > MAX_DOWNLOAD_BYTES:
        raise RuntimeError(
            f"Public snapshot exceeds the {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MiB download limit."
        )
    try:
        snapshot = json.loads(body)
        if isinstance(snapshot, dict) and "minimum_reporting_year" not in snapshot:
            snapshot["minimum_reporting_year"] = 2016
            emissions = snapshot.get("emissions")
            if isinstance(emissions, list):
                snapshot["emissions"] = [
                    record
                    for record in emissions
                    if not isinstance(record, dict)
                    or (
                        number(record.get("reporting_year")) is not None
                        and number(record.get("reporting_year")) >= snapshot["minimum_reporting_year"]
                    )
                ]
                snapshot["record_count"] = len(snapshot["emissions"])
        snapshot = validate_snapshot(snapshot)
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"Downloaded snapshot is invalid: {error}") from None

    write_snapshot(snapshot, output_path)
    return snapshot


def main() -> None:
    url = os.environ.get("DASHBOARD_SNAPSHOT_URL", DEFAULT_SNAPSHOT_URL)
    snapshot = download_snapshot(url)
    print(
        f"Downloaded {snapshot['record_count']:,} records for "
        f"{snapshot['facility_count']:,} facilities to {OUTPUT_PATH}."
    )


if __name__ == "__main__":
    main()
