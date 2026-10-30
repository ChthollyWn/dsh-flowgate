/**
 * host 层错误类型与 {error, hint} 包装。
 *
 * DSH 模型可见工具错误统一 `{ error, hint, validValues? }`（03 §10.1）；
 * 命令返回文本也走同样口径。宿主内部异常永远不往上抛，只在 doctor/日志留痕。
 */

/** host 层可预期的错误（带修复提示）。 */
export class HostError extends Error {
  readonly hint: string
  readonly code?: string
  constructor(message: string, hint = '运行 /flow doctor 查看自检结果', code?: string) {
    super(message)
    this.name = 'HostError'
    this.hint = hint
    this.code = code
  }
}

/** 引擎未就绪/未初始化时的统一错误。 */
export class EngineUnavailableError extends HostError {
  constructor(message = 'FlowGate 引擎尚未就绪', hint = '确认项目已用 /flow init 初始化，再运行 /flow doctor 诊断') {
    super(message, hint, 'ENGINE_UNAVAILABLE')
    this.name = 'EngineUnavailableError'
  }
}

/** 宿主能力缺失时的统一错误。 */
export class CapabilityMissingError extends HostError {
  constructor(capability: string, hint = '当前宿主版本缺少该接口；运行 /flow doctor 查看能力清单') {
    super(`当前宿主缺少能力：${capability}`, hint, 'CAPABILITY_MISSING')
    this.name = 'CapabilityMissingError'
  }
}

/** 任意错误 → agent 可见结构。 */
export function toAgentError(error: unknown): { error: string; hint: string; code?: string } {
  if (error instanceof HostError) {
    return { error: error.message, hint: error.hint, ...(error.code ? { code: error.code } : {}) }
  }
  if (error instanceof Error) {
    const hint = (error as Error & { hint?: string }).hint
    const code = (error as Error & { code?: string }).code
    return {
      error: error.message || error.name,
      hint: hint ?? '如果持续出现，运行 /flow doctor 并查看宿主日志',
      ...(typeof code === 'string' && code !== '' && code !== 'ERR' ? { code } : {}),
    }
  }
  return { error: String(error), hint: '如果持续出现，运行 /flow doctor 并查看宿主日志' }
}

/** 任意错误 → 单行中文文本（命令结果/通知用）。 */
export function describeError(error: unknown): string {
  const { error: message, hint } = toAgentError(error)
  return `${message}。${hint}`
}

/** 宿主日志函数类型（与 HostDeps.log 对齐）。 */
export type HostLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void

/** 空操作日志。 */
export const silentLog: HostLog = () => {}
