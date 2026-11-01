# 更新日志

FlowGate（npm 包名 `dsh-flowgate`）的重要变更记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **发布状态（2026-10-31）**：npm 已发布 [dsh-flowgate@0.1.0](https://www.npmjs.com/package/dsh-flowgate)；仓库 tag `v0.1.0` 已前移到本次发布提交（发布说明见 [docs/release/v0.1.0.md](docs/release/v0.1.0.md)）。
> 第六轮（独立复验后的接线修复，代码提交 `cea85dd`、文档提交 `25fffac`）已推送 `main`，CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) **success**。
> 发布物料与发布前检查清单见 [docs/release/v0.1.0.md](docs/release/v0.1.0.md)；本次发布信息已按实际日期（2026-10-31）回填。首版为本地 `npm publish`（无 provenance）；**GitHub Release 待补建**（命令见发布说明文末）。

## [Unreleased]（v0.7：修复通道智能准入，2026-11-01）

> 负责人追问："修复是走单独一条通道吗？为什么不是智能识别自动推导？"——修复车道保持为一等公民，
> 但把"该不该走、scope/verify 填什么"升级为**信号推导 + 确定性复核**；语义判断仍由 agent 负责并留可审计声明。

### Added

- **修复通道智能准入（v0.7）**：新增 `src/core/flow/repair-admission.ts`（纯函数规则）与 `FlowEngine.previewRepair()`。
  - 信号推导：最近失败/非零退出回执 → verify 候选与命令里的路径 token；`git status --untracked-files=all` 未提交改动 →
    scope 候选与脏工作区检查；项目 `commands.test` → verify 候选；缺省补全 title（symptom 首句）与两条通用 acceptance。
  - 确定性复核（硬拒）：已有进行中的变更（推荐 `flow_declare_rework`）、已有修复/锁定/未启用、scope 空/>20 条/整棵顶层目录
    （推荐 `flow_new_change`）、scope 命中敏感面（auth/支付/迁移/密钥/CI 等内置触发器）、预存未提交改动不在 scope 内、
    verify 无法推导或形状非法；scope 里的受保护路径（`.flowgate`/`.git`）自动剔除并留理由。
  - 裁定 `approved | adjusted | downgraded`；通过把来源（declared/suggested/failed-receipt/project）、置信度与检查项写入
    `RepairRecord.admission` 与账本 `repair.assessed`；拒绝写 `repair.rejected`（含推荐车道与 blockers），**不产生半开启修复**。
  - `flow_fix_start({ symptom, dryRun: true })` 只做准入预演（裁定/建议 scope/verify/最近 RED 线索/检查项/下一步），不写状态。
  - `flow_fix_start` 参数放宽：`symptom` 唯一必填，`title/scope/verify` 可选（省略时由准入推导），新增 `dryRun`。
- **关门防滥用上限**：`flow_fix_done` 收集到 >20 个改动文件时拒绝（提示改用变更车道），避免把 feature 伪装成小修复。
- **测试**：新增 `test/core/flow/repair-admission.test.ts`（17 例规则矩阵）与 `test/integration/engine-repair-admission.test.ts`
  （9 例端到端：预演、自动推导、脏工作区/敏感面拒绝、账本、改动文件上限、RED 线索）；更新修复通道/工具/真机引擎测试。

### Changed

- `flow_fix_start` 的 host 工具不再本地校验空 scope（交给准入）；拒绝文案按"推荐车道"区分 change / rework / repair。
- 文档：repair-lane.md 新增 §2.3 智能准入；README/README.en 的快速开始、工具表、功能表、FAQ、已知限制同步；
  auto-flow.md 补车道选择说明；implementation-status §3.19。

### Verification

- `npx vitest run` **131 files / 1876 tests** 全绿；`pnpm coverage` **86.61 / 76.61 / 87.44 / 89.71**（阈值通过）；
  lint/tsc 通过（149 源文件，0 error）；`pnpm build` host **1.36MB**（1,358,014 B，sha256 `37ca9097…`）/ client **375.2KB**；
  `verify:package` **39 文件 / 1190.8KB**；`verify:client` 18 插槽 + 1 右栏 tab；`verify:uninstall` 通过；
  `measure:startup` 约 +16ms（14.6–17.3ms 多轮，<200ms）；`verify:compat` **13/13**（隔离 DSH_HOME，dump-config 1316 行）；
  真机 `pnpm verify:host` **3/3 会话创建成功**（0.8s ready、无 lossless 错误；中性化旧构建第 2/3 次复现，门有效）。

## [Unreleased]（v0.6：修复通道 + 自愈/恢复 + 真机回归门 verify:host，2026-11-01）

> 未发版。负责人要求：v0.5.1 事故（投影非 lossless JSON → **连续新建会话从第二个起失败**）要根本修复——
> **修 bug 作为 vibe coding 核心环节成为一等公民（修复通道）**；同时补齐 P0-3 真机冒烟 `verify:host`、
> P1-6 双 profile + 恢复 CLI、P1-10 恢复 SOP、P2-12 重启/热重载 SOP、P2-13 控制面外移决策、P2-11 投影瘦身与预算。

### Added

- **修复通道（repair lane，P1-8/P1-9）**：`flow_fix_start` / `flow_fix_done` / `flow_fix_abort` + `/flow fix [status|done|abort <理由>]`。
  FIX-id 声明 `title/symptom/repro?/scope(1–20)/verify/acceptance?/severity`；流程为 RED（`flow_verify` 失败回执）→
  范围内自由迭代 → GREEN → `flow_fix_done` 关门（校验 RED/GREEN 顺序、`git status --untracked-files=all` 全部改动在 scope、
  `config.commands.test` 全量回归、重跑声明 verify、回执输入哈希新鲜）。**无人工门、不写七阶段 G1/G3 文档、不逐动作拦截**；
  失败保持通道开启。产物 `.flowgate/state/repair.json`（进行中）→ `.flowgate/fixes/<FIX-id>.json` + `fixes/index.md`；
  账本 `repair.started / repair.evidence / repair.done / repair.aborted`；快照 `snapshot.repair`（可选）。
  守卫：`R-FIX-SCOPE`（范围外写入拒绝）、`R-FIX-SHELL`（只允许测试/构建/lint/run + 只读/提交类 git）、`R-FIX-TOOL`（拒绝 delegate/MCP）。
  **旧 `/flow repair`（从账本重建状态）语义不变**。文档 [docs/impl/repair-lane.md](docs/impl/repair-lane.md)。
- **自暂停 / 事故记录（P1-8）**：`flow_self_pause`（项目级暂停写操作 `flags.off`，`by=agent` + `autoRearm`，下次宿主启动自动恢复；
  创建 `INC-id` 事故记录）与 `flow_incident_close`（补 summary/commit/tests/files 归档 `.flowgate/incidents/<INC-id>.json`，
  清理事故标记）；命令 `/flow incident`。产物 `.flowgate/state/flags.json`；账本 `incident.open/incident.close/flow.project_off/flow.project_on`；
  快照 `snapshot.incident/offBy`（可选）。
- **safe-mode 与模块开关（P0-4）**：`src/host/mode.ts` + `runtime` 模式解析。启动期 sentinel `$DSH_HOME/flowgate/safe-mode`
  （默认 `~/.dsh/flowgate/safe-mode`；host 侧改为 honor `DSH_HOME`）+ 项目级 `<root>/.flowgate/safe-mode` + `FLOWGATE_SAFE=1`
  + `config.safeMode`；生效后强制 `takeover=off` 并**跳过** guard/delegation/gates/dispatch（投影/命令/工具/会话保留，可人工止血）。
  模块开关 `FLOWGATE_DISABLE=<names>`（E2E/二分）与 `config.modules.<name>=false`；`/flow doctor` 显示模块 ok/failed/skipped 与原因、
  生效接管模式、safe-mode 实际读取路径、投影自检结果、宿主 epoch。
- **takeover 观察模式（P1-7）**：自举仓库（项目根 `package.json` name=dsh-flowgate 且含 `dsh` 清单字段）默认 `observe`——
  **只对 `R-NO-CHANGE`（未立项写入）放行**并写账本 `takeover.observed`（每会话每规则至多一次）并提示；
  **有进行中变更时，阶段/范围/受保护路径（`.flowgate`、`.git`）/修复通道 scope 等规则仍按原规则拦截**——
  目的是"不被自己的接管规则锁死，同时保留门禁与观测"，不是"观察期全放行"。显式 `config.takeover` 可覆盖
  （enforce/observe/off）。避免开发插件时被自己拦死（自举死锁）。
- **恢复 CLI `pnpm host:recover`（P1-10）**：`scripts/host-recover.mjs`。`--status` / `--safe-mode [--reason <文本>]` /
  `--clear` / `--profile <名> --remove [--yes]`（默认 dry-run）/ `--project <dir>`（项目级 sentinel 双保险）/ `--dsh-home <dir>`；
  每个实际动作追加审计行到 `$DSH_HOME/flowgate/recovery.log`；只写 sentinel 与审计，**不删除用户数据**。
- **真机回归门 `pnpm verify:host`（P0-3）**：`scripts/smoke-host.mjs`。隔离 `DSH_HOME` + `HOME`（护 ledger.key）+
  官方 web 模板 profile + `link:` 本仓库 → 真实 DSH Web 宿主（`--no-open --port 0`，解析 token）→ `GET /connect` 换鉴权 Cookie →
  **连续创建 ≥2（默认 3）个会话** → 断言 `ok:true` + `sessionId` + 响应无 `not lossless JSON`/`gateway/internal`；
  支持 `--keep` / `--plugin <dir>` / `--sessions <n>` / `--expect-fail`（用已知坏构建反向验证门有效）。
  **事实修正**：该 bug 只在 FlowGate 首次初始化后**再次**建会话时触发（首个会话可能正常），单次 POST 不足以复现/回归；
  中性化修复的模拟旧构建实测第 2/3 次创建失败、修复构建 3/3 通过。证据 [docs/compat/host-smoke.md](docs/compat/host-smoke.md)。
