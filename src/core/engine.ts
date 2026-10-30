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
} from './state'
import {
  evaluateRules,
  loadRules,
  fingerprintAction,
  actionFromToolCall,
  BLOCKED_DELEGATION_TOOLS,
  explainDecision,
} from './rules'
import { validateVerifyCommand } from './shell'
import { loadArtifacts, loadProjectDoc, runGateChecks, artifactHashes, parseIncrementalSpec, parseRoadmap } from './artifacts'
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
} from './evidence'
import { invalidateOnRework } from './revision'
import { computeMetrics } from './metrics'
import { renderChangeReport } from './report'
import { renderDashboard } from './dashboard'

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
  private interceptCounts: Record<string, number> = {}
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
      this.state = await store.loadProjectState({
        fs: this.fs,
        root: this.root,
        config: this.config,
        clock: this.clock,
      })
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

      this.receipts = await this.loadReceipts()
      this.project = await loadProjectDoc(this.fs, this.root)
      this.roadmapDoc = await this.loadRoadmapDoc()
      await this.rebuildCounters()

      // Attach session / current change.
      const leases = this.state.leases
      const mine = this.sessionId ? leases.find((lease) => lease.sessionId === this.sessionId) : undefined
      if (mine) {
        this.current = this.state.changes.find((change) => change.id === mine.changeId) ?? null
      } else {
        await this.autoAttach()
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

  private async rebuildCounters(): Promise<void> {
    this.interceptCounts = {}
    if (!this.ledger) return
    try {
      const events = await this.ledger.readAll()
      for (const event of events) {
        if (event.type === 'rule.denied' || event.type === 'rule.human') {
          const ruleId = String(event.data.ruleId ?? 'unknown')
          this.interceptCounts[ruleId] = (this.interceptCounts[ruleId] ?? 0) + 1
        }
      }
      this.evidenceCounter = this.receipts.length
    } catch {
      // Ledger unreadable: keep counters empty; locked mode already recorded.
    }
  }

  private async autoAttach(): Promise<void> {
    if (!this.state || !this.sessionId) return
    const active = this.state.changes.filter(
      (change) => change.lifecycle === 'active' && change.kind === 'change' && change.id !== 'PROJECT',
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

    const changeId = store.nextChangeId(this.state.changes, input.kind ?? 'change')
    const change = initialStatus({
      id: changeId,
      kind: input.kind ?? 'change',
      title,
      summary: input.summary,
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
    await this.recordGateResult(change, 'G0', await this.evaluateGate(change, 'G0'), now)
    await this.saveChange(change)
    if (input.kind === 'analysis') {
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
          : `变更 ${change.id} 已创建，建议复杂度 ${complexityLabel(complexity)}、风险 ${riskLabel(risk)}（负责人可在 G1 确认或调整）。`,
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
      await this.saveChange(change)
      return {
        gate,
        passed: false,
        items: result.items,
        failures: result.failures,
        stage: change.stage,
        message: `G${gate.slice(1)} 未通过：${result.failures.map((failure) => failure.label).join('；')}`,
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
      await this.saveChange(change)
      this.pushNotice('路线图已批准。用 /flow new --from-roadmap C1（或 flow_new_change）立项第一个变更；第一个变更固定是工程骨架 C0。')
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

    const task = this.getTask(this.activeTask()?.id ?? '')
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
    if (active) throw new FlowGateError(`任务 ${active.id} 正在进行中`, '先完成或暂停当前任务')
    if (this.config.dispatch === 'subagent' && task.run !== 'main') {
      throw new FlowGateError('当前是派发模式', '用 flow_dispatch_next 按执行图派发，不要自己领取任务')
    }
    const expected = this.nextTaskToStart(tasks)
    if (!expected) throw new FlowGateError('当前没有可领取的任务', '检查执行图与批次状态')
    if (expected.taskId !== taskId) {
      throw new FlowGateError(
        `执行图要求先做 ${expected.taskId}`,
        `当前批次 ${expected.batchId}（${expected.mode}），下一个可领取的是 ${expected.taskId}`,
      )
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
      tdd: task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.config.limits).tddRequiredAll,
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
    const tddRequired = task.tdd === 'required' || level.tddRequiredAll
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
      if (state.status === 'checkpoint') {
        return {
          dispatched: [],
          batchId: batch.batch,
          mode: batch.mode,
          message: `批次 ${batch.batch} 的任务全部完成，先完成集成检查点（合并 worktree + 全量测试），调用 completeCheckpoint 后再继续派发。`,
        }
      }
      if (batch.mode === 'parallel') {
        const running = batch.tasks.filter((id) => change.tasks[id]?.status === 'running')
        const queued = batch.tasks.filter((id) => {
          const taskState = change.tasks[id]
          return taskState && (taskState.status === 'pending' || taskState.status === 'queued' || taskState.status === 'interrupted')
        })
        const capacity = Math.max(0, this.config.parallel.max_agents - running.length)
        const toStart = queued.slice(0, capacity)
        if (toStart.length === 0) {
          if (running.length > 0) return { dispatched: [], batchId: batch.batch, mode: batch.mode, message: `批次 ${batch.batch} 已有 ${running.length} 个子 agent 在运行，达到并发上限 ${this.config.parallel.max_agents}。` }
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
        await this.saveChange(change)
        this.pushNotice(`已派发批次 ${batch.batch}（并行）的 ${dispatched.map((item) => item.taskId).join('、')}；每个任务在自己的 worktree 里执行。`)
        return { dispatched, batchId: batch.batch, mode: batch.mode, message: `已派发 ${dispatched.map((item) => item.taskId).join('、')}（并行批次 ${batch.batch}）。` }
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
      if (batch.mode === 'parallel' && state.status !== 'checkpoint') {
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

  async completeCheckpoint(batchId: string, result: { ok: boolean; detail?: string }): Promise<void> {
    const change = this.requireChange()
    const now = isoNow(this.clock)
    const batch = change.batches.find((item) => item.id === batchId)
    if (!batch) throw new FlowGateError(`没有批次 ${batchId}`, '运行 /flow 查看执行图')
    if (result.ok) {
      batch.status = 'done'
      batch.completedAt = now
      batch.checkpoint = { status: 'passed', at: now, detail: result.detail }
      await this.appendLedger('checkpoint.passed', { changeId: change.id, batch: batchId })
    } else {
      batch.status = 'failed'
      batch.checkpoint = { status: 'failed', at: now, detail: result.detail }
      await this.appendLedger('checkpoint.failed', { changeId: change.id, batch: batchId, detail: result.detail })
      this.createPending(change, {
        kind: 'conflict',
        title: `批次 ${batchId} 集成检查点失败`,
        detail: result.detail ?? '合并或全量测试失败，需要负责人决定如何处理。',
        data: { batchId },
      })
    }
    await this.checkBatchProgress(change, now)
    await this.saveChange(change)
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
        const tddRequired = task.tdd === 'required' || levelProfile(change.complexity, change.risk, this.config.limits).tddRequiredAll
        if (!tddRequired || taskState.redObserved) taskState.tdd = 'green'
      }
      if (receipt.exitCode !== 0) {
        taskState.failureCount = (taskState.failureCount ?? 0) + 1
        if (taskState.failureCount >= this.config.triggers.consecutive_failure_limit) {
          taskState.status = 'blocked'
          taskState.blockReason = `连续 ${taskState.failureCount} 次验证失败`
          this.createPending(change, {
            kind: 'blocker',
            title: `${task.id} 连续 ${taskState.failureCount} 次验证失败，已暂停`,
            detail: '先复现、找根因、再修复；不要继续试错。负责人确认后继续。',
            data: { taskId: task.id },
          })
          await this.appendLedger('task.blocked', { changeId: change.id, taskId: task.id, reason: 'consecutive-failures' })
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
        await this.applyPlanAmendment(change, item)
        await this.appendLedger('plan.amended', { changeId: change.id, pendingId: id })
      }
      await this.appendLedger('gate.approved', { changeId: change.id, pendingId: id, kind: item.kind })
    } else {
      if (item.kind === 'scope') await this.appendLedger('scope.rejected', { changeId: change.id, pendingId: id, reason })
      else if (item.kind === 'risk') await this.appendLedger('risk.rejected', { changeId: change.id, pendingId: id, reason })
      else await this.appendLedger('gate.rejected', { changeId: change.id, pendingId: id, kind: item.kind, reason })
    }
    this.pushNotice(`待处理项 ${id} 已${decision === 'approved' ? '批准' : '拒绝'}${reason ? `：${reason}` : ''}。`)
    await this.saveChange(change)
    return item
  }

  private async persistRule(item: PendingItem): Promise<void> {
    const layout = store.layout(this.root)
    const ruleId = String(item.data?.ruleId ?? `RL-${item.id}`)
    const path = posixJoin(layout.rulesDir, `${ruleId}.md`)
    const md = `# 项目规则 ${ruleId}\n\n## 问题\n\n${String(item.data?.finding ?? item.detail)}\n\n## 规则\n\n${String(item.data?.rule ?? '')}\n\n## 正确写法示例\n\n${String(item.data?.example ?? '')}\n\n## 适用范围\n\n${String(item.data?.scope ?? '')}\n`
    await this.fs.writeFile(path, md)
  }

  private async applyPlanAmendment(change: ChangeStatus, item: PendingItem): Promise<void> {
    const reorder = (item.data?.reorder as string[] | undefined) ?? []
    if (reorder.length > 0 && change.plan) {
      // Reordering within the same batch is expressed by the owner; keep a record for the panel.
      change.plan = { ...change.plan, batches: change.plan.batches.map((batch) => ({ ...batch })) }
    }
    void item
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
    const active = (this.state?.changes ?? []).filter((change) => change.lifecycle === 'active' && change.id !== 'PROJECT')
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
   * Incremental specs are copied under `.flowgate/specs/<id>/` as a minimal
   * merge step (full main-spec merging is a v1.0 refinement, tracked in docs).
   */
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
    // Keep a copy of the incremental spec under the project specs tree.
    const specCopy = posixJoin(layout.specsDir, change.id)
    await this.fs.mkdir(specCopy)
    if (await this.fs.exists(paths.spec)) {
      await this.fs.writeFile(posixJoin(specCopy, 'spec.md'), await this.fs.readFile(paths.spec))
    }
    change.lifecycle = 'archived'
    change.stage = 'archived'
    await this.fs.writeFile(posixJoin(archiveDir, 'status.json'), `${JSON.stringify(change, null, 2)}\n`)
    await this.fs.remove(paths.dir)
    await this.appendLedger('report.generated', { changeId: change.id, path: posixJoin(archiveDir, 'report.html') })
    this.pushNotice(`${change.id} 已交付归档到 ${archiveDir}。建议开新会话继续下一个变更。`)
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
    // Rebuild status.json / changes index from the ledger snapshots + artifacts.
    const rebuilt = await store.rebuildState(this.fs, this.root)
    await this.load()
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
      message: `已从账本与产物重建 ${rebuilt.rebuilt.length} 个变更（保留 ${rebuilt.kept.length} 个），锁定模式解除。`,
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
    if (!change) return '用 /flow new <描述> 立项'
    if (this.state?.locked) return '运行 /flow doctor 诊断，/flow repair 恢复'
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
