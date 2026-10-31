/**
 * /flow 命令族：解析、注册与执行（完成定义：命令注册与人工动作通知）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { FLOW_COMMAND_HELP, executeFlowCommand, parseFlowCommand } from '../../src/host/commands/index.js'
import type { RepairRecord } from '../../src/core/types.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function engineState(engine: PluginHarness['engine']) {
  return (engine as unknown as { state: import('../../src/host/testing/fake-ctx.js').FakeEngineState }).state
}

/** 进行中的修复记录（命令测试用）。 */
function fakeRepair(overrides: Partial<RepairRecord> = {}): RepairRecord {
  return {
    id: 'FIX-1',
    title: '回调重复扣款',
    symptom: '生产重复扣款',
    repro: '重放回调两次',
    scope: ['src/renewal/**'],
    verify: 'pnpm test',
    acceptance: ['不重复扣款'],
    severity: 'P0',
    status: 'open',
    openedAt: '2026-01-01T00:00:00.000Z',
    openedBy: 'agent',
    actions: 2,
    redEvidenceId: 'E-RED-1',
    ...overrides,
  }
}

/** 一个最小的进行中变更（区分 /flow off 的会话级 vs 项目级语义）。 */
function fakeChange() {
  return { id: 'C-001', kind: 'change', title: '测试变更', stage: 'S4', complexity: 'low', risk: 'normal', lifecycle: 'active', reviews: [], tasks: {} }
}

describe('解析 /flow 命令', () => {
  it('空输入视为 status', () => {
    expect(parseFlowCommand('')).toMatchObject({ verb: 'status', args: [] })
    expect(parseFlowCommand('   ').verb).toBe('status')
  })

  it('保留退回意见的原始空格', () => {
    const parsed = parseFlowCommand('reject 验收场景 不够具体，补 after 回调')
    expect(parsed.verb).toBe('reject')
    expect(parsed.rest).toBe('验收场景 不够具体，补 after 回调')
    expect(parsed.args).toEqual(['验收场景', '不够具体，补', 'after', '回调'])
  })

  it('verb 大小写不敏感', () => {
    expect(parseFlowCommand('APPROVE G1').verb).toBe('approve')
  })
})

describe('/flow route 帮助与解析', () => {
  it('help 列出 /flow route，解析出 full|standard|fast', () => {
    expect(FLOW_COMMAND_HELP).toContain('/flow route ')
    expect(FLOW_COMMAND_HELP).toContain('覆盖自动流程路由')
    expect(parseFlowCommand('route fast 简单清晰')).toMatchObject({ verb: 'route', args: ['fast', '简单清晰'] })
  })
})

