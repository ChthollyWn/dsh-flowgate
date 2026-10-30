/**
 * 配置补丁（/flow learn、/flow parallel 等"只改一个字段"的人工作用）。
 *
 * engine 的配置是内存对象 + `.flowgate/config.yaml` 持久化；宿主不另建写入路径，
 * 而是：读 engine.getConfig() → 合并补丁 → core.renderConfigYaml() → 写文件 →
 * engine.refresh()。这样配置格式始终与 core 的解析/默认值逻辑一致。
 *
 * 注：这些动作只允许人类命令触发（Panel/命令），模型工具不能改配置。
 */
import type { FlowgateConfig } from '../core/types.js'
import type { HostRuntime } from './runtime.js'
import { HostError, toAgentError } from './errors.js'

/** 合并补丁并落盘，然后让 engine 重新加载。 */
export async function patchConfig(runtime: HostRuntime, patch: Partial<FlowgateConfig>): Promise<FlowgateConfig> {
  const engine = runtime.requireEngine()
  const ports = runtime.ports()
  if (!ports) throw new HostError('宿主文件系统端口不可用', '运行 /flow doctor 查看能力')
  const current = engine.getConfig()
  const next: FlowgateConfig = { ...current, ...patch }
  const text = runtime.deps.core.renderConfigYaml(next)
  try {
    await ports.fs.writeFile('.flowgate/config.yaml', text)
  } catch (error) {
    throw new HostError(`写入 .flowgate/config.yaml 失败：${toAgentError(error).error}`, '检查项目目录权限')
  }
  try {
    await engine.refresh()
  } catch (error) {
    throw new HostError(`重新加载配置失败：${toAgentError(error).error}`, '运行 /flow doctor 诊断；配置已写入文件')
  }
  runtime.emit()
  return next
}
