/**
 * 会话生命周期（H23）：会话开始附着台账 + 注入交接摘要；会话关闭释放租约。
 *
 * rc.5 事实：`agent/created` 在首步之前触发（setup 已完成），`session/disposed`
 * 在会话销毁时触发。engine.load() 已内置"唯一活动变更自动附着"逻辑
 * （core/engine.ts autoAttach），host 这里只做：
 * 1. 绑定主会话 → 初始化引擎（runtime.bindMainAgent）；
 * 2. 引擎就绪后：若还没附着，尝试 engine.attachSession()（多个活动变更时给出面板接续提示）；
 * 3. 注入交接摘要/系统通知（不唤醒：agent.inject 下一步生效）；
 * 4. 启动租约心跳；会话关闭时 engine.releaseSession()（把 running/review 任务标中断）。
 *
 * H2（跨会话任务卡）：会话关闭时 running/review 任务被标成 `interrupted`；下次会话
 * 启动时如果只找 running/review，就会在第一步"失忆"（不知道要做哪个任务）。因此
 * 任务卡选择按 running/review → 最近 `interruptedAt` 的 interrupted 任务回退，并
 * 说明可用 `flow_task_start` 恢复/继续。
 *
 * H3（压缩后重注入）：宿主以 `agent/created{source:'compact'}` 重建 agent 时上下文
 * 只剩压缩摘要，而引擎与变更都还在（onEngineReady 只在引擎首次就绪时跑）。此时重新
 * 注入交接摘要 + 当前任务卡；与启动注入共用 `buildHandoffParts`，避免两处漂移。
 */
import type { DshAgent, DshContext, DshSession } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { EngineLike } from '../types.js'
import type { ChangeStatus, TaskCard, TaskState } from '../../core/types.js'
import { toAgentError } from '../errors.js'

/** 安装会话生命周期。 */
export function installSession(runtime: HostRuntime): void {
  // agent/created 是全局事件，不需要服务依赖（引擎初始化内部会探测）。
  runtime.on('agent/created', (payload: { agent?: DshAgent; source?: string }) => {
    const agent = payload?.agent
    if (!agent) return
    // H3：只有 source 明确为 'compact' 才做压缩重注入（旧宿主可能不传 source，
    // 绝不猜测；普通 startup/resume/new 会话仍走 bindMainAgent + onEngineReady）。
    if (payload?.source === 'compact') {
      if (runtime.mainAgent() === null) {
        // 异常路径：还没有绑定主会话时先正常绑定，引擎就绪回调会完成一次注入。
        runtime.bindMainAgent(agent)
        return
      }
      void reinjectAfterCompact(runtime, agent)
      return
    }
    runtime.bindMainAgent(agent)
  })

  runtime.on('agent/disposed', (payload: { agent?: DshAgent }) => {
    const agent = payload?.agent
    if (!agent) return
    if (runtime.mainAgent() && String(runtime.mainAgent()?.id) === String(agent.id)) {
      void runtime.handleSessionDisposed(agent.session) 
    }
  })

  runtime.on('session/disposed', (session: DshSession) => {
    if (!session) return
    void runtime.handleSessionDisposed(session)
  })
  // agent/created + agent/disposed 注册成功 = 生命周期事件可用（doctor 用）。
  runtime.capabilities.agents = true

  runtime.registerEngineReadyHook(async (agent, engine) => {
    await onEngineReady(runtime, agent, engine)
  })

  // 会话事件服务出现时标记能力（供 doctor 报告）。
  runtime.injectService('sessions', (scoped: DshContext) => {
    runtime.capabilities.sessions = true
    void scoped
  })
}

// ---------------------------------------------------------------------------
// H2 / H3：交接摘要 + 当前任务卡（启动注入与压缩重注入共用）
// ---------------------------------------------------------------------------

/** 本轮注入选中的任务。 */
export interface InjectedTask {
  task: TaskState
  /** true = 上一会话中断的任务（提示用 flow_task_start 恢复/继续）。 */
  interrupted: boolean
}

