import { describe, expect, it } from 'vitest'
import { riskRaisedEffects, riskTriggerPending } from '../../../src/core/risk'
import type { ChangeStatus, TaskState } from '../../../src/core/types'
import { makeChange } from '../store/fixtures'

function task(id: string, status: TaskState['status']): TaskState {
  return { id, batch: 'B1', status, tdd: 'none', evidenceIds: [], reviewIds: [] }
}

function changeWithTasks(tasks: TaskState[], overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  const map: Record<string, TaskState> = {}
  for (const item of tasks) map[item.id] = item
  return makeChange({ tasks: map, ...overrides })
}

describe('riskRaisedEffects', () => {
  it('S4 风险提高：已完成任务的审查重新要求，阶段不变', () => {
    const change = changeWithTasks(
      [task('T1', 'done'), task('T2', 'running'), task('T3', 'done'), task('T4', 'pending')],
      { stage: 'S4', risk: 'high' },
    )
    const effects = riskRaisedEffects(change)
    expect(effects.refreezeReviews).toEqual(['T1', 'T3'])
    expect(effects.backToStage).toBeUndefined()
  })

  it('已进入 S5 的退回 S4（回执保留由 engine 处理）', () => {
    const change = changeWithTasks([task('T1', 'done')], { stage: 'S5', risk: 'high' })
    expect(riskRaisedEffects(change)).toEqual({ refreezeReviews: ['T1'], backToStage: 'S4' })
  })

  it('已进入 S6 的退回 S4', () => {
    const change = changeWithTasks([task('T1', 'done'), task('T2', 'done')], { stage: 'S6', risk: 'high' })
    const effects = riskRaisedEffects(change)
    expect(effects.backToStage).toBe('S4')
    expect(effects.refreezeReviews).toEqual(['T1', 'T2'])
  })

  it('S3 之前不改变阶段', () => {
    const change = changeWithTasks([], { stage: 'S3', risk: 'high' })
    expect(riskRaisedEffects(change)).toEqual({ refreezeReviews: [] })
  })

  it('任务编号自然排序（T2 在 T10 前）', () => {
    const change = changeWithTasks([task('T10', 'done'), task('T2', 'done')], { stage: 'S4' })
    expect(riskRaisedEffects(change).refreezeReviews).toEqual(['T2', 'T10'])
  })
})

describe('riskTriggerPending', () => {
  it('生成待处理项草稿：kind=risk、带动作指纹与结构化数据', () => {
    const draft = riskTriggerPending(
      {
        trigger: 'dependency-change',
        decision: 'human',
        title: '依赖变更：新增 spring-boot-starter-security',
        detail: 'pom.xml 的依赖段发生变化，需要负责人确认供应链与许可证。',
        fingerprint: 'sha256:abc',
      },
      'C-003',
      '2026-11-12T10:31:05+08:00',
    )
    expect(draft).toEqual({
      kind: 'risk',
      title: '依赖变更：新增 spring-boot-starter-security',
      detail: 'pom.xml 的依赖段发生变化，需要负责人确认供应链与许可证。',
      actionFingerprint: 'sha256:abc',
      data: {
        trigger: 'dependency-change',
        decision: 'human',
        changeId: 'C-003',
        raisedAt: '2026-11-12T10:31:05+08:00',
      },
    })
  })

  it('缺少标题/详情时用触发器信息兜底', () => {
    const draft = riskTriggerPending(
      { trigger: 'sensitive-path', decision: 'human', title: '', detail: '' },
      'C-001',
      '2026-11-12T10:00:00+08:00',
    )
    expect(draft.title).toContain('sensitive-path')
    expect(draft.detail).toContain('sensitive-path')
    expect(draft.actionFingerprint).toBeUndefined()
  })
})
