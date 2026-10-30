/**
 * Execution plan checks (G3 parallel safety) and execution graph rendering.
 *
 * The plan is written by the agent at the end of `tasks.md`; FlowGate never
 * lets the agent hand-write the graph, so the rendered mermaid always matches
 * the checked plan.
 */
import type {
  CheckOutcome,
  ChangeStatus,
  ExecutionBatch,
  ExecutionPlan,
  FlowgateConfig,
  TaskCard,
} from '../types'
import { globsMayOverlap, isConcretePattern, matchGlob } from '../util/glob'
import { HOTSPOT_PATTERNS as KERNEL_HOTSPOT_PATTERNS } from '../rules'
import { normalizeRelPath } from '../util/paths'

/**
 * Hot files that parallel batches must not touch. Reused from the rules kernel
 * (`rules/risk-triggers.ts#HOTSPOT_PATTERNS`, FR-2.8) plus per-project extras in
 * `config.parallel.hotspots_extra`.
 */
export const HOTSPOT_PATTERNS: readonly string[] = KERNEL_HOTSPOT_PATTERNS

const BATCH_MODE_LABEL: Record<ExecutionBatch['mode'], string> = {
  sequential: '顺序',
  parallel: '并行',
}

const BATCH_STATUS_LABEL: Record<string, string> = {
  pending: '未开始',
  running: '进行中',
  checkpoint: '集成检查中',
  done: '已完成',
  failed: '失败',
  blocked: '阻塞',
}

function normalizeTaskId(value: string): string {
  const match = /T\s*0*(\d+)/i.exec(value)
  return match ? `T${Number.parseInt(match[1]!, 10)}` : value.trim()
}

function taskById(tasks: readonly TaskCard[]): Map<string, TaskCard> {
  const map = new Map<string, TaskCard>()
  for (const task of tasks) map.set(normalizeTaskId(task.id), task)
  return map
}

/** Every repo-relative file pattern a task declares: scope, tests, new files, deletes/renames. */
export function filesOfTask(task: TaskCard): string[] {
  const files: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined) return
    const normalized = normalizeRelPath(value)
    if (normalized !== '' && !files.includes(normalized)) files.push(normalized)
  }
  for (const entry of task.scope) push(entry)
  for (const entry of task.tests) push(entry)
  for (const entry of task.newFiles) push(entry)
  for (const change of task.changes) {
    push(change.path)
    push(change.to)
  }
  return files
}

/** True when a declared file pattern may touch a hotspot file. */
export function isHotspotPattern(pattern: string, config: FlowgateConfig): boolean {
  const normalized = normalizeRelPath(pattern)
  if (normalized === '') return false
  const hotspots = [...HOTSPOT_PATTERNS, ...(config.parallel?.hotspots_extra ?? [])].map((hotspot) =>
    normalizeRelPath(hotspot),
  )
  const directoryHotspots = hotspots.filter((hotspot) => hotspot.endsWith('/**'))
  const fileHotspots = hotspots.filter((hotspot) => !hotspot.endsWith('/**'))
  if (isConcretePattern(normalized)) {
    return hotspots.some((hotspot) => matchGlob(hotspot, normalized))
  }
  if (normalized.endsWith('/**')) {
    // A directory scope: flag only when the directory itself is a hotspot
    // location (e.g. .../db/migration/**, .../locales/**). A generic module
    // glob such as .../renewal/** must not be treated as touching pom.xml.
    const dirPrefix = normalized.slice(0, -3)
    for (const hotspot of fileHotspots) if (matchGlob(hotspot, dirPrefix)) return true
    for (const hotspot of directoryHotspots) {
      const base = hotspot.slice(0, -3)
      if (base !== '' && matchGlob(base, dirPrefix)) return true
    }
    return false
  }
  // A file-ish wildcard (e.g. src/**/pom.xml): compare against file hotspots.
  return fileHotspots.some((hotspot) => globsMayOverlap(hotspot, normalized))
}

/** Overlapping files between any two tasks of a batch (parallel batches only). */
export function batchOverlaps(tasks: TaskCard[], batch: ExecutionBatch): { a: string; b: string; path: string }[] {
  const byId = taskById(tasks)
  const overlaps: { a: string; b: string; path: string }[] = []
  const seen = new Set<string>()
  const ids = batch.tasks.map(normalizeTaskId)
  for (let i = 0; i < ids.length; i += 1) {
    const a = byId.get(ids[i]!)
    if (!a) continue
    for (let j = i + 1; j < ids.length; j += 1) {
      const b = byId.get(ids[j]!)
      if (!b) continue
      for (const pa of filesOfTask(a)) {
        for (const pb of filesOfTask(b)) {
          if (!globsMayOverlap(pa, pb)) continue
          const key = `${ids[i]}|${ids[j]}|${pa}|${pb}`
          if (seen.has(key)) continue
          seen.add(key)
          const path = pa === pb ? pa : `${pa} ∩ ${pb}`
          overlaps.push({ a: ids[i]!, b: ids[j]!, path })
        }
      }
    }
  }
  return overlaps
}

