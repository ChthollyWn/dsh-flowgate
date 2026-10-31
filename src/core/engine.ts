/**
 * FlowEngine: the single orchestration entry point for the host layer.
 *
 * Responsibilities:
 *  - load and persist `.flowgate/` state (status.json, index.md, ledger, evidence index)
 *  - drive gates (checks -> auto pass / await owner -> approve / reject -> stage transition)
 *  - answer guard decisions synchronously from cached state
 *  - run plugin-executed verification and compute freshness
 *  - manage tasks, pending items, overrides, exceptions, session leases
 *  - build the runtime snapshot / status bar / step injection
 *
 * The host layer only adapts DSH events to these methods and performs host-only
 * side effects (subagents, worktrees, projection, injection).
 */
import { stringify as stringifyYaml } from 'yaml'

import type {
  Action,
  AnalysisOutcome,
  ArtifactBundle,
  BatchState,
  CallerInfo,
  ChangeStatus,
  CheckOutcome,
  CommandRunner,
  Complexity,
  CoverageReport,
  Decision,
  DispatchOutcome,
  DispatchTaskEnvelope,
  DoctorReport,
  EnginePorts,
  EvidenceKind,
  EvidenceReceipt,
  ExceptionRecord,
  ExecutionPlan,
  FlowgateConfig,
  GateCheckContext,
  GateId,
  GateRecord,
  GateResult,
  HumanGateId,
  GitPort,
  HandoffSummary,
  InjectionBundle,
  InitResult,
  LedgerEvent,
  LevelProfile,
  LevelSuggestion,
  MetricSet,
  NewChangeInput,
  NewChangeOutcome,
  OverrideRecord,
  PendingDraft,
  PendingItem,
  PendingKind,
  ProjectDoc,
  ReviewFinding,
  ReviewRecord,
  RiskLevel,
  RoadmapDoc,
  RuntimeSnapshot,
  SessionLease,
  StageId,
  StageProgress,
  StatusSummary,
  TaskCard,
  TaskDoneOutcome,
  TaskStartOutcome,
  TaskState,
  VerifyRequest,
  Violation,
} from './types'
import { PENDING_PREFIX, GATES, STAGES } from './types'
import { isoNow, dateOnly, isOlderThanMinutes } from './util/time'
import { normalizeRelPath, posixJoin, isUnder } from './util/paths'
import { sha256, stableJson, containsSecret, redactSecrets } from './util/hash'
import type { FileSystem } from './util/fs'

import {
  STAGE_LABELS,
  STAGE_ORDER,
  levelProfile,
  suggestLevels,
  validateGateSubmission,
  applyGatePassed,
  applyGateFailed,
  applyGateAwaiting,
  applyGateApproved,
  applyGateRejected,
  enterStage,
  initialStatus,
  lockChange,
  unlockChange,
  isAllowedWrite,
  isProtectedPath,
  isArtifactWritableInStage,
  reviewRequirement,
  complexityLabel,
  riskLabel,
  parseComplexity,
  parseRiskLevel,
  nextStage,
  gateForStage,
  humanGate,
  stageAfterGate,
  applyVerificationFailure,
  draftRepairTasks,
  type VerificationFailureInput,
} from './state'
import {
  evaluateRules,
  loadRules,
  fingerprintAction,
  actionFromToolCall,
  BLOCKED_DELEGATION_TOOLS,
  explainDecision,
  ruleMisfireRate,
  shouldDowngradeRule,
  type RuleFeedback,
} from './rules'
import { validateVerifyCommand } from './shell'
import { loadArtifacts, loadProjectDoc, runGateChecks, artifactHashes, parseIncrementalSpec, parseRoadmap, parseTaskCardFragment } from './artifacts'
import { renderExecutionPlanMarkdown, renderExecutionDiagram } from './plan'
import { verifyCitations } from './citations'
import { detectTechStack, renderProjectDocDraft } from './detect'
import { createLedger, type Ledger } from './ledger'
import * as store from './store'
import {
  hashInputs,
  buildEvidenceView,
  receiptFreshness,
  runVerifyGroup,
  compareWithBaseline,
  summarizeEvidenceForContext,
  parseTestOutput,
  detectEvidenceKind,
} from './evidence'
import { invalidateOnRework } from './revision'
import { computeMetrics } from './metrics'
import { renderChangeReport } from './report'
import { renderDashboard } from './dashboard'
import { mergeIncrementalSpec, capabilityDirName } from './archive'

export class FlowGateError extends Error {
  hint?: string
  code?: string
  constructor(message: string, hint?: string, code?: string) {
    super(message)
    this.name = 'FlowGateError'
    this.hint = hint
    this.code = code
  }
}

export interface EngineHostHooks {
  /** Called when a verification receipt was produced (for post-execute compression). */
  onEvidence?: (receipt: EvidenceReceipt) => void
  /** Called when a human gate starts waiting for the owner (host may open panel). */
  onAwaitingOwner?: (change: ChangeStatus, gate: GateId) => void
  /**
   * Override the gate check runner (tests / replay). Defaults to the artifact
   * driven `runGateChecks` from src/core/artifacts.
   */
  gateChecker?: (context: GateCheckContext) => Promise<CheckOutcome[]>
}

export interface EngineOptions extends EnginePorts {
  root: string
  sessionId?: string
  sessionLabel?: string
  sessionAppend?: (type: string, data: Record<string, unknown>) => void
  onStateChange?: (snapshot: RuntimeSnapshot) => void
  host?: EngineHostHooks
}

const EVIDENCE_INDEX = 'state/evidence/index.jsonl'
const GENESIS_COMPLETE = 'genesis'

interface StatusWriteEvent {
  changeId: string
  change: ChangeStatus
}

export class FlowEngine {
  readonly root: string
  private readonly ports: EngineOptions
  private readonly fs: FileSystem
  private readonly git?: GitPort
  private readonly runner?: CommandRunner
  private readonly clock: { now(): Date }
  private readonly pluginVersion: string
  private readonly ledgerKey: string
  private readonly sessionId?: string
  private readonly sessionLabel?: string
  private readonly sessionAppend?: (type: string, data: Record<string, unknown>) => void
  private readonly onStateChange?: (snapshot: RuntimeSnapshot) => void
  private readonly hooks?: EngineHostHooks

  private config: FlowgateConfig
  private ledger: Ledger | null = null
  private state: store.ProjectState | null = null
  private current: ChangeStatus | null = null
  private artifacts: ArtifactBundle = {}
  private project: ProjectDoc | null = null
  private roadmapDoc: RoadmapDoc | null = null
  private receipts: EvidenceReceipt[] = []
  private coverageReport: CoverageReport | null = null
  private loaded = false
  private loadError: string | null = null
  /** 加载阶段发现的损坏状态文件（status.json 等）；非空即进入锁定模式（03 §14）。 */
  private stateCorruption: store.CorruptStateFile[] = []
  private interceptCounts: Record<string, number> = {}
  /** Per-rule M-5 feedback (interceptions / misjudged), rebuilt from the ledger. */
  private ruleFeedback: Record<string, RuleFeedback> = {}
  private lastRuleId: string | null = null
  private guardHeartbeat = { toolCalls: 0, decisions: 0 }
  private notices: string[] = []
  private evidenceCounter = 0

  constructor(options: EngineOptions) {
    this.ports = options
    this.root = normalizeRelPath(options.root) || options.root
    this.fs = options.fs
    this.git = options.git
    this.runner = options.commandRunner
    this.clock = options.clock
    this.pluginVersion = options.pluginVersion
    this.ledgerKey = options.ledgerKey
    this.sessionId = options.sessionId
    this.sessionLabel = options.sessionLabel
    this.sessionAppend = options.sessionAppend
    this.onStateChange = options.onStateChange
    this.hooks = options.host
    this.config = store.DEFAULT_CONFIG
  }

  // ------------------------------------------------------------------
  // Loading and persistence
  // ------------------------------------------------------------------

  async load(): Promise<void> {
    this.loadError = null
    this.stateCorruption = []
    try {
      const initialized = await store.isInitialized(this.fs, this.root)
      if (!initialized) {
        const layout = store.layout(this.root)
        this.config = store.DEFAULT_CONFIG
        this.state = {
          root: this.root,
          initialized: false,
          config: this.config,
          changes: [],
          leases: [],
          ledgerSeq: 0,
        }
        this.ledger = createLedger({
          fs: this.fs,
          path: layout.ledger,
          key: this.ledgerKey,
          clock: this.clock,
          sessionAppend: this.sessionAppend,
        })
        this.receipts = []
        this.artifacts = {}
        this.project = null
        this.roadmapDoc = null
        this.current = null
        this.loaded = true
        return
      }

      const layout = store.layout(this.root)
      try {
        this.config = await store.loadConfig(this.fs, this.root)
      } catch (error) {
        this.config = store.DEFAULT_CONFIG
        this.loadError = `配置文件损坏：${(error as Error).message}`
      }
      this.ledger = createLedger({
        fs: this.fs,
        path: layout.ledger,
        key: this.ledgerKey,
        clock: this.clock,
        sessionAppend: this.sessionAppend,
      })
      const verification = await this.ledger.verify()
      const loadedState = await store.loadProjectState({
        fs: this.fs,
        root: this.root,
        config: this.config,
        clock: this.clock,
      })
      this.state = loadedState
      this.stateCorruption = loadedState.corruptStateFiles ?? []
      if (!verification.ok) {
        this.state.locked = {
          reason: `账本校验失败（${verification.failures.length} 处）：${verification.failures
            .slice(0, 3)
            .map((f) => `第 ${f.line} 行 ${f.reason}`)
            .join('；')}`,
          at: isoNow(this.clock),
        }
      } else if (this.loadError) {
        this.state.locked = { reason: this.loadError, at: isoNow(this.clock) }
      }
      // 03 §14：状态文件损坏 → 锁定模式（拒绝门禁内写入）；原因带上文件路径与修复路径，
      // 供 /flow doctor、/flow status 与注入文本展示。/flow repair 从账本重建后解除。
      if (this.stateCorruption.length > 0) {
        const corruptionReason = this.corruptionLockReason()
        this.state.locked = {
          reason: this.state.locked ? `${this.state.locked.reason}；${corruptionReason}` : corruptionReason,
          at: isoNow(this.clock),
        }
      }

      this.receipts = await this.loadReceipts()
      this.project = await loadProjectDoc(this.fs, this.root)
      this.roadmapDoc = await this.loadRoadmapDoc()
      await this.rebuildCounters()

      // Attach session / current change.
      if (this.stateCorruption.length > 0) {
        // 损坏状态下不自动附着/改写租约：修复路径统一走 /flow repair，
        // 避免 load 顺手覆盖仍在报告里的损坏文件。
        this.current = null
      } else {
        const leases = this.state.leases
        const mine = this.sessionId ? leases.find((lease) => lease.sessionId === this.sessionId) : undefined
        if (mine) {
          this.current = this.state.changes.find((change) => change.id === mine.changeId) ?? null
        } else {
          await this.autoAttach()
        }
      }
      await this.reloadArtifacts()
      this.loaded = true
    } catch (error) {
      this.loadError = (error as Error).message
      this.loaded = false
      throw error
    } finally {
      this.emitState()
    }
  }

  /** 状态文件损坏的锁定原因：列出文件路径与原因，并给出诊断/修复入口（03 §14）。 */
  private corruptionLockReason(): string {
    const files = this.stateCorruption
    const shown = files.slice(0, 3).map((file) => `${file.path}（${file.reason}）`)
    const rest = files.length > 3 ? `；另有 ${files.length - 3} 个损坏文件` : ''
    return `状态文件损坏（${files.length} 个）：${shown.join('；')}${rest}。运行 /flow doctor 诊断，/flow repair 从账本重建。`
  }

  private async rebuildCounters(): Promise<void> {
    this.interceptCounts = {}
    this.ruleFeedback = {}
    if (!this.ledger) return
    const bump = (ruleId: string): RuleFeedback => {
      const key = ruleId === '' ? 'unknown' : ruleId
      const feedback = (this.ruleFeedback[key] ??= { interceptions: 0, misjudged: 0 })
      return feedback
    }
    const misjudgedEvent = (event: { data: Record<string, unknown> }): boolean => {
      if (event.data.misjudged === true) return true
      if (event.data.reasonKind === 'misjudged') return true
      return /误判/.test(String(event.data.reason ?? ''))
    }
    try {
      const events = await this.ledger.readAll()
      for (const event of events) {
        if (event.type === 'rule.denied' || event.type === 'rule.human') {
          const ruleId = String(event.data.ruleId ?? 'unknown')
          this.interceptCounts[ruleId] = (this.interceptCounts[ruleId] ?? 0) + 1
          const feedback = bump(ruleId)
          feedback.interceptions += 1
          if (misjudgedEvent(event)) feedback.misjudged += 1
        } else if ((event.type === 'override.granted' || event.type === 'exception.added') && misjudgedEvent(event)) {
          bump(String(event.data.ruleId ?? 'unknown')).misjudged += 1
        }
      }
      this.evidenceCounter = this.receipts.length
    } catch {
      // Ledger unreadable: keep counters empty; locked mode already recorded.
    }
  }

  /** 路线图是否已被负责人批准（GR 归档 PROJECT 时把 gates.GR 置为 passed）。 */
  private roadmapApprovedByOwner(): boolean {
    const project = this.state?.changes.find((change) => change.id === 'PROJECT')
    return project?.gates?.GR?.state === 'passed'
  }

  /** 除 PROJECT 外已创建过的变更数（路线图第一个变更的判定用）。 */
  private roadmapChangesCreated(): number {
    return this.state?.changes.filter((change) => change.id !== 'PROJECT').length ?? 0
  }

