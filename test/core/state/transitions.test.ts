import { describe, expect, it } from 'vitest'
import { GATES, STAGES } from '../../../src/core/types'
import type { ChangeStatus, GateId, StageId } from '../../../src/core/types'
import { gateForStage, stageAfterGate } from '../../../src/core/state/stages'
import {
  applyGateApproved,
  applyGateAwaiting,
  applyGateFailed,
  applyGatePassed,
  applyGateRejected,
  applyVerificationFailure,
  enterStage,
  initialStatus,
  lockChange,
  transitionTable,
  unlockChange,
  validateGateSubmission,
} from '../../../src/core/state/transitions'
import { levelProfile } from '../../../src/core/state/levels'
import { AT, AT_LATER, makeChange, makeTaskState } from './fixtures'

function atStage(stage: StageId): ChangeStatus {
  return makeChange({ stage })
}

describe('state/transitions — 转移表', () => {
  it('has exactly the six pipeline gate transitions', () => {
    expect(transitionTable()).toEqual([
      { from: 'S0', event: 'G0', to: 'S1', kind: 'auto' },
      { from: 'S1', event: 'G1', to: 'S2', kind: 'human' },
      { from: 'S2', event: 'G2', to: 'S3', kind: 'auto' },
      { from: 'S3', event: 'G3', to: 'S4', kind: 'human' },
      { from: 'S5', event: 'G5', to: 'S6', kind: 'auto' },
      { from: 'S6', event: 'G6', to: 'archived', kind: 'human' },
    ])
  })

  it('returns a defensive copy', () => {
    const first = transitionTable()
    first[0]!.to = 'archived'
    expect(transitionTable()[0]!.to).toBe('S1')
  })

  // 数据驱动：每条合法转移都通过 validate + apply
  it('every legal transition validates and moves to the target stage', () => {
    for (const transition of transitionTable()) {
      const change = atStage(transition.from)
      const validation = validateGateSubmission(change, transition.event)
      expect(validation.ok, `${transition.from} -> ${transition.event}: ${validation.message}`).toBe(true)
      const next = applyGatePassed(change, transition.event, AT_LATER)
      expect(next.stage, `${transition.from} + ${transition.event}`).toBe(transition.to)
      expect(next.gates[transition.event]?.state).toBe('passed')
      expect(next.gates[transition.event]?.passedAt).toBe(AT_LATER)
      expect(next.updatedAt).toBe(AT_LATER)
      // purity: the original object is untouched
      expect(change.stage).toBe(transition.from)
    }
  })

  it('archives the change when G6 passes', () => {
    const next = applyGatePassed(atStage('S6'), 'G6', AT_LATER)
    expect(next.stage).toBe('archived')
    expect(next.lifecycle).toBe('archived')
  })

  // 数据驱动：每个非法转移都返回 ok:false
  it('rejects every illegal stage/gate combination', () => {
    const legal = new Set(transitionTable().map((transition) => `${transition.from}:${transition.event}`))
    legal.add('roadmap:GR')
    let illegalCount = 0
    for (const stage of STAGES) {
      for (const gate of GATES) {
        // TG / G4 are never submittable; a change is only valid at its own stage gate.
        const expected =
          stage === 'roadmap' ? gate === 'GR' : legal.has(`${stage}:${gate}`)
        const change = atStage(stage)
        const validation = validateGateSubmission(change, gate)
        if (!expected) illegalCount += 1
        expect(validation.ok, `${stage} submit ${gate}: ${validation.message}`).toBe(expected)
      }
    }
    // 9 stages x 9 gates = 81 combinations, only 7 can be submitted
    expect(illegalCount).toBe(81 - 7)
  })

  it('every transition in the table matches stageAfterGate', () => {
    for (const transition of transitionTable()) {
      expect(stageAfterGate(transition.event)).toBe(transition.to === 'archived' ? 'archived' : transition.to)
    }
  })

  it('every pipeline stage has a closing gate that is not submittable when it is automatic', () => {
    expect(gateForStage('S4')).toBe('G4')
    const validation = validateGateSubmission(atStage('S4'), 'G4')
    expect(validation.ok).toBe(false)
    expect(validation.message).toContain('自动判定')
  })
})

