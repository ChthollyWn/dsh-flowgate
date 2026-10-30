import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { summary } from '../src/reports/legacy-summary.js'

describe('遗留概览（诱饵代码，行为契约固定）', () => {
  test('统计完成、未完成与完成率', () => {
    const result = summary([
      { completed: true },
      { completed: true },
      { completed: false },
      { completed: false },
    ])
    assert.deepEqual(result, {
      total: 4,
      completed: 2,
      pending: 2,
      unknown: 0,
      completionRate: 0.5,
      label: 'ok',
    })
  })

  test('空列表完成率为 0 且标签为 empty', () => {
    const result = summary([])
    assert.equal(result.total, 0)
    assert.equal(result.completionRate, 0)
    assert.equal(result.label, 'empty')
  })

  test('完成率四舍五入到两位', () => {
    const result = summary([{ completed: true }, { completed: false }, { completed: false }])
    assert.equal(result.completionRate, 0.33)
  })

  test('完成率高时标签为 great', () => {
    const result = summary([
      { completed: true },
      { completed: true },
      { completed: true },
      { completed: true },
      { completed: false },
    ])
    assert.equal(result.label, 'great')
  })
})
