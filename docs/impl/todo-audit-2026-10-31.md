# FlowGate 未完成事项审计（2026-10-31，HEAD `abd9dd2`）

> 范围：项目里**所有仍未完成的事项**（代码/测试/脚本/配置、需求/设计/实现/评测/兼容文档、技能与示例）。
> 排除：**发布/发版事项**（npm publish、GitHub Release、tag 前移/版本 bump、`NODE_AUTH_TOKEN`、release workflow 触发、发布前检查清单、发布后验证等），详见 §5。
> 方法：全仓标记扫描（TODO/FIXME/skip/todo 等）+ 逐文档"未完成/缺口/后续/未验证"抽取 + **对每条做 HEAD 代码核实**（避免把已修复项再报一遍）。
> 本文是审计产物（未提交 git），不是项目承诺；每条都给了证据位置，可逐条复核。
>
> **更新（2026-10-31 第三轮）**：§1 的 **7 项 P0 已全部修复**并附回归测试（全量 93 files / 1322 tests 全绿，lint/build/verify 通过）。实现行为与证据见 [implementation-status.md §3.9](implementation-status.md) 与 `CHANGELOG.md`；下面 §1 保留修复前的原始盘点，仅作对照，不再代表当前状态。P1/P2/P3 仍按本报告清单待处理。

## 0. 结论摘要

- **真正会卡住流程或让产品承诺失效的代码缺口：7 项（P0）**。其中 4 项**不在**项目现有的 `implementation-status.md §4` 已知缺口清单里：检查点失败无恢复路径、计划修订 API 空壳、终审/安全审查无自动生产者、S5 失败不回 S4 生成修复任务。
- **部分完成/低风险缺口/文档承诺与代码不一致：11 项（P1）**。新增：M-5"自动降为提示"未实现、pending `expired` 状态无写入点、CI 未执行覆盖率阈值；`merge.conflict` 账本事件无写入点已在第三轮顺带修复（见 P1-4）。
- **验证/证据缺口：16 项（P2）**，与项目自述的已知缺口基本重合（并行结算、评测重跑、Desktop、真机 UI 闭环等），本次只做去重和精确定位。
- **文档过期/一致性：12 项（P3）**，其中 1 项是"代码已修复但文档仍写待修复"（`status.json` 锁定语义，`host-integration.md:146`）。
- **发布/发版项已按要求全部排除**（§5）；**已闭环、不应再列为待办的 12 项**列在 §6，避免重复盘点。
- 全仓**没有** TODO/FIXME/HACK 类真实待办标记，**没有**跳过/占位的测试（90 个测试文件 / 1289 用例，与文档一致）。

## 1. P0：会卡死流程或让承诺失效的功能缺口（7）

