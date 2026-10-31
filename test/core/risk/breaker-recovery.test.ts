/**
 * T-FAILURE-LIMIT 连续失败熔断的「可恢复性」回归（03 §8.2 · FR-4.8 · T3.5）。
 *
 * 真实事故参考（只作为行为参照，测试本身不读 run 目录）：
 * `docs/evaluation-data/20261031-105753-greenfield-members-greenfield-B/`
 * - `flowgate/changes/C-001/status.json` 快照：T1 `status=blocked`、`failureCount=3`，
 *   `pending BL-1..BL-8` 全 open——BL-1 是连续失败熔断项，BL-2..BL-8 是熔断后
 *   「每个被拦动作各建一条」的重复项（read/flow_status/flow_report_risk/只读 bash 都被拦）；
 * - `rounds/round-5.stdout.jsonl`、`round-6.stdout.jsonl`：熔断后 agent 连
 *   `.flowgate/state/evidence/E-0003.log` 都读不了，也无法上报根因，人和 agent 都卡死。
 *
 * 修复目标（不放宽普通门禁）：
 * - 只读动作（read/glob/grep、只读 shell、flow_status/flow_diff/flow_report_risk）放行；
 * - 写/验证/进度类动作在熔断期间仍然转人工；
 * - 同一任务只保留一个 open blocker（幂等）；
 * - 负责人 `decidePending('BL-n','approved')`（host `/flow unblock`）后失败计数清零、
 *   任务恢复执行、同任务其它 open blocker 一并关闭、账本写 task.unblocked。
 *
 * 全部使用内存 FS + FakeClock + FakeGit/FakeCommandRunner，确定性、无网络、无真实 git。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../../src/core/engine'
import type { Action, CallerInfo, ChangeStatus, CheckOutcome, TaskState } from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { readChangeStatus, writeChangeStatus } from '../../../src/core/store'
import {
  FAILING_SUMMARY,
  FakeClock,
  FakeCommandRunner,
  FakeGit,
  PASSING_SUMMARY,
  VITEST_PASS_STDOUT,
} from '../../helpers/fakes'

const ROOT = ''
const LEDGER_KEY = 'breaker-recovery-key'
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

const MAIN: CallerInfo = { tool: 'write', agentRole: 'main' }

const WRITE_SRC: Action = { kind: 'write', tool: 'edit', path: 'src/impl.ts' }
const READ_EVIDENCE_LOG: Action = {
  kind: 'read',
  tool: 'read',
  path: '.flowgate/state/evidence/E-0003.log',
}
const READONLY_SHELL: Action = {
  kind: 'shell',
  tool: 'bash',
  command: 'ls -la; echo ---; ls -la .flowgate 2>/dev/null; echo ---',
}
const FLOW_STATUS: Action = { kind: 'other', tool: 'flow_status' }
const FLOW_DIFF: Action = { kind: 'other', tool: 'flow_diff' }
const FLOW_REPORT_RISK: Action = { kind: 'other', tool: 'flow_report_risk' }
const FLOW_VERIFY: Action = { kind: 'other', tool: 'flow_verify' }

const FAILING_TEST_STDOUT = [
  ' RUN  v4.1.0',
  '',
  ' ❯ test/unittest_runner.test.py (6 tests | 1 failed)',
  '   × parses unittest output',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 5 passed (6)',
  '',
].join('\n')

/** tasks.md：单任务 T1 + 单批次执行计划（tdd 可选，聚焦熔断而不是 TDD 顺序）。 */
const TASKS_MD = `# 任务

## T1 修复 unittest 解析器

\`\`\`yaml
covers: [R1.S1]
scope: [src/**]
tests: [test/**]
new_files: []
depends_on: []
tdd: optional
verify:
  - group: unit
    command: pnpm test
    inputs: [src/**]
size: S
\`\`\`

让 python unittest 的失败输出也能被解析。

## 执行计划

\`\`\`yaml
execution:
  - batch: B1
    mode: sequential
    tasks: [T1]
    why: 只有一个任务
\`\`\`
`

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

function createHarness(): Harness {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  fs.writeFile('README.md', '# demo\n')
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }))
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner(
    [
      { match: 'vitest', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY },
      // flow_verify 的 unit 组命令：失败（模仿真实事故里「测试跑了但解析失败 → 退出码非 0」）。
      {
        match: 'pnpm test',
        exitCode: 1,
        stdout: FAILING_TEST_STDOUT,
        summary: { ...FAILING_SUMMARY, failures: [{ name: 'parses unittest output', file: 'test/unittest_runner.test.py', line: 12, message: 'parser returned null' }] },
      },
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
    sessionId: 'session-breaker',
    host: { gateChecker: ALL_PASS },
  })
  return { fs, clock, git, runner, engine }
}

