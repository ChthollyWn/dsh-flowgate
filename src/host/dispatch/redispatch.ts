/**
 * 中断任务重新派发前的安全检查（T4.6 最后一条 / 03 §7.5）。
 *
 * 流程：会话关闭时 `engine.releaseSession()` 会把 `running`/`review` 的任务标成
 * `interrupted`；下次派发时 `engine.dispatchNext()` 会把这些任务当 queued 直接重派。
 * 如果旧的子 agent 还活着（同一宿主进程内、或宿主注册表里仍有记录），就会出现
 * 两个执行者同时改同一个 worktree/任务的情况。
 *
 * 因此 host 在调用 `engine.dispatchNext()` 之前先确认：
 * - 旧子 agent 的 id 来自任务状态（并行任务持久化的 `task.agent`）或本进程派发记录；
 * - 确认方式：宿主 `ctx.agents` 注册表里查不到该 agent（已注销）或本进程记录到
 *   activation 已 `dispose()`（资源已释放）；执行者子 agent 的 `maxDepth` 是 1，
 *   不会有后代，因此只确认直接子 agent；
 * - 确认不了（没记录 id / agents 服务不可用 / 仍在注册表里）→ **保持阻塞**，并用
 *   `engine.reportRisk()` 生成一条待处理项（`category = flowgate-redispatch:<taskId>`），
 *   负责人确认旧子 agent 已停止后运行 `/flow risk approve <RK-id>` 显式授权重新派发，
 *   或 `/flow risk reject` 并手动处理。已生成的 open/approved/rejected 记录本身也作为
 *   幂等标记，避免每次派发都重复生成待处理项。
 */
import type { DshAgent, DshAgentRegistry } from '../adapters/dsh-types.js'
import type { EngineLike } from '../types.js'
import type { HostRuntime } from '../runtime.js'
import type { PendingItem } from '../../core/types.js'
import { toAgentError } from '../errors.js'

/** `engine.reportRisk` 的 category 标记前缀（`<前缀>:<taskId>`；数据进 pending.data.category）。 */
export const DISPATCH_SAFETY_CATEGORY = 'flowgate-redispatch'

const AGENTS_SERVICE = 'agents'

/** `${changeId}/${taskId}` → 最近一次派发的子 agent id（内存记录；并行任务另有持久化的 task.agent）。 */
const lastChildByTask = new Map<string, string>()
/** 本进程里已完成 `activation.dispose()`（资源已释放）的子 agent id。 */
const releasedChildren = new Set<string>()
/** 已消费过的一次性授权（approved 的 safety 待处理项 id）：每次授权只放行一次重新派发。 */
const consumedAuthorizations = new Set<string>()

function childKey(changeId: string, taskId: string): string {
  return `${changeId}/${taskId}`
}

/** 记录一次成功的子 agent 启动（startExecutor 调用）。 */
export function recordDispatchedChild(changeId: string, taskId: string, childId: string): void {
  lastChildByTask.set(childKey(changeId, taskId), childId)
}

/** 记录一次子 agent 资源释放（activation.dispose 成功后调用）。 */
export function recordReleasedChild(childId: string): void {
  releasedChildren.add(childId)
}

/** 测试用：清空模块级派发/释放/授权记录。 */
export function resetRedispatchStateForTest(): void {
  lastChildByTask.clear()
  releasedChildren.clear()
  consumedAuthorizations.clear()
}

export interface RedispatchTaskProblem {
  taskId: string
  reason: string
}

export interface RedispatchCheck {
  ok: boolean
  /** 无法确认旧子 agent 已停止的中断任务及原因。 */
  problems: RedispatchTaskProblem[]
  /** 本次生成或此前已存在、与本次阻塞相关的待处理项。 */
  pending: PendingItem[]
  message?: string
  hint?: string
}

function safetyCategory(taskId: string): string {
  return `${DISPATCH_SAFETY_CATEGORY}:${taskId}`
}

/**
 * 该任务是否有负责人尚未消费的显式授权（safety 待处理项被 approved 且未用过）。
 * 授权是一次性的：用过即消费，避免旧授权让之后新发生的中断也被静默放行。
 */
function ownerAuthorized(change: { pending: PendingItem[] }, taskId: string): PendingItem | undefined {
  const marker = safetyCategory(taskId)
  return change.pending.find(
    (item) =>
      item.status === 'approved' &&
      !consumedAuthorizations.has(item.id) &&
      typeof item.data?.category === 'string' &&
      item.data.category === marker,
  )
}

/** 该任务被负责人退回过的待处理项（存在则继续阻塞且不再生成新的，避免刷屏）。 */
function rejectedItems(change: { pending: PendingItem[] }, taskId: string): PendingItem[] {
  const marker = safetyCategory(taskId)
  return change.pending.filter(
    (item) => item.status === 'rejected' && typeof item.data?.category === 'string' && item.data.category === marker,
  )
}

/** 已存在、仍 open 的 safety 待处理项（避免重复生成）。 */
function openSafetyItems(change: { pending: PendingItem[] }, taskId: string): PendingItem[] {
  const marker = safetyCategory(taskId)
  return change.pending.filter(
    (item) => item.status === 'open' && typeof item.data?.category === 'string' && item.data.category === marker,
  )
}

interface StopVerdict {
  confirmed: boolean
  reason: string
}

/**
 * 确认旧子 agent（及其后代——执行者 maxDepth=1，无后代）已停止、资源已释放。
 * 判定顺序：本进程已 dispose → 宿主注册表查不到 → 其余一律视为"无法确认"。
 */
