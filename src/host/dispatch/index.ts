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
import { reviewCapability, runTaskReview, taskReviewRounds } from '../review/index.js'
import { runGit } from '../adapters/node-git.js'
import { normalizeSlashes } from '../adapters/windows-path.js'
import {
  blockingPendingItems,
  consumeUnnotifiedOwnerPending,
  openOwnerPending,
  pendingHint,
  pendingLines,
  pendingView,
  resetPendingNotificationForTest,
} from './pending.js'
import {
  checkInterruptedRedispatch,
  recordDispatchedChild,
  recordReleasedChild,
  resetRedispatchStateForTest,
} from './redispatch.js'
import * as nodePath from 'node:path'
import * as fsp from 'node:fs/promises'

export {
  blockingPendingItems,
  consumeUnnotifiedOwnerPending,
  openOwnerPending,
  OWNER_PENDING_KINDS,
  BLOCKING_PENDING_KINDS,
  pendingHint,
  pendingView,
} from './pending.js'
export { checkInterruptedRedispatch, DISPATCH_SAFETY_CATEGORY, recordDispatchedChild, recordReleasedChild } from './redispatch.js'

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

/**
 * 测试用：清空模块级运行表。
 * `running` 是模块级状态，跨用例残留会让后续派发被误判为"上一批还在运行"；
 * 单测在 beforeEach 调用它，保证用例隔离（真实运行时由子 agent 结算清理）。
 */
export function resetDispatchStateForTest(): void {
  running.clear()
  checkpointInFlight.clear()
  resetPendingNotificationForTest()
  resetRedispatchStateForTest()
}

/**
 * 并行任务的 worktree 分支名。
 *
 * 注意：不能用 `flowgate/<changeId>/<taskId>`——变更分支本身是 `flowgate/<changeId>`，
 * git 的 ref 目录不允许 D/F 冲突（不能同时存在 refs/heads/flowgate/C-001 与
 * refs/heads/flowgate/C-001/T1），否则 worktree add 直接失败并静默降级为主工作区
 * （2026-10-31 真机发现）。因此任务分支放在兄弟命名空间 `flowgate-tasks/` 下。
 */
