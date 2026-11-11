#!/usr/bin/env python3
"""Refresh the public Colorado emissions snapshot from local ECHO Delta tables."""

from __future__ import annotations

import json
import math
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Protocol


SOURCE_URL = "https://echo.epa.gov/tools/data-downloads/air-emissions-download-summary"
FACILITY_TABLE = "ECHO_EXPORTER"
EMISSIONS_TABLE = "POLL_RPT_COMBINED_EMISSIONS"
DEFAULT_MIN_YEAR = 2016
OUTPUT_PATH = Path(__file__).resolve().parents[2] / "public" / "data" / "colorado-emissions.json"
EMISSION_COLUMNS = (
    "reporting_year",
    "registry_id",
    "pgm_sys_acrnm",
    "pollutant_name",
    "annual_emission",
    "unit_of_measure",
)


class TableSource(Protocol):
    def read_facilities(self) -> list[dict[str, Any]]: ...

    def read_emissions(self, facility_ids: list[str], min_year: int) -> list[dict[str, Any]]: ...


def field(row: dict[str, Any], name: str) -> Any:
    """Read a table column without depending on its casing."""
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
        raise ValueError("The Delta Lake tables returned no Colorado facilities; refusing to publish an empty snapshot.")

    emissions = normalize_emissions(
        emission_rows,
        {facility["registry_id"] for facility in facilities},
        min_year,
    )
    if not emissions:
        raise ValueError(
            f"The Delta Lake tables returned no valid Colorado emission records from {min_year} onward; "
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


class DeltaLakeReader:
    def __init__(self, tables_path: Path) -> None:
        self.tables_path = tables_path.expanduser()
        self.spark: Any = None
        self.functions: Any = None
        self.facilities: Any = None
        self.emissions: Any = None

    def __enter__(self) -> DeltaLakeReader:
        if not self.tables_path.is_dir():
            raise FileNotFoundError(
                f"Delta tables directory does not exist: {self.tables_path}"
            )
        table_paths = {
            table_name: self.tables_path / table_name
            for table_name in (FACILITY_TABLE, EMISSIONS_TABLE)
        }
        missing_tables = [name for name, path in table_paths.items() if not path.is_dir()]
        if missing_tables:
            names = ", ".join(missing_tables)
            raise FileNotFoundError(
                f"Missing Delta table directories under {self.tables_path}: {names}"
            )

        try:
            from delta import configure_spark_with_delta_pip
            from pyspark.sql import SparkSession, functions
        except ImportError as error:
            raise RuntimeError(
                "PySpark and delta-spark are required; run the refresh in the linked "
                "ECHO_modules Delta Docker environment."
            ) from error

        builder = (
            SparkSession.builder.master("local[*]")
            .appName("ColoradoEmissionsSnapshot")
            .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
            .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
        )
        try:
            self.spark = configure_spark_with_delta_pip(builder).getOrCreate()
            self.functions = functions
            self.facilities = (
                self.spark.read.format("delta").load(str(table_paths[FACILITY_TABLE]))
            )
            self.emissions = (
                self.spark.read.format("delta").load(str(table_paths[EMISSIONS_TABLE]))
            )
        except Exception as error:
            self.close()
            raise RuntimeError(
                f"Could not open the expected ECHO Delta tables under {self.tables_path}: {error}"
            ) from error
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def close(self) -> None:
        if self.spark is not None:
            self.spark.stop()
            self.spark = None

    def read_facilities(self) -> list[dict[str, Any]]:
        try:
            rows = (
                self.facilities.filter(self.functions.col("fac_state") == "CO")
                .select("registry_id", "fac_name", "fac_city", "fac_county", "fac_lat", "fac_long")
                .collect()
            )
        except Exception as error:
            raise RuntimeError(
                f"Could not read Colorado facilities from the {FACILITY_TABLE} Delta table: {error}"
            ) from error
        return [row.asDict(recursive=True) for row in rows]

    def read_emissions(self, facility_ids: list[str], min_year: int) -> list[dict[str, Any]]:
        if not facility_ids:
            return []

        facility_id_frame = self.spark.createDataFrame(
            [(registry_id,) for registry_id in facility_ids],
            ["registry_id"],
        ).alias("colorado_facilities")
        emissions = self.emissions.withColumn(
            "_registry_id_string",
            self.functions.col("registry_id").cast("string"),
        ).alias("emissions")

        try:
            rows = (
                emissions.filter(self.functions.col("reporting_year") >= min_year)
                .join(
                    facility_id_frame,
                    self.functions.col("emissions._registry_id_string")
                    == self.functions.col("colorado_facilities.registry_id"),
                    "inner",
                )
                .select(
                    *(self.functions.col(f"emissions.{column}") for column in EMISSION_COLUMNS)
                )
                .collect()
            )
        except Exception as error:
            raise RuntimeError(
                f"Could not read Colorado records from the {EMISSIONS_TABLE} Delta table: {error}"
            ) from error
        return [row.asDict(recursive=True) for row in rows]


def refresh(source: TableSource, min_year: int = DEFAULT_MIN_YEAR) -> dict[str, Any]:
    started = time.monotonic()
    facilities = source.read_facilities()
    facility_ids = sorted(
        {text(field(facility, "registry_id")) for facility in facilities}
        - {""}
    )
    if not facility_ids:
        raise ValueError("The Delta Lake tables returned no Colorado facilities; refusing to publish an empty snapshot.")

    emission_rows = source.read_emissions(facility_ids, min_year)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot = build_snapshot(facilities, emission_rows, timestamp, min_year)
    print(
        f"[refresh] Completed in {time.monotonic() - started:.1f}s: "
        f"{snapshot['record_count']:,} Colorado records, "
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
    tables_path = os.environ.get("DELTA_TABLES_MOUNT_PATH", "").strip()
    if not tables_path:
        raise SystemExit(
            "DELTA_TABLES_MOUNT_PATH is required; run inside the ECHO_modules Delta Docker "
            "environment or set it to the local Delta tables directory."
        )

    try:
        min_year = int(os.environ.get("ECHO_MIN_YEAR", str(DEFAULT_MIN_YEAR)))
    except ValueError:
        raise SystemExit("ECHO_MIN_YEAR must be an integer.") from None
    if min_year < 1900:
        raise SystemExit("ECHO_MIN_YEAR must be a valid year.")

    with DeltaLakeReader(Path(tables_path)) as source:
        snapshot = refresh(source, min_year)
    write_snapshot(snapshot)
    print(f"Snapshot written to {OUTPUT_PATH}.")


if __name__ == "__main__":
    main()
