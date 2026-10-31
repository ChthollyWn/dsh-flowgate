/**
 * 人工专属命令族 `/flow`（03 §10.2 / H9）。
 *
 * 命令只在负责人输入框（或面板按钮填命令）触发，**不进模型消息**；因此批准、
 * 放行、降低等级等动作只可能由人执行。handler 直接调 engine，返回文本由 UI 渲染。
 *
 * 单条命令注册策略：DSH 命令是扁平的（`/flow` 后面全是 rawInput），所以只注册
 * 一个 `flow`，子命令在本模块解析——这样 `ctx.commands` 里只占一个名字。
 */
import type { DshAgent, DshCommandDefinition, DshCommandRuntime, DshContext } from '../adapters/dsh-types.js'
import type { EngineLike } from '../types.js'
import type { HostRuntime } from '../runtime.js'
import { openLocalPath } from '../open.js'
import type { Complexity, FlowRoute, GateId, PendingItem, RiskLevel } from '../../core/types.js'
import { HostError, describeError, toAgentError } from '../errors.js'
import { approveHumanGate, confirmCardText, rejectCurrentGate } from '../gates/index.js'
import { formatDoctorReport, runRepair } from '../doctor/index.js'
import { patchConfig } from '../config-patch.js'
import { runInit } from '../init/index.js'
import { ensureCoverage } from '../coverage/index.js'

/** 解析后的 /flow 命令。 */
export interface ParsedFlowCommand {
  verb: string
  /** 去掉 verb 后的原始参数串（保留引号/空格，用于退回意见等自由文本）。 */
  rest: string
  args: string[]
}

/** 解析 `/flow <verb> <args...>`（verb 全小写；空输入视为 status）。 */
export function parseFlowCommand(rawInput: string): ParsedFlowCommand {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { verb: 'status', rest: '', args: [] }
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
  const verb = (match?.[1] ?? 'status').toLowerCase()
  const rest = (match?.[2] ?? '').trim()
  return { verb, rest, args: rest === '' ? [] : rest.split(/\s+/) }
}

/** 命令清单（help 与 doctor 共用）。 */
export const FLOW_COMMAND_HELP = [
  '/flow — 当前状态（阶段、门禁检查项、活动任务、待处理项）',
  '/flow init — 扫描仓库生成 .flowgate/project.md 草稿并启用',
  '/flow new <描述> — 立项；`--project` 声明新项目，`--analysis` 分析任务，`--from-roadmap C1` 从路线图立项',
  '/flow approve [门] — 批准人工门（GR/G1/G3/G6；低复杂度 G3 同时批准 G1）',
  '/flow reject <意见> — 退回当前人工门，意见注入给 agent',
  '/flow allow-once <规则id|last> <理由> — 单次放行',
  '/flow scope approve|reject <SC-n> [理由] — 范围变更申请',
  '/flow risk approve|reject <RK-n> [理由] — 风险接管项',
  '/flow unblock [BL-n|任务id] [理由] — 解除连续失败熔断：清零失败计数、任务恢复执行（无参时处理唯一 open blocker）',
  '/flow plan approve|reject <PC-n> [理由] — 计划修订申请',
  '/flow rule approve|reject <RL-n> [理由] — 规则沉淀提议',
  '/flow conflict approve|reject <CF-n> [理由] — 集成检查点冲突/失败：approve=确认已修好并重试检查点，reject=放弃自动重试',
  '/flow tamper approve|reject <TM-n> [理由] — 疑似篡改（跳过测试/删断言/改测试基础设施）：approve=确认是合法重构',
  '/flow external confirm [路径|all] — 确认非 agent 改动（编辑器/格式化），G6 前必须清零',
  '/flow rework <defect|requirement|unknown> [任务id...] <理由> — 返工声明：按类型失效回执与审查',
  '/flow review waive <RV-n> <理由> — 负责人豁免误报的审查 findings（写账本）',
  '/flow exception add <规则id> <路径模式|-> <理由> | revoke <EX-n> [理由] | list — 规则例外管理',
  '/flow route <full|standard|fast> <理由> — 覆盖自动流程路由（auto-review 建议；负责人可强制切换）',
  '/flow complexity <低|中|高|超高> [理由] — 改复杂度',
  '/flow risk-level <普通|高> [理由] — 改风险等级',
  '/flow metrics [--csv] — 指标',
  '/flow report — 生成 HTML 交付报告',
  '/flow board — 生成跨会话看板 dashboard.html',
  '/flow roadmap — 查看路线图',
  '/flow parallel <数量> — 调整并行上限（只影响之后启动的批次）',
  '/flow resume [变更] [--takeover] — 继续进行中的变更',
  '/flow pause — 暂停当前变更并写交接摘要',
  '/flow handoff — 立即生成交接摘要',
  '/flow doctor — 自检（守卫心跳、覆盖、账本、宿主能力）',
  '/flow repair — 从账本重建状态、退出锁定模式',
  '/flow off [理由] / /flow on — 本会话关闭/恢复门禁',
].join('\n')

