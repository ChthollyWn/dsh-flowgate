/**
 * Pipeline stage definitions.
 *
 * Stages are data: the order, the labels shown to the owner, the gate that
 * closes each stage and the human gates that need the owner's confirmation.
 * Everything here is a pure function over constant data, so the state machine
 * can be replayed deterministically in tests.
 */
import type { GateId, HumanGateId, StageId } from '../types'

/** The seven pipeline stages, excluding the project-level `roadmap` and the terminal `archived`. */
export const STAGE_ORDER: StageId[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']

export const STAGE_LABELS: Record<StageId, string> = {
  roadmap: '项目路线图',
  S0: '立项',
  S1: '需求澄清',
  S2: '上下文',
  S3: '设计拆解',
  S4: '执行',
  S5: '验证',
  S6: '交付',
  archived: '已归档',
}

export const STAGE_DESCRIPTIONS: Record<StageId, { what: string; why: string }> = {
  roadmap: {
    what: '把项目拆成能独立验收的能力变更，标出 MVP 切线，交付第一项固定是工程骨架。',
    why: '先有全局地图再动代码，避免边做边改方向、能力重复或遗漏。',
  },
  S0: {
    what: '创建立项记录，建议复杂度与风险，冻结本次变更生效的规则契约。',
    why: '立项先定边界和流程等级，之后所有判定都按同一份契约执行。',
  },
  S1: {
    what: '先挖后问：读项目与规格，闭合六要素，写 proposal 与增量规格。',
    why: '需求没定清楚，后面代码写得越快偏得越远。',
  },
  S2: {
    what: '组织项目级与变更级上下文，跑一次基线测试并记录结果。',
    why: '基线是判断"有没有回归"的唯一依据。',
  },
  S3: {
    what: '写设计（按复杂度）、风险登记、任务卡与执行计划。',
    why: '先定怎么做、有哪些风险、谁先谁后，再动手写代码。',
  },
  S4: {
    what: '按执行图逐任务实现：TDD、插件执行的验证回执、任务范围控制、独立审查。',
    why: '一次只做一张任务卡，改动可回滚、证据可追溯。',
  },
  S5: {
    what: '全量验证：相对基线无回归、验收场景有证据、按风险补运行证据与安全审查。',
    why: '用插件执行出来的证据证明完成，而不是 agent 口头声称完成。',
  },
  S6: {
    what: '终审、交付清单、手工证据确认，通过 G6 后归档并建议开新会话。',
    why: '交付有清单、风险有确认、过程有留痕，便于复盘与交接。',
  },
  archived: {
    what: '变更已归档，产物与证据只读，供复盘、指标和看板使用。',
    why: '冻结结束时的完整状态，事后不会因为继续改动而失真。',
  },
}

/** Convenience label helper for messages: `S3 设计拆解`. */
export function stageLabel(stage: StageId): string {
  return `${stage} ${STAGE_LABELS[stage]}`
}

/**
 * Ordering index of a pipeline stage: `S0` -> 0 ... `S6` -> 6.
 * `roadmap` is before the pipeline (-1); `archived` is after it (STAGE_ORDER.length).
 */
export function stageIndex(stage: StageId): number {
  const index = STAGE_ORDER.indexOf(stage)
  if (index >= 0) return index
  return stage === 'roadmap' ? -1 : STAGE_ORDER.length
}

/** Next pipeline stage. `S6` -> `archived`; `roadmap`/`archived` have no automatic successor. */
export function nextStage(stage: StageId): StageId | null {
  if (stage === 'roadmap' || stage === 'archived') return null
  const index = STAGE_ORDER.indexOf(stage)
  if (index < 0) return null
  const next = STAGE_ORDER[index + 1]
  return next ?? 'archived'
}

const GATE_TO_STAGE: Partial<Record<GateId, StageId>> = {
  G0: 'S1',
  G1: 'S2',
  G2: 'S3',
  G3: 'S4',
  G5: 'S6',
  G6: 'archived',
}

/**
 * Stage entered after a gate passes. `TG` (task gate) and `G4` (all tasks done)
 * are automatic aggregate gates handled by the engine, not stage transitions,
 * so they return `null`. `GR` is the project-level roadmap gate and does not
 * move a change into the pipeline (`null`).
 */
export function stageAfterGate(gate: GateId): StageId | null {
  return GATE_TO_STAGE[gate] ?? null
}

const STAGE_TO_GATE: Partial<Record<StageId, GateId>> = {
  roadmap: 'GR',
  S0: 'G0',
  S1: 'G1',
  S2: 'G2',
  S3: 'G3',
  S4: 'G4',
  S5: 'G5',
  S6: 'G6',
}

/** Gate that closes a stage; `archived` has none. */
export function gateForStage(stage: StageId): GateId | null {
  return STAGE_TO_GATE[stage] ?? null
}

/** Human gate that needs the owner's approval at the end of the stage. */
export function humanGate(stage: StageId): HumanGateId | null {
  switch (stage) {
    case 'roadmap':
      return 'GR'
    case 'S1':
      return 'G1'
    case 'S3':
      return 'G3'
    case 'S6':
      return 'G6'
    default:
      return null
  }
}
