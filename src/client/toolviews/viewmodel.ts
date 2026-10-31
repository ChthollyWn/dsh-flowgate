/**
 * FlowGate conversation tool-call row — pure view model (SSR/no-DOM).
 *
 * DSH dispatches every atomic model tool call through the keyed
 * `tool.call.toolview` slot (`entryKey = wire tool name`). FlowGate registers a
 * row for each `flow_*` wire name so a tool call in the transcript renders as a
 * mini seven-stage rail instead of the generic card.
 *
 * Contract notes (verified against the shipped DSH web client):
 * - register definition: `{ name: 'tool.call.toolview', key: '<wire name>', locale }`;
 * - owner props: `callId`, `toolName`, `phase` (`preparing | start | result`),
 *   `block`, `cwd?`, `home?`, `loadImage`, `openFile`, `inspect`;
 * - the registration additionally receives the session-slot standard kit, so
 *   `t` (locale seat when `locale` is declared) and `useProjection` are present.
 *
 * Everything here is defensive: a missing / malformed field must degrade to a
 * safe one-line row, never throw, because a thrown tool row would break the
 * whole transcript render. No `@deepseek-ai/*` import: types are local and
 * structural (see `src/client/types.ts` for the same boundary).
 */
import type { TFn } from '../i18n'
import { fallbackTranslator } from '../i18n'
import type { FlowgateProjection } from '../types'
import type { RuntimeSnapshot } from '../../core/types'
import type { StageNodeModel } from '../model'
import {
  awaitingText,
  buildPipelineNodes,
  gateForStage,
  normalizeStage,
  readProjection,
  stageIndex,
  stageLabel,
  taskStatusLabel,
} from '../model'

/** The family of wire tool names FlowGate registers a conversation row for. */
export const FLOW_TOOL_NAMES: readonly string[] = [
  // src/host/tools/definitions.ts
  'flow_status',
  'flow_new_change',
  'flow_submit',
  'flow_task_start',
  'flow_task_done',
  'flow_request_scope_change',
  'flow_report_risk',
  'flow_attach_evidence',
  'flow_verify',
  'flow_request_plan_change',
  'flow_propose_rule',
  'flow_investigate',
  'flow_submit_analysis',
  'flow_declare_rework',
  'flow_diff',
  // src/host/dispatch/index.ts (registered by the dispatch installer, same preset)
  'flow_dispatch_next',
]

/**
 * Best-effort "where does this tool usually act" stage, used only when there is
 * no projection to read (e.g. a brand-new host, or a windowless call). It is a
 * presentation hint — never treated as the current stage when a projection
 * exists.
 */
export const TOOL_STAGE_HINT: Readonly<Record<string, string>> = {
  flow_new_change: 'S0',
  flow_investigate: 'S2',
  flow_submit_analysis: 'S2',
  flow_submit: 'S3',
  flow_request_plan_change: 'S3',
  flow_report_risk: 'S3',
  flow_task_start: 'S4',
  flow_task_done: 'S4',
  flow_dispatch_next: 'S4',
  flow_request_scope_change: 'S4',
  flow_propose_rule: 'S4',
  flow_verify: 'S5',
  flow_attach_evidence: 'S5',
  flow_declare_rework: 'S5',
  flow_diff: 'S5',
}

