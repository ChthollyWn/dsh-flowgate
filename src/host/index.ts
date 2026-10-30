/**
 * FlowGate 宿主插件入口（Cordis 插件）。
 *
 * 形态（rc.5 实测，见 docs/impl/dsh-plugin-api-cheatsheet.md §4.1）：
 * `export const name` + `export const inject` + `export function apply(ctx, config)`。
 *
 * 鲁棒性约定（03 §14）：
 * - `inject: []`：不硬依赖任何服务，宿主缺接口时插件仍能激活；
 * - 每个功能模块用 `ctx.inject(['服务'], …)` 可选挂载 + 各自 try/catch，
 *   一处失败只让对应功能降级（在 /flow doctor 可见），**绝不影响宿主启动**；
 * - 插件卸载时释放租约、清理心跳与全部注册（ctx.effect）。
 */
import type { DshContext } from './adapters/dsh-types.js'
import type { HostConfig, HostDeps } from './types.js'
import { createHostDeps } from './deps.js'
import { HostRuntime } from './runtime.js'
import { toAgentError } from './errors.js'
import { installFetchDebug } from './debug-fetch.js'

// 各功能模块（按依赖顺序安装；全部内部降级）。
import { installSession } from './session/index.js'
import { installGuard } from './guard/index.js'
import { installDelegation } from './guard/delegation.js'
import { installCoverage } from './coverage/index.js'
import { installPostcheck } from './postcheck/index.js'
import { installEvidenceCompression } from './evidence/index.js'
import { installContext } from './context/index.js'
import { installProjection } from './projection/index.js'
import { installGates } from './gates/index.js'
import { installCommands } from './commands/index.js'
import { installTools } from './tools/index.js'
import { installDispatch } from './dispatch/index.js'

export const name = 'dsh-flowgate'
/** 不强制依赖任何服务；所有能力通过 ctx.inject 可选挂载。 */
export const inject: string[] = []

/** 当前进程内活动的 runtime（doctor/测试/调试用；正常插件生命周期内唯一）。 */
let activeRuntime: HostRuntime | null = null

/** 各模块安装结果（doctor/测试可见）。 */
const moduleStatus: Record<string, 'ok' | 'failed'> = {}

/** 插件入口。任何异常都不得冒泡到宿主启动流程。 */
export function apply(ctx: DshContext, config: HostConfig = {}): void {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    if (env?.FLOWGATE_DEBUG_FETCH === '1') installFetchDebug()
  } catch {
    /* debug hook is best-effort */
  }
  startHostPlugin(ctx, config)
}

/**
 * 装配并启动 host 插件（apply 的实现主体；测试可注入假 deps）。
 * 返回 runtime；连依赖装配都失败时返回 null（此时不注册任何东西，等同未生效）。
 */
export function startHostPlugin(ctx: DshContext, config: HostConfig = {}, deps?: HostDeps): HostRuntime | null {
  const logger = safeLogger(ctx)
  let runtime: HostRuntime
  try {
    runtime = new HostRuntime({ ctx, config, deps: deps ?? createHostDeps({ log: logger }) })
  } catch (error) {
    logger('error', `初始化失败：${toAgentError(error).error}`)
    return null
  }
  activeRuntime = runtime

  // Debug isolation flags (E2E bisect only; never required in normal use):
  // FLOWGATE_DISABLE=context,tools,guard,projection,session,... skips those modules.
  const disabled = new Set(
    String((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FLOWGATE_DISABLE ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const installIf = (key: string, stage: string, fn: () => void): void => {
    if (disabled.has(key)) return
    install(stage, fn)
  }
  installIf('session', '会话生命周期', () => installSession(runtime))
  installIf('guard', '守卫', () => installGuard(runtime))
  installIf('delegation', '原生委派关闭', () => installDelegation(runtime))
  installIf('coverage', '覆盖自检', () => installCoverage(runtime))
  installIf('postcheck', '事后检测', () => installPostcheck(runtime))
  installIf('compression', '输出压缩', () => installEvidenceCompression(runtime))
  installIf('context', '上下文注入', () => installContext(runtime))
  installIf('projection', '会话投影', () => installProjection(runtime))
  installIf('gates', '人工门', () => installGates(runtime))
  installIf('commands', '命令族', () => installCommands(runtime))
  installIf('tools', '模型工具', () => installTools(runtime))
  installIf('dispatch', '任务派发', () => installDispatch(runtime))

  logger('info', `FlowGate host 已激活（模块 ${Object.keys(moduleStatus).length} 个；插件版本 ${runtime.deps.pluginVersion}）`)

  // 插件卸载：释放租约/心跳/全部 disposer。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => () => {
          activeRuntime = null
          void runtime.dispose().catch(() => {
            // 卸载阶段的失败不冒泡。
          })
        },
        'dsh-flowgate: runtime dispose',
      )
    }
  } catch (error) {
    runtime.markInert('卸载清理', error, '插件卸载时的清理注册失败；宿主重启时会话租约由心跳超时自动释放。')
  }
  return runtime

  function install(stage: string, fn: () => void): void {
    try {
      fn()
      moduleStatus[stage] = 'ok'
    } catch (error) {
      moduleStatus[stage] = 'failed'
      runtime.markInert(stage, error, `FlowGate 的「${stage}」功能未生效；其余功能不受影响，运行 /flow doctor 查看。`)
    }
  }
}

/** 读取模块安装状态（测试/doctor 用）。 */
export function moduleInstallStatus(): Record<string, 'ok' | 'failed'> {
  return { ...moduleStatus }
}

/** 读取活动 runtime（测试/doctor 用；插件未加载时为 null）。 */
export function activeHostRuntime(): HostRuntime | null {
  return activeRuntime
}

/** 测试用：重置活动 runtime 与模块状态。 */
export function resetHostPluginForTest(): void {
  activeRuntime = null
  for (const key of Object.keys(moduleStatus)) delete moduleStatus[key]
}

function safeLogger(ctx: DshContext): (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void {
  return (level, message) => {
    try {
      const logger = ctx.logger
      if (!logger) return
      const line = `[flowgate] ${message}`
      if (level === 'error') logger.error(line)
      else if (level === 'warn') logger.warn(line)
      else if (level === 'info') logger.info(line)
      else logger.debug(line)
    } catch {
      // 日志失败忽略。
    }
  }
}
