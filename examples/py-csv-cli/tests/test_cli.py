from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from csvtool.cli import main

DATA = Path(__file__).resolve().parent.parent / "data"


def run_cli(argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(argv)
    return code, out.getvalue()


class CliTest(unittest.TestCase):
    def test_stats_command_outputs_json(self):
        code, output = run_cli(["stats", str(DATA / "members.csv")])
        self.assertEqual(code, 0)
        self.assertIn('"rows": 4', output)

    def test_export_to_stdout_keeps_original_phone(self):
        # 基准任务 R3 之前，导出保持原样（脱敏是待实现需求）。
        code, output = run_cli(["export", str(DATA / "members.csv")])
        self.assertEqual(code, 0)
        self.assertIn("13800138000", output)
        self.assertIn("id,name,phone", output)

    def test_export_to_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "exported.csv"
            code, _ = run_cli(["export", str(DATA / "members.csv"), "--out", str(out)])
            self.assertEqual(code, 0)
            text = out.read_text(encoding="utf-8")
            self.assertIn("张伟", text)

    def test_unknown_command_exits_nonzero(self):
        with self.assertRaises(SystemExit) as ctx:
            with contextlib.redirect_stderr(io.StringIO()):
                main(["unknown"])
        self.assertNotEqual(ctx.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
