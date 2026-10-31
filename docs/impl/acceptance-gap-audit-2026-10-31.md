# FlowGate 执行方案验收缺口审计与修复记录（第五轮记录 + 第六轮复验修正）

> 范围：按 [docs/04-执行方案.md](../04-执行方案.md) 逐任务（T0.1–T6.4）核对**验收标准**的实现情况。
> 与 [todo-audit-2026-10-31.md](todo-audit-2026-10-31.md) 的区别：后者以"全仓 TODO/文档缺口标记 + P0/P1 缺陷"为范围；
> 本报告直接对照 04 的验收条件，发现并修复了此前审计未覆盖的"实现未接线/验收未闭环"缺口。
>
> 基线：本报告开始时的 HEAD `a48c2b9`；第五轮修复记录提交：`8963a92`（P0 批次）、`b22dedc`（P1-1）、
> `58e8381`（P1-2）、`84b942e`（P1-3）、`535842b`（P1-4）、`6e3bd24`（runtime 守卫修复）。第五轮最终验收数字见 §6。
>
> **第六轮复验修正（2026-10-31 晚）**：独立只读复验推翻了本报告 §1"剩余未闭环只有三类 / 功能缺口全部闭环"的结论，
> 又发现 **7 项 P1 接线缺口**（已在第六轮代码提交 `cea85dd` 修复并补回归测试）与一批 P2/证据口径问题；
> 第六轮记录见 §7。**§1–§6 保留第五轮原文以便追溯，当前仍开放项以 §7.3 为准。**

## 1. 结论

- **M0–M6 的主干功能都在，工程门禁（lint/test/coverage/build/verify）在审计前后均全绿**；
- 但按 04 的验收条件核对，发现 **P0 级 16 项、P1 级约 25 项"实现存在但未接线/门禁未强制/验收条件未满足"的缺口**；第五轮已修复全部 P0 与 P1 代码/测试类项（逐项见 §3/§4）。
- **⚠️ 第六轮独立复验修正**：第五轮"已修复全部 P0/P1、剩余未闭环项只有三类、功能缺口全部闭环"的结论**不成立**——独立只读复验仍发现 **7 项 P1 接线缺口**（并行 worktree 执行根、派发双结算、S5 全量测试回归判定、压缩重注入、跨会话任务卡注入、澄清占位符、低复杂度任务数上限；均已补回归测试并在 `cea85dd` 修复，见 §7.1）与一批 P2/证据口径问题；剩余项按四类重分类（§7.3）。
- 本报告 §2–§6 保留第五轮记录（时点结论，便于追溯）；**当前状态以 [implementation-status §4](implementation-status.md) 与 §7 为准**。

## 2. 审计方法

1. 用 5 个只读子审计按里程碑逐条核对 04 的"做什么/验收"（M0–M1、M2、M3、M4、M5+§9+M6/§11），
   每条要求给出代码文件:行号或测试名；Lead 对关键发现逐条复核（grep/读代码/跑单测）。
2. 只信代码与测试，不采信既有文档的"✅ 完成"表述；对"有类型/有配置/有函数但无调用点"的状态按未实现处理。
3. 修复后每批补回归测试并跑全量门禁；环境受限项不伪造通过，逐项记录阻塞原因与所需环境（§5.1）。

## 3. P0 缺口与修复（全部已闭环）

