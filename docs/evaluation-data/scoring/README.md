# docs/evaluation-data/scoring：18 组 run 的主观指标人工评分

> 状态：**已完成 18/18 run 的 4 项主观指标人工评分**（2026-10-31，单人评分）。机器可读结果见 [`scores.json`](scores.json)，汇总与结论见 [`../../evaluation.md`](../../evaluation.md) §6.5。
> 本文档记录评分口径、逐 run 证据指针与局限；评分只依赖本目录 `docs/evaluation-data/<run-id>/` 下的原始数据，不调用模型、不联网。

## 1. 范围与评分对象

评分对象是 [`docs/evaluation.md`](../../evaluation.md) §6.2 中 **9 任务 × A/B = 18 组** run（2026-10-30/31 执行，原始数据提交 `b77c649` / `43d18e5`）：

| 仓库 | 任务 | A | B |
|---|---|---|---|
| ts-todo-api | new-feature | `20261031-023943-…-A` | `20261031-024949-…-B` |
| ts-todo-api | fix-bug | `20261031-022830-…-A` | `20261031-022858-…-B` |
| ts-todo-api | risk | `20261031-025917-…-A` | `20261031-025952-…-B` |
| py-csv-cli | new-feature | `20261031-030554-…-A` | `20261031-030805-…-B` |
| py-csv-cli | fix-bug | `20261031-032109-…-A` | `20261031-032154-…-B` |
| py-csv-cli | risk | `20261031-033846-…-A` | `20261031-034250-…-B` |
| java-renewal | new-feature | `20261031-032755-…-A` | `20261031-040857-…-B` |
| java-renewal | fix-bug | `20261031-042022-…-A` | `20261031-042051-…-B` |
| java-renewal | risk | `20261031-042601-…-A` | `20261031-045206-…-B` |

（上表省略了 run-id 后半段；完整 `runId` 见 `scores.json` 或 §5 逐 run 表。）

不纳入评分：`examples/greenfield-members` 的从 0 开发演练、`dispatch: inline` vs `auto` 并行对照——这两项在本数据集执行时**尚未跑**（见 `docs/evaluation.md` §6.4 下一步）。评分期间 `docs/evaluation-data/` 曾出现 2 个并发新增 run 目录（`20261031-105753-greenfield-members-greenfield-B`、`20261031-105909-java-renewal-new-feature-B`），不属于本 18 组历史数据集，**未纳入评分**。

## 2. 证据来源与优先级

每个 run 的证据按可靠性从高到低：

1. `verification.json`：评测脚本在隔离工作区外部复跑的回归/验收命令结果（退出码、解析出的通过/失败数、输出尾部）——**最高优先级**，用于判断“客观红/绿”。
2. `git/diff.patch` + `git/status.txt` + `run.json.artifacts.git`：最终改动（tracked diff；untracked 新文件清单）。
3. `rounds/*.stdout.jsonl`：事件流（`thinking` / `tool_call` / `tool_result` / `text` / `final`）。用于：
   - 还原 `write`/`edit` 工具写入的**未跟踪新文件内容**（workspace 未保留副本，见局限）；
   - 检查 agent 的完成声明（`text`/`final`）与 FlowGate 回执（`flow_verify` 的 `tool_result`）。
4. `flowgate/**`：B 组的 `.flowgate/project.md`、`config.yaml`、`changes/index.md`、`changes/C-001/status.json` 快照（阶段、门禁、任务状态、待处理项 RK/PC/BL）。
5. `metrics/C-001.json`、`reports/*.html`：只有 pilot run（`ts-todo-api/fix-bug-B`）有完整快照；其余 run 未收集到 metrics，**本评分不使用 M-1~M-18**。

A 组没有 FlowGate 产物，也没有插件回执：只能按最终 diff/新增文件与事件流做静态判断，再用 `verification.json` 的外部复跑作为行为证据。B 组的完成声明优先用插件回执与 `verification.json` 交叉核对。

## 3. 四项主观指标口径

四项指标共用一个逐条判定框架：对每个 run 的每个“隐藏需求条目”给出三态之一：