- **投影 wire 显式 DTO + 启动自检 + 预算（P0-2/P2-11）**：`src/host/boundary/json.ts`（镜像 DSH `isJsonValue`：
  拒绝 undefined/NaN/Infinity/**负零**/稀疏或带额外属性的数组/Date/Map/Set/类实例/symbol/bigint/循环引用；`toLosslessJson`/
  `toLosslessValue`/`assertLosslessJson`）；`src/host/projection/wire.ts` 显式白名单 DTO + 条数上限（changes 50、evidence 50、
  intercepts 50、reviews 20、trace 50、roadmap 30…）+ **256KiB 单帧预算**与降级顺序；`projectionSelfCheck()` 注册前用脏 fixture
  走 init/apply/wire，失败**不注册投影**（插件其余功能照常，doctor 可见）；`stateVersion` 升到 2；新投影字段
  `snapshot.takeover/offBy/incident/repair`（可选增量）。预算文档 [docs/impl/projection-budget.md](docs/impl/projection-budget.md)。
- **文档**：新增 [docs/impl/dev-loop.md](docs/impl/dev-loop.md)（双 profile：日常 desktop 不 link、dev=link、dogfood=tgz；改完→
  `verify:host`→打包→装 dogfood→重启 SOP + 回滚）、[docs/impl/host-recovery.md](docs/impl/host-recovery.md)（症状矩阵 + L0–L4 恢复阶梯 +
  审计不断）、[docs/impl/repair-lane.md](docs/impl/repair-lane.md)（双车道模型/字段/守卫/限制）、
  [docs/impl/projection-budget.md](docs/impl/projection-budget.md)、[docs/impl/control-plane-decision.md](docs/impl/control-plane-decision.md)
  （控制面外移决策：enforcement 留进程内、recovery 进程外，daemon 推迟 v1.0）、[docs/compat/host-smoke.md](docs/compat/host-smoke.md)（实测证据）。
- **package.json**：新增 `verify:host`、`host:recover` 两个 script（无新增依赖）。

### Changed

- `RuntimeSnapshot` 新增可选字段 `takeover`/`offBy`/`incident`/`repair`；投影 `stateVersion=2`；wire 改为显式白名单 DTO
  （新增字段必须显式加入，不再整包透传）。契约 [docs/impl/host-client-contract.md](docs/impl/host-client-contract.md) §1.1/§1.5。
- 接管模式从"开关"升级为三态 `enforce/observe/off`（enforce=全部规则硬拦截；observe=仅 `R-NO-CHANGE` 放行并记 `takeover.observed`、其余规则照常拦截；off=完全不拦截。safe-mode 强制 off；自举仓库默认 observe；其余默认 enforce），
  `/flow doctor` 展示生效模式与原因；`R-NO-CHANGE` 解锁话术指向两条车道（修 bug 用 `flow_fix_start`，新功能用 `flow_new_change`）。
- 面板构建侧与 wire 侧统一条数上限（`changes` 50、`intercepts` 50、`trace` 50、`risks` 20、`rules` 50、`roadmap` 30），
  历史数据按需通过命令/看板查看（remote 按需拉取为后续方向）。
- `.flowgate/` 目录新增 `state/flags.json`、`state/repair.json`、`fixes/`、`incidents/`（目录说明同步更新；默认不进 git 的策略不变）。
- 文档同步：README/README.en（双 profile、修复通道示例、21 工具口径、验证脚本清单、FAQ）、auto-flow（观察模式 + 与修复车道边界）、
  web-walkthrough §5.3（已归因 + 回归门）、implementation-status §3.17 复验补充 + 新增 §3.18、release/v0.1.0 发布清单（verify:host 必跑项）。

### Fixed

- **新建会话/子会话失败（v0.5.1 回归加固）**：根因是 `flowgate` 投影 wire 值含显式 `undefined`（`engine.snapshot()` 的
  `changeId`/`activeTaskId`、`panel`、`panel.changes[].session` 等），DSH `@deepseek-ai/dsh-api-remotes` 转发 `api-session/added`
  前用 `isJsonValue()` 校验并拒绝。v0.6 在 v0.5.1 的 `toLosslessJson` 清洗之上，进一步做**统一 lossless 边界**（所有跨边界数据）、
  **显式 wire DTO**、**投影启动自检（失败不注册）**，把该类问题从"出事后打补丁"变成"坏值不可能出界"。
- **恢复死锁（自举死锁）**：旧流程中 `/flow off` 是人工命令且要求已有变更、面板禁用=整插件+重启、`FLOWGATE_DISABLE` 只是 E2E 暗门，
  插件坏了就没有可用恢复路径。v0.6 的 safe-mode sentinel + `host:recover` + 模块开关 + observe 模式让恢复不依赖插件健康。
- **自举仓库被自己拦截**：自举检测默认 observe，开发插件时不再被 `R-NO-CHANGE` 锁死。

### Verification

- 真机：`pnpm verify:host`（隔离 DSH 0.2.1-rc.5 Web 宿主，零模型请求，宿主 0.8s ready，约 0.02s/会话）**连续 3 个会话创建成功**；
  中性化修复的模拟旧构建 **第 2/3 次创建报 `not lossless JSON`**（`--expect-fail` 元验证通过，证明回归门有效）。
- 离线门槛（2026-11-01 集成验证最终实测）：`lint`/`tsc` 通过（148 个源文件，tsc 0 error）；`npx vitest run` **129 files / 1849 tests** 全绿；
  `pnpm coverage` **86.50 / 76.45 / 87.41 / 89.63**（阈值 86/76/86/89 通过，exit 0）；`pnpm build` host **1.34MB**（1,339,774 B，sha256 `b979dc08…`）/
  client **375.2KB**（build-client 打印；文件 389,499 B）；`verify:package` **39 文件 / 1172.6KB**；`verify:client` **18 插槽 + 1 右栏 tab** 通过。
- 真实宿主其它复跑：`verify:uninstall` 全部通过（rc.5 `plugin remove` 不 prune node_modules 已知警告）；`measure:startup` 中位数增量
  **约 +16ms**（多轮 15.3–17.3ms 波动，验收线 <200ms 通过；具体口径见 docs/compat/startup.md）；`verify:compat` **13/13** 通过（隔离 `DSH_HOME=/tmp/fg-compat-final` + `link:` 安装，`--dump-config` 1316 行）。
- 证据与可复现步骤：[docs/compat/host-smoke.md](docs/compat/host-smoke.md)。

### Notes

- **事实修正（重要）**：该事故在旧构建上需要**连续创建第二个及以后的会话**才触发；单次 `POST /api/session/create` 可能成功，
  不能作为回归判据。历史提交信息中的旧表述不改写，以本轮文档为准（implementation-status §3.17 复验补充、host-smoke.md）。
- 已知限制：修复通道的 scope 由发起人声明（非自动推导）；shell 政策是治理策略不是沙箱（兜底为关门 scope 核对 + 全量回归）；
  修复通道无独立审查子 agent（高风险/跨模块改动仍应走变更车道）；safe-mode 需重启生效；`verify:host` 依赖本机 DSH，
  CI 不跑（发布清单要求本地执行）；投影 wire 体积在极端 `snapshot` 下仍可能超 256KiB（面板按需拉取为后续方向）。

## [Unreleased]（v0.5.1 修复：会话投影非 lossless JSON 导致新建会话失败，2026-11-01）

### Fixed

- **新建会话/子会话失败**：报 `gateway/internal: failed to create session: Error: forwarded host event "api-session/added" argument 0 is not lossless JSON data`。根因是 `flowgate` 会话投影的 wire 值来自 `engine.snapshot()` / `buildPanel()`，其中无变更/无活动任务时存在显式 `undefined` 字段（`changeId`、`activeTaskId`、`panel`、`panel.changes[].session` 等）；DSH `@deepseek-ai/dsh-api-remotes` 在转发 `api-session/added` 前会用 `isJsonValue()` 校验参数，`undefined` 属性使摘要不再是 lossless JSON，导致建会话失败。普通「新建会话」、子 agent/队友会话（同一错误）都受影响。
  - 修复：`src/host/projection/index.ts` 增加 `toLosslessJson()`（JSON 往返清洗），投影 `init()` 与 `wire.view()` 在交给 DSH 前清洗；`undefined` 被丢弃、NaN/Infinity 变 null，满足 DSH 的 lossless JSON 约束（契约已补充到 host-client-contract §1.1）。
  - 回归测试：`test/host/projection.test.ts` 覆盖 `toLosslessJson` 与「latest 投影带 undefined 字段时 wire.view 仍 lossless」；原有 passthrough 测试改为断言内容等价（不再断言同一引用）。
  - 真机复现/验证（隔离 DSH_HOME + 多会话 bundle profile + link 本仓库）：旧构建 `POST /api/session/create`（新 sessionId）返回 `gateway/internal ... not lossless JSON data`；修复构建同请求返回 `ok:true` 并成功创建会话（0 模型请求）。
  - **2026-11-01 复验补充（事实修正）**：单次 `POST /api/session/create` 不足以复现/回归该 bug——首个会话创建时 FlowGate engine 尚未初始化，
    首个会话可能正常；**连续创建第二个及以后的会话**才会在会话摘要里带上含 `undefined` 的投影值并失败。回归门为 `pnpm verify:host`
    （连续创建 ≥2 个会话；中性化修复的模拟旧构建第 2/3 次失败、修复构建 3/3 通过），见 [docs/compat/host-smoke.md](docs/compat/host-smoke.md)。

### Verification