describe('命令注册与执行', () => {
  it('注册 /flow 命令，handler 返回 kind=success 文本（不进模型消息）', async () => {
    harness = await setupPlugin()
    const definition = harness.commands.state.commands.get('flow')
    expect(definition).toBeDefined()
    const result = await definition?.handler({
      commandId: 'cmd-1',
      agent: harness.agent,
      rawInput: 'status',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result?.kind).toBe('success')
    if (result?.kind === 'success') expect(result.text).toContain('假状态')
  })

  it('/flow approve：调 engine.approveGate 并 inject 通知 agent（不唤醒）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { awaitingGate: 'G1', initialized: true }
    harness.runtime.emit()
    const text = await executeFlowCommand(harness.runtime, 'approve G1', harness.agent)
    expect(engineState(harness.engine).calls.approveGate).toEqual(['G1'])
    expect(text).toContain('已批准')
    expect(harness.agent.state.injected.length).toBeGreaterThan(0)
    expect(harness.agent.state.injected.at(-1)?.content[0]?.text).toContain('G1')
    expect(harness.agent.state.steered.length).toBe(0) // 不唤醒
  })

  it('/flow reject 无意见时报错；有意见时调 engine.rejectGate', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { awaitingGate: 'G3', initialized: true }
    harness.runtime.emit()
    await expect(executeFlowCommand(harness.runtime, 'reject', harness.agent)).rejects.toThrow('退回必须写意见')
    const text = await executeFlowCommand(harness.runtime, 'reject 补验收场景', harness.agent)
    expect(engineState(harness.engine).calls.rejectGate[0]).toMatchObject({ gate: 'G3', reason: '补验收场景' })
    expect(text).toContain('已退回')
  })

  it('/flow new 调 engine.newChange 并返回变更 id', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'new 续费回调幂等', harness.agent)
    expect(engineState(harness.engine).calls.newChange.length).toBe(1)
    expect(text).toContain('C-001')
  })

  it('/flow off（无进行中变更）→ 项目级暂停 setProjectOff(by=human)', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'off 临时排查', harness.agent)
    const calls = engineState(harness.engine).calls
    expect(calls.setOff).toHaveLength(0)
    expect(calls.setProjectOff.at(-1)).toMatchObject({ off: true, reason: '临时排查', by: 'human' })
    expect(text).toContain('项目门禁已暂停（项目级）')
    expect(text).toContain('agent 无法自行恢复')
  })

  it('/flow off（有进行中变更）→ 保持会话级 setOff；/flow on 恢复会话级', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).current = fakeChange()
    await executeFlowCommand(harness.runtime, 'off 临时排查', harness.agent)
    expect(engineState(harness.engine).calls.setOff.at(-1)).toEqual({ off: true, reason: '临时排查' })
    expect(engineState(harness.engine).calls.setProjectOff).toHaveLength(0)

    await executeFlowCommand(harness.runtime, 'on', harness.agent)
    expect(engineState(harness.engine).calls.setOff.at(-1)).toMatchObject({ off: false })
  })

  it('/flow on（无变更/项目级暂停）→ 恢复项目级并提示未关闭事故', async () => {
    harness = await setupPlugin()
    await executeFlowCommand(harness.runtime, 'off 项目停用', harness.agent)
    engineState(harness.engine).projectFlags.incident = {
      id: 'INC-1',
      severity: 'P1',
      reason: '需要负责人',
      openedAt: '2026-01-01T00:00:00.000Z',
      openedBy: 'agent',
    }
    const text = await executeFlowCommand(harness.runtime, 'on', harness.agent)
    expect(engineState(harness.engine).calls.setProjectOff.at(-1)).toMatchObject({ off: false })
    expect(text).toContain('项目门禁已恢复（项目级）')
    expect(text).toContain('INC-1')
    expect(text).toContain('flow_incident_close')
  })

  it('/flow allow-once 触发 engine.allowOnce', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'allow-once R-SCOPE 临时核对构建脚本', harness.agent)
    expect(engineState(harness.engine).calls.allowOnce.length).toBe(1)
    expect(text).toContain('单次放行')
  })

  it('/flow scope approve SC-1 走 decidePending', async () => {
    harness = await setupPlugin()
    await executeFlowCommand(harness.runtime, 'scope approve SC-1', harness.agent)
    expect(engineState(harness.engine).calls.decidePending[0]).toMatchObject({ id: 'SC-1', decision: 'approved' })
  })

  it('/flow conflict approve 走 decidePending（headless 负责人释放检查点闸门）', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'conflict approve CF-1 冲突已修好', harness.agent)
    expect(engineState(harness.engine).calls.decidePending[0]).toMatchObject({
      id: 'CF-1',
      decision: 'approved',
      reason: '冲突已修好',
    })
    expect(text).toContain('集成检查点冲突')
  })

  it('/flow conflict reject 必须写理由', async () => {
    harness = await setupPlugin()
    await expect(executeFlowCommand(harness.runtime, 'conflict reject CF-1', harness.agent)).rejects.toThrow('退回必须写理由')
  })

  it('/flow learn 已被移除：作为未知子命令报错', async () => {
    harness = await setupPlugin()
    await expect(executeFlowCommand(harness.runtime, 'learn brief', harness.agent)).rejects.toThrow('未知子命令')
  })

  it('/flow complexity 降低必须写理由', async () => {
    harness = await setupPlugin()
    await expect(executeFlowCommand(harness.runtime, 'complexity 低', harness.agent)).rejects.toThrow('降低复杂度必须写理由')
  })

  it('/flow doctor 输出宿主能力与降级信息', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('FlowGate 自检')
    expect(text).toContain('宿主能力')
    expect(text).toContain('工具覆盖自检')
  })

  it('/flow fix 无参：无修复时说明修复通道用法；有修复时显示证据与下一步', async () => {
    harness = await setupPlugin()
    let text = await executeFlowCommand(harness.runtime, 'fix', harness.agent)
    expect(text).toContain('当前没有进行中的修复')
    expect(text).toContain('flow_fix_start')

    engineState(harness.engine).repair = fakeRepair()
    text = await executeFlowCommand(harness.runtime, 'fix', harness.agent)
    expect(text).toContain('FIX-1')
    expect(text).toContain('回调重复扣款')
    expect(text).toContain('RED ✓ E-RED-1')
    expect(text).toContain('GREEN ✗ 未取到')
    expect(text).toContain('修复后取 GREEN')
  })

  it('/flow fix done 关闭修复通道（engine.finishRepair）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).repair = fakeRepair()
    const text = await executeFlowCommand(harness.runtime, 'fix done', harness.agent)
    expect(engineState(harness.engine).calls.finishRepair).toHaveLength(1)
    expect(text).toContain('已关闭')
    expect(text).toContain('.flowgate/fixes/')
  })

  it('/flow fix abort 必须写理由，并调 engine.abortRepair', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).repair = fakeRepair()
    await expect(executeFlowCommand(harness.runtime, 'fix abort', harness.agent)).rejects.toThrow('必须写理由')
    const text = await executeFlowCommand(harness.runtime, 'fix abort 根因判断错误', harness.agent)
    expect(engineState(harness.engine).calls.abortRepair).toEqual(['根因判断错误'])
    expect(text).toContain('已放弃修复 FIX-1')
  })

  it('/flow fix 未知动作报用法错误', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).repair = fakeRepair()
    await expect(executeFlowCommand(harness.runtime, 'fix frobnicate', harness.agent)).rejects.toThrow('用法：/flow fix')
  })

  it('/flow incident 显示未关闭事故与恢复/审计方式', async () => {
    harness = await setupPlugin()
    let text = await executeFlowCommand(harness.runtime, 'incident', harness.agent)
    expect(text).toContain('当前没有未关闭的事故')
    await executeFlowCommand(harness.runtime, 'off 项目停用', harness.agent)
    engineState(harness.engine).projectFlags.incident = {
      id: 'INC-7',
      severity: 'P0',
      reason: '主流程不可用',
      openedAt: '2026-01-01T00:00:00.000Z',
      openedBy: 'agent',
    }
    text = await executeFlowCommand(harness.runtime, 'incident', harness.agent)
    expect(text).toContain('INC-7')
    expect(text).toContain('主流程不可用')
    expect(text).toContain('/flow on')
    expect(text).toContain('flow_incident_close')
  })

  it('/flow status 输出修复通道与暂停来源', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).repair = fakeRepair()
    engineState(harness.engine).takeover = 'observe'
    let text = await executeFlowCommand(harness.runtime, 'status', harness.agent)
    expect(text).toContain('修复通道：FIX-1')
    expect(text).toContain('接管模式：observe')

    engineState(harness.engine).repair = null
    delete engineState(harness.engine).projectFlags.off
    engineState(harness.engine).projectFlags.off = { by: 'human', reason: '维护', at: '2026-01-01T00:00:00.000Z' }
    text = await executeFlowCommand(harness.runtime, 'status', harness.agent)
    expect(text).toContain('暂停来源：负责人手动')
  })

  it('/flow repair 仍是账本重建（旧语义不变），/flow help 同时列出 fix', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'repair', harness.agent)
    expect(text).toContain('修复完成（fake）')
    const help = await executeFlowCommand(harness.runtime, 'help', harness.agent)
    expect(help).toContain('/flow fix — 修复通道状态')
    expect(help).toContain('/flow fix done')
    expect(help).toContain('/flow fix abort')
    expect(help).toContain('/flow repair — 从账本重建状态')
    expect(help).toContain('/flow incident')
  })

  it('未知子命令给出用法错误', async () => {
    harness = await setupPlugin()
    await expect(executeFlowCommand(harness.runtime, 'frobnicate', harness.agent)).rejects.toThrow('未知子命令')
  })

  it('已移除的 /flow config 桩按未知子命令处理（P1-10）', async () => {
    harness = await setupPlugin()
    // 曾经的 "未实现" 桩不再存在，也没有文档化入口：与其它未知子命令一致报用法错误。
    await expect(executeFlowCommand(harness.runtime, 'config', harness.agent)).rejects.toThrow('未知子命令：config')
    const help = await executeFlowCommand(harness.runtime, 'help', harness.agent)
    expect(help).not.toContain('/flow config')
  })

  it('handler 捕获异常返回 kind=error（不抛给宿主）', async () => {
    harness = await setupPlugin()
    const definition = harness.commands.state.commands.get('flow')
    const result = await definition?.handler({
      commandId: 'cmd-2',
      agent: harness.agent,
      rawInput: 'frobnicate',
      attachments: [],
      signal: new AbortController().signal,
    })
    expect(result?.kind).toBe('error')
  })
})

describe('低复杂度方案确认卡', () => {
  it('approve G3 + 低复杂度时返回确认卡文本（engine 提供数据）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { awaitingGate: 'G3', initialized: true, complexity: 'low' }
    harness.runtime.emit()
    const text = await executeFlowCommand(harness.runtime, 'approve G3', harness.agent)
    // fake 引擎没有产物 → 卡片为空时不显示，但 approve 本身成功。
    expect(text).toContain('已批准')
  })
})
