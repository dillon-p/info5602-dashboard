#!/usr/bin/env python3
"""Refresh a public Colorado ECHO emissions snapshot using the authenticated API."""

from __future__ import annotations

import json
import math
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


API_BASE = "https://portal.gss.stonybrook.edu/api"
SOURCE_URL = "https://echo.epa.gov/tools/data-downloads/air-emissions-download-summary"
FACILITY_TABLE = "ECHO_EXPORTER"
EMISSIONS_TABLE = "POLL_RPT_COMBINED_EMISSIONS"
REQUEST_INTERVAL_SECONDS = 6
ID_BATCH_SIZE = 80
RETRY_LIMIT = 4
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "public" / "data" / "colorado-emissions.json"

PROGRAM_LABELS = {
    "EIS": "National Emissions Inventory (NEI)",
    "E-GGRT": "Greenhouse Gas Reporting Program (GHGRP)",
    "TRIS": "Toxics Release Inventory (TRI)",
    "CAMDBS": "Clean Air Markets (CAMD)",
}


def field(row: dict[str, Any], name: str) -> Any:
    """Read an API column without depending on its casing."""
    if name in row:
        return row[name]
    lowered = name.lower()
    return next((value for key, value in row.items() if key.lower() == lowered), None)


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def normalize_facilities(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    facilities: dict[str, dict[str, Any]] = {}
    for row in rows:
        registry_id = text(field(row, "registry_id"))
        if not registry_id:
            continue

        facility = {
            "registry_id": registry_id,
            "name": text(field(row, "fac_name")),
            "city": text(field(row, "fac_city")),
            "county": text(field(row, "fac_county")),
            "latitude": number(field(row, "fac_lat")),
            "longitude": number(field(row, "fac_long")),
        }
        existing = facilities.get(registry_id)
        if existing is None:
            facilities[registry_id] = facility
        else:
            for key, value in facility.items():
                if key != "registry_id" and (existing[key] in ("", None) and value not in ("", None)):
                    existing[key] = value

    return sorted(facilities.values(), key=lambda item: (item["name"].casefold(), item["registry_id"]))


def normalize_emissions(
    rows: Iterable[dict[str, Any]], facility_ids: set[str]
) -> list[dict[str, Any]]:
    emissions: list[dict[str, Any]] = []
    for row in rows:
        registry_id = text(field(row, "registry_id"))
        emission = number(field(row, "annual_emission"))
        year_value = number(field(row, "reporting_year"))
        program_code = text(field(row, "pgm_sys_acrnm"))
        pollutant = text(field(row, "pollutant_name"))
        unit = text(field(row, "unit_of_measure"))

        if (
            registry_id not in facility_ids
            or emission is None
            or year_value is None
            or not year_value.is_integer()
            or not program_code
            or not pollutant
            or not unit
        ):
            continue

        emissions.append(
            {
                "reporting_year": int(year_value),
                "registry_id": registry_id,
                "program": PROGRAM_LABELS.get(program_code, program_code),
                "program_code": program_code,
                "program_id": text(field(row, "pgm_sys_id")),
                "pollutant": pollutant,
                "annual_emission": emission,
                "unit_of_measure": unit,
                "nei_type": text(field(row, "nei_type")),
                "nei_hap_voc_flag": text(field(row, "nei_hap_voc_flag")),
            }
        )

    return sorted(
        emissions,
        key=lambda item: (
            item["reporting_year"],
            item["registry_id"],
            item["program_code"],
            item["pollutant"],
            item["unit_of_measure"],
        ),
    )


def build_snapshot(
    facility_rows: Iterable[dict[str, Any]],
    emission_rows: Iterable[dict[str, Any]],
    generated_at: str,
) -> dict[str, Any]:
    facilities = normalize_facilities(facility_rows)
    if not facilities:
        raise ValueError("The ECHO API returned no Colorado facilities; refusing to publish an empty snapshot.")

    emissions = normalize_emissions(
        emission_rows,
        {facility["registry_id"] for facility in facilities},
    )
    if not emissions:
        raise ValueError("The ECHO API returned no valid Colorado emission records; refusing to publish an empty snapshot.")

    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "source": SOURCE_URL,
        "facility_count": len(facilities),
        "record_count": len(emissions),
        "facilities": facilities,
        "emissions": emissions,
    }


