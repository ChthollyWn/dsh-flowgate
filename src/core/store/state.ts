/**
 * 变更进行状态（`changes/<id>/status.json`）、变更台账（`changes/index.md`）、
 * 会话租约（`state/sessions.json`）与 `/flow repair` 重建。
 *
 * - `status.json` 只由插件写：先写 `<status>.tmp` 再 rename，宿主崩溃不会留下半截 JSON。
 * - `index.md` 由 status 渲染：删除 status.json 与 index.md 后，可以用
 *   {@link rebuildState} 从账本（优先最近的 `change.updated` 完整快照）+ 产物目录重建。
 * - 编号：变更/分析任务 `C-001` / `A-001`（三位补零）；待处理项 `RK-1` / `SC-1`
 *   （按 03 §8.3 不补零）。
 */
import type { Clock, FileSystem } from '../util/fs'
import type {
  BatchState,
  ChangeStatus,
  GateId,
  GateRecord,
  LedgerEvent,
  PendingItem,
  ProjectState,
  ReviewRecord,
  SessionLease,
  StageId,
  TaskState,
  Violation,
} from '../types'
import { PENDING_PREFIX } from '../types'
import { isoNow } from '../util/time'
import { posixBasename } from '../util/paths'
import { changePaths, layout } from './layout'

/** 03 §9.8 台账的阶段列：与 core/state/stages 的中文标签保持一致（避免运行时跨模块依赖）。 */
const STAGE_PHASE_LABEL: Record<string, string> = {
  roadmap: '路线图',
  S0: 'S0 立项',
  S1: 'S1 需求澄清',
  S2: 'S2 上下文',
  S3: 'S3 设计拆解',
  S4: 'S4 执行',
  S5: 'S5 验证',
  S6: 'S6 交付',
  archived: '—',
  locked: '锁定',
}

const COMPLEXITY_LABEL: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  ultra: '超高',
}

const RISK_LABEL: Record<string, string> = {
  normal: '普通',
  high: '高风险',
}

const LIFECYCLE_LABEL: Record<string, string> = {
  active: '进行中',
  paused: '暂停',
  archived: '已交付',
  blocked: '阻塞',
  locked: '锁定',
}

export interface LoadProjectStatePorts {
  fs: FileSystem
  root: string
  config: ProjectState['config']
  clock: Clock
}

/** 加载时发现的损坏状态文件（路径为仓库相对路径，可直接展示给负责人）。 */
export interface CorruptStateFile {
  /** 例如 `.flowgate/changes/C-001/status.json`。 */
  path: string
  /** 面向人的原因，例如「非法 JSON（Unexpected end of JSON input）」。 */
  reason: string
}

/** 变更状态扫描结果：可解析的变更 + 损坏的 status.json 清单。 */
export interface ChangesScanResult {
  changes: ChangeStatus[]
  corrupt: CorruptStateFile[]
}

/**
 * `loadProjectState` 的返回类型：在 `ProjectState` 之上附带损坏清单。
 *
 * `corruptStateFiles` 只在存在损坏时出现，保持未损坏项目的返回值形状不变
 * （现有调用方/快照断言不受影响）。
 */
export interface LoadedProjectState extends ProjectState {
  corruptStateFiles?: CorruptStateFile[]
}

/**
 * 加载项目级运行态。
 *
 * `project` / `roadmap` 两个解析结果由 engine 在 load 阶段用 artifacts 解析器填入
 * （本函数只负责存储层事实，避免 store 依赖 artifacts 解析模块）。
 *
 * 损坏的 `status.json` 不再被静默跳过：汇总到 `corruptStateFiles` 交给 engine
 * 进入锁定模式（03 §14：状态文件损坏 → 锁定 + `/flow doctor` 诊断 + `/flow repair`）。
 */