- `pnpm lint` 绿；`npx vitest run` **119 files / 1689 tests** 全绿；`pnpm coverage` 86.18 / 76.23 / 86.88 / 89.26（阈值通过）；`pnpm build`（host 1.23MB / client 383.4KB）；`verify:package` 39 文件 / 1080.6KB；`verify:client` 18 插槽通过。
- 复现/修复证据：旧构建 session/create → `gateway/internal ... not lossless JSON data`；修复构建 → `{ ok: true, sessionId }`。

## [Unreleased]（v0.5 自动流程接管 + auto-review，2026-11-01）

> 负责人指令：启用 FlowGate 后所有修改由 FlowGate 接管；模型在流程开始前判断改动大小并自动调整流程——复杂全流程、中等合并、简单不人工确认；设计 auto-review 决定是否需要人工确认与是否缩减流程。

### Added

- **全量接管 `R-NO-CHANGE`**：项目启用后无进行中变更时，写文件 / mutating shell / 委派一律拒绝；只读动作与 `flow_*` 放行。解锁话术指向 `flow_new_change`。
- **流程路由 `flowPlan`**：`flow_new_change` 新增 `assessment` 参数（route/autoApprove/clear/goal/acceptance/scope/verify/risks/reasons）；宿主 `reviewFlowAssessment` 确定性 auto-review 后定稿 `route=full|standard|fast`，写 `change.flowPlan`、账本 `flow.assessed`、快照 `snapshot.flowPlan`。
- **按路由自动推进**：`standard` 合并 G1+G3 一次人工确认；`fast` 在检查全部通过后自动通过 G1/G3/G6（G3 自动批准冻结产物、G6 自动交付归档），不再生成授权卡片。人工门检查仍全部执行。
- **负责人覆盖**：`/flow route <full|standard|fast> <理由>`（账本 `flow.route_override`）；fast 仍受低复杂度·普通风险硬约束，复杂/高风险必须 full。
- **UI**：dock `data-flowgate="dock-flow-route"` 与面板 `data-flowgate="panel-flow-route"` 中性徽标，`title` 显示 auto-review 理由。
- **文档/测试**：`docs/impl/auto-flow.md`、需求 FR-4.13/FR-8.7、技术方案 §12.6；新增 auto-review 规则单测（8 类）与 engine fast/standard 集成测试、接管守卫测试、UI/命令测试。

### Verification

- `pnpm lint` 绿；`npx vitest run` **119 files / 1687 tests** 全绿；`pnpm coverage` 86.18 / 76.23 / 86.88 / 89.27（阈值通过）；`pnpm build`（host 1.23MB / client 369.4KB）；`verify:package` 39 文件 / 1079.2KB；`verify:client` 18 插槽通过。
- 真机零模型 E2E：自动流程徽标 **7/7**（`/flow help` 含 route、低复杂度变更 `/flow route fast` 后 dock `dock-flow-route` + 面板 `panel-flow-route` 均为 `data-route=fast`、`data-auto=true`、文案「自动流程 · fast」、pipeline 正常）+ v0.4 回归 E2E **14/14**；0 pageerror / 0 console.error / 0 模型请求。截图 [38-panel-auto-flow-v05](docs/screenshots/38-panel-auto-flow-v05.png)。
- 接管拒绝本身在 engine 集成测试覆盖（守卫级，真机零模型无法触发模型写入工具）；路由行为由 auto-review 单测 + engine fast/standard 集成测试覆盖。

## [Unreleased]（v0.4 移除学习模式，2026-11-01）

> 未发版：负责人决定去掉学习模式（产品简化、少文字）。只做移除，不新增能力。

### Removed

- **客户端**：面板头部的学习模式选择器（详细/简洁/关闭）；阶段学习卡（`StageCard`、`src/client/learn/**`，做什么/为什么/合格标准/方法来源/反模式/正反例）；Pipeline 里的折叠学习卡与术语表；`LearningMode` 类型、`FlowgateProjection.learning`、`PanelModel.learning`、`ClientAction.learn` 与 `/flow learn` 命令映射。
- **host/core**：`FlowgateConfig.learning` 配置字段与默认值/校验；`/flow learn` 命令（现在作为未知子命令报错）；投影 wire 字段 `learning`；engine 的“学习模式”注入提示与 1000 token 差异化预算（注入预算统一 ≤600）。
- **核心学习卡数据**：`src/core/learn/**` 删除；报告/看板只保留 `STAGE_CARD_TITLES`/`STAGE_CARD_ORDER`（迁至 `src/core/stage-meta.ts`），不再导出 `STAGE_LEARNING_CARDS`/`LearningCard`。
- 文档：README/README.en 命令表与功能状态、需求文档 FR-8.3/8.4/NFR-8、技术方案/执行方案对应章节标注移除。

### Changed

- 图形流程页保留可操作内容：hero、FlowMap、实时门禁检查项、产物 chips（改用 `src/client/stage-info.ts` 的 `STAGE_ARTIFACTS`）、下一步 callout、roadmap；单位置更少文字。
- 兼容：旧 `.flowgate/config.yaml` 中的 `learning:` 键加载时忽略、不报错；旧投影记录里的 `learning` 字段读取方忽略；旧 `/flow learn` 返回“未知子命令”而不是崩溃。

### Verification

- `pnpm lint` 绿；`npx vitest run` **117 files / 1669 tests** 全绿；`pnpm coverage` 通过 thresholds（86.31 / 76.23 / 86.88 / 89.37）；`pnpm build`（host 1.21MB / client 381.4KB）；`verify:package` 39 文件 / 1062.5KB；`verify:client`（18 插槽）通过。
- 真实宿主（隔离 DSH_HOME、零模型请求）E2E **14/14**：10 tab；面板 0 个 `learning-mode` 锚点、header 无“学习模式”；Pipeline 无 `stage-card`/`glossary`，仍有 `flow-map`/artifact chips/next-step callout/live-checks；`/flow help` 不含 learn；`/flow learn brief` 报“未知子命令”；旧配置带 `learning: brief` 仍可加载；0 pageerror / 0 console.error / 0 模型请求。截图 [37-panel-pipeline-v04](docs/screenshots/37-panel-pipeline-v04.png)。

## [Unreleased]（v0.3 运行可视化：子代理拓扑 + 后台任务，2026-11-01）

> 未发版：负责人需求——子代理拓扑实时预览（工作流图 / 树双模式）+ 后台任务清单（退出码、实时输出、强制终止）也要可视化，风格与 DSH 原生一致。设计契约见 [docs/impl/runtime-visualization.md](docs/impl/runtime-visualization.md)。

### Added

- **面板新视图「子代理」**：读取 DSH 原生会话投影 `subagentCatalog` + 全局标准 props `useSessionStatus` 的实时 running 状态，并与 FlowGate 投影的任务/批次/taskCards/worktree 关联；角色按激活 label 解析（执行者/任务审查者/终审/调查者/其它）；
  - **工作流图**（默认）：自上而下 主会话 → 竖向主干 → 批次组（组头含顺序/并行 tag、状态、数量）→ 组内子代理卡（flex-wrap，窄栏自动单列）→「服务」组最后；560px / 719px 侧栏实测 **0 横向溢出**（508/508、667/667）。
  - **树**：主会话根 → 可折叠批次 → 缩进子代理行；状态点（running 呼吸 / done / failed / idle）仅小面积语义色；「打开会话」经 `uiWorkspace.openSession` 跳转子代理会话。
- **面板新视图「后台」**：复用 DSH 原生 `ctx.jobs` 服务（与官方 Jobs 面板同源）渲染后台任务清单——状态点、kind、mono 命令标签、**退出码 chip**（解析 `detail` 的 `exit code: N`）、耗时（live 每秒刷新）、展开后经 `observe` 流式显示**实时输出**（`<pre>`，最近 8KB、自动滚底）、**两段式强制终止**（`kill`，armed 3 秒自动解除）；缺 `ctx.jobs` 时优雅空态。
- 客户端数据层：`HostBridge` 增加 `jobsAvailable/jobsSnapshot/subscribeJobs/watchJobs/observeJob/killJob/openSubagentSession`，经 `ctx.inject(['jobs'])`、`ctx.inject(['uiWorkspace'])` 延迟解析；`types.ts` 增加 `JobRowWire/JobsObservedView/JobsUiSnapshot`。
- `src/client/runtime-model.ts` 纯函数（角色解析/任务关联/orderedJobs/parseExitCode/formatDuration/输出裁剪）+ i18n zh/en 各 +54 key + 原生 token 样式类；面板 tab 8→10。

### Verification

- `pnpm lint` 绿；`npx vitest run` **118 files / 1683 tests** 全绿；`pnpm coverage` 通过 thresholds（86.39 / 76.25 / 86.93 / 89.47）；`pnpm build`（host 1.21MB / client 411.6KB）；`verify:package` / `verify:client`（18 插槽）通过。
- 真实 DSH 0.2.1-rc.5 Web 宿主（隔离 `DSH_HOME`、**零模型请求**）smoke **22/22**：10 tab（含新「子代理/后台」）、两视图空态、旧 8 tab 与授权卡/宽度无回归、0 pageerror / 0 console.error / 0 模型请求；dump-config 确认 `@deepseek-ai/dsh-api-job-controller`（ctx.jobs）与 `@deepseek-ai/dsh-client-ui-workspace`（openSession）在 Web 组合中。
- 组件级 populated 证据（真实组件 + 真实 `--dsw-*` token CSS + fixture）：34 子代理工作流图（560px，0 溢出）、35 树模式、36 后台任务（展开输出 + armed 终止 + 退出码）；截图见 [docs/screenshots](docs/screenshots/README.md)。
- **限制（如实）**：真机 populated（真实子代理/后台 job）需要模型运行，本轮零模型只验证空态与组合面；34–36 为组件级假数据证据，已在 README 标注。

