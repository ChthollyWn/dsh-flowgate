"""导出功能：当前原样导出 CSV。

基准任务 R3（合规：导出手机号脱敏）会要求加入手机号脱敏，
并且日志里也不能出现原值。当前实现完全没有脱敏。
"""
from __future__ import annotations

from pathlib import Path

from .csvio import read_rows, write_rows


def export_rows(path: str | Path) -> list[list[str]]:
    return read_rows(path)


def export(path: str | Path, out: str | Path | None = None) -> str | None:
    rows = export_rows(path)
    return write_rows(rows, out)
