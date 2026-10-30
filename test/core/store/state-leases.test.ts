import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import type { SessionLease } from '../../../src/core/types'
import { readLeases, writeLeases } from '../../../src/core/store'

const lease: SessionLease = {
  sessionId: 'web-1a2b',
  changeId: 'C-003',
  attachedAt: '2026-11-12T10:00:00+08:00',
  heartbeatAt: '2026-11-12T10:31:05+08:00',
  label: 'web-1a2b',
}

describe('session leases', () => {
  it('写读往返一致，且使用 sessions.json', async () => {
    const fs = new MemoryFileSystem()
    await writeLeases(fs, '', [lease])
    expect(fs.listFiles()).toEqual(['.flowgate/state/sessions.json'])
    await expect(readLeases(fs, '')).resolves.toEqual([lease])
    expect(fs.listFiles().some((path) => path.endsWith('.tmp'))).toBe(false)
  })

  it('文件不存在时返回空数组', async () => {
    const fs = new MemoryFileSystem()
    await expect(readLeases(fs, '')).resolves.toEqual([])
  })

  it('兼容裸数组格式', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/state/sessions.json': JSON.stringify([lease]),
    })
    await expect(readLeases(fs, '')).resolves.toEqual([lease])
  })

  it('损坏的租约文件抛错并提示 /flow repair', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/state/sessions.json': '{broken' })
    await expect(readLeases(fs, '')).rejects.toThrowError(/损坏/)
  })

  it('缺少 leases 数组时抛错', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/state/sessions.json': '{"version":1}' })
    await expect(readLeases(fs, '')).rejects.toThrowError(/leases/)
  })

  it('过滤字段不完整的租约项', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/state/sessions.json': JSON.stringify({
        version: 1,
        leases: [lease, { sessionId: 'x' }],
      }),
    })
    await expect(readLeases(fs, '')).resolves.toEqual([lease])
  })
})
