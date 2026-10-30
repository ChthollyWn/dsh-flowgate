/**
 * DSH 宿主接口的**本地结构性类型**。
 *
 * 约束（见 docs/impl/module-contracts.md §7 与 docs/03-技术方案.md §13）：
 * host 层**禁止** `import '@deepseek-ai/*'`，也不把宿主核心包放进 dependencies。
 * 这里按 rc.5 的真实 d.ts 手抄出我们用到的最小形状，运行时用能力探测
 * （`ctx.get('tools')`、`typeof svc.guard === 'function'`）判断是否存在。
 *
 * 形状来源（npm pack 产物，行号为该文件行号）：
 * - @deepseek-ai/dsh-tools/lib/types/index.d.ts:47,58,70,92,516-522,527-656
 * - @deepseek-ai/dsh-commands/lib/types/index.d.ts:36-52,74-96
 * - @deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:32-40,104-190
 *   @deepseek-ai/dsh-agent/lib/types/index.d.ts:26-48
 * - @deepseek-ai/dsh-session/lib/types/index.d.ts:40-56,158
 * - @deepseek-ai/dsh-session-projection/lib/types/index.d.ts:14-31
 * - @deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:10-31,96-120
 * - @deepseek-ai/dsh-subagent/lib/types/types.d.ts:20-110
 * - @deepseek-ai/dsh-session-query/lib/types/index.d.ts:44-90
 * - @deepseek-ai/cordis/lib/types/context.d.ts / registry.d.ts / events.d.ts
 *
 * 说明：所有 `unknown` 成员刻意放宽——宿主小版本升级时形状可能变化，
 * 具体字段由调用点的运行时探测负责收窄，绝不让类型断言直接抛错。
 */

// ---------------------------------------------------------------------------
// 基础值
// ---------------------------------------------------------------------------

/** 可 JSON 序列化值（dsh-util-values 的 JsonValue 的结构对应物）。 */
export type DshJsonValue = null | boolean | number | string | DshJsonValue[] | { [key: string]: DshJsonValue }
export type DshJsonObject = { [key: string]: DshJsonValue }

/**
 * 模型消息内容块。真实定义见 dsh-llm types（未在 /tmp/rc5 中完整打包）；
 * 我们只读 `type`/`text`，其余字段原样透传。
 */
export interface DshContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** 面向模型的 user 消息（dsh-session UserMessage，索引类型已放宽）。 */
export interface DshUserMessage {
  role?: 'user'
  content: DshContentBlock[]
  source?: { kind: string; [key: string]: unknown }
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Cordis 基础
// ---------------------------------------------------------------------------

/** ctx.logger(name) / ctx.logger.info 的最小形状（cordis LoggerService）。 */
export interface DshLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** cordis 事件监听器（mode 由宿主声明决定，我们只关心回调形状）。 */
export type DshListener = (...args: any[]) => unknown

/** cordis Context 的本地结构视图：服务全部可选，未知成员一律 `unknown`。 */
export interface DshContext {
  readonly root?: DshContext
  readonly logger?: DshLogger
  get(name: string, strict?: boolean): unknown
  provide?(name: string, value?: unknown): () => void
  effect?(callback: () => unknown, label?: string): () => void
  inject(deps: string | string[], callback: (scoped: DshContext) => unknown): unknown
  plugin?(plugin: unknown, ...args: unknown[]): unknown
  on(name: string, listener: DshListener, options?: unknown): () => void
  once?(name: string, listener: DshListener): () => void
  emit?(name: string, ...args: unknown[]): void
  bail?(name: string, ...args: unknown[]): unknown
  serial?(name: string, ...args: unknown[]): Promise<unknown>
  parallel?(name: string, ...args: unknown[]): Promise<void>
  waterfall?(name: string, ...args: unknown[]): Promise<unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// dsh-tools
// ---------------------------------------------------------------------------

/** ToolSchema（dsh-llm types.d.ts:472-483，parameters 为 JSON Schema 对象）。 */
export interface DshToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  deferLoading?: true
}

/** 输出声明（tools index.d.ts:106-113）。 */
export interface DshToolOutputDefinition {
  schema: unknown
  render(args: unknown, value: unknown): DshContentBlock[]
  presentationMeta?(args: unknown, value: unknown): DshJsonValue
}

/**
 * 注册用工具定义（tools index.d.ts:115-191 的 ToolDefinition）。
 *
 * 注意：我们**不** import `defineTool`，因此 `parameters` 直接写 JSON Schema，
 * `output.schema` 写受支持的 JSON Schema 子集；宿主 register() 会在注册时校验
 * （tools/lib/index.js:2974-2982）。
 */
export interface DshToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: DshToolOutputDefinition
  execute(args: unknown, exec: DshToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: DshToolResult): unknown
}

