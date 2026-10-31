/**
 * 故障注入（M6 / T6.2，03 §14）：状态损坏、守卫抛错、宿主服务缺失、配置损坏。
 *
 * 目标不是重复单测细节，而是从"宿主/引擎入口"验证：每种故障下插件要么正常启动，
 * 要么按 fail-closed / 锁定模式给出可解释结果，绝不静默放行或让宿主崩溃。
 *
 * 本轮（2026-10-31 T6.2 复验）扩充 3 例，覆盖此前未覆盖的故障类别：
 * - `changes/<id>/status.json` 内容被截断（非法 JSON）→ 宿主插件仍能启动、修复路径可用；
 * - `state/ledger.jsonl` 末行被截断（JSON 损坏，而非签名被篡改）→ 锁定 + doctor 报行号 + repair 拒绝；
 * - `config.yaml` 语义非法（未知 complexity）→ ConfigError 带路径/字段，宿主启动不受影响、写操作 fail-closed。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, FlowgateConfig } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../../src/core/store/config'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'
import { flush, setupPlugin, type PluginHarness } from '../host/helpers'
import { activeHostRuntime, apply, resetHostPluginForTest } from '../../src/host/index'
import { createFakeContext } from '../../src/host/testing/fake-ctx'
import { executeFlowCommand } from '../../src/host/commands/index'
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

/** 在同一个内存文件系统上新建引擎（模拟"宿主重启后重新加载"）。 */
function makeReloadedEngine(h: EngineHarness, sessionId: string): FlowEngine {
  return new FlowEngine({
    root: ROOT,
    fs: h.fs,
    clock: h.clock,
    git: h.git,
    commandRunner: h.runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'fault-injection-ledger-key',
    sessionId,
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

describe('故障注入：状态文件损坏（status.json 被截断为非法 JSON）', () => {
  it('宿主插件仍能启动、/flow doctor 可读，/flow repair 从账本快照重建状态', async () => {
    const h = makeEngineHarness()
    await h.engine.init()
    const created = await h.engine.newChange({ title: '状态损坏演练', summary: '验证 repair 能从账本恢复' })
    const statusPath = `.flowgate/changes/${created.changeId}/status.json`
    const rawStatus = await h.fs.readFile(statusPath)
    // 模拟磁盘写到一半崩溃：把 status.json 截断成非法 JSON。
    await h.fs.writeFile(statusPath, rawStatus.slice(0, Math.max(10, Math.floor(rawStatus.length / 2))))

    // 宿主插件启动路径（startHostPlugin → runtime.ensureEngine → engine.load）不抛错。
    const realEngine = makeReloadedEngine(h, 'session-fault-injection-status')
    harness = await setupPlugin({ engine: realEngine })
    expect(harness.runtime.engine()).toBe(realEngine)
    expect(realEngine.snapshot().initialized).toBe(true)
    // 03 §14：状态文件损坏不能被静默跳过（否则阶段门禁会 fail-open）。
    // 加载后必须锁定、doctor 指出损坏文件与修复路径，repair 从账本快照重建后解锁。
    expect(realEngine.snapshot().locked).toBe(true)
    expect(realEngine.allChanges()).toHaveLength(0)

    const doctorText = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(doctorText).toContain('FlowGate 自检')
    expect(doctorText).toContain('初始化：是')
    expect(doctorText).toContain('账本：完整')
    expect(doctorText).toContain('配置：正常')
    expect(doctorText).not.toContain('引擎：未就绪')
    expect(doctorText).toContain('状态文件损坏')
    expect(doctorText).toContain(statusPath)
    expect(doctorText).toContain('/flow repair')

    const repairText = await executeFlowCommand(harness.runtime, 'repair', harness.agent)
    expect(repairText).toContain('修复完成')
    expect(repairText).toContain('重建 1 个变更')
    const restored = JSON.parse(await h.fs.readFile(statusPath)) as { id: string; title: string }
    expect(restored.id).toBe(created.changeId)
    expect(restored.title).toBe('状态损坏演练')
    expect(realEngine.allChanges().map((change) => change.id)).toContain(created.changeId)
    // repair 后锁定解除（写操作恢复正常）。
    expect(realEngine.snapshot().locked).toBe(false)
    // 台账 index.md 也随修复重建。
    expect(await h.fs.exists('.flowgate/changes/index.md')).toBe(true)
  })
})

describe('故障注入：账本行被截断（JSON 损坏，非签名篡改）', () => {
  it('加载进入锁定模式，doctor 报出损坏行号，写操作被拒绝，repair 拒绝在坏账本上重建', async () => {
    const h = makeEngineHarness()
    await h.engine.init()
    await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const ledgerPath = '.flowgate/state/ledger.jsonl'
    const lines = (await h.fs.readFile(ledgerPath)).split('\n').filter((line) => line.length > 0)
    const lastLine = lines[lines.length - 1]!
    // 只截断字节（不篡改签名）：末行变成非法 JSON，哈希链无后续行可断。
    const truncated = lastLine.slice(0, Math.max(8, Math.floor(lastLine.length / 2)))
    await h.fs.writeFile(ledgerPath, `${[...lines.slice(0, -1), truncated].join('\n')}\n`)

    const reloaded = makeReloadedEngine(h, 'session-fault-injection-truncated')
    await reloaded.load() // 不抛错：账本损坏不能把宿主带崩
    expect(reloaded.snapshot().initialized).toBe(true)
    expect(reloaded.snapshot().locked).toBe(true)

    const doctor = await reloaded.doctor()
    expect(doctor.ledgerOk).toBe(false)
    expect(doctor.ledgerFailures).toHaveLength(1)
    expect(doctor.ledgerFailures[0]?.line).toBe(lines.length)
    expect(doctor.ledgerFailures[0]?.reason).toContain('不是合法的账本事件 JSON')
    expect(doctor.configOk).toBe(true)
    expect(doctor.message).toContain('锁定模式')

    // 门禁内写入被拒绝且原因可见（host 守卫消费的就是这个判定）。
    const decision = await reloaded.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(decision.effect).toBe('deny')
    expect(decision.message).toContain('R-LOCKED')
    await expect(reloaded.newChange({ title: '趁锁立项', summary: '应被拒绝' })).rejects.toThrow('锁定模式')

    // repair 不静默重写/截断坏账本：明确失败并报出行号。
    const repaired = await reloaded.repair()
    expect(repaired.ok).toBe(false)
    expect(repaired.message).toContain('账本校验失败')
    expect(repaired.message).toContain(`第 ${lines.length} 行`)
    expect(await h.fs.readFile(ledgerPath)).toContain(truncated)
  })
})

describe('故障注入：配置语义非法（未知 complexity 值）', () => {
  it('ConfigError 带路径与字段名；宿主插件仍启动，锁定并 fail-closed，doctor 报出配置错误与修复入口', async () => {
    const h = makeEngineHarness()
    await h.engine.init()
    await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    // YAML 语法合法但语义非法：未知复杂度档位。
    await h.fs.writeFile('.flowgate/config.yaml', 'levels:\n  complexity: impossible\n')

    await expect(loadConfig(h.fs, ROOT)).rejects.toBeInstanceOf(ConfigError)
    const configError = (await loadConfig(h.fs, ROOT).catch((error: unknown) => error)) as ConfigError
    expect(configError).toBeInstanceOf(ConfigError)
    expect(configError.path).toBe('.flowgate/config.yaml')
    expect(configError.message).toContain('levels.complexity')
    // 语义错误给字段路径（没有行号可指），语法错误才带行号（见上一组用例）。
    expect(configError.line).toBeUndefined()

    // 宿主插件启动路径不抛错：engine.load() 内部把配置错误降级为默认配置 + 锁定。
    const realEngine = makeReloadedEngine(h, 'session-fault-injection-config')
    harness = await setupPlugin({ engine: realEngine })
    expect(harness.runtime.engine()).toBe(realEngine)
    expect(realEngine.snapshot().initialized).toBe(true)
    expect(realEngine.snapshot().locked).toBe(true)
    // 降级口径：坏配置不生效，运行期用默认配置（不被非法值带偏）。
    expect(realEngine.getConfig().levels.complexity).toBe(DEFAULT_CONFIG.levels.complexity)

    const doctor = await realEngine.doctor()
    expect(doctor.configOk).toBe(false)
    expect(doctor.configError).toContain('levels.complexity')
    expect(doctor.ledgerOk).toBe(true)
    expect(doctor.message).toContain('锁定模式')
    expect(doctor.message).toContain('配置文件损坏')

    // 门禁内写入 fail-closed。
    const decision = await realEngine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(decision.effect).toBe('deny')
    expect(decision.message).toContain('R-LOCKED')

    const doctorText = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(doctorText).toContain('FlowGate 自检')
    expect(doctorText).toContain('配置：错误')
    expect(doctorText).toContain('levels.complexity')
    expect(doctorText).toContain('/flow repair')
  })
})

describe('故障注入：会话租约文件损坏（sessions.json 被截断）', () => {
  it('宿主仍能启动、engine 锁定而非 fail-open；doctor 可见，/flow repair 重建租约并解锁', async () => {
    const h = makeEngineHarness()
    await h.engine.init()
    const created = await h.engine.newChange({ title: '租约损坏演练', summary: '验证 sessions.json 损坏 fail-closed' })
    const sessionsPath = '.flowgate/state/sessions.json'
    const rawSessions = await h.fs.readFile(sessionsPath)
    // 模拟磁盘写到一半崩溃：租约文件截断成非法 JSON。
    await h.fs.writeFile(sessionsPath, rawSessions.slice(0, Math.max(5, Math.floor(rawSessions.length / 2))))

    // 关键回归：此前 readLeases 抛错会让 engine.load 失败 → 宿主 markInert → 守卫放行（fail-open）。
    const realEngine = makeReloadedEngine(h, 'session-fault-injection-lease')
    harness = await setupPlugin({ engine: realEngine })
    expect(harness.runtime.engine()).toBe(realEngine)
    expect(harness.runtime.inertReasons.some((reason) => reason.stage.includes('引擎'))).toBe(false)
    expect(realEngine.snapshot().initialized).toBe(true)
    expect(realEngine.snapshot().locked).toBe(true)
    // 变更本身仍能加载（损坏只在租约文件，不该丢变更）。
    expect(realEngine.allChanges().map((change) => change.id)).toContain(created.changeId)

    // 损坏状态下显式接续/恢复要明确失败，不能"假成功"返回空 current。
    await expect(realEngine.attachSession()).rejects.toThrow('状态文件损坏')
    await expect(realEngine.resumeChange(created.changeId)).rejects.toThrow('状态文件损坏')

    // 门禁内写入 fail-closed，而不是"engine 未就绪 → 放行"。
    const decision = await realEngine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(decision.effect).toBe('deny')
    expect(decision.message).toContain('R-LOCKED')

    const doctor = await realEngine.doctor()
    expect(doctor.ledgerOk).toBe(true)
    expect(doctor.message).toContain('锁定模式')
    expect(doctor.message).toContain('sessions.json')
    expect(doctor.message).toContain('/flow repair')

    // /flow repair 可用（不再因 engine inert 而报"引擎未就绪"），重建租约后解锁。
    const repairText = await executeFlowCommand(harness.runtime, 'repair', harness.agent)
    expect(repairText).toContain('修复完成')
    expect(repairText).toContain('会话租约')
    expect(realEngine.snapshot().locked).toBe(false)
    const repaired = JSON.parse(await h.fs.readFile(sessionsPath)) as { version?: number; leases?: unknown[] }
    expect(Array.isArray(repaired.leases)).toBe(true)
    // 解锁后可以正常接续。
    await expect(realEngine.attachSession()).resolves.toBeTruthy()
    // 解锁后写判定恢复正常（不再被 R-LOCKED 拦截）。
    const afterRepair = await realEngine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(afterRepair.message).not.toContain('R-LOCKED')
  })
})

// ---------------------------------------------------------------------------
// 故障注入：浏览器包缺失（T6.2 第四类）
// ---------------------------------------------------------------------------
describe('浏览器包缺失', () => {
  it('host 入口不依赖 client 产物：浏览器 bundle 缺失时宿主插件的加载路径不变', async () => {
    const { readFileSync } = await import('node:fs')
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      main?: string
      exports?: Record<string, string>
    }
    // host 入口是 lib/host.js；client 产物只通过 exports["./client"] 暴露，
    // 由 DSH Web shell 加载——浏览器包缺失不会让 host 插件 import 失败。
    expect(pkg.main).toBe('./lib/host.js')
    expect(pkg.exports?.['./client']).toBe('./lib/client.js')
    const hostEntry = readFileSync('src/host/index.ts', 'utf8')
    expect(hostEntry).not.toContain('./client')
    expect(hostEntry).not.toContain('../client')
  })
})
