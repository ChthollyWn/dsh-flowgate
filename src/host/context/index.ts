/**
 * 每步运行时上下文注入 + 拦住"宣布完成"（03 §6.6 / H7 / H8）。
 *
 * 注入：优先 `ctx.systemPrompt.section`（追加式、工具面不变 → KV cache 友好）；
 * 宿主缺 systemPrompt 时退回 `agent/pre-step` 的 enter 分支追加 user 消息。
 * 文本来自 `engine.buildInjection()`（≤600 token，包含阶段/允许动作/活动任务/
 * 待处理项/下一步）；末尾再追加固定的「卡片优先交互契约」（§0 规则 2）：
 * 负责人拍板走客户端授权卡片、澄清/选择走原生 ask_user_question 提问卡。
 * 未初始化时 buildInjection 为空文本，契约也不追加，避免污染普通项目提示词。
 *
 * 拦住宣布完成：`agent/turn-stopping` 无返回值（rc.5 事实），必须调
 * `agent.steer(userMessage)` 重新打开 inbox。触发条件（03 §6.6）：
 * 1. 当前 S4/S5；2. 最后一条 assistant 消息有完成类表述；
 * 3. 当前输入下没有新鲜 GREEN 回执。每轮最多 steer 2 次（config.limits.turn_continue_max）。
 */
import type { DshAgent, DshContext, DshSession, DshUserMessage } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { EvidenceReceipt, RuntimeSnapshot } from '../../core/types.js'
import { toAgentError } from '../errors.js'
import { sha256Hex } from '../../core/util/hash.js'

/** systemPrompt section 的 order：放在第一方工具说明之后、文件引用之前。 */
const INJECTION_ORDER = 9000
/** 注入文本未变化时，最多隔几步重复注入一次（避免每步都追加 600 token）。 */
const REPEAT_INTERVAL_STEPS = 4
/**
 * 卡片优先交互契约（ui-interaction-redesign §0 规则 2 / §5.2）。
 *
 * 只随已初始化项目的 runtime 注入一起追加，避免污染未启用 FlowGate 的普通项目提示词。
 * 约束两件事：① 需要负责人拍板的步骤走客户端授权卡片，不要让负责人手输 `/flow`；
 * ② agent 需要澄清/选择时必须调用原生 `ask_user_question`（带 options），
 * 由宿主渲染成提问卡片，而不是在普通文本里提问。
 */
export const INTERACTION_CONTRACT =
  '交互契约：需要负责人拍板的步骤由客户端授权卡片完成，不要要求负责人输入 /flow 命令；需要澄清/选择时必须调用 ask_user_question（带 options），不要在普通文本里提问。'

/**
 * 把卡片优先交互契约追加到 runtime 注入文本末尾（仅当注入文本非空时）。
 * section 与 pre-step 两条注入路径共用，保证 debug/兜底模式下契约不丢。
 */
export function withInteractionContract(text: string): string {
  if (text.trim() === '') return ''
  return `${text}\n${INTERACTION_CONTRACT}`
}

/** 完成类表述（小写比较）。 */
const COMPLETION_PATTERN =
  /(完成|已完成|搞定了|全部通过|都通过了|测试通过|修复(了|完成)|已修复|实现了|done|fixed|finished|passing|all tests pass|tests pass|implemented|resolved)/i

interface InjectionState {
  lastHash?: string
  steps: number
}

interface TurnState {
  turn: number
  count: number
  startedAt: number
}

const injectionStates = new Map<string, InjectionState>()
const turnStates = new Map<string, TurnState>()

/** 从 assistant/message 事件里提取文本（结构因版本而异，做多路兜底）。 */
export function assistantTextFromEvent(event: unknown): string {
  if (event === null || typeof event !== 'object') return ''
  const record = event as Record<string, unknown>
  const data = record.data
  if (data === null || typeof data !== 'object') return ''
  const dataRecord = data as Record<string, unknown>
  const message = (dataRecord.message ?? dataRecord) as Record<string, unknown>
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const blockRecord = block as Record<string, unknown>
    if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') parts.push(blockRecord.text)
  }
  return parts.join('\n')
}

/** 取会话日志里最后一条 assistant 文本（H8；`snapshotEvents` 是 rc.5 可用读法）。 */
export function lastAssistantText(agent: DshAgent): string {
  const session = agent.session as DshSession & {
    snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly unknown[]
    ownEvents?(): readonly unknown[]
    deriveMessages?(): readonly unknown[]
  }
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      const type = (event as { type?: string } | undefined)?.type
      if (type === 'assistant/message') {
        const text = assistantTextFromEvent(event)
        if (text.trim() !== '') return text
      }
    }
  } catch (error) {
    // 读会话事件失败：退回 deriveMessages。
    try {
      const messages = session.deriveMessages?.() ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as { role?: string; content?: unknown }
        if (message?.role !== 'assistant') continue
        const content = message.content
        if (!Array.isArray(content)) continue
        const text = content
          .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : ''))
          .join('\n')
        if (text.trim() !== '') return text
      }
    } catch {
      // 忽略：没有证据时不阻断。
    }
  }
  return ''
}