export async function loadProjectState(ports: LoadProjectStatePorts): Promise<LoadedProjectState> {
  const l = layout(ports.root)
  const initialized = await ports.fs.exists(l.config)
  const state: LoadedProjectState = {
    root: l.root,
    initialized,
    config: ports.config,
    changes: [],
    leases: [],
    ledgerSeq: 0,
  }
  if (!initialized) return state
  const scan = await listChangesDetailed(ports.fs, ports.root)
  state.changes = scan.changes
  if (scan.corrupt.length > 0) state.corruptStateFiles = scan.corrupt
  // 会话租约损坏不再把 engine.load 打崩（否则宿主 markInert、守卫 fail-open）：
  // 汇总为损坏状态文件，走与 status.json 相同的"锁定 + doctor + repair"路径。
  try {
    state.leases = await readLeases(ports.fs, ports.root)
  } catch (error) {
    if (!(error instanceof SessionLeaseCorruptionError)) throw error
    state.corruptStateFiles = [...(state.corruptStateFiles ?? []), { path: error.path, reason: error.reason }]
  }
  const events = await readLedgerEvents(ports.fs, l.ledger)
  state.ledgerSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
  const locked = foldProjectLock(events)
  if (locked) state.locked = locked
  return state
}

// ---------------------------------------------------------------------------
// status.json
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 单个 status.json 不可解析/结构非法时抛出的错误。
 *
 * 消息保持既有格式（`变更状态文件损坏：<路径>（<原因>）。等待负责人在授权卡片上修复（从账本重建）。`），
 * 同时把 `path` / `reason` 暴露给 {@link listChangesDetailed}，供 engine 汇总成锁定原因。
 */
class StateFileCorruptionError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string, hint = '等待负责人在授权卡片上修复（诊断后从账本重建）。') {
    super(`变更状态文件损坏：${path}（${reason}）。${hint}`)
    this.name = 'StateFileCorruptionError'
    this.path = path
    this.reason = reason
  }
}

/** 读取单个变更状态；不存在返回 null，JSON 损坏时抛错（宿主会进入锁定模式）。 */
export async function readChangeStatus(
  fs: FileSystem,
  root: string,
  changeId: string,
): Promise<ChangeStatus | null> {
  const path = changePaths(root, changeId).status
  if (!(await fs.exists(path))) return null
  const raw = await fs.readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StateFileCorruptionError(path, `非法 JSON（${detail}）`)
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string') {
    throw new StateFileCorruptionError(path, '缺少字符串字段 id', '等待负责人在授权卡片上修复（从账本重建）。')
  }
  return parsed as unknown as ChangeStatus
}

/** 原子写 status.json：先写 `<status>.tmp`，再 rename 覆盖。 */
export async function writeChangeStatus(
  fs: FileSystem,
  root: string,
  change: ChangeStatus,
): Promise<void> {
  const paths = changePaths(root, change.id)
  await fs.mkdir(paths.dir)
  const tmp = `${paths.status}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(change, null, 2)}\n`)
  await fs.rename(tmp, paths.status)
}

