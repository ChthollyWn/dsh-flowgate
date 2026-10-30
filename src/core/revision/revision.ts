/**
 * 返工失效范围（03 §6.8 / FR-5.12 / T3.8）。
 *
 * 返工类型决定哪些证据回执与审查作废：
 * - 缺陷返工（指定受影响任务）：这些任务 + 沿 `depends_on` 依赖它们的下游任务失效；
 *   其他任务的回执和审查保留；整个变更的终审失效由 engine 依据失效集合处理（阶段不变）。
 * - 需求/方案变更（`requirement`）：全部回执和审查失效，回到 S1 重新澄清。
 * - 影响不明（`unknown`）：全部回执和审查失效；阶段不擅自改变，由发动机决定退回位置。
 *
 * 几个任务共用的输入（例如同一个配置文件）变化时，engine 按输入哈希算出受影响
 * 的任务，传入 `sharedInputsChanged` 扩大失效范围（本模块把它当作额外的任务 id）。
 *
 * 契约扩展：`dependsOn` 是可选的任务依赖图（engine 从 tasks.md 传入），
 * 因为 `ChangeStatus` 只存任务运行态、不存任务卡。没有传时只按显式任务集合失效。
 */
import type { ChangeStatus, StageId } from '../types'

export type ReworkKind = 'defect' | 'requirement' | 'unknown'

export interface ReworkInput {
  kind: ReworkKind
  /** 缺陷返工时受影响的任务 id；不指定则保守地让全部任务失效。 */
  taskIds?: string[]
  /** 受共用输入变化影响的任务 id（engine 按验证组输入哈希算好后传入）。 */
  sharedInputsChanged?: string[]
  /** 契约扩展：任务依赖图 `{ 任务 id: [它依赖的任务 id...] }`，用于向下扩散。 */
  dependsOn?: Record<string, string[]>
}

export interface ReworkOutcome {
  invalidatedTasks: string[]
  keptTasks: string[]
  stage: StageId
}

function naturalCompare(a: string, b: string): number {
  const matchA = /^([A-Za-z]+)-?(\d+)$/.exec(a)
  const matchB = /^([A-Za-z]+)-?(\d+)$/.exec(b)
  if (matchA && matchB) {
    if (matchA[1] !== matchB[1]) return matchA[1]!.localeCompare(matchB[1]!)
    return Number(matchA[2]) - Number(matchB[2])
  }
  return a.localeCompare(b)
}

/** 沿依赖图向下扩散：任何依赖集合内任务的任务都加入失效集合。 */
function expandDownstream(
  invalidated: Set<string>,
  allTaskIds: string[],
  dependsOn: Record<string, string[]>,
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const taskId of allTaskIds) {
      if (invalidated.has(taskId)) continue
      const dependencies = dependsOn[taskId] ?? []
      if (dependencies.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(taskId)
        changed = true
      }
    }
  }
}

/**
 * 计算返工失效集合。
 * @returns `invalidatedTasks` / `keptTasks` 按任务编号自然排序；`stage` 是建议回到的阶段。
 */
export function invalidateOnRework(change: ChangeStatus, input: ReworkInput): ReworkOutcome {
  const allTaskIds = Object.keys(change.tasks).sort(naturalCompare)

  // 需求变更 / 影响不明：全部回执和审查失效（历史记录只作留痕，由 engine 保留账本）。
  if (input.kind === 'requirement' || input.kind === 'unknown') {
    return {
      invalidatedTasks: [...allTaskIds],
      keptTasks: [],
      stage: input.kind === 'requirement' ? ('S1' as StageId) : change.stage,
    }
  }

  // 缺陷返工：显式受影响任务 ∪ 共用输入变化影响的任务，再沿依赖向下扩散。
  const declared = [...(input.taskIds ?? []), ...(input.sharedInputsChanged ?? [])]
  const invalidated = new Set<string>()
  for (const taskId of declared) {
    if (allTaskIds.includes(taskId)) invalidated.add(taskId)
  }
  // 没有声明任何受影响任务时保守处理：全部失效，避免把坏证据当成好证据。
  if (invalidated.size === 0) {
    for (const taskId of allTaskIds) invalidated.add(taskId)
  }
  expandDownstream(invalidated, allTaskIds, input.dependsOn ?? {})

  const invalidatedTasks = [...invalidated].sort(naturalCompare)
  const keptTasks = allTaskIds.filter((taskId) => !invalidated.has(taskId))
  return { invalidatedTasks, keptTasks, stage: change.stage }
}
