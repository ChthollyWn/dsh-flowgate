/**
 * 基准任务 R2（修 bug）的验收测试。
 *
 * 这个文件刻意不在 `pnpm test` 的默认列表里：默认测试全绿，
 * 而这里演示"分页最后一页重复"这个真实缺陷。运行：
 *
 *   node --test test/known-bugs.mjs   （或 pnpm test:bug）
 *
 * 期望：修复 R2 后本文件全绿；修复前会失败 4 项。
 * 这些断言同时覆盖了 README"隐藏需求清单"里的稳定排序与越界页要求。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildPage, sortTodos } from '../src/pagination.js'

function makeTodos(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `todo-${String(index + 1).padStart(3, '0')}`,
    title: `待办 ${index + 1}`,
    createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  }))
}

describe('R2：分页最后一页重复（当前已知缺陷）', () => {
  test('遍历全部页：每条待办恰好出现一次，不重复不遗漏', () => {
    const todos = makeTodos(10)
    const ids = []
    for (let page = 1; page <= 4; page += 1) {
      ids.push(...buildPage(todos, page, 3).items.map((todo) => todo.id))
    }
    assert.equal(ids.length, 10, '10 条待办应被 4 页完整覆盖')
    assert.equal(new Set(ids).size, 10, '跨页不应出现重复 id')
  })

  test('最后一页只包含剩余条目（10 条 / 每页 3 条 → 第 4 页仅 1 条）', () => {
    const last = buildPage(makeTodos(10), 4, 3)
    assert.equal(last.items.length, 1)
    // 列表按 createdAt 倒序（最新在前），因此最后一页是**最早**的一条 todo-001。
    // 2026-10-31 修正：原断言写成 todo-010，与排序契约矛盾，正确修复也会被判红。
    assert.deepEqual(last.items.map((todo) => todo.id), ['todo-001'])
    assert.equal(last.hasNext, false)
  })

  test('超过总页数的页码返回空页，total 仍然正确', () => {
    const page = buildPage(makeTodos(10), 5, 3)
    assert.deepEqual(page.items, [])
    assert.equal(page.total, 10)
    assert.equal(page.hasNext, false)
  })

  test('createdAt 相同的条目按 id 升序稳定排序', () => {
    const same = '2026-03-01T00:00:00.000Z'
    const sorted = sortTodos([
      { id: 'todo-b', createdAt: same },
      { id: 'todo-a', createdAt: same },
      { id: 'todo-c', createdAt: same },
    ])
    assert.deepEqual(sorted.map((todo) => todo.id), ['todo-a', 'todo-b', 'todo-c'])
  })
})
