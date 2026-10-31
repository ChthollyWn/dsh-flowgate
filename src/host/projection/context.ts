/**
 * 上下文占用（contextPct）数据源（P1-7）。
 *
 * rc.5 数据链路（证据：docs/reference/dsh-0.2.1-rc.5/dsh-token-meter.zh.md
 * §「会话投影」；`@deepseek-ai/dsh-token-meter@0.2.1-rc.5`
 * lib/types/usage-projection.d.ts 的 `contextPressureProjectionDefinition`）：
 *
 * - 组合提供 `ctx.sessionProjections` 时，`dsh-token-meter` 注册
 *   `contextPressure` 投影单元，wire 值为
 *   `{ projectedTokens?, pressureTokens?, contextWindow? }`：`pressureTokens`
 *   是提供方上报的最近一次请求提示词规模，`projectedTokens` 是下一次请求的
 *   预算（含压缩后的修正），`contextWindow` 来自最新 `request/context` 记录
 *   （没有声明容量的路由没有该字段）。
 * - 宿主读取路径：`ctx.sessionProjections.snapshot(session, ['contextPressure'])`
 *   拿 wire 值；若该单元被注册成 host-only（没有 wire 块），退回
 *   `stateOf(session, 'contextPressure')`（host state 有 pressureTokens /
 *   contextWindow，没有 projectedTokens）。
 * - 占用 = (projectedTokens ?? pressureTokens) / contextWindow × 100。
 *   两个数字任一缺失就返回 undefined——**绝不编造**；客户端
 *   `src/client/model.ts` 只在 >= 60% 时展示。
 *
 * 能力探测 + 降级：没有 token-meter / 没有 contextPressure 键 / 读取抛错时，
 * 本模块只让 contextPct 不显示（doctor 的「功能状态」里记录一句），不影响
 * 投影注册与插件其他功能。
 */
import type { DshSession, DshSessionProjectionRegistry } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'

/** dsh-token-meter 注册的上下文压力投影 key。 */
export const CONTEXT_PRESSURE_KEY = 'contextPressure'

/** 正整数（token 数 / 容量）；其余一律视为缺失。 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 从 `contextPressure` 投影值算上下文占用百分比（0–100，一位小数）。
 * 缺少 `contextWindow`，或 `projectedTokens`/`pressureTokens` 都缺失 → undefined。
 */
export function contextPctFromPressure(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const contextWindow = positiveNumber(record.contextWindow)
  if (contextWindow === undefined) return undefined
  // projectedTokens 回答「下一次请求」，能在压缩后立即反映；pressureTokens 是
  // 提供方最近一次的上报值。优先前者，取不到再退回后者。
  const tokens = positiveNumber(record.projectedTokens) ?? positiveNumber(record.pressureTokens)
  if (tokens === undefined) return undefined
  const pct = (tokens / contextWindow) * 100
  // 一位小数：状态条还会 Math.round，避免长浮点进入投影 hash 与日志。
  return Math.min(100, Math.max(0, Math.round(pct * 10) / 10))
}

/**
 * 读取当前会话的上下文占用百分比。同步、无 IO；投影缺失/形状不符/抛错都
 * 返回 undefined（调用方保持快照无 contextPct 字段）。
 */
export function readContextPct(
  registry: DshSessionProjectionRegistry | null,
  session: DshSession | null,
): number | undefined {
  if (registry === null || session === null) return undefined
  try {
    if (typeof registry.snapshot === 'function') {
      const snapshot = registry.snapshot(session, [CONTEXT_PRESSURE_KEY])
      const value = snapshot.values?.[CONTEXT_PRESSURE_KEY]
      const pct = contextPctFromPressure(value)
      if (pct !== undefined) return pct
    }
  } catch {
    // 投影读取失败只降级上下文占用展示；继续尝试 host state 读法。
  }
  try {
    if (typeof registry.stateOf === 'function') {
      return contextPctFromPressure(registry.stateOf(session, CONTEXT_PRESSURE_KEY))
    }
  } catch {
    // 同上。
  }
  return undefined
}

/**
 * 安装 contextPct 数据源。由 projection 模块在 `sessionProjections` 可用时调用
 * （与 flowgate 投影注册共用一次注入）。
 *
 * - registry 为 null / 无读取面：只记一条 doctor 说明，不报错、不标记降级。
 * - 否则注册同步读取闭包；每次 `runtime.emit()` 都重新读一遍投影值。
 * - 引擎自身只在 flow/门禁/守卫等状态变化时 emit，普通工具调用不会——所以
 *   再订阅 `onChanged`：token-meter 在每条 assistant 用量样本后更新
 *   `contextPressure`，变更通知经微任务延后触发一次 emit（避免在投影 drive
 *   中同步追加会话记录造成重入）。
 */
export function installContextPressure(
  runtime: HostRuntime,
  registry: DshSessionProjectionRegistry | null,
): void {
  const readable =
    registry !== null && (typeof registry.snapshot === 'function' || typeof registry.stateOf === 'function')
  if (!readable) {
    runtime.noteFeature(
      'contextPct',
      '未发现 contextPressure 会话投影（组合中未挂载 @deepseek-ai/dsh-token-meter）：状态条不显示上下文占用，其余功能不受影响。',
    )
    return
  }
  runtime.setContextPctSource(() => readContextPct(registry, runtime.mainSession()))
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  runtime.registerDisposer(() => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    runtime.setContextPctSource(null)
  })
  if (typeof registry.onChanged === 'function') {
    const disposeChange = registry.onChanged((session, key) => {
      if (key !== CONTEXT_PRESSURE_KEY || disposed || timer !== null) return
      const main = runtime.mainSession()
      if (main === null || sessionIdOf(session) !== sessionIdOf(main)) return
      // 延后一个宏任务：onChanged 在已提交事件的投影 drive 内同步触发，此时
      // 直接 emit 会在会话日志提交链路里追加插件记录；等提交链路结束后再
      // emit（下一帧重新读取投影值，天然去重）。
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        runtime.emit()
      }, 0)
      timer.unref?.()
    })
    if (typeof disposeChange === 'function') runtime.registerDisposer(disposeChange)
  }
  // 已就绪的会话立即补一帧，不必等下一次引擎状态变化。
  if (runtime.engine()) runtime.emit()
}

/** 会话 id 的结构化读取（rc.5 Session.id 是 unknown；缺失视为不同会话）。 */
function sessionIdOf(session: DshSession): string {
  const id = (session as { id?: unknown }).id
  return id === undefined || id === null ? '' : String(id)
}
