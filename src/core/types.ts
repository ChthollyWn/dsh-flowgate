/**
 * FlowGate shared domain contracts.
 *
 * This file is the single source of truth for types crossing module boundaries
 * (core <-> host <-> client projection). It must stay free of imports from DSH
 * packages: the core runs as plain TypeScript and is unit-testable without the
 * host, and the host adapts DSH to these contracts.
 */
import type { FileSystem, Clock } from './util/fs'

export type { FileSystem, Clock } from './util/fs'

// ---------------------------------------------------------------------------
// Pipeline vocabulary
// ---------------------------------------------------------------------------

export const STAGES = ['roadmap', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'archived'] as const
export type StageId = (typeof STAGES)[number]
export type PipelineStage = Exclude<StageId, 'roadmap' | 'archived' | 'locked'>
export type RuntimeStage = StageId | 'locked'

export const GATES = ['GR', 'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'TG'] as const
export type GateId = (typeof GATES)[number]
export type HumanGateId = 'GR' | 'G1' | 'G3' | 'G6'
export type AutoGateId = 'G0' | 'G2' | 'G4' | 'G5' | 'TG'

export const COMPLEXITIES = ['low', 'medium', 'high', 'ultra'] as const
export type Complexity = (typeof COMPLEXITIES)[number]

export const RISK_LEVELS = ['normal', 'high'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export type ChangeKind = 'change' | 'analysis'
export type ChangeLifecycle = 'active' | 'paused' | 'archived' | 'blocked' | 'locked'
export type GateStateName = 'pending' | 'awaiting' | 'passed' | 'failed' | 'rejected' | 'skipped'
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'review'
  | 'done'
  | 'blocked'
  | 'interrupted'
  | 'failed'
  | 'skipped'
export type TddState = 'none' | 'red' | 'green'
export type BatchMode = 'sequential' | 'parallel'
export type BatchStatus = 'pending' | 'running' | 'checkpoint' | 'done' | 'failed' | 'blocked'
export type DispatchMode = 'auto' | 'subagent' | 'inline'
export type LearningMode = 'detail' | 'brief' | 'off'

export type PendingKind =
  | 'risk'
  | 'scope'
  | 'plan'
  | 'rule'
  | 'override'
  | 'exception'
  | 'conflict'
  | 'blocker'
  | 'tamper'
export const PENDING_PREFIX: Record<PendingKind, string> = {
  risk: 'RK',
  scope: 'SC',
  plan: 'PC',
  rule: 'RL',
  override: 'OV',
  exception: 'EX',
  conflict: 'CF',
  blocker: 'BL',
  tamper: 'TM',
}

// ---------------------------------------------------------------------------
// Actions (what the agent is about to do)
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'write'
  | 'create'
  | 'delete'
  | 'rename'
  | 'read'
  | 'shell'
  | 'dependency'
  | 'push'
  | 'delegate'
  | 'mcp'
  | 'other'

export interface FileAction {
  kind: 'write' | 'create' | 'delete' | 'rename' | 'read'
  tool: string
  /** Repository-relative path. */
  path: string
  /** For rename: destination path. */
  toPath?: string
  /** Write/edit payload used for secret detection; never persisted verbatim. */
  content?: string
}

export interface ShellAction {
  kind: 'shell'
  tool: string
  command: string
  cwd?: string
}

export interface DelegateAction {
  kind: 'delegate'
  tool: string
  target?: string
}

export interface GenericAction {
  kind: 'other' | 'mcp' | 'delegate'
  tool: string
  detail?: string
}

export type Action = FileAction | ShellAction | DelegateAction | GenericAction

export interface CallerInfo {
  /** Host tool name that invoked the guard. */
  tool: string
  /** Agent identity when the host can provide it (H18/H22). */
  agentId?: string
  /** `main` for the conversation agent, `flowgate-executor` for dispatched children. */
  agentRole?: 'main' | 'executor' | 'reviewer' | 'investigator' | 'unknown'
  /** Current working directory of the caller (worktree-aware). */
  cwd?: string
  /** Change/task the caller is operating on, when dispatched by FlowGate. */
  dispatch?: { changeId: string; taskId: string; worktree?: string }
}

// ---------------------------------------------------------------------------
// Rules and decisions
// ---------------------------------------------------------------------------

export type RuleDecision = 'allow' | 'deny' | 'human'

export interface RuleCondition {
  stage?: PipelineStage[] | StageId[]
  action?: ActionKind[]
  /** Glob matched against the target path (file actions). */
  path?: string
  /** Globs excluded from `path`. */
  except?: string[]
  /** Tool names this rule applies to. */
  tool?: string[]
  /** `scope`: action target must be inside the active task's allowed set. */
  outside?: 'task.scope' | 'task.allowed'
  /** Require content to match a secret pattern. */
  secret?: boolean
  /** Command classification (shell actions). */
  command?: ShellCommandClass[]
  /** Only apply while a pending item of this kind exists. */
  pending?: PendingKind
  /** Restrict to change kinds, e.g. analysis tasks are read-only. */
  changeKind?: ChangeKind[]
}

export type ShellCommandClass = 'dangerous' | 'push' | 'dependency' | 'test' | 'build' | 'lint' | 'mutating' | 'readonly'

export interface Rule {
  id: string
  when: RuleCondition
  decision: RuleDecision
  why: string
  unlock: string
  source?: string
  builtin?: boolean
}

export interface RuleMatch {
  ruleId: string
  decision: RuleDecision
  why: string
  unlock: string
  source?: string
}

export interface Decision {
  effect: RuleDecision
  /** Matched rule; undefined when the default allow applies. */
  rule?: RuleMatch
  /** Short agent-facing message (Chinese). Empty for allow. */
  message: string
  /** Pending item draft created when the effect is `human`. */
  pendingDraft?: PendingDraft
  /** Override id consumed by this decision, when a single-use override applied. */
  overrideUsed?: string
  /** Exception id that allowed the action. */
  exceptionUsed?: string
  /** Non-fatal notes surfaced to the panel (e.g. non-agent changes). */
  notes?: string[]
  /** True when a deny/human rule was auto-downgraded to a hint (M-5 misfire rate). */
  hinted?: boolean
}

export interface PendingDraft {
  kind: PendingKind
  title: string
  detail: string
  /** Fingerprint of the action this approval unlocks (single use). */
  actionFingerprint?: string
  /** Extra structured data (e.g. scope paths). */
  data?: Record<string, unknown>
}

export interface RuleEvaluationInput {
  action: Action
  caller: CallerInfo
  stage: StageId
  change?: ChangeStatus
  config: FlowgateConfig
  task?: TaskCard
  overrides: OverrideRecord[]
  exceptions: ExceptionRecord[]
  pending: PendingItem[]
  violations: Violation[]
  projectRoot: string
}

// ---------------------------------------------------------------------------
// Configuration (.flowgate/config.yaml)
// ---------------------------------------------------------------------------

export interface LevelSettings {
  /** `auto`: the plugin suggests a level and the owner confirms. */
  complexity: 'auto' | Complexity
  risk: 'auto' | RiskLevel
}

export interface CommandSettings {
  test?: string | 'none'
  integration?: string
  lint?: string
  build?: string
  typecheck?: string
  run?: string
  health?: string
}

export interface LimitSettings {
  task_max_files: number
  change_max_tasks: number
  clarify_max_rounds: number
  turn_continue_max: number
  test_output_summary_tokens: number
  context_warn_ratio: number
  token_budget: Record<Complexity, number>
}

export interface ParallelSettings {
  max_agents: number
  setup: string | null
  hotspots_extra: string[]
}

export interface SessionSettings {
  lease_minutes: number
}

export interface GitSettings {
  change_branch: boolean
  auto_commit: boolean
  commit_flowgate: boolean
}

export interface TriggerSettings {
  sensitive_paths: string[]
  sensitive_paths_extra: string[]
  dependency_files: string[]
  protected_paths: string[]
  secret_patterns: 'builtin' | 'builtin+extra'
  max_scope_new_files: number
  consecutive_failure_limit: number
}

export interface ReviewSettings {
  enabled: boolean
  /** Model override for the reviewer subagent; null = host default. */
  model?: string | null
  /** Treat missing review as blocking for medium+ complexity. */
  requireForTaskGate: boolean
}

export interface FlowgateConfig {
  levels: LevelSettings
  learning: LearningMode
  dispatch: DispatchMode
  commands: CommandSettings
  limits: LimitSettings
  parallel: ParallelSettings
  session: SessionSettings
  git: GitSettings
  review: ReviewSettings
  ignore: string[]
  rules: Rule[]
  triggers: TriggerSettings
}

// ---------------------------------------------------------------------------
// Artifacts (files the agent writes during the pipeline)
// ---------------------------------------------------------------------------

export type SixElementKey = 'goal' | 'boundary' | 'roles' | 'acceptance' | 'constraints' | 'unknowns'
export const SIX_ELEMENTS: SixElementKey[] = ['goal', 'boundary', 'roles', 'acceptance', 'constraints', 'unknowns']

export interface SourceFact {
  text: string
  citations: CitationRef[]
  /** confirmed: backed by a verified source citation. */
  status: 'confirmed' | 'derived' | 'assumption' | 'pending'
}

export interface ClarifyQA {
  question: string
  options: string[]
  answer: string
  /** Required: "this answer changed what". */
  changed: string
  round: number
}

export interface ClarifyDoc {
  raw: string
  originalDescription: string
  knownFacts: SourceFact[]
  elements: Record<SixElementKey, { conclusion: string; source: string; status: string }>
  qa: ClarifyQA[]
  assumptions: string[]
  openQuestions: string[]
  rounds: number
}

export interface ProposalDoc {
  raw: string
  why: string
  what: string
  impact: string
  outOfScope: string[]
}

export interface Scenario {
  id: string
  requirementId: string
  title: string
  given: string[]
  when: string[]
  then: string[]
  raw: string
}

export interface Requirement {
  id: string
  title: string
  text: string
  scenarios: Scenario[]
  /** ADDED / MODIFIED / REMOVED, from the incremental spec. */
  changeType: 'ADDED' | 'MODIFIED' | 'REMOVED'
}

export interface SpecDoc {
  raw: string
  requirements: Requirement[]
  scenarios: Scenario[]
}

export interface ContextSection {
  title: string
  body: string
  citations: CitationRef[]
}

export interface ContextDoc {
  raw: string
  sections: ContextSection[]
}

export interface DesignOption {
  name: string
  summary: string
  pros: string[]
  cons: string[]
}

export interface DesignDoc {
  raw: string
  options: DesignOption[]
  recommendation: string
  dataFlow: string
  errorHandling: string
  rollback: string
  architecture?: string
}

export type RiskCategory = 'security' | 'performance' | 'cost' | 'compliance' | 'maintainability'
export const RISK_CATEGORIES: RiskCategory[] = ['security', 'performance', 'cost', 'compliance', 'maintainability']
export type RiskGrade = 'none' | 'low' | 'medium' | 'high'

export interface RiskEntry {
  category: RiskCategory
  grade: RiskGrade
  reason: string
  mitigation: string
  verification: string
  needsHuman: boolean
}

export interface RiskDoc {
  raw: string
  entries: RiskEntry[]
}

export interface VerifyGroup {
  group: string
  command: string
  inputs: string[]
}

export interface PlannedFileChange {
  path: string
  kind: 'delete' | 'rename'
  to?: string
}

export interface TaskCard {
  id: string
  title: string
  covers: string[]
  scope: string[]
  tests: string[]
  newFiles: string[]
  changes: PlannedFileChange[]
  dependsOn: string[]
  tdd: 'required' | 'optional'
  tddReason?: string
  verify: VerifyGroup[]
  run: 'main' | 'subagent' | 'auto'
  runReason?: string
  /**
   * Runtime-only marker for auto-generated repair tasks (FIX-n). They use the
   * failing command as a `fix` verify group instead of RED→GREEN TDD, and are
   * exempt from `levels.tddRequiredAll` (high risk) so they stay completable.
   */
  autoRepair?: boolean
  risk: string[]
  size: 'S' | 'M' | 'L'
  choreReason?: string
  body: string
  /** Runtime additions approved through a scope change (not written back to the frozen tasks.md). */
  approvedScope?: string[]
  approvedNewFiles?: string[]
}

export interface ExecutionBatch {
  batch: string
  mode: BatchMode
  tasks: string[]
  why: string
  /** Runtime annotation when a batch was downgraded (e.g. parallel -> sequential). */
  downgraded?: string
  /** Set on auto-generated repair batches: the failed batch this batch repairs. */
  retryOf?: string
}

export interface ExecutionPlan {
  batches: ExecutionBatch[]
}

export interface TasksDoc {
  raw: string
  tasks: TaskCard[]
  execution: ExecutionPlan
}

export interface RoadmapEntry {
  change: string
  capability: string
  goal: string
  acceptance: string
  dependsOn: string[]
  estimatedTasks: number | null
  mvp: boolean
  status: '未开始' | '进行中' | '已交付' | 'paused' | string
}

export interface RoadmapDoc {
  raw: string
  title: string
  mvpCut: string
  entries: RoadmapEntry[]
}

export interface ProjectModuleInfo {
  path: string
  responsibility: string
}

export interface ProjectDoc {
  raw: string
  name: string
  stack: SourceFact[]
  modules: ProjectModuleInfo[]
  commands: CommandSettings
  conventions: string[]
  forbidden: string[]
  reusable: string[]
  /** Files actually inspected while generating the doc (FR-3.1 evidence). */
  readFiles: string[]
  claims: SourceFact[]
}

export interface ArtifactBundle {
  clarify?: ClarifyDoc
  proposal?: ProposalDoc
  spec?: SpecDoc
  context?: ContextDoc
  design?: DesignDoc
  risk?: RiskDoc
  tasks?: TasksDoc
  project?: ProjectDoc
}

export type ArtifactName = keyof ArtifactBundle

// ---------------------------------------------------------------------------
// Citations (verifiable source references)
// ---------------------------------------------------------------------------

export interface CitationRef {
  file: string
  startLine: number
  endLine: number
  quote?: string
}

export interface CitationCheck {
  citation: CitationRef
  ok: boolean
  hash?: string
  verifiedAt?: string
  stale?: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Evidence (plugin-executed verification receipts)
// ---------------------------------------------------------------------------

export type EvidenceKind = 'test' | 'build' | 'lint' | 'typecheck' | 'run' | 'manual'
export type EvidencePhase = 'red' | 'green' | 'none' | 'unknown'

export interface TestFailure {
  name: string
  file?: string
  line?: number
  message?: string
}

export interface TestSummary {
  parser: string
  parsed: boolean
  run: number
  passed: number
  failed: number
  skipped: number
  failures?: TestFailure[]
  durationMs?: number
  regressions?: string[]
}

export interface EvidenceReceipt {
  id: string
  changeId: string
  taskId?: string
  group: string
  kind: EvidenceKind
  phase: EvidencePhase
  command: string
  runBy: 'flowgate' | 'agent'
  exitCode: number
  summary: TestSummary | null
  inputsHash: string
  outputRef: string
  startedAt: string
  finishedAt: string
  timedOut?: boolean
  notes?: string
}

export interface EvidenceFreshness {
  fresh: boolean
  reason?: 'no-receipt' | 'inputs-changed' | 'superseded' | 'no-green' | 'failed'
  receipt?: EvidenceReceipt
  changedInputs?: string[]
}

export interface EvidenceView {
  receipts: EvidenceReceipt[]
  /** Freshest receipt per group (latest by finishedAt). */
  latestByGroup: Record<string, EvidenceReceipt>
  /** True when the latest receipt in the group was a failure. */
  latestFailed: Record<string, boolean>
}

export interface TraceMatrix {
  rows: {
    requirementId: string
    scenarioId: string
    title?: string
    taskIds: string[]
    evidenceIds: string[]
    covered: boolean
  }[]
  uncoveredScenarios: string[]
}

// ---------------------------------------------------------------------------
// Verification runner ports
// ---------------------------------------------------------------------------

export interface CommandRunOptions {
  cwd: string
  timeoutMs: number
  env?: Record<string, string>
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export interface CommandRunner {
  run(command: string, options: CommandRunOptions): Promise<CommandResult>
}

export interface GitPort {
  isRepo(cwd: string): Promise<boolean>
  head(cwd: string): Promise<string | null>
  currentBranch(cwd: string): Promise<string | null>
  branchExists(cwd: string, branch: string): Promise<boolean>
  createBranch(cwd: string, branch: string): Promise<void>
  checkout(cwd: string, branch: string, create?: boolean): Promise<void>
  statusPorcelain(cwd: string): Promise<string>
  diffNames(cwd: string, fromSnapshot?: string): Promise<string[]>
  diffText(cwd: string, base?: string): Promise<string>
  showFile(cwd: string, ref: string, path: string): Promise<string | null>
  add(cwd: string, paths: string[]): Promise<void>
  commit(cwd: string, message: string): Promise<void>
  push(cwd: string, remote?: string, branch?: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Persistent change state (changes/<id>/status.json)
// ---------------------------------------------------------------------------

/**
 * 冻结时用于判定的配置子集。
 *
 * 只冻结会改变判定结果的部分：规则、风险触发器、等级定义与数量/预算限制。
 * 命令、派发、并行、学习模式等不属于「契约」（变更期间可调整）。
 */
export interface ContractConfigSnapshot {
  rules: Rule[]
  triggers: TriggerSettings
  levels: LevelSettings
  limits: LimitSettings
}

export interface ContractSnapshot {
  plugin: string
  rules: string
  levels: string
  skills: Record<string, string>
  createdAt: string
  /**
   * 完整判定快照（v0.1 验收 T1.3 起写入）。在途变更按它判定，之后改
   * `config.yaml` 只影响新建变更；旧状态没有该字段时回退当前配置。
   */
  snapshot?: ContractConfigSnapshot
}

export interface GateRecord {
  state: GateStateName
  items?: CheckOutcome[]
  submittedAt?: string
  passedAt?: string
  approvedAt?: string
  rejectedAt?: string
  rejectedReason?: string
  attempts: number
}

export interface TaskState {
  id: string
  batch: string
  status: TaskStatus
  tdd: TddState
  evidenceIds: string[]
  reviewIds: string[]
  worktree?: string
  agent?: string
  startedAt?: string
  finishedAt?: string
  interruptedAt?: string
  failureCount?: number
  blockReason?: string
  /** True once a failing (RED) receipt was recorded for this task. */
  redObserved?: boolean
}

export interface BatchState {
  id: string
  mode: BatchMode
  status: BatchStatus
  tasks: string[]
  startedAt?: string
  completedAt?: string
  /** Set on auto-generated repair batches: the failed batch this batch repairs. */
  retryOf?: string
  checkpoint?: {
    status: 'passed' | 'failed' | 'conflict'
    at: string
    detail?: string
    /** Number of failed integration-checkpoint attempts (repair-loop guard). */
    attempts?: number
  }
}

export interface PendingActionScope {
  changeId: string
  taskId?: string
  ruleId?: string
  paths?: string[]
  command?: string
  actionFingerprint?: string
}

export interface PendingItem {
  id: string
  kind: PendingKind
  changeId: string
  title: string
  detail: string
  status: 'open' | 'approved' | 'rejected' | 'expired'
  createdAt: string
  decidedAt?: string
  decisionReason?: string
  scope?: PendingActionScope
  data?: Record<string, unknown>
}

export interface OverrideRecord {
  id: string
  ruleId: string
  changeId: string
  reason: string
  actionFingerprint: string
  createdAt: string
  usedAt?: string
  usedBy?: string
}

export interface ExceptionRecord {
  id: string
  ruleId: string
  changeId: string
  pathPattern?: string
  reason: string
  createdAt: string
  revokedAt?: string
  revokedReason?: string
}

export interface Violation {
  id: string
  changeId: string
  taskId?: string
  path: string
  kind: 'outside-scope' | 'undeclared-new-file' | 'undeclared-delete' | 'protected-path'
  detectedAt: string
  source: 'pre' | 'post'
  clearedAt?: string
  detail?: string
}

export interface WorkingTreeEntry {
  path: string
  status: string
  origin?: 'agent' | 'external' | 'unknown'
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor'
  file: string
  line?: number
  rule: string
  message: string
  suggestion?: string
}

export interface ReviewRecord {
  id: string
  changeId: string
  taskId?: string
  kind: 'task' | 'final' | 'security'
  verdict: 'pass' | 'changes-required'
  findings: ReviewFinding[]
  coverageOk: boolean
  diffFingerprint: string
  createdAt: string
  attempts: number
  waived?: boolean
  waivedReason?: string
}

export interface HandoffSummary {
  at: string
  stage: StageId
  taskId?: string
  decisions: string[]
  openItems: string[]
  next: string
  text: string
}

export interface ChangeStatus {
  id: string
  kind: ChangeKind
  title: string
  summary?: string
  complexity: Complexity
  risk: RiskLevel
  stage: StageId
  lifecycle: ChangeLifecycle
  contract?: ContractSnapshot
  gates: Partial<Record<GateId, GateRecord>>
  branch?: string
  batches: BatchState[]
  tasks: Record<string, TaskState>
  evidenceIds: string[]
  pending: PendingItem[]
  overrides: OverrideRecord[]
  exceptions: ExceptionRecord[]
  violations: Violation[]
  reviews: ReviewRecord[]
  handoff?: HandoffSummary
  session?: { attached?: string; heartbeat?: string }
  roadmap?: string
  relatedTo?: string
  off?: boolean
  lock?: { reason: string; at: string; detail?: string }
  clarifyRounds?: number
  /** Runtime execution plan (mirrors tasks.md, updated by approved plan amendments). */
  plan?: ExecutionPlan
  /** Runtime task cards added by an approved plan amendment. */
  newTasks?: TaskCard[]
  /** Approved scope additions per task id. */
  scopeAdditions?: Record<string, string[]>
  /** S2 baseline test result used for S5 regression comparison. */
  baseline?: { commit: string | null; summary: TestSummary; recordedAt: string; receiptId?: string }
  /** Changes detected between agent calls (manual edits, formatters) pending owner confirmation. */
  externalChanges?: { path: string; at: string; origin: 'external' | 'unknown'; confirmedAt?: string }[]
  /** 会话释放/暂停时记录的工作区状态；新会话接续时对比出「会话之间的非 agent 改动」。 */
  worktreeSnapshot?: { at: string; statusPorcelain: string; paths: string[] }
  /** 宿主上报的本变更累计 token 用量（token-meter 可用时）；无数据不填。 */
  tokenUsage?: number
  /** 已经被加载过的阶段技能回执（T2.4：核心技能必须在过门前加载）。 */
  skillReceipts?: { name: string; hash: string; at: string; sessionId?: string }[]
  /** G1/G2 核验过的源码引用及其文件哈希；文件改动后标记待复核（T2.10）。 */
  citationChecks?: CitationCheck[]
  /** 任务卡声明的删除/重命名：git HEAD 原内容快照（路径在 .flowgate/changes/<id>/evidence/original/ 下）。 */
  originalSnapshots?: { taskId: string; path: string; kind: 'delete' | 'rename'; storedPath: string; at: string }[]
  /** Highest artifact hashes frozen at gate approval. */
  frozen?: Record<string, { hash: string; at: string }>
  createdAt: string
  updatedAt: string
}

export interface SessionLease {
  sessionId: string
  changeId: string
  attachedAt: string
  heartbeatAt: string
  /** Free-form host label for the panel, e.g. "web-1a2b". */
  label?: string
}

export interface ProjectState {
  root: string
  initialized: boolean
  config: FlowgateConfig
  project?: ProjectDoc
  roadmap?: RoadmapDoc
  changes: ChangeStatus[]
  leases: SessionLease[]
  ledgerSeq: number
  locked?: { reason: string; at: string; detail?: string }
}

// ---------------------------------------------------------------------------
// Gate checks
// ---------------------------------------------------------------------------

export interface CheckOutcome {
  item: string
  label: string
  passed: boolean
  hint?: string
  example?: string
  details?: string[]
  /** P0 vs P1 gate items; only P0 items block in v0.5 mode. */
  priority?: 'P0' | 'P1'
}

export interface LevelProfile {
  complexity: Complexity
  risk: RiskLevel
  requiresDesign: boolean
  requiresDesignOptions: boolean
  requiresRiskDoc: boolean
  requiresExecutionPlan: boolean
  reviewRoundsPerTask: 0 | 1 | 2
  securityReview: boolean
  tddRequiredAll: boolean
  runtimeEvidenceRequired: boolean
  manualEvidenceConfirmed: boolean
  /** Low complexity: G1 and G3 merge into one confirmation card. */
  mergedGates: boolean
  maxTasks: number
  stages: StageId[]
}

export interface GateCheckContext {
  root: string
  gate: GateId
  level: LevelProfile
  change: ChangeStatus
  config: FlowgateConfig
  artifacts: ArtifactBundle
  fs: FileSystem
  git?: GitPort
  commandRunner?: CommandRunner
  /** Evidence receipts for this change (already filtered). */
  evidence: EvidenceReceipt[]
  project: ProjectDoc | null
  roadmap: RoadmapDoc | null
  /** Current time, ISO. */
  now: string
  limits: LimitSettings
}

export interface GateCheckDefinition {
  id: string
  label: string
  /** Which gates this item belongs to. */
  gates: GateId[]
  /** Only evaluate when the predicate holds. */
  when?: (ctx: GateCheckContext) => boolean
  /** Returns failures for this item; empty array means passed. */
  check: (ctx: GateCheckContext) => Promise<CheckOutcome> | CheckOutcome
  priority?: 'P0' | 'P1'
}

export interface GateResult {
  gate: GateId
  passed: boolean
  awaiting?: 'owner'
  items: CheckOutcome[]
  failures: CheckOutcome[]
  /** Present when the state change was applied. */
  stage?: StageId
  message: string
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerEventType =
  | 'change.created'
  | 'stage.entered'
  | 'gate.submitted'
  | 'gate.failed'
  | 'gate.passed'
  | 'gate.approved'
  | 'gate.rejected'
  | 'pending.expired'
  | 'rule.denied'
  | 'rule.human'
  | 'rule.hinted'
  | 'override.granted'
  | 'override.used'
  | 'exception.added'
  | 'exception.revoked'
  | 'scope.requested'
  | 'scope.approved'
  | 'scope.rejected'
  | 'risk.raised'
  | 'risk.approved'
  | 'risk.rejected'
  | 'task.started'
  | 'task.done'
  | 'task.blocked'
  | 'task.unblocked'
  | 'evidence.recorded'
  | 'review.reported'
  | 'violation.detected'
  | 'violation.cleared'
  | 'tamper.detected'
  | 'lock.entered'
  | 'lock.released'
  | 'flow.off'
  | 'flow.on'
  | 'level.changed'
  | 'clarify.asked'
  | 'clarify.answered'
  | 'turn.continued'
  | 'metrics.snapshot'
  | 'session.attached'
  | 'session.released'
  | 'session.takeover'
  | 'change.paused'
  | 'change.resumed'
  | 'task.interrupted'
  | 'batch.started'
  | 'batch.completed'
  | 'worktree.created'
  | 'worktree.removed'
  | 'checkpoint.passed'
  | 'checkpoint.failed'
  | 'checkpoint.retry_requested'
  | 'merge.conflict'
  | 'verify.receipt'
  | 'review.coverage_failed'
  | 'plan.amend_requested'
  | 'plan.amended'
  | 'plan.repair_added'
  | 'rule.proposed'
  | 'rule.adopted'
  | 'analysis.submitted'
  | 'citation.stale'
  | 'config.changed'
  | 'change.updated'
  | 'spec.merged'
  | 'flow.init'
  | 'roadmap.approved'
  | 'report.generated'
  | 'dispatch.started'
  | 'dispatch.completed'
  | 'artifacts.frozen'
  | 'artifact.frozen'
  | 'artifact.unfrozen'
  | 'external.detected'
  | 'external.acknowledged'
  | 'budget.exceeded'
  | 'skill.loaded'
  | 'citation.verified'
  | 'original.snapshot'
  | 'tamper.cleared'

export interface LedgerEvent {
  seq: number
  at: string
  type: LedgerEventType
  data: Record<string, unknown>
  prev: string
  mac?: string
}

export interface LedgerVerification {
  ok: boolean
  lines: number
  failures: { line: number; reason: string }[]
}

// ---------------------------------------------------------------------------
// Metrics (M-1 .. M-18)
// ---------------------------------------------------------------------------

export type MetricValue = number | '未知'

export interface MetricSet {
  changeId: string
  generatedAt: string
  metrics: Record<string, MetricValue>
  /** Notes explaining how each value was obtained (FR-10.3). */
  notes: Record<string, string>
}

// ---------------------------------------------------------------------------
// Host-facing runtime snapshot (status bar, panel projection, step injection)
// ---------------------------------------------------------------------------

export interface StageProgress {
  stage: StageId
  label: string
  status: 'done' | 'current' | 'pending' | 'blocked'
}

export interface RuntimeSnapshot {
  initialized: boolean
  changeId?: string
  title?: string
  kind?: ChangeKind
  complexity?: Complexity
  risk?: RiskLevel
  stage?: StageId
  lifecycle?: ChangeLifecycle
  awaitingGate?: HumanGateId
  pendingGate?: GateId
  pipeline: StageProgress[]
  tasks: Record<string, TaskState>
  batches: BatchState[]
  activeTaskId?: string
  pending: PendingItem[]
  violations: Violation[]
  /** 未经负责人确认的非 agent 改动（编辑器/格式化等），面板展示并在 G6 前要求确认。 */
  externalChanges?: NonNullable<ChangeStatus['externalChanges']>
  /** 本会话是接续已存在的进行中变更（状态条显示「已接续」）。 */
  resumed?: boolean
  /** 生效中的规则例外（面板可撤销）。 */
  exceptions?: ExceptionRecord[]
  off: boolean
  locked: boolean
  interceptCounts: Record<string, number>
  coverage?: CoverageReport
  nextStep: string
  /** One-line status bar text, <= 120 chars. */
  statusLine: string
  /**
   * Optional context-window occupancy in percent (0–100) for the status bar.
   * Filled by the host only when the DSH `contextPressure` session projection
   * (registered by `@deepseek-ai/dsh-token-meter`) reports both a token
   * pressure sample and the routed context window; absent otherwise — the host
   * never fabricates a number (P1-7).
   */
  contextPct?: number
  updatedAt: string
}

export interface CoverageEntry {
  tool: string
  category: 'read' | 'write' | 'shell' | 'delegate' | 'mcp' | 'flowgate' | 'unknown'
  covered: boolean
  reason?: string
}

export interface CoverageReport {
  entries: CoverageEntry[]
  coveredWritable: number
  uncoveredWritable: number
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Context injection (agent/pre-step, system prompt)
// ---------------------------------------------------------------------------

export interface InjectionBundle {
  /** Text appended to the step (K/V-cache friendly; append-only). */
  text: string
  /** Human-readable tokens estimate used for the injection budget. */
  approxTokens: number
}

// ---------------------------------------------------------------------------
// Host ports
// ---------------------------------------------------------------------------

export interface EnginePorts {
  fs: FileSystem
  clock: Clock
  git?: GitPort
  commandRunner?: CommandRunner
  /** Plugin version, recorded in the frozen contract. */
  pluginVersion: string
  /** Ledger HMAC key material (host provides from ~/.dsh/flowgate/ledger.key). */
  ledgerKey: string
  /** Base directory for agent user state (e.g. ~/.dsh/flowgate). */
  userStateDir?: string
}

export interface InitResult {
  ok: boolean
  project: ProjectDoc
  detectedCommands: CommandSettings
  risks: string[]
  filesRead: string[]
  message: string
}

export interface NewChangeInput {
  title: string
  summary?: string
  kind?: ChangeKind
  complexityHint?: Complexity
  riskHint?: RiskLevel
  fromRoadmap?: string
  relatedTo?: string
  project?: boolean
  reason?: string
}

export interface LevelSuggestion {
  complexity: Complexity
  risk: RiskLevel
  reasons: { complexity: string[]; risk: string[] }
}

export interface NewChangeOutcome {
  changeId: string
  suggestion: LevelSuggestion
  awaiting?: 'owner'
  message: string
}

export interface SubmitGateInput {
  gate: GateId
}

export interface StatusSummary {
  snapshot: RuntimeSnapshot
  change?: ChangeStatus
  gateItems?: CheckOutcome[]
  message: string
}

// ---------------------------------------------------------------------------
// Analysis tasks and reviews
// ---------------------------------------------------------------------------

export interface AnalysisSubmission {
  conclusion: string
  proposal: string
  limitations: string[]
  citations: CitationRef[]
}

export interface ReviewSubmission {
  verdict: 'pass' | 'changes-required'
  findings: ReviewFinding[]
}

export interface DispatchTaskEnvelope {
  changeId: string
  taskId: string
  batch: string
  mode: BatchMode
  task: TaskCard
  worktree?: string
  coveredScenarios: Scenario[]
  contextExcerpt: string
  handoff?: string
  verifyGroups: VerifyGroup[]
  tdd: boolean
}

export interface DispatchOutcome {
  dispatched: DispatchTaskEnvelope[]
  batchId?: string
  mode?: BatchMode
  message: string
  blocked?: PendingItem
  /**
   * Tasks whose card says `run: main`: the main session must claim them with
   * `flow_task_start` instead of the host starting an executor subagent.
   */
  mainTasks?: { taskId: string; batch: string; mode: BatchMode }[]
  /**
   * Set when a batch is waiting for its integration checkpoint (failed retry,
   * merge conflict, or a completed repair batch). The host must retry
   * `runIntegrationCheckpoint` for this batch instead of starting subagents.
   */
  retryCheckpoint?: { batchId: string; attempts: number }
}

export interface VerifyRequest {
  taskId?: string
  group: string
  /** Optional override; otherwise the group command from the task card. */
  command?: string
  inputs?: string[]
  kind?: EvidenceKind
}

export interface TaskStartOutcome {
  ok: boolean
  taskCard?: TaskCard
  envelope?: DispatchTaskEnvelope
  message: string
  hint?: string
}

export interface TaskDoneOutcome {
  ok: boolean
  passed: boolean
  failures: CheckOutcome[]
  message: string
  committed?: boolean
  nextStage?: StageId
}

export interface AnalysisOutcome {
  ok: boolean
  archived: boolean
  citationChecks: CitationCheck[]
  message: string
}

export interface DoctorReport {
  initialized: boolean
  pluginVersion: string
  ledgerOk: boolean
  ledgerFailures: { line: number; reason: string }[]
  configOk: boolean
  configError?: string
  stage?: StageId
  activeTasks: string[]
  openPending: number
  guardHeartbeat: { toolCalls: number; decisions: number }
  coverage?: CoverageReport
  hostCapabilities: Record<string, boolean>
  message: string
}
