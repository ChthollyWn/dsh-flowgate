# 模块接口契约（实现约定）

> Lead 维护。任何跨模块导出都在这里有签名；实现方可增加内部私有函数与额外导出，但**不得修改**已有签名或 `src/core/types.ts` 中的共享类型（需要改先告知 Lead）。
> 所有 core 模块禁止 import `@deepseek-ai/*`；只能使用 `node:*` 内置模块与 `src/core/util/**`、`src/core/types.ts`。
> 所有路径一律为**仓库相对路径**（正斜杠、无 `./` 前缀），用 `src/core/util/paths.ts` 归一化。
> 面向 agent/负责人的用户可见文案用中文；错误统一 `{ error, hint }` 风格由 host 适配层包装。

## 通用约定

- 时间用 ISO-8601（`isoNow(clock)`）；所有持久化结构必须可 JSON 序列化。
- 文件读写只通过 `FileSystem` 端口（`src/core/util/fs.ts`）；测试用 `MemoryFileSystem`（`src/core/util/memory-fs.ts`）。
- 哈希用 `src/core/util/hash.ts`（`sha256` 返回 `sha256:<hex>`）。
- 纯函数优先；带 IO 的函数签名把 `fs`、`root`、`clock` 作为前几个参数显式传入。
- 测试放 `test/core/<模块>/`，用 vitest（`import { describe, it, expect } from 'vitest'`）。
- 不写 `test/core` 以外的测试文件；不动别人 scope 的文件。
- 门禁检查项一律返回 `CheckOutcome`（见 types.ts），失败时给 `hint` + `example`；label 用中文。
- 每个模块在 `index.ts` 里 re-export 公共 API，engine 只从 `index.ts` 导入。

---

## 1. `src/core/state/**`（负责人：core-kernel）

`src/core/state/stages.ts`
```ts
export const STAGE_ORDER: StageId[]                 // S0..S6（不含 roadmap/archived）
export const STAGE_LABELS: Record<StageId, string>  // 中文：S0 立项、S1 需求澄清 ...
export const STAGE_DESCRIPTIONS: Record<StageId, { what: string; why: string }>
export function stageIndex(stage: StageId): number
export function nextStage(stage: StageId): StageId | null
export function stageAfterGate(gate: GateId): StageId | null   // G0->S1, G1->S2 ... G6->archived；TG/G4 返回 null
export function gateForStage(stage: StageId): GateId | null    // S0->G0, S1->G1, S2->G2, S3->G3, S4->G4, S5->G5, S6->G6
export function humanGate(stage: StageId): HumanGateId | null  // S1->G1, S3->G3, S6->G6（低复杂度 S1 合并到 G3）
```

`src/core/state/levels.ts`
```ts
export interface LevelProfile {
  complexity: Complexity
  risk: RiskLevel
  requiresDesign: boolean
  requiresDesignOptions: boolean     // 需要 2–3 个方案对比
  requiresRiskDoc: boolean
  requiresExecutionPlan: boolean
  reviewRoundsPerTask: 0 | 1 | 2
  securityReview: boolean
  tddRequiredAll: boolean
  runtimeEvidenceRequired: boolean
  manualEvidenceConfirmed: boolean
  mergedGates: boolean               // 低复杂度：G1 与 G3 合并为方案确认卡
  maxTasks: number
  stages: StageId[]
}
export function levelProfile(complexity: Complexity, risk: RiskLevel, limits?: LimitSettings): LevelProfile
export function complexityLabel(c: Complexity): string   // 低 / 中 / 高 / 超高
export function riskLabel(r: RiskLevel): string          // 普通 / 高风险
export function parseComplexity(input: string): Complexity | null
export function parseRiskLevel(input: string): RiskLevel | null
export function stricterComplexity(a: Complexity, b: Complexity): Complexity
export function stricterRisk(a: RiskLevel, b: RiskLevel): RiskLevel
export function reviewRequirement(complexity: Complexity, risk: RiskLevel, taskTdd?: 'required'|'optional'): { rounds: 0|1|2; security: boolean; tddRequired: boolean }
```

`src/core/state/suggest.ts`
```ts
export interface LevelSignalInput {
  title: string
  summary?: string
  paths?: string[]
  modules?: string[]
  config?: FlowgateConfig
}
export function suggestLevels(input: LevelSignalInput): LevelSuggestion   // 复杂度 × 风险及理由（FR-6.5）
```

