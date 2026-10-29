import io
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from scripts.download_snapshot import download_snapshot
from scripts.refresh_data import (
    API_BASE,
    DEFAULT_MIN_YEAR,
    EMISSIONS_TABLE,
    EchoApi,
    ResultTooLargeError,
    build_snapshot,
    batches,
    emissions_sql,
    normalize_emissions,
    normalize_facilities,
    refresh,
    sql_string,
)


def facility(registry_id, name="Mountain Energy"):
    return {
        "registry_id": registry_id,
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
        "pgm_sys_id": "1234",
        "pollutant_name": "Carbon dioxide",
        "annual_emission": amount,
        "unit_of_measure": "MTCO2e/year",
        "nei_type": "GHG",
        "nei_hap_voc_flag": "",
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

    def test_escapes_values_in_sql_literals_and_filters_years(self):
        self.assertEqual(sql_string("Facility's ID"), "'Facility''s ID'")
        query = emissions_sql(DEFAULT_MIN_YEAR)
        self.assertIn("WHERE reporting_year >= 2016", query)
        self.assertNotIn("pgm_sys_id", query)
        self.assertNotIn("nei_type", query)


class RefreshStrategyTests(unittest.TestCase):
    class FakeApi:
        base_url = API_BASE

        def __init__(self, national_too_large=False):
            self.request_count = 0
            self.last_response_bytes = 0
            self.national_too_large = national_too_large
            self.national_rows = [emission("CO-1", 2022), emission("US-2", 2023)]

        def read_table(self, table_name, sql, max_response_bytes=None):
            self.request_count += 1
            if table_name == "ECHO_EXPORTER":
                rows = [facility("CO-1")]
            elif "COUNT(*)" in sql:
                rows = [{"row_count": len(self.national_rows)}]
            elif "LIMIT" in sql:
                rows = self.national_rows
            elif "registry_id IN" in sql:
                rows = [row for row in self.national_rows if row["registry_id"] == "CO-1"]
            else:
                if self.national_too_large:
                    raise ResultTooLargeError("over limit")
                rows = self.national_rows
            self.last_response_bytes = len(json.dumps(rows, separators=(",", ":")).encode())
            if max_response_bytes is not None and self.last_response_bytes > max_response_bytes:
                raise AssertionError("Fake response unexpectedly exceeded the requested cap.")
            return rows

    def test_nationwide_query_filters_year_and_facility_locally(self):
        api = self.FakeApi()

        snapshot = refresh(api, max_national_bytes=50_000)

        self.assertEqual(snapshot["minimum_reporting_year"], 2016)
        self.assertEqual(snapshot["record_count"], 1)
        self.assertEqual(snapshot["emissions"][0]["registry_id"], "CO-1")
        self.assertEqual(api.request_count, 4)

    def test_actual_size_overrun_falls_back_to_id_batches(self):
        api = self.FakeApi(national_too_large=True)

        snapshot = refresh(api, max_national_bytes=50_000)

        self.assertEqual(snapshot["record_count"], 1)
        self.assertEqual(snapshot["emissions"][0]["registry_id"], "CO-1")
        self.assertEqual(api.request_count, 5)

    def test_large_estimate_falls_back_to_id_batches(self):
        api = self.FakeApi()

        snapshot = refresh(api, max_national_bytes=1)

        self.assertEqual(snapshot["record_count"], 1)
        self.assertEqual(snapshot["emissions"][0]["registry_id"], "CO-1")
        self.assertEqual(api.request_count, 4)

    def test_batches_grow_until_safe_url_or_id_limit(self):
        ids = [f"01234567-89ab-cdef-0123-{index:012d}" for index in range(500)]
        grouped = list(batches(ids))

        self.assertGreater(max(map(len, grouped)), 80)
        self.assertEqual(sum(map(len, grouped)), len(ids))
        for group in grouped:
            url = (
                f"{API_BASE}/echo/{EMISSIONS_TABLE}?"
                f"{urllib.parse.urlencode({'sql': emissions_sql(DEFAULT_MIN_YEAR, group)})}"
            )
            self.assertLessEqual(len(url), 7000)


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
            with patch("scripts.download_snapshot.urllib.request.urlopen", return_value=response):
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
            with patch("scripts.download_snapshot.urllib.request.urlopen", return_value=response):
                result = download_snapshot("https://example.test/snapshot.json", path)

            self.assertEqual(result["minimum_reporting_year"], 2016)
            self.assertEqual(result["record_count"], 1)
            self.assertEqual(result["emissions"][0]["reporting_year"], 2022)

    def test_invalid_download_does_not_replace_existing_snapshot(self):
        response = io.BytesIO(b'{"schema_version": 1, "facilities": [], "emissions": []}')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text("existing snapshot")
            with patch("scripts.download_snapshot.urllib.request.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "snapshot is invalid"):
                    download_snapshot("https://example.test/snapshot.json", path)
            self.assertEqual(path.read_text(), "existing snapshot")


class EchoApiTests(unittest.TestCase):
    class Response(io.BytesIO):
        headers = {"Content-Length": "100"}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    def test_national_response_byte_limit_is_enforced_from_headers(self):
        api = EchoApi(API_BASE, "test-token")
        with patch(
            "scripts.refresh_data.urllib.request.urlopen",
            return_value=self.Response(b"[]"),
        ):
            with self.assertRaises(ResultTooLargeError):
                api.read_table(EMISSIONS_TABLE, "SELECT * FROM table", max_response_bytes=10)


if __name__ == "__main__":
    unittest.main()
