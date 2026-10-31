/**
 * GATE_CHECKS: data-driven gate check definitions for GR / G0 / G1 / G2 / G3 /
 * G5 / G6 (docs/03 §3.2). Every item returns a `CheckOutcome` with a Chinese
 * label and an actionable hint + example on failure.
 *
 * `runGateChecks(ctx)` derives the gate from `ctx.change.stage` and runs the
 * applicable definitions. Single checks are exported individually so tests (and
 * the UI) can run one item at a time.
 */
import {
  COMPLEXITIES,
  RISK_LEVELS,
  SIX_ELEMENTS,
  type ArtifactBundle,
  type ArtifactName,
  type ChangeStatus,
  type CheckOutcome,
  type CommandSettings,
  type EvidenceReceipt,
  type ExecutionPlan,
  type GateCheckContext,
  type GateCheckDefinition,
  type GateId,
  type LevelProfile,
  type LimitSettings,
  type RiskLevel,
  type SixElementKey,
  type StageId,
  type TaskCard,
} from '../types'
import type { FileSystem } from '../util/fs'
import { sha256 } from '../util/hash'
import { extractSections, sectionHasContent } from '../util/markdown'
import { globsMayOverlap, isConcretePattern, matchAnyGlob, matchGlob } from '../util/glob'
import { normalizeRelPath, posixJoin } from '../util/paths'
import {
  extractCitationRefs,
  findVagueTerms,
  isQuantified,
  knownScenarioIds,
  traceabilityMatrix,
  vagueTermHint,
} from './parse'
import { artifactHashes, changePaths } from './load'
import { verifyCitations } from '../citations/verify'
import { checkExecutionPlan } from '../plan/check'
import { citationsStale } from '../citations/verify'
import { checkRoadmap } from '../roadmap/check'
import { validateVerifyCommand } from '../shell'
import { levelProfile } from '../state/levels'

// ---------------------------------------------------------------------------
// Small outcome helpers
// ---------------------------------------------------------------------------

type Priority = 'P0' | 'P1'

function pass(item: string, label: string, priority: Priority = 'P0', details?: string[]): CheckOutcome {
  const outcome: CheckOutcome = { item, label, passed: true, priority }
  if (details !== undefined && details.length > 0) outcome.details = details
  return outcome
}

function fail(
  item: string,
  label: string,
  hint: string,
  priority: Priority = 'P0',
  extra: { example?: string; details?: string[] } = {},
): CheckOutcome {
  const outcome: CheckOutcome = { item, label, passed: false, hint, priority }
  if (extra.example !== undefined) outcome.example = extra.example
  if (extra.details !== undefined && extra.details.length > 0) outcome.details = extra.details
  return outcome
}

// ---------------------------------------------------------------------------
// Config / level helpers
// ---------------------------------------------------------------------------

/**
 * The effective level profile (re-exported for callers that only import the spec
 * layer). `GateCheckContext.level` carries the authoritative instance computed
 * by state/levels.ts.
 */
export type GateLevelProfile = LevelProfile

/** Convenience: compute the level profile for a change with default limits. */
export function gateProfile(change: ChangeStatus): GateLevelProfile {
  return levelProfile(change.complexity, change.risk)
}

function limitsOf(ctx: GateCheckContext): LimitSettings {
  return ctx.limits ?? ctx.config.limits
}

function maxTasksOf(ctx: GateCheckContext): number {
  return limitsOf(ctx).change_max_tasks > 0 ? limitsOf(ctx).change_max_tasks : 12
}

/**
 * T2.8：低复杂度走快车道，S3 只允许 1 张任务卡；其它等级用配置上限
 * （`0` 表示未配置，回退默认 12）。
 */
function changeTaskLimit(ctx: GateCheckContext): number {
  if (ctx.change.complexity === 'low') return 1
  return maxTasksOf(ctx)
}

function mergedCommands(ctx: GateCheckContext): CommandSettings {
  const merged: CommandSettings = {}
  const apply = (source: CommandSettings | undefined): void => {
    if (!source) return
    for (const key of Object.keys(source) as (keyof CommandSettings)[]) {
      const value = source[key]
      if (value !== undefined) merged[key] = value
    }
  }
  apply(ctx.config.commands)
  apply(ctx.project?.commands)
  return merged
}

/** True when this change is the greenfield engineering skeleton C0. */
export function isSkeletonChange(ctx: GateCheckContext): boolean {
  const roadmap = (ctx.change.roadmap ?? '').trim().toUpperCase()
  if (roadmap === 'C0') return true
  const first = ctx.roadmap?.entries[0]
  if (first && first.change.trim().toUpperCase() === 'C0') {
    const title = `${ctx.change.title} ${ctx.change.summary ?? ''}`.toLowerCase()
    if (title.includes('骨架') || title.includes('skeleton') || title.includes('scaffold')) return true
  }
  return /工程骨架|脚手架|skeleton|scaffold/i.test(`${ctx.change.title} ${ctx.change.summary ?? ''}`)
}

/**
 * Shape restriction for verification commands (docs/03 §6.2): delegates to the
 * shell kernel (`src/core/shell/classify.ts#validateVerifyCommand`) so the plan
 * checks and the rule engine agree on what a legal command looks like.
 */
export function validateVerifyCommandShape(command: string): { ok: boolean; reason?: string } {
  return validateVerifyCommand(command)
}

function withoutUndefined(commands: CommandSettings): CommandSettings {
  const out: CommandSettings = {}
  for (const key of Object.keys(commands) as (keyof CommandSettings)[]) {
    const value = commands[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// File walking (for broad-scope / new-files checks)
// ---------------------------------------------------------------------------

const WALK_IGNORED = new Set([
  '.git',
  '.flowgate',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.cache',
])

interface FileIndex {
  root: string
  files: string[]
}

async function collectFileIndex(fs: FileSystem, root: string, maxFiles = 3000): Promise<FileIndex> {
  const files: string[] = []
  // Walk relative to root (entry names join without a leading root prefix).
  const visitRelative = async (relative: string, depth: number): Promise<void> => {
    if (files.length >= maxFiles || depth > 12) return
    const dir = relative === '' ? root : posixJoin(root, relative)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    entries.sort()
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (WALK_IGNORED.has(entry)) continue
      const childRelative = relative === '' ? entry : `${relative}/${entry}`
      try {
        await fs.statSize(posixJoin(root, childRelative))
        files.push(normalizeRelPath(childRelative))
        continue
      } catch {
        await visitRelative(childRelative, depth + 1)
      }
    }
  }
  try {
    await visitRelative('', 0)
  } catch {
    // ignore walk failures: checks that need concrete counts degrade gracefully
  }
  return { root, files }
}

function countMatchingFiles(index: FileIndex, pattern: string): number {
  return index.files.filter((file) => matchGlob(pattern, file)).length
}

const COMMON_SOURCE_ROOTS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'modules',
  'server',
  'client',
  'web',
  'api',
  'core',
  'services',
  'cmd',
  'internal',
  'pkg',
])

/** `src/**` / `**` style pattern that covers a whole tree instead of a task. */
function isBroadScopePattern(pattern: string): boolean {
  const segments = pattern.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return true
  if (segments[0] === '**') return true
  if (segments.length === 1) return /[*?]/.test(segments[0]!)
  if (segments.length === 2 && !/[*?]/.test(segments[0]!)) {
    return segments[1] === '**' || segments[1] === '*'
  }
  return false
}

/** New files may use module-level wildcards, but never a repo-root wildcard. */
function isRootLevelWildcard(pattern: string): boolean {
  const segments = pattern.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return true
  const hasWildcard = segments.some((segment) => /[*?]/.test(segment))
  if (!hasWildcard) return false
  if (segments[0] === '**') return true
  if (segments.length === 1) return true
  if (segments.length === 2 && segments[1] === '**' && COMMON_SOURCE_ROOTS.has(segments[0]!)) return true
  return false
}

/** Conservative "inner glob is contained in outer glob" test. */
function globContainedIn(outer: string, inner: string): boolean {
  const outerNorm = normalizeRelPath(outer)
  const innerNorm = normalizeRelPath(inner)
  if (outerNorm === innerNorm) return true
  if (isConcretePattern(innerNorm)) return matchGlob(outerNorm, innerNorm)
  const base = outerNorm.replace(/\/\*\*$/, '')
  if (base !== outerNorm && innerNorm.startsWith(`${base}/`)) return true
  return false
}

function estimateTaskFileCount(task: TaskCard, index: FileIndex, limit: number): { count: number; files: string[] } {
  const declared = new Set<string>()
  const addMatches = (pattern: string): void => {
    const matched = index.files.filter((file) => matchGlob(pattern, file))
    if (matched.length > 0 && matched.length <= limit) {
      for (const file of matched) declared.add(file)
    }
  }
  for (const pattern of task.scope) {
    if (isConcretePattern(pattern)) {
      declared.add(pattern)
      continue
    }
    addMatches(pattern)
  }
  for (const pattern of task.newFiles) {
    if (isConcretePattern(pattern)) declared.add(pattern)
    else addMatches(pattern)
  }
  for (const change of task.changes) {
    if (change.path !== '') declared.add(change.path)
    if (change.to !== undefined && change.to !== '') declared.add(change.to)
  }
  const files = [...declared].sort()
  return { count: Math.max(files.length, task.scope.length === 0 && task.newFiles.length === 0 ? 0 : files.length), files }
}

function dependencyCycle(taskList: TaskCard[]): string[] | null {
  const known = new Set(taskList.map((task) => task.id.trim().toUpperCase()))
  const graph = new Map<string, string[]>()
  for (const task of taskList) {
    graph.set(
      task.id.trim().toUpperCase(),
      task.dependsOn.map((dep) => dep.trim().toUpperCase()).filter((dep) => known.has(dep)),
    )
  }
  const colors = new Map<string, number>()
  const stack: string[] = []
  let cycle: string[] | null = null
  const visit = (node: string): boolean => {
    const color = colors.get(node) ?? 0
    if (color === 1) {
      const start = stack.indexOf(node)
      cycle = start >= 0 ? [...stack.slice(start), node] : [node, node]
      return true
    }
    if (color === 2) return false
    colors.set(node, 1)
    stack.push(node)
    for (const dep of graph.get(node) ?? []) {
      if (visit(dep)) return true
    }
    stack.pop()
    colors.set(node, 2)
    return false
  }
  for (const node of graph.keys()) {
    if (visit(node)) break
  }
  return cycle
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function latestReceipts(evidence: readonly EvidenceReceipt[]): EvidenceReceipt[] {
  const byGroup = new Map<string, EvidenceReceipt>()
  for (const receipt of evidence) {
    const key = receipt.group === '' ? receipt.id : receipt.group
    const current = byGroup.get(key)
    if (!current || receipt.finishedAt >= current.finishedAt) byGroup.set(key, receipt)
  }
  return [...byGroup.values()].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))
}

function latestOfKind(evidence: readonly EvidenceReceipt[], kind: EvidenceReceipt['kind']): EvidenceReceipt | undefined {
  return [...evidence].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1)).find((receipt) => receipt.kind === kind)
}

function greenReceiptForTask(evidence: readonly EvidenceReceipt[], taskIds: readonly string[]): EvidenceReceipt | undefined {
  return evidence.find(
    (receipt) =>
      receipt.taskId !== undefined &&
      taskIds.includes(receipt.taskId) &&
      receipt.kind === 'test' &&
      receipt.exitCode === 0 &&
      receipt.phase === 'green' &&
      (receipt.summary === null || receipt.summary.failed === 0),
  )
}