`src/core/state/transitions.ts`
```ts
export interface TransitionDef { from: StageId; event: GateId; to: StageId; kind: 'auto'|'human' }
export function transitionTable(): TransitionDef[]
export function validateGateSubmission(change: ChangeStatus, gate: GateId): { ok: boolean; message: string }
export function applyGatePassed(change: ChangeStatus, gate: GateId, at: string): ChangeStatus   // 返回新对象
export function applyGateFailed(change: ChangeStatus, gate: GateId, at: string, failures: CheckOutcome[]): ChangeStatus
export function applyGateAwaiting(change: ChangeStatus, gate: GateId, at: string): ChangeStatus
export function applyGateApproved(change: ChangeStatus, gate: GateId, at: string): ChangeStatus
export function applyGateRejected(change: ChangeStatus, gate: GateId, reason: string, at: string): ChangeStatus
export function enterStage(change: ChangeStatus, stage: StageId, at: string): ChangeStatus
export function applyVerificationFailure(change: ChangeStatus, failed: { name: string; files: string[]; tests: string[] }[], at: string): { change: ChangeStatus; tasks: TaskCard[] }  // 回 S4 + 修复任务卡草稿
export function lockChange(change: ChangeStatus, reason: string, at: string, detail?: string): ChangeStatus
export function unlockChange(change: ChangeStatus, at: string): ChangeStatus
export function initialStatus(input: ChangeStatusInitInput): ChangeStatus
```
> 单测要求：转移表每条合法转移 + 每个非法转移都有用例，状态机分支覆盖 100%（用 `transitionTable()` 数据驱动测试）。

`src/core/state/scope.ts`
```ts
export function allowedWriteSet(task: TaskCard | null, change: ChangeStatus): { scope: string[]; tests: string[]; newFiles: string[]; changes: PlannedFileChange[] }
export function isAllowedWrite(task: TaskCard | null, change: ChangeStatus, path: string): { allowed: boolean; reason: 'scope'|'tests'|'new-file'|'declared-change'|'undeclared-new-file'|'outside-scope'; hint?: string }
export function isProtectedPath(path: string, config: FlowgateConfig): { protected: boolean; reason?: string }
export function isArtifactWritableInStage(change: ChangeStatus, path: string): boolean   // S0–S3 只能写本变更产物
```

## 2. `src/core/rules/**` + `src/core/shell/**`（负责人：core-kernel）

`src/core/rules/builtin.ts`
```ts
export const BUILTIN_RULES: Rule[]        // R-STAGE-SRC、R-SCOPE、R-NEWFILE、R-DELETE、R-PROTECTED、R-TDD-ORDER、R-DELEGATE、R-MCP、R-PUSH
export function loadRules(config: FlowgateConfig): Rule[]   // 内置 + config.rules 覆盖（同 id 替换）/追加
export function ruleById(rules: Rule[], id: string): Rule | undefined
```

`src/core/rules/evaluate.ts`
```ts
export function fingerprintAction(action: Action): string
export function evaluateRules(input: RuleEvaluationInput): Decision
export function explainDecision(decision: Decision, context: { stage: StageId; changeId?: string }): { short: string; card: Record<string, string> }
export function actionTargetPath(action: Action): string | undefined
```
> 判定顺序固定：受保护路径 → 锁定模式 → 风险触发器（human）→ 阶段策略 → 任务范围 → 新文件控制 → TDD 顺序 → 例外与单次放行 → 默认允许。前面的 deny 不可被后面翻转；`allow` 规则只在没有更早 deny/human 时生效；单次放行只抵消指定规则一次（用掉后记账 `override.used`）。

`src/core/rules/toolclass.ts`
```ts
export type ToolCategory = 'read' | 'write' | 'shell' | 'delegate' | 'mcp' | 'flowgate' | 'unknown'
export interface ToolClassification { tool: string; category: ToolCategory; actionKind?: ActionKind; covered: boolean; reason?: string }
export function classifyTool(tool: string, schemaKeys?: string[]): ToolClassification
export function actionFromToolCall(tool: string, params: Record<string, unknown>): Action | null
export const BLOCKED_DELEGATION_TOOLS: string[]   // subagent, subagent_fork, workflow, send_message, run_code
```

