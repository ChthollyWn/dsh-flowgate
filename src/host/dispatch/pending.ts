/**
 * 派发链路上的"待处理项"可见性与通知（T4.6 / T4.9，03 §7.5 / §8.3）。
 *
 * 背景（真机 C-004）：并行批次里的执行者越界后会调用 `flow_request_scope_change`
 * 生成 `SC-n` 待处理项；此前 host 只把 pending 留在状态里，既不通知主会话也不
 * 阻断后续派发，负责人可能完全不知道有东西在等自己处理。
 *
 * 本模块提供两条最小路径：
 * 1. 通知：子 agent 结算后把"尚未通知过"的待处理项注入主会话（不唤醒，下一步生效），
 *    同一条 pending 只通知一次（避免 T1/T2 各自结算时重复刷屏）；
 * 2. 可见：`flow_dispatch_next` 的结构化返回里带 `pending` 列表；有未审批的
 *    scope/plan/risk 时由调用方直接拒绝派发（见 `blockingPendingItems`）。
 *
 * 这里只读 `engine.currentChange().pending`（内存快照），不做 IO、不抛错。
 */
import type { EngineLike } from '../types.js'
import type { PendingItem, PendingKind } from '../../core/types.js'

/** 需要负责人处理的待处理项类型（全量；通知用）。 */
export const OWNER_PENDING_KINDS: readonly PendingKind[] = ['scope', 'plan', 'risk', 'rule', 'conflict', 'blocker']

/**
 * 未处理时会阻断后续派发的待处理项类型（T4.6 验收：scope/plan/risk）。
 * `rule` 提议不阻塞执行；`conflict`/`blocker` 由批次/任务状态另行阻塞。
 */
export const BLOCKING_PENDING_KINDS: readonly PendingKind[] = ['scope', 'plan', 'risk']

/** 已通知过主会话的待处理项 id（模块级；测试用 reset 清理）。 */
const notifiedPendingIds = new Set<string>()

/** 结构化返回里的一条待处理项（模型可见，字段保持稳定）。 */
export interface PendingView {
  id: string
  kind: PendingKind
  title: string
  status: PendingItem['status']
  taskId?: string
}

/** 当前变更里处于 open 状态的待处理项（按 kind 过滤；读快照失败时返回空）。 */
export function openOwnerPending(
  engine: EngineLike,
  kinds: readonly PendingKind[] = OWNER_PENDING_KINDS,
): PendingItem[] {
  try {
    const change = engine.currentChange()
    if (!change) return []
    return change.pending.filter((item) => item.status === 'open' && kinds.includes(item.kind))
  } catch {
    return []
  }
}

/** 未审批时会阻断派发的待处理项（scope/plan/risk）。 */
export function blockingPendingItems(engine: EngineLike): PendingItem[] {
  return openOwnerPending(engine, BLOCKING_PENDING_KINDS)
}

/** 待处理项 → 负责人可执行的命令提示（scope/plan/risk/rule 与 /flow 子命令一一对应）。 */
export function pendingHint(item: PendingItem): string {
  switch (item.kind) {
    case 'scope':
      return `/flow scope approve ${item.id} 或 /flow scope reject ${item.id} <理由>`
    case 'plan':
      return `/flow plan approve ${item.id} 或 /flow plan reject ${item.id} <理由>`
    case 'risk':
      return `/flow risk approve ${item.id} 或 /flow risk reject ${item.id} <理由>`
    case 'rule':
      return `/flow rule approve ${item.id} 或 /flow rule reject ${item.id} <理由>`
    case 'conflict':
      return '集成检查点失败/冲突：修复冲突或测试失败后重新派发；详情见 /flow status'
    case 'blocker':
      return '任务失败/中断：决定重试或调整执行计划；详情见 /flow status'
    default:
      return '运行 /flow 查看待处理项并决定如何处理'
  }
}

/** 待处理项 → 结构化返回条目。 */
export function pendingView(items: readonly PendingItem[]): PendingView[] {
  return items.map((item) => {
    const taskId = item.scope?.taskId ?? (typeof item.data?.taskId === 'string' ? item.data.taskId : undefined)
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: item.status,
      ...(taskId ? { taskId } : {}),
    }
  })
}

/** 待处理项 → 注入主会话的文本行（空数组表示没有）。 */
export function pendingLines(items: readonly PendingItem[]): string[] {
  if (items.length === 0) return []
  const lines = [`[FlowGate] 有 ${items.length} 个待处理项需要负责人处理（scope/plan/risk 未处理时会阻断派发）：`]
  for (const item of items) lines.push(`- ${item.id} ${item.title}：${pendingHint(item)}`)
  return lines
}

/**
 * 取出"尚未通知过"的 open 待处理项并标记为已通知。
 * 同步执行（引擎状态读取 + Set 标记之间没有 await），并发结算不会重复通知。
 */
export function consumeUnnotifiedOwnerPending(engine: EngineLike): PendingItem[] {
  const items = openOwnerPending(engine).filter((item) => !notifiedPendingIds.has(item.id))
  for (const item of items) notifiedPendingIds.add(item.id)
  return items
}

/** 测试用：清空通知去重状态。 */
export function resetPendingNotificationForTest(): void {
  notifiedPendingIds.clear()
}