| # | 缺口（验收项） | 修复 | 证据 |
|---|---|---|---|
| P0-1 | 契约冻结只存哈希、判定始终用当前 config（T1.3 #3） | `contract.snapshot` 冻结 rules/triggers/levels/limits，`configFor(change)` 回放；旧状态无快照回退 | `src/core/store/freeze.ts`、`src/core/engine.ts`、`test/integration/engine-freeze.test.ts` |
| P0-2 | 人工门后产物未冻结（T2.1/T2.5/T3.1） | `change.frozen` 在门通过时写入；守卫 R-FROZEN-ARTIFACT；G3 frozenArtifacts 复核 | `engine.ts`（approveGate/evaluateAction）、`test/integration/engine-freeze.test.ts` |
| P0-3 | 撤销后越界不自动解除（T1.4 #2） | postcheck 传 cleanedPaths → `clearViolationsForReverted`；账本 `violation.cleared(reason=reverted)` | `src/host/postcheck/index.ts`、`engine.ts`、`test/host/postcheck.test.ts` |
| P0-4 | 非 agent 改动不可见（T1.4 #3） | 进入 snapshot/面板；`/flow external confirm`；G6 未确认即失败 | `engine.ts`、`src/client/panel/views/Gates.tsx`、`test/integration/engine-audit.test.ts` |
| P0-5 | 工程模式 preset 只有 persona（T1.7） | 补文件工具集/搜索/技能；persona 加计划模式引导；执行者补 shell；只读取证保持只读 | `cordis.patch.yml`、`test/host/preset-composition.test.ts` |
| P0-6 | 阶段核心技能回执缺失（T2.4） | 宿主 skill 工具后记录回执；G1 flow-clarify / G3 flow-plan 缺回执直接失败；注入提示先加载 | `src/host/evidence/index.ts`、`engine.ts`、`src/core/artifacts/checks.ts` |
| P0-7 | 路线图状态不回写、fromRoadmap 只继承标题（T2.7） | 进行中/暂停/已交付回写 roadmap.md；proposal/clarify 继承目标与验收要点 | `engine.ts`、`test/integration/real-gates.test.ts` |
| P0-8 | G3 批准卡无执行图；execution-plan 只写一次（T2.9） | G3 等待批准时物化 tasks/batches；execution-plan.md 随状态重生成 | `engine.ts`、`test/integration/real-gates.test.ts` |
| P0-9 | evidence.md / review.md 无写入点（T3.2/T3.4） | 插件维护两个文档；证据回执变化时刷新 | `engine.ts`、`test/integration/engine-audit.test.ts` |
| P0-10 | 篡改检测整体缺失（T3.5） | 新增 `core/tamper`（跳过测试/删断言/改测试基础设施）；post-execute 扫描 → TM-n、审查输入、G6 阻断 | `src/core/tamper/index.ts`、`src/host/review/index.ts`、`test/core/tamper/**` |
| P0-11 | 接管后旧会话写入不被拒；接续无快照对比（T3.7） | R-LEASE（节流读 sessions.json）；接续对比上次工作区快照；状态条「已接续」 | `engine.ts`、`test/integration/engine-session-audit.test.ts` |
| P0-12 | 面板 GREEN 过期只按"组内最新"（T3.6） | 回执新鲜度按输入哈希计算；面板用 engine 缓存 | `engine.ts`、`src/host/projection/panel.ts` |
| P0-13 | run/health 无执行器；G5 运行证据缺回执也 pass（T4.2 #2） | 宿主启动服务、轮询 health、采集日志并杀进程组；G5 配置 run 时必须运行回执/手工证据 | `src/host/verify/run.ts`、`src/host/tools/definitions.ts`、`src/core/artifacts/checks.ts` |
| P0-14 | 风险提高效应未接线、3 类触发器缺失、shell 拦截未脱敏（T4.1） | `applyRiskRaised`（清审查/退 S4/RK）；范围膨胀、删除受控文件提风险；token 预算触发器；`rule.denied` 脱敏 | `engine.ts`、`src/core/rules/**`、`test/integration/engine-audit.test.ts` |
| P0-15 | 例外闭环不可用（T5.1 #1） | `/flow exception add|revoke|list`、snapshot exceptions、Intercepts 视图撤销、actions 映射 | `src/host/commands/index.ts`、`engine.ts`、`Gates.tsx/Intercepts.tsx`、`test/client/panel.test.tsx` |
| P0-16 | 看板不自动更新、report/board 不打开（T5.3 #2） | 每次状态变化重生成 dashboard.html；report/board 调用系统打开（失败退回路径） | `engine.ts`、`src/host/open.ts`、`src/host/commands/index.ts` |

## 4. P1 缺口与修复（代码/测试类均已闭环）

