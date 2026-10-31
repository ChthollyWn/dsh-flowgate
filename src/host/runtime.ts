/**
 * HostRuntime：host 层唯一的"宿主侧状态机"。
 *
 * 职责：
 * 1. 宿主能力探测与降级台账（`capabilities`/`inertReasons`，doctor 输出）；
 * 2. 绑定主会话 → 解析项目根 → 构造并 load FlowEngine（单飞，失败只降级）；
 * 3. 管理引擎生命周期（心跳、会话关闭释放、卸载清理）；
 * 4. 维护会话投影（`flowgate` key）与插件记录写入（appendPluginRecord 优先）；
 * 5. 提供各功能模块共享的工具：安全注册、事件包装、拦截记录、守卫判定缓存。
 *
 * 不变式：本类的任何公开方法都**不得抛到宿主**。预期错误抛 `HostError`
 * 供命令/工具层包装成 {error,hint}；其余异常一律 try/catch + markInert。
 */
import type { DshAgent, DshContext, DshSession } from './adapters/dsh-types.js'
import type {
  EngineLike,
  GuardDecisionEntry,
  HostCapabilities,
  HostConfig,
  HostDeps,
  HostEngineOptions,
  HostModuleInfo,
  HostPorts,
  InertReason,
  SafeModeInfo,
  TakeoverMode,
} from './types.js'
import type { FlowgateProjection, InterceptRow, ProjectionSelfCheckResult } from './projection/types.js'
import { initialProjection } from './projection/types.js'
import { toLosslessJson } from './boundary/json.js'
import { detectSelfHost, effectiveTakeover, resolveSafeMode, safeModeCandidates, takeoverReason } from './mode.js'
import { buildPanel } from './projection/panel.js'
import { EngineUnavailableError, toAgentError, type HostLog } from './errors.js'
import { findProjectRoot, normalizeSlashes } from './adapters/windows-path.js'
import { loadPluginSessionApi, STATE_RECORD_TYPE, FLOWGATE_RECORD_PREFIX, type PluginSessionApi } from './adapters/session-record.js'
import { ensureLedgerKey } from './state/ledger-key.js'
import { isoNow } from '../core/util/time.js'
import { systemClock } from '../core/util/fs.js'
import { sha256Hex } from '../core/util/hash.js'
import type { CallerInfo, CoverageReport, RuntimeSnapshot } from '../core/types.js'
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'

/** 引擎就绪钩子（session/coverage/projection 模块在引擎可用后执行初始化）。 */
export type EngineReadyHook = (agent: DshAgent, engine: EngineLike) => Promise<void> | void

/** 会话关闭钩子（释放租约前的收尾）。 */
export type SessionEndHook = () => Promise<void> | void

/** 宿主服务名 → 本地结构性服务类型（调用方再收窄）。 */
export interface ServiceMap {
  tools: unknown
  commands: unknown
  systemPrompt: unknown
  sessionProjections: unknown
  sessions: unknown
  agents: unknown
  subagents: unknown
  sessionQuery: unknown
  userQuestions: unknown
}

const ALL_CAPABILITIES: HostCapabilities = {
  tools: false,
  toolsGuard: false,
  toolsRestrict: false,
  toolsPresentAs: false,
  toolsExecute: false,
  toolsPostExecute: false,
  commands: false,
  systemPrompt: false,
  sessionProjections: false,
  sessions: false,
  agents: false,
  subagents: false,
  sessionQuery: false,
  userQuestions: false,
  sessionAppend: false,
  sessionAppendPluginRecord: false,
  remote: false,
}

export interface HostRuntimeOptions {
  ctx: DshContext
  config: HostConfig
  deps: HostDeps
  /** 测试注入时钟。 */
  now?: () => Date
}

export class HostRuntime {
  readonly ctx: DshContext
  readonly config: HostConfig
  readonly deps: HostDeps
  readonly capabilities: HostCapabilities
  readonly inertReasons: InertReason[] = []
  readonly intercepts: InterceptRow[] = []
  /** pre-execute 计算、sync guard 消费的判定缓存（callId → 判定）。 */
  readonly guardDecisions = new Map<string, GuardDecisionEntry>()
  /** 功能降级/限制的说明（doctor 输出；键 = 功能名）。 */
  readonly featureNotes: Record<string, string[]> = {}
  /** 已知 agent 身份 → 角色/派发信息（H18/H22；主会话与 FlowGate 派发的子 agent）。 */
  readonly agentRoles = new Map<string, { role: NonNullable<CallerInfo['agentRole']>; dispatch?: CallerInfo['dispatch']; worktree?: string }>()