describe('state/transitions — 提交校验（T1.1）', () => {
  // GIVEN 当前在 S1 WHEN approve("G3") THEN 返回错误"当前待批准的是 G1"
  it('T1.1: at S1 approving G3 fails with "当前待批准的是 G1"', () => {
    const change = atStage('S1')
    const validation = validateGateSubmission(change, 'G3')
    expect(validation.ok).toBe(false)
    expect(validation.message).toContain('当前待批准的是 G1')
    expect(validation.message).toContain('不能批准 G3')
  })

  it('accepts the gate of the current stage only', () => {
    for (const stage of ['S0', 'S1', 'S2', 'S3', 'S5', 'S6'] as StageId[]) {
      const gate = gateForStage(stage)!
      expect(validateGateSubmission(atStage(stage), gate).ok, stage).toBe(true)
    }
  })

  it('refuses re-submission while a human gate is awaiting the owner', () => {
    const awaiting = applyGateAwaiting(atStage('S3'), 'G3', AT)
    const validation = validateGateSubmission(awaiting, 'G3')
    expect(validation.ok).toBe(false)
    expect(validation.message).toContain('已提交')
    expect(awaiting.stage).toBe('S3')
    expect(awaiting.gates.G3?.state).toBe('awaiting')
  })

  it('refuses submissions in locked mode and on archived changes', () => {
    const locked = lockChange(atStage('S1'), '账本第 5 行签名不符', AT)
    const lockedValidation = validateGateSubmission(locked, 'G1')
    expect(lockedValidation.ok).toBe(false)
    expect(lockedValidation.message).toContain('锁定模式')

    const archived = enterStage(atStage('S6'), 'archived', AT)
    const archivedValidation = validateGateSubmission(archived, 'G6')
    expect(archivedValidation.ok).toBe(false)
    expect(archivedValidation.message).toContain('已归档')
  })

  it('refuses the task gate and reports a stage without gates defensively', () => {
    expect(validateGateSubmission(atStage('S4'), 'TG').ok).toBe(false)
    const broken = { ...atStage('S0'), stage: 'idle' as StageId }
    const validation = validateGateSubmission(broken, 'G1')
    expect(validation.ok).toBe(false)
    expect(validation.message).toContain('没有可提交的门禁')
  })

  it('allows GR on the project roadmap stage and rejects other gates there', () => {
    expect(validateGateSubmission(atStage('roadmap'), 'GR').ok).toBe(true)
    const validation = validateGateSubmission(atStage('roadmap'), 'G1')
    expect(validation.ok).toBe(false)
    expect(validation.message).toContain('GR')
  })
})

describe('state/transitions — 门记录', () => {
  it('records failures, awaiting and rejection without moving the stage', () => {
    const failed = applyGateFailed(atStage('S3'), 'G3', AT_LATER, [
      { item: 'design.options', label: '设计方案对比', passed: false, hint: '补 2–3 个方案' },
    ])
    expect(failed.stage).toBe('S3')
    expect(failed.gates.G3?.state).toBe('failed')
    expect(failed.gates.G3?.items).toHaveLength(1)
    expect(failed.gates.G3?.attempts).toBe(1)

    const awaiting = applyGateAwaiting(failed, 'G3', AT_LATER)
    expect(awaiting.gates.G3?.state).toBe('awaiting')
    expect(awaiting.gates.G3?.submittedAt).toBe(AT_LATER)
    expect(awaiting.gates.G3?.attempts).toBe(2)

    const rejected = applyGateRejected(awaiting, 'G3', '方案对比不够具体', AT_LATER)
    expect(rejected.stage).toBe('S3')
    expect(rejected.gates.G3?.state).toBe('rejected')
    expect(rejected.gates.G3?.rejectedReason).toBe('方案对比不够具体')
    expect(rejected.gates.G3?.rejectedAt).toBe(AT_LATER)
  })

  it('increments attempts on top of an existing record', () => {
    const change = atStage('S0')
    change.gates.G0 = { state: 'pending', attempts: 2 }
    const next = applyGatePassed(change, 'G0', AT)
    expect(next.gates.G0?.attempts).toBe(3)
    expect(change.gates.G0?.attempts).toBe(2)
  })

  it('keeps the attempt history when a gate fails after an earlier submission', () => {
    const change = atStage('S3')
    change.gates.G3 = { state: 'failed', attempts: 2, submittedAt: AT }
    const failed = applyGateFailed(change, 'G3', AT_LATER, [
      { item: 'tasks.count', label: '任务数', passed: false },
    ])
    expect(failed.gates.G3?.attempts).toBe(3)
    expect(failed.gates.G3?.items).toHaveLength(1)
    expect(failed.gates.G3?.state).toBe('failed')
  })

  it('archives the change when G6 is approved by the owner', () => {
    const awaiting = applyGateAwaiting(atStage('S6'), 'G6', AT)
    const approved = applyGateApproved(awaiting, 'G6', AT_LATER)
    expect(approved.stage).toBe('archived')
    expect(approved.lifecycle).toBe('archived')
    expect(approved.gates.G6?.approvedAt).toBe(AT_LATER)
  })

  it('creates a default record when previous gate data is missing', () => {
    const change = { ...atStage('S5'), gates: {} }
    const passed = applyGatePassed(change, 'G5', AT)
    expect(passed.gates.G5?.attempts).toBe(1)
    const failed = applyGateFailed(change, 'G5', AT, [])
    expect(failed.gates.G5?.attempts).toBe(1)
    const rejected = applyGateRejected(change, 'G5', 'no', AT)
    expect(rejected.gates.G5?.attempts).toBe(1)
  })

  it('records G4 without moving the stage (engine calls enterStage afterwards)', () => {
    const next = applyGatePassed(atStage('S4'), 'G4', AT)
    expect(next.stage).toBe('S4')
    expect(next.gates.G4?.state).toBe('passed')
  })

  it('records GR without moving the stage', () => {
    const next = applyGateApproved(atStage('roadmap'), 'GR', AT)
    expect(next.stage).toBe('roadmap')
    expect(next.gates.GR?.state).toBe('passed')
    expect(next.gates.GR?.approvedAt).toBe(AT)
  })

  it('refuses to move the stage when a gate is applied at the wrong stage', () => {
    const next = applyGatePassed(atStage('S1'), 'G3', AT)
    expect(next.stage).toBe('S1')
    expect(next.gates.G3?.state).toBe('passed')
  })
})

