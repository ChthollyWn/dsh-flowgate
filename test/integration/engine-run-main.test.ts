/**
 * `run: main` 任务路由（P0-1）。
 *
 * - 顺序批次：dispatchNext 不派子 agent，而是返回 mainTasks，由主会话用 flow_task_start 领取。
 * - 并行批次：run: subagent 的任务正常派发；run: main 的任务同时交给主会话，
 *   主会话可在子 agent 运行期间领取自己的任务。
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
  engine: FlowEngine
}

async function harness(): Promise<Harness> {
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
    ledgerKey: 'run-main-key',
    sessionId: 'session-run-main',
    sessionLabel: 'run-main',
    host: { gateChecker: ALL_PASS },
  })
  await engine.load()
  return { fs, engine }
}

interface CardSpec {
  id: string
  covers: string
  file: string
  run: 'main' | 'subagent'
}

interface BatchPlan {
  batch: string
  mode: 'sequential' | 'parallel'
  tasks: string[]
}

async function toS4(
  h: Harness,
  cards: CardSpec[],
  mode: 'sequential' | 'parallel',
  batchPlan?: BatchPlan[],
): Promise<void> {
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
  const card = (spec: CardSpec): string =>
    [
      `## ${spec.id} 实现 ${spec.id}`,
      '',
      '```yaml',
      `covers: [${spec.covers}]`,
      `scope: [${spec.file}]`,
      `tests: [test/${spec.id.toLowerCase()}.test.ts]`,
      'new_files: []',
      'depends_on: []',
      'tdd: optional',
      'tdd_reason: 文档任务',
      'verify:',
      '  - group: unit',
      '    command: pnpm test',
      `    inputs: [${spec.file}]`,
      'size: S',
      `run: ${spec.run}`,
      ...(spec.run === 'subagent' ? ['run_reason: 需要独立核对'] : []),
      '```',
      '',
      `${spec.id} 的实现说明。`,
      '',
    ].join('\n')
  await fs.writeFile(
    `${base}/tasks.md`,
    [
      ...cards.map(card),
      '## 执行计划',
      '',
      '```yaml',
      'execution:',
      ...(batchPlan ?? [{ batch: 'B1', mode, tasks: cards.map((spec) => spec.id) }]).flatMap((batch) => [
        `  - batch: ${batch.batch}`,
        `    mode: ${batch.mode}`,
        `    tasks: [${batch.tasks.join(', ')}]`,
        '    why: 测试执行图',
      ]),
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

describe('run: main 任务路由', () => {
  it('顺序批次：dispatchNext 返回 mainTasks，主会话 taskStart 可领取', async () => {
    const h = await harness()
    await toS4(h, [{ id: 'T1', covers: 'R1.S1', file: 'src/a.ts', run: 'main' }], 'sequential')
    const outcome = await h.engine.dispatchNext()
    expect(outcome.dispatched).toEqual([])
    expect(outcome.mainTasks?.map((item) => item.taskId)).toEqual(['T1'])
    expect(outcome.message).toContain('run: main')
    // 主会话领取任务（auto 模式下允许 run:main 任务被 inline 领取）。
    const started = await h.engine.taskStart('T1')
    expect(started.ok).toBe(true)
    expect(h.engine.currentChange()?.tasks['T1']?.status).toBe('running')
  })

  it('并行批次：子 agent 任务正常派发，run:main 任务同时交给主会话领取', async () => {
    const h = await harness()
    await toS4(
      h,
      [
        { id: 'T1', covers: 'R1.S1', file: 'src/a.ts', run: 'main' },
        { id: 'T2', covers: 'R1.S2', file: 'src/b.ts', run: 'subagent' },
      ],
      'parallel',
    )
    const outcome = await h.engine.dispatchNext()
    expect(outcome.dispatched.map((envelope) => envelope.taskId)).toEqual(['T2'])
    expect(outcome.mainTasks?.map((item) => item.taskId)).toEqual(['T1'])
    // T2 的运行状态不影响主会话领取自己的 run:main 任务。
    expect(h.engine.currentChange()?.tasks['T2']?.status).toBe('running')
    const started = await h.engine.taskStart('T1')
    expect(started.ok).toBe(true)
    expect(h.engine.currentChange()?.tasks['T1']?.status).toBe('running')
  })

  it('run:main 不能跨未完成批次越序领取', async () => {
    const h = await harness()
    await toS4(
      h,
      [
        { id: 'T1', covers: 'R1.S1', file: 'src/a.ts', run: 'subagent' },
        { id: 'T2', covers: 'R1.S2', file: 'src/b.ts', run: 'main' },
      ],
      'parallel',
      [
        { batch: 'B1', mode: 'parallel', tasks: ['T1'] },
        { batch: 'B2', mode: 'parallel', tasks: ['T2'] },
      ],
    )
    const outcome = await h.engine.dispatchNext()
    expect(outcome.dispatched.map((envelope) => envelope.taskId)).toEqual(['T1'])
    // 前面的批次还没完成：run:main 任务不应被提前放行（会破坏 depends_on/批次顺序）。
    await expect(h.engine.taskStart('T2')).rejects.toThrow('执行图要求先做')
  })

  it('并行批次超出并发上限的任务进入 queued，槽位释放后按队列派发（P1-6）', async () => {
    const h = await harness()
    await toS4(
      h,
      [
        { id: 'T1', covers: 'R1.S1', file: 'src/a.ts', run: 'subagent' },
        { id: 'T2', covers: 'R1.S2', file: 'src/b.ts', run: 'subagent' },
      ],
      'parallel',
    )
    h.engine.getConfig().parallel.max_agents = 1
    const first = await h.engine.dispatchNext()
    expect(first.dispatched.map((envelope) => envelope.taskId)).toEqual(['T1'])
    expect(h.engine.currentChange()?.tasks['T2']?.status).toBe('queued')
    // 模拟 T1 结算；下一次派发应领取 queued 的 T2（不再重复标记）。
    h.engine.currentChange()!.tasks['T1']!.status = 'done'
    const second = await h.engine.dispatchNext()
    expect(second.dispatched.map((envelope) => envelope.taskId)).toEqual(['T2'])
    expect(h.engine.currentChange()?.tasks['T2']?.status).toBe('running')
  })

  it('inline 模式下 run:main 任务仍可按执行图顺序领取', async () => {
    const h = await harness()
    await toS4(h, [{ id: 'T1', covers: 'R1.S1', file: 'src/a.ts', run: 'main' }], 'sequential')
    const outcome = await h.engine.taskStart('T1')
    expect(outcome.ok).toBe(true)
  })
})
