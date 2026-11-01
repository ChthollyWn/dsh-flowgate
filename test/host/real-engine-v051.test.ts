/**
 * 宿主 + 真实引擎的集成链路（v0.5.1 新增能力的宿主面验收）：
 *
 * 1. **项目级暂停（/flow off 无变更）**：core 写 flags.off，host guard 不得因为
 *    `snapshot.off === true` 就整体短路——`.flowgate/**` 写入仍必须被 R-PROTECTED
 *    拒绝（否则 agent 能自己解除暂停/改账本），普通文件写入放行；/flow on 恢复。
 * 2. **修复通道（flow_fix_start / `/flow fix` / `/flow fix abort`）**：真实引擎
 *    返回 FIX-id、快照带 red/green 进度、host 命令可查看与中止。
 *
 * 这些用例走真实 FlowEngine + MemoryFileSystem（fake 引擎测试无法验证 core 判定
 * 与 host 边界的语义是否拼得起来）。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, FlowgateConfig } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { resetHostPluginForTest } from '../../src/host/index'
import { executeFlowCommand } from '../../src/host/commands/index'
import type { DshToolExecution } from '../../src/host/adapters/dsh-types'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'
import { setupPlugin, type PluginHarness } from './helpers'

const ALL_PASS = async (): Promise<CheckOutcome[]> => []
const ROOT = ''

interface RealHarness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
}

function makeRealHarness(): RealHarness {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  fs.writeFile('README.md', '# demo\n')
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner(
    [{ match: 'pnpm test', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY }],
    clock,
  )
  return { fs, clock, git, runner }
}

function makeRealEngine(h: RealHarness, sessionId: string, takeover?: 'enforce' | 'observe' | 'off'): FlowEngine {
  return new FlowEngine({
    root: ROOT,
    fs: h.fs,
    clock: h.clock,
    git: h.git,
    commandRunner: h.runner,
    pluginVersion: '0.1.0-test',
    ledgerKey: 'host-real-engine-key',
    sessionId,
    ...(takeover !== undefined ? { takeover } : {}),
    host: { gateChecker: ALL_PASS },
  })
}

let harness: PluginHarness | null = null
afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

/** 构造已初始化、无进行中变更的真实引擎 + 已加载的宿主插件。 */
async function setupRealPlugin(
  config?: import('../../src/host/types.js').HostConfig,
): Promise<{ h: RealHarness; engine: FlowEngine; harness: PluginHarness }> {
  const h = makeRealHarness()
  const seed = makeRealEngine(h, 'session-seed')
  await seed.init()
  // fake deps 直接返回预构造引擎：engine 的 takeover 必须与 host 配置一致，
  // 才能模拟真实宿主（runtime 会把 takeover 传给 deps.createEngine）。
  const engine = makeRealEngine(h, 'session-real', config?.takeover)
  const plugin = await setupPlugin({ engine, ...(config !== undefined ? { config } : {}) })
  expect(engine.isInitialized()).toBe(true)
  expect(engine.currentChange()).toBeNull()
  return { h, engine, harness: plugin }
}

function makeExec(name: string, args: Record<string, unknown>, callId: string, agent: unknown): DshToolExecution {
  return { name, arguments: args, callId, agent, signal: new AbortController().signal } as unknown as DshToolExecution
}

async function runPreExecute(h: PluginHarness, exec: DshToolExecution): Promise<unknown> {
  return await h.ctx.runWaterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
}

async function runTool(h: PluginHarness, name: string, args: Record<string, unknown>) {
  const tool = h.tools.state.tools.get(name)
  if (!tool) throw new Error(`tool ${name} 未注册`)
  return (await tool.execute(args, {
    callId: `call-${name}`,
    name,
    arguments: args,
    agent: h.agent,
    signal: new AbortController().signal,
  } as never)) as { ok: boolean; summary: string; data?: Record<string, unknown> }
}

describe('项目级暂停（真实引擎 + host guard）', () => {
  it('/flow off 无变更 → 项目级暂停；.flowgate 写入仍被 R-PROTECTED 拒绝，普通写入放行；/flow on 恢复', async () => {
    const setup = await setupRealPlugin()
    harness = setup.harness
    const { engine } = setup

    const text = await executeFlowCommand(harness.runtime, 'off 维护窗口', harness.agent)
    expect(text).toContain('项目门禁已暂停（项目级）')
    expect(engine.snapshot().off).toBe(true)
    expect(engine.snapshot().offBy).toBe('human')
    expect(engine.currentChange()).toBeNull()

    // 普通文件写入：暂停期间放行（engine.evaluateAction → allow）。
    const srcResult = (await runPreExecute(
      harness,
      makeExec('write', { file_path: 'src/index.ts' }, 'call-off-src', harness.agent),
    )) as { kind: string; reason?: string }
    expect(srcResult.kind).toBe('allow')

    // 账本/状态写入：即使项目级暂停也必须 R-PROTECTED 拒绝（agent 不能自解暂停）。
    const gateResult = (await runPreExecute(
      harness,
      makeExec('write', { file_path: '.flowgate/state/flags.json' }, 'call-off-gate', harness.agent),
    )) as { kind: string; reason?: string }
    expect(gateResult.kind).toBe('deny')
    expect(gateResult.reason).toContain('R-PROTECTED')

    // /flow on：恢复项目级门禁。
    const onText = await executeFlowCommand(harness.runtime, 'on', harness.agent)
    expect(onText).toContain('项目门禁已恢复（项目级）')
    expect(engine.snapshot().off).toBe(false)
  })

  it('agent 自暂停（flow_self_pause）→ 项目级 off + 事故；/flow on 恢复；flow_incident_close 补审计', async () => {
    const setup = await setupRealPlugin()
    harness = setup.harness
    const { engine } = setup

    const paused = await runTool(harness, 'flow_self_pause', { reason: '环境不可用，需要负责人介入', severity: 'P1' })
    expect(paused.ok).toBe(true)
    expect(String(paused.summary)).toContain('不能自行恢复')
    const incidentId = String((paused.data?.incident as Record<string, unknown>).id)
    expect(incidentId).toMatch(/^INC-/)
    expect(engine.snapshot().off).toBe(true)
    expect(engine.snapshot().offBy).toBe('agent')
    expect(engine.getProjectFlags().incident?.id).toBe(incidentId)

    const incidentText = await executeFlowCommand(harness.runtime, 'incident', harness.agent)
    expect(incidentText).toContain(incidentId)
    expect(incidentText).toContain('环境不可用')

    // 负责人 /flow on 恢复门禁（事故仍未关闭，需要补审计）。
    const onText = await executeFlowCommand(harness.runtime, 'on', harness.agent)
    expect(onText).toContain('仍未关闭')
    expect(engine.snapshot().off).toBe(false)

    const closed = await runTool(harness, 'flow_incident_close', {
      summary: '环境恢复，重跑通过',
      tests: 'pnpm test',
      files: ['src/index.ts'],
    })
    expect(closed.ok).toBe(true)
    expect(engine.getProjectFlags().incident).toBeUndefined()
    expect(engine.snapshot().incident).toBeUndefined()
  })
})

