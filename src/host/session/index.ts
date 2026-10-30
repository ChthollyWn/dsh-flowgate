/**
 * 会话生命周期（H23）：会话开始附着台账 + 注入交接摘要；会话关闭释放租约。
 *
 * rc.5 事实：`agent/created` 在首步之前触发（setup 已完成），`session/disposed`
 * 在会话销毁时触发。engine.load() 已内置"唯一活动变更自动附着"逻辑
 * （core/engine.ts autoAttach），host 这里只做：
 * 1. 绑定主会话 → 初始化引擎（runtime.bindMainAgent）；
 * 2. 引擎就绪后：若还没附着，尝试 engine.attachSession()（多个活动变更时给出 /flow resume 提示）；
 * 3. 注入交接摘要/系统通知（不唤醒：agent.inject 下一步生效）；
 * 4. 启动租约心跳；会话关闭时 engine.releaseSession()（把 running/review 任务标中断）。
 */
import type { DshAgent, DshContext, DshSession } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { EngineLike } from '../types.js'
import { toAgentError } from '../errors.js'

/** 安装会话生命周期。 */
export function installSession(runtime: HostRuntime): void {
  // agent/created 是全局事件，不需要服务依赖（引擎初始化内部会探测）。
  runtime.on('agent/created', (payload: { agent?: DshAgent; source?: string }) => {
    const agent = payload?.agent
    if (!agent) return
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

/** 引擎就绪后的会话初始化。 */
export async function onEngineReady(runtime: HostRuntime, agent: DshAgent, engine: EngineLike): Promise<void> {
  if (!engine.isInitialized()) {
    runtime.noteFeature('session', '项目未初始化：/flow init 启用（未初始化前不拦截任何操作）')
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
      // 有多个活动变更时明确提示用 /flow resume。
      try {
        await agent.inject({
          content: [
            {
              type: 'text',
              text: `[FlowGate] 项目已启用，但没有自动接续到进行中的变更：${info.error}。下一步：${info.hint}；或 /flow new <描述> 立项。`,
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
    const parts: string[] = [
      `[FlowGate] 已接续变更 ${change.id}「${change.title}」｜阶段 ${change.stage}｜${change.stage === 'S4' ? 'S4 执行' : '按注入的下一步继续'}`,
    ]
    if (change.handoff?.text) parts.push(`交接摘要：${change.handoff.text}`)
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
