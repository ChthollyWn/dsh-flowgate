/**
 * 审查 / 调查子 agent（P1，03 §7 / H12 / H20 / H24 / H25）。
 *
 * 能力组合（rc.5 事实见 docs/impl/dsh-plugin-api-cheatsheet.md §5.8）：
 * - `ctx.subagents.startActivation({ provider:'spawn', request:{ parent, agentPreset,
 *   cwd, prompt, outputSchema, signal }, delivery:'caller' })` 启动进程内子 agent；
 * - 只读取证 preset（cordis.patch.yml 里的 `flowgate-reviewer`，用 dsh-tool-fs
 *   config { read:true, write:false, edit:false } 保证文件工具只读）；
 * - 结构化结论 `activation.result.structured`；
 * - `ctx.sessionQuery.readSession(childId)` 核对它实际读过哪些文件（读取覆盖）。
 *
 * 失败语义（03 §14）：启动失败/超时**不消耗审查轮次**，自动重试 1 次；
 * 仍失败则返回 ok:false，由任务门标记"审查缺失"（普通风险可豁免，高风险阻断）。
 */
import type { DshAgent, DshContentBlock, DshSessionQueryEngine, DshSubagentRuntime, DshSubagentResult } from '../adapters/dsh-types.js'
import type { EngineLike, HostReviewOutcome } from '../types.js'
import type { HostRuntime } from '../runtime.js'
import type { ReviewFinding } from '../../core/types.js'
import { HostError, toAgentError } from '../errors.js'
import { sha256Hex } from '../../core/util/hash.js'
import { FLOWGATE_PRESETS } from '../guard/delegation.js'

/** 审查子 agent 的结构化输出 schema（spawn 本地后端要求 object root）。 */
export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes-required'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          rule: { type: 'string' },
          message: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'message'],
        additionalProperties: true,
      },
    },
    readFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary'],
  additionalProperties: true,
}

/** 当前变更的任务门审查轮次要求（0=不需要；fake/旧 engine 退化为 1）。 */
export function taskReviewRounds(engine: EngineLike): number {
  const fn = (engine as unknown as { requiredReviewRounds?: () => number }).requiredReviewRounds
  try {
    return typeof fn === 'function' ? Math.max(0, Number(fn.call(engine)) || 0) : 1
  } catch {
    return 1
  }
}

/** 子 agent 可用性：subagents 服务 + agent 工厂 + 已知 provider。 */
export function reviewCapability(runtime: HostRuntime): { available: boolean; provider?: string; reason?: string } {
  const subagents = runtime.getService<DshSubagentRuntime>('subagents')
  if (!subagents || typeof subagents.startActivation !== 'function') {
    return { available: false, reason: '宿主没有 ctx.subagents.startActivation' }
  }
  if (!runtime.mainAgent()) return { available: false, reason: '主会话尚未绑定' }
  const providers = safeList(subagents)
  const provider = providers.find((name) => name === 'spawn') ?? providers.find((name) => name === 'local') ?? providers[0]
  if (!provider) return { available: false, reason: '没有可用的子 agent provider（需要 dsh-subagent 本地后端）' }
  return { available: true, provider }
}

function safeList(subagents: DshSubagentRuntime): string[] {
  try {
    return subagents.list?.() ?? []
  } catch {
    return []
  }
}

/** 收集当前任务的改动文件与 diff（审查输入 + 读取覆盖核对基准）。 */
export async function collectDiff(runtime: HostRuntime, taskId?: string): Promise<{ diff: string; files: string[]; worktree?: string }> {
  const engine = runtime.requireEngine()
  const ports = runtime.ports()
  const root = runtime.root()
  if (!ports?.git || !root) throw new HostError('当前环境没有 git，无法生成 diff', '运行 /flow doctor 确认 git 可用')
  const change = engine.currentChange()
  const task = taskId ? engine.getTask(taskId) : undefined
  const taskState = change && taskId ? change.tasks[taskId] : undefined
  const cwd = taskState?.worktree ? runtime.absolute(taskState.worktree) : root
  const files = task
    ? [...new Set([...task.scope, ...task.newFiles, ...task.tests, ...(task.approvedScope ?? []), ...(task.approvedNewFiles ?? [])])]
    : await ports.git.diffNames(cwd).catch(() => [])
  let diff = ''
  try {
    diff = await ports.git.diffText(cwd)
  } catch (error) {
    throw new HostError(`读取 diff 失败：${toAgentError(error).error}`, '检查 git 状态与工作目录')
  }
  return { diff, files, worktree: taskState?.worktree }
}

