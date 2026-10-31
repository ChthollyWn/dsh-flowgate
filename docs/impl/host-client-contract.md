# host ↔ client 数据契约

> Lead 定稿。host 与 client 两侧按此实现；任何改动先改本文件。所有结构必须是可 JSON 序列化的纯数据；客户端对缺失字段做降级显示（"暂无 / 未启用"），不得抛错。
>
> **v0.6（2026-11-01）**：投影 wire 改为显式 DTO（`src/host/projection/wire.ts`），`stateVersion` 升到
> **2**；`RuntimeSnapshot` 新增可选字段 `offBy` / `takeover` / `incident` / `repair`（§1.5）；wire 值边界规则
> 扩大为完整 lossless JSON 语义（含负零/稀疏数组等，§1.1）。

## 1. 会话投影

host 注册（DSH 会话投影）：

```
key: 'flowgate'
state: FlowgateProjection
```

```ts
interface FlowgateProjection {
  /** 完整运行时快照，见 src/core/types.ts RuntimeSnapshot */
  snapshot: RuntimeSnapshot
  /** 面板补充数据（可选；没有时面板按 snapshot 降级显示） */
  panel?: PanelExtras
  /** 单调递增的修订号，客户端用它做变更检测/重渲染 */
  revision: number
  /** 生成时间 ISO */
  updatedAt: string
  /**
   * 写入该记录的宿主进程 epoch（可选；旧版本记录没有）。
   * 宿主重启后 revision 会从 0 重新计数，投影 apply 靠 epoch 识别"新进程记录"，
   * 避免被旧会话日志里更大的 revision 挡住而显示陈旧快照；客户端可忽略本字段。
   */
  epoch?: string
}
```

### 1.1 投影 wire 值必须是 lossless JSON（v0.5.1，v0.6 收紧）

DSH 的 `@deepseek-ai/dsh-api-remotes` 在转发 `api-session/added` 等事件前用 `isJsonValue()` 校验参数：`undefined` 属性、NaN/Infinity、函数、非 plain object 都会使会话摘要校验失败，表现为**新建会话/子会话失败**（v0.5.1 事故：连续新建会话从第二个起失败）。

v0.6 起 host 层所有跨边界数据统一走 `src/host/boundary/json.ts`（`toLosslessJson` / `assertLosslessJson` /
`isLosslessJson`），判定严格镜像 DSH `@deepseek-ai/dsh-util-values` 的 `isJsonValue`：

| 值 | 允许？ | 说明 |
|---|---|---|
| `null` / boolean / 有限 number / string | ✅ | — |
| `-0` | ❌ | **负零不是无损 JSON**（`Object.is(v, -0)` 即失败）；清洗 JSON 往返会把 `-0` 变 `0` |
| `NaN` / `Infinity` / `-Infinity` | ❌ | JSON 往返会变 `null` |
| `undefined`（属性/数组元素/顶层） | ❌ | 属性被丢弃；顶层 → 调用方按语义处理 |
| 稠密内建数组（无洞、无额外属性、内建 `Array.prototype`） | ✅ | **稀疏数组/Array 子类/伪造原型**拒绝 |
| plain object / null-prototype（仅可枚举字符串键） | ✅ | `Date`/`Map`/`Set`/类实例/含 symbol 或不可枚举属性 → 拒绝 |
| 函数 / symbol / bigint / 循环引用 | ❌ | bigint/循环无法往返：`toLosslessJson` 返回原值兜底，自检/`assertLosslessJson` 会失败 |

投影处理链（顺序固定）：

```
engine.snapshot()/buildPanel()  → toWireProjection()（显式白名单 DTO，见 §1.5）
  → toLosslessJson()（唯一清洗入口）→ DSH isJsonValue 校验 → 会话摘要/客户端
```