function idNumber(id: string): number {
  const match = /-(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

function compareChangeIdAsc(a: string, b: string): number {
  const diff = idNumber(a) - idNumber(b)
  return diff !== 0 ? diff : a.localeCompare(b)
}

/**
 * 列出 `changes/` 下的全部变更状态，并单独返回损坏的 `status.json` 清单。
 *
 * `listChanges` 保持既有行为（跳过无法解析的项）；需要感知损坏时用本函数：
 * 引擎在 load 阶段把 `corrupt` 汇总成锁定原因（03 §14 状态损坏 → 锁定），
 * `/flow repair` 再从账本快照重建这些 status.json。
 */
export async function listChangesDetailed(fs: FileSystem, root: string): Promise<ChangesScanResult> {
  const l = layout(root)
  let entries: string[]
  try {
    entries = await fs.readdir(l.changesDir)
  } catch {
    return { changes: [], corrupt: [] }
  }
  const changes: ChangeStatus[] = []
  const corrupt: CorruptStateFile[] = []
  for (const entry of [...entries].sort()) {
    if (entry.endsWith('.md') || entry.endsWith('.json')) continue
    let statusPath: string
    try {
      statusPath = changePaths(root, entry).status
    } catch {
      // 目录名不是合法变更编号（编辑器杂项文件等）：不是状态损坏，按既有行为跳过。
      continue
    }
    // 目录里没有 status.json（可能是还没立项完/被删除）不在此处判定为损坏：
    // 本函数的职责是「存在但读不出来」的状态文件，缺失状态由 /flow repair 按需重建。
    if (!(await fs.exists(statusPath))) continue
    try {
      const status = await readChangeStatus(fs, root, entry)
      if (status) changes.push(status)
    } catch (error) {
      corrupt.push({
        path: statusPath,
        reason:
          error instanceof StateFileCorruptionError
            ? error.reason
            : error instanceof Error
              ? error.message
              : String(error),
      })
    }
  }
  changes.sort((a, b) => compareChangeIdAsc(a.id, b.id))
  corrupt.sort((a, b) => a.path.localeCompare(b.path))
  return { changes, corrupt }
}

/** 列出 `changes/` 下的全部变更状态（按编号升序；跳过 index.md 与无法解析的项）。 */
export async function listChanges(fs: FileSystem, root: string): Promise<ChangeStatus[]> {
  return (await listChangesDetailed(fs, root)).changes
}

/** 执行中的批次摘要，用于台账「当前阶段」列，例如 `S4 执行（B2 并行 2/3）`。 */
function renderStageCell(change: ChangeStatus): string {
  if (change.lifecycle === 'archived' || change.stage === 'archived') return '—'
  const base = STAGE_PHASE_LABEL[change.stage] ?? change.stage
  const runningBatch = change.batches.find((batch) => batch.status === 'running')
  if (!runningBatch) return base
  const activeCount = runningBatch.tasks.filter((taskId) => {
    const status = change.tasks[taskId]?.status
    return status === 'running' || status === 'review'
  }).length
  const mode = runningBatch.mode === 'parallel' ? '并行' : '顺序'
  return `${base}（${runningBatch.id} ${mode} ${activeCount}/${runningBatch.tasks.length}）`
}

function renderArtifactLinks(change: ChangeStatus): string {
  if (change.lifecycle === 'archived') {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(change.updatedAt)?.[1] ?? 'unknown'
    return `[报告](../archive/${day}-${change.id}/report.html)`
  }
  if (change.kind === 'analysis') return `[分析](${change.id}/analysis.md)`
  return `[需求](${change.id}/proposal.md) · [执行图](${change.id}/execution-plan.md)`
}

/** `2026-11-12T10:31:05+08:00` → `11-12 10:31`（按记录里的本地时间显示，跨环境确定）。 */
export function formatActivityTime(iso: string | undefined): string {
  if (!iso) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!match) return '—'
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/**
 * 渲染变更台账（03 §9.8）：编号 / 标题 / 复杂度风险 / 当前阶段 / 状态 / 最近会话 /
 * 最近活动 / 产物链接。按编号倒序（最近创建的在前），符合 §9.8 的示例。
 */
export function renderChangesIndex(changes: ChangeStatus[]): string {
  const header = [
    '# 变更台账',
    '',
    '| 编号 | 标题 | 复杂度 / 风险 | 当前阶段 | 状态 | 最近会话 | 最近活动 | 产物 |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const sorted = [...changes].sort((a, b) => compareChangeIdAsc(b.id, a.id))
  const rows = sorted.map((change) => {
    const complexity = COMPLEXITY_LABEL[change.complexity] ?? change.complexity
    const risk = RISK_LABEL[change.risk] ?? change.risk
    const lifecycle = LIFECYCLE_LABEL[change.lifecycle] ?? change.lifecycle
    const session = change.session?.attached ?? '—'
    return `| ${escapeCell(change.id)} | ${escapeCell(change.title)} | ${complexity} / ${risk} | ${escapeCell(renderStageCell(change))} | ${lifecycle} | ${escapeCell(session)} | ${formatActivityTime(change.updatedAt)} | ${renderArtifactLinks(change)} |`
  })
  return `${[...header, ...rows].join('\n')}\n`
}

/** 原子写变更台账。 */
export async function writeChangesIndex(
  fs: FileSystem,
  root: string,
  changes: ChangeStatus[],
): Promise<void> {
  const l = layout(root)
  await fs.mkdir(l.changesDir)
  const tmp = `${l.changesIndex}.tmp`
  await fs.writeFile(tmp, renderChangesIndex(changes))
  await fs.rename(tmp, l.changesIndex)
}

// ---------------------------------------------------------------------------
// 会话租约
// ---------------------------------------------------------------------------

/** 会话租约文件损坏（非法 JSON / 结构非法）：engine 汇总为损坏状态文件并进入锁定模式。 */
export class SessionLeaseCorruptionError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`会话租约文件损坏：${path}（${reason}）。等待负责人在授权卡片上修复（从账本重建）。`)
    this.name = 'SessionLeaseCorruptionError'
    this.path = path
    this.reason = reason
  }
}