| # | 事项 | 现状与证据（HEAD `abd9dd2`） | 建议下一步 |
|---|---|---|---|
| P0-1 | **`run: main` 任务路由未实现**（T4.6 验收项） | 任务卡已解析 `run` 字段（`src/core/artifacts/parse.ts:1361`），但 `Engine.dispatchNext()`（`src/core/engine.ts:1834`）选任务只看状态，host 一律起子 agent（`src/host/dispatch/index.ts:234`）。全仓唯一 `run` 判断在 `src/core/engine.ts:1616`（inline/subagent 模式领取限制）。规范见 `docs/03-技术方案.md:479`；`skills/flow-orchestrate/SKILL.md:82`「最多处理 `run: main` 的任务」无法兑现 | `dispatchNext`/envelope 增加 `run === 'main'` 路由（返回"由主会话执行"的标记）+ host 侧处理 + 单测 |
| P0-2 | **集成检查点失败不生成修复任务** | 规范承诺"测试失败就生成一个顺序的修复任务"（`docs/03-技术方案.md:486`、`skills/flow-orchestrate/SKILL.md:36`）；实现只 `merge --abort`（`src/host/dispatch/index.ts:456`）→ `completeCheckpoint({ok:false})`（`:470`）→ 建 `kind:'conflict'` 待处理项并保留 worktree（`src/core/engine.ts:2040-2048`），无修复任务 | 接 core 计划修订 API（先修 P0-4），由失败文件集合生成 `FIX-n` 任务；或把 03/skills 改成降级语义并写明人工 SOP |
| P0-3 | **检查点失败后没有可用的恢复路径**（**新发现**） | `completeCheckpoint` 只在 host 内部被调用（`src/host/dispatch/index.ts:470/474/495`），**没有暴露成工具/命令**；`dispatchNext` 遇 `checkpoint` 直接返回"调用 completeCheckpoint"（`src/core/engine.ts:1855-1857`），模型无法调用；`decidePending` 没有 `conflict` 分支（`src/core/engine.ts:2213-2310`，仅 scope/risk/rule/plan/blocker）；`checkBatchProgress` 还会把 `failed` 改回 `checkpoint`（`:2009-2021`） | 提供"重试集成检查点"工具/命令（或让 conflict 批准触发重跑）+ 状态机修正 + 回归测试 |
| P0-4 | **计划修订 API 是空壳（PC-1 批准后执行计划不变）**（**新发现**） | `applyPlanAmendment`（`src/core/engine.ts:2382-2389`）：`add` 完全忽略；`reorder` 只复制 `batches` 数组；结尾 `void item`。批准链路 `src/core/engine.ts:2294`；`test/integration/engine-admin.test.ts:127-134` 只断言 PC id 与批准不抛错，未断言 `T9` 进入执行计划 | 实现任务插入/重排并写回执行计划（含 `tasks` 状态补齐），补断言；P0-2 依赖此 API |
| P0-5 | **G5/G6 终审与安全审查没有自动生产者**（**新发现**，文档只在排障区提示） | host 审查子 agent 只产 `kind:'task'`（`src/host/review/index.ts:206`）；G5/G6 检查要求 `kind:'final'` 与高风险 `kind:'security'`（`src/core/artifacts/checks.ts:1468/1480`）。默认 `review.enabled=true`（`src/core/store/config.ts:62`）→ **开着审查跑 G5 必然"缺少 S5 终审记录"**；唯一规避是 `review.enabled=false`（`checks.ts:1463` 直接放行），等于关掉审查功能。见 `docs/impl/host-integration.md:213` | 增加 S5 终审/安全审查子 agent 或人工记录入口；否则把默认值改为 false 并在文档写明取舍 |
| P0-6 | **`sessions.json` 损坏仍 fail-open，且 `/flow repair` 不可用**（已知缺口 §4 #10，代码核实） | `readLeases` 抛错（`src/core/store/state.ts:337-341`）→ `loadProjectState` reject（`:120`）→ `engine.load` 抛错 → `src/host/runtime.ts:469-483` `markInert` → 守卫 `if (!engine) return next()` 放行（`src/host/guard/index.ts:157-158`）；同时 `/flow repair` 也需要 engine（`src/host/doctor/index.ts:134`），无法自救。注：`status.json` 同类问题已修（`src/core/engine.ts:204/287/299-302`） | 按 §4 #10：租约文件损坏降级为锁定模式 + 故障注入用例；修 `/flow repair` 的 engine 依赖 |
| P0-7 | **S5/G5 验证失败不回 S4 生成修复任务**（**新发现**） | `applyVerificationFailure` 只 import 未调用（`src/core/engine.ts:107`；定义 `src/core/state/transitions.ts:309`）；G5 失败只 `applyGateFailed` 停在 S5（`src/core/engine.ts:975`）。`skills/flow-qa/SKILL.md:35`「S5 失败会生成修复任务回到 S4」无法兑现 | 接上 G5 失败 → 回 S4 + 生成修复任务；或删死代码并同步技能文案 |

## 2. P1：部分完成 / 低风险缺口 / 承诺与代码不一致（11）

