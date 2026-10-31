/**
 * 人工门批准/退回（03 §2.2 / §3.3）。
 *
 * 关键事实（03 §2.2）：人工门**不走** DSH 的审批流程（可能被 Auto review 机器批准），
 * 而是"拒绝动作 → 生成待处理项 → 只能由负责人用 /flow 命令或面板按钮处理"。
 * 命令/按钮处理完后用 `agent.inject()` 通知 agent —— 只做上下文注入、**不唤醒**，
 * 消息落在下一个被接纳的步骤（H7/H23）。
 */
import type { DshAgent } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { GateId } from '../../core/types.js'
import { HostError, toAgentError } from '../errors.js'
import { buildMergedConfirm, renderConfirmCardText } from './merged.js'

/** 合法的人工门集合（低复杂度 G3 同时批准 G1；从 0 开发还有 GR）。 */
export const HUMAN_GATES: readonly GateId[] = ['GR', 'G1', 'G3', 'G6']

export function isHumanGate(gate: string): gate is GateId {
  return (HUMAN_GATES as readonly string[]).includes(gate)
}

/** 向 agent 注入一条通知（不唤醒；失败只记降级）。 */
export async function notifyAgent(runtime: HostRuntime, text: string, agent?: DshAgent | null): Promise<void> {
  const target = agent ?? runtime.mainAgent()
  if (!target || text.trim() === '') return
  try {
    await target.inject({
      content: [{ type: 'text', text: text.startsWith('[FlowGate]') ? text : `[FlowGate] ${text}` }],
      source: { kind: 'runtime-context', form: 'relay' },
    })
  } catch (error) {
    runtime.noteFeature('gates', `通知 agent 失败：${toAgentError(error).error}`)
  }
}

/** 安装人工门通知钩子。 */
export function installGates(runtime: HostRuntime): void {
  runtime.registerGateAwaitingHook((changeId, gate) => {
    const text = isHumanGate(gate)
      ? `变更 ${changeId} 的 ${gate} 检查全部通过，正在等待负责人批准。下一步：等待负责人在授权卡片上批准或退回（退回需写理由）。`
      : `变更 ${changeId} 的 ${gate} 需要负责人确认。`
    void notifyAgent(runtime, text)
  })
}

/** 批准人工门（命令或面板动作共用）。返回给人类看的文本。 */
export async function approveHumanGate(
  runtime: HostRuntime,
  agent: DshAgent | null,
  gate: string,
  reason?: string,
  options: { confirmRisks?: boolean } = {},
): Promise<string> {
  if (!isHumanGate(gate)) {
    throw new HostError(`/flow approve 只处理人工门（GR/G1/G3/G6），收到 ${gate || '空'}`, '运行 /flow 查看当前等待批准的门')
  }
  const engine = runtime.requireEngine()
  const result = await engine.approveGate(gate, {
    ...(reason ? { reason } : {}),
    ...(options.confirmRisks === true ? { confirmRisks: true } : {}),
  })
  runtime.emit()
  const text = result.message || `已批准 ${gate}。`
  await notifyAgent(runtime, `${text} 继续按注入的下一步执行。`, agent)
  return text
}

/** 退回当前等待中的人工门。 */
export async function rejectCurrentGate(runtime: HostRuntime, agent: DshAgent | null, reason: string): Promise<string> {
  if (reason.trim() === '') throw new HostError('退回必须写意见', '例：/flow reject 验收场景不够具体，补 after 回调幂等')
  const engine = runtime.requireEngine()
  const snapshot = safeSnapshot(runtime)
  const gate = snapshot?.awaitingGate
  if (!gate) throw new HostError('当前没有等待批准的门', '运行 /flow 查看当前门禁状态')
  const result = await engine.rejectGate(gate, reason)
  runtime.emit()
  await notifyAgent(runtime, `负责人退回了 ${gate}，意见：${reason}。请按意见修改产物后重新 flow_submit。`, agent)
  return result.message || `已退回 ${gate}。`
}

/** 当前人工门确认卡（低复杂度 G3 合并卡）。 */
export function confirmCardText(runtime: HostRuntime): string | null {
  runtime.requireEngine()
  const card = buildMergedConfirm(runtime.requireEngine())
  if (!card) return null
  return renderConfirmCardText(card)
}

function safeSnapshot(runtime: HostRuntime) {
  try {
    return runtime.engine()?.snapshot() ?? null
  } catch {
    return null
  }
}
