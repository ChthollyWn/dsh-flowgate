# 实现状态报告（v0.1 交付时点）

> 日期：2026-10-30。基线：DSH `0.2.1-rc.5`。对应执行方案：[docs/04-执行方案.md](../04-执行方案.md)。
> 本报告按里程碑说明**已完成 / 部分完成 / 未开始**，并给出可复现的验证命令。功能状态的对外表述以本文件为准。

## 1. 总览

| 里程碑 | 计划内容 | 状态 | 说明 |
|---|---|---|---|
| M0 预研与脚手架 | 隔离开发 profile、探针、工程化 | ✅ 完成 | 26 条假设实测；spike 在隔离 `DSH_HOME` 真实加载；pnpm+TS+tsdown+vitest+CI 就绪 |
| M1 门禁内核、项目目录与工程模式 | 状态机、规则引擎、账本、守卫、命令、状态条 | ✅ 完成 | 迁移表数据驱动测试；守卫双保险；账本哈希链 + HMAC；`/flow` 命令族与 14 个工具 |
| M2 规格层 | 产物检查、澄清/上下文/设计/拆解、路线图、执行图、引用 | ✅ 完成 | 46 项门禁检查（每项正反例）；执行图 mermaid；技术栈探测；路线图 GR |
| M3 执行纪律与跨会话接续 | 范围/TDD/证据/审查/风险/接续/返工 | ✅ 完成 | 验证由插件执行、输入哈希过期、并发会话租约、`/flow repair` |
| M4 交付闭环、工程判断、派发、上下文 | S5/S6/指标/派发/压缩/交接/并行/分析 | ✅ 主体完成 | 派发/worktree/集成检查点在 host 侧接线并已有 host 单测（test/host/dispatch.test.ts）；缺 provider/git 时降级 |
| M5 可视化与学习 | 面板 8 视图、阶段卡、HTML 报告、看板 | ✅ 主体完成 | 真实 web 宿主走查 + 11 张截图（见 §3.1/§3.3）；剩余：面板按钮 Remote 兜底、低复杂度确认卡、误判反馈截图 |
| M6 评测、加固与发布 | 基准评测、故障注入、兼容矩阵、文档发布 | 🟡 主体完成 | 兼容 7/7；host 单测 116 例 + 故障注入 4 例；java-renewal S0→S6 + 审查真机完成；故障注入 4/4、启动增量 +14.2ms、卸载干净度通过；对照评测 pilot 1/9 已完成、完整矩阵在跑；未发布 npm（用户决定暂缓） |

## 2. 可复现验证（截至本报告）

```bash
pnpm install
pnpm lint        # 分层规则（core 不得依赖 DSH/host/client）+ tsc --noEmit
pnpm test        # 63 个测试文件 / 944 用例（含新增 host dispatch/review 测试后为 65 / 969）
pnpm build       # lib/host.js（ESM）+ lib/client.js（loader 包装）
pnpm verify:client
pnpm verify:package
DSH_HOME=/tmp/fg-home node scripts/verify-dsh-compat.mjs --profile flowgate --write
# 真实 DSH 进程组合并导入插件（隔离 DSH_HOME，不碰日常 profile）：
DSH_HOME=/tmp/fg-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile flowgate --dump-config
DSH_HOME=/tmp/fg-home "…/dsh" --profile flowgate --dump-config-schema >/dev/null
```

最近一次结果（2026-10-31 复核）：lint 通过（123 个源文件）；`test` 63 files / 944 tests 全绿（新增 dispatch/review/git/故障注入/检查点/util 测试后 68 files / 992 tests）；构建产物 host 993KB / client 192KB；`verify:package` 通过（39 文件 / 849.8KB）；`verify:client` 通过；`verify:compat` 7 项全过（DSH 0.2.1-rc.5，隔离 `DSH_HOME`）。核心逻辑覆盖率：语句 83.0% / 分支 68.4% / 函数 86.5% / 行 87.6%（`pnpm coverage`）。

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
| 输入框状态条 | ✅ dock 渲染 `◆ FlowGate …`，≤120 字符、颜色分级、点击可打开面板 |
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

**对照评测 pilot（2026-10-31）**：用 `scripts/run-evaluation.mjs` 在 `ts-todo-api / fix-bug` 上跑 A/B 各 1 次：A 26s/0 门/1 轮，B 363s/3 次人工门/3 轮；两种条件回归 34/34、验收 4/4 全绿。pilot 同时发现基准 fixture 断言错误（R2 期望值与倒序契约矛盾）与 git 自动提交 bug，均已修复。原始数据与局限见 [evaluation.md](../evaluation.md) §6.1。

**本轮未完成**：派发/并行 worktree 的完整真机结算（headless 一次性运行在子 agent 结算前退出，需要交互式会话或常驻宿主）；有/无插件完整 9 任务 × 2 条件对照评测与从 0 开发演练（pilot 1/9 已完成，见 §6）。审查链路已真机跑通并产出结构化 findings。

## 3.6 T6.2 加固与兼容验证（2026-10-31）

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
## 4. 已知缺口（如实列出）

