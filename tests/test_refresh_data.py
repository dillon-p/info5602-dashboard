import unittest

from scripts.refresh_data import build_snapshot, normalize_emissions, normalize_facilities, sql_string


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
    def test_keeps_only_valid_records_for_known_facilities(self):
        rows = [
            {
                "REPORTING_YEAR": "2022",
                "REGISTRY_ID": "CO-1",
                "PGM_SYS_ACRNM": "E-GGRT",
                "PGM_SYS_ID": "1234",
                "POLLUTANT_NAME": "Carbon dioxide",
                "ANNUAL_EMISSION": "45.5",
                "UNIT_OF_MEASURE": "MTCO2e/year",
                "NEI_TYPE": "GHG",
                "NEI_HAP_VOC_FLAG": "",
            },
            {
                "reporting_year": 2022,
                "registry_id": "OTHER",
                "pgm_sys_acrnm": "EIS",
                "pollutant_name": "Nitrogen oxides",
                "annual_emission": 2,
                "unit_of_measure": "tons",
            },
            {
                "reporting_year": 2022,
                "registry_id": "CO-1",
                "pgm_sys_acrnm": "EIS",
                "pollutant_name": "Invalid value",
                "annual_emission": "NaN",
                "unit_of_measure": "tons",
            },
        ]

        records = normalize_emissions(rows, {"CO-1"})

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["program"], "Greenhouse Gas Reporting Program (GHGRP)")
        self.assertEqual(records[0]["annual_emission"], 45.5)
        self.assertEqual(records[0]["reporting_year"], 2022)

    def test_rejects_empty_snapshots_instead_of_overwriting_public_data(self):
        with self.assertRaisesRegex(ValueError, "no Colorado facilities"):
            build_snapshot([], [], "2026-10-28T00:00:00Z")

        with self.assertRaisesRegex(ValueError, "no valid Colorado emission records"):
            build_snapshot(
                [{"registry_id": "CO-1", "fac_name": "Facility"}],
                [],
                "2026-10-28T00:00:00Z",
            )

    def test_escapes_values_in_sql_literals(self):
        self.assertEqual(sql_string("Facility's ID"), "'Facility''s ID'")


if __name__ == "__main__":
    unittest.main()