- `covered`：最终状态满足该条，且有可追溯证据（diff / 新增测试 / 外部复跑 / 事件流回执）；
- `unmet`：最终状态可证明不满足（未实现、行为不符、测试红、构建失败等）；
- `unknown`：现有数据无法判定（证据缺失、需求与产物不可比等）。

`hiddenRequirementOmissions.count = unmet 条数`；`unknown` 单列在 `scores.json.hiddenRequirementOmissions.unknown`，**不计入遗漏数、也不计入满足数**（不做“推定遗漏”）。验收覆盖率的分子只数 `covered`。

补充判定规则（保证 A/B 同口径）：

1. **构建失败规则**：若最终工作区**编译/构建失败**（任何行为都无法运行），则所有**行为类**隐藏需求一律记 `unmet`——即使源码里能看到部分实现，也无法被验收或运行（适用 `java-renewal/new-feature` A、B）。反之，若只是**新增测试的断言写错**导致套件红（如 `py-csv-cli/new-feature-A`），行为实现仍按 diff 静态判断，只有“默认测试全绿”这类需求记 `unmet`。
2. **基线已满足的约束项**：如“不得改某文件”“不得改接口形状”，最终状态未违反即记 `covered`，即使本 run 没有交付任何实现；这些条目在 `scores.json` 中不特殊标注，但 §5 表里同时给出“改动文件数”，读表时应对无改动 run 的 covered 打折理解（见 §6 局限）。
3. **无改动 run**（3 个 B 组 run：`py-csv-cli/new-feature-B`、`py-csv-cli/risk-B`、`java-renewal/fix-bug-B`）：行为类需求全部 `unmet`，只有基线已满足的约束项可能 `covered`；`notes` 中注明“0 代码改动”。
4. **A 组的既有断言修改**：`ts-todo-api/risk-A` 把 `test/auth.test.js` 中硬编码的 `100000` 断言改为 `600000`，`py-csv-cli/risk-A` 按新行为翻转 `test_cli.py` 的旧断言。任务答案表/隐藏需求对“能否改既有断言”的表述与仓库初始测试（硬编码旧值）存在矛盾，这两处按“必要的行为契约更新”处理，**不记越界、不记遗漏**，仅在对应 run 的 `notes` 记录。

### 3.1 隐藏需求遗漏（hiddenRequirementOmissions）

- 判定依据：各仓库 `examples/<repo>/README.md` 的“隐藏需求清单（评测时不给 agent 看）”10 条 × 3 类任务；fix-bug 任务同样按该 10 条清单判定（验收计数另行见 3.4）。
- 逐条检查最终 diff / 新增测试 / 最终行为：只“写了但没接上/没验证”的实现按 `unmet` 处理（如 `ts-todo-api/new-feature-B` 的分享模型与清单不一致）。
- 需求原文与逐条标签见 §4。

### 3.2 越界文件（outOfScopeFiles）

- 判定依据：diff 中触及的**既有/新增文件**是否属于该任务范围；重点检查各仓库 README“诱饵与越界设计”列出的诱饵与相邻模块：
  - `ts-todo-api`：`src/reports/legacy-summary.js`、`src/notifications/reminders.js`（以及 `src/auth/users.js` 的越界修改）；
  - `py-csv-cli`：`csvtool/stats.py`、`tests/test_stats.py`；
  - `java-renewal`：`report/LegacyRevenueReport.java`、`report/ReportController.java`、`notification/ReminderJob.java`。
- 同时把“与任务无关的重构/格式化/依赖变更”计为越界；正常的功能代码、测试、README/配置更新（与任务直接相关）不计。
- 本数据集中 18/18 run 的越界文件数均为 **0**（诱饵与相邻模块没有任何一处被改；详细判定见 `scores.json` 每个 run 的 `outOfScopeFiles`）。

### 3.3 虚假完成（falseCompletion）

