# 实现状态报告（v0.1 交付时点，第六轮独立复验修复后）

> 日期：2026-10-31（第六轮：独立只读复验发现接线缺口后逐项修复；第五轮记录见 §3.11 与 [acceptance-gap-audit-2026-10-31.md](acceptance-gap-audit-2026-10-31.md)）。基线：DSH `0.2.1-rc.5`。对应执行方案：[docs/04-执行方案.md](../04-执行方案.md)。
> 第六轮代码修复提交：`cea85dd`（`fix: sixth-round cleanup — wire acceptance gaps found by independent audit`）；第六轮文档/物料改动随本轮文档提交（文档提交哈希见 git log）。
> 本报告按里程碑说明**已完成 / 部分完成 / 未开始**，并给出可复现的验证命令。功能状态的对外表述以本文件为准；当前剩余项以 §4 为准，门禁数字以 §2 为准。

## 1. 总览

| 里程碑 | 计划内容 | 状态 | 说明 |
|---|---|---|---|
| M0 预研与脚手架 | 隔离开发 profile、探针、工程化 | ✅ 完成 | 26 条假设实测；spike 在隔离 `DSH_HOME` 真实加载；pnpm+TS+tsdown+vitest+CI 就绪 |
| M1 门禁内核、项目目录与工程模式 | 状态机、规则引擎、账本、守卫、命令、状态条 | ✅ 完成 | 迁移表数据驱动测试；守卫双保险；账本哈希链 + HMAC；契约冻结（判定快照）与产物冻结接线；`/flow` 命令族与 15 个 `flow_*` 工具（派发模块另有 `flow_dispatch_next`，共 16） |
| M2 规格层 | 产物检查、澄清/上下文/设计/拆解、路线图、执行图、引用 | ✅ 完成 | 52 项门禁检查（每项正反例）；G3 等待批准即物化执行图；路线图状态回写与立项继承；引用哈希待复核；技能回执（第五轮补）；澄清占位符检查与低复杂度任务数上限（第六轮补，§3.12） |
| M3 执行纪律与跨会话接续 | 范围/TDD/证据/审查/风险/接续/返工 | ✅ 完成 | 验证由插件执行、输入哈希过期；接管后旧会话写拒绝（R-LEASE）与接续快照对比；篡改检测；返工失效；evidence.md/review.md（第五轮补） |
| M4 交付闭环、工程判断、派发、上下文 | S5/S6/指标/派发/压缩/交接/并行/分析 | ✅ 主体完成 | `run: main` 路由、检查点修复任务与重试、计划修订、S5 回退、终审生产者、run/health 运行证据、风险提高效应、检查点任务验证+全量测试已闭环（第五轮补）；第六轮补：并行 worktree 执行根、S5 `runFullSuite` 回归判定、跨会话任务卡注入与压缩重注入、派发双结算防护（§3.12）；真实并行合并结算仍受 headless 环境限制（§4.1） |
| M5 可视化与学习 | 面板 8 视图、阶段卡、HTML 报告、看板 | ✅ 完成 | 真实 Web 宿主走查 25 张截图；第五轮补：规则统计用实际生效规则、例外可撤销、非 agent 改动确认、GREEN 过期按输入哈希、看板随状态重生成、report/board 尝试系统打开；第六轮补：执行图节点可点击 + 任务详情；规则试跑为客户端本地近似（尊重 off/locked/实际规则 decision/生效例外），固定标注精确判定以宿主实际拦截为准，本地无法判定的项目自定义规则会列出（§3.12） |
| M6 评测、加固与发布 | 基准评测、故障注入、兼容矩阵、文档发布 | 🟡 主体完成 | 对照评测 18/18 + 4 项主观指标评分完成；第六轮本地门禁全绿：**112 files / 1522 tests**、coverage thresholds 通过（合计 86.40/76.25/86.92/89.46）、compat **13/13**、startup **+16.2ms**、uninstall 通过；CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) 已成功。**npm `dsh-flowgate@0.1.0` 已于 2026-10-31 发布**（本地 `npm publish`，无 provenance；隔离 `DSH_HOME` 安装验证通过）；GitHub Release 待补建；Desktop 未走查 |

## 2. 可复现验证（截至本报告）

```bash
pnpm install
pnpm lint        # 分层规则（core 不得依赖 DSH/host/client）+ tsc --noEmit
pnpm test        # 112 个测试文件 / 1522 用例（2026-10-31 第六轮实测）
pnpm build       # lib/host.js（ESM）+ lib/client.js（loader 包装）
pnpm coverage    # 覆盖率 + thresholds（core+host 口径）
pnpm verify:client
pnpm verify:package
DSH_HOME=/tmp/fg-home node scripts/verify-dsh-compat.mjs --profile flowgate --write
# 真实 DSH 进程组合并导入插件（隔离 DSH_HOME，不碰日常 profile）：
DSH_HOME=/tmp/fg-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile flowgate --dump-config
```

最近一次结果（2026-10-31 第六轮，代码提交 `cea85dd` + 文档提交；全部为当前工作树实测）：lint + typecheck 通过（130 个源文件）；`test` **112 files / 1522 tests** 全绿（第五轮 107/1459，本轮 +5 文件 / +63 用例）；`pnpm coverage` 通过 thresholds（80/80/80/70）：合计 **86.40 / 76.25 / 86.92 / 89.46**（语句/分支/函数/行），core 83.42 / 69.26 / 82.59 / 88.48，host 74.09 / 65.71 / 70.00 / 78.20；构建产物 `lib/host.js` **1,210,648 B（≈1.21MB）** / `lib/client.js` **223,830 B（≈219KB）**（build-client 打印的 211.4KB 是 JS 字符串长度，不是文件体积）；`verify:package` **39 文件 / 1032.9KB**（docs 修改后重跑实测，含 README）；`verify:client` 通过。本 HEAD 复跑：`verify:compat` **13/13**（隔离 `DSH_HOME=/tmp/fg-audit-env` 的 profile + `link:` 安装，新构建；`--dump-config` 1314 行）、`measure:startup` 中位数增量 **+16.2ms**（基线 16.5ms / 加载 32.6ms，验收线 <200ms）、`verify:uninstall` 全部通过（已知 rc.5 `plugin remove` 不 prune node_modules 警告）。**第六轮提交已推送，CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) success。**

上一轮结果（2026-10-31 第五轮，代码提交 `6e3bd24` + 文档提交，保留以便追溯）：lint 通过（130 个源文件）；`test` **107 files / 1459 tests** 全绿；构建产物 host 约 1.20MB（1,196,501 B）/ client 约 202KB（202,243 B）；`verify:package` 通过（**39 文件 / 1015.9KB**）；`verify:client` 通过。`pnpm coverage` 通过 thresholds（80/80/80/70）；文本报告聚合：core 82.97 / 68.50 / 81.51 / 88.15、host 73.76 / 65.10 / 70.00 / 77.82、合计 86.19 / 75.84 / 86.60 / 89.29。本 HEAD 复跑：`verify:compat` **13/13**（隔离 `DSH_HOME=/tmp/fg-final-home` 的 profile + link 安装；含 6 项离线结构检查）、`measure:startup` 中位数增量 **+15.8ms**、`verify:uninstall` 全部通过（已知 rc.5 `plugin remove` 不 prune node_modules 警告）。

> 注：`pnpm verify:package` 在 `~/.npm` 不可写的沙箱环境里会把 npm cache/logs 固定到系统临时目录（2026-10-31 修复）；`verify:compat` 的 `--dump-config-schema` 在 rc.5 上因宿主自带 preset 行同样报错，不作为本插件的兼容判据（见 [compat/0.2.1-rc.5.md](../compat/0.2.1-rc.5.md)）。

## 3. 关键实现决策（与 03 方案的差异）

1. **入口形态**：package.json 无 host/client 入口字段；host=`main`（`lib/host.js`），client=`exports["./client"]`（`lib/client.js`），client 产物是 `window.__ModuleLoader__.load({id, factory})` 包装。见 [dsh-plugin-api-cheatsheet](dsh-plugin-api-cheatsheet.md) §2–§4。
2. **零宿主核心依赖**：host 不静态 import `@deepseek-ai/*`；`appendPluginRecord` 运行时探测，不可用时投影只在内存（latest-snapshot 兜底），**绝不**降级写 `session.append`（会损坏 rc.5 会话日志），doctor 可见。因此包不把宿主核心包带进依赖树（NFR-3）。
3. **投影 stateSchema**：rc.5 只调用 `.parse()`，用本地 passthrough schema，不引入 zod。
4. **面板动作**：Typert Remote 需要构建期生成器，v0.1 不做；按钮走"把 `/flow …` 填进输入框"的兜底（人工动作只允许人触发）。doctor 会标注降级。
5. **会话事件**：`session.append` 不能写任意类型，改用 `appendPluginRecord('plugin:dsh-flowgate/state')`（实验性逃生舱，可丢弃记录语义）。
6. **守卫**：`tools/pre-execute`（async 判定）+ `ctx.tools.guard`（sync 消费缓存）双保险；判定缺失/异常时受管控会话 fail-closed、未初始化会话放行。
7. **测试输出压缩**：post-execute 替换后 durable 日志即替换内容，所以全文先写 `.flowgate/state/evidence/<id>.log`。

## 3.1 真实 Web 宿主端到端走查（2026-10-30，P0-1）

在隔离 `DSH_HOME` 的 `flowgate-dev` profile 里用真实 DSH 0.2.1-rc.5 web 宿主 + Chrome（playwright-core）走查，**日常 desktop profile 哈希前后一致**。结论：

