/**
 * /flow init（03 §10.2 / §13；FR-3.1）。
 *
 * 关键：**engine.init() 自己会写 `.flowgate/project.md` 与 `config.yaml`**（探测技术栈、
 * 生成草稿、不覆盖已有配置）——host 不重复写，只负责：
 * 1. 调 engine.init()；
 * 2. 把探测结果/风险/非 git 提示整理成给负责人的文本；
 * 3. 若模板里命令探测置信度低，提示负责人核对 project.md。
 */
import type { DshAgent } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import { toAgentError } from '../errors.js'
import type { InitResult } from '../../core/types.js'

/** 执行 /flow init 并返回文本。 */
export async function runInit(runtime: HostRuntime, agent?: DshAgent | null): Promise<string> {
  const engine = runtime.engine() ?? (await runtime.ensureEngine(agent ?? undefined))
  if (!engine) {
    const reason = runtime.inertReasons[runtime.inertReasons.length - 1]
    throw new Error(`引擎初始化失败：${reason?.message ?? '未知原因'}。${reason?.hint ?? '运行 /flow doctor 诊断'}`)
  }
  if (engine.isInitialized()) {
    const result = await engine.init() // engine 对已初始化项目返回既有 project.md 信息，不覆盖配置。
    runtime.emit()
    return [
      result.message,
      '提示：要更新 project.md 请直接编辑该文件，然后运行 /flow repair 重建缓存。',
      '下一步：/flow new <描述> 立项。',
    ].join('\n')
  }
  let result: InitResult
  try {
    result = await engine.init()
  } catch (error) {
    throw new Error(`初始化失败：${toAgentError(error).error}。提示：${toAgentError(error).hint}`)
  }
  runtime.emit()
  const lines = [result.message]
  const commands = Object.entries(result.detectedCommands)
    .filter(([, value]) => typeof value === 'string' && value !== '' && value !== 'none')
    .map(([key, value]) => `  - ${key}: ${value}`)
  if (commands.length > 0) lines.push('探测到的命令（请核对 project.md）：', ...commands)
  if (result.risks.length > 0) lines.push('风险提示：', ...result.risks.map((risk) => `  - ${risk}`))
  if (result.filesRead.length > 0) lines.push(`生成 project.md 时读取了 ${result.filesRead.length} 个文件。`)
  try {
    const root = runtime.root()
    const git = runtime.ports()?.git
    if (root && git && !(await git.isRepo(root))) {
      lines.push('注意：当前不是 git 仓库，事后范围检测会降级。建议执行 `git init` 并把初始提交作为基线，再开始第一个变更。')
    }
  } catch {
    // 忽略 git 探测失败。
  }
  lines.push('下一步：')
  lines.push('1. 打开 .flowgate/project.md 核对技术栈、命令与可复用模块清单（agent 可以用 read 读）；')
  lines.push('2. 新项目用 /flow new --project <描述> 进入项目级澄清与路线图；')
  lines.push('3. 已有项目直接 /flow new <描述> 立项。')
  return lines.join('\n')
}
