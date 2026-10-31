import { describe, expect, it } from 'vitest'

import {
  MISFIRE_MIN_SAMPLES,
  MISFIRE_RATE_TARGET,
  ruleMisfireRate,
  shouldDowngradeRule,
} from '../../../src/core/rules/misfire'

describe('M-5 误判率规则降级', () => {
  it('误判率 = misjudged / interceptions；无拦截返回 null', () => {
    expect(ruleMisfireRate(undefined)).toBeNull()
    expect(ruleMisfireRate({ interceptions: 0, misjudged: 0 })).toBeNull()
    expect(ruleMisfireRate({ interceptions: 20, misjudged: 2 })).toBe(0.1)
  })

  it('仅当样本达标且严格超过 5% 时降级', () => {
    expect(MISFIRE_RATE_TARGET).toBe(0.05)
    expect(shouldDowngradeRule(undefined)).toBe(false)
    // 样本不足：即使 100% 误判也不降级。
    expect(shouldDowngradeRule({ interceptions: MISFIRE_MIN_SAMPLES - 1, misjudged: 99 })).toBe(false)
    // 恰好 5% 不算超过。
    expect(shouldDowngradeRule({ interceptions: 20, misjudged: 1 })).toBe(false)
    expect(shouldDowngradeRule({ interceptions: 20, misjudged: 2 })).toBe(true)
    expect(shouldDowngradeRule({ interceptions: 40, misjudged: 3 })).toBe(true)
  })
})
