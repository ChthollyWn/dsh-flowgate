# FlowGate 执行方案验收缺口审计与修复记录（2026-10-31，第五轮）

> 范围：按 [docs/04-执行方案.md](../04-执行方案.md) 逐任务（T0.1–T6.4）核对**验收标准**的实现情况。
> 与 [todo-audit-2026-10-31.md](todo-audit-2026-10-31.md) 的区别：后者以"全仓 TODO/文档缺口标记 + P0/P1 缺陷"为范围；
> 本报告直接对照 04 的验收条件，发现并修复了此前审计未覆盖的"实现未接线/验收未闭环"缺口。
>
> 基线：本报告开始时的 HEAD `a48c2b9`；修复记录提交：`8963a92`（P0 批次）、`b22dedc`（P1-1）、
> `58e8381`（P1-2）、`84b942e`（P1-3）、`535842b`（P1-4）、`6e3bd24`（runtime 守卫修复）。本轮最终验收数字见 §6。

## 1. 结论

- **M0–M6 的主干功能都在，工程门禁（lint/test/coverage/build/verify）在审计前后均全绿**；
- 但按 04 的验收条件核对，发现 **P0 级 16 项、P1 级约 25 项"实现存在但未接线/门禁未强制/验收条件未满足"的缺口**；
- 本轮已修复全部 P0 与大部分 P1（见 §3/§4）；**剩余未闭环项只有三类**：
  环境受限的真机/真模型验证（§5.1）、需要负责人决策的发布事项（§5.2）、自举决策项（§5.3），
  外加一条文档口径限制（T2.1 样本数量按字面未逐产物准备 10 正/反例）。

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
> 46 项门禁检查逐项正反例（`test/core/artifacts/checks*.test.ts` 134 例）+ 解析边界用例
> （parse/load/yaml 共 100+ 例）。这是"证据形式"差异，不是功能缺口，如需字面满足可单开一轮补 fixture。

## 5. 仍开放事项（不伪造完成）

### 5.1 环境受限验证（13 项，需要真机/真模型/可执行 sandbox）

并行批次真实合并结算与 M-18 加速比；18 组评测在可执行 sandbox 重跑；双人独立评分；B 组 metrics
采集；真实人工负担/响应时间；从 0 开发 C0→C1 完整交付；Desktop 宿主人工走查与 UI 冷启动计时；
真实 guard 拦截→面板→误判反馈端到端；preset persona/工具集运行时差异；真实确认卡产生路径；
Remote 非降级路径；projection epoch 真机重启复验；截图补齐（自动接续/doctor 明细/真实拦截链路）。
另：T3.4 的"5 个预置缺陷检出率"需要真模型审查；PTC/ask_user_question 结构化字段需要真实宿主组合。
逐项阻塞原因/复现命令/验收标准见 [todo-audit §3.1](todo-audit-2026-10-31.md) 与
[implementation-status §4](implementation-status.md)。

### 5.2 发布（负责人决策，此前明确暂缓）

npm publish、GitHub Release、tag `v0.1.0` 前移/版本 bump、awesome-dsh-plugin 收录、V2EX/即刻反馈、
demo 动图、干净机器 10 分钟快速开始验收。物料与 workflow 已就绪；当前 HEAD 的 CI 会在下次推送后重跑。

### 5.3 自举（04 §9，负责人决策项）

仓库根没有 `.flowgate/`，也没有 `flowgate-dogfood` profile；M3 出口的 `v0.5.0` tag、M6/v1.0 的
发布证据都不存在。做或不做需要负责人拍板；不做则把 §9 从 backlog 移除并同步文档。

## 6. 本次修复后的最终验收（本地 HEAD，代码提交 `6e3bd24` + 文档提交）

| 项 | 结果 |
|---|---|
| `pnpm lint` | 通过（分层规则 130 个源文件 + `tsc --noEmit`） |
| `pnpm test` | **107 个测试文件 / 1459 个用例全绿** |
| `pnpm coverage` | thresholds 通过：合计 86.19 / 75.84 / 86.60 / 89.30；core 82.97/68.50/81.51/88.15；host 73.76/65.10/70.00/77.82 |
| `pnpm build` + verify | build 通过；`verify:package` 39 文件 / 1015.9KB；`verify:client` 通过 |
| `verify:compat`（隔离 profile，本机 DSH 0.2.1-rc.5） | **13/13**（含 6 项离线结构检查：host 导出、工具注册、守卫、子 agent、浏览器包、面板声明） |
| `measure:startup` | 中位数 **+15.8ms**（验收线 <200ms） |
| `verify:uninstall` | 安装/卸载干净度通过（rc.5 `plugin remove` 不 prune node_modules 属已知警告） |
| 工具数 | 15 个 `flow_*` + `flow_dispatch_next`（派发模块单独注册）= 16 |
| 仓库状态 | 工作树干净；本轮未推送（CI 需下次推送后刷新） |
