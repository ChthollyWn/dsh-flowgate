/**
 * 低复杂度方案确认卡（G1 与 G3 合并，03 §3.4）。
 *
 * 内容由 core 产物推导（proposal/design/spec/tasks/risk），engine 只负责状态；
 * 面板（client）与命令 /flow approve 共用本模块渲染的纯数据/文本。
 */
import type { EngineLike } from '../types.js'
import type { GatePanel } from '../projection/types.js'

export interface MergedConfirmCard {
  goal: string
  acceptance: string[]
  scope: string[]
  verify: string
  risks?: { title: string; mitigation: string }[]
  /** 回滚方案（低复杂度 · 高风险时必须在卡片上展示并逐项确认）。 */
  rollback?: string
  /** true 时批准必须显式确认风险项（/flow approve G3 --confirm-risks）。 */
  requireConfirmation?: boolean
}

/** 从引擎缓存产物构建确认卡；数据不足时返回 undefined。 */
export function buildMergedConfirm(engine: EngineLike): MergedConfirmCard | undefined {
  const change = engine.currentChange()
  const artifacts = engine.getArtifacts()
  const spec = artifacts.spec
  const proposal = artifacts.proposal
  const tasks = engine.getTasks()
  const acceptance = (spec?.scenarios ?? []).map((scenario) => `${scenario.id} ${scenario.title}`)
  const scope = [...new Set(tasks.flatMap((task) => [...task.scope, ...task.newFiles]))].sort()
  const verifyCommands = [...new Set(tasks.flatMap((task) => task.verify.map((group) => group.command)))]
  const goal = proposal?.what?.trim() || change?.title || ''
  if (goal === '' && acceptance.length === 0 && scope.length === 0) return undefined
  const risks = (artifacts.risk?.entries ?? [])
    .filter((entry) => entry.grade !== 'none')
    .map((entry) => ({ title: `${entry.category}：${entry.reason}`, mitigation: entry.mitigation }))
  const rollbackFromDesign = (artifacts.design?.rollback ?? '').trim()
  const rollbackFromRisk = risks
    .filter((risk) => risk.mitigation.trim() !== '')
    .map((risk) => `${risk.title} → ${risk.mitigation}`)
    .join('；')
  const rollback = rollbackFromDesign !== '' ? rollbackFromDesign : rollbackFromRisk
  const highRisk = change?.risk === 'high'
  return {
    goal,
    acceptance,
    scope,
    verify: verifyCommands.join('；'),
    risks: risks.length > 0 ? risks : undefined,
    rollback: rollback !== '' || highRisk ? rollback || '（尚未填写回滚方案）' : undefined,
    requireConfirmation: highRisk,
  }
}

/** 把确认卡转成 GatePanel.mergedConfirm 形状（client 契约）。 */
export function toGatePanelConfirm(card: MergedConfirmCard): NonNullable<GatePanel['mergedConfirm']> {
  return {
    goal: card.goal,
    acceptance: card.acceptance,
    scope: card.scope,
    verify: card.verify,
    risks: card.risks,
    rollback: card.rollback,
    requireConfirmation: card.requireConfirmation,
  }
}

/** 渲染成人类可读的纯文本确认卡（与面板/输入区授权卡片同源数据）。 */
export function renderConfirmCardText(card: MergedConfirmCard): string {
  const lines: string[] = ['方案确认卡（低复杂度：批准后同时通过 G1 与 G3）', `目标：${card.goal || '（未填写）'}`]
  if (card.acceptance.length > 0) lines.push(`验收场景：\n${card.acceptance.map((item) => `  - ${item}`).join('\n')}`)
  if (card.scope.length > 0) {
    const shown = card.scope.slice(0, 20)
    lines.push(`改动范围：${shown.join('、')}${card.scope.length > shown.length ? ` 等 ${card.scope.length} 个文件` : ''}`)
  }
  lines.push(`验证命令：${card.verify || '（未填写）'}`)
  if (card.risks && card.risks.length > 0) {
    lines.push(`风险与缓解：\n${card.risks.map((risk) => `  - ${risk.title} → ${risk.mitigation}`).join('\n')}`)
  }
  if (card.rollback !== undefined) lines.push(`回滚方案：${card.rollback}`)
  lines.push(
    card.requireConfirmation === true
      ? '处理：高风险需逐项确认：在授权卡片上点「确认并推进」逐项确认风险与回滚方案，或退回（需写理由）。'
      : '处理：在授权卡片上点「确认并推进」批准（同时通过 G1），或退回（需写理由）。',
  )
  return lines.join('\n')
}
