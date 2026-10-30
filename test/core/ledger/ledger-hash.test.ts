import { describe, expect, it } from 'vitest'
import { GENESIS_PREV, contentHash, lineHash, signEvent } from '../../../src/core/ledger'
import type { LedgerEvent } from '../../../src/core/types'
import { hmacSha256 } from '../../../src/core/util/hash'

const KEY = 'ledger-key-for-hash-tests'

function baseEvent(): Omit<LedgerEvent, 'mac'> {
  return {
    seq: 7,
    at: '2026-11-12T10:31:05+08:00',
    type: 'change.created',
    data: { changeId: 'C-001', title: '会员续费' },
    prev: 'sha256:abc',
  }
}

describe('ledger hashing', () => {
  it('genesis 常量固定为 genesis', () => {
    expect(GENESIS_PREV).toBe('genesis')
  })

  it('contentHash 对 data 键顺序稳定', () => {
    const a = contentHash({ ...baseEvent(), data: { b: 2, a: 1, nested: { y: true, x: false } } })
    const b = contentHash({ ...baseEvent(), data: { nested: { x: false, y: true }, a: 1, b: 2 } })
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('contentHash 对 seq / at / type / prev 敏感', () => {
    const base = contentHash(baseEvent())
    expect(contentHash({ ...baseEvent(), seq: 8 })).not.toBe(base)
    expect(contentHash({ ...baseEvent(), at: '2026-11-12T10:31:06+08:00' })).not.toBe(base)
    expect(contentHash({ ...baseEvent(), type: 'flow.on' })).not.toBe(base)
    expect(contentHash({ ...baseEvent(), prev: 'sha256:def' })).not.toBe(base)
    expect(contentHash({ ...baseEvent(), data: { changeId: 'C-002' } })).not.toBe(base)
  })

  it('signEvent = HMAC-SHA256(key, contentHash)，换密钥即变化', () => {
    const event = baseEvent()
    expect(signEvent(event, KEY)).toBe(hmacSha256(KEY, contentHash(event)))
    expect(signEvent(event, 'other-key')).not.toBe(signEvent(event, KEY))
    expect(signEvent(event, KEY)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lineHash 覆盖整行内容（含 mac）', () => {
    const event: LedgerEvent = { ...baseEvent(), mac: 'a'.repeat(64) }
    const same: LedgerEvent = { ...baseEvent(), mac: 'a'.repeat(64) }
    const differentMac: LedgerEvent = { ...baseEvent(), mac: 'b'.repeat(64) }
    expect(lineHash(event)).toBe(lineHash(same))
    expect(lineHash(event)).not.toBe(lineHash(differentMac))
    expect(lineHash(event)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('contentHash 只覆盖不含 mac 的规范化内容', () => {
    const event: LedgerEvent = { ...baseEvent(), mac: 'a'.repeat(64) }
    const withoutMac: Omit<LedgerEvent, 'mac'> = {
      seq: event.seq,
      at: event.at,
      type: event.type,
      data: event.data,
      prev: event.prev,
    }
    expect(contentHash(withoutMac)).not.toBe(lineHash(event))
  })
})
