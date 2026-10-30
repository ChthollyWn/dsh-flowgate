/**
 * 模型工具注册（03 §10.1）。
 *
 * 注册 14 个 `flow_*` 工具；全部只暴露"推进流程/产出证据"的能力，
 * 没有任何批准/放行/降低等级入口（那些只有 `/flow` 命令=负责人能触发）。
 *
 * 注册失败的工具单独降级：其余工具继续可用，doctor 列出缺失项。
 */
import type { DshContext, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import { createFlowTools, FLOW_TOOL_NAMES } from './definitions.js'
import { toAgentError } from '../errors.js'

/** 安装全部 flow_* 工具。 */
export function installTools(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools || typeof tools.register !== 'function') return
    const disposers: Array<() => void> = []
    // 服务替换时先清掉上一轮的注册（避免重复同名注册抛错）。
    const disposeAll = (): void => {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          dispose?.()
        } catch {
          // 忽略。
        }
      }
    }
    runtime.registerDisposer(disposeAll)
    const registered: string[] = []
    for (const definition of createFlowTools(runtime)) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
        registered.push(definition.name)
      } catch (error) {
        runtime.markInert(`工具注册 ${definition.name}`, error, `工具 ${definition.name} 注册失败，其余 FlowGate 工具不受影响。`)
      }
    }
    runtime.capabilities.tools = true
    runtime.noteFeature('tools', `已注册 ${registered.length}/${FLOW_TOOL_NAMES.length} 个工具：${registered.join('、')}`)
    if (registered.length < FLOW_TOOL_NAMES.length) {
      const missing = FLOW_TOOL_NAMES.filter((name) => !registered.includes(name))
      runtime.noteFeature('tools', `未注册：${missing.join('、')}`)
    }
    // 注册完成后刷新投影（工具面变化会触发 tools/change，覆盖自检在那边重算）。
    runtime.emit()
  })
}

/** 工具注册的自检信息（doctor 用）。 */
export function toolRegistrationInfo(runtime: HostRuntime): { expected: string[]; registered: boolean } {
  return { expected: [...FLOW_TOOL_NAMES], registered: runtime.capabilities.tools === true }
}

/** 工具错误统一入口（供其它模块复用）。 */
export function toolErrorText(error: unknown): string {
  const info = toAgentError(error)
  return `${info.error}（提示：${info.hint}）`
}
