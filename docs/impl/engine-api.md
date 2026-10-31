# FlowEngine API（host 集成契约）

`src/core/engine.ts` 导出 `class FlowEngine`，是 host 层唯一的状态入口。host 只做三件事：把 DSH 事件翻译成 engine 调用、把 engine 的结果翻译回 DSH（工具结果/命令输出/投影/注入）、执行 DSH 专属副作用（子 agent、worktree、git 子进程、fs）。

构造：

```ts
const engine = new FlowEngine({
  root,                       // 会话工作目录所在项目根（host 解析）
  fs, clock, git?, commandRunner?,
  pluginVersion,
  ledgerKey,                  // 从 ~/.dsh/flowgate/ledger.key 读取（host 负责生成 0600）
  userStateDir,
  sessionId,                  // 当前 DSH 会话 id，用于租约/心跳
  sessionAppend?,             // (type, data) => session.append(type, data)
  onStateChange?,             // (snapshot) => 更新投影/状态条
})
await engine.load()
```

## 只读

| 成员 | 说明 |
|---|---|
| `isInitialized(): boolean` | 项目里有 `.flowgate/config.yaml` |
| `currentChange(): ChangeStatus \| null` | 当前会话附着的变更 |
| `snapshot(): RuntimeSnapshot` | 状态条/面板/注入用的完整快照 |
| `statusText(): string` | `/flow` 的文本展开 |
| `buildInjection(): InjectionBundle` | 每步注入（≤600 token，只追加） |
| `getConfig(): FlowgateConfig` | 当前配置（含默认值） |
| `getEvidence(): EvidenceReceipt[]` | 当前变更的证据回执 |
| `getArtifacts(): ArtifactBundle` | 当前变更产物（缓存，`reload()` 刷新） |
| `getProject(): ProjectDoc \| null` / `getRoadmap(): RoadmapDoc \| null` | 项目级上下文 |
| `coverage(): CoverageReport \| null` / `setCoverage(report)` | 覆盖自检结果（host 会话开始时计算） |

## 生命周期与门禁

| 方法 | 说明 |
|---|---|
| `load(): Promise<void>` | 读配置/项目状态/租约/证据索引/附着变更；失败置 locked |
| `refresh(): Promise<void>` | 重新加载（外部改了 `.flowgate/`） |
| `init(): Promise<InitResult>` | `/flow init`：探测技术栈、生成 project.md 草稿与默认 config（不覆盖已有配置） |
| `newChange(input): Promise<NewChangeOutcome>` | 立项（S0→G0 自动→S1），返回复杂度/风险建议 |
| `submitGate(gate): Promise<GateResult>` | agent 提交门（GR/G1/G2/G3/G5/G6）；自动门通过即推进，人工门返回 `awaiting:'owner'` |
| `approveGate(gate, opts?): Promise<GateResult>` | 负责人批准（G1/G3/G6/GR；低复杂度 G3 同时批准 G1） |
| `rejectGate(gate, reason): Promise<GateResult>` | 负责人退回，意见进入注入 |
| `evaluateAction(action, caller): Promise<Decision>` | 守卫判定入口（同步缓存状态，p95 < 5ms；不含 IO） |
| `recordPostcheck(input): Promise<Violation[]>` | shell 事后工作区对比结果归因：越界→违规；外部改动→记录 |
| `recordExternalChanges(paths): Promise<void>` | 非 agent 改动 |

## 任务与验证

| 方法 | 说明 |
|---|---|
| `taskStart(taskId): Promise<TaskStartOutcome>` | S4 inline 模式领取任务（执行图顺序校验），返回任务卡/场景/上下文片段/TDD 要求/验证组 |
| `taskDone(taskId): Promise<TaskDoneOutcome>` | 任务门：新鲜 GREEN、TDD RED→GREEN、范围、审查；通过后自动提交并检查 G4 |
| `runVerify(input: { taskId?, group, command?, inputs? }): Promise<EvidenceReceipt>` | 插件亲自执行验证命令并记录回执；`taskId/group` 来自任务卡 |
| `attachEvidence(input): Promise<EvidenceReceipt>` | 手工证据（`runBy:'agent'`，标"agent 自述"） |
| `submitAnalysis(input): Promise<GateResult>` | 分析任务结论提交（引用核验后归档） |
| `requestScopeChange(input): Promise<PendingItem>` | 范围变更申请 SC-n |
| `reportRisk(input): Promise<PendingItem>` | 主动上报风险 RK-n |
| `requestPlanChange(input): Promise<PendingItem>` | 计划修订申请 PC-n |
| `proposeRule(input): Promise<PendingItem>` | 规则提议 RL-n |
| `decidePending(id, decision, reason?)` | 处理任意待处理项（命令/面板调用） |

## 人工动作（命令/面板）

`allowOnce(ruleIdOrLast, reason)`、`addException(ruleId, pathPattern?, reason)`、`revokeException(id, reason)`、`changeComplexity(level, reason?)`、`changeRiskLevel(level, reason?)`、`setOff(off, reason?)`、`doctor()`、`repair()`、`attachSession(label?)`、`resumeChange(changeId, { takeover? })`、`pauseChange()`、`handoff()`、`generateMetrics()`、`generateReport()`、`generateBoard()`。

## 注入给 agent 的文本约定

- `Decision.message`：短版（阶段、动作、规则 id、为什么、怎么解锁 ≤ 300 字）。
- `TaskStartOutcome.envelope`：任务卡 + 覆盖场景 + 上下文片段 + 验证组 + TDD 要求。
- `InjectionBundle.text`：每步追加；包含阶段、允许动作、活动任务、待处理项、下一步（≤600 token；学习模式已于 v0.4 移除）。
- 所有 agent 可见文案中文；错误返回 `{ error, hint }` 由 host 包装。

## 事件回调

`onStateChange(snapshot)` 在每次状态变化后调用（host 用它刷新会话投影/状态条/看板文件、追加会话事件）。host 不需要自己写 `.flowgate/`。

## 补充（实现期新增，host 直接可用）

| 方法 | 说明 |
|---|---|
| `dispatchNext(): Promise<DispatchOutcome>` | 按执行图派发：并行批次返回最多 `parallel.max_agents` 个 envelope；顺序批次 1 个；checkpoint 未完成时返回提示；inline 模式报错 |
| `setTaskWorktree(taskId, worktree, agentId?)` | 记录并行任务所在的 worktree |
| `taskFailed(taskId, reason)` | 子 agent 失败/中断：任务标 failed + 生成阻塞待处理项 |
| `completeCheckpoint(batchId, { ok, detail })` | 集成检查点结果；通过后推进批次与 G4 |
| `recordReview({ taskId?, kind, verdict, findings, coverageOk, diffFingerprint?, waived?, waivedReason?, attempts? })` | 审查结论入库；`coverageOk=false` 不计入有效审查轮次 |
| `takeNotices(): string[]` | 取出待注入给 agent 的提示（命令/审批之后 host 调 `agent.inject`） |
| `getTasks()/getTask()/getPlan()/allChanges()/getState()` | 面板与命令用的只读视图 |
| 测试钩子 | `EngineOptions.host.gateChecker`（注入门禁检查器）、`setStateForTest/setArtifactsForTest/setReceiptsForTest/setProjectForTest` |