/** 审查提示词。 */
export function buildReviewPrompt(input: {
  taskId?: string
  changeTitle: string
  taskTitle?: string
  taskScope: string[]
  criteria: string[]
  diff: string
  files: string[]
}): DshContentBlock[] {
  const lines: string[] = [
    '你是 FlowGate 的独立审查者（只读取证模式）。你的任务：审查下面的改动是否满足要求，只输出结构化结论。',
    '',
    `变更：${input.changeTitle}`,
    input.taskTitle ? `任务：${input.taskId ?? ''} ${input.taskTitle}` : '',
    input.taskScope.length > 0 ? `任务范围：${input.taskScope.join('、')}` : '',
    '',
    '审查清单（逐条给出结论，发现必须带文件与行号）：',
    ...input.criteria.map((item, index) => `${index + 1}. ${item}`),
    '',
    '规则：',
    '- 只能用只读工具（read/glob/grep/flow_diff）；不能改文件、不能跑 shell。',
    '- 至少读完改动文件与原文件的相关行；漏读或截断视为未覆盖，结论会被拒绝。',
    '- verdict 只能是 pass 或 changes-required；findings 的 severity 只能是 critical/major/minor。',
    '- 没有发现问题时 findings 为空数组，verdict 仍可为 pass。',
    '',
    input.files.length > 0 ? `涉及文件：${input.files.join('、')}` : '涉及文件：见 diff',
    '',
    '改动 diff：',
    '```diff',
    input.diff.length > 60_000 ? `${input.diff.slice(0, 60_000)}\n…（diff 过长已截断，可用 flow_diff 或 read 查看完整内容）` : input.diff,
    '```',
  ].filter((line) => line !== '')
  return [{ type: 'text', text: lines.join('\n') }]
}

function reviewCriteria(): string[] {
  return [
    '改动是否在任务范围内，是否与已有模块重复（重复造轮子）',
    '是否覆盖任务卡声称的场景/需求（对照 spec 场景与验收标准）',
    '错误处理与边界条件是否完整（失败路径、幂等、并发）',
    '测试是否真实覆盖新逻辑（是否只改断言或跳过用例）',
    '是否引入安全/性能/兼容性风险（受保护路径、依赖变更、迁移）',
  ]
}

