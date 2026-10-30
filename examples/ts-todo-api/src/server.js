import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { TodoStore } from './store.js'
import { buildPage } from './pagination.js'
import { summary } from './reports/legacy-summary.js'
import { dueReminders } from './notifications/reminders.js'
import { seedUsers } from './auth/users.js'
import { needsRehash, verifyPassword } from './auth/passwords.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new HttpError(413, '请求体过大', 'body 不超过 64KB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', '发送 content-type: application/json 的 JSON 对象')
  }
}

export class HttpError extends Error {
  constructor(status, error, hint) {
    super(error)
    this.status = status
    this.hint = hint
  }
}

function validateTodoInput(body) {
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    throw new HttpError(400, 'title 不能为空', '传入 1–200 字符的 title')
  }
  if (body.title.trim().length > 200) {
    throw new HttpError(400, 'title 过长', 'title 不超过 200 字符')
  }
  if (typeof body.ownerId !== 'string' || body.ownerId.trim().length === 0) {
    throw new HttpError(400, 'ownerId 不能为空', '传入创建者 id，例如 user-1')
  }
}

/**
 * 创建请求处理器。测试直接调用它并在临时端口上监听；
 * `node src/server.js` 启动演示服务。
 */
export function createApp(store = new TodoStore(), users = seedUsers()) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok' })
      }

      if (req.method === 'GET' && url.pathname === '/todos') {
        const todos = store.list({
          ownerId: url.searchParams.get('ownerId') ?? undefined,
          completed: url.searchParams.has('completed') ? url.searchParams.get('completed') === 'true' : undefined,
        })
        const page = buildPage(todos, url.searchParams.get('page'), url.searchParams.get('pageSize'))
        return send(res, 200, page)
      }

      if (req.method === 'POST' && url.pathname === '/todos') {
        const body = await readJson(req)
        validateTodoInput(body)
        const todo = store.create({ title: body.title.trim(), ownerId: body.ownerId.trim() })
        return send(res, 201, { todo })
      }

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const body = await readJson(req)
        const user = typeof body.email === 'string' ? users.findByEmail(body.email) : undefined
        if (!user || typeof body.password !== 'string' || !verifyPassword(body.password, user.passwordHash)) {
          return send(res, 401, { error: '邮箱或密码错误', hint: '检查 email / password；错误信息不区分具体哪一项' })
        }
        // 旧参数哈希在登录成功后自动迁移到当前参数（基准任务 R3 的隐藏要求）。
        if (needsRehash(user.passwordHash)) {
          const { hashPassword } = await import('./auth/passwords.js')
          users.replaceHash(user.id, hashPassword(body.password))
        }
        return send(res, 200, { user: { id: user.id, email: user.email, displayName: user.displayName } })
      }

      if (parts[0] === 'todos' && parts[1] && parts.length === 2) {
        const todo = store.get(parts[1])
        if (!todo) return send(res, 404, { error: '待办不存在', hint: '确认 id 是否正确' })

        if (req.method === 'GET') return send(res, 200, { todo })

        if (req.method === 'PATCH') {
          const body = await readJson(req)
          if (typeof body.completed !== 'boolean') {
            return send(res, 400, { error: 'completed 必须是布尔值', hint: '传入 { "completed": true }' })
          }
          return send(res, 200, { todo: store.update(parts[1], { completed: body.completed }) })
        }

        if (req.method === 'DELETE') {
          store.remove(parts[1])
          return send(res, 204, {})
        }
      }

      if (req.method === 'GET' && url.pathname === '/reports/summary') {
        return send(res, 200, summary(store.list({ ownerId: url.searchParams.get('ownerId') ?? undefined })))
      }

      if (req.method === 'GET' && url.pathname === '/reminders/due') {
        const now = url.searchParams.get('now') ? new Date(url.searchParams.get('now')) : new Date()
        return send(res, 200, { reminders: dueReminders(store.list(), now) })
      }

      return send(res, 404, { error: '路由不存在', hint: `${req.method} ${url.pathname} 未定义` })
    } catch (error) {
      if (error instanceof HttpError) {
        return send(res, error.status, { error: error.message, hint: error.hint })
      }
      return send(res, 500, { error: '内部错误', hint: '查看服务端日志' })
    }
  }
}

export function createServer(store = new TodoStore(), users = seedUsers()) {
  return http.createServer(createApp(store, users))
}

function demoStore() {
  const store = new TodoStore()
  const titles = [
    '写周报', '买牛奶', '预约体检', '整理书架', '学习 Node 流',
    '修自行车', '回复邮件', '备份照片', '规划旅行', '读一本书',
  ]
  titles.forEach((title, index) => {
    store.create({ title, ownerId: 'user-1', createdAt: `2026-01-${String(index + 1).padStart(2, '0')}T09:00:00.000Z` })
  })
  return store
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const port = Number(process.env.PORT ?? 3000)
  const server = createServer(demoStore())
  server.listen(port, () => {
    console.log(`ts-todo-api listening on http://127.0.0.1:${port}`)
    console.log('可用接口：GET /health, GET /todos?page=1&pageSize=3, POST /todos, PATCH /todos/:id, POST /auth/login, GET /reports/summary')
  })
}
