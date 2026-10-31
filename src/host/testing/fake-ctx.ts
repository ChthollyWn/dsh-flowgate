/**
 * 假宿主 ctx 与依赖装配（test/host/** 使用）。
 *
 * 目标：让 host 层在不启动 DSH、不碰真实 core 的情况下单测：
 * - 假 Cordis ctx：`inject`/`on`/`effect`/`get` 的最小实现，事件可手动触发；
 * - 假服务：tools（含 guard/restrict/presentAs/schemas）、commands、
 *   systemPrompt、sessionProjections、subagents、sessionQuery、sessions；
 * - 假 agent/session：记录 inject/steer 与 append 的事件；
 * - 假 engine：可注入 evaluateAction 结果、记录所有调用；
 * - 假 HostDeps：MemoryFileSystem + 假 git/runner + 假 core 分类器。
 *
 * 约定：本文件只依赖 `src/core/**` 的类型与 MemoryFileSystem（测试无需跑真实引擎）。
 */
import type {
  DshAgent,
  DshCommandDefinition,
  DshCommandRuntime,
  DshContext,
  DshListener,
  DshLogger,
  DshProjectionDefinition,
  DshProjectionSchemaLike,
  DshSession,
  DshSessionProjectionRegistry,
  DshSubagentActivation,
  DshSubagentRuntime,
  DshToolDefinition,
  DshToolGuard,
  DshToolRestriction,
  DshToolRuntime,
  DshToolSchema,
  DshUserMessage,
} from '../adapters/dsh-types.js'
import type { CoreBridge, HostDeps, HostPorts } from '../types.js'
import type { EngineOptions, FlowEngine } from '../../core/engine.js'
import type {
  Action,
  Decision,
  FlowgateConfig,
  IncidentRecord,
  ProjectFlags,
  RepairRecord,
  RuntimeSnapshot,
  TakeoverMode,
  TestSummary,
} from '../../core/types.js'
import { MemoryFileSystem } from '../../core/util/memory-fs.js'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import * as fsp from 'node:fs/promises'

// ---------------------------------------------------------------------------
// 事件总线
// ---------------------------------------------------------------------------

export interface FakeContextOptions {
  services?: Record<string, unknown>
  /** 哪些服务存在（用于 ctx.inject 的可用性判断）。 */
  available?: string[]
}

export interface FakeContext extends DshContext {
  /** 触发 emit 类事件（同步调用所有监听器）。 */
  emitEvent(name: string, ...args: unknown[]): void
  /** 触发 waterfall 事件（从后往前串 next）。 */
  runWaterfall(name: string, args: unknown[], final: () => Promise<unknown>): Promise<unknown>
  listenersOf(name: string): DshListener[]
}

function createEventBus(): {
  listeners: Map<string, DshListener[]>
  on(name: string, listener: DshListener): () => void
  emitEvent(name: string, ...args: unknown[]): void
  runWaterfall(name: string, args: unknown[], final: () => Promise<unknown>): Promise<unknown>
} {
  const listeners = new Map<string, DshListener[]>()
  const on = (name: string, listener: DshListener): (() => void) => {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => {
      const current = listeners.get(name) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }
  const emitEvent = (name: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(name) ?? [])]) {
      try {
        void listener(...args)
      } catch {
        // 测试里的事件监听器异常不应中断。
      }
    }
  }
  const runWaterfall = async (name: string, args: unknown[], final: () => Promise<unknown>): Promise<unknown> => {
    const list = [...(listeners.get(name) ?? [])]
    let next = final
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const listener = list[index]
      if (!listener) continue
      const downstream = next
      next = () => Promise.resolve(listener(...args, downstream))
    }
    return await next()
  }
  return { listeners, on, emitEvent, runWaterfall }
}

/** 创建假 ctx（含可选服务；服务名单决定 inject 是否立即执行回调）。 */
export function createFakeContext(options: FakeContextOptions = {}): FakeContext {
  const services = options.services ?? {}
  const available = new Set(options.available ?? Object.keys(services))
  const bus = createEventBus()
  const effects: Array<() => void> = []
  const injected: string[][] = []
  const loggerMessages: { level: string; message: string }[] = []
  const logger: DshLogger = {
    debug: (...args) => loggerMessages.push({ level: 'debug', message: String(args[0] ?? '') }),
    info: (...args) => loggerMessages.push({ level: 'info', message: String(args[0] ?? '') }),
    warn: (...args) => loggerMessages.push({ level: 'warn', message: String(args[0] ?? '') }),
    error: (...args) => loggerMessages.push({ level: 'error', message: String(args[0] ?? '') }),
  }
  const ctx = {
    logger,
    get(name: string): unknown {
      return available.has(name) ? services[name] : undefined
    },
    provide(): () => void {
      return () => {}
    },
    effect(callback: () => unknown): () => void {
      const result = callback()
      const dispose = typeof result === 'function' ? (result as () => void) : () => {}
      effects.push(dispose)
      return dispose
    },
    inject(deps: string | string[], callback: (scoped: DshContext) => unknown): unknown {
      const names = Array.isArray(deps) ? deps : [deps]
      injected.push([...names])
      if (!names.every((name) => available.has(name))) return undefined
      return callback(ctx as unknown as DshContext)
    },
    on: bus.on,
    once(name: string, listener: DshListener): () => void {
      const dispose = bus.on(name, (...args: unknown[]) => {
        dispose()
        return listener(...args)
      })
      return dispose
    },
    emit(): void {},
  } as unknown as FakeContext
  ctx.listenersOf = (name: string) => [...(bus.listeners.get(name) ?? [])]
  ctx.emitEvent = bus.emitEvent
  ctx.runWaterfall = bus.runWaterfall
  ;(ctx as unknown as { _injected: string[][] })._injected = injected
  ;(ctx as unknown as { _effects: (() => void)[] })._effects = effects
  ;(ctx as unknown as { _logger: typeof loggerMessages })._logger = loggerMessages
  return ctx
}