| 项 | 结果 |
|---|---|
| 插件组合与加载 | ✅ 组合树含 `dsh-flowgate` 行 + 3 个 preset；web 宿主启动无 `did not activate` |
| 浏览器 bundle | ✅ 启动图加载 `dsh-flowgate/client.js`（combo HTTP 200），client 插件 `apply` 成功 |
| `/flow` 命令族 | ✅ `/flow status`、`/flow init`、`/flow doctor`、`/flow new` 在真实会话中执行，输出渲染在会话里 |
| `/flow init` 产物 | ✅ 在示例仓库生成 `.flowgate/`（config.yaml、project.md、state、目录内 `.gitignore` 等） |
| 模型工具 | ✅ 修复后 **14/14 注册成功**（doctor 可见工具清单） |
| 输入框状态条（历史，v0.2 已被图形化 dock 取代） | ✅ dock 渲染 `◆ FlowGate …`，≤120 字符、颜色分级、点击可打开面板 |
| 右侧栏面板 | ✅ 两段式注册生效；8 视图标签、学习模式、七阶段流程、阶段卡与术语表渲染正常；有变更时显示变更编号/标题/等级 |
| 会话投影 | ⚠️ 隔离 home 里 `appendPluginRecord` 不可解析 → 走 host 内存快照兜底（正常安装时走插件记录） |
| 模型调用 | ⚠️ 隔离 demo home 的凭据是引用式，`DeepSeek Messages transport failed`；工具调用/守卫拦截需要桌面会话或有效 API key 才能端到端演示 |

**本轮走查发现并修复的真实问题（均已加回归测试）：**

1. **client 插件激活失败**（`web boot: 1 entry did not activate`）：Cordis 上下文禁止读取未 `inject` 的服务，client 的侧栏快速路径直接读 `ctx.sidebarRightTabs` 抛错。改为只走 `ctx.inject`，并新增"严格 Cordis 上下文"回归测试。
2. **dock 状态条不渲染**：`conversation.input.dock` 由对话 entry 的 children 表声明，插件 apply 时尚未声明。改用 `ctx.slots.inject('conversation.input.dock', …)` 延迟注册（与官方 UI 插件同一写法）。
3. **14 个模型工具全部注册失败**：`ctx.tools.register` 只接受受支持 JSON Schema 子集，原 `output.schema` 用了类型数组（`type: [...]`）。改为 `oneOf` 单类型集合，全部注册成功。
4. **会话日志损坏风险**：`appendPluginRecord` 不可用时曾降级 `session.append('plugin:…')`，rc.5 会把它持久化成语义不完整的事件，下一次加载报 `session event at seq N lacks an identified message` 并使会话损坏。已删除该降级路径（只写插件记录；不可用则投影退回内存快照），并对插件记录做 JSON 无损化。
5. **投影兜底**：新增 latest-snapshot 兜底——任意已提交事件都从 host 内存最新投影刷新，不依赖实验性记录 API。

复现脚本与截图见 [screenshots/](../screenshots/README.md)。走查用的 demo workspace 在 `~/Developer/WorkSpace/dsh-flowgate-demo/`（可删除）。

## 3.2 模型链路走查（2026-10-30 晚，P0-2）

> 历史轮次记录：本节「本轮未完成」事项（真实宿主守卫拒绝演示、restrict/presentAs、能力标志误报）已在 §3.3/§3.4 后续轮次闭环；保留原文用于追溯。

用真实 DeepSeek API Key（只写入隔离 `DSH_HOME=/tmp/fg-demo-home` 的凭据存储，未进仓库、未提交；已删除）继续在真实 Web 宿主走查，发现并修复 3 个会阻断模型链路的真实问题：

1. **模型请求全部 `TRANSPORT` 失败（根因：注入消息的 source kind）**：host 用 `source: { kind: 'flowgate' }` 注入 user 消息；DSH 的 MessageSource 是 merge-extensible 的封闭登记表，provider 在组装请求时对未知 kind 抛错（在 `fetch` 之前），被 provider 包装成 `DeepSeek Messages transport failed`。逐层定位方式：给插件加 `FLOWGATE_DEBUG_FETCH=1` 的 fetch 追踪（记录请求/响应），发现主请求根本没到网络、只有标题请求到达；再用 `FLOWGATE_DISABLE=session,context` 二分确认是注入消息。修复：所有注入消息改用官方 `runtime-context` kind（`{ kind: 'runtime-context', form: 'relay' }`）。
2. **工具结果 `returned invalid output: value is not lossless JSON`**：`flow_status` 等工具把含 `undefined`/类实例的 snapshot 直接作为运行时值返回；DSH 在渲染 content 前校验 JSON 无损。修复：所有工具返回值先做 JSON round-trip（`toLosslessJson`），并加单测。
3. **工具参数 schema 的根级扩展关键字**：`parameters` 根对象曾带 `additionalProperties: true`；官方 `ctx.tools.register` 只接受受支持子集，去掉扩展关键字、保留 `type/properties/required`。
4. 顺带修复：`/flow new <描述>`（只带标题）此前 G0 因"一句话目标为空"卡在 S0；现在 summary 缺省回退为标题，立项即进入 S1。

**本轮实测通过：**
- 模型可正常调用（DeepSeek-V4.1-Flash，经 API Key provider），主请求带 46 个工具、HTTP 200、无 transport 错误；
- `flow_status` 工具调用成功并把当前快照返回给模型（模型复述了 `initialized/stage/nextStep` 等字段）；
- `/flow init`、`/flow new`（C-001 → S1）、`/flow allow-once R-STAGE-SRC`（OV-1）在真实会话执行并留痕；
- `/flow doctor`：**工具 14/14 已注册**、守卫心跳 3 次调用/3 次判定、会话投影 ✓、`appendPluginRecord` ✓（devDependency 让隔离环境也能解析 peer）、会话租约与接管提示正常。

**本轮未完成（下一步）**：
- 真实宿主里"FlowGate 守卫拒绝 S1 写操作"的端到端演示：本次两次尝试都被 DSH 自身的"先读后写"文件策略或会话租约挡住（`/flow resume` 需 `--takeover`），没有真正走到 FlowGate 的 R-STAGE-SRC 判定；守卫规则本身由 host fake-ctx 与 core 单测覆盖。下一步：takeover 后先 read 再 edit，观察 `R-STAGE-SRC` 拒绝与 `allow-once` 放行。
- `restrict`/`presentAs` 仍显示 ✗（scoped-only，应在 `agent/created` 的 agent ctx 上应用，H26 待补）；
- `agent 生命周期事件` 能力标志 ✗（实际 `agent/created` 已在用于会话注入，属检测标志误报，待修）；
- `subagent/sessionQuery/结构化提问/Remote` 在该精简 web 组合未启用（按降级处理）。

## 3.3 能力补齐与无模型走查（2026-10-30 深夜）

这一轮不需要真模型，在真实 Web 宿主（隔离 home + 一个**占位 API Key** 仅用于解锁 UI，未发起模型调用）验证并修复：

| 项 | 结果 |
|---|---|
| 预设选择器 | ✅ 菜单中出现 **FlowGate 工程模式 / FlowGate 执行者**（`docs/screenshots/09-preset-menu.png`；reviewer 只给审查子 agent 用，不在主会话菜单） |
| 自动接续（H23） | ✅ 打开页面即显示 `◆ FlowGate C-001 中 · 普通风险 │ ① 需求澄清`（无活动会话租约时自动附着，无需命令） |
| H26 关闭原生委派 | ✅ `restrict`/`presentAs` 能力标志变 ✓；真实宿主日志：**已关闭 subagent_fork、workflow、send_message** |
| 宿主能力检测 | ✅ `restrict` / `presentAs` / `agent 生命周期事件` 由 ✗ 修成 ✓；仍然缺失的 `subagents`/`sessionQuery`/`userQuestions`/`Remote` 在 doctor 里带"该宿主组合未提供/按降级处理"说明 |
| 覆盖自检（03 §4.3） | ✅ 修复 tool scope 用法：`schemas(scope)` 的 scope key 是 **agent 对象**（不是 agent.ctx）；真实宿主扫描到 46 个可见工具、已覆盖可写工具 4 个/未覆盖 0 |
| 归档主规格合并（T4.4） | ✅ 新增纯函数 `src/core/archive/merge.ts` + 7 个单测；S6 归档时按 ADDED/MODIFIED/REMOVED 合并进 `.flowgate/specs/<capability>/spec.md`（能力名优先取路线图能力，否则用标题），有警告时进通知与账本 `spec.merged` |

**这轮仍没解决 / 需要真模型**：
- 「S1 写操作被 R-STAGE-SRC 拒绝」的真实宿主证据仍缺：需要真模型发起 `edit` 工具调用（上一轮用真 key 时被自身流程说明、DSH 读后写策略和会话租约挡住）。下一步用 `--takeover` + 先 read 再 edit 做。
- 真实 S0→S6（java-renewal）仍需真 key。
- 派发/并行/审查子 agent 在本精简 web 组合里 `subagents` 未提供，需要带 provider 的组合或桌面会话再验。
- 覆盖自检数值会随扫描时机在 4–7 之间波动（扫描发生在工具注册过程中）；正确性已保证（未覆盖始终 0），显示口径待稳定。

> **后续状态（2026-10-31 晚补记）**：上面前三项已在后续轮次闭环——「S1 写 `src/server.js` 被 `R-STAGE-SRC` 拒绝」的真机证据见 §3.4「守卫真机证据」；`java-renewal` 真实 S0→S6 见 §3.5（C-001）；派发/审查子 agent 见 §3.7（单任务 worktree + 审查真机）与 §3.8（顺序派发完整结算到 S5），仅「并行批次合并结算」仍受 headless 一次性进程限制（§4 #3）。覆盖自检数值波动已由第四轮 P1-8 修复（tools/change 100ms trailing debounce + doctor/status 读取兜底，见 §3.10）。