| # | 事项 | 现状与证据 | 建议下一步 |
|---|---|---|---|
| P1-1 | **README 承诺"M-5 >5% 的规则自动降为提示"未实现**（**新发现**） | `README.md:236` / `README.en.md:236`；规则判定只有 `allow / deny / human`（`src/core/types.ts:138`、`src/core/rules/evaluate.ts:343-349`），metrics 只计算 M-5（`src/core/metrics/metrics.ts:285-299`），无任何自动降级/提示路径 | 实现 hint 效果或把文档改为"人工复盘时降级" |
| P1-2 | **`max_agents` 是 wave 级排队，非槽位级补位**（已知 §4 #4，部分完成） | core 每次 `dispatchNext` 会按空槽计算容量（`src/core/engine.ts:1865`），但子 agent 结算后**不会自动补派**，需主会话再次调用；host 结算只做检查点/通知（`src/host/dispatch/index.ts:395-414`）；测试已固化该行为（`test/host/dispatch-checkpoint.test.ts:326-327`） | 结算回调自动补下一槽位，或统一文档为"波次级、结算后需再派发" |
| P1-3 | **审批面板入口只覆盖 scope/conflict，plan/rule/blocker 只有命令**（已知 §4 #4，部分完成） | 面板审批按钮只给 `kind` 为 `scope` 或 `conflict` 的待处理项（`src/client/panel/views/Tasks.tsx:104/143-215`）；`src/client/actions.ts:84` 命令兜底；pending 注入通知已实现（`src/host/dispatch/pending.ts:102`） | 面板补齐 plan/rule/blocker 的批准/拒绝入口；真机会话复核 |
| P1-4 | **`merge.conflict` 账本事件没有写入点 → M-18 合并冲突计数恒为 0**（**新发现**；✅ 2026-10-31 第三轮随 P0-2/P0-3 修复） | 第三轮已在 `completeCheckpoint` 的 merge 冲突分支写 `merge.conflict`（`src/core/engine.ts`），新 run 的 M-18 合并冲突次数可统计 | 已修 |
| P1-5 | **pending `expired` 状态从未写入**（**新发现**） | 规范 `docs/03-技术方案.md:519-521`："任务结束仍未处理 → expired"；类型/报告已支持（`src/core/types.ts:717`、`src/core/report/report.ts:687`），但全仓无赋值点 | 归档/结项/任务完成时批量过期未处理项 |
| P1-6 | **`queued` 状态是死分支**（清理项） | `src/core/engine.ts:1863` 读取 `status === 'queued'`，全仓无赋值 | 删除或用于真实排队语义（低优先） |
| P1-7 | **上下文占用提示无数据源（token 用量未接）**（**新发现**，FR-13.5 / 03 §6） | 客户端会读 `snapshot.contextPct`（`src/client/model.ts:434-436`），但 host 从不填充；`dsh-token-meter` 读取路径未实测（`docs/impl/dsh-plugin-api-cheatsheet.md:803`、`docs/spike-report.md:34`） | 接通 token meter（可用时显示），或明确标"未知/不显示"并改文档 |
| P1-8 | **CI 未执行覆盖率阈值；覆盖自检显示数值会波动** | `vitest.config.ts:17` 的 thresholds 只在 `pnpm coverage` 生效，`ci.yml` 只有 `pnpm test`（无 coverage）→ NFR-5（`docs/02-需求规格说明.md:422`）的持续防线缺失；另外"未覆盖工具数"在 4–7 间波动（`docs/impl/implementation-status.md:111`，`src/host/coverage/index.ts:100` 即时重扫） | CI 加 `pnpm coverage`；注册完成后统一采样一次再展示 |
| P1-9 | **两个基准任务的"既有断言 vs 隐藏需求"冲突未修（评测重跑前置）** | `examples/ts-todo-api/test/auth.test.js:36` 断言 `pbkdf2$sha256$100000` vs `examples/ts-todo-api/README.md:106` 要求 600000；`examples/py-csv-cli/tests/test_cli.py:27` 断言保留原手机号 vs `examples/py-csv-cli/README.md:110` 要求脱敏（`docs/evaluation.md:194` 已列为下一步） | 先修基准（改断言或把冲突项移出"不能改既有断言"约束），再重跑风险任务 |
| P1-10 | **`/flow config` 是"未实现"桩且未文档化**（**新发现**，疑似有意） | `src/host/commands/index.ts:186` 抛 `'/flow config 未实现'`，且不在 `FLOW_COMMAND_HELP`（`:37-64`）与 README 命令表里 | 删除该分支（落到"未知子命令"）或正式支持/文档化 |
| P1-11 | **覆盖率残余分支与已确认死代码可清理**（已知 §4 #7，可选） | `docs/impl/implementation-status.md:243/264`：engine 编排/解析器组合分支、报告/指标组合分支未覆盖；`detect/stack.ts`、`shell/classify.ts`、`evidence/parse.ts`、`artifacts/checks.ts`、`rules/evaluate.ts` 有死代码/不可达分支 | 随功能改动补分支；死代码单开清理任务，不阻塞交付 |

