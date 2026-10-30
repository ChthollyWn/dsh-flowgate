import { describe, expect, it } from 'vitest'
import { STAGES } from '../../../src/core/types'
import type { GateId, StageId } from '../../../src/core/types'
import {
  STAGE_DESCRIPTIONS,
  STAGE_LABELS,
  STAGE_ORDER,
  gateForStage,
  humanGate,
  nextStage,
  stageAfterGate,
  stageIndex,
  stageLabel,
} from '../../../src/core/state/stages'

describe('state/stages', () => {
  it('STAGE_ORDER is the seven pipeline stages in order', () => {
    expect(STAGE_ORDER).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'])
  })

  it('labels and descriptions cover every StageId', () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage], `label ${stage}`).toBeTruthy()
      expect(STAGE_DESCRIPTIONS[stage]?.what, `what ${stage}`).toBeTruthy()
      expect(STAGE_DESCRIPTIONS[stage]?.why, `why ${stage}`).toBeTruthy()
    }
    expect(STAGE_LABELS.S0).toBe('立项')
    expect(STAGE_LABELS.S1).toBe('需求澄清')
    expect(stageLabel('S3')).toBe('S3 设计拆解')
  })

  it('stageIndex orders pipeline stages and places roadmap / archived outside', () => {
    expect(stageIndex('S0')).toBe(0)
    expect(stageIndex('S3')).toBe(3)
    expect(stageIndex('S6')).toBe(6)
    expect(stageIndex('roadmap')).toBe(-1)
    expect(stageIndex('archived')).toBe(STAGE_ORDER.length)
  })

  it('nextStage walks S0..S6 then archived', () => {
    const chain: StageId[] = []
    let current: StageId | null = 'S0'
    while (current !== null) {
      chain.push(current)
      current = nextStage(current)
    }
    expect(chain).toEqual([...STAGE_ORDER, 'archived'])
    expect(nextStage('roadmap')).toBeNull()
    expect(nextStage('archived')).toBeNull()
  })

  it('stageAfterGate maps submitted stage gates; G4/TG/GR are not stage transitions', () => {
    expect(stageAfterGate('G0')).toBe('S1')
    expect(stageAfterGate('G1')).toBe('S2')
    expect(stageAfterGate('G2')).toBe('S3')
    expect(stageAfterGate('G3')).toBe('S4')
    expect(stageAfterGate('G5')).toBe('S6')
    expect(stageAfterGate('G6')).toBe('archived')
    expect(stageAfterGate('G4')).toBeNull()
    expect(stageAfterGate('TG')).toBeNull()
    expect(stageAfterGate('GR')).toBeNull()
  })

  it('gateForStage maps each stage to its closing gate', () => {
    expect(gateForStage('S0')).toBe('G0')
    expect(gateForStage('S1')).toBe('G1')
    expect(gateForStage('S2')).toBe('G2')
    expect(gateForStage('S3')).toBe('G3')
    expect(gateForStage('S4')).toBe('G4')
    expect(gateForStage('S5')).toBe('G5')
    expect(gateForStage('S6')).toBe('G6')
    expect(gateForStage('roadmap')).toBe('GR')
    expect(gateForStage('archived')).toBeNull()
  })

  it('humanGate only marks the owner-approval gates', () => {
    expect(humanGate('roadmap')).toBe('GR')
    expect(humanGate('S1')).toBe('G1')
    expect(humanGate('S3')).toBe('G3')
    expect(humanGate('S6')).toBe('G6')
    const autoStages: StageId[] = ['S0', 'S2', 'S4', 'S5', 'archived']
    for (const stage of autoStages) {
      expect(humanGate(stage), stage).toBeNull()
    }
  })

  it('every stage has exactly one closing gate (except archived)', () => {
    const gates = new Set<GateId>()
    for (const stage of STAGE_ORDER) {
      const gate = gateForStage(stage)
      expect(gate, stage).not.toBeNull()
      expect(gates.has(gate!), `duplicate gate ${gate}`).toBe(false)
      gates.add(gate!)
    }
  })
})