export function taskWorktreeBranch(changeId: string, taskId: string): string {
  return `flowgate-tasks/${changeId}/${taskId}`
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
        // 子 agent 能力不在这里提前失败：队列里可能只有 run:main 任务（不需要子 agent），
        // 等 dispatchNext 返回后再按"是否真的有 dispatched 任务"决定。
        // 派发前复核（T4.6）：中断任务必须确认旧子 agent 已停止/资源已释放；
        // scope/plan/risk 待处理项未审批时不能静默开始新任务。
        const redispatch = await checkInterruptedRedispatch(runtime, engine)
        if (!redispatch.ok) {
          return fail(redispatch.message ?? '不能重新派发中断任务', redispatch.hint ?? '先处理待处理项后再派发', {
            pending: pendingView(redispatch.pending),
            tasks: redispatch.problems,
          })
        }
        const blocking = blockingPendingItems(engine)
        if (blocking.length > 0) {
          return fail(
            `有 ${blocking.length} 个未审批的待处理项，不能继续派发`,
            `先处理：${blocking.map((item) => `${item.id} ${item.title}（处理：${pendingHint(item)}）`).join('；')}`,
            { pending: pendingView(blocking) },
          )
        }
        const outcome = await engine.dispatchNext()
        runtime.emit()
        if (outcome.blocked) {
          return fail(outcome.message, pendingHint(outcome.blocked), {
            pending: pendingView([outcome.blocked]),
            batchId: outcome.batchId,
          })
        }
        const provider = capability.available ? capability.provider : undefined
        if (outcome.dispatched.length > 0 && !provider) {
          // 已经 core 侧标记 running 的任务要回滚为失败，避免挂起。
          for (const envelope of outcome.dispatched) {
            try {
              await engine.taskFailed(envelope.taskId, `宿主不支持派发子 agent：${capability.reason ?? '未知'}`)
            } catch {
              // 忽略记账失败。
            }
          }
          return fail('宿主不支持派发子 agent', `原因：${capability.reason ?? '未知'}。可把 config.dispatch 改为 inline，用 flow_task_start 逐个执行。`, {
            validValues: { dispatch: ['inline', 'auto', 'subagent'] },
          })
        }
        // A batch whose integration checkpoint failed (or whose repair batch just
        // finished) is retried here; this is the model-reachable recovery path
        // (P0-3). The engine never asks the model to call host-internal APIs.
        if (outcome.retryCheckpoint) {
          const retried = await runIntegrationCheckpoint(runtime, engine, outcome.retryCheckpoint.batchId)
          runtime.emit()
          const lines = [outcome.message]
          if (retried) {
            lines.push(
              retried.ok
                ? `集成检查点：批次 ${retried.batchId} 通过（worktree 已合并并清理）。`
                : `集成检查点：批次 ${retried.batchId} 失败 —— ${retried.detail ?? '原因未知'}。worktree 已保留便于排查；修复后再次调用 flow_dispatch_next 重试。`,
            )
          } else {
            lines.push('集成检查点暂时无法执行（批次任务未全部完成或环境缺失）；处理后再调用 flow_dispatch_next。')
          }
          return retried?.ok
            ? ok(lines.join('\n'), { batchId: retried.batchId, checkpoint: 'passed', retried: outcome.retryCheckpoint })
            : fail(
                lines.join('\n'),
                '检查点未通过：修复失败/冲突后再次调用 flow_dispatch_next 重试检查点',
                { batchId: outcome.retryCheckpoint.batchId, retryCheckpoint: outcome.retryCheckpoint },
              )
        }
        const pendingNow = pendingView(openOwnerPending(engine))
        const pendingData = pendingNow.length > 0 ? { pending: pendingNow } : {}
        // `run: main` tasks: the main session claims them via flow_task_start;
        // the host must not start an executor subagent for them.
        const mainTasks = outcome.mainTasks ?? []
        const mainTaskData = mainTasks.length > 0 ? { mainTasks } : {}
        const mainTaskLines =
          mainTasks.length > 0
            ? [`主会话任务（run: main）：${mainTasks.map((item) => `${item.taskId} → flow_task_start("${item.taskId}")`).join('、')}；完成后调用 flow_dispatch_next。`]
            : []
        if (outcome.dispatched.length === 0) {
          const emptyLines = [outcome.message, ...mainTaskLines]
          const knownPending = pendingLines(openOwnerPending(engine))
          if (knownPending.length > 0) emptyLines.push('', ...knownPending)
          return ok(emptyLines.join('\n'), { dispatched: [], batchId: outcome.batchId, mode: outcome.mode, ...mainTaskData, ...pendingData })
        }
        const lines = [outcome.message]
        // 结构化 data 必须回填 startExecutor 实际创建的 worktree：envelope 是派发前的
        // 快照，并行批次在 startExecutor 里才建 worktree，此时 envelope.worktree 为空。
        const dispatchedData: Record<string, unknown>[] = []
        for (const envelope of outcome.dispatched) {
          const started = await startExecutor(runtime, engine, envelope, provider as string)
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
          dispatchedData.push({
            taskId: envelope.taskId,
            title: envelope.task.title,
            batch: envelope.batch,
            mode: envelope.mode,
            ...(started.worktree ? { worktree: started.worktree } : {}),
          })
        }
        lines.push('任务结束后会收到完成通知（摘要、任务门、集成检查点结果）；收到后再调用 flow_dispatch_next。')
        if (mainTaskLines.length > 0) lines.push(...mainTaskLines)
        if (pendingNow.length > 0) {
          lines.push(`⚠ 仍有 ${pendingNow.length} 个待处理项需要负责人处理：${pendingNow.map((item) => item.id).join('、')}（/flow status 查看）。`)
        }
        runtime.emit()
        return ok(lines.join('\n'), {
          dispatched: dispatchedData,
          batchId: outcome.batchId,
          mode: outcome.mode,
          ...mainTaskData,
          ...pendingData,
        })
      },
    })
    const dispose = tools.register(tool)
    if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    runtime.noteFeature('dispatch', '已注册 flow_dispatch_next')
  })
}

/**
 * P1-2：并行批次槽位级补位。
 *
 * 一个执行者结算后（成功或失败）槽位立即空出；这里直接调 `dispatchNext` 按执行图
 * 取同批次下一个 queued 任务并启动，不再等主会话下一次 `flow_dispatch_next`。
 * 只处理同批次任务；engine 若错误地返回其它批次任务则回滚为失败，避免任务挂起。
 */
