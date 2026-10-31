/**
 * `foldLedgerToChanges` rebuild tests: every incremental ledger event type must
 * be able to restore the corresponding status.json fields when the full
 * `change.updated` snapshot is unavailable (trimmed/legacy ledger).
 */
import { describe, expect, it } from 'vitest'
import type { ChangeStatus, LedgerEvent, LedgerEventType } from '../../../src/core/types'
import { foldLedgerToChanges } from '../../../src/core/store/state'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { layout, rebuildState } from '../../../src/core/store'

const AT = '2026-11-12T10:00:00+08:00'

let seq = 0

function event(type: LedgerEventType, data: Record<string, unknown>, at = AT): LedgerEvent {
  seq += 1
  return { seq, at, type, data, prev: '' }
}

function fold(...events: LedgerEvent[]): ChangeStatus[] {
  // 增量事件按 data.changeId 归属变更：默认归到第一个事件的变更
  const defaultId = String(events[0]?.data['changeId'] ?? events[0]?.data['change'] !== undefined ? (events[0]?.data['change'] as Record<string, unknown> | undefined)?.['id'] ?? 'C-001' : 'C-001')
  const withIds = events.map((item) =>
    item.data['changeId'] !== undefined ? item : { ...item, data: { ...item.data, changeId: defaultId } },
  )
  // 重新编号，保证测试之间互不影响
  const renumbered = withIds.map((item, index) => ({ ...item, seq: index + 1 }))
  const changes = foldLedgerToChanges(renumbered)
  seq = 0
  return changes
}

