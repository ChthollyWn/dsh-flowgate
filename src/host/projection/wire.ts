/**
 * 投影 wire 显式 DTO（P0-2 / P2-11）。
 *
 * 为什么不能整包透传：`FlowgateProjection` 是 host 内部状态，`snapshot` 来自
 * `engine.snapshot()`（未来可能加字段、带内部对象），`panel` 来自缓存的多块
 * 数据。整包透传会把未清洗的字段（类实例/Date/BigInt 等）和意外增长的体积
 * 直接送进 DSH 的会话摘要与客户端——v0.5.1 的「新建会话失败」根因之一。
 *
 * 因此 wire 值在这里**逐字段显式挑选**：
 * - snapshot：只挑客户端契约已知字段（新增字段必须在这里显式加一行）；
 * - panel：逐块挑选，并对大块做条数上限（changes/evidence 等最近 N 条）；
 * - 顶层：revision/updatedAt/epoch。
 *
 * 体积上限：wire 面板按 `PANEL_WIRE_BUDGET_BYTES` 预算，超限时按
 * `PANEL_DROP_ORDER` 逐块降级（客户端对缺失块本来就必须降级显示）。这是
 * P2-11「面板按需拉取（remote）」落地前的兜底——远程按需拉取尚未实现，
 * 此处只保证单帧 wire 值有界；后续方向见 docs/impl/projection-budget.md。
 */
import type { RuntimeSnapshot } from '../../core/types.js'
import type { FlowgateProjection, PanelExtras } from './types.js'

/** 面板大块的条数上限（客户端只看最近 N 条；更早的数据按需通过命令拉取）。 */
export const WIRE_PANEL_LIMITS = {
  changes: 50,
  gateItems: 50,
  trace: 50,
  risks: 20,
  intercepts: 50,
  rules: 50,
  evidence: 50,
  reviews: 20,
  roadmapEntries: 30,
} as const

/** 单帧 wire 值（含 snapshot）的字节预算：超过就逐块降级面板。 */
export const PANEL_WIRE_BUDGET_BYTES = 256 * 1024

/** wire 面板的降级顺序（先丢最不影响状态判断的块；changes 最后丢）。 */
const PANEL_DROP_ORDER: (keyof PanelExtras)[] = [
  'trace',
  'evidence',
  'intercepts',
  'rules',
  'risks',
  'roadmap',
  'reviews',
  'metrics',
  'gate',
  'changes',
]

/** wire 值顶层键（投影自检断言用；客户端契约见 host-client-contract §1）。 */
export const PROJECTION_WIRE_TOP_LEVEL_KEYS = ['snapshot', 'revision', 'updatedAt'] as const

/** 取数组的最近 N 条（非数组时返回空数组；投影来自内部状态，防御损坏记录）。 */
function recent<T>(value: readonly T[] | undefined, limit: number): T[] {
  return Array.isArray(value) ? value.slice(-limit) : []
}

function wireSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    initialized: snapshot.initialized === true,
    changeId: snapshot.changeId,
    title: snapshot.title,
    kind: snapshot.kind,
    complexity: snapshot.complexity,
    risk: snapshot.risk,
    stage: snapshot.stage,
    lifecycle: snapshot.lifecycle,
    flowPlan: snapshot.flowPlan,
    awaitingGate: snapshot.awaitingGate,
    pendingGate: snapshot.pendingGate,
    pipeline: Array.isArray(snapshot.pipeline) ? snapshot.pipeline : [],
    tasks: snapshot.tasks && typeof snapshot.tasks === 'object' ? snapshot.tasks : {},
    taskCards: snapshot.taskCards,
    batches: Array.isArray(snapshot.batches) ? snapshot.batches : [],
    activeTaskId: snapshot.activeTaskId,
    pending: Array.isArray(snapshot.pending) ? snapshot.pending : [],
    violations: Array.isArray(snapshot.violations) ? snapshot.violations : [],
    externalChanges: snapshot.externalChanges,
    resumed: snapshot.resumed,
    exceptions: snapshot.exceptions,
    off: snapshot.off === true,
    offBy: snapshot.offBy,
    locked: snapshot.locked === true,
    interceptCounts: snapshot.interceptCounts && typeof snapshot.interceptCounts === 'object' ? snapshot.interceptCounts : {},
    coverage: snapshot.coverage,
    nextStep: typeof snapshot.nextStep === 'string' ? snapshot.nextStep : '',
    statusLine: typeof snapshot.statusLine === 'string' ? snapshot.statusLine : '',
    contextPct: snapshot.contextPct,
    updatedAt: snapshot.updatedAt,
    takeover: snapshot.takeover,
    incident: snapshot.incident,
    repair: snapshot.repair,
  }
}