/** 安装命令族。 */
export function installCommands(runtime: HostRuntime): void {
  runtime.injectService('commands', (scoped: DshContext) => {
    const commands = scoped.get('commands') as DshCommandRuntime | null
    if (!commands || typeof commands.register !== 'function') return
    const definition: DshCommandDefinition = {
      name: 'flow',
      description: 'FlowGate 流程门禁：状态、立项、门禁、放行、指标与自检',
      input: { hint: 'init | status | new <描述> | approve <门> | unblock [BL-n] | doctor' },
      recordInput: true,
      handler: async (invocation) => {
        try {
          const agent = invocation?.agent
          const result = await executeFlowCommand(runtime, invocation?.rawInput ?? '', agent)
          return { kind: 'success', text: result }
        } catch (error) {
          return { kind: 'error', text: describeError(error) }
        }
      },
    }
    if (typeof commands.register === 'function') {
      const dispose = commands.register(definition)
      if (typeof dispose === 'function') runtime.registerDisposer(dispose)
    }
    runtime.capabilities.commands = true
    runtime.noteFeature('commands', '已注册 /flow 命令族')
  })
}

/** 执行一条 /flow 命令并返回给人类看的文本（纯业务，命令 handler 与测试共用）。 */
export async function executeFlowCommand(runtime: HostRuntime, rawInput: string, agent?: DshAgent | null): Promise<string> {
  const { verb, rest, args } = parseFlowCommand(rawInput)
  switch (verb) {
    case 'status':
      return statusCommand(runtime)
    case 'help':
      return `FlowGate 命令：\n${FLOW_COMMAND_HELP}`
    case 'init':
      return initCommand(runtime)
    case 'new':
      return newCommand(runtime, rest, args)
    case 'approve':
      return approveCommand(runtime, agent ?? null, args, rest)
    case 'reject':
      return rejectCurrentGate(runtime, agent ?? null, rest)
    case 'allow-once': {
      const ruleId = args[0]
      const reason = args.slice(1).join(' ')
      if (!ruleId || reason.trim() === '') throw new HostError('用法：/flow allow-once <规则id|last> <理由>', '例：/flow allow-once R-SCOPE 临时核对构建脚本')
      const override = await runtime.requireEngine().allowOnce(ruleId, reason)
      runtime.emit()
      return `已单次放行 ${override.ruleId}（${override.id}）：${reason}。该放行只抵消指定规则一次。`
    }
    case 'scope':
    case 'risk':
    case 'plan':
    case 'rule':
    case 'conflict':
    case 'tamper':
      return pendingCommand(runtime, verb, args)
    case 'external':
      return externalCommand(runtime, args)
    case 'exception':
      return exceptionCommand(runtime, args)
    case 'rework':
      return reworkCommand(runtime, args)
    case 'review':
      return reviewCommand(runtime, args)
    case 'unblock':
      return unblockCommand(runtime, args)
    case 'route':
      return routeCommand(runtime, args)
    case 'complexity':
      return complexityCommand(runtime, rest)
    case 'risk-level':
      return riskCommand(runtime, rest)
    case 'metrics': {
      const engine = await engineFor(runtime, agent)
      const set = await engine.generateMetrics()
      const csv = args.includes('--csv')
      return csv ? runtime.deps.core.metricsCsv(set) : runtime.deps.core.formatMetricsText(set)
    }
    case 'report': {
      const engine = await engineFor(runtime, agent)
      const result = await engine.generateReport()
      const opened = await openLocalPath(runtime, result.path)
      return `已生成交付报告：${result.path}\n${opened.message}`
    }
    case 'board': {
      const engine = await engineFor(runtime, agent)
      const result = await engine.generateBoard()
      const opened = await openLocalPath(runtime, result.path)
      return `已生成跨会话看板：${result.path}\n${opened.message}`
    }
    case 'roadmap':
      return roadmapCommand(runtime, agent ?? null)
    case 'parallel':
      return parallelCommand(runtime, args)
    case 'resume':
      return resumeCommand(runtime, agent ?? null, args)
    case 'pause': {
      const engine = runtime.requireEngine()
      const handoff = await engine.pauseChange()
      runtime.emit()
      return `已暂停当前变更并写交接摘要：${handoff.text}\n租约已释放；新会话可用 /flow resume 继续。`
    }
    case 'handoff': {
      const engine = runtime.requireEngine()
      const handoff = await engine.generateHandoff()
      runtime.emit()
      return `交接摘要（${handoff.at}）：${handoff.text}\n下一步：${handoff.next}`
    }
    case 'doctor': {
      if (!runtime.engine() && runtime.mainAgent()) await runtime.ensureEngine()
      return await formatDoctorReport(runtime)
    }
    case 'repair':
      return runRepair(runtime)
    case 'off': {
      const engine = await engineFor(runtime, agent)
      await engine.setOff(true, rest === '' ? '负责人手动关闭' : rest)
      runtime.emit()
      return '本会话门禁已关闭（/flow off），操作不再拦截；账本已记录。恢复：/flow on。'
    }
    case 'on': {
      const engine = await engineFor(runtime, agent)
      await engine.setOff(false, rest === '' ? '负责人手动恢复' : rest)
      runtime.emit()
      return '门禁已恢复（/flow on）。'
    }
    default:
      throw new HostError(`未知子命令：${verb}`, `运行 /flow help 查看支持的命令；当前输入：/flow ${verb}`)
  }
}