## [Unreleased]（v0.2 开发线：图形化流程 + 卡片化授权，2026-11-01）

> 未发版：本节记录工作区已完成、尚未发布到 npm 的变更。设计契约见 [docs/impl/ui-interaction-redesign.md](docs/impl/ui-interaction-redesign.md)。

### Added

- **输入区图形化 dock（取代旧的一行文字状态条）**：七阶段动画轨道（当前阶段呼吸脉冲、已完成实线、未完成流动虚线、人工/自动门标记）+ 下一步 chip + 按状态出现的图形化卡片；8 态状态机（demo / locked / off / idle / active / awaiting / pending / blocked）；点击轨道/面板按钮打开右侧栏。DOM 契约（`data-flowgate="flow-dock"` / `flow-rail` / `rail-node` / `dock-next` / `auth-card` 等）与动效规范见设计文档。
- **点击即授权的授权卡片**：人工门（GR/G1/G3/G6）、待处理项（SC/RK/PC/RL/TM/CF/BL）、非 agent 改动确认、启用/修复/恢复门禁，全部渲染为可点击卡片（含内联退回理由）；点击经 `ctx.remote.commands.execute(sessionId, '/flow …', [])` 由宿主直接执行（`sessions.binding().session.command` 兜底），**不再把命令写进输入框**，用户无需回车确认任何命令。`performAction` 新顺序：remote → executeCommand → 旧 composer/剪贴板降级。
- **原生提问卡片**：`preset-flowgate` 组合 `@deepseek-ai/dsh-tool-ask-user`，澄清/选择走原生 `ask_user_question` 提问卡（DSH `ui-user-questions` 渲染）；新增 systemPrompt「交互契约」（仅已初始化项目追加）：人工拍板走授权卡、提问必须用 `ask_user_question`（带 options）。
- **面板图形流程页**：面板头新增 `panel-rail`；Pipeline 改为 hero 进度环 + 纵向 FlowMap 时间线（人工/自动门徽标、产物 chips、「你在这里」、下一步 callout）+ 默认折叠的学习卡；ExecutionGraph 运行中节点加呼吸光效。
- **会话内工具可视化**：为 16 个 `flow_*` 工具注册 `tool.call.toolview`，聊天里每次 FlowGate 工具调用渲染迷你七阶段轨道 + 当前阶段/门状态/工具生命周期状态（防御式降级，无投影时退回一行文本）。
- **动效与可访问性**：统一 `src/client/styles.ts`（幂等注入、SSR 安全）；只动画 transform/opacity/stroke-dashoffset；`prefers-reduced-motion: reduce` 下全部关闭。
- 工作流/文档：并行实现契约 [docs/impl/ui-interaction-redesign.md](docs/impl/ui-interaction-redesign.md)、[host-client-contract](docs/impl/host-client-contract.md) §2 更新、v0.2 真实宿主截图 30–33 与 [screenshots README](docs/screenshots/README.md) 分节。

### Changed

- 用户可见文案全面去命令化（host/core 三批清理，task-3/7/8）：`nextStep` / `pushNotice` / 工具结果 / 门禁 hint / 规则 unlock / 派发提示 / init 输出 / 会话接续提示等统一改为「等待负责人在授权卡片上确认/处理」；仅保留 `/flow help`、命令用法错误、doctor/repair 诊断、agent 工具名。`/flow` 命令保留给高级用户，与卡片等价。
- 客户端 i18n 447 keys（zh/en parity）；新增 `dock.*`、`viz.*`、`pipeline.*` 等 key，清理 trial/learning 文案里的 `/flow` 提示。
- 旧「面板按钮 → 填命令到输入框」的兜底仅作为无命令 remote 的旧宿主降级保留（正常 Web 宿主不触发，`ActionOutcome.fallback=false`）。

### Changed（native style iteration, 2026-11-01）

- **负责人反馈后第二轮视觉对齐**：授权卡/dock 宽度与 DSH 原生 plan 审批卡一致（照抄官方 `PlanReviewPanel.module.css` 的 frame/card/strip/summary/footer：`padding:6px calc(var(--dsh-composer-side-clearance)+16px) 10px`、`max-width:var(--dsh-chat-content-width)`、`background:var(--dsw-specific-input-major)`、`border-radius:var(--dsw-radius-xl)`、`box-shadow:var(--dsw-elevation-panel)`）；新增 `data-flowgate="flow-dock-inner"` 测量锚点。
- **去花哨配色**：删除整卡橙底/大橙进度环/彩色渐变/蓝红实心按钮；授权卡改为原生 plan 三段式（warn-tertiary strip + 小状态点 + 白卡 + 黑白主按钮 + outline 次按钮），rail/next chip/change id/面板 FlowRail/FlowMap/Pipeline hero/Gates 卡/ExecutionGraph 全部切换 `--dsw-*` 中性 token（语义色只用于小状态点/小图标/细线），暗色主题实测无写死白底黑字。
- 真实宿主实测（1600×1000）：`--dsh-chat-content-width=844.8px`，`flow-dock-inner`=授权卡=844.8px（±0px），dock 外框=composer hero 外框=908.8px（±0px）；composer 白卡内容宽 877px = var + 2×clearance 属宿主 token 设计（原生 plan 卡同样比 composer 窄 32px），已在 docs 披露。

### Verification

- `pnpm lint`（lint-layers + tsc）绿；`npx vitest run` **116 files / 1642 tests** 全绿；`pnpm coverage` 通过 thresholds（合计 86.39 / 76.24 / 86.93 / 89.47）；`pnpm build`（host ≈1.21MB / client 346.6KB）；`verify:package` 39 文件 / 1065.3KB；`verify:client` 通过（18 个插槽：dock + toolview×16 + sidebar tab）。
- 真实 DSH 0.2.1-rc.5 Web 宿主（隔离 `DSH_HOME`、**零模型请求**）E2E **35/35 断言通过**；原生风格改造后复验：active 12/12、awaiting 43/44（唯一旧断言 data-tone=attention 因 strip 语义改为 warn，data-kind/data-gate/data-action 不变）：awaiting 授权卡 → 点击「确认并推进」→ 1 次真实 `POST /api/commands/execute` 返回「已批准 G3（与 G1 合并确认），进入 S4」→ 卡片消失、阶段推进、宿主写盘 `stage=S4/G3=passed`；**composer 点击前/中/后全程为空**；面板 flow-map/you-are-here/next-step-callout；8 个 tab 无 `/flow` 手输文案；0 pageerror / 0 console.error；reduced-motion 下 0 动画。截图见 [docs/screenshots](docs/screenshots/README.md) 30–33。
- 限制（如实）：原生提问卡与 toolview 需模型真跑一轮，零模型 E2E 只验证组合面（工具行 + UI 插件在组合中）；awaiting 状态沿用既有离线构造口径，点击→执行→推进为真实链路。

## [0.1.0] - 2026-10-31

### Added

- **第六轮：清理复验发现的接线缺口（2026-10-31，代码提交 `cea85dd`）**：
  - 背景：独立只读复验推翻第五轮"功能缺口全部闭环"结论，新发现 **7 项 P1 接线缺口**（均补回归测试）：T4.9 并行 worktree 执行根（`flow_verify`/输入哈希/自动提交以任务 worktree 为根）；派发双结算（`taskFailed` 对 done 早退 + host finalize 先查状态）；T4.2 S5 全量测试改走 `runFullSuite`（regressions 写入回执，G5 可判回归、M-12 有数据源）；T4.8 压缩后交接摘要重注入（含 `agent/created source='compact'` 防御式路径，DSH rc.5 实测该事件不可达）；T3.7/T4.8 跨会话注入最近 interrupted 任务卡与「任务 RED/GREEN」状态；T2.2 澄清「改变说明」占位符（`（待补充）`/`（未记录）`）不再通过 G1（并回写 `clarifyRounds`）；T2.8 低复杂度 G3 任务数上限=1。
  - P2/证据修正：T2.3 `test: none` 时 G2 前真实运行 build/lint/typecheck 基线并落回执；M-16 数据源（`roadmap.approved`/`roadmap.progress` 写 total/delivered）；T5.1 执行图节点可点击/键盘选择 + 任务详情（snapshot 可选 `taskCards`）；规则试跑改为客户端本地近似并固定标注「精确判定以宿主为准」；T2.4 技能重复加载给出「本会话已加载」短提示；taskDone 审查提示不再引用不存在的 `flow_request_review`。
  - 技能/文档/物料：skills 同步（dispatch auto 未按 size 路由、低复杂度 1 张卡、澄清占位符、test:none 基线）；文档与发布物料清理（门禁 46→52 项、面试 M-6=42.9% 补原始数据、真实故事拆两条、README.en 状态、compat/startup 头注、evaluation §194、compat"无网络"、CI 状态表述、todo-audit 89.29、release.yml 加 coverage、package.json repository/homepage/bugs、tag 推送说明、截图可离线补做、vitest 注释、构建体积）。
  - 数字：**112 files / 1522 tests** 全绿（第五轮 107/1459，+5 文件 / +63 用例）；typecheck/lint 通过（130 源文件）；coverage thresholds 通过（合计 **86.40 / 76.25 / 86.92 / 89.46**）；compat **13/13**；startup **+16.2ms**；uninstall 通过；build host ≈1.21MB / client ≈219KB；`verify:package` **39 文件 / 1032.9KB**（docs 修改后重跑实测，含 README）。**第六轮提交已推送，CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) success**（lint/test/coverage/build/verify）。
  - 仍开放（四分类）：环境/人工受限验证；可离线补做（projection epoch 复验/自动接续与 doctor 截图）；需负责人决策（自举 §9、T2.1 字面口径；发布 tag 方案已解决：2026-10-31 已发布 v0.1.0）；后续 P2/产品决策（C0 骨架 TDD 死锁、`run:auto` size 路由未实现、Remote 非降级 v0.1 不做、M-17/dispatch 摘要/worktree 归因/T4.4 引导、T5.2 学习模式抽查）。详见 [implementation-status §4](docs/impl/implementation-status.md) 与 [acceptance-gap-audit §7](docs/impl/acceptance-gap-audit-2026-10-31.md)。

