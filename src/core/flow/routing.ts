/**
 * 自动流程路由审查（v0.5，03 §7.8 / docs/impl/auto-flow.md）。
 *
 * 模型在 `flow_new_change` 里提交本次需求的规模自评（route / autoApprove /
 * clear / acceptance / scope / verify / risks），这里由宿主做**确定性 auto-review**：
 *  - 复杂、高风险、敏感路径、需求不清晰 → 降级为 full/standard，保留人工门；
 *  - 小而清晰且验证方式明确 → 允许 fast：G1/G3/G6 检查通过后自动通过，不再等人；
 *  - 任何调整都写进 FlowPlan.checks，随变更状态与账本留痕，负责人可在面板复核。
 *
 * 这一层只做策略判定，不写状态、不跑检查；engine 负责持久化与执行。
 */
import type { Complexity, FlowAssessment, FlowPlan, FlowPlanCheck, FlowRoute, RiskLevel } from '../types'
import { validateVerifyCommand } from '../shell'

export interface FlowReviewInput {
  title: string
  summary?: string
  assessment: FlowAssessment
  complexity: Complexity
  risk: RiskLevel
  assessedAt: string
}

/** 敏感信号词：命中即强制人工全流程（不依赖模型自报风险）。 */
const SENSITIVE_SIGNAL =
  /(?:\b(?:auth|login|password|secret|token|payment|security|migration|deploy|ci)\b)|登录|密码|支付|权限|安全|迁移|部署|密钥|数据库/iu

const ROUTE_LABEL: Record<FlowRoute, string> = {
  full: '全流程（人工门）',
  standard: '标准流程（合并 G1+G3 一次确认）',
  fast: '快速流程（检查通过后自动放行，不再等人工确认）',
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '')
}

function routeForComplexity(complexity: Complexity): FlowRoute {
  return complexity === 'high' || complexity === 'ultra' ? 'full' : 'standard'
}

/**
 * 审查模型的流程自评，返回定稿的 FlowPlan。
 *
 * 不抛错：任何不安全/不完整的选择都会被降级并记录原因，创建变更本身不会被静默阻断。
 */