// ---------------------------------------------------------------------------
// GR checks
// ---------------------------------------------------------------------------

const PROJECT_CLARIFY_ELEMENTS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '目标用户与目标', re: /目标用户|用户与目标|目标|goal/i },
  { label: '核心流程', re: /核心流程|流程|使用场景|用例|use case/i },
  { label: 'MVP 边界（做 / 不做）', re: /mvp|边界|范围|做.*不做/i },
  { label: '技术栈与部署', re: /技术栈|技术选型|部署|stack|deploy/i },
  { label: '非功能要求', re: /非功能|性能|安全|合规|constraint|non-?functional/i },
  { label: '约束与未知项', re: /未知|假设|约束|风险|unknown|assumption/i },
]

/** GR: project-level six elements closed in `.flowgate/project-clarify.md`. */
export async function checkProjectClarify(ctx: GateCheckContext): Promise<CheckOutcome> {
  const item = 'gr.projectClarify'
  const label = '项目级六要素闭合'
  const path = posixJoin(ctx.root, '.flowgate/project-clarify.md')
  let raw: string
  try {
    raw = await ctx.fs.readFile(path)
  } catch {
    return fail(item, label, '缺少 .flowgate/project-clarify.md：从 0 开发时先做项目级澄清（目标用户、核心流程、MVP 边界、技术栈、非功能、未知）。', 'P0', {
      example: '# 项目级澄清\n\n## 目标用户与目标\n…\n## 核心流程\n…\n## MVP 边界（做 / 不做）\n…\n## 技术栈与部署\n…\n## 非功能要求\n…\n## 约束与未知项\n…',
      details: ['缺少 .flowgate/project-clarify.md：从 0 开发时先做项目级澄清'],
    })
  }
  const sections = extractSections(raw)
  const missing = PROJECT_CLARIFY_ELEMENTS.filter((element) => {
    const section = sections.find((candidate) => element.re.test(candidate.title))
    return !section || !sectionHasContent(section.body)
  }).map((element) => element.label)
  if (missing.length > 0) {
    return fail(item, label, `项目级澄清缺少或为空：${missing.join('、')}。补齐后再提交 GR。`, 'P0', {
      example: '## 目标用户与目标\n- 目标用户：门店店长\n## MVP 边界（做 / 不做）\n- 做：会员、续费\n- 不做：报表',
      details: missing,
    })
  }
  return pass(item, label)
}

function roadmapOutcome(ctx: GateCheckContext, roadmapItem: string, gateItem: string): CheckOutcome {
  const roadmap = ctx.roadmap
  if (!roadmap) {
    return fail(gateItem, '路线图检查', '缺少 roadmap.md：从 0 开发时先产出 .flowgate/roadmap.md，再提交 GR。', 'P0', {
      example: '# 路线图：会员管理系统\n\nMVP 切线：C0–C3 在切线内；C4 在切线外。',
    })
  }
  const outcomes = checkRoadmap(roadmap, ctx.project, ctx.config)
  const found = outcomes.find((outcome) => outcome.item === roadmapItem)
  return found ? { ...found, item: gateItem } : fail(gateItem, '路线图检查', '路线图检查项缺失。', 'P0')
}

async function checkRoadmapEntries(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.entries', 'gr.roadmapEntries')
}
async function checkRoadmapDeps(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.deps', 'gr.roadmapDeps')
}
async function checkRoadmapC0(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.c0', 'gr.roadmapC0')
}
async function checkRoadmapMvp(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.mvp', 'gr.roadmapMvp')
}
async function checkRoadmapScale(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.scale', 'gr.roadmapScale')
}
async function checkRoadmapMvpCut(ctx: GateCheckContext): Promise<CheckOutcome> {
  return roadmapOutcome(ctx, 'roadmap.mvpCut', 'gr.roadmapMvpCut')
}

// ---------------------------------------------------------------------------
// G0 checks
// ---------------------------------------------------------------------------

/** G0: the change directory exists. */
export async function checkChangeCreated(ctx: GateCheckContext): Promise<CheckOutcome> {
  const paths = changePaths(ctx.root, ctx.change.id)
  try {
    const exists = await ctx.fs.exists(paths.dir)
    if (exists) return pass('g0.changeDir', '变更目录已创建', 'P0', [paths.dir])
    return fail('g0.changeDir', '变更目录已创建', '变更目录不存在：重新调用 flow_new_change 立项后重试。', 'P0', { details: [paths.dir] })
  } catch {
    return fail('g0.changeDir', '变更目录已创建', '无法访问文件系统，无法确认变更目录。', 'P0', { details: [paths.dir] })
  }
}

/** G0: title and one-line goal are non-empty. */
export function checkTitleGoal(ctx: GateCheckContext): CheckOutcome {
  const problems: string[] = []
  if (ctx.change.title.trim() === '') problems.push('标题为空')
  if ((ctx.change.summary ?? '').trim() === '') problems.push('一句话目标（summary）为空')
  if (problems.length > 0) {
    return fail('g0.title', '标题和一句话目标非空', '新建立项时写清标题和一句话目标：说明这次要改什么、为什么。', 'P0', {
      example: 'title: 会员续费；summary: 给会员增加续费入口，支付回调幂等',
      details: problems,
    })
  }
  return pass('g0.title', '标题和一句话目标非空')
}

/** G0: complexity and risk have been suggested/confirmed. */
export function checkLevelsSet(ctx: GateCheckContext): CheckOutcome {
  const problems: string[] = []
  if (!COMPLEXITIES.includes(ctx.change.complexity)) problems.push(`复杂度取值非法：${String(ctx.change.complexity)}`)
  if (!RISK_LEVELS.includes(ctx.change.risk)) problems.push(`风险取值非法：${String(ctx.change.risk)}`)
  if (problems.length > 0) {
    return fail('g0.levels', '复杂度和风险已建议', '复杂度只能是 low / medium / high / ultra，风险只能是 normal / high。', 'P0', {
      details: problems,
    })
  }
  return pass('g0.levels', '复杂度和风险已建议', 'P0', [`复杂度 ${ctx.change.complexity} · 风险 ${ctx.change.risk}`])
}

/** G0: the contract snapshot is frozen when the change is created. */
export function checkContractFrozen(ctx: GateCheckContext): CheckOutcome {
  const contract = ctx.change.contract
  if (!contract || contract.plugin.trim() === '' || contract.rules.trim() === '' || contract.levels.trim() === '') {
    return fail(
      'g0.contract',
      '契约已冻结',
      '创建变更时必须冻结当时的插件版本、规则哈希和等级定义；状态损坏时等待负责人在授权卡片上修复。',
      'P0',
    )
  }
  return pass('g0.contract', '契约已冻结', 'P0', [`插件 ${contract.plugin}`])
}

// ---------------------------------------------------------------------------
// G1 checks
// ---------------------------------------------------------------------------

const ELEMENT_LABELS: Record<SixElementKey, string> = {
  goal: '目标',
  boundary: '边界（做 / 不做）',
  roles: '角色与权限',
  acceptance: '验收标准',
  constraints: '约束（非功能）',
  unknowns: '未知与假设',
}

/** G1: clarify rounds within `limits.clarify_max_rounds` (T2.2). */
export function checkClarifyRounds(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.clarifyRounds'
  const label = '澄清轮数不超过上限'
  const clarify = ctx.artifacts.clarify
  const limit = ctx.limits.clarify_max_rounds
  if (!clarify) return pass(item, label, 'P1', ['缺少 clarify.md，由 g1.sixElements 负责'])
  if (limit > 0 && clarify.rounds > limit) {
    return fail(item, label, `澄清超过 ${limit} 轮仍未闭合：把剩余问题列为未决问题/已接受假设，或请负责人补充信息后继续。`, 'P1', {
      details: [`当前轮数：${clarify.rounds}，上限：${limit}`],
    })
  }
  return pass(item, label, 'P1', [`澄清轮数 ${clarify.rounds} / 上限 ${limit}`])
}

/** G1: every captured Q&A row states what the answer changed (T2.2). */
export function checkClarifyQaChanged(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.qaChanged'
  const label = '问答记录写清「这个回答改变了什么」'
  const clarify = ctx.artifacts.clarify
  if (!clarify || clarify.qa.length === 0) return pass(item, label, 'P1', ['没有问答记录（由六要素/假设覆盖）'])
  // 宿主自动落账未带说明时写占位符；占位符不算「写清」，否则 T2.2 验收 #3 形同虚设。
  const PLACEHOLDERS = new Set(['（待补充）', '（未记录）', '-', '—', '无'])
  const missing = clarify.qa.filter((row) => {
    const changed = row.changed.trim()
    return changed === '' || PLACEHOLDERS.has(changed)
  })
  if (missing.length > 0) {
    return fail(
      item,
      label,
      '问答表每一行都要写「这个回答改变了什么」：编辑 clarify.md 补上每一行的说明后重新提交 G1（占位符「（待补充）」「（未记录）」不算）。',
      'P1',
      { details: missing.map((row) => `问题「${row.question}」缺少改变说明`) },
    )
  }
  return pass(item, label, 'P1', [`${clarify.qa.length} 条问答都有改变说明`])
}

/** G1: six elements each have a conclusion or were accepted as an assumption. */
export function checkClarifySixElements(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.sixElements'
  const label = '六要素各有结论或被接受为假设'
  const clarify = ctx.artifacts.clarify
  if (!clarify) {
    return fail(item, label, '缺少 clarify.md：先做需求澄清，把六要素表填完整。', 'P0', {
      example: '| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 | 会员可自助续费 | clarify | 已确认 |',
    })
  }
  const required: SixElementKey[] = ctx.change.complexity === 'low' ? ['goal', 'acceptance'] : [...SIX_ELEMENTS]
  const missing = required.filter((key) => {
    const element = clarify.elements[key]
    const conclusion = (element?.conclusion ?? '').trim()
    const acceptedAssumption = /假设|assumption|已接受|accepted/i.test(element?.status ?? '')
    return conclusion === '' && !acceptedAssumption
  })
  if (missing.length > 0) {
    return fail(
      item,
      label,
      `${missing.map((key) => ELEMENT_LABELS[key]).join('、')} 还没有结论：在 clarify.md 的六要素表里写结论，或写进「已接受的假设」。`,
      'P0',
      {
        example: '| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 边界 | 做续费；不做退款 | clarify | 已确认 |\n| 未知 | 支付平台回调重试策略待确认 | 假设 | 已接受为假设 |',
        details: missing.map((key) => `缺失要素：${ELEMENT_LABELS[key]}`),
      },
    )
  }
  return pass(item, label)
}

function scenarioShapeProblems(spec: GateCheckContext['artifacts']['spec']): string[] {
  if (!spec) return ['缺少增量规格（spec.md）']
  const problems: string[] = []
  if (spec.requirements.length === 0) problems.push('增量规格没有任何 Requirement')
  for (const requirement of spec.requirements) {
    if (requirement.scenarios.length === 0) {
      problems.push(`需求 ${requirement.id} 没有 GIVEN / WHEN / THEN 场景（每条需求至少 1 个）`)
    }
    for (const scenario of requirement.scenarios) {
      if (scenario.given.length === 0) problems.push(`场景 ${scenario.id} 缺少 GIVEN`)
      if (scenario.when.length === 0) problems.push(`场景 ${scenario.id} 缺少 WHEN`)
      if (scenario.then.length === 0) problems.push(`场景 ${scenario.id} 缺少 THEN`)
    }
  }
  return problems
}