## 3. P2：验证/证据缺口（16，需要真机、真模型、特定宿主或人工）

| # | 事项 | 现状与证据 | 建议下一步 |
|---|---|---|---|
| P2-1 | **并行批次真实合并结算未完成，M-18 无加速比**（已知 §4 #3/#4） | 真实并行批次只到"worktree + 子 agent + 回执 + 熔断"，headless 一次性进程在集成检查点前退出（`docs/evaluation.md:302`、`docs/impl/implementation-status.md:204/208`）；顺序派发已完整结算到 S5 | 常驻/交互式宿主完成"结算→合并→集成命令"闭环；顺序/并行各 ≥3 次 |
| P2-2 | **18 组对照评测需在可执行 sandbox 宿主重跑** | 本机 `workspace-write` sandbox 不可用、B 组 8/9 被环境/审批阻塞、3 个零改动（`docs/evaluation.md:184/192/250`）；`--auto-pending` 已扩展但仍不含 scope/risk（`scripts/run-evaluation.mjs:480-500`） | 换可执行 sandbox（PATH 有 pytest、`~/.m2` 可写）整体重跑并重填 §6.2/§6.4 |
| P2-3 | **评测样本小：每格 1 次 + 单人评分，无双人一致性** | `docs/evaluation.md:162/200/254` | 补第二评分者报告一致性，或结论永久标"自评、不可外推" |
| P2-4 | **评测指标采集不全（B 组仅 pilot 有 metrics）** | `docs/evaluation.md:172/195/278`：M-1~M-18 只有 pilot 快照；M-5/M-15/M-17 未量化 | 评测脚本统一收集 metrics 并汇总 token/M-15/M-5 |
| P2-5 | **真实人工负担/响应时间未测** | `docs/evaluation.md:91-92/122/193`：M-13 是门禁次数不是真人响应时间；建议 `--owner manual` | 小样本用 `--owner manual` 或真人会话采一次 |
| P2-6 | **从 0 开发 C0→C1 完整交付未完成** | `docs/evaluation.md:276-277`、`docs/impl/implementation-status.md:247`：已走通到 C0 S4，T6.1"C1 交付"验收未完全满足 | 可执行 sandbox + 交互式会话重跑至 C1 并记 M-16/M-17 |
| P2-7 | **Desktop 宿主未人工走查；UI 冷启动耗时未测**（已知 §4 #9） | `docs/impl/implementation-status.md:245`；`docs/compat/0.2.1-rc.5.md:60-61`；`docs/compat/startup.md:5` | 桌面走查启动/卸载、面板按钮、preset 差异、拦截闭环；UI 冷启动人工计时或永久标"未测" |
| P2-8 | **真实 guard 拦截 → 面板 → 误判反馈端到端未验证（仅组件级）**（已知 §4 #1） | `docs/impl/implementation-status.md:237`、`docs/impl/web-walkthrough.md:195`；`docs/screenshots/24-26` 是组件级证据 | 真模型 + 真实 `R-STAGE-SRC` 拦截的会话再走查 |
| P2-9 | **preset persona/工具集运行时差异未验证**（已知 §4 #2） | `docs/impl/implementation-status.md:238`、`docs/impl/web-walkthrough.md:193`、`cordis.patch.yml:12` | 真模型会话观察 preset 注入效果 |
| P2-10 | **真实确认卡产生路径未验证（本轮为离线构造）** | `docs/impl/web-walkthrough.md:194`、`:103` | 真模型写 S1/S3 产物触发 G3 awaiting 后验 UI |
| P2-11 | **Remote 非降级路径未验证（Typert Remote 已推迟）** | `docs/impl/web-walkthrough.md:196`、`docs/spike-report.md:53` | 明确 Remote 是否进 v1.0；否则文档标"暂缓" |
| P2-12 | **投影 epoch 修复后未做真机重启复验** | 修复已由单测覆盖（`docs/impl/web-walkthrough.md:178`、`src/host/projection/index.ts`），但 UI 证据仍是修复前宿主；§2.4 确认卡"验收场景 —"也未复验（`:103`） | 重跑 Web 走查，验证重启后投影最新 + 确认卡场景显示 |
| P2-13 | **截图待补** | `docs/screenshots/README.md:43`：自动接续、覆盖自检修复后的 doctor 截图本轮采集失败待补（`:44` 的确认卡/误判反馈已于 20–26 补拍，条目部分过期） | 补拍 2 组截图；顺手更新 README 说明 |
| P2-14 | **兼容/加固记录基线落后：HEAD `43d18e5`，未在 `abd9dd2` 复跑** | `docs/compat/0.2.1-rc.5.md:3/59`、`docs/compat/startup.md:1`；headless 真机 E2E 标注"本轮未复跑" | 当前 HEAD 重跑 `verify:compat` + 一次 headless 小 E2E，刷新 HEAD 标注 |
| P2-15 | **MCP 写入经守卫、PTC 守卫覆盖、`ask_user_question` 结构化字段未实测** | `docs/spike-report.md:24/75`、`docs/impl/dsh-plugin-api-cheatsheet.md:793/802`、`docs/04-执行方案.md:564` | 各补一条冒烟；PTC/委派已由强制原生模式堵上，MCP 是主要未知项 |
| P2-16 | **headless 无 `agentPresets` 服务时 preset 行 pending（部署限制）** | `docs/impl/host-integration.md:194-213`、`docs/evaluation.md:96-98`：需 overlay patch 才能解析 preset | 在 compat/安装文档写明要求，或在 profile 配置内置 |

