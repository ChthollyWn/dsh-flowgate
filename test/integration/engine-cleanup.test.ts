/**
 * 第六轮清理的引擎级回归（2026-10-31）：
 * - T4.9 并行 worktree 任务：flow_verify 与自动提交都在 worktree 内执行；
 * - 派发双结算保护：已完成任务不会被迟到的 taskFailed 覆盖；
 * - T3.7 状态条包含当前任务与 TDD 状态；
 * - M-7 数据源：recordClarifyQA 回写 clarifyRounds；
 * - T2.3 `test: none` 时 G2 前真实运行 build/lint 基线；
 * - T4.2 S5 全量测试与基线对比后把 regressions 写入回执，G5 失败。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import {
  FakeClock,
  FakeCommandRunner,
  FakeGit,
  PASSING_SUMMARY,
  VITEST_PASS_STDOUT,
} from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []
const NOW = '2026-11-12T10:31:05+08:00'

interface Harness {
  fs: MemoryFileSystem
  engine: FlowEngine
  runner: FakeCommandRunner
  git: FakeGit
}

async function harness(options: { bypassChecks?: boolean; specs?: ConstructorParameters<typeof FakeCommandRunner>[0] } = {}): Promise<Harness> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# demo\n')
  await fs.writeFile('src/a.ts', 'export const a = 1\n')
  await fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', build: 'tsc' } }))
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner(
    options.specs ?? [{ match: 'test', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY }],
    clock,
  )
  const engine = new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'cleanup-key',
    sessionId: 'session-cleanup',
    sessionLabel: 'cleanup',
    ...(options.bypassChecks === false ? {} : { host: { gateChecker: ALL_PASS } }),
  })
  await engine.load()
  return { fs, engine, runner, git }
}

async function toS4(h: Harness, title = '会员续费'): Promise<void> {
  const { engine, fs } = h
  await engine.init()
  const created = await engine.newChange({ title, summary: '给会员加续费功能' })
  const base = `.flowgate/changes/${created.changeId}`
  await fs.writeFile(
    `${base}/specs/spec.md`,
    [
      '## ADDED Requirements',
      '',
      '### Requirement: R1 续费',
      '系统 SHALL 续费。',
      '',
      '#### Scenario: R1.S1 成功',
      '- GIVEN 会员',
      '- WHEN 续费',
      '- THEN HTTP 200',
      '',
    ].join('\n'),
  )
  await fs.writeFile(
    `${base}/tasks.md`,
    [
      '## T1 实现续费',
      '',
      '```yaml',
      'covers: [R1.S1]',
      'scope: [src/a.ts]',
      'tests: [test/a.test.ts]',
      'new_files: []',
      'depends_on: []',
      'tdd: optional',
      'tdd_reason: 文档任务',
      'verify:',
      '  - group: unit',
      '    command: pnpm test',
      '    inputs: [src/a.ts]',
      'size: S',
      'run: main',
      '```',
      '',
      '## 执行计划',
      '',
      '```yaml',
      'execution:',
      '  - batch: B1',
      '    mode: sequential',
      '    tasks: [T1]',
      '    why: 单任务',
      '```',
      '',
    ].join('\n'),
  )
  await engine.submitGate('G1')
  await engine.approveGate('G1')
  await engine.submitGate('G2')
  await engine.submitGate('G3')
  await engine.approveGate('G3')
}

describe('第六轮清理：引擎级回归', () => {
  it('并行 worktree 任务：flow_verify 与自动提交使用 worktree 作为根（T4.9）', async () => {
    const h = await harness()
    await toS4(h)
    const engine = h.engine
    engine.getConfig().review.enabled = false
    engine.getConfig().git.auto_commit = true
    await engine.setTaskWorktree('T1', '.flowgate/worktrees/C-001/T1')
    await engine.taskStart('T1')

    const receipt = await engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(receipt.phase).toBe('green')
    expect(h.runner.calls.at(-1)?.cwd).toBe('.flowgate/worktrees/C-001/T1')

    const outcome = await engine.taskDone('T1')
    expect(outcome.passed).toBe(true)
    expect(h.git.commits.at(-1)?.cwd).toBe('.flowgate/worktrees/C-001/T1')
  })

  it('已完成后迟到的 taskFailed 不覆盖成功状态（派发双结算保护）', async () => {
    const h = await harness()
    await toS4(h)
    const engine = h.engine
    engine.getConfig().review.enabled = false
    await engine.taskStart('T1')
    await engine.runVerify({ taskId: 'T1', group: 'unit' })
    const done = await engine.taskDone('T1')
    expect(done.passed).toBe(true)
    const pendingBefore = engine.currentChange()!.pending.length

    await engine.taskFailed('T1', '迟到的子 agent 失败结算')
    expect(engine.currentChange()!.tasks['T1']!.status).toBe('done')
    expect(engine.currentChange()!.pending.length).toBe(pendingBefore)
  })

  it('S4 状态条显示当前任务与 TDD 状态（T3.7）', async () => {
    const h = await harness()
    await toS4(h)
    const engine = h.engine
    await engine.taskStart('T1')
    engine.currentChange()!.tasks['T1']!.tdd = 'red'
    const statusLine = engine.snapshot().statusLine
    expect(statusLine).toContain('T1 RED')
    expect(statusLine.length).toBeLessThanOrEqual(120)
  })

  it('recordClarifyQA 回写 clarifyRounds，M-7 不再恒为 0（M-7 数据源）', async () => {
    const h = await harness()
    await h.engine.init()
    await h.engine.newChange({ title: '澄清回写', summary: '验证 M-7 数据源' })
    expect(h.engine.currentChange()?.clarifyRounds).toBe(0)
    await h.engine.recordClarifyQA({ question: '续费后到期日如何计算？', options: ['A', 'B'], answer: 'A', changed: '增加验收场景' })
    expect(h.engine.currentChange()?.clarifyRounds).toBeGreaterThan(0)
  })

  it('test:none 时 G2 前真实运行 build 基线并落回执（T2.3）', async () => {
    const h = await harness()
    const engine = h.engine
    await engine.init()
    engine.getConfig().commands.test = 'none'
    engine.getConfig().commands.build = 'pnpm build'
    await engine.newChange({ title: '无测试前端项目', summary: 'test: none 基线' })
    const change = engine.currentChange()!
    change.stage = 'S2'
    await engine.submitGate('G2')
    expect(h.runner.calls.some((call) => call.command.includes('build'))).toBe(true)
    expect(engine.currentChange()?.baseline).toBeDefined()
  })

  it('S5 全量测试相对基线回归会写进回执并让 G5 失败（T4.2）', async () => {
    const h = await harness({ bypassChecks: false })
    const engine = h.engine
    await engine.init()
    engine.getConfig().commands.test = 'pnpm test'
    engine.getConfig().review.enabled = false
    await engine.newChange({ title: 'S5 回归', summary: '验证 G5 基线对比' })
    const change = engine.currentChange()!
    change.stage = 'S5'
    change.baseline = {
      commit: null,
      summary: PASSING_SUMMARY,
      recordedAt: NOW,
    }
    h.runner.enqueue({
      match: 'pnpm test',
      exitCode: 1,
      stdout: [
        ' RUN  v4.1.0',
        '',
        ' ❯ test/renewal.test.ts (1 test | 1 failed)',
        '   × renewal adds one extra day',
        '     → expected 2, got 1',
        '',
        ' Test Files  1 failed (1)',
        '      Tests  1 failed (1)',
      ].join('\n'),
    })
    const result = await engine.submitGate('G5')
    expect(result.passed).toBe(false)
    const failure = result.failures.find((item) => item.item === 'g5.fullTests')
    expect(failure).toBeDefined()
    // ensureFullSuite 必须走 runFullSuite：回执里带 regressions（M-12 / 回归判定的数据源）。
    const ledger = await h.fs.readFile('.flowgate/state/ledger.jsonl')
    expect(ledger).toContain('regressions')
    expect(ledger).toContain('renewal adds one extra day')
  })
})
