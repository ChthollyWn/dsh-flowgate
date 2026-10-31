/**
 * S5 验证失败 → 回退 S4 + 自动修复任务（P0-7）。
 *
 * 覆盖：
 * - `g5.fullTests` / `g5.lintBuild` 失败：进入 S4，生成 FIX-n 修复批次，修复任务可被派发；
 * - `g5.finalReview` 有 critical/major findings：按 findings 文件生成修复任务；
 * - 仅证据类失败（如 `g5.runtime`）不回退 S4，也不生成修复任务。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome, GateCheckContext } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  engine: FlowEngine
}

async function harness(gateChecker: (context: GateCheckContext) => Promise<CheckOutcome[]> = ALL_PASS): Promise<Harness> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# demo\n')
  await fs.writeFile('src/a.ts', 'export const a = 1\n')
  await fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner([{ match: 'test', exitCode: 0, stdout: VITEST_PASS_STDOUT }], clock)
  const engine = new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 's5-repair-key',
    sessionId: 'session-s5-repair',
    sessionLabel: 's5-repair',
    host: { gateChecker },
  })
  await engine.load()
  return { fs, engine }
}

/** Gate checker that only fails G5 with the given item. */
function g5Failing(item: string): (context: GateCheckContext) => Promise<CheckOutcome[]> {
  return async (context) =>
    context.gate === 'G5' ? [{ item, label: `S5 检查失败（${item}）`, passed: false, hint: '修复后重新提交 G5' }] : []
}

/** Drive a change to S4 with one task (B1) and mark S4 complete so only S5 gaps remain. */
async function toS5(h: Harness): Promise<void> {
  const { engine, fs } = h
  await engine.init()
  // 修复任务从项目命令生成验证组（test: none 时会降级 TDD）。
  engine.getConfig().commands.test = 'pnpm test'
  const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
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
  const change = engine.currentChange()!
  change.tasks['T1']!.status = 'done'
  change.batches[0]!.status = 'done'
  change.stage = 'S5'
  change.updatedAt = '2026-01-01T00:00:00.000Z'
}

describe('S5 验证失败回退 S4', () => {
  it('g5.fullTests 失败：回退 S4 并生成可派发的 FIX 修复任务', async () => {
    const h = await harness(g5Failing('g5.fullTests'))
    await toS5(h)

    const result = await h.engine.submitGate('G5')
    expect(result.passed).toBe(false)
    expect(result.stage).toBe('S4')
    expect(result.message).toContain('回退 S4')
    const change = h.engine.currentChange()!
    const repairBatch = change.batches.find((batch) => batch.tasks.some((taskId) => taskId.startsWith('FIX-')))
    expect(repairBatch).toBeDefined()
    const fixTask = h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))
    expect(fixTask).toBeDefined()
    // 修复范围回退到任务卡范围，保证修复任务可写。
    expect([...fixTask!.scope, ...fixTask!.tests]).toContain('src/a.ts')
    // 修复任务带可执行的验证组，能走 RED→GREEN 完成任务门。
    expect(fixTask!.verify[0]?.group).toBe('fix')
    expect(fixTask!.verify[0]?.command).toBe('pnpm test')
    expect(h.engine.getPlan().batches.some((batch) => batch.batch === repairBatch!.id)).toBe(true)
    // S5 修复批次不是重试检查点，不应带 retryOf。
    expect(repairBatch!.retryOf).toBeUndefined()

    // 回退后修复任务可被派发（B1 已完成），并走真实任务门完成。
    const dispatched = await h.engine.dispatchNext()
    expect(dispatched.dispatched.map((envelope) => envelope.taskId)).toEqual([fixTask!.id])
    expect(fixTask!.tdd).toBe('optional')
    h.engine.getConfig().review.enabled = false
    const verify = await h.engine.runVerify({ taskId: fixTask!.id, group: 'fix' })
    expect(verify.exitCode).toBe(0)
    const doneOutcome = await h.engine.taskDone(fixTask!.id)
    expect(doneOutcome.passed).toBe(true)
    // 修复批次完成后自动重评 G4 并回到 S5。
    expect(h.engine.currentChange()?.stage).toBe('S5')
  })

  it('g5.lintBuild 失败：同样回退 S4 生成修复任务', async () => {
    const h = await harness(g5Failing('g5.lintBuild'))
    await toS5(h)
    const result = await h.engine.submitGate('G5')
    expect(result.passed).toBe(false)
    expect(result.stage).toBe('S4')
    expect(h.engine.getTasks().some((card) => card.id.startsWith('FIX-'))).toBe(true)
    expect(h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))?.title).toContain('lint/build/typecheck')
  })

  it('终审 critical/major findings：按 findings 文件回退 S4 生成修复任务', async () => {
    const h = await harness(g5Failing('g5.finalReview'))
    await toS5(h)
    await h.engine.recordReview({
      kind: 'final',
      verdict: 'changes-required',
      findings: [{ severity: 'major', file: 'src/a.ts', line: 1, rule: 'review', message: '需要修复的空指针风险' }],
      coverageOk: true,
    })
    const result = await h.engine.submitGate('G5')
    expect(result.passed).toBe(false)
    expect(result.stage).toBe('S4')
    const fixTask = h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))
    expect(fixTask?.scope).toContain('src/a.ts')
    expect(fixTask?.title).toContain('终审 findings')
  })

  it('高风险变更：自动修复任务豁免 tddRequiredAll，真实 taskDone 可完成', async () => {
    const h = await harness(g5Failing('g5.lintBuild'))
    await toS5(h)
    // 高风险：levels.tddRequiredAll=true，自动修复任务仍应可用 fix 组 GREEN 收口。
    h.engine.currentChange()!.risk = 'high'
    const result = await h.engine.submitGate('G5')
    expect(result.passed).toBe(false)
    expect(result.stage).toBe('S4')
    const fixTask = h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))!
    expect(fixTask.autoRepair).toBe(true)
    const dispatched = await h.engine.dispatchNext()
    expect(dispatched.dispatched.map((envelope) => envelope.taskId)).toEqual([fixTask.id])
    h.engine.getConfig().review.enabled = false
    const verify = await h.engine.runVerify({ taskId: fixTask.id, group: 'fix' })
    expect(verify.exitCode).toBe(0)
    const doneOutcome = await h.engine.taskDone(fixTask.id)
    expect(doneOutcome.passed).toBe(true)
    expect(h.engine.currentChange()?.stage).toBe('S5')
  })

  it('仅证据类失败（g5.runtime）不回退 S4，也不生成修复任务', async () => {
    const h = await harness(g5Failing('g5.runtime'))
    await toS5(h)
    const before = h.engine.getTasks().length
    const result = await h.engine.submitGate('G5')
    expect(result.passed).toBe(false)
    expect(result.stage).toBe('S5')
    expect(result.message).not.toContain('回退 S4')
    expect(h.engine.getTasks().length).toBe(before)
    expect(h.engine.currentChange()!.batches.some((batch) => batch.tasks.some((taskId) => taskId.startsWith('FIX-')))).toBe(false)
  })
})