## 4. P3：文档过期/一致性（12，非功能待办，建议一次性清理）

| # | 事项 | 证据 | 建议 |
|---|---|---|---|
| P3-1 | **`status.json` 锁定语义：代码已修复，文档仍写"待修复"** | `docs/impl/host-integration.md:146`「当前 HEAD：坏文件会被加载器跳过…待修复」；实际已修：`src/core/engine.ts:204/287/299-302`、`docs/impl/implementation-status.md:224`、`CHANGELOG.md:43`。`docs/compat/0.2.1-rc.5.md:43-45` 同段过期 | 更新两处文档并标注修复轮次 |
| P3-2 | **`evaluation.md` 口径滞后** | `:36`「基础设施已就绪，结果未执行」、`:38`「尚未调用过真模型」、`:95`「B 组自动批准路径尚未验证」、`:96-98` 编号 7/6/7 重复、`:152`「未跑任务显示待跑」均已过期；`:306`「结论模板（跑完后写）」未填 | 把 §5 标为历史准备记录、修编号、补 §7 结论（或删模板） |
| P3-3 | **README 状态说法过期** | `README.md:15`「v0.1 开发中」、`:63/279`「M6 之前不要在日用 profile 安装」；M6 主体已完成，仅未发布 | 改为"v0.1 功能完成、未发布"并删过期 M6 前置 |
| P3-4 | **`implementation-status.md` 内部数字三套口径** | `:23` 89 files/1285 tests vs `:33` 90/1289；`:221` core 90.02/80.01 vs `:33` 90.34/80.16；`:221` host 74.01/60.74/72.81 vs `:243` 74.14/61.01/72.80 | 统一为最终 coverage-final 结果（90.34/80.16/90.77、host 74.14/61.01/72.80）与 90/1289 |
| P3-5 | **CHANGELOG 的 Known gaps 过期** | `CHANGELOG.md:133`「以下为截至 HEAD `e1aef8d` 的摘要」；`:135-140` 多项已被后续轮次关闭；Unreleased 无"当前已知缺口"段 | 给旧段加"已关闭"标注，Unreleased 直接引用 `implementation-status.md §4` |
| P3-6 | **`interview-notes.md` 数字过期** | `:19` 11 张截图/+14.2ms、`:34` 67 files/976 tests、`:36` 故障注入 4/4、`:37` 39 文件/848.7KB、`:42` pilot 1/9 — 实际为 25 张截图、90/1289、7/7、888.4KB、18/18+评分 | 整段刷新（面试材料尤其不能与事实不符） |
| P3-7 | **`screenshots/README.md` 待补说明部分过期** | `:43` 自动接续/doctor 仍待补；`:44` 确认卡/误判反馈已由 20–26 补拍，仅拦截链路仍是组件级 | 更新说明并区分"已补/仍待补" |
| P3-8 | **compat 文档矩阵与截图数不一致** | `docs/compat/0.2.1-rc.5.md:36`「headless ⏳」vs `:86`「headless ✅」；`:60` 提到 11 张截图（当前 25 张） | 统一矩阵口径（区分"离线组合 ✅ / 真机 E2E ⏳"） |
| P3-9 | **00–04 设计快照无"历史"横幅；spike/cheatsheet 部分结论被推翻** | `docs/00-总览与阅读指南.md:5` 仍写"M0 前待确认"；`docs/03-技术方案.md:3`「尚未写代码验证」；`docs/spike-report.md:73`、`docs/impl/dsh-plugin-api-cheatsheet.md:748` 仍写"浏览器内真实加载未验证"（已被 Web 走查覆盖） | 加"历史方案快照，现状见 implementation-status/release"横幅；更新已被推翻的结论 |
| P3-10 | **`implementation-status.md §3.2` 历史"本轮未完成"未标闭环** | `:88-92`（restrict/presentAs、agent 生命周期标志）已在 `:102-103` 修成 ✓；`:190` 等历史段同类 | 给历史轮次加"后续状态"或折叠 |
| P3-11 | **定期任务：方法来源表季度复查未到期** | `docs/method-sources.md:5/82`：下一轮复查 2027-01，复查清单未勾选（`:68-76`） | 日历提醒即可，不是当前待办 |
| P3-12 | **自举（用 FlowGate 管自身仓库开发）未开始（计划项）** | `docs/impl/implementation-status.md:263`、`docs/04-执行方案.md:502-505`；仓库根无 `.flowgate/`（`git ls-files` 0 条） | 负责人决定做/不做；不做则从"下一步"移除，避免与未完成混淆 |

