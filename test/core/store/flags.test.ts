/**
 * 项目级 flags（v0.5.1）：`.flowgate/state/flags.json` 的原子读写、损坏降级与归一化。
 * flags 是辅助运行态：任何损坏都不能让 engine.load 抛错，否则一次坏文件会永久锁死 agent。
 */
import { describe, expect, it } from 'vitest'

import {
  emptyProjectFlags,
  normalizeProjectFlags,
  readProjectFlags,
  writeProjectFlags,
} from '../../../src/core/store'
import { layout } from '../../../src/core/store/layout'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import type { ProjectFlags } from '../../../src/core/types'

const ROOT = ''

describe('store/flags: 读取与损坏降级', () => {
  it('文件缺失返回空 flags', async () => {
    const fs = new MemoryFileSystem()
    await expect(readProjectFlags(fs, ROOT)).resolves.toEqual({})
  })

  it('损坏 JSON / 空文件返回空 flags（不抛错）', async () => {
    const fs = new MemoryFileSystem({
      [layout(ROOT).flags]: '{"off": {broken',
    })
    await expect(readProjectFlags(fs, ROOT)).resolves.toEqual({})
    await fs.writeFile(layout(ROOT).flags, '')
    await expect(readProjectFlags(fs, ROOT)).resolves.toEqual({})
  })

  it('结构非法的字段被丢弃而不是整体失败', async () => {
    const flags = {
      off: { by: 'robot', reason: 'x', at: 't' },
      incident: { id: 'INC-1', severity: 'PX', reason: 'r' },
    } satisfies Record<string, unknown>
    const normalized = normalizeProjectFlags(flags)
    expect(normalized.off).toBeUndefined()
    // incident 缺 openedAt/openedBy 时按默认值补齐（id + reason 是必填）。
    expect(normalized.incident?.id).toBe('INC-1')
    expect(normalized.incident?.severity).toBe('P1')
    expect(normalized.incident?.openedBy).toBe('agent')
  })
})

describe('store/flags: 原子写入与回读', () => {
  it('写入后可完整回读（含暂停与事故记录），且不残留 .tmp', async () => {
    const fs = new MemoryFileSystem()
    const flags: ProjectFlags = {
      off: { by: 'agent', reason: '会话投影 bug 自暂停', at: '2026-11-01T09:00:00+08:00', autoRearm: true, hostEpoch: 'epoch-a' },
      incident: {
        id: 'INC-20261101-090000',
        severity: 'P0',
        reason: '新建会话失败',
        openedAt: '2026-11-01T09:00:00+08:00',
        openedBy: 'agent',
      },
    }
    await writeProjectFlags(fs, ROOT, flags)
    expect(fs.listFiles()).not.toContain(`${layout(ROOT).flags}.tmp`)
    await expect(readProjectFlags(fs, ROOT)).resolves.toEqual(flags)
  })

  it('emptyProjectFlags 每次返回新对象', () => {
    expect(emptyProjectFlags()).toEqual({})
    expect(emptyProjectFlags()).not.toBe(emptyProjectFlags())
  })
})