/** 运行一次审查；失败自动重试 1 次，两次都失败返回 ok:false（不消耗轮次）。 */
export async function runTaskReview(runtime: HostRuntime, taskId: string): Promise<HostReviewOutcome> {
  const capability = reviewCapability(runtime)
  if (!capability.available || !capability.provider) {
    return {
      ok: false,
      verdict: 'changes-required',
      findings: [],
      coverageOk: false,
      message: `审查子 agent 不可用：${capability.reason ?? '未知原因'}`,
    }
  }
  const engine = runtime.requireEngine()
  const parent = runtime.mainAgent()
  if (!parent) {
    return { ok: false, verdict: 'changes-required', findings: [], coverageOk: false, message: '主会话未绑定' }
  }
  const change = engine.currentChange()
  const task = engine.getTask(taskId)
  if (!change || !task) {
    throw new HostError(`没有任务 ${taskId}`, '运行 /flow 查看执行图')
  }
  const { diff, files } = await collectDiff(runtime, taskId)
  const diffFingerprint = sha256Hex(diff)
  const prompt = buildReviewPrompt({
    taskId,
    changeTitle: `${change.id} ${change.title}`,
    taskTitle: task.title,
    taskScope: [...task.scope, ...task.newFiles],
    criteria: reviewCriteria(),
    diff,
    files,
  })
  const subagents = runtime.getService<DshSubagentRuntime>('subagents')
  if (!subagents) return { ok: false, verdict: 'changes-required', findings: [], coverageOk: false, message: '子 agent 服务消失' }

  let lastError: unknown = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5 * 60_000)
    timer.unref?.()
    let activation: { childId: unknown; result: Promise<DshSubagentResult>; dispose(): Promise<void> } | null = null
    try {
      activation = await subagents.startActivation({
        provider: capability.provider,
        label: `flowgate-review-${taskId}-${attempt}`,
        request: {
          parent,
          agentPreset: FLOWGATE_PRESETS.reviewer,
          prompt,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          signal: controller.signal,
          ...(runtime.root() ? { cwd: runtime.root() as string } : {}),
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      runtime.registerAgentRole(String(activation.childId), 'reviewer', { changeId: change.id, taskId })
      await enforceChildReadOnly(runtime, String(activation.childId))
      const result = await activation.result
      const structured = parseReviewResult(result)
      const coverage = await checkReadCoverage(runtime, String(activation.childId), files)
      const coverageOk = structured.readFilesSatisfied && coverage.ok
      const findings = structured.findings
      const verdict = structured.verdict
      try {
        await engine.recordReview({
          taskId,
          kind: 'task',
          verdict,
          findings,
          coverageOk,
          diffFingerprint,
          attempts: attempt,
        })
      } catch (error) {
        runtime.noteFeature('review', `审查记录失败：${toAgentError(error).error}`)
      }
      runtime.emit()
      const message = coverageOk
        ? `审查完成：${verdict === 'pass' ? '通过' : '需要修改'}（${findings.length} 条发现，第 ${attempt} 次尝试）`
        : `审查未能覆盖全部改动文件（读取覆盖不足）：${coverage.detail ?? '读取覆盖不足'}。本次不消耗审查轮次。`
      return { ok: coverageOk, verdict, findings, coverageOk, message }
    } catch (error) {
      lastError = error
      runtime.noteFeature('review', `审查子 agent 第 ${attempt} 次启动/执行失败（不消耗轮次）：${toAgentError(error).error}`)
    } finally {
      clearTimeout(timer)
      if (activation) {
        try {
          await activation.dispose()
        } catch {
          // 清理失败不影响结论。
        }
      }
    }
  }
  return {
    ok: false,
    verdict: 'changes-required',
    findings: [],
    coverageOk: false,
    message: `审查子 agent 启动失败（重试 1 次后仍失败）：${toAgentError(lastError).error}。任务门将标记"审查缺失"。`,
  }
}

/** 终审检查清单（S5；高风险额外要求安全/合规）。 */
function finalReviewCriteria(riskHigh: boolean): string[] {
  const criteria = [
    '全部改动是否满足变更目标与全部验收场景（对照 specs/ 与追溯矩阵）',
    '是否引入回归风险：既有行为、接口兼容、迁移与配置是否被无证据地改变',
    '证据是否真实：测试是否覆盖新逻辑，是否存在跳过用例、改断言或"无证据自称完成"',
    '错误处理与边界条件（失败路径、幂等、并发）是否完整',
  ]
  if (riskHigh) {
    criteria.push(
      '安全：鉴权/越权、注入、密钥与敏感数据、依赖与供应链风险',
      '合规：日志/导出/存储是否泄漏敏感字段，是否满足登记的合规要求',
    )
  }
  return criteria
}

function buildFinalReviewPrompt(input: {
  changeTitle: string
  riskHigh: boolean
  criteria: string[]
  diff: string
  files: string[]
}): DshContentBlock[] {
  const lines: string[] = [
    '你是 FlowGate 的独立终审者（只读取证模式）。这是 S5 交付前的整体终审，只输出结构化结论。',
    '',
    `变更：${input.changeTitle}`,
    `风险等级：${input.riskHigh ? '高（必须同时给出安全/合规结论）' : '普通'}`,
    '',
    '终审清单（逐条给出结论，发现必须带文件与行号）：',
    ...input.criteria.map((item, index) => `${index + 1}. ${item}`),
    '',
    '规则：',
    '- 只能用只读工具（read/glob/grep/flow_diff）；不能改文件、不能跑 shell。',
    '- 至少读完改动文件与原文件的相关行；漏读或截断视为未覆盖，结论会被拒绝。',
    '- verdict 只能是 pass 或 changes-required；findings 的 severity 只能是 critical/major/minor。',
    '- 没有发现问题时 findings 为空数组，verdict 仍可为 pass。',
    '',
    input.files.length > 0 ? `涉及文件：${input.files.join('、')}` : '涉及文件：见 diff',
    '',
    '改动 diff（相对 S2 基线）：',
    '```diff',
    input.diff.length > 80_000 ? `${input.diff.slice(0, 80_000)}\n…（diff 过长已截断，可用 flow_diff 或 read 查看完整内容）` : input.diff,
    '```',
  ].filter((line) => line !== '')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * S5 终审 / 高风险安全审查的生产者（P0-5）。
 *
 * 现有 `runTaskReview` 只产 `kind:'task'` 的审查记录，而 G5/G6 要求
 * `kind:'final'`（高风险还需 `kind:'security'`）记录——此前没有生产者，
 * 开着 `review.enabled` 提交 G5 必然失败。终审对"相对 S2 基线的整体 diff"
 * 跑一次只读审查子 agent，并把同一结论登记为 final（高风险时再登记 security）。
 */
export async function runFinalReview(runtime: HostRuntime): Promise<HostReviewOutcome> {
  const capability = reviewCapability(runtime)
  if (!capability.available || !capability.provider) {
    return {
      ok: false,
      verdict: 'changes-required',
      findings: [],
      coverageOk: false,
      message: `终审子 agent 不可用：${capability.reason ?? '未知原因'}`,
    }
  }
  const parent = runtime.mainAgent()
  if (!parent) return { ok: false, verdict: 'changes-required', findings: [], coverageOk: false, message: '主会话未绑定' }
  const engine = runtime.requireEngine()
  const change = engine.currentChange()
  if (!change) throw new HostError('没有进行中的变更', '运行 /flow 查看')
  const subagents = runtime.getService<DshSubagentRuntime>('subagents')
  if (!subagents) return { ok: false, verdict: 'changes-required', findings: [], coverageOk: false, message: '子 agent 服务消失' }
  const ports = runtime.ports()
  const root = runtime.root()
  let diff = ''
  let files: string[] = []
  if (ports?.git && root) {
    const base = change.baseline?.commit ?? undefined
    try {
      diff = await ports.git.diffText(root, base)
      files = await ports.git.diffNames(root, base).catch(() => [])
    } catch (error) {
      return {
        ok: false,
        verdict: 'changes-required',
        findings: [],
        coverageOk: false,
        message: `读取终审 diff 失败：${toAgentError(error).error}`,
      }
    }
  }
  if (files.length === 0) {
    files = [...new Set(engine.getTasks().flatMap((task) => [...task.scope, ...task.newFiles, ...task.tests]))]
  }
  const diffFingerprint = sha256Hex(diff)
  const riskHigh = change.risk === 'high'
  const prompt = buildFinalReviewPrompt({
    changeTitle: `${change.id} ${change.title}`,
    riskHigh,
    criteria: finalReviewCriteria(riskHigh),
    diff,
    files,
  })

  let lastError: unknown = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8 * 60_000)
    timer.unref?.()
    let activation: { childId: unknown; result: Promise<DshSubagentResult>; dispose(): Promise<void> } | null = null
    try {
      activation = await subagents.startActivation({
        provider: capability.provider,
        label: `flowgate-final-review-${attempt}`,
        request: {
          parent,
          agentPreset: FLOWGATE_PRESETS.reviewer,
          prompt,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          signal: controller.signal,
          ...(root ? { cwd: root } : {}),
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      runtime.registerAgentRole(String(activation.childId), 'reviewer')
      await enforceChildReadOnly(runtime, String(activation.childId))
      const result = await activation.result
      const structured = parseReviewResult(result)
      const coverage = await checkReadCoverage(runtime, String(activation.childId), files)
      const coverageOk = structured.readFilesSatisfied && coverage.ok
      try {
        await engine.recordReview({
          kind: 'final',
          verdict: structured.verdict,
          findings: structured.findings,
          coverageOk,
          diffFingerprint,
          attempts: attempt,
        })
        if (riskHigh) {
          await engine.recordReview({
            kind: 'security',
            verdict: structured.verdict,
            findings: structured.findings,
            coverageOk,
            diffFingerprint,
            attempts: attempt,
          })
        }
      } catch (error) {
        runtime.noteFeature('review', `终审记录失败：${toAgentError(error).error}`)
      }
      runtime.emit()
      const message = coverageOk
        ? `终审完成：${structured.verdict === 'pass' ? '通过' : '需要修改'}（${structured.findings.length} 条发现${riskHigh ? '，已登记安全审查' : ''}，第 ${attempt} 次尝试）`
        : `终审未覆盖全部改动文件（读取覆盖不足）：${coverage.detail ?? '读取覆盖不足'}。本次不消耗轮次。`
      return { ok: coverageOk, verdict: structured.verdict, findings: structured.findings, coverageOk, message }
    } catch (error) {
      lastError = error
      runtime.noteFeature('review', `终审子 agent 第 ${attempt} 次启动/执行失败（不消耗轮次）：${toAgentError(error).error}`)
    } finally {
      clearTimeout(timer)
      if (activation) {
        try {
          await activation.dispose()
        } catch {
          // 清理失败不影响结论。
        }
      }
    }
  }
  return {
    ok: false,
    verdict: 'changes-required',
    findings: [],
    coverageOk: false,
    message: `终审子 agent 启动失败（重试 1 次后仍失败）：${toAgentError(lastError).error}`,
  }
}

interface ParsedReview {
  verdict: 'pass' | 'changes-required'
  findings: ReviewFinding[]
  readFilesSatisfied: boolean
}

function parseReviewResult(result: DshSubagentResult): ParsedReview {
  const structured = result.structured
  if (structured === null || typeof structured !== 'object') {
    return { verdict: 'changes-required', findings: [], readFilesSatisfied: false }
  }
  const record = structured as Record<string, unknown>
  const verdict = record.verdict === 'pass' ? 'pass' : 'changes-required'
  const findingsRaw = Array.isArray(record.findings) ? record.findings : []
  const findings: ReviewFinding[] = []
  for (const item of findingsRaw) {
    if (item === null || typeof item !== 'object') continue
    const finding = item as Record<string, unknown>
    const message = typeof finding.message === 'string' ? finding.message : ''
    const file = typeof finding.file === 'string' ? finding.file : ''
    if (message === '') continue
    const severity = finding.severity === 'critical' ? 'critical' : finding.severity === 'major' ? 'major' : 'minor'
    const reviewFinding: ReviewFinding = {
      severity,
      file,
      rule: typeof finding.rule === 'string' ? finding.rule : '审查',
      message,
    }
    if (typeof finding.line === 'number' && Number.isFinite(finding.line)) reviewFinding.line = finding.line
    if (typeof finding.suggestion === 'string') reviewFinding.suggestion = finding.suggestion
    findings.push(reviewFinding)
  }
  // 结构化输出里自带 readFiles 时，要求非空（说明审查者确实读过东西）。
  const readFiles = Array.isArray(record.readFiles) ? record.readFiles : undefined
  const readFilesSatisfied = readFiles === undefined ? true : readFiles.length > 0
  return { verdict, findings, readFilesSatisfied }
}

/** 用 sessionQuery 核对审查者实际读过哪些文件（H24）。 */
export async function checkReadCoverage(
  runtime: HostRuntime,
  childSessionId: string,
  requiredFiles: string[],
): Promise<{ ok: boolean; readFiles: string[]; detail?: string }> {
  const query = runtime.getService<DshSessionQueryEngine>('sessionQuery')
  if (!query || (typeof query.readSession !== 'function' && typeof query.observeSession !== 'function')) {
    runtime.noteFeature('review', '宿主没有 sessionQuery：读取覆盖核对降级为"只认结构化自述"')
    return { ok: true, readFiles: [], detail: 'sessionQuery 不可用（已降级）' }
  }
  if (requiredFiles.length === 0) return { ok: true, readFiles: [] }
  let events: unknown[] = []
  try {
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(childSessionId)
      events = [...(snapshot.events ?? [])]
    } else if (query.observeSession) {
      const observation = await query.observeSession(childSessionId, { projectionMode: 'none' })
      events = [...(observation.events ?? [])]
      observation.dispose?.()
    }
  } catch (error) {
    return { ok: false, readFiles: [], detail: `读取子会话失败：${toAgentError(error).error}` }
  }
  const serialized = JSON.stringify(events)
  const readFiles = requiredFiles.filter((file) => serialized.includes(file))
  const missing = requiredFiles.filter((file) => !serialized.includes(file))
  if (missing.length > 0) {
    return { ok: false, readFiles, detail: `未读到：${missing.slice(0, 5).join('、')}` }
  }
  return { ok: true, readFiles }
}

/** 只读调查（flow_investigate）：返回报告文本并记录为调查任务输出。 */
export async function runInvestigation(
  runtime: HostRuntime,
  input: { questions: string[]; benefit: string; taskId?: string },
): Promise<{ ok: boolean; report: string; message: string }> {
  const capability = reviewCapability(runtime)
  if (!capability.available || !capability.provider) {
    return { ok: false, report: '', message: `调查子 agent 不可用：${capability.reason ?? '未知原因'}` }
  }
  const parent = runtime.mainAgent()
  const subagents = runtime.getService<DshSubagentRuntime>('subagents')
  if (!parent || !subagents) return { ok: false, report: '', message: '主会话未绑定或子 agent 服务消失' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5 * 60_000)
  timer.unref?.()
  let activation: { childId: unknown; result: Promise<DshSubagentResult>; dispose(): Promise<void> } | null = null
  try {
    const prompt: DshContentBlock[] = [
      {
        type: 'text',
        text: [
          '你是 FlowGate 的只读调查者。用只读工具（read/glob/grep/flow_diff）调查下面的问题，',
          '结论必须带 `文件:起止行` 引用；不要改任何文件，不要跑 shell。',
          '',
          `调查收益说明（为什么要做）：${input.benefit}`,
          '',
          '问题：',
          ...input.questions.map((question, index) => `${index + 1}. ${question}`),
        ].join('\n'),
      },
    ]
    activation = await subagents.startActivation({
      provider: capability.provider,
      label: `flowgate-investigate-${Date.now()}`,
      request: {
        parent,
        agentPreset: FLOWGATE_PRESETS.reviewer,
        prompt,
        signal: controller.signal,
        ...(runtime.root() ? { cwd: runtime.root() as string } : {}),
      },
      signal: controller.signal,
      delivery: 'caller',
    })
    runtime.registerAgentRole(String(activation.childId), 'investigator')
    await enforceChildReadOnly(runtime, String(activation.childId))
    const result = await activation.result
    const report = result.output
      .map((block) => (block.type === 'text' ? String(block.text ?? '') : ''))
      .join('\n')
      .trim()
    if (report === '') return { ok: false, report: '', message: '调查子 agent 没有输出报告' }
    return { ok: true, report, message: `调查完成（${result.stopReason}）` }
  } catch (error) {
    return { ok: false, report: '', message: `调查子 agent 失败：${toAgentError(error).error}` }
  } finally {
    clearTimeout(timer)
    if (activation) {
      try {
        await activation.dispose()
      } catch {
        // 忽略。
      }
    }
  }
}

/**
 * 只读取证子 agent 的运行时兜底（H25 备选方案）：
 * preset 的 tool-fs config 是硬边界，但全局 composition 里的 bash/write 等工具
 * 仍可能被继承；这里通过 `agent.ctx.tools.restrict({ deny })` 把非只读工具从
 * 该子 agent 的可见集合里拿掉（restrict 只过滤继承的全局工具，正好合适）。
 * 失败只记 doctor，不影响审查主流程（守卫仍会拦写操作）。
 */
const READ_ONLY_ALLOW = new Set(['read', 'read_image', 'glob', 'grep', 'flow_diff', 'flow_status', 'flow_investigate', 'ask_user_question'])

export async function enforceChildReadOnly(runtime: HostRuntime, childId: string): Promise<void> {
  try {
    const agents = runtime.getService<{ get?(id: string): DshAgent | undefined }>('agents')
    const child = agents?.get?.(childId)
    const childTools = child?.ctx?.get?.('tools') as
      | { schemas?(): { name: string }[]; restrict?(filter: { deny: readonly string[] }): () => void; presentAs?(mode: 'native' | 'ptc'): () => void }
      | null
      | undefined
    if (!childTools || typeof childTools.restrict !== 'function') {
      runtime.noteFeature('review', '无法对只读取证子 agent 应用 restrict；仅依赖 preset 工具集与全局守卫')
      return
    }
    const known = (childTools.schemas?.() ?? []).map((schema) => schema.name)
    const deny = known.filter((name) => !READ_ONLY_ALLOW.has(name))
    if (deny.length > 0) {
      const dispose = childTools.restrict({ deny })
      if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    }
    if (typeof childTools.presentAs === 'function') {
      const dispose = childTools.presentAs('native')
      if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    }
  } catch (error) {
    runtime.noteFeature('review', `只读限制失败（降级为只依赖 preset 与守卫）：${toAgentError(error).error}`)
  }
}

/** flow_diff 工具主体：只读返回任务 diff。 */
export async function readTaskDiff(runtime: HostRuntime, taskId?: string): Promise<{ diff: string; files: string[] }> {
  const { diff, files } = await collectDiff(runtime, taskId)
  if (diff === '') throw new HostError('没有可审查的 diff（工作区干净）', '确认任务改动已保存；或运行 /flow 查看执行图')
  const maxLength = 30_000
  const text = diff.length > maxLength ? `${diff.slice(0, maxLength)}\n…（diff 超过 ${maxLength} 字符，已截断）` : diff
  return { diff: text, files }
}
