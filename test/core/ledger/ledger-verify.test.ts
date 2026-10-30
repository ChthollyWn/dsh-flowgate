import { describe, expect, it } from 'vitest'
import { createLedger } from '../../../src/core/ledger'
import { fixedClock, LEDGER_PATH, ledgerFs, rawLedgerLines, writeLedgerLines } from './test-helpers'

const KEY = 'test-ledger-key-0123456789'

async function seedLedger(lines = 4) {
  const fs = ledgerFs()
  const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
  for (let index = 1; index <= lines; index += 1) {
    await ledger.append({ type: 'flow.init', at: `2026-11-12T10:0${index}:00+08:00`, data: { index } })
  }
  return { fs, ledger }
}

describe('ledger verify', () => {
  it('完整账本校验通过', async () => {
    const { ledger } = await seedLedger(4)
    const result = await ledger.verify()
    expect(result).toEqual({ ok: true, lines: 4, failures: [] })
  })

  it('空账本校验通过', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const result = await ledger.verify()
    expect(result.ok).toBe(true)
    expect(result.lines).toBe(0)
  })

  it('改动第 N 行内容时报第 N 行签名不符（T1.3 验收）', async () => {
    const { fs, ledger } = await seedLedger(5)
    const lines = await rawLedgerLines(fs)
    const target = JSON.parse(lines[2]!) as Record<string, unknown>
    target.data = { index: 999, tampered: true }
    lines[2] = JSON.stringify(target)
    await writeLedgerLines(fs, lines)

    const result = await ledger.verify()
    expect(result.ok).toBe(false)
    expect(result.lines).toBe(5)
    const line3 = result.failures.filter((failure) => failure.line === 3)
    expect(line3.some((failure) => failure.reason.includes('HMAC'))).toBe(true)
    // 哈希链同样断裂：第 4 行的 prev 指向旧内容。
    expect(result.failures.some((failure) => failure.line === 4 && failure.reason.includes('prev'))).toBe(true)
  })

  it('只改 mac 字段也能发现签名不符', async () => {
    const { fs, ledger } = await seedLedger(3)
    const lines = await rawLedgerLines(fs)
    const target = JSON.parse(lines[1]!) as Record<string, unknown>
    target.mac = 'f'.repeat(64)
    lines[1] = JSON.stringify(target)
    await writeLedgerLines(fs, lines)
    const result = await ledger.verify()
    expect(result.ok).toBe(false)
    expect(result.failures.some((failure) => failure.line === 2 && failure.reason.includes('签名'))).toBe(true)
  })

  it('中间行不是合法 JSON 时报告该行，后续行仍可枚举、整体 fail', async () => {
    const { fs, ledger } = await seedLedger(4)
    const lines = await rawLedgerLines(fs)
    lines[1] = '{"seq":2, broken json'
    await writeLedgerLines(fs, lines)

    const result = await ledger.verify()
    expect(result.ok).toBe(false)
    expect(result.failures.some((failure) => failure.line === 2 && failure.reason.includes('JSON'))).toBe(true)
    // 损坏行之后的事件仍可枚举（最后一行的数据能读到），但整体校验失败。
    const events = await ledger.readAll()
    expect(events).toHaveLength(3)
    expect(events.at(-1)?.data).toEqual({ index: 4 })
  })

  it('第一行 prev 不是 genesis 时报错', async () => {
    const { fs, ledger } = await seedLedger(2)
    const lines = await rawLedgerLines(fs)
    const target = JSON.parse(lines[0]!) as Record<string, unknown>
    target.prev = 'sha256:deadbeef'
    lines[0] = JSON.stringify(target)
    await writeLedgerLines(fs, lines)
    const result = await ledger.verify()
    expect(result.failures.some((failure) => failure.line === 1 && failure.reason.includes('genesis'))).toBe(true)
  })

  it('删除中间行导致序号不连续', async () => {
    const { fs, ledger } = await seedLedger(4)
    const lines = await rawLedgerLines(fs)
    lines.splice(1, 1)
    await writeLedgerLines(fs, lines)
    const result = await ledger.verify()
    expect(result.ok).toBe(false)
    expect(result.lines).toBe(3)
    expect(result.failures.some((failure) => failure.line === 2 && failure.reason.includes('序号不连续'))).toBe(true)
  })

  it('换密钥后整本账校验失败', async () => {
    const { fs } = await seedLedger(3)
    const wrongKeyLedger = createLedger({ fs, path: LEDGER_PATH, key: 'another-key', clock: fixedClock() })
    const result = await wrongKeyLedger.verify()
    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(3)
    expect(result.failures.every((failure) => failure.reason.includes('HMAC'))).toBe(true)
  })
})
