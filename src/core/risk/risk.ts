/**
 * 风险引擎（03 §8.1 风险登记 / FR-6.1、FR-6.6 等级中途调整 / 03 §8.3 待处理项）。
 *
 * - `checkRiskDoc`：校验 risk.md 五类齐全（等级为「无」也要写理由）、高风险项
 *   必须标记「需人工接管」，并给出回滚方案线索提示。
 * - `riskRaisedEffects`：风险提高后，已完成任务的审查按新标准重新要求（回执保留）；
 *   已进入 S5/S6 的退回 S4。
 * - `riskTriggerPending`：命中风险触发器时生成待处理项草稿（`RK-n` 由 store 编号）。
 */
import type {
  CheckOutcome,
  LevelProfile,
  PendingDraft,
  RiskCategory,
  RiskDoc,
  RiskEntry,
  StageId,
  ChangeStatus,
} from '../types'
import type { TriggerHit } from '../rules/risk-triggers'
import { checkOutcome } from './outcome'

/** 与 core/rules 的 `TriggerHit` 同型（保留本模块的稳定导出名）。 */
export type RiskTriggerHit = TriggerHit

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  security: '安全',
  performance: '性能',
  cost: '成本',
  compliance: '合规',
  maintainability: '可维护性',
}

const ALL_CATEGORIES: RiskCategory[] = [
  'security',
  'performance',
  'cost',
  'compliance',
  'maintainability',
]

const REQUIRED_RISK_EXAMPLE = [
  '| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |',
  '|---|---|---|---|---|---|',
  '| 安全 | 高 | 回调需要验签，伪造回调可白嫖会员 | 复用 SignatureVerifier | 场景 R3.S2 测试 | 是 |',
  '| 成本 | 无 | 不新增外部调用 | — | — | 否 |',
].join('\n')

/** 回滚方案线索关键词（design.md 的回滚方案或 risk.md 的缓解措施里出现其一即可）。 */
const ROLLBACK_CLUE = /回滚|回退|降级|灰度|开关|切换|恢复|兜底|revert|rollback|feature[\s_-]?flag|kill[\s_-]?switch/i

function emptyDocOutcome(profile: LevelProfile): CheckOutcome[] {
  const requires = profile.requiresRiskDoc || profile.risk === 'high'
  if (!requires) {
    return [
      checkOutcome({
        item: 'risk.doc',
        label: '风险登记（本级免填）',
        passed: true,
        hint: '低复杂度普通风险可以免写 risk.md；内置风险触发器照常生效，命中仍会转人工。',
      }),
    ]
  }
  return [
    checkOutcome({
      item: 'risk.doc',
      label: '风险登记存在',
      passed: false,
      hint: 'S3 需要写 changes/<id>/risk.md：安全、性能、成本、合规、可维护性五类，每类写等级、理由、缓解措施、验证方式、是否需要人工接管；等级为「无」也要写一句理由。',
      example: REQUIRED_RISK_EXAMPLE,
    }),
  ]
}

const GRADE_LABELS: Record<string, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
}

function entryLabel(entry: RiskEntry): string {
  const grade = GRADE_LABELS[entry.grade] ?? entry.grade
  return `${CATEGORY_LABELS[entry.category] ?? entry.category}（${grade}）`
}

function isBlank(value: string | undefined): boolean {
  if (value === undefined) return true
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '—' || trimmed === '-' || trimmed === '/'
}

/**
 * 校验风险登记。返回若干 CheckOutcome（失败项带 hint/example；回滚线索是提示级，
 * 因为 design.md 的「回滚方案」也可以满足要求，由 G3 的设计检查硬约束）。
 */
