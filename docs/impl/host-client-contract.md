# host ↔ client 数据契约

> Lead 定稿。host 与 client 两侧按此实现；任何改动先改本文件。所有结构必须是可 JSON 序列化的纯数据；客户端对缺失字段做降级显示（"暂无 / 未启用"），不得抛错。

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
  /** 学习模式；默认 'detail' */
  learning?: 'detail' | 'brief' | 'off'
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

### 1.1 上下文占用（contextPct，可选）

host 从 DSH `@deepseek-ai/dsh-token-meter` 的 `contextPressure` 会话投影读取：
`sessionProjections.snapshot(session, ['contextPressure'])` 的 wire 值
`{ projectedTokens?, pressureTokens?, contextWindow? }`（单元为 host-only 无 wire 时退回 `stateOf`）。

- 计算：`contextPct = clamp(round((projectedTokens ?? pressureTokens) / contextWindow × 100, 1), 0, 100)`；
- 任一数字缺失/非法/`contextWindow <= 0` → **字段不存在**（不是 0），client 降级不显示（`>= 60` 才提示）；
- 刷新：token-meter 每次用量样本后 `onChanged` → 延后一帧 `emit()`；普通 emit 也会重读；
- 实现：`src/host/projection/context.ts`、`src/host/runtime.ts`（`setContextPctSource`/`snapshotWithContext`），测试 `test/host/context-pct.test.ts`。

### 1.2 任务卡详情（taskCards，可选，第六轮新增）

`RuntimeSnapshot.taskCards?: Record<string, TaskCard>`：host 把当前变更的解析后任务卡随投影快照下发，供面板"执行图节点 → 任务详情"展示；客户端必须对缺失字段降级（不显示详情），不得抛错。

- 主要字段：`id` / `title` / `covers` / `scope` / `tests` / `new_files` / `depends_on` / `tdd` / `verify`（验证组）/ `run` / `run_reason` / `size` / `risk`（完整定义见 `src/core/types.ts` 的 `TaskCard`）。
- 数据来源：`FlowEngine.getTasks()`（仅当前变更）；无 `tasks.md`、解析失败或旧快照时为**字段缺失**（不是空对象）。
- 客户端适配：`src/client/model.ts` 优先使用 `snapshot.taskCards[id]`，缺失时任务详情降级；测试 `test/client/task-detail.test.tsx`。
- 该字段是**可选增量**，不改变既有 wire 契约；引入于第六轮（§3.12 / `cea85dd`）。

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

**兜底（必须实现）**：Remote 不可用或 action 返回错误时，客户端把等价的 `/flow ...` 命令写入输入框草稿并聚焦，由负责人回车执行。批准/退回等人工动作只有人能触发，agent 工具里没有对应能力。

## 3. 客户端注册（slot）

按 recon 速查表（docs/impl/dsh-plugin-api-cheatsheet.md）的最终签名，当前目标形态：

- 状态条：`ctx.slots.register({ name: 'conversation.input.dock', id: 'flowgate-status' }, StatusBar)`；StatusBar 从投影读 `snapshot.statusLine`，点击调用 `ctx.sidebarRightTabs.open('flowgate')` 或等价 API。
- 右侧栏：`ctx.sidebarRightTabs.register({ id: 'flowgate', title: 'FlowGate', icon?, order? })` + `ctx.slots.register({ name: 'sidebar.right.pane.tab', id: 'flowgate' }, Panel)`。
- 客户端 `inject` 列表对应 package.json `dsh.client.inject`；只依赖 React runtime（`require('react')`）与 DSH 提供的 client 模块。

## 4. 版本与兼容

- 投影状态必须带 `revision`；host 每变更一次 +1。
- 客户端遇到未知 `stage`/`gate`/字段时显示原文而不是崩溃。
- 学习卡内容由 client 打包（i18n）；host 只提供 `learning` 模式。
