/**
 * 写操作硬拦截（03 §2 / §4.3 / H1 / H26）。
 *
 * 为什么是"pre-execute 判定 + 同步 guard 兜底"的双保险：
 * - `ctx.tools.guard(fn)` 是**单调、同步**的守卫，返回字符串即拒绝，后续监听器
 *   无法翻案——这是硬门禁的正确位置（docs/impl/dsh-plugin-api-cheatsheet.md §5.2）；
 * - 但 `engine.evaluateAction` 是异步的（可能写待处理项/账本），同步 guard 里无法 await。
 *   因此把判定放在 `tools/pre-execute`（waterfall、异步）里完成，结果按 callId
 *   缓存；同步 guard 只做"查缓存 + 拒绝"，既保持硬拦截，又保留 fail-closed 语义。
 * - 缓存没有命中（判定环节被跳过/异常）时：受管会话内 fail-closed 拒绝，
 *   未初始化/未启用会话直接放行（不干扰宿主与普通项目）。
 *
 * 所有异常都在本模块内消化：pre-execute 监听器绝不抛错，sync guard 自带 try/catch。
 */
import type { DshContext, DshToolExecution, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { Action, CallerInfo, Decision } from '../../core/types.js'
import type { GuardDecisionEntry, ToolClassificationLike } from '../types.js'
import { toAgentError } from '../errors.js'
import { toRepoRelative } from '../adapters/windows-path.js'
import { interceptRowOf } from '../projection/panel.js'
import { appendFileSync } from 'node:fs'

const GUARD_DEBUG_LOG = '/tmp/flowgate-guard.log'

/** Debug-only guard tracer (FLOWGATE_DEBUG_GUARD=1); enabled for E2E diagnosis. */
function debugGuard(line: string): void {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    if (env?.FLOWGATE_DEBUG_GUARD !== '1') return
    appendFileSync(GUARD_DEBUG_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}

const MAX_REASON_CHARS = 300

const FAIL_CLOSED_REASON =
  '[FlowGate] 内部校验不可用：按失败关闭（fail-closed）拒绝本次调用。运行 /flow doctor 查看诊断，或由负责人 /flow off 临时关闭门禁。'

/** 给 agent 看的短拒绝语（≤300 字），完整解释由 engine 的待处理项与面板承载。 */
export function shortReason(decision: Decision): string {
  const rule = decision.rule?.ruleId ? `（${decision.rule.ruleId}）` : ''
  const message = decision.message.trim() === '' ? '该操作被 FlowGate 规则拒绝。' : decision.message.trim()
  const text = `[FlowGate] 已拦截${rule}：${message}`
  if (text.length <= MAX_REASON_CHARS) return text
  return `${text.slice(0, MAX_REASON_CHARS - 1)}…`
}

/** 调用 id 字符串化（真实宿主是 branded string；测试里可能是任意值）。 */
export function callIdOf(exec: { callId?: unknown; name?: string }): string {
  const raw = exec.callId
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof raw === 'number') return String(raw)
  return `anonymous:${exec.name ?? 'unknown'}`
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

/** 分类兜底动作：核心 actionFromToolCall 只认识的工具返回 null 时，按类别给一个通用动作。 */
export function fallbackAction(
  tool: string,
  params: Record<string, unknown>,
  classification: ToolClassificationLike,
): Action | null {
  if (classification.category === 'delegate') {
    const target = typeof params.agentPreset === 'string' ? params.agentPreset : typeof params.target === 'string' ? params.target : undefined
    return { kind: 'delegate', tool, target }
  }
  if (classification.category === 'mcp') {
    return { kind: 'mcp', tool, detail: typeof params.tool === 'string' ? params.tool : undefined }
  }
  if (classification.category === 'write') {
    const path = typeof params.path === 'string' ? params.path : typeof params.file_path === 'string' ? params.file_path : undefined
    if (path === undefined) return null
    // 写工具没有可识别路径：动作交 engine 判定会误伤，返回 null 由覆盖自检标红转人工。
    return { kind: 'write', tool, path }
  }
  return null
}

/** 构造 caller info（H18：agentId/角色/工作目录/派发上下文）。 */
export function buildCallerInfo(runtime: HostRuntime, exec: DshToolExecution, tool: string): CallerInfo {
  const agentId = exec.agent ? String(exec.agent.id) : undefined
  const role = runtime.roleOf(agentId)
  const caller: CallerInfo = {
    tool,
    agentId,
    agentRole: role.role,
  }
  if (role.worktree) caller.cwd = role.worktree
  else if (runtime.root()) caller.cwd = runtime.root() ?? undefined
  if (role.dispatch) caller.dispatch = role.dispatch
  return caller
}

/** 把路径类动作归一成仓库相对路径（受保护路径/任务范围都按相对路径判定）。 */
function normalizeActionPath(runtime: HostRuntime, action: Action): Action {
  const root = runtime.root()
  if (!root) return action
  if (action.kind === 'write' || action.kind === 'create' || action.kind === 'delete' || action.kind === 'rename' || action.kind === 'read') {
    return { ...action, path: toRepoRelative(root, action.path) }
  }
  return action
}

/** 安装守卫。可重复调用（服务替换时由 cordis 重新挂载）。 */
export function installGuard(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools) return
    runtime.capabilities.tools = true
    runtime.capabilities.toolsExecute = true
    runtime.capabilities.toolsPostExecute = true

    // 1) 异步判定：tools/pre-execute（waterfall，失败只在内部降级，绝不抛给宿主）。
    runtime.onScoped(scoped, 'tools/pre-execute', async (exec: DshToolExecution, next: () => Promise<unknown>) => {
      return await evaluatePreExecute(runtime, exec, next)
    })

    // 2) 读取类事件只做清理，防止判定缓存泄漏。
    runtime.onScoped(scoped, 'tools/result', (exec: DshToolExecution) => {
      runtime.guardDecisions.delete(callIdOf(exec))
    })

    // 3) 同步单调守卫：消费判定缓存，命中 deny/human 时拒绝。
    if (typeof tools.guard === 'function') {
      runtime.capabilities.toolsGuard = true
      const dispose = tools.guard((exec) => evaluateSyncGuard(runtime, exec as unknown as DshToolExecution))
      if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    }
  })
}