- **第五轮：执行方案验收缺口修复（2026-10-31，提交 `8963a92`…`535842b`、`6e3bd24`）**：
  - 冻结/守卫：契约判定快照（改 config 只影响新变更）、门后产物哈希冻结 + `R-FROZEN-ARTIFACT`、越界撤销自动解除、非 agent 改动进入面板与 G6、接管后旧会话写拒绝（`R-LEASE`）与接续快照对比。
  - 执行/证据：`evidence.md`/`review.md` 由插件维护；篡改检测（`core/tamper`，跳过测试/删断言/改测试基础设施 → TM-n、审查输入、G6）；行级审查读取覆盖、同 diff 去重、critical/major 独立阻塞与 `/flow review waive`；返工失效（`flow_declare_rework`）；交接摘要过门/任务完成时生成并注入任务卡。
  - 交付/调度：S5 run/health 运行证据（宿主启服务+健康检查+日志+清理进程组）；检查点任务验证+全量测试与 worktree 降级标注；高风险终审三份结论；调查并发上限/耗时；relatedTo 继承分析结论。
  - UI/交付物：G1 低复杂度自动通过、G3 执行图、高风险确认卡风险/回滚逐项确认、例外可撤销、规则统计/试跑用生效规则、看板随状态重生成、report/board 尝试系统打开、注入 token 预算截断。
  - 评测/加固：compat 13/13（含 6 项离线结构检查）、浏览器包缺失故障注入、`review.model` 接线。
  - 最终数字：**107 files / 1459 tests**；coverage 86.19/75.84/86.60/89.29；package 39 文件/1015.9KB；startup +15.8ms；uninstall 通过。详见 [acceptance-gap-audit](docs/impl/acceptance-gap-audit-2026-10-31.md)。

- 发布工程：本 `CHANGELOG.md`、发布说明 [docs/release/v0.1.0.md](docs/release/v0.1.0.md)、tag 推送触发的发布 workflow `.github/workflows/release.yml`（依次 lint / test / coverage / build / verify:package / verify:client 后发布 npm 并创建 GitHub Release；本次 v0.1.0 发布即由它执行）。
  - 这些文件属于发布流程本身，不是插件功能变更。若发布时把 `v0.1.0` tag 前移到包含这些提交的 HEAD，请把本节并入 `[0.1.0]` 的「Documentation」一节。
- host 层单测补齐：`test/host/dispatch.test.ts`（11 例：注册、engine 未就绪、无 subagents/provider 降级、顺序/并行派发、worktree 落点、创建失败降级、互斥、失败结算）与 `test/host/review.test.ts`（14 例：开关、provider 降级、findings 归一化与 diff 指纹、重试 1 次、sessionQuery 读取覆盖、调查任务）。
- **并行执行者范围判定用错任务卡**（C-005 真机发现）：两个执行者同时活跃时 `evaluateAction` 用全局 `activeTask` 判定范围，T2 写自己 `new_files` 的文件被 T1 的 scope 拒绝；已改为优先取 `caller.dispatch.taskId`，并新增 engine 集成回归测试。
- **并行批次集成检查点**新增 2 个 host 单测：合并成功（merge 各任务分支 + integration 命令 + completeCheckpoint(ok) + 清理 worktree/branch）与合并冲突（abort + checkpoint 失败、保留 worktree）。
- **派发/worktree 真机缺陷修复**（C-003/C-004）：任务分支 `flowgate/<变更>/<任务>` 与变更分支 `flowgate/<变更>` 触发 git ref D/F 冲突，worktree 创建静默降级主工作区 → 改用 `flowgate-tasks/<变更>/<任务>` 兄弟命名空间；执行者在 worktree 内的绝对路径被按主仓库根归一，导致 `R-PROTECTED`/`R-SCOPE` 误伤 → 守卫改为按 caller.cwd（worktree）归一，补 2 个守卫回归测试与 1 个分支命名断言。真机已创建 `.flowgate/worktrees/C-004/T1|T2` 与对应分支，`data.dispatched.worktree` 回填生效；完整合并/集成检查点结算待 C-005 复验。
- T6.2 加固：`test/fault-injection/host-resilience.test.ts`（4 例：账本篡改锁定、守卫抛错 fail-closed、宿主服务缺失降级、配置损坏报错）、`scripts/measure-startup.mjs`（启动增量 +14.2ms，验收线 200ms）与 `scripts/verify-uninstall.mjs`（隔离 profile 安装/卸载干净度），结果录入 [docs/compat/0.2.1-rc.5.md](docs/compat/0.2.1-rc.5.md) 与 [docs/compat/startup.md](docs/compat/startup.md)。
- 首个真模型对照 pilot（`ts-todo-api / fix-bug`，A/B 各 1 次，2026-10-31）：两种条件均修复正确（回归 34/34、验收 4/4）；B 组多 2 轮、约 13 倍耗时、3 次人工门，但留下 RED/GREEN 回执、门禁留痕与交付报告。原始数据见 `docs/evaluation-data/20261031-0228*/`，结论与局限见 [docs/evaluation.md](docs/evaluation.md) §6.1。
- 核心工具单测补齐：`test/core/util/util.test.ts` 覆盖 paths/glob/hash/time/markdown（11 例：路径归一、** glob 与重叠、哈希/HMAC/稳定 JSON/密钥脱敏、时间格式与过期、围栏/表格/章节/列表解析）；核心覆盖率升至语句 83.0% / 分支 68.4%。
- **命令执行器超时挂起修复**（真机发现：`flow_verify` 跑 `spring-boot:start` 时宿主超时后永久挂起）。`NodeCommandRunner` 改为 POSIX detached 进程组、超时整组 SIGTERM/SIGKILL，并在宽限期后强制返回 `timedOut`/exit 124，避免后代进程持有管道导致 Promise 不 resolve；新增 3 个回归测试。
- 对照评测 **18/18 run** 完成（9 任务 × A/B，真实模型 + 隔离 headless，双流并行）并提交原始数据到 `docs/evaluation-data/`（11MB）；结果表与诚实结论见 [docs/evaluation.md](docs/evaluation.md) §6.2/§6.4：B 组回归通过数与 A 相同（7/9）、验收 2/3 vs 3/3，但耗时与人工门显著增加；含 2 个 B 更差反例与 2 个两者都红；sandbox 不可用是主要限制。
- 评测脚本新增 `--no-run`：B 组把 `commands.run` 覆盖为 `none`，避免 Spring Boot 这类长驻服务命令在 headless 一次性运行里挂起（A 组不受影响；普通风险 G5 本就不强制运行证据）。
- 评测结果汇总脚本 `scripts/collate-evaluation.mjs`（`pnpm eval:collate`）：从 `docs/evaluation-data/` 生成 9×2 结果表并写回 evaluation.md。
- 评测基础设施：`scripts/run-evaluation.mjs`（A/B 条件编排、隔离 `DSH_HOME`、人工门自动批准、产物收集、dry-run 零副作用）、`examples/greenfield-members/` 从 0 开发空仓库、`docs/evaluation-data/` 目录约定。

#### 2026-10-31 第二轮（剩余开发）

