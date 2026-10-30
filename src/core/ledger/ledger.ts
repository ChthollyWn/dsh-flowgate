/**
 * Append-only audit ledger (`.flowgate/state/ledger.jsonl`).
 *
 * 行格式（每行一个 JSON 对象，字段顺序固定）：
 * `{ seq, at, type, data, prev, mac }`
 *
 * - `seq` 从 1 起逐行递增，必须是连续的整数；行号即 seq（空行不参与编号）。
 * - `at` ISO-8601 时间戳（带时区偏移），可由调用方传入以复用同一批事件的时间。
 * - `data` 事件负载，缺省为 `{}`，必须是可 JSON 序列化的对象。
 * - `prev` 哈希链：首行为常量 {@link GENESIS_PREV}（`'genesis'`），
 *   之后每行为**上一行整行内容**（含上一行 mac 字段）的 sha256 哈希。
 *   这样一行一旦被改动，本行 mac 校验与下一行 prev 校验都会失败。
 * - `mac` = HMAC-SHA256(ledgerKey, 规范化内容)，规范化内容即
 *   {@link contentHash} 的结果 `sha256:<hex>`；`contentHash` 对
 *   `{ seq, at, type, data, prev }` 做键排序后的稳定 JSON 再哈希。
 *
 * 密钥由宿主提供（`EnginePorts.ledgerKey`，来自仓库外的
 * `~/.dsh/flowgate/ledger.key`）；core 不读也不写密钥文件。
 *
 * 只追加：模块不提供改写/删除接口。`readAll()` 对损坏行是容错的（跳过无法
 * 解析的行但仍返回其余行）；`verify()` 才逐行严格校验，报告行号从 1 起，
 * 即使中间某行损坏，后续行也继续校验，最终整体 `ok:false`。
 */
import type { Clock, FileSystem } from '../util/fs'
import type { LedgerEvent, LedgerEventType, LedgerVerification } from '../types'
import { hmacSha256, sha256, stableJson } from '../util/hash'
import { isoNow } from '../util/time'
import { posixDirname } from '../util/paths'

/** 首行 `prev` 的固定常量：表示链的起点。 */
export const GENESIS_PREV = 'genesis'

export interface LedgerEventInput {
  type: LedgerEventType
  data?: Record<string, unknown>
  at?: string
}

export interface Ledger {
  append(input: LedgerEventInput): Promise<LedgerEvent>
  readAll(): Promise<LedgerEvent[]>
  verify(): Promise<LedgerVerification>
  lastSeq(): Promise<number>
}

export interface CreateLedgerOptions {
  fs: FileSystem
  /** 账本文件路径（宿主 FileSystem 口径，通常为仓库相对路径 `.flowgate/state/ledger.jsonl`）。 */
  path: string
  /** HMAC 密钥，由宿主提供。 */
  key: string
  clock: Clock
  /**
   * 可选：把同一事件同步写进宿主会话日志（FR-11.5 交叉校验）。
   * 采用 DSH `session.append(type, data)` 的调用形态；失败不影响账本。
   */
  sessionAppend?: (type: string, data: Record<string, unknown>) => void
}

/** 参与 MAC 的规范化内容：`{ seq, at, type, data, prev }` 的稳定 JSON 哈希。 */
export function contentHash(event: Omit<LedgerEvent, 'mac'>): string {
  return sha256(
    stableJson({
      seq: event.seq,
      at: event.at,
      type: event.type,
      data: event.data ?? {},
      prev: event.prev,
    }),
  )
}

/** HMAC-SHA256(ledgerKey, 规范化内容)；返回裸 hex。 */
export function signEvent(event: Omit<LedgerEvent, 'mac'>, key: string): string {
  return hmacSha256(key, contentHash(event))
}

/** 整行内容哈希（含 mac），用作下一行的 `prev`。 */
export function lineHash(event: LedgerEvent): string {
  return sha256(
    stableJson({
      seq: event.seq,
      at: event.at,
      type: event.type,
      data: event.data ?? {},
      prev: event.prev,
      mac: event.mac ?? '',
    }),
  )
}

function withoutMac(event: LedgerEvent): Omit<LedgerEvent, 'mac'> {
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    data: event.data ?? {},
    prev: event.prev,
  }
}

/** 固定字段顺序序列化一行，便于人工审计与 diff。 */
function serializeLine(event: LedgerEvent): string {
  return JSON.stringify({
    seq: event.seq,
    at: event.at,
    type: event.type,
    data: event.data ?? {},
    prev: event.prev,
    mac: event.mac ?? '',
  })
}

