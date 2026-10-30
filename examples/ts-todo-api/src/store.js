import { randomUUID } from 'node:crypto'

/**
 * 内存待办存储。真实项目里这里会是数据库访问层；
 * 基准仓库保持零依赖，用 Map 模拟持久化。
 */
export class TodoStore {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now
    this.items = new Map()
  }

  create({ title, ownerId, createdAt }) {
    const todo = {
      id: randomUUID(),
      title,
      ownerId,
      completed: false,
      createdAt: createdAt ?? this.now(),
      updatedAt: null,
    }
    this.items.set(todo.id, todo)
    return todo
  }

  get(id) {
    return this.items.get(id)
  }

  list(filter = {}) {
    let todos = [...this.items.values()]
    if (filter.ownerId) todos = todos.filter((todo) => todo.ownerId === filter.ownerId)
    if (typeof filter.completed === 'boolean') {
      todos = todos.filter((todo) => todo.completed === filter.completed)
    }
    return todos
  }

  update(id, patch) {
    const todo = this.items.get(id)
    if (!todo) return undefined
    const next = { ...todo, ...patch, id: todo.id, updatedAt: this.now() }
    this.items.set(id, next)
    return next
  }

  remove(id) {
    return this.items.delete(id)
  }
}

/** 插入一批待办，保留传入顺序，便于测试构造稳定数据。 */
export function seedTodos(store, titles, ownerId = 'user-1', createdAt = '2026-01-01T00:00:00.000Z') {
  return titles.map((title, index) =>
    store.create({ title, ownerId, createdAt: `${createdAt}#${String(index).padStart(3, '0')}` })
  )
}
