/**
 * Metrics M-1 .. M-18 (docs/02 §7, docs/03 §12.2 指标视图).
 *
 * Everything is derived from the change status, the append-only ledger, the
 * parsed artifacts and evidence receipts. Values the plugin genuinely cannot
 * observe (host token usage, wall-clock comparison against a plugin-less
 * baseline, human response times without decisions) are returned as the
 * string `'未知'` and explained in `notes`; they are never replaced by 0
 * (FR-10.4: 缺失数据标"未知"，不用 0 代替，也不参与平均值).
 */
import type {
  ArtifactBundle,
  ChangeStatus,
  EvidenceReceipt,
  LedgerEvent,
  MetricSet,
  MetricValue,
  ReviewFinding,
  TaskCard,
} from '../types'
import { minutesBetween } from '../util/time'

export const METRIC_IDS = [
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

export interface MetricDefinition {
  id: string
  name: string
  definition: string
  target: string
}

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  { id: 'M-1', name: '跳步拦截数', definition: '因"阶段顺序"被拒绝的动作数（账本 rule.denied 且命中 R-STAGE-SRC）', target: '越早越少越好' },
  { id: 'M-2', name: '实际跳步数', definition: '未过门禁就进入下一阶段的次数（账本 stage.entered 缺少来源门禁字段）', target: '0' },
  { id: 'M-3', name: '越界尝试数', definition: '范围外写入尝试数；交付时越界残留数写入口径说明', target: '残留 = 0' },
  { id: 'M-4', name: '虚假完成拦截数', definition: '因缺少/过期证据被拒的 task_done 与被拦下的"宣布完成"（turn.continued 事件）', target: '—' },
  { id: 'M-5', name: '误判率', definition: '负责人标为误判的拦截 ÷ 全部拦截（百分比）', target: '≤ 5%' },
  { id: 'M-6', name: '门禁首次通过率', definition: '各门第一次提交就通过的比例（百分比）', target: '随使用上升' },
  { id: 'M-7', name: '澄清效率', definition: '澄清轮数；问题数与自定义回答占比写入口径说明', target: '—' },
  { id: 'M-8', name: '需求返工数', definition: 'G1 之后的需求变更次数（G1 重复提交 + requirement 返工事件）', target: '越少越好' },
  { id: 'M-9', name: '验收覆盖率', definition: '有通过证据的场景 ÷ 全部场景（百分比，自动化与手工分开统计）', target: 'G6 时 100%' },
  { id: 'M-10', name: 'TDD 合规率', definition: '有 RED → GREEN 证据的必需 TDD 任务 ÷ 必需 TDD 任务（百分比）', target: '100%' },
  { id: 'M-11', name: '审查发现', definition: 'critical / major / minor 数量（主值取总数）；修复轮次写入口径说明', target: '—' },
  { id: 'M-12', name: '回归失败数', definition: '相对基线新增的失败测试数（来自全量测试回执的 regressions）', target: '0' },
  { id: 'M-13', name: '人工负担', definition: '人工审批次数；单次放行次数与平均响应时间写入口径说明', target: '中复杂度每变更 ≤ 5 次' },
  { id: 'M-14', name: '阶段成本', definition: '变更总耗时（分钟）；各阶段耗时写入口径说明，token 数取不到时标未知', target: '—' },
  { id: 'M-15', name: '流程开销', definition: '同一基准任务有/无插件的耗时和 token 之比，需对照测量', target: '先测量' },
  { id: 'M-16', name: '路线图进度', definition: '已交付变更 ÷ 路线图中的变更（MVP 切线内外分开统计）', target: '—' },
  { id: 'M-17', name: '上下文健康度', definition: '主会话上下文峰值占用；压缩次数、接续次数写入口径说明', target: '—' },
  { id: 'M-18', name: '并行效率', definition: '并行加速比（各任务耗时之和 ÷ 实际耗时）；检查点失败/合并冲突/降级写入口径说明', target: '先测量' },
]

