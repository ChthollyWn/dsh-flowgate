/**
 * FlowGate 最小可加载插件 —— Host 入口（spike，仅用于验证 API 形状，不含产品逻辑）。
 *
 * 入口形态：Cordis 插件对象（具名导出 apply / inject / name，可选 Config schema）。
 * 加载方式：cordis.patch.yml 里 `- insert: [{ id, name: 'dsh-flowgate-spike' }]`。
 *
 * 运行期依赖只有 @deepseek-ai/dsh-tools 的 defineTool（由宿主 profile 的
 * node_modules 提供；tsdown 中必须 external）。
 * 其余 @deepseek-ai/* 只用 `import type`，编译后擦除。
 */
import { defineTool, type ToolGuard } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-flowgate-spike'
/** 不强制依赖任何服务；所有服务都通过 ctx.inject 可选挂载，缺服务时插件仍能激活。 */
export const inject: string[] = []

/** 插件配置（cordis.patch.yml 行里的 `config` 会传进 apply 第二参）。 */
export interface Config {
  /** 受管控项目的标志文件，相对会话 cwd。 */
  markerPath?: string
}

/** 状态占位：spike 只把观测到的东西打印出来，不做判定。 */
interface Observed {
  toolCalls: number
  lastTool?: string
  lastDenied?: string
  preSteps: number
  turnStops: number
  commands: number
}

export function apply(ctx: Context, config: Config = {}) {
  const markerPath = config.markerPath ?? '.flowgate/config.yaml'
  const log = (...args: unknown[]) => ctx.logger?.info?.('[flowgate-spike]', ...args)
  const observed: Observed = { toolCalls: 0, preSteps: 0, turnStops: 0, commands: 0 }
  log('apply() 进入，markerPath =', markerPath, 'cwd =', process.cwd())

  // ── 1. 斜杠命令：只在人类输入框触发，不进模型消息 ──────────────────────
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register({
      name: 'flow',
      description: 'FlowGate 流程门禁（spike 只回显状态）',
      input: { hint: 'init | status | approve <task-id>' },
      handler: ({ rawInput }) => {
        observed.commands += 1
        log('/flow 被调用，rawInput =', JSON.stringify(rawInput))
        return {
          kind: 'success' as const,
          text: [
            'FlowGate spike 命令可用。',
            `参数：${rawInput.trim() || '（空）'}`,
            `已观测：${JSON.stringify(observed)}`,
          ].join('\n'),
        }
      },
    })
  })

  // ── 2. 模型工具：一个只读查询工具 ──────────────────────────────────────
  ctx.inject(['tools'], (ctx) => {
    ctx.tools.register(
      defineTool({
        name: 'flow_status',
        description: 'Return the FlowGate spike status (read-only, demonstration only).',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', required: true },
              markerPath: { type: 'string', required: true },
              observed: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => ({
          enabled: process.cwd() !== undefined,
          markerPath,
          observed: JSON.stringify(observed),
        }),
      }),
    )

    // ── 3. 单调守卫：工具调用前的硬拦截点（H1 探针）───────────────────
    //    exec.name / exec.arguments / exec.agent / exec.callId 都能读到。
    const guard: ToolGuard = (exec) => {
      observed.toolCalls += 1
      observed.lastTool = exec.name
      const args = JSON.stringify(exec.arguments ?? null)
      log(`guard: name=${exec.name} agent=${exec.agent?.id ?? '-'} callId=${exec.callId} args=${args.slice(0, 400)}`)
      // spike 永远放行；产品实现返回字符串即拒绝。
      return undefined
    }
    ctx.tools.guard(guard)

    // 可选：presentAs('native') 强制原生工具（H26）；spike 只演示调用存在。
    const disposeNative = ctx.tools.presentAs('native')
    ctx.effect(() => disposeNative, 'flowgate-spike: presentAs(native)')
  })

  // ── 4. 工具流水线事件：全部能拿到 exec，post-execute 还能改结果 ────────
  //   不能把 ctx.on 的泛型收窄成 any，真实实现按 dsh-tools 的 Events 声明来。
  ctx.on('tools/pre-execute', async (exec, next) => {
    log('[tools/pre-execute]', exec.name)
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    log('[tools/execute]', exec.name, 'isError =', (result as { isError?: boolean }).isError)
    return result
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    log('[tools/post-execute]', exec.name, 'result keys =', Object.keys(result as object))
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    log('[tools/result]', exec.name, JSON.stringify(result).slice(0, 300))
  })

  // ── 5. agent 生命周期事件（H7 / H8 / H23 探针）─────────────────────────
  ctx.on('agent/created', (payload) => {
    log('[agent/created]', payload.agent.id, payload.source)
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    observed.preSteps += 1
    log('[agent/pre-step]', payload.agent.id, 'turn', payload.turn, 'step', payload.step,
      'messages', payload.messages.length)
    // 返回 { kind:'enter', messages:[...] } 可追加消息；spike 保持原样。
    return next()
  })
  ctx.on('agent/turn-stopping', async (payload) => {
    observed.turnStops += 1
    log('[agent/turn-stopping]', payload.agent.id, 'turn', payload.turn)
    // 产品实现：无新鲜证据时 payload.agent.steer(...) 让轮次继续。
  })
  ctx.on('session/disposed', (session) => {
    log('[session/disposed]', session.id)
  })

  // ── 6. 系统提示注入（追加式 section，不改工具面 → 不破坏 KV cache）─────
  ctx.inject(['systemPrompt'], (ctx) => {
    ctx.systemPrompt.section({
      name: 'flowgate:spike',
      order: 9000,
      text: `FlowGate spike 已加载（marker=${markerPath}）。`,
    })
  })

  // ── 7. 会话级插件记录：自定义事件写入会话日志（H6 探针）────────────────
  ctx.inject(['session'], (ctx) => {
    log('[session] service 可用；真实实现用 session.append / appendPluginRecord 落盘')
    ctx.on('session/created', (session) => {
      log('[session/created]', session.id)
    })
  })
}
