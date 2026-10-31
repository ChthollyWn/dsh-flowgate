/**
 * Runtime visualization view-model (docs/impl/runtime-visualization.md §1/§2).
 *
 * Pure, SSR-safe functions that turn the DSH native runtime data into the two
 * panel models:
 *  - subagents: `subagentCatalog` session projection + the standard
 *    `useSessionStatus` map + the FlowGate projection (tasks / batches /
 *    taskCards) to place each child under its batch or under “服务”;
 *  - background jobs: the native `ctx.jobs` snapshot (rows + observed output),
 *    sorted and formatted exactly like the official Jobs list.
 *
 * Nothing here invents data: malformed / missing host values degrade to empty
 * models so the views can render their empty states.
 */
import type { TFn } from './i18n'
import type { FlowgateProjection, JobRowWire, JobsUiSnapshot } from './types'

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

// ---------------------------------------------------------------------------
// Subagent catalog
// ---------------------------------------------------------------------------

/** One `subagentCatalog` projection row (`dsh-subagent` wire view). */
export interface SubagentCatalogEntry {
  id: string
  createdAt: number
  mode: string
  label?: string
}

/** Normalize an unknown projection value into catalog entries. */
export function parseCatalog(raw: unknown): SubagentCatalogEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: SubagentCatalogEntry[] = []
  for (const value of raw) {
    if (!isRecord(value)) continue
    const id = str(value.id)
    if (id === '') continue
    entries.push({
      id,
      createdAt: numOr(value.createdAt, 0),
      mode: str(value.mode, 'unknown'),
      ...(typeof value.label === 'string' && value.label !== '' ? { label: value.label } : {}),
    })
  }
  return entries
}

/** Stable ids, used for the `useSessionStatus` running selector. */
export function catalogIds(entries: readonly SubagentCatalogEntry[]): string[] {
  return entries.map((entry) => entry.id)
}

export type AgentRole = 'executor' | 'reviewer' | 'final-reviewer' | 'investigator' | 'subagent'

export interface ParsedAgentLabel {
  role: AgentRole
  taskId?: string
  attempt?: number
  /** `flowgate-final-<kind>` middle segment (e.g. `review`). */
  kind?: string
}

const EXEC_LABEL = /^flowgate-exec-(.+)$/
const REVIEW_LABEL = /^flowgate-review-(.+)-(\d+)$/
const FINAL_LABEL = /^flowgate-final-(.+)-(\d+)$/
const INVESTIGATE_LABEL = /^flowgate-investigate-(.+)$/

/** Resolve the registered child role from its catalog label (host contract). */
export function parseAgentLabel(label: string | undefined): ParsedAgentLabel {
  const value = label ?? ''
  const exec = EXEC_LABEL.exec(value)
  if (exec !== null) return { role: 'executor', taskId: exec[1] }
  const review = REVIEW_LABEL.exec(value)
  if (review !== null) {
    return { role: 'reviewer', taskId: review[1], attempt: Number(review[2]) }
  }
  const final = FINAL_LABEL.exec(value)
  if (final !== null) {
    return { role: 'final-reviewer', kind: final[1], attempt: Number(final[2]) }
  }
  const investigate = INVESTIGATE_LABEL.exec(value)
  if (investigate !== null) return { role: 'investigator', kind: investigate[1] }
  return { role: 'subagent' }
}

export type AgentStatus = 'running' | 'done' | 'failed' | 'idle'

