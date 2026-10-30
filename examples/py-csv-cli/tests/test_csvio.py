from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from csvtool.csvio import read_header, read_rows, write_rows

DATA = Path(__file__).resolve().parent.parent / "data"


class CsvIoTest(unittest.TestCase):
    def test_read_utf8_members(self):
        rows = read_rows(DATA / "members.csv")
        self.assertEqual(rows[0], ["id", "name", "phone", "email", "city"])
        self.assertEqual(len(rows), 5)

    def test_read_header(self):
        self.assertEqual(read_header(DATA / "members.csv")[:2], ["id", "name"])

    def test_write_rows_roundtrip(self):
        rows = [["id", "name"], ["1", "张伟"], ["2", "a,b"]]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.csv"
            write_rows(rows, out)
            self.assertEqual(read_rows(out), rows)

    def test_write_rows_to_string(self):
        text = write_rows([["a", "b"], ["1", "2"]])
        self.assertEqual(text, "a,b\n1,2\n")

    def test_read_empty_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "empty.csv"
            empty.write_text("", encoding="utf-8")
            self.assertEqual(read_rows(empty), [])
            self.assertEqual(read_header(empty), [])


if __name__ == "__main__":
    unittest.main()