投影注册前还有 `projectionSelfCheck()`：用含 undefined/NaN/Date/类实例的脏 fixture 走
init/apply/wire，断言 lossless 且顶层键齐全；**失败则不注册投影**（插件其余功能照常，`/flow doctor`
可见失败原因）。新增投影字段时不要直接透传内部对象，必须在 `wire.ts` 显式加白名单并过清洗。

### 1.2 自动流程摘要（v0.5，可选）

`snapshot.flowPlan?: { route: 'full' | 'standard' | 'fast'; autoApprove: boolean; verdict: 'approved' | 'adjusted'; reasons: string[] }`

仅当变更创建时提交了 `assessment`（或负责人用 `/flow route` 覆盖）才出现；旧客户端 / 旧投影记录忽略即可。服务端以 `status.json` 的 `change.flowPlan` 为准，账本另有 `flow.assessed` / `flow.route_override`。

### 1.3 上下文占用（contextPct，可选）

host 从 DSH `@deepseek-ai/dsh-token-meter` 的 `contextPressure` 会话投影读取：
`sessionProjections.snapshot(session, ['contextPressure'])` 的 wire 值
`{ projectedTokens?, pressureTokens?, contextWindow? }`（单元为 host-only 无 wire 时退回 `stateOf`）。

- 计算：`contextPct = clamp(round((projectedTokens ?? pressureTokens) / contextWindow × 100, 1), 0, 100)`；
- 任一数字缺失/非法/`contextWindow <= 0` → **字段不存在**（不是 0），client 降级不显示（`>= 60` 才提示）；
- 刷新：token-meter 每次用量样本后 `onChanged` → 延后一帧 `emit()`；普通 emit 也会重读；
- 实现：`src/host/projection/context.ts`、`src/host/runtime.ts`（`setContextPctSource`/`snapshotWithContext`），测试 `test/host/context-pct.test.ts`。

### 1.4 任务卡详情（taskCards，可选，第六轮新增）

`RuntimeSnapshot.taskCards?: Record<string, TaskCard>`：host 把当前变更的解析后任务卡随投影快照下发，供面板"执行图节点 → 任务详情"展示；客户端必须对缺失字段降级（不显示详情），不得抛错。

- 主要字段：`id` / `title` / `covers` / `scope` / `tests` / `new_files` / `depends_on` / `tdd` / `verify`（验证组）/ `run` / `run_reason` / `size` / `risk`（完整定义见 `src/core/types.ts` 的 `TaskCard`）。
- 数据来源：`FlowEngine.getTasks()`（仅当前变更）；无 `tasks.md`、解析失败或旧快照时为**字段缺失**（不是空对象）。
- 客户端适配：`src/client/model.ts` 优先使用 `snapshot.taskCards[id]`，缺失时任务详情降级；测试 `test/client/task-detail.test.tsx`。
- 该字段是**可选增量**，不改变既有 wire 契约；引入于第六轮（§3.12 / `cea85dd`）。

### 1.5 运行模式 / 事故 / 修复通道字段（v0.6，可选）

`RuntimeSnapshot` 新增以下**可选增量字段**（旧客户端忽略未知字段；客户端必须对缺失降级）：

| 字段 | 类型 | 出现条件 | 含义 |
|---|---|---|---|
| `takeover` | `'enforce' \| 'observe' \| 'off'` | 新引擎恒填；旧记录缺失 | 生效接管模式（safe-mode/自举检测/配置解析结果）：enforce=全部规则硬拦截；observe=**仅 `R-NO-CHANGE` 未立项写入放行并记 `takeover.observed`，其余规则照常拦截**；off=完全不拦截也不记录 |
| `offBy` | `'human' \| 'agent'` | 仅 `off === true` 时 | 谁暂停了门禁：负责人手动 `/flow off`，或 agent `flow_self_pause` 事故暂停 |
| `incident` | `{ id, severity: 'P0'\|'P1'\|'P2', reason, openedAt }` | 未关闭的事故记录存在时 | 自暂停创建的事故摘要；`flow_incident_close` 后消失 |
| `repair` | `{ id, title, severity, status: 'open', scope: string[], verify, red: boolean, green: boolean, openedAt, actions: number }` | 修复通道进行中时 | 修复声明进度（RED/GREEN/已放行动作数）；完成/中止后消失（审计在 `.flowgate/fixes/`） |

