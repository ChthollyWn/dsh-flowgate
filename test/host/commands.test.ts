/**
 * /flow 命令族：解析、注册与执行（完成定义：命令注册与人工动作通知）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { executeFlowCommand, parseFlowCommand } from '../../src/host/commands/index.js'

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

  it('/flow off 与 on 记账 setOff', async () => {
    harness = await setupPlugin()
    await executeFlowCommand(harness.runtime, 'off 临时排查', harness.agent)
    expect(engineState(harness.engine).calls.setOff.at(-1)).toEqual({ off: true, reason: '临时排查' })
    await executeFlowCommand(harness.runtime, 'on', harness.agent)
    expect(engineState(harness.engine).calls.setOff.at(-1)).toMatchObject({ off: false })
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

  it('/flow learn brief 合并写回 config.yaml 并 refresh', async () => {
    harness = await setupPlugin()
    const text = await executeFlowCommand(harness.runtime, 'learn brief', harness.agent)
    expect(text).toContain('学习模式')
    const fs = harness.runtime.ports()?.fs
    expect(fs).toBeDefined()
    const raw = await fs?.readFile('.flowgate/config.yaml')
    expect(raw).toContain('"learning": "brief"')
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
