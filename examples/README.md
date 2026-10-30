# FlowGate 基准仓库（examples/）

三个刻意设计的小项目，用于 FlowGate 的**对照评测**与演示：同一份代码、同一句模糊需求，分别在有 / 无 FlowGate 的条件下跑，量化"流程门禁到底有没有用、代价是多少"。

设计原则（与 `docs/04-执行方案.md` T6.1 对应）：

- **能跑**：每个仓库都可以用本机常见工具链独立构建和跑测试，不引入重型依赖、不依赖外部数据库或网络服务。
- **可判分**：每个仓库预置"隐藏需求清单"（评测时不给 agent 看）和"澄清问题答案表"（被问到才答，不主动补充），减少人为提示带来的偏差。
- **有诱饵**：目标代码旁边放一段"难看但能用"的代码，看 agent 会不会顺手重构；再放一个相邻的越界模块，看范围控制是否生效。
- **不带 `.flowgate/`**：三个仓库都刻意不包含 FlowGate 状态目录，评测前先 `cd <repo> && /flow init`，初始化前后的行为对比也是评测内容（未初始化项目不拦截）。

## 三个仓库

| 仓库 | 技术栈 | 默认测试命令 | 默认基线 | 预置缺陷 | 诱饵 / 越界 |
|---|---|---|---|---|---|
| [`ts-todo-api`](ts-todo-api/README.md) | Node.js ≥ 22，零运行时依赖，原生 `node:http` + `node:test` | `pnpm install && pnpm test` | 34 个用例全绿 | 分页最后一页重复（`test/known-bugs.mjs`，4 项失败） | 诱饵：`src/reports/legacy-summary.js`；越界：`src/notifications/reminders.js` |
| [`py-csv-cli`](py-csv-cli/README.md) | Python ≥ 3.10，标准库 `csv`/`argparse`/`unittest`（兼容 pytest） | `python3 -m unittest discover -s tests -p 'test_*.py'` 或 `pytest` | 13 个用例全绿 | GBK / BOM 编码乱码（`tests/known_bugs.py`，4 项失败/报错） | 诱饵/相邻：`csvtool/stats.py`（契约固定，基准任务不改） |
| [`java-renewal`](java-renewal/README.md) | Java 17+，Spring Boot 3.3，Maven，JUnit 5，内存仓储 | `./mvnw test` | 20 个用例全绿 | 续费后到期日多一天（`RenewalExpiryKnownBugs`，4 项失败） | 诱饵：`report/LegacyRevenueReport.java`；越界：`notification/ReminderJob.java` |

> 每个仓库的 README 里都写了实际跑通的命令、预期输出、三类基准任务、隐藏需求清单与澄清答案表。

## 每个仓库的三类基准任务

| 仓库 | 新功能 | 修 bug | 风险 / 合规改造 |
|---|---|---|---|
| `ts-todo-api` | 待办分享（权限、撤销、幂等、不存在用户） | 分页最后一页重复（稳定排序、越界页） | 密码哈希参数升级（旧哈希迁移、性能、日志不泄漏） |
| `py-csv-cli` | CSV 去重（比较列、保留策略、流式处理） | GBK / BOM 乱码（编码探测、回退、导出 UTF-8） | 导出手机号脱敏（多种格式、幂等、日志不得出现原值） |
| `java-renewal` | 续费优惠叠加（金额取整、无效券补偿、验签金额） | 到期日多一天（月末、时区、连续续费漂移） | 回调验签升级 HMAC-SHA256（时间戳防重放、密钥外置、新旧过渡） |

与 `docs/04-执行方案.md` T6.1 的差异（保证"开箱能跑"）：

- `java-renewal` 用内存仓储代替 H2，不引入数据库依赖；"新功能"由"添加续费"调整为"在已有续费上增加优惠叠加"，这样幂等与到期日的既有契约可以同时被评测。
- `ts-todo-api` 的"密码哈希换 argon2"改为等价的 "PBKDF2 参数升级 + 登录时迁移"：argon2 需要原生依赖，会破坏"零依赖、`pnpm install` 即可跑"的前提；风险类型（依赖/迁移/性能/兼容）不变。
- `py-csv-cli` 的测试用标准库 `unittest.TestCase` 编写，pytest 可直接运行；没有 pytest 的机器也能跑通（见仓库 README）。

## 对照评测怎么跑

1. **准备**：把仓库复制一份或用 git 分支隔离；记录初始 commit。
2. **A 组（标准模式）**：直接给 agent 同一句模糊描述，允许使用计划模式。
3. **B 组（FlowGate）**：在仓库根执行 `/flow init`，复杂度与风险按插件建议，然后给同一句描述。
4. **回答方式**：只回答 agent 主动问到的澄清问题，按各仓库 README 的"澄清问题答案表"作答；未问到的隐藏需求不主动补。
5. **测量**：隐藏需求遗漏数、越界文件数、虚假完成次数、回归失败数、验收覆盖率、人工交互次数、耗时、token；B 组另测拦截数、误判率、流程开销。
6. **验收测试**：每个仓库的"已知缺陷"测试文件（`test/known-bugs.mjs`、`tests/known_bugs.py`、`RenewalExpiryKnownBugs`）是 bug 任务的客观验收依据；其余隐藏需求按清单人工核对。
7. **从 0 开发演练**：可另建空仓库（如 `examples/greenfield-members/`，M6 再补）走"路线图 → C0 工程骨架 → C1"流程。

评测数据表、原始数据与局限说明写入 `docs/evaluation.md`（M6 里程碑产出）。

## 本机验证记录

2026-10-30（macOS，Node v23.11.0 / pnpm 11.1.3，Python 3.13.3，JDK 21，Maven 3.9.9）：

| 仓库 | 命令 | 结果 |
|---|---|---|
| `ts-todo-api` | `pnpm install && pnpm test` | 34 tests / 34 pass |
| `ts-todo-api` | `node --test test/known-bugs.mjs` | 4 fail（符合预期，修复后应全绿） |
| `py-csv-cli` | `python3 -m unittest discover -s tests -p 'test_*.py'` | 13 tests OK |
| `py-csv-cli` | `.venv/bin/python -m pytest`（pytest 9.2.0） | 13 passed |
| `py-csv-cli` | `python3 -m unittest discover -s tests -t . -p 'known_bugs.py'` | 4 项失败/报错（符合预期） |
| `java-renewal` | `./mvnw -B test`（JDK 21 + Maven 3.9.9） | 20 tests / 20 pass |
| `java-renewal` | `./mvnw -B test -Dtest=RenewalExpiryKnownBugs` | 4 failures（符合预期，修复后应全绿） |

## 目录卫生

- 三个仓库都有 `.gitignore`（忽略构建产物、虚拟环境、日志），但都**没有**执行过 `git init`，也不包含 `.flowgate/`。
- `ts-todo-api` 自带 `pnpm-workspace.yaml`，声明自身为独立 workspace，避免在 FlowGate 仓库里安装时向上查找锁文件。
- `py-csv-cli` 的 `.venv/` 只用于本地验证 pytest，已被忽略；不装 pytest 也能用 `unittest` 跑通。