`src/core/rules/risk-triggers.ts`
```ts
export interface TriggerHit { trigger: string; decision: RuleDecision; title: string; detail: string; fingerprint?: string }
export function matchRiskTriggers(input: RuleEvaluationInput): TriggerHit[]
export const DEFAULT_SENSITIVE_PATHS: string[]
export const DEFAULT_DEPENDENCY_FILES: string[]
export const HOTSPOT_PATTERNS: string[]   // 依赖清单/锁文件、路由、DI 配置、迁移、共享类型、i18n、CHANGELOG
export function isHotspot(path: string, config: FlowgateConfig): boolean
```

`src/core/shell/tokenize.ts`
```ts
export interface ParsedCommand { name: string; args: string[]; raw: string; redirects: string[]; background: boolean }
export function tokenizeShell(command: string): string[]            // 处理引号/转义
export function parseCommands(command: string): ParsedCommand[]     // 按 && || ; | 和子 shell 切分；heredoc 正文不参与
export function commandNames(command: string): string[]
export function firstCommandName(command: string): string | null
```
`src/core/shell/classify.ts`
```ts
export function classifyShellCommand(command: string): ShellCommandClass[]
export function isDangerousCommand(command: string): boolean
export function isPushCommand(command: string): boolean
export function isDependencyCommand(command: string): boolean
export function isTestCommand(command: string): boolean
export function isBuildCommand(command: string): boolean
export function isLintCommand(command: string): boolean
export function isMutatingCommand(command: string): boolean
export function validateVerifyCommand(command: string): { ok: boolean; reason?: string }
export function extractWriteTargets(command: string): string[]   // 提示用：>、>>、tee、sed -i、cp/mv 目标；`node -e "const f = x => x * 2"` 不得命中
```
> 误伤回归用例必须覆盖：`node -e "const f = x => x * 2"`、`echo "=> x"`、`git -C ../repo push --force`（命中 danger）、`rsync --delete`。

## 3. `src/core/artifacts/**`（负责人：core-spec）

`src/core/artifacts/parse.ts`
```ts
export function parseClarify(raw: string): ClarifyDoc
export function parseProposal(raw: string): ProposalDoc
export function parseIncrementalSpec(raw: string): SpecDoc
export function parseContext(raw: string): ContextDoc
export function parseDesign(raw: string): DesignDoc
export function parseRisk(raw: string): RiskDoc
export function parseTasks(raw: string): TasksDoc
export function parseProjectDoc(raw: string): ProjectDoc
export function parseRoadmap(raw: string): RoadmapDoc
export function findVagueTerms(text: string): string[]                 // 中英文模糊词表
export function isQuantified(text: string): boolean
export function extractCitationRefs(text: string): CitationRef[]      // `path:12-34` / `path:12`
export function traceabilityMatrix(spec: SpecDoc, tasks: TaskCard[], evidence: EvidenceReceipt[]): TraceMatrix
export interface TraceMatrix { rows: { requirementId: string; scenarioId: string; taskIds: string[]; evidenceIds: string[]; covered: boolean }[]; uncoveredScenarios: string[] }
```
`src/core/artifacts/load.ts`
```ts
export const CHANGE_ARTIFACTS: ArtifactName[]
export function changePaths(root: string, changeId: string): ChangePaths  // 也可从 store 导入
export async function loadArtifacts(fs: FileSystem, root: string, changeId: string): Promise<ArtifactBundle>
export async function loadProjectDoc(fs: FileSystem, root: string): Promise<ProjectDoc | null>
export function artifactHashes(bundle: ArtifactBundle): Record<string, string>
```
`src/core/artifacts/checks.ts`
```ts
export const GATE_CHECKS: GateCheckDefinition[]    // 覆盖 G0/G1/G2/G3/G5/G6/GR 的全部检查项
export function checksForGate(gate: GateId, level: LevelProfile): GateCheckDefinition[]
export async function runGateChecks(ctx: GateCheckContext): Promise<CheckOutcome[]>
// 拆开的单项检查也导出，便于单测：checkClarifySixElements / checkScenariosTestable /
// checkOutOfScope / checkOpenQuestions / checkSpecFormat / checkContextSections /
// checkDesignOptions / checkRiskCategories / checkTaskCards / checkTraceability /
// checkTaskCount / checkNewFiles / checkVerifyCommands / checkFrozenArtifacts / checkAnalysisCitations
```

## 4. `src/core/plan/**` + `src/core/citations/**` + `src/core/detect/**` + `src/core/roadmap/**`（负责人：core-spec）

