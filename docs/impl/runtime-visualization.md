# 运行可视化：子代理拓扑 + 后台任务（v0.3 设计契约）

> Lead 定稿 2026-11-01。负责人需求：**子代理拓扑实时预览（工作流图 / 树双模式）+ 后台任务清单：退出码、实时输出、强制终止 这部分也要可视化，风格也要和 DSH 原生风格一致。**
>
> 数据原则：**只读 DSH 原生运行数据**，不新造 host 状态：
> - 子代理：当前会话的 `subagentCatalog` 会话投影（`SubagentCatalogEntry[]`）+ 全局标准 props 的 `useSessionStatus`（实时 running）+ FlowGate 投影里的 tasks/batches/taskCards（把 `task.agent === childId` 的子代理关联到任务/批次/worktree）。
> - 后台任务：客户端 `ctx.jobs` 服务（`@deepseek-ai/dsh-api-job-controller` 注册；与官方 Jobs 面板同一数据源）：`watchRows(sessionId)`、`observe(sessionId, jobId)`、`kill(sessionId, jobId)`、`jobs.state.getSnapshot()/subscribe()`。
> - 不依赖模型/不伪造数据；没有数据时给空态与解释。

## 0. 新增面板视图

`PANEL_TABS` 增加两个 tab（面板内，自带原生风格）：

| tab id | zh 标签 | en 标签 | 内容 |
|---|---|---|---|
| `agents` | 子代理 | Agents | 子代理拓扑（工作流图 / 树 双模式，实时 running） |
| `jobs` | 后台 | Jobs | 后台任务清单（退出码、实时输出、强制终止） |

## 1. 子代理拓扑视图（`src/client/panel/views/Subagents.tsx`）

### 数据

```
proj      = normalizeProjection(useProjection('flowgate'))     // 可空
catalog   = useProjection('subagentCatalog')                    // SubagentCatalogEntry[]（可空）
running   = useSessionStatus(map => catalog.map(e => map.get(e.id)?.running ? '1' : '0').join(''))
```
- 角色从 catalog `label` 解析（注册标签见 host）：
  - `flowgate-exec-<taskId>` → executor（任务执行者）
  - `flowgate-review-<taskId>-<attempt>` → reviewer（任务审查者）
  - `flowgate-final-<kind>-<attempt>` → final-reviewer（终审）
  - `flowgate-investigate-<ts>` → investigator（调查者）
  - 其他/缺 label → subagent（子代理）
- 任务/批次/worktree：用 `snapshot.tasks[taskId]`（`status`、`batch`、`agent`、`worktree`、`startedAt/finishedAt`）与 `snapshot.batches`、`snapshot.taskCards[taskId].title` 关联；`task.agent === entry.id` 时以 task 状态作为终态补充。
- 未关联任务的子代理（review/final/investigate）直接挂在主会话下。
- 实时：`useSessionStatus` 变化 → running 点变化；catalog 投影 push → 新子代理出现。

### 双模式

- 标题行：`子代理` + 数量（运行 x / 共 y）+ 分段切换 `[工作流图] [树]`（`data-flowgate="agents-mode"`，按钮 `data-mode="graph|tree"`，`aria-pressed`）。
- **工作流图**（默认）：横向流程（超宽可横向滚动）：
  `主会话` →（批次分组：B1/B2/…，每组内含该批子代理卡；无批次归入「其他」）→ 每张子代理卡 = 角色徽标 + 任务 id/标题 + 状态点 + worktree（mono，可选）+ 耗时。
  未关联批次的子代理归入「服务」列，直接连主会话。
- **树**：主会话根行 → 批次节点（可展开/收起，默认展开）→ 子代理行（缩进分支线）；
  行内：状态点 + 角色徽标 + label/task 标题 + worktree + 耗时 + 「打开会话」。
- 状态点语义（与原生一致）：running=ongoing（呼吸）、failed=error、done=success、idle=弱化。
- 空态：`暂无子代理` + 解释「S4 派发执行者 / 审查者 / 调查者后，这里实时显示拓扑（inline 模式没有子代理）」；若宿主未提供 `subagentCatalog`：`宿主未提供子代理目录投影`。

### DOM 契约（测试/E2E）