/** 读取假 ctx 上注入过的服务名（测试断言用）。 */
export function injectedServices(ctx: FakeContext): string[][] {
  return (ctx as unknown as { _injected: string[][] })._injected ?? []
}

/** 读取假 ctx 的日志。 */
export function loggedMessages(ctx: FakeContext): { level: string; message: string }[] {
  return (ctx as unknown as { _logger: { level: string; message: string }[] })._logger ?? []
}

/** 卸载：执行所有 effect disposer。 */
export async function disposeFakeContext(ctx: FakeContext): Promise<void> {
  const effects = ((ctx as unknown as { _effects: (() => void)[] })._effects ?? []).slice().reverse()
  for (const dispose of effects) {
    try {
      dispose()
    } catch {
      // 忽略。
    }
  }
}

// ---------------------------------------------------------------------------
// 假服务
// ---------------------------------------------------------------------------

export interface FakeToolRuntime extends DshToolRuntime {
  state: {
    tools: Map<string, DshToolDefinition>
    guards: DshToolGuard[]
    restrictions: DshToolRestriction[]
    presentations: string[]
    schemasList: DshToolSchema[]
  }
}

export function createFakeToolRuntime(options: { schemas?: DshToolSchema[]; missing?: ('guard' | 'restrict' | 'presentAs' | 'schemas')[] } = {}): FakeToolRuntime {
  const missing = new Set(options.missing ?? [])
  const state: FakeToolRuntime['state'] = {
    tools: new Map(),
    guards: [],
    restrictions: [],
    presentations: [],
    schemasList: options.schemas ?? [],
  }
  const runtime = {
    state,
    register(definition: DshToolDefinition): () => void {
      if (state.tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      state.tools.set(definition.name, definition)
      return () => state.tools.delete(definition.name)
    },
    guard(guard: DshToolGuard): () => void {
      if (missing.has('guard')) throw new Error('guard unavailable')
      state.guards.push(guard)
      return () => {
        const index = state.guards.indexOf(guard)
        if (index >= 0) state.guards.splice(index, 1)
      }
    },
    restrict(filter: DshToolRestriction): () => void {
      if (missing.has('restrict')) throw new Error('restrict unavailable')
      const known = new Set(state.schemasList.map((schema) => schema.name))
      for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
        if (!known.has(name)) throw new Error(`unknown global tool "${name}"`)
      }
      state.restrictions.push(filter)
      return () => {
        const index = state.restrictions.indexOf(filter)
        if (index >= 0) state.restrictions.splice(index, 1)
      }
    },
    presentAs(mode: 'native' | 'ptc'): () => void {
      if (missing.has('presentAs')) throw new Error('presentAs unavailable')
      state.presentations.push(mode)
      return () => {
        const index = state.presentations.indexOf(mode)
        if (index >= 0) state.presentations.splice(index, 1)
      }
    },
    schemas(): DshToolSchema[] {
      if (missing.has('schemas')) throw new Error('schemas unavailable')
      return [...state.schemasList]
    },
    get(name: string): DshToolDefinition | undefined {
      return state.tools.get(name)
    },
  } as unknown as FakeToolRuntime
  return runtime
}

export interface FakeCommandRuntime extends DshCommandRuntime {
  state: { commands: Map<string, DshCommandDefinition> }
}

export function createFakeCommandRuntime(opts: { missing?: boolean } = {}): FakeCommandRuntime {
  const state: FakeCommandRuntime['state'] = { commands: new Map() }
  return {
    state,
    register(definition: DshCommandDefinition): () => void {
      if (opts.missing) throw new Error('commands.register unavailable')
      if (state.commands.has(definition.name)) throw new Error(`duplicate command ${definition.name}`)
      state.commands.set(definition.name, definition)
      return () => state.commands.delete(definition.name)
    },
  } as unknown as FakeCommandRuntime
}

export interface FakeSystemPromptService {
  state: { sections: Map<string, { name: string; order: number; text: unknown }> }
  section(section: { name: string; order: number; text: unknown }): () => void
  getSectionOrder(name: string): number
}

export function createFakeSystemPrompt(): FakeSystemPromptService {
  const state: FakeSystemPromptService['state'] = { sections: new Map() }
  return {
    state,
    section(section): () => void {
      state.sections.set(section.name, section)
      return () => state.sections.delete(section.name)
    },
    getSectionOrder(): number {
      return 9000
    },
  }
}

