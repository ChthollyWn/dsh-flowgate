from __future__ import annotations

import contextlib
import csv
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

    def test_export_to_stdout_keeps_contract(self):
        # 只断言导出契约（表头、行数、字段数、非手机号列），不写死待改造的手机号原值：
        # 基准任务 R3 会默认对手机号列脱敏，既有测试应继续通过。
        code, output = run_cli(["export", str(DATA / "members.csv")])
        self.assertEqual(code, 0)
        rows = list(csv.reader(io.StringIO(output)))
        self.assertEqual(rows[0], ["id", "name", "phone", "email", "city"])
        self.assertEqual(len(rows), 5)
        self.assertTrue(all(len(row) == 5 for row in rows))
        self.assertEqual([row[0] for row in rows[1:]], ["1", "2", "3", "4"])
        self.assertEqual([row[1] for row in rows[1:]], ["张伟", "李娜", "王芳", "Bob"])
        # 手机号列必须保留且非空（脱敏后也应如此），不能被删列或整列清空。
        self.assertTrue(all(row[2].strip() for row in rows[1:]))

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
