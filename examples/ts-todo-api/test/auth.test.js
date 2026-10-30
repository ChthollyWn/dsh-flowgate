import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../src/server.js'
import { TodoStore } from '../src/store.js'
import { UserStore, seedUsers } from '../src/auth/users.js'
import { hashPassword, needsRehash, verifyPassword, DEFAULT_ITERATIONS } from '../src/auth/passwords.js'

let server
let baseUrl
let users

before(async () => {
  users = seedUsers()
  server = createServer(new TodoStore(), users)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

async function login(body) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe('密码哈希', () => {
  test('哈希格式包含参数，可校验', () => {
    const stored = hashPassword('secret', { salt: 'fixed-salt' })
    assert.match(stored, /^pbkdf2\$sha256\$100000\$fixed-salt\$/)
    assert.equal(verifyPassword('secret', stored), true)
    assert.equal(verifyPassword('wrong', stored), false)
  })

  test('篡改或格式错误的哈希校验失败', () => {
    assert.equal(verifyPassword('secret', 'not-a-hash'), false)
    assert.equal(verifyPassword('secret', 'pbkdf2$sha256$100000$salt$dGFtcGVy'), false)
  })

  test('needsRehash 识别较低迭代次数', () => {
    const old = hashPassword('secret', { iterations: 1000 })
    assert.equal(needsRehash(old), true)
    const current = hashPassword('secret', { iterations: DEFAULT_ITERATIONS })
    assert.equal(needsRehash(current), false)
  })
})

describe('登录接口', () => {
  test('正确邮箱密码返回 200 与用户信息', async () => {
    const res = await login({ email: 'alice@example.com', password: 'alice-secret' })
    assert.equal(res.status, 200)
    assert.equal(res.body.user.id, 'user-1')
    assert.equal(res.body.user.displayName, 'Alice')
    assert.equal('passwordHash' in res.body.user, false)
  })

  test('密码错误返回 401，且不区分具体原因', async () => {
    const wrongPassword = await login({ email: 'alice@example.com', password: 'nope' })
    const unknownEmail = await login({ email: 'nobody@example.com', password: 'nope' })
    assert.equal(wrongPassword.status, 401)
    assert.equal(unknownEmail.status, 401)
    assert.equal(wrongPassword.body.error, unknownEmail.body.error)
  })

  test('旧参数哈希在登录成功后自动迁移到当前参数', async () => {
    const migrationUsers = new UserStore()
    migrationUsers.add({ id: 'user-9', email: 'carol@example.com', password: 'carol-secret' })
    migrationUsers.replaceHash('user-9', hashPassword('carol-secret', { iterations: 1000 }))
    assert.equal(needsRehash(migrationUsers.get('user-9').passwordHash), true)

    const migrationServer = createServer(new TodoStore(), migrationUsers)
    await new Promise((resolve) => migrationServer.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${migrationServer.address().port}/auth/login`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'carol@example.com', password: 'carol-secret' }),
      })
      assert.equal(response.status, 200)
      await response.json()
      assert.equal(needsRehash(migrationUsers.get('user-9').passwordHash), false)
    } finally {
      migrationServer.closeAllConnections()
      await new Promise((resolve) => migrationServer.close(resolve))
    }
  })
})
