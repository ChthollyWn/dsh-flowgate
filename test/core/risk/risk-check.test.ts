import { describe, expect, it } from 'vitest'
import { checkRiskDoc } from '../../../src/core/risk'
import { doc, entry, profile, validEntries } from './fixtures'

function outcomeOf(outcomes: ReturnType<typeof checkRiskDoc>, item: string) {
  return outcomes.find((outcome) => outcome.item === item)
}

describe('checkRiskDoc', () => {
  it('缺少 risk.md 时失败并给出五类与示例', () => {
    const outcomes = checkRiskDoc(null, profile())
    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    expect(outcome.item).toBe('risk.doc')
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('risk.md')
    expect(outcome.hint).toContain('五类')
    expect(outcome.example).toContain('需人工接管')
  })

  it('低复杂度普通风险免填：null 也通过并解释', () => {
    const outcomes = checkRiskDoc(null, profile({ complexity: 'low', requiresRiskDoc: false }))
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.passed).toBe(true)
    expect(outcomes[0]!.hint).toContain('触发器')
  })

  it('低复杂度但高风险仍必须填写', () => {
    const outcomes = checkRiskDoc(null, profile({ complexity: 'low', risk: 'high', requiresRiskDoc: false }))
    expect(outcomes[0]!.passed).toBe(false)
  })

  it('空风险登记按缺失处理', () => {
    const outcomes = checkRiskDoc(doc([]), profile())
    expect(outcomes[0]!.item).toBe('risk.doc')
    expect(outcomes[0]!.passed).toBe(false)
  })

  it('五类齐全时通过', () => {
    const outcomes = checkRiskDoc(doc(validEntries), profile())
    expect(outcomeOf(outcomes, 'risk.doc')?.passed).toBe(true)
    expect(outcomeOf(outcomes, 'risk.categories')?.passed).toBe(true)
    expect(outcomeOf(outcomes, 'risk.reason')?.passed).toBe(true)
    expect(outcomeOf(outcomes, 'risk.mitigation')?.passed).toBe(true)
    expect(outcomeOf(outcomes, 'risk.verification')?.passed).toBe(true)
    expect(outcomeOf(outcomes, 'risk.high.human')?.passed).toBe(true)
    expect(outcomes.every((outcome) => outcome.passed)).toBe(true)
  })

  it('缺少类别时列出缺失项', () => {
    const entries = validEntries.filter((item) => item.category !== 'performance' && item.category !== 'cost')
    const categories = outcomeOf(checkRiskDoc(doc(entries), profile()), 'risk.categories')!
    expect(categories.passed).toBe(false)
    expect(categories.details).toEqual(['缺少类别：性能', '缺少类别：成本'])
    expect(categories.hint).toContain('五类')
  })

  it('重复类别判失败', () => {
    const outcomes = [
      ...validEntries,
      entry('security', 'low', '重复登记', '无', '无'),
    ]
    const categories = outcomeOf(checkRiskDoc(doc(outcomes), profile()), 'risk.categories')!
    expect(categories.passed).toBe(false)
    expect(categories.details).toContain('类别重复：安全')
  })

  it('等级为「无」也必须写理由', () => {
    const entries = validEntries.map((item) => (item.category === 'cost' ? entry('cost', 'none', ' ') : item))
    const reason = outcomeOf(checkRiskDoc(doc(entries), profile()), 'risk.reason')!
    expect(reason.passed).toBe(false)
    expect(reason.details).toContain('缺少理由：成本（无）')
  })

  it('非「无」等级缺缓解措施/验证方式时失败', () => {
    const entries = validEntries.map((item) =>
      item.category === 'compliance' ? entry('compliance', 'medium', '含手机号', '—', '审查检查') : item,
    )
    const outcomes = checkRiskDoc(doc(entries), profile())
    expect(outcomeOf(outcomes, 'risk.mitigation')?.passed).toBe(false)
    expect(outcomeOf(outcomes, 'risk.mitigation')?.details).toEqual(['缺少缓解措施：合规（中）'])

    const noVerify = validEntries.map((item) =>
      item.category === 'performance' ? entry('performance', 'low', '多一次查询', '加唯一索引', ' ') : item,
    )
    expect(outcomeOf(checkRiskDoc(doc(noVerify), profile()), 'risk.verification')?.passed).toBe(false)
  })

  it('高风险项未标「需人工接管」时失败', () => {
    const entries = validEntries.map((item) => (item.category === 'security' ? { ...item, needsHuman: false } : item))
    const human = outcomeOf(checkRiskDoc(doc(entries), profile()), 'risk.high.human')!
    expect(human.passed).toBe(false)
    expect(human.details).toContain('未标人工接管：安全（高）')
  })

  it('高风险缓解措施缺回滚线索时给出提示（不判失败）', () => {
    const entries = validEntries.map((item) =>
      item.category === 'security'
        ? entry('security', 'high', '回调验签', '重启服务', '场景测试', true)
        : item,
    )
    const rollback = outcomeOf(checkRiskDoc(doc(entries), profile()), 'risk.high.rollback')!
    expect(rollback.passed).toBe(true)
    expect(rollback.hint).toContain('回滚')
  })

  it('高风险有回滚线索时不提示', () => {
    const rollback = outcomeOf(checkRiskDoc(doc(validEntries), profile()), 'risk.high.rollback')!
    expect(rollback.passed).toBe(true)
    expect(rollback.hint).toBeUndefined()
  })

  it('没有高风险项时不产生人工接管/回滚检查项', () => {
    const entries = validEntries.map((item) =>
      item.category === 'security' ? entry('security', 'medium', '回调验签', '复用验签器', '场景测试') : item,
    )
    const outcomes = checkRiskDoc(doc(entries), profile())
    expect(outcomeOf(outcomes, 'risk.high.human')).toBeUndefined()
    expect(outcomeOf(outcomes, 'risk.high.rollback')).toBeUndefined()
  })
})
