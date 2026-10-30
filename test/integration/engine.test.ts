/**
 * End-to-end engine tests: drive a whole change through S0 → S6 with the real
 * state machine, rules engine, ledger and store, and an injected gate checker
 * (artifact parsing is covered by test/core/artifacts).
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { FlowEngine, FlowGateError } from '../../src/core/engine'
import type { CheckOutcome, FlowgateConfig } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''

const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function createHarness(options: { gateChecker?: () => Promise<CheckOutcome[]>; config?: Partial<FlowgateConfig> } = {}): Promise<Harness> {
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
    ledgerKey: 'test-ledger-key',
    sessionId: 'session-test-1',
    sessionLabel: 'test',
    host: { gateChecker: options.gateChecker ?? ALL_PASS },
  })
  await engine.load()
  return { fs, clock, git, runner, engine }
}

async function writeArtifacts(fs: MemoryFileSystem, changeId: string, taskId = 'T1', tdd: 'required' | 'optional' = 'required'): Promise<void> {
  const base = `.flowgate/changes/${changeId}`
  await fs.writeFile(
    `${base}/clarify.md`,
    `# 澄清记录\n\n## 原始描述\n给会员加续费功能。\n\n## 已知事实\n- 会员到期日字段在 Membership.java:12-15。\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 | 支持续费 | 负责人 | 确认 |\n| 边界（做 / 不做） | 做续费，不做自动扣款 | 负责人 | 确认 |\n| 角色与权限 | 会员本人 | 负责人 | 确认 |\n| 验收标准 | 见增量规格 | proposal | 确认 |\n| 约束（非功能） | p95 < 300ms | 负责人 | 确认 |\n| 未知与假设 | 支付平台延迟 5 秒 | 假设 | 已接受 |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n| 到期日从哪天算？ | 当天/次日 | 次日 | 决定续费起算点 |\n\n## 已接受的假设\n- 支付回调在 5 秒内到达。\n\n## 未决问题\n`,
  )
  await fs.writeFile(`${base}/proposal.md`, `# 提案\n\n## 为什么\n会员需要续费。\n\n## 改什么\n新增续费接口。\n\n## 影响\nMemberService。\n\n## 不做\n不做自动扣款。\n`)
  await fs.writeFile(
    `${base}/specs/spec.md`,
    `## ADDED Requirements\n\n### Requirement: R1 续费\n系统 SHALL 允许会员续费。\n\n#### Scenario: R1.S1 续费成功\n- GIVEN 有效会员\n- WHEN 调用续费接口\n- THEN 到期日延长 30 天且 HTTP 200\n`,
  )
  await fs.writeFile(`${base}/context.md`, `# 上下文\n\n## 接口约束\n见 MemberService.java:20-30（p95 < 300ms）。\n\n## 数据模型\nMember 表。\n\n## 非功能要求\np95 < 300ms。\n`)
  await fs.writeFile(
    `${base}/design.md`,
    `# 设计\n\n## 方案对比\n\n### 方案 A 幂等表\n优点：可靠。缺点：多一张表。\n\n### 方案 B 唯一索引\n优点：简单。缺点：改动 DB。\n\n## 推荐方案\n方案 A，理由：可控。\n\n## 数据流\n接口 → 服务 → 幂等表。\n\n## 错误处理\n返回 409。\n\n## 回滚方案\n回滚迁移并保留旧接口。\n`,
  )
  await fs.writeFile(
    `${base}/risk.md`,
    `# 风险\n\n| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |\n|---|---|---|---|---|---|\n| 安全 | 高 | 回调可伪造 | 验签 | 单测 | 是 |\n| 性能 | 低 | 多一次查询 | 索引 | 压测 | 否 |\n| 成本 | 无 | 无外部调用 | — | — | 否 |\n| 合规 | 中 | 含手机号 | 脱敏 | 审查 | 否 |\n| 可维护性 | 中 | 规则分散 | 收拢 | 审查 | 否 |\n`,
  )
  await fs.writeFile(
    `${base}/tasks.md`,
    `# 任务\n\n## ${taskId} 实现续费\n\n\`\`\`yaml\ncovers: [R1.S1]\nscope: [src/**]\ntests: [test/**]\nnew_files: []\ndepends_on: []\ntdd: ${tdd}\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/**]\nsize: S\n\`\`\`\n\n实现续费逻辑。\n\n## T2 追加任务\n\n\`\`\`yaml\ncovers: [R1.S1]\nscope: [src/extra/**]\ntests: [test/extra/**]\nnew_files: [src/extra/**]\ndepends_on: [${taskId}]\ntdd: optional\ntdd_reason: 纯样式\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/extra/**]\nsize: S\n\`\`\`\n\n## 执行计划\n\n\`\`\`yaml\nexecution:\n  - batch: B1\n    mode: sequential\n    tasks: [${taskId}]\n    why: 唯一任务\n  - batch: B2\n    mode: parallel\n    tasks: [T2]\n    why: 与 T1 范围不重叠\n\`\`\`\n`,
  )
}

describe('FlowEngine pipeline', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  it('未初始化项目不拦截，init 后生成项目上下文', async () => {
    const before = await harness.engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(before.effect).toBe('allow')
    expect(harness.engine.isInitialized()).toBe(false)

    const result = await harness.engine.init()
    expect(result.ok).toBe(true)
    expect(harness.engine.isInitialized()).toBe(true)
    expect(harness.fs.listFiles()).toContain('.flowgate/config.yaml')
    expect(harness.fs.listFiles()).toContain('.flowgate/project.md')
    expect(harness.engine.snapshot().statusLine).toContain('FlowGate')
  })

  it('完整流程 S0 → S6：立项、四道人工门、任务门、归档', async () => {
    const { engine, fs } = harness
    await engine.init()
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    expect(created.changeId).toBe('C-001')
    expect(engine.currentChange()?.stage).toBe('S1')
    await writeArtifacts(fs, created.changeId)

    // G1 human gate
    const g1 = await engine.submitGate('G1')
    expect(g1.awaiting).toBe('owner')
    await engine.approveGate('G1')
    expect(engine.currentChange()?.stage).toBe('S2')

    // G2 auto gate
    const g2 = await engine.submitGate('G2')
    expect(g2.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S3')

    // G3 human gate
    const g3 = await engine.submitGate('G3')
    expect(g3.awaiting).toBe('owner')
    await engine.approveGate('G3')
    expect(engine.currentChange()?.stage).toBe('S4')
    expect(engine.currentChange()?.batches.map((batch) => batch.id)).toEqual(['B1', 'B2'])

    // Task 1: start, verify RED then GREEN (tdd required), review, done
    const start = await engine.taskStart('T1')
    expect(start.ok).toBe(true)
    expect(start.taskCard?.tdd).toBe('required')

    // Before RED, editing an implementation file is blocked by TDD ordering.
    const tddDenied = await engine.evaluateAction({ kind: 'write', tool: 'edit', path: 'src/impl.ts' }, { tool: 'edit', agentRole: 'main' })
    expect(tddDenied.effect).toBe('deny')

    harness.runner.enqueue({
      match: 'pnpm test',
      exitCode: 1,
      stdout: ' FAIL  test/renewal.test.ts > renewal\n AssertionError: expected 2026-12-01 but got 2026-12-02\n\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n',
    })
    const red = await engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(red.phase).toBe('red')
    expect(red.summary?.run).toBe(3)
    expect(red.summary?.failed).toBe(1)

    const green = await engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(green.phase).toBe('green')
    expect(engine.currentChange()?.tasks.T1?.tdd).toBe('green')

    // TDD ordering now allows implementation edits.
    const tddAllowed = await engine.evaluateAction({ kind: 'write', tool: 'edit', path: 'src/impl.ts' }, { tool: 'edit', agentRole: 'main' })
    expect(tddAllowed.effect).toBe('allow')

    const review = await engine.recordReview({ taskId: 'T1', kind: 'task', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: 'diff-1' })
    expect(review.verdict).toBe('pass')
    const done = await engine.taskDone('T1')
    expect(done.passed).toBe(true)
    expect(engine.currentChange()?.tasks.T1?.status).toBe('done')
    expect(harness.git.commits.length).toBe(1)

    // Task 2 lives in a parallel batch: it needs a passing checkpoint before G4.
    const start2 = await engine.taskStart('T2')
    expect(start2.ok).toBe(true)
    await engine.runVerify({ taskId: 'T2', group: 'unit' })
    await engine.recordReview({ taskId: 'T2', kind: 'task', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: 'diff-2' })
    const done2 = await engine.taskDone('T2')
    expect(done2.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S4')
    await engine.completeCheckpoint('B2', { ok: true, detail: '合并通过，全量测试通过' })

    // G4 auto + S5
    expect(engine.currentChange()?.stage).toBe('S5')

    // G5 auto gate
    const g5 = await engine.submitGate('G5')
    expect(g5.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S6')

    // G6 human gate then archive
    const g6 = await engine.submitGate('G6')
    expect(g6.awaiting).toBe('owner')
    await engine.approveGate('G6')
    expect(engine.currentChange()?.lifecycle).toBe('archived')
    const files = fs.listFiles()
    expect(files.some((file) => file.startsWith('.flowgate/archive/') && file.endsWith('C-001/status.json'))).toBe(true)
    expect(files.some((file) => file.startsWith('.flowgate/changes/C-001/'))).toBe(false)
  })

  it('S1 阶段写源码被规则拒绝，单次放行只生效一次', async () => {
    const { engine, fs } = harness
    await engine.init()
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const action = { kind: 'write' as const, tool: 'write', path: 'src/index.ts' }
    const denied = await engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('R-STAGE-SRC')

    await engine.allowOnce('R-STAGE-SRC', '紧急修复线上问题')
    const allowed = await engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })
    expect(allowed.effect).toBe('allow')
    expect(allowed.overrideUsed).toBeTruthy()

    const deniedAgain = await engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })
    expect(deniedAgain.effect).toBe('deny')

    // 受保护路径任何时候都拒绝
    const protectedWrite = await engine.evaluateAction({ kind: 'write', tool: 'write', path: '.flowgate/changes/C-001/status.json' }, { tool: 'write', agentRole: 'main' })
    expect(protectedWrite.effect).toBe('deny')
    void fs
  })

  it('范围变更：范围外写入被拒，申请获批后允许', async () => {
    const { engine, fs } = harness
    await engine.init()
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await writeArtifacts(fs, created.changeId, 'T1', 'optional')
    await engine.submitGate('G1')
    await engine.approveGate('G1')
    await engine.submitGate('G2')
    await engine.submitGate('G3')
    await engine.approveGate('G3')
    await engine.taskStart('T1')

    const outside = { kind: 'write' as const, tool: 'write', path: 'docs/other.md' }
    const denied = await engine.evaluateAction(outside, { tool: 'write', agentRole: 'main' })
    expect(denied.effect).not.toBe('allow')

    const pending = await engine.requestScopeChange({ taskId: 'T1', add: ['docs/**'], reason: '需要更新文档' })
    expect(pending.id).toMatch(/^SC-/)
    await engine.decidePending(pending.id, 'approved', '同意')
    const allowed = await engine.evaluateAction(outside, { tool: 'write', agentRole: 'main' })
    expect(allowed.effect).toBe('allow')
  })

  it('风险触发器转人工，批准后该次动作放行一次', async () => {
    const { engine, fs } = harness
    await engine.init()
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await writeArtifacts(fs, created.changeId)
    await engine.submitGate('G1')
    await engine.approveGate('G1')
    await engine.submitGate('G2')
    await engine.submitGate('G3')
    await engine.approveGate('G3')
    await engine.taskStart('T1')

    const dependencyEdit = { kind: 'write' as const, tool: 'write', path: 'pom.xml' }
    const decision = await engine.evaluateAction(dependencyEdit, { tool: 'write', agentRole: 'main' })
    expect(decision.effect).toBe('human')
    expect(decision.pendingDraft).toBeTruthy()
    const pending = engine.currentChange()?.pending.find((item) => item.status === 'open')
    expect(pending).toBeTruthy()
    await engine.decidePending(pending!.id, 'approved', '依赖评审通过')
    const allowed = await engine.evaluateAction(dependencyEdit, { tool: 'write', agentRole: 'main' })
    expect(allowed.effect).toBe('allow')
    expect(allowed.overrideUsed).toBeTruthy()
  })

  it('会话租约：另一个会话接管后旧会话写入被拒绝', async () => {
    const { engine, fs } = harness
    await engine.init()
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })

    const second = new FlowEngine({
      root: ROOT,
      fs,
      clock: harness.clock,
      git: harness.git,
      commandRunner: harness.runner,
      pluginVersion: '0.1.0',
      ledgerKey: 'test-ledger-key',
      sessionId: 'session-test-2',
      sessionLabel: 'other',
      host: { gateChecker: ALL_PASS },
    })
    await second.load()
    await expect(second.resumeChange('C-001')).rejects.toBeInstanceOf(FlowGateError)
    await second.resumeChange('C-001', { takeover: true })
    expect(second.currentChange()?.id).toBe('C-001')
  })

  it('pause 生成交接摘要并释放租约', async () => {
    const { engine } = harness
    await engine.init()
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const handoff = await engine.pauseChange()
    expect(handoff.text.length).toBeLessThanOrEqual(300)
    expect(engine.currentChange()).toBeNull()
  })

  it('账本被篡改后进入锁定模式，写操作被拒绝', async () => {
    const { engine, fs } = harness
    await engine.init()
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const ledgerPath = '.flowgate/state/ledger.jsonl'
    const lines = (await fs.readFile(ledgerPath)).split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThan(1)
    const tampered = [...lines]
    const parsed = JSON.parse(tampered[1]!) as { data: Record<string, unknown> }
    parsed.data.title = 'tampered'
    tampered[1] = JSON.stringify(parsed)
    await fs.writeFile(ledgerPath, `${tampered.join('\n')}\n`)

    const reloaded = new FlowEngine({
      root: ROOT,
      fs,
      clock: harness.clock,
      git: harness.git,
      commandRunner: harness.runner,
      pluginVersion: '0.1.0',
      ledgerKey: 'test-ledger-key',
      sessionId: 'session-test-1',
      host: { gateChecker: ALL_PASS },
    })
    await reloaded.load()
    expect(reloaded.snapshot().locked).toBe(true)
    const decision = await reloaded.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(decision.effect).toBe('deny')
  })
})
