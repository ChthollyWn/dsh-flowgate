/**
 * Change state machine.
 *
 * All functions are pure: they return a new `ChangeStatus` and never mutate the
 * input. Gate transitions are data (`transitionTable`), the rest are total
 * functions over the small state space. The engine persists the returned object.
 */
import type {
  BatchState,
  CheckOutcome,
  ChangeKind,
  ChangeLifecycle,
  ChangeStatus,
  Complexity,
  ContractSnapshot,
  ExecutionPlan,
  FlowgateConfig,
  GateId,
  GateRecord,
  RiskLevel,
  StageId,
  TaskCard,
  TaskState,
} from '../types'
import { normalizeRelPath } from '../util/paths'
import { STAGE_LABELS, gateForStage, stageAfterGate } from './stages'

/**
 * Input for `initialStatus`.
 *
 * Note: this interface lives here (not in `src/core/types.ts`) because the shared
 * types file is owned by the Lead; the shape is structurally compatible, so the
 * engine can pass its own object literal. `config`/`pluginVersion`/`skills` are
 * accepted for convenience but ignored by the state machine.
 */
export interface ChangeStatusInitInput {
  id: string
  kind: ChangeKind
  title: string
  summary?: string
  complexity: Complexity
  risk: RiskLevel
  /** Creation time, ISO-8601 with offset. Required so results are deterministic. */
  at: string
  stage?: StageId
  contract?: ContractSnapshot
  branch?: string
  roadmap?: string
  relatedTo?: string
  batches?: BatchState[]
  tasks?: Record<string, TaskState>
  plan?: ExecutionPlan
  // Accepted for engine convenience; the state machine does not use them.
  config?: FlowgateConfig
  pluginVersion?: string
  skills?: Record<string, string>
}

export interface TransitionDef {
  from: StageId
  event: GateId
  to: StageId
  kind: 'auto' | 'human'
}

const TRANSITIONS: TransitionDef[] = [
  { from: 'S0', event: 'G0', to: 'S1', kind: 'auto' },
  { from: 'S1', event: 'G1', to: 'S2', kind: 'human' },
  { from: 'S2', event: 'G2', to: 'S3', kind: 'auto' },
  { from: 'S3', event: 'G3', to: 'S4', kind: 'human' },
  { from: 'S5', event: 'G5', to: 'S6', kind: 'auto' },
  { from: 'S6', event: 'G6', to: 'archived', kind: 'human' },
]

/**
 * Gate transitions of the pipeline (S0..S6). `GR` is project-level, `TG` is the
 * per-task gate and `G4` is the aggregate "all tasks passed" gate handled by the
 * engine (`applyGatePassed` records it but does not move the stage).
 */
export function transitionTable(): TransitionDef[] {
  return TRANSITIONS.map((transition) => ({ ...transition }))
}

function transitionFor(from: StageId, event: GateId): TransitionDef | undefined {
  return TRANSITIONS.find((transition) => transition.from === from && transition.event === event)
}

function cloneChange(change: ChangeStatus): ChangeStatus {
  return { ...change, gates: { ...change.gates }, tasks: { ...change.tasks } }
}

function gateRecord(record: GateRecord | undefined): GateRecord {
  return record ? { ...record } : { state: 'pending', attempts: 0 }
}

/** Fresh change in S0 with G0 pending. */
export function initialStatus(input: ChangeStatusInitInput): ChangeStatus {
  const status: ChangeStatus = {
    id: input.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    complexity: input.complexity,
    risk: input.risk,
    stage: input.stage ?? 'S0',
    lifecycle: 'active',
    gates: { G0: { state: 'pending', attempts: 0 } },
    branch: input.branch,
    batches: input.batches ? input.batches.map((batch) => ({ ...batch })) : [],
    tasks: input.tasks ?? {},
    evidenceIds: [],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [],
    createdAt: input.at,
    updatedAt: input.at,
    clarifyRounds: 0,
  }
  if (input.contract) status.contract = input.contract
  if (input.roadmap) status.roadmap = input.roadmap
  if (input.relatedTo) status.relatedTo = input.relatedTo
  if (input.plan) status.plan = input.plan
  return status
}

