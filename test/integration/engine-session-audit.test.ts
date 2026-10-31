/**
 * 会话租约与接续快照（T3.7）：
 * - 被接管的旧会话写操作必须被拒绝（R-LEASE）；
 * - 接续时对比上一次会话释放时的工作区快照，把新增改动记为「非 agent 改动」；
 * - 状态条显示「已接续」。
 */
import { describe, it, expect } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Shared {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
}

function shared(): Shared {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  fs.writeFile('README.md', '# demo\n')
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
  const git = new FakeGit(clock)
  return { fs, clock, git }
}

function engineFor(sharedState: Shared, sessionId: string): FlowEngine {
  const runner = new FakeCommandRunner(
    [
      { match: 'vitest', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY },
      { match: 'pnpm test', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY },
    ],
    sharedState.clock,
  )
  return new FlowEngine({
    root: ROOT,
    fs: sharedState.fs,
    clock: sharedState.clock,
    git: sharedState.git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'session-audit-key',
    sessionId,
    sessionLabel: sessionId,
    host: { gateChecker: ALL_PASS },
  })
}

describe('会话接管与旧会话写拒绝（T3.7 验收 #2）', () => {
  it('B 接管 C-001 后，A 的写操作被 R-LEASE 拒绝', async () => {
    const state = shared()
    const a = engineFor(state, 'session-a')
    await a.load()
    await a.init()
    const created = await a.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    expect(created.changeId).toBe('C-001')

    const b = engineFor(state, 'session-b')
    await b.load()
    await b.resumeChange('C-001', { takeover: true })
    expect(b.currentChange()?.id).toBe('C-001')

    // 旧会话 A 的心跳节流到期后读磁盘租约，发现变更已被 B 接管。
    state.clock.advanceMs(2_000)
    const denied = await a.evaluateAction(
      { kind: 'write', tool: 'write', path: '.flowgate/changes/C-001/clarify.md' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(denied.effect).toBe('deny')
    expect(denied.rule?.ruleId).toBe('R-LEASE')

    // B 自己不受租约限制（该产物在本阶段可写）。
    const allowed = await b.evaluateAction(
      { kind: 'write', tool: 'write', path: '.flowgate/changes/C-001/clarify.md' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(allowed.effect).toBe('allow')
  })
})

describe('接续快照对比与「已接续」状态（T3.7 验收 #1/#3）', () => {
  it('会话释放后新会话接续：对比出会话之间的非 agent 改动', async () => {
    const state = shared()
    const a = engineFor(state, 'session-a')
    await a.load()
    await a.init()
    await a.newChange({ title: '会员续费', summary: '给会员加续费功能' })

    // 第一个会话：有一个 agent 改动，然后暂停（记录快照）。
    state.git.setChangedFiles(['src/agent-change.ts'])
    const pausedChange = a.currentChange()!
    await a.pauseChange()
    expect(pausedChange.worktreeSnapshot?.paths).toContain('src/agent-change.ts')

    // 两个会话之间：负责人又手动改了一个文件。
    state.git.setChangedFiles(['src/agent-change.ts', 'src/manual.ts'])
    const b = engineFor(state, 'session-b')
    await b.load()
    await b.resumeChange('C-001')
    const snapshot = b.snapshot()
    expect(snapshot.resumed).toBe(true)
    expect(snapshot.statusLine).toContain('已接续')
    expect(snapshot.externalChanges?.map((item) => item.path)).toEqual(['src/manual.ts'])
    expect(b.currentChange()?.externalChanges?.some((item) => item.path === 'src/manual.ts')).toBe(true)
  })

  it('新建变更不显示「已接续」', async () => {
    const state = shared()
    const a = engineFor(state, 'session-a')
    await a.load()
    await a.init()
    await a.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    expect(a.snapshot().resumed).toBe(false)
    expect(a.snapshot().statusLine).not.toContain('已接续')
  })
})