/** 工具执行上下文（tools index.d.ts:305-322 的 ToolRunContext）。 */
export interface DshToolRunContext {
  readonly callId: unknown
  readonly name: string
  readonly arguments: unknown
  readonly agent?: DshAgent
  readonly signal: AbortSignal
  deferContext?(context: DshUserMessage): void
  concludeTurn?(): void
}

/** 单调守卫（tools index.d.ts:522）。返回字符串 = 拒绝。 */
export type DshToolGuard = (execution: Readonly<DshToolExecution>) => string | undefined

/** 一次工具调用（tools index.d.ts:216-287）。 */
export interface DshToolExecution {
  readonly callId: unknown
  readonly rootCallId?: unknown
  readonly name: string
  readonly arguments: unknown
  readonly agent?: DshAgent
  readonly parent?: unknown
  readonly signal?: AbortSignal
  readonly token?: unknown
}

/** 工具最终结果（tools index.d.ts:193-205 / 413-435）。 */
export interface DshToolResult {
  content: DshContentBlock[]
  isError: boolean
  meta?: DshJsonValue
}

/** tools/post-execute 决策（tools index.d.ts:465-479）。 */
export type DshPostToolDecision =
  | { kind: 'accept'; content?: DshContentBlock[]; additionalContexts?: DshUserMessage[] }
  | { kind: 'accept'; value: unknown; additionalContexts?: DshUserMessage[] }
  | { kind: 'block'; feedback: DshContentBlock[]; additionalContexts?: DshUserMessage[] }

/** 工具限制掩码（tools index.d.ts:508-513）。 */
export interface DshToolRestriction {
  allow?: readonly string[]
  deny?: readonly string[]
}

/** ctx.tools 运行时（tools index.d.ts:527-770）。全部方法都做存在性探测。 */
export interface DshToolRuntime {
  guard(guard: DshToolGuard): () => void
  register(definition: DshToolDefinition): () => void
  presentAs?(mode: 'native' | 'ptc'): () => void
  restrict?(filter: DshToolRestriction): () => void
  schemas?(scope?: unknown): DshToolSchema[]
  get?(name: string, scope?: unknown): DshToolDefinition | undefined
}

// ---------------------------------------------------------------------------
// dsh-commands
// ---------------------------------------------------------------------------

/** 命令结果（commands types.d.ts:18-27）。 */
export type DshCommandResult = { kind: 'success'; text?: string; sourceEventSeq?: number } | { kind: 'error'; text: string }

/** 命令调用（commands index.d.ts:36-42）。 */
export interface DshCommandInvocation {
  readonly commandId: unknown
  readonly agent: DshAgent
  readonly rawInput: string
  readonly attachments: readonly unknown[]
  readonly signal: AbortSignal
}

/** 命令定义（commands index.d.ts:43-52）。 */
export interface DshCommandDefinition {
  definitionId?: unknown
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
  recordInput?: boolean
  handler(invocation: DshCommandInvocation): DshCommandResult | Promise<DshCommandResult>
}