## 3.4 真模型完整闭环 S0→S6（2026-10-30 深夜，C-002）

用真实 DeepSeek API Key（通过环境变量注入，不落仓库；隔离 `DSH_HOME` + 新建 `fg-headless` headless profile）在 `ts-todo-api` 上跑完**从立项到交付归档的完整闭环**：

| 阶段 | 证据 |
|---|---|
| S1 需求澄清 | 真模型写 clarify/proposal/specs，`flow_submit G1` 7/7 检查通过 → awaiting → 负责人 `/flow approve`（管理员 CLI） |
| S2 上下文 | 真模型写 context.md；`flow_submit G2` 通过（含真实 baseline：`pnpm test` 34/34） |
| S3 设计拆解 | 真模型写 design（方案对比/推荐/数据流/错误处理）、risk（五类）、tasks（任务卡+执行计划），`flow_submit G3` **9/9 通过** → 负责人批准 |
| S4 执行 | 真模型按任务卡实现分享功能并补测试（scope 内），`flow_verify` + `flow_task_done` → G4 passed，自动进 S5（自动提交因 demo 目录非 git 降级，符合预期） |
| S5 验证 | `flow_submit G5`：全量测试（34 基线无回归）、lint/build（未配置）、场景证据、运行证据、终审（review.enabled=false）全部通过 → 自动进 S6 |
| S6 交付 | `flow_submit G6` 全部检查通过 → 负责人批准 → **归档 + 116KB HTML 交付报告 + 主规格合并** |

产物（真实 demo 仓库，非测试 fixture）：
- `.flowgate/archive/2026-10-30-C-002/`：全部产物 + `report.html`（含 M-1~M-18 指标）、status.json；
- `.flowgate/specs/给待办列表增加分享功能/spec.md`：R1–R5 按 ADDED 合并（账本 `spec.merged` 事件，无 warning）；
- `.flowgate/changes/index.md`：C-002 已交付并链接报告。

**守卫真机证据（headless）**：C-001 S1 时 agent 真实调用 `read` + `edit` 改 `src/server.js`，被 `R-STAGE-SRC` 拦截；debug trace：`action kind=write path=src/server.js → effect=deny rule=R-STAGE-SRC → sync-guard cache=deny`，文件未被修改，模型收到完整拒绝原因与解锁路径。此前一次"放行"经查是消耗了上一轮遗留的**单次放行 OV-1**（账本 `override.used` 可证），语义正确。

**本轮真机发现并修复的 3 个缺陷（都已回归测试）**：
1. `R-PROTECTED` 误伤当前阶段产物（`.flowgate/changes/<id>/context.md` 被拦，导致 S2 无法推进）：现在当路径属于当前阶段可写产物时跳过保护，插件自有状态（status/ledger/config）仍受保护。
2. baseline 解析缺 `node --test`：`ℹ tests 34 / ℹ pass 34` 无法识别，G2 baseline 判失败；新增 `node-test` 解析器（默认/规范 reporter + TAP 风格 + 失败用例名）。
3. G5/G6 终审项无条件要求 review 记录：当 `review.enabled=false`（无 subagents 的宿主降级或负责人关闭）时死锁；现在尊重配置并放行，配置开启时仍强制要求。

**新增开发工具**：`src/dev/admin.ts` → `tools/admin.js`（不随包发布），用于 headless E2E 的负责人操作（approve/reject/resume/pause/new/status/doctor）。这是 dev tooling，`tools/` 已 gitignore、不在 `verify:package` 清单。

## 3.5 java-renewal 真模型 S0→S6 + host 单测补齐（2026-10-31 凌晨，C-001）

在 `examples/java-renewal` 的副本（git init + 基线提交，隔离 `DSH_HOME=/tmp/fg-demo-home` 的 `fg-headless` profile）上用真实 DeepSeek key 跑完 S0→S6。key 只经环境变量注入、未落仓库。headless 组合缺 `agentPresets` 服务，用 `--patch` overlay 补 `@deepseek-ai/dsh-agent-preset-registry`（`default: flowgate`）后 preset 行激活。

| 阶段 | 结果 |
|---|---|
| S1 需求澄清 | G1 经 3 轮修复后通过（首轮失败项：`g1.scenarioCoverage`、`g1.factsCitations`；模型按 status.json 失败项补场景与 `文件:起止行` 引用，插件逐行核验原文）；负责人 `/flow approve G1` |
| S2 上下文 | `flow_submit G2` 通过；baseline 回执：JUnit XML 20/20，真实 `./mvnw -B test` |
| S3 设计拆解 | G3 通过（低复杂度快车道：G3 与 G1 合并确认）；design/risk/tasks 三件套生成 |
| S4 执行 | `flow_verify` 回执 E-0002：41/41 通过（基线 20 + 新增 21 用例，含 `DiscountCalculator` 与 `RenewalDiscountTest`）；G4 任务门通过 → 自动进 S5 |
| S5 验证 | 首轮因 `g5.lintBuild` 失败：配置的 `./mvnw -B -DskipTests package` 在此沙箱写 `~/.m2` 被拒（插件只自动跑全量测试，build/lint 回执需命令自身可执行）；负责人把 build 改为 `./mvnw -B -DskipTests compile` 后 G5 通过 |
| S6 交付 | G6 通过 → 归档，`spec.merged` added R1–R5、无 warning |

产物（真实 demo 仓库，非 fixture）：`.flowgate/archive/2026-10-31-C-001/report.html`（128KB，M-1～M-18）、`.flowgate/specs/给已有续费增加优惠叠加/spec.md`、`.flowgate/metrics/C-001.json`；账本事件：7 次 `gate.passed`、6 次 `gate.failed`（重试留痕）、5 次 `gate.approved`、11 次 `verify.receipt`、1 次 `spec.merged`。

**本轮真机发现并修复（均已回归/记录）**：
1. **审查子 agent 无法启动**（已复验修复）：`cordis.patch.yml` 的 reviewer preset 里 `reviewer-tool-fs-search` 缺少 rc.5 必填配置 `sampleOverCapGlobResults`，报 `invalid config: $.sampleOverCapGlobResults missing required value`；审查重试 1 次后仍失败，任务门标记"审查缺失"。补 `sampleOverCapGlobResults: false` 后，第二个变更 C-002 的真实审查子 agent 成功启动并产出审查记录（详见下方"审查真机验证"）。
2. **`flow_dispatch_next` 结构化 data 的 worktree 为空**：并行批次里回填的是派发前 envelope 快照，实际 worktree 由 `startExecutor` 创建。已修 `src/host/dispatch/index.ts`（回填 `started.worktree`），并补单测断言。
3. **G5 的 build/lint 回执依赖命令可执行环境**：插件只自动跑全量测试；配置了 build/lint 命令时需在 S4/S5 通过验证组或 `attach_evidence` 收集回执（或把命令配置成沙箱内可执行的等价命令）。已记入 [host-integration.md](host-integration.md) 的 E2E 坑位。
4. **headless 一次性运行没有交互通道**：无审批回答器、macOS sandbox-exec 在受限环境不可用，agent 侧 shell 不可用；插件自身的命令执行不受影响（`flow_verify`/G2 baseline/G5 全量测试均正常）。负责人操作用 `tools/admin.js` 驱动。
5. **归档后变更编号被复用**：归档把 `.flowgate/changes/C-001/` 移出后，状态列表里不再有 C-001，`nextChangeId` 只扫当前列表 → 新建变更又分配了 C-001，账本出现两条 `change.created` C-001、变更台账被覆盖。已修：编号分配同时读取 `.flowgate/archive/<日期>-<id>/` 里的历史编号（`Engine.archivedChangeIds()`），并新增 engine 集成回归测试（归档后新建必须是 C-002）。
6. **`structured_output` 被误判为 MCP/未知写工具**：headless/结构化输出场景里 agent 会调用 `structured_output` 提交最终答案，覆盖自检把它归为"未知可写工具"并触发 `R-MCP` 待处理项（RK-1），任务门被人工项阻塞。已修：`src/core/rules/toolclass.ts` 把 `structured_output` 列入安全宿主工具（只读语义），并补单测；`tools/admin.js` 增加 `pending <id> approve|reject [理由]` 负责人命令（dev tooling，模型仍无审批工具）。
7. **`R-TDD-ORDER` 在 Java 测试路径上死锁**：任务卡 `tests` 里 agent 写成裸类名（如 `RenewalPageQueryTest`）而非路径/glob 时，`matchAnyGlob(task.tests, target)` 失配 → 写 `src/test/java/**/XxxTest.java` 也被 `R-TDD-ORDER` 拒绝；而 RED 回执只能由测试文件产生，形成死锁（真机：`seq 228/232/237` 连续拒绝）。已修：`evaluate.ts` 增加常见测试路径识别（`/test/`、`*.test.ts`、`*Test.java`、`test_*.py` 等）作为 `task.tests` 的后备判定，并补回归测试。
8. **git 自动提交恒失败**：`NodeGit.add` 生成 `git add -- -A`，`-A` 被当成 pathspec → 自动提交永远失败（任务门只能"降级提示"，评测 B 组也复现）。已修 `buildAddArgs`（选项在 `--` 前）并新增 `test/host/node-git.test.ts`。

**审查真机验证（C-002，`续费记录查询接口增加分页`）**：同一 java-renewal 副本上新建 C-002（`review.enabled=true`、`requireForTaskGate=false`、任务卡 `tdd: required`），模型先写测试 → `flow_verify` RED → 实现 → GREEN → `flow_task_done`：

