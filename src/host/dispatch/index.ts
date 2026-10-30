/**
 * 按执行图派发任务（P1，03 §7.5 / H18 / H20 / H21 / H22）。
 *
 * 流程：
 * 1. `flow_dispatch_next` 调 `engine.dispatchNext()` 拿到本批可派发的
 *    `DispatchTaskEnvelope[]`（顺序批次 1 个；并行批次最多 parallel.max_agents 个）；
 * 2. 并行任务先建 git worktree（`.flowgate/worktrees/<变更>/<任务>/`，分支
 *    `flowgate/<变更>/<任务>`）并跑 `parallel.setup` 准备命令；
 * 3. 用 `ctx.subagents.startActivation` 以"执行者" preset 启动全新子 agent
 *    （`delivery:'caller'`，不带主会话历史，cwd 指向 worktree）；
 * 4. 工具**立即返回**任务清单；子 agent 结束后 host 跑任务门、审查、记账，
 *    并用 `agent.inject()` 把结构化摘要通知主会话（不唤醒，下一步生效）；
 * 5. 并行批次全部结束后做集成检查点（合并分支 + integration 命令），
 *    结果写 `engine.completeCheckpoint(batchId, {ok, detail})`。
 *
 * 降级：宿主不支持子 agent / git worktree 时，返回明确错误并保留任务状态，
 * 由负责人改用 inline 模式（/flow 里提示），绝不静默丢任务。
 */
import type { DshAgent, DshContext, DshToolRuntime, DshSubagentRuntime } from '../adapters/dsh-types.js'
import type { EngineLike } from '../types.js'
import type { HostRuntime } from '../runtime.js'
import type { DispatchTaskEnvelope } from '../../core/types.js'
import { defineHostTool, fail, ok } from '../tools/schema.js'
import { HostError, toAgentError } from '../errors.js'
import { FLOWGATE_PRESETS } from '../guard/delegation.js'
import { reviewCapability, runTaskReview } from '../review/index.js'
import { runGit } from '../adapters/node-git.js'
import { normalizeSlashes } from '../adapters/windows-path.js'
import * as nodePath from 'node:path'
import * as fsp from 'node:fs/promises'

/** 执行者子 agent 的结构化回传 schema。 */
export const EXECUTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    done: { type: 'boolean' },
  },
  required: ['summary'],
  additionalProperties: true,
}

interface RunningDispatch {
  taskId: string
  batchId?: string
  childId: string
  worktree?: string
  startedAt: string
}

const running = new Map<string, RunningDispatch>()

/** 是否正在派发中。 */
export function dispatchBusy(): boolean {
  return running.size > 0
}

/** 安装 dispatch（register flow_dispatch_next）。 */
export function installDispatch(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools || typeof tools.register !== 'function') return
    const tool = defineHostTool({
      name: 'flow_dispatch_next',
      description:
        'S4 派发模式：按执行图派发下一批任务。顺序批次启动 1 个执行者子 agent，并行批次最多 N 个（各自 worktree）；立即返回本次启动清单。子 agent 结束后插件自动跑任务门/审查/集成检查点，并用完成通知返回摘要。',
      parameters: {},
      execute: async () => {
        const engine = runtime.engine()
        if (!engine) return fail('FlowGate 引擎未就绪', '确认项目已 /flow init；运行 /flow doctor 诊断')
        if (dispatchBusy()) return fail('上一批任务还在运行', '等当前批次结束（会收到完成通知）后再调用 flow_dispatch_next')
        const capability = reviewCapability(runtime)
        if (!capability.available || !capability.provider) {
          return fail('宿主不支持派发子 agent', `原因：${capability.reason ?? '未知'}。可把 config.dispatch 改为 inline，用 flow_task_start 逐个执行。`, {
            validValues: { dispatch: ['inline', 'auto', 'subagent'] },
          })
        }
        const outcome = await engine.dispatchNext()
        runtime.emit()
        if (outcome.dispatched.length === 0) {
          return ok(outcome.message, { dispatched: [], batchId: outcome.batchId, mode: outcome.mode })
        }
        const lines = [outcome.message]
        for (const envelope of outcome.dispatched) {
          const started = await startExecutor(runtime, engine, envelope, capability.provider)
          if (!started.ok) {
            lines.push(`✗ ${envelope.taskId} 启动失败：${started.message}`)
            try {
              await engine.taskFailed(envelope.taskId, started.message)
            } catch {
              // 忽略记账失败。
            }
            continue
          }
          lines.push(`✓ ${envelope.taskId} ${envelope.task.title}（${envelope.mode}${started.worktree ? `，worktree=${started.worktree}` : ''}）`)
        }
        lines.push('任务结束后会收到完成通知（摘要、任务门、集成检查点结果）；收到后再调用 flow_dispatch_next。')
        runtime.emit()
        return ok(lines.join('\n'), {
          dispatched: outcome.dispatched.map((envelope) => ({
            taskId: envelope.taskId,
            title: envelope.task.title,
            batch: envelope.batch,
            mode: envelope.mode,
            worktree: envelope.worktree,
          })),
          batchId: outcome.batchId,
          mode: outcome.mode,
        })
      },
    })
    const dispose = tools.register(tool)
    if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    runtime.noteFeature('dispatch', '已注册 flow_dispatch_next')
  })
}

