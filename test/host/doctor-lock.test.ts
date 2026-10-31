/**
 * /flow doctor 的锁定可见性（03 §14 / 02 需求 v1.0）：
 * `formatDoctorReport` 必须渲染 `engine.doctor().message`，让「状态文件损坏 → 锁定」
 * 的原因、损坏文件路径与 `/flow repair` 修复入口在 /flow doctor 文本里可见。
 *
 * 覆盖两层：
 * - 假引擎：`formatDoctorReport` 的渲染契约（message 落到输出）；
 * - 真实引擎 + 内存 FS：status.json 损坏 → 宿主启动仍可就绪 → doctor 可读锁定原因 →
 *   `/flow repair` 重建后解锁、doctor 恢复正常。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, DoctorReport } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { resetHostPluginForTest } from '../../src/host/index'
import { executeFlowCommand } from '../../src/host/commands/index'
import { createFakeEngine } from '../../src/host/testing/fake-ctx'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'
import { setupPlugin, type PluginHarness } from './helpers'

const LOCK_REASON =
  '锁定模式：状态文件损坏（1 个）：.flowgate/changes/C-001/status.json（非法 JSON）。运行 /flow doctor 诊断，/flow repair 从账本重建。'
const ALL_PASS = async (): Promise<CheckOutcome[]> => []
const ROOT = ''

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

describe('formatDoctorReport — 锁定原因可见', () => {
  it('渲染 engine.doctor().message（含损坏文件路径与 /flow repair 入口）', async () => {
    const engine = createFakeEngine() as unknown as FlowEngine
    engine.doctor = async (): Promise<DoctorReport> => ({
      initialized: true,
      pluginVersion: '0.1.0-test',
      ledgerOk: true,
      ledgerFailures: [],
      configOk: true,
      stage: undefined,
      activeTasks: [],
      openPending: 0,
      guardHeartbeat: { toolCalls: 3, decisions: 1 },
      hostCapabilities: {},
      message: LOCK_REASON,
    })
    harness = await setupPlugin({ engine })

    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('FlowGate 自检')
    expect(text).toContain(`引擎状态：${LOCK_REASON}`)
    expect(text).toContain('锁定模式')
    expect(text).toContain('.flowgate/changes/C-001/status.json')
    expect(text).toContain('/flow repair')
  })

  it('健康状态也渲染 engine.doctor().message（锁定线索不丢）', async () => {
    const engine = createFakeEngine() as unknown as FlowEngine
    engine.doctor = async (): Promise<DoctorReport> => ({
      initialized: true,
      pluginVersion: '0.1.0-test',
      ledgerOk: true,
      ledgerFailures: [],
      configOk: true,
      activeTasks: [],
      openPending: 0,
      guardHeartbeat: { toolCalls: 0, decisions: 0 },
      hostCapabilities: {},
      message: 'FlowGate 运行正常。',
    })
    harness = await setupPlugin({ engine })
    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('引擎状态：FlowGate 运行正常。')
  })
})

// ---------------------------------------------------------------------------
// 真实引擎：损坏 → 宿主启动 → /flow doctor 可见 → /flow repair 解锁
// ---------------------------------------------------------------------------

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

function makeRealEngine(h: RealHarness, sessionId: string): FlowEngine {
  return new FlowEngine({
    root: ROOT,
    fs: h.fs,
    clock: h.clock,
    git: h.git,
    commandRunner: h.runner,
    pluginVersion: '0.1.0-test',
    ledgerKey: 'doctor-lock-key',
    sessionId,
    host: { gateChecker: ALL_PASS },
  })
}

describe('/flow doctor + /flow repair — 真实引擎状态损坏链路', () => {
  it('doctor 看到锁定原因；repair 后解锁且 doctor 恢复正常', async () => {
    const h = makeRealHarness()
    const seed = makeRealEngine(h, 'session-doctor-lock-seed')
    await seed.init()
    const created = await seed.newChange({ title: '状态损坏演练', summary: '验证 doctor 锁定可见' })
    const statusPath = `.flowgate/changes/${created.changeId}/status.json`
    const raw = await h.fs.readFile(statusPath)
    await h.fs.writeFile(statusPath, raw.slice(0, Math.max(10, Math.floor(raw.length / 2))))

    // 宿主启动路径（startHostPlugin → runtime.ensureEngine → engine.load）不抛错。
    const engine = makeRealEngine(h, 'session-doctor-lock')
    harness = await setupPlugin({ engine })
    expect(harness.runtime.engine()).toBe(engine)
    expect(engine.snapshot().initialized).toBe(true)
    expect(engine.snapshot().locked).toBe(true)

    const doctorText = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(doctorText).toContain('FlowGate 自检')
    expect(doctorText).toContain('初始化：是')
    expect(doctorText).toContain('账本：完整')
    expect(doctorText).toContain('引擎状态：锁定模式：状态文件损坏')
    expect(doctorText).toContain(statusPath)
    expect(doctorText).toContain('/flow repair')
    expect(doctorText).not.toContain('引擎状态：FlowGate 运行正常。')

    // 日常 /flow status 也不丢锁定原因。
    const statusText = await executeFlowCommand(harness.runtime, 'status', harness.agent)
    expect(statusText).toContain('锁定模式')
    expect(statusText).toContain(statusPath)

    const repairText = await executeFlowCommand(harness.runtime, 'repair', harness.agent)
    expect(repairText).toContain('修复完成')
    expect(repairText).toContain('重建 1 个变更')
    expect(engine.snapshot().locked).toBe(false)

    const repairedDoctor = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(repairedDoctor).toContain('引擎状态：FlowGate 运行正常。')
    expect(repairedDoctor).not.toContain('锁定模式')
  })
})