describe('takeover=observe（真实引擎 + host guard）', () => {
  it('只放宽未立项写入（R-NO-CHANGE）：普通写入放行，但 .flowgate 受保护写入仍拦截', async () => {
    const setup = await setupRealPlugin({ takeover: 'observe' })
    harness = setup.harness
    expect(harness.runtime.enforcement()).toBe('observe')

    // 无变更 + observe：core 对普通写入返回 allow 并记 takeover.observed → host 放行。
    const srcResult = (await runPreExecute(
      harness,
      makeExec('write', { file_path: 'src/index.ts' }, 'call-observe-src', harness.agent),
    )) as { kind: string; reason?: string }
    expect(srcResult.kind).toBe('allow')

    // observe 不是全放行：受保护路径（账本/状态）仍是 R-PROTECTED deny。
    const protectedResult = (await runPreExecute(
      harness,
      makeExec('write', { file_path: '.flowgate/state/ledger.jsonl' }, 'call-observe-protected', harness.agent),
    )) as { kind: string; reason?: string }
    expect(protectedResult.kind).toBe('deny')
    expect(protectedResult.reason).toContain('R-PROTECTED')

    // 同步守卫同样按缓存判定（deny 就 deny）。
    const guard = harness.tools.state.guards[0] as ((exec: DshToolExecution) => string | undefined) | undefined
    const syncReason = guard?.(makeExec('write', { file_path: '.flowgate/state/ledger.jsonl' }, 'call-observe-protected', harness.agent))
    expect(syncReason).toContain('R-PROTECTED')
  })
})

describe('修复通道（真实引擎 + host 工具/命令）', () => {
  it('flow_fix_start → /flow fix 查看 → /flow fix abort（真实引擎状态流转）', async () => {
    const setup = await setupRealPlugin()
    harness = setup.harness
    const { engine } = setup

    const started = await runTool(harness, 'flow_fix_start', {
      title: '修复新建会话失败',
      symptom: '新建会话报 not lossless JSON',
      repro: 'POST /api/session/create',
      scope: ['src/host/**'],
      verify: 'pnpm test',
      acceptance: ['新建会话成功'],
      severity: 'P1',
    })
    expect(started.ok).toBe(true)
    const id = String(started.data?.id)
    expect(id).toMatch(/^FIX-/)
    expect(engine.getRepair()).toMatchObject({ id, status: 'open', title: '修复新建会话失败' })
    expect(engine.snapshot().repair).toMatchObject({ id, red: false, green: false })

    const statusText = await executeFlowCommand(harness.runtime, 'fix', harness.agent)
    expect(statusText).toContain(id)
    expect(statusText).toContain('src/host/**')
    expect(statusText).toContain('先取 RED')

    const statusCommandText = await executeFlowCommand(harness.runtime, 'status', harness.agent)
    expect(statusCommandText).toContain(`修复通道：${id}`)

    const aborted = await executeFlowCommand(harness.runtime, 'fix abort 演练结束，改走正式变更', harness.agent)
    expect(aborted).toContain(`已放弃修复 ${id}`)
    expect(engine.getRepair()).toBeNull()
    expect(engine.snapshot().repair).toBeUndefined()
  })

  it('修复通道不允许与进行中变更并存（engine 抛错 → 工具返回 {error,hint}）', async () => {
    const setup = await setupRealPlugin()
    harness = setup.harness
    const { engine } = setup
    await engine.newChange({ title: '进行中变更', summary: '用于验证修复通道前置条件' })
    const started = await runTool(harness, 'flow_fix_start', {
      title: '修 bug',
      symptom: 'x',
      scope: ['src/a.ts'],
      verify: 'pnpm test',
    })
    expect(started.ok).toBe(false)
    expect(String(started.data?.error)).toContain('已有进行中的变更')
    // v0.7 智能准入：已有变更时推荐变更内返工，而不是再开修复车道。
    expect(String(started.data?.hint)).toContain('flow_declare_rework')
  })
})