| # | 缺口（验收项） | 修复 |
|---|---|---|
| P1-1 | 澄清问答不落账、轮数上限是死配置、"改变什么"未检查（T2.2） | 宿主采集 ask_user_question → clarify.md + 账本；G1 新增轮数/改变说明检查 |
| P1-2 | 基线不按提交复用；等级建议恒 paths:[]；test:none 风险未自动登记（T2.3） | `state/baseline.json` 按 commit 复用；需求路径/模块信号；自动登记 RK |
| P1-3 | 低复杂度高风险确认卡缺风险项/回滚/逐项确认；提高复杂度不回 S1（T2.8） | 卡片展示风险+回滚、`--confirm-risks` 强制确认；提高复杂度回 S1 重置 G1–G3 |
| P1-4 | 引用核验哈希丢弃、stale 无消费者（T2.10） | G1/G2 落 citationChecks；G2/G3/G5 `g2.citationsFresh` 标待复核 |
| P1-5 | 删除/重命名无原内容快照（T3.1） | taskStart 从 git HEAD 保存原文（失败阻塞）；审查提示词带原内容 |
| P1-6 | 审查覆盖只按文件名、去重指纹不消费、critical 不阻塞、无豁免入口（T3.4） | 行级覆盖（read offset/limit vs diff 改动行）；同 diff 复用；critical/major 独立阻塞；`/flow review waive` |
| P1-7 | 返工失效未接线（T3.8） | `flow_declare_rework` + `/flow rework`；defect 沿依赖失效，requirement 全失效+回 S1+解冻 |
| P1-8 | 终审只有一份结论复制冒充 final+security（T4.3） | 高风险依次产出规格符合/代码质量/安全三份独立结论 |
| P1-9 | retro.md 无写入点；规则文件名 RL-RL；规则不加载（T4.5） | retro.md 追加；RL-n.md/.json；loadProjectRules 并入新变更契约 |
| P1-10 | 执行者 prompt 缺覆盖场景；run_reason 不校验（T4.6） | prompt 渲染覆盖场景+run_reason；G3 检查 subagent 必须写理由；未决问题要求 ask_user_question |
| P1-11 | 交接摘要只在 pause/手工生成；新会话不注入任务卡（T4.8） | 过门/任务完成生成；会话第一步注入当前任务卡 |
| P1-12 | 检查点不跑任务验证/全量测试；降级无标注（T4.9） | `runCheckpointVerification`；`BatchState.downgraded` |
| P1-13 | 调查无并发上限/耗时；relatedTo 不继承（T4.10） | 默认 2 并发、记录耗时（token 标未知）；相关分析结论进 clarify |
| P1-14 | 规则统计/试跑默认空（T5.1） | 面板投影改为实际生效规则（内置+项目规则） |
| P1-15 | 故障注入缺浏览器包缺失；compat 未覆盖 6 类（T6.2） | 浏览器包缺失用例；compat 增加 6 项离线结构检查（13/13） |
| P1-16 | `review.model`、注入预算等死配置（T4.1/NFR-8） | 审查子 agent agentOptions.model；注入 ≤600/1000 token 截断 |
| P1-17 | 空仓库不自动进项目级澄清（T2.7） | `/flow new` 检测空仓库 → PROJECT 路线图 |
| P1-18 | 同轮第 3 次完成拦截静默放行未记账（T3.3） | `turn.continued(suppressed=true)` 记账 |

> 说明：T2.1 的"每种产物各 10 个正例和反例"未按字面逐产物准备 10×样本；现有覆盖为
> 52 项门禁检查逐项正反例（`test/core/artifacts/checks*.test.ts` 134 例）+ 解析边界用例
> （parse/load/yaml 共 100+ 例）。这是"证据形式"差异，不是功能缺口，如需字面满足可单开一轮补 fixture。

## 5. 仍开放事项（不伪造完成）

> 第六轮复验后的四分类见 §7.3；本节"13 项"是第五轮时点计数，其中 projection epoch/截图已重分类为**可离线补做**、Remote 非降级为**v0.1 决策不做**。

### 5.1 环境受限验证（第五轮时点：13 项；第六轮重分类见 §7.3）

