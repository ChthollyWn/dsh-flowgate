/**
 * 投影面板数据构建（纯同步、无 IO）。
 *
 * 由 `engine.onStateChange` 触发，每次状态变化重新构建；因此这里**只能读**
 * engine 缓存（snapshot/artifacts/config/evidence），不得 await 或触发门禁检查。
 * 复杂数据（指标、报告）由命令/面板动作按需生成，这里只放缓存/摘要。
 */
import type { EngineLike } from '../types.js'
import type {
  ChangeSummary,
  EvidenceRow,
  GatePanel,
  InterceptRow,
  PanelExtras,
  RiskRow,
  RoadmapSummary,
  RuleRow,
  TraceRow,
} from './types.js'
import { reviewRowOf, summaryOf } from './types.js'
import { buildMergedConfirm, toGatePanelConfirm } from '../gates/merged.js'

export interface PanelBuildInput {
  engine: EngineLike
  /** host 侧拦截记录（最近 100 条，与 engine 的拦截计数互补）。 */
  intercepts: readonly InterceptRow[]
  /** 面板"打开看板"按钮的路径（仓库相对）。 */
  dashboardPath?: string
  now: string
}

/** 构建面板补充数据；任何单项失败都只让该块缺失，不影响投影其余部分。 */
export function buildPanel(input: PanelBuildInput): PanelExtras {
  const { engine } = input
  const panel: PanelExtras = {}
  try {
    // 客户端契约要求 changes 可用（空数组表示未启用/无变更），不要省略字段。
    panel.changes = engine.allChanges().map(toChangeSummary)
  } catch {
    panel.changes = []
  }
  try {
    const gate = buildGate(engine)
    if (gate) panel.gate = gate
  } catch {
    // 门记录损坏时省略。
  }
  try {
    const trace = buildTrace(engine)
    if (trace.length > 0) panel.trace = trace
  } catch {
    // 追溯矩阵依赖产物解析，失败时省略。
  }
  try {
    const risks = buildRisks(engine)
    if (risks.length > 0) panel.risks = risks
  } catch {
    // 风险文档损坏时省略。
  }
  try {
    if (input.intercepts.length > 0) panel.intercepts = [...input.intercepts].slice(-100)
  } catch {
    // 忽略。
  }
  try {
    const rules = buildRules(engine)
    if (rules.length > 0) panel.rules = rules
  } catch {
    // 忽略。
  }
  try {
    const evidence = buildEvidence(engine)
    if (evidence.length > 0) panel.evidence = evidence
  } catch {
    // 忽略。
  }
  try {
    const change = engine.currentChange()
    if (change && change.reviews.length > 0) panel.reviews = change.reviews.slice(-20).map(reviewRowOf)
  } catch {
    // 忽略。
  }
  try {
    const roadmap = buildRoadmap(engine)
    if (roadmap) panel.roadmap = roadmap
  } catch {
    // 忽略。
  }
  if (input.dashboardPath) panel.dashboardPath = input.dashboardPath
  return panel
}

function toChangeSummary(change: ReturnType<EngineLike['currentChange']>): ChangeSummary {
  // 非空断言由调用方 allChanges 保证。
  return summaryOf(change as NonNullable<typeof change>)
}

function buildGate(engine: EngineLike): GatePanel | undefined {
  const change = engine.currentChange()
  if (!change) return undefined
  const snapshot = engine.snapshot()
  const gateId = snapshot.awaitingGate ?? snapshot.pendingGate ?? null
  const record = gateId ? change.gates[gateId] : undefined
  const items = (record?.items ?? []).map((item) => ({
    item: item.item,
    label: item.label,
    passed: item.passed,
    hint: item.hint,
    example: item.example,
  }))
  const awaitingOwner = Boolean(snapshot.awaitingGate)
  const panel: GatePanel = {
    gate: gateId,
    state: record?.state ?? 'pending',
    items,
    awaitingOwner,
  }
  if (gateId === 'G3' && change.complexity === 'low') {
    const merged = buildMergedConfirm(engine)
    if (merged) panel.mergedConfirm = toGatePanelConfirm(merged)
  }
  return panel
}