/** 取引擎（命令可能先于 agent/created 到达：这里懒绑定）。 */
async function engineFor(runtime: HostRuntime, agent?: DshAgent | null): Promise<EngineLike> {
  if (!runtime.mainAgent() && agent) runtime.bindMainAgent(agent)
  const engine = await runtime.ensureEngine(agent ?? undefined)
  if (!engine) {
    throw new HostError(
      'FlowGate 引擎未就绪',
      runtime.inertReasons.length > 0
        ? `最近一次失败：${runtime.inertReasons[runtime.inertReasons.length - 1]?.message}；运行 /flow doctor 查看`
        : '确认会话有工作目录，且项目可读；运行 /flow doctor 诊断',
    )
  }
  return engine
}

function statusCommand(runtime: HostRuntime): string {
  const engine = runtime.engine()
  if (!engine) {
    return runtime.isEnabled()
      ? 'FlowGate 未启用：项目没有 .flowgate/config.yaml。运行 /flow init 启用。'
      : 'FlowGate 已禁用（插件配置 enabled=false）。'
  }
  const lines = [engine.statusText()]
  const notices = safeNotices(engine)
  if (notices.length > 0) lines.push('', '通知：', ...notices.map((notice) => `- ${notice}`))
  // 覆盖自检：读取前兜底（从未采样时同步补采一次，避免状态栏显示"未检查"）。
  ensureCoverage(runtime)
  if (runtime.coverage()?.uncoveredWritable) {
    lines.push('', `覆盖自检：有 ${runtime.coverage()?.uncoveredWritable} 个可写工具未被规则覆盖，运行 /flow doctor 查看。`)
  }
  return lines.join('\n')
}

async function initCommand(runtime: HostRuntime): Promise<string> {
  return await runInit(runtime)
}

