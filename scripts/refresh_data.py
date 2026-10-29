#!/usr/bin/env python3
"""Refresh a public Colorado ECHO emissions snapshot using the authenticated API."""

from __future__ import annotations

import getpass
import json
import math
import os
import sys
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
DEFAULT_MIN_YEAR = 2016
DEFAULT_MAX_NATIONAL_BYTES = 50_000_000
MAX_SAMPLE_RECORDS = 1000
MAX_QUERY_URL_CHARS = 7000
MAX_IDS_PER_BATCH = 400
RETRY_LIMIT = 4
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "public" / "data" / "colorado-emissions.json"
EMISSION_COLUMNS = (
    "reporting_year, registry_id, pgm_sys_acrnm, pollutant_name, "
    "annual_emission, unit_of_measure"
)


class ResultTooLargeError(RuntimeError):
    """Raised when an API response exceeds the configured byte limit."""


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
                if key != "registry_id" and existing[key] in ("", None) and value not in ("", None):
                    existing[key] = value

    return sorted(facilities.values(), key=lambda item: (item["name"].casefold(), item["registry_id"]))


def normalize_emissions(
    rows: Iterable[dict[str, Any]],
    facility_ids: set[str],
    min_year: int = DEFAULT_MIN_YEAR,
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
            or year_value < min_year
            or not program_code
            or not pollutant
            or not unit
        ):
            continue

        emissions.append(
            {
                "reporting_year": int(year_value),
                "registry_id": registry_id,
                "program": program_code,
                "pollutant": pollutant,
                "annual_emission": emission,
                "unit_of_measure": unit,
            }
        )

    return sorted(
        emissions,
        key=lambda item: (
            item["reporting_year"],
            item["registry_id"],
            item["program"],
            item["pollutant"],
            item["unit_of_measure"],
        ),
    )


def validate_snapshot(snapshot: Any) -> dict[str, Any]:
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1:
        raise ValueError("The snapshot has an unsupported format or schema version.")

    minimum_year = number(snapshot.get("minimum_reporting_year"))
    if minimum_year is None or not minimum_year.is_integer():
        raise ValueError("The snapshot is missing a valid minimum reporting year.")
    facilities = snapshot.get("facilities")
    emissions = snapshot.get("emissions")
    if not isinstance(facilities, list) or not facilities:
        raise ValueError("The snapshot contains no facilities.")
    if not isinstance(emissions, list) or not emissions:
        raise ValueError("The snapshot contains no emissions records.")

    for facility in facilities:
        if not isinstance(facility, dict) or not text(facility.get("registry_id")):
            raise ValueError("The snapshot contains an invalid facility record.")
    facility_ids = {facility["registry_id"] for facility in facilities if isinstance(facility, dict)}
    for emission in emissions:
        year = number(emission.get("reporting_year")) if isinstance(emission, dict) else None
        if (
            not isinstance(emission, dict)
            or year is None
            or not year.is_integer()
            or year < minimum_year
            or number(emission.get("annual_emission")) is None
            or text(emission.get("registry_id")) not in facility_ids
            or not text(emission.get("program_code") or emission.get("program"))
            or not text(emission.get("pollutant"))
            or not text(emission.get("unit_of_measure"))
        ):
            raise ValueError("The snapshot contains an invalid emission record.")

    if snapshot.get("facility_count") != len(facilities) or snapshot.get("record_count") != len(emissions):
        raise ValueError("The snapshot's record counts do not match its data.")
    return snapshot