/** 用真实状态机走到 S4，并领取唯一任务 T1。 */
async function reachS4WithRunningTask(h: Harness): Promise<ChangeStatus> {
  await h.engine.init()
  // 显式 medium：低复杂度会走 G1 自动通过 + G3 合并确认的快车道，这里验证的是 S4 熔断。
  const created = await h.engine.newChange({ title: '熔断恢复演练', summary: '验证连续失败熔断可恢复', complexityHint: 'medium' })
  await h.fs.writeFile(`.flowgate/changes/${created.changeId}/tasks.md`, TASKS_MD)

  await h.engine.submitGate('G1')
  await h.engine.approveGate('G1') // S2
  await h.engine.submitGate('G2') // 自动门 → S3
  await h.engine.submitGate('G3')
  await h.engine.approveGate('G3') // S4 + onEnterS4 物化任务状态

  const current = h.engine.currentChange()
  expect(current?.stage).toBe('S4')
  const started = await h.engine.taskStart('T1')
  expect(started.ok).toBe(true)
  return h.engine.currentChange()!
}

/** 连续失败 n 次（默认 3 次即触发熔断）。 */
async function failVerify(h: Harness, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    const receipt = await h.engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(receipt.exitCode).not.toBe(0)
  }
}

function openBlockers(change: ChangeStatus) {
  return change.pending.filter((item) => item.status === 'open' && item.kind === 'blocker')
}

async function ledgerEvents(h: Harness): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const raw = await h.fs.readFile('.flowgate/state/ledger.jsonl')
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
}

/** 模拟真实 run 里 BL-2..BL-8 的残留：直接改 status.json 再 refresh。 */
async function addOpenBlocker(h: Harness, changeId: string, blocker: { id: string; data: Record<string, unknown> }): Promise<void> {
  const status = await readChangeStatus(h.fs, ROOT, changeId)
  expect(status).not.toBeNull()
  status!.pending.push({
    id: blocker.id,
    kind: 'blocker',
    changeId,
    title: `${blocker.id} 历史熔断残留`,
    detail: '旧版本为每个被拦动作各建一条 BL。',
    status: 'open',
    createdAt: '2026-10-31T11:10:00+08:00',
    data: blocker.data,
  })
  await writeChangeStatus(h.fs, ROOT, status!)
  await h.engine.refresh()
}

// ---------------------------------------------------------------------------
// a. 只读放行：熔断后仍能取证/查状态/上报风险，写与验证仍拦截
// ---------------------------------------------------------------------------