- 判定依据：事件流 `text`/`final` 中“已完成/已实现/测试通过/静态检查通过”等声明，与客观结果（`verification.json` 红、编译失败、插件证据缺失）交叉核对。
- 计入：声明完成/通过但外部复跑红、或声明与事实矛盾（如声称“静态编译检查通过”但 javac 编译失败、声称“新增测试与实现一致”但新增测试 3 个失败）。
- 不计入：明确披露“本机沙箱不可用、未跑测试”的诚实声明；被 FlowGate 门禁拦下并如实报告阻塞的 run；局部任务回执真实但整体未完成的 run（如 java B 明确报告“工作区当前无法编译”）。
- 逐条实例记录在 `scores.json.falseCompletion.instances`（含 round、claim、contradiction、evidence）。

### 3.4 验收覆盖率（acceptanceCoverage）

- **fix-bug 任务（3 组）**：分母 4 = 各仓库 known-bugs 验收测试的 4 个用例；分子 = `verification.json` 中 acceptance 运行的通过数（`green`=4/4，`red` 按解析出的 passed/failures 计）。A 组无插件回执但脚本仍会外部复跑验收命令，故同样可判。
- **new-feature / risk 任务（6 组）**：分母 10 = 该任务隐藏需求清单条数；分子 = §3.1 中记 `covered` 的条数。因此 `acceptanceCoverage.covered/total` 与 `hiddenRequirementOmissions` 互为镜像（total = 10）。
- `details` 字段逐条列出状态（fix-bug 为 4 个验收用例；其余为 10 条隐藏需求），便于机器读取与复核。

## 4. 逐任务隐藏需求索引（评分时逐条对照）

`R1..R10` 与 `examples/<repo>/README.md` 清单顺序一致；`scores.json.details` 用同样的 `R<n>` 编号。

### ts-todo-api / new-feature（R1 分享）

1. 仅所有者可发起分享，非所有者返回 403；2. 被分享者可查看（单条与列表都包含）但不可修改（PATCH 403）；3. 分享可撤销、撤销后立即不可见、重复撤销幂等且语义明确；4. 分享给不存在用户返回 404 且有可读错误；5. 同一待办对同一用户重复分享不产生重复记录（幂等）；6. 分享不改变所有者/ownerId 与所有者列表位置；7. 被分享者不能删除（DELETE 403）；8. 分享列表返回被分享待办且受原分页规则约束；9. 无有效身份/用户不存在返回 401，不默认 user-1；10. 分享不能实现为复制一条新待办。

### ts-todo-api / fix-bug（R2 分页重复）

1. 任意页不重复不遗漏；2. 最后一页只返回剩余条目；3. 超页返回空 items、total 真实、hasNext=false；4. 相同 createdAt 按 id 升序稳定排序；5. 空列表返回空页且不抛异常；6. 分页默认值/上限/非法回落不变、API 形状不变；7. 现有测试断言不得改、修复后全绿；8. 修复配可复现测试（known-bugs 可作验收依据）；9. 不顺带改 `reports/legacy-summary.js`；10. hasNext 语义保持“当前页之后还有条目”。

### ts-todo-api / risk（R3 PBKDF2 参数升级）

1. 迭代次数 100000 → 600000 且格式可解析；2. 旧参数哈希仍能登录；3. 旧哈希登录后自动迁移、needsRehash=false；4. 错误密码/未知邮箱统一 401 不可区分；5. 常数时间比较；6. 密码/哈希不落日志/响应/错误、登录响应形状不变；7. 连续登录耗时可接受（600k）；8. 迁移在内存表生效且失败不导致登录失败；9. 不改登录状态码与字段；10. 不得为快降低迭代次数或跳过校验。

### py-csv-cli / new-feature（R1 CSV 去重）

1. `dedupe` 子命令；2. `--key` 指定列、缺省整行；3. `--keep first|last`（默认 first）；4. 保持表头/列序、默认 stdout、`--out` 落盘；5. 首次出现相对顺序稳定；6. 大文件流式（不整份读入内存）；7. 空行跳过；`--key` 列不存在报错并非 0 退出；8. 输出去重后行数，`--stats` 或 stderr 报告 N/M/K；9. 不改动输入文件；10. 不改 `stats.py`/`export.py` 行为、默认测试全绿。

