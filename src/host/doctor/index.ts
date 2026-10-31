/**
 * /flow doctor 与 /flow repair 的宿主侧呈现（03 §14 / §10.2）。
 *
 * `engine.doctor()` 负责账本校验/配置校验/阶段/活动任务/待处理项/覆盖自检；
 * 本模块补上**宿主能力**部分（缺哪些 DSH 接口、哪些功能已降级、事后检测是否
 * 用 git、preset 是否可用等），并统一渲染成人类可读文本。任何字段取不到都不抛错。
 */
import type { HostRuntime } from '../runtime.js'
import type { DoctorReport } from '../../core/types.js'
import { toAgentError } from '../errors.js'
import { postcheckStatus } from '../postcheck/index.js'
import { lastProjectionSelfCheck, projectionInfo } from '../projection/index.js'
import { FLOWGATE_PRESETS } from '../guard/delegation.js'
import { ensureCoverage } from '../coverage/index.js'

/** 能力清单的中文标签（doctor 展示顺序固定）。 */
const CAPABILITY_LABELS: [key: string, label: string][] = [
  ['tools', '工具注册表'],
  ['toolsGuard', '单调守卫 ctx.tools.guard'],
  ['toolsRestrict', '工具限制 restrict'],
  ['toolsPresentAs', '原生工具模式 presentAs'],
  ['toolsExecute', 'tools/execute 包装层'],
  ['toolsPostExecute', 'tools/post-execute'],
  ['commands', '命令注册 ctx.commands'],
  ['systemPrompt', '系统提示注入'],
  ['sessionProjections', '会话投影'],
  ['sessions', '会话服务'],
  ['agents', 'agent 生命周期事件'],
  ['subagents', '子 agent startActivation'],
  ['sessionQuery', '会话查询 sessionQuery'],
  ['sessionAppend', '自定义会话事件'],
  ['sessionAppendPluginRecord', 'appendPluginRecord'],
  ['userQuestions', '结构化提问'],
]

