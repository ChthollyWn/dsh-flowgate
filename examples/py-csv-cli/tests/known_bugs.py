"""基准任务 R2（GBK 乱码）的验收测试。

这个文件刻意不匹配默认发现规则（`test_*.py`），所以默认测试全绿；
它演示当前实现的两个真实缺陷：

  1. 读取 GBK 编码的 CSV 直接抛 UnicodeDecodeError；
  2. 读取带 UTF-8 BOM 的文件时，BOM 残留在第一个表头字段里。

运行（修复前应失败 3 项）：
  python3 -m unittest discover -s tests -t . -p 'known_bugs.py' -v
或：
  pytest tests/known_bugs.py -q
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from csvtool.cli import main
from csvtool.csvio import read_header, read_rows

DATA = Path(__file__).resolve().parent.parent / "data"


class KnownBugsTest(unittest.TestCase):
    def test_read_gbk_file_does_not_crash(self):
        rows = read_rows(DATA / "members-gbk.csv")
        self.assertEqual(rows[0], ["id", "name", "phone", "email", "city"])
        self.assertEqual(rows[1][1], "张伟")
        self.assertEqual(len(rows), 5)

    def test_read_gbk_file_keeps_chinese_text(self):
        rows = read_rows(DATA / "members-gbk.csv")
        names = [row[1] for row in rows[1:]]
        self.assertEqual(names, ["张伟", "李娜", "王芳", "Bob"])

    def test_utf8_bom_is_not_part_of_header(self):
        header = read_header(DATA / "members-bom.csv")
        self.assertEqual(header[0], "id")
        self.assertNotIn("\ufeff", header[0])

    def test_gbk_export_produces_readable_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "exported.csv"
            self.assertEqual(main(["export", str(DATA / "members-gbk.csv"), "--out", str(out)]), 0)
            text = out.read_text(encoding="utf-8")
            self.assertIn("张伟", text)


if __name__ == "__main__":
    unittest.main()
