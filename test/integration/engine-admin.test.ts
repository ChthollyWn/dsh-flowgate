/**
 * Engine administration paths: doctor / repair / metrics / report / board,
 * pending decisions (scope, risk, plan, rule), levels, exceptions, off/on,
 * postcheck violations and analysis tasks.
 */
import { describe, it, expect } from 'vitest'

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
  await fs.writeFile('src/index.ts', 'line1\nline2\nline3\nexport const answer = 42\n')
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
    ledgerKey: 'admin-key',
    sessionId: 'session-admin',
    sessionLabel: 'admin',
    host: { gateChecker },
  })
  await engine.load()
  return { fs, clock, git, runner, engine }
}

async function toS4(h: Harness): Promise<string> {
  const { engine, fs } = h
  await engine.init()
  const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
  const base = `.flowgate/changes/${created.changeId}`
  await fs.writeFile(`${base}/specs/spec.md`, '## ADDED Requirements\n\n### Requirement: R1 续费\n系统 SHALL 续费。\n\n#### Scenario: R1.S1 成功\n- GIVEN 会员\n- WHEN 续费\n- THEN HTTP 200\n')
  await fs.writeFile(
    `${base}/tasks.md`,
    '## T1 实现\n\n```yaml\ncovers: [R1.S1]\nscope: [src/index.ts]\ntests: [test/index.test.ts]\nnew_files: []\ndepends_on: []\ntdd: optional\ntdd_reason: 文档\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/index.ts]\nsize: S\nrun: main\n```\n\n## 执行计划\n\n```yaml\nexecution:\n  - batch: B1\n    mode: sequential\n    tasks: [T1]\n    why: 单任务\n```\n',
  )
  await engine.submitGate('G1')
  await engine.approveGate('G1')
  await engine.submitGate('G2')
  await engine.submitGate('G3')
  await engine.approveGate('G3')
  return created.changeId
}