const METRIC_BY_ID = new Map(METRIC_DEFINITIONS.map((definition) => [definition.id, definition]))

/** Pipeline order used by the M-2 ledger audit. */
const PIPELINE_STAGE_INDEX: Record<string, number> = {
  roadmap: 0,
  S0: 1,
  S1: 2,
  S2: 3,
  S3: 4,
  S4: 5,
  S5: 6,
  S6: 7,
  archived: 8,
}

/** Which gate must pass before entering each stage (M-2 audit). */
const GATE_ENTERING_STAGE: Record<string, string> = {
  S1: 'G0',
  S2: 'G1',
  S3: 'G2',
  S4: 'G3',
  S5: 'G4',
  S6: 'G5',
  archived: 'G6',
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percent(numerator: number, denominator: number): MetricValue {
  if (denominator <= 0) return '未知'
  return round((numerator / denominator) * 100, 1)
}

function isNumber(value: MetricValue): value is number {
  return typeof value === 'number'
}

function eventsOf(ledger: LedgerEvent[], types: LedgerEvent['type'][]): LedgerEvent[] {
  return ledger.filter((event) => types.includes(event.type))
}

function countWhere(
  ledger: LedgerEvent[],
  types: LedgerEvent['type'][],
  predicate: (event: LedgerEvent) => boolean,
): number {
  return eventsOf(ledger, types).filter(predicate).length
}

function dataOf(event: LedgerEvent): Record<string, unknown> {
  return event.data ?? {}
}

function dataString(event: LedgerEvent, key: string): string {
  const value = dataOf(event)[key]
  return typeof value === 'string' ? value : ''
}

function dataStringList(event: LedgerEvent, key: string): string[] {
  const value = dataOf(event)[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function numberFromData(event: LedgerEvent, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = dataOf(event)[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function stageEnteredEvents(ledger: LedgerEvent[]): LedgerEvent[] {
  return eventsOf(ledger, ['stage.entered']).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq))
}

function stageOfEvent(event: LedgerEvent): string {
  return dataString(event, 'stage') || dataString(event, 'to') || dataString(event, 'toStage')
}

function gateOfEvent(event: LedgerEvent): string {
  return dataString(event, 'gate') || dataString(event, 'gateId')
}

function findingsOf(change: ChangeStatus): ReviewFinding[] {
  return change.reviews.flatMap((review) => review.findings ?? [])
}

function taskDurations(change: ChangeStatus): { sumMs: number; wallMs: number; parallelBatches: number } {
  let sumMs = 0
  let wallMs = 0
  let parallelBatches = 0
  for (const batch of change.batches) {
    if (batch.mode !== 'parallel') continue
    parallelBatches += 1
    let batchSum = 0
    for (const taskId of batch.tasks) {
      const task = change.tasks[taskId]
      if (!task?.startedAt || !task.finishedAt) continue
      const minutes = minutesBetween(task.startedAt, task.finishedAt)
      if (minutes !== null && minutes > 0) batchSum += minutes
    }
    const wall = batch.startedAt && batch.completedAt ? minutesBetween(batch.startedAt, batch.completedAt) : null
    if (wall !== null && wall > 0) {
      sumMs += batchSum
      wallMs += wall
    }
  }
  return { sumMs, wallMs, parallelBatches }
}

/**
 * Compute the M-1..M-18 metric set for one change.
 *
 * Multi-part metrics keep a single scalar in `metrics` (the first named part)
 * and describe the remaining parts in `notes`, matching the single-value
 * `MetricValue` contract while keeping the CSV/text human-readable.
 */
export function computeMetrics(input: {
  change: ChangeStatus
  ledger: LedgerEvent[]
  artifacts: ArtifactBundle
  evidence: EvidenceReceipt[]
  now: string
}): MetricSet {
  const { change, artifacts, evidence, now } = input
  const ledger = input.ledger.filter((event) => {
    const eventChange = dataString(event, 'changeId') || dataString(event, 'change')
    return eventChange === '' || eventChange === change.id
  })
  const metrics: Record<string, MetricValue> = {}
  const notes: Record<string, string> = {}

  // M-1 跳步拦截数 -----------------------------------------------------------
  {
    const count = countWhere(ledger, ['rule.denied'], (event) => {
      const ruleId = dataString(event, 'ruleId') || dataString(event, 'rule')
      const category = dataString(event, 'category') || dataString(event, 'reasonKind')
      return ruleId === 'R-STAGE-SRC' || category === 'stage-order' || category === 'stage'
    })
    metrics['M-1'] = count
    notes['M-1'] = '账本中 rule.denied 且规则为 R-STAGE-SRC（或 category=stage-order）的事件数'
  }

  // M-2 实际跳步数 -----------------------------------------------------------
  {
    const ordered = ledger.slice().sort((a, b) => a.seq - b.seq)
    let lastIndex = PIPELINE_STAGE_INDEX.S0 ?? 1
    let lastPosition = -1
    let skips = 0
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index]!
      if (event.type !== 'stage.entered') continue
      const target = stageOfEvent(event)
      const targetIndex = PIPELINE_STAGE_INDEX[target]
      if (targetIndex === undefined) {
        lastPosition = index
        continue
      }
      if (targetIndex > lastIndex) {
        const expectedGate = GATE_ENTERING_STAGE[target] ?? ''
        let gateSeen = false
        for (let cursor = lastPosition + 1; cursor < index; cursor += 1) {
          const candidate = ordered[cursor]!
          if (candidate.type !== 'gate.passed' && candidate.type !== 'gate.approved') continue
          if (gateOfEvent(candidate) === expectedGate) {
            gateSeen = true
            break
          }
        }
        if (dataOf(event)['bypass'] === true || !gateSeen || targetIndex > lastIndex + 1) skips += 1
      }
      lastIndex = targetIndex
      lastPosition = index
    }
    metrics['M-2'] = skips
    notes['M-2'] =
      '账本审计：向前进入新阶段时，若同一窗口内没有对应门禁的 gate.passed/gate.approved，或一次跳过多个阶段，计一次跳步；回退（如风险提升回 S4）不计'
  }

  // M-3 越界尝试数 / 残留 -----------------------------------------------------
  {
    const residual = change.violations.filter((violation) => violation.clearedAt === undefined).length
    metrics['M-3'] = change.violations.length
    notes['M-3'] = `来自 change.violations 的越界记录数；交付时越界残留 ${residual} 个（clearedAt 为空）`
  }

  // M-4 虚假完成拦截数 --------------------------------------------------------
  {
    const turnContinued = countWhere(ledger, ['turn.continued'], () => true)
    // Engine records rejected `flow_task_done` calls as `task.blocked` with a
    // `failures` array of item ids; evidence failures look like `evidence:<组>`.
    const blockedTaskDone = countWhere(ledger, ['task.blocked'], (event) => {
      const failures = dataOf(event)['failures']
      if (Array.isArray(failures)) {
        return failures.some((item) => typeof item === 'string' && item.includes('evidence'))
      }
      const ruleId = dataString(event, 'ruleId') || dataString(event, 'rule')
      const check = dataString(event, 'check') || dataString(event, 'reasonKind')
      return ruleId === 'R-VERIFY' || ruleId === 'R-EVIDENCE' || ruleId === 'R-FAKE-DONE' || check === 'evidence'
    })
    const fakeDoneDenied = countWhere(ledger, ['rule.denied'], (event) => {
      const ruleId = dataString(event, 'ruleId') || dataString(event, 'rule')
      const check = dataString(event, 'check') || dataString(event, 'reasonKind')
      return ruleId === 'R-VERIFY' || ruleId === 'R-EVIDENCE' || ruleId === 'R-FAKE-DONE' || check === 'evidence'
    })
    metrics['M-4'] = turnContinued + blockedTaskDone + fakeDoneDenied
    notes['M-4'] = `turn.continued ${turnContinued} 次 + 因缺少/过期证据被拒的 task.blocked ${blockedTaskDone} 次 + 证据类 rule.denied ${fakeDoneDenied} 次`
  }

  // M-5 误判率 ----------------------------------------------------------------
  {
    const interceptions = countWhere(ledger, ['rule.denied', 'rule.human'], () => true)
    const misjudged = countWhere(ledger, ['rule.denied', 'rule.human', 'override.granted', 'exception.added'], (event) => {
      if (dataOf(event)['misjudged'] === true || dataString(event, 'reasonKind') === 'misjudged') return true
      // The panel's "误判·放行一次" flow records the reason; accept the Chinese marker.
      return /误判/.test(dataString(event, 'reason'))
    })
    metrics['M-5'] = percent(misjudged, interceptions)
    const hinted = ledger.filter((event) => event.type === 'rule.hinted')
    const hintedRules = [...new Set(hinted.map((event) => String(event.data.ruleId ?? 'unknown')))]
    notes['M-5'] =
      interceptions === 0
        ? '没有任何拦截记录，误判率无法计算，保持"未知"（不参与平均值）'
        : `误判 ${misjudged} ÷ 全部拦截 ${interceptions}；统计账本中显式标为 misjudged 或理由含「误判」的放行/例外记录${
            hinted.length > 0 ? `；另有 ${hinted.length} 次规则因误判率超阈值自动降为提示（${hintedRules.join('、')}）` : ''
          }`
  }

  // M-6 门禁首次通过率 --------------------------------------------------------
  {
    const attempts = Object.values(change.gates).filter((gate) => gate && gate.attempts > 0)
    const firstPass = attempts.filter((gate) => gate && gate.state === 'passed' && gate.attempts === 1)
    metrics['M-6'] = percent(firstPass.length, attempts.length)
    notes['M-6'] =
      attempts.length === 0
        ? '还没有门禁提交记录，无法计算首次通过率'
        : `${firstPass.length} ÷ ${attempts.length} 个提交过的门禁（attempts=1 且 state=passed）`
  }

  // M-7 澄清效率 --------------------------------------------------------------
  {
    const clarify = artifacts.clarify
    const ledgerRounds = new Set<number>()
    for (const event of eventsOf(ledger, ['clarify.asked', 'clarify.answered'])) {
      const round = numberFromData(event, 'round')
      if (round !== null) ledgerRounds.add(round)
    }
    const rounds = Math.max(change.clarifyRounds ?? 0, clarify?.rounds ?? 0, ledgerRounds.size)
    const questions = clarify?.qa.length ?? countWhere(ledger, ['clarify.asked'], () => true)
    const customAnswers = (clarify?.qa ?? []).filter((qa) => {
      const answer = qa.answer.trim()
      return answer !== '' && !qa.options.some((option) => option.trim() === answer)
    }).length
    metrics['M-7'] = rounds
    notes['M-7'] = `澄清轮数；问题 ${questions} 个，其中自定义回答 ${customAnswers} 个（占比 ${
      questions > 0 ? `${round((customAnswers / questions) * 100, 1)}%` : '未知'
    }）`
  }

  // M-8 需求返工数 ------------------------------------------------------------
  {
    const g1Submits = countWhere(ledger, ['gate.submitted'], (event) => gateOfEvent(event) === 'G1')
    const requirementRework = countWhere(ledger, ['clarify.asked', 'gate.submitted', 'plan.amend_requested'], (event) => {
      const kind = dataString(event, 'reworkKind') || dataString(event, 'kind')
      return kind === 'requirement'
    })
    metrics['M-8'] = Math.max(0, g1Submits - 1) + requirementRework
    notes['M-8'] = `G1 重复提交 ${Math.max(0, g1Submits - 1)} 次 + requirement 返工事件 ${requirementRework} 次`
  }

  // M-9 验收覆盖率 ------------------------------------------------------------
  {
    const scenarios = artifacts.spec?.scenarios ?? []
    const taskCards: TaskCard[] = artifacts.tasks?.tasks ?? []
    const greenTaskIds = new Set(evidence.filter((receipt) => receipt.phase === 'green' && receipt.taskId).map((receipt) => receipt.taskId!))
    const covered = scenarios.filter((scenario) =>
      taskCards.some((task) => task.covers.includes(scenario.id) && greenTaskIds.has(task.id)),
    )
    metrics['M-9'] = percent(covered.length, scenarios.length)
    notes['M-9'] =
      scenarios.length === 0
        ? '规格中没有场景（或 spec.md 未提供），覆盖率无法计算'
        : `自动化覆盖 ${covered.length}/${scenarios.length} 个场景；手工证据覆盖率需负责人确认，标为未知`
  }

  // M-10 TDD 合规率 -----------------------------------------------------------
  {
    const required = (artifacts.tasks?.tasks ?? []).filter((task) => task.tdd === 'required')
    let compliant = 0
    for (const task of required) {
      const receipts = evidence
        .filter((receipt) => receipt.taskId === task.id)
        .slice()
        .sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0))
      const redIndex = receipts.findIndex((receipt) => receipt.phase === 'red')
      const greenIndex = receipts.findIndex((receipt) => receipt.phase === 'green')
      if (redIndex !== -1 && greenIndex !== -1 && redIndex < greenIndex) compliant += 1
    }
    metrics['M-10'] = percent(compliant, required.length)
    notes['M-10'] =
      required.length === 0
        ? '没有 tdd: required 的任务，合规率不适用'
        : `${compliant} ÷ ${required.length} 个必需 TDD 任务有 RED → GREEN 回执（按 finishedAt 排序）`
  }

  // M-11 审查发现 -------------------------------------------------------------
  {
    const findings = findingsOf(change)
    const critical = findings.filter((finding) => finding.severity === 'critical').length
    const major = findings.filter((finding) => finding.severity === 'major').length
    const minor = findings.filter((finding) => finding.severity === 'minor').length
    metrics['M-11'] = findings.length
    notes['M-11'] = `critical ${critical} / major ${major} / minor ${minor}；审查记录 ${change.reviews.length} 条，修复轮次 ${
      change.reviews.filter((review) => review.verdict === 'changes-required').length
    }`
  }

  // M-12 回归失败数 -----------------------------------------------------------
  {
    const regressionReceipts = evidence.filter((receipt) => Array.isArray(receipt.summary?.regressions))
    if (regressionReceipts.length === 0) {
      metrics['M-12'] = '未知'
      notes['M-12'] = '还没有带基线对比的全量测试回执（runFullSuite），回归数取不到；不用 0 代替'
    } else {
      const regressions = new Set<string>()
      for (const receipt of regressionReceipts) for (const name of receipt.summary?.regressions ?? []) regressions.add(name)
      metrics['M-12'] = regressions.size
      notes['M-12'] = `汇总 ${regressionReceipts.length} 条全量测试回执的 regressions 字段`
    }
  }

  // M-13 人工负担 -------------------------------------------------------------
  {
    const decided = change.pending.filter((item) => item.decidedAt !== undefined)
    // Human gate approvals / risk / scope decisions also live in the ledger;
    // auto gates (gate.approved with data.auto) do not count as human burden.
    const ledgerApprovals = countWhere(ledger, ['gate.approved', 'scope.approved', 'risk.approved', 'override.granted'], (event) => {
      if (event.type === 'gate.approved') return dataOf(event)['auto'] !== true
      return true
    })
    const approvals = Math.max(decided.length, ledgerApprovals)
    const overridesUsed = change.overrides.filter((override) => override.usedAt !== undefined).length
    const responseTimes = decided
      .map((item) => (item.decidedAt ? minutesBetween(item.createdAt, item.decidedAt) : null))
      .filter((value): value is number => value !== null)
    const averageResponse =
      responseTimes.length > 0 ? round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length, 1) : null
    metrics['M-13'] = approvals
    notes['M-13'] = `人工审批 ${approvals} 次（账本 ${ledgerApprovals} 次 / 已处理待处理项 ${decided.length} 个，取较大值避免重复计数）；单次放行 ${overridesUsed} 次；平均响应时间 ${
      averageResponse === null ? '未知' : `${averageResponse} 分钟`
    }`
  }

  // M-14 阶段成本 -------------------------------------------------------------
  {
    const totalMinutes = minutesBetween(change.createdAt, change.updatedAt || now)
    const stageBreakdown: string[] = []
    const entries = stageEnteredEvents(ledger)
    for (let i = 0; i < entries.length; i += 1) {
      const current = entries[i]!
      const stage = stageOfEvent(current) || '未标注阶段'
      const nextAt = i + 1 < entries.length ? entries[i + 1]!.at : change.updatedAt || now
      const minutes = minutesBetween(current.at, nextAt)
      if (minutes !== null && minutes > 0) stageBreakdown.push(`${stage} ${minutes} 分钟`)
    }
    metrics['M-14'] = totalMinutes === null ? '未知' : totalMinutes
    notes['M-14'] = `变更总耗时（createdAt → updatedAt）；${
      stageBreakdown.length > 0 ? `分阶段：${stageBreakdown.join('、')}` : '分阶段耗时需要账本 stage.entered 事件'
    }；token 用量宿主未提供，标为未知`
  }

  // M-15 流程开销 -------------------------------------------------------------
  {
    const snapshot = eventsOf(ledger, ['metrics.snapshot']).filter((event) => numberFromData(event, 'overheadRatio') !== null).pop()
    const ratio = snapshot ? numberFromData(snapshot, 'overheadRatio') : null
    metrics['M-15'] = ratio === null ? '未知' : ratio
    notes['M-15'] =
      ratio === null
        ? '需要同一基准任务有/无插件的耗时与 token 对照测量，插件内无法自动获得'
        : '来自账本 metrics.snapshot 事件 data.overheadRatio'
  }

  // M-16 路线图进度 -----------------------------------------------------------
  {
    const roadmapEvent = eventsOf(ledger, ['roadmap.progress', 'roadmap.approved'])
      .filter((event) => numberFromData(event, 'total', 'delivered') !== null)
      .pop()
    const total = roadmapEvent ? numberFromData(roadmapEvent, 'total') : null
    const delivered = roadmapEvent ? numberFromData(roadmapEvent, 'delivered') : null
    if (total !== null && delivered !== null && total > 0) {
      metrics['M-16'] = percent(delivered, total)
      notes['M-16'] = `已交付 ${delivered} ÷ 路线图 ${total}（来自账本 roadmap.progress/roadmap.approved 事件）`
    } else {
      metrics['M-16'] = '未知'
      notes['M-16'] = '路线图数据不在 ArtifactBundle 中；需要 roadmap.md/路线图模块把已交付与总数写进账本'
    }
  }

  // M-17 上下文健康度 ---------------------------------------------------------
  {
    const snapshot = eventsOf(ledger, ['metrics.snapshot'])
      .filter((event) => numberFromData(event, 'contextPeakRatio', 'contextPeakPct') !== null)
      .pop()
    const ratio = snapshot ? numberFromData(snapshot, 'contextPeakRatio') : null
    const pct = snapshot ? numberFromData(snapshot, 'contextPeakPct') : null
    const attaches = countWhere(ledger, ['session.attached'], () => true)
    const continued = countWhere(ledger, ['turn.continued'], () => true)
    if (ratio !== null) metrics['M-17'] = round(ratio * 100, 1)
    else if (pct !== null) metrics['M-17'] = pct
    else metrics['M-17'] = '未知'
    notes['M-17'] =
      `${metrics['M-17'] === '未知' ? '上下文峰值占用宿主未提供；' : ''}跨会话接续 ${attaches} 次，轮次继续 ${continued} 次；压缩次数与节省 token 宿主未提供`
  }

  // M-18 并行效率 -------------------------------------------------------------
  {
    const timing = taskDurations(change)
    const checkpointFailed = countWhere(ledger, ['checkpoint.failed'], () => true) +
      countWhere(ledger, ['batch.completed'], (event) => dataString(event, 'checkpoint') === 'failed')
    const mergeConflicts = countWhere(ledger, ['merge.conflict'], () => true)
    const downgraded = (artifacts.tasks?.execution.batches ?? []).filter((batch) => batch.downgraded !== undefined).length
    if (timing.wallMs > 0 && timing.sumMs > 0) {
      metrics['M-18'] = round(timing.sumMs / timing.wallMs, 2)
      notes['M-18'] = `加速比 = 并行批次内任务耗时之和 ${timing.sumMs} 分钟 ÷ 实际墙钟 ${timing.wallMs} 分钟；集成检查点失败 ${checkpointFailed} 次、合并冲突 ${mergeConflicts} 次、降级为顺序 ${downgraded} 次`
    } else {
      metrics['M-18'] = '未知'
      notes['M-18'] = `没有可计算的并行批次时间（并行批次 ${timing.parallelBatches} 个，缺少任务或批次起止时间）；集成检查点失败 ${checkpointFailed} 次、合并冲突 ${mergeConflicts} 次、降级为顺序 ${downgraded} 次`
    }
  }

  // Ensure every metric id has a value + note even if a future revision misses one.
  for (const definition of METRIC_DEFINITIONS) {
    if (!(definition.id in metrics)) {
      metrics[definition.id] = '未知'
      notes[definition.id] = '未采集到该指标所需数据'
    }
  }

  return { changeId: change.id, generatedAt: now, metrics, notes }
}

