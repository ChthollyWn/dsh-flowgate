/**
 * 会话生命周期注入单测：
 * - H2 跨会话任务卡：会话关闭后 running/review 任务被标 interrupted，下次会话
 *   启动时必须回退注入最近中断的任务卡（含范围/验证组/TDD/run 与恢复提示）；
 *   有 running/review 时仍以它们优先。
 * - H3 上下文压缩重注入：`agent/created{source:'compact'}` 时向新 agent 重注入
 *   交接摘要 + 当前任务卡；source 缺失/非 compact 时不注入；引擎未就绪只记录降级原因。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ChangeStatus, HandoffSummary, TaskCard, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { buildHandoffParts, buildTaskCardLine, selectInjectedTask } from '../../src/host/session/index.js'
import { createFakeAgent, createFakeEngine, type FakeAgent, type FakeEngineState } from '../../src/host/testing/fake-ctx.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'T1',
    title: '任务T1',
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
    ...overrides,
  }
}

function makeTaskState(taskId: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: taskId,
    batch: 'B1',
    status: 'pending',
    tdd: 'none',
    evidenceIds: [],
    reviewIds: [],
    ...overrides,
  }
}

function makeHandoff(text: string, overrides: Partial<HandoffSummary> = {}): HandoffSummary {
  return {
    at: '2026-01-01T00:00:00.000Z',
    stage: 'S4',
    decisions: [],
    openItems: [],
    next: '继续执行下一个任务',
    text,
    ...overrides,
  }
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

function engineState(engine: PluginHarness['engine']): FakeEngineState {
  return (engine as unknown as { state: FakeEngineState }).state
}

function injectedTexts(agent: FakeAgent): string[] {
  return agent.state.injected.map((message) =>
    message.content.map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('\n'),
  )
}

async function start(engine: PluginHarness['engine']): Promise<PluginHarness> {
  harness = await setupPlugin({ engine })
  await harness.runtime.waitForEngine()
  await flush(20)
  return harness
}

/** 会话关闭后的典型现场：running/review 已被 core 改成 interrupted。 */
function interruptedChange(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return makeChange({
    handoff: makeHandoff('上次做到 T2，验证组已过 RED'),
    tasks: {
      T1: makeTaskState('T1', { status: 'done' }),
      T2: makeTaskState('T2', { status: 'interrupted', interruptedAt: '2026-01-01T00:01:00.000Z' }),
      T3: makeTaskState('T3', { status: 'interrupted', interruptedAt: '2026-01-01T00:02:00.000Z' }),
    },
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// H2：任务选择（纯函数）
// ---------------------------------------------------------------------------

describe('selectInjectedTask（H2 任务卡选择）', () => {
  it('running/review 优先于 interrupted（即使 interruptedAt 更新）', () => {
    const selection = selectInjectedTask({
      tasks: {
        T1: makeTaskState('T1', { status: 'interrupted', interruptedAt: '2026-01-01T00:09:00.000Z' }),
        T2: makeTaskState('T2', { status: 'running' }),
      },
    })
    expect(selection?.task.id).toBe('T2')
    expect(selection?.interrupted).toBe(false)
  })

  it('没有 running/review 时取 interruptedAt 最近的 interrupted 任务', () => {
    const selection = selectInjectedTask(interruptedChange())
    expect(selection?.task.id).toBe('T3')
    expect(selection?.interrupted).toBe(true)
  })

  it('interruptedAt 缺失/不可解析时排在有效时间之后，不抢"最近中断"', () => {
    const selection = selectInjectedTask({
      tasks: {
        T1: makeTaskState('T1', { status: 'interrupted' }),
        T2: makeTaskState('T2', { status: 'interrupted', interruptedAt: '2026-01-01T00:01:00.000Z' }),
      },
    })
    expect(selection?.task.id).toBe('T2')
    // 两者都没有有效时间时仍返回一个（确定性取插入顺序第一个）。
    const fallback = selectInjectedTask({
      tasks: {
        T1: makeTaskState('T1', { status: 'interrupted' }),
        T2: makeTaskState('T2', { status: 'interrupted' }),
      },
    })
    expect(fallback?.task.id).toBe('T1')
  })

  it('没有可注入任务时返回 undefined', () => {
    expect(selectInjectedTask({ tasks: { T1: makeTaskState('T1', { status: 'done' }) } })).toBeUndefined()
    expect(selectInjectedTask(null)).toBeUndefined()
  })
})

describe('buildTaskCardLine / buildHandoffParts', () => {
  it('任务卡包含范围、验证组、TDD、run；中断任务附 flow_task_start 恢复提示', () => {
    const engine = createFakeEngine()
    const state = engineState(engine)
    state.tasks = [
      makeTaskCard({
        id: 'T2',
        title: '任务T2',
        scope: ['src/b.ts'],
        newFiles: ['src/b.test.ts'],
        verify: [{ group: 'unit', command: 'pnpm vitest run', inputs: [] }],
        tdd: 'required',
        run: 'subagent',
      }),
    ]
    const selection = selectInjectedTask({
      tasks: { T2: makeTaskState('T2', { status: 'interrupted', interruptedAt: '2026-01-01T00:01:00.000Z' }) },
    })
    expect(selection).toBeDefined()
    const line = buildTaskCardLine(engine, selection!)
    expect(line).toContain('当前任务卡 T2「任务T2」')
    expect(line).toContain('范围 src/b.ts、src/b.test.ts')
    expect(line).toContain('验证组 unit=pnpm vitest run')
    expect(line).toContain('TDD required')
    expect(line).toContain('run subagent')
    expect(line).toContain('上一会话中断')
    expect(line).toContain('flow_task_start("T2")')
  })

  it('任务卡解析失败时给出状态行并保留恢复提示，不抛错', () => {
    const engine = createFakeEngine()
    engineState(engine).tasks = []
    const line = buildTaskCardLine(engine, { task: makeTaskState('T9', { status: 'interrupted' }), interrupted: true })
    expect(line).toContain('当前任务 T9 状态 interrupted（任务卡解析失败）')
    expect(line).toContain('flow_task_start("T9")')
  })

  it('交接摘要 + 任务卡组合；两者都没有时返回空数组', () => {
    const engine = createFakeEngine()
    engineState(engine).tasks = [makeTaskCard({ id: 'T3' })]
    const parts = buildHandoffParts(engine, interruptedChange())
    expect(parts[0]).toBe('交接摘要：上次做到 T2，验证组已过 RED')
    expect(parts[1]).toContain('当前任务卡 T3')
    expect(buildHandoffParts(engine, makeChange())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// H2：会话启动注入（集成）
// ---------------------------------------------------------------------------

describe('会话启动注入（H2）', () => {
  it('会话中断后启动：注入交接摘要 + 最近中断任务卡与恢复提示', async () => {
    const engine = createFakeEngine()
    const state = engineState(engine)
    state.current = interruptedChange()
    state.tasks = [
      makeTaskCard({
        id: 'T3',
        title: '任务T3',
        scope: ['src/c.ts'],
        verify: [{ group: 'unit', command: 'pnpm vitest run', inputs: [] }],
        tdd: 'required',
        run: 'subagent',
      }),
    ]
    const h = await start(engine)
    const text = injectedTexts(h.agent).join('\n')
    expect(text).toContain('已接续变更 C-001')
    expect(text).toContain('交接摘要：上次做到 T2，验证组已过 RED')
    expect(text).toContain('当前任务卡 T3「任务T3」')
    expect(text).toContain('范围 src/c.ts')
    expect(text).toContain('验证组 unit=pnpm vitest run')
    expect(text).toContain('TDD required')
    expect(text).toContain('上一会话中断')
    expect(text).toContain('flow_task_start("T3") 恢复/继续')
    // 最近中断优先：更早中断的 T2 不应被当成当前任务卡。
    expect(text).not.toContain('当前任务卡 T2')
  })

  it('有 running 任务时仍优先注入 running 任务卡（不回退到 interrupted）', async () => {
    const engine = createFakeEngine()
    const state = engineState(engine)
    state.current = makeChange({
      tasks: {
        T1: makeTaskState('T1', { status: 'running' }),
        T2: makeTaskState('T2', { status: 'interrupted', interruptedAt: '2026-01-01T00:05:00.000Z' }),
      },
    })
    state.tasks = [makeTaskCard({ id: 'T1', title: '任务T1' }), makeTaskCard({ id: 'T2', title: '任务T2' })]
    const h = await start(engine)
    const text = injectedTexts(h.agent).join('\n')
    expect(text).toContain('当前任务卡 T1「任务T1」')
    expect(text).not.toContain('上一会话中断')
  })
})

// ---------------------------------------------------------------------------
// H3：上下文压缩后重注入
// ---------------------------------------------------------------------------

describe('上下文压缩后重注入（H3）', () => {
  it('agent/created source=compact 时向新 agent 重注入交接摘要 + 当前任务卡', async () => {
    const engine = createFakeEngine()
    const state = engineState(engine)
    state.current = interruptedChange()
    state.tasks = [makeTaskCard({ id: 'T3', title: '任务T3' })]
    const h = await start(engine)
    // 压缩前主会话只有启动注入（应可忽略），压缩事件针对新 agent。
    const compacted = createFakeAgent({ id: 'session-compacted', cwd: '/fake/project', ctx: h.ctx })
    h.ctx.emitEvent('agent/created', { agent: compacted, source: 'compact' })
    await flush(20)

    const text = injectedTexts(compacted).join('\n')
    expect(text).toContain('上下文已压缩')
    expect(text).toContain('重新注入变更 C-001 的交接摘要与当前任务卡')
    expect(text).toContain('交接摘要：上次做到 T2，验证组已过 RED')
    expect(text).toContain('当前任务卡 T3「任务T3」')
    expect(text).toContain('上一会话中断')
    expect(text).toContain('flow_task_start')
    // 压缩重注入只发给新 agent，不重复打扰原主会话。
    expect(injectedTexts(h.agent).some((item) => item.includes('上下文已压缩'))).toBe(false)
    // doctor 可见的功能说明。
    expect(h.runtime.featureNotes.session?.join('；')).toContain('上下文压缩后已重新注入')
  })

  it('source 不是 compact 时不走压缩重注入（绝不猜测）', async () => {
    const engine = createFakeEngine()
    const state = engineState(engine)
    state.current = interruptedChange()
    state.tasks = [makeTaskCard({ id: 'T3', title: '任务T3' })]
    const h = await start(engine)
    const resumed = createFakeAgent({ id: 'session-resumed', cwd: '/fake/project', ctx: h.ctx })
    h.ctx.emitEvent('agent/created', { agent: resumed, source: 'resume' })
    await flush(20)
    expect(injectedTexts(resumed)).toEqual([])
    expect(h.runtime.featureNotes.session?.join('；') ?? '').not.toContain('上下文压缩后已重新注入')
  })

  it('引擎未就绪/未初始化时只记录降级原因，不注入空消息', async () => {
    const engine = createFakeEngine({ initialized: false })
    const h = await start(engine)
    expect(h.runtime.engine()?.isInitialized()).toBe(false)
    const compacted = createFakeAgent({ id: 'session-compacted', cwd: '/fake/project', ctx: h.ctx })
    h.ctx.emitEvent('agent/created', { agent: compacted, source: 'compact' })
    await flush(20)
    expect(injectedTexts(compacted)).toEqual([])
    expect(h.runtime.featureNotes.session?.join('；')).toContain('上下文压缩后跳过重注入：引擎未就绪')
    // 未初始化时也走卡片启用，不再提示 /flow init。
    expect(h.runtime.featureNotes.session?.join('；')).toContain('等待负责人在授权卡片上启用')
    expect(h.runtime.featureNotes.session?.join('；')).not.toContain('/flow init')
  })
})