  private async autoAttach(): Promise<void> {
    if (!this.state || !this.sessionId) return
    // PROJECT（路线图阶段）也要能自动接续：模型常在创建立项后结束本轮，
    // 负责人/下一条会话需要能继续看到它并批准 GR，否则 GR 会被静默搁置。
    const active = this.state.changes.filter(
      (change) => change.lifecycle === 'active' && change.kind === 'change',
    )
    if (active.length !== 1) return
    const change = active[0]!
    const lease = this.state.leases.find((item) => item.changeId === change.id)
    if (lease && lease.sessionId !== this.sessionId && !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())) {
      return
    }
    await this.acquireLease(change)
  }

  async refresh(): Promise<void> {
    const currentId = this.current?.id
    await this.load()
    if (currentId && this.state) {
      this.current = this.state.changes.find((change) => change.id === currentId) ?? this.current
    }
    await this.reloadArtifacts()
    this.emitState()
  }

  isInitialized(): boolean {
    return this.state?.initialized === true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  getConfig(): FlowgateConfig {
    return this.config
  }

  /**
   * Review rounds required for each task gate at the current change's level
   * (0 = review not required). Host uses it to run the full number of rounds
   * instead of short-circuiting after the first pass (high risk requires 2).
   */
  requiredReviewRounds(): number {
    if (!this.current) return 0
    return levelProfile(this.current.complexity, this.current.risk, this.config.limits).reviewRoundsPerTask
  }

  getState(): store.ProjectState | null {
    return this.state
  }

  currentChange(): ChangeStatus | null {
    return this.current
  }

  allChanges(): ChangeStatus[] {
    return this.state?.changes ?? []
  }

  getEvidence(): EvidenceReceipt[] {
    return this.receipts
  }

  getArtifacts(): ArtifactBundle {
    return this.artifacts
  }

  getProject(): ProjectDoc | null {
    return this.project
  }

  getRoadmap(): RoadmapDoc | null {
    return this.roadmapDoc
  }

  coverage(): CoverageReport | null {
    return this.coverageReport
  }

  setCoverage(report: CoverageReport): void {
    this.coverageReport = report
  }

  noteToolCall(): void {
    this.guardHeartbeat.toolCalls += 1
  }

  noteGuardDecision(): void {
    this.guardHeartbeat.decisions += 1
  }

  private async reloadArtifacts(): Promise<void> {
    if (!this.current) {
      this.artifacts = {}
      return
    }
    try {
      this.artifacts = await loadArtifacts(this.fs, this.root, this.current.id)
    } catch {
      this.artifacts = {}
    }
  }

  private async loadProjectDoc(): Promise<ProjectDoc | null> {
    return loadProjectDoc(this.fs, this.root)
  }

  private async loadRoadmapDoc(): Promise<RoadmapDoc | null> {
    const layout = store.layout(this.root)
    try {
      if (!(await this.fs.exists(layout.roadmap))) return null
      const raw = await this.fs.readFile(layout.roadmap)
      return parseRoadmap(raw)
    } catch {
      return null
    }
  }

  private async loadReceipts(): Promise<EvidenceReceipt[]> {
    const path = posixJoin(store.layout(this.root).dir, EVIDENCE_INDEX)
    if (!(await this.fs.exists(path))) return []
    try {
      const raw = await this.fs.readFile(path)
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as EvidenceReceipt)
    } catch {
      return []
    }
  }

  private async appendReceipt(receipt: EvidenceReceipt): Promise<void> {
    const path = posixJoin(store.layout(this.root).dir, EVIDENCE_INDEX)
    await this.fs.appendFile(path, `${JSON.stringify(receipt)}\n`)
    this.receipts.push(receipt)
  }

  private async appendLedger(type: Parameters<Ledger['append']>[0]['type'], data: Record<string, unknown> = {}): Promise<void> {
    if (!this.ledger) return
    try {
      await this.ledger.append({ type, data })
    } catch {
      // Ledger failures must never take the host down; the change enters locked mode on next load.
    }
  }

  private async saveChange(change: ChangeStatus | null = this.current): Promise<void> {
    if (!change || !this.state) return
    change.updatedAt = isoNow(this.clock)
    const existingIndex = this.state.changes.findIndex((item) => item.id === change.id)
    if (existingIndex >= 0) this.state.changes[existingIndex] = change
    else this.state.changes.push(change)
    if (this.current?.id === change.id) this.current = change
    if (change.lifecycle === 'archived') {
      // The change directory was moved into .flowgate/archive/; only refresh the
      // cross-change ledger view (kept in .flowgate/changes/index.md).
      await store.writeChangesIndex(this.fs, this.root, this.state.changes)
      await this.touchLease()
      this.emitState()
      return
    }
    await store.writeChangeStatus(this.fs, this.root, change)
    await store.writeChangesIndex(this.fs, this.root, this.state.changes)
    await this.appendLedger('change.updated', {
      changeId: change.id,
      change: JSON.parse(JSON.stringify(change)) as ChangeStatus,
    })
    await this.touchLease()
    this.emitState()
  }

  private async saveLeases(): Promise<void> {
    if (!this.state) return
    await store.writeLeases(this.fs, this.root, this.state.leases)
  }

  private emitState(): void {
    if (!this.onStateChange) return
    try {
      this.onStateChange(this.snapshot())
    } catch {
      // Projection failures never break the gate.
    }
  }

  private async touchLease(): Promise<void> {
    if (!this.state || !this.sessionId || !this.current) return
    const lease = this.state.leases.find((item) => item.sessionId === this.sessionId)
    if (!lease) return
    lease.heartbeatAt = isoNow(this.clock)
    await this.saveLeases()
  }

  private pushNotice(text: string): void {
    this.notices.push(text)
    if (this.notices.length > 20) this.notices.splice(0, this.notices.length - 20)
  }

  takeNotices(): string[] {
    const out = this.notices
    this.notices = []
    return out
  }

  // ------------------------------------------------------------------
  // Effective task/plan views
  // ------------------------------------------------------------------

  getTasks(): TaskCard[] {
    const tasks = [...(this.artifacts.tasks?.tasks ?? []), ...(this.current?.newTasks ?? [])]
    const additions = this.current?.scopeAdditions ?? {}
    return tasks.map((task) => {
      const extra = additions[task.id]
      if (!extra || extra.length === 0) return task
      return {
        ...task,
        approvedScope: [...(task.approvedScope ?? []), ...extra],
        scope: [...task.scope, ...extra],
      }
    })
  }

  getTask(taskId: string): TaskCard | undefined {
    return this.getTasks().find((task) => task.id === taskId)
  }

  getPlan(): ExecutionPlan {
    if (this.current?.plan) return this.current.plan
    return this.artifacts.tasks?.execution ?? { batches: [] }
  }

  private activeTask(): TaskState | undefined {
    if (!this.current) return undefined
    return Object.values(this.current.tasks).find((task) => task.status === 'running' || task.status === 'review')
  }

  // ------------------------------------------------------------------
  // Init and change creation
  // ------------------------------------------------------------------

  async init(): Promise<InitResult> {
    if (await store.isInitialized(this.fs, this.root)) {
      const existing = this.project
      return {
        ok: true,
        project: existing ?? {
          raw: '',
          name: '',
          stack: [],
          modules: [],
          commands: {},
          conventions: [],
          forbidden: [],
          reusable: [],
          readFiles: [],
          claims: [],
        },
        detectedCommands: this.config.commands,
        risks: [],
        filesRead: existing?.readFiles ?? [],
        message: 'FlowGate 已经初始化过；如需更新 project.md，请直接编辑后运行 /flow repair。',
      }
    }
    await store.scaffold(this.fs, this.root)
    const detected = await detectTechStack(this.fs, this.root)
    const now = isoNow(this.clock)
    const draft = renderProjectDocDraft(detected, now)
    const layout = store.layout(this.root)
    await this.fs.writeFile(layout.projectDoc, draft)
    this.config = {
      ...this.config,
      commands: { ...this.config.commands, ...detected.commands },
    }
    await this.writeConfig()
    this.project = await loadProjectDoc(this.fs, this.root)
    await this.appendLedger('flow.init', {
      root: this.root,
      stack: detected.kind,
      commands: this.config.commands,
    })
    await this.load()
    return {
      ok: true,
      project: this.project ?? detectedAsProjectDoc(detected, draft),
      detectedCommands: detected.commands,
      risks: detected.risks,
      filesRead: detected.readFiles,
      message: `FlowGate 已初始化。探测到 ${detected.kind} 项目，生成 .flowgate/project.md 草稿（读了 ${detected.readFiles.length} 个文件），请负责人核对命令与约定。`,
    }
  }

  private async writeConfig(): Promise<void> {
    const layout = store.layout(this.root)
    const plain = JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>
    await this.fs.writeFile(layout.config, stringifyYaml(plain))
  }

  async newChange(input: NewChangeInput): Promise<NewChangeOutcome> {
    if (!this.state?.initialized) throw new FlowGateError('FlowGate 未初始化', '先运行 /flow init')
    if (this.state.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow doctor 诊断，/flow repair 恢复')
    if (!this.state.changes.every((change) => change.lifecycle !== 'active') && !input.project) {
      const active = this.state.changes.filter((change) => change.lifecycle === 'active')
      if (active.length > 0 && this.current && this.current.lifecycle === 'active') {
        throw new FlowGateError(
          `已有进行中的变更 ${this.current.id}（${this.current.title}）`,
          '同一工作目录同一时间只能推进一个变更；用 /flow pause 暂停它，或 /flow resume 切换',
        )
      }
    }
    const now = isoNow(this.clock)
    const suggestion = suggestLevels({
      title: input.title,
      summary: input.summary,
      paths: [],
      config: this.config,
    })
    let complexity: Complexity = input.complexityHint ?? suggestion.complexity
    let risk: RiskLevel = input.riskHint ?? suggestion.risk
    let title = input.title
    let roadmapRef: string | undefined

    // 路线图已批准后，第一个变更必须从路线图立项（C0 工程骨架）：否则会绕过 GR 冻结的
    // 路线图，且新 C0 会失去 skeleton 标记（G2 对 project.md 命令的豁免依赖它，真实
    // greenfield 演练因此卡在 "project.md 受保护 + G2 要求命令" 的死锁里）。
    if (!input.project && !input.fromRoadmap && this.roadmapApprovedByOwner() && this.roadmapChangesCreated() === 0) {
      const first = this.roadmapDoc?.entries[0]?.change ?? 'C0'
      throw new FlowGateError(
        `路线图已批准：第一个变更必须从路线图立项（${first}）`,
        `用 flow_new_change({ fromRoadmap: "${first}" })；路线图外的新增/调整先写路线图增量并重新过 GR`,
      )
    }

    if (input.project) {
      if (this.roadmapDoc) throw new FlowGateError('路线图已存在', '增删能力请写路线图增量并重新过 GR')
      await this.scaffoldProjectFlow(title)
      const change = initialStatus({
        id: 'PROJECT',
        kind: 'change',
        title,
        summary: input.summary,
        complexity: 'medium',
        risk: 'normal',
        stage: 'roadmap',
        at: now,
        config: this.config,
        pluginVersion: this.pluginVersion,
        skills: this.skillVersions(),
      })
      change.contract = store.freezeContract(this.config, this.pluginVersion, this.skillVersions(), now)
      await store.ensureChangeDir(this.fs, this.root, change.id)
      this.state.changes.push(change)
      this.current = change
      await this.saveChange(change)
      await this.appendLedger('change.created', { changeId: change.id, kind: 'project', title })
      this.pushNotice(`项目级澄清与路线图已立项（${change.id}）。先写 .flowgate/project-clarify.md 和 .flowgate/roadmap.md，然后 flow_submit({gate:"GR"})。`)
      return {
        changeId: change.id,
        suggestion,
        awaiting: 'owner',
        message: '这是新项目：先完成项目级澄清与路线图，提交 GR，由负责人批准后逐个变更推进。',
      }
    }

    if (input.fromRoadmap) {
      const entry = this.roadmapDoc?.entries.find((item) => item.change === input.fromRoadmap)
      if (!entry) throw new FlowGateError(`路线图里没有 ${input.fromRoadmap}`, '先运行 /flow roadmap 查看条目编号')
      if (entry.status === '已交付') throw new FlowGateError(`${entry.change} 已交付`, '如需修改请新建关联变更')
      roadmapRef = entry.change
      title = entry.goal || input.title
      const dependents = entry.dependsOn ?? []
      const unfinished = dependents.filter((dep) => {
        const candidate = this.roadmapDoc?.entries.find((item) => item.change === dep)
        return candidate && candidate.status !== '已交付'
      })
      if (unfinished.length > 0) {
        throw new FlowGateError(
          `${entry.change} 的依赖 ${unfinished.join('、')} 尚未交付`,
          '先完成依赖变更，或调整路线图（走路线图增量并重新过 GR）',
        )
      }
    }

    // 已归档变更的目录被移出 `.flowgate/changes/`，不会出现在 this.state.changes 里；
    // 编号分配必须把它们也算进去，否则归档后新建变更会复用 C-001/A-001，导致账本与
    // 归档报告目录出现同号冲突（2026-10-31 真机发现）。
    const archived = await this.archivedChangeIds()
    const changeId = store.nextChangeId([...this.state.changes, ...archived], input.kind ?? 'change')
    // `/flow new <描述>` only carries a title; G0 requires a one-line goal. Default the
    // summary to the title instead of failing G0 on a human-typed command.
    const summary = input.summary?.trim() ? input.summary.trim() : title
    const change = initialStatus({
      id: changeId,
      kind: input.kind ?? 'change',
      title,
      summary,
      complexity,
      risk,
      stage: 'S0',
      at: now,
      config: this.config,
      pluginVersion: this.pluginVersion,
      skills: this.skillVersions(),
      roadmap: roadmapRef,
      relatedTo: input.relatedTo,
    })
    change.contract = store.freezeContract(this.config, this.pluginVersion, this.skillVersions(), now)
    await store.ensureChangeDir(this.fs, this.root, change.id)
    await this.writeChangeTemplates(change)
    this.state.changes.push(change)
    this.current = change
    if (this.sessionId) {
      const lease = this.state.leases.find((item) => item.sessionId === this.sessionId)
      if (lease) lease.changeId = change.id
      else
        this.state.leases.push({
          sessionId: this.sessionId,
          changeId: change.id,
          attachedAt: now,
          heartbeatAt: now,
          label: this.sessionLabel,
        })
      await this.saveLeases()
    }
    await this.appendLedger('change.created', { changeId: change.id, kind: change.kind, title, complexity, risk })
    const g0 = await this.evaluateGate(change, 'G0')
    await this.recordGateResult(change, 'G0', g0, now)
    await this.saveChange(change)
    const g0Failed = g0.failures.length > 0
    if (g0Failed) {
      this.pushNotice(`G0 未通过：${g0.failures.map((failure) => failure.label).join('；')}。修正后重新提交 G0。`)
    } else if (input.kind === 'analysis') {
      this.pushNotice(`已立分析任务 ${change.id}：只读排查，结论用 flow_submit_analysis 提交（必须带源码引用）。`)
    } else {
      this.pushNotice(`已立项 ${change.id}（${complexityLabel(complexity)} · ${riskLabel(risk)}）。当前 S1 需求澄清：先读相关代码与规格，再用 ask_user_question 澄清，写 clarify.md / proposal.md / 增量规格。`)
    }
    return {
      changeId: change.id,
      suggestion,
      message:
        input.kind === 'analysis'
          ? `分析任务 ${change.id} 已创建：只读，不改代码。`
          : g0Failed
            ? `变更 ${change.id} 已创建，但 G0 未通过：${g0.failures.map((failure) => failure.label).join('；')}。修正后重新提交 G0。`
            : `变更 ${change.id} 已创建并进入 S1 需求澄清（${complexityLabel(complexity)} · ${riskLabel(risk)}，建议等级，负责人可在 G1 确认或调整）。`,
    }
  }

  private skillVersions(): Record<string, string> {
    const skills: Record<string, string> = {}
    for (const name of [
      'flow-roadmap',
      'flow-clarify',
      'flow-context',
      'flow-design',
      'flow-plan',
      'flow-orchestrate',
      'flow-tdd',
      'flow-debug',
      'flow-scope',
      'flow-verify',
      'flow-review',
      'flow-qa',
      'flow-ship',
      'flow-retro',
      'flow-analysis',
    ]) {
      skills[name] = 'v1'
    }
    return skills
  }

  private async scaffoldProjectFlow(title: string): Promise<void> {
    const layout = store.layout(this.root)
    await this.fs.mkdir(store.layout(this.root).dir)
    const clarify = `# 项目级澄清：${title}\n\n## 目标用户与目标\n\n<!-- 谁用、在什么场景用、解决什么问题 -->\n\n## 核心流程\n\n<!-- 从入口到结果的关键步骤 -->\n\n## MVP 边界（做 / 不做）\n\n**做：**\n\n<!-- ... -->\n\n**不做：**\n\n<!-- ... -->\n\n## 技术栈与部署\n\n<!-- 语言/框架/数据库/部署方式 -->\n\n## 非功能要求\n\n<!-- 性能、安全、合规、可用性 -->\n\n## 约束与未知项\n\n<!-- 时间/预算/外部依赖；尚未确定、需要负责人决定的事项 -->\n`
    const roadmap = `# 路线图：${title}\n\nMVP 切线：<!-- C0–Cn 在切线内 -->\n\n| 变更 | 能力 | 一句话目标 | 验收要点 | 依赖 | 预计任务数 | MVP | 状态 |\n|---|---|---|---|---|---|---|---|\n| C0 | 工程骨架 | 能构建、能跑测试、有 CI | 测试框架跑通 1 个冒烟测试 | — | 4 | 是 | 未开始 |\n\n<!-- 按能力继续添加 C1…；第一个变更必须是工程骨架 -->\n`
    const { projectClarifyPath } = projectLevelPaths(this.root)
    await this.fs.writeFile(projectClarifyPath, clarify)
    await this.fs.writeFile(layout.roadmap, roadmap)
  }

  private async writeChangeTemplates(change: ChangeStatus): Promise<void> {
    const paths = store.changePaths(this.root, change.id)
    const clarifyTemplate = `# 澄清记录：${change.title}\n\n## 原始描述\n\n<!-- 负责人原始描述 -->\n\n## 已知事实\n\n<!-- 每条写 文件:起止行 引用形式；没有引用只能算假设 -->\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 |  |  |  |\n| 边界（做 / 不做） |  |  |  |\n| 角色与权限 |  |  |  |\n| 验收标准 |  |  |  |\n| 约束（非功能） |  |  |  |\n| 未知与假设 |  |  |  |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n\n## 已接受的假设\n\n## 未决问题\n`
    const proposalTemplate = `# 变更提案：${change.title}\n\n## 为什么\n\n<!-- 要解决的问题与证据 -->\n\n## 改什么\n\n<!-- 功能列表，配套增量规格 -->\n\n## 影响\n\n<!-- 受影响的模块、接口、数据 -->\n\n## 不做\n\n<!-- 明确排除的范围 -->\n`
    await this.fs.writeFile(paths.clarify, clarifyTemplate)
    await this.fs.writeFile(paths.proposal, proposalTemplate)
    await this.fs.mkdir(posixJoin(paths.dir, 'specs'))
  }

  // ------------------------------------------------------------------
  // Gates
  // ------------------------------------------------------------------

  private level(): LevelProfile {
    const change = this.current
    return levelProfile(change?.complexity ?? 'medium', change?.risk ?? 'normal', this.config.limits)
  }

  private async buildGateContext(change: ChangeStatus, gate: GateId): Promise<GateCheckContext> {
    const artifacts = await loadArtifacts(this.fs, this.root, change.id)
    // Re-read project-level documents: the agent may have written them since the last load.
    this.project = await loadProjectDoc(this.fs, this.root)
    this.roadmapDoc = await this.loadRoadmapDoc()
    const changeReceipts = this.receipts.filter((receipt) => receipt.changeId === change.id)
    return {
      root: this.root,
      gate,
      level: levelProfile(change.complexity, change.risk, this.config.limits),
      change,
      config: this.config,
      artifacts,
      fs: this.fs,
      git: this.git,
      commandRunner: this.runner,
      evidence: changeReceipts,
      project: this.project,
      roadmap: this.roadmapDoc,
      now: isoNow(this.clock),
      limits: this.config.limits,
    }
  }

  private async evaluateGate(change: ChangeStatus, gate: GateId): Promise<{ items: CheckOutcome[]; failures: CheckOutcome[] }> {
    const context = await this.buildGateContext(change, gate)
    const items = this.hooks?.gateChecker ? await this.hooks.gateChecker(context) : await runGateChecks(context)
    const failures = items.filter((item) => !item.passed)
    return { items, failures }
  }

  private async recordGateResult(
    change: ChangeStatus,
    gate: GateId,
    result: { items: CheckOutcome[]; failures: CheckOutcome[] },
    at: string,
  ): Promise<void> {
    const previous = change.gates[gate]
    const passed = result.failures.length === 0
    const record: GateRecord = {
      state: passed ? 'passed' : 'failed',
      items: result.items,
      submittedAt: at,
      passedAt: passed ? at : undefined,
      attempts: (previous?.attempts ?? 0) + 1,
    }
    change.gates[gate] = record
    if (passed) {
      await this.appendLedger('gate.passed', { changeId: change.id, gate, items: itemsSummary(result.items) })
      await this.advanceAfterAutoGate(change, gate, at)
    } else {
      await this.appendLedger('gate.failed', {
        changeId: change.id,
        gate,
        failures: result.failures.map((failure) => ({ item: failure.item, hint: failure.hint })),
      })
    }
  }

  private async advanceAfterAutoGate(change: ChangeStatus, gate: GateId, at: string): Promise<void> {
    if (gate === 'G0') {
      if (change.stage === 'S0') {
        Object.assign(change, enterStage(change, 'S1', at))
        await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S1' })
        if (change.kind === 'analysis') {
          // Analysis tasks have a single read-only stage: mark as S1 and wait for submit_analysis.
        }
      }
      return
    }
    const level = levelProfile(change.complexity, change.risk, this.config.limits)
    const human = isHumanGate(gate)
    if (human) return
    if (gate === 'G2') {
      Object.assign(change, applyGatePassed(change, 'G2', at))
      Object.assign(change, enterStage(change, 'S3', at))
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G2', auto: true })
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S3' })
      return
    }
    if (gate === 'G4') {
      Object.assign(change, applyGatePassed(change, 'G4', at))
      Object.assign(change, enterStage(change, 'S5', at))
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G4', auto: true })
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S5' })
      return
    }
    if (gate === 'G5') {
      Object.assign(change, applyGatePassed(change, 'G5', at))
      Object.assign(change, enterStage(change, 'S6', at))
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G5', auto: true })
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S6' })
      return
    }
    void level
  }

  async submitGate(gate: GateId): Promise<GateResult> {
    const change = this.requireChange()
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow repair 恢复')
    if (gate === 'TG' || gate === 'G4') {
      throw new FlowGateError(`${gate} 不是由 agent 提交的门`, '任务门由 flow_task_done 自动判定，G4 在全部任务完成后自动通过')
    }
    const validation = validateGateSubmission(change, gate)
    if (!validation.ok) throw new FlowGateError(validation.message, '运行 /flow 查看当前阶段与待办')
    if (gate === 'GR') {
      if (change.stage !== 'roadmap') throw new FlowGateError('当前不是在项目路线图阶段', '新项目先用 /flow new --project 立项')
    }
    const now = isoNow(this.clock)
    if (gate === 'G2') await this.ensureBaseline(change)
    if (gate === 'G5') await this.ensureFullSuite(change)
    await this.reloadArtifacts()
    const result = await this.evaluateGate(change, gate)
    await this.appendLedger('gate.submitted', { changeId: change.id, gate })
    if (result.failures.length > 0) {
      Object.assign(change, applyGateFailed(change, gate, now, result.failures))
      change.gates[gate] = {
        ...(change.gates[gate] ?? { state: 'failed', attempts: 0 }),
        state: 'failed',
        items: result.items,
        submittedAt: now,
        attempts: (change.gates[gate]?.attempts ?? 0) + 1,
      }
      await this.appendLedger('gate.failed', {
        changeId: change.id,
        gate,
        failures: result.failures.map((failure) => ({ item: failure.item, hint: failure.hint })),
      })
      // P0-7: S5 验证失败（全量测试 / lint-build / 终审 critical-major findings）
      // 回退 S4 并生成 FIX-n 修复任务，而不是停在 S5 让 agent 反复重交。
      let repairNote = ''
      if (gate === 'G5') {
        const inputs = this.gateVerificationInputs(change, result.failures)
        if (inputs !== null) {
          const reverted = applyVerificationFailure(change, inputs, now, this.nextRepairIndex(change))
          Object.assign(change, reverted.change)
          this.hydrateRepairTasks(reverted.tasks)
          const lastBatchId = change.batches[change.batches.length - 1]?.id ?? ''
          const repairBatchId = this.insertRepairBatch(
            change,
            reverted.tasks,
            lastBatchId,
            'S5 验证失败自动修复（回退 S4）',
            { retryOf: false },
          )
          await this.appendLedger('plan.repair_added', {
            changeId: change.id,
            batchId: 'G5',
            repairBatchId,
            tasks: reverted.tasks.map((card) => card.id),
            source: 's5-verification',
          })
          repairNote = `已回退 S4 并生成修复任务 ${reverted.tasks.map((card) => card.id).join('、')}（批次 ${repairBatchId}）`
        }
      }
      await this.saveChange(change)
      return {
        gate,
        passed: false,
        items: result.items,
        failures: result.failures,
        stage: change.stage,
        message: `G${gate.slice(1)} 未通过：${result.failures.map((failure) => failure.label).join('；')}${repairNote !== '' ? `；${repairNote}。` : ''}`,
      }
    }

    const human = isHumanGate(gate)
    const merged = gate === 'G3' && levelProfile(change.complexity, change.risk, this.config.limits).mergedGates
    if (human || merged) {
      Object.assign(change, applyGateAwaiting(change, gate, now))
      change.gates[gate] = {
        ...(change.gates[gate] ?? { state: 'awaiting', attempts: 0 }),
        state: 'awaiting',
        items: result.items,
        submittedAt: now,
        attempts: (change.gates[gate]?.attempts ?? 0) + 1,
      }
      await this.appendLedger('gate.passed', { changeId: change.id, gate, awaiting: 'owner', items: itemsSummary(result.items) })
      await this.saveChange(change)
      this.hooks?.onAwaitingOwner?.(change, gate)
      if (gate === 'GR') this.pushNotice('路线图检查通过，等负责人批准：/flow approve GR。')
      else if (merged) {
        this.pushNotice('低复杂度方案确认卡已就绪：等负责人确认（同时批准 G1 与 G3）。')
      } else this.pushNotice(`G${gate.slice(1)} 检查通过，等负责人批准：/flow approve ${gate}（或 /flow reject <意见>）。`)
      return {
        gate,
        passed: true,
        awaiting: 'owner',
        items: result.items,
        failures: [],
        stage: change.stage,
        message: `检查全部通过，等负责人批准 ${gate}。`,
      }
    }

    // Merged G1: pass silently and keep moving (owner confirms G1+G3 together at G3).
    const level = levelProfile(change.complexity, change.risk, this.config.limits)
    if (gate === 'G1' && level.mergedGates) {
      Object.assign(change, applyGatePassed(change, 'G1', now))
      change.gates.G1 = { ...(change.gates.G1 ?? { state: 'passed', attempts: 0 }), state: 'passed', items: result.items, submittedAt: now, passedAt: now, attempts: (change.gates.G1?.attempts ?? 0) + 1 }
      Object.assign(change, enterStage(change, 'S2', now))
      await this.appendLedger('gate.passed', { changeId: change.id, gate: 'G1', merged: true })
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S2' })
      await this.saveChange(change)
      return {
        gate,
        passed: true,
        items: result.items,
        failures: [],
        stage: change.stage,
        message: '低复杂度：G1 检查通过，已自动进入 S2；到 G3 时合并为一次方案确认。',
      }
    }

    // Auto gate: pass immediately and advance.
    Object.assign(change, applyGatePassed(change, gate, now))
    await this.appendLedger('gate.passed', { changeId: change.id, gate, items: itemsSummary(result.items) })
    if (gate === 'GR') {
      await this.markRoadmapApproved(change)
      await this.saveChange(change)
      return { gate, passed: true, items: result.items, failures: [], stage: change.stage, message: '路线图已批准。' }
    }
    Object.assign(change, enterStage(change, stageAfterGate(gate) ?? change.stage, now))
    if (gate === 'G3') await this.onEnterS4(change)
    await this.saveChange(change)
    return { gate, passed: true, items: result.items, failures: [], stage: change.stage, message: `已通过 ${gate}，进入 ${change.stage}。` }
  }

  async approveGate(gate: GateId, options: { reason?: string } = {}): Promise<GateResult> {
    const change = this.requireChange()
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow repair 恢复')
    const record = change.gates[gate]
    const awaiting = record?.state === 'awaiting' || (gate === 'G3' && record?.state === 'passed' && change.stage === 'S3')
    if (!awaiting) {
      throw new FlowGateError(`当前没有等待批准的 ${gate}`, '运行 /flow 查看当前等待批准的门')
    }
    const now = isoNow(this.clock)
    if (gate === 'GR') {
      await this.markRoadmapApproved(change)
      Object.assign(change, applyGateApproved(change, 'GR', now))
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'GR', reason: options.reason })
      change.lifecycle = 'archived'
      // 注意：不能走 saveChange()——它把 lifecycle==='archived' 当作"目录已被 archiveChange
      // 移走"而跳过 status.json 写入；PROJECT 没有 move，跳过会让 GR 批准在重载后丢失
      // （真机：PRJECT 状态磁盘仍为 active/awaiting，新会话再次要求批准 GR）。
      await store.writeChangeStatus(this.fs, this.root, change)
      await store.writeChangesIndex(this.fs, this.root, this.state?.changes ?? [change])
      if (this.state) {
        // 路线图变更归档后释放租约，避免新会话继续被一个已结束的变更占住。
        this.state.leases = this.state.leases.filter((lease) => lease.changeId !== change.id)
        await this.saveLeases()
      }
      // PROJECT 已归档：清空 current，让下一会话/注入落到"从已批准路线图立项第一个变更"。
      this.current = null
      this.emitState()
      const firstRoadmapChange = this.roadmapDoc?.entries[0]?.change ?? 'C0'
      this.pushNotice(
        `路线图已批准。用 flow_new_change({ fromRoadmap: "${firstRoadmapChange}" }) 立项第一个变更（工程骨架 ${firstRoadmapChange}）；不要用无 fromRoadmap 的立项绕过路线图。`,
      )
      return { gate, passed: true, items: record?.items ?? [], failures: [], stage: change.stage, message: '路线图已批准（GR）。' }
    }

    const level = levelProfile(change.complexity, change.risk, this.config.limits)
    const approveG1Too = gate === 'G3' && level.mergedGates && change.gates.G1?.state === 'passed'
    Object.assign(change, applyGateApproved(change, gate, now))
    change.gates[gate] = {
      ...(change.gates[gate] ?? { state: 'passed', attempts: 0 }),
      state: 'passed',
      approvedAt: now,
    }
    await this.appendLedger('gate.approved', { changeId: change.id, gate, reason: options.reason })
    if (approveG1Too) {
      Object.assign(change, applyGateApproved(change, 'G1', now))
      change.gates.G1 = { ...(change.gates.G1 ?? { state: 'passed', attempts: 0 }), state: 'passed', approvedAt: now }
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G1', merged: true })
    }
    const target = stageAfterGate(gate)
    if (target) {
      Object.assign(change, enterStage(change, target, now))
      await this.appendLedger('stage.entered', { changeId: change.id, stage: target })
      if (target === 'S4') await this.onEnterS4(change)
      if (target === 'S2' && approveG1Too) {
        // Fast lane: S2 is automatic for low complexity.
      }
      if (target === 'archived') {
        await this.archiveChange(change)
      }
    }
    await this.saveChange(change)
    this.pushNotice(`负责人已批准 ${gate}${approveG1Too ? '（同时批准 G1）' : ''}，当前阶段 ${change.stage}。`)
    return {
      gate,
      passed: true,
      items: change.gates[gate]?.items ?? [],
      failures: [],
      stage: change.stage,
      message: `已批准 ${gate}${approveG1Too ? '（与 G1 合并确认）' : ''}，进入 ${change.stage}。`,
    }
  }

  async rejectGate(gate: GateId, reason: string): Promise<GateResult> {
    const change = this.requireChange()
    if (!reason.trim()) throw new FlowGateError('退回必须写意见', '用法：/flow reject <意见>')
    const now = isoNow(this.clock)
    Object.assign(change, applyGateRejected(change, gate, reason, now))
    if (change.gates[gate]) {
      change.gates[gate] = {
        ...change.gates[gate]!,
        state: 'rejected',
        rejectedAt: now,
        rejectedReason: reason,
      }
    }
    await this.appendLedger('gate.rejected', { changeId: change.id, gate, reason })
    await this.saveChange(change)
    this.pushNotice(`负责人退回了 ${gate}：${reason}。请按意见修改产物后重新提交。`)
    return { gate, passed: false, items: change.gates[gate]?.items ?? [], failures: [], stage: change.stage, message: `已退回 ${gate}，意见已注入。` }
  }

  private async markRoadmapApproved(change: ChangeStatus): Promise<void> {
    if (this.roadmapDoc) {
      this.roadmapDoc = {
        ...this.roadmapDoc,
        entries: this.roadmapDoc.entries.map((entry) => ({ ...entry })),
      }
    }
    await this.appendLedger('roadmap.approved', { changeId: change.id })
  }

  private async onEnterS4(change: ChangeStatus): Promise<void> {
    const tasks = this.getTasks()
    if (tasks.length === 0) return
    const plan = this.getPlan()
    change.plan = plan
    change.tasks = {}
    change.batches = plan.batches.map<BatchState>((batch) => ({
      id: batch.batch,
      mode: batch.mode,
      status: 'pending',
      tasks: batch.tasks,
    }))
    for (const task of tasks) {
      const batch = plan.batches.find((item) => item.tasks.includes(task.id))
      change.tasks[task.id] = {
        id: task.id,
        batch: batch?.batch ?? '',
        status: 'pending',
        tdd: 'none',
        evidenceIds: [],
        reviewIds: [],
      }
    }
    if (this.config.git.change_branch && this.git) {
      try {
        const branch = `flowgate/${change.id}`
        await this.git.createBranch(this.root, branch)
        await this.git.checkout(this.root, branch)
        change.branch = branch
        await this.appendLedger('stage.entered', { changeId: change.id, branch })
      } catch (error) {
        this.pushNotice(`创建变更分支失败：${(error as Error).message}；继续在当前分支工作。`)
      }
    }
    const planMd = renderExecutionPlanMarkdown(plan, change)
    await this.fs.writeFile(store.changePaths(this.root, change.id).executionPlan, planMd)
  }

  // ------------------------------------------------------------------
  // Baseline and full-suite helpers
  // ------------------------------------------------------------------

  private async runProjectCommand(command: string, kind: EvidenceKind, groupName: string, inputs: string[]): Promise<EvidenceReceipt> {
    if (!this.runner) throw new FlowGateError('宿主没有提供命令执行器', '运行 /flow doctor 查看缺失接口')
    const change = this.requireChange()
    const commandCheck = validateVerifyCommand(command)
    if (!commandCheck.ok) throw new FlowGateError(`命令形状不合法：${commandCheck.reason}`, '验证命令不允许 && || ; 管道 重定向 命令替换')
    this.evidenceCounter += 1
    const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
    const receipt = await runVerifyGroup({
      fs: this.fs,
      root: this.root,
      runner: this.runner,
      change,
      task: {
        id: '',
        title: groupName,
        covers: [],
        scope: [],
        tests: [],
        newFiles: [],
        changes: [],
        dependsOn: [],
        tdd: 'optional',
        verify: [{ group: groupName, command, inputs }],
        run: 'main',
        risk: [],
        size: 'S',
        body: '',
      },
      group: { group: groupName, command, inputs },
      clock: this.clock,
      nextEvidenceId: () => id,
    })
    await this.appendReceipt(receipt)
    await this.appendLedger('verify.receipt', {
      changeId: change.id,
      evidenceId: receipt.id,
      group: receipt.group,
      phase: receipt.phase,
      kind,
      summary: receipt.summary,
    })
    this.hooks?.onEvidence?.(receipt)
    return receipt
  }

  private async ensureBaseline(change: ChangeStatus): Promise<void> {
    if (change.baseline) return
    const command = this.config.commands.test
    if (!command || command === 'none') {
      change.baseline = {
        commit: null,
        summary: { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
        recordedAt: isoNow(this.clock),
      }
      return
    }
    const commit = this.git ? await this.git.head(this.root).catch(() => null) : null
    const receipt = await this.runProjectCommand(command, 'test', 'baseline', this.baselineInputs())
    change.baseline = {
      commit,
      summary: receipt.summary ?? { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
      recordedAt: isoNow(this.clock),
      receiptId: receipt.id,
    }
    await this.appendLedger('verify.receipt', { changeId: change.id, baseline: true, evidenceId: receipt.id })
  }

  private baselineInputs(): string[] {
    return ['**/*', '!**/node_modules/**', '!**/target/**', '!**/build/**', '!**/dist/**', '!**/.git/**']
  }

  private async ensureFullSuite(change: ChangeStatus): Promise<void> {
    const commands = this.config.commands
    const command = commands.integration || commands.test
    if (command && command !== 'none') {
      const receipt = await this.runProjectCommand(command, 'test', 'full-suite', this.baselineInputs())
      const comparison = compareWithBaseline(
        change.baseline ? { commit: change.baseline.commit, summary: change.baseline.summary, receipts: [], failedTests: [] } : null,
        receipt.summary ?? { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
      )
      if (!comparison.ok) {
        this.pushNotice(`全量测试出现 ${comparison.regressions.length} 个回归，G5 不能通过。`)
      }
    }
    // S5 also collects lint / build / typecheck receipts when configured (T4.2).
    for (const key of ['lint', 'build', 'typecheck'] as const) {
      const lintCommand = commands[key]
      if (!lintCommand || lintCommand === 'none') continue
      try {
        await this.runProjectCommand(lintCommand, key, key, this.baselineInputs())
      } catch (error) {
        this.pushNotice(`${key} 命令执行失败：${(error as Error).message}`)
      }
    }
  }

  // ------------------------------------------------------------------
  // Guard decision
  // ------------------------------------------------------------------

  async evaluateAction(action: Action, caller: CallerInfo): Promise<Decision> {
    this.noteGuardDecision()
    if (!this.isInitialized()) return { effect: 'allow', message: '' }
    if (this.state?.locked) {
      return {
        effect: 'deny',
        rule: {
          ruleId: 'R-LOCKED',
          decision: 'deny',
          why: 'FlowGate 处于锁定模式：状态损坏或账本被篡改，写操作一律阻断。',
          unlock: '运行 /flow doctor 诊断，/flow repair 从账本重建后解除。',
        },
        message: 'FlowGate 锁定：拒绝写入（R-LOCKED）。解锁：运行 /flow doctor 诊断，/flow repair 恢复。',
      }
    }
    const change = this.current
    if (change?.off) return { effect: 'allow', message: '' }
    if (!change) {
      // Managed project without an active change: protect plugin state and secrets only.
      const target = 'path' in action ? action.path : undefined
      if (target && (isUnder(target, '.flowgate') || isUnder(target, '.git'))) {
        return {
          effect: 'deny',
          rule: { ruleId: 'R-PROTECTED', decision: 'deny', why: 'FlowGate 状态与 git 内部文件不允许 agent 直接写。', unlock: '用 flow_* 工具或 /flow 命令修改状态。' },
          message: '拒绝：受保护路径（R-PROTECTED）。用 flow_* 工具或 /flow 命令修改状态。',
        }
      }
      return { effect: 'allow', message: '', notes: ['尚未立项：建议用 flow_new_change 立项'] }
    }

    // Delegation tools are closed in managed sessions.
    if (BLOCKED_DELEGATION_TOOLS.includes(caller.tool)) {
      const decision: Decision = {
        effect: 'deny',
        rule: {
          ruleId: 'R-DELEGATE',
          decision: 'deny',
          why: '受管控会话里原生委派工具被关闭，子 agent 只能由 FlowGate 按执行图派发。',
          unlock: '改用 flow_dispatch_next（S4）或 flow_investigate（只读调查）。',
        },
        message: '拒绝：受管控会话不能使用原生委派（R-DELEGATE）。改用 flow_dispatch_next / flow_investigate。',
      }
      await this.logDenied(change, decision, action)
      return decision
    }

    // 并行批次里多个执行者同时活跃：优先用 caller 的派发上下文定位任务卡，
    // 否则会拿全局 activeTask（可能是另一个并行任务）做范围判定，导致误拒
    //（2026-10-31 真机发现：T2 写自己 new_files 里的文件被 T1 的 scope 拒绝）。
    const task = this.getTask(caller.dispatch?.taskId ?? this.activeTask()?.id ?? '')
    const decision = evaluateRules({
      action,
      caller,
      stage: change.stage,
      change,
      config: this.config,
      task,
      overrides: change.overrides,
      exceptions: change.exceptions,
      pending: change.pending,
      violations: change.violations.filter((violation) => !violation.clearedAt),
      projectRoot: this.root,
    })

    if (decision.rule) this.lastRuleId = decision.rule.ruleId
    // M-5：误判率超过 5%（且样本足够）的规则自动降为提示，本次放行并记账进入复盘。
    if ((decision.effect === 'deny' || decision.effect === 'human') && decision.rule) {
      const feedback = this.ruleFeedback[decision.rule.ruleId]
      if (shouldDowngradeRule(feedback)) {
        const rate = ruleMisfireRate(feedback) ?? 0
        const message = `规则 ${decision.rule.ruleId} 误判率 ${(rate * 100).toFixed(1)}%（目标 ≤5%，样本 ${feedback!.interceptions}）超过阈值：已自动降为提示，本次按提示放行，并已记为复盘候选。`
        await this.appendLedger('rule.hinted', {
          changeId: change.id,
          ruleId: decision.rule.ruleId,
          tool: action.tool,
          interceptions: feedback!.interceptions,
          misjudged: feedback!.misjudged,
        })
        this.pushNotice(message)
        return { ...decision, effect: 'allow', hinted: true, message, notes: [...(decision.notes ?? []), message] }
      }
    }
    if (decision.effect === 'deny') {
      await this.logDenied(change, decision, action)
      return decision
    }
    if (decision.effect === 'human') {
      await this.ensurePendingForDecision(change, decision, action)
      await this.saveChange(change)
      return decision
    }
    if (decision.overrideUsed) {
      const override = change.overrides.find((item) => item.id === decision.overrideUsed)
      if (override) {
        override.usedAt = isoNow(this.clock)
        override.usedBy = caller.agentId ?? caller.tool
        await this.appendLedger('override.used', { changeId: change.id, overrideId: override.id, ruleId: override.ruleId })
        await this.saveChange(change)
      }
    }
    return decision
  }

  private async logDenied(change: ChangeStatus, decision: Decision, action: Action): Promise<void> {
    const ruleId = decision.rule?.ruleId ?? 'unknown'
    this.interceptCounts[ruleId] = (this.interceptCounts[ruleId] ?? 0) + 1
    await this.appendLedger('rule.denied', {
      changeId: change.id,
      ruleId,
      tool: action.tool,
      target: 'path' in action ? (action as { path?: string }).path : 'command' in action ? (action as { command?: string }).command : undefined,
    })
  }

  private async ensurePendingForDecision(change: ChangeStatus, decision: Decision, action: Action): Promise<PendingItem> {
    const draft = decision.pendingDraft
    const draftKind = draft?.kind ?? 'risk'
    const fingerprint = draft?.actionFingerprint ?? fingerprintAction(action)

    // 熔断是「任务级」状态而不是「动作级」：一个任务只保留一个 open blocker。
    // 真实事故里通用人类决策路径会对每个被拦动作各建一个 BL（BL-2…BL-8），
    // 负责人解锁 BL-1 后其它 BL 仍是 open，事务生命周期无法收敛。
    if (draftKind === 'blocker') {
      const existing = this.findOpenBreakerBlocker(change)
      if (existing) {
        decision.notes = [
          ...(decision.notes ?? []),
          `已存在阻断项 ${existing.id}（${existing.title}），负责人运行 /flow unblock ${existing.id} 后重试即可，不要重复申请`,
        ]
        return existing
      }
      const failing = this.failingTaskIds(change)
      const item = this.createPending(change, {
        kind: 'blocker',
        title: draft?.title ?? `${decision.rule?.ruleId ?? '规则'} 需要负责人确认`,
        detail: draft?.detail ?? decision.message,
        data: {
          ...(draft?.data ?? {}),
          ...(failing.length === 1 ? { taskId: failing[0] } : {}),
        },
        scope: {
          changeId: change.id,
          ruleId: decision.rule?.ruleId,
          ...(failing.length === 1 ? { taskId: failing[0] } : {}),
          actionFingerprint: fingerprint,
        },
      })
      item.detail = `${item.detail}\n负责人确认后运行 /flow unblock ${item.id} 解锁（只读取证与 flow_status/flow_report_risk 不受限）。`
      await this.appendLedger('rule.human', { changeId: change.id, pendingId: item.id, ruleId: decision.rule?.ruleId })
      this.pushNotice(`需要负责人确认：${item.id}（${item.title}）。负责人运行 /flow unblock ${item.id} 后继续。`)
      return item
    }

    const existing = change.pending.find(
      (item) => item.status === 'open' && item.scope?.actionFingerprint === fingerprint && item.kind === draftKind,
    )
    if (existing) return existing
    const item = this.createPending(change, {
      kind: draftKind,
      title: draft?.title ?? `${decision.rule?.ruleId ?? '规则'} 需要负责人确认`,
      detail: draft?.detail ?? decision.message,
      data: draft?.data,
      scope: { changeId: change.id, ruleId: decision.rule?.ruleId, actionFingerprint: fingerprint },
    })
    await this.appendLedger('rule.human', { changeId: change.id, pendingId: item.id, ruleId: decision.rule?.ruleId })
    this.pushNotice(`需要负责人确认：${item.id}（${item.title}）。负责人处理后继续。`)
    return item
  }

  /** 当前变更里连续失败达到上限的任务 id（与 T-FAILURE-LIMIT 触发器同一判定）。 */
  private failingTaskIds(change: ChangeStatus): string[] {
    const limit = this.config.triggers.consecutive_failure_limit
    if (limit <= 0) return []
    return Object.values(change.tasks)
      .filter(
        (task) =>
          task.status !== 'done' &&
          task.status !== 'skipped' &&
          (task.failureCount ?? 0) >= limit,
      )
      .map((task) => task.id)
  }

  /**
   * 查找可复用的 open 阻断项：同任务的 blocker，或历史版本为每个动作创建的
   * T-FAILURE-LIMIT 残留项（真实 run 里 BL-2…BL-8 没有 data.taskId）。
   */
  private findOpenBreakerBlocker(change: ChangeStatus, taskId?: string): PendingItem | undefined {
    const failing = new Set(this.failingTaskIds(change))
    return change.pending.find((item) => {
      if (item.status !== 'open' || item.kind !== 'blocker') return false
      const itemTaskId = String(item.data?.taskId ?? item.scope?.taskId ?? '')
      if (taskId !== undefined && itemTaskId === taskId) return true
      if (itemTaskId !== '' && failing.has(itemTaskId)) return true
      return item.data?.ruleId === 'T-FAILURE-LIMIT'
    })
  }

  /**
   * 连续失败熔断：把任务置为 blocked，并且**只**创建一个 blocker 待处理项。
   * 幂等（同一任务已有 open blocker 时复用），避免每次失败/被拦动作都新建 BL-n。
   */
  private async blockTaskForConsecutiveFailures(
    change: ChangeStatus,
    taskId: string,
    failureCount: number,
  ): Promise<PendingItem> {
    const existing = this.findOpenBreakerBlocker(change, taskId)
    if (existing) return existing
    const item = this.createPending(change, {
      kind: 'blocker',
      title: `${taskId} 连续 ${failureCount} 次验证失败，已暂停`,
      detail: '先复现、找根因、再修复；不要继续试错。只读取证与 flow_status/flow_report_risk 不受限。',
      data: { taskId },
      scope: { changeId: change.id, taskId },
    })
    item.detail = `${item.detail}\n负责人确认后运行 /flow unblock ${item.id} 解锁（可只读诊断、查状态、上报风险）。`
    await this.appendLedger('task.blocked', {
      changeId: change.id,
      taskId,
      reason: 'consecutive-failures',
      pendingId: item.id,
    })
    this.pushNotice(
      `任务 ${taskId} 连续 ${failureCount} 次验证失败已熔断（${item.id}）：只读动作仍放行，负责人运行 /flow unblock ${item.id} 后继续。`,
    )
    return item
  }


  private createPending(
    change: ChangeStatus,
    input: {
      kind: PendingKind
      title: string
      detail: string
      data?: Record<string, unknown>
      scope?: PendingItem['scope']
    },
  ): PendingItem {
    const all = this.state?.changes.flatMap((item) => item.pending) ?? []
    const id = store.nextPendingId([...all, ...change.pending], input.kind)
    const item: PendingItem = {
      id,
      kind: input.kind,
      changeId: change.id,
      title: input.title,
      detail: input.detail,
      status: 'open',
      createdAt: isoNow(this.clock),
      scope: input.scope,
      data: input.data,
    }
    change.pending.push(item)
    return item
  }

  async recordPostcheck(input: { origin: 'agent' | 'external' | 'unknown'; changedPaths: string[]; taskId?: string }): Promise<Violation[]> {
    const change = this.current
    if (!change || input.changedPaths.length === 0) return []
    const now = isoNow(this.clock)
    const violations: Violation[] = []
    const task = input.taskId ? this.getTask(input.taskId) : this.getTask(this.activeTask()?.id ?? '')
    for (const rawPath of input.changedPaths) {
      const path = normalizeRelPath(rawPath)
      if (!path || isUnder(path, '.flowgate') || !path) continue
      if (input.origin !== 'agent') {
        change.externalChanges = [...(change.externalChanges ?? []), { path, at: now, origin: input.origin === 'external' ? 'external' : 'unknown' }]
        continue
      }
      if (!task) continue
      const allowed = isAllowedWrite(task, change, path)
      if (allowed.allowed) continue
      const violation: Violation = {
        id: `V-${change.violations.length + 1}`,
        changeId: change.id,
        taskId: task.id,
        path,
        kind: allowed.reason === 'undeclared-new-file' ? 'undeclared-new-file' : 'outside-scope',
        detectedAt: now,
        source: 'post',
        detail: allowed.hint,
      }
      change.violations.push(violation)
      violations.push(violation)
      await this.appendLedger('violation.detected', { changeId: change.id, taskId: task.id, path, kind: violation.kind })
      this.pushNotice(`检测到越界改动：${path}（${task.id} 范围外）。撤销或申请范围变更后才能继续写入。`)
    }
    if (violations.length > 0 || (change.externalChanges?.length ?? 0) > 0) await this.saveChange(change)
    return violations
  }

  async recordExternalChanges(paths: string[]): Promise<void> {
    const change = this.current
    if (!change || paths.length === 0) return
    const now = isoNow(this.clock)
    change.externalChanges = [
      ...(change.externalChanges ?? []),
      ...paths.map((path) => ({ path: normalizeRelPath(path), at: now, origin: 'external' as const })),
    ]
    await this.saveChange(change)
  }

  async clearViolation(path: string): Promise<boolean> {
    const change = this.current
    if (!change) return false
    const violation = change.violations.find((item) => item.path === normalizeRelPath(path) && !item.clearedAt)
    if (!violation) return false
    violation.clearedAt = isoNow(this.clock)
    await this.appendLedger('violation.cleared', { changeId: change.id, path, violationId: violation.id })
    await this.saveChange(change)
    return true
  }

  // ------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------

  async taskStart(taskId: string): Promise<TaskStartOutcome> {
    const change = this.requireChange()
    if (change.stage !== 'S4') {
      throw new FlowGateError(`当前阶段 ${change.stage} 不能开始任务`, 'S4 执行阶段才能领取任务；先用 flow_submit 完成当前门')
    }
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow repair 恢复')
    const tasks = this.getTasks()
    const task = tasks.find((item) => item.id === taskId)
    if (!task) throw new FlowGateError(`没有任务 ${taskId}`, `可用任务：${tasks.map((item) => item.id).join('、')}`)
    const active = this.activeTask()
    if (active) {
      // `run: main` tasks may execute in the main session while subagent tasks
      // of the same parallel batch keep running; two main-session tasks (or an
      // inline claim in the middle of another task) are still rejected.
      const activeCard = this.getTask(active.id)
      const activeIsMain = activeCard?.run === 'main'
      const currentIsMain = task.run === 'main'
      if (!(currentIsMain && !activeIsMain && this.config.dispatch !== 'inline')) {
        throw new FlowGateError(`任务 ${active.id} 正在进行中`, '先完成或暂停当前任务')
      }
    }
    if (this.config.dispatch === 'subagent' && task.run !== 'main') {
      throw new FlowGateError('当前是派发模式', '用 flow_dispatch_next 按执行图派发，不要自己领取任务')
    }
    const expected = this.nextTaskToStart(tasks)
    if (!expected) throw new FlowGateError('当前没有可领取的任务', '检查执行图与批次状态')
    if (expected.taskId !== taskId) {
      // A `run: main` task inside a parallel batch does not have to be first in
      // the batch order — it runs concurrently in the main session.
      const taskBatch = this.getPlan().batches.find((batch) => batch.batch === change.tasks[taskId]?.batch)
      const concurrentMain =
        task.run === 'main' &&
        taskBatch?.mode === 'parallel' &&
        // 只允许当前执行图正在推进的批次里的 run:main 任务并行领取；
        // 跨越未完成批次会破坏 depends_on / 批次顺序（reviewer Major）。
        expected.batchId === taskBatch.batch
      if (!concurrentMain) {
        throw new FlowGateError(
          `执行图要求先做 ${expected.taskId}`,
          `当前批次 ${expected.batchId}（${expected.mode}），下一个可领取的是 ${expected.taskId}`,
        )
      }
    }
    const now = isoNow(this.clock)
    const state = change.tasks[taskId]
    if (!state) throw new FlowGateError(`任务 ${taskId} 不在执行计划里`, '先重新提交 G3 或在计划修订后重试')
    state.status = 'running'
    state.startedAt = now
    this.ensureBatchRunning(change, state.batch)
    await this.appendLedger('task.started', { changeId: change.id, taskId, batch: state.batch })
    await this.saveChange(change)
    const envelope = this.buildEnvelope(change, task, state.batch)
    this.pushNotice(`任务 ${taskId} 开始。TDD：${task.tdd === 'required' ? '必须' : '可选'}；验证组：${task.verify.map((group) => group.group).join('、') || '未声明'}。`)
    return {
      ok: true,
      taskCard: task,
      envelope,
      message: `任务 ${task.id} 已开始：${task.title}`,
    }
  }

  private ensureBatchRunning(change: ChangeStatus, batchId: string): void {
    const batch = change.batches.find((item) => item.id === batchId)
    if (batch && batch.status === 'pending') {
      batch.status = 'running'
      batch.startedAt = isoNow(this.clock)
      void this.appendLedger('batch.started', { changeId: change.id, batch: batchId })
    }
  }

  private nextTaskToStart(tasks: TaskCard[]): { taskId: string; batchId: string; mode: string } | null {
    const change = this.current
    if (!change) return null
    const plan = this.getPlan()
    for (const batch of plan.batches) {
      const batchState = change.batches.find((item) => item.id === batch.batch)
      const taskIds = batch.tasks.filter((id) => {
        const state = change.tasks[id]
        return state && state.status !== 'done' && state.status !== 'skipped'
      })
      if (taskIds.length === 0) continue
      if (batchState && (batchState.status === 'done' || batchState.status === 'checkpoint')) continue
      if (batch.mode === 'parallel') {
        const running = batch.tasks.filter((id) => change.tasks[id]?.status === 'running')
        if (running.length >= this.config.parallel.max_agents) return null
      }
      const taskId = batch.mode === 'sequential' ? taskIds[0]! : taskIds[0]!
      return { taskId, batchId: batch.batch, mode: batch.mode }
    }
    return null
  }

  private buildEnvelope(change: ChangeStatus, task: TaskCard, batch: string): DispatchTaskEnvelope {
    const scenarios = (this.artifacts.spec?.scenarios ?? []).filter((scenario) => task.covers.includes(scenario.id))
    const contextExcerpt = this.artifacts.context?.raw?.slice(0, 4000) ?? ''
    const plan = this.getPlan()
    const batchDef = plan.batches.find((item) => item.batch === batch)
    const state = change.tasks[task.id]
    return {
      changeId: change.id,
      taskId: task.id,
      batch,
      mode: batchDef?.mode ?? 'sequential',
      task,
      worktree: state?.worktree,
      coveredScenarios: scenarios,
      contextExcerpt,
      handoff: change.handoff?.text,
      verifyGroups: task.verify,
      tdd: !task.autoRepair && (task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.config.limits).tddRequiredAll),
    }
  }

  async taskDone(taskId: string): Promise<TaskDoneOutcome> {
    const change = this.requireChange()
    if (change.stage !== 'S4') throw new FlowGateError(`当前阶段 ${change.stage} 不能完成任务`, '只有 S4 执行阶段的任务可以提交')
    const task = this.getTask(taskId)
    if (!task) throw new FlowGateError(`没有任务 ${taskId}`, '运行 /flow 查看任务列表')
    const taskState = change.tasks[taskId]
    if (!taskState) throw new FlowGateError(`任务 ${taskId} 未在执行计划中`, '重新提交 G3 后再试')
    if (taskState.status === 'done') throw new FlowGateError(`${taskId} 已经完成`, '无需重复提交')
    const failures: CheckOutcome[] = []
    const now = isoNow(this.clock)
    const level = levelProfile(change.complexity, change.risk, this.config.limits)

    // 1. Fresh GREEN evidence for every verify group.
    for (const group of task.verify) {
      const groupReceipts = this.receipts
        .filter((receipt) => receipt.changeId === change.id && receipt.taskId === taskId && receipt.group === group.group)
        .sort(compareReceipts)
      const latest = groupReceipts[groupReceipts.length - 1]
      const inputs = await hashInputs(this.fs, this.root, group.inputs)
      const freshness = receiptFreshness(latest, inputs.hash)
      if (!latest) {
        failures.push({
          item: `evidence:${group.group}`,
          label: `验证组 ${group.group} 还没有回执`,
          passed: false,
          hint: `先运行 flow_verify({ taskId: "${taskId}", group: "${group.group}" })，由插件执行并记录证据。`,
          example: `flow_verify({ taskId: "${taskId}", group: "${group.group}" })`,
        })
      } else if (!freshness.fresh) {
        failures.push({
          item: `evidence:${group.group}`,
          label: `验证组 ${group.group} 的回执已过期或失败`,
          passed: false,
          hint:
            freshness.reason === 'inputs-changed'
              ? `输入文件已变化（${(freshness.changedInputs ?? []).join('、') || '输入哈希不一致'}），重新运行 flow_verify。`
              : '最新一次回执不是通过状态；修复后重新 flow_verify。',
        })
      } else if (latest.summary && latest.summary.run === 0) {
        failures.push({
          item: `evidence:${group.group}`,
          label: `验证组 ${group.group} 没有跑到任何测试`,
          passed: false,
          hint: '运行数为 0 不算证据；检查测试命令是否能发现用例。',
        })
      } else if (latest.exitCode !== 0) {
        failures.push({
          item: `evidence:${group.group}`,
          label: `验证组 ${group.group} 退出码非 0`,
          passed: false,
          hint: '修复测试后重新 flow_verify。',
        })
      }
    }

    // 2. TDD ordering.
    // 自动修复任务用 fix 验证组收口，不强制 RED→GREEN（高风险的 tddRequiredAll 也豁免）。
    const tddRequired = !task.autoRepair && (task.tdd === 'required' || level.tddRequiredAll)
    if (tddRequired && taskState.tdd !== 'green') {
      failures.push({
        item: 'tdd',
        label: `${taskId} 要求 TDD，但没有 RED → GREEN 记录`,
        passed: false,
        hint: '先写失败测试并运行 flow_verify 得到 RED 回执，再改实现并再次 flow_verify 得到 GREEN。',
      })
    }

    // 3. Scope violations.
    const openViolations = change.violations.filter((violation) => !violation.clearedAt && (!violation.taskId || violation.taskId === taskId))
    if (openViolations.length > 0) {
      failures.push({
        item: 'scope',
        label: `还有 ${openViolations.length} 处未撤销的越界改动`,
        passed: false,
        hint: `撤销越界改动（如 git checkout -- <文件>）或申请范围变更：${openViolations.map((item) => item.path).join('、')}`,
      })
    }

    // 4. Review.
    if (level.reviewRoundsPerTask > 0 && this.config.review.enabled && this.config.review.requireForTaskGate) {
      const reviews = change.reviews.filter((review) => review.taskId === taskId && (review.verdict === 'pass' || review.waived))
      if (reviews.length < level.reviewRoundsPerTask) {
        failures.push({
          item: 'review',
          label: `${taskId} 需要 ${level.reviewRoundsPerTask} 轮审查`,
          passed: false,
          hint: '运行 flow_request_review（或由插件按风险自动审查），审查通过后再 flow_task_done。',
        })
      }
    }

    if (failures.length > 0) {
      taskState.status = taskState.status === 'running' ? 'running' : taskState.status
      await this.appendLedger('task.blocked', { changeId: change.id, taskId, failures: failures.map((failure) => failure.item) })
      await this.saveChange(change)
      return {
        ok: false,
        passed: false,
        failures,
        message: `${taskId} 还不能完成：${failures.map((failure) => failure.label).join('；')}`,
      }
    }

    // Passed: mark done and commit.
    taskState.status = 'done'
    taskState.finishedAt = now
    await this.appendLedger('task.done', { changeId: change.id, taskId, batch: taskState.batch })
    let committed = false
    if (this.config.git.auto_commit && this.git) {
      try {
        await this.git.add(this.root, ['-A'])
        await this.git.commit(this.root, `flowgate(${change.id}/${taskId}): ${task.title}`)
        committed = true
      } catch (error) {
        this.pushNotice(`自动提交失败：${(error as Error).message}`)
      }
    }
    await this.checkBatchProgress(change, now)
    await this.saveChange(change)
    return {
      ok: true,
      passed: true,
      failures: [],
      message: `${taskId} 已通过任务门，工作区干净${committed ? '并已提交' : ''}。`,
      committed,
      nextStage: change.stage,
    }
  }

  // ------------------------------------------------------------------
  // Dispatch (subagent mode) and review intake
  // ------------------------------------------------------------------

  /**
   * Find the next dispatchable task(s) according to the approved execution graph.
   * The host starts one child agent per returned envelope and calls taskDone()
   * (or taskFailed()) when each returns.
   */
  async dispatchNext(): Promise<DispatchOutcome> {
    const change = this.requireChange()
    if (change.stage !== 'S4') {
      throw new FlowGateError(`当前阶段 ${change.stage} 不能派发任务`, '只有 S4 执行阶段可以按执行图派发')
    }
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow repair 恢复')
    if (this.config.dispatch === 'inline') {
      throw new FlowGateError('当前是 inline 模式，不派子 agent', '用 flow_task_start 按执行图顺序领取任务；要派发请把 config.dispatch 改为 auto 或 subagent')
    }
    const plan = this.getPlan()
    const tasks = this.getTasks()
    const now = isoNow(this.clock)
    const batchStates = () => change.batches
    for (const batch of plan.batches) {
      let state = batchStates().find((item) => item.id === batch.batch)
      if (!state) continue
      if (state.status === 'done') continue
      if (state.status === 'checkpoint' || state.status === 'failed') {
        // A failed checkpoint is retried by the host on the next
        // flow_dispatch_next call. When an auto-generated repair batch (retryOf)
        // is still pending, let the loop fall through to dispatch that batch
        // first; only ask for a retry once the repairs are done.
        const pendingRepairBatches = change.batches.filter(
          (item) => item.retryOf === batch.batch && item.status !== 'done',
        )
        if (pendingRepairBatches.length > 0) continue
        const attempts = state.checkpoint?.attempts ?? 0
        // 达到连续失败上限后不再自动重试集成命令，转为负责人闸门：等负责人
        // 处理好冲突/失败并批准 conflict 项（会重置 attempts）后再重试。
        const limit = this.config.triggers.consecutive_failure_limit
        const ownerConflict = change.pending.find(
          (entry) =>
            entry.status === 'open' &&
            entry.kind === 'conflict' &&
            String(entry.data?.batchId ?? '') === batch.batch,
        )
        if (state.status === 'failed' && !ownerConflict) {
          await this.saveChange(change)
          throw new FlowGateError(
            `批次 ${batch.batch} 的集成检查点已被负责人放弃自动重试`,
            '如仍需交付：新建变更重跑；或 /flow doctor 查看状态。不再自动重试该批次',
          )
        }
        if (limit > 0 && attempts >= limit && ownerConflict) {
          await this.saveChange(change)
          return {
            dispatched: [],
            batchId: batch.batch,
            mode: batch.mode,
            blocked: ownerConflict,
            message: `批次 ${batch.batch} 的集成检查点连续失败 ${attempts} 次（上限 ${limit}），已转为负责人处理（${ownerConflict.id}）。修好后由负责人执行 /flow conflict approve ${ownerConflict.id}（或面板确认），再调用 flow_dispatch_next 重试。`,
          }
        }
        await this.appendLedger('checkpoint.retry_requested', {
          changeId: change.id,
          batchId: batch.batch,
          attempts,
          status: state.checkpoint?.status,
        })
        await this.saveChange(change)
        return {
          dispatched: [],
          batchId: batch.batch,
          mode: batch.mode,
          retryCheckpoint: { batchId: batch.batch, attempts },
          message:
            state.checkpoint?.status === 'conflict'
              ? `批次 ${batch.batch} 的集成检查点待重试（上次为合并冲突或未解决失败）。负责人解决冲突后再次调用 flow_dispatch_next 重试检查点。`
              : `批次 ${batch.batch} 的集成检查点待重试（已尝试 ${attempts} 次）。修复后再次调用 flow_dispatch_next 重试检查点。`,
        }
      }
      if (batch.mode === 'parallel') {
        const running = batch.tasks.filter((id) => change.tasks[id]?.status === 'running')
        const queued = batch.tasks.filter((id) => {
          const taskState = change.tasks[id]
          return taskState && (taskState.status === 'pending' || taskState.status === 'queued' || taskState.status === 'interrupted')
        })
        const mainQueued = queued
          .map((id) => ({ taskId: id, card: tasks.find((item) => item.id === id) }))
          .filter((entry) => entry.card?.run === 'main')
          .map((entry) => ({ taskId: entry.taskId, batch: batch.batch, mode: batch.mode }))
        const subagentQueued = queued.filter((id) => tasks.find((item) => item.id === id)?.run !== 'main')
        const capacity = Math.max(0, this.config.parallel.max_agents - running.length)
        const toStart = subagentQueued.slice(0, capacity)
        if (toStart.length === 0) {
          if (running.length > 0) {
            for (const taskId of subagentQueued) {
              const queuedState = change.tasks[taskId]
              if (queuedState && queuedState.status === 'pending') queuedState.status = 'queued'
            }
            await this.saveChange(change)
            return {
              dispatched: [],
              batchId: batch.batch,
              mode: batch.mode,
              ...(mainQueued.length > 0 ? { mainTasks: mainQueued } : {}),
              message:
                mainQueued.length > 0
                  ? `批次 ${batch.batch} 已有 ${running.length} 个子 agent 在运行；主会话任务待执行：${mainQueued.map((item) => item.taskId).join('、')}（用 flow_task_start 领取）。`
                  : `批次 ${batch.batch} 已有 ${running.length} 个子 agent 在运行，达到并发上限 ${this.config.parallel.max_agents}。`,
            }
          }
          if (mainQueued.length > 0) {
            this.ensureBatchRunning(change, batch.batch)
            await this.saveChange(change)
            return {
              dispatched: [],
              batchId: batch.batch,
              mode: batch.mode,
              mainTasks: mainQueued,
              message: `批次 ${batch.batch} 有 ${mainQueued.length} 个 run: main 任务待主会话执行：${mainQueued.map((item) => item.taskId).join('、')}。用 flow_task_start 领取；完成后调用 flow_dispatch_next。`,
            }
          }
          throw new FlowGateError(`批次 ${batch.batch} 没有可派发的任务`, '检查是否有任务被阻塞；被阻塞的任务需要先处理待处理项')
        }
        this.ensureBatchRunning(change, batch.batch)
        const dispatched: DispatchTaskEnvelope[] = []
        for (const taskId of toStart) {
          const task = tasks.find((item) => item.id === taskId)
          const taskState = change.tasks[taskId]
          if (!task || !taskState) continue
          taskState.status = 'running'
          taskState.startedAt = now
          await this.appendLedger('task.started', { changeId: change.id, taskId, batch: batch.batch, mode: 'parallel' })
          dispatched.push(this.buildEnvelope(change, task, batch.batch))
        }
        // P1-6：超出并发上限的并行任务显式进入 queued（此前 queued 是从不写入的死状态），
        // 面板/状态可以区分"排队中"和"待开始"；槽位释放后由宿主自动补位。
        for (const taskId of subagentQueued.slice(capacity)) {
          const queuedState = change.tasks[taskId]
          if (queuedState && queuedState.status === 'pending') queuedState.status = 'queued'
        }
        await this.saveChange(change)
        this.pushNotice(`已派发批次 ${batch.batch}（并行）的 ${dispatched.map((item) => item.taskId).join('、')}；每个任务在自己的 worktree 里执行。`)
        return {
          dispatched,
          batchId: batch.batch,
          mode: batch.mode,
          ...(mainQueued.length > 0 ? { mainTasks: mainQueued } : {}),
          message:
            mainQueued.length > 0
              ? `已派发 ${dispatched.map((item) => item.taskId).join('、')}（并行批次 ${batch.batch}）；主会话任务：${mainQueued.map((item) => item.taskId).join('、')}（用 flow_task_start 领取）。`
              : `已派发 ${dispatched.map((item) => item.taskId).join('、')}（并行批次 ${batch.batch}）。`,
        }
      }
      // sequential batch: one task at a time, in order.
      const nextId = batch.tasks.find((id) => {
        const taskState = change.tasks[id]
        return taskState && taskState.status !== 'done' && taskState.status !== 'skipped'
      })
      if (!nextId) {
        state.status = 'done'
        state.completedAt = now
        await this.appendLedger('batch.completed', { changeId: change.id, batch: batch.batch })
        // Repair batch finished: ask the host to retry the checkpoint of the
        // batch it repairs instead of moving on to later batches.
        if (batch.retryOf) {
          const retryState = change.batches.find((item) => item.id === batch.retryOf)
          const attempts = retryState?.checkpoint?.attempts ?? 0
          await this.appendLedger('checkpoint.retry_requested', {
            changeId: change.id,
            batchId: batch.retryOf,
            attempts,
            viaRepairBatch: batch.batch,
          })
          await this.saveChange(change)
          return {
            dispatched: [],
            batchId: batch.retryOf,
            mode: retryState?.mode,
            retryCheckpoint: { batchId: batch.retryOf, attempts },
            message: `修复批次 ${batch.batch} 已完成，重试原批次 ${batch.retryOf} 的集成检查点。`,
          }
        }
        continue
      }
      const nextTask = tasks.find((item) => item.id === nextId)
      const taskState = change.tasks[nextId]
      if (!nextTask || !taskState) continue
      if (taskState.status === 'blocked') {
        throw new FlowGateError(`任务 ${nextId} 被阻塞`, '先处理该任务的待处理项（/flow 查看）后再派发')
      }
      const runningTask = Object.values(change.tasks).find((item) => item.status === 'running')
      if (runningTask) throw new FlowGateError(`任务 ${runningTask.id} 仍在运行`, '顺序批次一次只能运行一个任务；等它结束后再调用 flow_dispatch_next')
      if (nextTask.run === 'main') {
        this.ensureBatchRunning(change, batch.batch)
        await this.saveChange(change)
        return {
          dispatched: [],
          batchId: batch.batch,
          mode: batch.mode,
          mainTasks: [{ taskId: nextId, batch: batch.batch, mode: batch.mode }],
          message: `批次 ${batch.batch} 的下一个任务 ${nextId} 标记 run: main，请主会话用 flow_task_start("${nextId}") 执行；完成后调用 flow_dispatch_next。`,
        }
      }
      this.ensureBatchRunning(change, batch.batch)
      taskState.status = 'running'
      taskState.startedAt = now
      await this.appendLedger('task.started', { changeId: change.id, taskId: nextId, batch: batch.batch, mode: 'sequential' })
      await this.saveChange(change)
      const envelope = this.buildEnvelope(change, nextTask, batch.batch)
      this.pushNotice(`已派发 ${nextId}（顺序批次 ${batch.batch}）。`)
      return { dispatched: [envelope], batchId: batch.batch, mode: batch.mode, message: `已派发任务 ${nextId}（顺序批次 ${batch.batch}）。` }
    }
    const allDone = change.batches.length > 0 && change.batches.every((batch) => batch.status === 'done')
    if (allDone) {
      const result = await this.evaluateGate(change, 'G4')
      await this.recordGateResult(change, 'G4', result, now)
      await this.saveChange(change)
      const reachedStage = change.stage as StageId
      return { dispatched: [], message: reachedStage === 'S5' ? '全部批次已完成并通过 G4，进入 S5 验证。' : '全部批次已完成。' }
    }
    return { dispatched: [], message: '当前没有可派发的任务。' }
  }

  /** Record the worktree a parallel task runs in (host side effect made visible). */
  async setTaskWorktree(taskId: string, worktree: string, agentId?: string): Promise<void> {
    const change = this.requireChange()
    const taskState = change.tasks[taskId]
    if (!taskState) throw new FlowGateError(`没有任务 ${taskId}`, '检查执行图')
    taskState.worktree = normalizeRelPath(worktree)
    if (agentId) taskState.agent = agentId
    await this.appendLedger('worktree.created', { changeId: change.id, taskId, worktree: taskState.worktree, agentId })
    await this.saveChange(change)
  }

  /** Mark a dispatched/claimed task as failed or interrupted, with a pending item. */
  async taskFailed(taskId: string, reason: string): Promise<void> {
    const change = this.requireChange()
    const taskState = change.tasks[taskId]
    if (!taskState) throw new FlowGateError(`没有任务 ${taskId}`, '检查执行图')
    taskState.status = 'failed'
    taskState.blockReason = reason
    taskState.finishedAt = isoNow(this.clock)
    this.createPending(change, {
      kind: 'blocker',
      title: `${taskId} 执行失败/中断`,
      detail: reason,
      data: { taskId },
      scope: { changeId: change.id, taskId },
    })
    await this.appendLedger('task.blocked', { changeId: change.id, taskId, reason })
    await this.saveChange(change)
  }

  /**
   * Intake a structured review result (from host review subagent).
   * Coverage-incomplete reviews never count toward the required rounds.
   */
  async recordReview(input: {
    taskId?: string
    kind: 'task' | 'final' | 'security'
    verdict: 'pass' | 'changes-required'
    findings: ReviewFinding[]
    coverageOk: boolean
    diffFingerprint?: string
    waived?: boolean
    waivedReason?: string
    attempts?: number
  }): Promise<ReviewRecord> {
    const change = this.requireChange()
    const review: ReviewRecord = {
      id: `RV-${change.reviews.length + 1}`,
      changeId: change.id,
      taskId: input.taskId,
      kind: input.kind,
      verdict: input.verdict,
      findings: input.findings,
      coverageOk: input.coverageOk,
      diffFingerprint: input.diffFingerprint ?? '',
      createdAt: isoNow(this.clock),
      attempts: input.attempts ?? 1,
      waived: input.waived,
      waivedReason: input.waivedReason,
    }
    change.reviews.push(review)
    if (input.taskId && change.tasks[input.taskId]) change.tasks[input.taskId]!.reviewIds.push(review.id)
    if (!input.coverageOk) {
      await this.appendLedger('review.coverage_failed', { changeId: change.id, reviewId: review.id, taskId: input.taskId })
    }
    await this.appendLedger('review.reported', {
      changeId: change.id,
      reviewId: review.id,
      taskId: input.taskId,
      kind: input.kind,
      verdict: input.verdict,
      coverageOk: input.coverageOk,
      findings: input.findings.map((finding) => ({ severity: finding.severity, file: finding.file, line: finding.line })),
    })
    await this.saveChange(change)
    if (input.findings.some((finding) => finding.severity === 'critical')) {
      this.pushNotice(`审查发现 critical 问题（${review.id}），任务门不会通过，必须修复。`)
    }
    return review
  }

  private async checkBatchProgress(change: ChangeStatus, now: string): Promise<void> {
    const plan = this.getPlan()
    for (const batch of plan.batches) {
      const state = change.batches.find((item) => item.id === batch.batch)
      if (!state || state.status === 'done') continue
      const allDone = batch.tasks.every((id) => change.tasks[id]?.status === 'done' || change.tasks[id]?.status === 'skipped')
      if (!allDone) continue
      if (batch.mode === 'parallel') {
        // checkpoint（含失败后待重试/冲突待处理）只能由 completeCheckpoint 结算；
        // 这里若把它当 done 会在修复任务完成时"跳过集成检查点"，把失败批次静默放行。
        if (state.status === 'checkpoint' || state.status === 'failed') continue
        state.status = 'checkpoint'
        await this.appendLedger('checkpoint.failed', { changeId: change.id, batch: batch.batch, note: 'awaiting-integration-checkpoint' })
        this.pushNotice(`并行批次 ${batch.batch} 的任务全部完成，需要集成检查点：合并 worktree 分支并跑全量测试。`)
        continue
      }
      state.status = 'done'
      state.completedAt = now
      await this.appendLedger('batch.completed', { changeId: change.id, batch: batch.batch })
    }
    const allBatchesDone = change.batches.every((batch) => batch.status === 'done')
    if (allBatchesDone && change.batches.length > 0 && change.stage === 'S4') {
      const result = await this.evaluateGate(change, 'G4')
      await this.recordGateResult(change, 'G4', result, now)
    }
  }

  /**
   * Finish the integration checkpoint of a parallel batch.
   *
   * - pass: mark the batch done and auto-close its open conflict pendings.
   * - `integration` failure: generate `FIX-n` repair tasks (scope = files parsed
   *   from the failure output, falling back to the batch task scopes) in a new
   *   sequential batch (`retryOf` = failed batch). After those tasks finish,
   *   `dispatchNext` returns `retryCheckpoint` so the host retries the merge +
   *   integration command on the same batch. Repeated failures above
   *   `triggers.consecutive_failure_limit` fall back to an owner conflict item.
   * - `merge`/unknown failure: owner conflict pending; the host retries the
   *   checkpoint on the next `flow_dispatch_next` call (`retryCheckpoint`).
   */
  async completeCheckpoint(
    batchId: string,
    result: {
      ok: boolean
      detail?: string
      /** Failure class reported by the host. */
      kind?: 'merge' | 'integration' | 'unknown'
      /** Raw integration-command output (used to derive repair-task scope). */
      output?: string
      /** Integration command itself (parser hint). */
      command?: string
    },
  ): Promise<void> {
    const change = this.requireChange()
    const now = isoNow(this.clock)
    const batch = change.batches.find((item) => item.id === batchId)
    if (!batch) throw new FlowGateError(`没有批次 ${batchId}`, '运行 /flow 查看执行图')
    if (batch.status === 'done') {
      // 幂等：并发/迟到的检查点回调不重复改状态（成功重放直接返回，失败回调忽略）。
      return
    }
    if (result.ok) {
      batch.status = 'done'
      batch.completedAt = now
      batch.checkpoint = { status: 'passed', at: now, detail: result.detail, attempts: batch.checkpoint?.attempts }
      await this.appendLedger('checkpoint.passed', { changeId: change.id, batch: batchId })
      // A successful retry closes the conflict items it was waiting on.
      for (const item of change.pending) {
        if (item.status !== 'open' || item.kind !== 'conflict') continue
        if (String(item.data?.batchId ?? '') !== batchId) continue
        item.status = 'approved'
        item.decidedAt = now
        item.decisionReason = '集成检查点重试通过，自动关闭'
      }
      await this.checkBatchProgress(change, now)
      await this.saveChange(change)
      return
    }

    const attempts = (batch.checkpoint?.attempts ?? 0) + 1
    const kind = result.kind ?? 'unknown'
    batch.status = 'checkpoint'
    batch.checkpoint = {
      status: kind === 'integration' ? 'failed' : 'conflict',
      at: now,
      detail: result.detail,
      attempts,
    }
    await this.appendLedger('checkpoint.failed', {
      changeId: change.id,
      batchId,
      detail: result.detail,
      kind,
      attempts,
    })
    if (kind === 'merge') await this.appendLedger('merge.conflict', { changeId: change.id, batchId })

    const limit = this.config.triggers.consecutive_failure_limit
    const canAutoRepair = kind === 'integration' && (limit <= 0 || attempts < limit)
    if (canAutoRepair) {
      const inputs = this.checkpointRepairInputs(batchId, result)
      const cards = draftRepairTasks(change, inputs, this.nextRepairIndex(change))
      this.hydrateRepairTasks(cards, result.command)
      const repairBatchId = this.insertRepairBatch(
        change,
        cards,
        batchId,
        `集成检查点失败自动修复（原批次 ${batchId}）`,
      )
      await this.appendLedger('plan.repair_added', {
        changeId: change.id,
        batchId,
        repairBatchId,
        tasks: cards.map((card) => card.id),
        attempts,
      })
      this.pushNotice(
        `批次 ${batchId} 集成检查点失败：已生成修复任务 ${cards.map((card) => card.id).join('、')}（批次 ${repairBatchId}）；完成后会自动重试检查点。`,
      )
    } else {
      // 重试仍失败时复用同批次已有的 open conflict 项，避免每次 retry 刷一条新待处理项。
      const existing = change.pending.find(
        (entry) =>
          entry.status === 'open' &&
          entry.kind === 'conflict' &&
          String(entry.data?.batchId ?? '') === batchId,
      )
      if (existing) {
        existing.detail = result.detail ?? existing.detail
        existing.data = { ...(existing.data ?? {}), kind, attempts }
      } else {
        this.createPending(change, {
          kind: 'conflict',
          title: `批次 ${batchId} 集成检查点失败`,
          detail: result.detail ?? '合并或全量测试失败，需要负责人决定如何处理。',
          data: { batchId, kind, attempts },
        })
      }
    }
    await this.saveChange(change)
  }

  /**
   * Make auto-generated repair tasks actually completable.
   *
   * `draftRepairTasks` (state machine) only knows scopes and marks TDD required.
   * For an auto repair task the failing state is usually not reproducible as a
   * RED unit test (e.g. a lint/build failure or an already-green suite), so
   * requiring RED→GREEN would permanently block `flow_task_done`. Repair tasks
   * therefore use TDD `optional` and carry the project's failing command as a
   * `fix` verify group, so completion still requires a fresh GREEN receipt.
   * Commands that `validateVerifyCommand` rejects (`&&`, pipes, …) are skipped.
   */
  private hydrateRepairTasks(cards: TaskCard[], preferredCommand?: string): void {
    const commands = this.config.commands
    // 只用测试类命令：build/lint 等命令的证据 phase 恒为 none，无法满足
    // taskDone 的"新鲜 GREEN"证据要求（会把修复任务再次卡死）。
    const candidates = [preferredCommand, commands.integration, commands.test, commands.lint, commands.build, commands.typecheck]
    const command =
      candidates.find(
        (item): item is string =>
          typeof item === 'string' &&
          item !== '' &&
          item !== 'none' &&
          validateVerifyCommand(item).ok &&
          detectEvidenceKind(item) === 'test',
      ) ?? ''
    for (const card of cards) {
      card.tdd = 'optional'
      card.autoRepair = true
      card.tddReason = '自动修复任务：以重新跑通失败命令为证据（不强制 RED→GREEN；仍需新鲜 GREEN 回执）'
      if (command !== '') {
        card.verify = [{ group: 'fix', command, inputs: [...card.scope] }]
      }
    }
  }

  /** Next `FIX-n` number for auto-generated repair tasks. */
  private nextRepairIndex(change: ChangeStatus): number {
    let max = 0
    const scan = (id: string): void => {
      const match = /^FIX-(\d+)$/.exec(id)
      if (match) max = Math.max(max, Number(match[1]))
    }
    for (const task of this.getTasks()) scan(task.id)
    for (const id of Object.keys(change.tasks)) scan(id)
    return max
  }

  /**
   * Repair-task inputs for S5 gate failures that need code changes.
   *
   * Only verification-class items are converted: full-suite regressions, lint/
   * build/typecheck failures, and final-review critical/major findings (which
   * point at concrete files). Evidence-only failures (`g5.runtime`,
   * `g5.scenarios`) stay in S5 — a code repair task cannot fix them.
   */
  private gateVerificationInputs(change: ChangeStatus, failures: CheckOutcome[]): VerificationFailureInput[] | null {
    const items = new Set(failures.map((failure) => failure.item))
    const inputs: VerificationFailureInput[] = []
    const allScopes = (): string[] => [
      ...new Set(this.getTasks().flatMap((task) => [...task.scope, ...task.newFiles, ...task.tests])),
    ]
    if (items.has('g5.fullTests')) {
      const receipt = [...this.receipts]
        .filter((entry) => entry.changeId === change.id && entry.group === 'full-suite')
        .sort(compareReceipts)
        .pop()
      const failed = receipt?.summary?.failures ?? []
      const files = failed
        .map((failure) => failure.file ?? this.fileFromFailureName(failure.name))
        .filter((file): file is string => Boolean(file))
      const tests = failed.map((failure) => failure.name).filter((name): name is string => Boolean(name))
      inputs.push({ name: 'S5 全量测试回归', files: files.length > 0 ? files : allScopes(), tests })
    }
    if (items.has('g5.lintBuild')) {
      inputs.push({ name: 'S5 lint/build/typecheck 失败', files: allScopes(), tests: [] })
    }
    if (items.has('g5.finalReview')) {
      const finalReview = [...change.reviews]
        .filter((review) => review.kind === 'final')
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))[0]
      const findings = (finalReview?.findings ?? []).filter(
        (finding) => finding.severity === 'critical' || finding.severity === 'major',
      )
      if (findings.length > 0) {
        const files = [...new Set(findings.map((finding) => finding.file).filter((file) => file !== ''))]
        inputs.push({ name: 'S5 终审 findings', files: files.length > 0 ? files : allScopes(), tests: [] })
      }
    }
    return inputs.length > 0 ? inputs : null
  }

  /** Derive repair-task inputs from a failed integration command. */
  private checkpointRepairInputs(
    batchId: string,
    result: { output?: string; command?: string; detail?: string },
  ): VerificationFailureInput[] {
    const batch = this.getPlan().batches.find((item) => item.batch === batchId)
    const files = new Set<string>()
    const tests = new Set<string>()
    const output = result.output ?? ''
    if (output.trim() !== '') {
      try {
        const summary = parseTestOutput({
          command: result.command && result.command !== '' ? result.command : 'integration',
          stdout: output,
          stderr: '',
          exitCode: 1,
        })
        for (const failure of summary.failures ?? []) {
          const derived = failure.file ?? this.fileFromFailureName(failure.name)
          if (derived) files.add(derived)
          if (failure.name) tests.add(failure.name)
        }
      } catch {
        // Parser is tolerant; this is only a fallback-scope optimization.
      }
    }
    if (files.size === 0) {
      // Fallback: the failed batch's task scopes, so the repair task can write
      // at all (an empty scope would be rejected by the write guard).
      for (const taskId of batch?.tasks ?? []) {
        const task = this.getTask(taskId)
        for (const path of task?.scope ?? []) files.add(path)
      }
    }
    return [{ name: `集成检查点 ${batchId}`, files: [...files].sort(), tests: [...tests].sort() }]
  }

  /**
   * Derive a file path from a test-failure name when the parser only returns
   * display names (e.g. vitest `test/a.test.ts > suite > case`).
   */
  private fileFromFailureName(name: string | undefined): string {
    const raw = (name ?? '').trim()
    if (raw === '') return ''
    const head = raw.split(' > ')[0]!.trim()
    if (!head.includes('/') && !/\.[a-z0-9]+$/i.test(head)) return ''
    return normalizeRelPath(head)
  }

  /** Insert a sequential repair batch right after `afterBatchId`. */
  private insertRepairBatch(
    change: ChangeStatus,
    cards: TaskCard[],
    afterBatchId: string,
    why: string,
    options: { retryOf?: boolean } = {},
  ): string {
    const plan = change.plan ?? this.getPlan()
    const nextPlan: ExecutionPlan = { batches: plan.batches.map((batch) => ({ ...batch, tasks: [...batch.tasks] })) }
    const repairBatchId = this.nextPlanBatchId(nextPlan)
    const taskIds = cards.map((card) => card.id)
    const planIndex = nextPlan.batches.findIndex((batch) => batch.batch === afterBatchId)
    // S5→S4 修复批次不是"重试检查点"，不应带 retryOf（否则 dispatchNext 会对已通过
    // 批次发 retryCheckpoint）；检查点失败生成的修复批次则必须带。
    const retryOf = options.retryOf === false ? undefined : afterBatchId
    nextPlan.batches.splice(planIndex >= 0 ? planIndex + 1 : nextPlan.batches.length, 0, {
      batch: repairBatchId,
      mode: 'sequential',
      tasks: taskIds,
      why,
      ...(retryOf !== undefined ? { retryOf } : {}),
    })
    change.newTasks = [...(change.newTasks ?? []), ...cards]
    const state: BatchState = {
      id: repairBatchId,
      mode: 'sequential',
      status: 'pending',
      tasks: [...taskIds],
      ...(retryOf !== undefined ? { retryOf } : {}),
    }
    const stateIndex = change.batches.findIndex((batch) => batch.id === afterBatchId)
    change.batches.splice(stateIndex >= 0 ? stateIndex + 1 : change.batches.length, 0, state)
    for (const card of cards) {
      change.tasks[card.id] = {
        id: card.id,
        batch: repairBatchId,
        status: 'pending',
        tdd: 'none',
        evidenceIds: [],
        reviewIds: [],
      }
    }
    change.plan = nextPlan
    return repairBatchId
  }

  // ------------------------------------------------------------------
  // Verification and evidence
  // ------------------------------------------------------------------

  async runVerify(request: VerifyRequest): Promise<EvidenceReceipt> {
    const change = this.requireChange()
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '运行 /flow repair 恢复')
    let command = request.command
    let inputs = request.inputs
    let groupName = request.group
    let task: TaskCard | undefined
    if (request.taskId) {
      task = this.getTask(request.taskId)
      if (!task) throw new FlowGateError(`没有任务 ${request.taskId}`, '运行 /flow 查看任务列表')
      const group = task.verify.find((item) => item.group === request.group)
      if (!group) throw new FlowGateError(`任务 ${request.taskId} 没有验证组 ${request.group}`, `可用验证组：${task.verify.map((item) => item.group).join('、')}`)
      command = group.command
      inputs = group.inputs
      groupName = group.group
    }
    if (!command) {
      command = this.config.commands.test
      if (!command || command === 'none') throw new FlowGateError('没有可用的验证命令', '在任务卡里声明 verify，或在 project.md 配置 test 命令')
    }
    const check = validateVerifyCommand(command)
    if (!check.ok) throw new FlowGateError(`验证命令不合法：${check.reason}`, '不允许 && || ; 管道 重定向 命令替换和反引号')
    if (!this.runner) throw new FlowGateError('宿主没有提供命令执行器', '运行 /flow doctor 查看缺失接口')
    this.evidenceCounter += 1
    const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
    const receipt = await runVerifyGroup({
      fs: this.fs,
      root: this.root,
      runner: this.runner,
      change,
      task: task ?? {
        id: request.taskId ?? '',
        title: groupName,
        covers: [],
        scope: [],
        tests: [],
        newFiles: [],
        changes: [],
        dependsOn: [],
        tdd: 'optional',
        verify: [],
        run: 'main',
        risk: [],
        size: 'S',
        body: '',
      },
      group: { group: groupName, command, inputs: inputs ?? this.baselineInputs() },
      clock: this.clock,
      nextEvidenceId: () => id,
    })
    await this.appendReceipt(receipt)
    if (task && change.tasks[task.id]) {
      const taskState = change.tasks[task.id]!
      taskState.evidenceIds.push(receipt.id)
      if (receipt.phase === 'red') {
        taskState.tdd = 'red'
        taskState.redObserved = true
      } else if (receipt.phase === 'green') {
        const tddRequired =
          !task.autoRepair &&
          (task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.config.limits).tddRequiredAll)
        if (!tddRequired || taskState.redObserved) taskState.tdd = 'green'
      }
      if (receipt.exitCode !== 0) {
        taskState.failureCount = (taskState.failureCount ?? 0) + 1
        const limit = this.config.triggers.consecutive_failure_limit
        if (limit > 0 && taskState.failureCount >= limit) {
          taskState.status = 'blocked'
          taskState.blockReason = `连续 ${taskState.failureCount} 次验证失败`
          await this.blockTaskForConsecutiveFailures(change, task.id, taskState.failureCount)
        }
      } else {
        taskState.failureCount = 0
      }
    }
    if (groupName === 'baseline' && receipt.summary) {
      change.baseline = {
        commit: this.git ? await this.git.head(this.root).catch(() => null) : null,
        summary: receipt.summary,
        recordedAt: isoNow(this.clock),
        receiptId: receipt.id,
      }
    }
    await this.appendLedger('verify.receipt', {
      changeId: change.id,
      taskId: request.taskId,
      evidenceId: receipt.id,
      group: groupName,
      phase: receipt.phase,
      summary: receipt.summary,
    })
    this.hooks?.onEvidence?.(receipt)
    await this.saveChange(change)
    return receipt
  }

  async attachEvidence(input: { taskId?: string; kind: EvidenceKind; path: string; note?: string }): Promise<EvidenceReceipt> {
    const change = this.requireChange()
    this.evidenceCounter += 1
    const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
    const now = isoNow(this.clock)
    const receipt: EvidenceReceipt = {
      id,
      changeId: change.id,
      taskId: input.taskId,
      group: 'manual',
      kind: input.kind,
      phase: 'unknown',
      command: `attach:${input.path}`,
      runBy: 'agent',
      exitCode: 0,
      summary: null,
      inputsHash: '',
      outputRef: input.path,
      startedAt: now,
      finishedAt: now,
      notes: input.note,
    }
    await this.appendReceipt(receipt)
    if (input.taskId && change.tasks[input.taskId]) change.tasks[input.taskId]!.evidenceIds.push(id)
    await this.appendLedger('evidence.recorded', { changeId: change.id, evidenceId: id, kind: input.kind, runBy: 'agent' })
    await this.saveChange(change)
    return receipt
  }

  // ------------------------------------------------------------------
  // Pending decisions, overrides, exceptions, levels
  // ------------------------------------------------------------------

  async requestScopeChange(input: { taskId: string; add: string[]; reason: string }): Promise<PendingItem> {
    const change = this.requireChange()
    if (change.stage !== 'S4') throw new FlowGateError('只有 S4 执行阶段可以申请范围变更', '当前阶段不需要范围变更')
    const task = this.getTask(input.taskId)
    if (!task) throw new FlowGateError(`没有任务 ${input.taskId}`, '运行 /flow 查看任务列表')
    if (!input.add || input.add.length === 0) throw new FlowGateError('范围变更至少写一个路径', '用法：flow_request_scope_change({ taskId, add: ["src/..."], reason })')
    if (!input.reason.trim()) throw new FlowGateError('范围变更必须写理由', '说明为什么必须改这些文件')
    const item = this.createPending(change, {
      kind: 'scope',
      title: `${input.taskId} 申请扩大范围`,
      detail: input.reason,
      data: { taskId: input.taskId, add: input.add },
      scope: { changeId: change.id, taskId: input.taskId, paths: input.add },
    })
    await this.appendLedger('scope.requested', { changeId: change.id, pendingId: item.id, taskId: input.taskId, add: input.add })
    await this.saveChange(change)
    this.pushNotice(`收到范围变更申请 ${item.id}，等负责人处理：/flow scope approve ${item.id} 或 /flow scope reject ${item.id} <理由>。`)
    return item
  }

  async reportRisk(input: { category: string; description: string; proposal: string }): Promise<PendingItem> {
    const change = this.requireChange()
    const item = this.createPending(change, {
      kind: 'risk',
      title: `agent 上报风险（${input.category}）`,
      detail: `${input.description}\n\n建议：${input.proposal}`,
      data: input,
    })
    await this.appendLedger('risk.raised', { changeId: change.id, pendingId: item.id, category: input.category })
    await this.saveChange(change)
    return item
  }

  async requestPlanChange(input: { add?: string[]; reorder?: string[]; reason: string }): Promise<PendingItem> {
    const change = this.requireChange()
    if (change.stage !== 'S4') throw new FlowGateError('只有 S4 可以申请计划修订', '当前阶段不需要计划修订')
    const item = this.createPending(change, {
      kind: 'plan',
      title: '计划修订申请',
      detail: input.reason,
      data: { add: input.add ?? [], reorder: input.reorder ?? [] },
    })
    await this.appendLedger('plan.amend_requested', { changeId: change.id, pendingId: item.id })
    await this.saveChange(change)
    return item
  }

  async proposeRule(input: { finding: string; rule: string; example: string; scope: string }): Promise<PendingItem> {
    const change = this.requireChange()
    const item = this.createPending(change, {
      kind: 'rule',
      title: '规则沉淀提议',
      detail: `${input.finding}\n\n规则：${input.rule}\n\n示例：${input.example}\n适用范围：${input.scope}`,
      data: input,
    })
    await this.appendLedger('rule.proposed', { changeId: change.id, pendingId: item.id })
    await this.saveChange(change)
    return item
  }

  async decidePending(id: string, decision: 'approved' | 'rejected', reason?: string): Promise<PendingItem> {
    const change = this.requireChange()
    const item = change.pending.find((entry) => entry.id === id)
    if (!item) throw new FlowGateError(`没有待处理项 ${id}`, '运行 /flow 查看待处理项列表')
    if (item.status !== 'open') throw new FlowGateError(`${id} 已经处理过（${item.status}）`, '不能重复处理')
    const now = isoNow(this.clock)
    item.status = decision
    item.decidedAt = now
    item.decisionReason = reason
    if (decision === 'approved') {
      if (item.kind === 'scope') {
        const taskId = String(item.data?.taskId ?? item.scope?.taskId ?? '')
        const add = (item.data?.add as string[] | undefined) ?? []
        if (taskId) {
          change.scopeAdditions = { ...(change.scopeAdditions ?? {}) }
          change.scopeAdditions[taskId] = [...(change.scopeAdditions[taskId] ?? []), ...add]
          for (const violation of change.violations) {
            if (!violation.clearedAt && violation.taskId === taskId && isUnderAny(violation.path, add)) {
              violation.clearedAt = now
            }
          }
        }
        await this.appendLedger('scope.approved', { changeId: change.id, pendingId: id, taskId, add })
      } else if (item.kind === 'risk') {
        // Approving a risk takeover unlocks exactly the action that triggered it, once.
        const ruleId = item.scope?.ruleId
        const fingerprint = item.scope?.actionFingerprint
        if (ruleId) {
          const all = this.state?.changes.flatMap((entry) => entry.overrides) ?? []
          const overrideId = store.nextPendingId(
            all.map((entry) => ({ id: entry.id, kind: 'override' } as PendingItem)),
            'override',
          )
          change.overrides.push({
            id: overrideId,
            ruleId,
            changeId: change.id,
            reason: reason ?? item.title,
            actionFingerprint: fingerprint ?? '',
            createdAt: now,
          })
          await this.appendLedger('override.granted', { changeId: change.id, overrideId, ruleId, pendingId: id })
        }
        await this.appendLedger('risk.approved', { changeId: change.id, pendingId: id })
      } else if (item.kind === 'rule') {
        await this.persistRule(item)
        await this.appendLedger('rule.adopted', { changeId: change.id, pendingId: id })
      } else if (item.kind === 'plan') {
        try {
          await this.applyPlanAmendment(change, item)
        } catch (error) {
          // 计划修订失败（片段不可解析/重排非法）时保持 open，避免"已批准但计划没变"
          // 的假状态在后续 saveChange 里被持久化。
          item.status = 'open'
          item.decidedAt = undefined
          item.decisionReason = undefined
          throw error
        }
      } else if (item.kind === 'conflict') {
        // 负责人确认"冲突/失败已修好"：重置该批次的检查点失败计数，下一次
        // flow_dispatch_next 会重试集成检查点（达到上限后的 owner 闸门由此解锁）。
        const batchId = String(item.data?.batchId ?? '')
        const batch = change.batches.find((entry) => entry.id === batchId)
        if (batch) {
          batch.status = 'checkpoint'
          if (batch.checkpoint) batch.checkpoint = { ...batch.checkpoint, attempts: 0 }
        }
        await this.appendLedger('checkpoint.retry_requested', {
          changeId: change.id,
          batchId,
          attempts: 0,
          ownerApproved: true,
        })
      } else if (item.kind === 'blocker') {
        // 负责人解锁「连续失败熔断」：清失败计数、任务恢复 running，并把同任务的
        // 其它 open blocker（含历史版本每个动作一条的 T-FAILURE-LIMIT 残留项）一起关闭。
        await this.approveBlocker(change, item, reason)
      }
      await this.appendLedger('gate.approved', { changeId: change.id, pendingId: id, kind: item.kind })
    } else {
      if (item.kind === 'scope') await this.appendLedger('scope.rejected', { changeId: change.id, pendingId: id, reason })
      else if (item.kind === 'risk') await this.appendLedger('risk.rejected', { changeId: change.id, pendingId: id, reason })
      else if (item.kind === 'conflict') {
        // 拒绝 = 放弃自动重试该批次的集成检查点：批次标记 failed，dispatchNext
        // 不再重试（避免 attempts 不归零导致无限重跑）。
        const batchId = String(item.data?.batchId ?? '')
        const batch = change.batches.find((entry) => entry.id === batchId)
        if (batch) batch.status = 'failed'
        await this.appendLedger('gate.rejected', { changeId: change.id, pendingId: id, kind: item.kind, reason })
      } else await this.appendLedger('gate.rejected', { changeId: change.id, pendingId: id, kind: item.kind, reason })
    }
    this.pushNotice(`待处理项 ${id} 已${decision === 'approved' ? '批准' : '拒绝'}${reason ? `：${reason}` : ''}。`)
    await this.saveChange(change)
    return item
  }

  /**
   * 批准 kind=blocker 的待处理项 = 负责人确认「熔断解除，任务继续」：
   * - 该任务 failureCount 归零、blocked/failed/interrupted → running（保留 startedAt）、清 blockReason；
   * - 同任务其它 open BL 与旧版 T-FAILURE-LIMIT 残留 BL 一并 approved（记录 decidedAt/reason）；
   * - 写 task.unblocked 账本事件，并让后续 flow_* 调用恢复（触发器不再命中）。
   */
  private async approveBlocker(change: ChangeStatus, item: PendingItem, reason?: string): Promise<void> {
    const now = isoNow(this.clock)
    let taskId = String(item.data?.taskId ?? item.scope?.taskId ?? '')
    if (taskId === '') taskId = this.resolveBlockedTaskId(change)
    const taskState = taskId !== '' ? change.tasks[taskId] : undefined
    if (taskState) {
      taskState.failureCount = 0
      if (taskState.status === 'blocked' || taskState.status === 'failed' || taskState.status === 'interrupted') {
        taskState.status = 'running'
        taskState.startedAt = taskState.startedAt ?? now
        taskState.finishedAt = undefined
        taskState.interruptedAt = undefined
      }
      taskState.blockReason = undefined
    }
    const closed: string[] = []
    for (const other of change.pending) {
      if (other.id === item.id || other.status !== 'open' || other.kind !== 'blocker') continue
      const otherTaskId = String(other.data?.taskId ?? other.scope?.taskId ?? '')
      const sameTask = taskId !== '' && otherTaskId === taskId
      // 旧版熔断项没有 taskId（BL-2…BL-8）：解锁当前任务时一并清理同变更的残留。
      const legacyBreaker = other.data?.ruleId === 'T-FAILURE-LIMIT' && (otherTaskId === '' || otherTaskId === taskId)
      if (!sameTask && !legacyBreaker) continue
      other.status = 'approved'
      other.decidedAt = now
      other.decisionReason = reason ? `${reason}（随 ${item.id} 一并解锁）` : `随 ${item.id} 一并解锁`
      closed.push(other.id)
    }
    await this.appendLedger('task.unblocked', {
      changeId: change.id,
      taskId: taskId === '' ? undefined : taskId,
      pendingId: item.id,
      reason,
      closedPendings: closed,
      failureCountReset: Boolean(taskState),
    })
    this.pushNotice(
      `已解锁阻断项 ${item.id}${taskId ? `（任务 ${taskId} 恢复执行，失败计数清零）` : ''}${
        closed.length > 0 ? `，一并关闭 ${closed.join('、')}` : ''
      }。只读动作不受限；可以继续 flow_* 调用。`,
    )
  }

  /** 旧版阻断项没有 data.taskId：从当前 blocked/failing 任务里反推唯一解锁目标。 */
  private resolveBlockedTaskId(change: ChangeStatus): string {
    const limit = this.config.triggers.consecutive_failure_limit
    const candidates = Object.values(change.tasks).filter(
      (task) =>
        task.status !== 'done' &&
        task.status !== 'skipped' &&
        (task.status === 'blocked' || (limit > 0 && (task.failureCount ?? 0) >= limit)),
    )
    return candidates.length === 1 ? candidates[0]!.id : ''
  }


  private async persistRule(item: PendingItem): Promise<void> {
    const layout = store.layout(this.root)
    const ruleId = String(item.data?.ruleId ?? `RL-${item.id}`)
    const path = posixJoin(layout.rulesDir, `${ruleId}.md`)
    const md = `# 项目规则 ${ruleId}\n\n## 问题\n\n${String(item.data?.finding ?? item.detail)}\n\n## 规则\n\n${String(item.data?.rule ?? '')}\n\n## 正确写法示例\n\n${String(item.data?.example ?? '')}\n\n## 适用范围\n\n${String(item.data?.scope ?? '')}\n`
    await this.fs.writeFile(path, md)
  }

  /**
   * Apply an owner-approved plan amendment (PC-n) for real.
   *
   * - `add`: each element is one task-card markdown fragment; parsed cards are
   *   registered as runtime tasks (`change.newTasks`) in one new sequential
   *   batch appended after the current plan (they cannot be started before it).
   * - `reorder`: a new order for not-yet-started tasks; tasks are reordered
   *   within their existing batches (batch membership never changes silently).
   *
   * The frozen `tasks.md` is not touched: `change.plan` is the runtime execution
   * plan and wins in `getPlan()`/`getTasks()`.
   */
  private async applyPlanAmendment(change: ChangeStatus, item: PendingItem): Promise<void> {
    // 迟到批准（S5/S6 才批）会留下永远无法派发的 pending 批次 → G6 死锁，
    // 因此只允许执行阶段应用；流程后期发现缺口应新建增量变更。
    if (change.stage !== 'S4') {
      throw new FlowGateError(
        '只有 S4 执行阶段可以应用计划修订',
        'S5/S6 才发现计划缺口时请新建增量变更；先把当前变更走完',
      )
    }
    const addRaw = (item.data?.add as unknown[] | undefined) ?? []
    const reorderRaw = (item.data?.reorder as unknown[] | undefined) ?? []
    const addFragments = addRaw.map((value) => String(value ?? '')).filter((value) => value.trim() !== '')
    const reorder = reorderRaw.map((value) => String(value ?? '').trim()).filter((value) => value !== '')
    if (addFragments.length === 0 && reorder.length === 0) {
      throw new FlowGateError('计划修订为空', 'PC 申请里 add 与 reorder 至少有一个；空的修订无法批准')
    }
    const plan = change.plan ?? this.getPlan()
    const nextPlan: ExecutionPlan = { batches: plan.batches.map((batch) => ({ ...batch, tasks: [...batch.tasks] })) }
    const existingIds = new Set(this.getTasks().map((task) => task.id))

    // 1) Parse and validate new task cards.
    const added: TaskCard[] = []
    for (const fragment of addFragments) {
      const card = parseTaskCardFragment(fragment)
      if (!card || card.id.trim() === '') {
        throw new FlowGateError(
          '无法解析新增任务卡片段',
          'add 的每个元素必须是一个任务卡 markdown 片段：标题含任务 id（如 `## T9 新增任务`）+ 常规 YAML 块',
        )
      }
      if (existingIds.has(card.id) || added.some((entry) => entry.id === card.id)) {
        throw new FlowGateError(`新增任务 ${card.id} 与既有任务 id 重复`, '新增任务需要使用未被占用的任务 id（如 FIX-2、T9）')
      }
      added.push(card)
    }

    // 2) Validate + apply reorder on not-yet-started tasks (within each batch).
    for (const id of reorder) {
      if (!existingIds.has(id) && !added.some((entry) => entry.id === id)) {
        throw new FlowGateError(`重排列表包含未知任务 ${id}`, 'reorder 只能引用当前执行计划或本次新增的任务 id')
      }
      const state = change.tasks[id]
      if (state && state.status !== 'pending' && state.status !== 'queued') {
        throw new FlowGateError(`任务 ${id} 已开始或已完成，不能调整顺序`, '只能调整尚未开始的任务顺序；已开始的任务请按原计划完成')
      }
    }

    // 3) Append added tasks as one new sequential batch at the end of the plan.
    if (added.length > 0) {
      const batchId = this.nextPlanBatchId(nextPlan)
      const taskIds = added.map((card) => card.id)
      nextPlan.batches.push({ batch: batchId, mode: 'sequential', tasks: taskIds, why: '负责人批准的计划修订新增任务' })
      change.newTasks = [...(change.newTasks ?? []), ...added]
      change.batches.push({ id: batchId, mode: 'sequential', status: 'pending', tasks: [...taskIds] })
      for (const card of added) {
        change.tasks[card.id] = {
          id: card.id,
          batch: batchId,
          status: 'pending',
          tdd: 'none',
          evidenceIds: [],
          reviewIds: [],
        }
      }
    }

    // 4) Reorder is applied after add so a PC can add and position new tasks in
    //    the same amendment (positions refer to the post-add task set).
    if (reorder.length > 0) {
      const position = new Map(reorder.map((id, index) => [id, index] as const))
      for (const batch of nextPlan.batches) {
        batch.tasks = [...batch.tasks].sort((a, b) => {
          const left = position.get(a) ?? Number.MAX_SAFE_INTEGER
          const right = position.get(b) ?? Number.MAX_SAFE_INTEGER
          return left - right
        })
        const state = change.batches.find((entry) => entry.id === batch.batch)
        if (state) state.tasks = [...batch.tasks]
      }
    }

    change.plan = nextPlan
    await this.appendLedger('plan.amended', {
      changeId: change.id,
      pendingId: item.id,
      added: added.map((card) => card.id),
      reorder,
    })
  }

  /** Next auto-generated batch id (`B<n>`), unique against plan + runtime state. */
  private nextPlanBatchId(plan: ExecutionPlan): string {
    let max = 0
    const scan = (id: string): void => {
      const match = /^B(\d+)$/i.exec(id)
      if (match) max = Math.max(max, Number(match[1]))
    }
    for (const batch of plan.batches) scan(batch.batch)
    for (const batch of this.current?.batches ?? []) scan(batch.id)
    return `B${max + 1}`
  }

  async allowOnce(ruleIdOrLast: string, reason: string): Promise<OverrideRecord> {
    const change = this.requireChange()
    if (!reason.trim()) throw new FlowGateError('单次放行必须写理由', '用法：/flow allow-once <规则id 或 last> <理由>')
    const ruleId = ruleIdOrLast === 'last' ? (this.lastRuleId ?? '') : ruleIdOrLast
    if (!ruleId) throw new FlowGateError('没有可放行的规则', '还没有拦截记录；用 /flow allow-once <规则id> <理由>')
    const rules = loadRules(this.config)
    if (!rules.some((rule) => rule.id === ruleId)) {
      throw new FlowGateError(`没有规则 ${ruleId}`, `可用规则：${rules.map((rule) => rule.id).join('、')}`)
    }
    const all = this.state?.changes.flatMap((entry) => entry.overrides) ?? []
    const id = store.nextPendingId(
      all.map((entry) => ({ id: entry.id, kind: 'override' } as PendingItem)),
      'override',
    )
    const override: OverrideRecord = {
      id,
      ruleId,
      changeId: change.id,
      reason,
      actionFingerprint: '',
      createdAt: isoNow(this.clock),
    }
    change.overrides.push(override)
    await this.appendLedger('override.granted', { changeId: change.id, overrideId: id, ruleId, reason })
    await this.saveChange(change)
    return override
  }

  async addException(ruleId: string, pathPattern: string | undefined, reason: string): Promise<ExceptionRecord> {
    const change = this.requireChange()
    if (!reason.trim()) throw new FlowGateError('加入例外必须写理由', '用法：/flow exception add <规则id> [路径] <理由>')
    const all = this.state?.changes.flatMap((entry) => entry.exceptions) ?? []
    const id = store.nextPendingId(
      all.map((entry) => ({ id: entry.id, kind: 'exception' } as PendingItem)),
      'exception',
    )
    const exception: ExceptionRecord = {
      id,
      ruleId,
      changeId: change.id,
      pathPattern,
      reason,
      createdAt: isoNow(this.clock),
    }
    change.exceptions.push(exception)
    await this.appendLedger('exception.added', { changeId: change.id, exceptionId: id, ruleId, pathPattern })
    await this.saveChange(change)
    return exception
  }

  async revokeException(id: string, reason?: string): Promise<void> {
    const change = this.requireChange()
    const exception = change.exceptions.find((item) => item.id === id)
    if (!exception) throw new FlowGateError(`没有例外 ${id}`, '运行 /flow 查看例外列表')
    exception.revokedAt = isoNow(this.clock)
    exception.revokedReason = reason
    await this.appendLedger('exception.revoked', { changeId: change.id, exceptionId: id, reason })
    await this.saveChange(change)
  }

  async changeComplexity(level: string, reason?: string): Promise<GateResult> {
    const change = this.requireChange()
    const parsed = parseComplexity(level)
    if (!parsed) throw new FlowGateError(`无效复杂度：${level}`, '可选：低、中、高、超高（low / medium / high / ultra）')
    const order: Complexity[] = ['low', 'medium', 'high', 'ultra']
    const lowering = order.indexOf(parsed) < order.indexOf(change.complexity)
    if (lowering && !reason?.trim()) throw new FlowGateError('降低复杂度必须写理由', '用法：/flow complexity 低 <理由>')
    change.complexity = parsed
    await this.appendLedger('level.changed', { changeId: change.id, dimension: 'complexity', level: parsed, reason })
    if (lowering) this.pushNotice(`复杂度已降低到 ${complexityLabel(parsed)}（已记录理由）。`)
    await this.saveChange(change)
    return { gate: 'G3', passed: true, items: [], failures: [], stage: change.stage, message: `复杂度已调整为 ${complexityLabel(parsed)}。` }
  }

  async changeRiskLevel(level: string, reason?: string): Promise<GateResult> {
    const change = this.requireChange()
    const parsed = parseRiskLevel(level)
    if (!parsed) throw new FlowGateError(`无效风险等级：${level}`, '可选：普通、高（normal / high）')
    const lowering = parsed === 'normal' && change.risk === 'high'
    if (lowering && !reason?.trim()) throw new FlowGateError('降低风险等级必须写理由', '用法：/flow risk-level 普通 <理由>')
    const raising = parsed === 'high' && change.risk === 'normal'
    change.risk = parsed
    if (raising && (change.stage === 'S5' || change.stage === 'S6')) {
      Object.assign(change, enterStage(change, 'S4', isoNow(this.clock)))
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S4', reason: 'risk-raised' })
      this.pushNotice('风险提高为高风险：已退回 S4，已完成任务的审查按新标准重新要求（回执保留）。')
    }
    await this.appendLedger('level.changed', { changeId: change.id, dimension: 'risk', level: parsed, reason })
    await this.saveChange(change)
    return { gate: 'G3', passed: true, items: [], failures: [], stage: change.stage, message: `风险等级已调整为 ${riskLabel(parsed)}。` }
  }

  async setOff(off: boolean, reason?: string): Promise<void> {
    const change = this.requireChange()
    change.off = off
    await this.appendLedger(off ? 'flow.off' : 'flow.on', { changeId: change.id, reason })
    await this.saveChange(change)
  }

  // ------------------------------------------------------------------
  // Analysis tasks
  // ------------------------------------------------------------------

  async submitAnalysis(input: { conclusion: string; proposal: string; limitations: string[]; citations: { file: string; startLine: number; endLine: number; quote?: string }[] }): Promise<AnalysisOutcome> {
    const change = this.requireChange()
    if (change.kind !== 'analysis') throw new FlowGateError('当前变更不是分析任务', '用 flow_new_change({ kind: "analysis" }) 立分析任务')
    if (!input.citations || input.citations.length === 0) {
      throw new FlowGateError('分析结论必须带源码引用', '引用格式：{file, startLine, endLine}，插件会核验原文')
    }
    const checks = await verifyCitations(this.fs, this.root, input.citations, isoNow(this.clock))
    const failed = checks.filter((check) => !check.ok)
    if (failed.length > 0) {
      return {
        ok: false,
        archived: false,
        citationChecks: checks,
        message: `引用核验失败：${failed.map((check) => `${check.citation.file}:${check.citation.startLine}-${check.citation.endLine}（${check.error}）`).join('；')}`,
      }
    }
    const paths = store.changePaths(this.root, change.id)
    const md = `# 分析结论：${change.title}\n\n## 结论\n\n${input.conclusion}\n\n## 建议\n\n${input.proposal}\n\n## 未确认项与局限\n\n${input.limitations.map((item) => `- ${item}`).join('\n') || '- 无'}\n\n## 源码引用\n\n${matchesToMarkdown(checks)}\n`
    await this.fs.writeFile(paths.analysis, md)
    const now = isoNow(this.clock)
    await this.expireOpenPending(change, now)
    change.lifecycle = 'archived'
    change.stage = 'archived'
    await this.appendLedger('analysis.submitted', {
      changeId: change.id,
      citations: input.citations.length,
      citationChecks: checks.map((check) => ({ file: check.citation.file, ok: check.ok })),
    })
    // Archive the analysis change directory.
    const archiveDir = posixJoin(store.layout(this.root).archiveDir, `${dateOnly(now)}-${change.id}`)
    await this.fs.mkdir(archiveDir)
    await this.fs.writeFile(posixJoin(archiveDir, 'analysis.md'), md)
    await this.saveChange(change)
    return { ok: true, archived: true, citationChecks: checks, message: `分析任务 ${change.id} 已归档：结论与引用已保存到 ${archiveDir}/analysis.md。` }
  }

  // ------------------------------------------------------------------
  // Session management
  // ------------------------------------------------------------------

  private async acquireLease(change: ChangeStatus): Promise<void> {
    if (!this.state || !this.sessionId) return
    // 损坏状态下不改写租约/附着：避免把仍应出现在 doctor 与 repair 报告里的
    // sessions.json 顺手覆盖掉（修复路径统一走 /flow repair）。
    if (this.stateCorruption.length > 0) return
    const now = isoNow(this.clock)
    this.state.leases = this.state.leases.filter((lease) => lease.changeId !== change.id || lease.sessionId === this.sessionId)
    this.state.leases = this.state.leases.filter((lease) => lease.sessionId !== this.sessionId)
    this.state.leases.push({
      sessionId: this.sessionId,
      changeId: change.id,
      attachedAt: now,
      heartbeatAt: now,
      label: this.sessionLabel,
    })
    change.session = { attached: this.sessionLabel ?? this.sessionId, heartbeat: now }
    this.current = change
    await this.saveLeases()
    await this.appendLedger('session.attached', { changeId: change.id, sessionId: this.sessionId, label: this.sessionLabel })
    await this.saveChange(change)
  }

  async attachSession(label?: string): Promise<RuntimeSnapshot> {
    if (this.stateCorruption.length > 0) {
      throw new FlowGateError(
        '状态文件损坏，不能接续变更',
        '运行 /flow doctor 诊断，/flow repair 从账本重建后再接续',
      )
    }
    // 与 autoAttach 一致：PROJECT（路线图阶段）也允许显式接续。
    const active = (this.state?.changes ?? []).filter((change) => change.lifecycle === 'active')
    if (active.length === 0) throw new FlowGateError('没有进行中的变更', '用 /flow new <描述> 立项')
    if (active.length > 1) throw new FlowGateError('有多个进行中的变更', `用 /flow resume <变更编号> 选择：${active.map((change) => change.id).join('、')}`)
    const change = active[0]!
    const lease = this.state?.leases.find((item) => item.changeId === change.id)
    if (lease && lease.sessionId !== this.sessionId && !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())) {
      throw new FlowGateError(`${change.id} 正在另一个会话中进行`, `如确认旧会话已停止，用 /flow resume ${change.id} --takeover 接管`)
    }
    await this.acquireLease(change)
    await this.reloadArtifacts()
    this.pushNotice(`已接续 ${change.id}（${change.title}，${change.stage}）。${change.handoff?.text ? `交接摘要：${change.handoff.text}` : ''}`)
    return this.snapshot()
  }

  async resumeChange(changeId: string, options: { takeover?: boolean } = {}): Promise<RuntimeSnapshot> {
    if (this.stateCorruption.length > 0) {
      throw new FlowGateError(
        '状态文件损坏，不能恢复变更',
        '运行 /flow doctor 诊断，/flow repair 从账本重建后再恢复',
      )
    }
    const change = this.state?.changes.find((item) => item.id === changeId)
    if (!change) throw new FlowGateError(`没有变更 ${changeId}`, '运行 /flow 查看台账')
    if (change.lifecycle === 'archived') throw new FlowGateError(`${changeId} 已归档`, '已交付的变更不能继续；要修改请新建关联变更')
    const lease = this.state?.leases.find((item) => item.changeId === changeId)
    const now = isoNow(this.clock)
    if (lease && lease.sessionId !== this.sessionId && !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())) {
      if (!options.takeover) {
        throw new FlowGateError(
          `${changeId} 正在另一个会话中进行（心跳 ${lease.heartbeatAt}）`,
          `确认旧会话已停止后用 /flow resume ${changeId} --takeover 接管`,
        )
      }
      await this.appendLedger('session.takeover', { changeId, from: lease.sessionId, to: this.sessionId })
      this.pushNotice(`已接管 ${changeId}；旧会话之后的写操作会被拒绝。`)
    }
    await this.acquireLease(change)
    change.lifecycle = 'active'
    await this.reloadArtifacts()
    return this.snapshot()
  }

  async pauseChange(): Promise<HandoffSummary> {
    const change = this.requireChange()
    const handoff = await this.generateHandoff()
    change.lifecycle = 'paused'
    if (this.state) this.state.leases = this.state.leases.filter((lease) => lease.sessionId !== this.sessionId)
    await this.appendLedger('change.paused', { changeId: change.id })
    await this.saveLeases()
    await this.saveChange(change)
    this.current = null
    return handoff
  }

  async releaseSession(): Promise<void> {
    if (!this.state || !this.sessionId) return
    const lease = this.state.leases.find((item) => item.sessionId === this.sessionId)
    if (!lease) return
    const change = this.state.changes.find((item) => item.id === lease.changeId)
    if (change && change.lifecycle === 'active') {
      for (const task of Object.values(change.tasks)) {
        if (task.status === 'running' || task.status === 'review') {
          task.status = 'interrupted'
          task.interruptedAt = isoNow(this.clock)
          await this.appendLedger('task.interrupted', { changeId: change.id, taskId: task.id })
        }
      }
      await this.saveChange(change)
    }
    this.state.leases = this.state.leases.filter((item) => item.sessionId !== this.sessionId)
    await this.saveLeases()
    await this.appendLedger('session.released', { changeId: lease.changeId, sessionId: this.sessionId })
  }

  async heartbeat(): Promise<void> {
    await this.touchLease()
  }

  /** Record a turn-continuation steer (T3.3 / M-4) for metrics and audit. */
  async recordTurnContinued(input: { turn?: number; count?: number; taskId?: string; reason?: string } = {}): Promise<void> {
    const change = this.current
    await this.appendLedger('turn.continued', {
      changeId: change?.id,
      taskId: input.taskId ?? this.activeTask()?.id,
      turn: input.turn,
      count: input.count,
      reason: input.reason,
    })
  }

  // ------------------------------------------------------------------
  // Handoff, doctor, repair, metrics, report, board
  // ------------------------------------------------------------------

  /**
   * Archive a delivered change: generate the HTML report, move the change
   * directory to `.flowgate/archive/<date>-<id>/` and mark it archived.
   * Incremental specs are folded into `.flowgate/specs/<capability>/spec.md`
   * with an OpenSpec-style ADDED / MODIFIED / REMOVED merge (T4.4); the result
   * and warnings are recorded in the ledger as `spec.merged`.
   */
  /**
   * P1-5：变更归档时把仍未处理的待处理项置为 `expired`（03 §8.3：任务结束仍未处理）。
   * 返回被过期的数量；每次都写 `pending.expired` 账本，供指标/复盘查询。
   */
  private async expireOpenPending(change: ChangeStatus, at: string): Promise<number> {
    let expired = 0
    for (const item of change.pending) {
      if (item.status !== 'open') continue
      item.status = 'expired'
      item.decidedAt = at
      item.decisionReason = '归档时仍未处理（任务结束自动过期）'
      expired += 1
      await this.appendLedger('pending.expired', { changeId: change.id, pendingId: item.id, kind: item.kind })
    }
    if (expired > 0) this.pushNotice(`${change.id} 归档：${expired} 个未处理待处理项已标记 expired（进入复盘）。`)
    return expired
  }

  private async archiveChange(change: ChangeStatus): Promise<void> {
    const now = isoNow(this.clock)
    const layout = store.layout(this.root)
    const paths = store.changePaths(this.root, change.id)
    try {
      await this.generateReport()
    } catch (error) {
      this.pushNotice(`生成交付报告失败：${(error as Error).message}`)
    }
    const archiveDir = posixJoin(layout.archiveDir, `${dateOnly(now)}-${change.id}`)
    await this.fs.mkdir(archiveDir)
    await this.copyDirRecursive(paths.dir, archiveDir)
    // Fold the incremental spec into the project's main capability spec
    // (ADDED/MODIFIED/REMOVED, OpenSpec-compatible layout, T4.4).
    if (await this.fs.exists(paths.spec)) {
      const incremental = await this.fs.readFile(paths.spec)
      const capability = capabilityDirName(this.capabilityOf(change), change.id)
      const capabilityDir = posixJoin(layout.specsDir, capability)
      const mainSpecPath = posixJoin(capabilityDir, 'spec.md')
      const existing = (await this.fs.exists(mainSpecPath)) ? await this.fs.readFile(mainSpecPath) : null
      const merged = mergeIncrementalSpec(existing, incremental, { capability })
      await this.fs.mkdir(capabilityDir)
      await this.fs.writeFile(mainSpecPath, merged.markdown)
      await this.appendLedger('spec.merged', {
        changeId: change.id,
        capability,
        added: merged.added,
        modified: merged.modified,
        removed: merged.removed,
        warnings: merged.warnings,
      })
      if (merged.warnings.length > 0) {
        this.pushNotice(`主规格合并提示：${merged.warnings.join('；')}`)
      }
    }
    // 归档即任务结束：未处理的待处理项生命周期收口（expired），避免"归档后仍 open"。
    await this.expireOpenPending(change, now)
    change.lifecycle = 'archived'
    change.stage = 'archived'
    await this.fs.writeFile(posixJoin(archiveDir, 'status.json'), `${JSON.stringify(change, null, 2)}\n`)
    await this.fs.remove(paths.dir)
    await this.appendLedger('report.generated', { changeId: change.id, path: posixJoin(archiveDir, 'report.html') })
    this.pushNotice(`${change.id} 已交付归档到 ${archiveDir}。建议开新会话继续下一个变更。`)
  }

  /** Capability name for the main spec: roadmap capability when known, else the title. */
  private capabilityOf(change: ChangeStatus): string {
    if (change.roadmap) {
      const entry = this.roadmapDoc?.entries.find((item) => item.change === change.roadmap)
      if (entry?.capability?.trim()) return entry.capability
    }
    return change.title?.trim() || change.id
  }

  /**
   * 已归档变更/分析任务的编号（从 `.flowgate/archive/<日期>-<编号>/` 目录名解析）。
   * 归档会移除 `.flowgate/changes/<id>/`，所以状态列表里已看不到它们；编号分配
   * 需要这些历史 id 来避免复用。
   */
  private async archivedChangeIds(): Promise<{ id: string }[]> {
    const archiveDir = store.layout(this.root).archiveDir
    if (!(await this.fs.exists(archiveDir))) return []
    let entries: string[] = []
    try {
      entries = await this.fs.readdir(archiveDir)
    } catch {
      return []
    }
    const ids: { id: string }[] = []
    for (const entry of entries) {
      const match = /-([AC]-\d+)$/.exec(entry)
      if (match?.[1]) ids.push({ id: match[1] })
    }
    return ids
  }

  private async copyDirRecursive(from: string, to: string): Promise<void> {
    await this.fs.mkdir(to)
    let entries: string[]
    try {
      entries = await this.fs.readdir(from)
    } catch {
      return
    }
    for (const entry of entries) {
      const source = posixJoin(from, entry)
      const target = posixJoin(to, entry)
      try {
        const content = await this.fs.readFile(source)
        await this.fs.writeFile(target, content)
      } catch {
        await this.copyDirRecursive(source, target)
      }
    }
  }

  async generateHandoff(): Promise<HandoffSummary> {
    const change = this.requireChange()
    const active = this.activeTask()
    const decisions: string[] = []
    const openItems = change.pending.filter((item) => item.status === 'open').map((item) => `${item.id} ${item.title}`)
    if (change.frozen) decisions.push('已过门产物已冻结')
    if (change.baseline) decisions.push('S2 基线已记录')
    const next = active
      ? `继续 ${active.id}（${active.status}/${active.tdd}）`
      : this.nextTaskToStart(this.getTasks())?.taskId
        ? `按执行图开始 ${this.nextTaskToStart(this.getTasks())!.taskId}`
        : change.stage === 'S4'
          ? '全部任务完成后提交 G4'
          : `完成当前阶段产物并 flow_submit`
    const text = `${change.id} ${change.title}｜阶段 ${change.stage}（${complexityLabel(change.complexity)} · ${riskLabel(change.risk)}）｜${active ? `任务 ${active.id} ${active.tdd.toUpperCase()}` : '无活动任务'}｜${decisions.join('；') || '无已定决定'}｜待处理 ${openItems.length}｜下一步：${next}`
    const summary: HandoffSummary = {
      at: isoNow(this.clock),
      stage: change.stage,
      taskId: active?.id,
      decisions,
      openItems,
      next,
      text: text.length > 300 ? `${text.slice(0, 297)}…` : text,
    }
    change.handoff = summary
    const paths = store.changePaths(this.root, change.id)
    await this.fs.writeFile(paths.handoff, `# 交接摘要 ${change.id}\n\n${summary.text}\n\n## 下一步\n\n${summary.next}\n`)
    await this.appendLedger('change.updated', { changeId: change.id, handoff: summary.text })
    return summary
  }

  async doctor(): Promise<DoctorReport> {
    let ledgerOk = true
    const failures: { line: number; reason: string }[] = []
    if (this.ledger) {
      const verification = await this.ledger.verify()
      ledgerOk = verification.ok
      failures.push(...verification.failures)
    }
    let configOk = true
    let configError: string | undefined
    try {
      await store.loadConfig(this.fs, this.root)
    } catch (error) {
      configOk = false
      configError = (error as Error).message
    }
    const activeTasks = this.current ? Object.values(this.current.tasks).filter((task) => task.status === 'running' || task.status === 'review').map((task) => task.id) : []
    const report: DoctorReport = {
      initialized: this.isInitialized(),
      pluginVersion: this.pluginVersion,
      ledgerOk,
      ledgerFailures: failures,
      configOk,
      configError,
      stage: this.current?.stage,
      activeTasks,
      openPending: this.current?.pending.filter((item) => item.status === 'open').length ?? 0,
      guardHeartbeat: { ...this.guardHeartbeat },
      coverage: this.coverageReport ?? undefined,
      hostCapabilities: {},
      message: !this.isInitialized()
        ? 'FlowGate 未启用：项目没有 .flowgate/config.yaml。运行 /flow init 启用。'
        : this.state?.locked
          ? `锁定模式：${this.state.locked.reason}`
          : 'FlowGate 运行正常。',
    }
    return report
  }

  async repair(): Promise<{ ok: boolean; message: string }> {
    if (!this.isInitialized()) throw new FlowGateError('FlowGate 未初始化', '先运行 /flow init')
    const verification = this.ledger ? await this.ledger.verify() : { ok: false, lines: 0, failures: [{ line: 0, reason: 'ledger missing' }] }
    if (!verification.ok) {
      return {
        ok: false,
        message: `账本校验失败，无法自动修复：${verification.failures
          .slice(0, 5)
          .map((failure) => `第 ${failure.line} 行 ${failure.reason}`)
          .join('；')}`,
      }
    }
    // 会话租约是易失状态：损坏文件无法从账本"还原"哪条租约还有效，直接重建为空，
    // 由下一个会话在 load 时自动附着/接管。它不能阻塞 repair（否则 sessions.json
    // 一坏就永久锁定）。
    let leaseNote = ''
    let leaseBackup: string | null = null
    try {
      await store.readLeases(this.fs, this.root)
    } catch {
      // 保留损坏原文：只有 repair 整体成功才允许留下"空租约"重建结果。
      leaseBackup = await this.fs.readFile(store.layout(this.root).sessions).catch(() => null)
      await store.writeLeases(this.fs, this.root, [])
      leaseNote = '（会话租约文件已重建为空）'
    }
    // Rebuild status.json / changes index from the ledger snapshots + artifacts.
    const rebuilt = await store.rebuildState(this.fs, this.root)
    await this.load()
    // 03 §14 / 需求 v1.0：repair 必须能解锁，但不能把修不好的损坏静默吞掉——
    // 仍有 status.json 无法从账本/产物重建时保持锁定并明确报告，避免二次 fail-open。
    if (this.stateCorruption.length > 0) {
      if (leaseBackup !== null) {
        // 整体修复失败：恢复原损坏的租约文件，避免"repair 失败但现场已被改掉"。
        await this.fs.writeFile(store.layout(this.root).sessions, leaseBackup)
        leaseNote = '（会话租约已恢复原损坏文件，等待整体修复）'
      }
      return {
        ok: false,
        message: `账本校验通过，但仍有 ${this.stateCorruption.length} 个状态文件无法从账本重建：${this.stateCorruption
          .map((file) => `${file.path}（${file.reason}）`)
          .join('；')}。已保持锁定模式，请备份 .flowgate/ 后按 /flow doctor 提示处理。${leaseNote}`,
      }
    }
    if (this.state?.locked) {
      this.state.locked = undefined
      for (const change of this.state.changes) {
        if (change.lock) change.lock = undefined
        if (change.lifecycle !== 'archived') await store.writeChangeStatus(this.fs, this.root, change)
      }
      await store.writeChangesIndex(this.fs, this.root, this.state.changes)
    }
    await this.appendLedger('lock.released', {})
    await this.reloadArtifacts()
    return {
      ok: true,
      message: `已从账本与产物重建 ${rebuilt.rebuilt.length} 个变更（保留 ${rebuilt.kept.length} 个）${leaseNote}，锁定模式解除。`,
    }
  }

  async generateMetrics(): Promise<MetricSet> {
    const change = this.requireChange()
    const ledgerEvents = this.ledger ? await this.ledger.readAll() : []
    const set = computeMetrics({
      change,
      ledger: ledgerEvents.filter((event) => event.data?.changeId === change.id || event.data?.change === change.id),
      artifacts: this.artifacts,
      evidence: this.receipts.filter((receipt) => receipt.changeId === change.id),
      now: isoNow(this.clock),
    })
    const path = posixJoin(store.layout(this.root).metricsDir, `${change.id}.json`)
    await this.fs.writeFile(path, `${JSON.stringify(set, null, 2)}\n`)
    await this.appendLedger('metrics.snapshot', { changeId: change.id, metrics: set.metrics })
    return set
  }

  async generateReport(): Promise<{ path: string; html: string }> {
    const change = this.requireChange()
    const ledgerEvents = this.ledger ? await this.ledger.readAll() : []
    const metrics = await this.generateMetrics()
    const html = renderChangeReport({
      change,
      artifacts: this.artifacts,
      evidence: this.receipts.filter((receipt) => receipt.changeId === change.id),
      ledger: ledgerEvents,
      reviews: change.reviews,
      metrics,
      generatedAt: isoNow(this.clock),
    })
    const path = store.changePaths(this.root, change.id).report
    await this.fs.writeFile(path, html)
    await this.appendLedger('report.generated', { changeId: change.id, path })
    return { path, html }
  }

  async generateBoard(): Promise<{ path: string; html: string }> {
    const changes = this.state?.changes ?? []
    const html = renderDashboard({
      changes,
      snapshot: this.snapshot(),
      pending: changes.flatMap((change) => change.pending.filter((item) => item.status === 'open')),
      generatedAt: isoNow(this.clock),
    })
    const path = store.layout(this.root).dashboard
    await this.fs.writeFile(path, html)
    return { path, html }
  }

  // ------------------------------------------------------------------
  // Injection / snapshot
  // ------------------------------------------------------------------

  buildInjection(): InjectionBundle {
    if (!this.isInitialized()) return { text: '', approxTokens: 0 }
    const change = this.current
    if (!change) {
      // 锁定模式可能由「损坏的 status.json 被跳过」导致（此时没有 current）：注入文本
      // 仍要给出锁定原因与修复入口，避免 agent 在 fail-open 错觉下继续写源码。
      if (this.state?.locked) {
        const text = `[FlowGate] 锁定模式：${this.state.locked.reason}。写操作被拒绝，运行 /flow doctor 诊断、/flow repair 恢复。`
        return { text, approxTokens: approx(text) }
      }
      if (this.roadmapApprovedByOwner() && this.roadmapChangesCreated() === 0) {
        const first = this.roadmapDoc?.entries[0]?.change ?? 'C0'
        const text = `[FlowGate] 路线图已批准，但还没有立项变更。下一步：用 flow_new_change({ fromRoadmap: "${first}" }) 立项第一个变更（工程骨架 ${first}）；不要用无 fromRoadmap 的立项绕过路线图。`
        return { text, approxTokens: approx(text) }
      }
      const text = `[FlowGate] 项目已启用 FlowGate 但当前没有进行中的变更。下一步：用 flow_new_change 立项，或 /flow new <描述>。`
      return { text, approxTokens: approx(text) }
    }
    if (change.off) {
      const text = `[FlowGate] 本会话门禁已被负责人临时关闭（/flow off），操作不再拦截；账本已记录。`
      return { text, approxTokens: approx(text) }
    }
    const lines: string[] = []
    lines.push(`[FlowGate] 变更 ${change.id}「${change.title}」｜阶段 ${change.stage} ${STAGE_LABELS[change.stage] ?? ''}｜${complexityLabel(change.complexity)} · ${riskLabel(change.risk)}`)
    if (this.state?.locked) {
      lines.push(`锁定模式：${this.state.locked.reason}。写操作被拒绝，运行 /flow doctor 诊断、/flow repair 恢复。`)
      return { text: lines.join('\n'), approxTokens: approx(lines.join('\n')) }
    }
    const level = this.level()
    if (change.stage === 'roadmap') {
      lines.push('当前是项目级澄清与路线图：写 .flowgate/project-clarify.md 与 .flowgate/roadmap.md，第一个变更必须是工程骨架 C0；完成后 flow_submit({ gate: "GR" })。')
    } else if (change.stage === 'S0' || change.stage === 'S1') {
      lines.push('S1 需求澄清：先读相关代码与规格（事实带 `文件:起止行` 引用），再用 ask_user_question 澄清（每轮 ≤4 题），写 clarify.md / proposal.md / 增量规格，然后 flow_submit({ gate: "G1" })。六要素未闭合、未决问题不为 0、模糊词未量化都会被拦。')
    } else if (change.stage === 'S2') {
      lines.push('S2 上下文：写 context.md（接口约束、数据模型、非功能要求），确保 project.md 命令可执行；然后 flow_submit({ gate: "G2" })，插件会跑一次基线测试。')
    } else if (change.stage === 'S3') {
      lines.push('S3 设计拆解：写 design.md（' + (level.requiresDesignOptions ? '2–3 个方案对比、推荐与理由、数据流、错误处理、回滚' : '方案与理由') + '）、risk.md（五类）、tasks.md（任务卡 + 末尾执行计划批次），然后 flow_submit({ gate: "G3" })。')
    } else if (change.stage === 'S4') {
      const active = this.activeTask()
      if (active) {
        const task = this.getTask(active.id)
        lines.push(`S4 执行：当前任务 ${active.id}「${task?.title ?? ''}」TDD=${active.tdd}${level.tddRequiredAll || task?.tdd === 'required' ? '（必需：先 RED 后 GREEN）' : ''}。只改任务范围 ${task?.scope.join('、') ?? ''}；用 flow_verify 由插件跑验证；完成后 flow_task_done("${active.id}")。`)
      } else {
        const next = this.nextTaskToStart(this.getTasks())
        lines.push(`S4 执行：${this.config.dispatch === 'inline' ? '用 flow_task_start 领取' : '用 flow_dispatch_next 派发'}${next ? `下一个任务 ${next.taskId}（批次 ${next.batchId} · ${next.mode}）` : '（当前没有可领取任务）'}。不能跳过执行图。`)
      }
    } else if (change.stage === 'S5') {
      lines.push('S5 验证：运行全量测试并与基线对比、lint/build、运行证据；然后 flow_submit({ gate: "G5" })。')
    } else if (change.stage === 'S6') {
      lines.push('S6 交付：更新 CHANGELOG/文档，生成交付报告，准备 G6 清单；然后 flow_submit({ gate: "G6" })。')
    }
    const pending = change.pending.filter((item) => item.status === 'open')
    if (pending.length > 0) lines.push(`待负责人处理：${pending.map((item) => `${item.id} ${item.title}`).join('；')}`)
    const breaker = pending.find((item) => item.kind === 'blocker')
    if (breaker) {
      lines.push(
        `熔断阻断 ${breaker.id}：只读动作（read/grep、只读 shell）、flow_status/flow_diff/flow_report_risk 不受限，可先取证；负责人确认后运行 /flow unblock ${breaker.id}（也可 /flow unblock <任务id>）解锁。`,
      )
    }
    const awaiting = (Object.entries(change.gates) as [GateId, GateRecord][]).find(([, record]) => record.state === 'awaiting')
    if (awaiting) lines.push(`当前等待负责人批准 ${awaiting[0]}：结束本轮，告诉负责人运行 /flow approve ${awaiting[0]}。`)
    const violations = change.violations.filter((violation) => !violation.clearedAt)
    if (violations.length > 0) lines.push(`未撤销的越界改动：${violations.map((violation) => violation.path).join('、')}；撤销（git checkout -- 文件）或申请范围变更后才能继续写入。`)
    const notices = this.notices.slice(-3)
    if (notices.length > 0) lines.push(...notices)
    if (this.config.learning === 'detail') lines.push('学习模式：每进入一个新阶段，先用 1–2 句话说明这一步在做什么、为什么。')
    const text = lines.join('\n')
    return { text, approxTokens: approx(text) }
  }

  snapshot(): RuntimeSnapshot {
    const change = this.current
    const initialized = this.isInitialized()
    const pipeline = this.pipelineProgress(change)
    const level = change ? levelProfile(change.complexity, change.risk, this.config.limits) : null
    const awaitingGate = change ? findAwaitingHumanGate(change) : undefined
    const activeTask = this.activeTask()
    const pending = change?.pending.filter((item) => item.status === 'open') ?? []
    const violations = change?.violations.filter((item) => !item.clearedAt) ?? []
    const snapshot: RuntimeSnapshot = {
      initialized,
      changeId: change?.id,
      title: change?.title,
      kind: change?.kind,
      complexity: change?.complexity,
      risk: change?.risk,
      stage: change?.stage,
      lifecycle: change?.lifecycle,
      awaitingGate,
      pendingGate: change ? gateForStage(change.stage) ?? undefined : undefined,
      pipeline,
      tasks: change?.tasks ?? {},
      batches: change?.batches ?? [],
      activeTaskId: activeTask?.id,
      pending,
      violations,
      off: change?.off ?? false,
      locked: Boolean(this.state?.locked),
      interceptCounts: { ...this.interceptCounts },
      coverage: this.coverageReport ?? undefined,
      nextStep: this.nextStepText(change, level),
      statusLine: '',
      updatedAt: isoNow(this.clock),
    }
    snapshot.statusLine = buildStatusLine(snapshot)
    return snapshot
  }

  private pipelineProgress(change: ChangeStatus | null): StageProgress[] {
    const currentStage: StageId | undefined = change?.stage
    const index = currentStage ? stageIndexSafe(currentStage) : -1
    return STAGE_ORDER.map((stage, order) => {
      let status: StageProgress['status'] = 'pending'
      if (index >= 0) {
        if (order < index) status = 'done'
        else if (order === index) status = 'current'
      }
      if (change?.gates[gateForStage(stage) ?? 'G0']?.state === 'passed') {
        status = 'done'
      }
      return { stage, label: STAGE_LABELS[stage] ?? stage, status }
    })
  }

  private nextStepText(change: ChangeStatus | null, level: LevelProfile | null): string {
    if (!this.isInitialized()) return '运行 /flow init 启用 FlowGate'
    if (this.state?.locked) return '运行 /flow doctor 诊断，/flow repair 恢复'
    if (!change) {
      if (this.roadmapApprovedByOwner() && this.roadmapChangesCreated() === 0) {
        const first = this.roadmapDoc?.entries[0]?.change ?? 'C0'
        return `用 flow_new_change({ fromRoadmap: "${first}" }) 从已批准路线图立项（第一个变更必须是工程骨架 ${first}）`
      }
      return '用 /flow new <描述> 立项'
    }
    if (change.off) return '门禁已关闭（/flow on 恢复）'
    const awaiting = (Object.entries(change.gates) as [GateId, GateRecord][]).find(([, record]) => record.state === 'awaiting')?.[0]
    if (awaiting) return `等待负责人：/flow approve ${awaiting}`
    switch (change.stage) {
      case 'roadmap':
        return '写路线图后 flow_submit({gate:"GR"})'
      case 'S0':
        return '正在立项'
      case 'S1':
        return '写澄清/需求产物后 flow_submit({gate:"G1"})'
      case 'S2':
        return '写 context.md 后 flow_submit({gate:"G2"})'
      case 'S3':
        return '写设计/风险/任务卡后 flow_submit({gate:"G3"})'
      case 'S4': {
        const active = this.activeTask()
        if (active) return `完成任务 ${active.id}（flow_verify → flow_task_done）`
        const blocked = Object.values(change.tasks).find((task) => task.status === 'blocked')
        const openBreaker = change.pending.find((item) => item.status === 'open' && item.kind === 'blocker')
        if (blocked || openBreaker) {
          const target = openBreaker?.id ?? blocked?.id ?? ''
          return `等待负责人 /flow unblock ${target}（连续失败已熔断；只读动作仍可执行）`
        }
        if (change.batches.some((batch) => batch.status === 'checkpoint')) return '执行集成检查点（合并 + 全量测试）'
        return '按执行图开始下一个任务'
      }
      case 'S5':
        return '跑全量验证后 flow_submit({gate:"G5"})'
      case 'S6':
        return '准备交付物后 flow_submit({gate:"G6"})'
      default:
        return '完成'
    }
  }

  statusText(): string {
    const snap = this.snapshot()
    const lines: string[] = []
    lines.push(`${snap.statusLine}`)
    if (!snap.initialized) return 'FlowGate 未启用 · 运行 /flow init 启用'
    if (snap.locked) lines.push(`⚠ 锁定模式：${this.state?.locked?.reason ?? ''}`)
    if (snap.changeId) {
      lines.push(`变更 ${snap.changeId}「${snap.title}」｜${complexityLabel(snap.complexity ?? 'medium')} · ${riskLabel(snap.risk ?? 'normal')}｜阶段 ${snap.stage} ${STAGE_LABELS[snap.stage ?? 'S0']}`)
      const tasks = Object.values(snap.tasks)
      if (tasks.length > 0) {
        lines.push(
          `任务：${tasks
            .map((task) => `${task.id} ${task.status}/${task.tdd}`)
            .join(' · ')}`,
        )
      }
      if (snap.pending.length > 0) lines.push(`待处理：${snap.pending.map((item) => `${item.id} ${item.title}`).join('；')}`)
      const breaker = snap.pending.find((item) => item.kind === 'blocker')
      if (breaker) lines.push(`熔断阻断 ${breaker.id}：负责人运行 /flow unblock ${breaker.id} 解锁（只读动作不受限）`)
      if (snap.violations.length > 0) lines.push(`越界：${snap.violations.map((item) => item.path).join('、')}`)
      lines.push(`下一步：${snap.nextStep}`)
    }
    const breakdown = Object.entries(snap.interceptCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ruleId, count]) => `${ruleId}×${count}`)
      .join(' ')
    if (breakdown) lines.push(`拦截统计：${breakdown}`)
    return lines.join('\n')
  }

  // ------------------------------------------------------------------
  // Private utils
  // ------------------------------------------------------------------

  private requireChange(): ChangeStatus {
    if (!this.current) throw new FlowGateError('当前没有进行中的变更', '用 /flow new <描述> 立项，或 /flow resume <变更编号> 继续')
    return this.current
  }

  /** Test/replay helper: replace the in-memory state without touching the filesystem. */
  setStateForTest(state: store.ProjectState, current: ChangeStatus | null): void {
    this.state = state
    this.current = current
  }

  /** Test/replay helper. */
  setArtifactsForTest(artifacts: ArtifactBundle): void {
    this.artifacts = artifacts
  }

  /** Test/replay helper. */
  setReceiptsForTest(receipts: EvidenceReceipt[]): void {
    this.receipts = receipts
    this.evidenceCounter = receipts.length
  }

  /** Test/replay helper. */
  setProjectForTest(project: ProjectDoc | null): void {
    this.project = project
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approx(text: string): number {
  // Chinese-heavy text: ~1 token per 2 characters is a safe upper bound for the budget.
  return Math.ceil(text.length / 2)
}

function stageIndexSafe(stage: StageId): number {
  const index = STAGE_ORDER.indexOf(stage as never)
  return index
}


/** Human gate currently awaiting the owner (low-complexity merged confirm is G3). */
function findAwaitingHumanGate(change: ChangeStatus): HumanGateId | undefined {
  const entries = Object.entries(change.gates) as [GateId, GateRecord][]
  for (const [gate, record] of entries) {
    if (record?.state === 'awaiting' && isHumanGate(gate)) return gate as HumanGateId
  }
  return undefined
}

function isHumanGate(gate: GateId): boolean {
  return gate === 'GR' || gate === 'G1' || gate === 'G3' || gate === 'G6'
}

function itemsSummary(items: CheckOutcome[]): { item: string; passed: boolean }[] {
  return items.map((item) => ({ item: item.item, passed: item.passed }))
}

function compareReceipts(a: EvidenceReceipt, b: EvidenceReceipt): number {
  if (a.finishedAt === b.finishedAt) return a.id.localeCompare(b.id)
  return a.finishedAt.localeCompare(b.finishedAt)
}

function isUnderAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.includes('*')) return false
    return path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`)
  })
}

function matchesToMarkdown(checks: { citation: { file: string; startLine: number; endLine: number; quote?: string }; hash?: string }[]): string {
  return checks
    .map((check) => {
      const quote = check.citation.quote ? `\n  > ${check.citation.quote}` : ''
      return `- \`${check.citation.file}:${check.citation.startLine}-${check.citation.endLine}\`（hash ${check.hash ?? '未知'}）${quote}`
    })
    .join('\n')
}

