import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../src/server.js'
import { TodoStore } from '../src/store.js'

let server
let baseUrl
let store

function freshStore() {
  const store = new TodoStore()
  const titles = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
  titles.forEach((title, index) => {
    store.create({ title, ownerId: 'user-1', createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z` })
  })
  return store
}

before(async () => {
  store = freshStore()
  server = createServer(store)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe('健康检查', () => {
  test('GET /health 返回 200 与 ok', async () => {
    const res = await request('/health')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { status: 'ok' })
  })
})

describe('待办列表与分页', () => {
  test('默认返回第 1 页 3 条，total 为 10', async () => {
    const res = await request('/todos')
    assert.equal(res.status, 200)
    assert.equal(res.body.page, 1)
    assert.equal(res.body.pageSize, 3)
    assert.equal(res.body.total, 10)
    assert.equal(res.body.items.length, 3)
    assert.equal(res.body.hasNext, true)
  })

  test('第 2 页接在第 1 页之后，不重复', async () => {
    const p1 = await request('/todos?page=1&pageSize=3')
    const p2 = await request('/todos?page=2&pageSize=3')
    const ids1 = p1.body.items.map((todo) => todo.id)
    const ids2 = p2.body.items.map((todo) => todo.id)
    assert.equal(new Set([...ids1, ...ids2]).size, 6)
  })

  test('非法分页参数回落到默认值', async () => {
    const res = await request('/todos?page=0&pageSize=999')
    assert.equal(res.status, 200)
    assert.equal(res.body.page, 1)
    assert.equal(res.body.pageSize, 10)
  })

  test('按完成状态过滤', async () => {
    const created = await request('/todos', {
      method: 'POST',
      body: JSON.stringify({ title: '已完成项', ownerId: 'user-1' }),
    })
    await request(`/todos/${created.body.todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
    })
    const done = await request('/todos?completed=true')
    assert.equal(done.body.items.every((todo) => todo.completed === true), true)
    assert.ok(done.body.total >= 1)
  })
})

describe('创建与更新', () => {
  test('创建返回 201 与生成的 id', async () => {
    const res = await request('/todos', {
      method: 'POST',
      body: JSON.stringify({ title: '新待办', ownerId: 'user-2' }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.todo.title, '新待办')
    assert.equal(res.body.todo.completed, false)
    assert.ok(res.body.todo.id)
  })

  test('title 为空返回 400 与 hint', async () => {
    const res = await request('/todos', {
      method: 'POST',
      body: JSON.stringify({ title: '   ', ownerId: 'user-1' }),
    })
    assert.equal(res.status, 400)
    assert.match(res.body.hint, /title/)
  })

  test('更新完成状态返回 200', async () => {
    const created = await request('/todos', {
      method: 'POST',
      body: JSON.stringify({ title: '要更新', ownerId: 'user-1' }),
    })
    const res = await request(`/todos/${created.body.todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.todo.completed, true)
  })

  test('更新不存在的待办返回 404', async () => {
    const res = await request('/todos/not-exist', {
      method: 'PATCH',
      body: JSON.stringify({ completed: true }),
    })
    assert.equal(res.status, 404)
    assert.match(res.body.hint, /id/)
  })

  test('completed 非布尔返回 400', async () => {
    const created = await request('/todos', {
      method: 'POST',
      body: JSON.stringify({ title: '类型错误', ownerId: 'user-1' }),
    })
    const res = await request(`/todos/${created.body.todo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: 'yes' }),
    })
    assert.equal(res.status, 400)
  })
})

describe('错误处理', () => {
  test('未知路由返回 404', async () => {
    const res = await request('/nope')
    assert.equal(res.status, 404)
    assert.ok(res.body.error)
  })

  test('非法 JSON 返回 400', async () => {
    const response = await fetch(`${baseUrl}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(response.status, 400)
  })
})
