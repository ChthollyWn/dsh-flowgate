/**
 * 状态文件损坏（03 §14）：`changes/<id>/status.json` 被截断/非法时不能 fail-open。
 *
 * 语义要求（02 需求规格 v1.0 完成定义 & 03 §14）：
 * - 状态文件损坏 → 锁定模式（写操作 R-LOCKED 拒绝）+ `/flow doctor` 可诊断；
 * - `/flow repair` 从账本快照重建 status.json 后解锁，写操作恢复；
 * - 修不好的损坏不能被静默吞掉（保持锁定并明确报告），否则会二次 fail-open。
 *
 * 测试全部使用内存 FS + 固定时钟，确定性、无网络、无真实 git。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../../src/core/engine'
import type { Action, CallerInfo, CheckOutcome } from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  DEFAULT_CONFIG,
  listChanges,
  listChangesDetailed,
  loadProjectState,
  readChangeStatus,
  scaffold,
  writeChangeStatus,
} from '../../../src/core/store'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../../helpers/fakes'
import { makeChange } from './fixtures'

const ROOT = ''
const LEDGER_KEY = 'state-corruption-key'
const ALL_PASS = async (): Promise<CheckOutcome[]> => []
const WRITE_SRC: Action = { kind: 'write', tool: 'write', path: 'src/index.ts' }
const CALLER: CallerInfo = { tool: 'write', agentRole: 'main' }
const FIXED_CLOCK = { now: () => new Date('2026-11-12T10:31:05+08:00') }

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

function makeHarness(): Harness {
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
    pluginVersion: '0.1.0-test',
    ledgerKey: LEDGER_KEY,
    sessionId: 'session-corruption',
    host: { gateChecker: ALL_PASS },
  })
  return { fs, clock, git, runner, engine }
}

/** 同一内存 FS 上新建引擎（模拟宿主重启后重新加载）。 */
function reload(h: Harness, sessionId: string): FlowEngine {
  return new FlowEngine({
    root: ROOT,
    fs: h.fs,
    clock: h.clock,
    git: h.git,
    commandRunner: h.runner,
    pluginVersion: '0.1.0-test',
    ledgerKey: LEDGER_KEY,
    sessionId,
    host: { gateChecker: ALL_PASS },
  })
}

function corruptStatusPath(changeId: string): string {
  return `.flowgate/changes/${changeId}/status.json`
}

/** 建一个变更，然后把 status.json 截断成非法 JSON（模拟磁盘写到一半崩溃）。 */
async function setupCorruptedChange(h: Harness): Promise<string> {
  await h.engine.init()
  const created = await h.engine.newChange({ title: '状态损坏演练', summary: '验证锁定与修复' })
  const statusPath = corruptStatusPath(created.changeId)
  const raw = await h.fs.readFile(statusPath)
  const truncated = raw.slice(0, Math.max(10, Math.floor(raw.length / 2)))
  // 截断点必须真的破坏 JSON，否则用例前提不成立（状态文件很长，通常截断即失败）。
  expect(() => JSON.parse(truncated)).toThrow()
  await h.fs.writeFile(statusPath, truncated)
  return created.changeId
}

// ---------------------------------------------------------------------------
// 存储层：损坏清单不再静默丢弃
// ---------------------------------------------------------------------------

describe('store/state — listChangesDetailed 报告损坏文件', () => {
  it('分别列出可解析变更与损坏 status.json；listChanges 保持既有跳过行为', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    await writeChangeStatus(fs, '', makeChange({ id: 'C-001', title: '正常' }))
    await fs.writeFile('.flowgate/changes/C-002/status.json', '{"id": "C-002", broken')
    await fs.writeFile('.flowgate/changes/C-003/status.json', '{"title": "缺少 id"}')
    // 台账/编辑器杂项文件不是状态损坏（既有行为：跳过）。
    await fs.writeFile('.flowgate/changes/index.md', '# 变更台账\n')
    await fs.writeFile('.flowgate/changes/.DS_Store', 'junk')

    const scan = await listChangesDetailed(fs, '')
    expect(scan.changes.map((change) => change.id)).toEqual(['C-001'])
    expect(scan.corrupt.map((file) => file.path)).toEqual([
      '.flowgate/changes/C-002/status.json',
      '.flowgate/changes/C-003/status.json',
    ])
    expect(scan.corrupt[0]?.reason).toContain('非法 JSON')
    expect(scan.corrupt[1]?.reason).toContain('id')
    // 兼容入口：仍只返回可解析的变更。
    expect((await listChanges(fs, '')).map((change) => change.id)).toEqual(['C-001'])
  })

  it('changes 目录不存在时返回空结果（不误报损坏）', async () => {
    const fs = new MemoryFileSystem()
    await expect(listChangesDetailed(fs, '')).resolves.toEqual({ changes: [], corrupt: [] })
  })

  it('目录存在但 status.json 缺失时不算损坏（缺失由 /flow repair 按需重建）', async () => {
    const fs = new MemoryFileSystem()
    await fs.mkdir('.flowgate/changes/C-004/specs')
    await fs.writeFile('.flowgate/changes/C-004/clarify.md', '# clarify\n')
    await expect(listChangesDetailed(fs, '')).resolves.toEqual({ changes: [], corrupt: [] })
  })

  it('读取 status.json 本身失败（EACCES 等）也计入损坏清单（fail-closed）', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/changes/C-001/status.json': '{"id": "C-001"}' })
    fs.failOn = 'C-001/status.json'
    const scan = await listChangesDetailed(fs, '')
    expect(scan.corrupt).toHaveLength(1)
    expect(scan.corrupt[0]?.path).toBe('.flowgate/changes/C-001/status.json')
    expect(scan.corrupt[0]?.reason).toContain('injected fs failure')
  })
})

