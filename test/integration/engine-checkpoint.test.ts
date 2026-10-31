/**
 * 集成检查点失败 → 自动修复任务 → 重试检查点（P0-2 / P0-3）。
 *
 * 覆盖：
 * - `kind: 'integration'` 失败：解析失败输出得到修复范围，生成 FIX-n 顺序修复批次；
 *   修复任务完成后 `dispatchNext()` 返回 `retryCheckpoint`，检查点重试通过后批次 done。
 * - `kind: 'merge'` 失败：只建 conflict 待处理项（不生成修复任务），`dispatchNext()`
 *   返回 `retryCheckpoint`；重试成功后待处理项自动关闭。
 * - 连续失败达到阈值后不再自动生成修复批次，转人工冲突项。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function harness(gateChecker = ALL_PASS): Promise<Harness> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# demo\n')
  await fs.writeFile('src/a.ts', 'export const a = 1\n')
  await fs.writeFile('src/b.ts', 'export const b = 2\n')
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
    ledgerKey: 'checkpoint-key',
    sessionId: 'session-checkpoint',
    sessionLabel: 'checkpoint',
    host: { gateChecker },
  })
  await engine.load()
  return { fs, clock, git, runner, engine }
}

/** Drive a change to S4 with a two-task parallel batch (B1). */
async function toS4Parallel(h: Harness): Promise<string> {
  const { engine, fs } = h
  await engine.init()
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
      '#### Scenario: R1.S2 失败',
      '- GIVEN 会员',
      '- WHEN 续费失败',
      '- THEN HTTP 500',
      '',
    ].join('\n'),
  )
  const task = (id: string, covers: string, file: string): string =>
    [
      `## ${id} 实现 ${id}`,
      '',
      '```yaml',
      `covers: [${covers}]`,
      `scope: [${file}]`,
      `tests: [test/${id.toLowerCase()}.test.ts]`,
      'new_files: []',
      'depends_on: []',
      'tdd: optional',
      'tdd_reason: 文档任务',
      'verify:',
      '  - group: unit',
      '    command: pnpm test',
      `    inputs: [${file}]`,
      'size: S',
      'run: subagent',
      'run_reason: 需要独立核对',
      '```',
      '',
      `${id} 的实现说明。`,
      '',
    ].join('\n')
  await fs.writeFile(
    `${base}/tasks.md`,
    [
      task('T1', 'R1.S1', 'src/a.ts'),
      task('T2', 'R1.S2', 'src/b.ts'),
      '## 执行计划',
      '',
      '```yaml',
      'execution:',
      '  - batch: B1',
      '    mode: parallel',
      '    tasks: [T1, T2]',
      '    why: 两个文件互不依赖',
      '```',
      '',
    ].join('\n'),
  )
  await engine.submitGate('G1')
  await engine.approveGate('G1')
  await engine.submitGate('G2')
  await engine.submitGate('G3')
  await engine.approveGate('G3')
  return created.changeId
}

/** Dispatch B1, then pretend both subagents finished successfully. */
async function dispatchAndFinishBatch(h: Harness): Promise<void> {
  const outcome = await h.engine.dispatchNext()
  expect(outcome.dispatched.map((envelope) => envelope.taskId).sort()).toEqual(['T1', 'T2'])
  const change = h.engine.currentChange()!
  for (const taskId of ['T1', 'T2']) {
    change.tasks[taskId]!.status = 'done'
  }
}

const FAILING_OUTPUT = [
  'FAIL  test/a.test.ts > A > adds',
  'AssertionError: expected 2 to be 1',
  ' ❯ test/a.test.ts:4:10',
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  1 failed | 1 passed (2)',
].join('\n')