/** 运行 doctor，返回可读文本。 */
export async function formatDoctorReport(runtime: HostRuntime): Promise<string> {
  const lines: string[] = ['FlowGate 自检', '']
  let report: DoctorReport | null = null
  const engine = runtime.engine()
  if (engine) {
    try {
      report = await engine.doctor()
    } catch (error) {
      lines.push(`引擎自检失败：${toAgentError(error).error}`)
      lines.push(`提示：${toAgentError(error).hint}`)
    }
  } else {
    lines.push('引擎：未就绪（项目未初始化或初始化失败）')
    for (const reason of runtime.inertReasons) {
      lines.push(`  降级·${reason.stage}：${reason.message}`)
    }
  }

  if (report) {
    lines.push(`插件版本：${report.pluginVersion}`)
    lines.push(`项目根：${runtime.root() ?? '（未解析）'}`)
    lines.push(`初始化：${report.initialized ? '是' : '否（运行 /flow init 启用）'}`)
    lines.push(`账本：${report.ledgerOk ? '完整' : `校验失败 ${report.ledgerFailures.length} 处`}`)
    for (const failure of report.ledgerFailures.slice(0, 5)) lines.push(`  第 ${failure.line} 行：${failure.reason}`)
    lines.push(`配置：${report.configOk ? '正常' : `错误：${report.configError ?? '未知'}`}`)
    // engine.doctor().message 汇总健康/锁定原因（状态文件损坏时含文件路径与 /flow repair
    // 修复入口）：03 §14 要求状态损坏在 /flow doctor 可见，不能只藏在 /flow status。
    lines.push(`引擎状态：${report.message}`)
    lines.push(`阶段：${report.stage ?? '（无活动变更）'}`)
    lines.push(`活动任务：${report.activeTasks.length > 0 ? report.activeTasks.join('、') : '无'}`)
    lines.push(`待处理项：${report.openPending} 个`)
    lines.push(`守卫心跳：工具调用 ${report.guardHeartbeat.toolCalls} 次 / 判定 ${report.guardHeartbeat.decisions} 次`)
  }

  // 运行模式（P0-4 / P1-7）：enforcement + safe-mode + 自举检测 + 宿主 epoch。
  lines.push('')
  lines.push('运行模式：')
  const safeMode = runtime.safeModeInfo()
  lines.push(`  接管模式：${runtime.enforcement()}（${runtime.enforcementReason()}）`)
  lines.push(
    `  safe-mode：${safeMode.active ? `生效（${safeMode.source ?? 'unknown'}${safeMode.path ? `：${safeMode.path}` : ''}；${safeMode.reason ?? ''}）` : '未触发'}`,
  )
  const safePaths = runtime.safeModePaths()
  lines.push(`  safe-mode 读取路径：${safePaths.length > 0 ? safePaths.join('、') : '（无法解析 home；只支持 FLOWGATE_SAFE/配置）'}`)
  lines.push(`  自举检测：${runtime.isSelfHost() ? '是（项目根是 dsh-flowgate 自身，默认 observe，不拦截写入）' : '否'}`)
  lines.push(`  宿主 epoch：${runtime.hostEpoch()}`)
  lines.push(`  插件启用：${runtime.isEnabled() ? '是' : '否（config.enabled=false）'}`)

  // 模块开关（P0-4）：env/config/safe-mode 三层合并后的实际安装结果。
  lines.push('')
  lines.push('模块开关：')
  const modules = runtime.moduleInfo()
  if (modules.length === 0) {
    lines.push('  未记录（插件安装阶段未完成或运行在测试替身里）')
  } else {
    for (const module of modules) {
      const icon = module.status === 'ok' ? '✓' : module.status === 'failed' ? '✗' : '−'
      lines.push(`  ${icon} ${module.stage}（${module.name}）${module.status === 'skipped' ? `：已跳过（${module.reason ?? '未说明'}）` : module.status === 'failed' ? `：安装失败（${module.reason ?? '未知错误'}）` : ''}`)
    }
  }

  // 覆盖自检：读取前兜底（工具注册早于引擎就绪时可能从未采样，同步补采一次）。
  ensureCoverage(runtime)
  const coverage = runtime.coverage() ?? report?.coverage ?? null
  lines.push('')
  lines.push('工具覆盖自检：')
  if (!coverage) {
    lines.push('  未检查（宿主缺少 ctx.tools.schemas 或尚未就绪）')
  } else {
    lines.push(`  已覆盖可写工具 ${coverage.coveredWritable} 个，未覆盖 ${coverage.uncoveredWritable} 个（检查于 ${coverage.checkedAt}）`)
    const uncovered = coverage.entries.filter((entry) => !entry.covered && entry.category !== 'read' && entry.category !== 'flowgate')
    if (uncovered.length > 0) {
      lines.push(`  需人工确认：${uncovered.map((entry) => `${entry.tool}(${entry.category})`).join('、')}`)
    }
  }

  // 宿主能力
  lines.push('')
  lines.push('宿主能力：')
  const capabilities = runtime.capabilitySnapshot()
  const unavailableHint: Record<string, string> = {
    subagents: '该宿主组合未提供；派发降级为 inline 执行',
    sessionQuery: '该宿主组合未提供；审查读取覆盖降级为启发式核对',
    userQuestions: '该宿主组合未提供；澄清访谈仍以 clarify.md 检查为准',
    remote: '未启用；面板按钮回退为填入 /flow 命令',
  }
  for (const [key, label] of CAPABILITY_LABELS) {
    const ok = capabilities[key] === true
    const hint = ok ? '' : (unavailableHint[key] ?? '')
    lines.push(`  ${ok ? '✓' : '✗'} ${label}${hint ? `（${hint}）` : ''}`)
  }
  lines.push(`  ${capabilities.remote ? '✓' : '✗'} 面板 Remote 调用（未启用时面板按钮回退为填命令）`)

  // 降级原因
  if (runtime.inertReasons.length > 0) {
    lines.push('')
    lines.push('降级/未生效：')
    for (const reason of runtime.inertReasons) {
      lines.push(`  - [${reason.stage}] ${reason.message}${reason.hint ? `；建议：${reason.hint}` : ''}`)
    }
  }

  // 功能说明（去重后最多 20 条）
  const featureLines = Object.entries(runtime.featureNotes).flatMap(([key, messages]) =>
    messages.slice(0, 4).map((message) => `  - [${key}] ${message}`),
  )
  if (featureLines.length > 0) {
    lines.push('')
    lines.push('功能状态：')
    lines.push(...featureLines.slice(0, 20))
  }

  // 事后检测与投影
  const postcheck = postcheckStatus(runtime)
  lines.push('')
  lines.push(`事后检测：${postcheck.gitAvailable ? 'git 可用（前后快照归因）' : 'git 不可用（降级为文件扫描/任务开始快照）'}`)
  const projection = projectionInfo()
  lines.push(`会话投影：key=${projection.key} stateVersion=${projection.stateVersion} record=${projection.recordType}`)
  const selfCheck = runtime.projectionSelfCheck() ?? lastProjectionSelfCheck()
  if (!selfCheck) {
    lines.push('投影自检：未运行（宿主缺少 sessionProjections 服务或尚未注入）')
  } else if (selfCheck.ok) {
    lines.push(`投影自检：通过（${selfCheck.wireBytes ?? 0}B；检查于 ${selfCheck.checkedAt}）`)
  } else {
    lines.push(`投影自检：失败，已跳过注册（${selfCheck.error ?? '未知错误'}）；会话创建不受影响`)
  }
  lines.push(`预设：${FLOWGATE_PRESETS.engineering} / ${FLOWGATE_PRESETS.executor} / ${FLOWGATE_PRESETS.reviewer}（cordis.patch.yml 声明；若宿主未加载 preset 只影响工程模式推荐）`)
  lines.push('')
  lines.push('如需重建状态：/flow repair；如状态文件损坏仍无法恢复：把 .flowgate/state 与账本一起备份后运行 /flow doctor 反馈。')
  return lines.join('\n')
}

/** 运行 repair 并返回可读文本。 */
export async function runRepair(runtime: HostRuntime): Promise<string> {
  const engine = runtime.requireEngine()
  const result = await engine.repair()
  runtime.emit()
  const lines = [result.ok ? '修复完成。' : '修复失败。', result.message]
  if (result.ok) lines.push('已从账本与产物重建状态；如仍有门禁异常，运行 /flow doctor 复查。')
  return lines.join('\n')
}