function projectLevelPaths(root: string): { projectClarifyPath: string } {
  const layout = store.layout(root)
  return { projectClarifyPath: posixJoin(layout.dir, 'project-clarify.md') }
}

function detectedAsProjectDoc(detected: Awaited<ReturnType<typeof detectTechStack>>, raw: string): ProjectDoc {
  return {
    raw,
    name: detected.name,
    stack: detected.stackFacts,
    modules: detected.modules,
    commands: detected.commands,
    conventions: [],
    forbidden: [],
    reusable: [],
    readFiles: detected.readFiles,
    claims: [],
  }
}

/** Build the one-line status bar text (<= 120 characters). */
export function buildStatusLine(snapshot: RuntimeSnapshot): string {
  if (!snapshot.initialized) return '◆ FlowGate 未启用 · /flow init 启用'
  if (snapshot.locked) return '◆ FlowGate 锁定 · /flow doctor 诊断'
  const parts: string[] = ['◆ FlowGate']
  if (snapshot.changeId && snapshot.changeId !== 'PROJECT') {
    parts.push(snapshot.changeId)
    parts.push(`${complexityShort(snapshot.complexity)} · ${riskShort(snapshot.risk)}`)
  }
  if (snapshot.stage === 'roadmap') parts.push('路线图 ▸ 待 GR')
  else if (snapshot.awaitingGate) parts.push(`等待批准 ${snapshot.awaitingGate}`)
  else if (snapshot.stage) parts.push(`${stageCircle(snapshot.stage)} ${STAGE_LABELS[snapshot.stage] ?? snapshot.stage}`)
  const interceptCount = Object.values(snapshot.interceptCounts).reduce((sum, value) => sum + value, 0)
  if (interceptCount > 0 || snapshot.pending.length > 0) {
    parts.push(`拦截 ${interceptCount} · 待处理 ${snapshot.pending.length}`)
  }
  parts.push(`下一步：${snapshot.nextStep}`)
  let text = parts.join(' │ ')
  if (text.length > 120) text = `${text.slice(0, 119)}…`
  return text
}

function complexityShort(complexity: Complexity | undefined): string {
  return complexityLabel(complexity ?? 'medium')
}

function riskShort(risk: RiskLevel | undefined): string {
  return riskLabel(risk ?? 'normal')
}

function stageCircle(stage: StageId): string {
  const map: Record<string, string> = {
    roadmap: '⓪',
    S0: '⓪',
    S1: '①',
    S2: '②',
    S3: '③',
    S4: '④',
    S5: '⑤',
    S6: '⑥',
    archived: '✓',
  }
  return map[stage] ?? '•'
}

export { STAGE_LABELS }