export interface FakeProjectionRegistryState {
  definitions: Map<string, DshProjectionDefinition<string, unknown>>
  /** `snapshot()` 返回的 client-visible wire 值（如 token-meter 的 contextPressure）。 */
  values: Record<string, unknown>
  /** `stateOf()` 返回的 host-only state（缺省回落到 `values`）。 */
  states: Record<string, unknown>
  /** 已注册的变更监听器（`emitChange` 用）。 */
  listeners: Set<(session: DshSession, key: string, value: unknown, seq: unknown) => void>
}

export interface FakeProjectionRegistryOptions {
  /**
   * client-visible 投影值：模拟 token-meter 等域插件注册的 wire 单元
   * （例如 `{ contextPressure: { projectedTokens: 120000, contextWindow: 200000 } }`）。
   */
  values?: Record<string, unknown>
  /** host-only state；不传时 `stateOf()` 读 `values`。 */
  states?: Record<string, unknown>
}

export interface FakeProjectionRegistry extends DshSessionProjectionRegistry {
  state: FakeProjectionRegistryState
  /** 触发一次投影变更通知（模拟 token-meter 更新 contextPressure）。 */
  emitChange(session: DshSession, key: string, value: unknown): void
}

/**
 * 假会话投影注册表：`register` 记录 flowgate 定义；`snapshot`/`stateOf`
 * 返回构造时给定的投影值，`emitChange` 手动触发变更流——供 contextPct
 * 读取/推送路径测试（P1-7）。
 */
