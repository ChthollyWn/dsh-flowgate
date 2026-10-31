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
  ExceptionRecord,
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
import type { PipelineStageId } from './stage-info'
import { artifactsForStage } from './stage-info'

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
    ...(isRecord(raw.flowPlan) &&
    (raw.flowPlan.route === 'full' || raw.flowPlan.route === 'standard' || raw.flowPlan.route === 'fast')
      ? {
          flowPlan: {
            route: raw.flowPlan.route,
            autoApprove: raw.flowPlan.autoApprove === true,
            verdict: raw.flowPlan.verdict === 'adjusted' ? ('adjusted' as const) : ('approved' as const),
            reasons: Array.isArray(raw.flowPlan.reasons)
              ? raw.flowPlan.reasons.filter((item): item is string => typeof item === 'string')
              : [],
          },
        }
      : {}),
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
 * (`{snapshot, panel?, revision, updatedAt}`) and a bare
 * `RuntimeSnapshot` for forward/backward compatibility.
 */
export function normalizeProjection(raw: unknown): FlowgateProjection | null {
  if (!isRecord(raw)) return null
  const snapshot = coerceSnapshot(isRecord(raw.snapshot) ? raw.snapshot : raw)
  if (snapshot === null) return null
  return {
    snapshot,
    panel: narrowPanel(raw.panel),
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
// Input dock (contract §2): seven-stage rail + next-step chip + auth card
// ---------------------------------------------------------------------------

/** Dock state machine (docs/impl/ui-interaction-redesign.md §2). */
export type DockState = 'demo' | 'locked' | 'off' | 'idle' | 'active' | 'awaiting' | 'pending' | 'blocked'

/** `data-kind` of the next-step chip: an icon + phrase, never a command. */
export type DockNextKind = 'question' | 'action' | 'auto' | 'wait'

export interface DockNextModel {
  kind: DockNextKind
  text: string
}

/** `data-kind` of the authorization card (contract §1.2). */
export type AuthCardKind = 'gate' | 'pending' | 'external' | 'enable' | 'repair' | 'reconnect'

export type AuthActionKind = 'approve' | 'reject' | 'raise' | 'confirm' | 'open-panel' | 'enable' | 'repair' | 'gates-on'

/** Button anchors fixed by the DOM contract (`data-action`). */
export type AuthDataAction =
  | 'auth-approve'
  | 'auth-reject'
  | 'auth-reject-submit'
  | 'auth-raise'
  | 'auth-confirm'
  | 'auth-open-panel'
  | 'auth-enable'
  | 'auth-repair'

export interface AuthActionModel {
  kind: AuthActionKind
  dataAction: AuthDataAction
  label: string
  tone: 'primary' | 'danger' | 'neutral'
  /** Render the inline reason textarea before submitting (contract §2). */
  needsReason?: boolean
}

/** The decision a card button maps back to (read by the dock container). */
export interface AuthTargetModel {
  gate?: string
  pendingId?: string
  blocker?: boolean
  externalCount: number
}

export type AuthStripTone = 'warn' | 'error' | 'business' | 'neutral'

export interface AuthCardModel {
  kind: AuthCardKind
  /** Human gate id (GR/G1/G3/G6) for gate cards. */
  gate?: string
  /** Native plan-card strip text (long state sentence). */
  strip: string
  /** Strip accent: warn = owner decision, error = blocked/locked, business = enable. */
  stripTone: AuthStripTone
  title: string
  subtitle?: string
  chips: { label: string; value: string }[]
  items: { label: string; passed: boolean }[]
  checks: { passed: number; total: number }
  actions: AuthActionModel[]
  target: AuthTargetModel
  /** Further open pending items folded behind “+n 查看全部”. */
  extraCount: number
  merged?: MergedConfirm
}

export interface DockModel {
  state: DockState
  tone: Tone
  initialized: boolean
  changeId?: string
  stage?: string
  awaitingGate?: string
  /** v0.5 自动流程路由摘要（fast/standard/full + 是否自动放行）。 */
  flowPlan?: NonNullable<RuntimeSnapshot['flowPlan']>
  /** Seven stages, never empty (placeholders while FlowGate is not enabled). */
  nodes: StageNodeModel[]
  progress: { done: number; total: number }
  next?: DockNextModel
  card?: AuthCardModel
  /** Natural-language summary used for the aria label. */
  phrase: string
}

/** State → theme tone mapping for the dock root (`data-tone`). */
export const DOCK_TONES: Record<DockState, Tone> = {
  demo: 'disabled',
  locked: 'blocked',
  off: 'blocked',
  idle: 'idle',
  active: 'active',
  awaiting: 'attention',
  pending: 'attention',
  blocked: 'blocked',
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

/** Seven gray placeholder nodes shown before FlowGate is enabled. */
export function placeholderStageNodes(t: TFn): StageNodeModel[] {
  return STAGE_ORDER.map((stage) => ({
    stage,
    label: t(`stage.${stage}`),
    index: t(`stage.idx.${stage}`),
    status: 'pending' as const,
    isCurrent: false,
  }))
}

/** Open pending decisions (a decided item no longer needs the owner). */
export function openPendingItems(snapshot: RuntimeSnapshot | null | undefined): PendingItem[] {
  if (snapshot === null || snapshot === undefined) return []
  return (snapshot.pending ?? []).filter((item) => item.status === undefined || item.status === 'open')
}

/** Total dock state machine (contract §2); pure and defensive. */
export function dockStateOf(snapshot: RuntimeSnapshot | null | undefined): DockState {
  if (snapshot === null || snapshot === undefined || snapshot.initialized !== true) return 'demo'
  if (snapshot.locked === true) return 'locked'
  if (snapshot.off === true) return 'off'
  if ((snapshot.violations ?? []).length > 0) return 'blocked'
  if (snapshot.awaitingGate !== undefined) return 'awaiting'
  if (openPendingItems(snapshot).length > 0) return 'pending'
  if (snapshot.changeId === undefined || snapshot.changeId === '') return 'idle'
  return 'active'
}

/** Human gates need an explicit owner approval (contract §2: GR/G1/G3/G6). */
export function isHumanGate(gate: string | null | undefined): boolean {
  return gate === 'GR' || gate === 'G1' || gate === 'G3' || gate === 'G6'
}

/** Pending id prefix → decision family (`RK-1` → risk). */
const PENDING_FAMILY: Record<string, 'risk' | 'scope' | 'plan' | 'rule' | 'blocker' | 'conflict'> = {
  RK: 'risk',
  SC: 'scope',
  PC: 'plan',
  RL: 'rule',
  BL: 'blocker',
  CF: 'conflict',
}

type PendingFamily = 'risk' | 'scope' | 'plan' | 'rule' | 'blocker' | 'conflict' | 'generic'

function pendingFamilyOf(id: string): PendingFamily {
  const prefix = id.split('-')[0]?.toUpperCase() ?? ''
  return PENDING_FAMILY[prefix] ?? 'generic'
}

/** “范围变更 / 风险接管 …” label for one pending decision. */
export function pendingFamilyLabel(id: string, t: TFn): string {
  switch (pendingFamilyOf(id)) {
    case 'risk':
      return t('dock.pendingFamily.risk')
    case 'scope':
      return t('dock.pendingFamily.scope')
    case 'plan':
      return t('dock.pendingFamily.plan')
    case 'rule':
      return t('dock.pendingFamily.rule')
    case 'blocker':
      return t('dock.pendingFamily.blocker')
    case 'conflict':
      return t('dock.pendingFamily.conflict')
    default:
      return t('dock.pendingFamily.generic')
  }
}

function pendingApproveLabel(id: string, t: TFn): string {
  switch (pendingFamilyOf(id)) {
    case 'risk':
      return t('dock.pendingAction.risk')
    case 'scope':
      return t('dock.pendingAction.scope')
    case 'plan':
      return t('dock.pendingAction.plan')
    case 'rule':
      return t('dock.pendingAction.rule')
    case 'blocker':
      return t('tasks.unblock')
    case 'conflict':
      return t('dock.pendingAction.conflict')
    default:
      return t('dock.pendingAction.generic')
  }
}

const FLOW_COMMAND_PATTERN = /\/flow(?:\s+[^\s·。；;，,、]+)*/g
/** Model-facing next-step syntax (tool names / object literals) never belongs in the UI. */
const MODEL_FACING_PATTERN = /\bflow_[a-z0-9_]+\b|[{}]/

/**
 * Strip `/flow ...` fragments from host-provided copy. The dock and the panel
 * only ever present natural-language next steps; commands stay available to
 * power users through `/flow help` but are never shown as an instruction.
 */
export function sanitizeNextStep(text: string | undefined): string {
  if (text === undefined || text === '') return ''
  return text
    .replace(FLOW_COMMAND_PATTERN, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·:：,，;；\-—→>]+/, '')
    .replace(/[\s·:：,，;；\-—→>]+$/, '')
    .trim()
}

/**
 * Human-facing next step for the owner (dock chip / panel callout).
 *
 * The host's `snapshot.nextStep` is model-facing for most stages
 * (`flow_submit({gate:"G1"})`, `flow_verify → flow_task_done`, …). Showing that
 * to the owner is noise, so anything matching model-facing syntax is replaced
 * with a stage-level natural-language phrase; only genuinely human copy is
 * passed through (after command sanitizing).
 */
export function humanNextStep(snapshot: RuntimeSnapshot | null | undefined, t: TFn): string {
  const raw = sanitizeNextStep(snapshot?.nextStep)
  const stage = snapshot?.stage !== undefined ? normalizeStage(snapshot.stage) : ''
  let friendly = t('dock.next.active')
  if ((STAGE_ORDER as string[]).includes(stage)) {
    friendly = t(`dock.next.stage.${stage as PipelineStageId}`)
  } else if (stage === 'roadmap') {
    friendly = t('dock.next.stage.roadmap')
  }
  if (raw === '' || MODEL_FACING_PATTERN.test(raw)) return friendly
  return raw
}

function buildDockNext(
  state: DockState,
  snapshot: RuntimeSnapshot | null,
  pendingCount: number,
  t: TFn,
): DockNextModel {
  switch (state) {
    case 'demo':
      return { kind: 'question', text: t('dock.next.demo') }
    case 'locked':
      return { kind: 'action', text: t('dock.next.locked') }
    case 'off':
      return { kind: 'action', text: t('dock.next.off') }
    case 'idle':
      return { kind: 'question', text: t('dock.next.idle') }
    case 'awaiting':
      return { kind: 'action', text: awaitingText(snapshot?.awaitingGate, t) }
    case 'pending':
      return { kind: 'action', text: t('dock.next.pending', { n: pendingCount }) }
    case 'blocked':
      return { kind: 'action', text: t('dock.next.blocked') }
    case 'active':
    default: {
      // Model-facing host copy (tool names / object literals) is replaced by a
      // stage-level natural phrase; human copy passes through sanitized.
      return { kind: 'auto', text: humanNextStep(snapshot, t) }
    }
  }
}

function openExternalChanges(snapshot: RuntimeSnapshot | null): NonNullable<RuntimeSnapshot['externalChanges']> {
  return (snapshot?.externalChanges ?? []).filter((entry) => entry.confirmedAt === undefined)
}

/** Gate panel items for the awaiting gate (empty when the host sends none). */
function gatePanelFor(
  proj: FlowgateProjection | null,
  gate: string | undefined,
): { items: { label: string; passed: boolean }[]; merged?: MergedConfirm } {
  const panelGate = proj?.panel?.gate
  if (panelGate === undefined) return { items: [] }
  if (gate !== undefined && panelGate.gate !== null && panelGate.gate !== gate) return { items: [] }
  const items = Array.isArray(panelGate.items)
    ? panelGate.items.map((item) => ({ label: item.label, passed: item.passed === true }))
    : []
  return panelGate.mergedConfirm !== undefined ? { items, merged: panelGate.mergedConfirm } : { items }
}

/**
 * Build the authorization card for one dock state. Cards are pure view data:
 * the container turns a clicked action back into `ClientAction` / `performAction`.
 */
function changeHeadline(snapshot: RuntimeSnapshot): string {
  return [snapshot.changeId ?? '', snapshot.title ?? ''].filter((part) => part !== '').join(' · ')
}

/**
 * Build the authorization card for one dock state (native plan-card structure:
 * strip → body → footer). Pure view data: the container turns a clicked action
 * back into `ClientAction` / `performAction`.
 */
function buildAuthCard(proj: FlowgateProjection | null, state: DockState, t: TFn): AuthCardModel | undefined {
  const snapshot = proj?.snapshot ?? null
  if (snapshot === null) return undefined
  const external = openExternalChanges(snapshot)
  const target: AuthTargetModel = { externalCount: external.length }
  const detailAction: AuthActionModel = {
    kind: 'open-panel',
    dataAction: 'auth-open-panel',
    label: t('dock.auth.detail'),
    tone: 'neutral',
  }
  switch (state) {
    case 'demo':
      return {
        kind: 'enable',
        strip: t('dock.strip.enable'),
        stripTone: 'neutral',
        title: t('dock.auth.enableTitle'),
        subtitle: t('dock.auth.enableBody'),
        chips: [],
        items: [],
        checks: { passed: 0, total: 0 },
        actions: [
          detailAction,
          { kind: 'enable', dataAction: 'auth-enable', label: t('dock.auth.enableAction'), tone: 'primary' },
        ],
        target,
        extraCount: 0,
      }
    case 'locked':
      return {
        kind: 'repair',
        strip: t('dock.strip.locked'),
        stripTone: 'error',
        title: t('dock.auth.repairTitle'),
        subtitle: t('dock.auth.repairBody'),
        chips: [],
        items: [],
        checks: { passed: 0, total: 0 },
        actions: [
          detailAction,
          { kind: 'repair', dataAction: 'auth-repair', label: t('dock.auth.repairAction'), tone: 'primary' },
        ],
        target,
        extraCount: 0,
      }
    case 'off':
      return {
        kind: 'reconnect',
        strip: t('dock.strip.off'),
        stripTone: 'error',
        title: t('dock.auth.offTitle'),
        subtitle: t('dock.auth.offBody'),
        chips: [],
        items: [],
        checks: { passed: 0, total: 0 },
        actions: [
          detailAction,
          { kind: 'gates-on', dataAction: 'auth-enable', label: t('dock.auth.offAction'), tone: 'primary' },
        ],
        target,
        extraCount: 0,
      }
    case 'blocked': {
      const violations = snapshot.violations ?? []
      const chips = external.slice(0, 3).map((entry) => ({ label: t('dock.auth.externalPath'), value: entry.path }))
      const actions: AuthActionModel[] = [detailAction]
      if (external.length > 0) {
        actions.push({ kind: 'confirm', dataAction: 'auth-confirm', label: t('dock.auth.confirmExternal'), tone: 'primary' })
      }
      return {
        kind: 'external',
        strip: t('dock.strip.blocked'),
        stripTone: 'error',
        title: t('dock.auth.blockedTitle'),
        subtitle: t('dock.auth.blockedBody', { n: violations.length }),
        chips,
        items: [],
        checks: { passed: 0, total: violations.length },
        actions,
        target,
        extraCount: 0,
      }
    }
    case 'awaiting': {
      const gate = snapshot.awaitingGate ?? proj?.panel?.gate?.gate ?? undefined
      if (gate === undefined || gate === null) return undefined
      const gatePanel = gatePanelFor(proj, gate)
      const merged = gatePanel.merged
      const items = gatePanel.items
      const passed = items.filter((item) => item.passed).length
      const stage = snapshot.stage !== undefined ? normalizeStage(snapshot.stage) : undefined
      const headline = changeHeadline(snapshot)
      const actions: AuthActionModel[] = [detailAction]
      let title: string
      let subtitle: string | undefined
      const chips: { label: string; value: string }[] = []
      if (merged !== undefined) {
        title = merged.goal !== '' ? merged.goal : t('dock.auth.mergedTitle')
        subtitle = merged.acceptance.length > 0 ? merged.acceptance.join(' · ') : undefined
        if (merged.scope.length > 0) chips.push({ label: t('gate.planConfirm.scope'), value: merged.scope.join(' · ') })
        if (merged.verify !== '') chips.push({ label: t('gate.planConfirm.verify'), value: merged.verify })
        actions.push({ kind: 'raise', dataAction: 'auth-raise', label: t('gate.planConfirm.raise'), tone: 'neutral' })
        actions.push({
          kind: 'reject',
          dataAction: 'auth-reject',
          label: t('gate.planConfirm.reject'),
          tone: 'danger',
          needsReason: true,
        })
        actions.push({ kind: 'approve', dataAction: 'auth-approve', label: t('gate.planConfirm.approve'), tone: 'primary' })
      } else {
        title =
          headline !== ''
            ? headline
            : t('dock.auth.gateTitle', { gate, stage: stage !== undefined ? stageLabel(stage, t) : '' })
        subtitle = t('dock.auth.gateBody', { passed, total: items.length })
        actions.push({ kind: 'reject', dataAction: 'auth-reject', label: t('gate.reject'), tone: 'danger', needsReason: true })
        actions.push({ kind: 'approve', dataAction: 'auth-approve', label: t('dock.auth.approve'), tone: 'primary' })
      }
      return {
        kind: 'gate',
        gate,
        strip: merged !== undefined ? t('dock.strip.merged', { gate }) : t('dock.strip.gate', { gate }),
        stripTone: 'warn',
        title,
        subtitle,
        chips,
        items,
        checks: { passed, total: items.length },
        actions,
        target: { ...target, gate },
        extraCount: 0,
        merged,
      }
    }
    case 'pending': {
      const pending = openPendingItems(snapshot)
      const first = pending[0]
      if (first === undefined) return undefined
      const blocker = pendingFamilyOf(first.id) === 'blocker'
      const family = pendingFamilyLabel(first.id, t)
      const chips: { label: string; value: string }[] = []
      if (snapshot.changeId !== undefined && snapshot.changeId !== '') {
        chips.push({ label: t('dock.auth.change'), value: snapshot.changeId })
      }
      if (snapshot.stage !== undefined) {
        chips.push({ label: t('dock.auth.stage'), value: stageLabel(normalizeStage(snapshot.stage), t) })
      }
      const actions: AuthActionModel[] = [detailAction]
      if (blocker) {
        actions.push({ kind: 'approve', dataAction: 'auth-approve', label: t('tasks.unblock'), tone: 'primary' })
      } else {
        actions.push({
          kind: 'reject',
          dataAction: 'auth-reject',
          label: t('dock.auth.rejectPending'),
          tone: 'danger',
          needsReason: true,
        })
        actions.push({
          kind: 'approve',
          dataAction: 'auth-approve',
          label: pendingApproveLabel(first.id, t),
          tone: 'primary',
        })
      }
      return {
        kind: 'pending',
        strip: t('dock.strip.pending', { family }),
        stripTone: 'warn',
        title: first.title !== '' ? first.title : t('dock.pending.title', { family }),
        subtitle: first.detail !== '' ? first.detail : undefined,
        chips,
        items: [],
        checks: { passed: 0, total: 0 },
        actions,
        target: { ...target, pendingId: first.id, blocker },
        extraCount: pending.length - 1,
      }
    }
    case 'active':
    case 'idle':
    default:
      return undefined
  }
}

/** Build the whole input-dock model (pure; used by SSR tests and the slot). */
export function buildDockModel(proj: FlowgateProjection | null, t: TFn): DockModel {
  const snapshot = proj?.snapshot ?? null
  const state = dockStateOf(snapshot)
  const built = buildPipelineNodes(snapshot, t)
  const nodes = built.length > 0 ? built : placeholderStageNodes(t)
  const done = built.filter((node) => node.status === 'done').length
  const stage =
    snapshot !== null && snapshot.initialized === true && snapshot.stage !== undefined
      ? normalizeStage(snapshot.stage)
      : undefined
  const pending = openPendingItems(snapshot)
  const next = buildDockNext(state, snapshot, pending.length, t)
  const card = buildAuthCard(proj, state, t)
  return {
    state,
    tone: DOCK_TONES[state],
    initialized: snapshot?.initialized === true,
    changeId: snapshot?.changeId,
    stage,
    awaitingGate: snapshot?.awaitingGate,
    flowPlan: snapshot?.flowPlan,
    nodes,
    progress: { done, total: nodes.length },
    next,
    card,
    phrase: next.text,
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
  /**
   * Task-detail extras (T5.1). The frozen host/client contract only ships
   * `TaskState`, so these are mapped defensively when the host sends richer
   * task cards / plan data; missing members simply hide the detail rows.
   */
  batchMode?: 'sequential' | 'parallel'
  batchStatus?: string
  evidenceIds?: string[]
  reviewIds?: string[]
  covers?: string[]
  scope?: string[]
  tests?: string[]
  newFiles?: string[]
  verify?: string[]
  /** Flattened review findings (severity/file/line/message) for the task. */
  findings?: { severity: string; file: string; line?: number; message: string }[]
  redObserved?: boolean
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
  /** Input-dock state (also drives the panel header rail). */
  flowState: DockState
  /** v0.5 自动流程路由摘要；旧宿主/旧记录为 undefined。 */
  flowPlan?: NonNullable<RuntimeSnapshot['flowPlan']>
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
  const batchMeta = new Map<string, { mode: 'sequential' | 'parallel'; status: string }>()
  for (const batch of batches) {
    if (!isRecord(batch)) continue
    const id = str(batch.id)
    for (const taskId of Array.isArray(batch.tasks) ? batch.tasks : []) {
      if (typeof taskId === 'string') batchOf.set(taskId, id)
    }
    if (id !== '') {
      batchMeta.set(id, { mode: batch.mode === 'parallel' ? 'parallel' : 'sequential', status: str(batch.status) })
    }
  }
  return Object.entries(snapshot.tasks ?? {}).map(([id, state]) => {
    // `TaskState` is the frozen wire shape; richer task-card fields are read
    // defensively so a newer host degrades gracefully instead of throwing.
    // `snapshot.taskCards` (optional, T5.1) carries the parsed card (scope /
    // verify groups / covers) when the host provides it.
    const card = snapshot.taskCards?.[id]
    const cardRecord = isRecord(card) ? (card as unknown as Record<string, unknown>) : {}
    const rawState = isRecord(state) ? { ...cardRecord, ...(state as unknown as Record<string, unknown>) } : cardRecord
    const rows = evidenceRows.filter((row) => row.taskId === id)
    const evidence: TaskCardModel['evidence'] =
      rows.length === 0 ? 'none' : rows.some((row) => row.fresh === true) ? 'fresh' : 'stale'
    const taskReviews = reviewRows.filter((row) => row.taskId === id)
    const findings = taskReviews.flatMap((row) =>
      Array.isArray(row.findings)
        ? row.findings.map((finding) => ({
            severity: str(finding.severity),
            file: str(finding.file),
            message: str(finding.message),
            ...(typeof finding.line === 'number' ? { line: finding.line } : {}),
          }))
        : [],
    )
    const batch = batchOf.get(id) ?? str(state?.batch)
    const meta = batchMeta.get(batch)
    return {
      id,
      title: str(rawState.title, id) || id,
      status: str(state?.status, 'pending'),
      batch,
      tdd: str(state?.tdd, 'none'),
      evidence,
      reviewFindings: findings.length,
      worktree: state?.worktree,
      agent: state?.agent,
      failureCount: numOr(state?.failureCount, 0),
      blockReason: state?.blockReason,
      ...(meta !== undefined ? { batchMode: meta.mode, batchStatus: meta.status } : {}),
      ...(Array.isArray(state?.evidenceIds) && state.evidenceIds.length > 0
        ? { evidenceIds: state.evidenceIds.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      ...(Array.isArray(state?.reviewIds) && state.reviewIds.length > 0
        ? { reviewIds: state.reviewIds.filter((entry): entry is string => typeof entry === 'string') }
        : {}),
      ...optionalListField(rawState, 'covers'),
      ...optionalListField(rawState, 'scope'),
      ...optionalListField(rawState, 'tests'),
      ...optionalListField(rawState, 'newFiles'),
      ...optionalVerifyField(rawState.verify),
      ...(findings.length > 0 ? { findings } : {}),
      ...(state?.redObserved === true ? { redObserved: true } : {}),
    }
  })
}

/** Read an optional string[] in a forward-compatible way (unknown wire field). */
function optionalListField<K extends 'covers' | 'scope' | 'tests' | 'newFiles'>(
  raw: Record<string, unknown>,
  key: K,
): Partial<Pick<TaskCardModel, K>> {
  const value = raw[key]
  if (!Array.isArray(value)) return {}
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  return list.length > 0 ? ({ [key]: list } as Partial<Pick<TaskCardModel, K>>) : {}
}

/** Verify groups may arrive either as strings or `{group, command}` records. */
function optionalVerifyField(value: unknown): Partial<TaskCardModel> {
  if (!Array.isArray(value)) return {}
  const list: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') {
      list.push(entry)
      continue
    }
    if (!isRecord(entry)) continue
    const group = str(entry.group)
    const command = str(entry.command)
    if (group !== '' && command !== '') list.push(`${group} · ${command}`)
    else if (group !== '') list.push(group)
    else if (command !== '') list.push(command)
  }
  return list.length > 0 ? { verify: list } : {}
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
    flowState: dockStateOf(snapshot),
    flowPlan: snapshot?.flowPlan,
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

/** Natural-language “next step” for the pipeline callout (never a command). */
export interface PanelNextStep {
  kind: 'human' | 'auto' | 'setup'
  text: string
}

export function nextStepForPanel(model: PanelModel, t: TFn): PanelNextStep {
  const snapshot = model.snapshot
  if (model.stage === undefined) return { kind: 'setup', text: t('viz.next.start') }
  if (model.gate.awaitingOwner && model.gate.gate !== null) {
    return { kind: 'human', text: t('viz.next.awaiting', { gate: model.gate.gate }) }
  }
  const pending = openPendingItems(snapshot)
  if (pending.length > 0) return { kind: 'human', text: t('viz.next.pending', { n: pending.length }) }
  if (model.externalChanges.length > 0) {
    return { kind: 'human', text: t('viz.next.external', { n: model.externalChanges.length }) }
  }
  return { kind: 'auto', text: humanNextStep(snapshot, t) }
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

/** Snapshot facts the local dry-run honours (T5.1). */
export interface RuleTrialSnapshot {
  off?: boolean
  locked?: boolean
  changeId?: string
  exceptions?: readonly ExceptionRecord[]
}

export type RuleTrialDecision = 'allow' | 'deny' | 'human'

/**
 * Where the local verdict came from. `off` / `locked` mirror the host mode;
 * `exception` means an active exception cancelled the matched rule; `rule`
 * means the matched rule's own (effective) decision was used; `default` means
 * no local heuristic fired.
 */
export type RuleTrialBasis = 'off' | 'locked' | 'exception' | 'rule' | 'default'

export interface RuleTrialResult {
  decision: RuleTrialDecision
  rule?: RuleRow
  /** Which builtin heuristic fired (for the card). */
  heuristic?: string
  /** Snapshot-driven reason for the verdict (for the card). */
  basis: RuleTrialBasis
  /** Active exception that cancelled the matched rule, when one applied. */
  exception?: { id: string; ruleId: string }
  /**
   * Project rules present in the effective rule list that this local heuristic
   * cannot evaluate. When non-empty the UI must state that the verdict is only
   * an approximation and the host `/flow trial` is authoritative.
   */
  uncoveredRules: string[]
  /** Always true: the host `/flow trial` is the authoritative dry-run. */
  approximate: true
}

const WRITE_TOOLS = ['write', 'edit', 'create', 'apply_patch', 'bash', 'shell', 'run_code', 'delete', 'rename']
const PROTECTED_HINTS = ['.flowgate/', 'ledger.key', '.env', 'id_rsa', 'secret']

/** Rule ids whose semantics the local heuristics below approximate. */
const LOCAL_HEURISTIC_RULE_IDS = new Set(['R-PROTECTED', 'R-DELETE', 'R-PUSH', 'R-STAGE-SRC', 'R-DELEGATE'])

/**
 * Built-in / reserved rule ids (mirrors core/rules/builtin.ts + risk-triggers.ts,
 * where ids are stable by contract). Any other rule id is a project rule whose
 * `when` conditions cannot be evaluated in the browser half.
 */
const KNOWN_BUILTIN_RULE_IDS = new Set([
  ...LOCAL_HEURISTIC_RULE_IDS,
  'R-ANALYSIS-READONLY',
  'R-SCOPE',
  'R-MCP',
  'R-NEWFILE',
  'R-TDD-ORDER',
  'R-LOCK',
  'R-VIOLATION',
  'T-SENSITIVE-PATH',
  'T-DEPENDENCY',
  'T-DANGEROUS',
  'T-SECRET',
  'T-SECRET-READ',
  'T-FAILURE-LIMIT',
])

/** Rules an exception may cancel: protected paths and lock mode are hard stops (core §13). */
const NON_CANCELLABLE_RULE_IDS = new Set(['R-PROTECTED', 'R-LOCK'])

function ruleDecision(rule: RuleRow | undefined, fallback: RuleTrialDecision): RuleTrialDecision {
  const value = rule?.decision
  return value === 'allow' || value === 'deny' || value === 'human' ? value : fallback
}

interface HeuristicHit {
  rule?: RuleRow
  heuristic: string
  fallback: 'deny' | 'human'
}

/** The builtin heuristics the browser can approximate; null = no rule matched. */
function localHeuristic(input: RuleTrialInput, rules: RuleRow[]): HeuristicHit | null {
  const find = (id: string): RuleRow | undefined => rules.find((rule) => rule.id === id)
  const tool = (input.tool ?? '').toLowerCase()
  const path = (input.path ?? '').replace(/\\/g, '/').toLowerCase()
  const command = (input.command ?? '').toLowerCase()
  const stage = normalizeStage(input.stage)

  const protectedHit = PROTECTED_HINTS.some((hint) => path.includes(hint))
  if (protectedHit) {
    return { rule: find('R-PROTECTED'), heuristic: 'R-PROTECTED', fallback: 'deny' }
  }
  if ((tool === 'delete' || tool === 'rename') && (input.path ?? '') !== '') {
    const rule = find('R-DELETE')
    if (rule !== undefined) return { rule, heuristic: 'R-DELETE', fallback: 'deny' }
  }
  if (command.includes('git push') || command.includes('push --force')) {
    return { rule: find('R-PUSH'), heuristic: 'R-PUSH', fallback: 'deny' }
  }
  if (WRITE_TOOLS.includes(tool) && path !== '' && (stage === 'S0' || stage === 'S1' || stage === 'S2' || stage === 'S3')) {
    if (path.startsWith('src/') || /\.(java|ts|tsx|js|jsx|py|go|rs)$/.test(path)) {
      return { rule: find('R-STAGE-SRC'), heuristic: 'R-STAGE-SRC', fallback: 'deny' }
    }
  }
  if (tool === 'subagent' || tool === 'workflow' || tool === 'send_message') {
    return { rule: find('R-DELEGATE'), heuristic: 'R-DELEGATE', fallback: 'deny' }
  }
  return null
}

function normalizeForGlob(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Minimal glob matcher for exception `pathPattern` checks. Approximates
 * `core/util/glob.ts` (`*` = one path segment, `**` = any depth, `?` = one char);
 * the local dry-run is explicitly approximate.
 */
function localGlobMatch(pattern: string, value: string): boolean {
  const normalizedPattern = normalizeForGlob(pattern)
  const normalizedValue = normalizeForGlob(value)
  let regex = '^'
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index]
    if (char === '*') {
      if (normalizedPattern[index + 1] === '*') {
        regex += '.*'
        index += 1
        if (normalizedPattern[index + 1] === '/') index += 1
      } else {
        regex += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      regex += '[^/]'
      continue
    }
    regex += (char ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  regex += '$'
  try {
    return new RegExp(regex).test(normalizedValue)
  } catch {
    return false
  }
}

/** Mirror core §13 exception matching (path / shell command targets), approximately. */
function exceptionMatchesAction(pathPattern: string | undefined, input: RuleTrialInput): boolean {
  if (pathPattern === undefined || pathPattern === '') return true
  const path = normalizeForGlob(input.path ?? '')
  if (path !== '' && localGlobMatch(pathPattern, path)) return true
  const command = input.command ?? ''
  if (command === '') return false
  if (command.includes(pathPattern)) return true
  return command.split(/\s+/).some((token) => token !== '' && localGlobMatch(pathPattern, token))
}

function activeExceptionFor(
  snapshot: RuleTrialSnapshot | null | undefined,
  rule: RuleRow,
  input: RuleTrialInput,
): ExceptionRecord | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  const exceptions = snapshot.exceptions ?? []
  return exceptions.find(
    (exception) =>
      exception.revokedAt === undefined &&
      exception.ruleId === rule.id &&
      (snapshot.changeId === undefined || exception.changeId === undefined || exception.changeId === snapshot.changeId) &&
      exceptionMatchesAction(exception.pathPattern, input),
  )
}

/**
 * Local approximation of the host rule engine, used only when
 * `remote.flowgate` offers no trial method. It never executes anything.
 *
 * Fidelity (T5.1): honours `snapshot.off` (allow), `snapshot.locked` (deny),
 * active `snapshot.exceptions` (allow when they cancel the matched rule) and
 * the effective rule decisions the host projects. Project rules whose `when`
 * conditions cannot be evaluated locally are reported through
 * `uncoveredRules`; the UI must tell the owner to confirm with `/flow trial`.
 */
export function trialRuleLocal(
  input: RuleTrialInput,
  rules: RuleRow[],
  snapshot: RuleTrialSnapshot | null = null,
): RuleTrialResult {
  const uncoveredRules = rules.filter((rule) => !KNOWN_BUILTIN_RULE_IDS.has(rule.id)).map((rule) => rule.id)

  if (snapshot?.off === true) {
    return { decision: 'allow', basis: 'off', uncoveredRules: [], approximate: true }
  }
  if (snapshot?.locked === true) {
    return {
      decision: 'deny',
      heuristic: 'R-LOCK',
      basis: 'locked',
      rule: rules.find((rule) => rule.id === 'R-LOCK'),
      uncoveredRules: [],
      approximate: true,
    }
  }

  const hit = localHeuristic(input, rules)
  if (hit === null) {
    return { decision: 'allow', basis: 'default', uncoveredRules, approximate: true }
  }
  const decision = ruleDecision(hit.rule, hit.fallback)
  const ruleForException: RuleRow = hit.rule ?? { id: hit.heuristic, decision, why: '', unlock: '', hits: 0 }
  const exception =
    decision !== 'allow' && !NON_CANCELLABLE_RULE_IDS.has(hit.heuristic)
      ? activeExceptionFor(snapshot, ruleForException, input)
      : undefined
  if (exception !== undefined) {
    return {
      decision: 'allow',
      rule: hit.rule,
      heuristic: hit.heuristic,
      basis: 'exception',
      exception: { id: exception.id, ruleId: exception.ruleId },
      uncoveredRules,
      approximate: true,
    }
  }
  return {
    decision,
    rule: hit.rule,
    heuristic: hit.heuristic,
    basis: 'rule',
    uncoveredRules,
    approximate: true,
  }
}

/** Artifact chips for one stage in the pipeline view (localized). */
export function stageArtifacts(stage: string | undefined, t: TFn): string[] {
  return artifactsForStage(normalizeStage(stage), localeOf(t))
}
