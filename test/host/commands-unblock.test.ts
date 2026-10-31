/**
 * `/flow unblock [BL-id|任务id] [理由]` 宿主命令（T-FAILURE-LIMIT 熔断的人工恢复入口）。
 *
 * 真实事故：连续验证失败熔断后只生成 kind=blocker 的 BL-n 待处理项，但旧版
 * `decidePending` 对 blocker 不做任何状态迁移，unlock 文案还错写成
 * `/flow risk approve <RK-n>`（RK 是风险接管项 id，不是 BL），负责人没有解锁路径
 * （见 docs/evaluation-data/20261031-105753-.../flowgate/changes/C-001/status.json）。
 *
 * 本文件用 fake host 夹具覆盖命令解析、id 解析与错误提示；状态迁移语义
 * （failureCount 清零 / 恢复 running / 一并关闭其它 BL / task.unblocked 账本）
 * 由 test/core/risk/breaker-recovery.test.ts 用真实 engine 覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { resetHostPluginForTest } from '../../src/host/index.js'
import { FLOW_COMMAND_HELP, executeFlowCommand } from '../../src/host/commands/index.js'
import type { FakeEngineState } from '../../src/host/testing/fake-ctx.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function engineState(engine: PluginHarness['engine']): FakeEngineState {
  return (engine as unknown as { state: FakeEngineState }).state
}

function blocker(id: string, options: { taskId?: string; status?: 'open' | 'approved'; kind?: 'blocker' | 'risk' } = {}) {
  return {
    id,
    kind: options.kind ?? 'blocker',
    changeId: 'C-001',
    title: `${id} 熔断阻断`,
    detail: '连续 3 次验证失败',
    status: options.status ?? 'open',
    createdAt: '2026-10-31T11:10:00+08:00',
    ...(options.taskId ? { data: { taskId: options.taskId } } : {}),
    scope: options.taskId ? { changeId: 'C-001', taskId: options.taskId } : { changeId: 'C-001' },
  }
}

/** 给 fake engine 注入一个「活动变更 + 待处理项」的快照。 */
function withPending(items: ReturnType<typeof blocker>[]): void {
  if (!harness) throw new Error('harness not ready')
  engineState(harness.engine).current = { id: 'C-001', pending: items }
}

async function ready(items: ReturnType<typeof blocker>[] = []): Promise<PluginHarness> {
  harness = await setupPlugin()
  withPending(items)
  await flush(1)
  return harness
}

describe('/flow unblock — 命令帮助与注册', () => {
  it('帮助文本登记 /flow unblock 与 BL-id/任务id 两种形态', () => {
    expect(FLOW_COMMAND_HELP).toContain('/flow unblock')
    expect(FLOW_COMMAND_HELP).toContain('BL-n')
    expect(FLOW_COMMAND_HELP).toContain('任务id')
  })
})

describe('/flow unblock — 指定 BL id', () => {
  it('unblock BL-1 → engine.decidePending(BL-1, approved)，返回解锁摘要', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' })])
    const text = await executeFlowCommand(h.runtime, 'unblock BL-1', h.agent)

    expect(engineState(h.engine).calls.decidePending).toEqual([{ id: 'BL-1', decision: 'approved' }])
    expect(text).toContain('BL-1')
    expect(text).toContain('失败计数清零')
    expect(text).toContain('flow_verify')
  })

  it('带理由时把理由传给 decidePending（透传到账本/待处理项）', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' })])
    // fake engine 只记录 id/decision；这里验证不会因为多余参数报错且命令成功。
    const text = await executeFlowCommand(h.runtime, 'unblock BL-1 解析器已修复，重新验证', h.agent)
    expect(engineState(h.engine).calls.decidePending[0]).toMatchObject({ id: 'BL-1', decision: 'approved' })
    expect(text).toContain('BL-1')
  })
})

describe('/flow unblock — 无参数形态', () => {
  it('当前变更唯一 open blocker 时直接解锁它', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' })])
    const text = await executeFlowCommand(h.runtime, 'unblock', h.agent)
    expect(engineState(h.engine).calls.decidePending).toEqual([{ id: 'BL-1', decision: 'approved' }])
    expect(text).toContain('BL-1')
  })

  it('多个 open blocker 时必须显式指定（避免误放行其它任务）', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' }), blocker('BL-2', { taskId: 'T2' })])
    await expect(executeFlowCommand(h.runtime, 'unblock', h.agent)).rejects.toThrow('需要指定 BL id')
    expect(engineState(h.engine).calls.decidePending).toHaveLength(0)
  })

  it('没有 open blocker 时给出明确提示（不调用 decidePending）', async () => {
    const h = await ready([])
    await expect(executeFlowCommand(h.runtime, 'unblock', h.agent)).rejects.toThrow('当前没有待解锁的熔断阻断项')
    expect(engineState(h.engine).calls.decidePending).toHaveLength(0)
  })
})

describe('/flow unblock — 任务 id 与错误提示', () => {
  it('任务 id（T1）解析到该任务的 open blocker', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' })])
    const text = await executeFlowCommand(h.runtime, 'unblock T1', h.agent)
    expect(engineState(h.engine).calls.decidePending).toEqual([{ id: 'BL-1', decision: 'approved' }])
    expect(text).toContain('任务 T1')
  })

  it('错误 id：给出 BL/任务 id 用法提示', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1' })])
    await expect(executeFlowCommand(h.runtime, 'unblock BL-9', h.agent)).rejects.toThrow('没有待解锁的阻断项：BL-9')
    await expect(executeFlowCommand(h.runtime, 'unblock T42', h.agent)).rejects.toThrow('没有待解锁的阻断项：T42')
    expect(engineState(h.engine).calls.decidePending).toHaveLength(0)
  })

  it('非 blocker 的待处理项提示对应命令（RK-n 用 risk approve）', async () => {
    const h = await ready([blocker('RK-1', { kind: 'risk' })])
    let caught: unknown
    try {
      await executeFlowCommand(h.runtime, 'unblock RK-1', h.agent)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('不是熔断阻断项')
    expect((caught as Error & { hint?: string }).hint).toContain('/flow risk approve')
    expect(engineState(h.engine).calls.decidePending).toHaveLength(0)
  })

  it('已经处理过的 blocker 不能重复解锁', async () => {
    const h = await ready([blocker('BL-1', { taskId: 'T1', status: 'approved' })])
    await expect(executeFlowCommand(h.runtime, 'unblock BL-1', h.agent)).rejects.toThrow('已经处理过')
    expect(engineState(h.engine).calls.decidePending).toHaveLength(0)
  })

  it('没有活动变更时给出清晰错误', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).current = null
    await expect(executeFlowCommand(harness.runtime, 'unblock BL-1', harness.agent)).rejects.toThrow('当前没有进行中的变更')
  })
})
