/**
 * Roadmap checks for the GR (project-level) gate (FR-12.3):
 * dependency acyclicity, C0 skeleton first, MVP capability ownership, task
 * scale per change, and a marked MVP cut line.
 */
import type { CheckOutcome, FlowgateConfig, ProjectDoc, RoadmapDoc, RoadmapEntry } from '../types'

const SCALE_FALLBACK = 12
const SKELETON_RE = /骨架|脚手架|工程|初始化|skeleton|scaffold|bootstrap|setup|foundation/i

function itemId(id: string): string {
  return `roadmap.${id}`
}

function outcome(
  id: string,
  label: string,
  passed: boolean,
  options: { hint?: string; example?: string; details?: string[] } = {},
): CheckOutcome {
  const result: CheckOutcome = { item: itemId(id), label, passed, priority: 'P0' }
  if (!passed) {
    if (options.hint !== undefined) result.hint = options.hint
    if (options.example !== undefined) result.example = options.example
    if (options.details !== undefined && options.details.length > 0) result.details = options.details
  } else if (options.details !== undefined && options.details.length > 0) {
    result.details = options.details
  }
  return result
}

function maxTasks(config: FlowgateConfig): number {
  const configured = config.limits?.change_max_tasks
  return typeof configured === 'number' && configured > 0 ? configured : SCALE_FALLBACK
}

function entryKey(entry: RoadmapEntry): string {
  return entry.change.trim().toUpperCase()
}

function dependencyViolations(roadmap: RoadmapDoc): { problems: string[]; cycle: string[] } {
  const problems: string[] = []
  const declarations = new Map<string, string[]>()
  const known = new Set<string>()
  for (const entry of roadmap.entries) known.add(entryKey(entry))
  for (const entry of roadmap.entries) {
    const key = entryKey(entry)
    for (const dependency of entry.dependsOn) {
      const dep = dependency.trim().toUpperCase()
      if (dep === '') continue
      if (!known.has(dep)) {
        problems.push(`变更 ${entry.change} 依赖了路线图里不存在的变更 ${dependency}`)
        continue
      }
      if (dep === key) {
        problems.push(`变更 ${entry.change} 依赖了自己`)
        continue
      }
      const list = declarations.get(key) ?? []
      list.push(dep)
      declarations.set(key, list)
    }
  }
  // DFS cycle detection with an explicit path for a friendly error message.
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const colors = new Map<string, number>()
  for (const key of known) colors.set(key, WHITE)
  let cycle: string[] = []
  const stack: string[] = []
  const visit = (node: string): boolean => {
    const color = colors.get(node) ?? WHITE
    if (color === GRAY) {
      const start = stack.indexOf(node)
      cycle = start >= 0 ? [...stack.slice(start), node] : [node, node]
      return true
    }
    if (color === BLACK) return false
    colors.set(node, GRAY)
    stack.push(node)
    for (const dep of declarations.get(node) ?? []) {
      if (visit(dep)) return true
    }
    stack.pop()
    colors.set(node, BLACK)
    return false
  }
  for (const key of known) {
    if (visit(key)) {
      problems.push(`路线图依赖成环：${cycle.join(' → ')}（把循环依赖拆掉，或调整能力拆分）`)
      break
    }
  }
  return { problems, cycle }
}

/** First roadmap change must be the engineering skeleton C0. */
export function firstChangeIsSkeleton(roadmap: RoadmapDoc): boolean {
  const first = roadmap.entries[0]
  if (!first) return false
  if (entryKey(first) !== 'C0') return false
  return SKELETON_RE.test(`${first.capability} ${first.goal}`)
}

