/**
 * dispatch 模块单测（03 §7.5 / H18 / H20 / H21 / H22）：
 * - flow_dispatch_next 注册与降级口径（engine 未就绪 / 无 subagents / 无 provider）；
 * - 顺序批次成功派发：执行者 preset 启动、立即返回 dispatched 清单、后台结算；
 * - 并行批次：建 worktree（git 端口用 mock 隔离，不依赖本机仓库）、多任务启动；
 * - worktree 创建失败降级为主工作区顺序执行且不抛错；
 * - dispatchBusy 互斥（运行中拒绝重复派发，结束后恢复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshSubagentActivationSpec, DshSubagentResult } from '../../src/host/adapters/dsh-types.js'
import type { ChangeStatus, DispatchOutcome, DispatchTaskEnvelope, FlowgateConfig, TaskCard, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { dispatchBusy, EXECUTOR_OUTPUT_SCHEMA, resetDispatchStateForTest, runningDispatches } from '../../src/host/dispatch/index.js'
import { createFakeEngine, createFakeSubagents, defaultFakeConfig, type FakeEngineState } from '../../src/host/testing/fake-ctx.js'
import { FLOWGATE_PRESETS } from '../../src/host/guard/delegation.js'
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'

// 派发模块的 worktree 逻辑直接调用 node-git 适配器（deps 端口不覆盖它）：
// 这里 mock 掉进程级 git，让 worktree 成功/失败两条路径都可确定性单测。
const gitMock = vi.hoisted(() => ({ runGit: vi.fn() }))

vi.mock('../../src/host/adapters/node-git.js', () => ({
  runGit: gitMock.runGit,
  // host/deps.ts 会 import NodeGit；保持模块形状即可（本测试注入 fake deps，不走真实实现）。
  NodeGit: class NodeGitStub {},
  GitCommandError: class GitCommandErrorStub extends Error {},
}))

type FakeSubagents = ReturnType<typeof createFakeSubagents>

let harness: PluginHarness | null = null

beforeEach(() => {
  // 模块级 running 表跨用例隔离（full-suite 并发负载下有残留风险）。
  resetDispatchStateForTest()
  gitMock.runGit.mockReset()
  // 默认：git 操作失败（非 worktree 用例不会调用它；worktree 用例自行覆盖）。
  gitMock.runGit.mockResolvedValue({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })
})

afterEach(async () => {
  // 等待后台结算完成，避免 running 残留到下一个用例。
  await flush(20)
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

async function start(options: Parameters<typeof setupPlugin>[0] = {}): Promise<PluginHarness> {
  harness = await setupPlugin(options)
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

/** 审查关闭的假引擎（本文件只关注派发；审查由 review.test.ts 覆盖）。 */
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

function specAt(subagents: FakeSubagents, index: number): DshSubagentActivationSpec {
  return subagents.state.started[index] as DshSubagentActivationSpec
}

function promptText(spec: DshSubagentActivationSpec): string {
  return spec.request.prompt.map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('\n')
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
  return await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-dispatch-'))
}

// ---------------------------------------------------------------------------
// 注册与降级
// ---------------------------------------------------------------------------

describe('flow_dispatch_next 注册', () => {
  it('注册工具（object root 参数、可渲染输出）并记录能力说明', async () => {
    const h = await start()
    const tool = h.tools.state.tools.get('flow_dispatch_next')
    expect(tool).toBeTruthy()
    expect(tool?.description).toContain('S4 派发模式')
    expect(tool?.parameters).toMatchObject({ type: 'object', properties: {} })
    expect(tool?.output.schema).toBeTruthy()
    expect(typeof tool?.output.render).toBe('function')
    expect(h.runtime.featureNotes.dispatch?.join('；')).toContain('已注册 flow_dispatch_next')
  })
})