并行批次真实合并结算与 M-18 加速比；18 组评测在可执行 sandbox 重跑；双人独立评分；B 组 metrics
采集；真实人工负担/响应时间；从 0 开发 C0→C1 完整交付（另受 C0 骨架首任务 TDD 死锁影响，见 §7.3）；
Desktop 宿主人工走查与 UI 冷启动计时；真实 guard 拦截→面板→误判反馈端到端；preset persona/工具集运行时差异；
真实确认卡产生路径；headless 真模型 E2E 在当前 HEAD 复跑（P2-14 口径修正）；T5.2 学习模式 10 次抽查
（需真实模型会话；实现只注入提示、无强制）。
**已重分类**：projection epoch 真机重启复验、自动接续/doctor 扩展明细截图 → **可离线补做**（Playwright+Chrome 可用、无需真模型）；
Remote 非降级路径 → **v0.1 决策不做**（Typert Remote 需构建期生成器，v0.1 走命令兜底）。
另：T3.4 的"5 个预置缺陷检出率"需要真模型审查；PTC/ask_user_question 结构化字段需要真实宿主组合。
逐项阻塞原因/复现命令/验收标准见 [todo-audit §3.1](todo-audit-2026-10-31.md) 与
[implementation-status §4](implementation-status.md)（第六轮已按四类重写）。

### 5.2 发布（负责人决策，此前明确暂缓）

npm publish、GitHub Release、tag `v0.1.0` 前移/版本 bump、awesome-dsh-plugin 收录、V2EX/即刻反馈、
demo 动图、干净机器 10 分钟快速开始验收。物料与 workflow 已就绪；CI 最后绿灯是 `b671ef9`（run [41190320744](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41190320744) 覆盖 `60a82dc` 的 lint/test/coverage/build/verify），**第六轮提交尚未推送，CI 待推送后重跑**；发布只差负责人决定 tag/版本方案（远程 tag `v0.1.0` 已指向 `f53d5f1`，前移需 force-move 或 bump 新版本，见 [release notes §8](../release/v0.1.0.md)）。

### 5.3 自举（04 §9，负责人决策项）

仓库根没有 `.flowgate/`，也没有 `flowgate-dogfood` profile；M3 出口的 `v0.5.0` tag、M6/v1.0 的
发布证据都不存在。做或不做需要负责人拍板；不做则把 §9 从 backlog 移除并同步文档。

## 6. 第五轮修复后的最终验收（历史记录，代码提交 `6e3bd24` + 文档提交）

| 项 | 结果 |
|---|---|
| `pnpm lint` | 通过（分层规则 130 个源文件 + `tsc --noEmit`） |
| `pnpm test` | **107 个测试文件 / 1459 个用例全绿** |
| `pnpm coverage` | thresholds 通过：合计 86.19 / 75.84 / 86.60 / 89.29；core 82.97/68.50/81.51/88.15；host 73.76/65.10/70.00/77.82 |
| `pnpm build` + verify | build 通过；`verify:package` 39 文件 / 1015.9KB；`verify:client` 通过 |
| `verify:compat`（隔离 profile，本机 DSH 0.2.1-rc.5） | **13/13**（含 6 项离线结构检查：host 导出、工具注册、守卫、子 agent、浏览器包、面板声明） |
| `measure:startup` | 中位数 **+15.8ms**（验收线 <200ms） |
| `verify:uninstall` | 安装/卸载干净度通过（rc.5 `plugin remove` 不 prune node_modules 属已知警告） |
| 工具数 | 15 个 `flow_*` + `flow_dispatch_next`（派发模块单独注册）= 16 |
| 仓库状态 | 工作树干净；已推送 `60a82dc`，GitHub Actions CI run [41190320744](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41190320744) **success**（lint/test/coverage/build/verify） |

> **第六轮本地门禁（2026-10-31，代码提交 `cea85dd` + 本轮文档）**：`pnpm test` **112 files / 1522 tests** 全绿；lint/typecheck 通过（130 源文件）；
> `pnpm coverage` thresholds 通过（合计 86.40 / 76.25 / 86.92 / 89.46）；build host 1,210,648 B（≈1.21MB）/ client 223,830 B（≈219KB）；
> `verify:package` 39 文件 / 1032.8KB（docs 修改后重跑实测，含 README）；`verify:client` 通过；`verify:compat` 13/13（隔离 `DSH_HOME=/tmp/fg-audit-env`，dump-config 1314 行）；
> `measure:startup` +16.2ms；`verify:uninstall` 通过。**CI 待推送后重跑**（最后绿灯 `b671ef9`）。