interface TaskPlacement {
  batchIndex: number
  batchId: string
  mode: ExecutionBatch['mode']
  indexInBatch: number
}

function placements(plan: ExecutionPlan, tasks: readonly TaskCard[]): {
  placement: Map<string, TaskPlacement>
  duplicates: string[]
  unknown: string[]
} {
  const known = taskById(tasks)
  const placement = new Map<string, TaskPlacement>()
  const duplicates: string[] = []
  const unknown: string[] = []
  for (const [batchIndex, batch] of plan.batches.entries()) {
    for (const [indexInBatch, rawId] of batch.tasks.entries()) {
      const id = normalizeTaskId(rawId)
      if (!known.has(id)) unknown.push(id)
      if (placement.has(id)) duplicates.push(id)
      else placement.set(id, { batchIndex, batchId: batch.batch, mode: batch.mode, indexInBatch })
    }
  }
  return { placement, duplicates, unknown }
}

/**
 * Dependency violations for the plan. A dependency may only point at an earlier
 * batch, or at a task ordered before it inside the same *sequential* batch.
 */
export function taskDependenciesRespectBatches(tasks: TaskCard[], plan: ExecutionPlan): string[] {
  const { placement } = placements(plan, tasks)
  const violations: string[] = []
  const known = taskById(tasks)
  for (const task of tasks) {
    const id = normalizeTaskId(task.id)
    const own = placement.get(id)
    for (const rawDep of task.dependsOn) {
      const dep = normalizeTaskId(rawDep)
      if (!known.has(dep)) {
        violations.push(`任务 ${id} 依赖了不存在的任务 ${dep}`)
        continue
      }
      if (!own) continue
      const target = placement.get(dep)
      if (!target) {
        violations.push(`任务 ${id} 依赖的任务 ${dep} 不在执行计划中`)
        continue
      }
      if (target.batchIndex > own.batchIndex) {
        violations.push(`任务 ${id}（${own.batchId}）依赖了更晚批次 ${target.batchId} 的任务 ${dep}`)
        continue
      }
      if (target.batchIndex === own.batchIndex) {
        if (own.mode === 'parallel') {
          violations.push(`并行批次 ${own.batchId} 内的任务 ${id} 依赖了同批次任务 ${dep}：并行任务必须互不依赖`)
        } else if (target.indexInBatch >= own.indexInBatch) {
          violations.push(
            `顺序批次 ${own.batchId} 内任务 ${id} 依赖了排在其后的任务 ${dep}：依赖必须指向更早执行的任务`,
          )
        }
      }
    }
  }
  return violations
}

function planStructureViolations(tasks: TaskCard[], plan: ExecutionPlan): string[] {
  const violations: string[] = []
  const taskIds = tasks.map((task) => normalizeTaskId(task.id))
  if (plan.batches.length === 0) {
    violations.push('执行计划为空：请把全部任务分进若干批次')
    return violations
  }
  const batchIds = new Set<string>()
  const placed = new Map<string, string>()
  for (const batch of plan.batches) {
    const batchId = batch.batch.trim()
    if (batchId === '') violations.push('存在没有编号的批次')
    if (batchIds.has(batchId)) violations.push(`批次编号重复：${batchId}`)
    batchIds.add(batchId)
    if (batch.tasks.length === 0) violations.push(`批次 ${batchId} 没有任务`)
    if (batch.why.trim() === '') violations.push(`批次 ${batchId} 没有写 why：必须说明为什么必须顺序或可以并行`)
    for (const rawId of batch.tasks) {
      const id = normalizeTaskId(rawId)
      if (placed.has(id)) {
        violations.push(`任务 ${id} 同时出现在批次 ${placed.get(id)} 和 ${batchId}：每个任务必须恰好属于一个批次`)
      } else {
        placed.set(id, batchId)
      }
      if (!taskIds.includes(id)) violations.push(`批次 ${batchId} 引用了不存在的任务 ${id}`)
    }
  }
  for (const id of taskIds) {
    if (!placed.has(id)) violations.push(`任务 ${id} 没有被排进任何批次`)
  }
  return violations
}