  private readonly nowFn: () => Date
  private readonly readyHooks: EngineReadyHook[] = []
  private readonly gateAwaitingHooks: Array<(changeId: string, gate: string) => void> = []
  private readonly sessionEndHooks: SessionEndHook[] = []
  private readonly disposers: Array<() => void | Promise<void>> = []
  private readonly stateListeners: Array<(projection: FlowgateProjection) => void> = []

  private engineValue: EngineLike | null = null
  private enginePromise: Promise<EngineLike | null> | null = null
  private portsValue: HostPorts | null = null
  private rootValue: string | null = null
  private mainAgentValue: DshAgent | null = null
  private mainSessionValue: DshSession | null = null
  private revisionValue = 0
  /**
   * 本进程 epoch（写入每条投影记录）。宿主重启后 revision 从 0 重新计数，
   * 投影 apply 靠 epoch 识别"新进程记录"，避免被旧会话日志里更大的 revision 挡住。
   */
  private readonly projectionEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  private projectionValue: FlowgateProjection = initialProjection(isoNow(systemClock))
  private coverageValue: CoverageReport | null = null
  private lastEmitHash = ''
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionApi: PluginSessionApi | null | undefined
  private sessionApiPromise: Promise<PluginSessionApi | null> | null = null
  private pendingProjection: FlowgateProjection | null = null
  private flushingPending = false
  private disposed = false
  private startedAt = isoNow(systemClock)
  /** 会话日志写入模式：`unknown` 未探测、`plugin-record` 用 appendPluginRecord、`session-append` 降级、`none` 不可用。 */
  sessionAppendMode: 'unknown' | 'plugin-record' | 'session-append' | 'none' = 'unknown'
  /** 最近一次引擎快照（供测试与面板兜底）。 */
  lastSnapshot: RuntimeSnapshot | null = null
  /**
   * 上下文占用（contextPct）数据源（projection 模块在 `contextPressure`
   * 投影可用时注册；返回 undefined 表示本帧取不到，绝不编造数字）。P1-7。
   */
  private contextPctSource: (() => number | undefined) | null = null
  /** 累计 token 用量数据源（token-meter 的 tokenUsage 投影，03 §8.2 预算触发器）。 */
  private tokenUsageSource: (() => number | undefined) | null = null
  /** 运行模式缓存（P0-4/P1-7：safe-mode / 自举 / 生效接管模式；guard 与 doctor 读）。 */
  private safeModeInfoValue: SafeModeInfo = { active: false }
  private selfHostValue = false
  private takeoverValue: TakeoverMode = 'enforce'
  private takeoverReasonValue = '默认强制接管'
  private modesResolvedFor: string | null | undefined
  /** 投影启动自检结果（projection 模块在注册前写入；doctor 读取）。 */
  private projectionSelfCheckValue: ProjectionSelfCheckResult | null = null
  /** 模块安装明细（index.ts 的 installIf 写入；doctor 读取）。 */
  private moduleInfoValue: HostModuleInfo[] = []

  constructor(options: HostRuntimeOptions) {
    this.ctx = options.ctx
    this.config = options.config
    this.deps = options.deps
    this.capabilities = { ...ALL_CAPABILITIES }
    this.nowFn = options.now ?? (() => systemClock.now())
    // 构造时就先解析一次运行模式：config.projectRoot 已知时（测试/单仓多项目）
    // 模块安装阶段即可按 safe-mode 跳过；项目根稍后解析到时在 ensureEngine 里重算。
    this.refreshModes(options.config.projectRoot ? nodePath.resolve(options.config.projectRoot) : null)
  }

  // ------------------------------------------------------------------
  // 基础：时钟 / 日志 / 降级台账 / 安全注册
  // ------------------------------------------------------------------

  now(): Date {
    return this.nowFn()
  }

  isoNow(): string {
    return isoNow({ now: () => this.nowFn() })
  }

  log: HostLog = (level, message) => {
    if (this.deps.log) {
      this.deps.log(level, message)
      return
    }
    try {
      const logger = this.ctx.logger
      if (!logger) return
      const line = `[flowgate] ${message}`
      if (level === 'error') logger.error(line)
      else if (level === 'warn') logger.warn(line)
      else if (level === 'info') logger.info(line)
      else logger.debug(line)
    } catch {
      // 日志失败不影响主流程。
    }
  }