/** G1: every requirement has at least one complete GIVEN/WHEN/THEN scenario. */
export function checkScenarioCoverage(ctx: GateCheckContext): CheckOutcome {
  const problems = scenarioShapeProblems(ctx.artifacts.spec)
  if (problems.length > 0) {
    return fail('g1.scenarioCoverage', '每条需求至少一个可测试场景', '每条需求至少写一个完整的 GIVEN / WHEN / THEN 场景。', 'P0', {
      example: '#### Scenario: R2.S1 重复回调\n- GIVEN 会员 A 的续费订单已处理\n- WHEN 支付平台再次推送同一流水号\n- THEN 到期日不变，接口返回 HTTP 200',
      details: problems,
    })
  }
  return pass('g1.scenarioCoverage', '每条需求至少一个可测试场景')
}

function vagueTermProblems(spec: GateCheckContext['artifacts']['spec']): { problems: string[]; terms: string[] } {
  const problems: string[] = []
  const terms: string[] = []
  if (!spec) return { problems, terms }
  for (const scenario of spec.scenarios) {
    for (const line of scenario.then) {
      const found = findVagueTerms(line)
      if (found.length === 0) continue
      if (isQuantified(line)) continue
      for (const term of found) if (!terms.includes(term)) terms.push(term)
      problems.push(`场景 ${scenario.id} 的 THEN「${line.slice(0, 60)}」包含未量化的模糊词：${found.join('、')}`)
    }
  }
  return { problems, terms }
}

/** G1: THEN clauses contain no unquantified vague terms. */
export function checkScenarioVagueTerms(ctx: GateCheckContext): CheckOutcome {
  const { problems, terms } = vagueTermProblems(ctx.artifacts.spec)
  if (!ctx.artifacts.spec) {
    return fail('g1.vagueTerms', '场景的 THEN 无未量化模糊词', '缺少增量规格（spec.md）。', 'P0')
  }
  if (problems.length > 0) {
    return fail('g1.vagueTerms', '场景的 THEN 无未量化模糊词', vagueTermHint(terms), 'P0', {
      example: '- THEN 响应时间 p95 < 300ms，错误率 < 0.1%\n- THEN 重复回调只生效一次，第二次返回 HTTP 200',
      details: problems,
    })
  }
  return pass('g1.vagueTerms', '场景的 THEN 无未量化模糊词')
}

/** Combined FR-1.4 check (shape + then-quantification), kept for callers/tests. */
export function checkScenariosTestable(ctx: GateCheckContext): CheckOutcome {
  const shape = checkScenarioCoverage(ctx)
  if (!shape.passed) return { ...shape, item: 'g1.scenarios', label: '场景可测试（GIVEN / WHEN / THEN，THEN 可量化）' }
  const vague = checkScenarioVagueTerms(ctx)
  if (!vague.passed) return { ...vague, item: 'g1.scenarios', label: '场景可测试（GIVEN / WHEN / THEN，THEN 可量化）' }
  return pass('g1.scenarios', '场景可测试（GIVEN / WHEN / THEN，THEN 可量化）')
}

/** G1: "不做" list is non-empty. */
export function checkOutOfScope(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.outOfScope'
  const label = '「不做」清单非空'
  const proposal = ctx.artifacts.proposal
  if (!proposal) {
    return fail(item, label, '缺少 proposal.md：写清为什么做、做什么、影响范围和不做什么。', 'P0', {
      example: '## 不做\n- 不做退款流程\n- 不做后台报表',
    })
  }
  if (proposal.outOfScope.length === 0) {
    return fail(item, label, 'proposal.md 的「不做」清单为空：明确写出本次不做的事，防止范围膨胀。', 'P0', {
      example: '## 不做\n- 不做退款流程\n- 不做后台报表',
    })
  }
  return pass(item, label, 'P0', [proposal.outOfScope.join('；')])
}

/** G1: no open questions remain. */
export function checkOpenQuestions(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.openQuestions'
  const label = '未决问题 = 0'
  const clarify = ctx.artifacts.clarify
  if (!clarify) return fail(item, label, '缺少 clarify.md：先完成需求澄清。', 'P0')
  const open = clarify.openQuestions.map((question) => question.trim()).filter((question) => question !== '')
  if (open.length > 0) {
    return fail(item, label, '还有未决问题：让负责人决定，或把它写成「已接受的假设」后再提交 G1。', 'P0', {
      example: '## 未决问题\n- 无（存量订单是否支持续费已由负责人决定：支持）',
      details: open,
    })
  }
  return pass(item, label)
}

/** G1: incremental spec format is valid (ADDED / MODIFIED / REMOVED + ids). */
export function checkSpecFormat(ctx: GateCheckContext): CheckOutcome {
  const item = 'g1.specFormat'
  const label = '增量规格格式合法'
  const spec = ctx.artifacts.spec
  if (!spec) return fail(item, label, '缺少增量规格（spec.md）。', 'P0', {
    example: '## ADDED Requirements\n\n### Requirement: R2 续费回调幂等\n系统 SHALL …\n\n#### Scenario: R2.S1 重复回调\n- GIVEN …\n- WHEN …\n- THEN …',
  })
  const problems: string[] = []
  if (!/(?:ADDED|MODIFIED|REMOVED|新增|修改|移除)/i.test(spec.raw)) {
    problems.push('缺少 ADDED / MODIFIED / REMOVED 变更类型小节')
  }
  const ids = new Set<string>()
  const scenarioIds = new Set<string>()
  for (const requirement of spec.requirements) {
    if (!/^R\d+$/.test(requirement.id)) problems.push(`需求编号非法：${requirement.id}（应为 R1、R2 …）`)
    if (ids.has(requirement.id)) problems.push(`需求编号重复：${requirement.id}`)
    ids.add(requirement.id)
    for (const scenario of requirement.scenarios) {
      if (!/^R\d+\.S\d+$/.test(scenario.id)) problems.push(`场景编号非法：${scenario.id}（应为 R2.S1 …）`)
      if (!scenario.id.startsWith(`${requirement.id}.`)) {
        problems.push(`场景 ${scenario.id} 的前缀与所属需求 ${requirement.id} 不一致`)
      }
      if (scenarioIds.has(scenario.id)) problems.push(`场景编号重复：${scenario.id}`)
      scenarioIds.add(scenario.id)
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '按增量规格模板写：ADDED / MODIFIED / REMOVED 三节，需求编号 R<n>、场景编号 R<n>.S<m>。', 'P0', {
      example: '## ADDED Requirements\n\n### Requirement: R2 续费回调幂等\n系统 SHALL 对同一流水号只处理一次。\n\n#### Scenario: R2.S1 重复回调\n- GIVEN …\n- WHEN …\n- THEN …',
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`需求 ${spec.requirements.length} 个 · 场景 ${spec.scenarios.length} 个`])
}

/**
 * G1 (P1, FR-1.10): known facts must be backed by verified citations; facts
 * without citations can only count as assumptions.
 */
export async function checkAnalysisCitations(ctx: GateCheckContext): Promise<CheckOutcome> {
  const item = 'g1.factsCitations'
  const label = '已知事实都带可核验引用'
  const clarify = ctx.artifacts.clarify
  if (!clarify) return fail(item, label, '缺少 clarify.md。', 'P1')
  const problems: string[] = []
  const refs = []
  for (const fact of clarify.knownFacts) {
    if (fact.status === 'assumption' || fact.status === 'pending') continue
    if (fact.citations.length === 0) {
      problems.push(`已知事实「${fact.text.slice(0, 50)}」没有引用：补「文件:起止行」引用，或把状态改成假设`)
      continue
    }
    refs.push(...fact.citations)
  }
  if (refs.length > 0) {
    const checks = await verifyCitations(ctx.fs, ctx.root, refs, ctx.now)
    for (const check of checks) {
      if (check.ok) continue
      problems.push(`${check.citation.file}:${check.citation.startLine}-${check.citation.endLine} 核验失败：${check.error ?? '未知原因'}`)
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '给已知事实补 `文件:起止行` 引用（插件会核验行号和原文），或把状态改成假设。', 'P1', {
      example: '## 已知事实\n- 续费入口在 HomeController.java:32-40（已确认）',
      details: problems,
    })
  }
  return pass(item, label, 'P1', clarify.knownFacts.length === 0 ? ['没有记录已知事实'] : undefined)
}

/** Kept as an alias for the contract name used by analysis submissions. */
export const checkClarifyCitations = checkAnalysisCitations

// ---------------------------------------------------------------------------
// G2 checks
// ---------------------------------------------------------------------------

const CONTEXT_SECTIONS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '接口约束', re: /接口|interface|api|契约/i },
  { label: '数据模型', re: /数据模型|模型|model|schema|表结构/i },
  { label: '非功能要求', re: /非功能|性能|安全|约束|non-?functional/i },
  { label: '相关模块', re: /相关模块|模块|module|涉及|影响面/i },
]

/** G2: required context.md sections are non-empty. */
export function checkContextSections(ctx: GateCheckContext): CheckOutcome {
  const item = 'g2.contextSections'
  const label = 'context.md 必填段非空'
  if (ctx.change.complexity === 'low') return pass(item, label, 'P0', ['低复杂度使用项目级上下文，不要求 context.md'])
  const context = ctx.artifacts.context
  if (!context) {
    return fail(item, label, '缺少 context.md：写清本次涉及的接口约束、数据模型、非功能要求和相关模块。', 'P0', {
      example: '## 接口约束\n- POST /api/member/renew 需要登录态（见 src/.../RenewController.java:20-40）\n## 数据模型\n- renewal_order 表 …\n## 非功能要求\n- 回调处理 p95 < 300ms\n## 相关模块\n- src/main/java/com/acme/member/renewal',
    })
  }
  const missing = CONTEXT_SECTIONS.filter((element) => {
    const section = context.sections.find((candidate) => element.re.test(candidate.title))
    return !section || !sectionHasContent(section.body)
  }).map((element) => element.label)
  if (missing.length > 0) {
    return fail(item, label, `context.md 缺少或为空：${missing.join('、')}。`, 'P0', {
      example: '## 接口约束\n…\n## 数据模型\n…\n## 非功能要求\n…\n## 相关模块\n…',
      details: missing,
    })
  }
  return pass(item, label)
}

/** G2 (P1, FR-3.7): interface / data-model sections carry source citations. */
export function checkContextCitations(ctx: GateCheckContext): CheckOutcome {
  const item = 'g2.contextCitations'
  const label = '接口约束与数据模型带源码引用'
  if (ctx.change.complexity === 'low') return pass(item, label, 'P1', ['低复杂度不要求 context.md'])
  const context = ctx.artifacts.context
  if (!context) return fail(item, label, '缺少 context.md。', 'P1')
  const problems: string[] = []
  for (const section of context.sections) {
    if (!/接口|数据模型|模型|model|interface|api|schema/i.test(section.title)) continue
    if (!sectionHasContent(section.body)) continue
    if (section.citations.length === 0) problems.push(`「${section.title}」没有源码引用`)
  }
  if (problems.length > 0) {
    return fail(item, label, '接口约束和数据模型要写 `文件:起止行` 引用，被引用文件改动后会标为待复核。', 'P1', {
      details: problems,
    })
  }
  return pass(item, label, 'P1')
}