function parseLine(raw: string): LedgerEvent | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.seq !== 'number' || !Number.isInteger(obj.seq)) return null
  if (typeof obj.type !== 'string' || typeof obj.at !== 'string') return null
  if (typeof obj.prev !== 'string') return null
  const data =
    obj.data !== null && typeof obj.data === 'object' && !Array.isArray(obj.data)
      ? (obj.data as Record<string, unknown>)
      : {}
  const event: LedgerEvent = {
    seq: obj.seq,
    at: obj.at,
    type: obj.type as LedgerEventType,
    data,
    prev: obj.prev,
  }
  if (typeof obj.mac === 'string') event.mac = obj.mac
  return event
}

export function createLedger(options: CreateLedgerOptions): Ledger {
  const { fs, key, clock } = options
  // 允许宿主传绝对路径；此处只补齐父目录，不解析仓库根。
  const path = options.path

  let queue: Promise<unknown> = Promise.resolve()

  async function readRawLines(): Promise<string[]> {
    if (!(await fs.exists(path))) return []
    const raw = await fs.readFile(path)
    return raw
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim() !== '')
  }

  async function readAll(): Promise<LedgerEvent[]> {
    const lines = await readRawLines()
    const events: LedgerEvent[] = []
    for (const line of lines) {
      const event = parseLine(line)
      // 容错：损坏行跳过，但后续行仍可枚举（verify() 会报告损坏行）。
      if (event) events.push(event)
    }
    return events
  }

  async function appendUnlocked(input: LedgerEventInput): Promise<LedgerEvent> {
    const events = await readAll()
    const previous = events.length > 0 ? events[events.length - 1] : undefined
    const seq = previous ? previous.seq + 1 : 1
    const base: Omit<LedgerEvent, 'mac'> = {
      seq,
      at: input.at ?? isoNow(clock),
      type: input.type,
      data: input.data ?? {},
      prev: previous ? lineHash(previous) : GENESIS_PREV,
    }
    const event: LedgerEvent = { ...base, mac: signEvent(base, key) }
    const dir = posixDirname(path)
    if (dir !== '') await fs.mkdir(dir)
    await fs.appendFile(path, `${serializeLine(event)}\n`)
    if (options.sessionAppend) {
      try {
        options.sessionAppend(event.type, event.data)
      } catch {
        // 会话日志写入失败不应破坏账本：账本是唯一事实来源，附着时会交叉核对。
      }
    }
    return event
  }

  function append(input: LedgerEventInput): Promise<LedgerEvent> {
    // 串行化追加，避免并发读到最后一行相同 seq。
    const run = queue.then(() => appendUnlocked(input))
    queue = run.catch(() => undefined)
    return run
  }

  async function verify(): Promise<LedgerVerification> {
    const lines = await readRawLines()
    const failures: { line: number; reason: string }[] = []
    const parsed: (LedgerEvent | null)[] = lines.map((line) => parseLine(line))
    for (let index = 0; index < lines.length; index += 1) {
      const lineNo = index + 1
      const event = parsed[index] ?? null
      if (!event) {
        failures.push({ line: lineNo, reason: `第 ${lineNo} 行不是合法的账本事件 JSON` })
        continue
      }
      if (event.seq !== lineNo) {
        failures.push({
          line: lineNo,
          reason: `第 ${lineNo} 行序号不连续（期望 ${lineNo}，实际 ${event.seq}）`,
        })
      }
      if (lineNo === 1) {
        if (event.prev !== GENESIS_PREV) {
          failures.push({ line: lineNo, reason: `第 1 行 prev 应为 ${GENESIS_PREV}，实际 ${event.prev}` })
        }
      } else {
        const previous = parsed[index - 1] ?? null
        if (previous) {
          const expected = lineHash(previous)
          if (event.prev !== expected) {
            failures.push({ line: lineNo, reason: `第 ${lineNo} 行 prev 与上一行哈希不一致（哈希链断裂）` })
          }
        }
      }
      const expectedMac = signEvent(withoutMac(event), key)
      if (!event.mac || event.mac !== expectedMac) {
        failures.push({ line: lineNo, reason: `第 ${lineNo} 行 HMAC 签名不符` })
      }
    }
    return { ok: failures.length === 0, lines: lines.length, failures }
  }

  async function lastSeq(): Promise<number> {
    const events = await readAll()
    return events.length > 0 ? events[events.length - 1]!.seq : 0
  }

  return { append, readAll, verify, lastSeq }
}
