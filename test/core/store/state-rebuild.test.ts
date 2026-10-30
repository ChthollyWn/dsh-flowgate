import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { createLedger } from '../../../src/core/ledger'
import {
  changePaths,
  layout,
  readChangeStatus,
  rebuildState,
  scaffold,
  writeChangeStatus,
  writeChangesIndex,
} from '../../../src/core/store'
import type { ChangeStatus } from '../../../src/core/types'
import { makeChange } from './fixtures'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const KEY = 'rebuild-test-key'

async function appendSnapshot(
  fs: MemoryFileSystem,
  change: ChangeStatus,
): Promise<void> {
  const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock: { now: () => new Date('2026-11-12T10:31:05+08:00') } })
  await ledger.append({
    type: 'change.updated',
    at: change.updatedAt,
    data: { changeId: change.id, change: clone(change) },
  })
}

describe('rebuildState（/flow repair）', () => {
  it('删除 status.json 与 index.md 后，从账本快照完整重建（与删除前一致）', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    const richChange = makeChange({
      id: 'C-001',
      title: '会员续费',
      stage: 'S4',
      session: { attached: 'web-1a2b', heartbeat: '2026-11-12T10:31:05+08:00' },
      batches: [{ id: 'B2', mode: 'parallel', status: 'running', tasks: ['T3', 'T4'] }],
      tasks: {
        T3: {
          id: 'T3',
          batch: 'B2',
          status: 'running',
          tdd: 'red',
          evidenceIds: ['E-0001'],
          reviewIds: [],
          worktree: '.flowgate/worktrees/C-001/T3',
        },
        T4: {
          id: 'T4',
          batch: 'B2',
          status: 'queued',
          tdd: 'none',
          evidenceIds: [],
          reviewIds: [],
        },
      },
      evidenceIds: ['E-0001'],
      contract: {
        plugin: '0.1.0',
        rules: 'sha256:aaa',
        levels: 'sha256:bbb',
        skills: { 'flow-plan': 'sha256:ccc' },
        createdAt: '2026-11-10T09:00:00+08:00',
      },
      frozen: { design: { hash: 'sha256:ddd', at: '2026-11-11T12:00:00+08:00' } },
      updatedAt: '2026-11-12T10:31:05+08:00',
    })
    const archived = makeChange({
      id: 'C-002',
      title: '首页按钮文案',
      stage: 'archived',
      lifecycle: 'archived',
      updatedAt: '2026-11-10T16:02:00+08:00',
    })
    const original = [richChange, archived]

    for (const change of original) await writeChangeStatus(fs, '', change)
    await writeChangesIndex(fs, '', original)
    const indexBefore = await fs.readFile(layout('').changesIndex)
    const statusBefore = await fs.readFile(changePaths('', 'C-001').status)
    for (const change of original) await appendSnapshot(fs, change)

    // 模拟状态文件丢失：删除 status.json 与台账，再重建。
    await fs.remove(changePaths('', 'C-001').status)
    await fs.remove(layout('').changesIndex)

    const result = await rebuildState(fs, '')
    expect(result.changes.map((change) => change.id)).toEqual(['C-001', 'C-002'])
    expect(result.rebuilt).toContain('C-001')
    await expect(readChangeStatus(fs, '', 'C-001')).resolves.toEqual(richChange)
    await expect(readChangeStatus(fs, '', 'C-002')).resolves.toEqual(archived)
    // status.json 与 index.md 都与删除前一致。
    expect(await fs.readFile(changePaths('', 'C-001').status)).toBe(statusBefore)
    expect(await fs.readFile(layout('').changesIndex)).toBe(indexBefore)
  })

  it('没有完整快照时用增量事件回填（阶段/门/标题）', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock: { now: () => new Date('2026-11-12T10:00:00+08:00') } })
    await ledger.append({ type: 'change.created', at: '2026-11-12T10:00:00+08:00', data: { changeId: 'C-010', kind: 'change', title: '增量重建', complexity: 'high', risk: 'high' } })
    await ledger.append({ type: 'gate.approved', at: '2026-11-12T10:01:00+08:00', data: { changeId: 'C-010', gate: 'G0' } })
    await ledger.append({ type: 'stage.entered', at: '2026-11-12T10:02:00+08:00', data: { changeId: 'C-010', stage: 'S1' } })

    const result = await rebuildState(fs, '')
    const rebuilt = result.changes.find((change) => change.id === 'C-010')!
    expect(result.rebuilt).toContain('C-010')
    expect(rebuilt.title).toBe('增量重建')
    expect(rebuilt.complexity).toBe('high')
    expect(rebuilt.stage).toBe('S1')
    expect(rebuilt.gates.G0?.state).toBe('passed')
    expect(rebuilt.updatedAt).toBe('2026-11-12T10:02:00+08:00')
    expect(await fs.exists(changePaths('', 'C-010').status)).toBe(true)
  })

  it('没有账本事件时按 changes/ 目录里的产物推断骨架（S3）', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/changes/C-009/tasks.md': '## T1 任务\n',
    })
    const result = await rebuildState(fs, '')
    const inferred = result.changes.find((change) => change.id === 'C-009')!
    expect(inferred.stage).toBe('S3')
    await expect(readChangeStatus(fs, '', 'C-009')).resolves.toMatchObject({ id: 'C-009', stage: 'S3' })
  })

  it('账本中夹带损坏行时仍能重建其余快照', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/state/ledger.jsonl': [
        '{"seq":1,"at":"2026-11-12T10:00:00+08:00","type":"flow.init","data":{},"prev":"genesis","mac":"bad"',
        JSON.stringify({
          seq: 2,
          at: '2026-11-12T10:01:00+08:00',
          type: 'change.updated',
          data: { changeId: 'C-011', change: clone(makeChange({ id: 'C-011', title: '损坏行之后' })) },
          prev: 'sha256:x',
          mac: 'y',
        }),
      ].join('\n'),
    })
    const result = await rebuildState(fs, '')
    expect(result.changes.find((change) => change.id === 'C-011')?.title).toBe('损坏行之后')
  })

  it('现有 status.json 没有对应快照时保留（不丢信息）', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    const existing = makeChange({ id: 'C-020', title: '保留下来的完整状态' })
    await writeChangeStatus(fs, '', existing)
    const ledger = createLedger({ fs, path: layout('').ledger, key: KEY, clock: { now: () => new Date('2026-11-12T10:00:00+08:00') } })
    await ledger.append({ type: 'change.created', at: '2026-11-12T10:00:00+08:00', data: { changeId: 'C-020', title: '账本标题' } })

    const result = await rebuildState(fs, '')
    expect(result.kept).toContain('C-020')
    await expect(readChangeStatus(fs, '', 'C-020')).resolves.toEqual(existing)
  })
})