describe('派发前的能力检查', () => {
  it('engine 未就绪时返回结构化失败（error + hint）', async () => {
    harness = await setupPlugin({ bindAgent: false })
    expect(harness.runtime.engine()).toBeNull()
    const { value } = await runTool(harness, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('FlowGate 引擎未就绪')
    expect(value.data?.error).toBe('FlowGate 引擎未就绪')
    expect(String(value.data?.hint)).toContain('/flow init')
  })

  it('宿主没有 subagents 服务时返回降级错误且不调用 engine.dispatchNext', async () => {
    const engine = makeEngine()
    const dispatchCalls = stubDispatch(engine, () => Promise.reject(new Error('不应被调用')))
    const h = await start({ engine, services: { subagents: undefined } })
    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.data?.error).toBe('宿主不支持派发子 agent')
    expect(String(value.data?.hint)).toContain('ctx.subagents.startActivation')
    expect(String(value.data?.hint)).toContain('inline')
    expect(value.data?.validValues).toEqual({ dispatch: ['inline', 'auto', 'subagent'] })
    expect(dispatchCalls.count).toBe(0)
    expect(subagentsStarted(h)).toBe(0)
  })

  it('宿主有 subagents 服务但没有可用 provider 时返回降级错误', async () => {
    const h = await start({ engine: makeEngine(), services: { subagents: createFakeSubagents({ providers: [] }) } })
    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(false)
    expect(value.data?.error).toBe('宿主不支持派发子 agent')
    expect(String(value.data?.hint)).toContain('没有可用的子 agent provider')
  })
})

function subagentsStarted(h: PluginHarness): number {
  const subagents = h.ctx.get('subagents') as FakeSubagents | undefined
  return subagents?.state.started.length ?? 0
}

// ---------------------------------------------------------------------------
// 顺序批次成功路径
// ---------------------------------------------------------------------------