补充约定：
- 这些字段与 `panel` 一样是**可选增量**，不改变既有 wire 顶层键（`snapshot`/`revision`/`updatedAt`/`epoch`）；
- 状态版本：`FlowgateProjection.stateVersion` 升到 **2**（显式 DTO；旧 checkpoint 值不再作为当前状态，
  DSH 在版本不匹配时丢弃旧 checkpoint，投影从日志重建）；
- 客户端展示建议：`repair` 显示 RED/GREEN 徽标；`incident` 显示事故条（原因 + 恢复提示）；
  `takeover!=='enforce'` 时 dock/面板显示"观察模式/已降级"提示；注意 observe 只放宽未立项写入，
  其余门禁仍可能拒绝动作，客户端不要据此隐藏门禁错误。

### PanelExtras

```ts
interface PanelExtras {
  changes?: ChangeSummary[]              // 台账：全部变更 + 分析任务
  gate?: GatePanel                       // 当前门
  trace?: TraceRow[]                     // 追溯矩阵
  risks?: RiskRow[]                      // 风险登记
  intercepts?: InterceptRow[]            // 拦截日志（最近 100 条）
  rules?: RuleRow[]                      // 规则与命中统计
  metrics?: { change: Record<string, number | '未知'>; total?: Record<string, number | '未知'>; notes?: Record<string, string> }
  evidence?: EvidenceRow[]               // 当前变更证据回执摘要
  reviews?: ReviewRow[]                  // 审查结论摘要
  roadmap?: RoadmapSummary               // 从 0 开发时的路线图进度
  dashboardPath?: string                 // .flowgate/dashboard.html 路径（面板"打开看板"用）
}

interface ChangeSummary {
  id: string
  title: string
  kind: 'change' | 'analysis'
  complexity: 'low' | 'medium' | 'high' | 'ultra'
  risk: 'normal' | 'high'
  stage: string
  lifecycle: 'active' | 'paused' | 'archived' | 'blocked' | 'locked'
  session?: string
  updatedAt: string
  artifactLinks?: { label: string; path: string }[]
}

interface GatePanel {
  gate: string | null
  state: 'pending' | 'awaiting' | 'passed' | 'failed' | 'rejected' | 'skipped'
  items: { item: string; label: string; passed: boolean; hint?: string; example?: string }[]
  mergedConfirm?: {                 // 低复杂度方案确认卡
    goal: string
    acceptance: string[]
    scope: string[]
    verify: string
    risks?: { title: string; mitigation: string }[]
  }
  awaitingOwner: boolean
}

interface TraceRow { requirementId: string; scenarioId: string; title?: string; taskIds: string[]; evidenceIds: string[]; covered: boolean }
interface RiskRow { category: string; grade: string; reason: string; mitigation: string; verification: string; needsHuman: boolean }
interface InterceptRow { at: string; ruleId: string; tool: string; target?: string; effect: 'deny' | 'human'; why: string; unlock: string; source?: string; violationId?: string }
interface RuleRow { id: string; decision: string; why: string; unlock: string; hits: number; source?: string }
interface EvidenceRow { id: string; taskId?: string; group: string; kind: string; phase: string; exitCode: number; run: number; passed: number; failed: number; skipped: number; fresh: boolean; finishedAt: string }
interface ReviewRow { id: string; taskId?: string; kind: string; verdict: string; findings: { severity: string; file: string; line?: number; message: string }[]; coverageOk: boolean; createdAt: string }
interface RoadmapSummary { mvpCut: string; entries: { change: string; capability: string; goal: string; status: string; mvp: boolean }[]; delivered: number; total: number }
```

## 2. 宿主 Remote（面板动作）