/** 判断最后一条 assistant 文本是否在宣布完成。 */
export function claimsCompletion(text: string): boolean {
  return COMPLETION_PATTERN.test(text.slice(-2_000))
}

/** 当前任务是否有"本回合开始之后"的 GREEN 回执。 */
export function hasFreshGreen(
  receipts: readonly EvidenceReceipt[],
  taskId: string | undefined,
  turnStartedAt: number,
): EvidenceReceipt | null {
  const candidates = receipts.filter((receipt) => {
    if (receipt.phase !== 'green') return false
    if (taskId && receipt.taskId && receipt.taskId !== taskId) return false
    if (taskId && receipt.taskId === undefined) return false
    return true
  })
  if (candidates.length === 0) return null
  const sorted = [...candidates].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
  const latest = sorted[sorted.length - 1]
  if (!latest) return null
  const finished = Date.parse(latest.finishedAt)
  if (Number.isFinite(finished) && finished >= turnStartedAt - 5_000) return latest
  return null
}

/** 注入是否该发给这个 agent（main / executor；不打扰 reviewer/investigator 的干净上下文）。 */
export function shouldInject(runtime: HostRuntime, agent: DshAgent | undefined): boolean {
  if (!agent) return true
  const id = String(agent.id)
  if (!runtime.mainAgent()) return true
  if (String(runtime.mainAgent()?.id) === id) return true
  const role = runtime.roleOf(id).role
  return role === 'executor' || role === 'main'
}

/** 安装上下文注入与 turn-stopping 拦截。 */
export function installContext(runtime: HostRuntime): void {
  let injectionMode: 'section' | 'pre-step' | 'none' = 'none'

  // Debug isolation: FLOWGATE_CONTEXT_MODE=pre-step skips the systemPrompt section.
  const envMode = String(
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FLOWGATE_CONTEXT_MODE ?? '',
  )
  const skipSection = envMode === 'pre-step'

  // 1) 首选：systemPrompt 追加段。
  if (!skipSection) runtime.injectService('systemPrompt', (scoped: DshContext) => {
    const prompt = scoped.get('systemPrompt') as {
      section?(section: unknown): () => void
      getSectionOrder?(name: string): number
    } | null
    if (!prompt || typeof prompt.section !== 'function') return
    const order = prompt.getSectionOrder ? safeSectionOrder(prompt) : INJECTION_ORDER
    const dispose = prompt.section({
      name: 'flowgate:runtime',
      order,
      interpolate: false,
      text: (context: { agent?: DshAgent }) => {
        try {
          if (!runtime.isEnabled()) return ''
          const engine = runtime.engine()
          if (!engine || !engine.isInitialized()) return ''
          if (!shouldInject(runtime, context?.agent)) return ''
          return withInteractionContract(engine.buildInjection().text)
        } catch (error) {
          runtime.noteFeature('context', `系统提示注入失败：${toAgentError(error).error}`)
          return ''
        }
      },
    })
    if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    runtime.capabilities.systemPrompt = true
    injectionMode = 'section'
    runtime.noteFeature('context', '注入方式：systemPrompt.section（追加式）')
  })

  // 2) 兜底：agent/pre-step 的 enter 分支追加消息。
  runtime.on('agent/pre-step', async (payload: { agent?: DshAgent; messages?: DshUserMessage[]; turn?: number; step?: number }, next: () => Promise<unknown>) => {
    const result = (await next()) as { kind?: string; messages?: DshUserMessage[]; startsRequestSeries?: true } | undefined
    if (injectionMode === 'section') return result
    if (!result || result.kind !== 'enter') return result
    const engine = runtime.engine()
    if (!engine || !engine.isInitialized() || !runtime.isEnabled()) return result
    if (!shouldInject(runtime, payload.agent)) return result
    try {
      const text = withInteractionContract(engine.buildInjection().text)
      if (text.trim() === '') return result
      const agentId = payload.agent ? String(payload.agent.id) : 'unknown'
      const state = injectionStates.get(agentId) ?? { steps: 0 }
      state.steps += 1
      const hash = sha256Hex(text)
      const shouldAppend = state.lastHash !== hash || state.steps % REPEAT_INTERVAL_STEPS === 0
      injectionStates.set(agentId, { lastHash: hash, steps: state.steps })
      if (!shouldAppend) return result
      const message: DshUserMessage = {
        content: [{ type: 'text', text }],
        source: { kind: 'runtime-context', form: 'relay' },
      }
      return {
        ...result,
        messages: [...(result.messages ?? []), message],
        ...(result.startsRequestSeries ? { startsRequestSeries: true } : {}),
      }
    } catch (error) {
      runtime.noteFeature('context', `pre-step 注入失败：${toAgentError(error).error}`)
      return result
    }
  })

  // 3) 拦住"宣布完成"。
  runtime.on('agent/turn-stopping', async (payload: { agent?: DshAgent; turn?: number }) => {
    await onTurnStopping(runtime, payload)
  })

  // 记录回合开始时间（用于判断回执是否新鲜）。
  runtime.on('agent/pre-step', async (payload: { agent?: DshAgent; turn?: number; step?: number; messages?: DshUserMessage[] }, next: () => Promise<unknown>) => {
    try {
      const agent = payload.agent
      const turn = payload.turn ?? 0
      const step = payload.step ?? 0
      if (agent && step <= 1) {
        turnStates.set(String(agent.id), { turn, count: 0, startedAt: Date.now() })
      }
    } catch {
      // 忽略。
    }
    return next()
  })
}

