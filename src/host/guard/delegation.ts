/**
 * 受管控会话里关闭 DSH 原生委派 + 强制原生工具模式（03 §2.4 / H26）。
 *
 * 两个动作都是 **agent 作用域** 的（rc.5 明确：`restrict` 与 `presentAs` 只在
 * scoped ctx 上生效，见 docs/impl/dsh-plugin-api-cheatsheet.md §10-6/§10-7）：
 * - `agent.ctx.tools.restrict({ deny })`：把 subagent/subagent_fork/workflow/
 *   send_message/run_code 等原生委派工具从该 agent 的可见集合拿掉（只过滤继承的
 *   全局工具；FlowGate 自己注册的 flow_* 不受影响）；
 * - `agent.ctx.tools.presentAs('native')`：强制原生 Function Calling，避免 PTC
 *   的 run_code 嵌套调用绕过守卫。
 *
 * 失败降级：restrict/presentAs 缺失或抛错时只记 doctor 说明；守卫（guard/index.ts）
 * 仍会在调用时拒绝原生委派（R-DELEGATE），因此"关不掉"不等于"能绕过"。
 */
import type { DshAgent, DshContext, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import { toAgentError } from '../errors.js'

/** 随插件提供的三个 agent preset id（cordis.patch.yml 中声明；待实测）。 */
export const FLOWGATE_PRESETS = {
  engineering: 'flowgate',
  executor: 'flowgate-executor',
  reviewer: 'flowgate-reviewer',
} as const

export interface DelegationClosure {
  restricted: boolean
  presentAsNative: boolean
  denied: string[]
  reason?: string
}

const closures = new WeakMap<object, DelegationClosure>()

/** 查询某个 agent 的委派关闭结果（doctor 用）。 */
export function delegationClosureOf(agent: DshAgent): DelegationClosure | undefined {
  return closures.get(agent as unknown as object)
}

/** 安装原生委派关闭策略。 */
export function installDelegation(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools) return
    // agent/created：每个 agent（主会话 + FlowGate 派发的子 agent）创建后立刻收紧。
    runtime.onScoped(scoped, 'agent/created', (payload: { agent?: DshAgent }) => {
      const agent = payload?.agent
      if (!agent) return
      void applyDelegationPolicy(runtime, agent).catch((error: unknown) => {
        runtime.markInert('原生委派关闭', error, '关闭原生委派失败；守卫仍会拒绝原生委派工具。')
      })
    })
  })
}

/** 对单个 agent 应用 restrict + presentAs（可重复调用，结果记录在 WeakMap）。 */
export async function applyDelegationPolicy(runtime: HostRuntime, agent: DshAgent): Promise<DelegationClosure | undefined> {
  if (!runtime.isEnabled()) return undefined
  // 主会话的引擎可能仍在异步初始化：等它就绪再判断是否受管。
  let engine = runtime.engine()
  if (!engine) {
    engine = await runtime.ensureEngine(agent)
  }
  if (!engine) return undefined
  let managed = false
  try {
    managed = engine.isInitialized()
  } catch {
    managed = false
  }
  if (!managed) return undefined

  const agentTools = (agent.ctx?.get('tools') as DshToolRuntime | null) ?? null
  const closure: DelegationClosure = { restricted: false, presentAsNative: false, denied: [] }
  if (!agentTools) {
    closure.reason = 'agent 作用域没有 tools 服务'
    closures.set(agent as unknown as object, closure)
    runtime.noteFeature('delegation', `无法关闭 ${String(agent.id)} 的原生委派：${closure.reason}`)
    return closure
  }

  // 1) presentAs('native')：失败不影响 restrict。
  if (typeof agentTools.presentAs === 'function') {
    runtime.safe('presentAs(native)', () => {
      const dispose = agentTools.presentAs?.('native')
      if (typeof dispose === 'function') runtime.registerDisposer(dispose)
      closure.presentAsNative = true
    })
  }
  if (!closure.presentAsNative) {
    runtime.noteFeature('delegation', '当前宿主没有可用的 tools.presentAs，PTC 模式无法强制关闭（守卫仍生效）')
  }

  // 2) restrict({ deny })：只 deny 真实存在的全局工具名，否则 rc.5 会直接抛错。
  if (typeof agentTools.restrict === 'function') {
    try {
      const known = new Set((agentTools.schemas?.() ?? []).map((schema) => schema.name))
      const candidates = runtime.deps.core.blockedDelegationTools()
      const deny = candidates.filter((name) => known.has(name))
      if (deny.length > 0) {
        const dispose = agentTools.restrict({ deny })
        if (typeof dispose === 'function') runtime.registerDisposer(dispose)
        closure.restricted = true
        closure.denied = deny
      } else {
        closure.reason = '原生委派工具当前不可见（可能已被其他插件关闭）'
      }
    } catch (error) {
      closure.reason = toAgentError(error).error
      runtime.markInert('原生委派关闭', error, '关闭原生委派失败；守卫仍会拒绝原生委派工具（R-DELEGATE）。')
    }
  } else {
    closure.reason = '宿主 tools 服务没有 restrict 方法'
  }

  closures.set(agent as unknown as object, closure)
  if (closure.restricted) {
    runtime.noteFeature('delegation', `已关闭 ${String(agent.id)} 的原生委派工具：${closure.denied.join('、')}`)
  } else if (closure.reason) {
    runtime.noteFeature('delegation', `未能关闭 ${String(agent.id)} 的原生委派：${closure.reason}`)
  }
  return closure
}
