"""统计功能：已实现，基准任务不涉及（相邻模块，保持契约）。"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .csvio import read_rows


def summary(path: str | Path) -> dict:
    rows = read_rows(path)
    if not rows:
        return {"file": str(path), "columns": [], "rows": 0, "emptyCells": 0}
    header = rows[0]
    data = rows[1:]
    empty = sum(1 for row in data for cell in row if cell.strip() == "")
    widths = Counter(len(row) for row in rows)
    return {
        "file": str(path),
        "columns": header,
        "rows": len(data),
        "emptyCells": empty,
        "rowWidths": dict(widths),
    }


def summary_json(path: str | Path) -> str:
    return json.dumps(summary(path), ensure_ascii=False, indent=2)
