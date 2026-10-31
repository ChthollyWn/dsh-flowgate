/**
 * 接管模式 / 项目级暂停 / 事故记录（v0.5.1）。
 *
 * - takeover=enforce：未立项改动 R-NO-CHANGE（unlock 指向 flow_fix_start 修复通道）；
 * - takeover=observe：只记录一次 takeover.observed 并放行（自举/试运行）；
 * - takeover=off：放行不记账；
 * - flags.off：项目级暂停放行写操作，但 `.flowgate/**`、`.git/**` 仍 R-PROTECTED；
 * - 自暂停 incident 开/关与宿主重启 auto-rearm。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, TakeoverMode } from '../../src/core/types'
import type { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { createSandbox, type FakeCommandRunner, type FakeGit, type FakeClock } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function makeEngine(
  fs: MemoryFileSystem,
  clock: FakeClock,
  git: FakeGit,
  runner: FakeCommandRunner,
  sessionId: string,
  options: { takeover?: TakeoverMode; hostEpoch?: string } = {},
): Promise<FlowEngine> {
  const engine = new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'takeover-key',
    sessionId,
    sessionLabel: sessionId,
    host: { gateChecker: ALL_PASS },
    ...(options.takeover !== undefined ? { takeover: options.takeover } : {}),
    ...(options.hostEpoch !== undefined ? { hostEpoch: options.hostEpoch } : {}),
  })
  await engine.load()
  return engine
}

async function harness(options: { takeover?: TakeoverMode; hostEpoch?: string } = {}): Promise<Harness> {
  const sandbox = createSandbox()
  const engine = await makeEngine(sandbox.fs, sandbox.clock, sandbox.git, sandbox.runner, 'session-takeover', options)
  await engine.init()
  return { ...sandbox, engine }
}

const WRITE_SRC = { kind: 'write' as const, tool: 'write', path: 'src/index.ts' }
const CALLER = { tool: 'write', agentRole: 'main' as const }

async function ledgerTypes(fs: MemoryFileSystem): Promise<string[]> {
  const path = '.flowgate/state/ledger.jsonl'
  if (!(await fs.exists(path))) return []
  const raw = await fs.readFile(path)
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

function count(types: string[], type: string): number {
  return types.filter((entry) => entry === type).length
}

describe('接管模式：enforce / observe / off', () => {
  it('enforce（默认）：未立项改动 deny R-NO-CHANGE，unlock 指向 flow_fix_start 修复通道', async () => {
    const h = await harness()
    expect(h.engine.getTakeoverMode()).toBe('enforce')
    expect(h.engine.snapshot().takeover).toBe('enforce')
    const write = await h.engine.evaluateAction(WRITE_SRC, CALLER)
    expect(write.effect).toBe('deny')
    expect(write.rule?.ruleId).toBe('R-NO-CHANGE')
    expect(write.rule?.unlock).toContain('flow_fix_start')
    expect(write.rule?.unlock).toContain('flow_new_change')
    // 只读动作不受影响。
    expect((await h.engine.evaluateAction({ kind: 'read', tool: 'read', path: 'src/index.ts' }, { tool: 'read', agentRole: 'main' })).effect).toBe('allow')
    expect((await h.engine.evaluateAction({ kind: 'other', tool: 'flow_status' }, { tool: 'flow_status', agentRole: 'main' })).effect).toBe('allow')
  })

  it('observe：放行动作但每会话每规则至多一次账本记录 + 提示', async () => {
    const h = await harness({ takeover: 'observe' })
    expect(h.engine.getTakeoverMode()).toBe('observe')
    const first = await h.engine.evaluateAction(WRITE_SRC, CALLER)
    expect(first.effect).toBe('allow')
    expect(first.notes?.join('；') ?? '').toContain('观察模式')
    await h.engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/other.ts' }, CALLER)
    await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command: 'pnpm install' }, { tool: 'bash', agentRole: 'main' })
    const types = await ledgerTypes(h.fs)
    expect(count(types, 'takeover.observed')).toBe(1)
    expect(types).not.toContain('rule.denied')
    // 只读动作不记账、也不产生提示。
    await h.engine.evaluateAction({ kind: 'read', tool: 'read', path: 'src/index.ts' }, { tool: 'read', agentRole: 'main' })
    expect(count(await ledgerTypes(h.fs), 'takeover.observed')).toBe(1)
  })

  it('off：放行且不记账', async () => {
    const h = await harness({ takeover: 'off' })
    expect(h.engine.getTakeoverMode()).toBe('off')
    expect(h.engine.snapshot().takeover).toBe('off')
    expect((await h.engine.evaluateAction(WRITE_SRC, CALLER)).effect).toBe('allow')
    expect((await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command: 'pnpm install' }, { tool: 'bash', agentRole: 'main' })).effect).toBe('allow')
    const types = await ledgerTypes(h.fs)
    expect(count(types, 'takeover.observed')).toBe(0)
    expect(types).not.toContain('rule.denied')
  })
})

describe('项目级暂停（flags.off）', () => {
  it('暂停后写操作放行、受保护路径仍拒绝；恢复后回到 R-NO-CHANGE', async () => {
    const h = await harness()
    await h.engine.setProjectOff(true, '负责人临时排查', { by: 'human' })
    expect(h.engine.snapshot()).toMatchObject({ off: true, offBy: 'human' })
    expect(h.engine.getProjectFlags().off).toMatchObject({ by: 'human', reason: '负责人临时排查' })
    expect(h.engine.snapshot().nextStep).toContain('/flow on')
    expect(h.engine.buildInjection().text).toContain('暂停')

    expect((await h.engine.evaluateAction(WRITE_SRC, CALLER)).effect).toBe('allow')
    expect((await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command: 'pnpm install' }, { tool: 'bash', agentRole: 'main' })).effect).toBe('allow')
    // 项目暂停期间仍不允许 agent 改插件状态/git 内部（防止自解暂停、改账本）。
    for (const path of ['.flowgate/state/flags.json', '.flowgate/state/ledger.jsonl', '.git/config']) {
      const decision = await h.engine.evaluateAction({ kind: 'write', tool: 'write', path }, CALLER)
      expect(decision.effect, path).toBe('deny')
      expect(decision.rule?.ruleId, path).toBe('R-PROTECTED')
    }
    expect((await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command: 'echo {} > .flowgate/state/flags.json' }, { tool: 'bash', agentRole: 'main' })).effect).toBe('deny')

    // 持久化：新引擎加载后仍是暂停态。
    const reloaded = await makeEngine(h.fs, h.clock, h.git, h.runner, 'session-other')
    expect(reloaded.snapshot()).toMatchObject({ off: true, offBy: 'human' })
    await reloaded.setProjectOff(false, '负责人恢复')
    expect(reloaded.snapshot().off).toBe(false)
    expect((await reloaded.evaluateAction(WRITE_SRC, CALLER)).effect).toBe('deny')
    const types = await ledgerTypes(h.fs)
    expect(types).toContain('flow.project_off')
    expect(types).toContain('flow.project_on')
  })

  it('flags 损坏时 load 不失败，按未暂停降级', async () => {
    const h = await harness()
    await h.fs.writeFile('.flowgate/state/flags.json', '{"off": {broken')
    const reloaded = await makeEngine(h.fs, h.clock, h.git, h.runner, 'session-corrupt-flags')
    expect(reloaded.isInitialized()).toBe(true)
    expect(reloaded.snapshot().off).toBe(false)
    expect(reloaded.getProjectFlags()).toEqual({})
  })
})

describe('事故自暂停与 auto-rearm', () => {
  it('selfPause 开事故 + 暂停；重复调用返回同一事故；closeIncident 归档并恢复', async () => {
    const h = await harness({ hostEpoch: 'epoch-a' })
    const first = await h.engine.selfPause({ reason: '新建会话被自己的投影 bug 打挂', severity: 'P0' })
    expect(first.incident.id).toMatch(/^INC-\d{8}-\d{6}$/)
    expect(first.incident.openedAt).toBeDefined()
    expect(first.message).toContain('门禁已暂停')
    expect(first.message).toContain('flow_incident_close')
    expect(h.engine.snapshot()).toMatchObject({
      off: true,
      offBy: 'agent',
      incident: { id: first.incident.id, severity: 'P0' },
    })
    expect(h.engine.getProjectFlags().off).toMatchObject({ by: 'agent', autoRearm: true, hostEpoch: 'epoch-a' })

    const second = await h.engine.selfPause({ reason: '重复调用' })
    expect(second.incident.id).toBe(first.incident.id)
    expect(count(await ledgerTypes(h.fs), 'incident.open')).toBe(1)

    const closed = await h.engine.closeIncident({
      summary: '投影 wire 值改为 lossless JSON',
      commit: 'abc1234',
      tests: 'pnpm vitest run',
      files: ['src/host/projection/index.ts'],
    })
    expect(closed.incident.id).toBe(first.incident.id)
    expect(closed.incident.closedAt).toBeDefined()
    expect(closed.incident.summary).toContain('lossless JSON')
    expect(closed.message).toContain('门禁已恢复')
    expect(h.engine.snapshot().off).toBe(false)
    expect(h.engine.snapshot().incident).toBeUndefined()
    expect(h.engine.getProjectFlags()).toEqual({})
    const files = h.fs.listFiles()
    expect(files).toContain(`.flowgate/incidents/${first.incident.id}.json`)
    const saved = JSON.parse(await h.fs.readFile(`.flowgate/incidents/${first.incident.id}.json`)) as Record<string, unknown>
    expect(saved['summary']).toContain('lossless JSON')
    expect(saved['files']).toEqual(['src/host/projection/index.ts'])
    const types = await ledgerTypes(h.fs)
    expect(count(types, 'incident.close')).toBe(1)
    expect(types).toContain('flow.project_on')

    // 没有事故时关闭要报错。
    await expect(h.engine.closeIncident({ summary: '重复关闭' })).rejects.toThrow('没有未关闭的事故')
  })

  it('auto-rearm：同 epoch 保持暂停，宿主重启（epoch 变化）自动恢复并记账', async () => {
    const h = await harness({ hostEpoch: 'epoch-a' })
    await h.engine.setProjectOff(true, 'agent 自暂停', { by: 'agent', autoRearm: true })
    expect(h.engine.snapshot().off).toBe(true)

    // 同一宿主进程内的新会话：仍是暂停态。
    const sameHost = await makeEngine(h.fs, h.clock, h.git, h.runner, 'session-same-epoch', { hostEpoch: 'epoch-a' })
    expect(sameHost.snapshot().off).toBe(true)
    expect(sameHost.buildInjection().text).toContain('暂停')

    // 宿主重启：不同 epoch → 自动恢复。
    const restarted = await makeEngine(h.fs, h.clock, h.git, h.runner, 'session-new-epoch', { hostEpoch: 'epoch-b' })
    expect(restarted.snapshot().off).toBe(false)
    expect(restarted.getProjectFlags().off).toBeUndefined()
    expect((await ledgerTypes(h.fs))).toContain('flow.project_on')
    expect(restarted.buildInjection().text).toContain('flow_fix_start')
  })

  it('负责人手动暂停不会 auto-rearm（即使 epoch 变化）', async () => {
    const h = await harness({ hostEpoch: 'epoch-a' })
    await h.engine.setProjectOff(true, '负责人手动暂停', { by: 'human' })
    const restarted = await makeEngine(h.fs, h.clock, h.git, h.runner, 'session-new-epoch-2', { hostEpoch: 'epoch-b' })
    expect(restarted.snapshot().off).toBe(true)
    expect(restarted.getProjectFlags().off).toMatchObject({ by: 'human' })
  })
})
