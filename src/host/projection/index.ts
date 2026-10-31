/**
 * 会话投影注册（`key: 'flowgate'`，契约见 docs/impl/host-client-contract.md §1）。
 *
 * 数据来源：host 每次引擎状态变化写一条插件记录 `plugin:dsh-flowgate/state`
 * （appendPluginRecord；见 runtime.emit），本投影的 `apply` 折叠该事件。
 * 这样冷恢复（resume/fork）时投影可从日志重建，客户端 `useProjection('flowgate')`
 * 拿到完整状态；面板/状态条不需要轮询。
 *
 * 自愈设计（P0-2，v0.5.1 事故复盘）：
 * 1. `init` **绝不**从其他会话的 latest 状态播种——一个会话的 live 状态不能成为
 *    新会话的初始值（新会话/子会话创建时投影 init 会参与会话摘要转发）；只返回
 *    干净的未启用快照。
 * 2. 所有出界数据（init/apply/wire）走 `src/host/boundary/json.ts` 的
 *    `toLosslessJson`；wire 值先经 `toWireProjection` 显式白名单 DTO。
 * 3. 注册前运行 `projectionSelfCheck()`：用 initial + 一个含 undefined/NaN/Date/
 *    类实例的脏 fixture 走 init/apply/wire，断言 isLosslessJson 且顶层键齐全；
 *    失败就**不注册**投影（runtime.markInert + doctor 可见），坏投影无法再让
 *    宿主的 lossless JSON 校验炸掉会话创建。
 *
 * schema 说明：rc.5 的注册表只在 checkpoint 冷读时调用 `stateSchema.parse` /
 * `wire.viewSchema.parse`，因此这里用本地 passthrough schema（不引入 zod）；
 * 若未来 DSH 版本改为真实校验，再补 zod 依赖。
 */
import type { DshContext, DshSessionProjectionRegistry } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import { STATE_RECORD_TYPE } from '../adapters/session-record.js'
import type { FlowgateProjection, ProjectionSelfCheckResult } from './types.js'
import { emptySnapshot, initialProjection } from './types.js'
import { toLosslessJson, assertLosslessJson, isLosslessJson } from '../boundary/json.js'
import { toWireProjection, PROJECTION_WIRE_TOP_LEVEL_KEYS } from './wire.js'
import { toAgentError } from '../errors.js'
import { installContextPressure } from './context.js'

/** 投影 key（客户端用 `useProjection('flowgate')` 读取）。 */
export const PROJECTION_KEY = 'flowgate'
/**
 * 状态语义/字段变化时递增；旧 checkpoint 会被丢弃。
 * v2：wire 改为显式白名单 DTO（v0.5.1）；旧 checkpoint 的宽松透传值不再兼容。
 */
export const PROJECTION_STATE_VERSION = 2

/** passthrough schema（rc.5 只用 .parse；见文件头注释）。 */
function passthroughSchema<T>(): { parse(value: unknown): T } {
  return { parse: (value: unknown) => value as T }
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
    // P0-2：init 只用干净的未启用快照，绝不从 latest() 播种（另一个会话的 live
    // 状态不能进新会话初始值——新会话/子会话创建时 init 会进会话摘要）。
    init: () => toLosslessJson(initialProjection(now())),
    apply: (state, event) => {
      if (event && event.type === STATE_RECORD_TYPE) {
        // 插件记录来自会话日志（可能被旧版本/损坏数据污染）：先 sanitize 形状，
        // 再统一过 lossless 边界，最后才参与 revision 比较。
        const sanitized = sanitizeProjection(event.data)
        const next = sanitized ? toLosslessJson(sanitized) : null
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
      // 兜底值同样先过 lossless 边界（latest 来自 runtime 内部状态）。
      const fresh = latest ? toLosslessJson(latest()) : undefined
      if (fresh) {
        const newEpoch = fresh.epoch !== undefined && fresh.epoch !== state.epoch
        if (newEpoch || fresh.revision > state.revision) return fresh
      }
      return state
    },
    wire: {
      viewSchema: passthroughSchema<unknown>(),
      // DSH 会把该值塞进 api-session/added 的会话摘要；必须是 lossless JSON。
      // 顺序：显式 DTO（挑字段+限量）→ JSON 清洗（唯一边界收口）。
      view: (state) => toLosslessJson(toWireProjection(state)),
    },
  }
}

// ---------------------------------------------------------------------------
// 投影启动自检（P0-2）
// ---------------------------------------------------------------------------

/** 自检 fixture 用的类实例：验证类实例不会以非 plain object 形态漏进 wire。 */
class DirtyProbe {
  readonly label = 'dirty'
  readonly seenAt = new Date(0)
}

/**
 * 脏 fixture：模拟真实事故里可能出现的一切坏值（undefined 字段 / NaN /
 * Date / 类实例 / 嵌套未知字段）。用 `unknown` 构造，避免"类型上不可能脏"
 * 掩盖自检本身（它检查的正是运行时形状）。
 */