async function refillParallelSlot(
  runtime: HostRuntime,
  engine: EngineLike,
  batchId: string,
  lines: string[],
): Promise<void> {
  const capability = reviewCapability(runtime)
  if (!capability.available || !capability.provider) return
  try {
    const outcome = await engine.dispatchNext()
    for (const envelope of outcome.dispatched) {
      const sameBatch = envelope.batch === batchId && envelope.mode === 'parallel'
      if (!sameBatch) {
        lines.push(`✗ 自动补位跳过 ${envelope.taskId}（非当前批次任务），已回滚为失败`)
        try {
          await engine.taskFailed(envelope.taskId, '并行槽位补位只处理同批次任务')
        } catch {
          // 忽略。
        }
        continue
      }
      const started = await startExecutor(runtime, engine, envelope, capability.provider)
      if (started.ok) {
        lines.push(`自动补位：${envelope.taskId} ${envelope.task.title}（并行批次 ${batchId}）`)
      } else {
        lines.push(`✗ 自动补位 ${envelope.taskId} 启动失败：${started.message}`)
        try {
          await engine.taskFailed(envelope.taskId, started.message)
        } catch {
          // 忽略。
        }
      }
    }
    if (outcome.dispatched.length > 0) runtime.emit()
  } catch (error) {
    runtime.noteFeature('dispatch', `并行槽位补位失败：${toAgentError(error).error}`)
  }
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
  // 记下 taskId → childId，供"中断任务重新派发"时确认旧子 agent 是否已停止
  // （顺序任务没有 worktree，engine 侧不会持久化 agentId）。
  recordDispatchedChild(change.id, envelope.taskId, childId)
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
        recordReleasedChild(childId)
      } catch {
        // 忽略 dispose 失败；此时不能宣称资源已释放，重新派发检查会保持阻塞。
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
      // 审查（按等级轮次要求补齐；高风险 2 轮。审查失败不消耗轮次）。
      try {
        const capability = reviewCapability(runtime)
        if (capability.available && engine.getConfig().review.enabled) {
          const required = taskReviewRounds(engine)
          const passCount = (): number =>
            (engine.currentChange()?.reviews ?? []).filter(
              (review) => review.taskId === envelope.taskId && review.verdict === 'pass' && review.coverageOk,
            ).length
          const messages: string[] = []
          for (let round = passCount(); round < required; round += 1) {
            const review = await runTaskReview(runtime, envelope.taskId)
            messages.push(review.message)
            if (!review.ok) break
          }
          if (messages.length > 0) lines.push(`审查：${messages.join('；')}`)
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
  // P1-2：并行批次槽位释放后立即按执行图自动补位（不等主会话再调用 dispatch）。
  if (envelope.mode === 'parallel' && envelope.batch) {
    await refillParallelSlot(runtime, engine, envelope.batch, lines)
  }
  runtime.emit()
  // 批次集成检查点（仅并行批次；顺序批次由 engine.dispatchNext 自己推进）。
  const checkpoint = envelope.mode === 'parallel' && envelope.batch ? await runIntegrationCheckpoint(runtime, engine, envelope.batch) : null
  if (checkpoint) {
    lines.push(
      checkpoint.ok
        ? `集成检查点：批次 ${checkpoint.batchId} 通过（worktree 已合并并清理）。`
        : `集成检查点：批次 ${checkpoint.batchId} 失败 —— ${checkpoint.detail ?? '原因未知'}。worktree 已保留便于排查；处理待处理项后重新派发。`,
    )
  }
  // T4.6：子 agent 越界会生成 scope 等待处理项；结算后必须让主会话/负责人看到
  // （同一项只通知一次，避免并行批次多任务结算时重复刷屏）。
  const unnotifiedPending = consumeUnnotifiedOwnerPending(engine)
  if (unnotifiedPending.length > 0) {
    lines.push('', ...pendingLines(unnotifiedPending))
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

/** 集成检查点结果（宿主侧）。 */
export interface CheckpointOutcome {
  batchId: string
  ok: boolean
  detail?: string
}

/**
 * 同一批次的检查点并发去重。
 *
 * 并行批次各子 agent 的结算回调是独立的：两个子 agent 几乎同时结束时会都看到
 * "全部任务已完成"并发跑合并/集成命令/completeCheckpoint（会双 merge、双扣费、
 * failure/success 交错导致状态机错乱）。这里用 in-flight promise 串行化同批次。
 */
const checkpointInFlight = new Map<string, Promise<CheckpointOutcome | null>>()

/** 并行批次全部任务结束后做集成检查点（合并 worktree 分支 + integration 命令）。导出供单测。 */
export function runIntegrationCheckpoint(
  runtime: HostRuntime,
  engine: EngineLike,
  batchId: string,
): Promise<CheckpointOutcome | null> {
  const existing = checkpointInFlight.get(batchId)
  if (existing) return existing
  const task = runIntegrationCheckpointInner(runtime, engine, batchId).finally(() => {
    checkpointInFlight.delete(batchId)
  })
  checkpointInFlight.set(batchId, task)
  return task
}

async function runIntegrationCheckpointInner(
  runtime: HostRuntime,
  engine: EngineLike,
  batchId: string,
): Promise<CheckpointOutcome | null> {
  try {
    const snapshot = engine.snapshot()
    const batch = snapshot.batches.find((item) => item.id === batchId)
    if (!batch) return null
    const change = engine.currentChange()
    if (!change) return null
    const notDone = batch.tasks.filter((taskId) => change.tasks[taskId]?.status !== 'done' && change.tasks[taskId]?.status !== 'skipped')
    if (notDone.length > 0) return null
    const root = runtime.root()
    const ports = runtime.ports()
    if (!root || !ports) return null
    // 1) 合并各任务分支回变更分支（当前 root 所在分支）。
    const failures: string[] = []
    let failureKind: 'merge' | 'integration' | 'unknown' = 'unknown'
    let failureOutput = ''
    let failureCommand = ''
    for (const taskId of batch.tasks) {
      const task = change.tasks[taskId]
      const branch = taskWorktreeBranch(change.id, taskId)
      if (!task?.worktree) continue
      const branchExists = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)
      if (branchExists.exitCode !== 0) continue
      const merge = await runGit(['merge', '--no-ff', '--no-edit', branch], root, 120_000)
      if (merge.exitCode !== 0) {
        failures.push(`合并 ${taskId} 冲突：${merge.stderr.trim().slice(0, 300)}`)
        failureKind = 'merge'
        await runGit(['merge', '--abort'], root)
        break
      }
    }
    // 2) 集成命令（config.commands.integration）。
    const integration = engine.getConfig().commands.integration
    if (failures.length === 0 && integration && integration !== 'none' && ports.commandRunner) {
      const result = await ports.commandRunner.run(integration, { cwd: root, timeoutMs: 20 * 60_000 })
      if (result.exitCode !== 0 || result.timedOut) {
        failureKind = 'integration'
        failureCommand = integration
        failureOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
        failures.push(`集成命令失败（${integration}，exit=${result.exitCode}）：${(result.stderr || result.stdout).trim().slice(0, 500)}`)
      }
    }
    if (failures.length > 0) {
      const detail = failures.join('；')
      await engine.completeCheckpoint(batchId, {
        ok: false,
        detail,
        kind: failureKind,
        command: failureCommand,
        output: failureOutput.slice(0, 20_000),
      })
      runtime.noteFeature('dispatch', `批次 ${batchId} 集成检查点失败：${detail}`)
      return { batchId, ok: false, detail }
    }
    await engine.completeCheckpoint(batchId, { ok: true })
    runtime.noteFeature('dispatch', `批次 ${batchId} 集成检查点通过`)
    // 3) 清理 worktree（失败保留便于排查；成功才删）。
    for (const taskId of batch.tasks) {
      const task = change.tasks[taskId]
      if (!task?.worktree) continue
      const absolute = runtime.absolute(task.worktree)
      const removed = await runGit(['worktree', 'remove', '--force', absolute], root, 60_000)
      if (removed.exitCode !== 0) {
        // 保留 worktree 对应的分支（可能仍被占用），只记降级说明，不影响检查点结论。
        runtime.noteFeature('dispatch', `worktree 清理失败（${task.worktree}）：${removed.stderr.trim().slice(0, 200)}`)
        continue
      }
      await runGit(['branch', '-D', taskWorktreeBranch(change.id, taskId)], root, 30_000)
    }
    runtime.emit()
    return { batchId, ok: true }
  } catch (error) {
    const detail = toAgentError(error).error
    runtime.noteFeature('dispatch', `集成检查点异常：${detail}`)
    try {
      await engine.completeCheckpoint(batchId, { ok: false, detail })
    } catch {
      // 忽略。
    }
    return { batchId, ok: false, detail }
  }
}

/** 建 worktree（`.flowgate/worktrees/<变更>/<任务>/`，分支见 taskWorktreeBranch）。 */
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
  const branch = taskWorktreeBranch(change.id, envelope.taskId)
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