describe('engine administration', () => {
  it('doctor 报告健康状态与覆盖自检', async () => {
    const h = await harness()
    await h.engine.init()
    const report = await h.engine.doctor()
    expect(report.initialized).toBe(true)
    expect(report.ledgerOk).toBe(true)
    expect(report.pluginVersion).toBe('0.1.0')
    expect(report.configOk).toBe(true)
    expect(report.message).toContain('正常')
  })

  it('repair 从账本与产物重建 status.json 与台账', async () => {
    const h = await harness()
    await toS4(h)
    const changeId = h.engine.currentChange()!.id
    await h.fs.remove(`.flowgate/changes/${changeId}/status.json`)
    await h.fs.remove('.flowgate/changes/index.md')
    const result = await h.engine.repair()
    expect(result.ok).toBe(true)
    expect(h.fs.listFiles()).toContain(`.flowgate/changes/${changeId}/status.json`)
    expect(h.fs.listFiles()).toContain('.flowgate/changes/index.md')
    expect(h.engine.currentChange()?.id).toBe(changeId)
  })

  it('off / on 记录账本并改变注入文本', async () => {
    const h = await harness()
    await h.engine.init()
    await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await h.engine.setOff(true, '调试')
    expect(h.engine.snapshot().off).toBe(true)
    expect(h.engine.buildInjection().text).toContain('关闭')
    const decision = await h.engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(decision.effect).toBe('allow')
    await h.engine.setOff(false)
    expect(h.engine.snapshot().off).toBe(false)
  })

  it('等级调整：降低必须写理由；提高风险退回 S4', async () => {
    const h = await harness()
    await toS4(h)
    await expect(h.engine.changeComplexity('low')).rejects.toThrow('理由')
    await h.engine.changeComplexity('low', '只是改文案')
    expect(h.engine.currentChange()?.complexity).toBe('low')
    // move to S5 artificially via task flow is covered elsewhere; raising risk from S4 still works.
    await h.engine.changeRiskLevel('high', '触及支付')
    expect(h.engine.currentChange()?.risk).toBe('high')
  })

  it('例外：加入后可反复放行，撤销后恢复拦截', async () => {
    const h = await harness()
    await h.engine.init()
    await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const action = { kind: 'write' as const, tool: 'write', path: 'src/index.ts' }
    expect((await h.engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })).effect).toBe('deny')
    const exception = await h.engine.addException('R-STAGE-SRC', 'src/**', '该文件属于需求澄清的证据')
    expect((await h.engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })).effect).toBe('allow')
    await h.engine.revokeException(exception.id, '例外到期')
    expect((await h.engine.evaluateAction(action, { tool: 'write', agentRole: 'main' })).effect).toBe('deny')
  })

  it('计划修订与规则沉淀：待处理项生命周期', async () => {
    const h = await harness()
    await toS4(h)
    const planRequest = await h.engine.requestPlanChange({ add: ['T9'], reason: '发现遗漏任务' })
    expect(planRequest.id).toMatch(/^PC-/)
    await h.engine.decidePending(planRequest.id, 'approved', '同意追加')
    const rule = await h.engine.proposeRule({ finding: '重复代码', rule: '抽公共函数', example: 'extract()', scope: 'S4' })
    await h.engine.decidePending(rule.id, 'approved', '沉淀')
    const files = h.fs.listFiles()
    expect(files.some((file) => file.startsWith('.flowgate/rules/'))).toBe(true)
    await expect(h.engine.decidePending(rule.id, 'approved')).rejects.toThrow('已经处理')
  })

  it('事后检测：范围外改动记为越界，撤销后清除', async () => {
    const h = await harness()
    await toS4(h)
    await h.engine.taskStart('T1')
    const violations = await h.engine.recordPostcheck({ origin: 'agent', changedPaths: ['docs/other.md'], taskId: 'T1' })
    expect(violations.length).toBe(1)
    expect(h.engine.currentChange()?.violations.length).toBe(1)
    const cleared = await h.engine.clearViolation('docs/other.md')
    expect(cleared).toBe(true)
    // External edits are recorded separately, not as violations.
    await h.engine.recordPostcheck({ origin: 'external', changedPaths: ['src/index.ts'], taskId: 'T1' })
    expect(h.engine.currentChange()?.externalChanges?.length).toBe(1)
  })

  it('指标、HTML 报告与看板可生成且离线可用', async () => {
    const h = await harness()
    await toS4(h)
    await h.engine.taskStart('T1')
    await h.engine.runVerify({ taskId: 'T1', group: 'unit' })
    const metrics = await h.engine.generateMetrics()
    expect(metrics.metrics['M-1']).toBeDefined()
    const report = await h.engine.generateReport()
    expect(report.html).toContain('<!DOCTYPE html>')
    expect(report.html).toContain('FlowGate')
    expect(report.html.length).toBeLessThan(2 * 1024 * 1024)
    expect(h.fs.listFiles()).toContain(report.path)
    const board = await h.engine.generateBoard()
    expect(board.html).toContain('<!DOCTYPE html>')
    expect(h.fs.listFiles()).toContain('.flowgate/dashboard.html')
  })

  it('分析任务：引用核验通过后归档，引用不成立时拒绝', async () => {
    const h = await harness()
    await h.engine.init()
    const created = await h.engine.newChange({ title: '为什么到期日多一天', kind: 'analysis', reason: '排查 bug' })
    expect(created.changeId).toMatch(/^A-/)
    const bad = await h.engine.submitAnalysis({
      conclusion: '时区问题',
      proposal: '用 UTC 存储',
      limitations: [],
      citations: [{ file: 'src/index.ts', startLine: 900, endLine: 901 }],
    })
    expect(bad.ok).toBe(false)
    expect(bad.archived).toBe(false)
    const good = await h.engine.submitAnalysis({
      conclusion: '时区问题',
      proposal: '用 UTC 存储',
      limitations: ['未验证数据库时区'],
      citations: [{ file: 'src/index.ts', startLine: 1, endLine: 2, quote: 'line1' }],
    })
    expect(good.ok).toBe(true)
    expect(good.archived).toBe(true)
    expect(h.fs.listFiles().some((file) => file.startsWith('.flowgate/archive/') && file.endsWith('/analysis.md'))).toBe(true)
  })

  it('集成检查点失败生成待处理项；dispatchNext 顺序派发', async () => {
    const h = await harness()
    await h.engine.init()
    const created = await h.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const base = `.flowgate/changes/${created.changeId}`
    await h.fs.writeFile(`${base}/tasks.md`, '## T1 实现\n\n```yaml\ncovers: [R1.S1]\nscope: [src/index.ts]\ntests: [test/index.test.ts]\nnew_files: []\ndepends_on: []\ntdd: optional\ntdd_reason: 文档\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/index.ts]\nsize: S\nrun: subagent\nrun_reason: 需要独立上下文\n```\n\n## T2 实现\n\n```yaml\ncovers: [R1.S1]\nscope: [src/other.ts]\ntests: [test/other.test.ts]\nnew_files: []\ndepends_on: [T1]\ntdd: optional\ntdd_reason: 文档\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/other.ts]\nsize: S\nrun: main\n```\n\n## 执行计划\n\n```yaml\nexecution:\n  - batch: B1\n    mode: sequential\n    tasks: [T1]\n    why: 先行\n  - batch: B2\n    mode: parallel\n    tasks: [T2]\n    why: 可并行\n```\n')
    await h.engine.submitGate('G1')
    await h.engine.approveGate('G1')
    await h.engine.submitGate('G2')
    await h.engine.submitGate('G3')
    await h.engine.approveGate('G3')
    const dispatch = await h.engine.dispatchNext()
    expect(dispatch.dispatched.map((item) => item.taskId)).toEqual(['T1'])
    expect(dispatch.dispatched[0]?.mode).toBe('sequential')
    await h.engine.setTaskWorktree('T1', '.flowgate/worktrees/C-001/T1', 'child-1')
    await h.engine.taskFailed('T1', '子 agent 超时')
    expect(h.engine.currentChange()?.tasks.T1?.status).toBe('failed')
    expect(h.engine.currentChange()?.pending.some((item) => item.title.includes('T1'))).toBe(true)
    await h.engine.completeCheckpoint('B1', { ok: false, detail: '合并冲突' })
    expect(h.engine.currentChange()?.pending.some((item) => item.kind === 'conflict')).toBe(true)
  })
})