- **T6.1 评测收尾**：18 组 A/B run 的 4 项主观指标（隐藏需求遗漏 / 越界文件 / 虚假完成 / 验收覆盖）完成人工评分 18/18；机器可读结果 `docs/evaluation-data/scoring/scores.json`、口径与证据指针 `docs/evaluation-data/scoring/README.md`、汇总与诚实结论 `docs/evaluation.md` §6.5。结论：B 组隐藏需求遗漏 41 vs A 22、验收覆盖 33/72 vs 51/72，但 9 个 B run 只有 1 个完整走到 G6（其余被环境/审批阻塞，3 个零改动）；B 的真实收益是 0 虚假完成（A 2 次）与可审计过程，数据集不足以证明 B 提升需求覆盖。
- **评测工具链增强**：`scripts/run-evaluation.mjs` 新增 `--preset-registry`（headless 缺 `agentPresets` 时用 `--patch` 补 `@deepseek-ai/dsh-agent-preset-registry`，让 cordis.patch.yml 的 preset 行激活）、`--auto-pending <kinds>`（脚本扮演负责人批准 blocker/plan/rule 等，默认不含 scope/risk）、owner-helper 的 `pending`/`resume` 动作、租约残留时自动 `resume --takeover`、greenfield 在"无活动变更"时继续轮次；`run.json` 记录 preset 注册表与 auto-pending 策略。
- **覆盖率缺口补齐**：`src/host/**` 纳入 vitest coverage 口径（排除测试替身）并加 thresholds（statements/functions/lines 80、branches 70）；新增 9 个测试文件 / 158 用例；core 覆盖率 语句 83.03→90.34%、分支 68.36→80.16%、函数 86.47→90.77%（coverage-final.json 计算）；host 语句 74.14% / 分支 61.01%；core+host 合计 86.40 / 75.97 / 85.96 / 89.53。
- **派发/并行 host 收尾（T4.6 / T4.9）**：新增 `src/host/dispatch/pending.ts`（子 agent 结算后把 open 的 scope/plan/risk/rule/conflict/blocker 待处理项注入主会话、同项只通知一次；`flow_dispatch_next` 的 `data.pending` 暴露）与 `src/host/dispatch/redispatch.ts`（重新派发中断任务前确认旧子 agent 已停止/资源已释放，确认不了保持阻塞并生成 risk 待处理项，负责人批准为一次性授权）；派发前复核 open scope/plan/risk（fail + 可执行命令提示）；`runIntegrationCheckpoint` 返回 `{batchId, ok, detail}` 并写进完成通知；新增 27 例 host 测试与 8 例集成检查点测试分支覆盖。
- **T-FAILURE-LIMIT 熔断可恢复**：连续失败触发器只拦"推进/修改"动作（写文件、会改工作区的命令、进度类 `flow_*`），只读 `read`/只读 shell/`flow_status`/`flow_diff`/`flow_report_risk` 放行；同一任务熔断只生成 1 个 BL 待处理项；新增负责人命令 `/flow unblock [BL-n|任务 id] [理由]`（失败计数清零、任务恢复 running、同任务残留 BL 一并关闭，账本新增 `task.unblocked` 事件）；`/flow doctor` 渲染锁定原因。18 例回归（含真实 run `BL-1..BL-8` 卡死快照复刻）。
- **Python 标准库 unittest 输出解析器**（greenfield 演练阻塞根因）：`src/core/evidence/parse.ts` 新增 `parseUnittestConsole`（`Ran N tests`、`OK` / `FAILED (failures/errors/skipped)`、`NO TESTS RAN`、FAIL/ERROR 分段名称与 文件:行、subTest），注册到控制台回退并修正 `detectEvidenceKind`；25 例测试包含真实 Python 3.13 输出与仓库已提交证据回放。
- **PROJECT（路线图阶段）跨会话接续**（greenfield 演练发现的 from-0 缺陷）：`autoAttach`/`attachSession` 不再排除 PROJECT，新会话可继续路线图阶段并批准 GR；修复 GR 批准不落盘（`approveGate('GR')` 归档 PROJECT 时绕过 `saveChange` 的 archived 跳过逻辑，改为直接写 status.json + 台账并释放租约），新会话不再反复要求批准 GR。新增 4 例回归。
- **会话投影进程 epoch**（Web 宿主走查发现的 UI 陈旧 bug）：投影记录携带宿主进程 `epoch`，`apply` 在 epoch 不同时接受新进程记录；修复"宿主重启后新进程 revision 从 0 起被旧会话日志更大 revision 挡住、面板停留在重启前快照"（`src/host/projection/index.ts`、`src/host/runtime.ts`、wire 契约新增可选 `epoch`）。新增 6 例回归。
- **Web 宿主交互真机走查**：新增 `docs/impl/web-walkthrough.md` 与 14 张截图（`13-`～`26-`）：会话内切换 FlowGate 工程模式 preset 成功（`agentPresets/select` 返回 `flowgate`、0 pageerror）、`/flow init`/`/flow new`、8 视图面板、面板按钮 Remote 兜底填命令、低复杂度方案确认卡三按钮、拦截视图误判反馈（组件级）；同时记录 2 个环境坑。
- **T-DEPENDENCY 按内容判定（误伤修复）**：依赖触发器从"只看路径"改为"路径命中 + 清单内容判定"——新建 `package.json`（无 `dependencies`/`devDependencies` 或全空）、只有 build/plugins 的 `pom.xml`、空/纯注释的 `requirements.txt`、空 `[dependencies]` 的 `Cargo.toml` 等纯脚手架不再转人工；lockfile、delete/rename、未知自定义清单、解析失败仍保守触发。真实 greenfield 演练中"新建无依赖 package.json"被反复 RK 卡死的问题因此消除；35 例回归。
- **路线图批准后的第一个变更必须从路线图立项**（greenfield 演练第四轮发现的 from-0 死锁）：GR 批准后若还没有任何变更，`flow_new_change` 不带 `fromRoadmap` 会被拒（hint 给出 `flow_new_change({ fromRoadmap: "C0" })`），注入文本 / nextStep 同步给出精确工具调用；GR 批准后清空 `current` 并释放租约，避免新会话继续停在 PROJECT。否则 C0 会失去 skeleton 标记，G2 的 `project.md 命令可执行` 与 `R-PROTECTED` 保护形成死锁。4 例回归。

### Fixed

- **状态文件损坏 fail-open**（T6.2 复验发现，违反 03 §14）：`status.json` 损坏时原先被 `listChanges` 静默跳过，导致 `locked=false`、doctor 显示"运行正常"、源码写操作 allow；现在 `listChangesDetailed` 汇总损坏清单，`engine.load` 进入锁定模式并在 `/flow doctor`/注入文本给出路径与 `/flow repair` 入口，`repair` 在仍有无法重建的文件时保持锁定（防二次 fail-open）。新增 14 例回归（core 11 + host 3）。
- **T-FAILURE-LIMIT 熔断卡死**（真实 greenfield run 暴露）：熔断后连 `read`/`flow_status`/`flow_report_risk` 都被拒、BL 待处理项没有负责人解锁路径且每个被拦动作新增一个（真实 run 膨胀到 BL-1..BL-8）、`decidePending` 对 blocker 的批准不生效；已按 Added 中"T-FAILURE-LIMIT 熔断可恢复"修复。
- **GR 批准在重载后丢失**：`approveGate('GR')` 把 PROJECT 标记 archived 后走 `saveChange`，而 `saveChange` 对 archived 直接跳过 status.json 写入（假设目录已被归档移走），导致磁盘仍是 active/awaiting、新会话再次要求批准 GR；现在直接写 status.json + 台账并释放租约（见 Added）。
- **宿主重启后投影 revision 回退**（见 Added 中的进程 epoch）；**greenfield 演练暴露的 unittest 解析缺口与 PROJECT 接续缺口**（见 Added）。

#### 2026-10-31 第三轮（P0 修复，7 项）

- **P0-4 计划修订落地**：`applyPlanAmendment` 真正解析 `add` 任务卡片段、追加顺序批次并应用 `reorder`（未开始任务可重排，已开始/完成拒绝），`flow_request_plan_change` 批准后执行计划不再"只 `void item`"。新增 `parseTaskCardFragment` 与集成回归。
- **P0-2/P0-3 集成检查点可修复、可重试**：integration 命令失败时解析失败输出（兜底批次任务范围）自动生成 `FIX-n` 顺序修复批次（`autoRepair` 任务豁免 TDD、`fix` 验证组只接测试类命令，保证真实 `flow_task_done` 可完成）；修复完成后 `dispatchNext` 返回 `retryCheckpoint`，宿主重跑合并+集成命令；连续失败达 `triggers.consecutive_failure_limit` 转负责人闸门（`blocked`），新增 `/flow conflict approve|reject CF-n`（headless 可释放；approve 重置 attempts 后重试，reject 放弃自动重试）；合并冲突写 `merge.conflict` 账本事件并保留 worktree；成功重试自动关闭对应 conflict 项。
- **P0-1 `run: main` 路由**：`dispatchNext` 返回 `mainTasks` 交由主会话 `flow_task_start` 领取（并行批次可与子 agent 任务并行），不再把主会话任务派给执行者子 agent；`flow_dispatch_next` 结构化 data 带 `mainTasks`。
- **P0-5 终审/安全审查生产者**：`flow_submit({gate:"G5"})` 在 S5 自动运行只读终审子 agent 并登记 `kind:'final'` 记录（高风险同时登记 `kind:'security'`），修复"开着 `review.enabled` 提交 G5 必然缺终审记录"；终审不可用时返回可执行提示。
- **P0-7 S5 验证失败回退 S4**：`g5.fullTests` / `g5.lintBuild` / 终审 critical-major findings 触发回退 S4 并生成 `FIX-n` 修复批次；纯证据类失败（`g5.runtime` 等）仍留在 S5 补证据。
- **任务门审查轮次补齐（复核发现的 pre-existing Major）**：host `flow_task_done`/派发结算不再"有一条 pass 就短路"，按 `requiredReviewRounds()`（高风险 2 轮）从已有 pass 数补跑审查；修复高风险任务门永久缺一轮、默认配置下无法完成任务的问题。
- **P0-6 `sessions.json` 损坏 fail-closed**：租约文件损坏/截断不再让 `engine.load` 抛错（此前 → 宿主 markInert → 守卫放行）；改为汇总损坏状态文件、进入锁定模式、doctor 显示路径、`/flow repair` 重建空租约并解锁；损坏态不自动改写租约。
- **测试稳定性**：`test/host/plugin-load.test.ts` 引擎初始化等待改用 `waitForEngine()`（原固定 `flush()` 在 coverage 插桩下偶发 `engine()===null`），修掉本轮复现的 flake。
- **测试**：第四轮收尾后实测 **96 个测试文件 / 1363 个用例**全绿（第三轮 1322 → 第四轮 1363，新增 41 例：M-5/槽位补位/面板审批/contextPct/coverage 去抖/MCP 守卫等）；`pnpm coverage` thresholds（80/80/80/70）通过（合计 87.07/76.57/87.09/90.16）；`pnpm lint`（127 源文件）、`pnpm build`、`verify:package`（39 文件 / 928.0KB）、`verify:client` 通过；HEAD 复跑 compat 7/7、startup +15.1ms、uninstall 通过。

#### 2026-10-31 第四轮（P1/P2/P3 收尾）