async function newCommand(runtime: HostRuntime, rest: string, args: string[]): Promise<string> {
  const engine = await engineFor(runtime)
  let project = false
  let kind: 'change' | 'analysis' = 'change'
  let fromRoadmap: string | undefined
  let relatedTo: string | undefined
  let complexityHint: Complexity | undefined
  let riskHint: RiskLevel | undefined
  const words: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--project') {
      project = true
      continue
    }
    if (arg === '--analysis') {
      kind = 'analysis'
      continue
    }
    if (arg === '--from-roadmap') {
      fromRoadmap = args[++index]
      continue
    }
    if (arg.startsWith('--from-roadmap=')) {
      fromRoadmap = arg.slice('--from-roadmap='.length)
      continue
    }
    if (arg === '--related-to') {
      relatedTo = args[++index]
      continue
    }
    if (arg.startsWith('--related-to=')) {
      relatedTo = arg.slice('--related-to='.length)
      continue
    }
    if (arg === '--complexity') {
      complexityHint = (args[++index] as Complexity | undefined) ?? undefined
      continue
    }
    if (arg === '--risk') {
      riskHint = (args[++index] as RiskLevel | undefined) ?? undefined
      continue
    }
    words.push(arg)
  }
  const title = words.join(' ').trim()
  if (title === '' && !project) throw new HostError('立项需要一个标题', '例：/flow new 续费回调幂等；新项目：/flow new --project 计费系统重构')
  const input = {
    title: title === '' ? (rest.replace(/--project/g, '').trim() || '新项目') : title,
    ...(project ? { project: true } : {}),
    ...(kind === 'analysis' ? { kind } : {}),
    ...(fromRoadmap ? { fromRoadmap } : {}),
    ...(relatedTo ? { relatedTo } : {}),
    ...(complexityHint ? { complexityHint } : {}),
    ...(riskHint ? { riskHint } : {}),
  }
  const outcome = await engine.newChange(input)
  runtime.emit()
  const suggestion = outcome.suggestion
  const lines = [outcome.message, `变更 id：${outcome.changeId}`]
  if (suggestion) {
    lines.push(`建议复杂度：${suggestion.complexity}（${suggestion.reasons.complexity.slice(0, 2).join('；') || '无'}）`)
    lines.push(`建议风险：${suggestion.risk}（${suggestion.reasons.risk.slice(0, 2).join('；') || '无'}）`)
    if (outcome.awaiting === 'owner') lines.push('等级等待负责人确认：/flow complexity <级别> 或直接 approve。')
  }
  lines.push('下一步：按注入的流程推进；S1 先用 ask_user_question 澄清需求。')
  return lines.join('\n')
}

async function approveCommand(runtime: HostRuntime, agent: DshAgent | null, args: string[], rest: string): Promise<string> {
  const engine = runtime.requireEngine()
  const snapshot = safeSnapshot(runtime)
  const gateArg = args[0]
  const gateCandidate =
    gateArg !== undefined
      ? gateArg.toUpperCase()
      : (snapshot?.awaitingGate as string | undefined) ?? (snapshot?.pendingGate as string | undefined)
  if (!gateCandidate) throw new HostError('当前没有可批准的门', '运行 /flow 查看当前阶段与门禁状态')
  const lines: string[] = []
  // 低复杂度方案确认卡：批准前把卡片内容给负责人看一眼。
  if (gateCandidate === 'G3' && snapshot?.complexity === 'low') {
    const card = confirmCardText(runtime)
    if (card) lines.push(card, '')
  }
  const confirmRisks = args.includes('--confirm-risks') || rest.includes('--confirm-risks')
  const reasonArgs = args.filter((arg) => arg !== '--confirm-risks')
  const reasonFromArgs = reasonArgs.length > 1 ? reasonArgs.slice(1).join(' ') : undefined
  const reasonFromRest = rest.includes(' ')
    ? rest
        .split(/\s+/)
        .slice(1)
        .filter((token) => token !== '--confirm-risks')
        .join(' ')
    : ''
  const reason = reasonFromArgs ?? (reasonFromRest !== '' ? reasonFromRest : undefined)
  const text = await approveHumanGate(runtime, agent, gateCandidate, reason, { confirmRisks })
  lines.push(text)
  void engine
  return lines.join('\n')
}

