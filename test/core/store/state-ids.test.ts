import { describe, expect, it } from 'vitest'
import { nextChangeId, nextPendingId } from '../../../src/core/store'
import { makeChange, makePending } from './fixtures'

describe('nextChangeId', () => {
  it('空列表从 C-001 / A-001 开始，三位补零', () => {
    expect(nextChangeId([], 'change')).toBe('C-001')
    expect(nextChangeId([], 'analysis')).toBe('A-001')
  })

  it('取同前缀最大序号 +1（跳过空号不回收）', () => {
    const changes = [
      makeChange({ id: 'C-001' }),
      makeChange({ id: 'C-003' }),
      makeChange({ id: 'C-007' }),
      makeChange({ id: 'A-004' }),
    ]
    expect(nextChangeId(changes, 'change')).toBe('C-008')
    expect(nextChangeId(changes, 'analysis')).toBe('A-005')
  })

  it('超过 999 后自然增长不截断', () => {
    expect(nextChangeId([makeChange({ id: 'C-999' })], 'change')).toBe('C-1000')
  })
})

describe('nextPendingId', () => {
  it('按 03 §8.3 使用前缀且不补零', () => {
    expect(nextPendingId([], 'risk')).toBe('RK-1')
    expect(nextPendingId([], 'scope')).toBe('SC-1')
    expect(nextPendingId([], 'plan')).toBe('PC-1')
    expect(nextPendingId([], 'rule')).toBe('RL-1')
    expect(nextPendingId([], 'override')).toBe('OV-1')
    expect(nextPendingId([], 'exception')).toBe('EX-1')
    expect(nextPendingId([], 'conflict')).toBe('CF-1')
    expect(nextPendingId([], 'blocker')).toBe('BL-1')
  })

  it('只看同类前缀，取最大序号 +1', () => {
    const pending = [makePending('RK-2'), makePending('RK-5', 'risk'), makePending('SC-9', 'scope')]
    expect(nextPendingId(pending, 'risk')).toBe('RK-6')
    expect(nextPendingId(pending, 'scope')).toBe('SC-10')
  })

  it('knownIds 参与取最大序号，避免跨变更重复', () => {
    const pending = [makePending('RK-1')]
    expect(nextPendingId(pending, 'risk', ['RK-7', 'SC-3', 'garbage'])).toBe('RK-8')
  })
})