  /** 记录一条"功能未生效/降级"的原因；同一 stage 只保留最新一条。 */
  markInert(stage: string, error: unknown, hint?: string): void {
    const info = toAgentError(error)
    const reason: InertReason = {
      at: this.isoNow(),
      stage,
      message: hint ?? info.error,
      hint: info.hint,
    }
    const existing = this.inertReasons.findIndex((item) => item.stage === stage)
    if (existing >= 0) this.inertReasons[existing] = reason
    else this.inertReasons.push(reason)
    this.log('warn', `${stage} 已降级：${reason.message}`)
  }

  /** 同步安全执行：失败记录降级并返回 undefined。 */
  safe<T>(stage: string, fn: () => T): T | undefined {
    if (this.disposed) return undefined
    try {
      return fn()
    } catch (error) {
      this.markInert(stage, error)
      return undefined
    }
  }

  /** 异步安全执行。 */
  async safeAsync<T>(stage: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (this.disposed) return undefined
    try {
      return await fn()
    } catch (error) {
      this.markInert(stage, error)
      return undefined
    }
  }

  /** 注册一个宿主事件监听器（自身 try/catch，异常只降级）。 */
  on(name: string, listener: (...args: any[]) => unknown): () => void {
    if (this.disposed) return () => {}
    return this.safe(`事件监听 ${name}`, () => {
      const dispose = this.ctx.on(name, (...args: any[]) => {
        try {
          return listener(...args)
        } catch (error) {
          this.markInert(`事件监听 ${name}`, error)
          return undefined
        }
      })
      const wrapped = (): void => {
        try {
          dispose?.()
        } catch {
          // 忽略。
        }
      }
      this.disposers.push(wrapped)
      return wrapped
    }) ?? (() => {})
  }

  /** 在指定（可能 scoped）ctx 上注册事件监听，同样自带 try/catch。 */
  onScoped(scoped: DshContext | null | undefined, name: string, listener: (...args: any[]) => unknown): () => void {
    if (!scoped || typeof scoped.on !== 'function') return () => {}
    return this.safe(`事件监听 ${name}`, () => {
      const dispose = scoped.on(name, (...args: any[]) => {
        try {
          return listener(...args)
        } catch (error) {
          this.markInert(`事件监听 ${name}`, error)
          return undefined
        }
      })
      const wrapped = (): void => {
        try {
          dispose?.()
        } catch {
          // 忽略。
        }
      }
      this.disposers.push(wrapped)
      return wrapped
    }) ?? (() => {})
  }

  /** 记录/查询 agent 角色（H18：guard 用 exec.agent 区分主会话与子 agent）。 */
  registerAgentRole(
    id: string,
    role: NonNullable<CallerInfo['agentRole']>,
    dispatch?: CallerInfo['dispatch'],
    worktree?: string,
  ): void {
    this.agentRoles.set(id, { role, dispatch, worktree })
  }

  roleOf(id: string | undefined): { role: NonNullable<CallerInfo['agentRole']>; dispatch?: CallerInfo['dispatch']; worktree?: string } {
    if (!id) return { role: 'unknown' }
    return this.agentRoles.get(id) ?? { role: 'unknown' }
  }

  /** 当前主会话是否处于受管状态（同步、无 IO，供 sync guard 快速判断）。 */
  isManagedNow(): boolean {
    if (!this.isEnabled()) return false
    if (!this.engineValue) return false
    const snapshot = this.lastSnapshot
    if (!snapshot) return true // 引擎已构造但尚未 emit：保守视为受管。
    return snapshot.initialized
  }

  /**
   * 可选服务挂载：服务出现时才执行（服务替换会重新执行），失败只降级。
   * 回调拿到的 scoped ctx 与根 ctx 行为一致（cordis `ctx.inject` 语义）。
   */
  injectService(name: keyof HostCapabilities & string, callback: (scoped: DshContext) => void): void {
    if (this.disposed) return
    this.safe(`挂载 ${name}`, () => {
      this.ctx.inject([name], (scoped) => {
        if (this.disposed) return
        try {
          callback(scoped)
          if (this.getService(name) !== null) this.capabilities[name] = true
        } catch (error) {
          this.markInert(`挂载 ${name}`, error, `FlowGate 的 ${name} 功能已降级；其余功能不受影响。`)
        }
        return undefined
      })
    })
  }

  /** 读取服务（不存在返回 null，不抛错）。 */
  getService<T>(name: string): T | null {
    try {
      const service = this.ctx.get(name)
      return (service as T | undefined) ?? null
    } catch {
      return null
    }
  }