`src/core/plan/check.ts`
```ts
export function checkExecutionPlan(tasks: TaskCard[], plan: ExecutionPlan, config: FlowgateConfig): CheckOutcome
export function batchOverlaps(tasks: TaskCard[], batch: ExecutionBatch): { a: string; b: string; path: string }[]
export function nextRunnableBatch(change: ChangeStatus): ExecutionBatch | null
export function taskDependenciesRespectBatches(tasks: TaskCard[], plan: ExecutionPlan): string[]
export function renderExecutionDiagram(plan: ExecutionPlan, change: ChangeStatus): string   // mermaid flowchart
export function renderExecutionPlanMarkdown(plan: ExecutionPlan, change: ChangeStatus): string
```
`src/core/citations/verify.ts`
```ts
export function verifyCitations(fs: FileSystem, root: string, refs: CitationRef[], now: string): Promise<CitationCheck[]>
export function citationsFresh(fs: FileSystem, root: string, check: CitationCheck): Promise<boolean>
export function documentCitations(doc: { raw: string }): CitationRef[]
export function citationsStale(fs: FileSystem, root: string, refs: CitationCheck[]): Promise<CitationCheck[]>
```
`src/core/detect/stack.ts`
```ts
export interface DetectedStack {
  kind: 'maven'|'gradle'|'node'|'python'|'go'|'rust'|'unknown'
  name: string
  stackFacts: SourceFact[]
  commands: CommandSettings
  modules: ProjectModuleInfo[]
  readFiles: string[]
  risks: string[]
}
export async function detectTechStack(fs: FileSystem, root: string): Promise<DetectedStack>
export function renderProjectDocDraft(stack: DetectedStack, now: string): string
```
`src/core/roadmap/check.ts`
```ts
export function checkRoadmap(roadmap: RoadmapDoc, project: ProjectDoc | null, config: FlowgateConfig): CheckOutcome[]
export function firstChangeIsSkeleton(roadmap: RoadmapDoc): boolean
export function roadmapStatusLine(roadmap: RoadmapDoc): string
export function nextRoadmapChange(roadmap: RoadmapDoc): RoadmapEntry | null
```

## 5. `src/core/ledger/**` + `src/core/store/**`（负责人：core-runtime-a）

`src/core/ledger/ledger.ts`
```ts
export interface LedgerEventInput { type: LedgerEventType; data?: Record<string, unknown>; at?: string }
export interface Ledger {
  append(input: LedgerEventInput): Promise<LedgerEvent>
  readAll(): Promise<LedgerEvent[]>
  verify(): Promise<LedgerVerification>
  lastSeq(): Promise<number>
}
export function createLedger(options: { fs: FileSystem; path: string; key: string; clock: Clock; sessionAppend?: (event: LedgerEvent) => void }): Ledger
export function contentHash(event: Omit<LedgerEvent,'mac'>): string   // sha256(stable JSON)
export function signEvent(event: Omit<LedgerEvent,'mac'>, key: string): string
```
`src/core/store/layout.ts`
```ts
export interface FlowgateLayout { root: string; dir: string; config: string; projectDoc: string; roadmap: string; changesIndex: string; changesDir: string; archiveDir: string; specsDir: string; rulesDir: string; stateDir: string; ledger: string; sessions: string; snapshotsDir: string; evidenceDir: string; worktreesDir: string; metricsDir: string; retro: string; dashboard: string; keyPath: string }
export interface ChangePaths { dir: string; clarify: string; proposal: string; spec: string; context: string; design: string; risk: string; tasks: string; analysis: string; executionPlan: string; status: string; handoff: string; evidence: string; review: string; report: string }
export function layout(root: string): FlowgateLayout
export function changePaths(root: string, changeId: string): ChangePaths
export function isInitialized(fs: FileSystem, root: string): Promise<boolean>
export function scaffold(fs: FileSystem, root: string): Promise<void>        // 建目录 + README + 目录内 .gitignore + 默认 config.yaml
```
`src/core/store/config.ts`
```ts
export const DEFAULT_CONFIG: FlowgateConfig
export async function loadConfig(fs: FileSystem, root: string): Promise<FlowgateConfig>   // 解析 YAML，合并默认；损坏时抛 ConfigError
export function parseConfig(text: string): FlowgateConfig
export function configHash(config: FlowgateConfig): string
```
`src/core/store/state.ts`
```ts
export async function loadProjectState(ports: { fs: FileSystem; root: string; config: FlowgateConfig; clock: Clock }): Promise<ProjectState>
export async function readChangeStatus(fs: FileSystem, root: string, changeId: string): Promise<ChangeStatus | null>
export async function writeChangeStatus(fs: FileSystem, root: string, change: ChangeStatus): Promise<void>
export async function listChanges(fs: FileSystem, root: string): Promise<ChangeStatus[]>
export function renderChangesIndex(changes: ChangeStatus[]): string
export async function writeChangesIndex(fs: FileSystem, root: string, changes: ChangeStatus[]): Promise<void>
export async function readLeases(fs: FileSystem, root: string): Promise<SessionLease[]>
export async function writeLeases(fs: FileSystem, root: string, leases: SessionLease[]): Promise<void>
export function nextChangeId(changes: ChangeStatus[], kind: ChangeKind): string   // C-001 / A-001
export function nextPendingId(pending: PendingItem[], kind: PendingKind): string  // RK-1 / SC-1 ...
export async function ensureChangeDir(fs: FileSystem, root: string, changeId: string): Promise<void>
```
`src/core/store/freeze.ts`
```ts
export function freezeContract(config: FlowgateConfig, pluginVersion: string, skills: Record<string,string>, at: string): ContractSnapshot
export function artifactsFingerprint(bundle: ArtifactBundle): Record<string,string>
export function assertNotFrozen(change: ChangeStatus, path: string): { frozen: boolean; hint?: string }
export async function assertArtifactsUnmodified(fs: FileSystem, root: string, change: ChangeStatus): Promise<{ modified: string[] }>
```

