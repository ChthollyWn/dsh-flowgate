"""csvtool 命令行入口。

子命令：
  stats  统计行数、列名、空单元格
  export 原样导出 CSV（基准任务 R3 会要求加手机号脱敏）

基准任务 R1（CSV 去重）还没有对应子命令，需要新增 `dedupe`。
"""
from __future__ import annotations

import argparse
import sys

from .export import export
from .stats import summary_json


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="csvtool", description="零依赖 CSV 小工具")
    sub = parser.add_subparsers(dest="command", required=True)

    stats = sub.add_parser("stats", help="统计 CSV 基本信息")
    stats.add_argument("file", help="输入 CSV 路径")

    exp = sub.add_parser("export", help="导出 CSV（当前不脱敏）")
    exp.add_argument("file", help="输入 CSV 路径")
    exp.add_argument("--out", default=None, help="输出路径；省略则打印到标准输出")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "stats":
        print(summary_json(args.file))
        return 0

    if args.command == "export":
        result = export(args.file, args.out)
        if result is not None:
            print(result, end="")
        return 0

    parser.error("未知命令")
    return 2


if __name__ == "__main__":
    sys.exit(main())