  /** 注册一个随插件卸载释放的清理函数。 */
  /** 记录一条功能级说明（doctor 输出）。 */
  noteFeature(key: string, message: string): void {
    const list = this.featureNotes[key] ?? (this.featureNotes[key] = [])
    if (!list.includes(message) && list.length < 20) list.push(message)
  }

  registerDisposer(dispose: () => void | Promise<void>): void {
    this.disposers.push(dispose)
  }

  registerStateListener(listener: (projection: FlowgateProjection) => void): () => void {
    this.stateListeners.push(listener)
    return () => {
      const index = this.stateListeners.indexOf(listener)
      if (index >= 0) this.stateListeners.splice(index, 1)
    }
  }

  registerEngineReadyHook(hook: EngineReadyHook): void {
    this.readyHooks.push(hook)
  }

  registerSessionEndHook(hook: SessionEndHook): void {
    this.sessionEndHooks.push(hook)
  }

  /** 人工门进入"等待负责人批准"时的通知钩子（gates 模块用来 inject 给 agent）。 */
  registerGateAwaitingHook(hook: (changeId: string, gate: string) => void): void {
    this.gateAwaitingHooks.push(hook)
  }

  isEnabled(): boolean {
    return this.config.enabled !== false && !this.disposed
  }

  startedAtIso(): string {
    return this.startedAt
  }

  // ------------------------------------------------------------------
  // 运行模式（P0-4：safe-mode / 自举观察 / 接管模式）
  // ------------------------------------------------------------------

  /** 重新解析 safe-mode / 自举 / 生效接管模式（项目根变化时调用）。 */
  private refreshModes(root: string | null): void {
    const safe = resolveSafeMode({ deps: this.deps, config: this.config, root })
    this.safeModeInfoValue = safe
    this.selfHostValue = this.config.selfHost ?? (root ? detectSelfHost(root) : false)
    this.takeoverValue = effectiveTakeover(this.config, { selfHost: this.selfHostValue, safe: safe.active })
    this.takeoverReasonValue = takeoverReason(this.config, {
      selfHost: this.selfHostValue,
      safe: safe.active,
      safeMode: safe,
    })
    this.modesResolvedFor = root
  }

  isSafeMode(): boolean {
    return this.safeModeInfoValue.active
  }

  safeModeInfo(): SafeModeInfo {
    return { ...this.safeModeInfoValue }
  }

  /** safe-mode sentinel 实际读取的候选路径（doctor 展示，避免"写了不生效"）。 */
  safeModePaths(): string[] {
    return safeModeCandidates({ deps: this.deps, root: this.rootValue ?? this.config.projectRoot ?? null })
  }

  isSelfHost(): boolean {
    return this.selfHostValue
  }

  /** 生效接管模式（safe→off；显式配置优先；自举→observe；默认 enforce）。 */
  enforcement(): TakeoverMode {
    return this.takeoverValue
  }

  /** 生效接管模式的原因（doctor 展示）。 */
  enforcementReason(): string {
    return this.takeoverReasonValue
  }

  /** 本次进程的宿主 epoch（写进投影记录；同时传给 core 用于 autoRearm）。 */
  hostEpoch(): string {
    return this.projectionEpoch
  }

  /** projection 模块在注册前写入自检结果（doctor 读取）。 */
  setProjectionSelfCheck(result: ProjectionSelfCheckResult): void {
    this.projectionSelfCheckValue = result
  }

  projectionSelfCheck(): ProjectionSelfCheckResult | null {
    return this.projectionSelfCheckValue
  }

  /** index.ts 安装结束后写入模块明细（doctor 读取）。 */
  setModuleInfo(modules: HostModuleInfo[]): void {
    this.moduleInfoValue = modules.map((module) => ({ ...module }))
  }

  moduleInfo(): HostModuleInfo[] {
    return this.moduleInfoValue.map((module) => ({ ...module }))
  }

  // ------------------------------------------------------------------
  // 主会话绑定与引擎生命周期
  // ------------------------------------------------------------------

  mainAgent(): DshAgent | null {
    return this.mainAgentValue
  }

  mainSession(): DshSession | null {
    return this.mainSessionValue
  }

  engine(): EngineLike | null {
    return this.engineValue
  }

  /** 取引擎；没有则抛 HostError（调用方负责包装成 {error,hint}）。 */
  requireEngine(): EngineLike {
    if (!this.engineValue) throw new EngineUnavailableError()
    return this.engineValue
  }

  root(): string | null {
    return this.rootValue
  }

  ports(): HostPorts | null {
    return this.portsValue
  }