def build_snapshot(
    facility_rows: Iterable[dict[str, Any]],
    emission_rows: Iterable[dict[str, Any]],
    generated_at: str,
    min_year: int = DEFAULT_MIN_YEAR,
) -> dict[str, Any]:
    facilities = normalize_facilities(facility_rows)
    if not facilities:
        raise ValueError("The ECHO API returned no Colorado facilities; refusing to publish an empty snapshot.")

    emissions = normalize_emissions(
        emission_rows,
        {facility["registry_id"] for facility in facilities},
        min_year,
    )
    if not emissions:
        raise ValueError(
            f"The ECHO API returned no valid Colorado emission records from {min_year} onward; "
            "refusing to publish an empty snapshot."
        )

    return {
        "schema_version": 1,
        "generated_at": generated_at,
        "minimum_reporting_year": min_year,
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
        self.request_count = 0
        self.last_response_bytes = 0

    def _wait_for_rate_limit(self) -> None:
        if self.last_request_at is None:
            return
        elapsed = time.monotonic() - self.last_request_at
        if elapsed < REQUEST_INTERVAL_SECONDS:
            time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)

    def read_table(
        self,
        table_name: str,
        sql: str,
        max_response_bytes: int | None = None,
    ) -> list[dict[str, Any]]:
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
            self.request_count += 1
            request_started = time.monotonic()

            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    content_length = response.headers.get("Content-Length")
                    if max_response_bytes is not None and content_length:
                        if int(content_length) > max_response_bytes:
                            raise ResultTooLargeError(
                                f"The ECHO response advertises {int(content_length):,} bytes, above the "
                                f"{max_response_bytes:,}-byte limit."
                            )
                    chunks: list[bytes] = []
                    response_size = 0
                    while chunk := response.read(64 * 1024):
                        response_size += len(chunk)
                        if max_response_bytes is not None and response_size > max_response_bytes:
                            raise ResultTooLargeError(
                                f"The ECHO response exceeded the {max_response_bytes:,}-byte limit."
                            )
                        chunks.append(chunk)
                    response_body = b"".join(chunks)
                self.last_response_bytes = len(response_body)
                payload = json.loads(response_body)
            except urllib.error.HTTPError as error:
                if error.code == 413 and max_response_bytes is not None:
                    raise ResultTooLargeError(
                        f"The ECHO API rejected the nationwide response as too large (HTTP 413)."
                    ) from None
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
                    detail = error.reason if isinstance(error, urllib.error.URLError) else error
                    raise RuntimeError(f"ECHO API request failed: {detail}.") from None
                delay = REQUEST_INTERVAL_SECONDS * (2**attempt)
                print(f"ECHO API request failed; retrying after {delay:g} seconds.")
                time.sleep(delay)
                continue

            if isinstance(payload, dict) and payload.get("error"):
                raise RuntimeError(f"ECHO API rejected the query: {payload['error']}")
            if not isinstance(payload, list) or any(not isinstance(row, dict) for row in payload):
                raise RuntimeError(f"ECHO API returned an unexpected response for {table_name}.")

            elapsed = time.monotonic() - request_started
            print(
                f"[api] {table_name}: {len(payload):,} rows, {self.last_response_bytes:,} bytes, "
                f"{elapsed:.1f}s"
            )
            return payload

        raise RuntimeError("ECHO API retry loop ended unexpectedly.")


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def emissions_sql(min_year: int, registry_ids: list[str] | None = None) -> str:
    statement = f"SELECT {EMISSION_COLUMNS} FROM {EMISSIONS_TABLE} WHERE reporting_year >= {min_year}"
    if registry_ids is not None:
        ids = ", ".join(sql_string(registry_id) for registry_id in registry_ids)
        statement += f" AND registry_id IN ({ids})"
    return statement


def batches(
    values: list[str],
    base_url: str = API_BASE,
    max_url_chars: int = MAX_QUERY_URL_CHARS,
) -> Iterable[list[str]]:
    current: list[str] = []
    for value in values:
        candidate = current + [value]
        candidate_url = (
            f"{base_url.rstrip('/')}/echo/{EMISSIONS_TABLE}?"
            f"{urllib.parse.urlencode({'sql': emissions_sql(DEFAULT_MIN_YEAR, candidate)})}"
        )
        if current and (
            len(candidate) > MAX_IDS_PER_BATCH or len(candidate_url) > max_url_chars
        ):
            yield current
            current = [value]
        else:
            current = candidate

        single_url = (
            f"{base_url.rstrip('/')}/echo/{EMISSIONS_TABLE}?"
            f"{urllib.parse.urlencode({'sql': emissions_sql(DEFAULT_MIN_YEAR, current)})}"
        )
        if len(single_url) > max_url_chars:
            raise ValueError("A facility identifier exceeds the safe ECHO API request URL length.")

    if current:
        yield current


def estimate_national_result(api: EchoApi, min_year: int) -> tuple[int, int]:
    count_sql = (
        f"SELECT COUNT(*) AS row_count FROM {EMISSIONS_TABLE} "
        f"WHERE reporting_year >= {min_year}"
    )
    count_rows = api.read_table(EMISSIONS_TABLE, count_sql)
    total = number(field(count_rows[0], "row_count")) if count_rows else None
    if total is None or not total.is_integer() or total < 0:
        raise RuntimeError("ECHO API returned an invalid row count for the nationwide preflight.")

    if total == 0:
        return 0, 0

    sample_sql = f"{emissions_sql(min_year)} LIMIT {MAX_SAMPLE_RECORDS}"
    sample = api.read_table(EMISSIONS_TABLE, sample_sql)
    if not sample:
        raise RuntimeError("ECHO API returned an empty sample for a non-empty nationwide result.")

    estimated_bytes = math.ceil(api.last_response_bytes * int(total) / len(sample))
    return int(total), estimated_bytes