describe('store/state — foldLedgerToChanges 增量事件重建', () => {
  it('change.created 补齐标题 / 类型 / 阶段 / 等级 / 生命周期 / 分支 / 关联信息', () => {
    const [change] = fold(
      event('change.created', {
        changeId: 'A-001',
        title: '分析登录流程',
        kind: 'analysis',
        stage: 'S1',
        complexity: 'high',
        risk: 'high',
        lifecycle: 'paused',
        branch: 'flow/A-001',
        summary: '只读分析',
        roadmap: 'RM-1',
        relatedTo: 'C-009',
        contract: { plugin: '0.1.0' },
      }),
    )
    expect(change).toMatchObject({
      id: 'A-001',
      kind: 'analysis',
      title: '分析登录流程',
      stage: 'S1',
      complexity: 'high',
      risk: 'high',
      lifecycle: 'paused',
      branch: 'flow/A-001',
      summary: '只读分析',
      roadmap: 'RM-1',
      relatedTo: 'C-009',
      createdAt: AT,
      updatedAt: AT,
    })
    expect(change?.contract).toEqual({ plugin: '0.1.0' })

    // 字段缺失 / 类型不对时走默认值（title 保留 id、忽略非对象 contract）
    const [bare] = fold(event('change.created', { changeId: 'C-001', summary: null, contract: 'bad' }))
    expect(bare).toMatchObject({ id: 'C-001', title: 'C-001', kind: 'change', stage: 'S0', lifecycle: 'active' })
    expect(bare?.contract).toBeUndefined()
    expect(bare?.summary).toBeUndefined()
  })

  it('level.changed 与 stage.entered 只在字段存在时覆盖', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('level.changed', { complexity: 'ultra', risk: 'high' }),
      event('level.changed', {}),
      event('stage.entered', { stage: 'S5' }),
      event('stage.entered', {}),
    )
    expect(change).toMatchObject({ complexity: 'ultra', risk: 'high', stage: 'S5' })
  })

  it('门的 submitted / failed / passed / approved / rejected 事件回填 GateRecord', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('gate.submitted', { gate: 'G1' }),
      event('gate.failed', { gate: 'G2', items: [{ item: 'x', label: 'x', status: 'fail', priority: 'P0' }] }),
      event('gate.failed', { gate: 'G3' }),
      event('gate.passed', { gate: 'G4' }),
      event('gate.approved', { gate: 'G5' }),
      event('gate.rejected', { gate: 'G6', reason: '规格不清' }),
      event('gate.submitted', {}),
    )
    expect(change?.gates.G1).toMatchObject({ state: 'awaiting', attempts: 1 })
    expect(change?.gates.G2?.state).toBe('failed')
    expect(change?.gates.G2?.items).toHaveLength(1)
    expect(change?.gates.G3?.state).toBe('failed')
    expect(change?.gates.G4?.state).toBe('passed')
    expect(change?.gates.G5?.state).toBe('passed')
    expect(change?.gates.G6).toMatchObject({ state: 'failed', rejectedReason: '规格不清' })
    expect(Object.keys(change?.gates ?? {})).toHaveLength(6)

    const [fallback] = fold(
      event('change.created', { changeId: 'C-002' }),
      event('gate.rejected', { gate: 'G1', rejectedReason: '旧字段' }),
    )
    expect(fallback?.gates.G1?.rejectedReason).toBe('旧字段')
  })

  it('任务事件回填任务状态并自动创建未知批次', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('task.started', { taskId: 'T1', batch: 'B1', agent: 'executor-1', cwd: '/x' }),
      event('task.done', { taskId: 'T1' }),
      event('task.started', { taskId: 'T2', batch: 'B9' }),
      event('task.blocked', { taskId: 'T2', reason: '等待负责人' }),
      event('task.interrupted', { taskId: 'T3' }),
      event('task.interrupted', { taskId: 'T3' }),
      event('task.started', {}),
    )
    expect(change?.tasks.T1).toMatchObject({ status: 'done', agent: 'executor-1', batch: 'B1' })
    expect(change?.tasks.T2).toMatchObject({ status: 'blocked', blockReason: '等待负责人', batch: 'B9' })
    expect(change?.tasks.T3).toMatchObject({ status: 'interrupted' })
    // 批次 B1/B9 各自动补建一次；重复的 interrupted 事件不会重复建批次
    expect(change?.batches.map((batch) => batch.id)).toEqual(['B1', 'B9'])
    expect(change?.batches.every((batch) => batch.status === 'pending')).toBe(true)
  })

  it('证据事件去重，review / violation 事件收集记录', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('evidence.recorded', { evidenceId: 'E-0001' }),
      event('verify.receipt', { evidenceId: 'E-0001' }),
      event('evidence.recorded', { id: 'E-0002' }),
      event('evidence.recorded', { id: 'E-0002' }),
      event('evidence.recorded', {}),
      event('review.reported', { review: { id: 'RV-1', verdict: 'pass' } }),
      event('review.reported', { review: 'bad' }),
      event('violation.detected', { violation: { id: 'V-1', path: 'src/x.ts' } }),
      event('violation.detected', { violation: 'bad' }),
      event('violation.cleared', { violationId: 'V-1' }),
      event('violation.cleared', { violationId: 'V-missing' }),
      event('violation.cleared', {}),
    )
    expect(change?.evidenceIds).toEqual(['E-0001', 'E-0002'])
    expect(change?.reviews).toEqual([{ id: 'RV-1', verdict: 'pass' }])
    expect(change?.violations).toHaveLength(1)
    expect(change?.violations[0]?.clearedAt).toBe(AT)
  })

  it('会话 / 暂停 / 锁定事件改变状态', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('session.attached', { sessionId: 'web-1' }),
      event('lock.entered', { reason: '账本被篡改', detail: 'line 3' }),
      event('lock.released', {}),
      event('change.paused', {}),
      event('session.released', {}),
    )
    expect(change?.lifecycle).toBe('paused')
    expect(change?.lock).toBeUndefined()
    expect(change?.session).toEqual({ heartbeat: AT })

    // takeover 覆盖 attached；lock.released 后 lifecycle 从 locked 回到 active
    const [locked] = fold(
      event('change.created', { changeId: 'C-002' }),
      event('session.attached', { sessionId: 'web-1' }),
      event('session.takeover', { sessionId: 'web-2' }),
      event('lock.entered', {}),
    )
    expect(locked?.session?.attached).toBe('web-2')
    expect(locked?.lock).toMatchObject({ reason: '锁定' })
    expect(locked?.lifecycle).toBe('locked')
    expect(fold(event('change.created', { changeId: 'C-002' }), event('lock.entered', {}), event('lock.released', {}))[0]?.lifecycle).toBe('active')
  })

  it('批次 started / completed 事件更新已有批次或新建批次', () => {
    const [change] = fold(
      event('change.created', { changeId: 'C-001' }),
      event('batch.started', { batchId: 'B1', mode: 'parallel', tasks: ['T1', 'T2'] }),
      event('batch.started', { batchId: 'B1' }),
      event('batch.started', { batchId: 'B2' }),
      event('batch.started', {}),
      event('batch.completed', { batchId: 'B1' }),
      event('batch.completed', { batchId: 'B-missing' }),
      event('batch.completed', {}),
    )
    expect(change?.batches).toHaveLength(2)
    expect(change?.batches[0]).toMatchObject({ id: 'B1', mode: 'parallel', status: 'done', tasks: ['T1', 'T2'] })
    expect(change?.batches[1]).toMatchObject({ id: 'B2', mode: 'sequential', status: 'running', tasks: [] })
  })

  it('未知事件 / 缺 changeId 的事件被跳过；按编号排序', () => {
    const changes = foldLedgerToChanges([
      // 缺 changeId 且无快照：跳过
      event('rule.denied', { ruleId: 'R-SCOPE' }),
      event('change.created', { changeId: 'C-010' }),
      event('change.created', { changeId: 'C-002' }),
      // 重复的 created 事件只保留一个状态
      event('change.created', { changeId: 'C-002' }),
    ])
    expect(changes.map((change) => change.id)).toEqual(['C-002', 'C-010'])
  })

  it('change.updated 完整快照优先，并对缺失字段做归一化', () => {
    const snapshot = {
      id: 'C-005',
      title: '快照变更',
      stage: 'S4',
      // 故意缺失 tasks/pending 等数组；gates 类型错误
      gates: 'bad',
      createdAt: '2026-11-01T00:00:00+08:00',
    }
    const changes = fold(
      event('change.updated', { change: snapshot }),
      // 快照之后的增量事件照常叠加（快照本身只重置一次状态）
      event('gate.passed', { gate: 'G3' }),
    )
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      id: 'C-005',
      title: '快照变更',
      stage: 'S4',
      tasks: {},
      pending: [],
      batches: [],
      evidenceIds: [],
      createdAt: '2026-11-01T00:00:00+08:00',
      updatedAt: AT,
    })
    // 快照里的非法 gates 被归一化为空对象，后续 gate.passed 再叠加
    expect(changes[0]?.gates.G3).toMatchObject({ state: 'passed' })
  })
})