function confirmChildrenStopped(registry: DshAgentRegistry | null, candidates: readonly string[]): StopVerdict {
  if (candidates.length === 0) {
    return { confirmed: false, reason: '没有记录旧子 agent id，无法向宿主确认其已停止' }
  }
  const unreleased = candidates.filter((id) => !releasedChildren.has(id))
  if (unreleased.length === 0) return { confirmed: true, reason: '' }
  if (!registry || typeof registry.get !== 'function') {
    return { confirmed: false, reason: '宿主未提供 agents 服务，无法确认旧子 agent 是否已停止' }
  }
  for (const id of unreleased) {
    let child: DshAgent | undefined
    try {
      child = registry.get(id)
    } catch (error) {
      return { confirmed: false, reason: `查询旧子 agent ${id} 失败：${toAgentError(error).error}` }
    }
    if (child === undefined || child === null) continue // 已从宿主注销：视为已停止/已释放。
    if (child.status === 'running') return { confirmed: false, reason: `旧子 agent ${id} 仍在运行` }
    return {
      confirmed: false,
      reason: `旧子 agent ${id} 仍在宿主注册表中（status=${child.status ?? 'unknown'}），无法确认资源已释放`,
    }
  }
  return { confirmed: true, reason: '' }
}

/** 生成一条待处理项（失败只降级，不阻断"保持阻塞"本身）。 */
async function createSafetyPending(
  runtime: HostRuntime,
  engine: EngineLike,
  taskId: string,
  candidates: readonly string[],
  reason: string,
): Promise<PendingItem | null> {
  try {
    return await engine.reportRisk({
      category: safetyCategory(taskId),
      description: `重新派发中断任务 ${taskId} 前无法确认旧子 agent 已停止/资源已释放：${reason}`,
      proposal: `旧子 agent：${candidates.join('、') || '未记录 id'}。确认其在宿主中已停止且资源已释放后，等待负责人在授权卡片上批准重新派发（RK-id）；无法确认时退回该待处理项并手动处理任务。`,
    })
  } catch (error) {
    runtime.noteFeature('dispatch', `中断任务 ${taskId} 的待处理项生成失败：${toAgentError(error).error}`)
    return null
  }
}

/**
 * 派发前检查：所有 `interrupted` 任务的旧子 agent 都必须确认已停止/已释放，
 * 否则返回 `ok:false`（调用方据此拒绝派发并展示原因/待处理项）。
 */
export async function checkInterruptedRedispatch(runtime: HostRuntime, engine: EngineLike): Promise<RedispatchCheck> {
  let change: ReturnType<EngineLike['currentChange']>
  try {
    change = engine.currentChange()
  } catch (error) {
    return {
      ok: false,
      problems: [],
      pending: [],
      message: `无法读取当前变更状态：${toAgentError(error).error}`,
      hint: '在 FlowGate 面板查看状态，或运行 /flow doctor 诊断后再派发',
    }
  }
  if (!change) return { ok: true, problems: [], pending: [] }
  const interrupted = Object.values(change.tasks).filter((task) => task.status === 'interrupted')
  if (interrupted.length === 0) return { ok: true, problems: [], pending: [] }

  const registry = runtime.getService<DshAgentRegistry>(AGENTS_SERVICE)
  const problems: RedispatchTaskProblem[] = []
  const pending: PendingItem[] = []
  /** 本次检查消费的负责人授权（全部任务都放行后才真正标记消费）。 */
  const authorizations: PendingItem[] = []

  for (const task of interrupted) {
    const authorization = ownerAuthorized(change, task.id)
    if (authorization) {
      authorizations.push(authorization) // 负责人已显式授权重新派发。
      continue
    }
    const candidates = [...new Set([task.agent, lastChildByTask.get(childKey(change.id, task.id))].filter((id): id is string => typeof id === 'string' && id !== ''))]
    const verdict = confirmChildrenStopped(registry, candidates)
    if (verdict.confirmed) continue // 已确认停止/资源已释放：即使曾被退回也可以安全重派。
    const rejected = rejectedItems(change, task.id)
    if (rejected.length > 0) {
      problems.push({
        taskId: task.id,
        reason: `负责人已退回该中断任务的重新派发（${rejected.map((item) => item.id).join('、')}），请先手动处理旧子 agent 与任务状态`,
      })
      continue
    }
    problems.push({ taskId: task.id, reason: verdict.reason })
    const existing = openSafetyItems(change, task.id)[0]
    const item = existing ?? (await createSafetyPending(runtime, engine, task.id, candidates, verdict.reason))
    if (item) pending.push(item)
  }

  if (problems.length === 0) {
    // 放行后才消费一次性授权（其它任务仍被阻塞时保留授权，下次继续可用）。
    for (const item of authorizations) consumedAuthorizations.add(item.id)
    return { ok: true, problems, pending }
  }
  const detail = problems.map((problem) => `${problem.taskId}：${problem.reason}`).join('；')
  const ids = pending.map((item) => item.id)
  return {
    ok: false,
    problems,
    pending,
    message: `不能重新派发中断任务：${detail}`,
    hint:
      ids.length > 0
        ? `已记录为待处理项 ${ids.join('、')}；确认旧子 agent 已停止且资源已释放后，等待负责人在授权卡片上批准重新派发（${ids[0]}）或退回后手动处理`
        : '先确认旧子 agent 已停止、资源已释放；无法确认时在 FlowGate 面板查看待处理项并人工处理',
  }
}