`src/core/risk/risk.ts`
```ts
export function checkRiskDoc(doc: RiskDoc | null, profile: LevelProfile): CheckOutcome[]
export function riskRaisedEffects(change: ChangeStatus): { refreezeReviews: string[]; backToStage?: StageId }
export function riskTriggerPending(hit: TriggerHit, changeId: string, at: string): PendingDraft
```
`src/core/revision/revision.ts`
```ts
export type ReworkKind = 'defect' | 'requirement' | 'unknown'
export function invalidateOnRework(change: ChangeStatus, input: { kind: ReworkKind; taskIds?: string[]; sharedInputsChanged?: string[] }): { invalidatedTasks: string[]; keptTasks: string[]; stage: StageId }
```

## 6. `src/core/evidence/**`（负责人：core-runtime-b）

`src/core/evidence/parse.ts`
```ts
export interface ParseInput { command: string; stdout: string; stderr: string; exitCode: number; reportFiles?: { path: string; content: string }[]; now?: string }
export function parseTestOutput(input: ParseInput): TestSummary
export function parseJUnitXml(xml: string): TestSummary
export function parseMavenConsole(output: string): TestSummary
export function parseGradleConsole(output: string): TestSummary
export function parsePytestConsole(output: string): TestSummary
export function parseVitestConsole(output: string): TestSummary
export function parseJestConsole(output: string): TestSummary
export function parseGoTestJson(output: string): TestSummary
export function parseCargoConsole(output: string): TestSummary
export function detectEvidenceKind(command: string): EvidenceKind
export function evidencePhase(summary: TestSummary | null, exitCode: number): EvidencePhase
```
`src/core/evidence/hash.ts`
```ts
export async function hashInputs(fs: FileSystem, root: string, inputs: string[]): Promise<{ hash: string; files: string[]; missing: string[] }>
export function selectReceiptsForGroup(receipts: EvidenceReceipt[], group: string): EvidenceReceipt[]
export function buildEvidenceView(receipts: EvidenceReceipt[]): EvidenceView
export function receiptFreshness(receipt: EvidenceReceipt | undefined, inputsHash: string): EvidenceFreshness
export function latestReceiptWins(a: EvidenceReceipt, b: EvidenceReceipt): EvidenceReceipt
```
`src/core/evidence/run.ts`
```ts
export interface RunVerifyOptions { fs: FileSystem; root: string; runner: CommandRunner; change: ChangeStatus; task: TaskCard; group: VerifyGroup; clock: Clock; nextEvidenceId: () => string }
export async function runVerifyGroup(options: RunVerifyOptions): Promise<EvidenceReceipt>
export interface BaselineResult { commit: string | null; summary: TestSummary; receipts: EvidenceReceipt[]; failedTests: string[] }
export async function runFullSuite(options: Omit<RunVerifyOptions,'task'|'group'> & { command: string; inputs: string[]; baseline?: BaselineResult }): Promise<EvidenceReceipt>
export function compareWithBaseline(baseline: BaselineResult | null, current: TestSummary): { regressions: string[]; newPasses: string[]; ok: boolean }
export function summarizeEvidenceForContext(receipt: EvidenceReceipt, maxTokens: number): string   // ≤400 token：失败用例名 + 首行错误 + 完整日志路径
export function truncateOutput(output: string, maxChars: number): { text: string; truncated: boolean }
```
`src/core/metrics/metrics.ts`
```ts
export function computeMetrics(input: { change: ChangeStatus; ledger: LedgerEvent[]; artifacts: ArtifactBundle; evidence: EvidenceReceipt[]; now: string }): MetricSet
export function formatMetricsText(set: MetricSet): string
export function metricsCsv(set: MetricSet): string
```
`src/core/report/report.ts` + `src/core/dashboard/dashboard.ts`
```ts
export function renderChangeReport(input: ReportInput): string          // 单文件 HTML，内联 CSS/JS，<2MB
export interface ReportInput { change: ChangeStatus; artifacts: ArtifactBundle; evidence: EvidenceReceipt[]; ledger: LedgerEvent[]; reviews: ReviewRecord[]; metrics: MetricSet; generatedAt: string }
export function renderDashboard(input: DashboardInput): string         // 跨会话看板 HTML
export interface DashboardInput { changes: ChangeStatus[]; snapshot?: RuntimeSnapshot; pending: PendingItem[]; generatedAt: string }
export const STAGE_LEARNING_CARDS: Record<StageId, LearningCard>        // 7 阶段学习卡（六部分全文），client 与报告共用
export interface LearningCard { what: string; why: string; criteria: string[]; upstream: string; antiPatterns: string[]; good: string; bad: string }
```