function parallelSafetyViolations(tasks: TaskCard[], plan: ExecutionPlan, config: FlowgateConfig): string[] {
  const violations: string[] = []
  for (const batch of plan.batches) {
    if (batch.mode !== 'parallel') continue
    for (const overlap of batchOverlaps(tasks, batch)) {
      violations.push(
        `并行批次 ${batch.batch} 内任务 ${overlap.a} 与 ${overlap.b} 的范围重叠：${overlap.path}；改为顺序批次，或把共享部分拆成独立任务`,
      )
    }
    const byId = taskById(tasks)
    for (const rawId of batch.tasks) {
      const id = normalizeTaskId(rawId)
      const task = byId.get(id)
      if (!task) continue
      for (const pattern of filesOfTask(task)) {
        if (!isHotspotPattern(pattern, config)) continue
        violations.push(
          `并行批次 ${batch.batch} 内的任务 ${id} 触碰热点文件 ${pattern}（依赖清单/锁文件、路由、依赖注入配置、数据库迁移、共享类型、i18n、CHANGELOG）：请把对热点文件的修改移到前面的顺序批次`,
        )
      }
    }
  }
  return violations
}

/**
 * Full G3 execution-plan check: placement, dependency order, parallel safety,
 * hotspot files and per-batch rationale.
 */
export function checkExecutionPlan(tasks: TaskCard[], plan: ExecutionPlan, config: FlowgateConfig): CheckOutcome {
  const violations: string[] = []
  try {
    violations.push(...planStructureViolations(tasks, plan))
    violations.push(...taskDependenciesRespectBatches(tasks, plan))
    violations.push(...parallelSafetyViolations(tasks, plan, config))
  } catch (error) {
    return {
      item: 'g3.executionPlan',
      label: '执行计划通过检查（批次划分、依赖顺序、并行范围、热点文件、批次理由）',
      passed: false,
      hint: `执行计划解析失败：${(error as Error).message}；请检查 tasks.md 末尾的 execution YAML 块。`,
      example: defaultPlanExample(),
      priority: 'P0',
    }
  }
  return {
    item: 'g3.executionPlan',
    label: '执行计划通过检查（批次划分、依赖顺序、并行范围、热点文件、批次理由）',
    passed: violations.length === 0,
    hint:
      violations.length === 0
        ? undefined
        : '执行计划未通过：按批次顺序整理依赖，把碰热点文件或范围重叠的任务移出并行批次；每个批次都要写 why。',
    example: violations.length === 0 ? undefined : defaultPlanExample(),
    details: violations.length === 0 ? undefined : violations,
    priority: 'P0',
  }
}

function defaultPlanExample(): string {
  return [
    'execution:',
    '  - batch: B1',
    '    mode: sequential',
    '    tasks: [T1, T2]',
    '    why: T2 要在 T1 建好的表结构上实现接口，且两者都改 pom.xml',
    '  - batch: B2',
    '    mode: parallel',
    '    tasks: [T3, T4]',
    '    why: 两块范围互不重叠，都只依赖 B1',
  ].join('\n')
}

/** First batch that may be dispatched now, or null when nothing is runnable. */
export function nextRunnableBatch(change: ChangeStatus): ExecutionBatch | null {
  const batches = change.batches ?? []
  for (const [index, batch] of batches.entries()) {
    if (batch.status === 'done') continue
    const previousDone = batches.slice(0, index).every((previous) => previous.status === 'done')
    if (!previousDone) return null
    if (batch.status === 'pending') {
      return { batch: batch.id, mode: batch.mode, tasks: batch.tasks, why: '' }
    }
    return null
  }
  return null
}

type DiagramClass = 'done' | 'running' | 'pending'

function mermaidId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `N_${cleaned}`
}

function escapeLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/\n/g, ' ')
}

function taskClass(change: ChangeStatus, taskId: string): DiagramClass {
  const state = change.tasks?.[taskId] ?? change.tasks?.[normalizeTaskId(taskId)]
  if (!state) return 'pending'
  if (state.status === 'done' || state.status === 'skipped') return 'done'
  if (state.status === 'running' || state.status === 'review') return 'running'
  return 'pending'
}

function checkpointClass(change: ChangeStatus, batchId: string): DiagramClass {
  const state = change.batches?.find((batch) => batch.id === batchId)
  if (!state) return 'pending'
  if (state.status === 'done') return 'done'
  if (state.status === 'running' || state.status === 'checkpoint') return 'running'
  return 'pending'
}

function pushClass(groups: Map<DiagramClass, string[]>, cls: DiagramClass, nodeId: string): void {
  const list = groups.get(cls) ?? []
  if (!list.includes(nodeId)) list.push(nodeId)
  groups.set(cls, list)
}