/** 读取会话租约（文件缺失返回空数组；损坏时抛 SessionLeaseCorruptionError）。 */
export async function readLeases(fs: FileSystem, root: string): Promise<SessionLease[]> {
  const path = layout(root).sessions
  if (!(await fs.exists(path))) return []
  const raw = await fs.readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new SessionLeaseCorruptionError(path, `非法 JSON（${reason}）`)
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.leases : null
  if (!Array.isArray(list)) {
    throw new SessionLeaseCorruptionError(path, '缺少 leases 数组')
  }
  return list.filter(
    (item): item is SessionLease =>
      isRecord(item) &&
      typeof item.sessionId === 'string' &&
      typeof item.changeId === 'string' &&
      typeof item.attachedAt === 'string' &&
      typeof item.heartbeatAt === 'string',
  )
}

/** 原子写会话租约。 */
export async function writeLeases(
  fs: FileSystem,
  root: string,
  leases: SessionLease[],
): Promise<void> {
  const l = layout(root)
  await fs.mkdir(l.stateDir)
  const tmp = `${l.sessions}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify({ version: 1, leases }, null, 2)}\n`)
  await fs.rename(tmp, l.sessions)
}

// ---------------------------------------------------------------------------
// 编号
// ---------------------------------------------------------------------------

