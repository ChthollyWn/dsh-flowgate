/**
 * host 层内部契约：依赖注入、引擎形状、能力状态。
 *
 * 设计原则：
 * - 所有宿主服务都通过能力探测访问（`ctx.get('tools')`），任何缺失只降级不抛错。
 * - 所有跨层依赖（core 函数、Node 端口、engine 工厂）走 `HostDeps` 注入，
 *   这样 `test/host/**` 的 fake-ctx 单测可以完全不碰真实 core/宿主。
 * - 只从 core 做 `import type`；值导入集中在 `src/host/core-bridge.ts`。
 */
import type { EngineOptions, FlowEngine } from '../core/engine.js'
import type { FileSystem } from '../core/util/fs.js'
import type {
  Action,
  ActionKind,
  CallerInfo,
  CommandRunner,
  Complexity,
  CoverageReport,
  Decision,
  EvidenceKind,
  EvidencePhase,
  EvidenceReceipt,
  GateId,
  GitPort,
  RiskLevel,
  TakeoverMode,
  TestSummary,
} from '../core/types.js'

export type { EngineOptions, FlowEngine, TakeoverMode }

/** host 层可用的引擎成员（等价于 FlowEngine 本身；测试用假引擎时做一次断言）。 */
export type EngineLike = FlowEngine

/** 插件配置（cordis.patch.yml 行的 `config:` 传入 apply 第二参）。 */
export interface HostConfig {
  /** 总开关；false 时插件只注册最小投影（doctor 可查看原因），不做任何拦截。 */
  enabled?: boolean
  /** ledger.key 的路径覆盖（默认 `~/.dsh/flowgate/ledger.key`）。 */
  ledgerKeyPath?: string
  /** 每轮 turn-stopping 最多 steer 次数覆盖（默认取 config.limits.turn_continue_max）。 */
  maxTurnContinue?: number
  /** 覆盖项目根解析：固定使用该目录（测试/单仓多项目时用）。 */
  projectRoot?: string
  /**
   * 接管模式（v0.5.1 / P1-7）：
   * - `enforce`（默认）：完全接管，未立项的写操作被拒绝；
   * - `observe`：只观察不拦截（自举开发本插件时默认）；
   * - `off`：不拦截不记录（safe-mode 会强制 off）。
   * 显式配置优先于自举检测；safe-mode 时强制 off。
   */
  takeover?: TakeoverMode
  /** 覆盖自举检测（默认读项目根 package.json 的 name/dsh 字段）。 */
  selfHost?: boolean
  /**
   * 安全模式（P0-4）：true 时强制 takeover='off' 并跳过
   * guard/delegation/dispatch/gates 安装。也可由 sentinel 文件或
   * `FLOWGATE_SAFE=1` 触发（见 src/host/mode.ts）。
   */
  safeMode?: boolean
  /**
   * 模块级开关（P0-4）：false 时不安装该模块；即使被其它开关强制打开，
   * 安装状态与降级原因也会写进 /flow doctor。
   */
  modules?: Partial<Record<HostModuleName, boolean>>
}

/** 可单独开关的宿主功能模块（与 index.ts 的安装顺序一致）。 */
export type HostModuleName =
  | 'session'
  | 'guard'
  | 'delegation'
  | 'coverage'
  | 'postcheck'
  | 'compression'
  | 'context'
  | 'projection'
  | 'gates'
  | 'commands'
  | 'tools'
  | 'dispatch'

/** 单个模块的安装结果（doctor 可见）。 */
export interface HostModuleInfo {
  name: HostModuleName
  /** 中文功能名（安装日志/doctor 用）。 */
  stage: string
  status: 'ok' | 'failed' | 'skipped'
  /** skipped/failed 的原因。 */
  reason?: string
}

/** safe-mode 解析结果（P0-4）。 */
export interface SafeModeInfo {
  active: boolean
  reason?: string
  source?: 'env' | 'config' | 'sentinel'
  /** source='sentinel' 时的文件路径（doctor 展示/人工清除用）。 */
  path?: string
}

/**
 * 传给 core 的引擎选项：EngineOptions + v0.5.1 新增的
 * takeover/hostEpoch（host 在构造引擎前确定接管模式）。
 */
export interface HostEngineOptions extends EngineOptions {
  takeover?: TakeoverMode
  hostEpoch?: string
}

/** 工具分类结果（对应 core/rules/toolclass.ts 的 ToolClassification）。 */
export interface ToolClassificationLike {
  tool: string
  category: 'read' | 'write' | 'shell' | 'delegate' | 'mcp' | 'flowgate' | 'unknown'
  actionKind?: ActionKind
  covered: boolean
  reason?: string
}