## 7. 第六轮：独立复验与接线修复（2026-10-31）

> 第五轮后，独立只读复验按 04 验收条件逐条重查，推翻"功能缺口全部闭环"的结论：又发现 7 项 P1 接线缺口与一批 P2/证据口径问题。
> 第六轮按"接线/回归"修复（不新增功能面），代码修复提交 `cea85dd`，每项补回归测试；测试规模 **112 files / 1522 tests** 全绿（第五轮 107/1459，+5 文件 / +63 用例）。

### 7.1 新发现并修复的 P1 接线缺口（7 项）

| # | 缺口（验收项） | 修复 | 证据 |
|---|---|---|---|
| 1 | T4.9 并行 worktree 未作为验证执行根 | `flow_verify`、输入哈希、自动提交改用任务 worktree 为执行根（`taskExecutionRoot`） | `src/core/evidence/run.ts`、`src/core/engine.ts`、`test/integration/engine-cleanup.test.ts` |
| 2 | 派发双结算：成功任务被迟到失败覆盖 | `engine.taskFailed` 对 `done` 早退；host dispatch finalize 先查状态 | `src/core/engine.ts`、`src/host/dispatch/index.ts`、`test/host/dispatch.test.ts` |
| 3 | T4.2 S5 全量测试无回归判定数据源 | S5 全量测试改走 `runFullSuite`，`regressions` 写入回执，G5 可判回归、M-12 有数据源 | `src/core/engine.ts`（`ensureFullSuite`）、`test/integration/engine-cleanup.test.ts` |
| 4 | T4.8 上下文压缩后丢失交接/任务上下文 | 交接摘要进每步注入 `buildInjection`；`agent/created source='compact'` 防御式重注入（rc.5 实测该事件不可达，已注明） | `src/core/engine.ts`、`src/host/session/index.ts`、`test/host/session.test.ts` |
| 5 | T3.7/T4.8 跨会话未注入中断任务卡 | `releaseSession` 生成 handoff；新会话注入 running/review → 最近 interrupted 任务卡；状态条 S4 显示「任务 RED/GREEN」 | `src/host/session/index.ts`、`src/core/engine.ts`、`test/host/session.test.ts` |
| 6 | T2.2 澄清「改变说明」占位符可过 G1 | 占位符（`（待补充）`/`（未记录）`）不再通过 G1；`recordClarifyQA` 回写 `clarifyRounds`（M-7 数据源） | `src/core/artifacts/checks.ts`、`src/core/engine.ts`、`test/core/artifacts/checks-cleanup.test.ts` |
| 7 | T2.8 低复杂度快车道任务数未收紧 | 低复杂度 G3 任务数上限=1（其它等级仍用配置/默认 12） | `src/core/artifacts/checks.ts`、`test/core/artifacts/checks-cleanup.test.ts` |

### 7.2 P2 / 证据与口径修正（8 项）