/** G2: project.md commands exist and are executable-shaped. */
export function checkProjectCommands(ctx: GateCheckContext): CheckOutcome {
  const item = 'g2.projectCommands'
  const label = 'project.md 命令可执行'
  if (ctx.change.kind === 'analysis') return pass(item, label, 'P0', ['分析任务不要求项目命令'])
  const skeleton = isSkeletonChange(ctx)
  if (!ctx.project) {
    if (skeleton) {
      return pass(item, label, 'P0', ['C0 工程骨架在交付时生成 project.md；G2 不阻塞'])
    }
    return fail(item, label, '缺少 project.md：等待负责人在授权卡片上修复（生成项目级上下文）后再进入 S2。', 'P0', {
      example: '## 命令\n| 名称 | 命令 |\n|---|---|\n| test | ./mvnw -B test |\n| build | ./mvnw -B -DskipTests package |',
    })
  }
  const commands = withoutUndefined(mergedCommands(ctx))
  const problems: string[] = []
  const commandKeys: (keyof CommandSettings)[] = ['test', 'integration', 'lint', 'build', 'typecheck', 'run', 'health']
  const usable = commandKeys.filter((key) => commands[key] !== undefined)
  if (skeleton) {
    // C0 is the change that *builds* the toolchain: at S2 the detected project may
    // still have no commands. Only validate the shape of whatever is declared.
    for (const key of usable) {
      const command = commands[key]
      if (command === undefined || command === 'none') continue
      const shape = validateVerifyCommandShape(command)
      if (!shape.ok) problems.push(`命令 ${key} 形状非法：${shape.reason ?? ''}`)
    }
    if (problems.length === 0) {
      return pass(item, label, 'P0', [
        `C0 工程骨架：构建 / 测试 / lint 命令在 S4 建立（已声明 ${usable.filter((key) => commands[key] !== 'none').length} 条），G5 再验证真实跑通`,
      ])
    }
  }
  if (usable.length === 0 && !skeleton) {
    return fail(item, label, 'project.md 的命令段为空：至少写 test（没有测试就写 test: none）和 build / lint。', 'P0', {
      details: ['命令段没有可执行命令'],
    })
  }
  for (const key of usable) {
    const command = commands[key]
    if (command === undefined) continue
    if (command === 'none') {
      if (key !== 'test') problems.push(`命令 ${key} 不能写成 none`)
      continue
    }
    const shape = validateVerifyCommandShape(command)
    if (!shape.ok) problems.push(`命令 ${key} 形状非法：${shape.reason ?? ''}`)
  }
  if (commands.test === undefined && !skeleton && commands.build === undefined && commands.lint === undefined && commands.typecheck === undefined) {
    problems.push('缺少 test 命令：项目确实没有测试时写 `test: none`，并配置 build / lint / typecheck 中的至少一项')
  }
  if (commands.test === 'none' && commands.build === undefined && commands.lint === undefined && commands.typecheck === undefined) {
    problems.push('test: none 时至少要配置 build / lint / typecheck 中的一项作为基线')
  }
  if (problems.length > 0) {
    return fail(item, label, '命令必须能被插件直接执行：不能包含 &&、||、;、管道、重定向或命令替换；没有测试写 test: none。', 'P0', {
      example: '## 命令\n| 名称 | 命令 |\n|---|---|\n| test | ./mvnw -B test |\n| lint | ./mvnw -q spotless:check |',
      details: problems,
    })
  }
  return pass(item, label, 'P0', usable.map((key) => `${key}: ${commands[key]}`))
}

/** G2: baseline recorded (tests ran, or build/lint/typecheck when test: none). */
export function checkBaseline(ctx: GateCheckContext): CheckOutcome {
  const item = 'g2.baseline'
  const label = '基线已记录'
  if (ctx.change.kind === 'analysis') return pass(item, label, 'P0', ['分析任务不要求基线'])
  const skeleton = isSkeletonChange(ctx)
  const commands = withoutUndefined(mergedCommands(ctx))
  const declaredTest = commands.test !== undefined && commands.test !== 'none'

  // The engine records `change.baseline` right before evaluating G2; prefer it
  // (it is the authoritative snapshot used for S5 regression comparison).
  const baseline = ctx.change.baseline
  if (baseline) {
    const summary = baseline.summary
    if (!declaredTest) {
      const baselineEvidence = ctx.evidence.filter(
        (receipt) => (receipt.kind === 'build' || receipt.kind === 'lint' || receipt.kind === 'typecheck') && receipt.exitCode === 0,
      )
      // T2.3：test: none 时必须以真实跑通的 build/lint/typecheck 回执作基线，
      // 不能只凭 `change.baseline` 字段存在就通过。
      if (baselineEvidence.length === 0) {
        return fail(
          item,
          label,
          'test: none 时要用构建、类型检查或 lint 的通过结果作基线：G2 前先运行对应验证组（插件会尝试自动跑 build/lint/typecheck）。',
          'P0',
          { details: [commands.test === 'none' ? 'test: none' : '未声明测试命令'] },
        )
      }
      return pass(item, label, 'P0', [
        '基线已记录（项目未声明测试命令）',
        ...baselineEvidence.map((receipt) => `${receipt.kind}: ${receipt.command}`),
      ])
    }
    if (!summary || summary.parsed === false) {
      if (skeleton && (!summary || summary.run === 0)) {
        return pass(item, label, 'P0', ['C0 工程骨架允许 0 个测试（基线已记录）'])
      }
      return fail(item, label, '测试输出未能解析出测试数量：检查测试命令是否输出摘要，或使用插件识别的工具链。', 'P0', {
        details: [commands.test ?? ''],
      })
    }
    if (summary.run < 1) {
      if (skeleton) return pass(item, label, 'P0', ['C0 工程骨架允许 0 个测试'])
      return fail(item, label, '测试命令没有跑到任何测试：FR-3.4 要求声明了测试命令时至少要跑到 1 个测试。', 'P0', {
        details: [`运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}`],
      })
    }
    return pass(item, label, 'P0', [
      `基线：运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}`,
    ])
  }

  // Fallback for callers that do not persist `change.baseline` (tests / replays).
  const receipts = latestReceipts(ctx.evidence)
  if (declaredTest) {
    const testReceipts = receipts.filter((receipt) => receipt.kind === 'test')
    if (testReceipts.length === 0) {
      return fail(item, label, 'S2 需要先跑一次基线测试并记录回执（插件执行）：在 S2 运行 `flow_verify` 的全量测试组。', 'P0', {
        details: [`声明的测试命令：${commands.test}`],
      })
    }
    const latest = testReceipts[0]!
    const summary = latest.summary
    if (!summary || summary.parsed === false) {
      return fail(item, label, '测试输出未能解析出测试数量：检查测试命令是否输出摘要，或使用插件识别的工具链。', 'P0', {
        details: [latest.command],
      })
    }
    if (summary.run < 1) {
      if (skeleton) return pass(item, label, 'P0', ['C0 工程骨架允许 0 个测试'])
      return fail(item, label, '测试命令没有跑到任何测试：FR-3.4 要求声明了测试命令时至少要跑到 1 个测试。', 'P0', {
        details: [`运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}`],
      })
    }
    return pass(item, label, 'P0', [
      `基线：运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}`,
    ])
  }
  const baselineKinds: EvidenceReceipt['kind'][] = ['build', 'lint', 'typecheck']
  const available = receipts.filter((receipt) => baselineKinds.includes(receipt.kind) && receipt.exitCode === 0)
  if (available.length === 0) {
    return fail(
      item,
      label,
      'test: none 时要用构建、类型检查或 lint 的通过结果作为基线：先运行对应的验证组。',
      'P0',
      { details: [commands.test === 'none' ? 'test: none' : '未声明测试命令'] },
    )
  }
  return pass(item, label, 'P0', ['以构建 / 类型检查 / lint 作为基线', ...available.map((receipt) => `${receipt.kind}: ${receipt.command}`)])
}

/** G3 (P1, FR-3.4): test: none must be recorded as a maintainability risk. */
export function checkTestNoneRisk(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.testNoneRisk'
  const label = '缺少自动化测试已登记为风险'
  const commands = withoutUndefined(mergedCommands(ctx))
  if (commands.test !== 'none') return pass(item, label, 'P1', ['不适用：已配置测试命令'])
  const risk = ctx.artifacts.risk
  if (!risk) return fail(item, label, '缺少 risk.md：test: none 时应在可维护性风险里记一条「缺少自动化测试」。', 'P1')
  const recorded = risk.entries.some((entry) =>
    /缺少自动化测试|无自动化测试|自动化测试缺失|没有自动化测试|no automated tests/i.test(
      `${entry.reason} ${entry.mitigation} ${entry.verification}`,
    ),
  )
  if (!recorded) {
    return fail(item, label, 'test: none 时在 risk.md 的可维护性类别里自动记录「缺少自动化测试」，说明后续如何补。', 'P1', {
      example: '| 可维护性 | 中 | 缺少自动化测试 | 在后续变更补冒烟测试 | 审查检查 | 否 |',
    })
  }
  return pass(item, label, 'P1')
}

// ---------------------------------------------------------------------------
// G3 checks
// ---------------------------------------------------------------------------

