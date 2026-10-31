import { describe, expect, it } from 'vitest'

import { reviewFlowAssessment } from '../../../src/core/flow/routing'
import type { FlowAssessment } from '../../../src/core/types'

const NOW = '2026-11-01T00:00:00+08:00'

function review(assessment: FlowAssessment, overrides: { complexity?: 'low' | 'medium' | 'high' | 'ultra'; risk?: 'normal' | 'high'; title?: string } = {}) {
  return reviewFlowAssessment({
    title: overrides.title ?? '给待办列表增加分享链接',
    summary: '生成只读分享链接，拿到链接的人查看同一份待办。',
    assessment,
    complexity: overrides.complexity ?? 'low',
    risk: overrides.risk ?? 'normal',
    assessedAt: NOW,
  })
}

const FAST: FlowAssessment = {
  route: 'fast',
  autoApprove: true,
  clear: true,
  goal: '生成只读分享链接',
  acceptance: ['分享链接可打开同一份待办', '分享页禁止修改'],
  scope: ['src/share/**', 'test/share/**'],
  verify: 'pnpm test',
  reasons: ['需求清晰、范围小'],
}

describe('reviewFlowAssessment：模型自评 + 宿主 auto-review', () => {
  it('低复杂度、清晰、可验证的需求批准 fast 自动流程', () => {
    const plan = review(FAST)
    expect(plan.route).toBe('fast')
    expect(plan.autoApprove).toBe(true)
    expect(plan.verdict).toBe('approved')
    expect(plan.checks.every((check) => check.passed)).toBe(true)
  })

  it('高风险需求强制降级为 full，并关闭自动放行', () => {
    const plan = review(FAST, { risk: 'high' })
    expect(plan.route).toBe('full')
    expect(plan.autoApprove).toBe(false)
    expect(plan.verdict).toBe('adjusted')
    expect(plan.checks.find((check) => check.id === 'risk')?.passed).toBe(false)
  })

  it('高/超高复杂度强制 full', () => {
    for (const complexity of ['high', 'ultra'] as const) {
      const plan = review(FAST, { complexity })
      expect(plan.route).toBe('full')
      expect(plan.autoApprove).toBe(false)
    }
  })

  it('命中敏感信号（支付/权限/迁移等）即使模型自报普通风险也强制 full', () => {
    const plan = review(
      { ...FAST, clear: true, scope: ['src/payment/**'], reasons: ['普通改动'] },
      { risk: 'normal', title: '续费支付回调幂等' },
    )
    expect(plan.route).toBe('full')
    expect(plan.autoApprove).toBe(false)
    expect(plan.checks.find((check) => check.id === 'sensitive')?.passed).toBe(false)
  })

  it('fast 缺少验收/验证命令/范围时降级为 standard（保留一次人工确认）', () => {
    const noAcceptance = review({ ...FAST, acceptance: ['只有一个验收点'] })
    expect(noAcceptance.route).toBe('standard')
    expect(noAcceptance.autoApprove).toBe(false)
    expect(noAcceptance.verdict).toBe('adjusted')

    const noVerify = review({ ...FAST, verify: '' })
    expect(noVerify.route).toBe('standard')

    const noScope = review({ ...FAST, scope: [] })
    expect(noScope.route).toBe('standard')
  })

  it('中等复杂度不允许 fast，降级为 standard', () => {
    const plan = review(FAST, { complexity: 'medium' })
    expect(plan.route).toBe('standard')
    expect(plan.autoApprove).toBe(false)
  })

  it('standard / full 不允许 autoApprove', () => {
    expect(review({ route: 'standard', autoApprove: true }).autoApprove).toBe(false)
    expect(review({ route: 'full', autoApprove: true }).autoApprove).toBe(false)
  })

  it('省略 route 时按复杂度推导（low/medium → standard，high → full）', () => {
    expect(review({}, { complexity: 'low' }).route).toBe('standard')
    expect(review({}, { complexity: 'medium' }).route).toBe('standard')
    expect(review({}, { complexity: 'high' }).route).toBe('full')
  })
})