function wireGate(gate: NonNullable<PanelExtras['gate']>): NonNullable<PanelExtras['gate']> {
  const wire: NonNullable<PanelExtras['gate']> = {
    gate: gate.gate,
    state: gate.state,
    items: recent(gate.items, WIRE_PANEL_LIMITS.gateItems).map((item) => ({
      item: item.item,
      label: item.label,
      passed: item.passed === true,
      hint: item.hint,
      example: item.example,
    })),
    awaitingOwner: gate.awaitingOwner === true,
  }
  if (gate.mergedConfirm) {
    wire.mergedConfirm = {
      goal: gate.mergedConfirm.goal,
      acceptance: recent(gate.mergedConfirm.acceptance, 20),
      scope: recent(gate.mergedConfirm.scope, 20),
      verify: gate.mergedConfirm.verify,
      risks: gate.mergedConfirm.risks?.slice(-10).map((risk) => ({ title: risk.title, mitigation: risk.mitigation })),
      rollback: gate.mergedConfirm.rollback,
      requireConfirmation: gate.mergedConfirm.requireConfirmation,
    }
  }
  return wire
}

function wirePanel(panel: PanelExtras): PanelExtras {
  const wire: PanelExtras = {}
  // 客户端契约：changes 恒存在（空数组表示未启用/无变更）。
  wire.changes = recent(panel.changes, WIRE_PANEL_LIMITS.changes).map((change) => ({
    id: change.id,
    title: change.title,
    kind: change.kind,
    complexity: change.complexity,
    risk: change.risk,
    stage: change.stage,
    lifecycle: change.lifecycle,
    session: change.session,
    updatedAt: change.updatedAt,
    artifactLinks: change.artifactLinks?.slice(-10).map((link) => ({ label: link.label, path: link.path })),
  }))
  if (panel.gate) wire.gate = wireGate(panel.gate)
  if (panel.trace && panel.trace.length > 0) {
    wire.trace = recent(panel.trace, WIRE_PANEL_LIMITS.trace).map((row) => ({
      requirementId: row.requirementId,
      scenarioId: row.scenarioId,
      title: row.title,
      taskIds: recent(row.taskIds, 20),
      evidenceIds: recent(row.evidenceIds, 20),
      covered: row.covered === true,
    }))
  }
  if (panel.risks && panel.risks.length > 0) {
    wire.risks = recent(panel.risks, WIRE_PANEL_LIMITS.risks).map((risk) => ({
      category: risk.category,
      grade: risk.grade,
      reason: risk.reason,
      mitigation: risk.mitigation,
      verification: risk.verification,
      needsHuman: risk.needsHuman === true,
    }))
  }
  if (panel.intercepts && panel.intercepts.length > 0) {
    wire.intercepts = recent(panel.intercepts, WIRE_PANEL_LIMITS.intercepts).map((row) => ({
      at: row.at,
      ruleId: row.ruleId,
      tool: row.tool,
      target: row.target,
      effect: row.effect,
      why: row.why,
      unlock: row.unlock,
      source: row.source,
      violationId: row.violationId,
    }))
  }
  if (panel.rules && panel.rules.length > 0) {
    wire.rules = recent(panel.rules, WIRE_PANEL_LIMITS.rules).map((rule) => ({
      id: rule.id,
      decision: rule.decision,
      why: rule.why,
      unlock: rule.unlock,
      hits: typeof rule.hits === 'number' && Number.isFinite(rule.hits) ? rule.hits : 0,
      source: rule.source,
    }))
  }
  if (panel.metrics) {
    wire.metrics = {
      change: panel.metrics.change,
      total: panel.metrics.total,
      notes: panel.metrics.notes,
    }
  }
  if (panel.evidence && panel.evidence.length > 0) {
    wire.evidence = recent(panel.evidence, WIRE_PANEL_LIMITS.evidence).map((row) => ({
      id: row.id,
      taskId: row.taskId,
      group: row.group,
      kind: row.kind,
      phase: row.phase,
      exitCode: row.exitCode,
      run: row.run,
      passed: row.passed,
      failed: row.failed,
      skipped: row.skipped,
      fresh: row.fresh === true,
      finishedAt: row.finishedAt,
    }))
  }
  if (panel.reviews && panel.reviews.length > 0) {
    wire.reviews = recent(panel.reviews, WIRE_PANEL_LIMITS.reviews).map((review) => ({
      id: review.id,
      taskId: review.taskId,
      kind: review.kind,
      verdict: review.verdict,
      findings: recent(review.findings, 20).map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        message: finding.message,
      })),
      coverageOk: review.coverageOk === true,
      createdAt: review.createdAt,
    }))
  }
  if (panel.roadmap) {
    wire.roadmap = {
      mvpCut: panel.roadmap.mvpCut,
      entries: recent(panel.roadmap.entries, WIRE_PANEL_LIMITS.roadmapEntries).map((entry) => ({
        change: entry.change,
        capability: entry.capability,
        goal: entry.goal,
        status: entry.status,
        mvp: entry.mvp === true,
      })),
      delivered: panel.roadmap.delivered,
      total: panel.roadmap.total,
    }
  }
  if (typeof panel.dashboardPath === 'string') wire.dashboardPath = panel.dashboardPath
  return wire
}