function buildTrace(engine: EngineLike): TraceRow[] {
  const artifacts = engine.getArtifacts()
  const scenarios = artifacts.spec?.scenarios ?? []
  if (scenarios.length === 0) return []
  const tasks = engine.getTasks()
  const change = engine.currentChange()
  const receipts = engine.getEvidence()
  const rows: TraceRow[] = []
  for (const scenario of scenarios) {
    const relatedTasks = tasks.filter(
      (task) => task.covers.includes(scenario.id) || task.covers.includes(scenario.requirementId),
    )
    const taskIds = relatedTasks.map((task) => task.id)
    const taskStates = taskIds.map((taskId) => ({ id: taskId, state: change?.tasks[taskId] }))
    const evidenceIds = taskStates.flatMap((entry) => entry.state?.evidenceIds ?? [])
    const knownEvidence = new Set(receipts.map((receipt) => receipt.id))
    const covered = taskIds.length > 0 && evidenceIds.some((id) => knownEvidence.has(id))
    rows.push({
      requirementId: scenario.requirementId,
      scenarioId: scenario.id,
      title: scenario.title,
      taskIds,
      evidenceIds,
      covered,
    })
  }
  return rows
}

function buildRisks(engine: EngineLike): RiskRow[] {
  const entries = engine.getArtifacts().risk?.entries ?? []
  return entries.map((entry) => ({
    category: entry.category,
    grade: entry.grade,
    reason: entry.reason,
    mitigation: entry.mitigation,
    verification: entry.verification,
    needsHuman: entry.needsHuman,
  }))
}

function buildRules(engine: EngineLike): RuleRow[] {
  const rules = engine.getConfig().rules ?? []
  const counts = engine.snapshot().interceptCounts ?? {}
  return rules.map((rule) => ({
    id: rule.id,
    decision: rule.decision,
    why: rule.why,
    unlock: rule.unlock,
    hits: counts[rule.id] ?? 0,
    source: rule.source,
  }))
}

function buildEvidence(engine: EngineLike): EvidenceRow[] {
  const receipts = engine.getEvidence()
  // 每组最新回执视为 fresh 的候选（真正的新鲜度由输入哈希判定，面板只做展示）。
  const latestByGroup = new Map<string, string>()
  for (const receipt of receipts) latestByGroup.set(receipt.group, receipt.id)
  return receipts.slice(-50).map((receipt) => ({
    id: receipt.id,
    taskId: receipt.taskId,
    group: receipt.group,
    kind: receipt.kind,
    phase: receipt.phase,
    exitCode: receipt.exitCode,
    run: receipt.summary?.run ?? 0,
    passed: receipt.summary?.passed ?? 0,
    failed: receipt.summary?.failed ?? 0,
    skipped: receipt.summary?.skipped ?? 0,
    fresh: latestByGroup.get(receipt.group) === receipt.id && !receipt.timedOut,
    finishedAt: receipt.finishedAt,
  }))
}

function buildRoadmap(engine: EngineLike): RoadmapSummary | undefined {
  const roadmap = engine.getRoadmap()
  if (!roadmap) return undefined
  const delivered = roadmap.entries.filter((entry) => entry.status === '已交付').length
  return {
    mvpCut: roadmap.mvpCut,
    entries: roadmap.entries.map((entry) => ({
      change: entry.change,
      capability: entry.capability,
      goal: entry.goal,
      status: entry.status,
      mvp: entry.mvp,
    })),
    delivered,
    total: roadmap.entries.length,
  }
}

/** 拦截记录 → 面板行（供 guard 模块与 runtime 共用）。 */
export function interceptRowOf(input: {
  at: string
  ruleId: string
  tool: string
  target?: string
  effect: 'deny' | 'human'
  why: string
  unlock: string
  source?: string
  violationId?: string
}): InterceptRow {
  return {
    at: input.at,
    ruleId: input.ruleId,
    tool: input.tool,
    target: input.target,
    effect: input.effect,
    why: input.why,
    unlock: input.unlock,
    source: input.source,
    violationId: input.violationId,
  }
}