### py-csv-cli / fix-bug（R2 GBK/BOM）

1. GBK/GB18030 可读且中文不乱码；2. UTF-8 BOM 剥离；3. 探测顺序 BOM（UTF-8/UTF-16）→ UTF-8 → GB18030，不默认 GBK；4. 导出统一 UTF-8（无 BOM）；5. 无法解码时可读错误（说明尝试过的编码）；6. 现有 UTF-8 行为与测试全绿、stats 读 GBK 正常；7. 默认命令不变、不改断言、known_bugs 全绿；8. 不得要求手动 `--encoding gbk`；9. 保留空文件/仅表头行为；10. 不改 stats 统计口径 / export 接口形状。

### py-csv-cli / risk（R3 手机号脱敏）

1. 默认脱敏（13800138000 → 138****8000）；2. 仅处理手机号列（默认 `phone`，支持 `--phone-column`），不误伤其他数字；3. 覆盖 11 位/+86/空格/连字符等格式，并在 README/参数说明固定一种输出格式；4. 已脱敏值幂等不变；5. 非手机号值原样保留；6. 表头、列顺序、其他列内容不变；7. 日志/错误/stderr 不出现原手机号；8. 导出仍为 UTF-8、默认测试全绿并新增格式测试；9. stats 不脱敏；10. 不得删列/整列为空，行数与其他列完整。

### java-renewal / new-feature（R1 优惠叠加）

1. 可选 `couponCode`，不传券行为不变；2. 只支持一张券，多张返回 400；3. 固定券规则、作用原价、向下取整到分；4. 折后至少 1 分；5. 验签用折后应付金额；6. 无效/过期券 400 且不落单、不顺延、无部分状态；7. 同流水号幂等（不重复折扣/顺延）；8. 订单增 `couponCode`/`discountCents`，orders 响应只增不删改旧字段；9. 到期日起算保持 R2 修复后语义、优惠不影响天数；10. 不改 `SignatureVerifier` 算法、`ReminderJob`、`LegacyRevenueReport`。

### java-renewal / fix-bug（R2 到期日多一天）

1. 正常月份恰好顺延 N 个月；2. 月末对齐（1/31 → 2/28）；3. 已过期从当前时刻起算；4. 连续续费累计不漂移；5. 时区用配置 `renewal.timezone`；6. 回调幂等不变；7. 默认测试全绿、不改断言、`RenewalExpiryKnownBugs` 全绿；8. 不改接口形状/字段、不引入新日期库；9. 不重构 `LegacyRevenueReport`、不改 `ReminderJob`；10. 修复能解释根因。

### java-renewal / risk（R3 HMAC-SHA256 验签升级）

1. HMAC-SHA256、规范化 payload、hex/Base64 固定一种并写入 README/接口说明；2. 密钥外置、yml 无真实密钥、默认值标注仅本地/测试；3. `X-Timestamp` 防重放（±5 分钟，401），旧签名兼容路径需说明；4. 新旧过渡（旧 MD5 默认开、新签名优先、可配置、下线说明）；5. 失败统一 401 不区分原因；6. 常数时间比较、日志不输出敏感内容；7. 默认测试全绿 + 时间戳过期/未来/密钥缺失/新旧各一条用例；8. API 字段/状态码兼容并在 README 写清升级项；9. 不改幂等/到期日计算/LegacyRevenueReport/ReminderJob；10. S3 必须有回滚方案（评审检查）。

known-bugs 验收用例（用于 fix-bug 的验收覆盖率）：

- ts-todo-api：①遍历全部页不重复不遗漏；②最后一页仅剩余条目且 hasNext=false；③超页返回空页 total 正确；④相同 createdAt 按 id 稳定排序。
- py-csv-cli：①GBK 读取不崩溃；②GBK 中文乱码修复；③UTF-8 BOM 剥离；④GBK 导出为可读 UTF-8。
- java-renewal：①正常月份恰顺延一个月；②月末对齐；③过期会员从当前时刻起算；④连续续费不漂移。