export function checkRiskDoc(doc: RiskDoc | null, profile: LevelProfile): CheckOutcome[] {
  if (!doc || doc.entries.length === 0) return emptyDocOutcome(profile)
  const entries = doc.entries
  const outcomes: CheckOutcome[] = []

  outcomes.push(checkOutcome({ item: 'risk.doc', label: '风险登记存在', passed: true }))

  // 1) 五类齐全
  const byCategory = new Map<RiskCategory, RiskEntry[]>()
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? []
    list.push(entry)
    byCategory.set(entry.category, list)
  }
  const missing = ALL_CATEGORIES.filter((category) => !byCategory.has(category))
  const duplicated = ALL_CATEGORIES.filter((category) => (byCategory.get(category)?.length ?? 0) > 1)
  outcomes.push(
    checkOutcome({
      item: 'risk.categories',
      label: '风险五大类齐全',
      passed: missing.length === 0 && duplicated.length === 0,
      hint: '风险登记必须覆盖安全、性能、成本、合规、可维护性五类；某一类没有风险也要写「等级：无」并说明理由。',
      example: REQUIRED_RISK_EXAMPLE,
      details: [
        ...missing.map((category) => `缺少类别：${CATEGORY_LABELS[category]}`),
        ...duplicated.map((category) => `类别重复：${CATEGORY_LABELS[category]}`),
      ],
    }),
  )

  // 2) 每类都要写理由（等级为「无」也一样）
  const noReason = entries.filter((entry) => isBlank(entry.reason))
  outcomes.push(
    checkOutcome({
      item: 'risk.reason',
      label: '每类都写明理由',
      passed: noReason.length === 0,
      hint: '每个类别都要写「为什么是这个等级」；等级为「无」也要写一句理由（例如「不新增外部调用」）。',
      details: noReason.map((entry) => `缺少理由：${entryLabel(entry)}`),
    }),
  )

  // 3) 非「无」等级必须有缓解措施与验证方式
  const needsDetail = entries.filter((entry) => entry.grade !== 'none')
  const noMitigation = needsDetail.filter((entry) => isBlank(entry.mitigation))
  const noVerification = needsDetail.filter((entry) => isBlank(entry.verification))
  outcomes.push(
    checkOutcome({
      item: 'risk.mitigation',
      label: '非「无」风险有缓解措施',
      passed: noMitigation.length === 0,
      hint: '等级不是「无」的风险项要写缓解措施；高风险项还应说明回滚/降级方案（或写在 design.md 的回滚方案里）。',
      details: noMitigation.map((entry) => `缺少缓解措施：${entryLabel(entry)}`),
    }),
  )
  outcomes.push(
    checkOutcome({
      item: 'risk.verification',
      label: '非「无」风险有验证方式',
      passed: noVerification.length === 0,
      hint: '等级不是「无」的风险项要写验证方式（对应的场景测试、压测、审查检查等）。',
      details: noVerification.map((entry) => `缺少验证方式：${entryLabel(entry)}`),
    }),
  )

  // 4) 高风险项必须标记需人工接管
  const highRisk = entries.filter((entry) => entry.grade === 'high')
  const missingHuman = highRisk.filter((entry) => !entry.needsHuman)
  if (highRisk.length > 0) {
    outcomes.push(
      checkOutcome({
        item: 'risk.high.human',
        label: '高风险项标记「需人工接管」',
        passed: missingHuman.length === 0,
        hint: '高风险项必须在 G3（低复杂度时为方案确认卡）由负责人逐项确认，把「需人工接管」标为「是」。',
        details: missingHuman.map((entry) => `未标人工接管：${entryLabel(entry)}`),
      }),
    )

    // 5) 回滚方案线索：risk.md 缓解措施里没写、也可能是 design.md 的回滚方案覆盖，
    //    所以这里只给提示，不直接判失败。
    const hasClue = highRisk.some(
      (entry) => ROLLBACK_CLUE.test(entry.mitigation) || ROLLBACK_CLUE.test(entry.verification),
    )
    outcomes.push(
      checkOutcome({
        item: 'risk.high.rollback',
        label: '高风险回滚方案线索',
        passed: true,
        hint: hasClue
          ? undefined
          : '未在风险登记的缓解措施里看到回滚线索。高风险变更必须有回滚方案：写在 design.md 的「回滚方案」一节，或在 risk.md 的缓解措施里写明回滚/降级/关闭开关的步骤。',
      }),
    )
  }

  return outcomes
}

function naturalCompare(a: string, b: string): number {
  const matchA = /^([A-Za-z]+)-?(\d+)$/.exec(a)
  const matchB = /^([A-Za-z]+)-?(\d+)$/.exec(b)
  if (matchA && matchB) {
    if (matchA[1] !== matchB[1]) return matchA[1]!.localeCompare(matchB[1]!)
    return Number(matchA[2]) - Number(matchB[2])
  }
  return a.localeCompare(b)
}

/**
 * 风险提高后的失效效果（FR-6.6 / 03 §3.8）：
 * - `refreezeReviews`：已完成任务（status=done）的审查按新标准重新要求；验证回执保留。
 * - `backToStage`：已进入 S5/S6 的退回 S4；S4 及之前不改变阶段。
 */
export function riskRaisedEffects(change: ChangeStatus): {
  refreezeReviews: string[]
  backToStage?: StageId
} {
  const completed = Object.values(change.tasks)
    .filter((task) => task.status === 'done')
    .map((task) => task.id)
    .sort(naturalCompare)
  const backToStage =
    change.stage === 'S5' || change.stage === 'S6' ? ('S4' as StageId) : undefined
  return backToStage ? { refreezeReviews: completed, backToStage } : { refreezeReviews: completed }
}

/**
 * 命中风险触发器时生成待处理项草稿（kind=risk，编号 RK-n 由 store.nextPendingId 分配）。
 * `actionFingerprint` 让批准只对该次动作单次生效（FR-6.3）。
 */
export function riskTriggerPending(hit: RiskTriggerHit, changeId: string, at: string): PendingDraft {
  const title = hit.title.trim() === '' ? `风险接管：${hit.trigger}` : hit.title
  const detail =
    hit.detail.trim() === ''
      ? `命中风险触发器 ${hit.trigger}，需要负责人确认后才能继续。`
      : hit.detail
  const draft: PendingDraft = {
    kind: 'risk',
    title,
    detail,
    data: { trigger: hit.trigger, decision: hit.decision, changeId, raisedAt: at },
  }
  if (hit.fingerprint !== undefined) draft.actionFingerprint = hit.fingerprint
  return draft
}
