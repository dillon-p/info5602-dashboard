import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from analytics.scripts.download_snapshot import download_snapshot
from analytics.scripts.refresh_data import (
    DEFAULT_MIN_YEAR,
    DeltaLakeReader,
    build_snapshot,
    normalize_emissions,
    normalize_facilities,
    refresh,
    write_snapshot,
)


def facility(registry_id, name="Mountain Energy"):
    return {
        "registry_id": registry_id,
        "fac_state": "CO",
        "fac_name": name,
        "fac_city": "Denver",
        "fac_county": "Denver",
        "fac_lat": "39.7",
        "fac_long": "-104.9",
    }


def emission(registry_id, year, amount=45.5):
    return {
        "reporting_year": year,
        "registry_id": registry_id,
        "pgm_sys_acrnm": "E-GGRT",
        "pollutant_name": "Carbon dioxide",
        "annual_emission": amount,
        "unit_of_measure": "MTCO2e/year",
    }


def published_emission(registry_id, year, amount=45.5):
    return {
        "reporting_year": year,
        "registry_id": registry_id,
        "program": "Greenhouse Gas Reporting Program (GHGRP)",
        "program_code": "E-GGRT",
        "pollutant": "Carbon dioxide",
        "annual_emission": amount,
        "unit_of_measure": "MTCO2e/year",
    }


class NormalizeFacilitiesTests(unittest.TestCase):
    def test_normalizes_and_merges_duplicate_facilities(self):
        facilities = normalize_facilities(
            [
                {
                    "REGISTRY_ID": "CO-1",
                    "FAC_NAME": "Mountain Energy",
                    "FAC_CITY": "Denver",
                    "FAC_COUNTY": "Denver",
                    "FAC_LAT": "39.7",
                    "FAC_LONG": "-104.9",
                },
                {"registry_id": "CO-1", "fac_name": "", "fac_city": "Denver"},
                {"registry_id": "", "fac_name": "Missing identifier"},
            ]
        )

        self.assertEqual(len(facilities), 1)
        self.assertEqual(facilities[0]["name"], "Mountain Energy")
        self.assertEqual(facilities[0]["latitude"], 39.7)
        self.assertEqual(facilities[0]["longitude"], -104.9)


class NormalizeEmissionsTests(unittest.TestCase):
    def test_keeps_only_valid_recent_records_for_known_facilities(self):
        rows = [
            {
                **emission("CO-1", 2022),
                "REPORTING_YEAR": "2022",
                "REGISTRY_ID": "CO-1",
                "PGM_SYS_ACRNM": "E-GGRT",
            },
            emission("CO-1", 2015),
            emission("OTHER", 2022),
            {**emission("CO-1", 2023), "annual_emission": "NaN"},
        ]

        records = normalize_emissions(rows, {"CO-1"})

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["program"], "E-GGRT")
        self.assertEqual(
            set(records[0]),
            {
                "reporting_year",
                "registry_id",
                "program",
                "pollutant",
                "annual_emission",
                "unit_of_measure",
            },
        )
        self.assertEqual(records[0]["annual_emission"], 45.5)
        self.assertEqual(records[0]["reporting_year"], 2022)

    def test_rejects_empty_snapshots_instead_of_overwriting_public_data(self):
        with self.assertRaisesRegex(ValueError, "no Colorado facilities"):
            build_snapshot([], [], "2026-10-28T00:00:00Z")

        with self.assertRaisesRegex(ValueError, "no valid Colorado emission records"):
            build_snapshot(
                [facility("CO-1")],
                [emission("CO-1", 2015)],
                "2026-10-28T00:00:00Z",
            )


class FakeDeltaSource:
    def __init__(self, facilities=None, emissions=None):
        self.facilities = facilities if facilities is not None else [facility("CO-1")]
        self.emissions = emissions if emissions is not None else [
            emission("CO-1", 2022),
            emission("US-2", 2023),
        ]
        self.requested_facility_ids = None
        self.requested_min_year = None

    def read_facilities(self):
        return self.facilities

    def read_emissions(self, facility_ids, min_year):
        self.requested_facility_ids = facility_ids
        self.requested_min_year = min_year
        return [
            row
            for row in self.emissions
            if row["registry_id"] in facility_ids and row["reporting_year"] >= min_year
        ]


class RefreshTests(unittest.TestCase):
    def test_filters_emissions_to_colorado_facilities_and_year_floor(self):
        source = FakeDeltaSource(
            emissions=[
                emission("CO-1", 2022),
                emission("CO-1", 2015),
                emission("US-2", 2023),
            ]
        )

        snapshot = refresh(source)

        self.assertEqual(snapshot["minimum_reporting_year"], DEFAULT_MIN_YEAR)
        self.assertEqual(snapshot["record_count"], 1)
        self.assertEqual(snapshot["emissions"][0]["registry_id"], "CO-1")
        self.assertEqual(source.requested_facility_ids, ["CO-1"])
        self.assertEqual(source.requested_min_year, DEFAULT_MIN_YEAR)

    def test_rejects_empty_facility_results_before_reading_emissions(self):
        source = FakeDeltaSource(facilities=[])

        with self.assertRaisesRegex(ValueError, "no Colorado facilities"):
            refresh(source)
        self.assertIsNone(source.requested_facility_ids)

    def test_delta_reader_reports_missing_table_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(FileNotFoundError, "ECHO_EXPORTER"):
                with DeltaLakeReader(Path(directory)):
                    self.fail("A reader with missing tables should not start.")


class SnapshotWriteTests(unittest.TestCase):
    def test_invalid_snapshot_does_not_replace_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text("existing snapshot")

            with self.assertRaises(ValueError):
                write_snapshot({}, path)

            self.assertEqual(path.read_text(), "existing snapshot")


class DownloadSnapshotTests(unittest.TestCase):
    def test_downloads_and_validates_published_snapshot_atomically(self):
        snapshot = build_snapshot(
            [facility("CO-1")],
            [emission("CO-1", 2022)],
            "2026-10-28T00:00:00Z",
        )
        response = io.BytesIO(json.dumps(snapshot).encode())

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch("analytics.scripts.download_snapshot.urllib.request.urlopen", return_value=response):
                result = download_snapshot("https://example.test/snapshot.json", path)

            self.assertEqual(result["record_count"], 1)
            self.assertEqual(json.loads(path.read_text())["minimum_reporting_year"], 2016)

    def test_migrates_an_older_published_snapshot_to_the_2016_floor(self):
        snapshot = {
            "schema_version": 1,
            "generated_at": "2025-01-01T00:00:00Z",
            "source": "test",
            "facility_count": 1,
            "record_count": 2,
            "facilities": [facility("CO-1")],
            "emissions": [published_emission("CO-1", 2014), published_emission("CO-1", 2022)],
        }
        response = io.BytesIO(json.dumps(snapshot).encode())

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch("analytics.scripts.download_snapshot.urllib.request.urlopen", return_value=response):
                result = download_snapshot("https://example.test/snapshot.json", path)

            self.assertEqual(result["minimum_reporting_year"], 2016)
            self.assertEqual(result["record_count"], 1)
            self.assertEqual(result["emissions"][0]["reporting_year"], 2022)

    def test_invalid_download_does_not_replace_existing_snapshot(self):
        response = io.BytesIO(b'{"schema_version": 1, "facilities": [], "emissions": []}')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text("existing snapshot")
            with patch("analytics.scripts.download_snapshot.urllib.request.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "snapshot is invalid"):
                    download_snapshot("https://example.test/snapshot.json", path)
            self.assertEqual(path.read_text(), "existing snapshot")


if __name__ == "__main__":
    unittest.main()
