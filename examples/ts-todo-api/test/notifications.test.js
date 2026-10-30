import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dueReminders } from '../src/notifications/reminders.js'

const DAY = 24 * 60 * 60 * 1000

describe('提醒模块（相邻模块，基准任务不涉及）', () => {
  test('只提醒未完成且超过 24 小时的条目', () => {
    const now = new Date('2026-02-01T12:00:00.000Z')
    const reminders = dueReminders(
      [
        { id: 'a', ownerId: 'user-1', completed: false, createdAt: new Date(now.getTime() - 2 * DAY).toISOString() },
        { id: 'b', ownerId: 'user-1', completed: true, createdAt: new Date(now.getTime() - 2 * DAY).toISOString() },
        { id: 'c', ownerId: 'user-2', completed: false, createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() },
      ],
      now
    )
    assert.deepEqual(reminders, [{ todoId: 'a', ownerId: 'user-1', reason: '24h 未完成' }])
  })

  test('createdAt 非法的条目被跳过', () => {
    const reminders = dueReminders([{ id: 'x', ownerId: 'u', completed: false, createdAt: 'not-a-date' }])
    assert.deepEqual(reminders, [])
  })
})
