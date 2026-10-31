/**
 * 中断任务重新派发前的安全检查（T4.6 最后一条 / 03 §7.5）。
 *
 * 验收口径：GIVEN 中断任务的旧子 agent 状态无法确认 WHEN 请求重新派发
 * THEN 保持阻塞并生成待处理项；能确认已停止/资源已释放或负责人已显式授权时放行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshSubagentResult } from '../../src/host/adapters/dsh-types.js'
import type { ChangeStatus, DispatchOutcome, DispatchTaskEnvelope, FlowgateConfig, PendingItem, PendingKind, TaskCard, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { DISPATCH_SAFETY_CATEGORY, resetDispatchStateForTest } from '../../src/host/dispatch/index.js'
import { createFakeEngine, createFakeSubagents, defaultFakeConfig, type FakeEngineState } from '../../src/host/testing/fake-ctx.js'

let harness: PluginHarness | null = null

beforeEach(() => {
  resetDispatchStateForTest()
})

afterEach(async () => {
  await flush(20)
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

async function start(options: Parameters<typeof setupPlugin>[0] = {}): Promise<PluginHarness> {
  harness = await setupPlugin(options)
  // 引擎初始化是异步的（ledger.key + engine.load）：显式等待，避免并行跑测试时的计时抖动。
  await harness.runtime.waitForEngine()
  return harness
}

function engineState(engine: PluginHarness['engine']): FakeEngineState {
  return (engine as unknown as { state: FakeEngineState }).state
}

async function runTool(
  h: PluginHarness,
  name: string,
  args: Record<string, unknown>,
): Promise<{ value: { ok: boolean; summary: string; data?: Record<string, unknown> } }> {
  const tool = h.tools.state.tools.get(name)
  if (!tool) throw new Error(`tool ${name} 未注册`)
  const value = await tool.execute(args, {
    callId: `call-${name}`,
    name,
    arguments: args,
    agent: h.agent,
    signal: new AbortController().signal,
  } as never)
  return { value: value as { ok: boolean; summary: string; data?: Record<string, unknown> } }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeTaskState(taskId: string, overrides: Partial<TaskState> = {}): TaskState {
  return { id: taskId, batch: 'B1', status: 'interrupted', tdd: 'none', evidenceIds: [], reviewIds: [], ...overrides }
}

function makeChange(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    id: 'C-001',
    kind: 'change',
    title: '测试变更',
    complexity: 'low',
    risk: 'normal',
    stage: 'S4',
    lifecycle: 'active',
    gates: {},
    branch: 'main',
    batches: [],
    tasks: {},
    evidenceIds: [],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ChangeStatus
}

function makeEnvelope(taskId = 'T1', overrides: Partial<DispatchTaskEnvelope> = {}): DispatchTaskEnvelope {
  const task: TaskCard = {
    id: taskId,
    title: `任务${taskId}`,
    covers: [],
    scope: ['src/a.ts'],
    tests: [],
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'optional',
    verify: [],
    run: 'main',
    risk: [],
    size: 'S',
    body: '任务卡正文',
  }
  return {
    changeId: 'C-001',
    taskId,
    batch: 'B1',
    mode: 'sequential',
    task,
    coveredScenarios: [],
    contextExcerpt: '',
    verifyGroups: [],
    tdd: false,
    ...overrides,
  }
}

function makeEngine(change: ChangeStatus): PluginHarness['engine'] {
  const config = defaultFakeConfig() as unknown as FlowgateConfig
  config.review = { enabled: false, requireForTaskGate: false }
  const engine = createFakeEngine({ config })
  const state = engineState(engine)
  state.current = change
  state.tasks = []
  return engine
}

function stubDispatch(engine: PluginHarness['engine'], outcome: DispatchOutcome | (() => Promise<DispatchOutcome>)): { count: number } {
  const calls = { count: 0 }
  engine.dispatchNext = async () => {
    calls.count += 1
    return typeof outcome === 'function' ? await outcome() : outcome
  }
  return calls
}

/** 记录 reportRisk 调用，并返回可被后续派发识别的 safety 待处理项。 */
function stubReportRisk(engine: PluginHarness['engine']): { calls: { category: string; description: string; proposal: string }[] } {
  const calls: { category: string; description: string; proposal: string }[] = []
  engine.reportRisk = async (input) => {
    calls.push(input)
    const item: PendingItem = {
      id: `RK-${calls.length}`,
      kind: 'risk',
      changeId: 'C-001',
      title: `agent 上报风险（${input.category}）`,
      detail: input.description,
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: { ...input },
    }
    return item
  }
  return { calls }
}