export function createFakeProjectionRegistry(options: FakeProjectionRegistryOptions = {}): FakeProjectionRegistry {
  const listeners = new Set<(session: DshSession, key: string, value: unknown, seq: unknown) => void>()
  const state: FakeProjectionRegistryState = {
    definitions: new Map(),
    values: { ...(options.values ?? {}) },
    states: { ...(options.states ?? options.values ?? {}) },
    listeners,
  }
  return {
    state,
    register(definition: DshProjectionDefinition<string, unknown>): () => void {
      state.definitions.set(definition.key, definition)
      return () => state.definitions.delete(definition.key)
    },
    onChanged(listener: (session: DshSession, key: string, value: unknown, seq: unknown) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot(_session: DshSession, keys?: readonly string[]) {
      const selected = keys === undefined ? state.values : Object.fromEntries(keys.filter((key) => key in state.values).map((key) => [key, state.values[key]]))
      return { asOfSeq: -1, values: { ...selected } }
    },
    stateOf(_session: DshSession, key: string): unknown {
      return state.states[key]
    },
    emitChange(session: DshSession, key: string, value: unknown): void {
      state.values[key] = value
      state.states[key] = value
      for (const listener of [...listeners]) {
        try {
          listener(session, key, value, -1)
        } catch {
          // 假宿主里监听器异常不中断测试。
        }
      }
    },
  } as unknown as FakeProjectionRegistry
}

/** 假 subagents 运行时。 */
export function createFakeSubagents(options: { providers?: string[]; start?: (spec: unknown) => Promise<DshSubagentActivation> } = {}): DshSubagentRuntime & {
  state: { started: unknown[] }
} {
  const state = { started: [] as unknown[] }
  return {
    state,
    list: () => options.providers ?? ['spawn'],
    async startActivation(spec: unknown): Promise<DshSubagentActivation> {
      state.started.push(spec)
      if (options.start) return await options.start(spec)
      return {
        childId: `child-${state.started.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'fake child output' }], structured: { verdict: 'pass', summary: 'ok', findings: [] }, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  } as unknown as DshSubagentRuntime & { state: { started: unknown[] } }
}

/** 假 sessionQuery。 */
export function createFakeSessionQuery(eventsBySession: Record<string, unknown[]> = {}): unknown {
  return {
    async readSession(sessionId: string) {
      return { session: { id: sessionId }, events: eventsBySession[sessionId] ?? [] }
    },
    async observeSession(sessionId: string) {
      return { header: { id: sessionId }, events: eventsBySession[sessionId] ?? [], dispose: () => {} }
    },
  }
}

// ---------------------------------------------------------------------------
// 假 agent / session
// ---------------------------------------------------------------------------

export interface FakeAgentState {
  injected: DshUserMessage[]
  steered: DshUserMessage[]
  followups: DshUserMessage[]
  disposed: boolean
}

export interface FakeAgent extends DshAgent {
  state: FakeAgentState
}

export interface FakeSessionState {
  events: { type: string; data: Record<string, unknown> }[]
  appended: { type: string; data: Record<string, unknown> }[]
}

export function createFakeSession(options: { id?: string; cwd?: string; events?: { type: string; data: Record<string, unknown> }[]; ctx?: DshContext } = {}): DshSession & {
  state: FakeSessionState
} {
  const state: FakeSessionState = { events: options.events ?? [], appended: [] }
  const session = {
    state,
    id: options.id ?? 'session-1',
    header: {
      id: options.id ?? 'session-1',
      createdAt: Date.now(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    seq: state.events.length,
    append(type: string, data: Record<string, unknown>): unknown {
      state.appended.push({ type, data })
      state.events.push({ type, data })
      return { type, seq: state.events.length - 1, data }
    },
    snapshotEvents(): readonly unknown[] {
      return [...state.events]
    },
    deriveMessages(): readonly unknown[] {
      return []
    },
  }
  return session as unknown as DshSession & { state: FakeSessionState }
}

export function createFakeAgent(options: { id?: string; cwd?: string; ctx?: DshContext; session?: DshSession; sourceCwd?: string } = {}): FakeAgent {
  const state: FakeAgentState = { injected: [], steered: [], followups: [], disposed: false }
  const session = options.session ?? createFakeSession({ id: options.id ?? 'session-1', cwd: options.cwd ?? '/fake/project' })
  const agent = {
    state,
    id: options.id ?? 'session-1',
    session,
    ctx: options.ctx,
    status: 'idle',
    inject(message: DshUserMessage): void {
      state.injected.push(message)
    },
    steer(message: DshUserMessage): void {
      state.steered.push(message)
    },
    followup(message: DshUserMessage): void {
      state.followups.push(message)
    },
    cancel(): void {},
    async whenIdle(): Promise<void> {},
  }
  return agent as unknown as FakeAgent
}

// ---------------------------------------------------------------------------
// 假 engine
// ---------------------------------------------------------------------------

export interface FakeEngineState {
  initialized: boolean
  snapshotOverrides: Partial<RuntimeSnapshot>
  config: FlowgateConfig
  evaluateActionError: Error | null
  evaluateActionResult: Decision
  calls: {
    evaluateAction: { action: Action; caller: unknown }[]
    recordPostcheck: unknown[]
    recordExternalChanges: string[][]
    heartbeat: number
    releaseSession: number
    setOff: { off: boolean; reason?: string }[]
    setProjectOff: { off: boolean; reason: string; by?: string; autoRearm?: boolean }[]
    approveGate: string[]
    rejectGate: { gate: string; reason: string }[]
    recordReview: unknown[]
    taskDone: string[]
    taskFailed: { taskId: string; reason: string }[]
    newChange: unknown[]
    allowOnce: unknown[]
    decidePending: unknown[]
    turnContinued: unknown[]
    startRepair: unknown[]
    finishRepair: unknown[]
    abortRepair: string[]
    selfPause: unknown[]
    closeIncident: unknown[]
  }
  current: unknown
  receipts: unknown[]
  tasks: unknown[]
  injectionText: string
  notes: string[]
  /** v0.5.1：接管模式（fake 默认 enforce；自举/测试可覆盖为 observe/off）。 */
  takeover: TakeoverMode
  /** v0.5.1：项目级 flags（暂停/事故）。 */
  projectFlags: ProjectFlags
  /** v0.5.1：进行中的修复通道记录（无则 null）。 */
  repair: RepairRecord | null
  /** v0.5.1：未关闭的事故（selfPause 创建，closeIncident 清除）。 */
  incident: IncidentRecord | null
}

export function createFakeEngine(overrides: Partial<FakeEngineState> = {}): FlowEngine & { state: FakeEngineState } {
  const state: FakeEngineState = {
    initialized: overrides.initialized ?? true,
    snapshotOverrides: overrides.snapshotOverrides ?? {},
    config: overrides.config ?? (defaultFakeConfig() as unknown as FlowgateConfig),
    evaluateActionError: overrides.evaluateActionError ?? null,
    evaluateActionResult: overrides.evaluateActionResult ?? { effect: 'allow', message: '' },
    calls: {
      evaluateAction: [],
      recordPostcheck: [],
      recordExternalChanges: [],
      heartbeat: 0,
      releaseSession: 0,
      setOff: [],
      setProjectOff: [],
      approveGate: [],
      rejectGate: [],
      recordReview: [],
      taskDone: [],
      taskFailed: [],
      newChange: [],
      allowOnce: [],
      decidePending: [],
      turnContinued: [],
      startRepair: [],
      finishRepair: [],
      abortRepair: [],
      selfPause: [],
      closeIncident: [],
    },
    current: overrides.current ?? null,
    receipts: [],
    tasks: overrides.tasks ?? [],
    injectionText: overrides.injectionText ?? '[FlowGate] 假注入：阶段 S4｜活动任务 T1',
    notes: [],
    takeover: overrides.takeover ?? 'enforce',
    projectFlags: overrides.projectFlags ?? {},
    repair: overrides.repair ?? null,
    incident: overrides.incident ?? null,
  }
  const engine = {
    state,
    root: '/fake/project',
    async load(): Promise<void> {},
    async refresh(): Promise<void> {},
    isInitialized: () => state.initialized,
    isLoaded: () => true,
    getConfig: () => state.config,
    getState: () => null,
    currentChange: () => state.current,
    allChanges: () => (state.current ? [state.current] : []),
    snapshot: () => makeSnapshot(state),
    statusText: () => '假状态：S4 执行中',
    buildInjection: () => ({ text: state.injectionText, approxTokens: 20 }),
    getEvidence: () => state.receipts,
    getArtifacts: () => ({}),
    getProject: () => null,
    getRoadmap: () => null,
    coverage: () => null,
    setCoverage: (report: unknown) => {
      ;(state as unknown as { coverage: unknown }).coverage = report
    },
    noteToolCall: () => {},
    noteGuardDecision: () => {},
    takeNotices: () => state.notes.splice(0, state.notes.length),
    getTasks: () => state.tasks,
    getTask: (id: string) => (state.tasks as { id: string }[]).find((task) => task.id === id),
    getPlan: () => ({ batches: [] }),
    async init() {
      return { ok: true, project: {}, detectedCommands: {}, risks: [], filesRead: [], message: '初始化完成（fake）' }
    },
    async newChange(input: unknown) {
      state.calls.newChange.push(input)
      return { changeId: 'C-001', suggestion: { complexity: 'low', risk: 'normal', reasons: { complexity: [], risk: [] } }, message: '已立项（fake）' }
    },
    async submitGate(gate: string) {
      return { gate, passed: true, awaiting: 'owner', items: [], failures: [], stage: 'S1', message: `已提交 ${gate}（fake）` }
    },
    async approveGate(gate: string) {
      state.calls.approveGate.push(gate)
      return { gate, passed: true, items: [], failures: [], stage: 'S2', message: `已批准 ${gate}（fake）` }
    },
    async rejectGate(gate: string, reason: string) {
      state.calls.rejectGate.push({ gate, reason })
      return { gate, passed: false, items: [], failures: [], stage: 'S1', message: `已退回 ${gate}（fake）` }
    },
    async evaluateAction(action: Action, caller: unknown) {
      state.calls.evaluateAction.push({ action, caller })
      if (state.evaluateActionError) throw state.evaluateActionError
      return state.evaluateActionResult
    },
    async recordPostcheck(input: unknown) {
      state.calls.recordPostcheck.push(input)
      return []
    },
    async recordExternalChanges(paths: string[]) {
      state.calls.recordExternalChanges.push(paths)
    },
    async clearViolation() {
      return true
    },
    async taskStart(taskId: string) {
      return { ok: true, taskCard: { id: taskId, title: '假任务' }, message: `已领取 ${taskId}（fake）` }
    },
    async taskDone(taskId: string) {
      state.calls.taskDone.push(taskId)
      return { ok: true, passed: true, failures: [], message: `任务 ${taskId} 通过（fake）`, committed: true }
    },
    async taskFailed(taskId: string, reason: string) {
      state.calls.taskFailed.push({ taskId, reason })
    },
    async runVerify() {
      return {
        id: 'E-0001',
        changeId: 'C-001',
        group: 'unit',
        kind: 'test',
        phase: 'green',
        command: 'pnpm test',
        runBy: 'flowgate',
        exitCode: 0,
        summary: { parser: 'fake', parsed: true, run: 1, passed: 1, failed: 0, skipped: 0 },
        inputsHash: 'sha256:fake',
        outputRef: '.flowgate/state/evidence/E-0001.log',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
        notes: 'fake',
      }
    },
    async attachEvidence() {
      return { id: 'E-0002', changeId: 'C-001', group: 'manual', kind: 'manual', phase: 'none', command: 'manual', runBy: 'agent', exitCode: 0, summary: null, inputsHash: '', outputRef: '.flowgate/x.log', startedAt: '', finishedAt: '' }
    },
    async requestScopeChange() {
      return { id: 'SC-1', kind: 'scope', changeId: 'C-001', title: '范围变更', detail: '', status: 'open', createdAt: '' }
    },
    async reportRisk() {
      return { id: 'RK-1', kind: 'risk', changeId: 'C-001', title: '风险上报', detail: '', status: 'open', createdAt: '' }
    },
    async requestPlanChange() {
      return { id: 'PC-1', kind: 'plan', changeId: 'C-001', title: '计划修订', detail: '', status: 'open', createdAt: '' }
    },
    async proposeRule() {
      return { id: 'RL-1', kind: 'rule', changeId: 'C-001', title: '规则提议', detail: '', status: 'open', createdAt: '' }
    },
    async submitAnalysis() {
      return { ok: true, archived: true, citationChecks: [], message: '已归档（fake）' }
    },
    async decidePending(id: string, decision: string, reason?: string) {
      state.calls.decidePending.push(reason === undefined ? { id, decision } : { id, decision, reason })
      return { id, kind: 'scope', changeId: 'C-001', title: `待处理 ${id}`, detail: '', status: decision === 'approved' ? 'approved' : 'rejected', createdAt: '' }
    },
    async allowOnce(ruleId: string, reason: string) {
      state.calls.allowOnce.push({ ruleId, reason })
      return { id: 'OV-1', ruleId, reason, changeId: 'C-001', actionFingerprint: 'x', createdAt: '' }
    },
    async addException() {
      return { id: 'EX-1' }
    },
    async revokeException() {},
    async changeComplexity(level: string) {
      return { gate: 'G3', passed: true, items: [], failures: [], stage: 'S3', message: `复杂度改为 ${level}（fake）` }
    },
    async changeRiskLevel(level: string) {
      return { gate: 'G3', passed: true, items: [], failures: [], stage: 'S3', message: `风险改为 ${level}（fake）` }
    },
    async setOff(off: boolean, reason?: string) {
      state.calls.setOff.push({ off, reason })
    },
    // ---- v0.5.1：接管模式 / 项目 flags / 修复通道 / 事故（fake 行为） ----
    getTakeoverMode: () => state.takeover,
    getProjectFlags: () => cloneProjectFlags(state.projectFlags),
    async setProjectOff(off: boolean, reason: string, options?: { by?: 'human' | 'agent'; autoRearm?: boolean }) {
      state.calls.setProjectOff.push({
        off,
        reason,
        ...(options?.by !== undefined ? { by: options.by } : {}),
        ...(options?.autoRearm !== undefined ? { autoRearm: options.autoRearm } : {}),
      })
      if (off) {
        state.projectFlags.off = {
          by: options?.by ?? 'human',
          reason,
          at: '2026-01-01T00:00:00.000Z',
          ...(options?.autoRearm === true ? { autoRearm: true, hostEpoch: 'fake-host-epoch' } : {}),
        }
      } else {
        delete state.projectFlags.off
      }
    },
    getRepair: () => (state.repair ? { ...state.repair, scope: [...state.repair.scope] } : null),
    async startRepair(input: {
      title: string
      symptom: string
      repro?: string
      scope: string[]
      verify: string
      acceptance?: string[]
      severity?: 'P0' | 'P1' | 'P2'
      openedBy?: 'human' | 'agent'
    }) {
      state.calls.startRepair.push(input)
      const record: RepairRecord = {
        id: 'FIX-20260101-000000',
        title: input.title,
        symptom: input.symptom,
        ...(input.repro !== undefined ? { repro: input.repro } : {}),
        scope: [...input.scope],
        verify: input.verify,
        acceptance: input.acceptance ?? [],
        severity: input.severity ?? 'P2',
        status: 'open',
        openedAt: '2026-01-01T00:00:00.000Z',
        openedBy: input.openedBy ?? 'agent',
        actions: 0,
      }
      state.repair = record
      return { ...record }
    },
    async finishRepair(input: { summary?: string; commit?: string | null } = {}) {
      state.calls.finishRepair.push(input)
      const current = state.repair
      if (!current) throw new Error('没有进行中的修复通道（fake）')
      const record: RepairRecord = {
        ...current,
        status: 'done',
        redEvidenceId: current.redEvidenceId ?? 'E-RED-1',
        greenEvidenceId: current.greenEvidenceId ?? 'E-GREEN-1',
        regressionEvidenceId: current.regressionEvidenceId ?? 'E-REG-1',
        changedFiles: current.changedFiles ?? ['src/fixed.ts'],
        closedAt: '2026-01-01T00:00:01.000Z',
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        commit: input.commit ?? null,
      }
      state.repair = null
      return { record, message: `修复 ${record.id} 已关闭：RED → GREEN 证据齐全（fake）` }
    },
    async abortRepair(reason: string) {
      state.calls.abortRepair.push(reason)
      const current = state.repair
      if (!current) throw new Error('没有进行中的修复通道（fake）')
      const record: RepairRecord = {
        ...current,
        status: 'aborted',
        abortReason: reason,
        closedAt: '2026-01-01T00:00:01.000Z',
      }
      state.repair = null
      return record
    },
    async selfPause(input: { reason: string; severity?: 'P0' | 'P1' | 'P2' }) {
      state.calls.selfPause.push(input)
      const incident: IncidentRecord = {
        id: `INC-${state.calls.selfPause.length}`,
        severity: input.severity ?? 'P1',
        reason: input.reason,
        openedAt: '2026-01-01T00:00:00.000Z',
        openedBy: 'agent',
      }
      state.incident = incident
      state.projectFlags.incident = incident
      state.projectFlags.off = {
        by: 'agent',
        reason: input.reason,
        at: '2026-01-01T00:00:00.000Z',
        autoRearm: true,
        hostEpoch: 'fake-host-epoch',
      }
      return { incident: { ...incident }, message: `已暂停项目写操作并创建事故 ${incident.id}（fake）` }
    },
    async closeIncident(input: { summary: string; commit?: string | null; tests?: string; files?: string[] }) {
      state.calls.closeIncident.push(input)
      const current = state.projectFlags.incident ?? state.incident
      if (!current) throw new Error('没有未关闭的事故（fake）')
      const incident: IncidentRecord = {
        ...current,
        closedAt: '2026-01-01T00:00:02.000Z',
        summary: input.summary,
        ...(input.tests !== undefined ? { tests: input.tests } : {}),
        ...(input.files !== undefined ? { files: [...input.files] } : {}),
        commit: input.commit ?? null,
      }
      delete state.projectFlags.incident
      state.incident = null
      return { incident: { ...incident }, message: `事故 ${incident.id} 已关闭（fake）` }
    },
    async dispatchNext() {
      return { dispatched: [], message: '没有可派发任务（fake）' }
    },
    async recordTurnContinued(input: unknown) {
      state.calls.turnContinued.push(input)
    },
    async setTaskWorktree() {},
    async recordReview(input: unknown) {
      state.calls.recordReview.push(input)
      return { id: 'RV-1' }
    },
    async completeCheckpoint() {},
    async attachSession() {
      return makeSnapshot(state)
    },
    async resumeChange() {
      return makeSnapshot(state)
    },
    async pauseChange() {
      return { at: '', stage: 'S4', decisions: [], openItems: [], next: '', text: '暂停（fake）' }
    },
    async generateHandoff() {
      return { at: '', stage: 'S4', decisions: [], openItems: [], next: '', text: '交接（fake）' }
    },
    async heartbeat() {
      state.calls.heartbeat += 1
    },
    async releaseSession() {
      state.calls.releaseSession += 1
    },
    async doctor() {
      return {
        initialized: state.initialized,
        pluginVersion: '0.1.0-test',
        ledgerOk: true,
        ledgerFailures: [],
        configOk: true,
        activeTasks: [],
        openPending: 0,
        guardHeartbeat: { toolCalls: 0, decisions: 0 },
        hostCapabilities: {},
        message: 'fake doctor',
      }
    },
    async repair() {
      return { ok: true, message: '修复完成（fake）' }
    },
    async generateMetrics() {
      return { changeId: 'C-001', generatedAt: '', metrics: {}, notes: {} }
    },
    async generateReport() {
      return { path: '.flowgate/report.html', html: '<html></html>' }
    },
    async generateBoard() {
      return { path: '.flowgate/dashboard.html', html: '<html></html>' }
    },
  }
  return engine as unknown as FlowEngine & { state: FakeEngineState }
}

/** 项目 flags 深拷贝（fake 返回值与内部状态隔离，模拟 core 的"返回拷贝"约定）。 */
function cloneProjectFlags(flags: ProjectFlags): ProjectFlags {
  return {
    ...(flags.off !== undefined ? { off: { ...flags.off } } : {}),
    ...(flags.incident !== undefined ? { incident: { ...flags.incident } } : {}),
  }
}

function makeSnapshot(state: FakeEngineState): RuntimeSnapshot {
  const flags = state.projectFlags
  const off = state.snapshotOverrides.off === true || flags.off !== undefined
  const incident = state.incident ?? flags.incident
  const repair = state.repair
  return {
    initialized: state.initialized,
    pipeline: [],
    tasks: {},
    batches: [],
    pending: [],
    violations: [],
    off,
    ...(off && flags.off !== undefined ? { offBy: flags.off.by } : {}),
    takeover: state.takeover,
    ...(incident !== null && incident !== undefined
      ? { incident: { id: incident.id, severity: incident.severity, reason: incident.reason, openedAt: incident.openedAt } }
      : {}),
    ...(repair !== null
      ? {
          repair: {
            id: repair.id,
            title: repair.title,
            severity: repair.severity,
            status: 'open' as const,
            scope: [...repair.scope],
            verify: repair.verify,
            red: Boolean(repair.redEvidenceId),
            green: Boolean(repair.greenEvidenceId),
            openedAt: repair.openedAt,
            actions: repair.actions,
          },
        }
      : {}),
    locked: false,
    interceptCounts: {},
    nextStep: '下一步（fake）',
    statusLine: 'FlowGate · S4 执行中（fake）',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...state.snapshotOverrides,
  }
}

/** 默认假配置（只填本插件用到的字段）。 */
export function defaultFakeConfig(): Record<string, unknown> {
  return {
    levels: { complexity: 'auto', risk: 'auto' },
    dispatch: 'inline',
    commands: {},
    limits: {
      task_max_files: 10,
      change_max_tasks: 10,
      clarify_max_rounds: 3,
      turn_continue_max: 2,
      test_output_summary_tokens: 400,
      context_warn_ratio: 0.8,
      token_budget: { low: 10000, medium: 20000, high: 40000, ultra: 80000 },
    },
    parallel: { max_agents: 3, setup: null, hotspots_extra: [] },
    session: { lease_minutes: 10 },
    git: { change_branch: false, auto_commit: false, commit_flowgate: false },
    review: { enabled: true, requireForTaskGate: false },
    ignore: [],
    rules: [],
    triggers: {
      sensitive_paths: [],
      sensitive_paths_extra: [],
      dependency_files: [],
      protected_paths: [],
      secret_patterns: 'builtin',
      max_scope_new_files: 10,
      consecutive_failure_limit: 3,
    },
  }
}

// ---------------------------------------------------------------------------
// 假 HostDeps
// ---------------------------------------------------------------------------

export interface FakeDepsOptions {
  engine?: FlowEngine
  ports?: HostPorts
  core?: Partial<CoreBridge>
  homeDir?: string
  log?: (level: string, message: string) => void
  /** 捕获传给 createEngine 的选项（测试 takeover/hostEpoch 透传）。 */
  onCreateEngine?: (options: EngineOptions) => void
}

/** 默认假分类器：write/edit → FileAction；bash → ShellAction；subagent → delegate。 */
export function createFakeCore(overrides: Partial<CoreBridge> = {}): CoreBridge {
  const classify = (tool: string, schemaKeys?: string[]) => {
    const map: Record<string, { category: 'read' | 'write' | 'shell' | 'delegate' | 'mcp' | 'flowgate' | 'unknown'; covered: boolean }> = {
      write: { category: 'write', covered: true },
      edit: { category: 'write', covered: true },
      read: { category: 'read', covered: true },
      glob: { category: 'read', covered: true },
      grep: { category: 'read', covered: true },
      bash: { category: 'shell', covered: true },
      shell: { category: 'shell', covered: true },
      subagent: { category: 'delegate', covered: true },
      subagent_fork: { category: 'delegate', covered: true },
      workflow: { category: 'delegate', covered: true },
      send_message: { category: 'delegate', covered: true },
      run_code: { category: 'delegate', covered: true },
      flow_status: { category: 'flowgate', covered: true },
      flow_verify: { category: 'flowgate', covered: true },
      mcp__demo: { category: 'mcp', covered: false },
      mystery_tool: { category: 'unknown', covered: false },
    }
    void schemaKeys
    const found = map[tool] ?? { category: 'unknown' as const, covered: false }
    return { tool, category: found.category, covered: found.covered }
  }
  const actionFrom = (tool: string, params: Record<string, unknown>): Action | null => {
    if (tool === 'write' || tool === 'edit') {
      const path = typeof params.file_path === 'string' ? params.file_path : typeof params.path === 'string' ? params.path : ''
      return path === '' ? null : { kind: 'write', tool, path, ...(typeof params.content === 'string' ? { content: params.content } : {}) }
    }
    if (tool === 'bash' || tool === 'shell') {
      return typeof params.command === 'string' ? { kind: 'shell', tool, command: params.command } : null
    }
    if (tool === 'subagent' || tool === 'subagent_fork' || tool === 'workflow' || tool === 'send_message') {
      return { kind: 'delegate', tool, target: typeof params.agentPreset === 'string' ? params.agentPreset : undefined }
    }
    return null
  }
  return {
    classifyTool: (tool, keys) => classify(tool, keys) as never,
    actionFromToolCall: actionFrom,
    detectEvidenceKind: (command: string) => (/test|vitest|jest|pytest|mvn|gradle/i.test(command) ? 'test' : 'run'),
    parseTestOutput: (input) => ({ parser: 'fake', parsed: true, run: 1, passed: input.exitCode === 0 ? 1 : 0, failed: input.exitCode === 0 ? 0 : 1, skipped: 0 }),
    evidencePhase: (summary: TestSummary | null, exitCode: number) => (exitCode === 0 ? 'green' : summary && summary.failed > 0 ? 'red' : 'unknown'),
    summarizeEvidenceForContext: (receipt) => `[FlowGate] ${receipt.command} → 失败（运行 1，通过 0，失败 1，跳过 0）\n完整输出：${receipt.outputRef}`,
    truncateOutput: (output, maxChars) => ({ text: output.slice(0, maxChars), truncated: output.length > maxChars }),
    extractWriteTargets: () => [],
    blockedDelegationTools: () => ['subagent', 'subagent_fork', 'workflow', 'send_message', 'run_code'],
    formatMetricsText: () => '指标（fake）',
    metricsCsv: () => 'a,b\n1,2',
    renderConfigYaml: (config) => JSON.stringify(config, null, 2),
    ...overrides,
  }
}

/** 假 git 端口（isRepo/statusPorcelain 可配置）。 */
export function createFakeGit(overrides: Partial<Record<string, unknown>> = {}): HostPorts['git'] {
  return {
    isRepo: async () => true,
    head: async () => 'deadbeef',
    currentBranch: async () => 'main',
    branchExists: async () => false,
    createBranch: async () => {},
    checkout: async () => {},
    statusPorcelain: async () => '',
    diffNames: async () => [],
    diffText: async () => '',
    showFile: async () => null,
    add: async () => {},
    commit: async () => {},
    push: async () => {},
    ...overrides,
  } as unknown as HostPorts['git']
}

/** 默认假端口：MemoryFileSystem + 假 git + 假 runner。 */
export function createFakePorts(root = '/fake/project', options: { git?: boolean; configYaml?: boolean } = {}): HostPorts {
  const seed: Record<string, string> = {}
  if (options.configYaml !== false) seed[`${root}/.flowgate/config.yaml`] = 'flowgate:\n'
  return {
    fs: new MemoryFileSystem(seed),
    ...(options.git === false ? {} : { git: createFakeGit() }),
    commandRunner: {
      async run(command: string) {
        return { exitCode: 0, stdout: `ran ${command}`, stderr: '', timedOut: false, durationMs: 1 }
      },
    },
  }
}

/** 假 HostDeps。 */
export function createFakeDeps(options: FakeDepsOptions = {}): HostDeps {
  const engine = options.engine ?? createFakeEngine()
  const homeDir = options.homeDir ?? nodePath.join(os.tmpdir(), `flowgate-test-home-${process.pid}-${Math.random().toString(36).slice(2)}`)
  return {
    createPorts: (root: string) => options.ports ?? createFakePorts('/fake/project'),
    createEngine: (engineOptions: EngineOptions) => {
      options.onCreateEngine?.(engineOptions)
      return engine
    },
    core: createFakeCore(options.core),
    homeDir: () => homeDir,
    pluginVersion: '0.1.0-test',
    randomKeyHex: (bytes: number) => 'a'.repeat(bytes * 2),
    ...(options.log ? { log: options.log } : { log: () => {} }),
  }
}

/** 创建测试用临时目录（ledger.key 落到这里，避免污染真实 home）。 */
export async function makeTempHome(): Promise<string> {
  return await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-home-'))
}
