/**
 * 会话投影 `flowgate` 的 wire 数据契约（与 docs/impl/host-client-contract.md §1 同步）。
 *
 * 客户端通过 session 插槽 props 的 `useProjection('flowgate')` 读取本结构；
 * 所有字段可选/可缺省，客户端必须对缺失做降级显示。
 */
import type { ChangeStatus, ReviewRecord, RuntimeSnapshot } from '../../core/types.js'

/** 面板补充数据。 */
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

export interface ChangeSummary {
  id: string
  title: string
  kind: 'change' | 'analysis'
  complexity: 'low' | 'medium' | 'high' | 'ultra'
  risk: 'normal' | 'high'
  stage: string
  lifecycle: 'active' | 'paused' | 'archived' | 'blocked' | 'locked'
  session?: string
  updatedAt: string
  artifactLinks?: { label: string; path: string }[]
}

export interface GatePanel {
  gate: string | null
  state: 'pending' | 'awaiting' | 'passed' | 'failed' | 'rejected' | 'skipped'
  items: { item: string; label: string; passed: boolean; hint?: string; example?: string }[]
  mergedConfirm?: {
    goal: string
    acceptance: string[]
    scope: string[]
    verify: string
    risks?: { title: string; mitigation: string }[]
  }
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

/** 投影 wire 值（客户端读取的完整状态）。 */
export interface FlowgateProjection {
  snapshot: RuntimeSnapshot
  panel?: PanelExtras
  learning?: 'detail' | 'brief' | 'off'
  revision: number
  updatedAt: string
}

/** 学习模式默认值。 */
export const DEFAULT_LEARNING = 'detail' as const

/** 未初始化/无变更时的兜底快照（投影 init 与降级共用）。 */
export function emptySnapshot(now: string): RuntimeSnapshot {
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
    nextStep: 'FlowGate 未启用：在项目里运行 /flow init 启用',
    statusLine: 'FlowGate 未启用 · /flow init 启用',
    updatedAt: now,
  }
}

/** 初始投影值。 */
export function initialProjection(now: string): FlowgateProjection {
  return {
    snapshot: emptySnapshot(now),
    learning: DEFAULT_LEARNING,
    revision: 0,
    updatedAt: now,
  }
}

/** 从变更状态生成台账摘要（避免把 status.json 全量塞进投影）。 */
export function summaryOf(change: ChangeStatus): ChangeSummary {
  return {
    id: change.id,
    title: change.title,
    kind: change.kind,
    complexity: change.complexity,
    risk: change.risk,
    stage: change.stage,
    lifecycle: change.lifecycle,
    session: change.session?.attached,
    updatedAt: change.updatedAt,
  }
}

/** 审查记录 → 面板行。 */
export function reviewRowOf(review: ReviewRecord): ReviewRow {
  return {
    id: review.id,
    taskId: review.taskId,
    kind: review.kind,
    verdict: review.verdict,
    findings: review.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
    })),
    coverageOk: review.coverageOk,
    createdAt: review.createdAt,
  }
}