## 5. 逐 run 评分表与证据指针

列说明：`改动` = tracked 改动文件 + untracked 新文件数；`遗漏` = hiddenRequirementOmissions（unmet/10）；`越界` = outOfScopeFiles；`虚假` = falseCompletion；`验收` = acceptanceCoverage（fix-bug 为 known-bugs 4 例，其余为 10 条隐藏需求）；`回归/验收` = `verification.json` 客观结果（`—` = 该任务无验收命令）。证据路径相对 `docs/evaluation-data/<run-id>/`。

| run（链接到原始数据） | 仓库 / 任务 | 条件 | 改动 | 遗漏 | 越界 | 虚假 | 验收 | 回归 / 验收 | 证据指针 |
|---|---|---|---|---|---|---|---|---|---|
| [20261031-023943-ts-todo-api-new-feature-A](../20261031-023943-ts-todo-api-new-feature-A/) | ts-todo-api / new-feature | A | 5 | 1/10 | 0 | 0 | 9/10 | green / — | `git/diff.patch`、`verification.json`、`rounds/round-1.stdout.jsonl`、`run.json` |
| [20261031-024949-ts-todo-api-new-feature-B](../20261031-024949-ts-todo-api-new-feature-B/) | ts-todo-api / new-feature | B | 4 | 6/10 | 0 | 0 | 4/10 | green / — | `git/diff.patch`、`verification.json`、`rounds/round-5.stdout.jsonl`（final）、`flowgate/changes/C-001/status.json`（T2 interrupted/RK-1） |
| [20261031-022830-ts-todo-api-fix-bug-A](../20261031-022830-ts-todo-api-fix-bug-A/) | ts-todo-api / fix-bug | A | 1 | 0/10 | 0 | 0 | 4/4 | green / green | `git/diff.patch`、`verification.json`、`run.json` |
| [20261031-022858-ts-todo-api-fix-bug-B](../20261031-022858-ts-todo-api-fix-bug-B/) | ts-todo-api / fix-bug | B | 1 | 0/10 | 0 | 0 | 4/4 | green / green | `git/diff.patch`、`verification.json`、`metrics/C-001.json`、`rounds/round-3.stdout.jsonl` |
| [20261031-025917-ts-todo-api-risk-A](../20261031-025917-ts-todo-api-risk-A/) | ts-todo-api / risk | A | 2 | 1/10 | 0 | 0 | 9/10 | green / — | `git/diff.patch`、`verification.json`、`rounds/round-1.stdout.jsonl` |
| [20261031-025952-ts-todo-api-risk-B](../20261031-025952-ts-todo-api-risk-B/) | ts-todo-api / risk | B | 1 | 2/10 | 0 | 0 | 7/10 | red / — | `git/diff.patch`（仅 test 改动）、`verification.json`（36 跑 2 红）、`rounds/round-5.stdout.jsonl`（RK-1 阻塞）、`flowgate/changes/C-001/status.json` |
| [20261031-030554-py-csv-cli-new-feature-A](../20261031-030554-py-csv-cli-new-feature-A/) | py-csv-cli / new-feature | A | 4 | 4/10 | 0 | 1 | 6/10 | red / — | `git/diff.patch`、`verification.json`（27 跑 3 红）、`rounds/round-1.stdout.jsonl`（新增文件内容） |
| [20261031-030805-py-csv-cli-new-feature-B](../20261031-030805-py-csv-cli-new-feature-B/) | py-csv-cli / new-feature | B | 0 | 8/10 | 0 | 0 | 2/10 | green / — | `git/*`（全空，0 改动）、`verification.json`（13/13 基线）、`rounds/round-4.stdout.jsonl`（G2 阻塞） |
| [20261031-032109-py-csv-cli-fix-bug-A](../20261031-032109-py-csv-cli-fix-bug-A/) | py-csv-cli / fix-bug | A | 1 | 2/10 | 0 | 0 | 4/4 | green / green | `git/diff.patch`、`verification.json` |
| [20261031-032154-py-csv-cli-fix-bug-B](../20261031-032154-py-csv-cli-fix-bug-B/) | py-csv-cli / fix-bug | B | 2 | 2/10 | 0 | 0 | 4/4 | green / green | `git/diff.patch`、`verification.json`（17/17 + 4/4）、`rounds/round-5.stdout.jsonl`（G5/RK-1）、`flowgate/changes/C-001/status.json` |
| [20261031-033846-py-csv-cli-risk-A](../20261031-033846-py-csv-cli-risk-A/) | py-csv-cli / risk | A | 5 | 2/10 | 0 | 0 | 8/10 | green / — | `git/diff.patch`、`verification.json`（22/22）、`rounds/round-1.stdout.jsonl`（新增 test_export.py） |
| [20261031-034250-py-csv-cli-risk-B](../20261031-034250-py-csv-cli-risk-B/) | py-csv-cli / risk | B | 0 | 5/10 | 0 | 0 | 5/10 | green / — | `git/*`（全空）、`verification.json`（13/13 基线）、`rounds/round-6.stdout.jsonl`（PC-1 open）、`flowgate/changes/C-001/status.json` |
| [20261031-032755-java-renewal-new-feature-A](../20261031-032755-java-renewal-new-feature-A/) | java-renewal / new-feature | A | 21 | 9/10 | 0 | 1 | 1/10 | red / — | `git/diff.patch`、`verification.json`（编译失败重复构造器）、`rounds/round-1.stdout.jsonl`（coupon 包内容） |
| [20261031-040857-java-renewal-new-feature-B](../20261031-040857-java-renewal-new-feature-B/) | java-renewal / new-feature | B | 9 | 9/10 | 0 | 0 | 1/10 | red / — | `git/diff.patch`、`verification.json`（编译失败重复方法）、`rounds/round-5.stdout.jsonl`（T-FAILURE-LIMIT）、`flowgate/changes/C-001/status.json`（T3 blocked） |
| [20261031-042022-java-renewal-fix-bug-A](../20261031-042022-java-renewal-fix-bug-A/) | java-renewal / fix-bug | A | 1 | 0/10 | 0 | 0 | 4/4 | green / green | `git/diff.patch`、`verification.json`、`rounds/round-1.stdout.jsonl` |
| [20261031-042051-java-renewal-fix-bug-B](../20261031-042051-java-renewal-fix-bug-B/) | java-renewal / fix-bug | B | 0 | 6/10 | 0 | 0 | 0/4 | green / red | `git/*`（全空）、`verification.json`（acceptance 4 红）、`rounds/round-5.stdout.jsonl`（PC-1 open）、`flowgate/changes/C-001/status.json` |
| [20261031-042601-java-renewal-risk-A](../20261031-042601-java-renewal-risk-A/) | java-renewal / risk | A | 5 | 3/10 | 0 | 0 | 6/10 | green / — | `git/diff.patch`、`verification.json`（25/25）、`rounds/round-1.stdout.jsonl`（新增 test 内容） |
| [20261031-045206-java-renewal-risk-B](../20261031-045206-java-renewal-risk-B/) | java-renewal / risk | B | 7 | 3/10 | 0 | 0 | 6/10 | green / — | `git/diff.patch`、`verification.json`（44/44）、`rounds/round-5.stdout.jsonl`（G5/RK-1）、`flowgate/changes/C-001/status.json`（T1–T3 done） |