/** One-line status for the status bar: MVP progress + current/next capability. */
export function roadmapStatusLine(roadmap: RoadmapDoc): string {
  const entries = roadmap.entries
  if (entries.length === 0) return '路线图：暂无变更'
  const mvp = entries.filter((entry) => entry.mvp)
  const delivered = mvp.filter((entry) => /已交付|done|delivered/i.test(entry.status)).length
  const current = entries.find((entry) => /进行中|in progress|running/i.test(entry.status))
  const next = nextRoadmapChange(roadmap)
  const head = `路线图 MVP ${delivered}/${mvp.length} 已交付`
  let text: string
  if (current) text = `${head} · 当前 ${current.change} ${current.capability}`
  else if (next) text = `${head} · 下一个 ${next.change} ${next.capability}`
  else text = `${head} · MVP 已完成`
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`
}

/** Next change to create from the roadmap (in-progress first, then first unblocked 未开始). */
export function nextRoadmapChange(roadmap: RoadmapDoc): RoadmapEntry | null {
  const delivered = new Set(
    roadmap.entries.filter((entry) => /已交付|done|delivered/i.test(entry.status)).map((entry) => entryKey(entry)),
  )
  for (const entry of roadmap.entries) {
    if (delivered.has(entryKey(entry))) continue
    if (/进行中|in progress|running/i.test(entry.status)) return entry
  }
  for (const entry of roadmap.entries) {
    if (delivered.has(entryKey(entry))) continue
    if (/paused|暂停/i.test(entry.status)) continue
    if (/已交付|done/i.test(entry.status)) continue
    const depsReady = entry.dependsOn.every((dependency) => delivered.has(dependency.trim().toUpperCase()))
    if (depsReady) return entry
  }
  return null
}

/** All GR checks. Callers select individual outcomes by `item` id. */
export function checkRoadmap(roadmap: RoadmapDoc, project: ProjectDoc | null, config: FlowgateConfig): CheckOutcome[] {
  const outcomes: CheckOutcome[] = []
  const entries = roadmap.entries
  const projectDetail = project?.name ? `项目：${project.name}` : undefined

  outcomes.push(
    outcome('entries', '路线图至少包含一个变更', entries.length > 0, {
      hint: 'roadmap.md 缺少能力拆分表：按「变更 / 能力 / 一句话目标 / 验收要点 / 依赖 / 预计任务数 / MVP / 状态」列出从 C0 开始的变更。',
      example: '| C0 | 工程骨架 | 能构建、能跑测试、有 CI | 测试框架跑通 1 个冒烟测试；CI 通过 | — | 4 | 是 | 未开始 |',
      details: projectDetail ? [projectDetail] : undefined,
    }),
  )

  const deps = dependencyViolations(roadmap)
  outcomes.push(
    outcome('deps', '路线图依赖无环且引用存在', deps.problems.length === 0, {
      hint: '依赖只能指向路线图里已有的变更，且不能成环；按「地基 → 能力」的顺序重排依赖。',
      example: 'C2 依赖 C1，C3 依赖 C2；不要出现 C1 → C3 → C1。',
      details: deps.problems,
    }),
  )

  const first = entries[0]
  let c0Passed = false
  let c0Hint = ''
  if (!first) {
    c0Hint = '路线图为空：第一个变更固定为工程骨架 C0（目录、构建、测试框架、CI、lint、至少一个冒烟测试）。'
  } else if (entryKey(first) !== 'C0') {
    c0Hint = `第一个变更是 ${first.change}，但必须先建工程骨架 C0：后续变更才有可构建、可跑测试的基线。`
  } else if (!SKELETON_RE.test(`${first.capability} ${first.goal}`)) {
    c0Hint = `C0 的能力/目标应描述工程骨架（目录、构建、测试框架、CI、lint、冒烟测试），当前是「${first.capability || first.goal || '空'}」。`
  } else {
    c0Passed = true
  }
  outcomes.push(
    outcome('c0', '第一个变更是工程骨架 C0', c0Passed, {
      hint: c0Hint,
      example: '| C0 | 工程骨架 | 能构建、能跑测试、有 CI | 测试框架跑通 1 个冒烟测试；CI 通过 | — | 4 | 是 | 未开始 |',
    }),
  )

  const mvpProblems: string[] = []
  const capabilitySeen = new Set<string>()
  for (const entry of entries) {
    if (!entry.mvp) continue
    if (entryKey(entry) === '') mvpProblems.push('存在没有编号的 MVP 变更')
    if (entry.capability.trim() === '') mvpProblems.push(`MVP 变更 ${entry.change} 缺少能力名称`)
    if (entry.goal.trim() === '') mvpProblems.push(`MVP 变更 ${entry.change} 缺少一句话目标`)
    if (entry.acceptance.trim() === '') mvpProblems.push(`MVP 变更 ${entry.change} 缺少验收要点`)
    const capability = entry.capability.trim()
    if (capability !== '') {
      if (capabilitySeen.has(capability)) mvpProblems.push(`能力「${capability}」被重复拆分到多个变更，请合并或改名`)
      capabilitySeen.add(capability)
    }
  }
  const mvpEntries = entries.filter((entry) => entry.mvp)
  outcomes.push(
    outcome('mvp', '每项 MVP 能力都有归属的变更', mvpEntries.length > 0 && mvpProblems.length === 0, {
      hint:
        mvpEntries.length === 0
          ? '路线图没有标记任何 MVP 变更：MVP 切线内的能力必须各自归属到一个可独立验收的变更。'
          : '给每个 MVP 变更补齐能力、一句话目标、验收要点，并合并重复能力。',
      details: mvpProblems,
    }),
  )

  const scaleProblems: string[] = []
  const limit = maxTasks(config)
  for (const entry of entries) {
    if (entry.estimatedTasks === null) {
      scaleProblems.push(`变更 ${entry.change} 没有填写预计任务数`)
      continue
    }
    if (entry.estimatedTasks > limit) {
      scaleProblems.push(`变更 ${entry.change} 预计 ${entry.estimatedTasks} 个任务，超过上限 ${limit}：拆成多个变更`)
    }
  }
  outcomes.push(
    outcome('scale', `单个变更预计任务数不超过 ${limit}`, scaleProblems.length === 0, {
      hint: `预计任务数超过 ${limit} 的变更在 G3 会失败：拆成多个可独立验收的变更，或缩小该能力范围。`,
      details: scaleProblems,
    }),
  )

  outcomes.push(
    outcome('mvpCut', 'MVP 切线已标出', roadmap.mvpCut.trim() !== '', {
      hint: 'roadmap.md 顶部写一行「MVP 切线：C0–C3 在切线内；C4 在切线外。」，明确这次做到哪里。',
      example: 'MVP 切线：C0–C3 在切线内；C4 在切线外。',
    }),
  )

  return outcomes
}
