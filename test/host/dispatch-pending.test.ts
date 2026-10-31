/**
 * dispatch 与待处理项（pending）的单测（T4.6 / T4.9；03 §7.5 / §8.3）。
 *
 * 覆盖真机 C-004 暴露的缺口：
 * - 并行/顺序批次里执行者越界生成 `SC-n` 后，主会话必须收到注入通知（不是静默留状态）；
 *   同一条 pending 只通知一次；
 * - `flow_dispatch_next` 派发前有未审批的 scope/plan/risk 时必须拒绝并给出可解释提示；
 *   rule 待处理项不阻断但要在返回里可见；
 * - 集成检查点失败的结论与它生成的待处理项要出现在完成通知里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeStatus, DispatchOutcome, DispatchTaskEnvelope, FlowgateConfig, PendingItem, PendingKind, TaskCard, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { dispatchBusy, resetDispatchStateForTest } from '../../src/host/dispatch/index.js'
import { createFakeEngine, createFakeSubagents, defaultFakeConfig, type FakeEngineState } from '../../src/host/testing/fake-ctx.js'
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'

// 并行批次的 worktree 路径会走进程级 git 适配器；这里统一 mock，避免依赖本机仓库。
const gitMock = vi.hoisted(() => ({ runGit: vi.fn() }))
vi.mock('../../src/host/adapters/node-git.js', () => ({
  runGit: gitMock.runGit,
  NodeGit: class NodeGitStub {},
  GitCommandError: class GitCommandErrorStub extends Error {},
}))

let harness: PluginHarness | null = null

beforeEach(() => {
  resetDispatchStateForTest()
  gitMock.runGit.mockReset()
  gitMock.runGit.mockResolvedValue({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })
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

function makePending(id: string, kind: PendingKind, title: string, data: Record<string, unknown> = {}): PendingItem {
  const taskId = typeof data.taskId === 'string' ? data.taskId : undefined
  return {
    id,
    kind,
    changeId: 'C-001',
    title,
    detail: `${title} 详情`,
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    data,
    ...(taskId ? { scope: { changeId: 'C-001', taskId } } : {}),
  }
}

function makeEnvelope(taskId = 'T1', overrides: Partial<DispatchTaskEnvelope> = {}): DispatchTaskEnvelope {
  return {
    changeId: 'C-001',
    taskId,
    batch: 'B1',
    mode: 'sequential',
    task: makeTaskCard({ id: taskId, title: `任务${taskId}` }),
    coveredScenarios: [],
    contextExcerpt: '',
    verifyGroups: [],
    tdd: false,
    ...overrides,
  }
}

function makeEngine(): PluginHarness['engine'] {
  const config = defaultFakeConfig() as unknown as FlowgateConfig
  config.review = { enabled: false, requireForTaskGate: false }
  const engine = createFakeEngine({ config })
  const state = engineState(engine)
  state.current = makeChange()
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

function injectedTexts(h: PluginHarness): string[] {
  return h.agent.state.injected.map((message) =>
    message.content.map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('\n'),
  )
}

/** 派发完成通知（排除 session 模块在绑定变更时的"已接续变更"注入）。 */
function completionNotices(h: PluginHarness): string[] {
  return injectedTexts(h).filter((text) => text.includes('的子 agent 已结束'))
}

function lastNotice(h: PluginHarness): string {
  const notices = completionNotices(h)
  return notices[notices.length - 1] ?? ''
}

async function tempProject(): Promise<string> {
  return await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-pending-'))
}

/** 让 fake 引擎的 taskDone 在结算时挂上一条 pending（模拟执行者结算期间请求范围变更）。 */
function taskDoneAddingPending(engine: PluginHarness['engine'], pending: PendingItem, taskId = 'T1'): void {
  engine.taskDone = async (id: string) => {
    engineState(engine).calls.taskDone.push(id)
    engineState(engine).current = {
      ...(engineState(engine).current as ChangeStatus),
      pending: [...(engineState(engine).current as ChangeStatus).pending, pending],
      tasks: { ...(engineState(engine).current as ChangeStatus).tasks, [taskId]: makeTaskState(taskId, { status: 'done' }) },
    }
    return { ok: true, passed: true, failures: [], message: `任务 ${id} 通过（fake）。`, committed: false }
  }
}

// ---------------------------------------------------------------------------
// a) pending 通知
// ---------------------------------------------------------------------------