function makeSafetyPending(id: string, taskId: string, status: PendingItem['status']): PendingItem {
  const kind: PendingKind = 'risk'
  return {
    id,
    kind,
    changeId: 'C-001',
    title: '中断任务重新派发待确认',
    detail: '旧子 agent 状态无法确认',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    data: { category: `${DISPATCH_SAFETY_CATEGORY}:${taskId}`, description: '无法确认', proposal: '确认后批准' },
  }
}

/** 宿主 agents 注册表 fake（get(id) 由用例控制）。 */
function agentRegistry(get: (id: string) => unknown): { get: (id: string) => unknown } {
  return { get }
}

const EMPTY_OUTCOME: DispatchOutcome = { dispatched: [], message: '当前没有可派发的任务（fake）。' }

// ---------------------------------------------------------------------------
// 无法确认 → 阻塞 + 生成待处理项
// ---------------------------------------------------------------------------

describe('中断任务重新派发：无法确认旧子 agent 状态时保持阻塞', () => {
  it('没有记录旧子 agent id 时阻塞派发、生成待处理项并提示负责人命令', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1') } }))
    const subagents = createFakeSubagents()
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents, agents: agentRegistry(() => undefined) } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('不能重新派发中断任务')
    expect(value.summary).toContain('T1')
    expect(value.summary).toContain('没有记录旧子 agent id')
    expect(dispatchCalls.count).toBe(0)
    expect(subagents.state.started).toHaveLength(0)
    // 生成待处理项：category 带 taskId 标记，负责人可在授权卡片上批准重新派发。
    expect(risk.calls).toHaveLength(1)
    expect(risk.calls[0]?.category).toBe(`${DISPATCH_SAFETY_CATEGORY}:T1`)
    expect(String(value.data?.hint)).toContain('授权卡片')
    expect(String(value.data?.hint)).toContain('RK-1')
    expect(String(value.data?.hint)).not.toContain('/flow risk approve')
    expect(value.data?.pending).toEqual([expect.objectContaining({ id: 'RK-1', kind: 'risk', status: 'open' })])
    expect(value.data?.tasks).toEqual([expect.objectContaining({ taskId: 'T1' })])
  })

  it('宿主未提供 agents 服务（无法确认）时阻塞并生成待处理项', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1', { agent: 'child-old' }) } }))
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents: createFakeSubagents(), agents: undefined } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('宿主未提供 agents 服务')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls).toHaveLength(1)
    expect(String(value.data?.hint)).toContain('授权卡片')
  })

  it('旧子 agent 仍在运行（宿主注册表 status=running）时阻塞', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1', { agent: 'child-old' }) } }))
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({
      engine,
      services: { subagents: createFakeSubagents(), agents: agentRegistry(() => ({ id: 'child-old', status: 'running' })) },
    })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('仍在运行')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls).toHaveLength(1)
  })

  it('查询旧子 agent 抛错时视为无法确认并阻塞', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1', { agent: 'child-old' }) } }))
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({
      engine,
      services: {
        subagents: createFakeSubagents(),
        agents: agentRegistry(() => {
          throw new Error('registry unavailable')
        }),
      },
    })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('查询旧子 agent child-old 失败')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls).toHaveLength(1)
  })

  it('多个中断任务只对无法确认的那个阻塞并生成待处理项', async () => {
    const engine = makeEngine(
      makeChange({
        tasks: {
          T1: makeTaskState('T1', { agent: 'child-gone' }),
          T2: makeTaskState('T2'),
        },
      }),
    )
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({
      engine,
      services: { subagents: createFakeSubagents(), agents: agentRegistry((id) => (id === 'child-gone' ? undefined : { id, status: 'idle' })) },
    })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('T2')
    expect(value.summary).not.toContain('T1：')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls.map((call) => call.category)).toEqual([`${DISPATCH_SAFETY_CATEGORY}:T2`])
  })
})

// ---------------------------------------------------------------------------
// 可以确认 / 负责人已授权 → 放行
// ---------------------------------------------------------------------------