function formatValue(value: MetricValue): string {
  if (value === '未知') return '未知'
  if (Number.isInteger(value)) return String(value)
  return String(round(value, 2))
}

function metricLabel(id: string): string {
  return METRIC_BY_ID.get(id)?.name ?? id
}

/** Human-readable Chinese metric table for `/flow metrics`. */
export function formatMetricsText(set: MetricSet): string {
  const lines = [
    `FlowGate 指标 · ${set.changeId}（生成于 ${set.generatedAt}）`,
    '',
    '| ID | 指标 | 数值 | 统计口径 |',
    '|---|---|---|---|',
  ]
  for (const definition of METRIC_DEFINITIONS) {
    const value = set.metrics[definition.id] ?? '未知'
    const note = (set.notes[definition.id] ?? '').replace(/\|/g, '／')
    lines.push(`| ${definition.id} | ${metricLabel(definition.id)} | ${formatValue(value)} | ${note} |`)
  }
  lines.push('')
  lines.push('取不到的指标显示为「未知」，不用 0 代替，也不参与平均值（FR-10.4）。')
  return lines.join('\n')
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

/** CSV export for `/flow metrics --csv` (UTF-8, one row per metric). */
export function metricsCsv(set: MetricSet): string {
  const rows = [['指标ID', '指标名称', '数值', '统计口径'].join(',')]
  for (const definition of METRIC_DEFINITIONS) {
    const value = set.metrics[definition.id] ?? '未知'
    rows.push(
      [
        definition.id,
        metricLabel(definition.id),
        formatValue(value),
        set.notes[definition.id] ?? '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  return `${rows.join('\n')}\n`
}

/** Convenience used by report/dashboard: metrics present in the set. */
export function metricsAsRows(set: MetricSet): { id: string; name: string; value: MetricValue; note: string }[] {
  return METRIC_DEFINITIONS.map((definition) => ({
    id: definition.id,
    name: definition.name,
    value: set.metrics[definition.id] ?? '未知',
    note: set.notes[definition.id] ?? '',
  }))
}

export { formatValue as formatMetricValue, isNumber as isMetricNumber }