  /** 仓库相对路径 → 宿主绝对路径。 */
  absolute(repoRelative: string): string {
    const root = this.rootValue
    if (!root) return repoRelative
    return nodePath.resolve(root, normalizeSlashes(repoRelative))
  }

  /** 绑定主会话（`agent/created` 的第一个根 agent）。重复/多主会话只记录降级。 */
  bindMainAgent(agent: DshAgent): void {
    if (this.disposed || !this.isEnabled()) return
    const session = agent.session
    if (!session) return
    const header = session.header ?? { id: agent.id }
    const isChild = header.origin === 'subagent' || header.parentSession !== undefined || (header.delegationDepth ?? 0) > 0
    if (isChild) return
    if (this.mainAgentValue !== null) {
      if (String(this.mainAgentValue.id) === String(agent.id)) return
      // 一个进程里只服务一个主会话：后续会话的记录型能力不生效（命令/工具仍可按需懒绑定）。
      this.markInert(
        '多主会话',
        new Error(`已绑定会话 ${String(this.mainAgentValue.id)}，忽略新主会话 ${String(agent.id)}`),
        'FlowGate 一个宿主进程只跟踪一个主会话；请在同一个会话里使用 /flow。',
      )
      return
    }
    this.mainAgentValue = agent
    this.mainSessionValue = session
    void this.ensureEngine().catch((error: unknown) => this.markInert('引擎初始化', error))
  }

  /** 单飞初始化引擎；失败返回 null（已记入 inertReasons）。 */
  async ensureEngine(agent?: DshAgent): Promise<EngineLike | null> {
    if (this.engineValue) return this.engineValue
    if (this.enginePromise) return this.enginePromise
    const target = agent ?? this.mainAgentValue
    if (!target) return null
    const promise = this.createEngineFor(target)
    this.enginePromise = promise
    try {
      return await promise
    } finally {
      this.enginePromise = null
    }
  }

  private async createEngineFor(agent: DshAgent): Promise<EngineLike | null> {
    try {
      const root = this.resolveProjectRoot(agent)
      this.rootValue = root
      // 项目根解析出来后重算运行模式（项目级 safe-mode sentinel / 自举检测依赖它）。
      if (this.modesResolvedFor !== root) this.refreshModes(root)
      const ports = this.deps.createPorts(root)
      this.portsValue = ports
      const keyPath =
        this.config.ledgerKeyPath ?? nodePath.join(this.deps.homeDir(), '.dsh', 'flowgate', 'ledger.key')
      const ledgerKey = await ensureLedgerKey(keyPath, { randomKeyHex: (bytes) => this.deps.randomKeyHex(bytes) })
      const sessionId = String(agent.id)
      const sessionLabel = this.sessionLabelOf(agent)
      // v0.5.1：接管模式与 hostEpoch 在构造引擎前确定（core 只读）；
      // HostEngineOptions 是 EngineOptions 的扩展（core 落地前也能编译）。
      const engineOptions: HostEngineOptions = {
        root,
        fs: ports.fs,
        clock: systemClock,
        git: ports.git,
        commandRunner: ports.commandRunner,
        pluginVersion: this.deps.pluginVersion,
        ledgerKey,
        userStateDir: nodePath.dirname(keyPath),
        sessionId,
        sessionLabel,
        sessionAppend: (type, data) => {
          void this.appendLedgerRecord(type, data)
        },
        onStateChange: (snapshot) => this.onEngineState(snapshot),
        takeover: this.enforcement(),
        hostEpoch: this.projectionEpoch,
        host: {
          onEvidence: (receipt) => {
            this.log('debug', `证据回执 ${receipt.id}（${receipt.phase}）已记录`)
          },
          onAwaitingOwner: (change, gate) => {
            this.log('info', `${change.id} 的人工门 ${gate} 等待负责人批准`)
            this.emit()
            for (const hook of this.gateAwaitingHooks) {
              try {
                hook(change.id, gate)
              } catch (error) {
                this.markInert('人工门通知', error)
              }
            }
          },
        },
      }
      const engine = this.deps.createEngine(engineOptions)
      this.engineValue = engine
      await engine.load()
      this.capabilities.engine = true
      for (const hook of this.readyHooks) {
        try {
          await hook(agent, engine)
        } catch (error) {
          this.markInert('引擎就绪回调', error)
        }
      }
      this.emit()
      return engine
    } catch (error) {
      this.engineValue = null
      this.markInert(
        '引擎初始化',
        error instanceof Error ? error : new Error(String(error)),
        `FlowGate 引擎初始化失败：${toAgentError(error).error}。项目内状态文件可能损坏，运行 /flow doctor 诊断。`,
      )
      return null
    }
  }