describe('store/state — listChanges / rebuildState 的错误分支', () => {
  it('changes 目录读不到时 listChanges 返回空数组', async () => {
    const { listChanges } = await import('../../../src/core/store/state')
    const fs = new MemoryFileSystem()
    const broken = Object.create(fs) as MemoryFileSystem
    Object.defineProperty(broken, 'readdir', {
      value: async () => {
        throw new Error('EACCES')
      },
    })
    expect(await listChanges(broken, '')).toEqual([])
  })

  it('账本没有快照、目录里只剩产物时按产物推断阶段；无产物目录被忽略', async () => {
    const fs = new MemoryFileSystem()
    // 目录里只有无产物的变更 + 一个有 clarify.md 的变更；均无 status.json、账本为空
    await fs.mkdir('.flowgate/changes/C-002')
    await fs.mkdir('.flowgate/changes/C-003')
    await fs.writeFile('.flowgate/changes/C-003/clarify.md', '# clarify\n')
    const result = await rebuildState(fs, '')
    expect(result.changes.map((change) => change.id)).toEqual(['C-003'])
    expect(result.rebuilt).toEqual(['C-003'])
    expect(result.kept).toEqual([])
    expect(result.changes[0]?.stage).toBe('S1')
    expect(result.changes[0]?.kind).toBe('change')
    // 台账也被重写
    expect(await fs.exists(layout('').changesIndex)).toBe(true)
  })

  it('账本只有增量事件（无 status.json）时用折叠结果重建', async () => {
    const fs = new MemoryFileSystem()
    await fs.mkdir('.flowgate/changes/C-001')
    const events: LedgerEvent[] = [
      event('change.created', { changeId: 'C-001', title: '增量重建' }),
      event('stage.entered', { changeId: 'C-001', stage: 'S2' }),
    ]
    await fs.writeFile(
      layout('').ledger,
      `${events
        .map((item) => JSON.stringify({ seq: item.seq, at: item.at, type: item.type, data: item.data, prev: '' }))
        .join('\n')}\n`,
    )
    const result = await rebuildState(fs, '')
    expect(result.rebuilt).toEqual(['C-001'])
    expect(result.changes[0]).toMatchObject({ id: 'C-001', title: '增量重建', stage: 'S2' })
    const raw = await fs.readFile('.flowgate/changes/C-001/status.json')
    expect(JSON.parse(raw)).toMatchObject({ id: 'C-001', stage: 'S2' })
  })

  it('changes 目录无法读取时 rebuildState 仍重写台账', async () => {
    const fs = new MemoryFileSystem()
    const broken = Object.create(fs) as MemoryFileSystem
    Object.defineProperty(broken, 'readdir', {
      value: async () => {
        throw new Error('EACCES')
      },
    })
    const result = await rebuildState(broken, '')
    expect(result.changes).toEqual([])
    expect(result.index).toBe(layout('').changesIndex)
  })
})
