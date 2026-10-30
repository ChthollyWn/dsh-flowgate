from __future__ import annotations

import json
import unittest
from pathlib import Path

from csvtool.stats import summary, summary_json

DATA = Path(__file__).resolve().parent.parent / "data"


class StatsTest(unittest.TestCase):
    def test_summary_members(self):
        result = summary(DATA / "members.csv")
        self.assertEqual(result["rows"], 4)
        self.assertEqual(result["columns"], ["id", "name", "phone", "email", "city"])
        self.assertEqual(result["emptyCells"], 0)

    def test_summary_counts_empty_cells(self):
        result = summary(DATA / "duplicates.csv")
        self.assertEqual(result["rows"], 6)
        self.assertEqual(result["emptyCells"], 0)

    def test_summary_json_is_valid_json(self):
        parsed = json.loads(summary_json(DATA / "members.csv"))
        self.assertIn("columns", parsed)
        self.assertIn("rows", parsed)

    def test_summary_empty_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "empty.csv"
            empty.write_text("", encoding="utf-8")
            result = summary(empty)
            self.assertEqual(result["rows"], 0)
            self.assertEqual(result["columns"], [])


if __name__ == "__main__":
    unittest.main()
