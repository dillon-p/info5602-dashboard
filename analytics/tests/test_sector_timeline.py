import unittest

from analytics.scripts.build_sector_timeline import build_timeline, parse_estimate


def yes_row(sector, values):
    return (sector, 7, "Question 7", 1, "Yes", *values)


class BuildTimelineTests(unittest.TestCase):
    def test_averages_available_sectors_and_marks_low_confidence_weeks(self):
        timeline = build_timeline(
            ["202602", "202601", "202552"],
            [
                yes_row(11, ["10.0%", "S", "."]),
                yes_row(21, ["20.0%", "30.0%", "."]),
                yes_row("XX", ["90.0%", "90.0%", "90.0%"]),
            ],
        )

        self.assertEqual(timeline["sectorCount"], 2)
        self.assertEqual(
            timeline["weeks"],
            [
                {
                    "year": 2026,
                    "week": 1,
                    "yesPercent": 30.0,
                    "availableSectorCount": 1,
                    "lowConfidenceSectorCount": 1,
                },
                {
                    "year": 2026,
                    "week": 2,
                    "yesPercent": 15.0,
                    "availableSectorCount": 2,
                    "lowConfidenceSectorCount": 0,
                },
            ],
        )

    def test_rejects_duplicate_sector_rows(self):
        with self.assertRaisesRegex(ValueError, "Duplicate Question 7 Yes row"):
            build_timeline(
                ["202601"],
                [yes_row(11, ["10.0%"]), yes_row(11, ["12.0%"])],
            )

    def test_rejects_unexpected_estimate_values(self):
        with self.assertRaisesRegex(ValueError, "Unexpected Question 7 response estimate"):
            parse_estimate("unknown")


if __name__ == "__main__":
    unittest.main()