describe('子 agent 生成待处理项后的通知（T4.6）', () => {
  it('执行者越界生成 SC-n 后，完成通知注入主会话并给出处理命令', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents()
    stubDispatch(engine, { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' })
    taskDoneAddingPending(engine, makePending('SC-1', 'scope', 'T1 申请扩大范围', { taskId: 'T1', add: ['src/b.ts'] }))
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    await flush()
    expect(dispatchBusy()).toBe(false)
    const notice = lastNotice(h)
    expect(notice).toContain('任务 T1 的子 agent 已结束')
    // 通知里必须出现待处理项 id、标题与卡片处理方式，而不是只留内存状态。
    expect(notice).toContain('待处理项')
    expect(notice).toContain('SC-1')
    expect(notice).toContain('T1 申请扩大范围')
    expect(notice).toContain('授权卡片')
    expect(notice).not.toContain('/flow scope approve')
    // 单条 inject 同时包含完成摘要与待处理项通知。
    expect(completionNotices(h)).toHaveLength(1)
  })

  it('同一条待处理项只通知一次；负责人处理后可以继续派发', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents()
    const scope = makePending('SC-1', 'scope', 'T1 申请扩大范围', { taskId: 'T1', add: ['src/b.ts'] })
    taskDoneAddingPending(engine, scope)
    // 第一次派发 T1（结算时生成 SC-1）；负责人批准后再派发 T2（结算时没有新 pending）。
    const queue: DispatchOutcome[] = [
      { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' },
      { dispatched: [makeEnvelope('T2')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T2（顺序批次 B1）。' },
    ]
    const dispatchCalls = stubDispatch(engine, async () => queue.shift() ?? { dispatched: [], message: '没有可派发的任务（fake）。' })
    const h = await start({ engine, services: { subagents } })

    const first = await runTool(h, 'flow_dispatch_next', {})
    expect(first.value.ok).toBe(true)
    await flush()
    expect(lastNotice(h)).toContain('SC-1')

    // 负责人批准 pending（/flow scope approve SC-1 的等价状态变化）。
    scope.status = 'approved'
    engineState(engine).current = {
      ...(engineState(engine).current as ChangeStatus),
      pending: [(engineState(engine).current as ChangeStatus).pending[0] as PendingItem],
    }
    const second = await runTool(h, 'flow_dispatch_next', {})
    expect(second.value.ok).toBe(true)
    expect(dispatchCalls.count).toBe(2)
    await flush()
    const notices = completionNotices(h)
    expect(notices).toHaveLength(2)
    expect(notices[1]).not.toContain('SC-1')
  })

  it('并行批次结算通知包含集成检查点结论与检查点生成的待处理项', async () => {
    const projectRoot = await tempProject()
    try {
      gitMock.runGit.mockResolvedValue({ stdout: 'main', stderr: '', exitCode: 0 })
      const engine = makeEngine()
      const subagents = createFakeSubagents()
      engineState(engine).snapshotOverrides = { batches: [{ id: 'B1', mode: 'parallel', status: 'checkpoint', tasks: ['T1'] }] }
      taskDoneAddingPending(engine, makePending('CF-1', 'conflict', '批次 B1 集成检查点失败', { batchId: 'B1' }))
      let parallelCalls = 0
      stubDispatch(engine, async () => {
        parallelCalls += 1
        return parallelCalls === 1
          ? { dispatched: [makeEnvelope('T1', { mode: 'parallel' })], batchId: 'B1', mode: 'parallel' as const, message: '已派发任务 T1（并行批次 B1）。' }
          : { dispatched: [], batchId: 'B1', mode: 'parallel' as const, message: '没有可补位的任务（fake）。' }
      })
      const h = await start({ engine, services: { subagents }, config: { projectRoot } })

      const { value } = await runTool(h, 'flow_dispatch_next', {})
      expect(value.ok).toBe(true)
      await flush(20)
      const notice = lastNotice(h)
      expect(notice).toContain('集成检查点：批次 B1 通过')
      expect(notice).toContain('CF-1')
      expect(notice).toContain('集成检查点失败')
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// d) 派发前未审批 pending 的拦截
// ---------------------------------------------------------------------------

describe('派发前的待处理项复核（T4.6）', () => {
  for (const [kind, label] of [
    ['scope', '范围变更 SC-n'],
    ['plan', '计划修订 PC-n'],
    ['risk', '风险接管 RK-n'],
  ] as const) {
    it(`未审批的 ${label} 阻断派发并返回可解释提示`, async () => {
      const engine = makeEngine()
      engineState(engine).current = makeChange({ pending: [makePending(kind === 'scope' ? 'SC-1' : kind === 'plan' ? 'PC-1' : 'RK-1', kind, `${label} 待处理`)] })
      const subagents = createFakeSubagents()
      const dispatchCalls = stubDispatch(engine, { dispatched: [], message: '不应被调用' })
      const h = await start({ engine, services: { subagents } })

      const { value } = await runTool(h, 'flow_dispatch_next', {})
      const id = kind === 'scope' ? 'SC-1' : kind === 'plan' ? 'PC-1' : 'RK-1'
      expect(value.ok).toBe(false)
      expect(value.summary).toContain('未审批的待处理项')
      expect(String(value.data?.hint)).toContain('授权卡片')
      expect(String(value.data?.hint)).toContain(id)
      expect(String(value.data?.hint)).not.toContain(`/flow ${kind} approve`)
      expect(value.data?.pending).toEqual([expect.objectContaining({ id, kind, status: 'open' })])
      expect(dispatchCalls.count).toBe(0)
      expect(subagents.state.started).toHaveLength(0)
    })
  }

  it('rule 提议不阻断派发，但在返回的 pending 列表与 summary 里可见', async () => {
    const engine = makeEngine()
    engineState(engine).current = makeChange({ pending: [makePending('RL-1', 'rule', '规则沉淀提议')] })
    const subagents = createFakeSubagents()
    const dispatchCalls = stubDispatch(engine, { dispatched: [], message: '当前没有可派发的任务（fake）。' })
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(dispatchCalls.count).toBe(1)
    expect(value.summary).toContain('当前没有可派发的任务')
    expect(String(value.summary)).toContain('RL-1')
    expect(value.data?.pending).toEqual([expect.objectContaining({ id: 'RL-1', kind: 'rule', status: 'open' })])
  })

  it('待处理项被负责人处理（非 open）后恢复派发', async () => {
    const engine = makeEngine()
    const approved = makePending('SC-1', 'scope', '范围变更已批准', { taskId: 'T1', add: ['src/b.ts'] })
    approved.status = 'approved'
    engineState(engine).current = makeChange({ pending: [approved] })
    const subagents = createFakeSubagents()
    const dispatchCalls = stubDispatch(engine, { dispatched: [], message: '当前没有可派发的任务（fake）。' })
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(dispatchCalls.count).toBe(1)
    expect(value.data?.pending).toBeUndefined()
  })
})