/**
 * Which gate may be submitted right now. Refuses submissions in locked mode and
 * on archived changes, and refuses the automatic `TG`/`G4` gates.
 */
export function validateGateSubmission(
  change: ChangeStatus,
  gate: GateId,
): { ok: boolean; message: string } {
  if (change.lifecycle === 'locked') {
    return {
      ok: false,
      message: `变更 ${change.id} 处于锁定模式（${change.lock?.reason ?? '状态损坏或被篡改'}），不能提交门禁；请负责人执行 /flow repair 后再试。`,
    }
  }
  if (change.stage === 'archived') {
    return { ok: false, message: `变更 ${change.id} 已归档，不能再提交门禁。` }
  }
  if (gate === 'TG') {
    return { ok: false, message: '任务门 TG 由插件在每个任务完成时自动判定（flow_task_done），不需要提交。' }
  }
  if (gate === 'G4') {
    return { ok: false, message: 'G4 由插件在全部任务通过任务门后自动判定，不需要提交。' }
  }
  if (change.stage === 'roadmap') {
    if (gate === 'GR') {
      return { ok: true, message: '可以提交 GR；检查通过后等负责人批准路线图。' }
    }
    return {
      ok: false,
      message: `当前待批准的是 GR（项目路线图批准），不能提交 ${gate}；请先完成路线图与项目级澄清。`,
    }
  }
  const expected = gateForStage(change.stage)
  if (expected === null) {
    return { ok: false, message: `当前阶段 ${STAGE_LABELS[change.stage]} 没有可提交的门禁。` }
  }
  if (change.gates[gate]?.state === 'awaiting') {
    return {
      ok: false,
      message: `${gate} 已提交，正等负责人批准或退回，不要重复提交；用 flow_status 查看待处理项。`,
    }
  }
  if (gate !== expected) {
    return {
      ok: false,
      message: `当前待批准的是 ${expected}（${STAGE_LABELS[change.stage]}阶段的出口门），不能批准 ${gate}；请先完成本阶段产物并提交 ${expected}。`,
    }
  }
  return { ok: true, message: `可以提交 ${expected}。` }
}

/**
 * Record a passed gate and move to the next stage when the gate is a stage gate.
 * `G4` only records the gate (the engine advances with `enterStage(change,'S5')`);
 * `GR` only records the project-level approval.
 */
export function applyGatePassed(change: ChangeStatus, gate: GateId, at: string): ChangeStatus {
  const next = cloneChange(change)
  const previous = gateRecord(next.gates[gate])
  next.gates[gate] = {
    ...previous,
    state: 'passed',
    passedAt: at,
    attempts: previous.attempts + 1,
  }
  const transition = transitionFor(next.stage, gate)
  if (transition) {
    next.stage = transition.to
    if (transition.to === 'archived') next.lifecycle = 'archived'
  }
  next.updatedAt = at
  return next
}

export function applyGateFailed(
  change: ChangeStatus,
  gate: GateId,
  at: string,
  failures: CheckOutcome[],
): ChangeStatus {
  const next = cloneChange(change)
  const previous = gateRecord(next.gates[gate])
  next.gates[gate] = {
    ...previous,
    state: 'failed',
    items: failures.map((failure) => ({ ...failure })),
    attempts: previous.attempts + 1,
  }
  next.updatedAt = at
  return next
}

/** Checks passed but a human gate needs the owner; the stage does not move yet. */
export function applyGateAwaiting(change: ChangeStatus, gate: GateId, at: string): ChangeStatus {
  const next = cloneChange(change)
  const previous = gateRecord(next.gates[gate])
  next.gates[gate] = {
    ...previous,
    state: 'awaiting',
    submittedAt: at,
    attempts: previous.attempts + 1,
  }
  next.updatedAt = at
  return next
}

/**
 * Owner approved a human gate: record `approvedAt` and advance.
 * Low complexity merges G1 and G3: approving G3 also records G1 as approved.
 */
