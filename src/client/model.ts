/**
 * Client view-model mapping (pure functions — SSR testable, no DOM).
 *
 * Input: the host projection (`FlowgateProjection`, see docs/impl/host-client-contract.md)
 * or `null`. Output: plain-data view models the React views render. Every field
 * is narrowed defensively: a missing / malformed field degrades to "暂无 / 未启用"
 * instead of throwing (FR-8.2, 03 §14 "浏览器插件加载失败" row).
 */
import type {
  BatchState,
  CoverageReport,
  PendingItem,
  RuntimeSnapshot,
  StageId,
  TaskState,
} from '../core/types'
import type { TFn } from './i18n'
import { localeOf } from './i18n'
import type {
  ChangeSummary,
  ComplexityLevel,
  EvidenceRow,
  FlowgateProjection,
  GateItem,
  GatePanel,
  GateState,
  InterceptRow,
  LearningMode,
  Lifecycle,
  MergedConfirm,
  ReviewRow,
  RiskLevel,
  RiskRow,
  RoadmapSummary,
  RuleRow,
  TraceRow,
  ChangeKind,
} from './types'
import { PROJECTION_KEY } from './types'
import type { Tone } from './theme'
import { toneOf } from './theme'

export { toneOf }
import type { PipelineStageId } from './learn/cards'
import { cardsFor } from './learn/cards'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const STATUS_LINE_MAX = 120

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Character-safe truncation (CJK / surrogate pairs count as one char). */
export function truncateChars(text: string, max: number = STATUS_LINE_MAX): string {
  if (max <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

export function textLength(text: string): number {
  return Array.from(text).length
}

const STAGE_ORDER: PipelineStageId[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']

/** Normalize any stage string; unknown values are shown verbatim by views. */
export function normalizeStage(value: unknown): string {
  const raw = str(value, '')
  if (raw === 'roadmap' || raw === 'archived' || raw === 'locked') return raw
  return (STAGE_ORDER as string[]).includes(raw) ? raw : raw
}

function stageKey(stage: string): PipelineStageId {
  if (stage === 'S1') return 'S1'
  if (stage === 'S2') return 'S2'
  if (stage === 'S3') return 'S3'
  if (stage === 'S4') return 'S4'
  if (stage === 'S5') return 'S5'
  if (stage === 'S6') return 'S6'
  return 'S0'
}

/** Stage display label with i18n fallback to the raw value. */
export function stageLabel(stage: string, t: TFn): string {
  if ((STAGE_ORDER as string[]).includes(stage)) {
    return t(`stage.${stage as PipelineStageId}`)
  }
  if (stage === 'roadmap') return t('stage.roadmap')
  if (stage === 'archived') return t('stage.archived')
  if (stage === 'locked') return t('stage.locked')
  return stage
}

/** Circled index used by the status bar (S0→⓪ … S6→⑥). */
export function stageIndex(stage: string, t: TFn): string {
  if (stage === 'roadmap') return t('stage.idx.roadmap')
  const key = stageKey(stage)
  return t(`stage.idx.${key as PipelineStageId}`)
}

export function complexityLabel(level: string | undefined, t: TFn): string {
  switch (level) {
    case 'low':
      return t('complexity.low')
    case 'medium':
      return t('complexity.medium')
    case 'high':
      return t('complexity.high')
    case 'ultra':
      return t('complexity.ultra')
    default:
      return level !== undefined && level !== '' ? level : t('common.unknown')
  }
}

export function riskLabel(level: string | undefined, t: TFn): string {
  switch (level) {
    case 'normal':
      return t('risk.normal')
    case 'high':
      return t('risk.high')
    default:
      return level !== undefined && level !== '' ? level : t('common.unknown')
  }
}

export function lifecycleLabel(value: string | undefined, t: TFn): string {
  switch (value) {
    case 'active':
      return t('lifecycle.active')
    case 'paused':
      return t('lifecycle.paused')
    case 'archived':
      return t('lifecycle.archived')
    case 'blocked':
      return t('lifecycle.blocked')
    case 'locked':
      return t('lifecycle.locked')
    default:
      return value !== undefined && value !== '' ? value : t('common.unknown')
  }
}

export function taskStatusLabel(status: string | undefined, t: TFn): string {
  switch (status) {
    case 'pending':
      return t('tasks.status.pending')
    case 'queued':
      return t('tasks.status.queued')
    case 'running':
      return t('tasks.status.running')
    case 'review':
      return t('tasks.status.review')
    case 'done':
      return t('tasks.status.done')
    case 'blocked':
      return t('tasks.status.blocked')
    case 'interrupted':
      return t('tasks.status.interrupted')
    case 'failed':
      return t('tasks.status.failed')
    case 'skipped':
      return t('tasks.status.skipped')
    default:
      return status !== undefined && status !== '' ? status : t('common.unknown')
  }
}

export function gateStateLabel(state: string | undefined, t: TFn): string {
  switch (state) {
    case 'pending':
      return t('gate.state.pending')
    case 'awaiting':
      return t('gate.state.awaiting')
    case 'passed':
      return t('gate.state.passed')
    case 'failed':
      return t('gate.state.failed')
    case 'rejected':
      return t('gate.state.rejected')
    case 'skipped':
      return t('gate.state.skipped')
    default:
      return state !== undefined && state !== '' ? state : t('common.unknown')
  }
}

/** Render a relative-ish timestamp: only HH:MM:SS for compact panel rows. */
export function shortTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '—'
  const match = /T(\d{2}:\d{2})(:\d{2})?/.exec(iso)
  if (match !== null) return match[1] + (match[2] ?? '')
  return iso
}

// ---------------------------------------------------------------------------
// Projection normalization
// ---------------------------------------------------------------------------

export function emptySnapshot(): RuntimeSnapshot {
  return {
    initialized: false,
    pipeline: [],
    tasks: {},
    batches: [],
    pending: [],
    violations: [],
    off: false,
    locked: false,
    interceptCounts: {},
    nextStep: '',
    statusLine: '',
    updatedAt: '',
  }
}

function coerceSnapshot(raw: unknown): RuntimeSnapshot | null {
  if (!isRecord(raw)) return null
  const initialized = raw.initialized === true
  const hasShape =
    initialized ||
    Array.isArray(raw.pipeline) ||
    typeof raw.changeId === 'string' ||
    typeof raw.updatedAt === 'string'
  if (!hasShape) return null
  const pipeline = Array.isArray(raw.pipeline)
    ? raw.pipeline
        .filter(isRecord)
        .map((entry) => ({
          stage: normalizeStage(entry.stage) as StageId,
          label: str(entry.label),
          status: (entry.status === 'done' || entry.status === 'current' || entry.status === 'pending' || entry.status === 'blocked'
            ? entry.status
            : 'pending') as RuntimeSnapshot['pipeline'][number]['status'],
        }))
    : []
  return {
    initialized,
    changeId: typeof raw.changeId === 'string' ? raw.changeId : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    kind: raw.kind === 'analysis' ? 'analysis' : raw.kind === 'change' ? 'change' : undefined,
    complexity: raw.complexity as ComplexityLevel | undefined,
    risk: raw.risk as RiskLevel | undefined,
    stage: typeof raw.stage === 'string' ? (normalizeStage(raw.stage) as StageId) : undefined,
    lifecycle: raw.lifecycle as Lifecycle | undefined,
    awaitingGate:
      typeof raw.awaitingGate === 'string' ? (raw.awaitingGate as unknown as RuntimeSnapshot['awaitingGate']) : undefined,
    pendingGate:
      typeof raw.pendingGate === 'string' ? (raw.pendingGate as unknown as RuntimeSnapshot['pendingGate']) : undefined,
    pipeline,
    tasks: isRecord(raw.tasks) ? (raw.tasks as Record<string, TaskState>) : {},
    batches: Array.isArray(raw.batches) ? (raw.batches.filter(isRecord) as unknown as BatchState[]) : [],
    activeTaskId: typeof raw.activeTaskId === 'string' ? raw.activeTaskId : undefined,
    pending: Array.isArray(raw.pending) ? (raw.pending.filter(isRecord) as unknown as PendingItem[]) : [],
    violations: Array.isArray(raw.violations)
      ? (raw.violations.filter(isRecord) as unknown as RuntimeSnapshot['violations'])
      : [],
    exceptions: Array.isArray(raw.exceptions)
      ? (raw.exceptions.filter(isRecord) as unknown as NonNullable<RuntimeSnapshot['exceptions']>)
      : [],
    externalChanges: Array.isArray(raw.externalChanges)
      ? (raw.externalChanges.filter(isRecord).map((entry) => ({
          path: str(entry.path) ?? '',
          at: str(entry.at) ?? '',
          origin: entry.origin === 'external' ? ('external' as const) : ('unknown' as const),
          ...(typeof entry.confirmedAt === 'string' ? { confirmedAt: entry.confirmedAt } : {}),
        })) as RuntimeSnapshot['externalChanges'])
      : [],
    off: raw.off === true,
    locked: raw.locked === true,
    interceptCounts: isRecord(raw.interceptCounts)
      ? Object.fromEntries(
          Object.entries(raw.interceptCounts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        )
      : {},
    coverage: isRecord(raw.coverage) ? (raw.coverage as unknown as CoverageReport) : undefined,
    nextStep: str(raw.nextStep),
    statusLine: str(raw.statusLine),
    updatedAt: str(raw.updatedAt),
  }
}

/** Panel extras after defensive narrowing (same shape, optional members only). */
export interface MetricsExtra {
  change: Record<string, number | '未知'>
  total?: Record<string, number | '未知'>
  notes?: Record<string, string>
}

export interface PanelExtrasSafe {
  changes?: ChangeSummary[]
  gate?: GatePanel
  trace?: TraceRow[]
  risks?: RiskRow[]
  intercepts?: InterceptRow[]
  rules?: RuleRow[]
  metrics?: MetricsExtra
  evidence?: EvidenceRow[]
  reviews?: ReviewRow[]
  roadmap?: RoadmapSummary
  dashboardPath?: string
}

function narrowPanel(raw: unknown): PanelExtrasSafe {
  if (!isRecord(raw)) return {}
  const panel: PanelExtrasSafe = {}
  if (Array.isArray(raw.changes)) panel.changes = raw.changes.filter(isRecord) as unknown as ChangeSummary[]
  if (isRecord(raw.gate)) panel.gate = raw.gate as unknown as GatePanel
  if (Array.isArray(raw.trace)) panel.trace = raw.trace.filter(isRecord) as unknown as TraceRow[]
  if (Array.isArray(raw.risks)) panel.risks = raw.risks.filter(isRecord) as unknown as RiskRow[]
  if (Array.isArray(raw.intercepts)) panel.intercepts = raw.intercepts.filter(isRecord) as unknown as InterceptRow[]
  if (Array.isArray(raw.rules)) panel.rules = raw.rules.filter(isRecord) as unknown as RuleRow[]
  if (isRecord(raw.metrics)) panel.metrics = raw.metrics as unknown as MetricsExtra
  if (Array.isArray(raw.evidence)) panel.evidence = raw.evidence.filter(isRecord) as unknown as EvidenceRow[]
  if (Array.isArray(raw.reviews)) panel.reviews = raw.reviews.filter(isRecord) as unknown as ReviewRow[]
  if (isRecord(raw.roadmap)) panel.roadmap = raw.roadmap as unknown as RoadmapSummary
  if (typeof raw.dashboardPath === 'string') panel.dashboardPath = raw.dashboardPath
  return panel
}

/**
 * Narrow a raw projection value. Accepts both the contract shape
 * (`{snapshot, panel?, learning?, revision, updatedAt}`) and a bare
 * `RuntimeSnapshot` for forward/backward compatibility.
 */
export function normalizeProjection(raw: unknown): FlowgateProjection | null {
  if (!isRecord(raw)) return null
  const snapshot = coerceSnapshot(isRecord(raw.snapshot) ? raw.snapshot : raw)
  if (snapshot === null) return null
  const learning: LearningMode | undefined =
    raw.learning === 'detail' || raw.learning === 'brief' || raw.learning === 'off' ? raw.learning : undefined
  return {
    snapshot,
    panel: narrowPanel(raw.panel),
    learning,
    revision: numOr(raw.revision, 0),
    updatedAt: str(raw.updatedAt, snapshot.updatedAt),
    ...(typeof raw.epoch === 'string' && raw.epoch !== '' ? { epoch: raw.epoch } : {}),
  }
}

/** Read the projection from a slot component's standard kit. */
export function readProjection(props: { useProjection?: (key: string) => unknown } | undefined): FlowgateProjection | null {
  if (props === undefined || typeof props.useProjection !== 'function') return null
  try {
    return normalizeProjection(props.useProjection(PROJECTION_KEY))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Status bar (FR-8.1, T1.6)
// ---------------------------------------------------------------------------

export interface StatusBarModel {
  text: string
  tone: Tone
  initialized: boolean
  changeId?: string
  stage?: string
  awaitingGate?: string
  interceptCount: number
  pendingCount: number
  /** Full aria label (the visible text may be truncated). */
  ariaLabel: string
}

export function awaitingText(gate: string | undefined, t: TFn): string {
  switch (gate) {
    case 'G1':
      return t('status.awaiting.g1')
    case 'G3':
      return t('status.awaiting.g3')
    case 'G6':
      return t('status.awaiting.g6')
    case 'GR':
      return t('status.awaiting.gr')
    default:
      return t('status.awaiting.generic')
  }
}

export function interceptTotal(snapshot: RuntimeSnapshot | null | undefined): number {
  if (snapshot === null || snapshot === undefined) return 0
  let total = 0
  for (const value of Object.values(snapshot.interceptCounts ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/** Compose the one-line status text; always ≤ 120 characters (T1.6). */
export function buildStatusLine(snapshot: RuntimeSnapshot | null | undefined, t: TFn): string {
  if (snapshot === null || snapshot === undefined || snapshot.initialized !== true) {
    return truncateChars(t('status.demo'))
  }
  if (snapshot.locked === true) return truncateChars(t('status.locked'))
  if (snapshot.off === true) return truncateChars(t('status.off'))
  if (snapshot.changeId === undefined || snapshot.changeId === '') {
    return truncateChars(`${t('status.idle')} │ ${t('status.noChange')}`)
  }

  const stage = normalizeStage(snapshot.stage)
  const parts: string[] = []
  parts.push(
    `◆ FlowGate ${snapshot.changeId} ${complexityLabel(snapshot.complexity, t)} · ${riskLabel(snapshot.risk, t)}`,
  )
  let phase = `${stageIndex(stage, t)} ${stageLabel(stage, t)}`
  if (snapshot.awaitingGate !== undefined) {
    phase += ` ▸ ${awaitingText(snapshot.awaitingGate, t)}`
  } else if (snapshot.pending !== undefined && snapshot.pending.length > 0) {
    phase += ` ▸ ${t('status.awaiting.generic')}`
  }
  parts.push(phase)

  const counts: string[] = []
  const intercepts = interceptTotal(snapshot)
  if (intercepts > 0 || snapshot.awaitingGate !== undefined) {
    counts.push(t('status.intercepts', { n: intercepts }))
  }
  const pendingCount = Array.isArray(snapshot.pending) ? snapshot.pending.length : 0
  if (pendingCount > 0 || snapshot.awaitingGate !== undefined) {
    counts.push(t('status.pending', { n: pendingCount }))
  }
  if (counts.length > 0) parts.push(counts.join(' · '))

  const next = snapshot.nextStep !== undefined ? snapshot.nextStep.trim() : ''
  if (next !== '') parts.push(t('status.next', { next }))

  // Optional host-provided context ratio (not part of the frozen snapshot; degrade silently).
  const contextPct = (snapshot as unknown as Record<string, unknown>).contextPct
  if (typeof contextPct === 'number' && contextPct >= 60) {
    parts.push(t('status.context', { pct: Math.round(contextPct) }))
  }

  return truncateChars(parts.join(' │ '))
}

export function buildStatusBarModel(proj: FlowgateProjection | null, t: TFn): StatusBarModel {
  const snapshot = proj?.snapshot ?? null
  const text = buildStatusLine(snapshot, t)
  return {
    text,
    tone: toneOf(snapshot),
    initialized: snapshot?.initialized === true,
    changeId: snapshot?.changeId,
    stage: snapshot?.stage !== undefined ? normalizeStage(snapshot.stage) : undefined,
    awaitingGate: snapshot?.awaitingGate,
    interceptCount: interceptTotal(snapshot),
    pendingCount: Array.isArray(snapshot?.pending) ? snapshot.pending.length : 0,
    ariaLabel: t('status.aria', { text }),
  }
}

// ---------------------------------------------------------------------------
// Panel view models
// ---------------------------------------------------------------------------

export interface StageNodeModel {
  stage: string
  label: string
  index: string
  status: 'done' | 'current' | 'pending' | 'blocked'
  isCurrent: boolean
}

export interface GateModel {
  gate: string | null
  state: GateState
  items: GateItem[]
  awaitingOwner: boolean
  mergedConfirm?: MergedConfirm
  /** Gate that belongs to the current stage even when the panel extra is absent. */
  derivedGate: string | null
}

export interface LedgerRowModel {
  id: string
  title: string
  kind: ChangeKind
  complexity: string
  risk: string
  stage: string
  stageDisplay: string
  lifecycle: string
  lifecycleDisplay: string
  session?: string
  updatedAt: string
  current: boolean
  artifactLinks: { label: string; path: string }[]
}

export interface TaskCardModel {
  id: string
  title: string
  status: string
  batch: string
  tdd: string
  evidence: 'fresh' | 'stale' | 'none'
  reviewFindings: number
  worktree?: string
  agent?: string
  failureCount: number
  blockReason?: string
}

export interface ExecutionNodeModel {
  id: string
  title: string
  status: string
  batch: string
  x: number
  y: number
  width: number
  height: number
  worktree?: string
  agent?: string
}

export interface ExecutionBatchModel {
  id: string
  mode: 'sequential' | 'parallel'
  status: string
  x: number
  y: number
  width: number
  height: number
  taskIds: string[]
  checkpoint: { status: string; x: number; y: number } | null
}

export interface ExecutionEdgeModel {
  id: string
  from: string
  to: string
  kind: 'sequence' | 'parallel' | 'checkpoint'
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface ExecutionGraphModel {
  width: number
  height: number
  batches: ExecutionBatchModel[]
  nodes: ExecutionNodeModel[]
  edges: ExecutionEdgeModel[]
  empty: boolean
}

export interface MetricRowModel {
  id: string
  label: string
  value: string
  note?: string
}

export interface MetricRowsModel {
  change: MetricRowModel[]
  total: MetricRowModel[] | null
  hasData: boolean
}

export interface PanelModel {
  initialized: boolean
  hasData: boolean
  snapshot: RuntimeSnapshot | null
  revision: number
  updatedAt: string
  changeId?: string
  title?: string
  kind?: ChangeKind
  complexity?: string
  risk?: string
  stage?: string
  lifecycle?: string
  learning: LearningMode
  pipeline: StageNodeModel[]
  roadmap?: RoadmapSummary
  gate: GateModel
  ledger: LedgerRowModel[]
  tasks: TaskCardModel[]
  tasksByStatus: TaskGroups
  execution: ExecutionGraphModel
  trace: TraceRow[] | null
  uncoveredScenarios: string[]
  risks: RiskRow[]
  pendingRisks: PendingItem[]
  intercepts: InterceptRow[]
  rules: RuleRow[]
  coverage: CoverageReport | null
  metrics: MetricRowsModel
  evidence: EvidenceRow[]
  reviews: ReviewRow[]
  /** 未经负责人确认的非 agent 改动（G6 前必须清空）。 */
  externalChanges: NonNullable<RuntimeSnapshot['externalChanges']>
  /** 生效中的规则例外（面板可撤销，T5.1 验收 #1）。 */
  exceptions: NonNullable<RuntimeSnapshot['exceptions']>
  off: boolean
  locked: boolean
}

const GATE_FOR_STAGE: Record<string, string> = {
  S0: 'G0',
  S1: 'G1',
  S2: 'G2',
  S3: 'G3',
  S4: 'G4',
  S5: 'G5',
  S6: 'G6',
}

export function gateForStage(stage: string | undefined): string | null {
  if (stage === undefined) return null
  return GATE_FOR_STAGE[stage] ?? null
}

export function buildPipelineNodes(snapshot: RuntimeSnapshot | null, t: TFn): StageNodeModel[] {
  if (snapshot === null || snapshot.initialized !== true) return []
  const progress = snapshot.pipeline ?? []
  if (progress.length === 0) {
    return STAGE_ORDER.map((stage) => ({
      stage,
      label: t(`stage.${stage}`),
      index: t(`stage.idx.${stage}`),
      status: snapshot?.stage === stage ? 'current' : 'pending',
      isCurrent: snapshot?.stage === stage,
    }))
  }
  return progress
    .filter((entry) => typeof entry.stage === 'string')
    .map((entry) => {
      const stage = normalizeStage(entry.stage)
      const status =
        entry.status === 'done' || entry.status === 'current' || entry.status === 'blocked' || entry.status === 'pending'
          ? entry.status
          : 'pending'
      return {
        stage,
        label: stageLabel(stage, t),
        index: stageIndex(stage, t),
        status,
        isCurrent: status === 'current',
      }
    })
}

function makeTaskModels(proj: FlowgateProjection | null): TaskCardModel[] {
  const snapshot = proj?.snapshot
  if (snapshot === null || snapshot === undefined) return []
  const panel = proj?.panel ?? {}
  const evidenceRows = panel.evidence ?? []
  const reviewRows = panel.reviews ?? []
  const batches = snapshot.batches ?? []
  const batchOf = new Map<string, string>()
  for (const batch of batches) {
    for (const taskId of batch.tasks ?? []) batchOf.set(taskId, batch.id)
  }
  return Object.entries(snapshot.tasks ?? {}).map(([id, state]) => {
    const rows = evidenceRows.filter((row) => row.taskId === id)
    const evidence: TaskCardModel['evidence'] =
      rows.length === 0 ? 'none' : rows.some((row) => row.fresh === true) ? 'fresh' : 'stale'
    const findings = reviewRows
      .filter((row) => row.taskId === id)
      .reduce((sum, row) => sum + (Array.isArray(row.findings) ? row.findings.length : 0), 0)
    return {
      id,
      title: id,
      status: str(state.status, 'pending'),
      batch: batchOf.get(id) ?? str(state.batch),
      tdd: str(state.tdd, 'none'),
      evidence,
      reviewFindings: findings,
      worktree: state.worktree,
      agent: state.agent,
      failureCount: numOr(state.failureCount, 0),
      blockReason: state.blockReason,
    }
  })
}

export function buildExecutionGraph(snapshot: RuntimeSnapshot | null): ExecutionGraphModel {
  const batches = snapshot?.batches ?? []
  const tasks = snapshot?.tasks ?? {}
  const grouped: { id: string; mode: 'sequential' | 'parallel'; status: string; taskIds: string[] }[] = []
  for (const batch of batches) {
    if (!isRecord(batch)) continue
    grouped.push({
      id: str(batch.id, `B${grouped.length + 1}`),
      mode: batch.mode === 'parallel' ? 'parallel' : 'sequential',
      status: str(batch.status, 'pending'),
      taskIds: Array.isArray(batch.tasks) ? batch.tasks.filter((id): id is string => typeof id === 'string') : [],
    })
  }
  if (grouped.length === 0) {
    // Degrade: derive one sequential batch per group of task states' `batch`.
    const order: string[] = []
    for (const [id, state] of Object.entries(tasks)) {
      const batchId = str(state?.batch, 'B1') || 'B1'
      if (!order.includes(batchId)) order.push(batchId)
    }
    for (const batchId of order) {
      grouped.push({
        id: batchId,
        mode: 'sequential',
        status: 'pending',
        taskIds: Object.entries(tasks)
          .filter(([, state]) => (str(state?.batch, 'B1') || 'B1') === batchId)
          .map(([id]) => id),
      })
    }
  }
  if (grouped.length === 0) {
    return { width: 0, height: 0, batches: [], nodes: [], edges: [], empty: true }
  }

  const NODE_W = 148
  const NODE_H = 38
  const GAP_X = 20
  const GAP_Y = 16
  const LABEL_W = 76
  const PAD = 10
  const BATCH_GAP = 26
  const CP_D = 18
  const CP_SPACE = 58

  const nodes: ExecutionNodeModel[] = []
  const outBatches: ExecutionBatchModel[] = []
  const edges: ExecutionEdgeModel[] = []
  let cursorY = PAD
  let maxWidth = 0

  grouped.forEach((batch) => {
    const count = Math.max(batch.taskIds.length, 1)
    const contentW = batch.mode === 'parallel' ? NODE_W : count * NODE_W + (count - 1) * GAP_X
    const contentH = batch.mode === 'parallel' ? count * NODE_H + (count - 1) * GAP_Y : NODE_H
    const height = Math.max(contentH, 46)
    const width = LABEL_W + contentW + CP_D + CP_SPACE
    const batchX = PAD
    const batchY = cursorY
    const batchModel: ExecutionBatchModel = {
      id: batch.id,
      mode: batch.mode,
      status: batch.status,
      x: batchX,
      y: batchY,
      width,
      height,
      taskIds: batch.taskIds,
      checkpoint: null,
    }
    // Task nodes.
    const nodeStartY = batchY + (height - contentH) / 2
    batch.taskIds.forEach((taskId, index) => {
      const state = (tasks as Record<string, TaskState | undefined>)[taskId]
      const x = batchX + LABEL_W + (batch.mode === 'parallel' ? 0 : index * (NODE_W + GAP_X))
      const y = batch.mode === 'parallel' ? nodeStartY + index * (NODE_H + GAP_Y) : nodeStartY
      nodes.push({
        id: taskId,
        title: taskId,
        status: str(state?.status, 'pending'),
        batch: batch.id,
        x,
        y,
        width: NODE_W,
        height: NODE_H,
        worktree: state?.worktree,
        agent: state?.agent,
      })
    })
    // Within-batch edges.
    if (batch.mode === 'parallel') {
      const busX = batchX + LABEL_W - 12
      const midY = batchY + height / 2
      for (const taskId of batch.taskIds) {
        const node = nodes.find((candidate) => candidate.id === taskId && candidate.batch === batch.id)
        if (node === undefined) continue
        edges.push({
          id: `${batch.id}->${taskId}`,
          from: batch.id,
          to: taskId,
          kind: 'parallel',
          x1: busX,
          y1: midY,
          x2: node.x,
          y2: node.y + node.height / 2,
        })
      }
    } else {
      for (let index = 0; index < batch.taskIds.length - 1; index += 1) {
        const fromNode = nodes.find(
          (candidate) => candidate.id === batch.taskIds[index] && candidate.batch === batch.id,
        )
        const toNode = nodes.find(
          (candidate) => candidate.id === batch.taskIds[index + 1] && candidate.batch === batch.id,
        )
        if (fromNode === undefined || toNode === undefined) continue
        edges.push({
          id: `${fromNode.id}->${toNode.id}`,
          from: fromNode.id,
          to: toNode.id,
          kind: 'sequence',
          x1: fromNode.x + fromNode.width,
          y1: fromNode.y + fromNode.height / 2,
          x2: toNode.x,
          y2: toNode.y + toNode.height / 2,
        })
      }
    }
    // Integration checkpoint at the end of each batch.
    const checkpointX = batchX + LABEL_W + contentW + 22
    const checkpointY = batchY + height / 2
    batchModel.checkpoint = { status: batch.status, x: checkpointX, y: checkpointY }
    const lastNode =
      nodes.filter((node) => node.batch === batch.id).slice(-1)[0] ??
      ({ x: batchX + LABEL_W, y: batchY, width: NODE_W, height: NODE_H } as ExecutionNodeModel)
    edges.push({
      id: `${batch.id}#cp`,
      from: batch.id,
      to: `${batch.id}#cp`,
      kind: 'checkpoint',
      x1: lastNode.x + lastNode.width,
      y1: lastNode.y + lastNode.height / 2,
      x2: checkpointX - CP_D,
      y2: checkpointY,
    })
    outBatches.push(batchModel)
    maxWidth = Math.max(maxWidth, batchX + width)
    cursorY += height + BATCH_GAP
  })

  // Batch-to-batch sequence edges (from previous checkpoint to first node of next batch).
  for (let index = 1; index < outBatches.length; index += 1) {
    const previous = outBatches[index - 1]
    const current = outBatches[index]
    if (previous?.checkpoint === null || previous?.checkpoint === undefined) continue
    if (current === undefined) continue
    const firstNode = nodes.find((node) => node.batch === current.id)
    if (firstNode === undefined) continue
    edges.push({
      id: `${previous.id}=>${current.id}`,
      from: `${previous.id}#cp`,
      to: firstNode.id,
      kind: 'sequence',
      x1: previous.checkpoint.x + CP_D / 2,
      y1: previous.checkpoint.y,
      x2: firstNode.x - 8,
      y2: firstNode.y + firstNode.height / 2,
    })
  }

  return {
    width: maxWidth + PAD,
    height: cursorY + PAD,
    batches: outBatches,
    nodes,
    edges,
    empty: nodes.length === 0,
  }
}

export function buildGateModel(proj: FlowgateProjection | null, t: TFn): GateModel {
  const snapshot = proj?.snapshot ?? null
  const panel = proj?.panel ?? {}
  const raw = panel.gate
  const derivedGate = snapshot?.awaitingGate ?? gateForStage(snapshot?.stage !== undefined ? normalizeStage(snapshot.stage) : undefined)
  if (raw === undefined) {
    const awaitingOwner = snapshot?.awaitingGate !== undefined
    return {
      gate: snapshot?.awaitingGate ?? derivedGate,
      state: awaitingOwner ? 'awaiting' : 'pending',
      items: [],
      awaitingOwner,
      derivedGate,
    }
  }
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter(isRecord)
        .map((entry) => ({
          item: str(entry.item),
          label: str(entry.label, str(entry.item)),
          passed: entry.passed === true,
          hint: typeof entry.hint === 'string' ? entry.hint : undefined,
          example: typeof entry.example === 'string' ? entry.example : undefined,
        }))
    : []
  const state: GateState =
    raw.state === 'pending' ||
    raw.state === 'awaiting' ||
    raw.state === 'passed' ||
    raw.state === 'failed' ||
    raw.state === 'rejected' ||
    raw.state === 'skipped'
      ? raw.state
      : 'pending'
  const mergedConfirm = isRecord(raw.mergedConfirm)
    ? {
        goal: str(raw.mergedConfirm.goal),
        acceptance: Array.isArray(raw.mergedConfirm.acceptance)
          ? raw.mergedConfirm.acceptance.filter((entry): entry is string => typeof entry === 'string')
          : [],
        scope: Array.isArray(raw.mergedConfirm.scope)
          ? raw.mergedConfirm.scope.filter((entry): entry is string => typeof entry === 'string')
          : [],
        verify: str(raw.mergedConfirm.verify),
        risks: Array.isArray(raw.mergedConfirm.risks)
          ? raw.mergedConfirm.risks
              .filter(isRecord)
              .map((risk) => ({ title: str(risk.title), mitigation: str(risk.mitigation) }))
          : undefined,
        rollback: str(raw.mergedConfirm.rollback),
        requireConfirmation: raw.mergedConfirm.requireConfirmation === true,
      }
    : undefined
  return {
    gate: typeof raw.gate === 'string' ? raw.gate : derivedGate,
    state,
    items,
    awaitingOwner: raw.awaitingOwner === true || state === 'awaiting',
    mergedConfirm,
    derivedGate,
  }
}

export function buildLedgerRows(proj: FlowgateProjection | null, t: TFn): LedgerRowModel[] {
  const snapshot = proj?.snapshot ?? null
  const changes = proj?.panel?.changes ?? []
  if (changes.length > 0) {
    return changes.map((change) => ({
      id: str(change.id),
      title: str(change.title),
      kind: change.kind === 'analysis' ? 'analysis' : 'change',
      complexity: complexityLabel(change.complexity, t),
      risk: riskLabel(change.risk, t),
      stage: normalizeStage(change.stage),
      stageDisplay: stageLabel(normalizeStage(change.stage), t),
      lifecycle: str(change.lifecycle),
      lifecycleDisplay: lifecycleLabel(change.lifecycle, t),
      session: typeof change.session === 'string' ? change.session : undefined,
      updatedAt: str(change.updatedAt),
      current: snapshot?.changeId !== undefined && change.id === snapshot.changeId,
      artifactLinks: Array.isArray(change.artifactLinks)
        ? change.artifactLinks
            .filter(isRecord)
            .map((link) => ({ label: str(link.label), path: str(link.path) }))
        : [],
    }))
  }
  if (snapshot === null || snapshot === undefined || snapshot.changeId === undefined) return []
  return [
    {
      id: snapshot.changeId,
      title: str(snapshot.title),
      kind: snapshot.kind === 'analysis' ? 'analysis' : 'change',
      complexity: complexityLabel(snapshot.complexity, t),
      risk: riskLabel(snapshot.risk, t),
      stage: normalizeStage(snapshot.stage),
      stageDisplay: stageLabel(normalizeStage(snapshot.stage), t),
      lifecycle: str(snapshot.lifecycle, 'active'),
      lifecycleDisplay: lifecycleLabel(snapshot.lifecycle, t),
      session: undefined,
      updatedAt: snapshot.updatedAt,
      current: true,
      artifactLinks: [],
    },
  ]
}

export interface TaskGroups {
  todo: TaskCardModel[]
  running: TaskCardModel[]
  review: TaskCardModel[]
  done: TaskCardModel[]
  blocked: TaskCardModel[]
}

export function groupTasksByStatus(tasks: TaskCardModel[]): TaskGroups {
  const groups: TaskGroups = {
    todo: [],
    running: [],
    review: [],
    done: [],
    blocked: [],
  }
  for (const task of tasks) {
    switch (task.status) {
      case 'running':
      case 'queued':
        groups.running.push(task)
        break
      case 'review':
        groups.review.push(task)
        break
      case 'done':
        groups.done.push(task)
        break
      case 'blocked':
      case 'failed':
      case 'interrupted':
        groups.blocked.push(task)
        break
      default:
        groups.todo.push(task)
        break
    }
  }
  return groups
}

const METRIC_KEYS = [
  'M-1',
  'M-2',
  'M-3',
  'M-4',
  'M-5',
  'M-6',
  'M-7',
  'M-8',
  'M-9',
  'M-10',
  'M-11',
  'M-12',
  'M-13',
  'M-14',
  'M-15',
  'M-16',
  'M-17',
  'M-18',
] as const

export function buildMetricRows(metrics: PanelExtrasSafe['metrics'], t: TFn): MetricRowsModel {
  const rowFor = (id: (typeof METRIC_KEYS)[number], source: Record<string, number | '未知'> | undefined): MetricRowModel => {
    const raw = source !== undefined ? source[id] : undefined
    let value: string
    if (raw === undefined || raw === '未知') value = t('metrics.unknown')
    else value = String(raw)
    const note = metrics?.notes !== undefined ? metrics.notes[id] : undefined
    return {
      id,
      label: t(`metric.${id}`),
      value,
      note,
    }
  }
  const change = METRIC_KEYS.map((id) => rowFor(id, metrics?.change))
  const total = metrics?.total !== undefined ? METRIC_KEYS.map((id) => rowFor(id, metrics.total)) : null
  const hasData = metrics !== undefined && (Object.keys(metrics.change ?? {}).length > 0 || metrics.total !== undefined)
  return { change, total, hasData }
}

export function metricsCsv(rows: MetricRowsModel): string {
  const header = 'id,metric,value,note'
  const lines = [header]
  for (const row of rows.change) {
    lines.push(`"${row.id}","${csvCell(row.label)}","${csvCell(row.value)}","${csvCell(row.note ?? '')}"`)
  }
  return `${lines.join('\n')}\n`
}

export function metricsJson(rows: MetricRowsModel): string {
  return JSON.stringify(
    {
      change: Object.fromEntries(rows.change.map((row) => [row.id, { label: row.label, value: row.value, note: row.note }])),
      total:
        rows.total === null
          ? null
          : Object.fromEntries(rows.total.map((row) => [row.id, { label: row.label, value: row.value, note: row.note }])),
    },
    null,
    2,
  )
}

function csvCell(value: string): string {
  return value.replace(/"/g, '""')
}

export function buildPanelModel(proj: FlowgateProjection | null, t: TFn): PanelModel {
  const snapshot = proj?.snapshot ?? null
  const panel = proj?.panel ?? {}
  const tasks = makeTaskModels(proj)
  const risks = panel.risks ?? []
  return {
    initialized: snapshot?.initialized === true,
    hasData: proj !== null,
    snapshot,
    revision: proj?.revision ?? 0,
    updatedAt: proj?.updatedAt ?? snapshot?.updatedAt ?? '',
    changeId: snapshot?.changeId,
    title: snapshot?.title,
    kind: snapshot?.kind,
    complexity: snapshot?.complexity,
    risk: snapshot?.risk,
    stage: snapshot?.stage !== undefined ? normalizeStage(snapshot.stage) : undefined,
    lifecycle: snapshot?.lifecycle,
    learning: proj?.learning ?? 'detail',
    pipeline: buildPipelineNodes(snapshot, t),
    roadmap: panel.roadmap,
    gate: buildGateModel(proj, t),
    ledger: buildLedgerRows(proj, t),
    tasks,
    tasksByStatus: groupTasksByStatus(tasks),
    execution: buildExecutionGraph(snapshot),
    trace: panel.trace !== undefined && panel.trace.length > 0 ? panel.trace : null,
    uncoveredScenarios: (panel.trace ?? []).filter((row) => row.covered !== true).map((row) => str(row.scenarioId)),
    risks,
    pendingRisks: (snapshot?.pending ?? []).filter((item) => item.kind === 'risk'),
    intercepts: panel.intercepts ?? [],
    rules: panel.rules ?? [],
    coverage: snapshot?.coverage ?? null,
    metrics: buildMetricRows(panel.metrics, t),
    evidence: panel.evidence ?? [],
    reviews: panel.reviews ?? [],
    externalChanges: (snapshot?.externalChanges ?? []).filter((entry) => entry.confirmedAt === undefined),
    exceptions: (snapshot?.exceptions ?? []).filter((entry) => entry.revokedAt === undefined),
    off: snapshot?.off === true,
    locked: snapshot?.locked === true,
  }
}

// ---------------------------------------------------------------------------
// Rule dry-run (approximate, local; FR-9.4 fallback when the remote is absent)
// ---------------------------------------------------------------------------

export interface RuleTrialInput {
  tool: string
  path?: string
  command?: string
  stage?: string
}

export interface RuleTrialResult {
  decision: 'allow' | 'deny' | 'human'
  rule?: RuleRow
  /** Which builtin heuristic fired (for the card). */
  heuristic?: string
}

const WRITE_TOOLS = ['write', 'edit', 'create', 'apply_patch', 'bash', 'shell', 'run_code', 'delete', 'rename']
const PROTECTED_HINTS = ['.flowgate/', 'ledger.key', '.env', 'id_rsa', 'secret']

/**
 * Local approximation of the host rule engine, used only when
 * `remote.flowgate` offers no trial method. It intentionally errs on the
 * conservative side (human/deny) and never executes anything.
 */
export function trialRuleLocal(input: RuleTrialInput, rules: RuleRow[]): RuleTrialResult {
  const find = (id: string): RuleRow | undefined => rules.find((rule) => rule.id === id)
  const tool = (input.tool ?? '').toLowerCase()
  const path = (input.path ?? '').replace(/\\/g, '/').toLowerCase()
  const command = (input.command ?? '').toLowerCase()
  const stage = normalizeStage(input.stage)

  const protectedHit = PROTECTED_HINTS.some((hint) => path.includes(hint))
  if (protectedHit) {
    const rule = find('R-PROTECTED')
    return { decision: rule?.decision === 'allow' ? 'allow' : rule?.decision === 'human' ? 'human' : 'deny', rule, heuristic: 'R-PROTECTED' }
  }
  if ((tool === 'delete' || tool === 'rename') && (input.path ?? '') !== '') {
    const rule = find('R-DELETE')
    if (rule !== undefined) return { decision: rule.decision === 'human' ? 'human' : 'deny', rule, heuristic: 'R-DELETE' }
  }
  if (command.includes('git push') || command.includes('push --force')) {
    const rule = find('R-PUSH')
    return { decision: rule?.decision === 'human' ? 'human' : 'deny', rule, heuristic: 'R-PUSH' }
  }
  if (WRITE_TOOLS.includes(tool) && path !== '' && (stage === 'S0' || stage === 'S1' || stage === 'S2' || stage === 'S3')) {
    if (path.startsWith('src/') || /\.(java|ts|tsx|js|jsx|py|go|rs)$/.test(path)) {
      const rule = find('R-STAGE-SRC')
      return { decision: rule?.decision === 'human' ? 'human' : 'deny', rule, heuristic: 'R-STAGE-SRC' }
    }
  }
  if (tool === 'subagent' || tool === 'workflow' || tool === 'send_message') {
    const rule = find('R-DELEGATE')
    return { decision: rule?.decision === 'human' ? 'human' : 'deny', rule, heuristic: 'R-DELEGATE' }
  }
  return { decision: 'allow' }
}

/** Stage-card selection for the pipeline view (localized). */
export function stageCardFor(stage: string | undefined, t: TFn) {
  const locale = localeOf(t)
  const cards = cardsFor(locale)
  const key = normalizeStage(stage)
  if (key === 'S0' || key === 'S1' || key === 'S2' || key === 'S3' || key === 'S4' || key === 'S5' || key === 'S6') {
    return cards[key]
  }
  return cards.S0
}