/**
 * `/flow external confirm [路径|all]`：负责人确认「这些不是 agent 改的」。
 * 不传参数等价 all；G6 的 g6.externalChanges 要求全部确认。
 */
async function externalCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const engine = await engineFor(runtime)
  const change = engine.currentChange()
  if (!change) throw new HostError('当前没有进行中的变更', '运行 /flow 查看状态')
  const pendingExternal = (change.externalChanges ?? []).filter((item) => item.confirmedAt === undefined)
  if (pendingExternal.length === 0) return '当前没有待确认的非 agent 改动。'
  const target = (args[0] ?? 'all').toLowerCase()
  const paths = target === 'all' ? undefined : args
  const confirmed = await engine.acknowledgeExternalChanges(paths)
  runtime.emit()
  return confirmed === 0
    ? `没有匹配的待确认非 agent 改动：${args.join(' ')}。运行 /flow 查看列表。`
    : `已确认 ${confirmed} 处非 agent 改动。`
}

/** `/flow rework <defect|requirement|unknown> [任务...] <理由>`（T3.8）。 */
async function reworkCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const engine = await engineFor(runtime)
  const kind = (args[0] ?? '').toLowerCase()
  if (kind !== 'defect' && kind !== 'requirement' && kind !== 'unknown') {
    throw new HostError('用法：/flow rework <defect|requirement|unknown> [任务id...] <理由>', '例：/flow rework defect T2 回调幂等有缺陷')
  }
  const taskIds: string[] = []
  let index = 1
  while (index < args.length && /^[TtA-Za-z]+-?\d+/.test(args[index]!)) {
    taskIds.push(args[index]!.toUpperCase())
    index += 1
  }
  const reason = args.slice(index).join(' ')
  if (reason.trim() === '') throw new HostError('返工声明必须写理由', '说明缺陷/需求变更与影响范围')
  const result = await engine.declareRework({ kind, ...(taskIds.length > 0 ? { taskIds } : {}), reason })
  runtime.emit()
  return `返工已声明（${kind}）：失效任务 ${result.invalidatedTasks.join('、') || '无'}；保留任务 ${result.keptTasks.join('、') || '无'}；阶段 ${result.stage}。`
}

/** `/flow review waive <RV-n> <理由>`（T3.4 负责人豁免）。 */
async function reviewCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const action = (args[0] ?? '').toLowerCase()
  if (action !== 'waive') throw new HostError('用法：/flow review waive <RV-n> <理由>', '运行 /flow 查看审查记录')
  const id = args[1]
  const reason = args.slice(2).join(' ')
  if (!id || reason.trim() === '') throw new HostError('豁免审查必须写 id 与理由', '例：/flow review waive RV-2 该 finding 是误报，已有等价测试')
  const engine = await engineFor(runtime)
  const review = await engine.waiveReview(id, reason)
  runtime.emit()
  return `审查记录 ${review.id} 已豁免：${reason}`
}

/**
 * `/flow exception add|revoke|list`：规则例外的负责人入口（T5.1 验收 #1）。
 * 例外与单次放行的区别：例外可重复命中、可撤销；单次放行只抵消一次。
 */