## 7. 引擎（Lead 实现，host 只调用它）

`src/core/engine.ts` 导出 `class FlowEngine`：
- 构造：`new FlowEngine(ports: EnginePorts & { root: string })`
- 只读：`snapshot(): RuntimeSnapshot`、`change(id): ChangeStatus | undefined`、`isInitialized(): boolean`
- 生命周期：`load()`、`status()`、`refresh()`
- 命令/工具用用例：`init()`、`newChange(input)`、`submitGate(gate)`、`approveGate(gate, opts)`、`rejectGate(gate, reason)`、`evaluateAction(action, caller)`、`recordPostcheck(...)`、`executeVerify(...)`、`taskStart/taskDone/...`、`attach/resume/pause/takeover`、`off/on`、`doctor/repair`、`metrics/report/dashboard/board`
- 每次状态变化后 `reload()` 并触发 `onStateChange` 回调（host 投影用）。

## 实现偏差记录（实现期确认，以此为准）

1. `createLedger` 的 `sessionAppend` 实际签名：`(type: string, data: Record<string, unknown>) => void`（与 DSH session 追加一致）。
2. `ChangePaths` 增加可选 `specsDir`；新增 `findIncrementalSpec(fs, root, changeId)`；`changePaths().spec = changes/<id>/specs/spec.md`。
3. `nextPendingId(pending, kind, knownIds?: string[])` 增加可选第三参（跨变更取最大序号 + 1）。
4. `revision` 的 input 增加可选 `dependsOn?: Record<string, string[]>`（engine 从 tasks.md 传入依赖图）。
5. 额外导出（engine/host 可用）：`GENESIS_PREV`、`lineHash`、`renderFlowgateGitignore`、`ConfigError`、`configPath`、`renderConfigYaml`、`readLedgerEvents`、`foldLedgerToChanges`、`formatActivityTime`、`artifactKeyForPath`、`LEDGER_KEY_PATH`、`DEFAULT_CONFIG_PATH`、`rebuildState`。
6. `GateCheckContext` 增加必填 `gate: GateId` 与 `level: LevelProfile`（engine 传入当前门与生效等级矩阵）。
7. `FlowgateConfig` 增加 `review: { enabled; model?: string | null; requireForTaskGate }`；`ProjectState`/`ChangeStatus` 增加 `plan?/newTasks?/scopeAdditions?/baseline?/externalChanges?`；`TaskState` 增加 `redObserved?`。
8. 账本每次持久化变更时追加 `change.updated` 事件（data: `{ changeId, change: <完整 ChangeStatus> }`），`/flow repair` 用它精确重建。