describe('集成检查点失败 → 修复任务 → 重试', () => {
  it('integration 失败生成 FIX 修复批次，修完后重试通过', async () => {
    const h = await harness()
    await toS4Parallel(h)
    await dispatchAndFinishBatch(h)

    await h.engine.completeCheckpoint('B1', {
      ok: false,
      kind: 'integration',
      detail: '集成命令失败（pnpm test，exit=1）',
      command: 'pnpm test',
      output: FAILING_OUTPUT,
    })
    const change = h.engine.currentChange()!
    const failedBatch = change.batches.find((batch) => batch.id === 'B1')!
    expect(failedBatch.status).toBe('checkpoint')
    expect(failedBatch.checkpoint?.status).toBe('failed')
    expect(failedBatch.checkpoint?.attempts).toBe(1)

    const repairBatch = change.batches.find((batch) => batch.retryOf === 'B1')
    expect(repairBatch).toBeDefined()
    expect(repairBatch?.mode).toBe('sequential')
    const fixTask = h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))
    expect(fixTask).toBeDefined()
    // 失败输出里的文件被解析进修复范围（解析器只给 name 时要从 ` > ` 前缀推导 file）。
    expect(fixTask!.scope).toContain('test/a.test.ts')
    // 修复任务必须带可执行的验证组（否则 flow_verify 无组可选、flow_task_done 永远卡 TDD）。
    expect(fixTask!.verify[0]?.group).toBe('fix')
    expect(fixTask!.verify[0]?.command).toBe('pnpm test')
    // 修复批次在计划里排在失败批次之后。
    const plan = h.engine.getPlan()
    const planOrder = plan.batches.map((batch) => batch.batch)
    expect(planOrder.indexOf(repairBatch!.id)).toBeGreaterThan(planOrder.indexOf('B1'))

    // 修复任务可被派发；走**真实任务门**完成（不再是测试里直接改 status）。
    const next = await h.engine.dispatchNext()
    expect(next.dispatched.map((envelope) => envelope.taskId)).toEqual([fixTask!.id])
    // 自动修复任务不强制 RED→GREEN（失败状态通常不可复现为 RED），用 fix 组 GREEN 收口。
    expect(fixTask!.tdd).toBe('optional')
    h.engine.getConfig().review.enabled = false
    const verify = await h.engine.runVerify({ taskId: fixTask!.id, group: 'fix' })
    expect(verify.exitCode).toBe(0)
    const doneOutcome = await h.engine.taskDone(fixTask!.id)
    expect(doneOutcome.passed).toBe(true)
    // 修复任务完成会触发 checkBatchProgress：失败的 checkpoint 批次不能被当成 done。
    expect(change.batches.find((batch) => batch.id === 'B1')?.status).toBe('checkpoint')

    // 修复批次完成后要求重试原批次检查点（而不是继续下一批）。
    const retry = await h.engine.dispatchNext()
    expect(retry.dispatched).toEqual([])
    expect(retry.retryCheckpoint?.batchId).toBe('B1')

    await h.engine.completeCheckpoint('B1', { ok: true })
    const completedBatch = h.engine.currentChange()!.batches.find((batch) => batch.id === 'B1')!
    expect(completedBatch.status).toBe('done')
    expect(completedBatch.checkpoint?.status).toBe('passed')
  })

  it('integration 是 build/lint 类命令时：修复任务不带无效验证组，但真实 taskDone 仍可完成', async () => {
    const h = await harness()
    await toS4Parallel(h)
    await dispatchAndFinishBatch(h)
    await h.engine.completeCheckpoint('B1', {
      ok: false,
      kind: 'integration',
      detail: '集成命令失败（pnpm build，exit=1）',
      command: 'pnpm build',
      output: 'build failed: syntax error',
    })
    const fixTask = h.engine.getTasks().find((card) => card.id.startsWith('FIX-'))!
    // build 命令证据 phase 恒为 none：绝不能作为 fix 验证组（否则永久"回执过期"）。
    expect(fixTask.verify.some((group) => group.command === 'pnpm build')).toBe(false)
    expect(fixTask.autoRepair).toBe(true)
    const dispatched = await h.engine.dispatchNext()
    expect(dispatched.dispatched.map((envelope) => envelope.taskId)).toEqual([fixTask.id])
    h.engine.getConfig().review.enabled = false
    // 若项目另有测试命令则先跑 fix 组；没有验证组时修复任务仍可完成（降级口径）。
    if (fixTask.verify.length > 0) {
      expect(fixTask.verify[0]?.group).toBe('fix')
      const verify = await h.engine.runVerify({ taskId: fixTask.id, group: 'fix' })
      expect(verify.exitCode).toBe(0)
    }
    const doneOutcome = await h.engine.taskDone(fixTask.id)
    expect(doneOutcome.passed).toBe(true)
    const retry = await h.engine.dispatchNext()
    expect(retry.retryCheckpoint?.batchId).toBe('B1')
  })

  it('merge 失败只建 conflict 待处理项；重试成功后自动关闭', async () => {
    const h = await harness()
    await toS4Parallel(h)
    await dispatchAndFinishBatch(h)

    await h.engine.completeCheckpoint('B1', {
      ok: false,
      kind: 'merge',
      detail: '合并 T2 冲突：CONFLICT (content)',
    })
    const change = h.engine.currentChange()!
    expect(change.batches.filter((batch) => batch.retryOf === 'B1')).toHaveLength(0)
    const conflict = change.pending.find((item) => item.kind === 'conflict')
    expect(conflict).toBeDefined()
    expect(conflict?.status).toBe('open')
    expect(String(conflict?.data?.batchId)).toBe('B1')

    const retry = await h.engine.dispatchNext()
    expect(retry.retryCheckpoint?.batchId).toBe('B1')

    await h.engine.completeCheckpoint('B1', { ok: true })
    const closed = h.engine.currentChange()!.pending.find((item) => item.id === conflict!.id)
    expect(closed?.status).toBe('approved')
    expect(h.engine.currentChange()!.batches.find((batch) => batch.id === 'B1')?.status).toBe('done')
  })

  it('负责人拒绝 conflict = 放弃自动重试：批次 failed，dispatchNext 不再无限重试', async () => {
    const h = await harness()
    await toS4Parallel(h)
    await dispatchAndFinishBatch(h)
    await h.engine.completeCheckpoint('B1', { ok: false, kind: 'merge', detail: '合并冲突' })
    const conflict = h.engine.currentChange()!.pending.find((item) => item.kind === 'conflict')!
    await h.engine.decidePending(conflict.id, 'rejected', '决定放弃这批改动')
    expect(h.engine.currentChange()!.batches.find((batch) => batch.id === 'B1')?.status).toBe('failed')
    await expect(h.engine.dispatchNext()).rejects.toThrow('放弃自动重试')
  })

  it('连续失败达到阈值后不再自动生成修复批次，转人工冲突项', async () => {
    const h = await harness()
    await toS4Parallel(h)
    await dispatchAndFinishBatch(h)

    // 默认连续失败阈值 3 次：第 1、2 次自动修复，第 3 次转人工。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.engine.completeCheckpoint('B1', {
        ok: false,
        kind: 'integration',
        detail: `第 ${attempt} 次失败`,
        command: 'pnpm test',
        output: FAILING_OUTPUT,
      })
    }
    const change = h.engine.currentChange()!
    expect(change.batches.find((batch) => batch.id === 'B1')?.checkpoint?.attempts).toBe(3)
    expect(change.pending.some((item) => item.kind === 'conflict')).toBe(true)
    // 第 3 次不再新增修复批次（前两次各一个）。
    expect(change.batches.filter((batch) => batch.retryOf === 'B1')).toHaveLength(2)
    // 第 4 次仍失败：复用同一个 open conflict 项，不重复刷待处理项。
    await h.engine.completeCheckpoint('B1', {
      ok: false,
      kind: 'integration',
      detail: '第 4 次失败',
      command: 'pnpm test',
      output: FAILING_OUTPUT,
    })
    const after = h.engine.currentChange()!
    expect(
      after.pending.filter(
        (item) => item.kind === 'conflict' && item.status === 'open' && String(item.data?.batchId) === 'B1',
      ),
    ).toHaveLength(1)
    expect(after.batches.find((batch) => batch.id === 'B1')?.checkpoint?.attempts).toBe(4)
    const conflict = after.pending.find(
      (item) => item.kind === 'conflict' && item.status === 'open' && String(item.data?.batchId) === 'B1',
    )!
    // 修复批次完成后，达到失败上限 → dispatchNext 转为负责人闸门而不是无限重试。
    for (const batch of after.batches.filter((item) => item.retryOf === 'B1')) batch.status = 'done'
    const blocked = await h.engine.dispatchNext()
    expect(blocked.dispatched).toEqual([])
    expect(blocked.blocked?.id).toBe(conflict.id)
    // 负责人确认修好后：attempts 归零，下一次派发重试检查点。
    await h.engine.decidePending(conflict.id, 'approved', '冲突已修好')
    expect(after.batches.find((batch) => batch.id === 'B1')?.checkpoint?.attempts).toBe(0)
    const retry = await h.engine.dispatchNext()
    expect(retry.retryCheckpoint?.batchId).toBe('B1')
  })
})