export interface AgentNodeModel {
  id: string
  role: AgentRole
  /** Raw catalog label (fallback when no role-specific copy applies). */
  label: string
  createdAt: number
  mode: string
  taskId?: string
  attempt?: number
  kind?: string
  taskTitle?: string
  taskStatus?: string
  batch?: string
  worktree?: string
  /** Live/running flag from the standard `useSessionStatus` map. */
  sessionRunning: boolean
  status: AgentStatus
  /** Where `status` came from (debugging / tests). */
  statusSource: 'session' | 'task' | 'idle'
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface AgentBatchModel {
  id: string
  /** Execution mode from the plan batch (absent for the synthetic services group). */
  mode?: 'sequential' | 'parallel'
  nodes: AgentNodeModel[]
  status: AgentStatus
}

export interface AgentsViewModel {
  /** True when the host provided a `subagentCatalog` projection at all. */
  available: boolean
  nodes: AgentNodeModel[]
  /** Linked executor nodes grouped by batch, in snapshot batch order. */
  batches: AgentBatchModel[]
  /** Unlinked / non-executor children: review, final, investigate, services. */
  services: AgentNodeModel[]
  running: number
  total: number
}

/** ISO timestamp (task state) → epoch ms, tolerating junk. */
export function parseIsoTime(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function taskStatusToAgent(status: string | undefined): AgentStatus | undefined {
  switch (status) {
    case 'running':
    case 'review':
    case 'queued':
      return 'running'
    case 'done':
      return 'done'
    case 'failed':
    case 'blocked':
    case 'interrupted':
      return 'failed'
    case 'pending':
    case 'skipped':
      return 'idle'
    default:
      return undefined
  }
}

function batchStatusOf(nodes: readonly AgentNodeModel[]): AgentStatus {
  if (nodes.some((node) => node.status === 'running')) return 'running'
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.length > 0 && nodes.every((node) => node.status === 'done')) return 'done'
  return 'idle'
}

function runningByIndex(entries: readonly SubagentCatalogEntry[], runningKey: string | undefined): boolean[] {
  const key = typeof runningKey === 'string' ? runningKey : ''
  return entries.map((_, index) => key[index] === '1')
}

/**
 * Build the subagent topology model.
 *
 * @param rawCatalog - `subagentCatalog` projection value (unknown wire data).
 * @param proj - FlowGate projection (task/batch/title enrichment), nullable.
 * @param runningKey - per-catalog-entry `'1'/'0'` string selected from
 *   `useSessionStatus` (stable across renders; '' when the hook is absent).
 */
export function buildAgentsModel(
  rawCatalog: unknown,
  proj: FlowgateProjection | null,
  runningKey: string | undefined,
): AgentsViewModel {
  const available = rawCatalog !== undefined && rawCatalog !== null
  const entries = parseCatalog(rawCatalog)
  const snapshot = proj?.snapshot ?? null
  const tasks = snapshot?.tasks ?? {}
  const taskCards = snapshot?.taskCards ?? {}
  const batchMeta = new Map<string, 'sequential' | 'parallel'>()
  for (const batch of snapshot?.batches ?? []) {
    const id = str(batch?.id)
    if (id === '') continue
    batchMeta.set(id, batch.mode === 'parallel' ? 'parallel' : 'sequential')
  }
  const batchOrder = [...batchMeta.keys()]
  const runningFlags = runningByIndex(entries, runningKey)

  const nodes: AgentNodeModel[] = entries.map((entry, index) => {
    const parsed = parseAgentLabel(entry.label)
    const taskId = parsed.taskId
    // Only executor children are task-linked; reviewers / final review /
    // investigators stay as services under the main session (contract §1).
    const executor = parsed.role === 'executor'
    const task = executor && taskId !== undefined ? tasks[taskId] : undefined
    const card = executor && taskId !== undefined ? taskCards[taskId] : undefined
    const sessionRunning = runningFlags[index] === true
    const fromTask = executor ? taskStatusToAgent(task?.status) : undefined
    const status: AgentStatus = sessionRunning ? 'running' : (fromTask ?? 'idle')
    const statusSource: AgentNodeModel['statusSource'] = sessionRunning ? 'session' : fromTask !== undefined ? 'task' : 'idle'
    const startedAt = parseIsoTime(task?.startedAt)
    const finishedAt = parseIsoTime(task?.finishedAt)
    const durationMs =
      startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined
    const linkedTask = executor && task !== undefined
    const batch = linkedTask ? optionalStr(task?.batch) : undefined
    return {
      id: entry.id,
      role: parsed.role,
      label: entry.label ?? '',
      createdAt: entry.createdAt,
      mode: entry.mode,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(parsed.attempt !== undefined && Number.isFinite(parsed.attempt) ? { attempt: parsed.attempt } : {}),
      ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
      ...(task !== undefined && card !== undefined && typeof card.title === 'string' ? { taskTitle: card.title } : {}),
      ...(task?.status !== undefined ? { taskStatus: task.status } : {}),
      ...(batch !== undefined ? { batch } : {}),
      ...(linkedTask && typeof task?.worktree === 'string' && task.worktree !== '' ? { worktree: task.worktree } : {}),
      sessionRunning,
      status,
      statusSource,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
  })

  const byBatch = new Map<string, AgentNodeModel[]>()
  for (const node of nodes) {
    if (node.batch === undefined) continue
    const list = byBatch.get(node.batch) ?? []
    list.push(node)
    byBatch.set(node.batch, list)
  }
  const batchIds = [...batchOrder.filter((id) => (byBatch.get(id) ?? []).length > 0)]
  for (const id of byBatch.keys()) if (!batchIds.includes(id)) batchIds.push(id)
  const batches: AgentBatchModel[] = batchIds.map((id) => {
    const batchNodes = byBatch.get(id) ?? []
    const mode = batchMeta.get(id)
    return {
      id,
      ...(mode !== undefined ? { mode } : {}),
      nodes: batchNodes,
      status: batchStatusOf(batchNodes),
    }
  })
  const services = nodes.filter((node) => node.batch === undefined)
  const running = nodes.filter((node) => node.status === 'running').length
  return { available, nodes, batches, services, running, total: nodes.length }
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

/** Stable empty snapshot for hosts without the jobs service (React identity). */
export const EMPTY_JOBS_SNAPSHOT: JobsUiSnapshot = { rows: {}, observed: {} }

export type JobStatus = JobRowWire['status']

/** Running / stopping rows are live; everything else has settled. */
export function isLiveJob(row: JobRowWire | undefined): boolean {
  return row !== undefined && (row.status === 'running' || row.status === 'stopping')
}

/** A settled job with retained output can still open its panel. */
export function isObservableJob(row: JobRowWire | undefined): boolean {
  if (row === undefined) return false
  if (isLiveJob(row)) return true
  return (row.output?.total ?? 0) > 0
}

/** The one-line qualifier beside the status: live progress, else the detail. */
export function jobDetail(row: JobRowWire): string | undefined {
  return optionalStr(row.progress) ?? optionalStr(row.detail)
}

/**
 * Live rows first in start order, then settled rows newest-first
 * (same ordering as the official Jobs list; deterministic on ties).
 */
export function orderedJobs(rows: readonly JobRowWire[]): JobRowWire[] {
  return [...rows].sort((left, right) => {
    const liveLeft = isLiveJob(left)
    if (liveLeft !== isLiveJob(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** Defensive row narrowing: junk rows are dropped instead of rendered. */
export function normalizeJobRow(raw: unknown): JobRowWire | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  const status = raw.status
  if (id === '') return null
  if (status !== 'running' && status !== 'stopping' && status !== 'completed' && status !== 'killed' && status !== 'failed') {
    return null
  }
  const output = isRecord(raw.output)
    ? {
        ...(typeof raw.output.total === 'number' ? { total: raw.output.total } : {}),
        ...(typeof raw.output.earliest === 'number' ? { earliest: raw.output.earliest } : {}),
      }
    : undefined
  return {
    id,
    kind: str(raw.kind, 'job'),
    label: str(raw.label, id),
    status,
    ...(typeof raw.progress === 'string' && raw.progress !== '' ? { progress: raw.progress } : {}),
    ...(typeof raw.detail === 'string' && raw.detail !== '' ? { detail: raw.detail } : {}),
    startedAt: numOr(raw.startedAt, 0),
    ...(typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt) ? { finishedAt: raw.finishedAt } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

/** Rows for one session, ordered; empty when the snapshot/session is missing. */
export function jobsForSession(snapshot: JobsUiSnapshot | undefined, sessionId: string | undefined): JobRowWire[] {
  if (snapshot === undefined || sessionId === undefined || sessionId === '') return []
  const bucket = snapshot.rows[sessionId]
  if (!Array.isArray(bucket)) return []
  const rows: JobRowWire[] = []
  for (const value of bucket) {
    const row = normalizeJobRow(value)
    if (row !== null) rows.push(row)
  }
  return orderedJobs(rows)
}

/** Observed live output for one job ('' when nothing was observed yet). */
export function observedOutput(snapshot: JobsUiSnapshot | undefined, jobId: string | undefined): string {
  if (snapshot === undefined || jobId === undefined) return ''
  const view = snapshot.observed[jobId]
  return isRecord(view) ? str(view.text) : ''
}

/** Keep only the last `limit` characters (UTF-16 safe) of the live output. */
export function clipJobOutput(text: string, limit = 8192): string {
  if (limit <= 0) return ''
  return text.length <= limit ? text : `…${text.slice(Math.max(0, text.length - limit + 1))}`
}

const EXIT_CODE_PATTERN = /exit code\s*[:：]\s*(-?\d+)/i

/** Parse `exit code: N` (ASCII or full-width colon) out of a job detail. */
export function parseExitCode(detail: string | undefined): number | null {
  if (typeof detail !== 'string' || detail === '') return null
  const match = EXIT_CODE_PATTERN.exec(detail)
  if (match === null) return null
  const code = Number(match[1])
  return Number.isInteger(code) ? code : null
}

/** Dot semantics shared with the official Jobs list. */
export type JobDotState = 'ongoing' | 'warning' | 'done' | 'error'

export function jobDotState(status: JobStatus | undefined): JobDotState {
  switch (status) {
    case 'running':
      return 'ongoing'
    case 'stopping':
    case 'killed':
      return 'warning'
    case 'completed':
      return 'done'
    case 'failed':
    default:
      return 'error'
  }
}

/** Localized status label for a job row. */
export function jobStatusLabel(status: JobStatus | undefined, t: TFn): string {
  switch (status) {
    case 'running':
      return t('jobs.status.running')
    case 'stopping':
      return t('jobs.status.stopping')
    case 'completed':
      return t('jobs.status.completed')
    case 'killed':
      return t('jobs.status.killed')
    case 'failed':
    default:
      return t('jobs.status.failed')
  }
}

/** Elapsed milliseconds: live rows count to now, settled rows to finishedAt. */
export function jobElapsedMs(row: JobRowWire, now: number): number {
  const end = isLiveJob(row) ? now : (row.finishedAt ?? row.startedAt)
  return Math.max(0, end - row.startedAt)
}

/** Localized duration in at most two adjacent units (official Jobs wording). */
export function formatDuration(elapsedMs: number, t: TFn): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return t('jobs.duration.hours', { hours, minutes })
  if (minutes > 0) return t('jobs.duration.minutes', { minutes, seconds })
  return t('jobs.duration.seconds', { seconds })
}
