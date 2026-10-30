import { describe, expect, it } from 'vitest'
import {
  GENESIS_PREV,
  contentHash,
  createLedger,
  lineHash,
  signEvent,
} from '../../../src/core/ledger'
import { fixedClock, LEDGER_PATH, ledgerFs, rawLedgerLines } from './test-helpers'

const KEY = 'test-ledger-key-0123456789'

describe('ledger append', () => {
  it('首行 prev 为 genesis，seq 从 1 开始，字段齐全', async () => {
    const fs = ledgerFs()
    const clock = fixedClock()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock })
    const event = await ledger.append({ type: 'flow.init', data: { plugin: '0.1.0' } })
    expect(event.seq).toBe(1)
    expect(event.prev).toBe(GENESIS_PREV)
    expect(event.type).toBe('flow.init')
    expect(event.data).toEqual({ plugin: '0.1.0' })
    expect(event.at).toBe('2026-11-12T10:31:05+08:00')
    expect(event.mac).toMatch(/^[0-9a-f]{64}$/)
  })

  it('prev 等于上一行整行内容哈希，形成哈希链', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const first = await ledger.append({ type: 'flow.init', at: '2026-11-12T10:00:00+08:00' })
    const second = await ledger.append({ type: 'change.created', at: '2026-11-12T10:01:00+08:00', data: { changeId: 'C-001' } })
    const third = await ledger.append({ type: 'stage.entered', at: '2026-11-12T10:02:00+08:00', data: { changeId: 'C-001', stage: 'S1' } })
    expect(second.prev).toBe(lineHash(first))
    expect(third.prev).toBe(lineHash(second))
    expect(second.mac).toBe(
      signEvent({ seq: second.seq, at: second.at, type: second.type, data: second.data, prev: second.prev }, KEY),
    )
  })

  it('data 缺省为 {}，at 缺省取时钟', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const event = await ledger.append({ type: 'flow.off' })
    expect(event.data).toEqual({})
    expect(event.at).toBe('2026-11-12T10:31:05+08:00')
    await expect(ledger.readAll()).resolves.toHaveLength(1)
  })

  it('只追加：文件按行保存、以换行结尾、旧行内容不变', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    await ledger.append({ type: 'flow.init', at: '2026-11-12T10:00:00+08:00' })
    const firstLine = (await rawLedgerLines(fs))[0]
    await ledger.append({ type: 'flow.on', at: '2026-11-12T10:05:00+08:00' })
    const lines = await rawLedgerLines(fs)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(firstLine)
    const raw = await fs.readFile(LEDGER_PATH)
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['seq', 'at', 'type', 'data', 'prev', 'mac'])
  })

  it('lastSeq 返回最后一行序号，空账本为 0', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    await expect(ledger.lastSeq()).resolves.toBe(0)
    await ledger.append({ type: 'flow.init' })
    await ledger.append({ type: 'flow.on' })
    await expect(ledger.lastSeq()).resolves.toBe(2)
  })

  it('并发 append 串行化，序号不重复', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const events = await Promise.all(
      Array.from({ length: 6 }, (_, index) => ledger.append({ type: 'flow.init', data: { index } })),
    )
    expect(events.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    await expect(ledger.verify()).resolves.toMatchObject({ ok: true, lines: 6 })
  })

  it('sessionAppend 收到 (type, data)，且抛出异常不破坏账本', async () => {
    const calls: { type: string; data: Record<string, unknown> }[] = []
    const fs = ledgerFs()
    const ledger = createLedger({
      fs,
      path: LEDGER_PATH,
      key: KEY,
      clock: fixedClock(),
      sessionAppend: (type, data) => {
        calls.push({ type, data })
        throw new Error('session append unavailable')
      },
    })
    const event = await ledger.append({ type: 'flow.init', data: { plugin: '0.1.0' } })
    expect(calls).toEqual([{ type: 'flow.init', data: { plugin: '0.1.0' } }])
    await expect(ledger.readAll()).resolves.toEqual([event])
  })

  it('contentHash 与 signEvent 可在外部独立重算', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const event = await ledger.append({ type: 'gate.passed', data: { gate: 'G2' } })
    const recomputed = contentHash({ seq: event.seq, at: event.at, type: event.type, data: event.data, prev: event.prev })
    expect(signEvent({ seq: event.seq, at: event.at, type: event.type, data: event.data, prev: event.prev }, KEY)).toBe(event.mac)
    expect(recomputed).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('ledger append（跨实例与数据快照）', () => {
  it('同一账本被多个实例依次追加时链保持连续', async () => {
    const fs = ledgerFs()
    const first = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    await first.append({ type: 'flow.init', at: '2026-11-12T10:00:00+08:00' })
    const second = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const event = await second.append({ type: 'flow.on', at: '2026-11-12T10:05:00+08:00' })
    expect(event.seq).toBe(2)
    await expect(second.verify()).resolves.toMatchObject({ ok: true, lines: 2 })
  })

  it('调用方事后修改 data 对象不会改写已落盘内容', async () => {
    const fs = ledgerFs()
    const ledger = createLedger({ fs, path: LEDGER_PATH, key: KEY, clock: fixedClock() })
    const data: Record<string, unknown> = { changeId: 'C-001', items: [1] }
    await ledger.append({ type: 'change.created', data })
    data.changeId = 'C-999'
    const events = await ledger.readAll()
    expect(events[0]!.data).toEqual({ changeId: 'C-001', items: [1] })
  })
})
