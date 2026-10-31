/**
 * 并行批次集成检查点单测（T4.9 / 03 §7.5）。
 *
 * 现有 `dispatch.test.ts` 只覆盖「合并成功」与「合并冲突 abort」两条主路径；
 * 本文件补齐：合并顺序、分支不存在跳过、集成命令失败、任务未全部完成时不做检查点、
 * worktree 清理失败降级、completeCheckpoint 异常兜底，以及 `parallel.max_agents=2`
 * 时第 3 个任务在宿主侧排队的契约（容量计算在 core engine.dispatchNext）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshSubagentActivationSpec, DshSubagentResult } from '../../src/host/adapters/dsh-types.js'
import type { ChangeStatus, FlowgateConfig, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { dispatchBusy, resetDispatchStateForTest, runIntegrationCheckpoint, runningDispatches } from '../../src/host/dispatch/index.js'
import { createFakeEngine, createFakeSubagents, defaultFakeConfig, type FakeEngineState } from '../../src/host/testing/fake-ctx.js'
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'

// 集成检查点/worktree 走进程级 git 适配器：mock 掉，避免依赖本机仓库。
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
  gitMock.runGit.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
})

afterEach(async () => {
  await flush(20)
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function gitLines(): string[] {
  return gitMock.runGit.mock.calls.map((call) => (call[0] as string[]).join(' '))
}

// ---------------------------------------------------------------------------
// runIntegrationCheckpoint 分支
// ---------------------------------------------------------------------------

describe('runIntegrationCheckpoint 分支', () => {
  interface CheckpointStub {
    runtime: unknown
    engine: unknown
    completed: { id: string; result: { ok: boolean; detail?: string } }[]
    noteFeature: ReturnType<typeof vi.fn>
    commandRunner: ReturnType<typeof vi.fn>
  }

  function checkpointStub(options: {
    tasks: Record<string, { status: string; worktree?: string }>
    batchTasks?: string[]
    integration?: string
    completeCheckpoint?: (id: string, result: { ok: boolean; detail?: string }) => Promise<void>
    root?: string | null
    withPorts?: boolean
    batches?: { id: string; tasks: string[] }[]
    changeNull?: boolean
  }): CheckpointStub {
    const completed: { id: string; result: { ok: boolean; detail?: string } }[] = []
    const noteFeature = vi.fn()
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }))
    const batches = options.batches ?? [{ id: 'B1', tasks: options.batchTasks ?? ['T1', 'T2'] }]
    const root = options.root === undefined ? '/fake/project' : options.root
    const runtime = {
      root: () => root,
      ports: () => (options.withPorts === false ? null : { commandRunner: { run: commandRunner } }),
      noteFeature,
      emit: vi.fn(),
      absolute: (relative: string) => nodePath.join(root ?? '/fake/project', relative),
      log: vi.fn(),
    }
    const engine = {
      snapshot: () => ({ batches }),
      currentChange: () => (options.changeNull ? null : { id: 'C-001', tasks: options.tasks, batches: [] }),
      getConfig: () => ({ commands: { integration: options.integration ?? 'pnpm test' }, parallel: { setup: null, max_agents: 3 } }),
      completeCheckpoint:
        options.completeCheckpoint ??
        (async (id: string, result: { ok: boolean; detail?: string }) => {
          completed.push({ id, result })
        }),
    }
    return { runtime, engine, completed, noteFeature, commandRunner }
  }

  const doneTasks = {
    T1: { status: 'done', worktree: '.flowgate/worktrees/C-001/T1' },
    T2: { status: 'done', worktree: '.flowgate/worktrees/C-001/T2' },
  }

  it('按 batch.tasks 顺序合并与清理，成功后才删除 worktree 与任务分支', async () => {
    const stub = checkpointStub({ tasks: doneTasks, batchTasks: ['T2', 'T1'] })
    const result = await runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1')
    const calls = gitLines()
    expect(calls.filter((line) => line.startsWith('merge --no-ff'))).toEqual([
      'merge --no-ff --no-edit flowgate-tasks/C-001/T2',
      'merge --no-ff --no-edit flowgate-tasks/C-001/T1',
    ])
    expect(calls.filter((line) => line.startsWith('worktree remove --force'))).toEqual([
      `worktree remove --force ${nodePath.join('/fake/project', '.flowgate/worktrees/C-001/T2')}`,
      `worktree remove --force ${nodePath.join('/fake/project', '.flowgate/worktrees/C-001/T1')}`,
    ])
    expect(calls.filter((line) => line.startsWith('branch -D'))).toEqual([
      'branch -D flowgate-tasks/C-001/T2',
      'branch -D flowgate-tasks/C-001/T1',
    ])
    expect(result).toEqual({ batchId: 'B1', ok: true })
    expect(stub.completed).toEqual([{ id: 'B1', result: { ok: true } }])
    expect(stub.noteFeature).toHaveBeenCalledWith('dispatch', expect.stringContaining('集成检查点通过'))
  })

  it('任务分支不存在时跳过该任务的合并，其余任务照常合并', async () => {
    gitMock.runGit.mockImplementation(async (args: string[]) => {
      const line = args.join(' ')
      if (line.includes('refs/heads/flowgate-tasks/C-001/T1') && line.startsWith('rev-parse')) {
        return { stdout: '', stderr: '', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const stub = checkpointStub({ tasks: doneTasks })
    const result = await runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1')
    const merges = gitLines().filter((line) => line.startsWith('merge --no-ff'))
    expect(merges).toEqual(['merge --no-ff --no-edit flowgate-tasks/C-001/T2'])
    expect(result?.ok).toBe(true)
    expect(stub.completed[0]?.result.ok).toBe(true)
  })

  it('集成命令失败时记录 checkpoint 失败、保留 worktree 便于排查', async () => {
    const runner = vi.fn(async () => ({ exitCode: 2, stdout: 'partial', stderr: '2 tests failed', timedOut: false }))
    type CheckpointResult = {
      ok: boolean
      detail?: string
      kind?: 'merge' | 'integration' | 'unknown'
      output?: string
      command?: string
    }
    const completed: { id: string; result: CheckpointResult }[] = []
    const noteFeature = vi.fn()
    const runtime = {
      root: () => '/fake/project',
      ports: () => ({ commandRunner: { run: runner } }),
      noteFeature,
      emit: vi.fn(),
      absolute: (relative: string) => nodePath.join('/fake/project', relative),
      log: vi.fn(),
    }
    const engine = {
      snapshot: () => ({ batches: [{ id: 'B1', tasks: ['T1', 'T2'] }] }),
      currentChange: () => ({ id: 'C-001', tasks: doneTasks, batches: [] }),
      getConfig: () => ({ commands: { integration: 'pnpm test' }, parallel: { setup: null, max_agents: 3 } }),
      completeCheckpoint: async (id: string, result: CheckpointResult) => {
        completed.push({ id, result })
      },
    }
    const result = await runIntegrationCheckpoint(runtime as never, engine as never, 'B1')
    expect(result?.ok).toBe(false)
    expect(result?.detail).toContain('集成命令失败')
    expect(result?.detail).toContain('exit=2')
    expect(result?.detail).toContain('2 tests failed')
    expect(completed[0]?.result.ok).toBe(false)
    // 结构化失败信息交给 core 解析修复范围（P0-2）。
    expect(completed[0]?.result.kind).toBe('integration')
    expect(completed[0]?.result.command).toBe('pnpm test')
    expect(completed[0]?.result.output).toContain('2 tests failed')
    // 失败时不清理 worktree/branch（保留给负责人排查）。
    const calls = gitLines()
    expect(calls.some((line) => line.startsWith('worktree remove --force'))).toBe(false)
    expect(calls.some((line) => line.startsWith('branch -D'))).toBe(false)
    expect(noteFeature).toHaveBeenCalledWith('dispatch', expect.stringContaining('集成检查点失败'))
  })

  it('合并成功但 worktree 清理失败时降级记录，不删分支也不改变检查点结论', async () => {
    gitMock.runGit.mockImplementation(async (args: string[]) => {
      const line = args.join(' ')
      if (line.startsWith('worktree remove --force') && line.includes('/T1')) {
        return { stdout: '', stderr: 'worktree is locked', exitCode: 128 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const stub = checkpointStub({ tasks: doneTasks })
    const result = await runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1')
    expect(result?.ok).toBe(true)
    const branches = gitLines().filter((line) => line.startsWith('branch -D'))
    // T1 的 worktree 没删掉 → 保留它的分支；T2 正常清理。
    expect(branches).toEqual(['branch -D flowgate-tasks/C-001/T2'])
    expect(stub.noteFeature).toHaveBeenCalledWith('dispatch', expect.stringContaining('worktree 清理失败'))
  })

  it('批次任务未全部完成（有 running/failed）时不做检查点（返回 null，无 git/命令调用）', async () => {
    const stub = checkpointStub({
      tasks: { T1: { status: 'done', worktree: '.flowgate/worktrees/C-001/T1' }, T2: { status: 'running' } },
    })
    const result = await runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1')
    expect(result).toBeNull()
    expect(gitMock.runGit).not.toHaveBeenCalled()
    expect(stub.commandRunner).not.toHaveBeenCalled()
    expect(stub.completed).toHaveLength(0)
  })

  it('completeCheckpoint 抛错时兜底为失败结果并记录降级，不抛到宿主', async () => {
    const stub = checkpointStub({
      tasks: doneTasks,
      completeCheckpoint: async () => {
        throw new Error('ledger broken')
      },
    })
    const result = await runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1')
    expect(result).toEqual({ batchId: 'B1', ok: false, detail: 'ledger broken' })
    expect(stub.noteFeature).toHaveBeenCalledWith('dispatch', expect.stringContaining('集成检查点异常'))
  })

  it('同一批次并发调用只执行一次（子 agent 结算回调去重）', async () => {
    const calls: string[] = []
    const stub = checkpointStub({
      tasks: doneTasks,
      completeCheckpoint: async (id: string) => {
        calls.push(id)
        await new Promise((resolve) => setTimeout(resolve, 10))
      },
    })
    const [first, second] = await Promise.all([
      runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1'),
      runIntegrationCheckpoint(stub.runtime as never, stub.engine as never, 'B1'),
    ])
    expect(first).toEqual(second)
    expect(first?.ok).toBe(true)
    expect(calls).toEqual(['B1'])
  })

  it('批次/根目录/端口缺失时直接跳过（返回 null）', async () => {
    const missingBatch = checkpointStub({ tasks: doneTasks, batches: [] })
    expect(await runIntegrationCheckpoint(missingBatch.runtime as never, missingBatch.engine as never, 'B1')).toBeNull()

    const noRoot = checkpointStub({ tasks: doneTasks, root: null })
    expect(await runIntegrationCheckpoint(noRoot.runtime as never, noRoot.engine as never, 'B1')).toBeNull()

    const noPorts = checkpointStub({ tasks: doneTasks, withPorts: false })
    expect(await runIntegrationCheckpoint(noPorts.runtime as never, noPorts.engine as never, 'B1')).toBeNull()

    const noChange = checkpointStub({ tasks: {}, changeNull: true })
    expect(await runIntegrationCheckpoint(noChange.runtime as never, noChange.engine as never, 'B1')).toBeNull()
    expect(gitMock.runGit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// parallel.max_agents 排队（host 侧契约）
// ---------------------------------------------------------------------------

describe('并行批次并发上限排队（max_agents=2）', () => {
  function makeTaskState(taskId: string): TaskState {
    return { id: taskId, batch: 'B1', status: 'done', tdd: 'none', evidenceIds: [], reviewIds: [], worktree: `.flowgate/worktrees/C-001/${taskId}` }
  }

  async function tempProject(): Promise<string> {
    return await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-parallel-'))
  }

  it('同时只启动 engine 返回的上限内任务，第 3 个在下一轮派发时启动', async () => {
    const projectRoot = await tempProject()
    try {
      const config = defaultFakeConfig() as unknown as FlowgateConfig
      config.review = { enabled: false, requireForTaskGate: false }
      config.parallel = { max_agents: 2, setup: null, hotspots_extra: [] }
      const engine = createFakeEngine({ config }) as unknown as PluginHarness['engine']
      const state = engineState(engine)
      state.current = {
        id: 'C-001',
        kind: 'change',
        title: '测试变更',
        complexity: 'low',
        risk: 'normal',
        stage: 'S4',
        lifecycle: 'active',
        gates: {},
        branch: 'main',
        batches: [{ id: 'B1', mode: 'parallel', status: 'checkpoint', tasks: ['T1', 'T2', 'T3'] }],
        tasks: { T1: makeTaskState('T1'), T2: makeTaskState('T2'), T3: makeTaskState('T3') },
        evidenceIds: [],
        pending: [],
        overrides: [],
        exceptions: [],
        violations: [],
        reviews: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as ChangeStatus
      state.snapshotOverrides = { batches: [{ id: 'B1', mode: 'parallel', status: 'checkpoint', tasks: ['T1', 'T2', 'T3'] }] }
      // 模拟 core engine.dispatchNext 的容量逻辑（max_agents=2）：只返回当前空槽内的任务。
      const queued = ['T1', 'T2', 'T3']
      let running = 0
      let engineDispatchCalls = 0
      engine.dispatchNext = async () => {
        engineDispatchCalls += 1
        const capacity = Math.max(0, 2 - running)
        const start = queued.splice(0, capacity)
        running += start.length
        if (start.length === 0) return { dispatched: [], batchId: 'B1', mode: 'parallel' as const, message: '没有可派发任务（fake）。' }
        return {
          dispatched: start.map((taskId) => ({
            changeId: 'C-001',
            taskId,
            batch: 'B1',
            mode: 'parallel' as const,
            task: { id: taskId, title: `任务${taskId}`, covers: [], scope: ['src/a.ts'], tests: [], newFiles: [], changes: [], dependsOn: [], tdd: 'optional' as const, verify: [], run: 'main' as const, risk: [], size: 'S' as const, body: '' },
            coveredScenarios: [],
            contextExcerpt: '',
            verifyGroups: [],
            tdd: false,
          })),
          batchId: 'B1',
          mode: 'parallel' as const,
          message: `已派发 ${start.join('、')}（并行批次 B1）。`,
        }
      }
      // 子 agent 结果由测试控制，便于观察并发窗口。
      const resolvers = new Map<string, (result: DshSubagentResult) => void>()
      const subagents = createFakeSubagents({
        start: async (spec) => {
          const activation = spec as DshSubagentActivationSpec
          let resolve!: (result: DshSubagentResult) => void
          const result = new Promise<DshSubagentResult>((done) => {
            resolve = done
          })
          resolvers.set(activation.label, resolve)
          return { childId: `child-${activation.label}`, result, dispose: async () => {} }
        },
      })
      const h = await setupPlugin({ engine, services: { subagents }, config: { projectRoot } })
      harness = h
      // 引擎初始化是异步的：显式等待，避免并行跑测试时的计时抖动。
      await h.runtime.waitForEngine()

      const first = await runTool(h, 'flow_dispatch_next', {})
      expect(first.value.ok).toBe(true)
      expect(subagents.state.started).toHaveLength(2)
      expect(runningDispatches().map((item) => item.taskId)).toEqual(['T1', 'T2'])
      expect((first.value.data?.dispatched as { taskId: string }[]).map((item) => item.taskId)).toEqual(['T1', 'T2'])

      // 已有 2 个在跑：再派发会被互斥拦下（第 3 个仍排队，不会超过 max_agents）。
      const blocked = await runTool(h, 'flow_dispatch_next', {})
      expect(blocked.value.ok).toBe(false)
      expect(blocked.value.summary).toContain('上一批任务还在运行')
      expect(engineDispatchCalls).toBe(1)
      expect(subagents.state.started).toHaveLength(2)

      // P1-2：T1 结算释放一个槽位 → 宿主自动补位 T3（无需主会话再次调用 dispatch）。
      running = 1 // fake 容量模拟：T1 结算后 core 侧只剩 1 个 running。
      resolvers.get('flowgate-exec-T1')?.({ output: [], structured: { summary: 'T1 完成' }, stopReason: 'completed' })
      await flush(30)
      expect(engineDispatchCalls).toBeGreaterThanOrEqual(2)
      expect(subagents.state.started).toHaveLength(3)
      expect((subagents.state.started[2] as DshSubagentActivationSpec).label).toBe('flowgate-exec-T3')
      expect(dispatchBusy()).toBe(true) // T2/T3 仍在跑

      // 其余任务结算后收敛。
      resolvers.get('flowgate-exec-T2')?.({ output: [], structured: { summary: 'T2 完成' }, stopReason: 'completed' })
      resolvers.get('flowgate-exec-T3')?.({ output: [], structured: { summary: 'T3 完成' }, stopReason: 'completed' })
      await flush(30)
      expect(dispatchBusy()).toBe(false)
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 检查点失败后的重试路径（P0-3）：宿主在 retryCheckpoint 时重跑检查点
// ---------------------------------------------------------------------------

describe('flow_dispatch_next 重试集成检查点', () => {
  it('dispatchNext 返回 retryCheckpoint 时宿主重跑检查点并返回通过', async () => {
    const projectRoot = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-retry-'))
    try {
      const config = defaultFakeConfig() as unknown as FlowgateConfig
      config.review = { enabled: false, requireForTaskGate: false }
      config.commands = {}
      const engine = createFakeEngine({ config }) as unknown as PluginHarness['engine']
      const state = engineState(engine)
      const task = (id: string): TaskState => ({
        id,
        batch: 'B1',
        status: 'done',
        tdd: 'none',
        evidenceIds: [],
        reviewIds: [],
        worktree: `.flowgate/worktrees/C-001/${id}`,
      })
      state.current = {
        id: 'C-001',
        kind: 'change',
        title: '重试检查点',
        complexity: 'low',
        risk: 'normal',
        stage: 'S4',
        lifecycle: 'active',
        gates: {},
        branch: 'main',
        batches: [{ id: 'B1', mode: 'parallel', status: 'checkpoint', tasks: ['T1', 'T2'] }],
        tasks: { T1: task('T1'), T2: task('T2') },
        evidenceIds: [],
        pending: [],
        overrides: [],
        exceptions: [],
        violations: [],
        reviews: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as ChangeStatus
      state.snapshotOverrides = { batches: [{ id: 'B1', mode: 'parallel', status: 'checkpoint', tasks: ['T1', 'T2'] }] }
      const checkpointCalls: { id: string; result: { ok: boolean } }[] = []
      type CheckpointResult = {
        ok: boolean
        detail?: string
        kind?: 'merge' | 'integration' | 'unknown'
        output?: string
        command?: string
      }
      engine.completeCheckpoint = async (id: string, result: CheckpointResult) => {
        checkpointCalls.push({ id, result })
      }
      engine.dispatchNext = async () => ({
        dispatched: [],
        batchId: 'B1',
        mode: 'parallel' as const,
        message: '批次 B1 的集成检查点待重试。',
        retryCheckpoint: { batchId: 'B1', attempts: 1 },
      })
      const subagents = createFakeSubagents({ start: vi.fn() })
      const h = await setupPlugin({ engine, services: { subagents }, config: { projectRoot } })
      harness = h
      await h.runtime.waitForEngine()

      const result = await runTool(h, 'flow_dispatch_next', {})
      expect(result.value.ok).toBe(true)
      expect(result.value.summary).toContain('集成检查点：批次 B1 通过')
      expect(result.value.data?.checkpoint).toBe('passed')
      expect(checkpointCalls).toEqual([{ id: 'B1', result: { ok: true } }])
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// run: main 任务（P0-1）：交给主会话领取，不启动子 agent
// ---------------------------------------------------------------------------

describe('flow_dispatch_next 的 run: main 任务', () => {
  it('mainTasks 交给主会话 flow_task_start，不启动执行者子 agent', async () => {
    const projectRoot = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-run-main-'))
    try {
      const config = defaultFakeConfig() as unknown as FlowgateConfig
      config.review = { enabled: false, requireForTaskGate: false }
      const engine = createFakeEngine({ config }) as unknown as PluginHarness['engine']
      engine.dispatchNext = async () => ({
        dispatched: [],
        batchId: 'B1',
        mode: 'sequential' as const,
        mainTasks: [{ taskId: 'T1', batch: 'B1', mode: 'sequential' as const }],
        message: '批次 B1 的下一个任务 T1 标记 run: main，请主会话用 flow_task_start("T1") 执行。',
      })
      const subagents = createFakeSubagents({ start: vi.fn() })
      const h = await setupPlugin({ engine, services: { subagents }, config: { projectRoot } })
      harness = h
      await h.runtime.waitForEngine()

      const result = await runTool(h, 'flow_dispatch_next', {})
      expect(result.value.ok).toBe(true)
      expect(result.value.summary).toContain('flow_task_start("T1")')
      expect((result.value.data?.mainTasks as unknown[]).length).toBe(1)
      expect(subagents.state.started).toHaveLength(0)
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('宿主没有子 agent 能力时，纯 run:main 任务仍可派发（不提前失败）', async () => {
    const projectRoot = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-run-main-nocap-'))
    try {
      const config = defaultFakeConfig() as unknown as FlowgateConfig
      config.review = { enabled: false, requireForTaskGate: false }
      const engine = createFakeEngine({ config }) as unknown as PluginHarness['engine']
      engine.dispatchNext = async () => ({
        dispatched: [],
        batchId: 'B1',
        mode: 'sequential' as const,
        mainTasks: [{ taskId: 'T1', batch: 'B1', mode: 'sequential' as const }],
        message: '批次 B1 的下一个任务 T1 标记 run: main。',
      })
      const h = await setupPlugin({ engine, services: { subagents: undefined }, config: { projectRoot } })
      harness = h
      await h.runtime.waitForEngine()
      const result = await runTool(h, 'flow_dispatch_next', {})
      expect(result.value.ok).toBe(true)
      expect(result.value.summary).toContain('flow_task_start("T1")')
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// 全链路测试用的公共小工具（与 dispatch.test.ts 同形）
// ---------------------------------------------------------------------------

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