- RV-1（无代码 diff 时）：审查子 agent 真实启动；因读取覆盖不足返回 `changes-required / coverageOk=false`，账本 `review.coverage_failed` + `review.reported` 留痕（本次不消耗审查轮次）。
- RV-2（实现完成后，diff 指纹 `d1e9bd86…`）：审查子 agent 再次启动，`coverageOk=true`，返回 **5 条带 文件:行号 的 findings**（verdict `changes-required`）：测试桩在反射失败时兜底返回空页导致 RED 不可能红、无参 `orders()` 与契约不符、控制器 try 包裹过宽会吞掉服务端异常、`RenewalPage` 落点与设计不符且未校验 pageSize、`memberId=" M "` 未 trim 的边界；账本 `review.reported` 可查。

**host 单测补齐**：新增 `test/host/dispatch.test.ts`（11 例）、`test/host/review.test.ts`（14 例）与 `test/host/node-git.test.ts`（2 例，自动提交参数回归）；`test/host` 85 → 112 例，全仓 63 files/944 tests → **67 files/976 tests**（另含 TDD 测试路径回归 1 例、故障注入 4 例）。

**对照评测完整矩阵（2026-10-31）**：9 任务 × A/B 共 **18/18 run** 已跑完（双流并行、真实模型、隔离 headless），原始数据在 `docs/evaluation-data/`，结果表与结论见 [evaluation.md](../evaluation.md) §6.2/§6.4。诚实结论：B 组回归通过数与 A 相同（7/9），验收 2/3 vs A 3/3，但多 2–20 倍耗时与 1–3 次人工门；有 2 个 B 更差的反例、2 个两者都红；本机 sandbox 不可用使 A 组无法自测，正式结论需在可执行 sandbox 重跑并人工补 4 项主观指标。

**对照评测 pilot（2026-10-31）**：用 `scripts/run-evaluation.mjs` 在 `ts-todo-api / fix-bug` 上跑 A/B 各 1 次：A 26s/0 门/1 轮，B 363s/3 次人工门/3 轮；两种条件回归 34/34、验收 4/4 全绿。pilot 同时发现基准 fixture 断言错误（R2 期望值与倒序契约矛盾）与 git 自动提交 bug，均已修复。原始数据与局限见 [evaluation.md](../evaluation.md) §6.1。

**本轮未完成**：派发/并行 worktree 的完整真机结算（headless 一次性运行在子 agent 结算前退出，需要交互式会话或常驻宿主）；有/无插件完整 9 任务 × 2 条件对照评测与从 0 开发演练（pilot 1/9 已完成，见 §6）。审查链路已真机跑通并产出结构化 findings。

## 3.6 T6.2 加固与兼容验证（2026-10-31）

> 历史记录（第二轮）。当前 HEAD 的启动/兼容/卸载复跑数字见 §2 与 [compat](../compat/0.2.1-rc.5.md)（第六轮：compat 13/13、startup +16.2ms、uninstall 通过；第五轮为 +15.8ms，历史保留）。

| 项 | 结果 | 证据 |
|---|---|---|
| 故障注入 | ✅ 4/4 | [test/fault-injection/host-resilience.test.ts](../../test/fault-injection/host-resilience.test.ts)：账本篡改→锁定+拒写+repair 拒绝静默重建；守卫抛错→fail-closed；宿主服务全缺失→apply 不抛错、能力 inert；配置损坏→带路径/行号 ConfigError |
| 启动耗时增量 | ✅ **+14.2ms**（验收线 <200ms） | `pnpm measure:startup` → [compat/startup.md](../compat/startup.md)。口径：新 Node 进程加载 `lib/host.js` 与空进程的中位数差（模块加载成本，不含 Electron/UI 启动） |
| 安装 / 卸载干净度 | ✅ 通过 | `pnpm verify:uninstall`：隔离 headless profile 安装→卸载后组合树/依赖/bundles 均不含插件，profile 内无 `lib/`、`skills/`、`.flowgate/` 残留。**已知残留**：DSH rc.5 的 `plugin remove` 不 prune `node_modules`（软链仍在，删 profile 或重跑 `pnpm install` 清理），脚本以警告如实报告 |
| 兼容矩阵 | Web ✅ / headless ✅ / Desktop ⏳ | Web 走查见 §3.1；headless 真机见 §3.4/§3.5；Desktop 需人工桌面会话走查（未自动化） |

**新增脚本**：`scripts/measure-startup.mjs`（启动增量）、`scripts/verify-uninstall.mjs`（卸载干净度）；均只操作临时/隔离目录，绝不使用进程里的真实 `DSH_HOME`。

## 3.7 派发 / worktree 真机验证（2026-10-31，C-003/C-004）

目标：在真实 headless 宿主里用 `flow_dispatch_next` 跑并行批次，验证 worktree 创建、子 agent 启动、任务门/审查/集成检查点结算。

**C-003（第一轮，发现两个真机缺陷）**

- 派发成功：`batch.started B1`、`task.started T1/T2 mode=parallel`，两个执行者子 agent（`flowgate-exec-T1/T2`）真实启动并分别结算（最终 T1=done、T2=failed）。
- **缺陷 A：worktree 分支 D/F 冲突**。变更分支是 `flowgate/C-003`，任务分支按 `flowgate/C-003/T1` 命名，git 不允许 `refs/heads/flowgate/C-003` 与 `refs/heads/flowgate/C-003/T1` 共存 → `git worktree add` 失败并被静默降级为主工作区（日志只有 feature note）。已修：任务分支改用兄弟命名空间 `flowgate-tasks/<changeId>/<taskId>`（`taskWorktreeBranch`），worktree add/merge/cleanup 三处统一，并补单测断言。
- **缺陷 B：worktree 内写操作路径归一错误**。执行者 cwd 是 worktree，但守卫把绝对路径相对**主仓库根**归一，路径变成 `.flowgate/worktrees/C-004/T2/src/...`，随即被 `R-PROTECTED`（插件状态）拒绝；即使通过也会被 `R-SCOPE` 判越界。已修：`buildCallerInfo` 把 worktree 转绝对路径，`normalizeActionPath` 以 caller.cwd 为基准归一（主会话仍用仓库根），并补 2 个守卫回归测试（worktree 内路径 → `src/...`；worktree 外路径保持绝对交范围规则）。

**C-004（第二轮，修复后的真机证据）**

- 真实创建了两个 worktree：`.flowgate/worktrees/C-004/T1` 与 `.../T2`，分支 `flowgate-tasks/C-004/T1`、`flowgate-tasks/C-004/T2`；`git worktree list` 可见；主分支 `flowgate/C-004`。
- `flow_dispatch_next` 的 `data.dispatched` 回填真实 `worktree` 字段（此前修复的问题在真机闭环）。
- 两个执行者子 agent 在各自 worktree 内启动并执行；账本有 `rule.denied`（R-SCOPE/旧版 R-PROTECTED）与 `scope.requested SC-1/SC-2` 记录——这是子 agent 越界后的正确转人工路径，但也暴露调度侧缺口：**并行批次里 scope 变更请求需要负责人审批**，host 目前只把 pending 留在状态里，没有自动通知/审批者（交互式会话里由负责人处理；E2E 用 `admin pending <id> approve`）。
- **本轮未完成**：C-004 的 worktree 合并、集成检查点与任务门结算使用修复前的 lib 运行，因此只验证到"worktree 创建 + 子 agent 启动 + 结构化回填"；用修复后 lib 的完整结算复验（C-005）留下一轮。

**C-006 / C-007（单任务 worktree 结算，第三轮）**

- C-006：`worktree.created` 账本事件、子 agent 在 worktree 内写入 `RenewalPageSizeLimit` + 测试、`turn.continued`（agent 宣布完成但无新鲜 GREEN 回执时插件会继续推一轮）、`verify.receipt` E-0029 65/65、**`review.reported` RV-1（coverageOk=true）**、`task.done`；批次进入 `checkpoint` 状态，但一次性 headless 在主进程退出前未完成 worktree 合并与集成检查点。
- C-007（保持主会话轮询 211s 后仍是同样结果）：worktree + 子 agent + 测试 + **review RV-1 verdict=pass / coverageOk=true** + task.done 全部通过；批次仍停在 `checkpoint`。结论：headless 一次性运行无法可靠等待"子 agent finalize → 合并 → 集成命令"的后台链路，需要交互式/常驻宿主会话复验。
- **缺陷 C：并行执行者的范围判定用全局 activeTask**。C-005 里 T2 写自己 `new_files` 中的文件被 T1 的 scope 拒绝（`rule.denied R-SCOPE target=RenewalSummaryText.java`）。已修：`Engine.evaluateAction` 优先用 `caller.dispatch.taskId` 定位任务卡，再回退 activeTask；新增 engine 集成回归测试（T2 执行者允许、主会话按 T1 拒绝）。
- 并行批次内的 `scope.requested`（SC-n）仍需负责人审批；headless 下拉不到审批通知，交互式会话可在面板处理，E2E 用 `admin pending <id> approve`。
- **缺陷 D：命令执行器超时后可能永久挂起**（2026-10-31 真机发现）：`flow_verify` 执行 `spring-boot:start` 时 java 后代进程继承 stdout/stderr，只 kill shell 不会触发 'close'，宿主在超时后仍然悬挂（风险 B 评测卡住 >10 分钟）。已修 `NodeCommandRunner`：POSIX 用 detached 进程组、超时对整组 SIGTERM/SIGKILL，并在宽限期后强制 resolve(exitCode=124)；新增 3 个回归测试（含"后代持有管道"场景）。

## 3.8 第二轮开发：评测收尾、覆盖率、派发/并行、熔断恢复（2026-10-31）

本轮按 [04 执行方案](../04-执行方案.md) 与 §6「下一步」补齐剩余内容；详细数字见 §2，评测结论见 [evaluation.md](../evaluation.md) §6.5–§6.7。