/** G3: design.md has 2–3 compared options, recommendation, data flow, error handling, rollback when risk is high. */
export function checkDesignOptions(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.design'
  const label = '设计有 2–3 个方案对比和推荐'
  const complexity = ctx.change.complexity
  const design = ctx.artifacts.design
  const riskHigh = ctx.change.risk === 'high'
  const problems: string[] = []
  if (complexity === 'low' && !riskHigh) {
    return pass(item, label, 'P0', ['低复杂度免设计文档'])
  }
  if (!design) {
    if (complexity === 'medium' && !riskHigh) {
      return pass(item, label, 'P0', ['中复杂度在只有一个可行方案时可以不写设计；如写必须含 2–3 个方案对比'])
    }
    return fail(item, label, '缺少 design.md：写 2–3 个方案对比、推荐方案和理由、数据流、错误处理；高风险必须有回滚方案。', 'P0', {
      example: '## 方案 A 唯一索引\n- 优点：简单\n- 缺点：需要迁移\n## 方案 B 先查后写\n…\n## 推荐\n选方案 A …\n## 数据流\n…\n## 错误处理\n…\n## 回滚\n…',
    })
  }
  if (design.options.length < 2 || design.options.length > 3) {
    problems.push(`方案数量为 ${design.options.length}，应为 2–3 个方案对比`)
  }
  if (design.recommendation.trim() === '') problems.push('缺少推荐方案和理由')
  if (design.dataFlow.trim() === '') problems.push('缺少数据流')
  if (design.errorHandling.trim() === '') problems.push('缺少错误处理')
  if (riskHigh && design.rollback.trim() === '') problems.push('高风险变更必须有回滚方案')
  if (complexity === 'ultra' && (design.architecture ?? '').trim() === '') problems.push('超高复杂度需另写架构边界、影响和取舍')
  if (problems.length > 0) {
    return fail(item, label, 'design.md 不完整：补齐方案对比、推荐理由、数据流、错误处理；高风险加回滚，超高复杂度加架构边界。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`方案 ${design.options.length} 个`])
}

const RISK_CATEGORY_LABELS: Record<string, string> = {
  security: '安全',
  performance: '性能',
  cost: '成本',
  compliance: '合规',
  maintainability: '可维护性',
}

/** G3: risk.md covers the five categories; high-grade items are handled by a human. */
export function checkRiskCategories(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.risk'
  const label = '风险登记五类齐全'
  if (ctx.change.complexity === 'low') return pass(item, label, 'P0', ['低复杂度免填风险登记（触发器照常生效）'])
  const risk = ctx.artifacts.risk
  if (!risk) {
    return fail(item, label, '缺少 risk.md：按安全 / 性能 / 成本 / 合规 / 可维护性五类登记风险。', 'P0', {
      example: '| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |\n|---|---|---|---|---|---|\n| 安全 | 高 | 回调需验签 | 复用 SignatureVerifier | 场景 R2.S2 测试 | 是 |',
    })
  }
  const problems: string[] = []
  const categories = ['security', 'performance', 'cost', 'compliance', 'maintainability'] as const
  for (const category of categories) {
    const entry = risk.entries.find((candidate) => candidate.category === category)
    if (!entry) {
      problems.push(`缺少「${RISK_CATEGORY_LABELS[category]}」类别`)
      continue
    }
    if (entry.grade !== 'none' && (entry.reason === '' || entry.reason === '—')) {
      problems.push(`「${RISK_CATEGORY_LABELS[category]}」缺少风险理由`)
    }
    if (entry.grade === 'high') {
      if (!entry.needsHuman) problems.push(`「${RISK_CATEGORY_LABELS[category]}」为高风险，需要人工接管确认`)
      if (entry.mitigation === '') problems.push(`「${RISK_CATEGORY_LABELS[category]}」为高风险，缺少缓解措施`)
      if (entry.verification === '') problems.push(`「${RISK_CATEGORY_LABELS[category]}」为高风险，缺少验证方式`)
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '风险登记不完整：五类都要有等级和理由；高风险项要有缓解、验证并标记人工接管。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`风险项 ${risk.entries.length} 个`])
}

/** G3: task cards are cover-complete, dependency-acyclic and reasonably scoped. */
export async function checkTaskCards(ctx: GateCheckContext): Promise<CheckOutcome> {
  const item = 'g3.taskCards'
  const label = '任务卡检查通过（依赖无环、场景全覆盖、范围合理、规模受限）'
  const tasksDoc = ctx.artifacts.tasks
  if (!tasksDoc) {
    return fail(item, label, '缺少 tasks.md：按任务卡模板把变更拆成可独立验证的任务。', 'P0', {
      example: '## T1 续费接口\n```yaml\ncovers: [R2.S1]\nscope:\n  - src/main/java/com/acme/member/renewal/**\ntests:\n  - src/test/java/com/acme/member/renewal/**\nnew_files:\n  - src/main/java/com/acme/member/renewal/RenewalService.java\ndepends_on: []\ntdd: required\nverify:\n  - group: renewal-unit\n    command: ./mvnw -B -q -Dtest=RenewalCallbackTest test\n    inputs: [src/main/java/com/acme/member/renewal/**, pom.xml]\n```',
    })
  }
  const tasks = tasksDoc.tasks
  if (tasks.length === 0) {
    return fail(item, label, 'tasks.md 没有解析到任何任务卡：用 `## T1 标题` + 围栏 YAML 的模板书写。', 'P0')
  }
  const problems: string[] = []
  const ids = new Set<string>()
  for (const task of tasks) {
    const id = task.id.trim().toUpperCase()
    if (id === '') problems.push('存在没有编号的任务卡')
    if (ids.has(id)) problems.push(`任务编号重复：${task.id}`)
    ids.add(id)
  }
  for (const task of tasks) {
    const id = task.id.trim().toUpperCase()
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency.trim().toUpperCase())) {
        problems.push(`任务 ${id} 依赖了不存在的任务 ${dependency}`)
      }
    }
    const covers = task.covers.filter((cover) => cover.trim() !== '')
    if (covers.length === 0 && (task.choreReason ?? '').trim() === '') {
      problems.push(`任务 ${id} 没有覆盖任何场景，也没有标 chore 并写理由`)
    }
    if (task.scope.length === 0) problems.push(`任务 ${id} 的 scope 为空`)
    for (const pattern of task.scope) {
      if (pattern === '' || pattern.startsWith('/') || pattern.split('/').includes('..')) {
        problems.push(`任务 ${id} 的 scope 路径非法：${pattern}（必须是仓库相对路径）`)
      }
    }
    if (task.title.trim() === '') problems.push(`任务 ${id} 缺少标题`)
    // T4.6：派子 agent 必须写理由（run: subagent + run_reason）。
    if (task.run === 'subagent' && (task.runReason ?? '').trim() === '') {
      problems.push(`任务 ${id} 声明 run: subagent 但没有 run_reason：派子 agent 必须说明为什么需要独立上下文`)
    }
  }
  const cycle = dependencyCycle(tasks)
  if (cycle) problems.push(`任务依赖成环：${cycle.join(' → ')}`)
  const spec = ctx.artifacts.spec
  const known = knownScenarioIds(spec ?? { raw: '', requirements: [], scenarios: [] })
  const requirementIds = new Set((spec?.requirements ?? []).map((requirement) => requirement.id.toUpperCase()))
  if (spec) {
    const matrix = traceabilityMatrix(spec, tasks, [])
    for (const scenarioId of matrix.uncoveredScenarios) {
      problems.push(`场景 ${scenarioId} 没有被任何任务覆盖：新增任务或并入覆盖相近场景的任务`)
    }
    for (const task of tasks) {
      for (const cover of task.covers) {
        const normalized = cover.trim().toUpperCase()
        if (normalized === '') continue
        if (!known.has(normalized) && !requirementIds.has(normalized)) {
          problems.push(`任务 ${task.id} 的 covers 引用了不存在的场景 ${cover}`)
        }
      }
    }
  } else {
    problems.push('缺少增量规格（spec.md），无法检查场景覆盖')
  }
  const limit = maxTasksOf(ctx)
  try {
    const index = await collectFileIndex(ctx.fs, ctx.root)
    for (const task of tasks) {
      for (const pattern of task.scope) {
        if (isBroadScopePattern(pattern)) {
          const matched = countMatchingFiles(index, pattern)
          const suffix = matched > 0 ? `（该范围实际匹配 ${matched} 个文件）` : ''
          problems.push(`任务 ${task.id} 的 scope ${pattern} 范围过宽${suffix}：收紧到具体模块或本次实际会改的文件`)
        } else {
          const matched = countMatchingFiles(index, pattern)
          if (matched > Math.max(limit * 4, 20)) {
            problems.push(`任务 ${task.id} 的 scope ${pattern} 范围过宽（该范围实际匹配 ${matched} 个文件）：收紧到具体模块`)
          }
        }
      }
      const estimate = estimateTaskFileCount(task, index, limit)
      if (estimate.count > limit) {
        problems.push(`任务 ${task.id} 声明了 ${estimate.count} 个文件，超过单任务上限 ${limit}：拆成多个任务`)
      }
      if (task.size === 'S' && estimate.count > 2) {
        problems.push(`任务 ${task.id} 标为 S 但涉及 ${estimate.count} 个文件：S ≤ 2 个文件，改成 M 或拆任务`)
      }
    }
  } catch {
    // File walk is best-effort; structural checks above already ran.
  }
  if (problems.length > 0) {
    return fail(item, label, '逐项修任务卡：依赖无环、每个场景有任务覆盖、每个任务有场景或 chore 理由、范围收窄、file 数受限。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`任务 ${tasks.length} 个`])
}

/** G3: new_files must stay inside scope and must not be a repo-root wildcard. */
export function checkNewFiles(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.newFiles'
  const label = 'new_files 落在 scope 内且不是根级通配'
  const tasksDoc = ctx.artifacts.tasks
  if (!tasksDoc) return fail(item, label, '缺少 tasks.md。', 'P0')
  const problems: string[] = []
  for (const task of tasksDoc.tasks) {
    for (const pattern of task.newFiles) {
      if (pattern === '') continue
      if (isRootLevelWildcard(pattern)) {
        problems.push(`任务 ${task.id} 的 new_files 使用了仓库根级通配 ${pattern}：写到模块或具体文件`)
        continue
      }
      const inScope = task.scope.some((scope) => globContainedIn(scope, pattern))
      if (!inScope) problems.push(`任务 ${task.id} 的 new_files ${pattern} 不在 scope 内`)
    }
  }
  if (problems.length > 0) {
    return fail(
      item,
      label,
      'new_files 可以写模块级通配（例如 src/renewal/**），但必须落在 scope 内，且不能是 src/** 这类根级通配。',
      'P0',
      {
        example: 'scope:\n  - src/main/java/com/acme/member/renewal/**\nnew_files:\n  - src/main/java/com/acme/member/renewal/RenewalService.java',
        details: problems,
      },
    )
  }
  return pass(item, label)
}

/** G3: every task has at least one executable verification group with inputs. */
export function checkVerifyCommands(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.verifyCommands'
  const label = '每个任务都有合法的验证命令'
  const tasksDoc = ctx.artifacts.tasks
  if (!tasksDoc) return fail(item, label, '缺少 tasks.md。', 'P0')
  const problems: string[] = []
  for (const task of tasksDoc.tasks) {
    if (task.verify.length === 0) {
      problems.push(`任务 ${task.id} 没有验证组：至少写一个 group / command / inputs`)
      continue
    }
    for (const group of task.verify) {
      const groupName = group.group.trim() === '' ? `verify-${task.verify.indexOf(group) + 1}` : group.group
      if (group.command.trim() === '') {
        problems.push(`任务 ${task.id} 的验证组 ${groupName} 命令为空`)
        continue
      }
      const shape = validateVerifyCommandShape(group.command)
      if (!shape.ok) problems.push(`任务 ${task.id} 的验证组 ${groupName} 命令形状非法：${shape.reason ?? ''}`)
      if (group.inputs.length === 0) {
        problems.push(`任务 ${task.id} 的验证组 ${groupName} inputs 为空：必须声明输入范围（源文件/测试/构建配置）`)
      }
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '验证命令由插件执行：不能有 && / || / ; / 管道 / 重定向 / 命令替换；并声明 inputs 以便判断回执是否过期。', 'P0', {
      example: 'verify:\n  - group: renewal-unit\n    command: ./mvnw -B -q -Dtest=RenewalCallbackTest test\n    inputs: [src/main/java/com/acme/member/renewal/**, src/test/java/com/acme/member/renewal/**, pom.xml]',
      details: problems,
    })
  }
  return pass(item, label)
}

/** G3: total task count within the configured limit. */
export function checkTaskCount(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.taskCount'
  const limit = changeTaskLimit(ctx)
  const label = `任务数不超过 ${limit}`
  const tasksDoc = ctx.artifacts.tasks
  if (!tasksDoc) return fail(item, label, '缺少 tasks.md。', 'P0')
  const count = tasksDoc.tasks.length
  if (count > limit) {
    return fail(item, label, `当前有 ${count} 张任务卡，超过单变更上限 ${limit}：把变更拆成多个可独立验收的变更。`, 'P0', {
      example: `拆成两个变更：C-00x 负责前 ${limit} 张任务，C-00y 负责剩余任务并依赖前一个。`,
      details: [`任务数：${count} > 上限：${limit}`],
    })
  }
  return pass(item, label, 'P0', [`任务 ${count} 个`])
}

/** G3: traceability matrix has no uncovered scenario. */
export function checkTraceability(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.traceability'
  const label = '追溯矩阵无未覆盖场景'
  const spec = ctx.artifacts.spec
  const tasksDoc = ctx.artifacts.tasks
  if (!spec) return fail(item, label, '缺少增量规格（spec.md）。', 'P0')
  if (!tasksDoc) return fail(item, label, '缺少 tasks.md。', 'P0')
  const matrix = traceabilityMatrix(spec, tasksDoc.tasks, ctx.evidence)
  const known = knownScenarioIds(spec)
  const requirementIds = new Set(spec.requirements.map((requirement) => requirement.id.toUpperCase()))
  const problems: string[] = []
  for (const scenarioId of matrix.uncoveredScenarios) {
    problems.push(`场景 ${scenarioId} 未被任何任务覆盖：新增任务或并入覆盖相近场景的任务`)
  }
  for (const task of tasksDoc.tasks) {
    for (const cover of task.covers) {
      const normalized = cover.trim().toUpperCase()
      if (normalized === '') continue
      if (!known.has(normalized) && !requirementIds.has(normalized)) {
        problems.push(`任务 ${task.id} 的 covers 引用了不存在的场景 ${cover}`)
      }
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '追溯矩阵有未覆盖场景：每个场景至少被一个任务覆盖，covers 只写存在的场景编号。', 'P0', {
      example: 'covers: [R2.S1, R2.S2]',
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`场景 ${spec.scenarios.length} 个全部有归属`])
}

/** G3: execution plan passes dependency / parallel / hotspot checks. */
export function checkPlan(ctx: GateCheckContext): CheckOutcome {
  const tasksDoc = ctx.artifacts.tasks
  if (!tasksDoc) {
    return fail('g3.executionPlan', '执行计划通过检查', '缺少 tasks.md。', 'P0')
  }
  const plan: ExecutionPlan = tasksDoc.execution
  return checkExecutionPlan(tasksDoc.tasks, plan, ctx.config)
}

/**
 * G3: 低复杂度 · 高风险必须给出回滚方案（T2.8 验收 #3）。
 * 回滚来源：design.md 的「回滚方案」，或 risk.md 每条高危风险的缓解措施。
 */
export function checkRollbackPlan(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.rollbackPlan'
  const label = '高风险低复杂度方案有回滚方案'
  const rollback = (ctx.artifacts.design?.rollback ?? '').trim()
  const mitigations = (ctx.artifacts.risk?.entries ?? [])
    .filter((entry) => entry.grade === 'high' || entry.grade === 'medium')
    .map((entry) => `${entry.category}：${entry.mitigation}`)
    .filter((value) => value.trim() !== '')
  if (rollback !== '' || mitigations.length > 0) {
    return pass(item, label, 'P0', [rollback !== '' ? `回滚方案：${rollback}` : '已有逐项缓解措施'])
  }
  return fail(item, label, '低复杂度 · 高风险的方案确认卡要展示风险项和回滚方案：在 risk.md 写清逐项缓解措施，或在 design.md 写回滚方案。', 'P0')
}

/** G2/G3/G5: citations verified at gate time must still match the cited files (T2.10). */
export async function checkCitationsFresh(ctx: GateCheckContext): Promise<CheckOutcome> {
  const item = 'g2.citationsFresh'
  const label = '已核验引用未被改动（否则待复核）'
  const checks = ctx.change.citationChecks ?? []
  if (checks.length === 0) return pass(item, label, 'P1', ['没有已核验引用'])
  const stale = await citationsStale(ctx.fs, ctx.root, checks)
  if (stale.length > 0) {
    return fail(
      item,
      label,
      '被引用的源码在核验后已改动：重新核验引用（flow_submit 会重新记录），或在澄清记录里把结论标为待确认。',
      'P1',
      { details: stale.slice(0, 20).map((check) => `${check.citation.file}:${check.citation.startLine}-${check.citation.endLine} 已改动`) },
    )
  }
  return pass(item, label, 'P1', [`${checks.length} 条引用与核验时一致`])
}

/** G3: frozen artifacts (approved earlier) must not be modified. */
export function checkFrozenArtifacts(ctx: GateCheckContext): CheckOutcome {
  const item = 'g3.frozenArtifacts'
  const label = '已冻结产物未被修改'
  const frozen = ctx.change.frozen
  if (!frozen || Object.keys(frozen).length === 0) {
    return pass(item, label, 'P0', ['产物尚未冻结'])
  }
  const hashes = artifactHashes(ctx.artifacts)
  const problems: string[] = []
  const candidates: ArtifactName[] = ['clarify', 'proposal', 'spec', 'context', 'design', 'risk', 'tasks', 'project']
  for (const [key, record] of Object.entries(frozen)) {
    const base = (key.split('/').pop() ?? key).replace(/\.(md|json)$/i, '')
    if (!candidates.includes(base as ArtifactName)) continue
    const name = base as ArtifactName
    const current = hashes[name]
    if (current === undefined) {
      problems.push(`${key} 已冻结，但当前文件缺失或无法解析`)
      continue
    }
    if (record.hash !== current) {
      problems.push(`${key} 已被修改（冻结 ${record.hash.slice(0, 20)}…，当前 ${current.slice(0, 20)}…）`)
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '产物在人工门批准后已冻结：修改需求走增量规格，修改范围走范围变更申请，不要直接编辑。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label)
}

/** G3: working tree has no uncommitted changes (entering S4 creates the change branch). */
export async function checkCleanWorktree(ctx: GateCheckContext): Promise<CheckOutcome> {
  const item = 'g3.cleanWorktree'
  const label = '工作区没有未提交的改动'
  if (!ctx.git) return pass(item, label, 'P0', ['未提供 git 端口，跳过工作区检查'])
  try {
    const porcelain = await ctx.git.statusPorcelain(ctx.root)
    const lines = porcelain
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .filter((line) => !/\.flowgate\//.test(line))
    if (lines.length > 0) {
      return fail(item, label, '进入 S4 前工作区必须干净：先提交或暂存现有改动，再创建变更分支。', 'P0', {
        details: lines.slice(0, 10),
      })
    }
    return pass(item, label)
  } catch (error) {
    return pass(item, label, 'P0', [`读取 git 状态失败，跳过检查：${(error as Error).message}`])
  }
}

// ---------------------------------------------------------------------------
// G5 checks
// ---------------------------------------------------------------------------

/** G5: full test suite is green (compared with baseline when supplied). */
export function checkG5FullTests(ctx: GateCheckContext): CheckOutcome {
  const item = 'g5.fullTests'
  const label = '全量测试通过且相对基线无回归'
  if (ctx.change.kind === 'analysis') return pass(item, label, 'P0', ['分析任务不要求测试'])
  const skeleton = isSkeletonChange(ctx)
  const commands = withoutUndefined(mergedCommands(ctx))
  const receipts = latestReceipts(ctx.evidence)
  const testReceipts = receipts.filter((receipt) => receipt.kind === 'test')
  if (testReceipts.length === 0) {
    if (commands.test === 'none') return pass(item, label, 'P0', ['项目声明 test: none：以构建 / 类型检查 / lint 作为 S5 验证'])
    return fail(item, label, '缺少全量测试回执：S5 需要一次由插件执行的全量测试 GREEN 回执。', 'P0', {
      details: [`声明的测试命令：${commands.test ?? '未配置'}`],
    })
  }
  const latest = testReceipts[0]!
  const summary = latest.summary
  if (!summary || summary.parsed === false) {
    return fail(item, label, '全量测试输出未能解析出数量：证据不可用，请检查命令输出格式。', 'P0', { details: [latest.command] })
  }
  if (summary.run < 1) {
    return fail(
      item,
      label,
      skeleton
        ? '工程骨架的 G5 要求测试框架真实跑通至少一个测试（当前 0 个）。'
        : '全量测试没有跑到任何测试。',
      'P0',
      { details: [latest.command] },
    )
  }
  if (latest.exitCode !== 0 || summary.failed > 0) {
    return fail(item, label, `全量测试失败：运行 ${summary.run}，失败 ${summary.failed}。修复后重新运行。`, 'P0', {
      details: [...(summary.failures ?? []).slice(0, 10).map((failure) => failure.name), latest.command],
    })
  }
  if (summary.regressions !== undefined && summary.regressions.length > 0) {
    return fail(item, label, `相对基线出现回归：${summary.regressions.slice(0, 10).join('、')}`, 'P0')
  }
  return pass(item, label, 'P0', [`运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}`])
}

/** G5: configured lint / build / typecheck commands all pass. */
export function checkG5LintBuild(ctx: GateCheckContext): CheckOutcome {
  const item = 'g5.lintBuild'
  const label = 'lint / build / typecheck 通过'
  const commands = withoutUndefined(mergedCommands(ctx))
  const checks: { key: 'lint' | 'build' | 'typecheck'; kind: EvidenceReceipt['kind'] }[] = [
    { key: 'lint', kind: 'lint' },
    { key: 'build', kind: 'build' },
    { key: 'typecheck', kind: 'typecheck' },
  ]
  const problems: string[] = []
  const details: string[] = []
  let required = 0
  for (const check of checks) {
    const command = commands[check.key]
    if (command === undefined || command === 'none') continue
    required += 1
    const receipt = latestOfKind(ctx.evidence, check.kind)
    if (!receipt) {
      // The engine only auto-runs the full test suite at G5; other configured
      // commands may be collected through task verify groups / attach_evidence.
      details.push(`未收集到 ${check.key} 回执（建议用 attach_evidence 或验证组补充）`)
      continue
    }
    if (receipt.exitCode !== 0) {
      problems.push(`${check.key} 失败（${command}）`)
      continue
    }
    details.push(`${check.key} 通过`)
  }
  if (problems.length > 0) {
    return fail(item, label, 'S5 要求 lint / build / typecheck 全部通过：修复后重新运行对应验证组。', 'P0', { details: problems })
  }
  return pass(item, label, 'P0', required === 0 ? ['未配置 lint / build / typecheck 命令'] : details)
}

function scenarioEvidenceOutcome(ctx: GateCheckContext, item: string, label: string): CheckOutcome {
  const spec = ctx.artifacts.spec
  const tasksDoc = ctx.artifacts.tasks
  if (!spec || spec.scenarios.length === 0) return fail(item, label, '缺少增量规格或没有场景，无法核对验收证据。', 'P0')
  if (!tasksDoc) return fail(item, label, '缺少 tasks.md，无法核对验收证据。', 'P0')
  const matrix = traceabilityMatrix(spec, tasksDoc.tasks, ctx.evidence)
  const problems: string[] = []
  for (const row of matrix.rows) {
    if (row.taskIds.length === 0) {
      problems.push(`场景 ${row.scenarioId} 没有任务覆盖`)
      continue
    }
    if (!greenReceiptForTask(ctx.evidence, row.taskIds)) {
      problems.push(`场景 ${row.scenarioId} 的覆盖任务（${row.taskIds.join(', ')}）没有 GREEN 测试回执`)
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '验收场景全部要有通过证据：为覆盖任务运行 flow_verify 并产生 GREEN 回执。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`场景 ${matrix.rows.length} 个均有任务和通过证据`])
}

/** G5: every acceptance scenario has a green evidence receipt. */
export function checkG5Scenarios(ctx: GateCheckContext): CheckOutcome {
  return scenarioEvidenceOutcome(ctx, 'g5.scenarios', '验收场景全部有通过证据')
}

/** G5: runtime evidence required when high risk (or when a run command is configured). */
export function checkG5RuntimeEvidence(ctx: GateCheckContext): CheckOutcome {
  const item = 'g5.runtime'
  const label = '运行证据（按风险）'
  const commands = withoutUndefined(mergedCommands(ctx))
  const runReceipt = latestOfKind(ctx.evidence, 'run')
  const riskHigh = ctx.change.risk === 'high'
  if (riskHigh) {
    if (!runReceipt || runReceipt.exitCode !== 0) {
      return fail(item, label, '高风险变更需要运行证据：配置 run 命令并执行，或提供手工证据（日志 + 冒烟）。', 'P0', {
        details: [`run 命令：${commands.run ?? '未配置'}`],
      })
    }
    return pass(item, label, 'P0', [runReceipt.command])
  }
  if (commands.run !== undefined && commands.run !== 'none') {
    const manual = latestOfKind(ctx.evidence, 'manual')
    if (!runReceipt || runReceipt.exitCode !== 0) {
      if (manual) {
        return pass(item, label, 'P0', [`使用手工运行证据：${manual.command}（普通风险允许 attach_evidence 兜底）`])
      }
      return fail(
        item,
        label,
        '配置了 run 命令：S5 必须产生运行证据（flow_submit G5 会自动启动服务并做健康检查）；兼容路径是用 attach_evidence 提交日志+冒烟。',
        'P0',
        { details: [`run 命令：${commands.run}`, `health 命令：${commands.health ?? '未配置'}`] },
      )
    }
    return pass(item, label, 'P0', [runReceipt.command])
  }
  return pass(item, label, 'P0', ['未配置 run 命令，普通风险不要求运行证据'])
}

function finalReviewOutcome(ctx: GateCheckContext, item: string, label: string): CheckOutcome {
  // Review is owner-configurable (lean host combinations have no subagents to
  // run the reviewer preset). When the owner turns it off, G5/G6 must not
  // dead-lock waiting for a review record that can never be produced.
  if (ctx.config.review?.enabled === false) {
    return pass(item, label, 'P0', ['review.enabled=false（负责人关闭或宿主降级）：不要求审查记录'])
  }
  const reviews = ctx.change.reviews ?? []
  const sorted = [...reviews].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const finalReview = sorted.find((review) => review.kind === 'final')
  const problems: string[] = []
  if (!finalReview) {
    problems.push('缺少 S5 终审记录')
  } else {
    if (finalReview.verdict !== 'pass') problems.push('终审结论为 changes-required')
    if (finalReview.coverageOk === false) problems.push('终审读取覆盖不足（coverageOk=false），不能作为交付证据')
    const critical = finalReview.findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'major')
    if (critical.length > 0) {
      problems.push(`终审还有 ${critical.length} 条未处理的 critical / major：${critical.slice(0, 5).map((finding) => `${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.message}`).join('；')}`)
    }
  }
  if (ctx.change.risk === 'high') {
    const security = sorted.find((review) => review.kind === 'security')
    if (!security) problems.push('高风险变更缺少安全审查记录')
    else {
      if (security.verdict !== 'pass') problems.push('安全审查未通过')
      if (security.coverageOk === false) problems.push('安全审查读取覆盖不足（coverageOk=false）')
    }
  }
  if (problems.length > 0) {
    return fail(item, label, '终审必须通过且没有未处理的 critical / major；高风险还要安全审查通过。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', ['终审通过'])
}

/** G5: final review passed, no unresolved critical/major, security review for high risk. */
export function checkG5FinalReview(ctx: GateCheckContext): CheckOutcome {
  return finalReviewOutcome(ctx, 'g5.finalReview', '终审无未处理 critical / major')
}

// ---------------------------------------------------------------------------
// G6 checks
// ---------------------------------------------------------------------------

/** G6: every task and batch is completed. */
export function checkG6TaskCompletion(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.taskCompletion'
  const label = '全部任务完成'
  const problems: string[] = []
  const taskEntries = Object.entries(ctx.change.tasks ?? {})
  if (taskEntries.length === 0) problems.push('状态里没有任何任务记录')
  for (const [taskId, state] of taskEntries) {
    if (state.status !== 'done' && state.status !== 'skipped') {
      problems.push(`任务 ${taskId} 状态为 ${state.status}，尚未完成`)
    }
  }
  const batches = ctx.change.batches ?? []
  for (const batch of batches) {
    if (batch.status !== 'done') problems.push(`批次 ${batch.id} 状态为 ${batch.status}，尚未完成`)
  }
  if (problems.length > 0) {
    return fail(item, label, 'G6 要求全部任务与批次完成（经 G4 按执行图跑完，每个并行批次通过集成检查点）。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label, 'P0', [`任务 ${taskEntries.length} 个 · 批次 ${batches.length} 个`])
}

/** G6: G5 must already be passed. */
export function checkG6G5Passed(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.g5Passed'
  const label = 'G5 已通过'
  const state = ctx.change.gates?.G5?.state
  if (state !== 'passed') {
    return fail(item, label, `G5 状态为 ${state ?? '未提交'}：先通过 S5 验证门，再提交 G6。`, 'P0')
  }
  return pass(item, label)
}

/** G6: acceptance scenarios all have passing evidence. */
export function checkG6Scenarios(ctx: GateCheckContext): CheckOutcome {
  return scenarioEvidenceOutcome(ctx, 'g6.scenarios', '验收场景全部有通过证据')
}

/** G6: no unhandled critical / major review findings. */
export function checkG6Reviews(ctx: GateCheckContext): CheckOutcome {
  return finalReviewOutcome(ctx, 'g6.reviews', '终审无未处理 critical / major')
}

/** G6: risks are all handled; no unresolved violations. */
export function checkG6Risks(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.risks'
  const label = '风险项全部处理'
  const problems: string[] = []
  for (const pending of ctx.change.pending ?? []) {
    if (pending.kind === 'risk' && pending.status === 'open') {
      problems.push(`风险接管项未处理：${pending.id} ${pending.title}`)
    }
  }
  for (const violation of ctx.change.violations ?? []) {
    if (violation.clearedAt === undefined) {
      problems.push(`未清理的越界记录：${violation.path}（${violation.kind}）`)
    }
  }
  const risk = ctx.artifacts.risk
  if (risk) {
    for (const entry of risk.entries) {
      if (entry.grade === 'high' && !entry.needsHuman) {
        problems.push(`高风险项「${RISK_CATEGORY_LABELS[entry.category] ?? entry.category}」未安排人工确认`)
      }
    }
  }
  if (ctx.change.risk === 'high' && (ctx.artifacts.design?.rollback ?? '').trim() === '') {
    problems.push('高风险变更缺少回滚方案')
  }
  if (problems.length > 0) {
    return fail(item, label, '逐条处理风险接管项和越界记录，高风险项要有人工确认和回滚方案。', 'P0', { details: problems })
  }
  return pass(item, label)
}

/** G6: manual evidence recorded (high risk requires item-by-item confirmation). */
export function checkG6ManualEvidence(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.manualEvidence'
  const label = '手工证据已确认'
  const manual = ctx.evidence.filter((receipt) => receipt.kind === 'manual' || receipt.group === 'manual')
  if (ctx.change.risk === 'high' && manual.length === 0) {
    return fail(item, label, '高风险变更在 G6 需要逐条确认手工证据：补充手工验证记录（日志 / 截图说明）后再提交。', 'P0')
  }
  if (manual.length > 0) {
    const failed = manual.filter((receipt) => receipt.exitCode !== 0)
    if (failed.length > 0) {
      return fail(item, label, `手工证据中有 ${failed.length} 条未通过：${failed.map((receipt) => receipt.id).join('、')}`, 'P0')
    }
    return pass(item, label, 'P0', [`手工证据 ${manual.length} 条`])
  }
  return pass(item, label, 'P0', ['没有手工证据项'])
}

/** G6: state is not locked / tampered. */
export function checkG6TamperCheck(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.tamper'
  const label = '篡改检测项已确认'
  if (ctx.change.lock) {
    return fail(item, label, '状态被锁定（可能检测到篡改）：等待负责人在授权卡片上修复，并确认篡改检测项。', 'P0', {
      details: [ctx.change.lock.reason],
    })
  }
  const openTamper = (ctx.change.pending ?? []).filter((pending) => pending.kind === 'tamper' && pending.status === 'open')
  if (openTamper.length > 0) {
    const signals = openTamper.flatMap((pending) => {
      const list = (pending.data?.signals as { kind?: string; path?: string }[] | undefined) ?? []
      return list.map((signal) => `${signal.kind ?? 'signal'} · ${signal.path ?? ''}`)
    })
    return fail(
      item,
      label,
      '检测到疑似篡改（跳过测试/删断言/改测试基础设施）：负责人确认前不能通过 G6；合法重构请批准 TM 项，否则回退改动。',
      'P0',
      { details: [...openTamper.map((pending) => `${pending.id} ${pending.title}`), ...signals].slice(0, 20) },
    )
  }
  return pass(item, label, 'P0', ['未检测到篡改信号；`/flow doctor` 会复核账本与锁定状态'])
}

/** G6: non-agent changes are listed and confirmed; no open conflicts. */
export function checkG6ExternalChanges(ctx: GateCheckContext): CheckOutcome {
  const item = 'g6.externalChanges'
  const label = '非 agent 改动已单列确认'
  const problems: string[] = []
  for (const pending of ctx.change.pending ?? []) {
    if (pending.status === 'open' && (pending.kind === 'conflict' || pending.kind === 'blocker')) {
      problems.push(`未处理的人工确认项：${pending.id} ${pending.title}`)
    }
  }
  for (const violation of ctx.change.violations ?? []) {
    if (violation.clearedAt === undefined) problems.push(`未清理的越界改动：${violation.path}`)
  }
  for (const external of ctx.change.externalChanges ?? []) {
    if (external.confirmedAt === undefined) problems.push(`未确认的非 agent 改动：${external.path}`)
  }
  if (problems.length > 0) {
    return fail(item, label, '等待负责人在授权卡片上确认非 agent 改动，并处理所有未清理的越界记录。', 'P0', {
      details: problems,
    })
  }
  return pass(item, label)
}

// ---------------------------------------------------------------------------
// GATE_CHECKS definition table
// ---------------------------------------------------------------------------

const CHANGE_ARTIFACTS_PRESENT: ArtifactName[] = ['clarify', 'proposal', 'spec']

/** 阶段核心技能（T2.4）：过门前必须由宿主记录加载回执。 */
const REQUIRED_SKILLS: Partial<Record<GateId, string[]>> = {
  G1: ['flow-clarify'],
  G3: ['flow-plan'],
}

function skillLoaded(change: ChangeStatus, wanted: string): boolean {
  const target = wanted.toLowerCase()
  return (change.skillReceipts ?? []).some((receipt) => {
    const loaded = receipt.name.toLowerCase()
    return loaded === target || loaded.endsWith(target) || loaded.includes(`${target}:`) || loaded.includes(`/${target}`)
  })
}

/** 阶段核心技能必须已经加载过（T2.4 验收 #1）。 */
export function checkCoreSkillReceipts(ctx: GateCheckContext): CheckOutcome {
  const item = ctx.gate === 'G1' ? 'g1.coreSkills' : 'g3.coreSkills'
  const label = '阶段核心技能已加载'
  const required = REQUIRED_SKILLS[ctx.gate] ?? []
  if (required.length === 0) return pass(item, label, 'P0', ['本门不要求技能回执'])
  const missing = required.filter((name) => !skillLoaded(ctx.change, name))
  if (missing.length > 0) {
    return fail(item, label, '先在当前会话用 skill 工具加载阶段核心技能，过门时会核对加载回执。', 'P0', {
      details: [`未加载：${missing.join('、')}`, '加载方式：调用 skill 工具（如 skill({ name: "flow-plan" })）'],
    })
  }
  return pass(item, label, 'P0', [`已加载：${required.join('、')}`])
}

function onlyWhen(predicate: (ctx: GateCheckContext) => boolean) {
  return predicate
}

/** All gate check definitions, in gate execution order. */
export const GATE_CHECKS: GateCheckDefinition[] = [
  // ----- GR ---------------------------------------------------------------
  { id: 'gr.projectClarify', label: '项目级六要素闭合', gates: ['GR'], priority: 'P0', check: checkProjectClarify },
  { id: 'gr.roadmapEntries', label: '路线图至少包含一个变更', gates: ['GR'], priority: 'P0', check: checkRoadmapEntries },
  { id: 'gr.roadmapDeps', label: '路线图依赖无环且引用存在', gates: ['GR'], priority: 'P0', check: checkRoadmapDeps },
  { id: 'gr.roadmapC0', label: '第一个变更是工程骨架 C0', gates: ['GR'], priority: 'P0', check: checkRoadmapC0 },
  { id: 'gr.roadmapMvp', label: '每项 MVP 能力都有归属的变更', gates: ['GR'], priority: 'P0', check: checkRoadmapMvp },
  { id: 'gr.roadmapScale', label: '单个变更预计任务数不超过上限', gates: ['GR'], priority: 'P0', check: checkRoadmapScale },
  { id: 'gr.roadmapMvpCut', label: 'MVP 切线已标出', gates: ['GR'], priority: 'P0', check: checkRoadmapMvpCut },

  // ----- G0 ---------------------------------------------------------------
  { id: 'g0.changeDir', label: '变更目录已创建', gates: ['G0'], priority: 'P0', check: checkChangeCreated },
  { id: 'g0.title', label: '标题和一句话目标非空', gates: ['G0'], priority: 'P0', check: checkTitleGoal },
  { id: 'g0.levels', label: '复杂度和风险已建议', gates: ['G0'], priority: 'P0', check: checkLevelsSet },
  { id: 'g0.contract', label: '契约已冻结', gates: ['G0'], priority: 'P0', check: checkContractFrozen },

  // ----- G1 ---------------------------------------------------------------
  { id: 'g1.sixElements', label: '六要素各有结论或被接受为假设', gates: ['G1'], priority: 'P0', check: checkClarifySixElements },
  { id: 'g1.scenarioCoverage', label: '每条需求至少一个可测试场景', gates: ['G1'], priority: 'P0', check: checkScenarioCoverage },
  { id: 'g1.vagueTerms', label: '场景的 THEN 无未量化模糊词', gates: ['G1'], priority: 'P0', check: checkScenarioVagueTerms },
  { id: 'g1.outOfScope', label: '「不做」清单非空', gates: ['G1'], priority: 'P0', check: checkOutOfScope },
  { id: 'g1.openQuestions', label: '未决问题 = 0', gates: ['G1'], priority: 'P0', check: checkOpenQuestions },
  { id: 'g1.specFormat', label: '增量规格格式合法', gates: ['G1'], priority: 'P0', check: checkSpecFormat },
  { id: 'g1.factsCitations', label: '已知事实都带可核验引用', gates: ['G1'], priority: 'P1', check: checkAnalysisCitations },
  { id: 'g1.coreSkills', label: '阶段核心技能已加载', gates: ['G1'], priority: 'P0', check: checkCoreSkillReceipts },
  { id: 'g1.clarifyRounds', label: '澄清轮数不超过上限', gates: ['G1'], priority: 'P1', check: checkClarifyRounds },
  { id: 'g1.qaChanged', label: '问答记录写清「这个回答改变了什么」', gates: ['G1'], priority: 'P1', check: checkClarifyQaChanged },

  // ----- G2 ---------------------------------------------------------------
  {
    id: 'g2.contextSections',
    label: 'context.md 必填段非空',
    gates: ['G2'],
    priority: 'P0',
    when: onlyWhen((ctx) => ctx.change.complexity !== 'low'),
    check: checkContextSections,
  },
  {
    id: 'g2.contextCitations',
    label: '接口约束与数据模型带源码引用',
    gates: ['G2'],
    priority: 'P1',
    when: onlyWhen((ctx) => ctx.change.complexity !== 'low' && ctx.artifacts.context !== undefined),
    check: checkContextCitations,
  },
  { id: 'g2.projectCommands', label: 'project.md 命令可执行', gates: ['G2'], priority: 'P0', check: checkProjectCommands },
  { id: 'g2.baseline', label: '基线已记录', gates: ['G2'], priority: 'P0', check: checkBaseline },
  {
    id: 'g2.citationsFresh',
    label: '已核验引用未被改动（否则待复核）',
    gates: ['G2', 'G3', 'G5'],
    priority: 'P1',
    when: onlyWhen((ctx) => (ctx.change.citationChecks?.length ?? 0) > 0),
    check: checkCitationsFresh,
  },

  // ----- G3 ---------------------------------------------------------------
  {
    id: 'g3.design',
    label: '设计有 2–3 个方案对比和推荐',
    gates: ['G3'],
    priority: 'P0',
    when: onlyWhen((ctx) => ctx.change.complexity !== 'low'),
    check: checkDesignOptions,
  },
  {
    id: 'g3.risk',
    label: '风险登记五类齐全',
    gates: ['G3'],
    priority: 'P0',
    // 低复杂度仅在普通风险时免填；低复杂度 · 高风险仍要求风险逐项确认（T2.8）。
    when: onlyWhen((ctx) => ctx.change.complexity !== 'low' || ctx.change.risk === 'high'),
    check: checkRiskCategories,
  },
  {
    id: 'g3.rollbackPlan',
    label: '高风险低复杂度方案有回滚方案',
    gates: ['G3'],
    priority: 'P0',
    when: onlyWhen((ctx) => ctx.change.complexity === 'low' && ctx.change.risk === 'high'),
    check: checkRollbackPlan,
  },
  { id: 'g3.taskCards', label: '任务卡检查通过（依赖无环、场景全覆盖、范围合理、规模受限）', gates: ['G3'], priority: 'P0', check: checkTaskCards },
  { id: 'g3.traceability', label: '追溯矩阵无未覆盖场景', gates: ['G3'], priority: 'P0', check: checkTraceability },
  { id: 'g3.taskCount', label: '任务数不超过上限', gates: ['G3'], priority: 'P0', check: checkTaskCount },
  { id: 'g3.newFiles', label: 'new_files 落在 scope 内且不是根级通配', gates: ['G3'], priority: 'P0', check: checkNewFiles },
  { id: 'g3.verifyCommands', label: '每个任务都有合法的验证命令', gates: ['G3'], priority: 'P0', check: checkVerifyCommands },
  {
    id: 'g3.executionPlan',
    label: '执行计划通过检查（依赖顺序、并行范围、热点文件）',
    gates: ['G3'],
    priority: 'P0',
    when: onlyWhen(
      (ctx) =>
        ctx.change.complexity !== 'low' ||
        (ctx.artifacts.tasks !== undefined && ctx.artifacts.tasks.execution.batches.length > 0),
    ),
    check: checkPlan,
  },
  { id: 'g3.coreSkills', label: '阶段核心技能已加载', gates: ['G3'], priority: 'P0', check: checkCoreSkillReceipts },
  {
    id: 'g3.frozenArtifacts',
    label: '已冻结产物未被修改',
    gates: ['G2', 'G3', 'G5', 'G6'],
    priority: 'P0',
    check: checkFrozenArtifacts,
  },
  { id: 'g3.cleanWorktree', label: '工作区没有未提交的改动', gates: ['G3'], priority: 'P0', check: checkCleanWorktree },
  {
    id: 'g3.testNoneRisk',
    label: '缺少自动化测试已登记为风险',
    gates: ['G3'],
    priority: 'P1',
    when: onlyWhen((ctx) => withoutUndefined(mergedCommands(ctx)).test === 'none'),
    check: checkTestNoneRisk,
  },

  // ----- G5 ---------------------------------------------------------------
  { id: 'g5.fullTests', label: '全量测试通过且相对基线无回归', gates: ['G5'], priority: 'P0', check: checkG5FullTests },
  { id: 'g5.lintBuild', label: 'lint / build / typecheck 通过', gates: ['G5'], priority: 'P0', check: checkG5LintBuild },
  { id: 'g5.scenarios', label: '验收场景全部有通过证据', gates: ['G5'], priority: 'P0', check: checkG5Scenarios },
  { id: 'g5.runtime', label: '运行证据（按风险）', gates: ['G5'], priority: 'P0', check: checkG5RuntimeEvidence },
  { id: 'g5.finalReview', label: '终审无未处理 critical / major', gates: ['G5'], priority: 'P0', check: checkG5FinalReview },

  // ----- G6 ---------------------------------------------------------------
  { id: 'g6.taskCompletion', label: '全部任务完成', gates: ['G6'], priority: 'P0', check: checkG6TaskCompletion },
  { id: 'g6.g5Passed', label: 'G5 已通过', gates: ['G6'], priority: 'P0', check: checkG6G5Passed },
  { id: 'g6.scenarios', label: '验收场景全部有通过证据', gates: ['G6'], priority: 'P0', check: checkG6Scenarios },
  { id: 'g6.reviews', label: '终审无未处理 critical / major', gates: ['G6'], priority: 'P0', check: checkG6Reviews },
  { id: 'g6.risks', label: '风险项全部处理', gates: ['G6'], priority: 'P0', check: checkG6Risks },
  { id: 'g6.manualEvidence', label: '手工证据已确认', gates: ['G6'], priority: 'P0', check: checkG6ManualEvidence },
  { id: 'g6.tamper', label: '篡改检测项已确认', gates: ['G6'], priority: 'P0', check: checkG6TamperCheck },
  { id: 'g6.externalChanges', label: '非 agent 改动已单列确认', gates: ['G6'], priority: 'P0', check: checkG6ExternalChanges },
]

const LEVEL_LEVEL_GATE: Record<string, (level: GateLevelProfile) => boolean> = {
  'g3.design': (level) => level.requiresDesign,
  'g3.risk': (level) => level.requiresRiskDoc,
  'g3.executionPlan': (level) => level.requiresExecutionPlan,
}

/** Applicable checks for a gate under a level profile (low complexity skips design/risk/plan). */
export function checksForGate(gate: GateId, level: GateLevelProfile): GateCheckDefinition[] {
  const includeG1 = level.mergedGates && gate === 'G3'
  return GATE_CHECKS.filter((definition) => {
    const gateMatch = definition.gates.includes(gate) || (includeG1 && definition.gates.includes('G1'))
    if (!gateMatch) return false
    const levelPredicate = LEVEL_LEVEL_GATE[definition.id]
    if (levelPredicate && !levelPredicate(level)) return false
    return true
  })
}

const STAGE_GATE: Partial<Record<StageId, GateId>> = {
  roadmap: 'GR',
  S0: 'G0',
  S1: 'G1',
  S2: 'G2',
  S3: 'G3',
  S5: 'G5',
  S6: 'G6',
}

/** Run every applicable gate check for the current gate/level of the change. */
export async function runGateChecks(ctx: GateCheckContext): Promise<CheckOutcome[]> {
  const gate: GateId | undefined = (ctx as { gate?: GateId }).gate ?? STAGE_GATE[ctx.change.stage]
  if (!gate) return []
  const level: LevelProfile = (ctx as { level?: LevelProfile }).level ?? gateProfile(ctx.change)
  const definitions = checksForGate(gate, level)
  const outcomes: CheckOutcome[] = []
  for (const definition of definitions) {
    if (definition.when && !definition.when(ctx)) continue
    try {
      const outcome = await definition.check(ctx)
      outcomes.push({ ...outcome, item: definition.id, label: definition.label, priority: definition.priority ?? outcome.priority })
    } catch (error) {
      outcomes.push(
        fail(definition.id, definition.label, `检查执行失败：${(error as Error).message}`, definition.priority ?? 'P0'),
      )
    }
  }
  return outcomes
}

/** Artifacts that must exist for the change-kind-specific checks. */
export function requiredArtifactsFor(gate: GateId): ArtifactName[] {
  switch (gate) {
    case 'G1':
      return CHANGE_ARTIFACTS_PRESENT
    case 'G2':
      return ['context']
    case 'G3':
      return ['design', 'risk', 'tasks']
    default:
      return []
  }
}