function dirtyProjectionEvent(now: string): unknown {
  return {
    snapshot: {
      ...emptySnapshot(now),
      initialized: true,
      changeId: 'C-SELF-CHECK',
      title: '投影自检（dirty fixture）',
      stage: 'S4',
      takeover: 'enforce',
      offBy: undefined,
      incident: undefined,
      repair: undefined,
      contextPct: Number.NaN,
      updatedAt: new Date(0),
      unexpectedUndefined: undefined,
      unexpectedDate: new Date(0),
      unexpectedInstance: new DirtyProbe(),
      unexpectedFunction: () => undefined,
      tasks: { T1: { state: 'todo', nestedUndefined: undefined } },
      pending: [],
    },
    panel: {
      changes: [
        {
          id: 'C-SELF-CHECK',
          title: '投影自检',
          kind: 'change',
          complexity: 'low',
          risk: 'normal',
          stage: 'S4',
          lifecycle: 'active',
          session: undefined,
          updatedAt: now,
        },
      ],
      gate: {
        gate: 'G1',
        state: 'pending',
        items: [{ item: 'i', label: 'l', passed: false, hint: undefined }],
        awaitingOwner: false,
      },
      evidence: [
        {
          id: 'E-SELF-CHECK',
          taskId: undefined,
          group: 'repro',
          kind: 'test',
          phase: 'red',
          exitCode: 1,
          run: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          fresh: true,
          finishedAt: now,
        },
      ],
      dashboardPath: '.flowgate/dashboard.html',
    },
    revision: 2,
    updatedAt: now,
    epoch: 'projection-self-check',
  }
}

/** 测试注入自检结果（故障注入用：验证自检失败时不注册投影且不抛错）。 */
let selfCheckOverride: (() => ProjectionSelfCheckResult) | null = null

/** 最近一次自检结果（doctor 读取；installProjection 注册前写入）。 */
let lastSelfCheck: ProjectionSelfCheckResult | null = null

/**
 * 运行投影启动自检：initial + 脏 fixture 走 init/apply/wire，断言
 * - 三个产出都能通过 `assertLosslessJson`（DSH isJsonValue 等价规则）；
 * - wire 顶层键齐全（snapshot/revision/updatedAt）；
 * - 顶层键值与 JSON 往返语义一致（防 toWireProjection 引入不可表示值）。
 *
 * 自检本身不抛错：失败返回 { ok:false, error } 由调用方决定降级。
 */
export function projectionSelfCheck(now: () => string = () => new Date().toISOString()): ProjectionSelfCheckResult {
  const checkedAt = now()
  const result: ProjectionSelfCheckResult = { ok: false, checkedAt, stateVersion: PROJECTION_STATE_VERSION }
  try {
    const definition = createFlowgateProjection(now)
    const initial = definition.init()
    assertLosslessJson(initial, '投影自检 init')
    const applied = definition.apply(initial, { type: STATE_RECORD_TYPE, data: dirtyProjectionEvent(now()) })
    assertLosslessJson(applied, '投影自检 apply')
    const view = definition.wire.view(applied)
    assertLosslessJson(view, '投影自检 wire')
    if (!isLosslessJson(view)) throw new Error('wire 值未通过 isLosslessJson（自检内部不一致）')
    const record = view as unknown as Record<string, unknown>
    for (const key of PROJECTION_WIRE_TOP_LEVEL_KEYS) {
      if (!(key in record) || record[key] === undefined) throw new Error(`wire 值缺少顶层键 ${key}`)
    }
    if (record.snapshot === null || typeof record.snapshot !== 'object') throw new Error('wire 值的 snapshot 不是对象')
    const wireRecord = record.snapshot as Record<string, unknown>
    if (wireRecord.initialized !== true) throw new Error('wire 值的 snapshot 丢失 initialized 标记（脏 fixture 未被正确折叠）')
    const roundTrip = JSON.parse(JSON.stringify(view)) as unknown
    if (JSON.stringify(roundTrip) !== JSON.stringify(view)) throw new Error('wire 值 JSON 往返后语义改变')
    result.wireBytes = new TextEncoder().encode(JSON.stringify(view)).length
    result.ok = true
  } catch (error) {
    result.error = toAgentError(error).error
  }
  return result
}

/** 测试用：注入自检结果（传 null 恢复正常自检）。 */
export function setProjectionSelfCheckForTest(override: (() => ProjectionSelfCheckResult) | null): void {
  selfCheckOverride = override
}

/** 最近一次自检结果（未运行过返回 null）。 */
export function lastProjectionSelfCheck(): ProjectionSelfCheckResult | null {
  return lastSelfCheck
}

/** 测试用：重置自检缓存/注入。 */
export function resetProjectionSelfCheckForTest(): void {
  selfCheckOverride = null
  lastSelfCheck = null
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
    // P0-2：注册前自检；失败不注册投影（坏投影不能毒化会话创建），其余功能不受影响。
    const check = selfCheckOverride ? selfCheckOverride() : projectionSelfCheck(() => runtime.isoNow())
    lastSelfCheck = check
    runtime.setProjectionSelfCheck(check)
    if (!check.ok) {
      runtime.markInert(
        '投影自检',
        new Error(check.error ?? '投影自检失败'),
        '会话投影自检失败，已跳过注册（不会影响新建会话）；状态条/面板暂不可用，其余门禁功能不受影响。运行 /flow doctor 查看。',
      )
      runtime.noteFeature('projection', `投影自检失败，未注册投影：${check.error ?? '未知错误'}`)
      return
    }
    const definition = createFlowgateProjection(
      () => runtime.isoNow(),
      () => runtime.projection(),
    )
    const dispose = registry.register(definition)
    if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    runtime.capabilities.sessionProjections = true
    runtime.noteFeature('projection', `已注册会话投影 ${PROJECTION_KEY}（stateVersion=${PROJECTION_STATE_VERSION}，自检通过 ${check.wireBytes ?? 0}B）`)
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
