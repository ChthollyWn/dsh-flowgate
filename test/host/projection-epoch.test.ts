/**
 * 会话投影的进程 epoch（真实 Web 宿主走查发现的 UI 陈旧 bug，2026-10-31）：
 *
 * 宿主重启后 `runtime.revisionValue` 从 0 重新计数，但会话日志里旧进程写入的
 * 插件记录 revision 可能已经到 10+；投影 apply 的 revision 单调保护会把重启后
 * 的 revision 1/2/3 全部丢弃，面板与状态条停留在重启前的快照（真实复现：
 * 重启后更新 specs/spec.md，低复杂度确认卡的验收场景仍是旧值）。
 *
 * 修复：投影记录带宿主进程 epoch；epoch 不同的记录视为"新进程记录"直接接受，
 * 同一 epoch 内仍按 revision 单调去重。
 */
import { describe, expect, it } from 'vitest'

import { createFlowgateProjection, sanitizeProjection, PROJECTION_KEY } from '../../src/host/projection/index.js'
import type { FlowgateProjection } from '../../src/host/projection/types.js'
import { STATE_RECORD_TYPE } from '../../src/host/adapters/session-record.js'

const NOW = '2026-10-31T11:00:00+08:00'

function snapshotOf(marker: string): FlowgateProjection['snapshot'] {
  return {
    initialized: true,
    pipeline: [],
    tasks: {},
    batches: [],
    pending: [],
    violations: [],
    off: false,
    locked: false,
    interceptCounts: {},
    nextStep: marker,
    statusLine: marker,
    updatedAt: NOW,
  }
}

function record(revision: number, epoch?: string): { type: string; data: FlowgateProjection } {
  const projection: FlowgateProjection = {
    snapshot: snapshotOf(`rev-${revision}-${epoch ?? 'legacy'}`),
    revision,
    updatedAt: NOW,
    ...(epoch ? { epoch } : {}),
  }
  return { type: STATE_RECORD_TYPE, data: projection }
}

describe('projection epoch：宿主重启后的 revision 回退', () => {
  it('旧进程记录先回放（revision 1..10），新进程 epoch 的 revision 1 仍然被接受', () => {
    const projection = createFlowgateProjection(() => NOW)
    let state = projection.init()
    for (let revision = 1; revision <= 10; revision += 1) {
      state = projection.apply(state, record(revision, 'old-process'))
    }
    expect(state.revision).toBe(10)

    state = projection.apply(state, record(1, 'new-process'))
    expect(state.revision).toBe(1)
    expect(state.epoch).toBe('new-process')
    expect(state.snapshot.nextStep).toBe('rev-1-new-process')
  })

  it('同一 epoch 内仍按 revision 单调去重（乱序/重复事件被忽略）', () => {
    const projection = createFlowgateProjection(() => NOW)
    let state = projection.init()
    state = projection.apply(state, record(3, 'p1'))
    state = projection.apply(state, record(5, 'p1'))
    expect(state.revision).toBe(5)

    const outOfOrder = projection.apply(state, record(4, 'p1'))
    expect(outOfOrder.revision).toBe(5)
    expect(outOfOrder.snapshot.nextStep).toBe('rev-5-p1')
  })

  it('没有 epoch 的旧记录（旧插件版本）保持原 revision 单调语义', () => {
    const projection = createFlowgateProjection(() => NOW)
    let state = projection.init()
    state = projection.apply(state, record(2))
    state = projection.apply(state, record(7))
    expect(state.revision).toBe(7)
    const stale = projection.apply(state, record(3))
    expect(stale.revision).toBe(7)
  })

  it('latest() 兜底同样按 epoch 判断：新进程的低 revision 内存快照不会被旧 checkpoint 挡住', () => {
    let latestValue: FlowgateProjection | undefined
    const projection = createFlowgateProjection(() => NOW, () => latestValue)
    let state = projection.init()
    for (let revision = 1; revision <= 6; revision += 1) state = projection.apply(state, record(revision, 'old'))
    expect(state.revision).toBe(6)

    latestValue = {
      snapshot: snapshotOf('fresh-new-process'),
      revision: 1,
      updatedAt: NOW,
      epoch: 'new',
    }
    // 非插件记录事件命中兜底分支。
    state = projection.apply(state, { type: 'some-other-event', data: {} })
    expect(state.epoch).toBe('new')
    expect(state.revision).toBe(1)
    expect(state.snapshot.nextStep).toBe('fresh-new-process')
  })

  it('sanitizeProjection 保留 epoch，非法 epoch 被忽略', () => {
    const kept = sanitizeProjection({ snapshot: snapshotOf('x'), revision: 2, updatedAt: NOW, epoch: 'abc' })
    expect(kept?.epoch).toBe('abc')
    const dropped = sanitizeProjection({ snapshot: snapshotOf('x'), revision: 2, updatedAt: NOW, epoch: 42 })
    expect(dropped?.epoch).toBeUndefined()
  })

  it('投影 key 不变（客户端 useProjection 契约）', () => {
    const projection = createFlowgateProjection(() => NOW)
    expect(projection.key).toBe(PROJECTION_KEY)
  })
})