/** ctx.commands（commands index.d.ts:67-77）。 */
export interface DshCommandRuntime {
  register(definition: DshCommandDefinition): () => void
  list?(agent: unknown): readonly unknown[]
  find?(agent: unknown, name: string): DshCommandDefinition | undefined
}

// ---------------------------------------------------------------------------
// dsh-session
// ---------------------------------------------------------------------------

/** 会话头（session types.d.ts:14-75 的 SessionHeader 子集）。 */
export interface DshSessionHeader {
  readonly id: unknown
  readonly createdAt?: number
  /** 会话创建时的绝对工作目录；**不**代表当前执行目录（rc.5 已知变化）。 */
  readonly cwd?: string
  readonly parentSession?: unknown
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
  [key: string]: unknown
}

/** 会话事件（只读我们关心的字段）。 */
export interface DshSessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
}

/** Session（session index.d.ts:158-200 的公开成员子集）。 */
export interface DshSession {
  readonly id: unknown
  readonly header: DshSessionHeader
  readonly seq?: number
  readonly inheritedEventCount?: number
  append(type: string, data: Record<string, unknown>, ...opts: unknown[]): unknown
  deriveMessages?(): unknown[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// dsh-session-projection
// ---------------------------------------------------------------------------

/** zod 风格 schema 的最小形状：注册表只在 checkpoint 读取时调用 `.parse()`。 */
export interface DshProjectionSchemaLike<T> {
  parse(value: unknown): T
}

/** 投影定义（session-projection index.d.ts:14-31）。 */
export interface DshProjectionDefinition<K extends string, S> {
  key: K
  stateSchema: DshProjectionSchemaLike<S>
  init(header: DshSessionHeader, inheritedEventCount: number): S
  apply(state: S, event: DshSessionEvent): S
  wire?: {
    viewSchema: DshProjectionSchemaLike<unknown>
    view(state: S): unknown
  }
  stateVersion: number
}

/** ctx.sessionProjections（session-projection index.d.ts:44-80 的公开成员子集）。 */
export interface DshSessionProjectionRegistry {
  register<K extends string, S>(definition: DshProjectionDefinition<K, S>): () => void
  onChanged?(listener: (session: DshSession, key: string, value: unknown, seq: unknown) => void): () => void
  snapshot?(session: DshSession, keys?: readonly string[]): { asOfSeq: unknown; values: Record<string, unknown> }
  cachedSnapshot?(session: DshSession, keys?: readonly string[]): { asOfSeq: unknown; values: Record<string, unknown> } | undefined
  stateOf?<K extends string>(session: DshSession, key: K): unknown
}

// ---------------------------------------------------------------------------
// dsh-system-prompt
// ---------------------------------------------------------------------------

/** 提示词段（system-prompt index.d.ts:41-47）。 */
export interface DshPromptSection {
  name: string
  order: number
  text: string | ((context: { scope?: unknown; signal?: AbortSignal; agent?: DshAgent }) => string)
  interpolate?: boolean
  complete?: boolean
}

/** 提示词动态上下文（system-prompt index.d.ts:55-62）。 */
export interface DshPromptContext {
  name: string
  order: number
  text: string | ((context: { scope?: unknown; signal?: AbortSignal; agent?: DshAgent }) => string)
  interpolate?: boolean
  required?: boolean
}

/** ctx.systemPrompt（system-prompt index.d.ts:100-120）。 */
export interface DshSystemPrompt {
  section(section: DshPromptSection): () => void
  context?(context: DshPromptContext): () => void
  getSectionOrder?(name: string): number
  getContextOrder?(name: string): number
  variable?(name: string, provider: (context: { agent?: DshAgent }) => string | undefined): () => void
  refreshContext?(assembly: unknown, context?: unknown): unknown
  assemble?(context?: unknown): Promise<unknown>
}

// ---------------------------------------------------------------------------
// dsh-agent
// ---------------------------------------------------------------------------

/** Agent（agent runtime-types.d.ts:104-116 的模块扩展成员）。 */
export interface DshAgent {
  readonly id: unknown
  readonly session: DshSession
  readonly ctx?: DshContext
  readonly status?: 'idle' | 'running'
  inject(message: DshUserMessage): void
  steer(message: DshUserMessage): void
  followup(message: DshUserMessage): void
  send?(message: DshUserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void
  cancel?(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): void
  whenIdle?(): Promise<void>
}

/** ctx.agents（agent index.d.ts:46-96 的公开成员）。 */
export interface DshAgentRegistry {
  create?(options: unknown): Promise<{ agent: DshAgent; dispose(): Promise<void> }>
  get?(id: unknown): DshAgent | undefined
  list?(): DshAgent[]
  roots?(): DshAgent[]
  isOwnedBy?(id: unknown, owner: DshAgent): boolean
}

// ---------------------------------------------------------------------------
// dsh-subagent
// ---------------------------------------------------------------------------

/** 子 agent 结果（subagent types.d.ts:94-99）。 */
export interface DshSubagentResult {
  readonly output: readonly DshContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  readonly stopReason: string
}

/** 子 agent 启动规格（subagent types.d.ts:20-34 + activation 的返回值）。 */
export interface DshSubagentStartRequest {
  readonly cwd?: string
  readonly agentPreset?: string
  readonly label?: string
  readonly prompt: DshContentBlock[]
  readonly parent: DshAgent
  readonly signal: AbortSignal
  readonly agentOptions?: { provider?: string; model?: string; reasoningEffort?: string; maxTokens?: number }
  readonly outputSchema?: Record<string, unknown>
  readonly maxDepth?: number
}

export interface DshSubagentActivationSpec {
  readonly provider: string
  readonly label: string
  readonly request: DshSubagentStartRequest
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}

/** activation 句柄（subagent types.d.ts:37-42）。 */
export interface DshSubagentActivation {
  readonly childId: unknown
  readonly messageId?: unknown
  readonly result: Promise<DshSubagentResult>
  dispose(): Promise<void>
}

/** ctx.subagents（subagent index.d.ts:96-160 的公开成员子集）。 */
export interface DshSubagentRuntime {
  list?(): string[]
  startActivation(spec: DshSubagentActivationSpec): Promise<DshSubagentActivation>
  waitForChildren?(parent: DshAgent): Promise<boolean>
  sendMessage?(sender: DshAgent, targetId: unknown, content: DshContentBlock[], options: { signal: AbortSignal }): Promise<unknown>
  interrupt?(targetSessionId: unknown, authority: unknown): void
}

// ---------------------------------------------------------------------------
// dsh-session-query
// ---------------------------------------------------------------------------

/** 会话观察（session-query observation.d.ts:7-25）。 */
export interface DshSessionObservation {
  readonly source: 'live' | 'prepared'
  readonly header: DshSessionHeader
  readonly events: readonly DshSessionEvent[]
  readonly cursor?: unknown
  dispose?(): void
}

/** ctx.sessionQuery（session-query index.d.ts:44-83 的公开成员子集）。 */
export interface DshSessionQueryEngine {
  observeSession?(sessionId: unknown, options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' }): Promise<DshSessionObservation>
  readSession?(sessionId: unknown): Promise<{ session: DshSessionHeader; inheritedEventCount?: number; events: readonly DshSessionEvent[] }>
  listEvents?(sessionId: unknown): Promise<readonly { seq?: number; type: string; time?: number }[]>
}

// ---------------------------------------------------------------------------
// 事件负载
// ---------------------------------------------------------------------------

export interface DshAgentCreatedPayload {
  readonly agent: DshAgent
  readonly source: 'startup' | 'resume' | 'clear' | 'compact'
  readonly signal?: AbortSignal
}

export interface DshPreStepPayload {
  readonly agent: DshAgent
  readonly messages: DshUserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

export type DshPreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: DshUserMessage[]; startsRequestSeries?: true }

export interface DshTurnStoppingPayload {
  readonly agent: DshAgent
  readonly turn: number
  readonly signal: AbortSignal
}
