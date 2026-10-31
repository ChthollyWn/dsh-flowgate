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
  EnforcerKind,
  EnginePorts,
  EvidenceKind,
  EvidenceReceipt,
  ExceptionRecord,
  ExecutionPlan,
  FileAction,
  FlowgateConfig,
  FlowPlan,
  FlowRoute,
  GateCheckContext,
  GateId,
  GateRecord,
  GateResult,
  HumanGateId,
  GitPort,
  HandoffSummary,
  IncidentRecord,
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
  ProjectFlags,
  RepairRecord,
  RepairSeverity,
  ReviewFinding,
  ReviewRecord,
  RiskLevel,
  RoadmapDoc,
  Rule,
  RuntimeSnapshot,
  SessionLease,
  StageId,
  StageProgress,
  StatusSummary,
  TakeoverMode,
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
import { matchGlob } from './util/glob'
import { matchesScope, outOfScopePaths } from './util/scope'
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
  mutatesRepository,
  explainDecision,
  ruleMisfireRate,
  shouldDowngradeRule,
  type RuleFeedback,
} from './rules'
import { validateVerifyCommand, classifyRepairShellCommand, extractWriteTargets } from './shell'
import { loadArtifacts, loadProjectDoc, runGateChecks, artifactHashes, parseIncrementalSpec, parseRoadmap, parseTaskCardFragment } from './artifacts'
import { renderExecutionPlanMarkdown, renderExecutionDiagram } from './plan'
import { verifyCitations, citationsStale, documentCitations } from './citations'
import { detectTechStack, renderProjectDocDraft } from './detect'
import { createLedger, type Ledger } from './ledger'
import * as store from './store'
import {
  hashInputs,
  buildEvidenceView,
  receiptFreshness,
  runVerifyGroup,
  runFullSuite,
  summarizeEvidenceForContext,
  parseTestOutput,
  detectEvidenceKind,
} from './evidence'
import { invalidateOnRework, type ReworkKind } from './revision'
import { computeMetrics } from './metrics'
import { reviewFlowAssessment } from './flow/routing'
import { renderChangeReport } from './report'
import { renderDashboard } from './dashboard'
import { mergeIncrementalSpec, capabilityDirName } from './archive'
import { riskRaisedEffects } from './risk'
import type { TamperSignal, TamperSignalKind } from './tamper'

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
  /**
   * 接管模式（v0.5.1，构造时固定）：
   * - `enforce`（默认）：未立项的仓库改动一律拒绝；
   * - `observe`：只记录 `takeover.observed` 并放行（用于自举/试运行）；
   * - `off`：不拦截也不记录。
   */
  takeover?: TakeoverMode
  /** 宿主进程 epoch：agent 自暂停（autoRearm）在宿主重启后自动恢复的判定依据。 */
  hostEpoch?: string
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
  /** 回执 id → 当前输入哈希下是否仍新鲜（面板/注入用；由 refreshEvidenceFreshness 计算）。 */
  private evidenceFreshnessCache: Record<string, boolean> = {}
  private loaded = false
  private loadError: string | null = null
  /** 加载阶段发现的损坏状态文件（status.json 等）；非空即进入锁定模式（03 §14）。 */
  private stateCorruption: store.CorruptStateFile[] = []
  private interceptCounts: Record<string, number> = {}
  /** Per-rule M-5 feedback (interceptions / misjudged), rebuilt from the ledger. */
  private ruleFeedback: Record<string, RuleFeedback> = {}
  private lastRuleId: string | null = null
  private guardHeartbeat = { toolCalls: 0, decisions: 0 }
  /** 本会话是否接续了已存在的变更（状态条「已接续」）。 */
  private resumed = false
  /** 租约外部变化检查（节流 1s，避免每次写操作都读 sessions.json）。 */
  private lastLeaseRefreshAt = 0
  private foreignLease: SessionLease | null = null
  private notices: string[] = []
  private evidenceCounter = 0
  /** 负责人批准的项目规则（.flowgate/rules/*.json），创建新变更时并入契约。 */
  private projectRules: Rule[] = []
  /** 接管模式（构造时固定；v0.5.1）。 */
  private readonly takeover: TakeoverMode
  /** 宿主进程 epoch（用于 agent 自暂停的宿主重启自动恢复）。 */
  private readonly hostEpoch?: string
  /** 项目级开关（暂停/事故）：`.flowgate/state/flags.json`（v0.5.1）。 */
  private flags: ProjectFlags = {}
  /** 进行中的修复声明：`.flowgate/state/repair.json`（v0.5.1）。 */
  private activeRepair: RepairRecord | null = null
  /**
   * 观察模式去重：每会话每规则至多写一次 `takeover.observed`。
   * 键为规则 id（当前只有 R-NO-CHANGE）；引擎实例即会话作用域。
   */
  private readonly observedTakeover = new Set<string>()

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
    this.takeover = options.takeover ?? 'enforce'
    this.hostEpoch = options.hostEpoch
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
        this.flags = {}
        this.activeRepair = null
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
      await this.loadProjectRules()
      this.project = await loadProjectDoc(this.fs, this.root)
      this.roadmapDoc = await this.loadRoadmapDoc()
      await this.rebuildCounters()
      // v0.5.1：项目级开关（暂停/事故）与进行中的修复声明都从磁盘恢复；两者
      // 损坏时按「未暂停 / 无修复」降级，绝不因为辅助状态文件坏掉而让 load 失败。
      this.flags = await store.readProjectFlags(this.fs, this.root)
      this.activeRepair = await store.readActiveRepair(this.fs, this.root)
      await this.autoRearmProjectFlags()

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
      await this.refreshEvidenceFreshness()
      this.loaded = true
    } catch (error) {
      this.loadError = (error as Error).message
      this.loaded = false
      throw error
    } finally {
      this.emitState()
    }
  }

  /**
   * 状态文件损坏的锁定原因：列出文件路径与原因（03 §14）。
   * 修复入口不在这里提示命令：用户可见路径统一写「授权卡片」（§0 规则 2）；
   * `/flow doctor` 输出由 `doctor()` 另外补上 `/flow repair` 诊断入口（help 文本）。
   */
  private corruptionLockReason(): string {
    const files = this.stateCorruption
    const shown = files.slice(0, 3).map((file) => `${file.path}（${file.reason}）`)
    const rest = files.length > 3 ? `；另有 ${files.length - 3} 个损坏文件` : ''
    return `状态文件损坏（${files.length} 个）：${shown.join('；')}${rest}。已进入锁定模式`
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

  /** 接管模式（v0.5.1）：构造时固定，运行期不可变。 */
  getTakeoverMode(): TakeoverMode {
    return this.takeover
  }

  /** 项目级开关快照（暂停/事故）；返回副本，调用方修改不影响引擎。 */
  getProjectFlags(): ProjectFlags {
    return JSON.parse(JSON.stringify(this.flags)) as ProjectFlags
  }

  /** 进行中的修复声明（v0.5.1）；没有时返回 null。返回副本。 */
  getRepair(): RepairRecord | null {
    if (this.activeRepair === null) return null
    return JSON.parse(JSON.stringify(this.activeRepair)) as RepairRecord
  }

  /** 面板/试跑用：当前变更实际生效的规则（内置 + 项目规则，按冻结契约）。 */
  getEffectiveRules(): Rule[] {
    return loadRules(this.configFor(this.current))
  }

  /**
   * 当前变更生效的判定配置。
   *
   * 变更创建时已把「规则 / 触发器 / 等级 / 限制」冻结进 `contract.snapshot`；
   * 在途变更始终按冻结快照判定（T1.3 验收：改 config.yaml 只影响新变更）。
   * 旧状态没有快照（字段是后续版本加的）时回退当前配置。
   */
  private configFor(change: ChangeStatus | null | undefined): FlowgateConfig {
    return store.frozenContractConfig(this.config, change?.contract)
  }

  /**
   * Review rounds required for each task gate at the current change's level
   * (0 = review not required). Host uses it to run the full number of rounds
   * instead of short-circuiting after the first pass (high risk requires 2).
   */
  requiredReviewRounds(): number {
    if (!this.current) return 0
    return levelProfile(this.current.complexity, this.current.risk, this.configFor(this.current).limits).reviewRoundsPerTask
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

  /** 宿主在补算投影数据（如证据新鲜度）后主动刷新一次面板投影。 */
  notifyStateChanged(): void {
    this.emitState()
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

  /** 读取 `.flowgate/rules/*.json`（负责人批准的规则沉淀），失败时保持空。 */
  private async loadProjectRules(): Promise<void> {
    const dir = store.layout(this.root).rulesDir
    try {
      if (!(await this.fs.exists(dir))) return
      const names = (await this.fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort()
      const rules: Rule[] = []
      for (const name of names) {
        try {
          const raw = await this.fs.readFile(posixJoin(dir, name))
          const parsed = JSON.parse(raw) as Rule
          if (parsed && typeof parsed.id === 'string' && parsed.id !== '') rules.push(parsed)
        } catch {
          // 单条规则损坏不影响其它规则。
        }
      }
      this.projectRules = rules
    } catch {
      this.projectRules = []
    }
  }

  /** 当前生效配置（含已批准的项目规则）；创建新变更时用它冻结契约。 */
  private effectiveConfig(): FlowgateConfig {
    if (this.projectRules.length === 0) return this.config
    return { ...this.config, rules: [...this.config.rules, ...this.projectRules] }
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
    // 回执一变，证据文档与面板新鲜度都要跟着刷新（T3.2/T3.6）。
    await this.refreshEvidenceFreshness()
    await this.refreshEvidenceDoc()
  }

  /** 面板用：回执 id → 是否仍按当前输入新鲜（输入哈希判定，不只看「组内最新」）。 */
  getEvidenceFreshness(): Record<string, boolean> {
    return this.evidenceFreshnessCache
  }

  /**
   * 重新计算全部回执的新鲜度（T3.6 验收：改了源码后 GREEN 证据应显示「过期」）。
   * 同一输入集合只哈希一次；取不到文件系统信息时保守记为不新鲜。
   */
  async refreshEvidenceFreshness(): Promise<void> {
    const change = this.current
    if (!change) {
      this.evidenceFreshnessCache = {}
      return
    }
    const tasks = this.getTasks()
    const hashes = new Map<string, string>()
    const cache: Record<string, boolean> = {}
    for (const receipt of this.receipts.filter((item) => item.changeId === change.id)) {
      try {
        const task = receipt.taskId !== undefined ? tasks.find((item) => item.id === receipt.taskId) : undefined
        const group = task?.verify.find((item) => item.group === receipt.group)
        const inputs = group?.inputs !== undefined ? group.inputs : this.baselineInputs()
        const key = stableJson(inputs)
        let inputsHash = hashes.get(key)
        if (inputsHash === undefined) {
          inputsHash = (await hashInputs(this.fs, this.root, inputs)).hash
          hashes.set(key, inputsHash)
        }
        cache[receipt.id] = receiptFreshness(receipt, inputsHash).fresh
      } catch {
        cache[receipt.id] = false
      }
    }
    this.evidenceFreshnessCache = cache
  }

  /** 把全部回执写成 `evidence.md`（T3.2 交付物；插件维护，agent 不可写）。 */
  async refreshEvidenceDoc(): Promise<void> {
    const change = this.current
    if (!change) return
    const receipts = this.receipts.filter((item) => item.changeId === change.id)
    const rows = receipts.map((receipt) => {
      const fresh = this.evidenceFreshnessCache[receipt.id] === true ? '新鲜' : '过期/未知'
      const result = `${receipt.phase} · exit=${receipt.exitCode}${receipt.timedOut ? ' · 超时' : ''}`
      return `| ${receipt.id} | ${receipt.taskId ?? '—'} | ${receipt.group} | ${receipt.kind} | ${result} | ${fresh} | ${receipt.finishedAt} |`
    })
    const lines = [
      `# 证据回执 ${change.id}`,
      '',
      '> 由 FlowGate 插件根据回执索引生成；agent 不能直接编辑（R-PROTECTED）。',
      '',
      '| 回执 | 任务 | 验证组 | 类型 | 结果 | 新鲜度 | 时间 |',
      '|---|---|---|---|---|---|---|',
      ...rows,
      '',
    ]
    await this.fs.writeFile(store.changePaths(this.root, change.id).evidence, lines.join('\n'))
  }

  /** 把审查记录写成 `review.md`（T3.4 交付物；插件维护）。 */
  async refreshReviewDoc(): Promise<void> {
    const change = this.current
    if (!change) return
    const reviews = change.reviews
    const lines = [`# 审查记录 ${change.id}`, '']
    if (reviews.length === 0) {
      lines.push('> 还没有审查记录。')
    } else {
      for (const review of reviews) {
        lines.push(`## ${review.id} · ${review.kind} · ${review.verdict}`)
        lines.push('')
        lines.push(`- 任务：${review.taskId ?? '（终审）'}`)
        lines.push(`- 读取覆盖：${review.coverageOk ? '通过' : '不完整'}`)
        lines.push(`- 时间：${review.createdAt}`)
        lines.push('')
        if (review.findings.length === 0) lines.push('（无 findings）')
        else {
          lines.push('| 级别 | 文件 | 行 | 规则 | 说明 |')
          lines.push('|---|---|---|---|---|')
          for (const finding of review.findings) {
            lines.push(
              `| ${finding.severity} | ${finding.file} | ${finding.line ?? '—'} | ${finding.rule} | ${finding.message.replace(/\|/g, '\\|')} |`,
            )
          }
        }
        lines.push('')
      }
    }
    await this.fs.writeFile(store.changePaths(this.root, change.id).review, lines.join('\n'))
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
    // 执行图随状态变化重生成（T2.9）：任务/批次状态一变，execution-plan.md 就是最新视图。
    if (
      change.plan !== undefined &&
      (change.stage === 'S3' || change.stage === 'S4' || change.stage === 'S5' || change.stage === 'S6')
    ) {
      try {
        const planMd = renderExecutionPlanMarkdown(change.plan, change)
        await this.fs.writeFile(store.changePaths(this.root, change.id).executionPlan, planMd)
      } catch {
        // 执行图重生成失败不阻塞状态保存。
      }
    }
    // 跨会话看板随状态变化重新生成（T5.3 验收 #2）：文件写盘失败不阻塞状态保存。
    if (this.state?.initialized === true) {
      try {
        await this.generateBoard()
      } catch {
        // 忽略看板生成失败。
      }
    }
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

  /**
   * Working directory for a task: its parallel worktree when recorded, else the
   * main repository root. T4.9 requires verification, input hashing and the
   * auto-commit to happen inside the executor's worktree, not the main one.
   */
  private taskExecutionRoot(taskId?: string): string {
    const worktree = taskId !== undefined ? this.current?.tasks[taskId]?.worktree : undefined
    if (worktree === undefined || worktree === '') return this.root
    return posixJoin(this.root, normalizeRelPath(worktree))
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
        message: 'FlowGate 已经初始化过；如需更新 project.md，请直接编辑后点授权卡片上的「修复」重建缓存。',
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

  /** 空仓库判定（T2.7）：没有常见工程清单时先走项目级澄清 + 路线图。 */
  private async looksLikeEmptyRepository(): Promise<boolean> {
    for (const marker of [
      'package.json',
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'go.mod',
      'Cargo.toml',
      'composer.json',
      'Gemfile',
    ]) {
      if (await this.fs.exists(marker)) return false
    }
    return true
  }

  async newChange(input: NewChangeInput): Promise<NewChangeOutcome> {
    if (!this.state?.initialized) throw new FlowGateError('FlowGate 未初始化', '等待负责人在授权卡片上启用 FlowGate 后重试')
    if (this.state.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    // v0.5.1：修复通道与七阶段变更互斥——修 bug 不是新功能，先关门再立项。
    if (this.activeRepair !== null) {
      throw new FlowGateError(
        `修复通道 ${this.activeRepair.id} 正在进行中（${this.activeRepair.title}）`,
        '先 flow_fix_done 完成修复并留证（或 flow_fix_abort 中止）后再 flow_new_change 立项；修复通道内不需要立项',
      )
    }
    // T2.7：空仓库里 `/flow new <需求>` 不应直接立一个大变更——先走项目级澄清 + 路线图。
    if (!input.project && !input.fromRoadmap && !this.roadmapApprovedByOwner() && (await this.looksLikeEmptyRepository())) {
      this.pushNotice('检测到空仓库：先进入项目级澄清与路线图（PROJECT 变更），批准 GR 后再从路线图立项。')
      return this.newChange({ ...input, project: true })
    }
    if (!this.state.changes.every((change) => change.lifecycle !== 'active') && !input.project) {
      const active = this.state.changes.filter((change) => change.lifecycle === 'active')
      if (active.length > 0 && this.current && this.current.lifecycle === 'active') {
        throw new FlowGateError(
          `已有进行中的变更 ${this.current.id}（${this.current.title}）`,
          '同一工作目录同一时间只能推进一个变更；在 FlowGate 面板上暂停或切换到另一个变更',
        )
      }
    }
    const now = isoNow(this.clock)
    const suggestion = suggestLevels({
      title: input.title,
      summary: input.summary,
      // FR-6.5：把需求里提到的路径/模块作为等级信号，而不是恒为 []。
      paths: extractMentionedPaths(`${input.title} ${input.summary ?? ''}`),
      modules: this.project?.modules?.map((module) => module.path) ?? [],
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
        config: this.effectiveConfig(),
        pluginVersion: this.pluginVersion,
        skills: this.skillVersions(),
      })
      change.contract = store.freezeContract(this.effectiveConfig(), this.pluginVersion, this.skillVersions(), now)
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
      if (!entry) throw new FlowGateError(`路线图里没有 ${input.fromRoadmap}`, '先在 FlowGate 面板的流程页查看路线图条目编号')
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
    // v0.5 自动流程：模型自评 + 宿主 auto-review 决定 route/autoApprove。
    // 旧调用（/flow new、未提交 assessment）保持既有行为，不自动降级/放行。
    const flowPlan: FlowPlan | undefined =
      input.assessment !== undefined && (input.kind ?? 'change') === 'change'
        ? reviewFlowAssessment({
            title,
            summary,
            assessment: input.assessment,
            complexity,
            risk,
            assessedAt: now,
          })
        : undefined
    const change = initialStatus({
      id: changeId,
      kind: input.kind ?? 'change',
      title,
      summary,
      complexity,
      risk,
      stage: 'S0',
      at: now,
      config: this.effectiveConfig(),
      pluginVersion: this.pluginVersion,
      skills: this.skillVersions(),
      roadmap: roadmapRef,
      relatedTo: input.relatedTo,
    })
    change.contract = store.freezeContract(this.effectiveConfig(), this.pluginVersion, this.skillVersions(), now)
    if (flowPlan !== undefined) change.flowPlan = flowPlan
    await store.ensureChangeDir(this.fs, this.root, change.id)
    const roadmapEntry =
      roadmapRef !== undefined ? this.roadmapDoc?.entries.find((entry) => entry.change === roadmapRef) : undefined
    const relatedAnalysis = input.relatedTo !== undefined ? await this.loadArchivedAnalysis(input.relatedTo) : null
    if (input.relatedTo !== undefined && relatedAnalysis === null) {
      this.pushNotice(`关联分析 ${input.relatedTo} 没有找到归档结论：S1 需要自行核对。`)
    }
    await this.writeChangeTemplates(change, roadmapEntry, relatedAnalysis ?? undefined)
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
    if (flowPlan !== undefined) {
      await this.appendLedger('flow.assessed', {
        changeId: change.id,
        route: flowPlan.route,
        proposedRoute: flowPlan.proposedRoute,
        autoApprove: flowPlan.autoApprove,
        verdict: flowPlan.verdict,
        reasons: flowPlan.reasons,
      })
    }
    if (roadmapRef !== undefined) await this.updateRoadmapStatus(change, '进行中')
    const g0 = await this.evaluateGate(change, 'G0')
    await this.recordGateResult(change, 'G0', g0, now)
    await this.saveChange(change)
    const g0Failed = g0.failures.length > 0
    if (g0Failed) {
      this.pushNotice(`G0 未通过：${g0.failures.map((failure) => failure.label).join('；')}。修正后重新提交 G0。`)
    } else if (input.kind === 'analysis') {
      this.pushNotice(`已立分析任务 ${change.id}：只读排查，结论用 flow_submit_analysis 提交（必须带源码引用）。`)
    } else {
      if (flowPlan !== undefined) {
        const auto = flowPlan.autoApprove ? '；G1/G3/G6 检查通过后自动通过（不再等人）' : ''
        this.pushNotice(
          `已立项 ${change.id}（${complexityLabel(complexity)} · ${riskLabel(risk)}）。自动流程：${this.flowRouteLabel(flowPlan.route)}${auto}。当前 S1 需求澄清。`,
        )
      } else {
        this.pushNotice(`已立项 ${change.id}（${complexityLabel(complexity)} · ${riskLabel(risk)}）。当前 S1 需求澄清：先读相关代码与规格，再用 ask_user_question 澄清，写 clarify.md / proposal.md / 增量规格。`)
      }
    }
    const routeNote =
      flowPlan !== undefined
        ? `自动流程 ${flowPlan.route}${flowPlan.autoApprove ? '（自动放行）' : flowPlan.route === 'standard' ? '（合并 G1+G3 一次确认）' : '（人工门）'}${flowPlan.verdict === 'adjusted' ? `，auto-review 已调整：${flowPlan.reasons[flowPlan.reasons.length - 1] ?? ''}` : ''}`
        : ''
    return {
      changeId: change.id,
      suggestion,
      ...(flowPlan !== undefined ? { flowPlan } : {}),
      message:
        input.kind === 'analysis'
          ? `分析任务 ${change.id} 已创建：只读，不改代码。`
          : g0Failed
            ? `变更 ${change.id} 已创建，但 G0 未通过：${g0.failures.map((failure) => failure.label).join('；')}。修正后重新提交 G0。`
            : `变更 ${change.id} 已创建并进入 S1 需求澄清（${complexityLabel(complexity)} · ${riskLabel(risk)}${routeNote !== '' ? `；${routeNote}` : '，建议等级，负责人可在 G1 确认或调整'}）。`,
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

  /** 读取已归档分析任务（A-xxx）的结论，供 relatedTo 立项继承（T4.10）。 */
  private async loadArchivedAnalysis(analysisId: string): Promise<{ id: string; content: string } | null> {
    const archiveDir = store.layout(this.root).archiveDir
    try {
      if (!(await this.fs.exists(archiveDir))) return null
      const entries = await this.fs.readdir(archiveDir)
      const match = entries.filter((name) => name.endsWith(`-${analysisId}`)).sort().pop()
      if (match === undefined) return null
      const path = posixJoin(archiveDir, match, 'analysis.md')
      if (!(await this.fs.exists(path))) return null
      return { id: analysisId, content: await this.fs.readFile(path) }
    } catch {
      return null
    }
  }

  private async writeChangeTemplates(
    change: ChangeStatus,
    roadmapEntry?: { goal: string; capability: string; acceptance: string },
    relatedAnalysis?: { id: string; content: string },
  ): Promise<void> {
    const paths = store.changePaths(this.root, change.id)
    const clarifyGoal = roadmapEntry?.goal !== undefined && roadmapEntry.goal !== '' ? roadmapEntry.goal : ''
    const clarifyTemplate = `# 澄清记录：${change.title}\n\n## 原始描述\n\n${clarifyGoal !== '' ? `${clarifyGoal}（来自已批准的路线图）` : '<!-- 负责人原始描述 -->'}\n\n## 已知事实\n\n<!-- 每条写 文件:起止行 引用形式；没有引用只能算假设 -->\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 |  |  |  |\n| 边界（做 / 不做） |  |  |  |\n| 角色与权限 |  |  |  |\n| 验收标准 |  |  |  |\n| 约束（非功能） |  |  |  |\n| 未知与假设 |  |  |  |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n\n## 已接受的假设\n\n## 未决问题\n${relatedAnalysis !== undefined ? `\n## 关联分析结论（${relatedAnalysis.id}）\n\n${relatedAnalysis.content.slice(0, 4_000)}\n` : ''}`
    const proposalTemplate =
      roadmapEntry !== undefined && (roadmapEntry.goal !== '' || roadmapEntry.acceptance !== '')
        ? `# 变更提案：${change.title}\n\n## 为什么\n\n${roadmapEntry.goal !== '' ? roadmapEntry.goal : '<!-- 要解决的问题与证据 -->'}\n\n## 改什么\n\n${roadmapEntry.capability !== '' ? roadmapEntry.capability : '<!-- 功能列表，配套增量规格 -->'}\n\n## 影响\n\n<!-- 受影响的模块、接口、数据 -->\n\n## 不做\n\n<!-- 明确排除的范围 -->\n\n## 验收要点（来自已批准的路线图）\n\n${roadmapEntry.acceptance !== '' ? roadmapEntry.acceptance : '<!-- 验收要点 -->'}\n`
        : `# 变更提案：${change.title}\n\n## 为什么\n\n<!-- 要解决的问题与证据 -->\n\n## 改什么\n\n<!-- 功能列表，配套增量规格 -->\n\n## 影响\n\n<!-- 受影响的模块、接口、数据 -->\n\n## 不做\n\n<!-- 明确排除的范围 -->\n`
    await this.fs.writeFile(paths.clarify, clarifyTemplate)
    await this.fs.writeFile(paths.proposal, proposalTemplate)
    await this.fs.mkdir(posixJoin(paths.dir, 'specs'))
  }

  // ------------------------------------------------------------------
  // Gates
  // ------------------------------------------------------------------

  private level(): LevelProfile {
    const change = this.current
    return levelProfile(change?.complexity ?? 'medium', change?.risk ?? 'normal', this.configFor(change).limits)
  }

  /** v0.5：fast 路由 = 检查通过后自动通过 G1/G3/G6（auto-review 已批准）。 */
  private isFastFlow(change: ChangeStatus): boolean {
    const plan = change.flowPlan
    return plan?.route === 'fast' && plan.autoApprove === true
  }

  /** v0.5：standard 路由把 G1+G3 合并为一次人工确认（不因复杂度而退化）。 */
  private mergesG1G3(change: ChangeStatus): boolean {
    return change.flowPlan?.route === 'standard'
  }

  private flowRouteLabel(route: FlowRoute): string {
    switch (route) {
      case 'fast':
        return 'fast（检查通过后自动放行）'
      case 'standard':
        return 'standard（合并 G1+G3 一次确认）'
      default:
        return 'full（全流程人工门）'
    }
  }

  private async buildGateContext(change: ChangeStatus, gate: GateId): Promise<GateCheckContext> {
    const artifacts = await loadArtifacts(this.fs, this.root, change.id)
    // Re-read project-level documents: the agent may have written them since the last load.
    this.project = await loadProjectDoc(this.fs, this.root)
    this.roadmapDoc = await this.loadRoadmapDoc()
    const changeReceipts = this.receipts.filter((receipt) => receipt.changeId === change.id)
    const config = this.configFor(change)
    return {
      root: this.root,
      gate,
      level: levelProfile(change.complexity, change.risk, config.limits),
      change,
      config,
      artifacts,
      fs: this.fs,
      git: this.git,
      commandRunner: this.runner,
      evidence: changeReceipts,
      project: this.project,
      roadmap: this.roadmapDoc,
      now: isoNow(this.clock),
      limits: config.limits,
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
      // T4.8：每通过一个门生成交接摘要（新会话/压缩后优先注入）。
      if (change.lifecycle === 'active' && change.stage !== 'roadmap' && this.current?.id === change.id) {
        try {
          await this.generateHandoff()
        } catch {
          // 交接摘要失败不影响门禁。
        }
      }
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
    const level = levelProfile(change.complexity, change.risk, this.configFor(change).limits)
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
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    if (gate === 'TG' || gate === 'G4') {
      throw new FlowGateError(`${gate} 不是由 agent 提交的门`, '任务门由 flow_task_done 自动判定，G4 在全部任务完成后自动通过')
    }
    const validation = validateGateSubmission(change, gate)
    if (!validation.ok) throw new FlowGateError(validation.message, '在 FlowGate 面板查看当前阶段与待办')
    if (gate === 'GR') {
      if (change.stage !== 'roadmap') throw new FlowGateError('当前不是在项目路线图阶段', '新项目先调用 flow_new_change({ project: true }) 立项')
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

    // T2.10：G1/G2 通过时把源码引用的文件哈希冻结下来，之后文件改动会标待复核。
    if (gate === 'G1' || gate === 'G2') {
      try {
        await this.recordGateCitationChecks(change)
      } catch {
        // 引用核验失败不阻塞门（由 g1/g2 的 citation 检查负责提示）。
      }
    }
    const level = levelProfile(change.complexity, change.risk, this.configFor(change).limits)
    const fastFlow = this.isFastFlow(change)
    const mergedFlow = level.mergedGates || this.mergesG1G3(change)
    // 低复杂度快车道 / standard 合并确认 / fast 自动流程：G1 检查通过后不等人，自动进入 S2。
    if (gate === 'G1' && mergedFlow) {
      change.gates.G1 = {
        ...(change.gates.G1 ?? { state: 'passed', attempts: 0 }),
        state: 'passed',
        items: result.items,
        submittedAt: now,
        passedAt: now,
        ...(fastFlow ? { approvedAt: now, approvedBy: 'auto' as const } : {}),
        attempts: (change.gates.G1?.attempts ?? 0) + 1,
      }
      Object.assign(change, enterStage(change, stageAfterGate('G1') ?? change.stage, now))
      await this.appendLedger('gate.passed', {
        changeId: change.id,
        gate: 'G1',
        auto: true,
        merged: !fastFlow,
        ...(fastFlow ? { flowRoute: 'fast' } : {}),
      })
      await this.appendLedger('stage.entered', { changeId: change.id, stage: change.stage })
      await this.saveChange(change)
      this.pushNotice(
        fastFlow
          ? 'G1 检查通过（fast 自动流程）：自动进入 S2。'
          : 'G1 检查通过（低复杂度快车道）：自动进入 S2，G1 与 G3 将在方案确认卡一起获批。',
      )
      return {
        gate,
        passed: true,
        items: result.items,
        failures: [],
        stage: change.stage,
        message: fastFlow ? 'G1 检查通过（fast 自动流程，自动进入 S2）。' : 'G1 检查通过（低复杂度快车道，自动进入 S2）。',
      }
    }
    const human = isHumanGate(gate)
    const merged = gate === 'G3' && mergedFlow

    // fast 自动流程：G3 检查通过 → 自动批准并进入 S4（不再生成授权卡片）。
    if (gate === 'G3' && fastFlow) {
      change.gates.G3 = {
        ...(change.gates.G3 ?? { state: 'passed', attempts: 0 }),
        state: 'passed',
        items: result.items,
        submittedAt: now,
        passedAt: now,
        approvedAt: now,
        approvedBy: 'auto',
        attempts: (change.gates.G3?.attempts ?? 0) + 1,
      }
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G3', auto: true, flowRoute: 'fast' })
      // 和人工批准保持一致：冻结产物，之后直接改已批准产物会被守卫拒绝。
      await this.reloadArtifacts()
      const frozenKeys = store.freezeArtifacts(change, this.artifacts, now)
      if (frozenKeys.length > 0) {
        await this.appendLedger('artifacts.frozen', { changeId: change.id, gate: 'G3', keys: frozenKeys })
      }
      Object.assign(change, enterStage(change, stageAfterGate('G3') ?? change.stage, now))
      await this.appendLedger('stage.entered', { changeId: change.id, stage: change.stage })
      if (change.stage === 'S4') await this.onEnterS4(change)
      await this.saveChange(change)
      this.pushNotice(`G3 检查通过（fast 自动流程）：已自动批准并进入 S4，按执行图开始任务。`)
      return {
        gate,
        passed: true,
        items: result.items,
        failures: [],
        stage: change.stage,
        message: 'G3 检查通过（fast 自动流程，已自动批准，进入 S4）。',
      }
    }

    // fast 自动流程：G6 检查通过 → 自动交付归档（不再等人）。
    if (gate === 'G6' && fastFlow) {
      change.gates.G6 = {
        ...(change.gates.G6 ?? { state: 'passed', attempts: 0 }),
        state: 'passed',
        items: result.items,
        submittedAt: now,
        passedAt: now,
        approvedAt: now,
        approvedBy: 'auto',
        attempts: (change.gates.G6?.attempts ?? 0) + 1,
      }
      await this.appendLedger('gate.approved', { changeId: change.id, gate: 'G6', auto: true, flowRoute: 'fast' })
      Object.assign(change, enterStage(change, stageAfterGate('G6') ?? 'archived', now))
      await this.archiveChange(change)
      await this.saveChange(change)
      return {
        gate,
        passed: true,
        items: result.items,
        failures: [],
        stage: change.stage,
        message: 'G6 检查通过（fast 自动流程）：已自动交付并归档。',
      }
    }
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
      // G3 批准卡片要显示执行图（T2.9 验收 #3）：等负责人期间就物化任务/批次。
      if (gate === 'G3') this.materializePlan(change)
      await this.saveChange(change)
      this.hooks?.onAwaitingOwner?.(change, gate)
      if (gate === 'GR') this.pushNotice('路线图检查通过：等待负责人在授权卡片上批准。')
      else if (merged) {
        this.pushNotice('低复杂度方案确认卡已就绪：等负责人确认（同时批准 G1 与 G3）。')
      } else this.pushNotice(`G${gate.slice(1)} 检查通过：等待负责人在授权卡片上批准或退回（退回需写理由）。`)
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

  async approveGate(gate: GateId, options: { reason?: string; confirmRisks?: boolean } = {}): Promise<GateResult> {
    const change = this.requireChange()
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    const record = change.gates[gate]
    const awaiting = record?.state === 'awaiting' || (gate === 'G3' && record?.state === 'passed' && change.stage === 'S3')
    if (!awaiting) {
      throw new FlowGateError(`当前没有等待批准的 ${gate}`, '在授权卡片或面板查看当前等待批准的门')
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

    const level = levelProfile(change.complexity, change.risk, this.configFor(change).limits)
    // T2.8 验收 #3：低复杂度 · 高风险的方案确认卡要逐项确认风险与回滚方案。
    if (gate === 'G3' && (level.mergedGates || this.mergesG1G3(change)) && change.risk === 'high' && options.confirmRisks !== true) {
      throw new FlowGateError(
        '低复杂度 · 高风险的方案确认卡需要逐项确认风险和回滚方案',
        '请在授权卡片上点「确认并推进」，逐项确认风险与回滚方案',
      )
    }
    const approveG1Too = gate === 'G3' && (level.mergedGates || this.mergesG1G3(change)) && change.gates.G1?.state === 'passed'
    Object.assign(change, applyGateApproved(change, gate, now))
    change.gates[gate] = {
      ...(change.gates[gate] ?? { state: 'passed', attempts: 0 }),
      state: 'passed',
      approvedAt: now,
    }
    await this.appendLedger('gate.approved', { changeId: change.id, gate, reason: options.reason })
    // 人工门通过后冻结当前全部产物的原文哈希（T2.1/T2.5）：之后 agent 直接改
    // 已批准产物会被守卫拒绝，G3/G6 的 frozenArtifacts 检查也会发现绕过守卫的改动。
    await this.reloadArtifacts()
    const frozenKeys = store.freezeArtifacts(change, this.artifacts, now)
    if (frozenKeys.length > 0) {
      await this.appendLedger('artifacts.frozen', { changeId: change.id, gate, keys: frozenKeys })
    }
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
    this.pushNotice(`负责人已批准 ${gate}${approveG1Too ? '（同时批准 G1，standard 合并确认）' : ''}，当前阶段 ${change.stage}。`)
    return {
      gate,
      passed: true,
      items: change.gates[gate]?.items ?? [],
      failures: [],
      stage: change.stage,
      message: `已批准 ${gate}${approveG1Too ? '（与 G1 合并确认）' : ''}，进入 ${change.stage}。`,
    }
  }

  /**
   * 负责人覆盖自动流程路由（v0.5）：/flow route <full|standard|fast> <理由>。
   *
   * auto-review 给出的是建议；负责人始终可以强制切换，但 fast 仍受“低复杂度 + 普通风险”
   * 的硬约束，避免通过覆盖把高风险需求变成无人确认。
   */
  async setFlowRoute(route: FlowRoute, reason: string): Promise<string> {
    const change = this.requireChange()
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    if (!reason.trim()) throw new FlowGateError('切换自动流程路由必须写理由', '用法：/flow route <full|standard|fast> <理由>')
    if (!['S0', 'S1', 'S2', 'S3'].includes(change.stage)) {
      throw new FlowGateError('自动流程路由只能在进入执行前调整', '当前已进入 S4/S5/S6；如需更严格流程请暂停后新建变更。')
    }
    const awaitingGate = (Object.entries(change.gates) as [GateId, GateRecord][]).find(([, record]) => record.state === 'awaiting')?.[0]
    if (awaitingGate !== undefined) {
      throw new FlowGateError(`当前等待批准的 ${awaitingGate} 尚未处理`, '先批准或退回当前门，再切换自动流程路由，避免留下过期授权卡片。')
    }
    if (route === 'fast' && (change.complexity !== 'low' || change.risk !== 'normal')) {
      throw new FlowGateError(
        'fast 自动流程只适用于低复杂度 · 普通风险',
        '先用 /flow complexity、/flow risk-level 调整等级；复杂或高风险需求请保持 standard/full。',
      )
    }
    if (route === 'standard' && (change.complexity === 'high' || change.complexity === 'ultra' || change.risk === 'high')) {
      throw new FlowGateError('standard 只适用于低/中复杂度 · 普通风险', '复杂或高风险需求必须走 full（全部人工门）。')
    }
    const now = isoNow(this.clock)
    const previous = change.flowPlan
    const autoApprove = route === 'fast'
    change.flowPlan = {
      route,
      proposedRoute: previous?.proposedRoute ?? route,
      autoApprove,
      proposedAutoApprove: previous?.proposedAutoApprove ?? autoApprove,
      verdict: 'adjusted',
      complexity: change.complexity,
      risk: change.risk,
      checks: previous?.checks ?? [],
      reasons: [...(previous?.reasons ?? []), `负责人覆盖路由：${reason}`],
      assessedAt: now,
      assessedBy: 'owner-override',
    }
    await this.appendLedger('flow.route_override', { changeId: change.id, route, reason, from: previous?.route })
    await this.saveChange(change)
    this.pushNotice(`负责人已把自动流程改为 ${this.flowRouteLabel(route)}。`)
    return `自动流程已改为 ${this.flowRouteLabel(route)}；理由：${reason}。${autoApprove ? '后续 G1/G3/G6 检查通过后将自动通过。' : '仍保留人工确认。'}`
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
    // M-16 数据源：审批时写入总数与已交付数，后续按已交付回写刷新事件。
    const entries = this.roadmapDoc?.entries ?? []
    const delivered = entries.filter((entry) => entry.status === '已交付').length
    await this.appendLedger('roadmap.approved', { changeId: change.id, total: entries.length, delivered })
  }

  /**
   * 回写路线图条目状态（T2.7）：按 `change.roadmap` 找到表格行，替换状态列。
   * 纯文本行替换，保留负责人的表格格式与其它列。
   */
  private async updateRoadmapStatus(change: ChangeStatus, status: string): Promise<void> {
    const ref = change.roadmap
    if (!ref || !this.roadmapDoc) return
    const layout = store.layout(this.root)
    if (!(await this.fs.exists(layout.roadmap))) return
    try {
      const raw = await this.fs.readFile(layout.roadmap)
      const lines = raw.split('\n')
      let changed = false
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        if (!line.trim().startsWith('|')) continue
        const cells = line.split('|')
        // | 变更 | 能力 | ... | 状态 | → cells[1] 是变更编号，倒数第二个是状态
        const changeCell = (cells[1] ?? '').replace(/`/g, '').trim()
        if (changeCell !== ref) continue
        if (cells.length < 4) continue
        const statusIndex = cells.length - 2
        if (cells[statusIndex]!.trim() === status) continue
        const leading = cells[statusIndex]!.startsWith(' ') ? ' ' : ''
        cells[statusIndex] = `${leading}${status} `
        lines[index] = cells.join('|')
        changed = true
      }
      if (changed) {
        await this.fs.writeFile(layout.roadmap, lines.join('\n'))
        this.roadmapDoc = await this.loadRoadmapDoc()
        await this.appendLedger('change.updated', { changeId: change.id, roadmapRef: ref, roadmapStatus: status })
        // M-16：每次路线图状态回写后刷新 M-16 数据源（总数 / 已交付数）。
        const entries = this.roadmapDoc?.entries ?? []
        const delivered = entries.filter((entry) => entry.status === '已交付').length
        await this.appendLedger('roadmap.progress', { changeId: change.id, total: entries.length, delivered })
      }
    } catch {
      // 路线图回写失败不影响归档主流程；下一轮 GR 修订仍是权威来源。
    }
  }

  /**
   * 把 `tasks.md` 末尾的执行计划物化到运行时状态（T2.9）：
   * G3 检查通过、等负责人批准时就要有 tasks/batches，批准卡片才能显示执行图；
   * 进入 S4 复用它而不是重置（避免丢了批准前展示的同一份计划）。
   */
  private materializePlan(change: ChangeStatus): void {
    const tasks = this.getTasks()
    if (tasks.length === 0) return
    const plan = this.getPlan()
    change.plan = plan
    if (!change.batches || change.batches.length === 0) {
      change.batches = plan.batches.map<BatchState>((batch) => ({
        id: batch.batch,
        mode: batch.mode,
        status: 'pending',
        tasks: batch.tasks,
      }))
    }
    for (const task of tasks) {
      if (change.tasks[task.id] !== undefined) continue
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
  }

  private async onEnterS4(change: ChangeStatus): Promise<void> {
    const tasks = this.getTasks()
    if (tasks.length === 0) return
    this.materializePlan(change)
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
    const planMd = renderExecutionPlanMarkdown(change.plan ?? this.getPlan(), change)
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
      // T2.3：test: none 的项目改用 build / lint / typecheck 作基线；这些命令必须
      // 由插件真实执行并落回执，G2 的 g2.baseline 会核对回执而不是只看字段存在。
      const merged = { ...this.config.commands, ...(this.project?.commands ?? {}) }
      for (const key of ['build', 'lint', 'typecheck'] as const) {
        const baselineCommand = merged[key]
        if (!baselineCommand || baselineCommand === 'none') continue
        try {
          await this.runProjectCommand(baselineCommand, key, `baseline-${key}`, this.baselineInputs())
        } catch (error) {
          this.pushNotice(`${key} 基线命令执行失败：${(error as Error).message}`)
        }
      }
      change.baseline = {
        commit: null,
        summary: { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
        recordedAt: isoNow(this.clock),
      }
      // T2.3：没有自动化测试的项目自动登记「缺少自动化测试」风险（G3 会检查）。
      const existing = change.pending.find((item) => item.status === 'open' && item.data?.trigger === 'test-none')
      if (!existing) {
        const item = this.createPending(change, {
          kind: 'risk',
          title: '缺少自动化测试（test: none）',
          detail: '项目没有可执行的测试命令：基线改用构建/类型检查/lint；请在 risk.md 登记该风险并给出人工验证方式。',
          data: { trigger: 'test-none' },
        })
        await this.appendLedger('risk.raised', { changeId: change.id, pendingId: item.id, trigger: 'test-none' })
        this.pushNotice(`已自动登记风险 ${item.id}：项目没有自动化测试。G3 要求在 risk.md 里登记该风险。`)
      }
      return
    }
    const commit = this.git ? await this.git.head(this.root).catch(() => null) : null
    const layout = store.layout(this.root)
    const cachePath = posixJoin(layout.stateDir, 'baseline.json')
    // T2.3：同一提交号复用基线，避免每个变更都重跑全量测试。
    if (commit !== null && (await this.fs.exists(cachePath))) {
      try {
        const cache = JSON.parse(await this.fs.readFile(cachePath)) as {
          commit?: string
          summary?: ChangeStatus['baseline'] extends { summary: infer S } ? S : never
          recordedAt?: string
        }
        if (cache.commit === commit && cache.summary !== undefined) {
          change.baseline = {
            commit,
            summary: cache.summary as NonNullable<ChangeStatus['baseline']>['summary'],
            recordedAt: cache.recordedAt ?? isoNow(this.clock),
          }
          await this.appendLedger('verify.receipt', { changeId: change.id, baseline: true, reused: true, commit })
          this.pushNotice(`基线复用：提交 ${commit.slice(0, 8)} 已有基线记录（通过 ${change.baseline.summary.passed}）。`)
          return
        }
      } catch {
        // 缓存损坏：重新跑基线。
      }
    }
    const receipt = await this.runProjectCommand(command, 'test', 'baseline', this.baselineInputs())
    change.baseline = {
      commit,
      summary: receipt.summary ?? { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
      recordedAt: isoNow(this.clock),
      receiptId: receipt.id,
    }
    if (commit !== null) {
      try {
        await this.fs.mkdir(layout.stateDir)
        await this.fs.writeFile(
          cachePath,
          `${JSON.stringify({ commit, summary: change.baseline.summary, recordedAt: change.baseline.recordedAt })}\n`,
        )
      } catch {
        // 缓存写失败不影响本次基线。
      }
    }
    await this.appendLedger('verify.receipt', { changeId: change.id, baseline: true, evidenceId: receipt.id })
  }

  private baselineInputs(): string[] {
    return ['**/*', '!**/node_modules/**', '!**/target/**', '!**/build/**', '!**/dist/**', '!**/.git/**']
  }

  // ------------------------------------------------------------------
  // Clarify interview capture (T2.2)
  // ------------------------------------------------------------------

  /**
   * 记录一次 `ask_user_question` 问答（T2.2）：追加到 clarify.md 的「问答记录」
   * 表格 + 写 `clarify.asked` / `clarify.answered` 账本，供 M-7 与 G1 检查使用。
   *
   * `changed` 留空时写入「（待补充）」——G1 会要求每一行都写清「这个回答改变了什么」。
   */
  async recordClarifyQA(input: {
    question: string
    options?: string[]
    answer: string
    changed?: string
    round?: number
  }): Promise<{ recorded: boolean; duplicate: boolean; round: number }> {
    const change = this.requireChange()
    const question = input.question.trim()
    const answer = input.answer.trim()
    if (question === '') return { recorded: false, duplicate: false, round: 0 }
    const paths = store.changePaths(this.root, change.id)
    const raw = (await this.fs.exists(paths.clarify)) ? await this.fs.readFile(paths.clarify) : `# 澄清记录：${change.title}\n\n## 问答记录\n\n`
    const existingRows = raw.split('\n').filter((line) => line.trim().startsWith('|') && line.includes(question.slice(0, Math.min(20, question.length))))
    if (existingRows.length > 0) return { recorded: false, duplicate: true, round: 0 }
    const round = input.round ?? Math.max(1, raw.split('\n').filter((line) => /^\|\s*[^|]+\s*\|/.test(line)).length)
    const cell = (value: string): string => value.replace(/\|/g, '\\|')
    const row = `| ${cell(question)} | ${cell((input.options ?? []).join(' / '))} | ${cell(answer === '' ? '（未记录）' : answer)} | ${cell(input.changed ?? '（待补充）')} | ${round} |`
    await this.fs.writeFile(paths.clarify, appendClarifyQaRow(raw, row))
    await this.appendLedger('clarify.asked', { changeId: change.id, round, question })
    await this.appendLedger('clarify.answered', { changeId: change.id, round, question, answered: answer !== '' })
    // M-7 数据源：把已记录的最大轮次写回变更状态（此前 clarifyRounds 恒为 0）。
    change.clarifyRounds = Math.max(change.clarifyRounds ?? 0, round)
    await this.saveChange(change)
    await this.reloadArtifacts()
    return { recorded: true, duplicate: false, round }
  }

  // ------------------------------------------------------------------
  // Skill receipts (T2.4)
  // ------------------------------------------------------------------

  /** 阶段核心技能的必读回执（G3 前必须加载过）。 */
  static readonly REQUIRED_SKILLS: Partial<Record<GateId, string[]>> = {
    G1: ['flow-clarify'],
    G3: ['flow-plan'],
  }

  /** 本会话已加载过的技能名（用于「不重复注入/重复加载只提示已加载」）。 */
  private loadedSkills = new Set<string>()

  /** 记录一次技能加载（宿主在 skill 工具成功后调用）。重复加载返回 duplicate。 */
  async recordSkillLoaded(name: string, hash = ''): Promise<{ duplicate: boolean; receipt?: NonNullable<ChangeStatus['skillReceipts']>[number] }> {
    const change = this.current
    const trimmed = name.trim()
    if (!change || trimmed === '') return { duplicate: false }
    const existing = (change.skillReceipts ?? []).find(
      (receipt) => receipt.name === trimmed && (this.sessionId === undefined || receipt.sessionId === this.sessionId),
    )
    if (existing) {
      this.loadedSkills.add(trimmed)
      return { duplicate: true, receipt: existing }
    }
    const receipt = { name: trimmed, hash, at: isoNow(this.clock), sessionId: this.sessionId }
    change.skillReceipts = [...(change.skillReceipts ?? []), receipt]
    this.loadedSkills.add(trimmed)
    await this.appendLedger('skill.loaded', { changeId: change.id, name: trimmed, hash, duplicate: false })
    await this.saveChange(change)
    return { duplicate: false, receipt }
  }

  /** 本变更是否已加载过指定技能（按名字前缀归一：flow-plan / FlowGate flow-plan 都算）。 */
  hasSkillReceipt(name: string): boolean {
    const change = this.current
    if (!change) return false
    const wanted = name.trim().toLowerCase()
    return (change.skillReceipts ?? []).some((receipt) => {
      const loaded = receipt.name.toLowerCase()
      return loaded === wanted || loaded.endsWith(wanted) || loaded.includes(`${wanted}:`) || loaded.includes(`/${wanted}`)
    })
  }

  /** 本会话是否已加载过该技能（宿主用于重复加载只回「已加载」提示）。 */
  skillLoadedThisSession(name: string): boolean {
    return this.loadedSkills.has(name.trim()) || this.hasSkillReceipt(name)
  }

  private async ensureFullSuite(change: ChangeStatus): Promise<void> {
    const commands = this.config.commands
    const command = commands.integration || commands.test
    if (command && command !== 'none') {
      if (!this.runner) throw new FlowGateError('宿主没有提供命令执行器', '运行 /flow doctor 查看缺失接口')
      // T4.2：全量测试必须用 runFullSuite 跑，才能把 regressions 写进回执，
      // G5 的 g5.fullTests 与 M-12 才有可判定的基线对比结果。
      this.evidenceCounter += 1
      const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
      const baseline = change.baseline
        ? { commit: change.baseline.commit, summary: change.baseline.summary, receipts: [], failedTests: [] }
        : undefined
      const receipt = await runFullSuite({
        fs: this.fs,
        root: this.root,
        runner: this.runner,
        change,
        command,
        inputs: this.baselineInputs(),
        baseline,
        clock: this.clock,
        nextEvidenceId: () => id,
      })
      await this.appendReceipt(receipt)
      await this.appendLedger('verify.receipt', {
        changeId: change.id,
        evidenceId: receipt.id,
        group: receipt.group,
        phase: receipt.phase,
        kind: receipt.kind,
        summary: receipt.summary,
        regressions: receipt.summary?.regressions ?? [],
      })
      if (receipt.summary?.regressions !== undefined && receipt.summary.regressions.length > 0) {
        this.pushNotice(`全量测试出现 ${receipt.summary.regressions.length} 个回归，G5 不能通过。`)
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
          unlock: '等待负责人在授权卡片上修复（从账本重建状态后解除锁定）。',
        },
        message: 'FlowGate 锁定：拒绝写入（R-LOCKED）。解除：等待负责人在授权卡片上修复。',
      }
    }
    const change = this.current
    // 负责人对本变更临时关闭门禁（旧语义）：全部放行。
    if (change?.off) return { effect: 'allow', message: '' }
    // 项目级暂停（v0.5.1）：写操作放行，但 `.flowgate/**`、`.git/**` 仍受保护，
    // 否则 agent 可以自己解除暂停、改账本或篡改状态。
    if (this.flags.off !== undefined) {
      const protectedTarget = this.protectedWriteTarget(action)
      if (protectedTarget !== undefined) {
        return {
          effect: 'deny',
          rule: {
            ruleId: 'R-PROTECTED',
            decision: 'deny',
            why: `项目门禁处于暂停状态（${this.flags.off.reason}），但 ${protectedTarget} 属于插件状态/git 内部，仍不允许 agent 写。`,
            unlock: '用 flow_* 工具修改状态；恢复门禁用 /flow on。',
          },
          message: '拒绝：受保护路径（R-PROTECTED，项目暂停期间仍拦截）。用 flow_* 工具修改状态。',
        }
      }
      return { effect: 'allow', message: '', notes: ['项目门禁已暂停：写操作放行'] }
    }
    // 已被其它会话接管的旧会话：写操作一律拒绝（T3.7 验收 #2）。
    if (change) {
      await this.refreshForeignLease()
      if (this.foreignLease && this.foreignLease.changeId === change.id) {
        const decision: Decision = {
          effect: 'deny',
          rule: {
            ruleId: 'R-LEASE',
            decision: 'deny',
            why: `变更 ${change.id} 已被会话 ${this.foreignLease.sessionId} 接管：本会话的写操作会破坏租约与证据链。`,
            unlock: '本会话只做只读查看；要继续写请在新会话里操作，或由负责人确认旧会话已停止后重新 --takeover。',
          },
          message: `拒绝：变更已被其它会话接管（R-LEASE）。`,
        }
        await this.logDenied(change, decision, action)
        return decision
      }
    }
    // 成本预算触发（03 §8.2）：token 用量超过复杂度预算 → 负责人确认前拒绝写操作。
    if (change) {
      const budgetPending = change.pending.find(
        (item) => item.kind === 'risk' && item.status === 'open' && item.data?.trigger === 'token-budget',
      )
      if (budgetPending) {
        const decision: Decision = {
          effect: 'deny',
          rule: {
            ruleId: 'R-BUDGET',
            decision: 'deny',
            why: `本变更 token 用量 ${change.tokenUsage ?? 0} 已超过预算，已暂停并转人工（${budgetPending.id}）。`,
            unlock: '等待负责人在授权卡片上确认继续（' + budgetPending.id + '），或暂停本会话。',
          },
          message: `拒绝：token 预算已超（R-BUDGET，待处理 ${budgetPending.id}）。`,
        }
        await this.logDenied(change, decision, action)
        return decision
      }
    }

    if (!change) {
      // 受保护路径（.git / 密钥 / 插件状态）任何模式都拒绝；文件动作与 shell 写目标都查。
      const protectedTarget = this.protectedWriteTarget(action)
      if (protectedTarget !== undefined) {
        return {
          effect: 'deny',
          rule: { ruleId: 'R-PROTECTED', decision: 'deny', why: 'FlowGate 状态与 git 内部文件不允许 agent 直接写。', unlock: '用 flow_* 工具修改状态。' },
          message: '拒绝：受保护路径（R-PROTECTED）。用 flow_* 工具修改状态。',
        }
      }
      // 修复通道（v0.5.1）：bugfix 是一等公民。已声明 scope 内自由迭代，
      // 用 RED→GREEN 证据关门；不需要七阶段、不逐动作等人工。
      if (this.activeRepair !== null) {
        return this.evaluateRepairAction(this.activeRepair, action)
      }
      // 无修复、无变更：按接管模式处理。
      const mutating = mutatesRepository(action)
      if (!mutating) return { effect: 'allow', message: '', notes: ['尚未立项：只读动作放行'] }
      if (this.takeover === 'observe') {
        await this.recordTakeoverObserved(action)
        return {
          effect: 'allow',
          message: '',
          notes: ['观察模式（takeover=observe）：未立项的改动已放行，并记入账本一次（每会话每规则至多一次）'],
        }
      }
      if (this.takeover === 'off') {
        return { effect: 'allow', message: '', notes: ['接管已关闭（takeover=off）：不拦截也不记录'] }
      }
      // 接管原则：FlowGate 启用后，任何会改变仓库的动作都必须挂在一个已立项的
      // 变更（或修复声明）上，否则会绕过阶段门、范围控制、证据链与审查。
      return {
        effect: 'deny',
        rule: {
          ruleId: 'R-NO-CHANGE',
          decision: 'deny',
          why: 'FlowGate 已启用但当前没有进行中的变更：所有代码/文件/命令改动必须由 FlowGate 接管。',
          unlock:
            '若这是修复：用 flow_fix_start 开修复通道（推荐）；若是新功能：flow_new_change 立项（含 assessment）。立项前先评估改动规模，在 assessment 里声明 route/autoApprove/clear/acceptance/scope/verify；简单需求可由 auto-review 自动放行。',
        },
        message: '拒绝：FlowGate 已启用但未立项（R-NO-CHANGE）。修复用 flow_fix_start；新功能用 flow_new_change 立项。',
      }
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

    // 已批准产物冻结：agent 直接改 `.flowgate/changes/<id>/<产物>.md` 一律拒绝，
    // 必须走返工/新建变更（T2.1/T2.5/T3.1 验收）。
    const frozenTarget = 'path' in action && typeof action.path === 'string' ? action.path : undefined
    if (frozenTarget) {
      const frozen = store.assertNotFrozen(change, frozenTarget)
      if (frozen.frozen) {
        const decision: Decision = {
          effect: 'deny',
          rule: {
            ruleId: 'R-FROZEN-ARTIFACT',
            decision: 'deny',
            why: frozen.hint ?? '已批准产物已冻结，不能直接修改。',
            unlock: '走返工流程解除冻结（重新声明返工范围），或新建关联变更。',
          },
          message: `拒绝：已批准产物已冻结（R-FROZEN-ARTIFACT）。${frozen.hint ?? ''}`,
        }
        await this.logDenied(change, decision, action)
        return decision
      }
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
      config: this.configFor(change),
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

  /**
   * 找出会写到 `.flowgate/` 或 `.git/` 的目标（文件动作或 shell 写目标）。
   * 这些路径在任何「放行」模式（项目暂停 / 修复通道 / observe）下仍然拒绝。
   */
  private protectedWriteTarget(action: Action): string | undefined {
    const paths: string[] = []
    if ('path' in action && typeof (action as FileAction).path === 'string') {
      const file = action as FileAction
      if (file.kind !== 'read') {
        paths.push(normalizeRelPath(file.path))
        if (file.kind === 'rename' && file.toPath !== undefined) paths.push(normalizeRelPath(file.toPath))
      }
    }
    if (action.kind === 'shell') {
      for (const target of extractWriteTargets(action.command)) paths.push(normalizeRelPath(target))
    }
    return paths.find((path) => path !== '' && (isUnder(path, '.flowgate') || isUnder(path, '.git')))
  }

  /** 修复通道的动作判定（无 current change 时）：范围/命令策略 + 审计计数。 */
  private async evaluateRepairAction(repair: RepairRecord, action: Action): Promise<Decision> {
    const scopeHint =
      '修复通道只允许改声明过的范围（scope）；需要扩范围请 flow_fix_abort 后重新 flow_fix_start（写清 scope），或改用 flow_new_change 立项。'
    if (action.kind === 'read' || action.kind === 'other') {
      return { effect: 'allow', message: '', notes: [`修复通道 ${repair.id}：只读/flow_* 动作放行`] }
    }
    if (action.kind === 'delegate' || action.kind === 'mcp') {
      this.noteRepairDenied('R-FIX-TOOL')
      return {
        effect: 'deny',
        rule: {
          ruleId: 'R-FIX-TOOL',
          decision: 'deny',
          why: `修复通道只允许文件编辑、只读动作与测试/构建类 shell；${action.kind}（${action.tool}）不在允许范围内。`,
          unlock: '修复通道内不派发子 agent、不调 MCP、不改依赖/不推送；需要这些请完成修复后走 flow_new_change。',
        },
        message: `拒绝：修复通道不允许 ${action.kind}（R-FIX-TOOL）。`,
      }
    }
    if (action.kind === 'shell') {
      const verdict = classifyRepairShellCommand(action.command)
      if (!verdict.allowed) {
        this.noteRepairDenied('R-FIX-SHELL')
        const decision: Decision = {
          effect: 'deny',
          rule: {
            ruleId: 'R-FIX-SHELL',
            decision: 'deny',
            why: `修复通道不允许该 shell 命令：${verdict.reason ?? '不在允许范围内'}`,
            unlock:
              '修复通道只允许测试/构建/lint/typecheck/run 类命令与只读/提交类 git（git status/diff/log/add/commit/rev-parse/stash）；危险命令（rm -rf、git push、git reset --hard、npm publish、curl/wget、ssh、chmod/chown、mkfs 等）一律拒绝。',
          },
          message: `拒绝：修复通道不允许该命令（R-FIX-SHELL）：${verdict.reason ?? ''}`,
        }
        return decision
      }
      return { effect: 'allow', message: '', notes: [`修复通道 ${repair.id}：允许的 shell 命令`] }
    }
    // write / create / delete / rename
    const file = action as FileAction
    const targets = [normalizeRelPath(file.path)]
    if (file.kind === 'rename' && file.toPath !== undefined) targets.push(normalizeRelPath(file.toPath))
    const outside = targets.filter((target) => target === '' || !matchesScope(target, repair.scope))
    if (outside.length > 0) {
      this.noteRepairDenied('R-FIX-SCOPE')
      return {
        effect: 'deny',
        rule: {
          ruleId: 'R-FIX-SCOPE',
          decision: 'deny',
          why: `修复通道 ${repair.id}「${repair.title}」只允许改声明范围：${repair.scope.join('、')}；${outside.join('、')} 不在范围内。`,
          unlock: scopeHint,
        },
        message: `拒绝：修复通道范围外（R-FIX-SCOPE）：${outside.join('、')}。${scopeHint}`,
      }
    }
    repair.actions += 1
    try {
      await store.writeActiveRepair(this.fs, this.root, repair)
    } catch {
      // 计数持久化失败不阻断修复动作。
    }
    return { effect: 'allow', message: '', notes: [`修复通道 ${repair.id}：已放行并计数（actions=${repair.actions}）`] }
  }

  /** 修复通道拒绝计数（无 C-xxx 变更，不写 rule.denied 账本；host guard 负责拦截日志）。 */
  private noteRepairDenied(ruleId: string): void {
    this.interceptCounts[ruleId] = (this.interceptCounts[ruleId] ?? 0) + 1
  }

  /** 观察模式：每会话每规则至多写一次 `takeover.observed` + 提示。 */
  private async recordTakeoverObserved(action: Action): Promise<void> {
    const ruleId = 'R-NO-CHANGE'
    if (this.observedTakeover.has(ruleId)) return
    this.observedTakeover.add(ruleId)
    const rawTarget =
      'path' in action ? (action as { path?: string }).path : 'command' in action ? (action as { command?: string }).command : undefined
    await this.appendLedger('takeover.observed', {
      mode: 'observe',
      ruleId,
      tool: action.tool,
      target: rawTarget !== undefined ? redactSecrets(rawTarget) : undefined,
    })
    this.pushNotice('观察模式（takeover=observe）：检测到未立项的仓库改动，已放行并记入账本（本会话每规则只记一次）。恢复硬接管：负责人调整 takeover 配置，或修复自举后重启。')
  }

  private async logDenied(change: ChangeStatus, decision: Decision, action: Action): Promise<void> {
    const ruleId = decision.rule?.ruleId ?? 'unknown'
    this.interceptCounts[ruleId] = (this.interceptCounts[ruleId] ?? 0) + 1
    const rawTarget =
      'path' in action ? (action as { path?: string }).path : 'command' in action ? (action as { command?: string }).command : undefined
    await this.appendLedger('rule.denied', {
      changeId: change.id,
      ruleId,
      tool: action.tool,
      // 命令文本可能含密钥（T4.1 验收）：写账本前统一脱敏。
      target: rawTarget !== undefined ? redactSecrets(rawTarget) : undefined,
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
          `已存在阻断项 ${existing.id}（${existing.title}），等待负责人在授权卡片上处理后重试即可，不要重复申请`,
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
      item.detail = `${item.detail}\n等待负责人在授权卡片上确认后解锁（只读取证与 flow_status/flow_report_risk 不受限）。`
      await this.appendLedger('rule.human', { changeId: change.id, pendingId: item.id, ruleId: decision.rule?.ruleId })
      this.pushNotice(`需要负责人确认：${item.id}（${item.title}）。等待负责人在授权卡片上处理后继续。`)
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
    const limit = this.configFor(change).triggers.consecutive_failure_limit
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
    item.detail = `${item.detail}\n等待负责人在授权卡片上确认后解锁（可只读诊断、查状态、上报风险）。`
    await this.appendLedger('task.blocked', {
      changeId: change.id,
      taskId,
      reason: 'consecutive-failures',
      pendingId: item.id,
    })
    this.pushNotice(
      `任务 ${taskId} 连续 ${failureCount} 次验证失败已熔断（${item.id}）：只读动作仍放行，等待负责人在授权卡片上处理后继续。`,
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

  async recordPostcheck(input: {
    origin: 'agent' | 'external' | 'unknown'
    changedPaths: string[]
    taskId?: string
    /** 本次调用后消失（删除）的路径；用于「删除受控文件提风险」。 */
    deletedPaths?: string[]
  }): Promise<Violation[]> {
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
    if (input.origin === 'agent') {
      await this.escalateDeletedTrackedFiles(change, task, input.deletedPaths ?? [])
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

  /**
   * 撤销（`git checkout -- <file>`）后自动解除越界（T1.4 验收 #2）。
   * 宿主事后检测把「本次调用后已回到干净状态」的路径传进来。
   */
  async clearViolationsForReverted(paths: string[]): Promise<string[]> {
    const change = this.current
    if (!change || paths.length === 0) return []
    const normalized = new Set(paths.map((path) => normalizeRelPath(path)))
    const cleared: string[] = []
    const now = isoNow(this.clock)
    for (const violation of change.violations) {
      if (violation.clearedAt !== undefined || !normalized.has(violation.path)) continue
      violation.clearedAt = now
      cleared.push(violation.path)
      await this.appendLedger('violation.cleared', {
        changeId: change.id,
        path: violation.path,
        violationId: violation.id,
        reason: 'reverted',
      })
    }
    if (cleared.length > 0) {
      await this.saveChange(change)
      this.pushNotice(`已撤销的文件自动解除越界：${cleared.join('、')}。`)
    }
    return cleared
  }

  /**
   * 负责人确认非 agent 改动（T1.4 验收 #3 / G6 单列确认）。
   * 不传 paths 时确认全部；返回确认条数。
   */
  async acknowledgeExternalChanges(paths?: string[]): Promise<number> {
    const change = this.current
    if (!change || !change.externalChanges || change.externalChanges.length === 0) return 0
    const now = isoNow(this.clock)
    const normalized = paths !== undefined && paths.length > 0 ? new Set(paths.map((path) => normalizeRelPath(path))) : null
    let count = 0
    for (const entry of change.externalChanges) {
      if (entry.confirmedAt !== undefined) continue
      if (normalized && !normalized.has(entry.path)) continue
      entry.confirmedAt = now
      count += 1
    }
    if (count > 0) {
      await this.appendLedger('external.acknowledged', { changeId: change.id, count, paths: paths ?? 'all' })
      await this.saveChange(change)
      this.pushNotice(`负责人已确认 ${count} 处非 agent 改动。`)
    }
    return count
  }

  /** 记录篡改嫌疑（跳过测试/删断言/改测试基础设施），生成 TM-n 待处理项（T3.5）。 */
  async recordTamperSignals(signals: TamperSignal[], origin = 'postcheck'): Promise<PendingItem | null> {
    const change = this.current
    if (!change || signals.length === 0) return null
    const open = change.pending.find((item) => item.kind === 'tamper' && item.status === 'open')
    if (open) {
      const existing = (open.data?.signals as TamperSignal[] | undefined) ?? []
      const seen = new Set(existing.map((signal) => `${signal.kind}\u0000${signal.path}`))
      const merged = [...existing]
      for (const signal of signals) {
        const key = `${signal.kind}\u0000${signal.path}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(signal)
      }
      open.data = { ...(open.data ?? {}), signals: merged }
      await this.saveChange(change)
      return open
    }
    const detail = signals.map((signal) => `${signal.detail}（${signal.kind}）`).join('\n')
    const item = this.createPending(change, {
      kind: 'tamper',
      title: '疑似篡改测试/门禁配置',
      detail,
      data: { signals, origin },
    })
    await this.appendLedger('tamper.detected', {
      changeId: change.id,
      pendingId: item.id,
      signals: signals.map((signal) => ({ kind: signal.kind, path: signal.path })),
    })
    await this.saveChange(change)
    this.pushNotice(`检测到疑似篡改（${item.id}）：${signals.slice(0, 3).map((signal) => signal.path).join('、')}。已进入审查输入与 G6 清单。`)
    return item
  }

  // ------------------------------------------------------------------
  // Citation freshness (T2.10)
  // ------------------------------------------------------------------

  /** G1/G2 通过时核验产物里的源码引用并持久化文件哈希，供后续门检查待复核。 */
  async recordGateCitationChecks(change: ChangeStatus): Promise<number> {
    const refs = [
      ...documentCitations(change && this.artifacts.clarify ? this.artifacts.clarify : { raw: '' }),
      ...documentCitations(change && this.artifacts.context ? this.artifacts.context : { raw: '' }),
    ]
    if (refs.length === 0) return 0
    const now = isoNow(this.clock)
    const checks = await verifyCitations(this.fs, this.root, refs, now)
    const existing = change.citationChecks ?? []
    const byKey = new Map(existing.map((check) => [`${check.citation.file}:${check.citation.startLine}-${check.citation.endLine}`, check]))
    for (const check of checks) {
      byKey.set(`${check.citation.file}:${check.citation.startLine}-${check.citation.endLine}`, check)
    }
    change.citationChecks = [...byKey.values()]
    const stale = await citationsStale(this.fs, this.root, change.citationChecks)
    if (stale.length > 0) {
      await this.appendLedger('citation.stale', { changeId: change.id, count: stale.length, files: stale.map((check) => check.citation.file) })
    }
    return checks.length
  }

  /** 当前已核验引用里哪些文件的哈希已变（待复核）。 */
  async staleCitations(): Promise<Awaited<ReturnType<typeof citationsStale>>> {
    const change = this.current
    if (!change?.citationChecks || change.citationChecks.length === 0) return []
    return citationsStale(this.fs, this.root, change.citationChecks)
  }

  /** 审查/宿主读取：任务卡声明删除/重命名的原内容快照。 */
  originalSnapshots(taskId?: string): NonNullable<ChangeStatus['originalSnapshots']> {
    const list = this.current?.originalSnapshots ?? []
    return taskId === undefined ? list : list.filter((entry) => entry.taskId === taskId)
  }

  // ------------------------------------------------------------------
  // Risk-escalation & token budget (FR-6.6 / 03 §8.2)
  // ------------------------------------------------------------------

  /**
   * 风险提高为高风险的统一副作用（FR-6.6）：
   * - 已完成任务的审查按新标准重新要求：清空 reviewIds（测试回执保留），并生成
   *   RK 待处理项提醒负责人安排两轮审查；
   * - 已进入 S5/S6 的退回 S4（`riskRaisedEffects` 决定）。
   */
  private async applyRiskRaised(change: ChangeStatus, reason: string): Promise<void> {
    if (change.risk !== 'high') change.risk = 'high'
    const effects = riskRaisedEffects(change)
    for (const taskId of effects.refreezeReviews) {
      const task = change.tasks[taskId]
      if (task) task.reviewIds = []
    }
    const now = isoNow(this.clock)
    if (effects.backToStage !== undefined && change.stage !== effects.backToStage) {
      Object.assign(change, enterStage(change, effects.backToStage, now))
      await this.appendLedger('stage.entered', { changeId: change.id, stage: effects.backToStage, reason: 'risk-raised' })
    }
    if (effects.refreezeReviews.length > 0 || effects.backToStage !== undefined) {
      const item = this.createPending(change, {
        kind: 'risk',
        title: '风险提高：已完成任务的审查需按两轮标准重新要求',
        detail: `原因：${reason}。受影响任务：${effects.refreezeReviews.join('、') || '（无已完成任务）'}；测试回执保留。`,
        data: { trigger: 'risk-raised', tasks: effects.refreezeReviews, backToStage: effects.backToStage },
      })
      await this.appendLedger('risk.raised', {
        changeId: change.id,
        pendingId: item.id,
        tasks: effects.refreezeReviews,
        backToStage: effects.backToStage,
        reason,
      })
    }
    this.pushNotice(
      `风险提高为高风险：${effects.backToStage !== undefined ? `已退回 ${effects.backToStage}；` : ''}已完成任务（${effects.refreezeReviews.join('、') || '无'}）的审查按两轮标准重新要求（回执保留）。`,
    )
  }

  /**
   * 宿主上报本变更累计 token 用量（token-meter 的 tokenUsage 投影，取不到不调用）。
   * 超过复杂度预算时生成 RK 待处理项并把写操作切到 R-BUDGET，直到负责人批准。
   */
  async recordTokenUsage(total: number): Promise<void> {
    const change = this.current
    if (!change || !Number.isFinite(total) || total < 0) return
    const rounded = Math.round(total)
    if (change.tokenUsage === rounded) return
    change.tokenUsage = rounded
    const budget = this.configFor(change).limits.token_budget[change.complexity]
    const existing = change.pending.find(
      (item) => item.kind === 'risk' && item.status === 'open' && item.data?.trigger === 'token-budget',
    )
    if (budget > 0 && rounded > budget && !existing) {
      const item = this.createPending(change, {
        kind: 'risk',
        title: 'token 预算超支，已暂停转人工',
        detail: `本变更累计约 ${rounded} token，超过${complexityLabel(change.complexity)}复杂度预算 ${budget}。负责人确认后写操作恢复，或暂停本会话。`,
        data: { trigger: 'token-budget', used: rounded, budget },
      })
      item.detail = `本变更累计约 ${rounded} token，超过${complexityLabel(change.complexity)}复杂度预算 ${budget}。请在授权卡片上确认继续，或暂停本会话。`
      await this.appendLedger('budget.exceeded', { changeId: change.id, pendingId: item.id, used: rounded, budget })
      this.pushNotice(`token 预算超支：累计 ${rounded} / 预算 ${budget}。已暂停写操作，等负责人处理 ${item.id}。`)
    }
    await this.saveChange(change)
  }

  /** 删除受版本控制文件时把风险提高为高风险（T4.1 / 03 §5.6）。 */
  private async escalateDeletedTrackedFiles(change: ChangeStatus, task: TaskCard | undefined, deletedPaths: string[]): Promise<void> {
    if (deletedPaths.length === 0 || change.risk === 'high' || !this.git || !task) return
    const declared = (task.changes ?? []).filter((entry) => entry.kind === 'delete').map((entry) => normalizeRelPath(entry.path))
    for (const rawPath of deletedPaths) {
      const path = normalizeRelPath(rawPath)
      if (!declared.some((pattern) => pattern === path || matchGlob(pattern, path))) continue
      try {
        const original = await this.git.showFile(this.root, 'HEAD', path)
        if (original === null) continue
      } catch {
        continue
      }
      await this.applyRiskRaised(change, `删除受版本控制文件 ${path}`)
      return
    }
  }

  /**
   * 删除/重命名声明：从 git HEAD 取原内容快照存进变更目录（T3.1 / 03 §5.6）。
   * 取不到（git 端口缺失或命令失败）时阻塞任务开始，交负责人处理；未跟踪文件没有原文可保。
   */
  private async captureOriginalSnapshots(change: ChangeStatus, task: TaskCard): Promise<void> {
    const declared = (task.changes ?? []).filter((entry) => entry.kind === 'delete' || entry.kind === 'rename')
    if (declared.length === 0) return
    if (!this.git) {
      throw new FlowGateError(
        `任务 ${task.id} 声明了删除/重命名，但宿主没有 git 端口，无法保存原内容快照`,
        '删除/重命名需要 git 原内容交给审查；请让负责人手动处理，或去掉 changes 声明',
      )
    }
    const now = isoNow(this.clock)
    const snapshots = [...(change.originalSnapshots ?? [])]
    for (const entry of declared) {
      const path = normalizeRelPath(entry.path)
      let original: string | null
      try {
        original = await this.git.showFile(this.root, 'HEAD', path)
      } catch (error) {
        throw new FlowGateError(
          `无法从 git 取得 ${path} 的原内容：${(error as Error).message}`,
          'git 原内容快照是删除/重命名的审查输入；修复仓库状态后重试，或让负责人手动备份',
        )
      }
      if (original === null) continue
      const safeName = path.replace(/[\\/]/g, '__')
      const storedPath = posixJoin(
        store.changePaths(this.root, change.id).dir,
        'evidence',
        'original',
        task.id,
        safeName,
      )
      const dir = storedPath.slice(0, storedPath.lastIndexOf('/'))
      await this.fs.mkdir(dir)
      await this.fs.writeFile(storedPath, original)
      if (!snapshots.some((item) => item.taskId === task.id && item.path === path)) {
        snapshots.push({ taskId: task.id, path, kind: entry.kind, storedPath, at: now })
        await this.appendLedger('original.snapshot', { changeId: change.id, taskId: task.id, path, storedPath })
      }
    }
    change.originalSnapshots = snapshots
  }

  // ------------------------------------------------------------------
  // Tasks
  // ------------------------------------------------------------------

  async taskStart(taskId: string): Promise<TaskStartOutcome> {
    const change = this.requireChange()
    if (change.stage !== 'S4') {
      throw new FlowGateError(`当前阶段 ${change.stage} 不能开始任务`, 'S4 执行阶段才能领取任务；先用 flow_submit 完成当前门')
    }
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
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
    // 删除/重命名声明：先把 git 原内容快照落盘，审查与 G6 用它核对"删掉的是什么"。
    await this.captureOriginalSnapshots(change, task)
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
      tdd: !task.autoRepair && (task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.configFor(change).limits).tddRequiredAll),
    }
  }

  async taskDone(taskId: string): Promise<TaskDoneOutcome> {
    const change = this.requireChange()
    if (change.stage !== 'S4') throw new FlowGateError(`当前阶段 ${change.stage} 不能完成任务`, '只有 S4 执行阶段的任务可以提交')
    const task = this.getTask(taskId)
    if (!task) throw new FlowGateError(`没有任务 ${taskId}`, '在 FlowGate 面板查看任务列表')
    const taskState = change.tasks[taskId]
    if (!taskState) throw new FlowGateError(`任务 ${taskId} 未在执行计划中`, '重新提交 G3 后再试')
    if (taskState.status === 'done') throw new FlowGateError(`${taskId} 已经完成`, '无需重复提交')
    const failures: CheckOutcome[] = []
    const now = isoNow(this.clock)
    const level = levelProfile(change.complexity, change.risk, this.configFor(change).limits)
    // T4.9：并行任务在自己的 worktree 里执行，验证命令与输入哈希必须同样以
    // worktree 为根，否则回执描述的是主工作区而不是执行者的改动。
    const executionRoot = this.taskExecutionRoot(taskId)

    // 1. Fresh GREEN evidence for every verify group.
    for (const group of task.verify) {
      const groupReceipts = this.receipts
        .filter((receipt) => receipt.changeId === change.id && receipt.taskId === taskId && receipt.group === group.group)
        .sort(compareReceipts)
      const latest = groupReceipts[groupReceipts.length - 1]
      const inputs = await hashInputs(this.fs, executionRoot, group.inputs)
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
    if (this.config.review.enabled && this.config.review.requireForTaskGate) {
      const taskReviews = change.reviews.filter((review) => review.taskId === taskId)
      // 负责人豁免（waived）的记录不阻塞；critical/major 即使 verdict=pass 也不放行（T3.4）。
      const blocking = taskReviews.filter(
        (review) =>
          !review.waived && review.findings.some((finding) => finding.severity === 'critical' || finding.severity === 'major'),
      )
      if (blocking.length > 0) {
        failures.push({
          item: 'review:findings',
          label: `${taskId} 的审查还有 ${blocking.length} 条未处理的 critical / major`,
          passed: false,
          hint: `修复 findings 后重新审查；确属误报可由负责人 /flow review waive <RV-n> <理由> 豁免：${blocking
            .flatMap((review) =>
              review.findings
                .filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
                .map((finding) => `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''} ${finding.message}`),
            )
            .slice(0, 5)
            .join('；')}`,
        })
      }
      if (level.reviewRoundsPerTask > 0) {
        const reviews = taskReviews.filter((review) => review.verdict === 'pass' || review.waived)
        if (reviews.length < level.reviewRoundsPerTask) {
          failures.push({
            item: 'review',
            label: `${taskId} 需要 ${level.reviewRoundsPerTask} 轮审查`,
            passed: false,
            hint: '审查由插件在任务完成时自动触发；确认审查记录已通过后再 flow_task_done。若审查不可用，请联系负责人用 /flow review waive 明确豁免。',
          })
        }
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
    // T4.8：每完成一个任务生成交接摘要。
    try {
      await this.generateHandoff()
    } catch {
      // 交接摘要失败不影响任务完成。
    }
    let committed = false
    if (this.config.git.auto_commit && this.git) {
      try {
        await this.git.add(executionRoot, ['-A'])
        await this.git.commit(executionRoot, `flowgate(${change.id}/${taskId}): ${task.title}`)
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
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
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
        const limit = this.configFor(change).triggers.consecutive_failure_limit
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
            message: `批次 ${batch.batch} 的集成检查点连续失败 ${attempts} 次（上限 ${limit}），已转为负责人处理（${ownerConflict.id}）。修好后等待负责人在授权卡片上确认，再调用 flow_dispatch_next 重试。`,
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
        throw new FlowGateError(`任务 ${nextId} 被阻塞`, '先等待负责人在授权卡片上处理该任务的待处理项后再派发')
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
    // A2：成功任务不能被迟到的失败结算覆盖（派发宿主可能重复结算：执行者
    // 已经自行 flow_task_done，host finalize 再次调用 taskDone 抛错后转失败）。
    if (taskState.status === 'done') return
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
    await this.refreshReviewDoc()
    if (input.findings.some((finding) => finding.severity === 'critical')) {
      this.pushNotice(`审查发现 critical 问题（${review.id}），任务门不会通过，必须修复。`)
    }
    return review
  }

  /**
   * 负责人豁免一条审查记录（T3.4）：误报的 critical/major 不再阻塞任务门，
   * 豁免必须写理由并留在账本里（可审计）。
   */
  async waiveReview(reviewId: string, reason: string): Promise<ReviewRecord> {
    const change = this.requireChange()
    if (!reason.trim()) throw new FlowGateError('豁免审查必须写理由', '用法：/flow review waive <RV-n> <理由>')
    const review = change.reviews.find((item) => item.id === reviewId)
    if (!review) throw new FlowGateError(`没有审查记录 ${reviewId}`, '在 FlowGate 面板查看审查记录')
    if (review.waived === true) return review
    review.waived = true
    review.waivedReason = reason
    await this.appendLedger('review.waived', { changeId: change.id, reviewId, reason })
    await this.saveChange(change)
    await this.refreshReviewDoc()
    this.pushNotice(`审查记录 ${reviewId} 已被负责人豁免：${reason}`)
    return review
  }

  /**
   * 返工声明（T3.8）：按类型失效受影响任务的回执与审查，并解除产物冻结。
   * - defect：只失效指定任务及其下游（未指定时保守全失效），测试回执与审查作废；
   * - requirement：全部失效、回到 S1、解冻全部产物（需求/方案变了要重走澄清）；
   * - unknown：全部失效，阶段不变，解冻产物等负责人决定。
   */
  async declareRework(input: {
    kind: ReworkKind
    taskIds?: string[]
    sharedInputsChanged?: string[]
    reason: string
  }): Promise<{ invalidatedTasks: string[]; keptTasks: string[]; stage: StageId }> {
    const change = this.requireChange()
    if (!input.reason.trim()) throw new FlowGateError('返工声明必须写理由', '用法：/flow rework <defect|requirement|unknown> [任务...] <理由>')
    if (change.stage === 'archived') throw new FlowGateError('已归档的变更不能声明返工', '新建关联变更后返工')
    const tasks = this.getTasks()
    const dependsOn: Record<string, string[]> = {}
    for (const task of tasks) dependsOn[task.id] = task.dependsOn
    const outcome = invalidateOnRework(change, {
      kind: input.kind,
      taskIds: input.taskIds,
      sharedInputsChanged: input.sharedInputsChanged,
      dependsOn,
    })
    const invalidated = new Set(outcome.invalidatedTasks)
    for (const taskId of outcome.invalidatedTasks) {
      const state = change.tasks[taskId]
      if (!state) continue
      state.evidenceIds = []
      state.reviewIds = []
      state.tdd = 'none'
      state.redObserved = false
      state.failureCount = 0
      if (state.status === 'done' || state.status === 'failed' || state.status === 'blocked') state.status = 'pending'
      state.finishedAt = undefined
      state.startedAt = undefined
      const batch = change.batches.find((item) => item.id === state.batch)
      if (batch && batch.status === 'done') {
        batch.status = 'pending'
        batch.completedAt = undefined
        if (batch.checkpoint) batch.checkpoint = { ...batch.checkpoint, attempts: 0 }
      }
    }
    // 审查失效：缺陷返工只清受影响任务；需求/影响不明清全部（含终审/安全审查）。
    if (input.kind === 'requirement' || input.kind === 'unknown') {
      change.reviews = []
    } else {
      change.reviews = change.reviews.filter((review) => review.taskId === undefined || !invalidated.has(review.taskId))
    }
    // 产物冻结解除：需求/影响不明必须允许重写规格与计划；缺陷返工保留已批准产物。
    if (input.kind === 'requirement' || input.kind === 'unknown') {
      for (const key of store.unfreezeArtifacts(change)) {
        await this.appendLedger('artifact.unfrozen', { changeId: change.id, artifact: key, reason: input.kind })
      }
    }
    if (outcome.stage !== change.stage && input.kind === 'requirement') {
      const now = isoNow(this.clock)
      Object.assign(change, enterStage(change, 'S1', now))
      change.gates.G1 = { state: 'pending', attempts: 0 }
      change.gates.G2 = { state: 'pending', attempts: 0 }
      change.gates.G3 = { state: 'pending', attempts: 0 }
      change.plan = undefined
      change.tasks = {}
      change.batches = []
      change.frozen = {}
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S1', reason: 'rework-requirement' })
      this.pushNotice(`需求返工：已回到 S1，全部回执与审查失效、产物解冻；补齐澄清/规格后重新过 G1–G3。`)
    }
    await this.appendLedger('rework.declared', {
      changeId: change.id,
      kind: input.kind,
      invalidatedTasks: outcome.invalidatedTasks,
      keptTasks: outcome.keptTasks,
      reason: input.reason,
    })
    await this.saveChange(change)
    if (input.kind !== 'requirement') {
      this.pushNotice(`返工声明（${input.kind}）：失效任务 ${outcome.invalidatedTasks.join('、') || '无'}；保留任务 ${outcome.keptTasks.join('、') || '无'}。`)
    }
    return outcome
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
  /** 并行批次降级标注（worktree 不可用等）：执行图上显示降级原因（T4.9）。 */
  async markBatchDowngraded(batchId: string, reason: string): Promise<void> {
    const change = this.current
    if (!change) return
    const batch = change.batches.find((item) => item.id === batchId)
    if (!batch || batch.downgraded === reason) return
    batch.downgraded = reason
    await this.appendLedger('checkpoint.failed', { changeId: change.id, batch: batchId, note: `downgraded:${reason}` })
    await this.saveChange(change)
    this.pushNotice(`批次 ${batchId} 降级：${reason}。`)
  }

  /**
   * 集成检查点的验证部分（T4.9 验收 #3）：按任务卡逐个跑验证组，再跑全量测试；
   * 全通过才允许批次进入下一批。宿主在合并成功后调用（integration 命令额外再跑）。
   */
  async runCheckpointVerification(batchId: string): Promise<{ ok: boolean; detail: string; receiptIds: string[] }> {
    const change = this.current
    if (!change) return { ok: false, detail: '没有进行中的变更', receiptIds: [] }
    const batch = change.batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, detail: `没有批次 ${batchId}`, receiptIds: [] }
    const tasks = this.getTasks().filter((task) => batch.tasks.includes(task.id))
    const failures: string[] = []
    const receiptIds: string[] = []
    for (const task of tasks) {
      for (const group of task.verify) {
        try {
          const receipt = await this.runVerify({ taskId: task.id, group: group.group })
          receiptIds.push(receipt.id)
          if (receipt.exitCode !== 0) failures.push(`${task.id}/${group.group} 失败（exit=${receipt.exitCode}）`)
        } catch (error) {
          failures.push(`${task.id}/${group.group} 无法执行：${(error as Error).message}`)
        }
      }
    }
    const commands = this.configFor(change).commands
    const fullCommand = commands.integration ?? commands.test
    if (fullCommand !== undefined && fullCommand !== 'none') {
      try {
        const receipt = await this.runProjectCommand(fullCommand, 'test', 'checkpoint', this.baselineInputs())
        receiptIds.push(receipt.id)
        if (receipt.exitCode !== 0) failures.push(`全量测试失败（${fullCommand}，exit=${receipt.exitCode}）`)
      } catch (error) {
        failures.push(`全量测试无法执行：${(error as Error).message}`)
      }
    }
    await this.saveChange(change)
    return {
      ok: failures.length === 0,
      detail: failures.length === 0 ? `任务验证组与全量测试通过（${tasks.length} 个任务）` : failures.join('；'),
      receiptIds,
    }
  }

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
    if (!batch) throw new FlowGateError(`没有批次 ${batchId}`, '在 FlowGate 面板查看执行图')
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

    const limit = this.configFor(change).triggers.consecutive_failure_limit
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
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    // 修复通道（v0.5.1）：没有 C-xxx 变更时也允许由插件亲自跑验证命令，
    // 回执结构不变（changeId = FIX-id，落 .flowgate/state/evidence/），RED/GREEN 自动绑定。
    if (this.current === null && this.activeRepair !== null) {
      const command = request.command !== undefined && request.command.trim() !== '' ? request.command.trim() : this.activeRepair.verify
      const groupName = request.group.trim() === '' ? 'repair' : request.group.trim()
      const inputs = request.inputs !== undefined && request.inputs.length > 0 ? request.inputs : this.activeRepair.scope
      const receipt = await this.runRepairReceipt({ command, group: groupName, inputs, bind: true })
      this.hooks?.onEvidence?.(receipt)
      return receipt
    }
    const change = this.requireChange()
    let command = request.command
    let inputs = request.inputs
    let groupName = request.group
    let task: TaskCard | undefined
    if (request.taskId) {
      task = this.getTask(request.taskId)
      if (!task) throw new FlowGateError(`没有任务 ${request.taskId}`, '在 FlowGate 面板查看任务列表')
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
      cwd: task ? this.taskExecutionRoot(task.id) : this.root,
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
          (task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.configFor(change).limits).tddRequiredAll)
        if (!tddRequired || taskState.redObserved) taskState.tdd = 'green'
      }
      if (receipt.exitCode !== 0) {
        taskState.failureCount = (taskState.failureCount ?? 0) + 1
        const limit = this.configFor(change).triggers.consecutive_failure_limit
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

  /**
   * 记录一条运行证据（T4.2 验收 #2）：宿主启动 run 命令、轮询 health、采集日志后
   * 由宿主调用；回执 kind=`run`，G5 的 g5.runtime 读它。
   */
  async recordRunEvidence(input: {
    command: string
    ok: boolean
    detail: string
    logPath?: string
    health?: { url?: string; status?: number; ok: boolean }
  }): Promise<EvidenceReceipt> {
    const change = this.requireChange()
    this.evidenceCounter += 1
    const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
    const now = isoNow(this.clock)
    const healthNote = input.health
      ? `健康检查：${input.health.ok ? '通过' : '失败'}${input.health.url !== undefined ? ` ${input.health.url}` : ''}${input.health.status !== undefined ? ` → HTTP ${input.health.status}` : ''}`
      : '健康检查：未配置'
    const receipt: EvidenceReceipt = {
      id,
      changeId: change.id,
      group: 'runtime',
      kind: 'run',
      phase: input.ok ? 'green' : 'red',
      command: input.command,
      runBy: 'flowgate',
      exitCode: input.ok ? 0 : 1,
      summary: null,
      inputsHash: '',
      outputRef: input.logPath ?? '',
      startedAt: now,
      finishedAt: now,
      notes: `${healthNote}｜${input.detail}`,
    }
    await this.appendReceipt(receipt)
    await this.appendLedger('evidence.recorded', { changeId: change.id, evidenceId: id, kind: 'run', runBy: 'plugin' })
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
    if (!task) throw new FlowGateError(`没有任务 ${input.taskId}`, '在 FlowGate 面板查看任务列表')
    if (!input.add || input.add.length === 0) throw new FlowGateError('范围变更至少写一个路径', '用法：flow_request_scope_change({ taskId, add: ["src/..."], reason })')
    if (!input.reason.trim()) throw new FlowGateError('范围变更必须写理由', '说明为什么必须改这些文件')
    const limit = this.configFor(change).triggers.max_scope_new_files
    const expanded = limit > 0 && input.add.length > limit
    const item = this.createPending(change, {
      kind: 'scope',
      title: `${input.taskId} 申请扩大范围${expanded ? '（范围膨胀）' : ''}`,
      detail: expanded
        ? `${input.reason}\n\n⚠ 范围膨胀：一次申请 ${input.add.length} 个路径，超过触发器上限 ${limit}（03 §8.2）。批准后风险将提高为高风险。`
        : input.reason,
      data: { taskId: input.taskId, add: input.add, ...(expanded ? { scopeExpanded: true } : {}) },
      scope: { changeId: change.id, taskId: input.taskId, paths: input.add },
    })
    if (expanded) {
      await this.appendLedger('risk.raised', {
        changeId: change.id,
        pendingId: item.id,
        trigger: 'scope-expansion',
        paths: input.add.length,
        limit,
      })
      this.pushNotice(`范围膨胀：${input.add.length} 个路径超过上限 ${limit}，批准该范围变更会同时把风险提高为高风险。`)
    }
    await this.appendLedger('scope.requested', { changeId: change.id, pendingId: item.id, taskId: input.taskId, add: input.add })
    await this.saveChange(change)
    this.pushNotice(`收到范围变更申请 ${item.id}：等待负责人在授权卡片上批准或退回（退回需写理由）。`)
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
    if (!item) throw new FlowGateError(`没有待处理项 ${id}`, '在 FlowGate 面板查看待处理项列表')
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
        if (item.data?.scopeExpanded === true && change.risk === 'normal') {
          await this.applyRiskRaised(change, '范围膨胀（一次范围变更超过触发器上限）')
        }
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
      } else if (item.kind === 'tamper') {
        // 负责人确认「这是合法重构」：关闭篡改嫌疑项，G6 的 g6.tamper 随即可通过。
        await this.appendLedger('tamper.cleared', { changeId: change.id, pendingId: id })
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
    const limit = this.configFor(change).triggers.consecutive_failure_limit
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
    // item.id 本身就是 RL-n；不能再次拼前缀（旧实现会写出 RL-RL-1.md）。
    const ruleId = String(item.data?.ruleId ?? item.id)
    const md = `# 项目规则 ${ruleId}\n\n## 问题\n\n${String(item.data?.finding ?? item.detail)}\n\n## 规则\n\n${String(item.data?.rule ?? '')}\n\n## 正确写法示例\n\n${String(item.data?.example ?? '')}\n\n## 适用范围\n\n${String(item.data?.scope ?? '')}\n`
    await this.fs.writeFile(posixJoin(layout.rulesDir, `${ruleId}.md`), md)
    // 同时写机器可读规则，供 loadProjectRules 在新建变更时并入契约并挂到当前阶段。
    const stage = this.current?.stage
    const rule: Rule = {
      id: ruleId,
      when: stage !== undefined && stage !== 'archived' ? { stage: [stage] } : {},
      decision: 'human',
      why: String(item.data?.rule ?? item.detail),
      unlock: String(item.data?.example ?? '负责人确认后继续；确需长期放行请改 config/例外'),
      source: `规则沉淀 ${ruleId}（负责人批准）`,
    }
    await this.fs.writeFile(posixJoin(layout.rulesDir, `${ruleId}.json`), `${JSON.stringify(rule, null, 2)}\n`)
    this.projectRules = [...this.projectRules.filter((entry) => entry.id !== ruleId), rule]
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
    const rules = loadRules(this.configFor(change))
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
    if (!exception) throw new FlowGateError(`没有例外 ${id}`, '在 FlowGate 面板查看例外列表')
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
    const raising = order.indexOf(parsed) > order.indexOf(change.complexity)
    if (lowering && !reason?.trim()) throw new FlowGateError('降低复杂度必须写理由', '用法：/flow complexity 低 <理由>')
    const previous = change.complexity
    change.complexity = parsed
    // T2.8 验收 #2：低复杂度方案确认卡上点「提高复杂度」→ 回 S1 补齐中复杂度要求，
    // 之后按正常的 G1/G2/G3 人工确认走。
    if (raising && order.indexOf(previous) === 0 && (change.stage === 'S1' || change.stage === 'S2' || change.stage === 'S3')) {
      const now = isoNow(this.clock)
      Object.assign(change, enterStage(change, 'S1', now))
      change.gates.G1 = { state: 'pending', attempts: 0 }
      change.gates.G2 = { state: 'pending', attempts: 0 }
      change.gates.G3 = { state: 'pending', attempts: 0 }
      change.plan = undefined
      change.tasks = {}
      change.batches = []
      await this.appendLedger('stage.entered', { changeId: change.id, stage: 'S1', reason: 'complexity-raised' })
      this.pushNotice(`复杂度从「低」提高到「${complexityLabel(parsed)}」：已回到 S1 补齐六要素，之后按 G1/G2/G3 逐门确认。`)
    }
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
    if (raising) {
      // FR-6.6：清空已完成任务的审查、按需退回 S4，并生成 RK 提醒（测试回执保留）。
      await this.applyRiskRaised(change, reason ?? '负责人提高风险等级')
    } else {
      change.risk = parsed
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
  // Project-level pause, incident records and the repair lane (v0.5.1)
  // ------------------------------------------------------------------

  /**
   * agent 自暂停的宿主重启自动恢复（auto-rearm）：`flags.off.autoRearm === true`
   * 且记录的 hostEpoch 与当前进程 hostEpoch 都存在且不同 → 清暂停并记账。
   * 负责人手动暂停（by='human' / 无 autoRearm）永不自动恢复。
   */
  private async autoRearmProjectFlags(): Promise<void> {
    const off = this.flags.off
    if (off === undefined || off.autoRearm !== true) return
    if (off.hostEpoch === undefined || this.hostEpoch === undefined) return
    if (off.hostEpoch === this.hostEpoch) return
    delete this.flags.off
    try {
      await store.writeProjectFlags(this.fs, this.root, this.flags)
    } catch {
      // 写失败不影响本次 load：内存里已经恢复，下一次写入会补上。
    }
    await this.appendLedger('flow.project_on', {
      reason: '宿主重启自动恢复（auto-rearm）',
      auto: true,
      by: off.by,
      previousEpoch: off.hostEpoch,
      hostEpoch: this.hostEpoch,
    })
    this.pushNotice('门禁已从 agent 自暂停中自动恢复（宿主重启 auto-rearm）。如有未结事故，请用 flow_incident_close 补审计记录。')
  }

  /**
   * 项目级暂停/恢复（v0.5.1）：`/flow off` / `/flow on` 在没有活动变更时也能用。
   * 暂停期间写操作放行，但 `.flowgate/**`、`.git/**` 仍由 evaluateAction 拦截，
   * 防止 agent 自己解除暂停或改账本。
   */
  async setProjectOff(
    off: boolean,
    reason: string,
    options: { by?: EnforcerKind; autoRearm?: boolean } = {},
  ): Promise<void> {
    if (!this.isInitialized()) throw new FlowGateError('FlowGate 未初始化', '等待负责人在授权卡片上启用 FlowGate 后重试')
    const by = options.by ?? 'human'
    const text = reason.trim() === '' ? (off ? '负责人暂停门禁' : '负责人恢复门禁') : reason.trim()
    let previousBy: EnforcerKind | undefined
    if (off) {
      this.flags.off = {
        by,
        reason: text,
        at: isoNow(this.clock),
        ...(options.autoRearm === true ? { autoRearm: true } : {}),
        ...(this.hostEpoch !== undefined ? { hostEpoch: this.hostEpoch } : {}),
      }
    } else {
      previousBy = this.flags.off?.by
      delete this.flags.off
    }
    await store.writeProjectFlags(this.fs, this.root, this.flags)
    if (off) {
      await this.appendLedger('flow.project_off', { reason: text, by, autoRearm: options.autoRearm === true })
      this.pushNotice(`门禁已暂停（写操作放行${by === 'agent' ? '，agent 自暂停' : ''}）：${text}。恢复用 /flow on。`)
    } else {
      await this.appendLedger('flow.project_on', { reason: text, by, previousBy })
      this.pushNotice(`门禁已恢复：${text}`)
    }
    this.emitState()
  }

  /**
   * agent 自暂停（v0.5.1）：开一条事故记录 + 项目级暂停（autoRearm），让 agent
   * 在遇到自身 bug 时能先止血而不是被自己的门禁锁死。负责人 `/flow on` 或宿主
   * 重启后自动恢复；完成后用 `flow_incident_close` 补审计记录。
   */
  async selfPause(input: { reason: string; severity?: RepairSeverity }): Promise<{ incident: IncidentRecord; message: string }> {
    if (!this.isInitialized()) throw new FlowGateError('FlowGate 未初始化', '等待负责人在授权卡片上启用 FlowGate 后重试')
    if (this.flags.incident !== undefined) {
      const existing: IncidentRecord = { ...this.flags.incident }
      return {
        incident: existing,
        message: `已有未关闭的事故 ${existing.id}（${existing.severity}）：${existing.reason}。修复完成后用 flow_incident_close 补审计记录；恢复门禁用 /flow on（或宿主重启自动恢复）。`,
      }
    }
    const reason = input.reason.trim()
    if (reason === '') {
      throw new FlowGateError('自暂停必须写原因', '用法：flow_self_pause({ reason: "为什么暂停门禁（P0/P1 事故）", severity?: "P0" | "P1" | "P2" })')
    }
    const ids = await store.listIncidentIds(this.fs, this.root)
    const now = isoNow(this.clock)
    const incident: IncidentRecord = {
      id: store.nextStampedId('INC', this.clock, ids),
      severity: input.severity ?? 'P2',
      reason,
      openedAt: now,
      openedBy: 'agent',
    }
    this.flags.incident = incident
    this.flags.off = {
      by: 'agent',
      reason,
      at: now,
      autoRearm: true,
      ...(this.hostEpoch !== undefined ? { hostEpoch: this.hostEpoch } : {}),
    }
    await store.writeProjectFlags(this.fs, this.root, this.flags)
    await this.appendLedger('incident.open', { incidentId: incident.id, severity: incident.severity, reason, openedBy: 'agent' })
    await this.appendLedger('flow.project_off', { reason, by: 'agent', autoRearm: true, incidentId: incident.id })
    const message = `门禁已暂停（写操作放行）；恢复：负责人 /flow on，或下一次宿主启动自动恢复；完成后用 flow_incident_close 补审计记录。事故 ${incident.id}（${incident.severity}）。`
    this.pushNotice(message)
    this.emitState()
    return { incident: { ...incident }, message }
  }

  /** 关闭事故记录（v0.5.1）：补摘要/commit/tests/files 归档到 `.flowgate/incidents/<id>.json` 并解除 agent 自暂停。 */
  async closeIncident(input: { summary: string; commit?: string | null; tests?: string; files?: string[] }): Promise<{ incident: IncidentRecord; message: string }> {
    const open = this.flags.incident
    if (open === undefined) {
      throw new FlowGateError('当前没有未关闭的事故记录', '自暂停用 flow_self_pause；关闭用 flow_incident_close({ summary, commit?, tests?, files? })')
    }
    const summary = input.summary.trim()
    if (summary === '') {
      throw new FlowGateError('关闭事故必须写摘要', 'summary 写清：原因、修复方式、验证结论（commit/tests/files 可选但建议填）')
    }
    const closed: IncidentRecord = { ...open, closedAt: isoNow(this.clock), summary }
    if (input.commit !== undefined) closed.commit = input.commit
    if (input.tests !== undefined) closed.tests = input.tests
    if (input.files !== undefined) closed.files = [...input.files]
    const path = await store.writeIncidentRecord(this.fs, this.root, closed)
    delete this.flags.incident
    const pausedByAgent = this.flags.off?.by === 'agent'
    if (pausedByAgent) delete this.flags.off
    await store.writeProjectFlags(this.fs, this.root, this.flags)
    await this.appendLedger('incident.close', {
      incidentId: closed.id,
      summary,
      commit: closed.commit ?? null,
      tests: closed.tests ?? null,
      files: closed.files ?? [],
      path,
    })
    if (pausedByAgent) await this.appendLedger('flow.project_on', { reason: '事故关闭，门禁恢复', incidentId: closed.id })
    const message = `事故 ${closed.id} 已关闭并归档到 ${path}${pausedByAgent ? '；门禁已恢复' : ''}。`
    this.pushNotice(message)
    this.emitState()
    return { incident: closed, message }
  }

  /**
   * 开始一次修复（v0.5.1）：一次声明（scope + verify + 验收），之后在范围内自由
   * 迭代（edit → 跑测试 → 再 edit），用 RED→GREEN 证据关门；不产生 C-xxx 变更。
   */
  async startRepair(input: {
    title: string
    symptom: string
    repro?: string
    scope: string[]
    verify: string
    acceptance?: string[]
    severity?: RepairSeverity
    openedBy?: EnforcerKind
  }): Promise<RepairRecord> {
    if (!this.isInitialized()) throw new FlowGateError('FlowGate 未初始化', '等待负责人在授权卡片上启用 FlowGate 后重试')
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复（从账本重建状态）后再开修复通道')
    const activeChanges = (this.state?.changes ?? []).filter((change) => change.lifecycle === 'active')
    if (activeChanges.length > 0) {
      const first = activeChanges[0]!
      throw new FlowGateError(
        `已有进行中的变更 ${first.id}（${first.title}）`,
        '修复通道用于「没有进行中变更」时的 bug 修复；先把现有变更 finish/pause，再 flow_fix_start',
      )
    }
    if (this.activeRepair !== null) {
      throw new FlowGateError(
        `已有进行中的修复 ${this.activeRepair.id}（${this.activeRepair.title}）`,
        '先 flow_fix_done 完成并留证，或 flow_fix_abort 中止后再开始新的修复',
      )
    }
    const title = input.title.trim()
    if (title === '') throw new FlowGateError('修复标题不能为空', '用一句话说清修什么，例如「修复新建会话失败」')
    const symptom = input.symptom.trim()
    if (symptom === '') throw new FlowGateError('修复必须写症状（symptom）', '写清用户可见现象/报错/影响面，便于复盘')
    const scope = [...new Set(input.scope.map((pattern) => normalizeRelPath(pattern)).filter((pattern) => pattern !== ''))]
    if (scope.length === 0) {
      throw new FlowGateError(
        '修复范围不能为空（scope）',
        '写清允许改动的仓库相对路径或 glob（≤20 条），例如 ["src/core/**", "test/core/**"]',
      )
    }
    if (scope.length > 20) throw new FlowGateError(`修复范围过大（${scope.length} 条，最多 20 条）`, '缩小 scope；若是跨模块大改请改用 flow_new_change 立项')
    const verify = input.verify.trim()
    if (verify === '') throw new FlowGateError('修复必须声明验证命令（verify）', '例如 "pnpm vitest run test/core/xxx.test.ts"；RED→GREEN 由插件亲自执行该命令')
    const shape = validateVerifyCommand(verify)
    if (!shape.ok) throw new FlowGateError(`验证命令不合法：${shape.reason}`, '只写一条命令，不允许 && || ; 管道 重定向 命令替换和反引号')
    if (!this.runner) throw new FlowGateError('宿主没有提供命令执行器', '运行 /flow doctor 查看缺失接口')
    const acceptance = (input.acceptance ?? []).map((item) => item.trim()).filter((item) => item !== '')
    const ids = await store.listFixIds(this.fs, this.root)
    const now = isoNow(this.clock)
    const record: RepairRecord = {
      id: store.nextStampedId('FIX', this.clock, ids),
      title,
      symptom,
      ...(input.repro !== undefined && input.repro.trim() !== '' ? { repro: input.repro.trim() } : {}),
      scope,
      verify,
      acceptance,
      severity: input.severity ?? 'P2',
      status: 'open',
      openedAt: now,
      openedBy: input.openedBy ?? 'agent',
      actions: 0,
    }
    this.activeRepair = record
    await store.writeActiveRepair(this.fs, this.root, record)
    await this.appendLedger('repair.started', {
      repairId: record.id,
      title,
      severity: record.severity,
      scope,
      verify,
      symptom,
      openedBy: record.openedBy,
    })
    this.pushNotice(
      `修复通道已开启 ${record.id}「${title}」（${record.severity}）。只允许改声明范围：${scope.join('、')}。下一步：先写复现测试/跑失败命令拿 RED（flow_verify），再改到 GREEN，完成后 flow_fix_done。`,
    )
    this.emitState()
    return JSON.parse(JSON.stringify(record)) as RepairRecord
  }

  /** 记录一条修复回执并（可选）绑定 RED/GREEN；回执结构与普通验证完全一致。 */
  private async runRepairReceipt(input: { command: string; group: string; inputs: string[]; bind: boolean }): Promise<EvidenceReceipt> {
    const repair = this.activeRepair
    if (repair === null) throw new FlowGateError('当前没有进行中的修复', '先用 flow_fix_start 开修复通道')
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    if (!this.runner) throw new FlowGateError('宿主没有提供命令执行器', '运行 /flow doctor 查看缺失接口')
    const shape = validateVerifyCommand(input.command)
    if (!shape.ok) throw new FlowGateError(`验证命令不合法：${shape.reason}`, '只写一条可执行命令，不允许 && || ; 管道 重定向 命令替换和反引号')
    this.evidenceCounter += 1
    const id = `E-${String(this.evidenceCounter).padStart(4, '0')}`
    const now = isoNow(this.clock)
    // 修复通道没有 C-xxx 变更目录：回执的 changeId 用 FIX-id，evidence 索引与日志
    // 都落在 `.flowgate/state/evidence/`（与普通回执同构），host 无需特殊处理。
    const syntheticChange: ChangeStatus = {
      id: repair.id,
      kind: 'change',
      title: repair.title,
      complexity: 'low',
      risk: 'normal',
      stage: 'S4',
      lifecycle: 'active',
      gates: {},
      batches: [],
      tasks: {},
      evidenceIds: [],
      pending: [],
      overrides: [],
      exceptions: [],
      violations: [],
      reviews: [],
      createdAt: repair.openedAt,
      updatedAt: now,
    }
    const syntheticTask: TaskCard = {
      id: 'FIX',
      title: repair.title,
      covers: [],
      scope: [...repair.scope],
      tests: [],
      newFiles: [],
      changes: [],
      dependsOn: [],
      tdd: 'required',
      verify: [{ group: input.group, command: input.command, inputs: [...input.inputs] }],
      run: 'main',
      risk: [],
      size: 'M',
      body: '',
    }
    const receipt = await runVerifyGroup({
      fs: this.fs,
      root: this.root,
      runner: this.runner,
      change: syntheticChange,
      task: syntheticTask,
      group: { group: input.group, command: input.command, inputs: [...input.inputs] },
      clock: this.clock,
      nextEvidenceId: () => id,
    })
    await this.appendReceipt(receipt)
    if (input.bind) await this.bindRepairEvidence(receipt)
    else
      await this.appendLedger('repair.evidence', {
        repairId: repair.id,
        evidenceId: receipt.id,
        group: input.group,
        phase: receipt.phase,
        command: receipt.command,
        exitCode: receipt.exitCode,
        inputsHash: receipt.inputsHash,
        bound: false,
      })
    return receipt
  }

  /**
   * 把验证回执绑定到修复记录：RED 只绑定一次（在拿到 GREEN 之前可刷新），
   * GREEN 一旦出现即可更新（多次 green 以最后一次为准）。
   */
  private async bindRepairEvidence(receipt: EvidenceReceipt): Promise<void> {
    const repair = this.activeRepair
    if (repair === null || this.current !== null) return
    let bound: 'red' | 'green' | null = null
    if (receipt.phase === 'red') {
      if (repair.greenEvidenceId === undefined && repair.redEvidenceId !== receipt.id) {
        repair.redEvidenceId = receipt.id
        bound = 'red'
      }
    } else if (receipt.phase === 'green') {
      if (repair.redEvidenceId !== undefined && repair.greenEvidenceId !== receipt.id) {
        repair.greenEvidenceId = receipt.id
        bound = 'green'
      }
    }
    if (bound !== null) {
      try {
        await store.writeActiveRepair(this.fs, this.root, repair)
      } catch {
        // 持久化失败不阻断验证；下一次写入会带上。
      }
      this.pushNotice(
        bound === 'red'
          ? `修复 ${repair.id} 已记录 RED 证据 ${receipt.id}（${receipt.command}）。现在改代码到通过，再 flow_verify 拿 GREEN。`
          : `修复 ${repair.id} 已记录 GREEN 证据 ${receipt.id}。下一步 flow_fix_done 关门（会跑全量回归并核对改动范围）。`,
      )
    }
    await this.appendLedger('repair.evidence', {
      repairId: repair.id,
      evidenceId: receipt.id,
      group: receipt.group,
      phase: receipt.phase,
      command: receipt.command,
      exitCode: receipt.exitCode,
      inputsHash: receipt.inputsHash,
      bound,
      redEvidenceId: repair.redEvidenceId ?? null,
      greenEvidenceId: repair.greenEvidenceId ?? null,
    })
  }

  /**
   * 修复通道的收尾（v0.5.1）。前置全部通过才写修复记录并清空 repair.json：
   * - RED/GREEN 都存在且 GREEN 晚于 RED；
   * - 全量回归（config.commands.test）通过（未配置则跳过并写明）；
   * - 重新运行声明的 verify 命令且回执新鲜；
   * - 改动文件全部命中 scope（收集不到时记 unknown 并继续，不误杀）。
   * 任一失败抛 FlowGateError 且**不清空**进行中的修复。
   */
  async finishRepair(input: { summary?: string; commit?: string | null } = {}): Promise<{ record: RepairRecord; message: string }> {
    const repair = this.activeRepair
    if (repair === null) throw new FlowGateError('当前没有进行中的修复', '先用 flow_fix_start 开修复通道（声明 scope 与 verify），修完再用 flow_fix_done')
    if (this.state?.locked) throw new FlowGateError('FlowGate 处于锁定模式', '等待负责人在授权卡片上修复')
    const notes: string[] = []
    const red = repair.redEvidenceId !== undefined ? this.receipts.find((receipt) => receipt.id === repair.redEvidenceId) : undefined
    const green = repair.greenEvidenceId !== undefined ? this.receipts.find((receipt) => receipt.id === repair.greenEvidenceId) : undefined
    if (red === undefined) {
      throw new FlowGateError(
        `修复 ${repair.id} 还没有 RED 证据`,
        '先写复现测试/跑失败命令：flow_verify 会把失败回执记为 RED；修复通道保持开启',
      )
    }
    if (green === undefined) {
      throw new FlowGateError(
        `修复 ${repair.id} 还没有 GREEN 证据`,
        '修好后重新 flow_verify，直到验证命令通过（GREEN）；修复通道保持开启',
      )
    }
    const redAt = Date.parse(red.finishedAt)
    const greenAt = Date.parse(green.finishedAt)
    if (Number.isFinite(redAt) && Number.isFinite(greenAt) && greenAt <= redAt) {
      throw new FlowGateError(`修复 ${repair.id} 的 GREEN 证据不晚于 RED`, '重新跑一次 flow_verify 生成新的 GREEN 回执后再 flow_fix_done')
    }
    // 1) 改动文件必须在声明范围内（收集不到时记 unknown，继续）。
    const collected = await this.collectChangedFiles()
    if (collected === null) {
      notes.push('未收集到改动文件（GitPort 与命令行都不可用，或不是 git 仓库）：changedFiles 记为 unknown')
    } else {
      const outside = outOfScopePaths(collected, repair.scope)
      if (outside.length > 0) {
        const shown = outside.slice(0, 5).join('、')
        throw new FlowGateError(
          `修复改动超出声明范围：${shown}${outside.length > 5 ? ` 等 ${outside.length} 个文件` : ''}`,
          '把这些文件写进 scope 后重新 flow_fix_start（或 flow_fix_abort 后重开）；若这是新功能请 flow_new_change 立项。修复通道保持开启',
        )
      }
    }
    // 2) 全量回归（config.commands.test；none/缺失跳过并记录 notes）。
    const testCommand = this.config.commands.test
    let regression: EvidenceReceipt | undefined
    if (testCommand === undefined || testCommand === 'none' || testCommand.trim() === '') {
      notes.push('项目没有配置全量测试命令（commands.test = none/缺失）：已跳过全量回归')
    } else {
      regression = await this.runRepairReceipt({
        command: testCommand,
        group: 'repair-regression',
        inputs: repair.scope.length > 0 ? repair.scope : this.baselineInputs(),
        bind: false,
      })
      if (regression.exitCode !== 0 || regression.phase !== 'green') {
        throw new FlowGateError(
          `全量回归失败（${testCommand}）：exit=${regression.exitCode}，phase=${regression.phase}`,
          `先修好回归失败再 flow_fix_done；修复通道保持开启（回归回执 ${regression.id}）`,
        )
      }
      notes.push(`全量回归通过（回执 ${regression.id}）`)
    }
    // 3) 重新运行声明的 verify 命令，确认当前输入下仍是 GREEN。
    const confirm = await this.runRepairReceipt({ command: repair.verify, group: 'repair-verify', inputs: repair.scope, bind: true })
    if (confirm.exitCode !== 0 || confirm.phase !== 'green') {
      throw new FlowGateError(
        `重新运行验证命令未通过（${repair.verify}）：phase=${confirm.phase}，exit=${confirm.exitCode}`,
        '继续改到 flow_verify 通过后再 flow_fix_done；修复通道保持开启（本次回执已记录）',
      )
    }
    // 4) 新鲜度：回执的输入哈希必须等于当前 scope 的哈希（复用证据 freshness 口径）。
    const freshHash = (await hashInputs(this.fs, this.root, repair.scope)).hash
    if (confirm.inputsHash !== freshHash) {
      throw new FlowGateError('验证回执已过期：运行验证命令后声明范围内的输入又发生了变化', '不要改文件，直接重新 flow_fix_done（会重新跑验证命令）')
    }
    // 5) commit：负责人可显式传；否则尽力取 git HEAD（取不到记 null，不阻断）。
    let commit: string | null = null
    if (input.commit !== undefined) commit = input.commit
    else if (this.git) commit = await this.git.head(this.root).catch(() => null)
    // 6) 落审计记录并清空 active repair。
    const closedAt = isoNow(this.clock)
    const summaryInput = input.summary?.trim() ?? ''
    const record: RepairRecord = {
      ...repair,
      status: 'done',
      closedAt,
      summary: summaryInput === '' ? `修复完成：${repair.title}` : summaryInput,
      greenEvidenceId: confirm.id,
      ...(regression !== undefined ? { regressionEvidenceId: regression.id } : {}),
      ...(collected !== null ? { changedFiles: collected } : {}),
      commit,
    }
    const path = await store.writeFixRecord(this.fs, this.root, record)
    await this.appendLedger('repair.done', {
      repairId: record.id,
      redEvidenceId: record.redEvidenceId ?? null,
      greenEvidenceId: record.greenEvidenceId ?? null,
      regressionEvidenceId: record.regressionEvidenceId ?? null,
      changedFiles: record.changedFiles ?? null,
      commit: record.commit ?? null,
      summary: record.summary ?? null,
      path,
      notes,
    })
    this.activeRepair = null
    await store.clearActiveRepair(this.fs, this.root)
    const message = renderRepairReport(record, red, confirm, regression, notes)
    this.pushNotice(`修复完成 ${record.id}「${record.title}」：记录 ${path}`)
    this.emitState()
    return { record: JSON.parse(JSON.stringify(record)) as RepairRecord, message }
  }

  /** 中止修复（v0.5.1）：记录理由与（能收集到的）改动文件后清空 active repair。 */
  async abortRepair(reason: string): Promise<RepairRecord> {
    const repair = this.activeRepair
    if (repair === null) throw new FlowGateError('当前没有进行中的修复', '用 flow_fix_start 开修复通道；中止用 flow_fix_abort({ reason })')
    const text = reason.trim()
    if (text === '') throw new FlowGateError('中止修复必须写理由', '说清为什么放弃（例如根因在另一个模块，需要 flow_new_change 大改）')
    const collected = await this.collectChangedFiles()
    const record: RepairRecord = {
      ...repair,
      status: 'aborted',
      abortReason: text,
      closedAt: isoNow(this.clock),
      ...(collected !== null ? { changedFiles: collected } : {}),
    }
    const path = await store.writeFixRecord(this.fs, this.root, record)
    await this.appendLedger('repair.aborted', {
      repairId: record.id,
      reason: text,
      path,
      changedFiles: record.changedFiles ?? null,
    })
    this.activeRepair = null
    await store.clearActiveRepair(this.fs, this.root)
    this.pushNotice(`修复通道已中止 ${record.id}：${text}（记录 ${path}）`)
    this.emitState()
    return JSON.parse(JSON.stringify(record)) as RepairRecord
  }

  /**
   * 收集工作区改动文件（repo-relative）：优先 GitPort，其次 CommandRunner 跑
   * `git status --porcelain --untracked-files=all`；都不是 git / 命令失败返回 null。
   * `.flowgate/`、`.git/` 下的改动是插件状态，不算修复改动。
   */
  private async collectChangedFiles(): Promise<string[] | null> {
    let status: string | null = null
    if (this.git !== undefined) {
      try {
        status = await this.git.statusPorcelain(this.root)
      } catch {
        status = null
      }
    }
    if (status === null && this.runner !== undefined) {
      try {
        const result = await this.runner.run('git status --porcelain --untracked-files=all', { cwd: this.root, timeoutMs: 30_000 })
        if (result.exitCode === 0) status = result.stdout
      } catch {
        status = null
      }
    }
    if (status === null) return null
    const paths = FlowEngine.porcelainPaths(status).filter(
      (path) => !isUnder(path, '.flowgate') && !isUnder(path, '.git') && path !== '',
    )
    return [...new Set(paths)].sort()
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

  /**
   * 检查当前变更是否已被其它会话接管（T3.7 验收 #2）。
   * 被接管后的旧会话写操作必须拒绝；节流 1s 读取 sessions.json，避免每次 guard 都读盘。
   */
  private async refreshForeignLease(): Promise<void> {
    if (!this.sessionId || !this.current) return
    const nowMs = this.clock.now().getTime()
    if (nowMs - this.lastLeaseRefreshAt < 1_000) return
    this.lastLeaseRefreshAt = nowMs
    try {
      const leases = await store.readLeases(this.fs, this.root)
      const lease = leases.find((item) => item.changeId === this.current?.id)
      if (
        lease &&
        lease.sessionId !== this.sessionId &&
        !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())
      ) {
        this.foreignLease = lease
      } else {
        this.foreignLease = null
      }
    } catch {
      // 租约文件损坏由锁定模式处理；这里不额外阻断。
    }
  }

  /**
   * 解析 git status 的路径（接续快照对比用）：兼容 porcelain=v2 -z 与
   * 旧版 v1 文本（测试替身/降级实现返回 v1）。
   */
  private static porcelainPaths(status: string): string[] {
    if (status === '') return []
    const paths = new Set<string>()
    const addV1 = (line: string): void => {
      const match = /^[ MADRCU?!]{2} (.+)$/.exec(line)
      if (!match) return
      const value = match[1]!
      const renamed = /^(.+?) -> (.+)$/.exec(value)
      paths.add(renamed ? renamed[2]! : value)
    }
    const records = status.split('\0')
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]
      if (!record) continue
      const kind = record[0]
      if (kind === '1' || kind === 'u') {
        const match = /^[12u] \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record)
        const path = kind === '1' ? record.split(' ').slice(8).join(' ') : match?.[1]
        if (path) paths.add(path)
      } else if (kind === '2') {
        const path = record.split(' ').slice(9).join(' ')
        if (path) paths.add(path)
        index += 1
      } else if (kind === '?') {
        const path = record.slice(2)
        if (path) paths.add(path)
      } else if (record.includes('\n')) {
        for (const line of record.split('\n')) if (line !== '') addV1(line)
      } else {
        addV1(record)
      }
    }
    return [...paths].sort()
  }

  /**
   * 接续时对比「上一次会话释放时的快照」与当前工作区（T3.7 验收 #3）：
   * 新增的已改路径记为非 agent 改动，交给负责人确认。
   */
  private async compareWorktreeSnapshot(change: ChangeStatus): Promise<void> {
    const previous = change.worktreeSnapshot
    if (!previous || !this.git) return
    try {
      const status = await this.git.statusPorcelain(this.root)
      const currentPaths = FlowEngine.porcelainPaths(status)
      const external = currentPaths.filter((path) => !previous.paths.includes(path))
      if (external.length === 0) return
      const now = isoNow(this.clock)
      for (const path of external) {
        if (isUnder(path, '.flowgate') || isUnder(path, '.git')) continue
        change.externalChanges = [...(change.externalChanges ?? []), { path, at: now, origin: 'external' }]
      }
      await this.appendLedger('external.detected', { changeId: change.id, paths: external })
      this.pushNotice(`接续时检测到 ${external.length} 处会话之间的非 agent 改动：${external.slice(0, 5).join('、')}。G6 前需在授权卡片上确认。`)
    } catch {
      // 快照对比失败不阻塞接续。
    }
  }

  /** 记录当前工作区快照（释放/暂停会话时调用），供下一次接续对比。 */
  private async captureWorktreeSnapshot(change: ChangeStatus): Promise<void> {
    if (!this.git) return
    try {
      const status = await this.git.statusPorcelain(this.root)
      change.worktreeSnapshot = {
        at: isoNow(this.clock),
        statusPorcelain: status,
        paths: FlowEngine.porcelainPaths(status),
      }
    } catch {
      // 忽略快照失败。
    }
  }

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
    // 接续（而不是新建）时：对比上一次会话的工作区快照，找出会话之间的非 agent 改动。
    if (change.worktreeSnapshot !== undefined) {
      this.resumed = true
      await this.compareWorktreeSnapshot(change)
    }
    await this.saveLeases()
    await this.appendLedger('session.attached', { changeId: change.id, sessionId: this.sessionId, label: this.sessionLabel })
    await this.saveChange(change)
  }

  async attachSession(label?: string): Promise<RuntimeSnapshot> {
    if (this.stateCorruption.length > 0) {
      throw new FlowGateError(
        '状态文件损坏，不能接续变更',
        '等待负责人在授权卡片上修复（从账本重建状态）后再接续',
      )
    }
    // 与 autoAttach 一致：PROJECT（路线图阶段）也允许显式接续。
    const active = (this.state?.changes ?? []).filter((change) => change.lifecycle === 'active')
    if (active.length === 0) throw new FlowGateError('没有进行中的变更', '用一句话描述要做的变更，让 agent 立项')
    if (active.length > 1) throw new FlowGateError('有多个进行中的变更', `在 FlowGate 面板上选择要接续的变更：${active.map((change) => change.id).join('、')}`)
    const change = active[0]!
    const lease = this.state?.leases.find((item) => item.changeId === change.id)
    if (lease && lease.sessionId !== this.sessionId && !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())) {
      throw new FlowGateError(`${change.id} 正在另一个会话中进行`, `如确认旧会话已停止，在 FlowGate 面板上接管 ${change.id}`)
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
        '等待负责人在授权卡片上修复（从账本重建状态）后再恢复',
      )
    }
    const change = this.state?.changes.find((item) => item.id === changeId)
    if (!change) throw new FlowGateError(`没有变更 ${changeId}`, '在 FlowGate 面板查看台账')
    if (change.lifecycle === 'archived') throw new FlowGateError(`${changeId} 已归档`, '已交付的变更不能继续；要修改请新建关联变更')
    const lease = this.state?.leases.find((item) => item.changeId === changeId)
    const now = isoNow(this.clock)
    if (lease && lease.sessionId !== this.sessionId && !isOlderThanMinutes(lease.heartbeatAt, this.config.session.lease_minutes, this.clock.now())) {
      if (!options.takeover) {
        throw new FlowGateError(
          `${changeId} 正在另一个会话中进行（心跳 ${lease.heartbeatAt}）`,
          `确认旧会话已停止后在 FlowGate 面板上接管 ${changeId}`,
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
    await this.captureWorktreeSnapshot(change)
    if (change.roadmap !== undefined) await this.updateRoadmapStatus(change, '暂停')
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
      // T3.7/T4.8：关闭会话前生成交接摘要，否则新会话没有 handoff 可注入。
      try {
        await this.generateHandoff()
      } catch {
        // 交接摘要失败不阻塞释放租约。
      }
      await this.captureWorktreeSnapshot(change)
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
  async recordTurnContinued(input: {
    turn?: number
    count?: number
    taskId?: string
    reason?: string
    /** true = 超过每轮上限后的静默放行（仍记账，避免审计空白）。 */
    suppressed?: boolean
  } = {}): Promise<void> {
    const change = this.current
    await this.appendLedger('turn.continued', {
      changeId: change?.id,
      taskId: input.taskId ?? this.activeTask()?.id,
      turn: input.turn,
      count: input.count,
      reason: input.reason,
      suppressed: input.suppressed === true,
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
    // 路线图条目状态回写：C0/C1 交付后后续变更的依赖判定才不会被卡住（T2.7）。
    await this.updateRoadmapStatus(change, '已交付')
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
        ? 'FlowGate 未启用：项目没有 .flowgate/config.yaml。在授权卡片上启用（或 /flow init）。'
        : this.state?.locked
          ? `锁定模式：${this.state.locked.reason}。修复入口：/flow repair。`
          : this.flags.incident !== undefined
            ? `门禁已因事故暂停（${this.flags.incident.id} · ${this.flags.incident.severity}）：写操作放行。修复后用 flow_incident_close 补审计记录；恢复用 /flow on 或宿主重启自动恢复。`
            : this.flags.off !== undefined
              ? `门禁已暂停（${this.flags.off.by === 'agent' ? 'agent 自暂停' : '负责人手动'}）：写操作放行。恢复用 /flow on。`
              : this.activeRepair !== null
                ? `修复通道进行中：${this.activeRepair.id}「${this.activeRepair.title}」（${this.activeRepair.severity}，RED ${this.activeRepair.redEvidenceId !== undefined ? '已有' : '待补'} / GREEN ${this.activeRepair.greenEvidenceId !== undefined ? '已有' : '待补'}）。`
                : 'FlowGate 运行正常。',
    }
    return report
  }

  async repair(): Promise<{ ok: boolean; message: string }> {
    if (!this.isInitialized()) throw new FlowGateError('FlowGate 未初始化', '等待负责人在授权卡片上启用 FlowGate 后重试')
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
    await this.writeRetro(change, ledgerEvents, set)
    return set
  }

  /** 复盘日志（T4.5）：把拦截最多规则、误判、阶段耗时、返工原因追加到 .flowgate/retro.md。 */
  private async writeRetro(change: ChangeStatus, ledgerEvents: LedgerEvent[], metrics: MetricSet): Promise<void> {
    try {
      const layout = store.layout(this.root)
      const events = ledgerEvents.filter((event) => event.data?.changeId === change.id || event.data?.change === change.id)
      const denied = events.filter((event) => event.type === 'rule.denied' || event.type === 'rule.human')
      const counts = new Map<string, number>()
      for (const event of denied) {
        const ruleId = String(event.data?.ruleId ?? 'unknown')
        counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1)
      }
      const topRules = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      const stageDurations: { stage: string; ms: number }[] = []
      const entries = events.filter((event) => event.type === 'stage.entered')
      for (let index = 0; index < entries.length; index += 1) {
        const start = Date.parse(entries[index]!.at)
        const next = entries[index + 1]?.at ?? metrics.generatedAt
        const end = Date.parse(next)
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) stageDurations.push({ stage: String(entries[index]!.data?.stage ?? '?'), ms: end - start })
      }
      const slowest = stageDurations.sort((a, b) => b.ms - a.ms)[0]
      const reworks = events.filter((event) => event.type === 'rework.declared')
      const lines = [
        '',
        `## ${metrics.generatedAt} · ${change.id} ${change.title}`,
        '',
        `- 阶段：${change.stage}；复杂度 ${complexityLabel(change.complexity)} · 风险 ${riskLabel(change.risk)}`,
        `- 拦截最多的规则：${topRules.length > 0 ? topRules.map(([rule, count]) => `${rule}×${count}`).join('、') : '无'}`,
        `- M-5 误判率：${metrics.metrics['M-5'] !== undefined ? String(metrics.metrics['M-5']) : '未知'}`,
        `- 最慢阶段：${slowest !== undefined ? `${slowest.stage}（约 ${Math.round(slowest.ms / 60000)} 分钟）` : '未知'}`,
        `- 返工：${reworks.length > 0 ? reworks.map((event) => `${String(event.data?.kind ?? '')}：${String(event.data?.reason ?? '')}`).join('；') : '无'}`,
        '',
      ].join('\n')
      await this.fs.appendFile(layout.retro, lines)
    } catch {
      // 复盘日志写失败不影响指标/报告。
    }
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
        const text = `[FlowGate] 锁定模式：${this.state.locked.reason}。写操作被拒绝，等待负责人在授权卡片上修复。`
        return { text, approxTokens: approx(text) }
      }
      // v0.5.1：项目级暂停 / 事故自暂停——写操作放行，但 .flowgate 与 .git 仍受保护。
      if (this.flags.off !== undefined) {
        const incident = this.flags.incident
        const text =
          incident !== undefined
            ? `[FlowGate] 门禁已因事故暂停（${incident.id} · ${incident.severity}）：写操作放行，但 .flowgate/ 与 .git/ 仍受保护。修复完成后用 flow_incident_close 补审计记录；恢复：负责人 /flow on，或下一次宿主启动自动恢复。`
            : `[FlowGate] 项目门禁已暂停（${this.flags.off.reason}）：写操作放行，但 .flowgate/ 与 .git/ 仍受保护。恢复：负责人 /flow on，或下一次宿主启动自动恢复（agent 自暂停时）。`
        return { text, approxTokens: approx(text) }
      }
      // v0.5.1：修复通道（bugfix 一等公民）——无变更时也能迭代，RED→GREEN 关门。
      if (this.activeRepair !== null) {
        const repair = this.activeRepair
        const text = `[FlowGate] 修复通道 ${repair.id}「${repair.title}」（${repair.severity}）进行中：只允许改声明范围 ${repair.scope.join('、')}；验证命令 ${repair.verify}。当前${repair.redEvidenceId !== undefined ? '已有 RED' : '等待 RED'}${repair.greenEvidenceId !== undefined ? '、已有 GREEN' : ''}。下一步：${repair.redEvidenceId === undefined ? '写复现测试/跑失败命令，用 flow_verify 拿 RED' : '改代码并用 flow_verify 拿 GREEN，然后 flow_fix_done 关门（会跑全量回归并核对改动范围）'}。`
        return { text, approxTokens: approx(text) }
      }
      if (this.roadmapApprovedByOwner() && this.roadmapChangesCreated() === 0) {
        const first = this.roadmapDoc?.entries[0]?.change ?? 'C0'
        const text = `[FlowGate] 路线图已批准，但还没有立项变更。下一步：用 flow_new_change({ fromRoadmap: "${first}" }) 立项第一个变更（工程骨架 ${first}）；不要用无 fromRoadmap 的立项绕过路线图。`
        return { text, approxTokens: approx(text) }
      }
      const text = `[FlowGate] 项目已启用 FlowGate 但当前没有进行中的变更：任何改动都必须先立项（R-NO-CHANGE），修 bug 则用 flow_fix_start 开修复通道（推荐）。下一步：评估这次需求的大小与清晰度，然后调用 flow_new_change({ title, summary, assessment }) 立项。assessment 字段：route=full|standard|fast、autoApprove、clear、goal、acceptance[]、scope[]、verify、reasons[]；宿主 auto-review 会校验并可能调整：复杂/高风险/敏感面 → full；中等 → standard（合并 G1+G3 一次确认）；低复杂度且清晰可验证 → fast（G1/G3/G6 检查通过后自动放行，直到交付归档）。`
      return { text, approxTokens: approx(text) }
    }
    if (change.off) {
      const text = `[FlowGate] 本会话门禁已被负责人临时关闭，操作不再拦截；账本已记录。`
      return { text, approxTokens: approx(text) }
    }
    if (this.flags.off !== undefined) {
      const incident = this.flags.incident
      const text =
        incident !== undefined
          ? `[FlowGate] 门禁已因事故暂停（${incident.id} · ${incident.severity}）：写操作放行，但 .flowgate/ 与 .git/ 仍受保护。修复完成后用 flow_incident_close 补审计记录；恢复：负责人 /flow on，或下一次宿主启动自动恢复。`
          : `[FlowGate] 项目门禁已暂停（${this.flags.off.reason}）：写操作放行，但 .flowgate/ 与 .git/ 仍受保护。恢复：负责人 /flow on，或下一次宿主启动自动恢复。`
      return { text, approxTokens: approx(text) }
    }
    const lines: string[] = []
    lines.push(`[FlowGate] 变更 ${change.id}「${change.title}」｜阶段 ${change.stage} ${STAGE_LABELS[change.stage] ?? ''}｜${complexityLabel(change.complexity)} · ${riskLabel(change.risk)}`)
    if (change.flowPlan !== undefined) {
      const plan = change.flowPlan
      lines.push(
        `自动流程：${this.flowRouteLabel(plan.route)}${plan.autoApprove ? ' · 自动放行' : ''}${plan.verdict === 'adjusted' ? '（auto-review 已调整模型建议）' : ''}。`,
      )
    }
    if (this.state?.locked) {
      lines.push(`锁定模式：${this.state.locked.reason}。写操作被拒绝，等待负责人在授权卡片上修复。`)
      return { text: lines.join('\n'), approxTokens: approx(lines.join('\n')) }
    }
    const level = this.level()
    if (change.stage === 'roadmap') {
      lines.push('当前是项目级澄清与路线图：写 .flowgate/project-clarify.md 与 .flowgate/roadmap.md，第一个变更必须是工程骨架 C0；完成后 flow_submit({ gate: "GR" })。')
    } else if (change.stage === 'S0' || change.stage === 'S1') {
      lines.push('S1 需求澄清：先读相关代码与规格（事实带 `文件:起止行` 引用），再用 ask_user_question 澄清（每轮 ≤4 题），写 clarify.md / proposal.md / 增量规格，然后 flow_submit({ gate: "G1" })。六要素未闭合、未决问题不为 0、模糊词未量化都会被拦。')
      if (!this.hasSkillReceipt('flow-clarify')) lines.push('阶段核心技能：先用 skill 工具加载 flow-clarify（skill({ name: "flow-clarify" })）；G1 会核对加载回执，缺回执直接失败。')
    } else if (change.stage === 'S2') {
      lines.push('S2 上下文：写 context.md（接口约束、数据模型、非功能要求），确保 project.md 命令可执行；然后 flow_submit({ gate: "G2" })，插件会跑一次基线测试。')
    } else if (change.stage === 'S3') {
      lines.push('S3 设计拆解：写 design.md（' + (level.requiresDesignOptions ? '2–3 个方案对比、推荐与理由、数据流、错误处理、回滚' : '方案与理由') + '）、risk.md（五类）、tasks.md（任务卡 + 末尾执行计划批次），然后 flow_submit({ gate: "G3" })。')
      if (!this.hasSkillReceipt('flow-plan')) lines.push('阶段核心技能：先用 skill 工具加载 flow-plan（skill({ name: "flow-plan" })）；G3 会核对加载回执，缺回执直接失败。')
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
    // T4.8：交接摘要进入每步注入，上下文压缩后的下一步仍能恢复。
    if (change.handoff?.text) lines.push(`交接摘要：${change.handoff.text}`)
    const pending = change.pending.filter((item) => item.status === 'open')
    if (pending.length > 0) lines.push(`待负责人处理：${pending.map((item) => `${item.id} ${item.title}`).join('；')}`)
    const breaker = pending.find((item) => item.kind === 'blocker')
    if (breaker) {
      lines.push(
        `熔断阻断 ${breaker.id}：只读动作（read/grep、只读 shell）、flow_status/flow_diff/flow_report_risk 不受限，可先取证；等待负责人在授权卡片上确认后解锁。`,
      )
    }
    const awaiting = (Object.entries(change.gates) as [GateId, GateRecord][]).find(([, record]) => record.state === 'awaiting')
    if (awaiting) lines.push(`当前等待负责人批准 ${awaiting[0]}：结束本轮，告诉负责人到授权卡片上确认（批准或退回）。`)
    const violations = change.violations.filter((violation) => !violation.clearedAt)
    if (violations.length > 0) lines.push(`未撤销的越界改动：${violations.map((violation) => violation.path).join('、')}；撤销（git checkout -- 文件）或申请范围变更后才能继续写入。`)
    const external = (change.externalChanges ?? []).filter((item) => item.confirmedAt === undefined)
    if (external.length > 0) {
      lines.push(`非 agent 改动待确认：${external.map((item) => item.path).join('、')}；等待负责人在授权卡片上确认（G6 前必须处理）。`)
    }
    const notices = this.notices.slice(-3)
    if (notices.length > 0) lines.push(...notices)
    // NFR-8：每步运行时注入 ≤600 token——超了截断尾部，绝不无限增长。
    const budget = 600
    let text = lines.join('\n')
    if (approx(text) > budget) {
      const maxChars = budget * 2 - 2
      text = `${text.slice(0, Math.max(0, maxChars))}…`
    }
    return { text, approxTokens: approx(text) }
  }

  snapshot(): RuntimeSnapshot {
    const change = this.current
    const initialized = this.isInitialized()
    const pipeline = this.pipelineProgress(change)
    const level = change ? levelProfile(change.complexity, change.risk, this.configFor(change).limits) : null
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
      ...(change?.flowPlan !== undefined
        ? {
            flowPlan: {
              route: change.flowPlan.route,
              autoApprove: change.flowPlan.autoApprove,
              verdict: change.flowPlan.verdict,
              reasons: change.flowPlan.reasons.slice(-5),
            },
          }
        : {}),
      awaitingGate,
      pendingGate: change ? gateForStage(change.stage) ?? undefined : undefined,
      pipeline,
      tasks: change?.tasks ?? {},
      // T5.1：面板任务详情需要任务卡的 scope / 验证组 / covers；作为可选附加字段下发。
      ...(change !== null
        ? { taskCards: Object.fromEntries(this.getTasks().map((card) => [card.id, card])) }
        : {}),
      batches: change?.batches ?? [],
      activeTaskId: activeTask?.id,
      pending,
      violations,
      externalChanges: (change?.externalChanges ?? []).filter((item) => item.confirmedAt === undefined),
      resumed: this.resumed,
      exceptions: (change?.exceptions ?? []).filter((item) => item.revokedAt === undefined),
      off: (change?.off ?? false) || this.flags.off !== undefined,
      offBy: change?.off === true ? 'human' : this.flags.off?.by,
      takeover: this.takeover,
      ...(this.flags.incident !== undefined
        ? {
            incident: {
              id: this.flags.incident.id,
              severity: this.flags.incident.severity,
              reason: this.flags.incident.reason,
              openedAt: this.flags.incident.openedAt,
            },
          }
        : {}),
      ...(this.activeRepair !== null
        ? {
            repair: {
              id: this.activeRepair.id,
              title: this.activeRepair.title,
              severity: this.activeRepair.severity,
              status: 'open' as const,
              scope: [...this.activeRepair.scope],
              verify: this.activeRepair.verify,
              red: this.activeRepair.redEvidenceId !== undefined,
              green: this.activeRepair.greenEvidenceId !== undefined,
              openedAt: this.activeRepair.openedAt,
              actions: this.activeRepair.actions,
            },
          }
        : {}),
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

  /**
   * 用户可见的「下一步」短句（ui-interaction-redesign §5.3）。
   *
   * 需要负责人拍板的步骤统一写成「等待负责人在授权卡片上确认/处理」，不再提示
   * 负责人手输 `/flow ...`：授权卡片走客户端 `bridge.runCommand` 直接执行命令
   * （§0 规则 1）。`/flow` 命令本身保留给高级用户；agent 工具名（flow_submit 等）
   * 属于模型动作，可以出现在这里。
   */
  private nextStepText(change: ChangeStatus | null, level: LevelProfile | null): string {
    if (!this.isInitialized()) return 'FlowGate 未启用：在授权卡片上启用后继续'
    if (this.state?.locked) return 'FlowGate 已锁定：等待负责人在授权卡片上修复'
    // v0.5.1：项目级暂停 / 事故自暂停（写操作放行，.flowgate 与 .git 仍受保护）。
    if (this.flags.off !== undefined) {
      if (this.flags.incident !== undefined) {
        return `门禁因事故 ${this.flags.incident.id}（${this.flags.incident.severity}）已暂停：修复后用 flow_incident_close 补审计记录；恢复用 /flow on（或宿主重启自动恢复）`
      }
      return '门禁已暂停（项目级）：恢复用 /flow on，或下一次宿主启动自动恢复'
    }
    if (!change) {
      // v0.5.1：修复通道提示——先拿 RED 证据，再修到 GREEN 关门。
      if (this.activeRepair !== null) {
        const repair = this.activeRepair
        if (repair.redEvidenceId === undefined) return '先写复现测试/跑失败命令拿 RED：flow_verify'
        if (repair.greenEvidenceId === undefined) return '改代码到验证通过：flow_verify 拿 GREEN，然后 flow_fix_done'
        return '证据齐了：flow_fix_done 关门（会跑全量回归并核对改动范围）'
      }
      if (this.roadmapApprovedByOwner() && this.roadmapChangesCreated() === 0) {
        const first = this.roadmapDoc?.entries[0]?.change ?? 'C0'
        return `用 flow_new_change({ fromRoadmap: "${first}" }) 从已批准路线图立项（第一个变更必须是工程骨架 ${first}）`
      }
      return '用一句话描述你想做的变更，由 agent 立项；修 bug 可直接用 flow_fix_start 开修复通道'
    }
    if (change.off) return '门禁已关闭：可在授权卡片上恢复'
    const awaiting = (Object.entries(change.gates) as [GateId, GateRecord][]).find(([, record]) => record.state === 'awaiting')?.[0]
    if (awaiting) return `等待负责人在授权卡片上确认（${awaiting}）`
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
          return `等待负责人在授权卡片上处理 ${target}（连续失败已熔断；只读动作仍可执行）`
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
    if (!snap.initialized) return 'FlowGate 未启用 · 在授权卡片上启用'
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
      if (breaker) lines.push(`熔断阻断 ${breaker.id}：等待负责人在授权卡片上处理后解锁（只读动作不受限）`)
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
    if (!this.current) throw new FlowGateError('当前没有进行中的变更', '用一句话描述要做的变更，让 agent 立项；或在面板接续已有变更')
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

/** 在 clarify.md 的「问答记录」表格末尾追加一行；没有该节/表时补上。 */
export function appendClarifyQaRow(raw: string, row: string): string {
  const lines = raw.split('\n')
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s*.*(问答记录|questions?|qa)\b/i.test(line))
  const insertRow = (endIndex: number): number => {
    let target = endIndex
    while (target > 0 && lines[target - 1]!.trim() === '') target -= 1
    lines.splice(target, 0, row)
    return target
  }
  if (headingIndex >= 0) {
    let tableStart = -1
    let sectionEnd = lines.length
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^#{1,6}\s/.test(lines[index]!)) {
        sectionEnd = index
        break
      }
      if (tableStart < 0 && lines[index]!.trim().startsWith('|')) tableStart = index
    }
    if (tableStart >= 0) {
      let lastRow = tableStart
      for (let index = tableStart; index < sectionEnd; index += 1) {
        if (lines[index]!.trim().startsWith('|')) lastRow = index
        else if (lines[index]!.trim() !== '') break
      }
      insertRow(lastRow + 1)
      return lines.join('\n')
    }
    // 有节无表：插入表头。
    const header = ['| 问题 | 选项 | 回答 | 这个回答改变了什么 | 轮次 |', '|---|---|---|---|---|', row]
    lines.splice(headingIndex + 1, 0, '', ...header)
    return lines.join('\n')
  }
  lines.push('', '## 问答记录', '', '| 问题 | 选项 | 回答 | 这个回答改变了什么 | 轮次 |', '|---|---|---|---|---|', row)
  return lines.join('\n')
}

/**
 * 从需求描述里提取可能的文件/目录路径（FR-6.5 等级建议用）。
 * 只做保守识别：目录前缀（src/app/lib/...）或常见源码文件扩展名；不猜自然语言。
 */
export function extractMentionedPaths(text: string): string[] {
  const found = new Set<string>()
  const dirPattern = /(?:^|\s)((?:src|app|lib|packages?|services?|config|test|tests|docs|scripts|infra|migrations?)\/[\w./-]+)/g
  const filePattern = /(?:^|\s)([\w.-]+\.(?:java|kt|ts|tsx|js|jsx|mjs|py|go|rs|rb|php|sql|yaml|yml|json|xml|html|css|scss|md|sh|gradle|toml))\b/g
  for (const match of text.matchAll(dirPattern)) if (match[1]) found.add(match[1])
  for (const match of text.matchAll(filePattern)) if (match[1]) found.add(match[1])
  return [...found].sort().slice(0, 32)
}

export function buildStatusLine(snapshot: RuntimeSnapshot): string {
  if (!snapshot.initialized) return '◆ FlowGate 未启用 · 在授权卡片上启用'
  if (snapshot.locked) return '◆ FlowGate 锁定 · 等待负责人在授权卡片上修复'
  // v0.5.1：暂停/事故优先显示（写操作放行，但不改变既有正常文案）。
  if (snapshot.off) {
    const incident = snapshot.incident
    if (incident !== undefined) {
      return truncateStatusLine(`◆ FlowGate 事故暂停 ${incident.id}（${incident.severity}）│ 写操作放行 │ 下一步：${snapshot.nextStep}`)
    }
    return truncateStatusLine(
      `◆ FlowGate 门禁暂停${snapshot.offBy === 'agent' ? '（agent 自暂停）' : ''} │ 写操作放行 │ 下一步：${snapshot.nextStep}`,
    )
  }
  const parts: string[] = ['◆ FlowGate']
  // v0.5.1：修复通道（无变更）状态条。
  if (snapshot.repair !== undefined && !snapshot.changeId) {
    const repair = snapshot.repair
    parts.push(`修复 ${repair.id}`)
    parts.push(repair.red ? (repair.green ? 'RED→GREEN' : 'RED') : '待 RED')
    parts.push(`下一步：${snapshot.nextStep}`)
    return truncateStatusLine(parts.join(' │ '))
  }
  if (snapshot.changeId && snapshot.changeId !== 'PROJECT') {
    parts.push(snapshot.changeId)
    parts.push(`${complexityShort(snapshot.complexity)} · ${riskShort(snapshot.risk)}`)
  }
  if (snapshot.resumed) parts.push('已接续')
  if (snapshot.stage === 'roadmap') parts.push('路线图 ▸ 待 GR')
  else if (snapshot.awaitingGate) parts.push(`等待批准 ${snapshot.awaitingGate}`)
  else if (snapshot.stage) parts.push(`${stageCircle(snapshot.stage)} ${STAGE_LABELS[snapshot.stage] ?? snapshot.stage}`)
  // T3.7：S4 状态条显示当前任务与 TDD 状态（如「已接续 C-003 · S4 · T3 RED」）。
  if (snapshot.stage === 'S4' && snapshot.activeTaskId !== undefined) {
    const active = snapshot.tasks[snapshot.activeTaskId]
    if (active) {
      const tdd = active.tdd === 'red' ? 'RED' : active.tdd === 'green' ? 'GREEN' : active.status
      parts.push(`${active.id} ${tdd}`)
    }
  }
  const interceptCount = Object.values(snapshot.interceptCounts).reduce((sum, value) => sum + value, 0)
  if (interceptCount > 0 || snapshot.pending.length > 0) {
    parts.push(`拦截 ${interceptCount} · 待处理 ${snapshot.pending.length}`)
  }
  parts.push(`下一步：${snapshot.nextStep}`)
  return truncateStatusLine(parts.join(' │ '))
}

/** 状态条 ≤120 字符（超出截断并加省略号）。 */
function truncateStatusLine(text: string): string {
  if (text.length <= 120) return text
  return `${text.slice(0, 119)}…`
}

/**
 * finishRepair 的中文报告：证据 id、改动文件、回归结论、commit 与建议提交文案。
 * 直接返回给 host 展示/注入，不依赖客户端渲染。
 */
function renderRepairReport(
  record: RepairRecord,
  red: EvidenceReceipt,
  green: EvidenceReceipt,
  regression: EvidenceReceipt | undefined,
  notes: readonly string[],
): string {
  const changed =
    record.changedFiles !== undefined
      ? record.changedFiles.length > 0
        ? record.changedFiles.join('、')
        : '（无工作区改动）'
      : 'unknown（未收集到 git 改动，见备注）'
  const lines = [
    `修复完成 ${record.id}「${record.title}」（${record.severity}）`,
    `- RED 证据：${red.id}（${red.command}，exit=${red.exitCode}，${red.finishedAt}）`,
    `- GREEN 证据：${green.id}（重新运行 ${record.verify} 通过，${green.finishedAt}）`,
    `- 全量回归：${regression !== undefined ? `${regression.id}（通过）` : '未配置全量测试命令，已跳过'}`,
    `- 改动文件（${record.changedFiles !== undefined ? record.changedFiles.length : 'unknown'}）：${changed}`,
    `- commit：${record.commit === null || record.commit === undefined ? '（未获取到 git HEAD；完成修复后请自行提交）' : record.commit}`,
    `- 审计记录：.flowgate/fixes/${record.id}.json；索引 .flowgate/fixes/index.md`,
    ...notes.map((note) => `- 备注：${note}`),
    '',
    '建议提交信息：',
    `fix: ${record.title}`,
  ]
  if (record.symptom !== '') lines.push('', `症状：${record.symptom}`)
  if (record.summary !== undefined && record.summary !== '' && record.summary !== `修复完成：${record.title}`) {
    lines.push('', record.summary)
  }
  return lines.join('\n')
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
