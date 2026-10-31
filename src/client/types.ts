/**
 * FlowGate client wire contracts (browser half).
 *
 * Source of truth: docs/impl/host-client-contract.md (Lead owned).
 * The browser bundle must not import `@deepseek-ai/*`; DSH services arrive as
 * structurally-typed injections through `ctx`, and projection values are
 * narrowed defensively at this boundary. Everything here is plain JSON data.
 *
 * 投影 key / Remote id / tab id 都集中在本文件，host 侧按同一份文档实现。
 */
import type { RuntimeSnapshot } from '../core/types'

/** Session projection key the host registers. */
export const PROJECTION_KEY = 'flowgate' as const
/** Host remote service id (dsh-api-gateway / Typert Remote). */
export const REMOTE_ID = 'flowgate' as const
/** Sidebar tab type id (also the body seat key). */
export const TAB_ID = 'flowgate' as const
/** Sidebar tab kind used by `openTab(kind)`. */
export const TAB_KIND = 'flowgate.panel' as const
/** Input-dock slot id. */
export const DOCK_ID = 'flowgate-status' as const
/** Client locale namespace. */
export const LOCALE_NS = 'dsh-flowgate' as const

// ---------------------------------------------------------------------------
// Projection (host -> client)
// ---------------------------------------------------------------------------

export type LearningMode = 'detail' | 'brief' | 'off'
export type ComplexityLevel = 'low' | 'medium' | 'high' | 'ultra'
export type RiskLevel = 'normal' | 'high'
export type ChangeKind = 'change' | 'analysis'
export type Lifecycle = 'active' | 'paused' | 'archived' | 'blocked' | 'locked'
export type GateName = 'GR' | 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'TG'
export type GateState = 'pending' | 'awaiting' | 'passed' | 'failed' | 'rejected' | 'skipped'

export interface ChangeSummary {
  id: string
  title: string
  kind: ChangeKind
  complexity: ComplexityLevel
  risk: RiskLevel
  stage: string
  lifecycle: Lifecycle
  session?: string
  updatedAt: string
  artifactLinks?: { label: string; path: string }[]
}

export interface GateItem {
  item: string
  label: string
  passed: boolean
  hint?: string
  example?: string
}

export interface MergedConfirm {
  goal: string
  acceptance: string[]
  scope: string[]
  verify: string
  risks?: { title: string; mitigation: string }[]
  rollback?: string
  requireConfirmation?: boolean
}

export interface GatePanel {
  gate: string | null
  state: GateState
  items: GateItem[]
  mergedConfirm?: MergedConfirm
  awaitingOwner: boolean
}

export interface TraceRow {
  requirementId: string
  scenarioId: string
  title?: string
  taskIds: string[]
  evidenceIds: string[]
  covered: boolean
}

export interface RiskRow {
  category: string
  grade: string
  reason: string
  mitigation: string
  verification: string
  needsHuman: boolean
}

export interface InterceptRow {
  at: string
  ruleId: string
  tool: string
  target?: string
  effect: 'deny' | 'human'
  why: string
  unlock: string
  source?: string
  violationId?: string
}

export interface RuleRow {
  id: string
  decision: string
  why: string
  unlock: string
  hits: number
  source?: string
}

export interface EvidenceRow {
  id: string
  taskId?: string
  group: string
  kind: string
  phase: string
  exitCode: number
  run: number
  passed: number
  failed: number
  skipped: number
  fresh: boolean
  finishedAt: string
}

export interface ReviewRow {
  id: string
  taskId?: string
  kind: string
  verdict: string
  findings: { severity: string; file: string; line?: number; message: string }[]
  coverageOk: boolean
  createdAt: string
}

export interface RoadmapSummary {
  mvpCut: string
  entries: { change: string; capability: string; goal: string; status: string; mvp: boolean }[]
  delivered: number
  total: number
}

export interface PanelExtras {
  changes?: ChangeSummary[]
  gate?: GatePanel
  trace?: TraceRow[]
  risks?: RiskRow[]
  intercepts?: InterceptRow[]
  rules?: RuleRow[]
  metrics?: {
    change: Record<string, number | '未知'>
    total?: Record<string, number | '未知'>
    notes?: Record<string, string>
  }
  evidence?: EvidenceRow[]
  reviews?: ReviewRow[]
  roadmap?: RoadmapSummary
  dashboardPath?: string
}

/** The session-projection value. */
export interface FlowgateProjection {
  snapshot: RuntimeSnapshot
  panel?: PanelExtras
  learning?: LearningMode
  revision: number
  updatedAt: string
  /** Host-process epoch (optional; absent on records written by older plugin versions). */
  epoch?: string
}

// ---------------------------------------------------------------------------
// Host remote actions (client -> host)
// ---------------------------------------------------------------------------

export type FlowgateAction =
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

export interface ActionEnvelope {
  ok: boolean
  message: string
  value?: unknown
}

/** Structural face of `ctx.remote.flowgate`; every member is re-proved. */
export interface FlowgateRemote {
  state?: () => Promise<unknown>
  action?: (payload: FlowgateAction) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Cordis client context (structural; never imported from @deepseek-ai/*)
// ---------------------------------------------------------------------------

export type Disposer = () => void

export interface SlotPropRecord {
  sessionId?: string
  session?: { sessionId?: string }
  useProjection?: (key: string) => unknown
  t?: (key: string, params?: Record<string, string | number>) => string
  [key: string]: unknown
}

export interface LocaleService {
  register?: (ns: string, dicts: Record<string, Record<string, string>>) => Disposer | void
  bind?: (ns: string) => (key: string, params?: Record<string, string | number>) => string
}

export interface SlotsService {
  register?: (definition: Record<string, unknown>, component: unknown) => Disposer | void
  inject?: (name: string, callback: () => unknown) => unknown
}

export interface SidebarRightTabsService {
  register?: (definition: Record<string, unknown>) => Disposer | void
  open?: (id: string, options?: unknown) => unknown
}

export interface SidebarRightService {
  openTab?: (kind: string, options?: unknown) => unknown
  openResource?: (address: string, options?: unknown) => unknown
}

export interface ClientLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

/** The subset of the Cordis client context this plugin touches. */
export interface ClientContext {
  effect?: (callback: () => Disposer | void, label?: string) => unknown
  inject?: (deps: string[], callback: (ctx: ClientContext) => unknown) => unknown
  slots?: SlotsService
  locale?: LocaleService
  sidebarRightTabs?: SidebarRightTabsService
  sidebarRight?: SidebarRightService
  sessions?: unknown
  conversation?: unknown
  remote?: Record<string, unknown>
  logger?: ClientLogger
  [key: string]: unknown
}
