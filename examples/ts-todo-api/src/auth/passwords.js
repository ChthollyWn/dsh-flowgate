import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 密码哈希（PBKDF2-SHA256，格式自带参数，便于以后升级迭代次数）。
 *
 * 基准任务 R3（风险改造）会要求把迭代次数从 100000 提到 600000，
 * 并保证旧哈希仍能登录、登录成功后自动迁移。注意这是一个安全敏感路径。
 */
export const DEFAULT_ITERATIONS = 100_000
const KEY_LENGTH = 32
const DIGEST = 'sha256'

export function hashPassword(password, { iterations = DEFAULT_ITERATIONS, salt = randomBytes(16).toString('base64url') } = {}) {
  const derived = pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST).toString('base64url')
  return `pbkdf2$${DIGEST}$${iterations}$${salt}$${derived}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$')
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false
  const [, digest, iterationsRaw, salt, expected] = parts
  const iterations = Number.parseInt(iterationsRaw, 10)
  if (!Number.isFinite(iterations) || iterations <= 0) return false
  const actual = pbkdf2Sync(password, salt, iterations, KEY_LENGTH, digest).toString('base64url')
  const expectedBuffer = Buffer.from(expected, 'base64url')
  const actualBuffer = Buffer.from(actual, 'base64url')
  if (expectedBuffer.length !== actualBuffer.length) return false
  return timingSafeEqual(expectedBuffer, actualBuffer)
}

export function needsRehash(stored, iterations = DEFAULT_ITERATIONS) {
  const parts = String(stored).split('$')
  if (parts.length !== 5) return true
  return Number.parseInt(parts[2], 10) < iterations
}