| 方向 | 产出 | 证据 |
|---|---|---|
| T6.1 评测收尾 | 18 组 run 的 4 项主观指标（隐藏需求遗漏 / 越界文件 / 虚假完成 / 验收覆盖）人工评分 18/18；新增评分口径与 `scores.json`；结论与局限入档 | [evaluation.md](../evaluation.md) §6.5、[evaluation-data/scoring](../evaluation-data/scoring/README.md) |
| 覆盖率 | `src/host/**` 纳入 vitest coverage 口径并加 thresholds；core 语句 83.03→90.02%、分支 68.36→80.01%、函数 86.47→90.64%、行 87.56→92.64%（host 74.01/60.74/72.81/78.87%）；新增 9 文件 / 158 例 | `pnpm coverage`（通过 thresholds 80/80/80/70） |
| 派发/并行 host 收尾 | 结算后把 open 待处理项注入主会话且不重复、`flow_dispatch_next` 暴露 `data.pending`；集成检查点返回结论并写通知；中断任务重派发前确认旧子 agent 已停止（否则阻塞 + 待处理项）；派发前复核 open scope/plan/risk；新增 27 例 | `src/host/dispatch/{pending,redispatch}.ts`、`test/host/dispatch-{pending,redispatch,checkpoint}.test.ts` |
| T-FAILURE-LIMIT 熔断恢复 | 只拦"推进/修改"动作（read、只读 shell、`flow_status`/`flow_diff`/`flow_report_risk` 放行）；同任务只生成 1 个 BL；新增 `/flow unblock`（计数清零、任务恢复、残留 BL 一并关闭、账本 `task.unblocked`）；新增 18 例（含真实 run `BL-1..BL-8` 卡死快照复刻） | `src/core/rules/risk-triggers.ts`、`src/core/engine.ts`、`src/host/commands/index.ts`、`test/core/risk/breaker-recovery.test.ts` |
| 状态损坏 fail-closed | `status.json` 损坏不再 fail-open：锁定模式 + `/flow doctor` 显示路径与修复入口 + `/flow repair` 重建后解锁；修不好的损坏保持锁定；新增 14 例 | `src/core/store/state.ts`、`src/core/engine.ts`、`src/host/doctor/index.ts`、`test/core/store/state-corruption.test.ts` |
| 测试输出解析 | 新增 Python 标准库 `unittest` 控制台解析器（`Ran N tests`、OK/FAILED/NO TESTS RAN、失败名称与 文件:行、subTest），修正 `detectEvidenceKind`；25 例含真实 Python 3.13 输出与仓库证据回放 | `src/core/evidence/parse.ts`、`test/core/evidence/parse-unittest.test.ts` |
| 从 0 开发缺陷 | PROJECT（路线图阶段）可跨会话自动接续并批准 GR；修复 `approveGate('GR')` 归档 PROJECT 时绕过 `saveChange` 导致 GR 批准不落盘、GR 后清空 current；GR 后第一个变更强制从路线图立项（否则 C0 失去 skeleton 标记，G2 project.md 与 R-PROTECTED 死锁）；T-DEPENDENCY 改为按清单内容判定（新建无依赖 package.json 不再误伤）；共 10 例新回归 + 35 例依赖触发器回归 | `src/core/engine.ts`、`test/core/engine-project-attach.test.ts` |
| Web 宿主走查 | 会话内切换 FlowGate 工程模式 preset（`agentPresets/select` 返回 flowgate、0 pageerror）、`/flow init`/`/flow new`、8 视图面板、面板按钮 Remote 兜底、低复杂度方案确认卡三按钮、拦截视图误判反馈（组件级）；14 张截图；修复投影进程 epoch（重启后 UI 陈旧，新增 6 例） | [web-walkthrough.md](web-walkthrough.md)、[screenshots/](../screenshots/README.md)、`test/host/projection-epoch.test.ts` |
| T6.2 加固复验 | 故障注入 7/7（新增 3 例）、启动增量 +12.1ms / +15.5ms（<200ms）、卸载干净度通过、兼容 7/7；`--dump-config-schema` 归因为 rc.5 preset 嵌套限制（宿主自带 preset 同样中招） | [compat/0.2.1-rc.5.md](../compat/0.2.1-rc.5.md)、[compat/startup.md](../compat/startup.md) |
| 真机评测补跑 | 真实模型 + 隔离 headless：greenfield 从 0 开发演练 6 次完整迭代（另有 1 次未完成未计入；真实走通"项目级澄清 → 路线图 GR → C0 立项 → G1/G2/G3 → S4"，期间暴露并修复 7 个真实缺陷）；`java-renewal` 新功能 `dispatch=auto`：顺序派发完整结算到 S5（3 批次 done、G4 passed、外部回归 20/20），并行批次真实启动（worktree + 独立子 agent + 证据）但 headless 进程在集成检查点前退出 | [evaluation.md](../evaluation.md) §6.6/§6.7、`docs/evaluation-data/20261031-11*/` |

**本轮真机发现并修复的产品缺陷（均有回归测试）**：状态文件损坏 fail-open；T-FAILURE-LIMIT 过度拦截 / 无解锁路径 / BL 膨胀；GR 批准不落盘；PROJECT 不自动接续；Python unittest 解析缺失；宿主重启后投影 revision 回退导致 UI 陈旧；评测工具链缺口（headless preset 注册表、租约残留、待处理项自动处理）。

## 3.9 第三轮 P0 修复（2026-10-31，7 项）

按 [todo-audit-2026-10-31.md](todo-audit-2026-10-31.md) 的 P0 清单逐项修复，每项都有回归测试（第三轮结束时新增 3 个集成测试文件 + host/故障注入用例 33 例，93 files / 1322 tests 绿；第四轮 P1 收尾后全量为 96 files / 1363 tests，见 §3.10）。

| # | 修复 | 行为变化 | 证据 |
|---|---|---|---|
| P0-4 | 计划修订 API 落地 | `applyPlanAmendment` 解析 `add` 任务卡片段并追加顺序批次、`reorder` 调整未开始任务；`flow_request_plan_change` 批准后执行计划真正变化（此前只 `void item`） | `src/core/engine.ts`、`src/core/artifacts/parse.ts`、`test/integration/engine-admin.test.ts` |
| P0-2/P0-3 | 检查点失败 → 修复任务 + 重试 | integration 命令失败：解析失败输出（兜底用批次任务范围）生成 `FIX-n` 顺序修复批次；修复批次完成后 `dispatchNext` 返回 `retryCheckpoint`，宿主重跑合并与集成命令；连续失败达阈值转 conflict 待处理；merge 冲突写 `merge.conflict` 账本并转人工 | `src/core/engine.ts`、`src/host/dispatch/index.ts`、`test/integration/engine-checkpoint.test.ts`、`test/host/dispatch-checkpoint.test.ts` |
| P0-1 | `run: main` 路由 | `dispatchNext` 不再把 run:main 任务派给子 agent，而是返回 `mainTasks`（并行批次可与子 agent 任务并行执行），主会话用 `flow_task_start` 领取 | `src/core/engine.ts`、`src/host/dispatch/index.ts`、`test/integration/engine-run-main.test.ts` |
| P0-5 | 终审/安全审查生产者 | `flow_submit G5` 在 S5 自动跑整体终审子 agent，登记 `kind:'final'`（高风险同时登记 `security`）；不再出现"开着 review 提交 G5 必然缺终审记录" | `src/host/review/index.ts`、`src/host/tools/definitions.ts`、`test/host/review.test.ts` |
| P0-7 | S5 验证失败回退 S4 | `g5.fullTests` / `g5.lintBuild` / 终审 critical-major findings 触发回退 S4 并生成 FIX 修复批次；纯证据类失败（如 `g5.runtime`）留在 S5 | `src/core/engine.ts`、`src/core/state/transitions.ts`、`test/integration/engine-s5-repair.test.ts` |
| P0-6 | 租约文件损坏 fail-closed | `sessions.json` 损坏、截断 → 锁定模式（不再 `engine.load` 抛错 → markInert → 守卫放行）+ doctor 显示路径 + `/flow repair` 重建空租约并解锁；损坏态不自动改写租约 | `src/core/store/state.ts`、`src/core/engine.ts`、`test/fault-injection/host-resilience.test.ts` |

**复核补强（独立 reviewer 两轮只读复核后）**：

- 自动修复任务 `autoRepair`：豁免 RED→GREEN（含高风险 `tddRequiredAll`），只用 `fix` 验证组要求新鲜 GREEN；`fix` 组只接受测试类命令（build/lint 证据 phase 恒为 none），无测试命令时降级为无验证组但可完成，避免"修复任务永远过不了任务门"。
- 检查点失败达 `triggers.consecutive_failure_limit` 后进入负责人闸门（`dispatchNext` 返回 `blocked`）；新增 `/flow conflict approve|reject CF-n`（headless/CLI 可释放：approve 重置 attempts 后重试检查点，reject 放弃该批次自动重试）；host 的 conflict 提示同步。
- 迟到批准计划修订被拒（只允许 S4 应用）、run:main 不跨未完成批次越序领取、检查点并发结算按批次去重 + done 幂等、无子 agent 宿主不提前阻断 run:main 派发。
- host 任务门审查不再"任意一条 pass 就短路"：按 `requiredReviewRounds()`（高风险 2 轮）从已有 pass 数补足轮次，修复 pre-existing 高风险任务门永久缺一轮的问题（flow_task_done 与派发结算两条路径）；低复杂度（0 轮）不再跑无意义的信息性审查。
- 测试稳定性：`test/host/plugin-load.test.ts` 的引擎初始化等待从固定 `flush()` 改为 `waitForEngine()`，消除覆盖率插桩下偶发的 `engine()===null` 抖动（本轮复现并修复）。

## 3.10 第四轮 P1/P2/P3 收尾（2026-10-31）