/** 下一个变更编号：变更 `C-001`、分析任务 `A-001`。 */
export function nextChangeId(changes: { id: string }[], kind: 'change' | 'analysis'): string {
  const prefix = kind === 'analysis' ? 'A' : 'C'
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const change of changes) {
    const match = pattern.exec(change.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

/**
 * 下一个待处理项编号（03 §8.3：`RK-1` / `SC-1` / `PC-1` / `RL-1` / `OV-1` / `EX-1`，
 * 不补零）。
 * @param knownIds 额外已知 id（例如其他变更里的待处理项），用于避免跨变更重复编号。
 */
export function nextPendingId(
  pending: PendingItem[],
  kind: PendingItem['kind'],
  knownIds: string[] = [],
): string {
  const prefix = PENDING_PREFIX[kind]
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  let max = 0
  for (const id of [...pending.map((item) => item.id), ...knownIds]) {
    const match = pattern.exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${max + 1}`
}

/** 确保变更目录（含 specs/）存在；`/flow new` 立项时调用。 */
export async function ensureChangeDir(fs: FileSystem, root: string, changeId: string): Promise<void> {
  const paths = changePaths(root, changeId)
  await fs.mkdir(paths.dir)
  await fs.mkdir(paths.specsDir as string)
}

// ---------------------------------------------------------------------------
// /flow repair：从账本 + 产物重建
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function emptyStatus(id: string, at: string): ChangeStatus {
  return {
    id,
    kind: id.startsWith('A-') ? 'analysis' : 'change',
    title: id,
    complexity: 'medium',
    risk: 'normal',
    stage: 'S0',
    lifecycle: 'active',
    gates: {},
    batches: [],
    tasks: {},
    evidenceIds: [],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [],
    createdAt: at,
    updatedAt: at,
  }
}

/** 完整快照归一化：补齐数组/对象默认值，保证重建结果可被 engine 直接使用。 */
function normalizeSnapshot(snapshot: Record<string, unknown>, changeId: string, at: string): ChangeStatus {
  const base = emptyStatus(changeId, at)
  const merged: ChangeStatus = {
    ...base,
    ...(snapshot as unknown as Partial<ChangeStatus>),
    id: str(snapshot.id) ?? changeId,
    gates: isRecord(snapshot.gates) ? (snapshot.gates as ChangeStatus['gates']) : base.gates,
    batches: Array.isArray(snapshot.batches) ? (snapshot.batches as BatchState[]) : base.batches,
    tasks: isRecord(snapshot.tasks) ? (snapshot.tasks as Record<string, TaskState>) : base.tasks,
    evidenceIds: Array.isArray(snapshot.evidenceIds) ? (snapshot.evidenceIds as string[]) : base.evidenceIds,
    pending: Array.isArray(snapshot.pending) ? (snapshot.pending as PendingItem[]) : base.pending,
    overrides: Array.isArray(snapshot.overrides) ? (snapshot.overrides as ChangeStatus['overrides']) : base.overrides,
    exceptions: Array.isArray(snapshot.exceptions) ? (snapshot.exceptions as ChangeStatus['exceptions']) : base.exceptions,
    violations: Array.isArray(snapshot.violations) ? (snapshot.violations as Violation[]) : base.violations,
    reviews: Array.isArray(snapshot.reviews) ? (snapshot.reviews as ReviewRecord[]) : base.reviews,
    createdAt: str(snapshot.createdAt) ?? at,
    updatedAt: str(snapshot.updatedAt) ?? at,
  }
  return merged
}

function gateRecord(current: GateRecord | undefined, patch: Partial<GateRecord>): GateRecord {
  return { state: 'pending', attempts: 0, ...(current ?? {}), ...patch }
}

/**
 * 把账本事件折叠成变更状态列表。
 *
 * 权威来源是 `change.updated` 事件 `data.change` 里的完整 ChangeStatus 快照
 * （engine 每次持久化变更时追加）；没有快照时按常见事件做尽力而为的增量回填
 * （阶段、门、任务、会话、锁定等），用于账本被裁剪或旧账本的兼容。
 */
export function foldLedgerToChanges(events: LedgerEvent[]): ChangeStatus[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const byId = new Map<string, ChangeStatus>()
  for (const event of sorted) {
    const data = event.data ?? {}
    const snapshot = asRecord(data.change)
    const changeId = str(data.changeId) ?? (snapshot ? str(snapshot.id) : undefined)
    if (!changeId) continue
    const at = event.at
    let status = byId.get(changeId)
    if (snapshot) {
      status = normalizeSnapshot(snapshot, changeId, at)
      byId.set(changeId, status)
      continue
    }
    if (!status) {
      status = emptyStatus(changeId, at)
      byId.set(changeId, status)
    }
    applyIncrementalEvent(status, event, data, at)
    status.updatedAt = at
  }
  return [...byId.values()].sort((a, b) => compareChangeIdAsc(a.id, b.id))
}

function applyIncrementalEvent(
  change: ChangeStatus,
  event: LedgerEvent,
  data: Record<string, unknown>,
  at: string,
): void {
  const gate = str(data.gate) as GateId | undefined
  const taskId = str(data.taskId)
  switch (event.type) {
    case 'change.created': {
      change.title = str(data.title) ?? change.title
      if (str(data.kind) === 'analysis' || str(data.kind) === 'change') change.kind = str(data.kind) as 'analysis' | 'change'
      if (str(data.stage)) change.stage = str(data.stage) as StageId
      if (str(data.complexity)) change.complexity = str(data.complexity) as ChangeStatus['complexity']
      if (str(data.risk)) change.risk = str(data.risk) as ChangeStatus['risk']
      if (str(data.lifecycle)) change.lifecycle = str(data.lifecycle) as ChangeStatus['lifecycle']
      if (str(data.branch)) change.branch = str(data.branch)
      change.createdAt = at
      if (data.summary !== undefined) change.summary = str(data.summary)
      if (str(data.roadmap)) change.roadmap = str(data.roadmap)
      if (str(data.relatedTo)) change.relatedTo = str(data.relatedTo)
      if (isRecord(data.contract)) change.contract = data.contract as unknown as ChangeStatus['contract']
      break
    }
    case 'level.changed': {
      if (str(data.complexity)) change.complexity = str(data.complexity) as ChangeStatus['complexity']
      if (str(data.risk)) change.risk = str(data.risk) as ChangeStatus['risk']
      break
    }
    case 'stage.entered': {
      if (str(data.stage)) change.stage = str(data.stage) as StageId
      break
    }
    case 'gate.submitted': {
      if (gate) change.gates[gate] = gateRecord(change.gates[gate], { state: 'awaiting', submittedAt: at, attempts: (change.gates[gate]?.attempts ?? 0) + 1 })
      break
    }
    case 'gate.failed': {
      if (gate) {
        const items = Array.isArray(data.items) ? (data.items as GateRecord['items']) : undefined
        change.gates[gate] = gateRecord(change.gates[gate], items ? { state: 'failed', items } : { state: 'failed' })
      }
      break
    }
    case 'gate.passed': {
      if (gate) change.gates[gate] = gateRecord(change.gates[gate], { state: 'passed', passedAt: at })
      break
    }
    case 'gate.approved': {
      if (gate) change.gates[gate] = gateRecord(change.gates[gate], { state: 'passed', approvedAt: at })
      break
    }
    case 'gate.rejected': {
      if (gate) {
        const reason = str(data.reason) ?? str(data.rejectedReason) ?? ''
        change.gates[gate] = gateRecord(change.gates[gate], { state: 'failed', rejectedAt: at, rejectedReason: reason })
      }
      break
    }
    case 'task.started':
    case 'task.done':
    case 'task.blocked':
    case 'task.interrupted':
    case 'task.unblocked': {
      if (taskId) {
        const current: TaskState = change.tasks[taskId] ?? {
          id: taskId,
          batch: str(data.batch) ?? '',
          status: 'pending',
          tdd: 'none',
          evidenceIds: [],
          reviewIds: [],
        }
        if (event.type === 'task.started') {
          current.status = 'running'
          current.startedAt = at
          if (str(data.batch)) current.batch = str(data.batch) as string
          if (str(data.agent)) current.agent = str(data.agent)
        } else if (event.type === 'task.done') {
          current.status = 'done'
          current.finishedAt = at
        } else if (event.type === 'task.blocked') {
          current.status = 'blocked'
          current.blockReason = str(data.reason) ?? str(data.blockReason)
        } else if (event.type === 'task.unblocked') {
          // 负责人解锁连续失败熔断：失败计数清零、任务恢复执行（保留原 startedAt）。
          current.status = 'running'
          current.failureCount = 0
          current.blockReason = undefined
        } else {
          current.status = 'interrupted'
          current.interruptedAt = at
        }
        change.tasks[taskId] = current
        if (!change.batches.some((batch) => batch.id === current.batch) && current.batch !== '') {
          change.batches.push({ id: current.batch, mode: 'sequential', status: 'pending', tasks: [] })
        }
      }
      break
    }
    case 'evidence.recorded':
    case 'verify.receipt': {
      const evidenceId = str(data.evidenceId) ?? str(data.id)
      if (evidenceId && !change.evidenceIds.includes(evidenceId)) change.evidenceIds.push(evidenceId)
      break
    }
    case 'review.reported': {
      if (isRecord(data.review)) change.reviews.push(data.review as unknown as ReviewRecord)
      break
    }
    case 'violation.detected': {
      if (isRecord(data.violation)) change.violations.push(data.violation as unknown as Violation)
      break
    }
    case 'violation.cleared': {
      const violationId = str(data.violationId) ?? str(data.id)
      if (violationId) {
        const target = change.violations.find((violation) => violation.id === violationId)
        if (target) target.clearedAt = at
      }
      break
    }
    case 'session.attached':
    case 'session.takeover': {
      const sessionId = str(data.sessionId)
      if (sessionId) change.session = { attached: sessionId, heartbeat: at }
      break
    }
    case 'session.released': {
      if (change.session) change.session = { heartbeat: at }
      break
    }
    case 'change.paused': {
      change.lifecycle = 'paused'
      break
    }
    case 'change.resumed': {
      change.lifecycle = 'active'
      break
    }
    case 'lock.entered': {
      change.lock = { reason: str(data.reason) ?? '锁定', at, detail: str(data.detail) }
      change.lifecycle = 'locked'
      break
    }
    case 'lock.released': {
      delete change.lock
      if (change.lifecycle === 'locked') change.lifecycle = 'active'
      break
    }
    case 'batch.started': {
      const batchId = str(data.batchId)
      if (batchId) {
        const existing = change.batches.find((batch) => batch.id === batchId)
        const mode = str(data.mode) === 'parallel' ? 'parallel' : 'sequential'
        const tasks = Array.isArray(data.tasks) ? (data.tasks as string[]) : []
        if (existing) {
          existing.status = 'running'
          existing.startedAt = at
        } else {
          change.batches.push({ id: batchId, mode, status: 'running', tasks })
        }
      }
      break
    }
    case 'batch.completed': {
      const batchId = str(data.batchId)
      if (batchId) {
        const existing = change.batches.find((batch) => batch.id === batchId)
        if (existing) {
          existing.status = 'done'
          existing.completedAt = at
        }
      }
      break
    }
    default:
      break
  }
}

/** 折叠项目级锁定状态（`lock.entered` / `lock.released`）。 */
function foldProjectLock(events: LedgerEvent[]): ProjectState['locked'] {
  let locked: ProjectState['locked']
  for (const event of events) {
    if (event.type === 'lock.entered') {
      const data = event.data ?? {}
      locked = { reason: str(data.reason) ?? '锁定', at: event.at, detail: str(data.detail) }
    } else if (event.type === 'lock.released') {
      locked = undefined
    }
  }
  return locked
}

/** 读取账本原始事件（容错：跳过无法解析的行）；不校验 HMAC（校验用 ledger.verify）。 */
export async function readLedgerEvents(fs: FileSystem, path: string): Promise<LedgerEvent[]> {
  if (!(await fs.exists(path))) return []
  const raw = await fs.readFile(path)
  const events: LedgerEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        isRecord(parsed) &&
        typeof parsed.seq === 'number' &&
        typeof parsed.at === 'string' &&
        typeof parsed.type === 'string'
      ) {
        events.push({
          seq: parsed.seq,
          at: parsed.at,
          type: parsed.type as LedgerEvent['type'],
          data: isRecord(parsed.data) ? parsed.data : {},
          prev: typeof parsed.prev === 'string' ? parsed.prev : '',
          ...(typeof parsed.mac === 'string' ? { mac: parsed.mac } : {}),
        })
      }
    } catch {
      // 跳过损坏行；verify() 会报告具体行号。
    }
  }
  return events.sort((a, b) => a.seq - b.seq)
}

async function inferStatusFromArtifacts(
  fs: FileSystem,
  root: string,
  changeId: string,
): Promise<ChangeStatus | null> {
  const paths = changePaths(root, changeId)
  const probes: { path: string; stage: StageId }[] = [
    { path: paths.tasks, stage: 'S3' },
    { path: paths.design, stage: 'S3' },
    { path: paths.risk, stage: 'S3' },
    { path: paths.context, stage: 'S2' },
    { path: paths.clarify, stage: 'S1' },
    { path: paths.proposal, stage: 'S1' },
    { path: paths.spec, stage: 'S1' },
  ]
  let stage: StageId = 'S0'
  let latestMtime = 0
  let found = false
  for (const probe of probes) {
    if (await fs.exists(probe.path)) {
      found = true
      stage = probe.stage
      try {
        latestMtime = Math.max(latestMtime, await fs.mtimeMs(probe.path))
      } catch {
        // 忽略 mtime 读取失败。
      }
    }
  }
  if (!found) return null
  const at = latestMtime > 0 ? isoNow({ now: () => new Date(latestMtime) }) : isoNow()
  const status = emptyStatus(changeId, at)
  status.stage = stage
  return status
}

export interface RebuildStateResult {
  /** 重建后的全部变更状态（按编号升序）。 */
  changes: ChangeStatus[]
  /** 重写 status.json 的变更编号（缺失或由完整快照重建）。 */
  rebuilt: string[]
  /** 保留现有 status.json 的变更编号。 */
  kept: string[]
  /** 本次写回的 index.md 路径。 */
  index: string
}

/**
 * `/flow repair` 的核心：从账本和产物重建 status.json 与 changes/index.md。
 *
 * 规则：
 * 1. 撤销删除/损坏的 status.json：有 `change.updated` 完整快照 → 直接用快照；
 *    只有增量事件 → 尽力回填；change 目录里有产物但没有账本 → 按产物推断骨架。
 * 2. 现有且账本没有快照的 status.json 优先保留（避免 repair 丢信息）。
 * 3. 最后重写台账 index.md。
 */
export async function rebuildState(fs: FileSystem, root: string): Promise<RebuildStateResult> {
  const l = layout(root)
  const events = await readLedgerEvents(fs, l.ledger)
  const snapshotIds = new Set<string>()
  for (const event of events) {
    const data = event.data ?? {}
    if (isRecord(data.change)) {
      const id = str(data.changeId) ?? str((data.change as Record<string, unknown>).id)
      if (id) snapshotIds.add(id)
    }
  }
  const folded = new Map(foldLedgerToChanges(events).map((change) => [change.id, change]))

  const existing = new Map<string, ChangeStatus>()
  let entries: string[] = []
  try {
    entries = await fs.readdir(l.changesDir)
  } catch {
    entries = []
  }
  const dirIds: string[] = []
  for (const entry of entries.sort()) {
    if (entry.endsWith('.md') || entry.endsWith('.json')) continue
    dirIds.push(entry)
    try {
      const status = await readChangeStatus(fs, root, entry)
      if (status) existing.set(entry, status)
    } catch {
      // 损坏的 status.json 会被账本重建覆盖。
    }
  }

  const ids = new Set<string>([...existing.keys(), ...folded.keys(), ...dirIds])
  const finalChanges: ChangeStatus[] = []
  const rebuilt: string[] = []
  const kept: string[] = []
  for (const id of [...ids].sort(compareChangeIdAsc)) {
    const foldedStatus = folded.get(id)
    const existingStatus = existing.get(id)
    let status: ChangeStatus | null = null
    let needWrite = false
    if (foldedStatus && (!existingStatus || snapshotIds.has(id))) {
      status = foldedStatus
      needWrite = true
    } else if (existingStatus) {
      status = existingStatus
    } else if (foldedStatus) {
      status = foldedStatus
      needWrite = true
    } else {
      const inferred = await inferStatusFromArtifacts(fs, root, id)
      if (inferred) {
        status = inferred
        needWrite = true
      }
    }
    if (!status) continue
    finalChanges.push(status)
    if (needWrite) {
      await writeChangeStatus(fs, root, status)
      rebuilt.push(id)
    } else {
      kept.push(id)
    }
  }
  await writeChangesIndex(fs, root, finalChanges)
  return { changes: finalChanges, rebuilt, kept, index: l.changesIndex }
}