- **P1-1 M-5 规则自动降级**：按账本重建每规则误判反馈；累计拦截 ≥ 20 且误判率 > 5% 时，deny/human 判定降为提示（本次放行、写账本 `rule.hinted`、计入 M-5 备注与复盘），样本不足不降级。README 承诺与实现对齐。
- **P1-2/P1-6 并行调度**：执行者结算后宿主机**槽位级自动补位**同批次 queued 任务（不再等主 agent 再 dispatch）；超出 `max_agents` 的任务显式标 `queued`。
- **P1-3 面板审批**：右侧栏面板覆盖 scope/risk/plan/rule/conflict 批准/拒绝与 blocker 解除熔断，保留 Remote 不可用时的命令兜底；修正 BL-* 的命令映射。
- **P1-5 pending 生命周期**：变更/分析归档时未处理 pending → `expired`，写账本 `pending.expired`。
- **P1-7 上下文占用**：host 读取 rc.5 `dsh-token-meter` 的 `contextPressure` 会话投影 → `RuntimeSnapshot.contextPct`（缺数据不填、不编造；client ≥60% 提示）；契约见 host-client-contract §1.1。
- **P1-8 CI/覆盖自检**：CI 增加 `pnpm coverage`；覆盖自检 tools/change 100ms trailing debounce + doctor/status 读取兜底，消除"4–7 波动"。
- **P1-9 基准仓库**：ts-todo-api PBKDF2 断言改为格式契约（迭代次数下限）、py-csv-cli 导出断言改为契约断言；R3 正确实现不再与既有断言冲突（两仓库基线 + R3 模拟均绿）。
- **P1-10/P1-11**：删除 `/flow config` 未实现桩；删除 grep 证明零引用的死代码（私有 helper/废弃 walker 等，`rules/evaluate.ts` 保留）。
- **P2 可执行证据**：HEAD 复跑 `verify:compat` 7/7、`measure:startup` +15.1ms、`verify:uninstall` 通过；补充 MCP/未知工具守卫冒烟（R-MCP human → 负责人批准 → 单次放行）。真机/真模型/桌面/sandbox 类项在 [todo-audit](docs/impl/todo-audit-2026-10-31.md) §3.1 如实记录阻塞与复现。
- **P3 文档**：evaluation/interview/screenshots/compat/00–04/spike/cheatsheet/web-walkthrough/method-sources 口径与历史标注清理。

### Tests

- 第六轮实测：**112 files / 1522 tests** 全绿（第五轮 107/1459，+5 文件 / +63 用例）；coverage thresholds 通过（合计 86.40/76.25/86.92/89.46）；lint/typecheck 通过（130 源文件）；compat 13/13、startup +16.2ms、uninstall 通过。
- 测试规模（本轮最终提交实测）：**90 个测试文件 / 1289 个用例**全绿（约 3.5s），较 43d18e5 的 69 files / 995 tests 新增 21 files / 294 tests；新增覆盖：派发并行 27、熔断恢复 18、状态损坏 14、unittest 解析 25、覆盖率补缺 158、投影 epoch 6、PROJECT 接续 4、依赖内容判定 35、路线图首个变更 4 等。
- 故障注入 **7/7 通过**：新增 3 例（`status.json` 截断 → 宿主启动 + 锁定 + doctor 路径 + repair；`ledger.jsonl` 末行截断 → 锁定 + 行号 + repair 拒绝静默重写；`config.yaml` 语义非法 → ConfigError + 启动不受影响 + fail-closed）。
- 覆盖率（`pnpm coverage` 通过 thresholds）：core 语句 90.34% / 分支 80.16% / 函数 90.77%；host（新纳入口径）语句 74.14% / 分支 61.01%；core+host 合计 语句 86.40 / 分支 75.97 / 函数 85.96 / 行 89.53。
- 真机验证：`java-renewal` 新功能 B 组 `dispatch=auto`（`--preset-registry`）真实跑通并行批次——B1 并行 T1/T2 分别创建 `.flowgate/worktrees/C-001/T1|T2`、独立子 agent、产生验证回执，进程退出前批次停在 checkpoint（headless 一次性运行限制）；从 0 开发演练（greenfield Python 标准库）确认真实模型在 S4 的证据/熔断/恢复路径。
- 兼容/加固复验：`verify:compat` 7/7、启动增量 +12.1ms/+15.5ms（<200ms 验收线）、卸载干净度通过（保留 rc.5 `plugin remove` 不 prune node_modules 的已知残留警告）。

### Documentation

- `docs/evaluation.md`：新增 §6.5 主观指标人工评分（18/18）并修订 §6.4 结论/下一步；`docs/evaluation-data/scoring/**` 新增评分口径与机器可读结果。
- `docs/compat/0.2.1-rc.5.md`、`docs/compat/startup.md`：保留历史并追加本轮复验（7/7、+12.1/+15.5ms、卸载、未能复验项归因：`--dump-config-schema` 属 rc.5 preset 嵌套限制）。
- `docs/impl/web-walkthrough.md`（新增）与 `docs/screenshots/`（13–26 号 14 张 + README）：Web 宿主 preset 切换、面板交互、确认卡与兜底动作的真机证据。
- `README.md` / `README.en.md`：命令表新增 `/flow unblock`，风险触发器补充"熔断只拦推进动作、只读放行"；`docs/03-技术方案.md`：命令表、账本事件（`task.unblocked`）、8.2 触发器说明同步。
- `docs/impl/host-client-contract.md`：投影 wire 契约新增可选 `epoch`；`docs/impl/implementation-status.md` §3.8 记录本轮。
- 历史条目（上一轮）：测试规模 69 个测试文件 / 995 个用例（较 `e1aef8d` 的 63 files / 944 tests 新增 27 个 host 用例 + 1 个 TDD 测试路径回归 + 2 个 git 适配器回归 + 4 个故障注入用例 + 1 个并行派发范围回归 + 2 个集成检查点用例 + 11 个 util 测试用例 + 3 个命令执行器用例）。

### 早期开发快照（2026-10-30）

首个可用版本。FlowGate 把「先澄清与设计、再按执行图 TDD、用可核验证据验收、人工门放行」做成 DSH 宿主层的硬约束插件：阶段顺序、写操作范围、证据新鲜度都由代码判定，而不是提示词。

#### Added

- **7 阶段硬约束流程内核**：S0 立项/路线图 → S1 需求澄清 → S2 上下文 → S3 设计拆解 → S4 执行 → S5 验证 → S6 交付；状态机与复杂度（低/中/高/超高）× 风险（普通/高）等级矩阵；迁移表数据驱动测试；`/flow` 命令族与阶段状态条。
- **规则引擎与守卫**：数据驱动规则（`R-STAGE-SRC`、`R-SCOPE`、`R-PROTECTED`、`R-DEP` 等，可在 `.flowgate/config.yaml` 覆盖）；工具调用参数与 shell 命令分词；风险触发器（敏感路径、依赖变更、危险命令、疑似密钥、成本、范围膨胀、连续失败）；`tools/pre-execute` 异步判定 + `ctx.tools.guard` 同步缓存双保险；单次放行 `OV-n`、例外与误判反馈闭环。
- **账本与跨会话状态**：`.flowgate/` 项目目录、状态与配置；账本哈希链 + HMAC（篡改可定位到行）；会话租约与接管、交接摘要、锁定模式与 `/flow repair` 从账本和产物重建。
- **规格层**：变更目录产物（`clarify.md` / `proposal.md` / `specs/` / `context.md` / `design.md` / `risk.md` / `tasks.md`）、GR/G0–G3/G5/G6 共 46 项门禁检查（每项正反例；v0.1.0 发布时统计为 46，第五轮后 `GATE_CHECKS` 实为 52）、任务卡检查、技术栈探测、项目路线图、mermaid 执行图、可核验源码引用。
- **执行纪律**：`flow_task_start` 领取任务卡并注入上下文；范围事前控制 + shell 事后检测；TDD RED/GREEN 证据回执与输入哈希过期判定；按执行图派发（inline / subagent / auto）、git worktree 并行、集成检查点；返工失效范围；审查子 agent（宿主提供 subagents 时）。
- **交付闭环**：S5/S6 验证证据汇总、单文件离线 HTML 交付报告、跨会话 HTML 看板、M-1～M-18 指标自动计算与 CSV 导出、规则沉淀、只读分析任务与 `flow_submit_analysis`。
- **模型工具**：15 个 `flow_*` 工具（`/flow doctor` 的 `14/14` 是 tools 模块清单口径，`flow_dispatch_next` 由派发模块单独注册）；没有批准 / 放行 / 降低等级类工具——人工专属动作只能由负责人执行。
- **界面**：输入框状态条（阶段、变更、等级、风险，≤120 字符，颜色分级，点击打开面板）；右侧栏 8 视图面板（阶段卡、七阶段流程、执行图、学习模式、术语表、变更信息等），client 产物为 `window.__ModuleLoader__.load({ id, factory })` 打包。
- **内容**：15 个内置技能（每个含 `SKILL.md` + `learn.md` 教学卡，共 30 个文件，附上游方法来源追踪表）；3 个可独立构建与测试的基准仓库（`ts-todo-api` / `py-csv-cli` / `java-renewal`，含隐藏需求与越界诱饵）。
- **宿主集成**：DSH 0.2.1-rc.5 的组合 patch 与三个 agent preset（FlowGate 工程模式 / FlowGate 执行者 / FlowGate 只读取证）；`--dump-config` 可导出插件行。
- **工程与发布基线**：GitHub Actions CI（lint / test / build / verify:package）；`verify:package`（npm 包内容）、`verify:client`（浏览器 bundle 加载协议与插槽注册）、`verify:compat`（隔离 `DSH_HOME` 真实组合/导入）三个验证脚本；NFR-3 零宿主核心依赖。
- **仓库**：MIT 许可、第三方声明（含 DSH 0.2.1-rc.5 参考文档的归属）、中文/英文 README、需求/技术/执行方案、实现契约、spike 报告、真实宿主截图。

#### Changed