  /** 会话工作目录 → 最近的项目根（无 `.flowgate/` 时用工作目录本身，供 /flow init）。 */
  private resolveProjectRoot(agent: DshAgent): string {
    if (this.config.projectRoot) return nodePath.resolve(this.config.projectRoot)
    const header = agent.session?.header
    const cwd = header?.cwd && header.cwd.trim() !== '' ? header.cwd : process.cwd()
    const root = findProjectRoot(cwd, '.flowgate/config.yaml', (candidate) => existsSync(candidate))
    return nodePath.resolve(root)
  }

  private sessionLabelOf(agent: DshAgent): string {
    const preset = agent.session?.header?.agentPreset
    const id = String(agent.id)
    const short = id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
    return preset ? `${preset}:${short}` : short
  }

  private onEngineState(snapshot: RuntimeSnapshot): void {
    this.lastSnapshot = snapshot
    this.emit()
  }

  /** 引擎初始化完成后的公共初始化入口（session 模块使用）。 */
  async sessionStartTimer(): Promise<void> {
    const engine = this.engineValue
    if (!engine || this.heartbeatTimer) return
    let leaseMinutes = 10
    try {
      leaseMinutes = engine.getConfig().session.lease_minutes
    } catch {
      // 用默认值。
    }
    const intervalMs = Math.max(30_000, Math.round((leaseMinutes * 60_000) / 3))
    this.heartbeatTimer = setInterval(() => {
      const current = this.engineValue
      if (!current) return
      void current.heartbeat().catch((error: unknown) => {
        this.log('warn', `租约心跳失败：${toAgentError(error).error}`)
      })
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** `session/disposed`：释放租约、停止心跳、复位绑定（崩溃时由超时兜底）。 */
  async handleSessionDisposed(session: DshSession): Promise<void> {
    if (!this.mainSessionValue || String(this.mainSessionValue.id) !== String(session.id)) return
    for (const hook of this.sessionEndHooks) {
      try {
        await hook()
      } catch (error) {
        this.markInert('会话关闭清理', error)
      }
    }
    this.stopHeartbeat()
    const engine = this.engineValue
    if (engine) {
      try {
        await engine.releaseSession()
      } catch (error) {
        this.log('warn', `释放租约失败：${toAgentError(error).error}`)
      }
    }
    this.engineValue = null
    this.enginePromise = null
    this.mainAgentValue = null
    this.mainSessionValue = null
    this.guardDecisions.clear()
  }

  /** 卸载：停止心跳、尽力释放租约、执行所有清理函数。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopHeartbeat()
    const engine = this.engineValue
    if (engine) {
      try {
        await engine.releaseSession()
      } catch {
        // 卸载阶段的失败只记录，不影响宿主。
      }
    }
    this.engineValue = null
    this.enginePromise = null
    const disposers = this.disposers.splice(0, this.disposers.length)
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // 忽略清理失败。
      }
    }
    this.stateListeners.length = 0
    this.guardDecisions.clear()
  }

  // ------------------------------------------------------------------
  // 会话投影
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 上下文占用（contextPct；DSH `contextPressure` 会话投影，P1-7）
  // ------------------------------------------------------------------

  /**
   * 安装/卸下 contextPct 数据源（projection 模块调用）。数据源同步读取宿主
   * 投影；取不到时返回 undefined，投影保持无字段——绝不编造数字，也不因
   * 宿主缺投影而降级插件其他功能。
   */
  setContextPctSource(source: (() => number | undefined) | null): void {
    this.contextPctSource = source
  }

  /** 安装/卸下累计 token 用量数据源（projection 模块调用）。 */
  setTokenUsageSource(source: (() => number | undefined) | null): void {
    this.tokenUsageSource = source
  }

  /** 当前会话累计 token 用量；无投影/读取异常时 undefined（不编造）。 */
  tokenUsage(): number | undefined {
    const source = this.tokenUsageSource
    if (!source) return undefined
    try {
      const value = source()
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 当前上下文占用百分比（0–100）；无投影/未采样/读取异常时 undefined。 */
  contextPct(): number | undefined {
    const source = this.contextPctSource
    if (!source) return undefined
    try {
      const value = source()
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 投影用快照：有 contextPct 时附加可选字段，无值时保持原引用/形状。 */
  private snapshotWithContext(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const contextPct = this.contextPct()
    return contextPct === undefined ? snapshot : { ...snapshot, contextPct }
  }

  projection(): FlowgateProjection {
    return this.projectionValue
  }

  /** 引擎状态变化 → 重建投影负载并写入会话日志（重复内容不 bump revision）。 */
  emit(): void {
    if (this.disposed) return
    const engine = this.engineValue
    if (!engine) return
    // 预算触发器：token-meter 可用时把累计用量上报给引擎（超预算会生成 RK 并暂停写操作）。
    const tokensUsed = this.tokenUsage()
    // 假引擎/旧注入可能没有该方法：预算触发器是可选增强，不能影响投影。
    if (tokensUsed !== undefined && typeof engine.recordTokenUsage === 'function') {
      void engine.recordTokenUsage(tokensUsed).catch(() => undefined)
    }
    try {
      const rawSnapshot = engine.snapshot()
      this.lastSnapshot = rawSnapshot
      // 上下文占用只在投影/状态条里展示，不写回引擎快照；取不到就不加字段。
      const snapshot = this.snapshotWithContext(rawSnapshot)
      const now = this.isoNow()
      let panel
      try {
        panel = buildPanel({ engine, intercepts: this.intercepts, dashboardPath: '.flowgate/dashboard.html', now })
      } catch {
        panel = undefined
      }
      const contentHash = sha256Hex(
        JSON.stringify({
          snapshot: snapshotForHash(snapshot),
          panel: panel ?? null,
        }),
      )
      if (contentHash === this.lastEmitHash) return
      this.lastEmitHash = contentHash
      this.revisionValue += 1
      const projection: FlowgateProjection = {
        snapshot,
        panel,
        revision: this.revisionValue,
        updatedAt: now,
        epoch: this.projectionEpoch,
      }
      this.projectionValue = projection
      for (const listener of this.stateListeners) {
        try {
          listener(projection)
        } catch {
          // 监听器失败不影响投影。
        }
      }
      this.queueProjectionAppend(projection)
    } catch (error) {
      this.setNoThrowInert('投影更新', error)
    }
  }

  /** 不抛错的 markInert（emit 内部使用）。 */
  private setNoThrowInert(stage: string, error: unknown): void {
    try {
      this.markInert(stage, error)
    } catch {
      // 忽略。
    }
  }

  /**
   * 把投影负载写成插件记录（`plugin:dsh-flowgate/state`），供投影 `apply` 折叠。
   * `appendSessionEvent` 内部缓存了 API 探测结果，后续调用无额外开销。
   */
  private queueProjectionAppend(projection: FlowgateProjection): void {
    if (this.sessionAppendMode === 'none') return
    if (this.sessionAppendMode === 'plugin-record' || this.sessionAppendMode === 'session-append') {
      void this.appendSessionEvent(STATE_RECORD_TYPE, projection as unknown as Record<string, unknown>)
      return
    }
    // 会话 API 仍在探测：先记住最新一条，探测完成后补写，避免首帧投影丢失。
    this.pendingProjection = projection
    if (this.flushingPending) return
    this.flushingPending = true
    void this.ensureSessionApi().finally(() => {
      this.flushingPending = false
      const queued = this.pendingProjection
      this.pendingProjection = null
      if (queued) void this.appendSessionEvent(STATE_RECORD_TYPE, queued as unknown as Record<string, unknown>)
    })
  }

  /** 单飞加载会话 API（缓存成功/失败结果）。 */
  private ensureSessionApi(): Promise<PluginSessionApi | null> {
    if (this.sessionApi !== undefined) return Promise.resolve(this.sessionApi)
    if (!this.sessionApiPromise) {
      this.sessionApiPromise = loadPluginSessionApi().then((api) => {
        this.sessionApi = api
        return api
      })
    }
    return this.sessionApiPromise
  }

  /**
   * 写一条插件记录到主会话日志（只走 `appendPluginRecord`）。
   * 该 API 不可用时标记 `none`：投影只在内存中（client 投影有 latest-snapshot
   * 兜底），绝不降级 `session.append` —— rc.5 会把未声明类型持久化成语义不完整的
   * SessionEvent，下次加载时报 "lacks an identified message" 并让会话损坏。
   */
  async appendSessionEvent(type: string, data: Record<string, unknown>): Promise<boolean> {
    const session = this.mainSessionValue
    if (!session) return false
    const api = await this.ensureSessionApi()
    if (api && this.sessionAppendMode !== 'session-append') {
      try {
        // Plugin records must be *losslessly JSON*: 统一走 host 边界（P0-1）。
        const safeData = toLosslessJson(data)
        api.appendPluginRecord(session, normalizeRecordType(type), safeData)
        this.sessionAppendMode = 'plugin-record'
        this.capabilities.sessionAppend = true
        this.capabilities.sessionAppendPluginRecord = true
        return true
      } catch (error) {
        this.capabilities.sessionAppendPluginRecord = false
        this.log('debug', `appendPluginRecord 不可用（不降级 session.append，投影退回内存快照）：${toAgentError(error).error}`)
      }
    }
    // NOTE: do NOT fall back to session.append() with an undeclared event type.
    // rc.5 persists it as a SessionEvent that fails message-identity validation on
    // the next load ("session event at seq N lacks an identified message"), which
    // corrupts the stored session. When appendPluginRecord is unavailable we keep
    // the projection in memory only; the client-side projection fallback refreshes
    // it from the host's latest snapshot on every committed event.
    {
      this.sessionAppendMode = 'none'
      this.capabilities.sessionAppend = false
      this.markInert(
        '会话事件写入',
        new Error('appendPluginRecord unavailable'),
        '当前宿主不允许插件写自定义会话事件：状态条/面板改为每次打开时读取，其他门禁功能不受影响。',
      )
      return false
    }
  }

  /** 引擎账本事件 → 会话日志记录（错误不抛出）。 */
  async appendLedgerRecord(type: string, data: Record<string, unknown>): Promise<void> {
    const session = this.mainSessionValue
    if (!session) return
    try {
      const api = await this.ensureSessionApi()
      if (!api) return // never session.append() an undeclared type (would corrupt the session log)
      const safe = toLosslessJson({ type, data, at: this.isoNow() })
      api.appendPluginRecord(session, `${FLOWGATE_RECORD_PREFIX}ledger`, safe)
    } catch {
      // 账本事件写会话日志失败只降级，不影响 .flowgate/ledger.jsonl。
    }
  }

  // ------------------------------------------------------------------
  // 拦截记录与守卫判定缓存
  // ------------------------------------------------------------------

  addIntercept(record: InterceptRow): void {
    this.intercepts.push(record)
    if (this.intercepts.length > 100) this.intercepts.splice(0, this.intercepts.length - 100)
  }

  putGuardDecision(entry: GuardDecisionEntry): void {
    this.guardDecisions.set(entry.callId, entry)
    if (this.guardDecisions.size > 256) this.cleanupGuardDecisions()
  }

  takeGuardDecision(callId: string): GuardDecisionEntry | undefined {
    const entry = this.guardDecisions.get(callId)
    if (entry) this.guardDecisions.delete(callId)
    return entry
  }

  cleanupGuardDecisions(maxAgeMs = 60_000): void {
    const threshold = this.now().getTime() - maxAgeMs
    for (const [key, entry] of this.guardDecisions) {
      if (entry.at < threshold) this.guardDecisions.delete(key)
    }
  }

  // ------------------------------------------------------------------
  // 覆盖自检缓存
  // ------------------------------------------------------------------

  setCoverage(report: CoverageReport | null): void {
    this.coverageValue = report
    try {
      this.engineValue?.setCoverage(report as CoverageReport)
    } catch {
      // 忽略。
    }
  }

  coverage(): CoverageReport | null {
    return this.coverageValue
  }

  /** 宿主能力 + 引擎状态的 doctor 摘要（doctor 模块使用）。 */
  capabilitySnapshot(): HostCapabilities {
    return { ...this.capabilities }
  }

  /** 测试/诊断：等待引擎就绪（最多 timeoutMs）。 */
  async waitForEngine(timeoutMs = 5_000): Promise<EngineLike | null> {
    if (this.engineValue) return this.engineValue
    if (!this.enginePromise) {
      if (!this.mainAgentValue) return null
      return this.ensureEngine()
    }
    return Promise.race([
      this.enginePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.()),
    ])
  }
}

/** 归一化插件记录类型：只保留 `plugin:<小写字母数字/->` 形态。 */
export function normalizeRecordType(type: string): string {
  if (type.startsWith('plugin:')) return type
  const slug = type
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${FLOWGATE_RECORD_PREFIX}${slug === '' ? 'event' : slug}`
}

/** 快照哈希时剔除易变字段，避免每次 emit 都因时间戳变化而重复写日志。 */
function snapshotForHash(snapshot: RuntimeSnapshot): object {
  return { ...snapshot, statusLine: snapshot.statusLine, nextStep: snapshot.nextStep, updatedAt: '' }
}

// 默认导出便于测试构造。
export default HostRuntime