/** 启动一个任务的执行者子 agent（成功立即返回，完成结算在后台）。 */
async function startExecutor(
  runtime: HostRuntime,
  engine: EngineLike,
  envelope: DispatchTaskEnvelope,
  provider: string,
): Promise<{ ok: boolean; message: string; worktree?: string; childId?: string }> {
  const parent = runtime.mainAgent()
  if (!parent) return { ok: false, message: '主会话未绑定' }
  const subagents = runtime.getService<DshSubagentRuntime>('subagents')
  if (!subagents) return { ok: false, message: '子 agent 服务不可用' }
  const change = engine.currentChange()
  if (!change) return { ok: false, message: '没有进行中的变更' }

  // 1) 并行批次：建 worktree + 准备命令。
  let cwd = runtime.root() ?? process.cwd()
  let worktree: string | undefined
  if (envelope.mode === 'parallel') {
    try {
      const created = await prepareWorktree(runtime, engine, envelope)
      cwd = created.absolute
      worktree = created.repoRelative
    } catch (error) {
      runtime.noteFeature('dispatch', `worktree 创建失败，批次降级为顺序执行：${toAgentError(error).error}`)
      // 降级：仍在主工作区执行（H21 不成立时的文档行为）。
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30 * 60_000)
  timer.unref?.()
  let activation: Awaited<ReturnType<DshSubagentRuntime['startActivation']>> | null = null
  try {
    activation = await subagents.startActivation({
      provider,
      label: `flowgate-exec-${envelope.taskId}`,
      request: {
        parent,
        agentPreset: FLOWGATE_PRESETS.executor,
        prompt: buildExecutorPrompt(envelope, worktree),
        outputSchema: EXECUTOR_OUTPUT_SCHEMA,
        cwd,
        signal: controller.signal,
        maxDepth: 1,
      },
      signal: controller.signal,
      delivery: 'caller',
    })
  } catch (error) {
    clearTimeout(timer)
    return { ok: false, message: `startActivation 失败：${toAgentError(error).error}` }
  }
  const childId = String(activation.childId)
  runtime.registerAgentRole(childId, 'executor', { changeId: change.id, taskId: envelope.taskId, ...(worktree ? { worktree } : {}) }, worktree)
  running.set(envelope.taskId, { taskId: envelope.taskId, ...(envelope.batch ? { batchId: envelope.batch } : {}), childId, startedAt: runtime.isoNow(), ...(worktree ? { worktree } : {}) })
  if (worktree) {
    try {
      await engine.setTaskWorktree(envelope.taskId, worktree, childId)
    } catch (error) {
      runtime.noteFeature('dispatch', `worktree 记账失败：${toAgentError(error).error}`)
    }
  }
  runtime.registerAgentRole(childId, 'executor', { changeId: change.id, taskId: envelope.taskId, ...(worktree ? { worktree } : {}) }, worktree)

  // 2) 后台等待结算 → 任务门/审查/集成检查点 → 通知主会话。
  void (async () => {
    let result: Awaited<typeof activation.result> | null = null
    try {
      result = await activation.result
    } catch (error) {
      await finalizeTask(runtime, engine, envelope, null, `子 agent 失败：${toAgentError(error).error}`, worktree)
      return
    } finally {
      clearTimeout(timer)
      try {
        await activation.dispose()
      } catch {
        // 忽略。
      }
    }
    const summary = parseExecutorSummary(result?.structured)
    await finalizeTask(runtime, engine, envelope, result, summary, worktree)
  })()

  return { ok: true, message: '已启动', ...(worktree ? { worktree } : {}), childId }
}

function buildExecutorPrompt(envelope: DispatchTaskEnvelope, worktree?: string): { type: 'text'; text: string }[] {
  const task = envelope.task
  const lines: string[] = [
    '你是 FlowGate 的执行者子 agent。你只负责这一个任务，完成后用结构化输出回传摘要。',
    '',
    `任务：${task.id} ${task.title}（批次 ${envelope.batch}，${envelope.mode}）`,
    `允许改动的范围：${[...task.scope, ...task.newFiles].join('、') || '（任务卡未声明，禁止改文件，先结束并回传问题）'}`,
    task.tests.length > 0 ? `测试文件：${task.tests.join('、')}` : '',
    task.changes.length > 0 ? `删除/重命名：${task.changes.map((change) => `${change.path}${change.to ? `→${change.to}` : ''}`).join('、')}` : '',
    `TDD：${envelope.tdd ? '必须（先写失败测试并运行到 RED，再实现到 GREEN）' : '可选'}`,
    `验证组：${envelope.verifyGroups.map((group) => `${group.group} = ${group.command}`).join('；') || '（无）'}`,
    '',
    '纪律：',
    '- 只改任务范围内文件；越界会被守卫拒绝并记违规。',
    '- 用 flow_verify 让插件执行验证命令；不要自己编造测试结果。',
    '- 不能委派、不能提问（ask_user_question 不可用）；遇到需要人决定的事写进 questions。',
    '- 完成前必须让任务卡的全部验证组产生 GREEN 回执，然后调用 flow_task_done。',
    worktree ? `- 工作目录是独立 worktree：${worktree}（不要改主工作区）` : '',
    '',
    envelope.contextExcerpt ? `上下文片段：\n${envelope.contextExcerpt}` : '',
    '',
    '任务卡：',
    task.body,
    '',
    '最后必须回传结构化摘要：summary（做了什么）、filesChanged、evidenceIds、remaining（遗留）、questions（需要负责人决定的问题）。',
  ].filter((line) => line !== '')
  return [{ type: 'text', text: lines.join('\n') }]
}

interface ExecutorSummary {
  summary: string
  filesChanged: string[]
  evidenceIds: string[]
  remaining: string[]
  questions: string[]
  done: boolean
}

function parseExecutorSummary(structured: unknown): ExecutorSummary {
  if (structured === null || typeof structured !== 'object') {
    return { summary: '（执行者没有回传结构化摘要）', filesChanged: [], evidenceIds: [], remaining: [], questions: [], done: false }
  }
  const record = structured as Record<string, unknown>
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  return {
    summary: typeof record.summary === 'string' ? record.summary : '（摘要为空）',
    filesChanged: strings(record.filesChanged),
    evidenceIds: strings(record.evidenceIds),
    remaining: strings(record.remaining),
    questions: strings(record.questions),
    done: record.done === true,
  }
}

/** 子 agent 结算后的收尾：审查 → 任务门 → 记账 → 完成通知；批次完成时做集成检查点。 */
async function finalizeTask(
  runtime: HostRuntime,
  engine: EngineLike,
  envelope: DispatchTaskEnvelope,
  result: Awaited<ReturnType<DshSubagentRuntime['startActivation']>>['result'] extends Promise<infer R> ? R | null : never,
  summary: ExecutorSummary | string,
  worktree?: string,
): Promise<void> {
  running.delete(envelope.taskId)
  const parsed: ExecutorSummary =
    typeof summary === 'string'
      ? { summary, filesChanged: [], evidenceIds: [], remaining: [], questions: [], done: false }
      : summary
  const lines: string[] = [`[FlowGate] 任务 ${envelope.taskId} 的子 agent 已结束。`, `摘要：${parsed.summary}`]
  if (parsed.filesChanged.length > 0) lines.push(`改动文件：${parsed.filesChanged.join('、')}`)
  if (parsed.evidenceIds.length > 0) lines.push(`证据：${parsed.evidenceIds.join('、')}`)
  if (parsed.remaining.length > 0) lines.push(`遗留：${parsed.remaining.join('；')}`)
  if (parsed.questions.length > 0) lines.push(`需要负责人决定：${parsed.questions.join('；')}`)
  const failed = typeof summary === 'string' || result === null || result.stopReason !== 'completed'
  try {
    if (failed) {
      await engine.taskFailed(envelope.taskId, typeof summary === 'string' ? summary : `子 agent 停止原因：${result?.stopReason ?? '未知'}`)
      lines.push('任务已标记失败，等待负责人处理（/flow 查看待处理项）。')
    } else {
      // 审查（普通任务 1 轮；审查失败不消耗轮次）。
      try {
        const capability = reviewCapability(runtime)
        if (capability.available && engine.getConfig().review.enabled) {
          const review = await runTaskReview(runtime, envelope.taskId)
          lines.push(`审查：${review.message}`)
        }
      } catch (error) {
        lines.push(`审查执行异常：${toAgentError(error).error}`)
      }
      const outcome = await engine.taskDone(envelope.taskId)
      lines.push(outcome.message)
      for (const failure of outcome.failures) lines.push(`✗ ${failure.label}：${failure.hint ?? ''}`)
      if (!outcome.passed) lines.push(`任务门未通过；负责人可运行 /flow 查看，或让执行者继续修复（重新 flow_dispatch_next）。`)
    }
  } catch (error) {
    lines.push(`任务门执行异常：${toAgentError(error).error}`)
    try {
      await engine.taskFailed(envelope.taskId, toAgentError(error).error)
    } catch {
      // 忽略。
    }
  }
  runtime.emit()
  // 批次集成检查点（仅并行批次；顺序批次由 engine.dispatchNext 自己推进）。
  if (envelope.mode === 'parallel' && envelope.batch) {
    await maybeCheckpoint(runtime, engine, envelope.batch)
  }
  // 通知主会话（delivery:'caller' 不会自动通知；用 inject 不唤醒）。
  const target = runtime.mainAgent()
  if (target) {
    try {
      await target.inject({ content: [{ type: 'text', text: lines.join('\n') }], source: { kind: 'runtime-context', form: 'relay' } })
    } catch {
      // 忽略通知失败。
    }
  }
}

/** 并行批次全部任务结束后做集成检查点（合并 worktree 分支 + integration 命令）。 */
async function maybeCheckpoint(runtime: HostRuntime, engine: EngineLike, batchId: string): Promise<void> {
  try {
    const snapshot = engine.snapshot()
    const batch = snapshot.batches.find((item) => item.id === batchId)
    if (!batch) return
    const change = engine.currentChange()
    if (!change) return
    const notDone = batch.tasks.filter((taskId) => change.tasks[taskId]?.status !== 'done' && change.tasks[taskId]?.status !== 'skipped')
    if (notDone.length > 0) return
    const root = runtime.root()
    const ports = runtime.ports()
    if (!root || !ports) return
    // 1) 合并各任务分支回变更分支（当前 root 所在分支）。
    const failures: string[] = []
    for (const taskId of batch.tasks) {
      const task = change.tasks[taskId]
      const branch = `flowgate/${change.id}/${taskId}`
      if (!task?.worktree) continue
      const branchExists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
      if (branchExists.exitCode !== 0) continue
      const merge = await runGit(['merge', '--no-ff', '--no-edit', branch], root, 120_000)
      if (merge.exitCode !== 0) {
        failures.push(`合并 ${taskId} 冲突：${merge.stderr.trim().slice(0, 300)}`)
        await runGit(['merge', '--abort'], root)
        break
      }
    }
    // 2) 集成命令（config.commands.integration）。
    const integration = engine.getConfig().commands.integration
    if (failures.length === 0 && integration && integration !== 'none' && ports.commandRunner) {
      const result = await ports.commandRunner.run(integration, { cwd: root, timeoutMs: 20 * 60_000 })
      if (result.exitCode !== 0 || result.timedOut) {
        failures.push(`集成命令失败（${integration}，exit=${result.exitCode}）：${(result.stderr || result.stdout).trim().slice(0, 500)}`)
      }
    }
    if (failures.length > 0) {
      await engine.completeCheckpoint(batchId, { ok: false, detail: failures.join('；') })
      runtime.noteFeature('dispatch', `批次 ${batchId} 集成检查点失败：${failures.join('；')}`)
      return
    }
    await engine.completeCheckpoint(batchId, { ok: true })
    runtime.noteFeature('dispatch', `批次 ${batchId} 集成检查点通过`)
    // 3) 清理 worktree（失败保留便于排查；成功才删）。
    for (const taskId of batch.tasks) {
      const task = change.tasks[taskId]
      if (!task?.worktree) continue
      const absolute = runtime.absolute(task.worktree)
      const removed = await runGit(['worktree', 'remove', '--force', absolute], root, 60_000)
      if (removed.exitCode === 0) {
        await runGit(['branch', '-D', `flowgate/${change.id}/${taskId}`], root, 30_000)
      }
    }
    runtime.emit()
  } catch (error) {
    runtime.noteFeature('dispatch', `集成检查点异常：${toAgentError(error).error}`)
    try {
      await engine.completeCheckpoint(batchId, { ok: false, detail: toAgentError(error).error })
    } catch {
      // 忽略。
    }
  }
}

/** 建 worktree（`.flowgate/worktrees/<变更>/<任务>/`，分支 `flowgate/<变更>/<任务>`）。 */
async function prepareWorktree(
  runtime: HostRuntime,
  engine: EngineLike,
  envelope: DispatchTaskEnvelope,
): Promise<{ absolute: string; repoRelative: string }> {
  const root = runtime.root()
  if (!root) throw new HostError('项目根未解析', '运行 /flow doctor')
  const change = engine.currentChange()
  if (!change) throw new HostError('没有进行中的变更', '运行 /flow')
  const relative = normalizeSlashes(`.flowgate/worktrees/${change.id}/${envelope.taskId}`)
  const absolute = nodePath.resolve(root, relative)
  await fsp.mkdir(nodePath.dirname(absolute), { recursive: true })
  const branch = `flowgate/${change.id}/${envelope.taskId}`
  const base = change.branch ?? (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim()
  const add = await runGit(['worktree', 'add', '-b', branch, absolute, base || 'HEAD'], root, 120_000)
  if (add.exitCode !== 0) {
    // 分支/worktree 已存在时尝试复用。
    const reuse = await runGit(['worktree', 'add', absolute, branch], root, 120_000)
    if (reuse.exitCode !== 0) {
      throw new HostError(`git worktree add 失败：${add.stderr.trim().slice(0, 300)}`, '确认 git 版本支持 worktree、磁盘有空间；或把配置改为顺序执行')
    }
  }
  // 准备命令（如 pnpm install --frozen-lockfile）。
  const setup = engine.getConfig().parallel.setup
  if (setup && setup.trim() !== '') {
    const runner = runtime.ports()?.commandRunner
    if (runner) {
      const result = await runner.run(setup, { cwd: absolute, timeoutMs: 15 * 60_000 })
      if (result.exitCode !== 0 || result.timedOut) {
        throw new HostError(`worktree 准备命令失败（${setup}）：${(result.stderr || result.stdout).trim().slice(0, 300)}`, '修复准备命令或把批次改为顺序执行')
      }
    }
  }
  return { absolute, repoRelative: relative }
}

/** 当前运行中的派发明细（doctor 用）。 */
export function runningDispatches(): RunningDispatch[] {
  return [...running.values()]
}