按 [todo-audit-2026-10-31.md](todo-audit-2026-10-31.md) 继续收尾：**P1 全部闭环**；P2 中可执行项完成、真机/真模型/桌面/sandbox 项如实列为环境受限；P3 文档一致性清理完成。新增回归 41 例（第三轮 1322 → 第四轮 1363）。

| 方向 | 产出 | 证据 |
|---|---|---|
| P1-1 M-5 自动降级 | 规则级误判反馈从账本重建；累计拦截 ≥ 20 且误判率 > 5% 时 deny/human 降为提示（本次放行 + `rule.hinted` 账本 + M-5 备注），样本不足不降级 | `src/core/rules/misfire.ts`、`FlowEngine.evaluateAction`、`src/core/metrics/metrics.ts`、`test/core/rules/misfire.test.ts`、engine 集成用例 |
| P1-2/P1-6 并行调度 | 执行者结算后**槽位级自动补位**同批次 queued 任务（不再等主 agent 再 dispatch）；超出 `max_agents` 的任务显式 `queued`；`/flow dispatch` 的 `dispatched` 数据与状态一致 | `src/host/dispatch/index.ts`、`src/core/engine.ts`、`test/host/dispatch-checkpoint.test.ts`、`test/integration/engine-run-main.test.ts` |
| P1-3 面板审批 | 面板覆盖 scope/risk/plan/rule/conflict 批准/拒绝 + blocker 解除熔断（保留 Remote 填命令兜底）；客户端命令映射防 BL 误命令 | `src/client/panel/views/Tasks.tsx`、`src/client/actions.ts`、`test/client/tasks-pending.test.tsx` |
| P1-5 pending 生命周期 | 变更/分析任务归档时未处理 pending → `expired` + 账本 `pending.expired` | `src/core/engine.ts`、engine 集成用例 |
| P1-7 上下文占用 | host 读 rc.5 `token-meter` 的 `contextPressure` 投影 → `RuntimeSnapshot.contextPct`（缺数据不填、不编造；≥60% 客户端提示） | `src/host/projection/context.ts`、`src/host/runtime.ts`、`docs/impl/host-client-contract.md` §1.1、`test/host/context-pct.test.ts` |
| P1-8 CI/覆盖自检 | CI 增加 `pnpm coverage`；覆盖自检 tools/change 100ms trailing debounce + doctor/status 读取兜底 | `.github/workflows/ci.yml`、`src/host/coverage/index.ts`、`test/host/coverage-delegation.test.ts` |
| P1-9 基准仓库 | ts PBKDF2 断言改格式契约（迭代次数下限）、py 导出断言改契约；R3 正确实现无需改既有断言 | `examples/ts-todo-api/test/auth.test.js`、`examples/py-csv-cli/tests/test_cli.py`、`examples/README.md` |
| P1-10/P1-11 | 删除 `/flow config` 未实现桩；删除 grep 证明零引用的死代码（stack/classify/parse/checks 私有函数与废弃 walker）；`rules/evaluate.ts` 保留待后续 | `src/host/commands/index.ts`、`src/core/{detect,shell,evidence,artifacts}/**` |
| P2 可执行证据 | HEAD 复跑 compat 7/7、startup +15.1ms、uninstall 通过；MCP/未知工具守卫冒烟（R-MCP human → 负责人批准 → 单次放行）；headless preset overlay 文档化 | [compat](../compat/0.2.1-rc.5.md)、`test/integration/engine-admin.test.ts` |
| P3 文档 | evaluation/interview/screenshots/compat/00–04/spike/cheatsheet/web-walkthrough/method-sources 口径清理；README/CHANGELOG/release/audit 同步 | 各文档；见 [todo-audit](todo-audit-2026-10-31.md) §4.1 |

## 3.11 第五轮：执行方案验收缺口修复（2026-10-31）

按 [acceptance-gap-audit-2026-10-31.md](acceptance-gap-audit-2026-10-31.md) 逐条修复 04 验收缺口，
分 5 个批次提交：`8963a92`（P0 16 项）、`b22dedc`（P1-1）、`58e8381`（P1-2）、`84b942e`（P1-3）、
`6e3bd24`（P1-4），本轮新增测试文件 6 个、回归用例 96 例（第四轮 1363 → 第五轮 1459）。

| 方向 | 主要产出 | 证据 |
|---|---|---|
| 冻结与守卫 | 契约判定快照、产物哈希冻结 + R-FROZEN-ARTIFACT、越界撤销自动解除、非 agent 改动投影/G6、接管写拒绝 R-LEASE + 接续快照 | `src/core/store/freeze.ts`、`src/core/engine.ts`、`test/integration/engine-freeze.test.ts`、`engine-session-audit.test.ts` |
| 执行与证据 | evidence.md/review.md、篡改检测（TM-n）、行级审查覆盖、同 diff 去重、critical/major 阻塞 + `/flow review waive`、返工失效、交接摘要触发 | `src/core/tamper/**`、`src/host/review/index.ts`、`test/core/tamper/**`、`test/host/review-coverage.test.ts` |
| 交付与调度 | run/health 运行证据、检查点任务验证+全量测试、worktree 降级标注、终审三份结论、dispatch 场景/理由、调查并发上限、relatedTo 继承 | `src/host/verify/run.ts`、`src/host/dispatch/index.ts`、`test/integration/engine-audit.test.ts` |
| UI/交付物 | 技能回执、工程 preset 工具集、G3 执行图、例外闭环、看板自动刷新/打开、规则统计（实际生效规则）、规则试跑（客户端本地近似，标注精确判定以宿主实际拦截为准）、GREEN 过期 | `cordis.patch.yml`、`src/client/panel/**`、`test/host/preset-composition.test.ts`、`test/client/panel.test.tsx` |
| 评测/加固 | compat 13/13（含 6 项离线结构检查）、浏览器包缺失故障注入、注入 token 预算、review.model 接线 | `scripts/verify-dsh-compat.mjs`、`test/fault-injection/host-resilience.test.ts` |

> 第五轮当时认为仍开放项只有环境受限验证、发布与自举决策，以及 T2.1 的"每产物 10 正/反例"证据形式差异；
> **第六轮独立复验发现另有 7 项 P1 接线缺口（见 §3.12），该"只剩三类"结论已被修正；当前剩余项以 §4 为准。**
> 第五轮原始"仍开放事项"记录见 [acceptance-gap-audit §5](acceptance-gap-audit-2026-10-31.md#5-仍开放事项不伪造完成)（历史时点）。

## 3.12 第六轮：清理复验发现的接线缺口（2026-10-31）

独立只读复验按 04 验收条件重查第五轮"已闭环"结论，推翻了"功能缺口全部闭环、仅剩三类"的判断：实际又发现 **7 项 P1 接线缺口**与一批 P2/证据口径问题。本轮按"接线/回归"修复（不新增功能面），每项均补回归测试；代码修复提交 `cea85dd`，测试规模 **112 files / 1522 tests**（第五轮 107/1459，+5 文件 / +63 用例）。

### 3.12.1 P1：代码接线（7 项，均补回归测试）

| # | 缺口（验收项） | 修复 | 证据 |
|---|---|---|---|
| 1 | T4.9 并行 worktree 未作为验证执行根 | `flow_verify`、输入哈希、自动提交改用任务 worktree 为执行根（`taskExecutionRoot`），回执描述执行者真实工作区 | `src/core/evidence/run.ts`、`src/core/engine.ts`、`test/integration/engine-cleanup.test.ts` |
| 2 | 派发双结算：已完成任务被迟到的失败覆盖 | `engine.taskFailed` 对 `done` 早退；host dispatch finalize 先查任务状态，成功任务不再被失败结算覆盖 | `src/core/engine.ts`、`src/host/dispatch/index.ts`、`test/host/dispatch.test.ts` |
| 3 | T4.2 S5 全量测试没有回归判定数据源 | S5 全量测试改走 `runFullSuite`，`regressions` 写入回执，G5 可判定回归、M-12 有数据源 | `src/core/engine.ts`（`ensureFullSuite`）、`test/integration/engine-cleanup.test.ts` |
| 4 | T4.8 上下文压缩后丢失交接/任务上下文 | 交接摘要加入每步注入 `buildInjection`；host 增加 `agent/created source='compact'` 防御式重注入（DSH rc.5 实测该事件不可达，已在文档注明） | `src/core/engine.ts`、`src/host/session/index.ts`、`test/host/session.test.ts` |
| 5 | T3.7/T4.8 跨会话未注入中断任务卡 | `releaseSession` 生成 handoff；新会话注入 running/review → 最近 interrupted 的任务卡；状态条 S4 显示「任务 RED/GREEN」 | `src/host/session/index.ts`、`src/core/engine.ts`、`test/host/session.test.ts` |
| 6 | T2.2 澄清「改变说明」占位符可通过 G1 | 占位符（`（待补充）`/`（未记录）`）不再通过 G1；`recordClarifyQA` 回写 `clarifyRounds`（M-7 数据源） | `src/core/artifacts/checks.ts`、`src/core/engine.ts`、`test/core/artifacts/checks-cleanup.test.ts` |
| 7 | T2.8 低复杂度快车道任务数未收紧 | 低复杂度 G3 任务数上限=1（其它等级仍用配置/默认 12） | `src/core/artifacts/checks.ts`、`test/core/artifacts/checks-cleanup.test.ts` |

### 3.12.2 P2 / 证据与口径修正（8 项）

| # | 项 | 修复 | 证据 |
|---|---|---|---|
| 8 | T2.3 `test: none` 基线未真实取证 | G2 前真实运行 build/lint/typecheck 基线并落回执；无通过回执 G2 失败 | `src/core/artifacts/checks.ts`、`test/integration/engine-cleanup.test.ts` |
| 9 | M-16 路线图进度无数据源 | `roadmap.approved` / `roadmap.progress` 写 `total` / `delivered` | `src/core/metrics/metrics.ts`、`src/core/types.ts` |
| 10 | T5.1 执行图不可交互、任务详情缺失 | 执行图节点可点击/键盘选择 + 任务详情区块；snapshot 新增可选 `taskCards`（scope/验证组/covers 下发，客户端缺失时降级） | `src/client/panel/ExecutionGraph.tsx`、`src/client/panel/views/Tasks.tsx`、`src/client/model.ts`、`src/core/types.ts`、`test/client/task-detail.test.tsx` |
| 11 | 规则试跑与真实判定口径不符 | 客户端本地近似：尊重 off/locked/实际规则 decision/生效例外，固定标注「本地近似试跑，精确判定以宿主为准」，并列出本地无法判定的项目自定义规则 | `src/client/model.ts`、`src/client/panel/views/Intercepts.tsx`、`test/client/rule-trial-ui.test.tsx` |
| 12 | T2.4 技能重复加载每次注入全文 | `duplicate` 时 post-execute 输出替换为「本会话已加载，不重复注入」短提示（派发子 agent 保留全文） | `src/host/evidence/index.ts`、`test/host/evidence.test.ts` |
| 13 | 任务门审查提示引用不存在的工具 | taskDone 提示改为"审查由插件自动触发；不可用时负责人 `/flow review waive`"，不再引用 `flow_request_review` | `src/core/engine.ts` |
| 14 | 技能文案与实现不一致 | skills 同步：dispatch auto 未按 size 路由（如实说明）、低复杂度 1 张任务卡、澄清占位符、`test:none` 基线 | `skills/flow-plan|flow-orchestrate|flow-clarify|flow-context/SKILL.md` |
| 15 | 文档/物料过期或事实错误 | 46→52 项门禁检查、面试 M-6=42.9% 补原始数据、真实故事拆两条、README.en 状态、compat/startup 头注、evaluation §194、compat"无网络"、CI 状态、todo-audit 89.29、release.yml 加 coverage、package.json repository/homepage/bugs、tag 推送说明、截图可离线补做、vitest 注释、构建体积 | `README*.md`、`CHANGELOG.md`、`docs/**`、`package.json`、`.github/workflows/release.yml`、`vitest.config.ts` |

> 第六轮门禁数字见 §2：**112 files / 1522 tests** 全绿、lint/typecheck 通过、coverage thresholds 通过（合计 86.40/76.25/86.92/89.46）、compat 13/13、startup +16.2ms、uninstall 通过；CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) 已成功。
> 第六轮仍开放项（四分：环境受限 / 可离线补做 / 需负责人决策 / 后续 P2）见 §4；逐项证据见 [acceptance-gap-audit §7](acceptance-gap-audit-2026-10-31.md)。