describe('store/state — loadProjectState 汇总损坏清单', () => {
  it('干净项目不新增字段（保持旧返回值形状），损坏时给出路径与原因', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    await writeChangeStatus(fs, '', makeChange({ id: 'C-001' }))

    const clean = await loadProjectState({ fs, root: ROOT, config: DEFAULT_CONFIG, clock: FIXED_CLOCK })
    expect(clean.changes.map((change) => change.id)).toEqual(['C-001'])
    // 只在存在损坏时出现，避免改变既有调用方/快照断言的返回形状。
    expect(clean.corruptStateFiles).toBeUndefined()

    await fs.writeFile('.flowgate/changes/C-001/status.json', '{"id": "C-001", broken')
    const corrupted = await loadProjectState({ fs, root: ROOT, config: DEFAULT_CONFIG, clock: FIXED_CLOCK })
    expect(corrupted.changes).toEqual([])
    expect(corrupted.corruptStateFiles).toHaveLength(1)
    expect(corrupted.corruptStateFiles?.[0]?.path).toBe('.flowgate/changes/C-001/status.json')
    expect(corrupted.corruptStateFiles?.[0]?.reason).toContain('非法 JSON')
  })
})

// ---------------------------------------------------------------------------
// 引擎：损坏 → 锁定（拒绝写入 + doctor/status 可见）
// ---------------------------------------------------------------------------

describe('engine.load — 损坏 status.json 进入锁定模式（03 §14）', () => {
  it('锁定、doctor/status 带文件路径与修复入口、写操作 R-LOCKED、立项被拒', async () => {
    const h = makeHarness()
    const changeId = await setupCorruptedChange(h)
    const reloaded = reload(h, 'session-corruption-locked')
    await reloaded.load()

    expect(reloaded.snapshot().initialized).toBe(true)
    expect(reloaded.snapshot().locked).toBe(true)
    // 损坏变更不会被当作「不存在」静默放行；它从变更列表消失但仍以锁定模式约束全局。
    expect(reloaded.allChanges()).toHaveLength(0)

    const doctor = await reloaded.doctor()
    expect(doctor.ledgerOk).toBe(true)
    expect(doctor.configOk).toBe(true)
    expect(doctor.message).toContain('锁定模式')
    expect(doctor.message).toContain(corruptStatusPath(changeId))
    expect(doctor.message).toContain('非法 JSON')
    expect(doctor.message).toContain('/flow repair')

    // /flow status 文本同样不丢原因。
    const statusText = reloaded.statusText()
    expect(statusText).toContain('锁定模式')
    expect(statusText).toContain(corruptStatusPath(changeId))

    // 注入文本（agent 看到的状态）也要给出锁定原因。
    const injection = reloaded.buildInjection().text
    expect(injection).toContain('锁定模式')
    expect(injection).toContain(corruptStatusPath(changeId))

    // 门禁内写入 fail-closed。
    const decision = await reloaded.evaluateAction(WRITE_SRC, CALLER)
    expect(decision.effect).toBe('deny')
    expect(decision.message).toContain('R-LOCKED')

    await expect(reloaded.newChange({ title: '趁锁立项', summary: '应被拒绝' })).rejects.toThrow('锁定模式')
  })

  it('快照 nextStep 指向授权卡片修复而不是「立项」', async () => {
    const h = makeHarness()
    await setupCorruptedChange(h)
    const reloaded = reload(h, 'session-corruption-next-step')
    await reloaded.load()
    expect(reloaded.snapshot().nextStep).toContain('授权卡片')
    expect(reloaded.snapshot().nextStep).toContain('修复')
    expect(reloaded.snapshot().nextStep).not.toContain('/flow')
  })

  it('多个损坏文件时锁定原因给出数量与代表路径（路径不刷屏）', async () => {
    const h = makeHarness()
    await h.engine.init()
    for (const id of ['C-101', 'C-102', 'C-103', 'C-104']) {
      await h.fs.writeFile(corruptStatusPath(id), `{"id": "${id}", broken`)
    }
    const reloaded = reload(h, 'session-corruption-many')
    await reloaded.load()
    expect(reloaded.snapshot().locked).toBe(true)
    const doctor = await reloaded.doctor()
    expect(doctor.message).toContain('状态文件损坏（4 个）')
    expect(doctor.message).toContain('.flowgate/changes/C-101/status.json')
    expect(doctor.message).toContain('另有 1 个损坏文件')
    expect(doctor.message).toContain('/flow repair')
  })
})