describe('顺序批次派发', () => {
  it('以执行者 preset 启动子 agent、立即返回 dispatched 清单，并在后台结算', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents()
    const dispatched = [makeEnvelope('T1')]
    const dispatchCalls = stubDispatch(engine, { dispatched, batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' })
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(dispatchCalls.count).toBe(1)
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('✓ T1 任务T1（sequential）')
    expect(value.data?.dispatched).toEqual([{ taskId: 'T1', title: '任务T1', batch: 'B1', mode: 'sequential' }])
    expect(value.data?.batchId).toBe('B1')
    expect(value.data?.mode).toBe('sequential')

    // startExecutor：执行者 preset、caller 交付、不带主会话历史、cwd 主工作区。
    expect(subagents.state.started.length).toBe(1)
    const spec = specAt(subagents, 0)
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('flowgate-exec-T1')
    expect(spec.delivery).toBe('caller')
    expect(spec.request.agentPreset).toBe(FLOWGATE_PRESETS.executor)
    expect(spec.request.outputSchema).toBe(EXECUTOR_OUTPUT_SCHEMA)
    expect(spec.request.maxDepth).toBe(1)
    expect(spec.request.cwd).toBe('/fake/project')
    const prompt = promptText(spec)
    expect(prompt).toContain('T1')
    expect(prompt).toContain('任务卡正文')
    expect(prompt).toContain('src/a.ts')
    await flush()
    // 后台结算：记录角色 → 任务门 → 通知主会话（inject，不唤醒）。
    expect(dispatchBusy()).toBe(false)
    expect(runningDispatches()).toEqual([])
    expect(h.runtime.agentRoles.get('child-1')?.role).toBe('executor')
    expect(engineState(engine).calls.taskDone).toEqual(['T1'])
    // 完成后用 inject（不唤醒）通知主会话；绑定变更时的 resume 注入不算完成通知。
    expect(completionNotices(h)).toHaveLength(1)
    const text = lastNotice(h)
    expect(text).toContain('任务 T1 的子 agent 已结束')
    expect(text).toContain('摘要：ok')
  })

  it('启动子 agent 失败时标记任务失败并在清单里给出 ✗ 行（不抛错）', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents({ start: async () => Promise.reject(new Error('spawn 不可用')) })
    stubDispatch(engine, { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' })
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('✗ T1 启动失败：startActivation 失败：spawn 不可用')
    expect(engineState(engine).calls.taskFailed).toEqual([{ taskId: 'T1', reason: 'startActivation 失败：spawn 不可用' }])
    expect(dispatchBusy()).toBe(false)
  })

  it('没有可派发任务时返回空 dispatched 清单，不启动子 agent', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents()
    stubDispatch(engine, { dispatched: [], message: '当前没有可派发的任务（fake）。' })
    const h = await start({ engine, services: { subagents } })
    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    expect(value.data?.dispatched).toEqual([])
    expect(value.summary).toContain('当前没有可派发的任务')
    expect(subagents.state.started.length).toBe(0)
    await flush()
    expect(completionNotices(h)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 并行批次与 worktree
// ---------------------------------------------------------------------------

describe('并行批次 worktree', () => {
  it('并行多任务各自建 worktree，执行者 cwd 指向 worktree 并记账', async () => {
    const projectRoot = await tempProject()
    try {
      gitMock.runGit.mockResolvedValue({ stdout: 'main', stderr: '', exitCode: 0 })
      const engine = makeEngine()
      const worktrees: { taskId: string; worktree: string; agentId?: string }[] = []
      engine.setTaskWorktree = async (taskId, worktree, agentId) => {
        worktrees.push({ taskId, worktree, ...(agentId ? { agentId } : {}) })
      }
      const subagents = createFakeSubagents()
      const dispatched = [makeEnvelope('T1', { mode: 'parallel' }), makeEnvelope('T2', { mode: 'parallel' })]
      stubDispatch(engine, { dispatched, batchId: 'B1', mode: 'parallel', message: '已派发 T1、T2（并行批次 B1）。' })
      const h = await start({ engine, services: { subagents }, config: { projectRoot } })

      const { value } = await runTool(h, 'flow_dispatch_next', {})
      expect(value.ok).toBe(true)
      expect(subagents.state.started.length).toBe(2)
      const wtT1 = nodePath.join(projectRoot, '.flowgate/worktrees/C-001/T1')
      const wtT2 = nodePath.join(projectRoot, '.flowgate/worktrees/C-001/T2')
      // git worktree add 成功路径被走到（未被降级）。
      const gitCalls = gitMock.runGit.mock.calls.map((call) => (call[0] as string[]).join(' '))
      expect(gitCalls.some((line) => line === `worktree add -b flowgate/C-001/T1 ${wtT1} main`)).toBe(true)
      expect(gitCalls.some((line) => line === `worktree add -b flowgate/C-001/T2 ${wtT2} main`)).toBe(true)
      // 执行者 cwd 指向各自 worktree；摘要行展示 worktree 路径。
      expect(specAt(subagents, 0).request.cwd).toBe(wtT1)
      expect(specAt(subagents, 1).request.cwd).toBe(wtT2)
      expect(promptText(specAt(subagents, 0))).toContain('独立 worktree')
      expect(value.summary).toContain(`worktree=.flowgate/worktrees/C-001/T1`)
      expect(value.summary).toContain(`worktree=.flowgate/worktrees/C-001/T2`)
      // 结构化返回的 dispatch 条目必须回填实际创建的 worktree（不是派发前的空快照）。
      const dispatchedData = value.data?.dispatched as { taskId: string; worktree?: string }[]
      expect(dispatchedData.map((item) => [item.taskId, item.worktree])).toEqual([
        ['T1', '.flowgate/worktrees/C-001/T1'],
        ['T2', '.flowgate/worktrees/C-001/T2'],
      ])
      // prepareWorktree 会预先创建 worktree 的父目录（真正目录由 git worktree add 创建，本测试被 mock）。
      await expect(fsp.stat(nodePath.dirname(wtT1))).resolves.toBeTruthy()
      expect(worktrees).toEqual([
        { taskId: 'T1', worktree: '.flowgate/worktrees/C-001/T1', agentId: 'child-1' },
        { taskId: 'T2', worktree: '.flowgate/worktrees/C-001/T2', agentId: 'child-2' },
      ])
      await flush()
      expect(dispatchBusy()).toBe(false)
      expect(engineState(engine).calls.taskDone).toEqual(['T1', 'T2'])
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('worktree 创建失败时降级为主工作区顺序执行且不抛错', async () => {
    const projectRoot = await tempProject()
    try {
      // git 全部失败：worktree add 首次失败 → 复用分支也失败 → 降级。
      gitMock.runGit.mockResolvedValue({ stdout: '', stderr: 'fatal: could not create work tree dir', exitCode: 128 })
      const engine = makeEngine()
      const subagents = createFakeSubagents()
      stubDispatch(engine, { dispatched: [makeEnvelope('T1', { mode: 'parallel' })], batchId: 'B1', mode: 'parallel', message: '已派发任务 T1（并行批次 B1）。' })
      const h = await start({ engine, services: { subagents }, config: { projectRoot } })

      const { value } = await runTool(h, 'flow_dispatch_next', {})
      expect(value.ok).toBe(true)
      expect(value.summary).toContain('✓ T1 任务T1（parallel）')
      expect(h.runtime.featureNotes.dispatch?.join('；')).toContain('worktree 创建失败，批次降级为顺序执行')
      // 降级后仍在主工作区启动，且 dispatched 条目不谎报 worktree。
      expect(subagents.state.started.length).toBe(1)
      expect(specAt(subagents, 0).request.cwd).toBe(projectRoot)
      expect((value.data?.dispatched as Record<string, unknown>[])[0]?.worktree).toBeUndefined()
      await flush()
      expect(dispatchBusy()).toBe(false)
      expect(engineState(engine).calls.taskDone).toEqual(['T1'])
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 并发互斥
// ---------------------------------------------------------------------------

describe('dispatchBusy 互斥', () => {
  it('子 agent 运行中拒绝重复派发，结束后恢复可派发', async () => {
    const engine = makeEngine()
    let resolveResult!: (result: DshSubagentResult) => void
    const result = new Promise<DshSubagentResult>((resolve) => {
      resolveResult = resolve
    })
    let disposed = 0
    const subagents = createFakeSubagents({
      start: async () => ({
        childId: 'child-busy',
        result,
        dispose: async () => {
          disposed += 1
        },
      }),
    })
    const dispatchCalls = stubDispatch(engine, { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' })
    const h = await start({ engine, services: { subagents } })

    const first = await runTool(h, 'flow_dispatch_next', {})
    expect(first.value.ok).toBe(true)
    expect(dispatchBusy()).toBe(true)
    expect(runningDispatches().map((item) => item.taskId)).toEqual(['T1'])
    expect(runningDispatches()[0]?.childId).toBe('child-busy')

    const second = await runTool(h, 'flow_dispatch_next', {})
    expect(second.value.ok).toBe(false)
    expect(second.value.summary).toContain('上一批任务还在运行')
    expect(second.value.data?.error).toBe('上一批任务还在运行')
    expect(dispatchCalls.count).toBe(1)

    // 子 agent 结束 → 后台结算 → 互斥解除。
    resolveResult({
      output: [{ type: 'text', text: '完成' }],
      structured: { summary: '完成', filesChanged: ['src/a.ts'], evidenceIds: ['E-1'] },
      stopReason: 'completed',
    })
    await flush()
    expect(dispatchBusy()).toBe(false)
    expect(runningDispatches()).toEqual([])
    expect(disposed).toBe(1)
    expect(engineState(engine).calls.taskDone).toEqual(['T1'])
    const text = lastNotice(h)
    expect(text).toContain('摘要：完成')
    expect(text).toContain('改动文件：src/a.ts')
    expect(text).toContain('证据：E-1')
  })

  it('子 agent 非 completed 结束时标记任务失败并通知主会话', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents({
      start: async () => ({
        childId: 'child-abort',
        result: Promise.resolve({
          output: [],
          structured: { summary: '中途取消' },
          stopReason: 'cancelled',
        } satisfies DshSubagentResult),
        dispose: async () => {},
      }),
    })
    stubDispatch(engine, { dispatched: [makeEnvelope('T1')], batchId: 'B1', mode: 'sequential', message: '已派发任务 T1（顺序批次 B1）。' })
    const h = await start({ engine, services: { subagents } })

    const { value } = await runTool(h, 'flow_dispatch_next', {})
    expect(value.ok).toBe(true)
    await flush()
    expect(dispatchBusy()).toBe(false)
    expect(engineState(engine).calls.taskFailed).toEqual([{ taskId: 'T1', reason: '子 agent 停止原因：cancelled' }])
    expect(engineState(engine).calls.taskDone).toEqual([])
    expect(lastNotice(h)).toContain('任务已标记失败')
  })
})