/** Seven-stage order used by the mini rail. */
export const RAIL_STAGES: readonly string[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']

export type ToolPhase = 'preparing' | 'start' | 'result' | 'unknown'
export type ToolRunState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped' | 'unknown'
export type FlowToolTone = 'blocked' | 'attention' | 'active' | 'idle' | 'disabled'
export type RailNodeStatus = 'done' | 'current' | 'pending' | 'blocked'

/**
 * Slot props accepted by the row. The real owner payload is merged with the
 * session standard kit, so most members are optional from this module's point
 * of view — that is exactly why every read goes through the safe helpers below.
 * Deliberately a standalone structural type (not `SlotPropRecord`) so a
 * future/older kit shape cannot fail typecheck here; the component's behavior
 * is defined by the runtime reads, not by a frozen façade.
 */
export interface FlowToolRowProps {
  toolName?: unknown
  phase?: unknown
  block?: unknown
  callId?: unknown
  t?: unknown
  useProjection?: unknown
  [key: string]: unknown
}

/** One node of the mini rail (DOM contract: `data-flowgate="rail-node"`). */
export interface FlowToolNodeModel {
  stage: string
  label: string
  index: string
  status: RailNodeStatus
  isCurrent: boolean
}

export interface FlowToolViewModel {
  /** Sanitized wire tool name (display-safe, never empty). */
  toolName: string
  phase: ToolPhase
  state: ToolRunState
  tone: FlowToolTone
  /** True when the projection could be normalized. */
  projected: boolean
  initialized: boolean
  /** True when the seven-stage rail should render (projection + pipeline data). */
  hasRail: boolean
  changeId?: string
  stage?: string
  stageText?: string
  gate?: string
  gateText?: string
  /** Gate derived from the current stage (`gateForStage`), for tooltips/data-*. */
  stageGate?: string
  pendingCount: number
  nodes: FlowToolNodeModel[]
  /** One-line flow context + tool lifecycle, e.g. `C-003 · ③ 设计拆解 · G3 等你批准计划 · 进行中`. */
  statusText: string
  ariaLabel: string
}

export interface BuildFlowToolViewModelInput {
  toolName: unknown
  phase: unknown
  block: unknown
  projection: FlowgateProjection | null
  t: TFn
}

const TOOL_NAME_MAX = 48
const CHANGE_ID_MAX = 24
const GATE_PATTERN = /^(GR|G[0-6])$/
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/

/** A translator that can never throw (missing/unbound locale degrades to the key). */
export function safeTranslator(t: unknown): TFn {
  if (typeof t !== 'function') return fallbackTranslator()
  return ((key: never, params?: Record<string, string | number>): string => {
    try {
      const value = (t as (k: never, p?: Record<string, string | number>) => unknown)(key, params)
      return typeof value === 'string' ? value : String(key)
    } catch {
      return String(key)
    }
  }) as TFn
}

/** Read one property without letting a hostile/malformed object throw. */
function safeGet(record: Record<string, unknown> | null, key: string): unknown {
  if (record === null) return undefined
  try {
    return record[key]
  } catch {
    return undefined
  }
}

/** Narrow an arbitrary value to a plain record (arrays/null rejected, never throws). */
export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

/** Sanitize an arbitrary tool-name value into something safe to render as text. */
export function safeToolName(value: unknown): string {
  try {
    if (typeof value !== 'string') return 'FlowGate'
    const trimmed = value.trim()
    if (trimmed === '' || !TOOL_NAME_PATTERN.test(trimmed)) return 'FlowGate'
    return Array.from(trimmed).slice(0, TOOL_NAME_MAX).join('')
  } catch {
    return 'FlowGate'
  }
}

function safeChangeId(value: unknown): string | undefined {
  try {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (trimmed === '' || !TOOL_NAME_PATTERN.test(trimmed)) return undefined
    return Array.from(trimmed).slice(0, CHANGE_ID_MAX).join('')
  } catch {
    return undefined
  }
}

function safeGate(value: unknown): string | undefined {
  try {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return GATE_PATTERN.test(trimmed) ? trimmed : undefined
  } catch {
    return undefined
  }
}

function isRailStage(stage: string): boolean {
  return RAIL_STAGES.includes(stage)
}

/** Derive the phase discriminant: prefer the owner `phase`, fall back to the block shape. */
export function resolvePhase(phase: unknown, block: unknown): ToolPhase {
  try {
    if (phase === 'preparing' || phase === 'start' || phase === 'result') return phase
    const record = asPlainRecord(block)
    if (record !== null) {
      if ('kind' in record) return 'result'
      const inner = safeGet(record, 'phase')
      if (inner === 'preparing' || inner === 'start') return inner
    }
  } catch {
    /* fall through to unknown */
  }
  return 'unknown'
}

/** Derive the lifecycle state from the phase and the tool block (mirrors the shipped row model). */
export function resolveRunState(phase: ToolPhase, block: unknown): ToolRunState {
  try {
    if (phase === 'preparing') return 'preparing'
    if (phase === 'start') return 'running'
    if (phase !== 'result') return 'unknown'
    const record = asPlainRecord(block)
    if (record === null) return 'unknown'
    const error = asPlainRecord(safeGet(record, 'error'))
    if (error !== null && safeGet(error, 'code') === 'interrupted') return 'stopped'
    return safeGet(record, 'isError') === true ? 'error' : 'ok'
  } catch {
    return 'unknown'
  }
}

function stateLabel(state: ToolRunState, t: TFn): string | undefined {
  switch (state) {
    case 'preparing':
      return taskStatusLabel('queued', t)
    case 'running':
      return taskStatusLabel('running', t)
    case 'ok':
      return taskStatusLabel('done', t)
    case 'error':
      return taskStatusLabel('failed', t)
    case 'stopped':
      return taskStatusLabel('interrupted', t)
    default:
      return t('common.unknown')
  }
}

function toneOfSnapshot(snapshot: RuntimeSnapshot | null): FlowToolTone {
  if (snapshot === null || snapshot.initialized !== true) return 'disabled'
  if (snapshot.locked === true || snapshot.off === true) return 'blocked'
  if (Array.isArray(snapshot.violations) && snapshot.violations.length > 0) return 'blocked'
  if (snapshot.awaitingGate !== undefined || (Array.isArray(snapshot.pending) && snapshot.pending.length > 0)) {
    return 'attention'
  }
  if (snapshot.stage !== undefined || snapshot.changeId !== undefined) return 'active'
  return 'idle'
}

function nodeLabel(stage: string, t: TFn): string {
  try {
    return stageLabel(stage, t)
  } catch {
    return stage
  }
}

function nodeIndex(stage: string, t: TFn): string {
  try {
    return stageIndex(stage, t)
  } catch {
    return ''
  }
}

/**
 * Build the seven-stage rail: always seven slots in S0..S6 order, filling
 * stages the host pipeline omitted with `pending` nodes so a partial projection
 * still reads as a pipeline. Returns `[]` when FlowGate is not initialized —
 * the caller then degrades to a one-line row.
 */
export function buildFlowToolNodes(
  snapshot: RuntimeSnapshot | null,
  stage: string | undefined,
  t: TFn,
): FlowToolNodeModel[] {
  if (snapshot === null || snapshot.initialized !== true) return []
  try {
    const byStage = new Map<string, FlowToolNodeModel>()
    let projected: StageNodeModel[] = []
    try {
      projected = buildPipelineNodes(snapshot, t)
    } catch {
      projected = []
    }
    for (const node of projected) {
      if (node === null || typeof node !== 'object') continue
      if (typeof node.stage !== 'string' || !isRailStage(node.stage)) continue
      const status: RailNodeStatus =
        node.status === 'done' || node.status === 'current' || node.status === 'blocked' ? node.status : 'pending'
      byStage.set(node.stage, {
        stage: node.stage,
        label: typeof node.label === 'string' && node.label !== '' ? node.label : nodeLabel(node.stage, t),
        index: typeof node.index === 'string' && node.index !== '' ? node.index : nodeIndex(node.stage, t),
        status,
        isCurrent: status === 'current',
      })
    }
    // A normalized projection without a current marker still needs one: the
    // snapshot stage is authoritative for the rail's pulse. A blocked current
    // stage keeps its blocked status (both attributes are contract-defined).
    const hasCurrent = Array.from(byStage.values()).some((node) => node.isCurrent)
    if (!hasCurrent && stage !== undefined && isRailStage(stage)) {
      const existing = byStage.get(stage)
      byStage.set(stage, {
        stage,
        label: existing?.label ?? nodeLabel(stage, t),
        index: existing?.index ?? nodeIndex(stage, t),
        status: existing?.status === 'blocked' ? 'blocked' : 'current',
        isCurrent: true,
      })
    }
    return RAIL_STAGES.map((railStage) => {
      const found = byStage.get(railStage)
      if (found !== undefined) return found
      return {
        stage: railStage,
        label: nodeLabel(railStage, t),
        index: nodeIndex(railStage, t),
        status: railStage === stage ? 'current' : 'pending',
        isCurrent: railStage === stage,
      }
    })
  } catch {
    return []
  }
}

/**
 * Compose the pure row model from raw slot props parts. Never throws: any
 * malformed input degrades to the one-line fallback shape.
 */
export function buildFlowToolViewModel(input: BuildFlowToolViewModelInput): FlowToolViewModel {
  const t = safeTranslator(input.t)
  const toolName = safeToolName(input.toolName)
  try {
    const phase = resolvePhase(input.phase, input.block)
    const state = resolveRunState(phase, input.block)
    const stateText = stateLabel(state, t)
    const snapshot = input.projection?.snapshot ?? null
    const initialized = snapshot?.initialized === true
    const stage = initialized && typeof snapshot?.stage === 'string' ? normalizeStage(snapshot.stage) : undefined
    const nodes = buildFlowToolNodes(snapshot, stage, t)
    const hasRail = nodes.length > 0
    const projected = input.projection !== null
    const tone = toneOfSnapshot(snapshot)

    const changeId = initialized ? safeChangeId(snapshot?.changeId) : undefined
    const awaitingGate = initialized ? safeGate(snapshot?.awaitingGate) : undefined
    const panelGate = safeGate(input.projection?.panel?.gate?.gate)
    const panelAwaiting = input.projection?.panel?.gate?.state === 'awaiting'
    const gate = awaitingGate ?? (panelAwaiting ? panelGate : undefined)
    const pendingCount = initialized && Array.isArray(snapshot?.pending) ? snapshot.pending.length : 0
    const stageText = stage !== undefined ? `${nodeIndex(stage, t)} ${nodeLabel(stage, t)}` : undefined
    const gateText = gate !== undefined ? `${gate} ${safeGateAwaitingText(gate, t)}` : undefined
    const stageGate = gateForStage(stage) ?? undefined

    const parts: string[] = []
    if (!projected) {
      // Degraded path: no projection hook on this host. Still show which
      // stage this tool usually acts on so the row is not just a bare name.
      const hintStage = TOOL_STAGE_HINT[toolName]
      const hintText =
        hintStage !== undefined
          ? `${nodeIndex(hintStage, t)} ${nodeLabel(hintStage, t)}`
          : safeLabel(t, 'pipeline.title')
      if (hintText !== '') parts.push(hintText)
    } else if (!initialized) {
      parts.push(safeLabel(t, 'common.notEnabled'))
    } else {
      if (changeId !== undefined) parts.push(changeId)
      if (stageText !== undefined) parts.push(stageText)
      if (gateText !== undefined) parts.push(gateText)
      else if (pendingCount > 0) parts.push(safeT(t, 'status.pending', { n: pendingCount }))
      else if (changeId === undefined) parts.push(safeLabel(t, 'panel.noChange'))
      if (snapshot?.locked === true) parts.push(safeLabel(t, 'stage.locked'))
      else if (snapshot?.off === true) parts.push(safeLabel(t, 'tone.disabled'))
    }
    if (stateText !== undefined && stateText !== '') parts.push(stateText)
    const statusText = parts.filter((part) => part !== '').join(' · ')

    const ariaLabel = `${toolName}${statusText !== '' ? ` · ${statusText}` : ''}`

    return {
      toolName,
      phase,
      state,
      tone,
      projected,
      initialized,
      hasRail,
      ...(changeId !== undefined ? { changeId } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(stageText !== undefined ? { stageText } : {}),
      ...(gate !== undefined ? { gate } : {}),
      ...(gateText !== undefined ? { gateText } : {}),
      ...(stageGate !== undefined ? { stageGate } : {}),
      pendingCount,
      nodes,
      statusText,
      ariaLabel,
    }
  } catch {
    return fallbackViewModel(toolName, t)
  }
}

/**
 * Minimal always-renderable model: tool name + "未知" phase text, no rail.
 * Used when anything above throws (bad proxy, exotic host payload).
 */
export function fallbackViewModel(toolName: string, t: TFn): FlowToolViewModel {
  const name = safeToolName(toolName)
  const label = safeLabel(t, 'common.unknown')
  return {
    toolName: name,
    phase: 'unknown',
    state: 'unknown',
    tone: 'disabled',
    projected: false,
    initialized: false,
    hasRail: false,
    pendingCount: 0,
    nodes: [],
    statusText: label,
    ariaLabel: `${name} · ${label}`,
  }
}

function safeLabel(t: TFn, key: 'pipeline.title' | 'common.notEnabled' | 'panel.noChange' | 'stage.locked' | 'tone.disabled' | 'common.unknown'): string {
  try {
    return t(key)
  } catch {
    return key
  }
}

function safeGateAwaitingText(gate: string, t: TFn): string {
  try {
    return awaitingText(gate, t)
  } catch {
    return ''
  }
}

function safeT(t: TFn, key: 'status.pending', params: Record<string, string | number>): string {
  try {
    return t(key, params)
  } catch {
    return key
  }
}

/**
 * Read the session projection from slot props. Wraps `readProjection` (which
 * already try/catches the hook call) in a structural cast because the local
 * props type keeps unknown members unknown.
 */
export function readFlowProjection(props: FlowToolRowProps | undefined): FlowgateProjection | null {
  if (props === undefined || props === null) return null
  try {
    const candidate = props as { useProjection?: (key: string) => unknown }
    return readProjection(candidate)
  } catch {
    return null
  }
}