async function exceptionCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const engine = await engineFor(runtime)
  const action = (args[0] ?? '').toLowerCase()
  if (action === 'list') {
    const change = engine.currentChange()
    const list = change?.exceptions ?? []
    if (list.length === 0) return '当前变更没有规则例外。'
    return [
      '规则例外：',
      ...list.map((exception) =>
        `- ${exception.id} · ${exception.ruleId}${exception.pathPattern !== undefined ? ` @ ${exception.pathPattern}` : ''} · ${exception.revokedAt !== undefined ? '已撤销' : '生效中'} · ${exception.reason}`,
      ),
    ].join('\n')
  }
  if (action === 'add') {
    const ruleId = args[1]
    const pathPattern = args[2]
    const reason = args.slice(3).join(' ')
    if (!ruleId || !pathPattern || reason.trim() === '') {
      throw new HostError('用法：/flow exception add <规则id> <路径模式|-> <理由>', '例：/flow exception add R-SCOPE src/legacy/** 迁移期间允许改旧适配层')
    }
    const exception = await engine.addException(ruleId, pathPattern === '-' ? undefined : pathPattern, reason)
    runtime.emit()
    return `已加入例外 ${exception.id}：规则 ${exception.ruleId}${exception.pathPattern !== undefined ? ` @ ${exception.pathPattern}` : ''}；可用 /flow exception revoke ${exception.id} 撤销。`
  }
  if (action === 'revoke') {
    const id = args[1]
    if (!id) throw new HostError('用法：/flow exception revoke <EX-n> [理由]', '运行 /flow exception list 查看例外')
    await engine.revokeException(id, args.slice(2).join(' ') || undefined)
    runtime.emit()
    return `例外 ${id} 已撤销。`
  }
  throw new HostError('用法：/flow exception add|revoke|list', '例：/flow exception list')
}

async function pendingCommand(
  runtime: HostRuntime,
  kind: 'scope' | 'risk' | 'plan' | 'rule' | 'conflict' | 'tamper',
  args: string[],
): Promise<string> {
  const action = (args[0] ?? '').toLowerCase()
  const id = args[1]
  const reason = args.slice(2).join(' ')
  if (action !== 'approve' && action !== 'reject') {
    throw new HostError(`用法：/flow ${kind} approve <id> [理由] 或 /flow ${kind} reject <id> <理由>`, '运行 /flow 查看待处理项 id')
  }
  if (!id) throw new HostError('缺少待处理项 id', '运行 /flow 查看待处理项列表')
  if (action === 'reject' && reason.trim() === '') throw new HostError('退回必须写理由', '例：/flow scope reject SC-1 范围太大，拆成两次变更')
  const engine = await engineFor(runtime)
  const item = await engine.decidePending(id, action === 'approve' ? 'approved' : 'rejected', reason === '' ? undefined : reason)
  runtime.emit()
  const label =
    kind === 'scope'
      ? '范围变更'
      : kind === 'risk'
        ? '风险接管'
        : kind === 'plan'
          ? '计划修订'
          : kind === 'conflict'
            ? '集成检查点冲突'
            : kind === 'tamper'
              ? '篡改嫌疑'
              : '规则提议'
  return `${label} ${item.id} 已${action === 'approve' ? '批准' : '退回'}。${item.title}`
}

/** 非 blocker 待处理项对应的处理命令（错误提示用）。 */
function pendingKindHint(kind: string): string {
  switch (kind) {
    case 'scope':
      return '/flow scope approve <SC-n>'
    case 'risk':
      return '/flow risk approve <RK-n>'
    case 'plan':
      return '/flow plan approve <PC-n>'
    case 'rule':
      return '/flow rule approve <RL-n>'
    case 'conflict':
      return '/flow conflict approve <CF-n>（确认已修好并重试检查点）或 /flow conflict reject <CF-n> <理由>（放弃自动重试）'
    case 'tamper':
      return '/flow tamper approve <TM-n>（确认是合法重构）或 /flow tamper reject <TM-n> <理由>'
    default:
      return '运行 /flow 查看待处理项列表'
  }
}

/**
 * `/flow unblock [BL-id|任务id] [理由]`：负责人确认「熔断解除，任务继续」。
 *
 * 命令只是入口，真正的状态迁移在 engine.decidePending(...,'approved') 的 blocker 分支：
 * 失败计数清零、任务恢复执行、同任务其它 open BL 一并关闭，并写 task.unblocked 账本事件。
 * 无参数时只处理当前变更里**唯一**的 open blocker（多个时必须显式指定，避免误放行）。
 */