| # | 项 | 修复 | 证据 |
|---|---|---|---|
| 8 | T2.3 `test: none` 基线未真实取证 | G2 前真实运行 build/lint/typecheck 基线并落回执，无通过回执 G2 失败 | `src/core/artifacts/checks.ts`、`test/integration/engine-cleanup.test.ts` |
| 9 | M-16 路线图进度无数据源 | `roadmap.approved` / `roadmap.progress` 写 `total` / `delivered` | `src/core/metrics/metrics.ts`、`src/core/types.ts` |
| 10 | T5.1 执行图不可交互、任务详情缺失 | 执行图节点可点击/键盘选择 + 任务详情；snapshot 新增可选 `taskCards` | `src/client/panel/ExecutionGraph.tsx`、`src/client/panel/views/Tasks.tsx`、`src/client/model.ts`、`test/client/task-detail.test.tsx` |
| 11 | 规则试跑与真实判定口径不符 | 客户端本地近似（尊重 off/locked/实际规则 decision/生效例外），标注「本地近似试跑，精确判定以宿主为准」，列出本地无法判定的项目自定义规则 | `src/client/model.ts`、`src/client/panel/views/Intercepts.tsx`、`test/client/rule-trial-ui.test.tsx` |
| 12 | T2.4 技能重复加载每次注入全文 | `duplicate` 时输出替换为「本会话已加载，不重复注入」短提示（派发子 agent 保留全文） | `src/host/evidence/index.ts`、`test/host/evidence.test.ts` |
| 13 | 任务门审查提示引用不存在的工具 | taskDone 提示去掉 `flow_request_review`，改为插件自动触发/负责人 `/flow review waive` | `src/core/engine.ts` |
| 14 | 技能文案与实现不一致 | dispatch auto 未按 size 路由（如实）、低复杂度 1 张卡、澄清占位符、`test:none` 基线 | `skills/flow-plan|flow-orchestrate|flow-clarify|flow-context/SKILL.md` |
| 15 | 文档/物料过期或事实错误 | 46→52 项、M-6=42.9% 补来源、真实故事拆两条、README.en 状态、compat/startup 头注、evaluation §194、compat"无网络"、CI 状态、todo-audit 89.29、release.yml coverage、package.json repository/homepage/bugs、tag 推送说明、截图可离线补做、vitest 注释、构建体积 | `README*.md`、`docs/**`、`package.json`、`.github/workflows/release.yml`、`vitest.config.ts` |

### 7.3 仍开放事项（第六轮后，四分类）

1. **环境/人工受限（不伪造通过）**：18 组评测可执行 sandbox 重跑、双人独立评分、B 组 metrics、真实人工负担、从 0 到 C1 交付、并行合并结算/M-18、真实 guard 拦截→面板端到端、preset 运行时、真实确认卡、5 个预置缺陷检出率、PTC/ask_user_question 结构化字段、Desktop 走查与 UI 冷启动、**headless 真模型 E2E 未在当前 HEAD 复跑（P2-14 口径修正）**、**T5.2 学习模式抽查未做**。
2. **可离线补做（非环境受限）**：projection epoch 重启真机复验、自动接续/doctor 扩展明细截图（Playwright+Chrome 可用，无需模型）。
3. **需负责人决策**：发布（tag force-move vs bump `0.1.1` + `NODE_AUTH_TOKEN` + demo 动图 + 干净机器 10 分钟验收）、自举 §9、T2.1"每产物 10 正/反例"字面口径。
4. **后续 P2 / 产品决策**：C0 骨架首任务 TDD 死锁（`package.json` 在 RED 前不可写；需决定 C0 豁免 TDD 或标准 allow-once SOP）、`run: auto` 按 size 路由未实现（skills 已如实说明）、Remote 非降级 v0.1 决策不做、上下文阈值/M-17 数据源、dispatch 摘要落账、worktree 归因、T4.4 PR/CHANGELOG 生成引导。

### 7.4 第六轮门禁数字（本地，CI 待推送后重跑）

- `pnpm lint` + `typecheck` 通过（130 源文件）；`pnpm test` **112 files / 1522 tests** 全绿（+63 用例）。
- `pnpm coverage` thresholds 通过：合计 **86.40 / 76.25 / 86.92 / 89.46**；core 83.42 / 69.26 / 82.59 / 88.48；host 74.09 / 65.71 / 70.00 / 78.20。
- build：`lib/host.js` 1,210,648 B（≈1.21MB）/ `lib/client.js` 223,830 B（≈219KB）；`verify:package` **39 文件 / 1032.8KB**（docs 修改后重跑实测）；`verify:client` 通过。
- `verify:compat` **13/13**（隔离 `DSH_HOME=/tmp/fg-audit-env`，新构建，dump-config 1314 行）；`measure:startup` **+16.2ms**（基线 16.5 / 加载 32.6）；`verify:uninstall` 通过（rc.5 `plugin remove` 不 prune node_modules 已知警告）。
- CI：**未推送本轮提交，最后绿灯 `b671ef9`；第六轮本地全绿，CI 待推送后重跑。**