/** 中断时间排序键；缺失/不可解析视为最旧，避免坏数据抢到"最近中断"。 */
function interruptedAtMs(task: TaskState): number {
  const parsed = task.interruptedAt === undefined ? Number.NaN : Date.parse(task.interruptedAt)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/**
 * H2：选择本轮注入的任务卡。
 *
 * 优先级：running/review（当前正在执行）→ interruptedAt 最近的 interrupted 任务。
 * 会话关闭时 `engine.releaseSession` 会把 running/review 标成 interrupted，
 * 所以跨会话时通常命中第二档。
 */
export function selectInjectedTask(change: Pick<ChangeStatus, 'tasks'> | null | undefined): InjectedTask | undefined {
  const tasks = Object.values(change?.tasks ?? {})
  const active = tasks.find((task) => task.status === 'running' || task.status === 'review')
  if (active !== undefined) return { task: active, interrupted: false }
  let latest: TaskState | undefined
  for (const task of tasks) {
    if (task.status !== 'interrupted') continue
    if (latest === undefined || interruptedAtMs(task) > interruptedAtMs(latest)) latest = task
  }
  return latest === undefined ? undefined : { task: latest, interrupted: true }
}

/** 读任务卡（任务卡解析失败/引擎异常时返回 undefined，不打断注入主流程）。 */
function taskCardOf(engine: EngineLike, taskId: string): TaskCard | undefined {
  try {
    return engine.getTask(taskId)
  } catch {
    return undefined
  }
}

/**
 * 任务卡注入文本：范围/验证组/TDD/run。
 * 中断任务额外说明"上一会话中断，可用 flow_task_start 恢复/继续"。
 */
export function buildTaskCardLine(engine: EngineLike, selection: InjectedTask): string {
  const { task, interrupted } = selection
  const interruptedAt = task.interruptedAt !== undefined ? `（中断时间 ${task.interruptedAt}）` : ''
  // 语序保证"上一会话中断，可用 flow_task_start"整句连续，便于模型/负责人直接照做。
  const resumeHint = interrupted ? `上一会话中断，可用 flow_task_start("${task.id}") 恢复/继续。${interruptedAt}` : ''
  const card = taskCardOf(engine, task.id)
  if (card === undefined) {
    return `当前任务 ${task.id} 状态 ${task.status}（任务卡解析失败）。${resumeHint}`
  }
  const scope = [...card.scope, ...card.newFiles].join('、') || '—'
  const verify = card.verify.map((group) => `${group.group}=${group.command}`).join('；') || '—'
  const line = `当前任务卡 ${card.id}「${card.title}」：范围 ${scope}；验证组 ${verify}；TDD ${card.tdd}；run ${card.run}。`
  return `${line}${resumeHint}`
}

/**
 * 交接摘要 + 当前任务卡（onEngineReady 与压缩后重注入共用）。
 * 空数组 = 当前变更既没有交接摘要也没有可注入任务。
 */
export function buildHandoffParts(engine: EngineLike, change: ChangeStatus): string[] {
  const parts: string[] = []
  if (change.handoff?.text) parts.push(`交接摘要：${change.handoff.text}`)
  const selection = selectInjectedTask(change)
  if (selection !== undefined) parts.push(buildTaskCardLine(engine, selection))
  return parts
}

/** 子 agent 不接收主会话的交接/任务卡注入。 */
function isChildAgent(agent: DshAgent): boolean {
  const header = agent.session?.header
  if (!header) return false
  return header.origin === 'subagent' || header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0
}

/**
 * H3：上下文压缩后重注入（`agent/created{source:'compact'}`）。
 *
 * 防御姿态：只有宿主显式传 `source:'compact'` 才触发；引擎未就绪、没有进行中的
 * 变更、或既无交接摘要也无任务卡时只记录 noteFeature，不注入空消息、不抛错。
 */
async function reinjectAfterCompact(runtime: HostRuntime, agent: DshAgent): Promise<void> {
  try {
    if (isChildAgent(agent)) return
    // 压缩重建的仍是主会话 agent：登记角色，guard 才能区分主会话与派发子 agent。
    runtime.registerAgentRole(String(agent.id), 'main')
    const engine = runtime.engine()
    if (!engine || !engine.isInitialized()) {
      runtime.noteFeature('session', '上下文压缩后跳过重注入：引擎未就绪')
      return
    }
    const change = engine.currentChange()
    if (!change) {
      runtime.noteFeature('session', '上下文压缩后跳过重注入：没有进行中的变更')
      return
    }
    const parts = buildHandoffParts(engine, change)
    if (parts.length === 0) {
      runtime.noteFeature('session', `上下文压缩后无可重注入内容（${change.id}）`)
      return
    }
    const text = [
      `[FlowGate] 上下文已压缩：重新注入变更 ${change.id} 的交接摘要与当前任务卡（压缩前对话的细节已折叠，以任务卡、验证组与 .flowgate 产物为准）。`,
      ...parts,
    ].join('\n')
    await agent.inject({ content: [{ type: 'text', text }], source: { kind: 'runtime-context', form: 'relay' } })
    runtime.noteFeature('session', `上下文压缩后已重新注入交接摘要/任务卡（${change.id}）`)
  } catch (error) {
    runtime.noteFeature('session', `上下文压缩后重注入失败：${toAgentError(error).error}`)
  }
}

/** 引擎就绪后的会话初始化。 */
export async function onEngineReady(runtime: HostRuntime, agent: DshAgent, engine: EngineLike): Promise<void> {
  if (!engine.isInitialized()) {
    runtime.noteFeature('session', '项目未初始化：等待负责人在授权卡片上启用（未初始化前不拦截任何操作）')
    return
  }
  // 1) 自动附着：engine.load() 已处理唯一活动变更；这里补 attachSession 的兜底与提示。
  if (!engine.currentChange()) {
    try {
      await engine.attachSession()
      runtime.noteFeature('session', '已自动接续活动变更')
    } catch (error) {
      const info = toAgentError(error)
      runtime.noteFeature('session', `未自动接续：${info.error}（${info.hint}）`)
      // 有多个活动变更时明确提示到面板/授权卡片接续。
      try {
        await agent.inject({
          content: [
            {
              type: 'text',
              text: `[FlowGate] 项目已启用，但没有自动接续到进行中的变更：${info.error}。下一步：${info.hint}；或用一句话描述你想做的变更，让 agent 立项。`,
            },
          ],
          source: { kind: 'runtime-context', form: 'relay' },
        })
      } catch {
        // agent 已不可用：忽略。
      }
    }
  }

  // 2) 租约心跳。
  await runtime.sessionStartTimer()

  // 3) 交接摘要/系统通知注入（不唤醒）。
  // 主会话角色无条件登记（H18：guard 用 exec.agent 区分主会话与子 agent）。
  runtime.registerAgentRole(String(agent.id), 'main')
  const change = engine.currentChange()
  if (change) {
    const notices = safeTakeNotices(engine)
    // H2：交接摘要 + 当前任务卡（running/review，或最近中断的 interrupted 任务）。
    const parts: string[] = [
      `[FlowGate] 已接续变更 ${change.id}「${change.title}」｜阶段 ${change.stage}｜${change.stage === 'S4' ? 'S4 执行' : '按注入的下一步继续'}`,
      ...buildHandoffParts(engine, change),
    ]
    if (notices.length > 0) parts.push(`通知：${notices.join('；')}`)
    const text = parts.join('\n')
    try {
      await agent.inject({ content: [{ type: 'text', text }], source: { kind: 'runtime-context', form: 'relay' } })
    } catch (error) {
      runtime.noteFeature('session', `交接摘要注入失败：${toAgentError(error).error}`)
    }
  }

  runtime.emit()
}

function safeTakeNotices(engine: EngineLike): string[] {
  try {
    return engine.takeNotices()
  } catch {
    return []
  }
}