describe('T-FAILURE-LIMIT — 只读动作放行（真实事故回归）', () => {
  it('read/只读 shell/flow_status/flow_diff/flow_report_risk 放行；写与 flow_verify 仍转人工', async () => {
    const h = createHarness()
    await reachS4WithRunningTask(h)
    await failVerify(h, 3)
    const change = h.engine.currentChange()!
    expect(change.tasks.T1?.status).toBe('blocked')
    expect(openBlockers(change)).toHaveLength(1)

    // 真实事故里被拦的正是这些只读动作：取证日志、ls、查状态、上报风险。
    for (const action of [READ_EVIDENCE_LOG, READONLY_SHELL, FLOW_STATUS, FLOW_DIFF, FLOW_REPORT_RISK]) {
      const decision = await h.engine.evaluateAction(action, MAIN)
      expect(decision.effect, `${action.kind}:${action.tool}`).toBe('allow')
    }

    // 写/验证仍转人工：熔断不是放宽门禁。
    for (const action of [WRITE_SRC, FLOW_VERIFY]) {
      const decision = await h.engine.evaluateAction(action, MAIN)
      expect(decision.effect, `${action.kind}:${action.tool}`).toBe('human')
      expect(decision.rule?.ruleId).toBe('T-FAILURE-LIMIT')
      expect(decision.message).toContain('/flow unblock')
    }

    // 被拦动作不再新建 BL：仍只有 1 个 open blocker。
    expect(openBlockers(h.engine.currentChange()!)).toHaveLength(1)
  })

  it('未达上限（2/3）时不熔断：写操作与只读都放行，也不生成 BL', async () => {
    const h = createHarness()
    await reachS4WithRunningTask(h)
    await failVerify(h, 2)

    const change = h.engine.currentChange()!
    expect(change.tasks.T1?.failureCount).toBe(2)
    expect(openBlockers(change)).toHaveLength(0)
    expect((await h.engine.evaluateAction(WRITE_SRC, MAIN)).effect).toBe('allow')
    expect((await h.engine.evaluateAction(FLOW_STATUS, MAIN)).effect).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// b. 幂等：同一任务只产生一个 BL（真实 run 里膨胀到 BL-1..BL-8）
// ---------------------------------------------------------------------------

describe('T-FAILURE-LIMIT — 待处理项幂等', () => {
  it('3 次失败只产生 1 个 BL；继续失败/被拦动作也不会膨胀', async () => {
    const h = createHarness()
    await reachS4WithRunningTask(h)
    await failVerify(h, 3)

    let change = h.engine.currentChange()!
    const blockers = openBlockers(change)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({ id: 'BL-1', kind: 'blocker', data: { taskId: 'T1' } })
    expect(blockers[0]!.detail).toContain('/flow unblock BL-1')

    // 继续失败（直接调 engine.runVerify，绕过 guard）：failureCount 增长但 BL 不新增。
    await failVerify(h, 2)
    change = h.engine.currentChange()!
    expect(change.tasks.T1?.failureCount).toBe(5)
    expect(openBlockers(change)).toHaveLength(1)

    // 熔断期间反复尝试写动作：每次都转人工，但都复用 BL-1（不新建 BL）。
    for (let index = 0; index < 3; index += 1) {
      const decision = await h.engine.evaluateAction(WRITE_SRC, MAIN)
      expect(decision.effect).toBe('human')
    }
    change = h.engine.currentChange()!
    expect(openBlockers(change)).toHaveLength(1)
    expect(openBlockers(change)[0]?.id).toBe('BL-1')
  })
})

// ---------------------------------------------------------------------------
// c. 负责人解锁：decidePending('BL-1','approved') 等价 /flow unblock BL-1
// ---------------------------------------------------------------------------

describe('T-FAILURE-LIMIT — 负责人解锁（/flow unblock）', () => {
  it('解锁后 failureCount=0、任务恢复 running（保留 startedAt）、账本有 task.unblocked、flow_* 恢复', async () => {
    const h = createHarness()
    await reachS4WithRunningTask(h)
    await failVerify(h, 3)

    const before = h.engine.currentChange()!
    const startedAt = before.tasks.T1?.startedAt
    expect(startedAt).toBeTruthy()
    expect(before.tasks.T1?.failureCount).toBe(3)

    const decided = await h.engine.decidePending('BL-1', 'approved', '已定位根因：解析器缺 stderr 分支')
    expect(decided.status).toBe('approved')
    expect(decided.decidedAt).toBeTruthy()

    const after = h.engine.currentChange()!
    const task = after.tasks.T1 as TaskState
    expect(task.failureCount).toBe(0)
    expect(task.status).toBe('running') // 从 blocked 恢复执行
    expect(task.startedAt).toBe(startedAt) // 保留原 startedAt
    expect(task.blockReason).toBeUndefined()

    // 账本：负责人解锁事件（host 层 /flow unblock 与 decidePending approved 等价）。
    const unblocked = (await ledgerEvents(h)).filter((event) => event.type === 'task.unblocked')
    expect(unblocked).toHaveLength(1)
    expect(unblocked[0]!.data).toMatchObject({ taskId: 'T1', pendingId: 'BL-1' })

    // 后续 flow_* 调用恢复：flow_verify 放行，写操作也恢复（任务范围仍受 R-SCOPE 约束）。
    expect((await h.engine.evaluateAction(FLOW_VERIFY, MAIN)).effect).toBe('allow')
    expect((await h.engine.evaluateAction(WRITE_SRC, MAIN)).effect).toBe('allow')

    // 通过一次 GREEN 验证后任务继续推进（失败计数保持 0）。
    h.runner.enqueue({ match: 'pnpm test', exitCode: 0, stdout: VITEST_PASS_STDOUT, summary: PASSING_SUMMARY })
    const green = await h.engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(green.exitCode).toBe(0)
    expect(h.engine.currentChange()?.tasks.T1?.failureCount).toBe(0)
  })

  it('多个 BL（同任务重复项 + 旧版无 taskId 残留）在解锁时一并关闭', async () => {
    const h = createHarness()
    const change = await reachS4WithRunningTask(h)
    await failVerify(h, 3)

    // 真实 run 的 BL-2..BL-8：旧版本没有 data.taskId；这里各造一条验证两种残留形态。
    await addOpenBlocker(h, change.id, { id: 'BL-2', data: { ruleId: 'T-FAILURE-LIMIT', tool: 'flow_status' } })
    await addOpenBlocker(h, change.id, { id: 'BL-3', data: { taskId: 'T1' } })
    expect(openBlockers(h.engine.currentChange()!)).toHaveLength(3)

    await h.engine.decidePending('BL-1', 'approved', '负责人确认继续')

    const after = h.engine.currentChange()!
    expect(openBlockers(after)).toHaveLength(0)
    for (const id of ['BL-1', 'BL-2', 'BL-3']) {
      const item = after.pending.find((entry) => entry.id === id)
      expect(item?.status, id).toBe('approved')
      expect(item?.decidedAt, id).toBeTruthy()
    }
    expect(after.pending.find((entry) => entry.id === 'BL-2')?.decisionReason).toContain('随 BL-1 一并解锁')
    expect(after.tasks.T1?.failureCount).toBe(0)
    expect(after.tasks.T1?.status).toBe('running')
    // 只写一条 task.unblocked，不重复记账。
    expect((await ledgerEvents(h)).filter((event) => event.type === 'task.unblocked')).toHaveLength(1)
  })

  it('负责人 reject 时不解锁：任务仍 blocked、失败计数不变', async () => {
    const h = createHarness()
    await reachS4WithRunningTask(h)
    await failVerify(h, 3)

    await h.engine.decidePending('BL-1', 'rejected', '先补复现步骤')
    const after = h.engine.currentChange()!
    expect(after.tasks.T1?.status).toBe('blocked')
    expect(after.tasks.T1?.failureCount).toBe(3)
    expect((await ledgerEvents(h)).filter((event) => event.type === 'task.unblocked')).toHaveLength(0)
    // 写操作仍被熔断拦截。
    expect((await h.engine.evaluateAction(WRITE_SRC, MAIN)).effect).toBe('human')
  })

  it('升级前卡死的真实 run（T1 blocked + BL-1..BL-8 全 open）可被一次 /flow unblock 恢复', async () => {
    const h = createHarness()
    await h.engine.init()
    const created = await h.engine.newChange({ title: '升级恢复演练', summary: '复刻真实 run 的 BL-1..BL-8' })

    // 复刻 docs/evaluation-data/.../flowgate/changes/C-001/status.json 的快照形态：
    // T1 blocked/failureCount=3；BL-1 是熔断项（data.taskId），BL-2..BL-8 是熔断后
    // 每个被拦动作各建一条的重复项（data.ruleId=T-FAILURE-LIMIT，没有 taskId）。
    const status = await readChangeStatus(h.fs, ROOT, created.changeId)
    expect(status).not.toBeNull()
    status!.stage = 'S4'
    status!.tasks = {
      T1: {
        id: 'T1',
        batch: 'B1',
        status: 'blocked',
        tdd: 'none',
        evidenceIds: [],
        reviewIds: [],
        startedAt: '2026-10-31T11:05:50+08:00',
        failureCount: 3,
        blockReason: '连续 3 次验证失败',
      },
    }
    status!.pending = [
      {
        id: 'BL-1',
        kind: 'blocker',
        changeId: created.changeId,
        title: 'T1 连续 3 次验证失败，已暂停',
        detail: '先复现、找根因、再修复；不要继续试错。负责人确认后继续。',
        status: 'open',
        createdAt: '2026-10-31T11:05:52+08:00',
        data: { taskId: 'T1' },
      },
      ...['read E-0003.log', 'flow_status', 'flow_report_risk', 'bash ls', 'read index.jsonl', 'read tasks.md', 'bash ls 2'].map(
        (label, index) => ({
          id: `BL-${index + 2}`,
          kind: 'blocker' as const,
          changeId: created.changeId,
          title: `T-FAILURE-LIMIT：${label}`,
          detail: 'T-FAILURE-LIMIT 需要负责人确认',
          status: 'open' as const,
          createdAt: '2026-10-31T11:06:00+08:00',
          data: { ruleId: 'T-FAILURE-LIMIT', stage: 'S4', tool: label.split(' ')[0] },
          scope: { changeId: created.changeId, ruleId: 'T-FAILURE-LIMIT', actionFingerprint: `sha256:${index}` },
        }),
      ),
    ]
    await writeChangeStatus(h.fs, ROOT, status!)
    await h.engine.refresh()
    expect(openBlockers(h.engine.currentChange()!)).toHaveLength(8)

    // 升级后的插件不会再为被拦动作新建 BL：仍复用 BL-1，总数保持 8。
    const decision = await h.engine.evaluateAction(WRITE_SRC, MAIN)
    expect(decision.effect).toBe('human')
    expect(decision.rule?.ruleId).toBe('T-FAILURE-LIMIT')
    expect(openBlockers(h.engine.currentChange()!)).toHaveLength(8)

    // 负责人一条命令解锁：失败计数清零、任务恢复、8 条 BL 全部关闭、后续 flow_* 恢复。
    await h.engine.decidePending('BL-1', 'approved', '解析器已修，确认继续')
    const after = h.engine.currentChange()!
    expect(openBlockers(after)).toHaveLength(0)
    expect(after.pending.filter((item) => item.status === 'approved')).toHaveLength(8)
    expect(after.tasks.T1).toMatchObject({ status: 'running', failureCount: 0 })
    expect(after.tasks.T1?.startedAt).toBe('2026-10-31T11:05:50+08:00')
    expect((await h.engine.evaluateAction(FLOW_VERIFY, MAIN)).effect).toBe('allow')
  })
})