async function unblockCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const engine = await engineFor(runtime)
  const change = engine.currentChange()
  if (!change) throw new HostError('当前没有进行中的变更', '没有活动变更时没有需要解锁的熔断阻断项；运行 /flow 查看状态')
  const openBlockers = change.pending.filter((item) => item.status === 'open' && item.kind === 'blocker')
  const requested = args[0]
  const reason = args.slice(1).join(' ') || undefined
  let target: PendingItem | undefined

  if (requested === undefined || requested === '') {
    if (openBlockers.length === 0) {
      throw new HostError('当前没有待解锁的熔断阻断项（BL-n）', '连续验证失败达到上限时才会产生阻断项；运行 /flow 查看当前状态')
    }
    if (openBlockers.length > 1) {
      throw new HostError(
        `有 ${openBlockers.length} 个待解锁阻断项，需要指定 BL id：${openBlockers.map((item) => item.id).join('、')}`,
        `例：/flow unblock ${openBlockers[0]?.id}；无条件解锁会误放行其它任务`,
      )
    }
    target = openBlockers[0]
  } else {
    const byId = change.pending.find((item) => item.id === requested)
    if (byId) {
      if (byId.kind !== 'blocker') {
        throw new HostError(
          `${byId.id} 不是熔断阻断项（kind=${byId.kind}），不能用 /flow unblock`,
          `${byId.id} 的处理方式：${pendingKindHint(byId.kind)}`,
        )
      }
      if (byId.status !== 'open') {
        throw new HostError(`${byId.id} 已经处理过（${byId.status}）`, '不能重复解锁；运行 /flow 查看待处理项')
      }
      target = byId
    } else {
      const forTask = openBlockers.filter((item) => String(item.data?.taskId ?? item.scope?.taskId ?? '') === requested)
      if (forTask.length === 0) {
        throw new HostError(
          `没有待解锁的阻断项：${requested}`,
          '按 BL id（如 BL-1）或任务 id（如 T1）解锁；运行 /flow 查看待处理项与任务列表',
        )
      }
      if (forTask.length > 1) {
        throw new HostError(
          `任务 ${requested} 有多个待解锁阻断项：${forTask.map((item) => item.id).join('、')}`,
          `例：/flow unblock ${forTask[0]?.id}`,
        )
      }
      target = forTask[0]
    }
  }
  if (!target) throw new HostError(`没有待解锁的阻断项：${requested ?? ''}`, '运行 /flow 查看待处理项与任务列表')

  const blockerId = target.id
  const taskId = String(target.data?.taskId ?? target.scope?.taskId ?? '')
  await engine.decidePending(blockerId, 'approved', reason)
  runtime.emit()
  return [
    `已解锁熔断阻断项 ${blockerId}${taskId ? `（任务 ${taskId}）` : ''}：失败计数清零、任务恢复执行。`,
    ...(taskId ? [`agent 现在可以继续 flow_* 调用（flow_verify / flow_task_done 等）；只读动作本就未受限。`] : []),
    '同任务的其它 open 阻断项与旧版熔断残留项已一并关闭。',
  ].join('\n')
}

async function complexityCommand(runtime: HostRuntime, rest: string): Promise<string> {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest.trim())
  const level = match?.[1] ?? ''
  const reason = (match?.[2] ?? '').trim()
  if (level === '') throw new HostError('用法：/flow complexity <低|中|高|超高> [理由]', '例：/flow complexity 高 涉及支付链路')
  if (reason === '' && isDowngradeComplexity(level)) throw new HostError('降低复杂度必须写理由', '例：/flow complexity 中 只改文案，不涉及接口')
  const engine = await engineFor(runtime)
  const result = await engine.changeComplexity(level, reason === '' ? undefined : reason)
  runtime.emit()
  return result.message || `复杂度已改为 ${level}。`
}

function isDowngradeComplexity(level: string): boolean {
  return ['低', 'low'].includes(level)
}

async function riskCommand(runtime: HostRuntime, rest: string): Promise<string> {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest.trim())
  const level = match?.[1] ?? ''
  const reason = (match?.[2] ?? '').trim()
  if (level === '') throw new HostError('用法：/flow risk-level <普通|高> [理由]', '例：/flow risk-level 高 涉及账号安全')
  if (reason === '' && ['普通', 'normal'].includes(level)) throw new HostError('降低风险等级必须写理由', '例：/flow risk-level 普通 只影响内部工具')
  const engine = await engineFor(runtime)
  const result = await engine.changeRiskLevel(level, reason === '' ? undefined : reason)
  runtime.emit()
  return result.message || `风险等级已改为 ${level}。`
}