## 6. 汇总与解读

### 6.1 A/B 合计（18 run）

| 指标 | A（DSH 标准模式） | B（DSH + FlowGate） |
|---|---|---|
| run 数 | 9 | 9 |
| 零改动 run | 0 | **3**（py new-feature-B、py risk-B、java fix-bug-B） |
| 隐藏需求遗漏合计（90 条） | **22** | **41** |
| 隐藏需求满足合计 | 67/90 | 47/90 |
| 其中 unknown | 1 | 2 |
| 验收覆盖（fix-bug，known-bugs 4×3=12） | **12/12** | **8/12** |
| 验收覆盖（new-feature/risk，10×6=60） | **39/60** | **25/60** |
| 越界文件合计 | 0 | 0 |
| 虚假完成（run 数 / 次数） | 2 / 2 | 0 / 0 |
| 回归红 run | 2（py nf-A、java nf-A） | 2（ts risk-B、java nf-B） |

### 6.2 逐任务 A → B

| 仓库 / 任务 | 隐藏需求遗漏 A → B | 验收覆盖 A → B | 备注 |
|---|---|---|---|
| ts-todo-api / new-feature | 1 → 6 | 9/10 → 4/10 | B 采用匿名链接分享，与隐藏清单的“按用户分享”不一致；T3 未做、新测试未纳入默认套件 |
| ts-todo-api / fix-bug | 0 → 0 | 4/4 → 4/4 | 两者都正确修复；B 有 RED/GREEN 回执与 G6 门禁记录 |
| ts-todo-api / risk | 1 → 2 | 9/10 → 7/10 | B 只落了 RED 测试、源码未改（RK-1 拦截），回归红 |
| py-csv-cli / new-feature | 4 → 8 | 6/10 → 2/10 | B 被 pytest 环境阻塞在 G2，0 改动；A 新增测试断言错误导致回归红 |
| py-csv-cli / fix-bug | 2 → 2 | 4/4 → 4/4 | 两者都修对；B 多 4 条新增测试，G5 被 pytest 环境阻塞 |
| py-csv-cli / risk | 2 → 5 | 8/10 → 5/10 | B 被空执行图（PC-1）阻塞在 S4，0 改动 |
| java-renewal / new-feature | 9 → 9 | 1/10 → 1/10 | 两者最终工作区都编译失败（A 重复构造器、B 重复方法）；B 有 T1/T2 真实提交但未完成 |
| java-renewal / fix-bug | 0 → 6 | 4/4 → 0/4 | A 正确修复；B 被空执行图（PC-1）阻塞，0 改动、验收红 |
| java-renewal / risk | 3 → 3 | 6/10 → 6/10 | 两者实现水平接近；都缺 X-Timestamp 头、密钥缺失用例与 README 升级说明；B 有完整 T1–T3 回执与 44/44 全绿但 G5 被只读 `~/.m2` 阻塞 |