class EchoApi:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.last_request_at: float | None = None

    def _wait_for_rate_limit(self) -> None:
        if self.last_request_at is None:
            return
        elapsed = time.monotonic() - self.last_request_at
        if elapsed < REQUEST_INTERVAL_SECONDS:
            time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)

    def read_table(self, table_name: str, sql: str) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"sql": sql})
        url = f"{self.base_url}/echo/{table_name}?{query}"

        for attempt in range(RETRY_LIMIT):
            self._wait_for_rate_limit()
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self.token}",
                    "User-Agent": "Colorado-ECHO-Emissions-Dashboard/1.0",
                },
            )
            self.last_request_at = time.monotonic()

            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    payload = json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 429 or error.code >= 500:
                    if attempt + 1 == RETRY_LIMIT:
                        raise RuntimeError(
                            f"ECHO API request failed after {RETRY_LIMIT} attempts (HTTP {error.code})."
                        ) from None
                    retry_after = error.headers.get("Retry-After", "")
                    try:
                        delay = max(REQUEST_INTERVAL_SECONDS, float(retry_after))
                    except ValueError:
                        delay = REQUEST_INTERVAL_SECONDS * (2**attempt)
                    print(f"ECHO API returned HTTP {error.code}; retrying after {delay:g} seconds.")
                    time.sleep(delay)
                    continue
                if error.code in (401, 403):
                    raise RuntimeError(
                        f"ECHO API rejected the request (HTTP {error.code}); verify ECHO_API_TOKEN and API access."
                    ) from None
                raise RuntimeError(f"ECHO API request failed (HTTP {error.code}).") from None
            except (TimeoutError, urllib.error.URLError, json.JSONDecodeError) as error:
                if attempt + 1 == RETRY_LIMIT:
                    raise RuntimeError(f"ECHO API request failed: {error.reason if isinstance(error, urllib.error.URLError) else error}.") from None
                delay = REQUEST_INTERVAL_SECONDS * (2**attempt)
                print(f"ECHO API request failed; retrying after {delay:g} seconds.")
                time.sleep(delay)
                continue

            if isinstance(payload, dict) and payload.get("error"):
                raise RuntimeError(f"ECHO API rejected the query: {payload['error']}")
            if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
                raise RuntimeError(f"ECHO API returned an unexpected response for {table_name}.")
            return payload

        raise RuntimeError("ECHO API retry loop ended unexpectedly.")


def batches(values: list[str], batch_size: int = ID_BATCH_SIZE) -> Iterable[list[str]]:
    for start in range(0, len(values), batch_size):
        yield values[start : start + batch_size]


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def refresh(api: EchoApi) -> dict[str, Any]:
    facility_sql = (
        "SELECT registry_id, fac_name, fac_city, fac_county, fac_lat, fac_long "
        "FROM ECHO_EXPORTER WHERE fac_state = 'CO'"
    )
    facilities = normalize_facilities(api.read_table(FACILITY_TABLE, facility_sql))
    if not facilities:
        raise ValueError("The ECHO API returned no Colorado facilities; refusing to publish an empty snapshot.")

    registry_ids = [facility["registry_id"] for facility in facilities]
    emission_rows: list[dict[str, Any]] = []
    for index, batch in enumerate(batches(registry_ids), start=1):
        identifiers = ", ".join(sql_string(registry_id) for registry_id in batch)
        emission_sql = (
            "SELECT reporting_year, registry_id, pgm_sys_acrnm, pgm_sys_id, pollutant_name, "
            "annual_emission, unit_of_measure, nei_type, nei_hap_voc_flag "
            f"FROM {EMISSIONS_TABLE} WHERE registry_id IN ({identifiers})"
        )
        print(f"Fetching Colorado emissions batch {index} of {(len(registry_ids) + ID_BATCH_SIZE - 1) // ID_BATCH_SIZE}.")
        emission_rows.extend(api.read_table(EMISSIONS_TABLE, emission_sql))

    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return build_snapshot(facilities, emission_rows, timestamp)


def write_snapshot(snapshot: dict[str, Any], output_path: Path = OUTPUT_PATH) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=output_path.parent,
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = temporary_file.name
            json.dump(snapshot, temporary_file, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            temporary_file.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.unlink(temporary_path)


def main() -> None:
    token = os.environ.get("ECHO_API_TOKEN", "").strip()
    if not token:
        raise SystemExit("ECHO_API_TOKEN is required; add it as a GitHub Actions secret before running this refresh.")

    base_url = os.environ.get("ECHO_API_BASE_URL", API_BASE)
    snapshot = refresh(EchoApi(base_url, token))
    write_snapshot(snapshot)
    print(
        f"Published {snapshot['record_count']:,} records for "
        f"{snapshot['facility_count']:,} Colorado facilities."
    )


if __name__ == "__main__":
    main()
