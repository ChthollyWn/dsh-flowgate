/**
 * 故障注入（M6 / T6.2，03 §14）：状态损坏、守卫抛错、宿主服务缺失、配置损坏。
 *
 * 目标不是重复单测细节，而是从"宿主/引擎入口"验证：每种故障下插件要么正常启动，
 * 要么按 fail-closed / 锁定模式给出可解释结果，绝不静默放行或让宿主崩溃。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, FlowgateConfig } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { ConfigError, loadConfig } from '../../src/core/store/config'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'
import { flush, setupPlugin, type PluginHarness } from '../host/helpers'
import { activeHostRuntime, apply, resetHostPluginForTest } from '../../src/host/index'
import { createFakeContext } from '../../src/host/testing/fake-ctx'
import type { DshToolExecution } from '../../src/host/adapters/dsh-types'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface EngineHarness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

function makeEngineHarness(): EngineHarness {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  fs.writeFile('README.md', '# demo\n')
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner(
    [
      { match: 'vitest', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY },
      { match: 'pnpm test', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY },
    ],
    clock,
  )
  const engine = new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'fault-injection-ledger-key',
    sessionId: 'session-fault-injection',
  })
  return { fs, clock, git, runner, engine }
}

let harness: PluginHarness | null = null
afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

async function runPreExecute(h: PluginHarness, exec: DshToolExecution): Promise<unknown> {
  return await h.ctx.runWaterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
}

describe('故障注入：状态损坏（账本被篡改）', () => {
  it('加载进入锁定模式、写操作被拒绝，repair 拒绝在坏账本上自动重建', async () => {
    const h = makeEngineHarness()
    await h.engine.init()
    await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const ledgerPath = '.flowgate/state/ledger.jsonl'
    const lines = (await h.fs.readFile(ledgerPath)).split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    const tampered = [...lines]
    const parsed = JSON.parse(tampered[1]!) as { data: Record<string, unknown> }
    parsed.data.title = 'tampered'
    tampered[1] = JSON.stringify(parsed)
    await h.fs.writeFile(ledgerPath, `${tampered.join('\n')}\n`)

    const reloaded = new FlowEngine({
      root: ROOT,
      fs: h.fs,
      clock: h.clock,
      git: h.git,
      commandRunner: h.runner,
      pluginVersion: '0.1.0',
      ledgerKey: 'fault-injection-ledger-key',
      sessionId: 'session-fault-injection-2',
      host: { gateChecker: ALL_PASS },
    })
    await reloaded.load()
    expect(reloaded.snapshot().locked).toBe(true)
    const decision = await reloaded.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(decision.effect).toBe('deny')
    expect(decision.message).toContain('R-LOCKED')
    expect(decision.message).toContain('锁定')

    const repaired = await reloaded.repair()
    expect(repaired.ok).toBe(false)
    expect(repaired.message).toContain('无法自动修复')
    // 坏账本不会被静默截断/覆盖。
    const after = (await h.fs.readFile(ledgerPath)).split('\n').filter((line) => line.length > 0)
    expect(after[1]).toBe(tampered[1])
  })
})

describe('故障注入：守卫判定抛错', () => {
  it('fail-closed 拒绝本次写操作并标记降级原因，不把异常抛给宿主', async () => {
    harness = await setupPlugin()
    const state = harness.engine as unknown as { state: { evaluateActionError?: Error } }
    state.state.evaluateActionError = new Error('engine boom')
    const exec = {
      name: 'write',
      arguments: { file_path: 'src/a.ts' },
      callId: 'fault-guard-throw',
      agent: harness.agent,
    } as unknown as DshToolExecution
    const result = (await runPreExecute(harness, exec)) as { kind: string; reason: string }
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('失败关闭')
    expect(harness.runtime.inertReasons.some((reason) => reason.stage === '守卫判定')).toBe(true)
  })
})

describe('故障注入：宿主服务缺失', () => {
  it('没有 tools/commands/projection 等服务时 apply 不抛错，能力降级为 inert', async () => {
    const projectRoot = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-fault-home-'))
    try {
      const ctx = createFakeContext({ services: {}, available: [] })
      expect(() =>
        apply(ctx, {
          enabled: true,
          projectRoot,
          ledgerKeyPath: nodePath.join(projectRoot, 'ledger.key'),
        }),
      ).not.toThrow()
      const runtime = activeHostRuntime()
      expect(runtime).not.toBeNull()
      expect(runtime?.capabilitySnapshot().tools).toBe(false)
      expect(runtime?.capabilitySnapshot().commands).toBe(false)
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('故障注入：配置文件损坏', () => {
  it('返回带路径与行号的 ConfigError，不静默回退默认配置', async () => {
    const fs = new MemoryFileSystem()
    fs.writeFile('.flowgate/config.yaml', 'levels:\n  complexity: [oops\n  risk: normal\n')
    await expect(loadConfig(fs, ROOT)).rejects.toBeInstanceOf(ConfigError)
    await expect(loadConfig(fs, ROOT)).rejects.toThrow(/config\.yaml/)
    await expect(loadConfig(fs, ROOT)).rejects.toThrow(/第 \d+ 行/)
  })
})