export function applyGateApproved(change: ChangeStatus, gate: GateId, at: string): ChangeStatus {
  const next = cloneChange(change)
  const previous = gateRecord(next.gates[gate])
  next.gates[gate] = {
    ...previous,
    state: 'passed',
    approvedAt: previous.approvedAt ?? at,
    attempts: Math.max(previous.attempts, 1),
  }
  if (gate === 'G3' && next.complexity === 'low') {
    const g1 = gateRecord(next.gates.G1)
    next.gates.G1 = {
      ...g1,
      state: 'passed',
      approvedAt: g1.approvedAt ?? at,
      attempts: Math.max(g1.attempts, 1),
    }
  }
  const transition = transitionFor(next.stage, gate)
  if (transition) {
    next.stage = transition.to
    if (transition.to === 'archived') next.lifecycle = 'archived'
  }
  next.updatedAt = at
  return next
}

/** Owner rejected a human gate: stay in the stage, remember the reason for the agent. */
export function applyGateRejected(
  change: ChangeStatus,
  gate: GateId,
  reason: string,
  at: string,
): ChangeStatus {
  const next = cloneChange(change)
  const previous = gateRecord(next.gates[gate])
  next.gates[gate] = {
    ...previous,
    state: 'rejected',
    rejectedAt: at,
    rejectedReason: reason,
    attempts: Math.max(previous.attempts, 1),
  }
  next.updatedAt = at
  return next
}

/** Move a change to a stage directly (back-edges, repair, engine-driven auto gates). */
export function enterStage(change: ChangeStatus, stage: StageId, at: string): ChangeStatus {
  const next = cloneChange(change)
  next.stage = stage
  if (stage === 'archived') {
    next.lifecycle = 'archived'
  } else if (next.lifecycle === 'archived') {
    next.lifecycle = 'active' as ChangeLifecycle
  }
  next.updatedAt = at
  return next
}

/** A failed S5 verification entry: which verification failed and what it touched. */
export interface VerificationFailureInput {
  name: string
  files: string[]
  tests: string[]
}

/**
 * S5 verification failed: go back to S4 and draft repair task cards whose scope
 * only contains the files/tests involved in the failure (T1.1).
 */
export function applyVerificationFailure(
  change: ChangeStatus,
  failed: VerificationFailureInput[],
  at: string,
): { change: ChangeStatus; tasks: TaskCard[] } {
  const next = enterStage(change, 'S4', at)
  const tasks = failed.map((failure, index) => draftRepairTask(change, failure, index))
  return { change: next, tasks }
}

function draftRepairTask(
  change: ChangeStatus,
  failure: VerificationFailureInput,
  index: number,
): TaskCard {
  const scope = uniquePaths(failure.files)
  const tests = uniquePaths(failure.tests)
  const fileCount = scope.length + tests.length
  return {
    id: `FIX-${index + 1}`,
    title: `修复验证失败：${failure.name}`,
    covers: [],
    scope,
    tests,
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'required',
    tddReason: '修复验证失败必须先用失败用例复现，再修到 GREEN（RED → GREEN）',
    verify: [],
    run: 'auto',
    risk: change.risk === 'high' ? ['验证回归'] : [],
    size: fileCount <= 2 ? 'S' : fileCount <= 5 ? 'M' : 'L',
    body:
      `S5 全量验证失败：${failure.name}。修复任务的范围只包含失败涉及的源码与测试：` +
      '先写/改测试复现失败（RED），再修复实现到通过（GREEN），最后用 flow_verify 重跑验证组。',
  }
}

function uniquePaths(paths: string[]): string[] {
  const cleaned = paths.map((path) => normalizeRelPath(path)).filter((path) => path !== '')
  return [...new Set(cleaned)].sort()
}

/** Enter locked mode: reject gated writes until repaired. */
export function lockChange(
  change: ChangeStatus,
  reason: string,
  at: string,
  detail?: string,
): ChangeStatus {
  const next = cloneChange(change)
  next.lifecycle = 'locked'
  next.lock = detail === undefined ? { reason, at } : { reason, at, detail }
  next.updatedAt = at
  return next
}

/** Leave locked mode (after `/flow repair`); the stage itself is restored separately. */
export function unlockChange(change: ChangeStatus, at: string): ChangeStatus {
  const next = cloneChange(change)
  next.lifecycle = next.stage === 'archived' ? 'archived' : 'active'
  delete next.lock
  next.updatedAt = at
  return next
}