| # | 缺口 | 影响 | 后续 |
|---|---|---|---|
| 1 | ~~浏览器端交互未在真实 DSH web/desktop 会话里跑过~~（已 2026-10-30 实测，见 §3.1） | 剩余：人工按钮点击流程（Remote 兜底）、低复杂度确认卡、误判反馈截图 | 用桌面会话补做 |
| 2 | 三个 preset 已在真实 web 宿主的预设菜单出现（§3.3）；headless 用 overlay 补 `@deepseek-ai/dsh-agent-preset-registry` 后可激活（§3.5 实测），但**会话内切换**仍未验证 | 工程模式/执行者/只读 preset 的运行时行为仍需确认 | 桌面/Web 会话切换实测；overlay 写法已记入 host-integration |
| 3 | 有 / 无插件对照评测未执行（M6 T6.1）；评测脚本 `scripts/run-evaluation.mjs` 与 greenfield 空仓库已就绪并通过 dry-run | 无法给出 M-15/M-18 实测数字 | 按 [evaluation.md](../evaluation.md) 跑 9 任务 × 2 条件 |
| 4 | 审查子 agent 真机跑通（RV-1 verdict=pass + coverageOk）；派发/worktree 真机已验证创建、分支命名、子 agent 启动、data 回填、任务门/审查/task.done；**worktree 合并 + 集成检查点**已有 2 个 host 单测（合并成功/冲突 abort）覆盖逻辑，但真实宿主上的合并结算仍待交互式会话（headless 一次性运行提前退出）；scope 变更请求需负责人审批 | 非 git 仓库或 provider 缺失时降级为顺序 | 交互式会话复验合并 + 集成检查点；scope 变更审批通知 |
| 5 | `appendPluginRecord` 属实验性 API | DSH 升级可能失效 | 每个 RC 跑 `verify:compat`；不可用时只保留内存投影 |
| 6 | ~~主规格归档未做 ADDED/MODIFIED/REMOVED 合并~~（2026-10-30 已补：`src/core/archive/merge.ts` + 7 个单测 + `spec.merged` 账本事件，C-002 真机验证） | — | 已闭环 |
| 7 | 覆盖率分支 68.4% 低于 80% 目标（语句 83.0% 达标）；host 层不在 vitest coverage 口径内 | 部分错误/降级分支缺测 | 补 config 错误分支、host 降级路径测试，并把 host 纳入口径 |
| 8 | npm 未发布、无 GitHub Release；tag `v0.1.0` 落后 HEAD 4 个提交 | 无法按 README 的 npm 安装路径使用 | 发布物料已备（CHANGELOG、release notes、release.yml），待配置 `NODE_AUTH_TOKEN` 后发布并刷新 tag |
| 9 | Desktop 宿主未验证（T6.2 的启动耗时与卸载干净度已完成，见 §3.6） | 兼容矩阵只有 Web / headless 证据 | 桌面会话人工走查 |

## 5. 文件地图（主干）

- 纯逻辑：`src/core/{state,rules,shell,artifacts,plan,citations,detect,roadmap,ledger,store,evidence,risk,revision,metrics,report,dashboard,learn}/`，编排入口 `src/core/engine.ts`。
- 宿主适配：`src/host/`（入口 `index.ts`；`adapters/`、`guard/`、`commands/`、`tools/`、`projection/`、`review/`、`dispatch/` 等）。
- 浏览器半侧：`src/client/`（`dock/StatusBar.tsx`、`panel/` 8 视图、`learn/`、`actions.ts`、`i18n/`）。
- 内容：`skills/`（15 技能 × SKILL+learn）、`examples/`（3 个基准仓库）、`docs/`（00–04 原始方案 + 本目录实现文档 + spike-report + compat）。
- 脚本：`scripts/{lint-layers,verify-package,verify-client-bundle,verify-dsh-compat}.mjs`；CI：`.github/workflows/ci.yml`。

## 6. 下一步（按优先级）

1. **派发/并行 worktree 收尾**：在交互式会话里复验 worktree 合并 + 集成检查点（headless 一次性运行会提前退出）；补 `maybeCheckpoint` 单测与 scope 变更审批通知；交互式会话验证审批。
2. **M6 对照评测**：pilot 1/9 已完成（ts-todo-api/fix-bug A/B）；继续跑剩余 8 任务 × 2 条件、从 0 开发（greenfield）演练与并行对照，填入 [evaluation.md](../evaluation.md) §6.2。
3. 真实会话里切换三个 preset；更新 `cordis.patch.yml` 的"待实测"注释（当前已刷新为实际剩余项）。
4. 补覆盖率分支缺口、把 host 层纳入覆盖率口径；Desktop 宿主人工走查（启动耗时/卸载干净度已完成，见 §3.6）。
5. 发布：提交发布物料，配置 `NODE_AUTH_TOKEN` 后重打 tag / npm publish / GitHub Release；README 演示动图与 awesome-dsh-plugin 收录申请。
6. 自举：用 FlowGate 管理自身仓库开发（04 方案第 9 节），当前仍以 demo 仓库做 E2E。