/** core 侧纯函数桥（值导入由 core-bridge.ts 提供，测试可注入假实现）。 */
export interface CoreBridge {
  /** 工具名（+ 参数 schema 顶层键）→ 分类；驱动覆盖自检与守卫。 */
  classifyTool(tool: string, schemaKeys?: string[]): ToolClassificationLike
  /** 工具名 + 参数 → 结构化动作；返回 null 表示"读/只读/与门禁无关"。 */
  actionFromToolCall(tool: string, params: Record<string, unknown>): Action | null
  /** 解析验证命令的类别（test/build/lint/typecheck/run/manual）。 */
  detectEvidenceKind(command: string): EvidenceKind
  /** 解析测试命令输出（含各工具链 console 格式）。 */
  parseTestOutput(input: {
    command: string
    stdout: string
    stderr: string
    exitCode: number
    reportFiles?: { path: string; content: string }[]
    now?: string
  }): TestSummary
  /** 由摘要与退出码判断 RED / GREEN / none / unknown。 */
  evidencePhase(summary: TestSummary | null, exitCode: number): EvidencePhase
  /** 生成 ≤maxTokens 的证据摘要（给模型看的压缩结果）。 */
  summarizeEvidenceForContext(receipt: EvidenceReceipt, maxTokens: number): string
  /** 保留头尾的截断（超大输出兜底）。 */
  truncateOutput(output: string, maxChars: number): { text: string; truncated: boolean }
  /** 从 shell 命令里提取写入目标（提示用；误伤回归由 core 保证）。 */
  extractWriteTargets?(command: string): string[]
  /** 原生委派工具名（core 的 BLOCKED_DELEGATION_TOOLS）。 */
  blockedDelegationTools(): string[]
  /** 指标文本 / CSV（/flow metrics 使用）。 */
  formatMetricsText(set: import('../core/types.js').MetricSet): string
  metricsCsv(set: import('../core/types.js').MetricSet): string
  /** 把配置对象序列化成 .flowgate/config.yaml 文本（/flow learn、/flow parallel 使用）。 */
  renderConfigYaml(config: import('../core/types.js').FlowgateConfig): string
}

/** Node 端口的工厂结果。 */
export interface HostPorts {
  fs: FileSystem
  git?: GitPort
  commandRunner?: CommandRunner
}

/** 注入的依赖集合。 */
export interface HostDeps {
  /** 以**绝对项目根**构造 fs/git/runner 端口（fs 会把相对路径解析到 root）。 */
  createPorts(root: string): HostPorts
  /** 构造并返回 FlowEngine 实例（只构造，不 load）。 */
  createEngine(options: EngineOptions): EngineLike
  /** core 纯函数桥。 */
  core: CoreBridge
  /** 用户主目录（读/生成 ledger.key）。 */
  homeDir(): string
  /** 插件版本（写进契约快照）。 */
  pluginVersion: string
  /** 生成随机密钥十六进制（ledger HMAC key）。 */
  randomKeyHex(bytes: number): string
  /** 当前会话的日志函数。 */
  log?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/** 宿主能力台账：doctor 报告与面板都读它。键名稳定，新增只追加。 */
export interface HostCapabilities {
  tools: boolean
  toolsGuard: boolean
  toolsRestrict: boolean
  toolsPresentAs: boolean
  toolsExecute: boolean
  toolsPostExecute: boolean
  commands: boolean
  systemPrompt: boolean
  sessionProjections: boolean
  sessions: boolean
  agents: boolean
  subagents: boolean
  sessionQuery: boolean
  userQuestions: boolean
  sessionAppend: boolean
  sessionAppendPluginRecord: boolean
  remote: boolean
  [key: string]: boolean
}

/** 单次工具调用的预判结果（pre-execute 计算，sync guard 消费）。 */
export interface GuardDecisionEntry {
  callId: string
  tool: string
  action?: Action
  caller: CallerInfo
  decision: Decision
  at: number
}

/** 一个被拦截/转人工的动作（投影的面板数据源）。 */
export interface InterceptRecord {
  at: string
  ruleId: string
  tool: string
  target?: string
  effect: 'deny' | 'human'
  why: string
  unlock: string
  source?: string
  violationId?: string
}

/** 插件未生效/降级的原因（doctor 与状态条使用）。 */
export interface InertReason {
  at: string
  stage: string
  message: string
  hint?: string
}

/** 复杂度/风险更新的输入（命令与 Remote 共用）。 */
export interface LevelChangeInput {
  complexity?: Complexity
  risk?: RiskLevel
  reason?: string
}

/** 任务派发句柄（review/dispatch 模块共用）。 */
export interface DispatchedChild {
  taskId?: string
  role: 'executor' | 'reviewer' | 'investigator'
  childId: string
  startedAt: string
  activation: { result: Promise<unknown>; dispose(): Promise<void> }
}

/** 审查结论（host 采集后交给 engine.recordReview）。 */
export interface HostReviewOutcome {
  ok: boolean
  verdict: 'pass' | 'changes-required'
  findings: { severity: string; file: string; line?: number; message: string }[]
  coverageOk: boolean
  message: string
}

/** 门 id 的合法集合（命令解析用，避免把任意字符串传给 engine）。 */
export type HumanGate = Extract<GateId, 'GR' | 'G1' | 'G3' | 'G6'>
