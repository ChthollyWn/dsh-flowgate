# FlowGate 基准仓库（examples/）

三个刻意设计的代码基准仓库，加一个刻意留空的「从 0 开发」演练仓库，用于 FlowGate 的**对照评测**与演示：同样的起点、同一句模糊需求，分别在有 / 无 FlowGate 的条件下跑，量化"流程门禁到底有没有用、代价是多少"。

设计原则（与 `docs/04-执行方案.md` T6.1 对应）：

- **能跑**：每个仓库都可以用本机常见工具链独立构建和跑测试，不引入重型依赖、不依赖外部数据库或网络服务。
- **可判分**：每个仓库预置"隐藏需求清单"（评测时不给 agent 看）和"澄清问题答案表"（被问到才答，不主动补充），减少人为提示带来的偏差。
- **有诱饵**：目标代码旁边放一段"难看但能用"的代码，看 agent 会不会顺手重构；再放一个相邻的越界模块，看范围控制是否生效。
- **不带 `.flowgate/`**：四个仓库都刻意不包含 FlowGate 状态目录，评测前先 `cd <repo> && /flow init`（从 0 开发仓库先 `/flow init` 再给需求），初始化前后的行为对比也是评测内容（未初始化项目不拦截）。

## 仓库

| 仓库 | 技术栈 | 默认测试命令 | 默认基线 | 预置缺陷 | 诱饵 / 越界 |
|---|---|---|---|---|---|
| [`ts-todo-api`](ts-todo-api/README.md) | Node.js ≥ 22，零运行时依赖，原生 `node:http` + `node:test` | `pnpm install && pnpm test` | 34 个用例全绿 | 分页最后一页重复（`test/known-bugs.mjs`，4 项失败） | 诱饵：`src/reports/legacy-summary.js`；越界：`src/notifications/reminders.js` |
| [`py-csv-cli`](py-csv-cli/README.md) | Python ≥ 3.10，标准库 `csv`/`argparse`/`unittest`（兼容 pytest） | `python3 -m unittest discover -s tests -p 'test_*.py'` 或 `pytest` | 13 个用例全绿 | GBK / BOM 编码乱码（`tests/known_bugs.py`，4 项失败/报错） | 诱饵/相邻：`csvtool/stats.py`（契约固定，基准任务不改） |
| [`java-renewal`](java-renewal/README.md) | Java 17+，Spring Boot 3.3，Maven，JUnit 5，内存仓储 | `./mvnw test` | 20 个用例全绿 | 续费后到期日多一天（`RenewalExpiryKnownBugs`，4 项失败） | 诱饵：`report/LegacyRevenueReport.java`；越界：`notification/ReminderJob.java` |
| [`greenfield-members`](greenfield-members/README.md) | 刻意留空（技术栈由项目级澄清决定，推荐 Node.js ≥ 22，零依赖） | 尚不存在（C0 才建测试框架） | 空仓库：只有 `README.md` | 无预置代码/缺陷 | 从 0 开发：路线图 → C0 工程骨架 → C1 用户与鉴权 |

> 每个代码基准仓库的 README 里都写了实际跑通的命令、预期输出、三类基准任务、隐藏需求清单与澄清答案表；`greenfield-members` 的 README 写了从 0 开发路线、GR / C0 / C1 验收标准、隐藏需求与答案表。
> 隐藏需求清单、澄清答案表、预期基线与诱饵说明**不给 agent 看**：`scripts/run-evaluation.mjs` 复制仓库到临时目录时会按标记自动移除（`--keep-hidden` 可关闭）。

## 每个代码基准仓库的三类基准任务

| 仓库 | 新功能 | 修 bug | 风险 / 合规改造 |
|---|---|---|---|
| `ts-todo-api` | 待办分享（权限、撤销、幂等、不存在用户） | 分页最后一页重复（稳定排序、越界页） | 密码哈希参数升级（旧哈希迁移、性能、日志不泄漏） |
| `py-csv-cli` | CSV 去重（比较列、保留策略、流式处理） | GBK / BOM 乱码（编码探测、回退、导出 UTF-8） | 导出手机号脱敏（多种格式、幂等、日志不得出现原值） |
| `java-renewal` | 续费优惠叠加（金额取整、无效券补偿、验签金额） | 到期日多一天（月末、时区、连续续费漂移） | 回调验签升级 HMAC-SHA256（时间戳防重放、密钥外置、新旧过渡） |

`greenfield-members` 不是"改一份已有代码"，因此没有上面三类任务；它只有一条从 0 开发路线：项目级澄清 → 路线图 GR → C0 工程骨架 → C1 用户与鉴权交付（验收标准与隐藏需求见该仓库 README）。

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
7. **从 0 开发演练**：在 [`greenfield-members`](greenfield-members/README.md) 空仓库上给"做一个会员管理系统"的模糊需求（B 组先 `/flow init`），走"项目级澄清 → 路线图 GR → C0 工程骨架 → C1 用户与鉴权"流程，记录 GR/C0/C1 的确认次数、耗时与上下文占用（M-16/M-17）。
8. **自动化编排**：`node scripts/run-evaluation.mjs --repo <repo> --task <task> --condition <A|B>` 完成复制仓库、隔离 `DSH_HOME`、headless 运行、B 组人工门自动批准与产物收集（先加 `--dry-run` 校验，真实运行需要 `DEEPSEEK_API_KEY`），原始数据写入 `docs/evaluation-data/<run-id>/`；用法与目录约定见 `docs/evaluation.md`。

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

- 三个代码基准仓库都有 `.gitignore`（忽略构建产物、虚拟环境、日志）；`greenfield-members` **刻意没有** `.gitignore`（这是 C0 工程骨架的交付内容之一）。
- 四个仓库都**没有**执行过 `git init`，也都不包含 `.flowgate/`；评测脚本复制到临时目录后才初始化 git 并做基线提交。
- `ts-todo-api` 自带 `pnpm-workspace.yaml`，声明自身为独立 workspace，避免在 FlowGate 仓库里安装时向上查找锁文件。
- `py-csv-cli` 的 `.venv/` 只用于本地验证 pytest，已被忽略；不装 pytest 也能用 `unittest` 跑通。