describe('中断任务重新派发：确认已停止或负责人授权后放行', () => {
  it('旧子 agent 已从宿主注册表注销时直接放行重新派发', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1', { agent: 'child-old' }) } }))
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents: createFakeSubagents(), agents: agentRegistry(() => undefined) } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('当前没有可派发的任务')
    expect(dispatchCalls.count).toBe(1)
    expect(risk.calls).toHaveLength(0)
  })

  it('负责人已批准 safety 待处理项时视为显式授权，即使无法确认也放行', async () => {
    const engine = makeEngine(
      makeChange({
        tasks: { T1: makeTaskState('T1', { agent: 'child-old' }) },
        pending: [makeSafetyPending('RK-1', 'T1', 'approved')],
      }),
    )
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({
      engine,
      services: { subagents: createFakeSubagents(), agents: agentRegistry(() => ({ id: 'child-old', status: 'running' })) },
    })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(dispatchCalls.count).toBe(1)
    expect(risk.calls).toHaveLength(0)
  })

  it('一次授权只放行一次：再次中断时重新确认并生成新的待处理项', async () => {
    const engine = makeEngine(
      makeChange({
        tasks: { T1: makeTaskState('T1') },
        pending: [makeSafetyPending('RK-9', 'T1', 'approved')],
      }),
    )
    let engineDispatchCalls = 0
    engine.dispatchNext = async () => {
      engineDispatchCalls += 1
      return EMPTY_OUTCOME
    }
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents: createFakeSubagents(), agents: undefined } })

    // 第一次：消费 RK-1 的授权放行。
    const first = await runTool(h, 'flow_dispatch_next', {})
    expect(first.value.ok).toBe(true)
    expect(engineDispatchCalls).toBe(1)
    // 第二次：任务仍 interrupted 且旧 child 无法确认 → 旧授权已用完，必须重新阻塞 + 生成新待处理项。
    const second = await runTool(h, 'flow_dispatch_next', {})
    expect(second.value.ok).toBe(false)
    expect(second.value.summary).toContain('不能重新派发中断任务')
    expect(risk.calls).toHaveLength(1)
    expect(second.value.data?.pending).toEqual([expect.objectContaining({ id: 'RK-1', status: 'open' })])
    expect(engineDispatchCalls).toBe(1)
  })

  it('同进程里子 agent 已 dispose（资源已释放）时可放行（即使宿主注册表不可用）', async () => {
    const engine = makeEngine(makeChange({ tasks: { T1: makeTaskState('T1', { status: 'pending' }) } }))
    let resolveResult!: (result: DshSubagentResult) => void
    const result = new Promise<DshSubagentResult>((resolve) => {
      resolveResult = resolve
    })
    const subagents = createFakeSubagents({
      start: async () => ({ childId: 'child-released', result, dispose: async () => {} }),
    })
    let dispatchCall = 0
    engine.dispatchNext = async () => {
      dispatchCall += 1
      return dispatchCall === 1 ? { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' } : EMPTY_OUTCOME
    }
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents, agents: undefined } })

    const first = await runTool(h, 'flow_dispatch_next', {})
    expect(first.value.ok).toBe(true)
    // 模拟会话关闭：任务被标记中断（engine.releaseSession 的效果），随后旧子 agent 才结算。
    const state = engineState(engine)
    state.current = {
      ...(state.current as ChangeStatus),
      tasks: { T1: makeTaskState('T1', { status: 'interrupted' }) },
    }
    resolveResult({ output: [], structured: { summary: '完成' }, stopReason: 'completed' })
    await flush(20)
    // 旧子 agent 已 dispose → 资源已释放，即使 agents 服务不可用也可以确认。
    const second = await runTool(h, 'flow_dispatch_next', {})
    expect(second.value.ok).toBe(true)
    expect(dispatchCall).toBe(2)
    expect(risk.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 待处理项幂等 / 退回
// ---------------------------------------------------------------------------

describe('中断任务重新派发：待处理项幂等', () => {
  it('已有 open 的 safety 待处理项时不再重复生成，继续阻塞并提示该项 id', async () => {
    const engine = makeEngine(
      makeChange({
        tasks: { T1: makeTaskState('T1') },
        pending: [makeSafetyPending('RK-1', 'T1', 'open')],
      }),
    )
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({
      engine,
      services: { subagents: createFakeSubagents(), agents: agentRegistry(() => undefined) },
    })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('RK-1')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls).toHaveLength(0)
    expect(value.data?.pending).toEqual([expect.objectContaining({ id: 'RK-1' })])
  })

  it('负责人已退回（rejected）时保持阻塞且不重复生成待处理项', async () => {
    const engine = makeEngine(
      makeChange({
        tasks: { T1: makeTaskState('T1') },
        pending: [makeSafetyPending('RK-1', 'T1', 'rejected')],
      }),
    )
    const dispatchCalls = stubDispatch(engine, EMPTY_OUTCOME)
    const risk = stubReportRisk(engine)
    const h = await start({ engine, services: { subagents: createFakeSubagents(), agents: undefined } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('已退回')
    expect(dispatchCalls.count).toBe(0)
    expect(risk.calls).toHaveLength(0)
  })
})