// ---------------------------------------------------------------------------
// repair：从账本重建后解锁
// ---------------------------------------------------------------------------

describe('engine.repair — 状态损坏后的恢复', () => {
  it('从账本快照重建 status.json 后解锁、写操作恢复', async () => {
    const h = makeHarness()
    const changeId = await setupCorruptedChange(h)
    const locked = reload(h, 'session-corruption-repair')
    await locked.load()
    expect(locked.snapshot().locked).toBe(true)

    const result = await locked.repair()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('重建 1 个变更')
    expect(result.message).toContain('锁定模式解除')

    // status.json 由账本里的 change.updated 完整快照重建。
    const restored = await readChangeStatus(h.fs, ROOT, changeId)
    expect(restored?.id).toBe(changeId)
    expect(restored?.title).toBe('状态损坏演练')

    expect(locked.snapshot().locked).toBe(false)
    // 解锁后普通源码写恢复放行（已无进行中的变更时也允许，且不再 R-LOCKED）。
    const decision = await locked.evaluateAction(WRITE_SRC, CALLER)
    expect(decision.message).not.toContain('R-LOCKED')
    expect(decision.effect).toBe('allow')

    // 新引擎重新加载也不会回到锁定。
    const reloaded = reload(h, 'session-corruption-after-repair')
    await reloaded.load()
    expect(reloaded.snapshot().locked).toBe(false)
    expect(reloaded.allChanges().map((change) => change.id)).toEqual([changeId])
  })

  it('同一会话 repair 也能解锁：current 恢复、回到原有阶段门禁而不是 R-LOCKED', async () => {
    const h = makeHarness()
    const changeId = await setupCorruptedChange(h)
    // 用创建变更的同一 sessionId 重新加载：租约命中，但损坏的变更不在列表里 → current 为空。
    const sameSession = reload(h, 'session-corruption')
    await sameSession.load()
    expect(sameSession.snapshot().locked).toBe(true)
    expect(sameSession.currentChange()).toBeNull()

    const result = await sameSession.repair()
    expect(result.ok).toBe(true)
    expect(sameSession.snapshot().locked).toBe(false)
    expect(sameSession.currentChange()?.id).toBe(changeId)
    // 写操作不再被锁定规则拒绝（S1 阶段对 src/ 的阶段门禁是另一条正常规则）。
    const decision = await sameSession.evaluateAction(WRITE_SRC, CALLER)
    expect(decision.message).not.toContain('R-LOCKED')
  })

  it('无法从账本重建的损坏文件：repair 明确失败并保持锁定（不静默解锁）', async () => {
    const h = makeHarness()
    await h.engine.init()
    // 变更目录存在、status.json 损坏，但账本里没有该变更的快照、目录里也没有可推断产物。
    const orphanStatus = '.flowgate/changes/C-009/status.json'
    await h.fs.writeFile(orphanStatus, '{"id": "C-009", broken')

    const reloaded = reload(h, 'session-corruption-unrecoverable')
    await reloaded.load()
    expect(reloaded.snapshot().locked).toBe(true)

    const result = await reloaded.repair()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法从账本重建')
    expect(result.message).toContain(orphanStatus)
    // 修不好就保持锁定：不能把二次 fail-open 当成功。
    expect(reloaded.snapshot().locked).toBe(true)
    expect((await reloaded.evaluateAction(WRITE_SRC, CALLER)).effect).toBe('deny')
  })
})
