/**
 * 会话投影注册（`key: 'flowgate'`，契约见 docs/impl/host-client-contract.md §1）。
 *
 * 数据来源：host 每次引擎状态变化写一条插件记录 `plugin:dsh-flowgate/state`
 * （appendPluginRecord；见 runtime.emit），本投影的 `apply` 折叠该事件。
 * 这样冷恢复（resume/fork）时投影可从日志重建，客户端 `useProjection('flowgate')`
 * 拿到完整状态；面板/状态条不需要轮询。
 *
 * schema 说明：rc.5 的注册表只在 checkpoint 冷读时调用 `stateSchema.parse` /
 * `wire.viewSchema.parse`，因此这里用本地 passthrough schema（不引入 zod）；
 * 若未来 DSH 版本改为真实校验，再补 zod 依赖。
 */
import type { DshContext, DshSessionProjectionRegistry } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import { STATE_RECORD_TYPE } from '../adapters/session-record.js'
import type { FlowgateProjection } from './types.js'
import { initialProjection } from './types.js'
import { toAgentError } from '../errors.js'
import { installContextPressure } from './context.js'

/** 投影 key（客户端用 `useProjection('flowgate')` 读取）。 */
export const PROJECTION_KEY = 'flowgate'
/** 状态语义/字段变化时递增；旧 checkpoint 会被丢弃。 */
export const PROJECTION_STATE_VERSION = 1

/** passthrough schema（rc.5 只用 .parse；见文件头注释）。 */
function passthroughSchema<T>(): { parse(value: unknown): T } {
  return { parse: (value: unknown) => value as T }
}

/**
 * 无损 JSON 边界清洗（v0.5.1 修复：新会话创建失败）。
 *
 * DSH 的 `@deepseek-ai/dsh-api-remotes` 在转发 `api-session/added` 等事件前会用
 * `isJsonValue()` 校验参数；`undefined` 属性、NaN/Infinity、函数、非 plain object
 * 都会让校验失败并抛出
 * `forwarded host event "api-session/added" argument 0 is not lossless JSON data`。
 *
 * 我们的 `flowgate` 投影值来自 `engine.snapshot()` / `buildPanel()`，其中不少
 * 可选字段在无变更/无活动任务时是显式 `undefined`（如 changeId、activeTaskId、
 * panel、panel.changes[].session）。这些字段一旦进入会话摘要的
 * `projections.values.flowgate` 就会让「新建会话」失败。
 *
 * 修法：投影的 init / wire.view 在交给 DSH 前做一次 JSON 往返清洗。JSON 本身
 * 会把 undefined 丢掉、把 NaN/Infinity 变成 null——这正是 lossless JSON 的要求。
 * 不做深拷贝/递归手写，避免再与 DSH 的判定规则漂移。
 */
export function toLosslessJson<T>(value: T): T {
  if (value === undefined) return value
  try {
    // JSON.stringify 会抛 TypeError（BigInt / 循环引用），此时保底返回原值；
    // 当前投影数据是插件自己构造的纯对象，不会走到这里。
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/** 校验从插件记录折叠出来的投影值（损坏时保留原状态，绝不返回半截对象）。 */
export function sanitizeProjection(value: unknown): FlowgateProjection | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const snapshot = record.snapshot
  if (snapshot === null || typeof snapshot !== 'object') return null
  const revision = typeof record.revision === 'number' ? record.revision : 0
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString()
  const projection: FlowgateProjection = {
    snapshot: snapshot as FlowgateProjection['snapshot'],
    revision,
    updatedAt,
  }
  if (typeof record.epoch === 'string' && record.epoch !== '') projection.epoch = record.epoch
  if (record.panel !== undefined && record.panel !== null && typeof record.panel === 'object') {
    projection.panel = record.panel as FlowgateProjection['panel']
  }
  return projection
}

/** 投影定义（导出便于单测直接折叠事件）。 */
export function createFlowgateProjection(now: () => string, latest?: () => FlowgateProjection | undefined): {
  key: typeof PROJECTION_KEY
  stateVersion: number
  stateSchema: { parse(value: unknown): FlowgateProjection }
  init(): FlowgateProjection
  apply(state: FlowgateProjection, event: { type?: string; data?: unknown }): FlowgateProjection
  wire: { viewSchema: { parse(value: unknown): unknown }; view(state: FlowgateProjection): FlowgateProjection }
} {
  return {
    key: PROJECTION_KEY as typeof PROJECTION_KEY,
    stateVersion: PROJECTION_STATE_VERSION,
    stateSchema: passthroughSchema<FlowgateProjection>(),
    init: () => toLosslessJson(latest?.() ?? initialProjection(now())),
    apply: (state, event) => {
      if (event && event.type === STATE_RECORD_TYPE) {
        const next = sanitizeProjection(event.data)
        if (next) {
          // 宿主重启后 revision 从 0 重新计数，而日志里旧进程的 revision 可能更大：
          // epoch 不同视为"新进程记录"，直接接受（否则 UI 会停留在重启前快照）。
          const newEpoch = next.epoch !== undefined && next.epoch !== state.epoch
          if (newEpoch || next.revision >= state.revision) return next
          return state
        }
      }
      // Fallback when the host does not expose appendPluginRecord (custom session
      // records unavailable): refresh from the host's latest in-memory projection
      // on any committed event. The projection then tracks command/tool activity
      // without depending on the experimental record API.
      const fresh = latest?.()
      if (fresh) {
        const newEpoch = fresh.epoch !== undefined && fresh.epoch !== state.epoch
        if (newEpoch || fresh.revision > state.revision) return fresh
      }
      return state
    },
    wire: {
      viewSchema: passthroughSchema<unknown>(),
      // DSH 会把该值塞进 api-session/added 的会话摘要；必须是 lossless JSON。
      view: (state) => toLosslessJson(state),
    },
  }
}

/** 安装投影。 */
export function installProjection(runtime: HostRuntime): void {
  runtime.injectService('sessionProjections', (scoped: DshContext) => {
    const registry = scoped.get('sessionProjections') as
      | (DshSessionProjectionRegistry & { register?(definition: unknown): () => void })
      | null
    // 上下文占用（P1-7）与 flowgate 投影共用这次注入：token-meter 注册的
    // contextPressure 单元与 flowgate 一样由 sessionProjections 提供。
    installContextPressure(runtime, registry)
    if (!registry || typeof registry.register !== 'function') return
    const definition = createFlowgateProjection(
      () => runtime.isoNow(),
      () => runtime.projection(),
    )
    const dispose = registry.register(definition)
    if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    runtime.capabilities.sessionProjections = true
    runtime.noteFeature('projection', `已注册会话投影 ${PROJECTION_KEY}（stateVersion=${PROJECTION_STATE_VERSION}）`)
    // 注册完成后把当前投影补写一次，保证打开中的会话立即有值。
    if (runtime.engine()) runtime.emit()
  })
}

/** 供 doctor/测试读取的投影定义信息。 */
export function projectionInfo(): { key: string; stateVersion: number; recordType: string } {
  return { key: PROJECTION_KEY, stateVersion: PROJECTION_STATE_VERSION, recordType: STATE_RECORD_TYPE }
}

/** 供模块文档引用：投影 wire 值与客户端契约一致。 */
export type { FlowgateProjection }

/** 把错误转成面板可读字符串（调试用）。 */
export function describeProjectionError(error: unknown): string {
  return toAgentError(error).error
}