export function reviewFlowAssessment(input: FlowReviewInput): FlowPlan {
  const { assessment, complexity, risk, title } = input
  const summary = input.summary ?? ''
  const proposedRoute = assessment.route ?? routeForComplexity(complexity)
  const proposedAutoApprove = proposedRoute === 'fast' ? assessment.autoApprove !== false : assessment.autoApprove === true
  const acceptance = normalizeStringList(assessment.acceptance)
  const scope = normalizeStringList(assessment.scope)
  const reasons: string[] = normalizeStringList(assessment.reasons)
  const checks: FlowPlanCheck[] = []

  const pass = (id: string, label: string, detail?: string): void => {
    checks.push(detail === undefined ? { id, label, passed: true } : { id, label, passed: true, detail })
  }
  const fail = (id: string, label: string, detail: string): void => {
    checks.push({ id, label, passed: false, detail })
  }

  let route: FlowRoute = proposedRoute
  let autoApprove = proposedAutoApprove
  const downgrade = (to: FlowRoute, id: string, label: string, detail: string): void => {
    if (route !== to) route = to
    if (to !== 'fast') autoApprove = false
    fail(id, label, detail)
    reasons.push(`自动审查：${detail}`)
  }

  // 1) 风险与复杂度硬约束。
  if (risk === 'high') {
    downgrade('full', 'risk', '高风险必须人工确认', '风险等级为高风险：自动流程降级为 full，所有人工门保留。')
  } else {
    pass('risk', '风险等级允许自动流程')
  }
  if (complexity === 'high' || complexity === 'ultra') {
    downgrade('full', 'complexity', '复杂需求必须走全流程', `${complexity} 复杂度：自动流程降级为 full，保留全部人工门。`)
  } else {
    pass('complexity', '复杂度允许自动流程', complexity)
  }

  // 2) 敏感信号：模型自报之外，宿主独立扫描标题/描述/范围。
  const sensitiveText = [title, summary, assessment.goal ?? '', scope.join(' ')].join(' ')
  if (SENSITIVE_SIGNAL.test(sensitiveText)) {
    downgrade('full', 'sensitive', '涉及敏感面必须人工确认', '标题/描述/范围命中敏感信号（认证、支付、权限、迁移、密钥、CI 等）：降级为 full。')
  } else {
    pass('sensitive', '未命中敏感信号')
  }

  // 3) fast：只允许“小、清晰、可验证”的需求。
  if (route === 'fast') {
    if (complexity !== 'low') {
      downgrade('standard', 'fast.complexity', 'fast 只用于低复杂度需求', `fast 要求低复杂度，实际为 ${complexity}：降级为 standard（合并 G1+G3 一次人工确认）。`)
    } else {
      pass('fast.complexity', '低复杂度符合 fast 条件')
    }
  }
  if (route === 'fast') {
    if (assessment.clear !== true) {
      downgrade('standard', 'fast.clear', '需求清晰度未确认', 'fast 需要 clear=true（需求已足够明确）；未声明则降级为 standard。')
    } else {
      pass('fast.clear', '模型确认需求清晰')
    }
  }
  if (route === 'fast') {
    if (acceptance.length < 2) {
      downgrade('standard', 'fast.acceptance', '验收要点不足', `fast 至少需要 2 条可测量的 acceptance，当前 ${acceptance.length} 条：降级为 standard。`)
    } else {
      pass('fast.acceptance', '验收要点充足', `${acceptance.length} 条`)
    }
  }
  if (route === 'fast') {
    const command = (assessment.verify ?? '').trim()
    const commandCheck = command === '' ? { ok: false, reason: '缺少验证命令' } : validateVerifyCommand(command)
    if (!commandCheck.ok) {
      downgrade('standard', 'fast.verify', '验证命令缺失或不合法', `fast 需要合法的 verify 命令（${commandCheck.reason}）：降级为 standard。`)
    } else {
      pass('fast.verify', '验证命令合法', command)
    }
  }
  if (route === 'fast') {
    if (scope.length === 0) {
      downgrade('standard', 'fast.scope', '改动范围未声明', 'fast 需要 scope（预计改动的路径/glob）：降级为 standard。')
    } else if (scope.length > 5) {
      downgrade('standard', 'fast.scope', '改动范围过大', `fast 至多 5 条 scope，当前 ${scope.length} 条：降级为 standard。`)
    } else {
      pass('fast.scope', '改动范围可控', `${scope.length} 条`)
    }
  }
  if (route === 'fast' && !autoApprove) {
    autoApprove = true
    pass('auto', 'fast 路由强制自动放行', 'fast 的定义是无人工门；autoApprove 已置为 true。')
  }

  // 4) 非 fast 路由不允许自动放行。
  if (route !== 'fast' && autoApprove) {
    autoApprove = false
    fail('auto.policy', '非 fast 路由不允许自动放行', `${route} 路由保留人工确认，autoApprove 已置为 false。`)
  } else if (route !== 'fast') {
    pass('auto.policy', '人工确认保留')
  }

  const verdict: FlowPlan['verdict'] =
    route === proposedRoute && autoApprove === proposedAutoApprove ? 'approved' : 'adjusted'
  if (verdict === 'approved') {
    reasons.push(`自动审查通过：${ROUTE_LABEL[route]}${autoApprove ? '，G1/G3/G6 检查通过后自动通过' : ''}。`)
  } else {
    reasons.push(`自动审查调整：模型建议 ${ROUTE_LABEL[proposedRoute]}${proposedAutoApprove ? '（自动放行）' : ''}，定稿 ${ROUTE_LABEL[route]}。`)
  }

  return {
    route,
    proposedRoute,
    autoApprove,
    proposedAutoApprove,
    verdict,
    complexity,
    risk,
    checks,
    reasons: reasons.slice(0, 20),
    assessedAt: input.assessedAt,
    assessedBy: 'auto-review',
  }
}