/** UTF-8 字节数（不依赖 Buffer，宿主与测试环境都可用）。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * 面板降级到预算内：先丢最不关键的块，changes 最后丢。
 * snapshot 本身超预算时无法靠丢面板解决（不在 P2-11 范围内）。
 */
function enforceWireBudget(projection: FlowgateProjection): FlowgateProjection {
  let bytes = byteLength(JSON.stringify(projection))
  if (bytes <= PANEL_WIRE_BUDGET_BYTES) return projection
  let panel = projection.panel
  for (const key of PANEL_DROP_ORDER) {
    if (!panel) break
    const nextPanel = { ...panel }
    delete nextPanel[key]
    const next = { ...projection, panel: nextPanel }
    bytes = byteLength(JSON.stringify(next))
    panel = nextPanel
    if (bytes <= PANEL_WIRE_BUDGET_BYTES) return next
  }
  return { ...projection, panel }
}

/**
 * 内部投影状态 → 客户端 wire 值（显式白名单 DTO）。
 *
 * 注意：这里只负责"挑字段 + 限量"，undefined 清洗仍由调用方在边界统一做
 * （`toLosslessJson(toWireProjection(state))`），保持单一清洗入口。
 */
export function toWireProjection(state: FlowgateProjection): FlowgateProjection {
  const projection: FlowgateProjection = {
    snapshot: wireSnapshot(state.snapshot),
    revision: typeof state.revision === 'number' && Number.isFinite(state.revision) ? state.revision : 0,
    updatedAt: state.updatedAt,
  }
  if (state.panel !== undefined && state.panel !== null && typeof state.panel === 'object') {
    projection.panel = wirePanel(state.panel)
  }
  if (typeof state.epoch === 'string' && state.epoch !== '') projection.epoch = state.epoch
  return enforceWireBudget(projection)
}
