import { hashPassword } from './passwords.js'

/**
 * 内存用户表（相邻模块：分享功能必须用到用户校验，但基准任务 R1/R2 不改这里；
 * R3 风险改造只允许增加"登录成功后迁移哈希"的逻辑，不能改变登录语义）。
 */
export class UserStore {
  constructor() {
    this.users = new Map()
  }

  add({ id, email, password, displayName = email }) {
    const user = { id, email, displayName, passwordHash: hashPassword(password) }
    this.users.set(id, user)
    return user
  }

  get(id) {
    return this.users.get(id)
  }

  findByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email)
  }

  replaceHash(id, passwordHash) {
    const user = this.users.get(id)
    if (!user) return undefined
    const next = { ...user, passwordHash }
    this.users.set(id, next)
    return next
  }
}

export function seedUsers() {
  const users = new UserStore()
  users.add({ id: 'user-1', email: 'alice@example.com', password: 'alice-secret', displayName: 'Alice' })
  users.add({ id: 'user-2', email: 'bob@example.com', password: 'bob-secret', displayName: 'Bob' })
  return users
}