/** pre-execute 主体：所有异常都转成"内部错误 + fail-closed"或放行，不抛给宿主。 */
async function evaluatePreExecute(
  runtime: HostRuntime,
  exec: DshToolExecution,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const callId = callIdOf(exec)
  debugGuard(`pre-execute tool=${exec.name} args=${JSON.stringify(exec.arguments)?.slice(0, 400)} enabled=${String(runtime.isEnabled())}`)
  if (!runtime.isEnabled()) return next()
  const engine = runtime.engine()
  if (!engine) return next()

  // 心跳/审计计数（engine 内部负责线程安全，guard 是同步入口）。
  try {
    engine.noteToolCall()
  } catch {
    // 忽略计数失败。
  }

  try {
    const snapshot = runtime.lastSnapshot
    debugGuard(
      `snapshot initialized=${String(snapshot?.initialized)} off=${String(snapshot?.off)} change=${String(snapshot?.changeId)} stage=${String(snapshot?.stage)} managed=${String(runtime.isManagedNow())}`,
    )
    // 未初始化 / 当前会话已 off：不拦截任何操作（03 §2.4）。
    if (!snapshot || snapshot.initialized === false || snapshot.off === true) return next()

    const params = asRecord(exec.arguments)
    const classification = runtime.deps.core.classifyTool(exec.name, Object.keys(params))
    let action = runtime.deps.core.actionFromToolCall(exec.name, params)
    if (!action) action = fallbackAction(exec.name, params, classification)
    const caller = buildCallerInfo(runtime, exec, exec.name)
    if (!action) {
      // 只读/无关工具：记录 allow 占位，让 sync guard 放行。
      putDecision(runtime, { callId, tool: exec.name, caller, decision: { effect: 'allow', message: '' }, at: runtime.now().getTime() })
      return next()
    }
    const normalized = normalizeActionPath(runtime, action)
    debugGuard(`action kind=${normalized.kind} path=${String((normalized as { path?: string }).path)} caller=${JSON.stringify(caller).slice(0, 200)}`)
    const decision = await engine.evaluateAction(normalized, caller)
    debugGuard(`decision effect=${decision.effect} rule=${decision.rule?.ruleId ?? '-'} message=${decision.message.slice(0, 160)}`)
    putDecision(runtime, { callId, tool: exec.name, action: normalized, caller, decision, at: runtime.now().getTime() })
    if (decision.effect === 'allow') return next()

    try {
      engine.noteGuardDecision()
    } catch {
      // 忽略。
    }
    runtime.addIntercept(
      interceptRowOf({
        at: runtime.isoNow(),
        ruleId: decision.rule?.ruleId ?? 'UNKNOWN',
        tool: exec.name,
        target: actionTarget(normalized),
        effect: decision.effect,
        why: decision.rule?.why ?? decision.message,
        unlock: decision.rule?.unlock ?? '查看 /flow 的待处理项',
        source: decision.rule?.source,
      }),
    )
    runtime.emit()
    const reason = shortReason(decision)
    return {
      kind: 'deny',
      reason,
      info: { name: 'FlowGate', code: 'FLOWGATE_BLOCKED', reason },
    }
  } catch (error) {
    runtime.markInert('守卫判定', error, `守卫判定异常，已按失败关闭拒绝本次调用：${toAgentError(error).error}`)
    // fail-closed：受管会话内拒绝；未初始化（engine 存在但快照未 initialized）时放行。
    if (runtime.isManagedNow()) {
      return {
        kind: 'deny',
        reason: FAIL_CLOSED_REASON,
        info: { name: 'FlowGate', code: 'FLOWGATE_INTERNAL', reason: FAIL_CLOSED_REASON },
      }
    }
    return next()
  }
}

/** 单调守卫：只查缓存。没有预判时按 fail-closed 处理（受管会话内）。 */
function evaluateSyncGuard(runtime: HostRuntime, exec: DshToolExecution): string | undefined {
  try {
    if (!runtime.isEnabled()) return undefined
    if (!runtime.isManagedNow()) return undefined
    const callId = callIdOf(exec)
    const entry = runtime.takeGuardDecision(callId)
    debugGuard(`sync-guard tool=${exec.name} cache=${entry ? entry.decision.effect : 'miss'}`)
    if (!entry) {
      return FAIL_CLOSED_REASON
    }
    if (entry.decision.effect === 'allow') return undefined
    return shortReason(entry.decision)
  } catch (error) {
    try {
      runtime.markInert('守卫内部异常', error, '守卫内部异常，已按失败关闭拒绝本次调用；连续出现请运行 /flow doctor。')
    } catch {
      // 忽略。
    }
    return FAIL_CLOSED_REASON
  }
}

function putDecision(runtime: HostRuntime, entry: GuardDecisionEntry): void {
  runtime.putGuardDecision(entry)
}

/** 面板展示用的动作目标。 */
function actionTarget(action: Action): string | undefined {
  if ('command' in action) return action.command
  if ('target' in action) return action.target
  if ('detail' in action) return action.detail
  if ('path' in action) return action.path
  return undefined
}
