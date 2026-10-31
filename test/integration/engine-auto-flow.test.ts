/**
 * v0.5 自动流程：模型自评 → 宿主 auto-review → 按 route 自动通过人工门。
 * 这里用真实 engine + 全通过 gateChecker，验证 fast/standard 的状态机行为。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

async function createHarness(): Promise<{ engine: FlowEngine; fs: MemoryFileSystem }> {
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
    sessionId: 'session-test-auto',
    sessionLabel: 'test',
    host: { gateChecker: ALL_PASS },
  })
  await engine.load()
  await engine.init()
  return { engine, fs }
}

const FAST = {
  route: 'fast' as const,
  autoApprove: true,
  clear: true,
  goal: '生成只读分享链接',
  acceptance: ['分享链接可打开同一份待办', '分享页禁止修改'],
  scope: ['src/share/**', 'test/share/**'],
  verify: 'pnpm test',
  reasons: ['需求清晰、范围小'],
}

describe('自动流程 fast：检查通过后自动通过 G1/G3/G6', () => {
  it('auto-review 批准后按 fast 自动进入 S4，检查通过即自动归档', async () => {
    const { engine } = await createHarness()
    const outcome = await engine.newChange({
      title: '给待办列表增加分享链接',
      summary: '生成只读分享链接',
      complexityHint: 'low',
      assessment: FAST,
    })
    expect(outcome.flowPlan?.route).toBe('fast')
    expect(outcome.flowPlan?.autoApprove).toBe(true)
    expect(outcome.flowPlan?.verdict).toBe('approved')
    expect(engine.snapshot().flowPlan?.route).toBe('fast')
    expect(engine.buildInjection().text).toContain('自动流程：fast')

    const g1 = await engine.submitGate('G1')
    expect(g1.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S2')
    expect(engine.currentChange()?.gates.G1?.approvedBy).toBe('auto')

    const g2 = await engine.submitGate('G2')
    expect(g2.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S3')

    const g3 = await engine.submitGate('G3')
    expect(g3.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S4')
    expect(engine.currentChange()?.gates.G3?.approvedBy).toBe('auto')
    expect(engine.currentChange()?.gates.G3?.approvedAt).toBeDefined()

    // 直接推进到 S6 模拟交付（任务门等由其他测试覆盖）。
    const change = engine.currentChange()!
    change.stage = 'S6'
    change.gates.G5 = { state: 'passed', attempts: 1 }
    const g6 = await engine.submitGate('G6')
    expect(g6.passed).toBe(true)
    expect(change.lifecycle).toBe('archived')
    expect(change.gates.G6?.approvedBy).toBe('auto')

  })

  it('高风险 self-assessment 被 auto-review 降级为 full，不自动放行', async () => {
    const { engine } = await createHarness()
    const outcome = await engine.newChange({
      title: '支付回调幂等',
      complexityHint: 'high',
      riskHint: 'high',
      assessment: { ...FAST, route: 'fast' },
    })
    expect(outcome.flowPlan?.route).toBe('full')
    expect(outcome.flowPlan?.autoApprove).toBe(false)
    expect(outcome.flowPlan?.verdict).toBe('adjusted')
    const g1 = await engine.submitGate('G1')
    expect(g1.awaiting).toBe('owner')
  })
})

describe('自动流程 standard：合并 G1+G3 为一次人工确认', () => {
  it('G1 自动过、G3 等负责人一次确认，批准后同时批准 G1 并进入 S4', async () => {
    const { engine } = await createHarness()
    const outcome = await engine.newChange({
      title: '给设置页增加导出按钮',
      complexityHint: 'medium',
      assessment: { route: 'standard', clear: true, reasons: ['中等需求，合并确认'] },
    })
    expect(outcome.flowPlan?.route).toBe('standard')
    expect(outcome.flowPlan?.autoApprove).toBe(false)

    const g1 = await engine.submitGate('G1')
    expect(g1.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S2')

    await engine.submitGate('G2')
    const g3 = await engine.submitGate('G3')
    expect(g3.awaiting).toBe('owner')
    expect(engine.currentChange()?.stage).toBe('S3')

    const approved = await engine.approveGate('G3')
    expect(approved.passed).toBe(true)
    expect(engine.currentChange()?.stage).toBe('S4')
    expect(engine.currentChange()?.gates.G1?.approvedAt).toBeDefined()
  })
})

describe('负责人覆盖自动流程路由', () => {
  it('/flow route fast 在低复杂度 · 普通风险时生效，并写入账本', async () => {
    const { engine } = await createHarness()
    await engine.newChange({
      title: '给设置页增加导出按钮',
      complexityHint: 'low',
      assessment: { route: 'standard', reasons: ['先合并确认'] },
    })
    const message = await engine.setFlowRoute('fast', '负责人决定直接自动')
    expect(message).toContain('fast')
    expect(engine.currentChange()?.flowPlan?.route).toBe('fast')
    expect(engine.currentChange()?.flowPlan?.autoApprove).toBe(true)
    expect(engine.currentChange()?.flowPlan?.assessedBy).toBe('owner-override')
  })

  it('有等待批准的人工门时拒绝覆盖，避免留下过期授权卡片', async () => {
    const { engine } = await createHarness()
    await engine.newChange({ title: '等待确认的需求', complexityHint: 'low', assessment: { route: 'standard' } })
    await engine.submitGate('G1')
    await engine.submitGate('G2')
    await engine.submitGate('G3')
    expect(engine.currentChange()?.gates.G3?.state).toBe('awaiting')
    await expect(engine.setFlowRoute('fast', '强行切换')).rejects.toThrow('尚未处理')
  })

  it('fast 覆盖受低复杂度 · 普通风险约束', async () => {
    const { engine } = await createHarness()
    await engine.newChange({ title: '大改造', complexityHint: 'medium', assessment: { route: 'standard' } })
    await expect(engine.setFlowRoute('fast', '强行自动')).rejects.toThrow('fast 自动流程只适用于低复杂度')
  })
})