host 若支持 `dsh-api-gateway` / Typert Remote，注册：

```
remote id: 'flowgate'
methods:
  state(): Promise<FlowgateProjection>        // 兜底：也可从投影读取
  action(payload: FlowgateAction): Promise<{ ok: boolean; message: string; value?: unknown }>
```

```ts
type FlowgateAction =
  | { type: 'approve'; gate: string }
  | { type: 'reject'; gate: string; reason: string }
  | { type: 'approve-pending'; id: string; reason?: string }
  | { type: 'reject-pending'; id: string; reason: string }
  | { type: 'allow-once'; ruleId: string; reason: string }
  | { type: 'add-exception'; ruleId: string; pathPattern?: string; reason: string }
  | { type: 'revoke-exception'; id: string; reason?: string }
  | { type: 'complexity'; level: string; reason?: string }
  | { type: 'risk-level'; level: string; reason?: string }
  | { type: 'resume'; changeId: string; takeover?: boolean }
  | { type: 'pause' }
  | { type: 'off'; reason?: string }
  | { type: 'on' }
  | { type: 'metrics-export' }
  | { type: 'generate-report' }
  | { type: 'open-board' }
```

**主路径（2026-11-01 起，授权卡片）**：人工确认/待处理动作由会话输入区上方的授权卡（`conversation.input.dock`）或面板按钮触发。点击后客户端经
`ctx.remote.commands.execute(sessionId, '/flow ...', [])`（`src/client/bridge.ts` 的 `bridge.runCommand`，
与官方 slash-command UI 同源）由宿主执行等价命令；**不写输入框、不需要用户回车**。点击即为人授权，
agent 工具里仍然没有批准/退回能力。`performAction` 的 ports 顺序为
`remote.flowgate.action` → `executeCommand` → 旧 composer draft → 剪贴板。

**旧兜底（仅旧宿主降级）**：Remote 与命令 Remote 都不可用时，客户端才把等价的 `/flow ...` 命令写入输入框草稿并聚焦，
由负责人回车执行；或用剪贴板。正常 Web 宿主不会走到这条路径（`ActionOutcome.fallback=false`）。

**提问路径（2026-11-01 起）**：需要用户回答的问题由 agent 调用原生 `ask_user_question`
（FlowGate 工程模式 preset 组合 `@deepseek-ai/dsh-tool-ask-user`），由 `@deepseek-ai/dsh-client-ui-user-questions`
渲染原生提问卡片；FlowGate 不自绘提问卡。

## 3. 客户端注册（slot）

按 recon 速查表（docs/impl/dsh-plugin-api-cheatsheet.md）的最终签名，当前目标形态：

- 状态条：`ctx.slots.register({ name: 'conversation.input.dock', id: 'flowgate-status' }, StatusBar)`；StatusBar 从投影读 `snapshot.statusLine`，点击调用 `ctx.sidebarRightTabs.open('flowgate')` 或等价 API。
- 右侧栏：`ctx.sidebarRightTabs.register({ id: 'flowgate', title: 'FlowGate', icon?, order? })` + `ctx.slots.register({ name: 'sidebar.right.pane.tab', id: 'flowgate' }, Panel)`。
- 客户端 `inject` 列表对应 package.json `dsh.client.inject`；只依赖 React runtime（`require('react')`）与 DSH 提供的 client 模块。

## 4. 版本与兼容

- **投影状态版本**：`stateVersion = 2`（v0.6 显式 wire DTO；v0.5.1 为 1）。旧 checkpoint 会被宿主丢弃并按日志重建，
  客户端只消费 wire 值，不感知 stateVersion。
- 投影状态必须带 `revision`；host 每变更一次 +1。
- 客户端遇到未知 `stage`/`gate`/字段时显示原文而不是崩溃。
- 学习模式/阶段学习卡已于 v0.4 移除；阶段展示只用 `snapshot.stage` 与 `panel.gate`，旧记录里的 `learning` 字段由读取方忽略。