describe('state/transitions — 人工批准与低复杂度合并（T2.8）', () => {
  it('ordinary human gate approval records approvedAt and advances', () => {
    const awaiting = applyGateAwaiting(atStage('S3'), 'G3', AT)
    const approved = applyGateApproved(awaiting, 'G3', AT_LATER)
    expect(approved.stage).toBe('S4')
    expect(approved.gates.G3?.approvedAt).toBe(AT_LATER)
    expect(approved.gates.G3?.state).toBe('passed')
    // medium complexity: G1 is not touched
    expect(approved.gates.G1).toBeUndefined()
  })

  it('low complexity: approving G3 also approves G1 (merged confirmation card)', () => {
    const merged = makeChange({ complexity: 'low', stage: 'S3' })
    merged.gates.G1 = { state: 'passed', attempts: 1 }
    const approved = applyGateApproved(merged, 'G3', AT_LATER)
    expect(approved.stage).toBe('S4')
    expect(approved.gates.G3?.approvedAt).toBe(AT_LATER)
    expect(approved.gates.G1?.state).toBe('passed')
    expect(approved.gates.G1?.approvedAt).toBe(AT_LATER)
    expect(levelProfile('low', 'normal').mergedGates).toBe(true)
  })

  it('low complexity merged approval also works when G1 has no record yet', () => {
    const merged = makeChange({ complexity: 'low', stage: 'S3' })
    const approved = applyGateApproved(merged, 'G3', AT_LATER)
    expect(approved.gates.G1?.state).toBe('passed')
    expect(approved.gates.G1?.approvedAt).toBe(AT_LATER)
    expect(approved.gates.G1?.attempts).toBe(1)
  })

  it('T2.8: low complexity fast lane asks the owner exactly twice (G3 merged card + G6)', () => {
    // S0 -> G0 auto -> S1
    let change = applyGatePassed(
      initialStatus({
        id: 'C-010',
        kind: 'change',
        title: '改文案',
        complexity: 'low',
        risk: 'normal',
        at: AT,
      }),
      'G0',
      AT,
    )
    expect(change.stage).toBe('S1')

    // S1: G1 checks pass but do not wait for the owner
    change = applyGatePassed(change, 'G1', AT)
    expect(change.stage).toBe('S2')

    // S2 auto -> S3
    change = applyGatePassed(change, 'G2', AT)
    expect(change.stage).toBe('S3')

    // G3: merged confirmation card awaits the owner
    change = applyGateAwaiting(change, 'G3', AT)
    expect(change.gates.G3?.state).toBe('awaiting')
    expect(validateGateSubmission(change, 'G3').ok).toBe(false)

    let ownerConfirmations = 0
    change = applyGateApproved(change, 'G3', AT_LATER)
    ownerConfirmations += 1
    expect(change.stage).toBe('S4')
    expect(change.gates.G1?.approvedAt).toBe(AT_LATER) // merged: G1 recorded too

    // S4: all tasks passed -> G4 recorded, engine advances
    change = applyGatePassed(change, 'G4', AT_LATER)
    change = enterStage(change, 'S5', AT_LATER)
    expect(change.stage).toBe('S5')

    // S5 -> G5 auto -> S6
    change = applyGatePassed(change, 'G5', AT_LATER)
    expect(change.stage).toBe('S6')

    // G6: second and last owner confirmation
    change = applyGateAwaiting(change, 'G6', AT_LATER)
    change = applyGateApproved(change, 'G6', AT_LATER)
    ownerConfirmations += 1
    expect(change.stage).toBe('archived')
    expect(ownerConfirmations).toBe(2)
  })

  it('T2.8: raising complexity sends the owner back to S1 and un-merges the gates', () => {
    let change = makeChange({ complexity: 'low', stage: 'S3' })
    change = applyGateRejected(change, 'G3', '改成中复杂度', AT_LATER)
    expect(change.stage).toBe('S3')
    // the owner raises complexity and the agent goes back to S1 to fill the six elements
    change = { ...change, complexity: 'medium' }
    change = enterStage(change, 'S1', AT_LATER)
    expect(change.stage).toBe('S1')
    const profile = levelProfile(change.complexity, change.risk)
    expect(profile.mergedGates).toBe(false)
    expect(profile.requiresRiskDoc).toBe(true)
    // now G1 is a standalone human gate again
    expect(validateGateSubmission(change, 'G1').ok).toBe(true)
  })
})