## 3.13 v0.2：图形化流程 + 卡片化授权（2026-11-01）

负责人两条需求：① vibecoding 全流程可视化——尽量用 UI/UX 元素、少用文字、先一眼看懂流程/当前/下一步，多用动态动画；② 需要人确认的步骤用授权卡片，不再让用户手输命令——会话框只输入自然语言，所有问题用提问卡片/授权卡片点击交互。设计契约 [ui-interaction-redesign.md](ui-interaction-redesign.md)。

| 方向 | 交付 | 证据 |
|---|---|---|
| 图形化流程（输入区） | 新 dock：七阶段动画轨道 + 下一步 chip + 8 态图形卡（demo/locked/off/idle/active/awaiting/pending/blocked）；授权卡（gate/pending/external/enable/repair/reconnect）+ 内联退回理由 | `src/client/dock/StatusBar.tsx`、`src/client/visual/*`、`src/client/styles.ts`、`test/client/status-bar.test.tsx`、`visual.test.tsx` |
| 图形化流程（面板） | `panel-rail` 全局可见；Pipeline 图形流程页（hero 进度环、纵向 FlowMap、人工/自动门徽标、「你在这里」、下一步 callout、折叠学习卡）；ExecutionGraph 运行动效 | `src/client/panel/Panel.tsx`、`views/Pipeline.tsx`、`ExecutionGraph.tsx`、`test/client/panel.test.tsx` |
| 原生 plan 风格与宽度（负责人反馈迭代） | 授权卡照抄官方 `PlanReviewPanel`：frame `padding:6px calc(var(--dsh-composer-side-clearance)+16px) 10px`、card `max-width:var(--dsh-chat-content-width)` + `--dsw-specific-input-major`/`radius-xl`/`elevation-panel`；warn strip + 白卡 + 黑白 primary/outline 按钮；rail/next chip/面板全部切换 `--dsw-*` 中性 token，去大色块/彩虹色；新增 `data-flowgate="flow-dock-inner"` | `src/client/styles.ts`、`dock/StatusBar.tsx`、`visual/*`、`panel/views/{Pipeline,Gates}.tsx`、`theme.ts`、`visual.test.tsx`；真实宿主实测见下 |
| 会话内工具可视化 | 16 个 `flow_*` 工具注册 `tool.call.toolview`，聊天中渲染迷你七阶段轨道 + 状态行；防御式降级 | `src/client/toolviews/**`、`test/client/toolviews.test.tsx` |
| 点击即授权（不再填命令） | `bridge.runCommand` 双层（`remote.commands.execute` → `sessions.binding().session.command`）；`performAction` 顺序 remote→executeCommand→旧降级；面板/dock 按钮全部直连 | `src/client/actions.ts`、`bridge.ts`、`test/client/actions.test.ts`、`bridge.test.ts`、`gates-auth.test.tsx` |
| 提问卡片 | `preset-flowgate` 组合 `@deepseek-ai/dsh-tool-ask-user`；systemPrompt 追加「交互契约」（仅已初始化项目）：拍板走授权卡、提问必须 `ask_user_question`（带 options） | `cordis.patch.yml`、`src/host/context/index.ts`、`test/host/preset-composition.test.ts`、`context.test.ts` |
| 文案去命令化 | host/core 三批清理（task-3/7/8）：nextStep / pushNotice / 工具结果 / 门禁 hint / 规则 unlock / 派发 / init / 会话接续 → 「等待负责人在授权卡片上确认/处理」；仅保留 help/用法错误/doctor 诊断 | `src/core/engine.ts`、`src/host/**`、相关 11 个测试文件 |
| i18n | zh/en 447 keys parity；新增 dock/viz/pipeline 等 key，清理 trial/learning 中 `/flow` 提示 | `src/client/locale/*.json`、`test/client/i18n.test.ts` |

**验证**：`pnpm lint`（lint-layers + tsc）绿；`npx vitest run` **116 files / 1642 tests** 全绿；`pnpm coverage` 通过 thresholds（合计 **86.39 / 76.24 / 86.93 / 89.47**）；`pnpm build`（host 1.21MB / client 346.6KB）；`verify:package` **39 文件 / 1065.3KB**；`verify:client`（18 插槽）通过。真实 DSH 0.2.1-rc.5 Web 宿主（隔离 `DSH_HOME`、零模型请求）E2E **35/35 断言**：awaiting 授权卡点击「确认并推进」→ 真实 `POST /api/commands/execute` → G3 passed、阶段 S4、写盘一致、**composer 全程为空**、0 pageerror/console.error；面板 flow-map/you-are-here/next-step-callout；8 tab 无 `/flow` 手输文案；reduced-motion 0 动画。截图 [screenshots 30–33](../screenshots/README.md)。原生风格/宽度改造后真实宿主复验：`--dsh-chat-content-width=844.8px`，`[data-flowgate="flow-dock-inner"]` 与授权卡均为 **844.8px（±0px，等于原生 PlanReviewPanel 的 max-width）**，dock 外框 = composer hero 外框 = 908.8px（±0px）；active 12/12、awaiting 43/44（唯一未过为旧断言 `data-tone="attention"`，原生 strip 语义改为 `warn`，`data-kind/data-gate/data-action` 不变）；0 pageerror / 0 console.error / 0 模型请求；30–33 截图已按新风格重拍。

**已知限制（如实）**：原生提问卡与 toolview 需模型真跑一轮才能出现，零模型 E2E 只验证组合面（preset 含工具、web 组合含 `ui-user-questions`）；awaiting 状态沿用既有离线构造口径（web-walkthrough §2.4），点击→执行→推进是真实链路。另有观察项：活跃态 dock 的 next chip 已从 host 的 `flow_submit(...)` 模型文案替换为阶段自然语言（`humanNextStep`），D2 复验刷新截图 30。

## 3.14 v0.3：运行可视化（子代理拓扑 + 后台任务，2026-11-01）

负责人需求：**子代理拓扑实时预览（工作流图 / 树双模式）+ 后台任务清单（退出码、实时输出、强制终止）也要可视化，风格与 DSH 原生一致。** 设计契约 [runtime-visualization.md](runtime-visualization.md)。数据全部来自 DSH 原生服务，不新造 host 状态。

| 方向 | 交付 | 证据 |
|---|---|---|
| 子代理视图（面板 tab `agents`） | `subagentCatalog` 投影 + `useSessionStatus` 实时 running + FlowGate tasks/batches/taskCards/worktree 关联；角色解析（exec/review/final/investigate）；工作流图（自上而下，560/719 侧栏 0 溢出）/ 树双模式；打开子代理会话 | `src/client/panel/views/Subagents.tsx`、`runtime-model.ts`、`test/client/subagents.test.tsx`、截图 34/35 |
| 后台任务视图（面板 tab `jobs`） | 复用 `ctx.jobs`：状态/退出码 chip/耗时/展开实时输出（observe 流式 `<pre>`）/两段式强制终止（kill）/缺服务空态 | `src/client/panel/views/Jobs.tsx`、`test/client/jobs.test.tsx`、截图 36 |
| bridge 数据层 | `jobsAvailable/jobsSnapshot/subscribeJobs/watchJobs/observeJob/killJob/openSubagentSession`；`ctx.inject(['jobs'])` + `['uiWorkspace']` 延迟解析、防御式降级 | `src/client/bridge.ts`、`types.ts`、`test/client/bridge.test.ts`（30 例） |
| 原生风格 | 全部 `--dsw-*` token/中性色；状态语义色仅小状态点；行/按钮/输出面板与官方 Jobs/plan 卡风格一致；reduce 关闭动效 | `styles.ts`、`visual.test`、真实宿主风格核对 |