```
data-flowgate="view-agents"           根
data-flowgate="agents-mode"           分段控件；按钮 data-mode="graph|tree" aria-pressed
data-flowgate="agents-count"          data-running / data-total
data-flowgate="agents-graph" / "agents-tree"
data-flowgate="agent-root"            主会话节点
data-flowgate="agent-batch"           data-batch
data-flowgate="agent-node"            data-session-id data-role data-status data-task
data-action="agent-open"              data-session-id（可选，通过 bridge.openSubagentSession）
data-flowgate="agents-empty"
```

## 2. 后台任务视图（`src/client/panel/views/Jobs.tsx`）

- 数据经 bridge 读取 `ctx.jobs`（见 §3）：`rows = jobsSnapshot().rows[sessionId] ?? []`；实时输出 `observed[jobId].text`。
- 排序与官方一致：live 在前（startedAt 升序），已结束在后（finishedAt 降序）。
- 每行（原生 Jobs 行风格）：
  - 状态点（running=ongoing / stopping|killed=warning / completed=done / failed=error）；kind 小标签；mono label（命令/描述）；
  - 右侧：状态或 `detail`（含退出码时优先显示）→ **退出码 chip**：从 `detail` 解析 `exit code: N`（兼容 `exit code：N`），显示「退出码 N」；killed 显示终止原因；
  - 耗时（running 每秒刷新；settled 用 startedAt/finishedAt）；
  - live 行有「终止」按钮（两段式：点一次进入确认态 `data-armed="true"`，再点调用 kill；失败显示错误文案）；
  - 可展开：展开后 acquire `observe(sessionId, jobId)`，显示 `<pre>` 实时输出（保留最近 ~8KB，自动滚到底；无输出显示「暂无输出」）；收起释放观察。
- 头部：`后台任务` + 运行中数量；空态「当前没有后台任务」+ 解释；`ctx.jobs` 不可用时「宿主未提供后台任务服务」。
- 行/输出面板沿用原生 token：行 `--dsw-alias-border-l1`、hover `--dsw-alias-fill-l1`；输出面板 `--dsw-alias-markdown-code-block`（回退 `--dsw-alias-bg-module-platform`）+ mono 字体。

### DOM 契约

```
data-flowgate="view-jobs"             根
data-flowgate="jobs-count"            data-running / data-total
data-flowgate="job-row"               data-job-id data-status data-live
data-flowgate="job-exit"              data-code（退出码 chip；无则不渲染）
data-action="job-expand"              aria-expanded
data-action="job-kill"                data-armed="true|false"
data-flowgate="job-output"            <pre> 实时输出
data-flowgate="jobs-empty" / "jobs-unavailable"
```

## 3. bridge 扩展（`src/client/bridge.ts`，interaction 所有）

```ts
export interface JobRowWire {
  id: string; kind: string; label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  progress?: string; detail?: string
  startedAt: number; finishedAt?: number
  output?: { total?: number; earliest?: number }
}
export interface JobsUiSnapshot {
  rows: Record<string, JobRowWire[]>
  observed: Record<string, { text?: string }>
}
export interface HostBridge {
  jobsAvailable(): boolean
  jobsSnapshot(): JobsUiSnapshot
  subscribeJobs(listener: () => void): Disposer
  watchJobs(sessionId: string): Disposer
  observeJob(sessionId: string, jobId: string): Disposer
  killJob(sessionId: string, jobId: string): Promise<boolean>
  openSubagentSession(parentSessionId: string, childSessionId: string): boolean
}
```
- 实现：`ctx.inject(['jobs'], ...)`（服务结构见官方 `@deepseek-ai/dsh-client-ui-jobs`：`state.getSnapshot/subscribe`、`watchRows/observe` 返回 release、`kill` 返回 `{ok}`）；`ctx.inject(['uiWorkspace'], ...)` 的 `openSession({parentSessionId, childSessionId, mode:'continuable'})` 用于打开子代理会话。
- 全部 optional/防御式；缺失时 UI 空态/按钮隐藏；服务 dispose 时 bridge 字段清空。

## 4. 样式（viz）

- 复用既有 `.fg-plan-card` / `.fg-native-btn-*` / native tokens；新增：
  - `.fg-runtime-card`（subagents graph/tree 容器）、`.fg-graph-col`、`.fg-graph-arrow`、`.fg-graph-batch`、`.fg-agent-card`、`.fg-tree-row`、`.fg-branch`；
  - `.fg-job-row`、`.fg-job-chip`、`.fg-job-output`；
  - 状态点/脉冲复用 `.fg-pulse` 或新增 `.fg-dot-live`（只动 opacity/transform，reduce 关闭）。
