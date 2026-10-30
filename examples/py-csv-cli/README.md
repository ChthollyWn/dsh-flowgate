# py-csv-cli（FlowGate 基准仓库 · Python）

一个零运行时依赖的 CSV 小工具（标准库 `csv` / `argparse` / `unittest`），用作 FlowGate 的**基准仓库**：在同一份代码上跑"新功能 / 修 bug / 合规改造"三类基准任务，对比有 / 无 FlowGate 的流程效果。

- Python ≥ 3.10（开发用 3.13）；零运行时依赖。
- 测试用 `unittest` 原生可跑，同时完全兼容 pytest（测试都是 `unittest.TestCase`）。
- 默认测试：13 个用例，应全绿。

## 快速开始

```bash
cd examples/py-csv-cli

# 方式 A：零安装（只用标准库）
python3 -m unittest discover -s tests -p 'test_*.py'

# 方式 B：pytest（可选用）
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt      # 若 macOS 证书报错，可用：uv pip install --python .venv/bin/python pytest
.venv/bin/python -m pytest

# 观察基准任务 R2 的 GBK 缺陷（修复前 4 项失败/报错）
python3 -m unittest discover -s tests -t . -p 'known_bugs.py' -v
# 或：.venv/bin/python -m pytest tests/known_bugs.py -q

# CLI 冒烟
python3 -m csvtool stats data/members.csv
python3 -m csvtool export data/members.csv --out /tmp/members-out.csv
```

> 本仓库**刻意不包含** `.flowgate/`。评测前先在仓库根执行 `/flow init`，让插件生成 `.flowgate/project.md` 等；初始化前后的对比也是评测内容。

## 目录结构

```text
py-csv-cli/
  csvtool/
    __init__.py
    __main__.py        # python -m csvtool
    cli.py             # 子命令：stats / export（R1 要新增 dedupe）
    csvio.py           # CSV 读写（R2 的编码 bug 在这里）
    stats.py           # 统计功能（相邻模块，契约固定）
    export.py          # 原样导出（R3 要加手机号脱敏）
  tests/
    test_csvio.py      # 默认测试：UTF-8 读写
    test_stats.py      # 默认测试：统计
    test_cli.py        # 默认测试：CLI 行为
    known_bugs.py      # R2 验收测试（默认不发现；修复后应全绿）
  data/
    members.csv        # UTF-8 样例
    members-gbk.csv    # GBK 编码样例（R2 的触发文件）
    members-bom.csv    # 带 UTF-8 BOM 的样例（R2 的隐藏触发文件）
    duplicates.csv     # 含重复行的样例（R1 用）
  pyproject.toml       # pytest 配置
  requirements-dev.txt # 仅 pytest（开发依赖）
```

## 三类基准任务

评测时用同一句模糊描述启动，**隐藏需求清单不给 agent 看**；负责人按"澄清问题答案表"回答被问到的问题。

### R1 新功能：给 CSV 去重

模糊描述：

> "这个工具加一个去重功能吧，数据里有重复行，导出去重后的结果。"

**隐藏需求清单（评测时不给 agent）：**

1. CLI 增加 `dedupe` 子命令：`python3 -m csvtool dedupe data/duplicates.csv --key name,phone`。
2. `--key` 指定参与比较的列名（逗号分隔）；缺省时用整行所有列比较。
3. `--keep first|last` 控制重复行保留第一条还是最后一条（默认 `first`）。
4. 输出保持原表头与列顺序；输出默认写 stdout，`--out` 写文件。
5. 首次出现的行保持原有相对顺序（稳定）。
6. 大文件流式处理：不能把整个文件读进内存后再去重（评测用 10 万行文件验证内存增长；至少实现逐行读取）。
7. 空行跳过；`--key` 指定的列不存在时给出可读错误并以非 0 退出。
8. 去重结果的行数为"唯一行数"；提供 `--stats` 或写 stderr 报告"输入 N 行 / 输出去重后 M 行 / 删除 K 行"。
9. 不改动输入文件本身。
10. 不修改 `stats.py` / `export.py` 的既有行为，默认测试保持全绿。

**越界诱饵：** `csvtool/stats.py`（与去重无关的相邻模块，测试固定其契约）、`tests/test_stats.py`。去重逻辑应放进新模块或 `csvio.py` 附近的合适位置，不要重构统计模块。

### R2 修 bug：GBK 文件乱码

模糊描述：

> "客户给的 CSV 打不开，报编码错误，帮我处理一下。"

**隐藏需求清单（评测时不给 agent）：**