**验证**：`pnpm lint` 绿；`npx vitest run` **118 files / 1683 tests**；coverage 86.39/76.25/86.93/89.47（阈值通过）；build（host 1.21MB / client 411.6KB）；verify:package / verify:client（18 插槽）通过。真实 Web 宿主（隔离 DSH_HOME、零模型请求）smoke **22/22**：10 tab、两视图空态、旧 8 tab/授权卡/宽度无回归、0 pageerror/0 console.error/0 模型请求；dump-config 含 `@deepseek-ai/dsh-api-job-controller` 与 `@deepseek-ai/dsh-client-ui-workspace`。子代理工作流图 560px/719px 0 横向溢出（508/508、667/667）。组件级 populated 截图 34–36（真实组件 + 真实 token CSS + fixture）。

**限制（如实）**：真实子代理与后台 job 需要模型运行才能产生；零模型验证只覆盖空态/组合面，populated 截图为组件级假数据（README 已披露）。

## 4. 剩余项（第六轮复验后，四分）

> 第六轮独立复验确认第五轮"功能缺口全部闭环"结论不成立：7 项 P1 接线缺口已在 §3.12 修复；
> 下表是**当前仍开放项**，分四类：环境/人工受限、可离线补做、需负责人决策、后续 P2/产品决策。
> 第一至五轮的历史缺口清单与闭环证据见 [acceptance-gap-audit](acceptance-gap-audit-2026-10-31.md) §3–§6、
> [todo-audit §9](todo-audit-2026-10-31.md) 与本文件 §3.9–§3.12（历史记录，不再重复展开）。

### 4.1 环境/人工受限（不伪造通过）

- 18 组评测在可执行 sandbox 重跑、双人独立评分、B 组 metrics 采集、真实人工负担/响应时间（`--owner manual`）。
- 并行批次真实合并结算与 M-18 加速比（headless 一次性运行在集成检查点前退出；需常驻/交互式宿主，顺序/并行各 ≥3 次）。
- 从 0 开发 C0→C1 完整交付（当前卡点之一见 4.4 的 C0 骨架 TDD 死锁）。
- 真实 guard 拦截→面板→误判反馈端到端、preset persona/工具集运行时差异、真实确认卡产生路径、5 个预置缺陷检出率、PTC / `ask_user_question` 结构化字段（需真模型会话与完整宿主组合）。
- Desktop 宿主人工走查与 UI 冷启动人工计时（Web/headless 已有证据，启动增量仅模块加载口径）。
- **P2-14 口径修正**：headless 真模型 E2E 未在第六轮 HEAD 复跑（历史真机结果见 §3.4/§3.5；compat 文档据此标注"本轮未复跑"）。
- **T5.2 学习模式抽查未做**：实现只在 detail 模式注入提示文本，无强制/度量；需真实模型会话人工抽查 10 次（≥8 次符合）。

### 4.2 可离线补做（Playwright + Chrome 可用，非环境受限）

- 自动接续 UI、`/flow doctor` 覆盖自检扩展明细截图（见 [screenshots/README.md](../screenshots/README.md)）。
- projection epoch 宿主重启后的真机复验（已有 6 例单测）。
- 上述两项不需要模型/网络，属"未排期"而非"做不到"。

### 4.3 需负责人决策

- **发布（基本完成）**：2026-10-31 采用方案 A（前移 `v0.1.0` 到 `c193e98`、保持版本 0.1.0）发布 npm `dsh-flowgate@0.1.0`（本地 `npm publish`，无 provenance；隔离 `DSH_HOME` 安装验证通过）。**GitHub Release 待补建**（`gh release create v0.1.0 --verify-tag --notes-file docs/release/v0.1.0.md` 或网页创建）。仍可后续补做：demo 动图、干净机器 10 分钟快速开始验收、awesome-dsh-plugin 收录/社区反馈。
- **自举（04 §9）**：用 FlowGate 管本仓库开发；M3 出口 `v0.5.0` tag、M6/v1.0 发布证据都不存在。做/不做需拍板；不做则从 backlog 移除并同步文档。
- **T2.1 字面口径**："每种产物 10 正/反例"当前以 52 项检查逐项正反例 + 解析边界用例覆盖，未逐产物准备 10×样本；是否单开一轮补 fixture。

### 4.4 后续 P2 / 产品决策

- **C0 骨架首任务 TDD 死锁**（greenfield 真机发现，产品决策）：C0 只允许写工程骨架、`package.json` 在 RED 前不可写，导致 C0→C1 卡住。需决定 C0 豁免 TDD，或给出标准 allow-once SOP。
- `run: auto` 按 size 路由未实现：当前 `auto` 与 `subagent` 行为一致（均由派发宿主起子 agent），需要主会话做的小任务要显式写 `run: main`；skills 已如实说明。
- ~~**Remote 非降级路径：v0.1 决策不做**~~（2026-11-01 更新：卡片/按钮已改为点击即执行——客户端经**官方命令 remote** `ctx.remote.commands.execute(sessionId, line, [])`（与 slash-command UI 同源，`sessions.binding().session.command` 兜底）直接执行等价 `/flow` 命令，不再填输入框；FlowGate 自有 Typert Remote 仍不做，后续按需评估）。
- 上下文阈值 / M-17 数据源、dispatch 摘要落账、worktree 归因、T4.4 PR/CHANGELOG 生成仍为引导（P2 后续）。
- `appendPluginRecord` 属实验性 API，DSH 升级可能失效：每个 RC 跑 `verify:compat`；不可用时只保留内存投影。

## 5. 文件地图（主干）

- 纯逻辑：`src/core/{state,rules,shell,artifacts,plan,citations,detect,roadmap,ledger,store,evidence,risk,revision,metrics,report,dashboard,learn,tamper}/`（含 `rules/misfire.ts` 的 M-5 降级、`tamper/` 的篡改检测纯函数），编排入口 `src/core/engine.ts`。
- 宿主适配：`src/host/`（入口 `index.ts`；`adapters/`、`guard/`、`commands/`、`tools/`、`projection/`（含 `context.ts` 上下文占用/token 用量数据源）、`review/`（读取覆盖行级核对、终审三份结论）、`dispatch/`（含 `pending.ts`、`redispatch.ts`、并行槽位补位、检查点验证）、`verify/run.ts`（S5 运行证据）、`open.ts`（report/board 打开）等）。
- 浏览器半侧：`src/client/`（`dock/StatusBar.tsx` 图形化 dock、`visual/` 轨道/流程图/图标、`styles.ts`、`toolviews/` 会话工具轨道、`panel/` 8 视图、`learn/`、`actions.ts`、`bridge.ts`、`i18n/`）。
- 内容：`skills/`（15 技能 × SKILL+learn）、`examples/`（3 个基准仓库 + 空仓库）、`docs/`（00–04 原始方案 + 本目录实现文档 + spike-report + compat + screenshots + evaluation-data）。
- 脚本：`scripts/{lint-layers,run-evaluation,collate-evaluation,verify-package,verify-client-bundle,verify-dsh-compat,verify-uninstall,measure-startup}.mjs`；CI：`.github/workflows/ci.yml`。

## 6. 下一步（按优先级）

> 第六轮复验与接线修复后，剩余项按 §4 四分；门禁数字见 §2，逐项证据见 §3.12 与
> [acceptance-gap-audit §7](acceptance-gap-audit-2026-10-31.md)。

1. **发布（已完成 2026-10-31）**：npm `dsh-flowgate@0.1.0` 已发布、tag `v0.1.0` 已前移。发布后仍可补：demo 动图、干净机器 10 分钟快速开始验收、awesome-dsh-plugin 收录与社区反馈。
2. **C0 骨架 TDD 死锁决策（产品）**：决定 C0 豁免 TDD，或给出标准 allow-once SOP；决策后在可执行 sandbox 重跑从 0 开发至 C1 交付并记录 M-16/M-17。
3. **环境受限验证批次**：可执行 sandbox + 真实模型上重跑 18 组评测 + 双人独立评分 + B 组 metrics；并行/顺序各 ≥3 次得可统计 M-18；真实人工负担用 `--owner manual`/真人会话；headless 真模型 E2E 在当前 HEAD 复跑。
4. **真实 Web/Desktop 走查**：真实 `R-STAGE-SRC` 拦截 → 面板 → 误判反馈闭环、preset 运行时差异、真实确认卡、PTC/`ask_user_question` 结构化字段、5 个预置缺陷检出率；补 Desktop 兼容矩阵与 UI 冷启动人工计时。
5. **可离线补做（不需要模型）**：自动接续/`doctor` 扩展明细截图、projection epoch 重启真机复验（Playwright+Chrome 可用）。
6. **自举（负责人决策项）**：用 FlowGate 管自身仓库开发（04 §9）；不做则从 backlog 移除并同步文档。
7. **P2 后续/口径**：`run: auto` 按 size 路由（或保持显式 `run: main`）、M-17 上下文阈值数据源、dispatch 摘要落账、worktree 归因、T4.4 PR/CHANGELOG 生成引导、T5.2 学习模式抽查；T2.1"每产物 10 正/反例"的 fixture 形式补齐。