/** Mermaid flowchart for the plan; node colors follow the current change state. */
export function renderExecutionDiagram(plan: ExecutionPlan, change: ChangeStatus): string {
  const lines: string[] = ['flowchart LR']
  const groups = new Map<DiagramClass, string[]>()
  if (plan.batches.length === 0) {
    lines.push('  NONE["暂无执行计划"]')
    lines.push('  classDef done fill:#d1fadf,stroke:#12b76a')
    lines.push('  classDef running fill:#d1e9ff,stroke:#2e90fa')
    lines.push('  classDef pending fill:#f2f4f7,stroke:#98a2b3')
    return lines.join('\n')
  }

  const batchTerminals = new Map<string, string[]>()
  const batchIds = new Set<string>()
  for (const batch of plan.batches) {
    batchIds.add(mermaidId(batch.batch))
  }

  for (const batch of plan.batches) {
    const batchNodeId = mermaidId(batch.batch)
    const taskIds = batch.tasks.map((id) => normalizeTaskId(id))
    const parallelSuffix = batch.mode === 'parallel' ? '（并行）' : ''
    lines.push(`  subgraph ${batchNodeId}["${escapeLabel(`${batch.batch} ${BATCH_MODE_LABEL[batch.mode]}${parallelSuffix}`)}"]`)
    for (const taskId of taskIds) {
      const nodeId = mermaidId(taskId)
      lines.push(`    ${nodeId}["${escapeLabel(taskId)}"]`)
      pushClass(groups, taskClass(change, taskId), nodeId)
    }
    if (batch.mode === 'sequential') {
      for (let i = 0; i + 1 < taskIds.length; i += 1) {
        lines.push(`    ${mermaidId(taskIds[i]!)} --> ${mermaidId(taskIds[i + 1]!)}`)
      }
    }
    lines.push('  end')

    if (batch.mode === 'parallel') {
      const checkpointId = `CP_${batchNodeId}`
      lines.push(`  ${checkpointId}{{"集成检查点：合并 + 全量测试"}}`)
      for (const taskId of taskIds) lines.push(`  ${mermaidId(taskId)} --> ${checkpointId}`)
      pushClass(groups, checkpointClass(change, batch.batch), checkpointId)
      batchTerminals.set(batch.batch, taskIds.length > 0 ? [checkpointId] : [])
    } else {
      const last = taskIds[taskIds.length - 1]
      batchTerminals.set(batch.batch, last ? [mermaidId(last)] : [])
    }
  }

  for (let i = 0; i + 1 < plan.batches.length; i += 1) {
    const previous = plan.batches[i]!
    const current = plan.batches[i + 1]!
    const terminals = batchTerminals.get(previous.batch) ?? []
    const heads = current.mode === 'parallel' ? current.tasks.map((id) => mermaidId(normalizeTaskId(id))) : current.tasks.length > 0 ? [mermaidId(normalizeTaskId(current.tasks[0]!))] : []
    for (const terminal of terminals) {
      for (const head of heads) lines.push(`  ${terminal} --> ${head}`)
    }
  }

  lines.push('  classDef done fill:#d1fadf,stroke:#12b76a')
  lines.push('  classDef running fill:#d1e9ff,stroke:#2e90fa')
  lines.push('  classDef pending fill:#f2f4f7,stroke:#98a2b3')
  for (const cls of ['done', 'running', 'pending'] as const) {
    const nodes = groups.get(cls) ?? []
    if (nodes.length > 0) lines.push(`  class ${nodes.join(',')} ${cls}`)
  }
  return lines.join('\n')
}

/** Human-readable execution-plan markdown with the auto-generated diagram. */
export function renderExecutionPlanMarkdown(plan: ExecutionPlan, change: ChangeStatus): string {
  const lines: string[] = ['# 执行计划', '']
  lines.push('> 由 FlowGate 根据 `tasks.md` 末尾的执行计划自动生成；图中节点颜色随任务状态更新，agent 不手写流程图。')
  lines.push('')
  lines.push('## 批次概览')
  lines.push('')
  if (plan.batches.length === 0) {
    lines.push('暂无执行计划。')
  } else {
    lines.push('| 批次 | 模式 | 任务 | 为什么这么排 | 状态 |')
    lines.push('|---|---|---|---|---|')
    for (const batch of plan.batches) {
      const state = change.batches?.find((item) => item.id === batch.batch)
      const status = state ? (BATCH_STATUS_LABEL[state.status] ?? state.status) : '未开始'
      lines.push(
        `| ${batch.batch} | ${BATCH_MODE_LABEL[batch.mode]} | ${batch.tasks.join(', ')} | ${batch.why || '—'} | ${status} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 执行图')
  lines.push('')
  lines.push('```mermaid')
  lines.push(renderExecutionDiagram(plan, change))
  lines.push('```')
  lines.push('')
  lines.push('图例：绿色 = 已完成；蓝色 = 进行中（或集成检查中）；灰色 = 待执行。并行批次全部完成后要经过集成检查点才能进入下一批次。')
  return lines.join('\n')
}