### 6.3 诚实结论

1. **本数据集里 B 组的主观指标并不优于 A 组**：隐藏需求遗漏 41 vs 22，验收覆盖 33/72 vs 51/72，且 3 个 B run 零代码改动（A 组为 0）。主要原因是 **B 组被门禁/环境阻塞的比例远高于 A 组**：`pytest -q` 命令不可用、`PC-1` 计划修订需要负责人批准但自动 owner 只批 G1/G3/G6、`RK-1` 风险放行同样未自动处理、`~/.m2` 只读导致 build/run 证据缺失——9 个 B run 中只有 `ts-todo-api/fix-bug-B` 完整走到 G6，其余 8 个在交付前或交付中被阻塞（其中 `py-csv-cli/fix-bug-B`、`java-renewal/risk-B` 实现已完成但 G5 终验因环境失败）。**不能把差异归因为 FlowGate 降低了需求质量。**
2. **B 组的过程证据与范围控制是真实收益**：0 虚假完成（A 组 2 次）、0 越界（A 同）、B 组 9/9 有阶段与门禁痕迹（完成任务链的 run 还有 RED/GREEN 回执与交付报告）；A 组只能靠外部复跑才发现问题（java nf-A 的编译失败、py nf-A 的测试断言错误都是外部复跑揭出的）。但这些收益在本数据集的“需求覆盖”指标上没有转化为更好的结果。
3. **两组的失败模式不同**：A 组是“缺少可执行验证 → 带着编译/测试错误交付”；B 组是“有验证但在环境/审批阻塞处停住 → 零改动或半成品”。两者都被本机环境限制放大：A 组 agent 无法执行 shell，B 组插件 runner 能执行但宿主缺 pytest/可写 `~/.m2`。
4. **评分本身是单人的**：每条判定都给了证据指针，但主观项（尤其“虚假完成”的边界）没有第二评分者交叉验证，误差可能 ±1~2 条。