## 5. 按要求排除：发布/发版事项（不列入待办）

- npm 首发/registry 状态、GitHub Release、tag `v0.1.0` 前移或版本 bump（`CHANGELOG.md:5/141`、`docs/release/v0.1.0.md:3-10/122`）。
- `NODE_AUTH_TOKEN`/CI secrets、`.github/workflows/release.yml` 未触发、tag 推送发布流程（`docs/release/v0.1.0.md:131-150`）。
- "发布前检查清单"全部 10 项、发布后验证、失败恢复（`docs/release/v0.1.0.md:131-149`）。
- package.json `repository/homepage/bugs` 元数据、CHANGELOG 是否进 npm 包（`docs/release/v0.1.0.md` 可选元数据项）。
- awesome-dsh-plugin 收录、README 演示动图等推广物料（`docs/impl/implementation-status.md:261`）。
- CI"待推送后重跑"等发布证据刷新（`docs/release/v0.1.0.md:85`）。

## 6. 已核实、不应再列为待办的（避免重复盘点）

1. **`status.json` 损坏 fail-open**：已修（锁定模式 + `/flow doctor` 路径 + `/flow repair` 拒绝静默重建，`src/core/engine.ts:204/287/299-302`、14 例回归）。
2. **覆盖率 thresholds**：已补并通过（core 90.34/80.16/90.77；host 74.14/61.01/72.80；`vitest.config.ts`）。
3. **`restrict`/`presentAs`/agent 生命周期能力标志**：已由 `docs/impl/implementation-status.md:102-103` 修复并真机验证。
4. **T-FAILURE-LIMIT 熔断可恢复**：`/flow unblock` 已实现（见 CHANGELOG、命令表）。
5. **投影 revision 回退**：已用进程 epoch 修复并有 6 例单测（真机复验见 P2-12）。
6. **归档主规格 ADDED/MODIFIED/REMOVED 合并**：已闭环（`docs/impl/implementation-status.md:242`）。
7. **评测脚本自动 owner 已扩展**：`scripts/run-evaluation.mjs:480-500` 已支持 blocker/plan/rule；`docs/evaluation.md:193` 的"不处理 PC/BL/RL"已过期（归 P3-2）。
8. **无跳过/占位测试**：全仓 `.skip/.todo/.only` 命中 0；代码/技能/脚本 TODO 标记命中 0（唯一 `test/client/stage-card.test.tsx:88` 是反向断言）。
9. **examples 的 `known-bugs.mjs`、`legacy-summary.js`、py `known_bugs.py`**：评测基准的故意诱饵/已知缺陷 fixture，不是待办。
10. **`spike/` 的"占位"**：预研设计说明（`spike/README.md` 声明非产品源码），不是待办。
11. **`method-sources.md` 季度复查**：未到期（2027-01，归 P3-11）。
12. **发布/发版项**：按任务要求排除（§5）。

