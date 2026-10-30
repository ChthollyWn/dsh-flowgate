import { describe, expect, it } from 'vitest'
import { invalidateOnRework } from '../../../src/core/revision'
import type { ChangeStatus, TaskState } from '../../../src/core/types'
import { makeChange } from '../store/fixtures'

function task(id: string, status: TaskState['status'] = 'done'): TaskState {
  return {
    id,
    batch: id < 'T4' ? 'B1' : 'B2',
    status,
    tdd: 'none',
    evidenceIds: [`E-${id}`],
    reviewIds: [`R-${id}`],
  }
}

function changeWith(ids: string[], overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  const tasks: Record<string, TaskState> = {}
  for (const id of ids) tasks[id] = task(id)
  return makeChange({ tasks, stage: 'S4', ...overrides })
}

describe('invalidateOnRework', () => {
  it('缺陷返工：失效沿 depends_on 向下扩散，未受影响任务保留（T3.8 验收）', () => {
    const change = changeWith(['T1', 'T2', 'T3', 'T4', 'T5'])
    const result = invalidateOnRework(change, {
      kind: 'defect',
      taskIds: ['T2'],
      dependsOn: { T4: ['T2'], T5: ['T4'] },
    })
    expect(result.invalidatedTasks).toEqual(['T2', 'T4', 'T5'])
    expect(result.keptTasks).toEqual(['T1', 'T3'])
    expect(result.stage).toBe('S4')
  })

  it('共用输入变化通过 sharedInputsChanged 扩大范围', () => {
    const change = changeWith(['T1', 'T2', 'T3', 'T4'])
    const result = invalidateOnRework(change, {
      kind: 'defect',
      taskIds: ['T2'],
      sharedInputsChanged: ['T1'],
      dependsOn: { T3: ['T1'] },
    })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2', 'T3'])
    expect(result.keptTasks).toEqual(['T4'])
  })

  it('缺陷返工未指定任务时保守地全部失效', () => {
    const change = changeWith(['T1', 'T2'])
    const result = invalidateOnRework(change, { kind: 'defect' })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2'])
    expect(result.keptTasks).toEqual([])
  })

  it('需求变更：全部回执和审查失效，回到 S1', () => {
    const change = changeWith(['T1', 'T2'])
    const result = invalidateOnRework(change, { kind: 'requirement', taskIds: ['T1'] })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2'])
    expect(result.keptTasks).toEqual([])
    expect(result.stage).toBe('S1')
  })

  it('影响不明：全部失效，但阶段不擅自改变（由 engine 决定退回位置）', () => {
    const change = changeWith(['T1', 'T2'])
    const result = invalidateOnRework(change, { kind: 'unknown' })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2'])
    expect(result.keptTasks).toEqual([])
    expect(result.stage).toBe('S4')
  })

  it('依赖图里的未知任务/未知声明不会混入结果', () => {
    const change = changeWith(['T1', 'T2'])
    const result = invalidateOnRework(change, {
      kind: 'defect',
      taskIds: ['T9', 'T1'],
      dependsOn: { T2: ['T1'], T8: ['T1'] },
    })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2'])
  })

  it('任务编号自然排序（T2 在 T10 前）', () => {
    const change = changeWith(['T10', 'T2', 'T1'])
    const result = invalidateOnRework(change, { kind: 'requirement' })
    expect(result.invalidatedTasks).toEqual(['T1', 'T2', 'T10'])
  })

  it('没有任务时返回空集合', () => {
    const change = makeChange({ tasks: {} })
    expect(invalidateOnRework(change, { kind: 'defect' })).toEqual({
      invalidatedTasks: [],
      keptTasks: [],
      stage: 'S4',
    })
  })
})