def fetch_batched_emissions(api: EchoApi, registry_ids: list[str], min_year: int) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    grouped_ids = list(batches(registry_ids, api.base_url))
    for index, batch in enumerate(grouped_ids, start=1):
        sql = emissions_sql(min_year, batch)
        print(f"Fetching Colorado emissions batch {index} of {len(grouped_ids)}.")
        result.extend(api.read_table(EMISSIONS_TABLE, sql))
    return result


def refresh(
    api: EchoApi,
    min_year: int = DEFAULT_MIN_YEAR,
    max_national_bytes: int = DEFAULT_MAX_NATIONAL_BYTES,
) -> dict[str, Any]:
    started = time.monotonic()
    facility_sql = (
        "SELECT registry_id, fac_name, fac_city, fac_county, fac_lat, fac_long "
        "FROM ECHO_EXPORTER WHERE fac_state = 'CO'"
    )
    facilities = normalize_facilities(api.read_table(FACILITY_TABLE, facility_sql))
    if not facilities:
        raise ValueError("The ECHO API returned no Colorado facilities; refusing to publish an empty snapshot.")

    registry_ids = [facility["registry_id"] for facility in facilities]
    nationwide_count, estimated_bytes = estimate_national_result(api, min_year)
    print(
        f"[preflight] {nationwide_count:,} U.S. rows since {min_year}; "
        f"estimated JSON size {estimated_bytes / 1_000_000:.1f} MB "
        f"(limit {max_national_bytes / 1_000_000:.0f} MB)"
    )

    if nationwide_count == 0:
        raise ValueError(f"The ECHO API has no emissions records from {min_year} onward.")

    emission_rows: list[dict[str, Any]]
    if estimated_bytes <= max_national_bytes:
        try:
            emission_rows = api.read_table(
                EMISSIONS_TABLE,
                emissions_sql(min_year),
                max_response_bytes=max_national_bytes,
            )
            colorado_ids = set(registry_ids)
            emission_rows = [
                row for row in emission_rows if text(field(row, "registry_id")) in colorado_ids
            ]
            print(f"[refresh] Filtered national result to {len(emission_rows):,} Colorado rows.")
        except ResultTooLargeError as error:
            print(f"[preflight] National response exceeded the configured limit ({error}); using ID batches.")
            emission_rows = fetch_batched_emissions(api, registry_ids, min_year)
    else:
        print("[preflight] Estimated result exceeds the configured limit; using ID batches.")
        emission_rows = fetch_batched_emissions(api, registry_ids, min_year)

    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot = build_snapshot(facilities, emission_rows, timestamp, min_year)
    print(
        f"[refresh] Completed in {time.monotonic() - started:.1f}s: "
        f"{api.request_count} API requests, {snapshot['record_count']:,} Colorado records, "
        f"{snapshot['facility_count']:,} facilities."
    )
    return snapshot


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
            json.dump(validate_snapshot(snapshot), temporary_file, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            temporary_file.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path and os.path.exists(temporary_path):
            os.unlink(temporary_path)


def main() -> None:
    token = os.environ.get("ECHO_API_TOKEN", "").strip()
    if not token and sys.stdin.isatty():
        token = getpass.getpass("ECHO API token (input hidden): ").strip()
    if not token:
        raise SystemExit(
            "ECHO_API_TOKEN is required in non-interactive runs; add it as a GitHub Actions secret."
        )

    try:
        min_year = int(os.environ.get("ECHO_MIN_YEAR", str(DEFAULT_MIN_YEAR)))
        max_national_bytes = int(
            os.environ.get("ECHO_MAX_NATIONAL_BYTES", str(DEFAULT_MAX_NATIONAL_BYTES))
        )
    except ValueError:
        raise SystemExit("ECHO_MIN_YEAR and ECHO_MAX_NATIONAL_BYTES must be integers.") from None
    if min_year < 1900 or max_national_bytes <= 0:
        raise SystemExit("ECHO_MIN_YEAR must be a valid year and ECHO_MAX_NATIONAL_BYTES must be positive.")

    base_url = os.environ.get("ECHO_API_BASE_URL", API_BASE)
    snapshot = refresh(EchoApi(base_url, token), min_year, max_national_bytes)
    write_snapshot(snapshot)
    print(f"Snapshot written to {OUTPUT_PATH}.")


if __name__ == "__main__":
    main()