- **入口形态**：host 走 `main`（`lib/host.js`），浏览器半边走 `exports["./client"]`（`lib/client.js`）；client 产物是 `window.__ModuleLoader__.load(...)` 包装，模块 id 与包名一致。
- **不静态依赖宿主核心包**：`@deepseek-ai/*` 只作可选 `peerDependencies`；`appendPluginRecord` 运行时探测，缺失时投影退回 host 内存快照（NFR-3，npm 包内不含 `@deepseek-ai` 文件）。
- **注入消息来源**：所有注入给模型的 user 消息改用 DSH 已登记的 `{ kind: 'runtime-context', form: 'relay' }`，不再自造 source kind。
- **工具 schema 子集**：`output.schema` 用 `oneOf` 单类型集合表达原类型数组，`parameters` 根对象去掉 `additionalProperties` 等扩展关键字；工具返回值先做 JSON 无损往返再交给宿主。
- **会话写入**：只写 `appendPluginRecord('plugin:dsh-flowgate/state')`；删除 `session.append('plugin:…')` 降级路径，避免 rc.5 会话日志出现无语义事件而损坏；投影在记录不可用时从最新内存快照刷新。
- **委派与能力检测**：`restrict` / `presentAs` 按 agent scope 应用；受管控会话关闭原生 `subagent_fork` / `workflow` / `send_message`；真实宿主上能力标志修正为 ✓，确实缺失的能力（subagents / sessionQuery / userQuestions / Remote）在 `/flow doctor` 说明并按降级处理。
- **覆盖自检**：`ctx.tools.schemas(scope)` 的 scope key 使用 agent 对象（不是 `agent.ctx`）；真实宿主可扫描 46 个可见工具，可写工具未覆盖数为 0。
- **S6 归档规格合并**：新增纯函数模块 `src/core/archive/merge.ts`，交付时把增量规格按 ADDED / MODIFIED / REMOVED 合并进 `.flowgate/specs/<能力>/spec.md`；写入账本 `spec.merged` 事件，语义不一致警告（如 ADDED 的条目已存在、MODIFIED 的条目不存在）进入通知与账本。
- **`/flow new <描述>`**：只带标题时 summary 回退为标题，G0 通过后直接进入 S1（此前会卡在 S0）。
- **人工门与审查配置**：G5/G6 终审项尊重 `review.enabled`；关闭审查的精简宿主不再死锁，开启时仍强制要求审查记录。
- **受保护路径**：`R-PROTECTED` 不再拦截当前阶段可写的变更产物（`.flowgate/changes/<id>/**`）；插件自有状态（status / ledger / config）仍受保护。
- **baseline 解析**：新增 `node --test` 解析器（默认/规范 reporter、TAP 风格、失败用例名），Node 项目可正确建立 G2 基线。
- **仓库工程化**：`.gitignore` 的 `coverage/` 锚定为 `/coverage/`（避免误忽略 `src/host/coverage`）；移除 pnpm 11 已不读的 `pnpm.onlyBuiltDependencies`，构建白名单改到 `pnpm-workspace.yaml` 的 `allowBuilds`；账本时间戳断言改为时区无关。

#### Fixed

- client 插件在真实 Web 宿主激活失败（`web boot: 1 entry did not activate`）：不再读取未 `inject` 的 Cordis 服务，侧栏标签注册只走 `ctx.inject`。
- 输入框状态条不渲染：改为 `ctx.slots.inject('conversation.input.dock', …)` 延迟注册（该 slot 由对话 entry 的 children 表声明）。
- tools 模块的 14 个模型工具在真实宿主全部注册失败：`output.schema` 的 `type: [...]` 改为 `oneOf` 单类型集合；`parameters` 根级 `additionalProperties` 移除。
- 会话日志损坏风险：`appendPluginRecord` 不可用时不再降级 `session.append('plugin:…')`（rc.5 会将其持久化为语义不完整事件，下次加载报 `session event at seq N lacks an identified message`）。
- 模型请求全部 `TRANSPORT` 失败：注入消息的 source kind 改为官方 `runtime-context`（provider 在 fetch 前拒绝未知 kind，表现为 `DeepSeek Messages transport failed`）。
- 工具结果被宿主拒绝（`returned invalid output: value is not lossless JSON`）：所有工具返回值先 JSON round-trip。
- 真实模型 E2E 发现的 3 个阻断：`R-PROTECTED` 误伤阶段产物导致 S2 死锁、缺 `node --test` baseline 解析导致 G2 无法通过、`review.enabled=false` 时 G5/G6 终审死锁。
- 账本时间戳测试时区依赖（CI 用 UTC，开发机可能 UTC+8）。
- 公开仓库准备：README 补仓库链接、参考文档归属补充到第三方声明、开发文档中的本地绝对路径匿名化。

#### Documentation

- 中文/英文 README：定位、7 阶段与人工门、命令表、模型工具表、规则参考、15 个技能、FAQ、真实宿主界面截图，以及 CI / license / DSH-compat badges。
- [docs/impl/implementation-status.md](docs/impl/implementation-status.md)：里程碑状态、可复现验证、§3.1 真实 Web 宿主走查、§3.2 模型链路走查、§3.3 能力补齐与无模型走查、§3.4 真模型完整闭环 S0→S6、§4 已知缺口。
- [docs/impl/host-integration.md](docs/impl/host-integration.md)：隔离 profile 集成步骤、headless 真机 E2E 剧本、真实宿主踩坑记录与调试开关（`FLOWGATE_DEBUG_FETCH` / `FLOWGATE_DISABLE` / `FLOWGATE_CONTEXT_MODE` / `FLOWGATE_DEBUG_GUARD`）。
- [docs/compat/0.2.1-rc.5.md](docs/compat/0.2.1-rc.5.md)：7 项 DSH 0.2.1-rc.5 兼容验证记录。
- [docs/screenshots/](docs/screenshots/README.md)：真实 Web 宿主 11 张实拍（状态条、命令、面板、模型工具调用、doctor、单次放行、交付报告）。
- 需求规格、技术方案、执行方案、方法来源追踪表、第三方声明（DSH rc.5 参考文档 MIT 归属）、spike 报告。

#### Tests

- 测试规模（`e1aef8d` 时点实测）：**63 个测试文件 / 944 个用例**；本次提交进一步补到 **69 files / 995 tests**（见 [Unreleased]「Tests」）。注：[implementation-status.md](docs/impl/implementation-status.md) §2 记录的 61 files / 925 tests 是该报告首次成稿时的基线。
- 真实 Web 宿主走查（隔离 `DSH_HOME`，DSH 0.2.1-rc.5 + Chrome）：插件组合与加载、浏览器 bundle、`/flow` 命令族、tools 模块 14/14 工具注册（含派发模块共 15 个 `flow_*` 工具）、状态条/面板、preset 菜单、自动接续、宿主能力检测。
- 守卫真机证据：真实 headless 会话中 agent 对 `src/server.js` 的 `edit` 被 `R-STAGE-SRC` 拦截，文件未被修改，模型收到完整拒绝原因与解锁路径（debug trace + 账本可查；此前一次「放行」经查为上一轮遗留的单次放行 `OV-1`）。
- 真实模型完整闭环：在 `ts-todo-api` 上以 C-002 从 `/flow new` 走到 S6 归档——G1 7/7、G2 真实 baseline 34/34、G3 9/9、G4 任务门、G5 全量测试/场景/运行证据、G6 批准；产出 116KB HTML 交付报告，主规格按 R1–R5 合并（账本 `spec.merged`）。API key 经环境变量注入隔离 home，未提交。
- `verify:package`（HEAD 实测）：npm 包 39 个文件 / 845.0KB，含 `lib/host.js`、`lib/client.js`、`skills/**/*.md` 与 `cordis.patch.yml`，不含 `@deepseek-ai` 或开发文件；`verify:client` 离线验证 loader 协议与两段式侧栏注册；`verify:compat` 7/7 通过。
- CI：`.github/workflows/ci.yml` 在 push/PR 上跑 lint / test / build / verify:package；HEAD `e1aef8d` 的 `build` check 为 success。
- 回归测试覆盖真实宿主发现的问题：严格 Cordis 上下文、不得调用 `session.append` 的不变量、`appendPluginRecord` 路径、工具 schema 与无损 JSON、`node --test` baseline、归档规格合并、时区无关断言、G5/G6 审查配置。

#### Known gaps

> **历史摘要（`[0.1.0]` 时点，截至 HEAD `e1aef8d`）**，不是当前状态；**当前缺口以 [docs/impl/implementation-status.md](docs/impl/implementation-status.md) §4 为准**。以下条目多已在 2026-10-31 后续轮次关闭，保留原文 + 关闭说明：

- ~~有/无插件对照评测（M6 / T6.1）未执行~~ → 已执行 18/18 run + 4 项主观指标人工评分 18/18（单次/单人、不可外推；见 evaluation §6）。
- ~~三个 agent preset 在真实会话中的切换验证未完成~~ → 会话内切换已真机验证；persona/工具集运行时差异仍需真模型会话观察（见 implementation-status §4）。
- ~~浏览器内人工交互流程（Remote 兜底、低复杂度确认卡）未走查~~ → 已在真实 Web 宿主走查（14 张新增截图，25 张总计）；真实拦截→面板→误判反馈仍是组件级。
- 审查 / 派发 / 并行 worktree 的完整真机验证依赖提供 subagents 的宿主组合：顺序派发已真机结算到 S5；并行批次真实启动但 headless 一次性运行未完成合并结算（仍开放）。
- `appendPluginRecord` 属实验性 API，DSH 升级可能失效：每个 RC 需跑 `verify:compat`（仍开放）。
- ~~核心逻辑覆盖率低于 80% 目标~~ → thresholds 已入 `vitest.config.ts` 并在本地/CI 通过（数值口径见 implementation-status §2）。
- npm 首发与 GitHub Release 尚未执行：发布决策仍待负责人（发布项，非功能缺口）。

[Unreleased]: https://github.com/ChthollyWn/dsh-flowgate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ChthollyWn/dsh-flowgate/releases/tag/v0.1.0