- 禁止新增大色块/彩虹色；语义色只用于小状态点与退出码/错误小字。

## 5. 测试与验收

- 纯函数（role 解析 / 任务关联 / 退出码解析 / 排序 / 耗时格式）单测。
- SSR 组件测试：`test/client/subagents.test.tsx`、`test/client/jobs.test.tsx`（空态、双模式切换、节点/role/status、job 行/退出码/终止确认态/输出展开态、缺 bridge 降级）。
- Panel/i18n 测试同步（tab 数 8→10，PANEL_TABS 动态键）。
- 真实宿主（隔离 DSH_HOME、零模型请求）：两个新 tab 可打开、空态正确、0 pageerror/console.error；**组件级证据**：用真实组件 + 真实 token CSS + 假数据渲染 populated 截图（与 24–26 号同一诚实口径；零模型无法真实产生子代理/后台 job，真机 populated 需模型）。
- 截图：`34-panel-subagents.png`、`35-panel-jobs.png`（组件级 populated，如实标注）+ 真实宿主空态可选。
- 文档：README/CHANGELOG/implementation-status/screenshots README 同步。

## 6. 写入范围

| 成员 | 范围 |
|---|---|
| interaction | `src/client/bridge.ts`、`src/client/types.ts`、`test/client/bridge.test.ts` |
| viz | `src/client/panel/views/Subagents.tsx`、`Jobs.tsx`、`src/client/runtime-model.ts`、`panel/Panel.tsx`、`src/client/styles.ts`、`src/client/locale/**`、`test/client/subagents.test.tsx`、`jobs.test.tsx`、`panel.test.tsx`、`i18n.test.ts`（如需） |
| verifier | `/tmp` + `docs/screenshots/**`（新截图与 README 分节） |
| Lead | 本文件、README/CHANGELOG/implementation-status、最终集成 |

## 7. 实施与验证结果（2026-11-01）

| 项 | 结果 |
|---|---|
| 面板 tabs | 8 → 10（新增 `agents`「子代理」/`jobs`「后台」，位于「任务」之后） |
| 子代理数据 | `subagentCatalog`（原生投影）+ `useSessionStatus`（实时 running）+ FlowGate snapshot tasks/batches/taskCards/worktree 关联；角色解析 exec/review/final/investigate |
| 工作流图 | 自上而下：主会话 → 竖向主干 → 批次组（顺序/并行 tag、状态、数量）→ 组内 flex-wrap 子代理卡 → 服务组；**560px 侧栏 clientWidth=scrollWidth=508、719px=667/667（0 横向溢出）** |
| 树模式 | 主会话根 → 可折叠批次 → 缩进子代理行；560px 0 溢出 |
| 后台任务 | 原生 `ctx.jobs`：状态/退出码 chip（解析 detail `exit code: N`）/耗时（live 1s）/展开实时输出（observe，8KB 尾）/两段式 kill（armed 3s）/空态 |
| bridge | jobsAvailable/jobsSnapshot/subscribeJobs/watchJobs/observeJob/killJob/openSubagentSession（`ctx.inject` 延迟解析、防御式、dispose 清理） |
| 测试 | `npx vitest run` 118 files / 1683 tests；新增 subagents 14 例、jobs 14 例、bridge +13 例；typecheck/lint 绿 |
| 真实宿主（零模型） | smoke 22/22：10 tab、两视图空态、旧 8 tab/授权卡/宽度无回归、0 pageerror/0 console.error/0 模型请求；组合含 `@deepseek-ai/dsh-api-job-controller` 与 `dsh-client-ui-workspace` |
| 组件级 populated | 34 工作流图（560px，0 溢出）/ 35 树 / 36 后台任务（展开输出 + armed 终止 + 退出码），真实组件 + 真实 `--dsw-*` token CSS + fixture |
| 限制 | 真机 populated 需模型运行；零模型只验证空态/组合面；34–36 为组件级假数据证据（已如实标注） |

截图：[30–33](../screenshots/README.md) v0.2；[34–36](../screenshots/README.md) v0.3。文档同步：README/README.en、CHANGELOG、implementation-status、screenshots README。
