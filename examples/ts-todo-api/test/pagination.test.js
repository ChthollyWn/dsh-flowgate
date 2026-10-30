import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildPage, normalizePaging, sortTodos, paginate, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/pagination.js'

function makeTodos(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `todo-${String(count - index).padStart(3, '0')}`,
    title: `待办 ${index + 1}`,
    createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  }))
}

describe('分页参数', () => {
  test('缺省与非法值回落到默认', () => {
    assert.deepEqual(normalizePaging(undefined, undefined), { page: 1, pageSize: DEFAULT_PAGE_SIZE })
    assert.deepEqual(normalizePaging('-1', '0'), { page: 1, pageSize: DEFAULT_PAGE_SIZE })
    assert.deepEqual(normalizePaging('abc', 'abc'), { page: 1, pageSize: DEFAULT_PAGE_SIZE })
  })

  test('pageSize 有上限', () => {
    assert.equal(normalizePaging('1', '999').pageSize, MAX_PAGE_SIZE)
  })

  test('接受字符串数字', () => {
    assert.deepEqual(normalizePaging('2', '5'), { page: 2, pageSize: 5 })
  })
})

describe('排序', () => {
  test('按 createdAt 倒序', () => {
    const sorted = sortTodos(makeTodos(3))
    assert.deepEqual(
      sorted.map((todo) => todo.createdAt),
      ['2026-01-03T09:00:00.000Z', '2026-01-02T09:00:00.000Z', '2026-01-01T09:00:00.000Z']
    )
  })

  test('不修改原数组', () => {
    const todos = makeTodos(3)
    const before = todos.map((todo) => todo.id)
    sortTodos(todos)
    assert.deepEqual(todos.map((todo) => todo.id), before)
  })
})

describe('分页结果', () => {
  test('第 1 页返回前 pageSize 条与总数', () => {
    const page = buildPage(makeTodos(10), 1, 3)
    assert.equal(page.items.length, 3)
    assert.equal(page.total, 10)
    assert.equal(page.hasNext, true)
  })

  test('第 2 页与第 1 页不重叠', () => {
    const p1 = buildPage(makeTodos(10), 1, 3)
    const p2 = buildPage(makeTodos(10), 2, 3)
    const ids = new Set([...p1.items, ...p2.items].map((todo) => todo.id))
    assert.equal(ids.size, 6)
  })

  test('总数小于一页时 hasNext 为 false', () => {
    const page = buildPage(makeTodos(2), 1, 3)
    assert.equal(page.items.length, 2)
    assert.equal(page.hasNext, false)
  })

  test('空列表返回空页且 total 为 0', () => {
    const page = buildPage([], 1, 3)
    assert.deepEqual(page.items, [])
    assert.equal(page.total, 0)
    assert.equal(page.hasNext, false)
  })

  test('paginate 返回数组（兼容旧调用）', () => {
    const items = paginate(makeTodos(10), 1, 3)
    assert.ok(Array.isArray(items))
    assert.equal(items.length, 3)
  })
})