async function routeCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const route = (args[0] ?? '').toLowerCase()
  if (route !== 'full' && route !== 'standard' && route !== 'fast') {
    throw new HostError('用法：/flow route <full|standard|fast> <理由>', 'full=全流程人工门；standard=合并 G1+G3 一次确认；fast=检查通过后自动放行')
  }
  const reason = args.slice(1).join(' ').trim()
  const engine = await engineFor(runtime)
  const text = await engine.setFlowRoute(route as FlowRoute, reason)
  runtime.emit()
  return text
}

async function parallelCommand(runtime: HostRuntime, args: string[]): Promise<string> {
  const raw = args[0]
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value) || value <= 0) throw new HostError('用法：/flow parallel <数量>', '例：/flow parallel 3；数量必须是正整数')
  const engine = await engineFor(runtime)
  const current = engine.getConfig()
  const max = Math.min(value, 8)
  await patchConfig(runtime, { parallel: { ...current.parallel, max_agents: max } })
  return `并行上限已调整为 ${max}（只影响之后启动的批次；宿主 maxActiveSubagents 上限仍生效）。`
}

async function roadmapCommand(runtime: HostRuntime, agent?: DshAgent | null): Promise<string> {
  const engine = await engineFor(runtime, agent)
  const roadmap = engine.getRoadmap()
  if (!roadmap) return '当前项目没有 roadmap.md（只有 /flow new --project 声明的新项目才有路线图阶段）。'
  const lines = [`路线图：${roadmap.title}`, `MVP 切割：${roadmap.mvpCut}`]
  for (const entry of roadmap.entries) {
    lines.push(`- ${entry.change} ${entry.capability}｜${entry.status}${entry.mvp ? '（MVP）' : ''}：${entry.goal}`)
  }
  const delivered = roadmap.entries.filter((entry) => entry.status === '已交付').length
  lines.push(`进度：${delivered}/${roadmap.entries.length} 已交付。`)
  return lines.join('\n')
}

async function resumeCommand(runtime: HostRuntime, agent: DshAgent | null, args: string[]): Promise<string> {
  const takeover = args.includes('--takeover')
  const engine = await engineFor(runtime, agent)
  const changeArg = args.find((arg) => !arg.startsWith('--'))
  let changeId = changeArg
  if (!changeId) {
    const active = engine.allChanges().filter((change) => change.lifecycle === 'active')
    if (active.length === 1) changeId = active[0]?.id
    else if (active.length === 0) throw new HostError('没有进行中的变更', '用 /flow new <描述> 立项')
    else throw new HostError(`有多个进行中的变更，需要指定：${active.map((change) => change.id).join('、')}`, '例：/flow resume C-002')
  }
  if (!changeId) throw new HostError('没有进行中的变更', '用 /flow new <描述> 立项')
  await engine.resumeChange(changeId, takeover ? { takeover: true } : {})
  runtime.emit()
  return `已接续 ${changeId}${takeover ? '（接管）' : ''}。当前阶段：${safeSnapshot(runtime)?.stage ?? '未知'}。`
}

function safeSnapshot(runtime: HostRuntime) {
  try {
    return runtime.engine()?.snapshot() ?? null
  } catch {
    return null
  }
}

function safeNotices(engine: EngineLike): string[] {
  try {
    return engine.takeNotices()
  } catch {
    return []
  }
}

/** 供测试/doctor：命令注册是否成功。 */
export function commandNames(): string[] {
  return ['flow']
}

/** 处理命令期间的错误并转成 UI 文本（handler 已在内部使用；保留导出便于测试）。 */
export function commandErrorMessage(error: unknown): string {
  const info = toAgentError(error)
  return `${info.error}\n提示：${info.hint}`
}

/** gate 合法值（供解析与测试）。 */
export const GATE_VALUES: readonly GateId[] = ['GR', 'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'TG']