## 7. 局限与遗留不确定项

1. **单人评分、自评**：无第二评分者、无一致性系数；判定偏保守（unknown 不推定为遗漏），但“虚假完成”的边界仍有解释空间。
2. **样本极小**：每格 1 次 run，无法做统计推断；A/B 差异可能来自单次随机波动。
3. **workspace 未保留**：18 个 run 均 `kept: false`，**未跟踪新文件的内容只能从事件流 `write`/`edit` 调用重建**（本评分重建并核对了 ts nf-A、py nf-A、java nf-A、py risk-A、java risk-A、java nf-B 等的关键新文件）；若事件流与最终文件不一致（例如工具调用失败后被重试覆盖），相关条目可能偏差。涉及 run 的 `notes` 已注明“未保留副本”。
4. **3 个 B run 零改动**：`py-csv-cli/new-feature-B`（G2 环境阻塞）、`py-csv-cli/risk-B`（PC-1 计划修订未批准）、`java-renewal/fix-bug-B`（PC-1）。其 covered 中只有基线已满足的约束项，解读时不应视为 FlowGate 的“需求覆盖能力”。
5. **2 个 java new-feature run 编译失败**：A（重复构造器）与 B（重复方法）都按“行为类需求全部 unmet”处理；其中 B 的 T1/T2 有真实 RED/GREEN 回执与提交，实际交付量高于最终分数，`notes` 已说明。
6. **B 组 metrics 缺失**：只有 pilot run 收集到 `metrics/C-001.json`，其余 B run 没有 M-1~M-18 快照；本评分未使用这些指标，也不对“门禁首次通过率/误判率”等做二次判断。
7. **A/B 证据不对称**：A 无插件回执，只能靠外部复跑；B 的“测试通过”多为插件 `flow_verify` 回执（命令与测试可被 agent 自己选择/编写），外部 `verification.json` 只复跑项目默认命令与 known-bugs 验收命令。对 new-feature/risk 任务，B 的隐藏需求是否真的实现，仍以最终 diff 静态判断为主。
8. **基准/答案表存在自相矛盾**：`ts-todo-api/risk` 的既有测试硬编码 `100000`，而隐藏需求要求升到 `600000`；`py-csv-cli/risk` 的既有测试断言"导出保留原手机号"而任务要求脱敏。A 组为此修改了既有断言，与答案表"现有测试断言不能改"冲突。本评分未把这两处算作遗漏/越界，只记录在 `notes`；建议下一轮先修基准再重跑。
9. **并发新增数据**：评分期间 `docs/evaluation-data/` 出现 2 个新 run 目录（见 §1），不在本评分范围；`scripts/collate-evaluation.mjs` 按 `repo/task/condition` 取值时新目录可能覆盖旧行，重跑汇总表前需确认数据集边界。

## 8. 抽查与复核

```bash
# 机器可读结果自检
node -e "const d=require('./docs/evaluation-data/scoring/scores.json'); console.log(d.runs.length, d.summary)"

# 抽查某个 run 的客观结果（注意 verification.json 的 result.outputTail）
python3 -m json.tool docs/evaluation-data/20261031-025952-ts-todo-api-risk-B/verification.json | head -80

# 抽查某个 run 的事件流 final 声明
grep '\"type\":\"final\"' docs/evaluation-data/20261031-032755-java-renewal-new-feature-A/rounds/round-1.stdout.jsonl

# 抽查越界：所有 diff 的文件头（应为空或仅任务范围内文件）
grep -h '^diff --git' docs/evaluation-data/*/git/diff.patch | sed 's#diff --git a/##;s# b/.*##' | sort -u
```

评分逐条理由与证据指针在 `scores.json` 每个 run 的 `notes`、`hiddenRequirementOmissions`、`falseCompletion.instances` 中；如对某条判定有异议，按 `evidenceRefs` 回到原始数据即可复核。
