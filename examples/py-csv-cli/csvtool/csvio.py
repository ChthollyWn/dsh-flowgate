"""CSV 读写工具。

基准任务 R2（GBK 乱码）的目标文件：当前实现只按 UTF-8 读取，
遇到 GBK 编码或带 BOM 的文件会报 UnicodeDecodeError 或把 BOM 带进首列。
"""
from __future__ import annotations

import csv
import io
from pathlib import Path


def read_rows(path: str | Path) -> list[list[str]]:
    """按 UTF-8 读取整个 CSV，返回行列表。

    已知缺陷：没有编码探测，GBK 文件会直接抛 UnicodeDecodeError；
    UTF-8 BOM 会残留在第一个表头字段里（"\\ufeffid"）。
    """
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return [row for row in csv.reader(handle)]


def write_rows(rows: list[list[str]], path: str | Path | None = None) -> str | None:
    """把行写成 CSV；path 为 None 时返回字符串。"""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerows(rows)
    text = buffer.getvalue()
    if path is None:
        return text
    Path(path).write_text(text, encoding="utf-8")
    return None


def read_header(path: str | Path) -> list[str]:
    rows = read_rows(path)
    if not rows:
        return []
    return rows[0]