describe('state/transitions — 验证失败与修复任务（T1.1）', () => {
  // GIVEN S5 验证失败 WHEN 处理失败结果 THEN 回到 S4，并生成一个修复任务，其范围只包含失败涉及的文件和测试
  it('T1.1: S5 failure returns to S4 and drafts a repair task scoped to the failed files/tests', () => {
    const change = atStage('S5')
    const { change: next, tasks } = applyVerificationFailure(
      change,
      [
        {
          name: 'RenewalPriceTest',
          files: ['src/main/java/com/acme/renewal/RenewalService.java', './src/main/java/com/acme/renewal/RenewalService.java'],
          tests: ['src/test/java/com/acme/renewal/RenewalPriceTest.java'],
        },
      ],
      AT_LATER,
    )
    expect(next.stage).toBe('S4')
    expect(tasks).toHaveLength(1)
    const repair = tasks[0]!
    expect(repair.id).toBe('FIX-1')
    expect(repair.title).toContain('RenewalPriceTest')
    expect(repair.scope).toEqual(['src/main/java/com/acme/renewal/RenewalService.java'])
    expect(repair.tests).toEqual(['src/test/java/com/acme/renewal/RenewalPriceTest.java'])
    expect(repair.newFiles).toEqual([])
    expect(repair.changes).toEqual([])
    expect(repair.tdd).toBe('required')
    expect(repair.size).toBe('S')
    expect(repair.body).toContain('RED')
  })

  it('creates one repair task per failure and sizes them by file count', () => {
    const change = makeChange({ stage: 'S5', risk: 'high' })
    const { tasks } = applyVerificationFailure(
      change,
      [
        { name: 'A', files: ['a.ts', 'b.ts', 'c.ts', ''], tests: ['a.test.ts', ''] },
        {
          name: 'B',
          files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
          tests: ['a.test.ts', 'b.test.ts'],
        },
      ],
      AT,
    )
    expect(tasks.map((task) => task.id)).toEqual(['FIX-1', 'FIX-2'])
    expect(tasks[0]!.size).toBe('M')
    expect(tasks[1]!.size).toBe('L')
    expect(tasks[1]!.risk).toEqual(['验证回归'])
    expect(tasks[1]!.covers).toEqual([])
  })
})