function safeSectionOrder(prompt: { getSectionOrder?(name: string): number }): number {
  try {
    return prompt.getSectionOrder?.('DELIVERABLE_FILE_REFERENCES') ?? INJECTION_ORDER
  } catch {
    return INJECTION_ORDER
  }
}

/** turn-stopping 主体。 */
async function onTurnStopping(runtime: HostRuntime, payload: { agent?: DshAgent; turn?: number }): Promise<void> {
  if (!runtime.isEnabled()) return
  const agent = payload?.agent
  if (!agent) return
  const engine = runtime.engine()
  if (!engine || !engine.isInitialized()) return
  const snapshot: RuntimeSnapshot | null = runtime.lastSnapshot ?? safeSnapshot(runtime)
  if (!snapshot || snapshot.off || snapshot.locked) return
  if (snapshot.stage !== 'S4' && snapshot.stage !== 'S5') return
  // 只对主会话/执行者生效；reviewer/investigator 的干净上下文不打扰。
  if (!shouldInject(runtime, agent)) return
  const agentId = String(agent.id)
  const turn = payload.turn ?? 0
  const turnState = turnStates.get(agentId)
  if (!turnState || turnState.turn !== turn) {
    turnStates.set(agentId, { turn, count: 0, startedAt: Date.now() })
  }
  const state = turnStates.get(agentId) ?? { turn, count: 0, startedAt: Date.now() }
  if (state.turn !== turn) {
    state.turn = turn
    state.count = 0
    state.startedAt = Date.now()
  }
  let maxContinues = 2
  try {
    maxContinues = engine.getConfig().limits.turn_continue_max
  } catch {
    // 默认 2。
  }
  if (state.count >= maxContinues) {
    // T3.3：同一轮第 3 次不再拦截，但必须记账（此前静默 return，审计里看不到）。
    const suppressedState = state as typeof state & { suppressedRecorded?: boolean }
    if (suppressedState.suppressedRecorded !== true) {
      suppressedState.suppressedRecorded = true
      void engine
        .recordTurnContinued({
          turn,
          count: state.count,
          ...(snapshot.activeTaskId ? { taskId: snapshot.activeTaskId } : {}),
          reason: '超过每轮拦截上限，静默放行（已记账）',
          suppressed: true,
        })
        .catch((error: unknown) => runtime.noteFeature('turn', `抑制记账失败：${toAgentError(error).error}`))
    }
    return
  }
  const text = lastAssistantText(agent)
  if (!claimsCompletion(text)) return
  let receipts: EvidenceReceipt[] = []
  try {
    receipts = engine.getEvidence()
  } catch {
    receipts = []
  }
  const fresh = hasFreshGreen(receipts, snapshot.activeTaskId, state.startedAt)
  if (fresh) return

  const activeTask = snapshot.activeTaskId ? `当前任务 ${snapshot.activeTaskId}` : '当前阶段'
  const steerText =
    `[FlowGate] 你刚才声称完成，但${activeTask}没有本回合内新鲜通过的验证回执（GREEN）。` +
    '请立即运行对应验证命令（优先 `flow_verify`），用真实输出证明；如果还没做完，继续做完再宣布完成。' +
    '负责人可以看到回执与失败用例。'
  try {
    agent.steer({ content: [{ type: 'text', text: steerText }], source: { kind: 'runtime-context', form: 'relay' } })
    state.count += 1
    runtime.noteFeature('turn', `已 steer 继续（第 ${state.count}/${maxContinues} 次，turn=${turn}）`)
    void engine
      .recordTurnContinued({ turn, count: state.count, ...(snapshot.activeTaskId ? { taskId: snapshot.activeTaskId } : {}), reason: 'agent 宣布完成但无新鲜 GREEN 回执' })
      .catch((error: unknown) => runtime.noteFeature('turn', `记账失败：${toAgentError(error).error}`))
  } catch (error) {
    runtime.noteFeature('turn', `steer 失败（宿主可能不支持）：${toAgentError(error).error}`)
  }
}

function safeSnapshot(runtime: HostRuntime): RuntimeSnapshot | null {
  try {
    return runtime.engine()?.snapshot() ?? null
  } catch {
    return null
  }
}

/** 测试用：清空上下文模块状态。 */
export function resetContextStateForTest(): void {
  injectionStates.clear()
  turnStates.clear()
}