## 7. 建议处理顺序（与发布解耦）

1. **先修 P0**（预计代码改动集中、可测试）：P0-4 计划修订 → P0-2/P0-3 检查点修复任务与恢复路径 → P0-1 run:main 路由 → P0-5 终审生产者 → P0-7 S5 回退 → P0-6 租约锁定。
2. **再修 P1 前置**：P1-9 基准矛盾、P1-8 CI coverage、P1-4/P1-5 账本与 expired。
3. **集中一轮真机验证**（一个交互式/常驻宿主会话可覆盖大半）：P2-1/2/3/4/6/7/8/9/10/12/14/15。
4. **文档一次性清理**：P3-1..P3-10（同一批 PR）；P3-11/P3-12 由负责人决策。
5. 可选：P1-11 覆盖率补缺与死代码清理。

## 8. 审计方法与复现

```bash
# 1) 全仓待办标记（0 个真实命中）
git grep -nIE 'TODO|FIXME|HACK|XXX|@todo|TBD' -- ':!node_modules' ':!lib' ':!coverage' ':!docs/evaluation-data'
git grep -nIE '\.skip\(|\.todo\(|\.only\(|it\.todo' -- test src

# 2) 文档未完成/缺口抽取
git grep -nE '未完成|未实现|未验证|未覆盖|未复验|已知缺口|规划中|后续|下一步|待补|待重跑|暂不' -- docs README.md CHANGELOG.md ':!docs/evaluation-data' ':!docs/reference'

# 3) 关键代码核实点
sed -n '1834,1900p' src/core/engine.ts            # dispatchNext 是否看 run
sed -n '2382,2389p' src/core/engine.ts            # applyPlanAmendment 空壳
sed -n '1459,1495p' src/core/artifacts/checks.ts  # G5 终审要求 final/security
sed -n '2030,2055p' src/core/engine.ts            # 检查点失败只建 conflict pending
sed -n '337,341p'    src/core/store/state.ts      # 租约损坏抛错
sed -n '469,490p'    src/host/runtime.ts          # 引擎加载失败 markInert
sed -n '150,170p'    src/host/guard/index.ts      # engine 缺失时放行（fail-open）
```

> 本报告由 Lead 汇总 3 个只读审计子任务（代码/测试/脚本、实现与评测文档、需求与设计文档）并按 HEAD `abd9dd2` 逐条复核；命中行号随代码演进可能漂移，以符号/文件为准。