describe('state/transitions — 初始状态与锁定模式', () => {
  it('initial status starts in S0 with G0 pending and empty collections', () => {
    const status = initialStatus({
      id: 'C-001',
      kind: 'change',
      title: '会员续费',
      summary: '一句话目标',
      complexity: 'medium',
      risk: 'high',
      at: AT,
    })
    expect(status.stage).toBe('S0')
    expect(status.lifecycle).toBe('active')
    expect(status.gates).toEqual({ G0: { state: 'pending', attempts: 0 } })
    expect(status.batches).toEqual([])
    expect(status.tasks).toEqual({})
    expect(status.evidenceIds).toEqual([])
    expect(status.pending).toEqual([])
    expect(status.overrides).toEqual([])
    expect(status.exceptions).toEqual([])
    expect(status.violations).toEqual([])
    expect(status.reviews).toEqual([])
    expect(status.createdAt).toBe(AT)
    expect(status.updatedAt).toBe(AT)
    expect(status.clarifyRounds).toBe(0)
    expect(status.summary).toBe('一句话目标')
    // engine convenience inputs are accepted but ignored
    expect('config' in status).toBe(false)
    expect('pluginVersion' in status).toBe(false)
  })

  it('initial status carries the frozen contract snapshot when provided', () => {
    const contract = {
      plugin: '0.6.0',
      rules: 'sha256:rules',
      levels: 'sha256:levels',
      skills: { 'flow-plan': 'sha256:skill' },
      createdAt: AT,
    }
    const status = initialStatus({
      id: 'C-002',
      kind: 'change',
      title: '会员续费',
      complexity: 'medium',
      risk: 'normal',
      at: AT,
      contract,
    })
    expect(status.contract).toEqual(contract)
  })

  it('initial status honours stage and optional metadata', () => {
    const status = initialStatus({
      id: 'PROJECT',
      kind: 'change',
      title: '新项目',
      complexity: 'medium',
      risk: 'normal',
      at: AT,
      stage: 'roadmap',
      branch: 'flowgate/C-001',
      roadmap: 'C1',
      relatedTo: 'A-002',
      batches: [{ id: 'B1', mode: 'sequential', status: 'pending', tasks: ['T1'] }],
      tasks: { T1: makeTaskState({ id: 'T1' }) },
      plan: { batches: [{ batch: 'B1', mode: 'sequential', tasks: ['T1'], why: '顺序' }] },
    })
    expect(status.stage).toBe('roadmap')
    expect(status.branch).toBe('flowgate/C-001')
    expect(status.roadmap).toBe('C1')
    expect(status.relatedTo).toBe('A-002')
    expect(status.batches).toHaveLength(1)
    expect(status.tasks.T1?.id).toBe('T1')
    expect(status.plan?.batches[0]?.batch).toBe('B1')
  })

  it('locks and unlocks a change, remembering the reason', () => {
    const locked = lockChange(atStage('S4'), '账本校验失败', AT, '第 5 行签名不符')
    expect(locked.lifecycle).toBe('locked')
    expect(locked.lock).toEqual({ reason: '账本校验失败', at: AT, detail: '第 5 行签名不符' })
    expect(locked.stage).toBe('S4')
    expect('detail' in (lockChange(atStage('S4'), 'x', AT).lock ?? {})).toBe(false)

    const unlocked = unlockChange(locked, AT_LATER)
    expect(unlocked.lifecycle).toBe('active')
    expect(unlocked.lock).toBeUndefined()
    expect(unlocked.stage).toBe('S4')

    const archived = enterStage(atStage('S6'), 'archived', AT)
    expect(unlockChange(archived, AT_LATER).lifecycle).toBe('archived')
  })

  it('enterStage toggles archived lifecycle both ways', () => {
    const archived = enterStage(atStage('S6'), 'archived', AT)
    expect(archived.lifecycle).toBe('archived')
    const revived = enterStage(archived, 'S1', AT_LATER)
    expect(revived.lifecycle).toBe('active')
    expect(revived.stage).toBe('S1')
  })

  it('never mutates the input object', () => {
    const change = atStage('S1')
    const snapshot = JSON.stringify(change)
    applyGatePassed(change, 'G1', AT)
    applyGateFailed(change, 'G1', AT, [])
    applyGateAwaiting(change, 'G1', AT)
    applyGateApproved(change, 'G1', AT)
    applyGateRejected(change, 'G1', 'no', AT)
    enterStage(change, 'S2', AT)
    lockChange(change, 'x', AT)
    unlockChange(change, AT)
    expect(JSON.stringify(change)).toBe(snapshot)
  })
})
