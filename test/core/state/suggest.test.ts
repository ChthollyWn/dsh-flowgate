import { describe, expect, it } from 'vitest'
import { suggestLevels } from '../../../src/core/state/suggest'
import { makeConfig } from './fixtures'

describe('state/suggest — FR-6.5 复杂度与风险建议', () => {
  it('copy-only change: low complexity, normal risk', () => {
    const suggestion = suggestLevels({
      title: '把首页按钮文案"立即购买"改成"马上抢购"',
      summary: '只改中文和英文两处文案',
      paths: ['src/pages/Home.tsx', 'src/locales/zh-CN.json'],
    })
    expect(suggestion.complexity).toBe('low')
    expect(suggestion.risk).toBe('normal')
    expect(suggestion.reasons.complexity.length).toBeGreaterThan(0)
    expect(suggestion.reasons.risk.length).toBeGreaterThan(0)
  })

  it('payment callback change: high risk, at least medium complexity', () => {
    const suggestion = suggestLevels({
      title: '新增会员续费支付回调接口',
      summary: '验签并保证幂等',
      paths: ['src/main/java/com/acme/payment/RenewalCallback.java'],
    })
    expect(suggestion.risk).toBe('high')
    expect(suggestion.complexity).not.toBe('low')
    expect(suggestion.reasons.risk.join('')).toMatch(/支付|敏感路径/)
  })

  it('refactor across modules: high or ultra complexity', () => {
    const suggestion = suggestLevels({
      title: '重构订单模块，跨模块迁移到新架构',
      paths: [
        'src/order/a.ts',
        'src/order/b.ts',
        'src/payment/c.ts',
        'src/inventory/d.ts',
        'src/notify/e.ts',
      ],
      modules: ['order', 'payment', 'inventory', 'notify'],
    })
    expect(['high', 'ultra']).toContain(suggestion.complexity)
  })

  it('from-scratch platform work suggests ultra complexity', () => {
    const suggestion = suggestLevels({ title: '从零搭建全新平台，全面重做旧系统' })
    expect(suggestion.complexity).toBe('ultra')
  })

  it('module count raises complexity monotonically', () => {
    const small = suggestLevels({ title: '实现订单查询', modules: ['order'] })
    const large = suggestLevels({
      title: '实现订单查询',
      modules: ['order', 'payment', 'notify', 'inventory', 'auth'],
    })
    const rank = (value: string): number => ['low', 'medium', 'high', 'ultra'].indexOf(value)
    expect(rank(large.complexity)).toBeGreaterThanOrEqual(rank(small.complexity))
  })

  it('sensitive path in config triggers high risk with the pattern as reason', () => {
    const config = makeConfig({
      triggers: {
        ...makeConfig().triggers,
        sensitive_paths_extra: ['src/main/java/**/billing/**'],
      },
    })
    const suggestion = suggestLevels({
      title: '调整计费规则',
      paths: ['src/main/java/com/acme/billing/Invoice.java'],
      config,
    })
    expect(suggestion.risk).toBe('high')
    expect(suggestion.reasons.risk.join('')).toMatch(/敏感路径|billing/)
  })

  it('is deterministic: same input yields the same suggestion and sorted unique reasons', () => {
    const input = {
      title: '新增导出功能并重构导出模块',
      summary: '导出 CSV，涉及鉴权',
      paths: ['src/export/a.ts', 'src/export/b.ts', 'src/auth/guard.ts'],
      modules: ['export', 'auth'],
    }
    const first = suggestLevels(input)
    const second = suggestLevels(input)
    expect(second).toEqual(first)
    expect(new Set(first.reasons.complexity).size).toBe(first.reasons.complexity.length)
    expect(new Set(first.reasons.risk).size).toBe(first.reasons.risk.length)
    expect([...first.reasons.complexity]).toEqual([...first.reasons.complexity].sort())
  })

  it('empty signals fall back to low complexity / normal risk with reasons', () => {
    const suggestion = suggestLevels({ title: '修一个边界条件' })
    expect(suggestion.complexity).toBe('low')
    expect(suggestion.risk).toBe('normal')
    expect(suggestion.reasons.complexity.length).toBeGreaterThan(0)
    expect(suggestion.reasons.risk.length).toBeGreaterThan(0)
  })
})
