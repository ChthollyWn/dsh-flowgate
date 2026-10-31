import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { createLedger } from '../../../src/core/ledger'
import {
  DEFAULT_CONFIG,
  layout,
  loadProjectState,
  scaffold,
  writeChangeStatus,
  writeLeases,
} from '../../../src/core/store'
import type { SessionLease } from '../../../src/core/types'
import { makeChange } from './fixtures'

const clock = { now: () => new Date('2026-11-12T10:31:05+08:00') }
const KEY = 'load-test-key'

const lease: SessionLease = {
  sessionId: 'web-1a2b',
  changeId: 'C-001',
  attachedAt: '2026-11-12T10:00:00+08:00',
  heartbeatAt: '2026-11-12T10:31:00+08:00',
}

describe('loadProjectState', () => {
  it('未初始化项目返回空状态，不读其他文件', async () => {
    const fs = new MemoryFileSystem()
    const state = await loadProjectState({ fs, root: '', config: DEFAULT_CONFIG, clock })
    expect(state).toEqual({
      root: '',
      initialized: false,
      config: DEFAULT_CONFIG,
      changes: [],
      leases: [],
      ledgerSeq: 0,
    })
  })

  it('已初始化项目加载变更、租约与账本序号', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    await writeChangeStatus(fs, '', makeChange({ id: 'C-001' }))
    await writeChangeStatus(fs, '', makeChange({ id: 'C-002', updatedAt: '2026-11-12T11:00:00+08:00' }))
    await writeLeases(fs, '', [lease])
    const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock })
    await ledger.append({ type: 'flow.init' })
    await ledger.append({ type: 'session.attached', data: { changeId: 'C-001', sessionId: 'web-1a2b' } })

    const state = await loadProjectState({ fs, root: '', config: DEFAULT_CONFIG, clock })
    expect(state.initialized).toBe(true)
    expect(state.changes.map((change) => change.id)).toEqual(['C-001', 'C-002'])
    expect(state.leases).toEqual([lease])
    expect(state.ledgerSeq).toBe(2)
    expect(state.locked).toBeUndefined()
  })

  it('账本里有未解除的 lock.entered 时带上项目锁定信息', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock })
    await ledger.append({ type: 'flow.init' })
    await ledger.append({ type: 'lock.entered', at: '2026-11-12T10:10:00+08:00', data: { reason: '账本被篡改', detail: '第 3 行签名不符' } })

    const state = await loadProjectState({ fs, root: '', config: DEFAULT_CONFIG, clock })
    expect(state.locked).toEqual({ reason: '账本被篡改', at: '2026-11-12T10:10:00+08:00', detail: '第 3 行签名不符' })
  })

  it('lock.released 之后解除锁定', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock })
    await ledger.append({ type: 'flow.init' })
    await ledger.append({ type: 'lock.entered', data: { reason: '损坏' } })
    await ledger.append({ type: 'lock.released' })

    const state = await loadProjectState({ fs, root: '', config: DEFAULT_CONFIG, clock })
    expect(state.locked).toBeUndefined()
  })

  it('会话租约损坏时汇总为 corruptStateFiles（由 engine 锁定，不再让 load 抛错）', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    await fs.writeFile(layout('').sessions, '{broken')
    // P0-6：租约损坏曾让 loadProjectState 抛错 → engine.load 失败 → 宿主 markInert →
    // 守卫 fail-open。现在按状态文件损坏处理：返回损坏清单，engine 进入锁定模式。
    const state = await loadProjectState({ fs, root: '', config: DEFAULT_CONFIG, clock })
    expect(state.leases).toEqual([])
    expect(state.corruptStateFiles).toHaveLength(1)
    expect(state.corruptStateFiles?.[0]?.path).toBe(layout('').sessions)
    expect(state.corruptStateFiles?.[0]?.reason).toContain('非法 JSON')
  })

  it('支持 root 前缀', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '/repo')
    const state = await loadProjectState({ fs, root: '/repo', config: DEFAULT_CONFIG, clock })
    expect(state.root).toBe('/repo')
    expect(state.initialized).toBe(true)
  })
})