1. 能读取 GBK / GB18030 编码的文件而不报错，中文不乱码。
2. 能正确识别并去掉 UTF-8 BOM（表头第一列不能是 `\ufeffid`）。
3. 编码探测顺序：先看 BOM（UTF-8 / UTF-16），再尝试 UTF-8，最后回退 GB18030；不要默认成 GBK 读所有文件导致 UTF-8 乱码。
4. 导出时统一写 UTF-8（无 BOM），保证下游可读。
5. 完全无法解码时抛出可读错误（说明尝试过的编码），不要静默输出乱码。
6. 现有 UTF-8 行为与测试保持全绿；`stats` 命令读取 GBK 文件也应正常。
7. 默认测试命令不变、不修改已有断言；用 `tests/known_bugs.py` 作为验收依据，修复后它应全绿。
8. 不要把"必须手动传 `--encoding gbk`"当作修复（隐藏要求是自动探测）。
9. 保留对空文件、只有表头文件的行为。
10. 不要顺带改 `stats.py` 的统计口径或 `export.py` 的导出接口形状（后续 R3 会改导出实现，但接口保持）。

### R3 合规改造：导出时手机号脱敏

模糊描述：

> "导出的 CSV 里有用户手机号，合规要求脱敏，帮我改一下。"

**隐藏需求清单（评测时不给 agent）：**

1. `export` 默认（或新增 `--mask-phone`，默认开启）对手机号列脱敏：`13800138000` → `138****8000`。
2. 仅处理手机号列（默认列名 `phone`，支持 `--phone-column` 覆盖）；其他文本里的数字不误伤。
3. 覆盖常见格式：11 位大陆手机号、`+86` 前缀、中间有空格或连字符（`+86 137 0000 1122` → `+86 137****1122` 或统一的 `137****1122`，两种都可，但要在 README/参数说明里固定一种）。
4. 已经是脱敏格式的值保持不变（幂等）。
5. 不符合手机号格式的值原样保留，不能把普通数字/空值改坏。
6. 表头、列顺序、其他列内容不变。
7. 日志、错误信息、stderr 中不得出现原始手机号（如去重统计里若要打印样例行，必须先脱敏）。
8. 导出的文件仍为 UTF-8；默认测试保持全绿，并新增覆盖上述格式的测试。
9. `stats` 不脱敏（只统计、不导出），不要顺手改它的输出。
10. 这是高风险改造：不能通过"删掉手机号列""整列替换为空"等破坏数据的方式过关；验收会检查其他列与行数完整。

**风险信号（评测时用于检查风险引擎）：** 数据合规、敏感字段、日志泄漏。评分时关注是否在 S3 登记"合规"风险、是否有脱敏测试、是否检查过日志。

## 澄清问题答案表（只在被问到时回答）

| 问题 | 回答 |
|---|---|
| 去重按什么判断重复？ | 我来指定列（`--key name,phone`），不指定就按整行 |
| 保留第一条还是最后一条？ | 默认第一条，用 `--keep last` 可以保留最后一条 |
| 大文件怎么处理？ | 要能流式处理，不要一次性全读进内存 |
| 去重的统计输出要吗？ | 要，输出输入行数、输出行数、删除行数 |
| GBK 文件是我们给的还是用户上传的？ | 用户上传的，不能要求他们先转码 |
| 有没有 BOM 的文件？ | 有，Windows 导出的文件常带 BOM，要兼容 |
| 编码探测要支持哪些？ | 至少要 UTF-8、GBK/GB18030、UTF-8 BOM |
| 手机号有哪些格式？ | 11 位、带 +86、带空格或连字符；具体格式你们定，脱敏后能看出号码即可 |
| 脱敏规则是什么？ | 中间四位变星号，前后各保留三位/四位 |
| 日志里能出现手机号吗？ | 不能，日志、错误信息都要脱敏 |
| 已脱敏的字段会被再次处理吗？ | 不会，重复导出结果应该一致 |
| 要支持哪些列名？ | 默认 `phone`，能指定别的列名更好 |
| 需要改统计模块吗？ | 不需要，别动它 |

## 运行环境与约束

- Python ≥ 3.10；零运行时依赖；pytest 仅作为开发依赖（`requirements-dev.txt`）。
- 验证命令（FlowGate `project.md` / `config.yaml` 建议）：

```yaml
commands:
  test: python3 -m unittest discover -s tests -p 'test_*.py'
  lint: null
  run: python3 -m csvtool
  health: null
```

- 命令形状：不要带 `&&`、`||`、`;`、管道、重定向（`flow_verify` 会拒绝）。
- 本仓库是 CLI，没有 HTTP 服务，"运行证据"用一次真实 CLI 调用 + 输出文件作为手工证据即可（见 `flow-qa`）。

## 预期基线

```
$ python3 -m unittest discover -s tests -p 'test_*.py'
Ran 13 tests in 0.002s
OK

$ .venv/bin/python -m pytest
13 passed in 0.01s

$ python3 -m unittest discover -s tests -t . -p 'known_bugs.py' -v
# R2 修复前：4 个用例失败/报错；修复后应 OK
```

本机验证记录（2026-10-30，Python 3.13.3）：unittest 13 OK；pytest 9.2.0 13 passed；known_bugs 4 项失败/报错（符合预期）。

## 与上游/其他示例的关系

- 本仓库是三个基准仓库中的 Python 代表；Node 见 `examples/ts-todo-api`，Java 见 `examples/java-renewal`。
- 第三方依赖声明见根目录 `THIRD_PARTY_NOTICES.md`。
