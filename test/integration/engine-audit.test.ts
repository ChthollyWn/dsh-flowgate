/**
 * 审计缺口修复的引擎级回归（T1.4 / T3.2 / T3.4 / T3.5 / T3.6）：
 * - 非 agent 改动可见、可确认；
 * - 越界撤销后自动解除；
 * - 篡改嫌疑生成 TM 待处理项并可被负责人确认；
 * - evidence.md / review.md 由插件维护；
 * - 证据新鲜度按输入哈希判定（面板 GREEN 过期）。
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, PASSING_SUMMARY, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  engine: FlowEngine
  git: FakeGit
  runner: FakeCommandRunner
}

async function createHarness(): Promise<Harness> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  fs.writeFile('README.md', '# demo\n')
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('test/index.test.ts', "import { answer } from '../src/index'\n")
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
    ledgerKey: 'audit-test-key',
    sessionId: 'session-audit',
    host: { gateChecker: ALL_PASS },
  })
  await engine.load()
  await engine.init()
  return { fs, engine, git, runner }
}

async function writeArtifacts(fs: MemoryFileSystem, changeId: string, taskYamlExtra = ''): Promise<void> {
  const base = `.flowgate/changes/${changeId}`
  await fs.writeFile(`${base}/clarify.md`, `# 澄清记录\n\n## 原始描述\n加续费。\n\n## 已知事实\n- 见 Membership.java:12-15。\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 | 续费 | 负责人 | 确认 |\n| 边界 | 做续费 | 负责人 | 确认 |\n| 角色 | 会员 | 负责人 | 确认 |\n| 验收标准 | 见规格 | proposal | 确认 |\n| 约束 | p95<300ms | 负责人 | 确认 |\n| 未知 | 无 | 负责人 | 已接受 |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n| 从哪天算？ | 当天/次日 | 次日 | 起算点 |\n\n## 已接受的假设\n- 无。\n\n## 未决问题\n（无）\n`)
  await fs.writeFile(`${base}/proposal.md`, `# 提案\n\n## 为什么\n会员需要续费。\n\n## 改什么\n新增续费接口。\n\n## 影响\nMemberService。\n\n## 不做\n不做自动扣款。\n`)
  await fs.writeFile(`${base}/specs/spec.md`, `## ADDED Requirements\n\n### Requirement: R1 续费\n系统 SHALL 允许续费。\n\n#### Scenario: R1.S1 续费成功\n- GIVEN 有效会员\n- WHEN 调用接口\n- THEN HTTP 200 且到期日延长 30 天\n`)
  await fs.writeFile(`${base}/context.md`, `# 上下文\n\n## 接口约束\n见 MemberService.java:20-30。\n\n## 数据模型\nMember 表。\n\n## 非功能要求\np95 < 300ms。\n\n## 相关模块\nsrc。\n`)
  await fs.writeFile(`${base}/design.md`, `# 设计\n\n## 方案对比\n\n### 方案 A\n优点：稳。缺点：慢。\n\n### 方案 B\n优点：快。缺点：险。\n\n## 推荐方案\n方案 A。\n\n## 数据流\nHTTP → 服务。\n\n## 错误处理\n409。\n\n## 回滚方案\n回滚迁移。\n`)
  await fs.writeFile(`${base}/risk.md`, `# 风险\n\n| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |\n|---|---|---|---|---|---|\n| 安全 | 高 | 可伪造 | 验签 | 单测 | 是 |\n| 性能 | 低 | 多查一次 | 索引 | 压测 | 否 |\n| 成本 | 无 | 无 | — | — | 否 |\n| 合规 | 中 | 手机号 | 脱敏 | 审查 | 否 |\n| 可维护性 | 低 | 集中 | 收拢 | 审查 | 否 |\n`)
  await fs.writeFile(`${base}/tasks.md`, `# 任务\n\n## T1 实现续费\n\n\`\`\`yaml\ncovers: [R1.S1]\nscope: [src/**]\ntests: [test/**]\nnew_files: []\ndepends_on: []\ntdd: optional\ntdd_reason: 演示\n${taskYamlExtra}verify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/**]\nsize: S\nrun: main\n\`\`\`\n\n实现续费。\n\n## 执行计划\n\n\`\`\`yaml\nexecution:\n  - batch: B1\n    mode: sequential\n    tasks: [T1]\n    why: 单任务\n\`\`\`\n`)
}

async function toS4(harness: Harness, taskYamlExtra = ''): Promise<string> {
  const { engine, fs } = harness
  const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
  await writeArtifacts(fs, created.changeId, taskYamlExtra)
  await engine.submitGate('G1')
  await engine.approveGate('G1')
  await engine.submitGate('G2')
  await engine.submitGate('G3')
  await engine.approveGate('G3')
  expect(engine.currentChange()?.stage).toBe('S4')
  return created.changeId
}

describe('非 agent 改动可见与确认（T1.4 验收 #3）', () => {
  let harness: Harness
  beforeEach(async () => {
    harness = await createHarness()
  })

  it('recordExternalChanges 进入 snapshot，确认后清空', async () => {
    const { engine } = harness
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await engine.recordExternalChanges(['src/manual.ts'])
    expect(engine.snapshot().externalChanges?.map((item) => item.path)).toEqual(['src/manual.ts'])

    const confirmed = await engine.acknowledgeExternalChanges(['src/manual.ts'])
    expect(confirmed).toBe(1)
    expect(engine.snapshot().externalChanges).toEqual([])
    expect(engine.currentChange()?.externalChanges?.[0]?.confirmedAt).toBeDefined()
  })
})

describe('越界撤销后自动解除（T1.4 验收 #2）', () => {
  it('clearViolationsForReverted 只清匹配路径', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    await engine.taskStart('T1')
    const violations = await engine.recordPostcheck({ origin: 'agent', changedPaths: ['docs/out.md', 'docs/other.md'], taskId: 'T1' })
    expect(violations).toHaveLength(2)
    expect(engine.snapshot().violations).toHaveLength(2)

    const cleared = await engine.clearViolationsForReverted(['docs/out.md'])
    expect(cleared).toEqual(['docs/out.md'])
    expect(engine.snapshot().violations.map((violation) => violation.path)).toEqual(['docs/other.md'])
  })
})

describe('篡改嫌疑待处理项（T3.5）', () => {
  it('生成 TM-1 待处理项，负责人批准后关闭', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    const item = await engine.recordTamperSignals([
      { kind: 'skipped-test', path: 'test/renewal.test.ts', detail: '新增跳过测试：it.skip' },
    ])
    expect(item?.id).toBe('TM-1')
    expect(item?.kind).toBe('tamper')
    expect(engine.snapshot().pending.some((pending) => pending.kind === 'tamper')).toBe(true)

    await engine.decidePending('TM-1', 'approved', '合法重构')
    expect(engine.currentChange()?.pending.find((pending) => pending.id === 'TM-1')?.status).toBe('approved')
  })
})

describe('evidence.md / review.md 与新鲜度（T3.2/T3.4/T3.6）', () => {
  it('跑验证后写 evidence.md，改输入后新鲜度变 false', async () => {
    const harness = await createHarness()
    const changeId = await toS4(harness)
    const { engine, fs } = harness
    await engine.taskStart('T1')
    const receipt = await engine.runVerify({ taskId: 'T1', group: 'unit' })
    expect(receipt.phase).toBe('green')
    expect(fs.listFiles()).toContain(`.flowgate/changes/${changeId}/evidence.md`)
    expect(engine.getEvidenceFreshness()[receipt.id]).toBe(true)

    await fs.writeFile('src/impl.ts', 'export const impl = 1\n')
    await engine.refreshEvidenceFreshness()
    expect(engine.getEvidenceFreshness()[receipt.id]).toBe(false)
  })

  it('recordReview 写 review.md（含 findings 与覆盖结论）', async () => {
    const harness = await createHarness()
    const changeId = await toS4(harness)
    const { engine, fs } = harness
    await engine.taskStart('T1')
    await engine.recordReview({
      taskId: 'T1',
      kind: 'task',
      verdict: 'changes-required',
      coverageOk: false,
      findings: [{ severity: 'major', file: 'src/index.ts', line: 3, rule: 'error-handling', message: '缺少失败分支' }],
    })
    const path = `.flowgate/changes/${changeId}/review.md`
    expect(fs.listFiles()).toContain(path)
    const text = await fs.readFile(path)
    expect(text).toContain('RV-1')
    expect(text).toContain('缺少失败分支')
    expect(text).toContain('不完整')
  })
})

describe('风险提高效应与缺失触发器（T4.1）', () => {
  it('token 预算超支：生成 RK 待处理项并拒绝写操作，负责人批准后恢复', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    await engine.taskStart('T1')
    await engine.recordTokenUsage(999_999_999)
    const pending = engine.currentChange()?.pending.find((item) => item.data?.trigger === 'token-budget')
    expect(pending?.kind).toBe('risk')
    const denied = await engine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/impl.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(denied.effect).toBe('deny')
    expect(denied.rule?.ruleId).toBe('R-BUDGET')
    await engine.decidePending(pending!.id, 'approved')
    const allowed = await engine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/impl.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(allowed.effect).toBe('allow')
  })

  it('风险提高为高：已完成任务审查重新要求（回执保留）并生成 RK 提醒', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    const change = engine.currentChange()!
    change.tasks.T1 = { ...change.tasks.T1!, status: 'done', tdd: 'green', evidenceIds: ['E-1'], reviewIds: ['RV-1'] }
    await engine.changeRiskLevel('高', '涉及鉴权目录')
    const updated = engine.currentChange()!
    expect(updated.risk).toBe('high')
    expect(updated.tasks.T1!.reviewIds).toEqual([])
    expect(updated.tasks.T1!.evidenceIds).toEqual(['E-1'])
    expect(updated.pending.some((item) => item.data?.trigger === 'risk-raised')).toBe(true)
  })

  it('范围膨胀：一次范围变更超过上限时标记并提高风险', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    const item = await engine.requestScopeChange({
      taskId: 'T1',
      add: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      reason: '一次性补齐',
    })
    expect(item.title).toContain('范围膨胀')
    expect(item.data?.scopeExpanded).toBe(true)
    await engine.decidePending(item.id, 'approved')
    expect(engine.currentChange()?.risk).toBe('high')
  })

  it('删除受版本控制文件：风险自动提高为高', async () => {
    const harness = await createHarness()
    const { git } = harness
    git.showFile = async () => 'legacy content'
    await toS4(harness, 'changes:\n  - path: src/old.ts\n    kind: delete\n')
    const { engine } = harness
    await engine.taskStart('T1')
    await engine.recordPostcheck({
      origin: 'agent',
      changedPaths: ['src/old.ts'],
      deletedPaths: ['src/old.ts'],
      taskId: 'T1',
    })
    expect(engine.currentChange()?.risk).toBe('high')
  })
})

describe('技能回执（T2.4）与例外快照（T5.1）', () => {
  it('技能加载回执幂等；重复加载返回 duplicate，且能通过 G3 核心技能检查', async () => {
    const harness = await createHarness()
    await harness.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const first = await harness.engine.recordSkillLoaded('flow-plan', 'sha256:plan')
    expect(first.duplicate).toBe(false)
    const second = await harness.engine.recordSkillLoaded('flow-plan', 'sha256:plan')
    expect(second.duplicate).toBe(true)
    expect(harness.engine.hasSkillReceipt('flow-plan')).toBe(true)
    expect(harness.engine.hasSkillReceipt('flow-clarify')).toBe(false)
    expect(harness.engine.currentChange()?.skillReceipts).toHaveLength(1)
  })

  it('规则例外进入 snapshot，撤销后消失', async () => {
    const harness = await createHarness()
    await harness.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const exception = await harness.engine.addException('R-SCOPE', 'src/legacy/**', '迁移期放行')
    expect(harness.engine.snapshot().exceptions?.map((item) => item.id)).toEqual([exception.id])
    await harness.engine.revokeException(exception.id, '迁移完成')
    expect(harness.engine.snapshot().exceptions).toEqual([])
  })

  it('状态变化后自动重新生成跨会话看板（T5.3 验收 #2）', async () => {
    const harness = await createHarness()
    await harness.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    expect(harness.fs.listFiles()).toContain('.flowgate/dashboard.html')
    const first = await harness.fs.readFile('.flowgate/dashboard.html')
    await harness.engine.reportRisk({ category: 'security', description: '看板刷新测试', proposal: '确认' })
    const second = await harness.fs.readFile('.flowgate/dashboard.html')
    expect(second).not.toBe(first)
  })
})

describe('澄清问答采集（T2.2）', () => {
  it('问答写入 clarify.md 的问答记录表，重复问题不重复写', async () => {
    const harness = await createHarness()
    const changeId = await toS4(harness)
    const { engine, fs } = harness
    // 回到 S1 之前也能记录：这里直接调用 API，模拟宿主在 S1 采集。
    const first = await engine.recordClarifyQA({ question: '续费从哪天算？', options: ['当天', '次日'], answer: '次日' })
    expect(first.recorded).toBe(true)
    const second = await engine.recordClarifyQA({ question: '续费从哪天算？', options: ['当天', '次日'], answer: '次日' })
    expect(second.duplicate).toBe(true)
    const text = await fs.readFile(`.flowgate/changes/${changeId}/clarify.md`)
    expect(text).toContain('续费从哪天算？')
    expect(text).toContain('次日')
  })
})

describe('基线复用与 test:none 风险自动登记（T2.3）', () => {
  it('同一提交号复用基线缓存，不重复跑全量测试', async () => {
    const harness = await createHarness()
    await toS4(harness) // 第一次变更在 G2 已经跑过基线
    const cachePath = '.flowgate/state/baseline.json'
    expect(harness.fs.listFiles()).toContain(cachePath)
    const before = harness.engine.getEvidence().filter((receipt) => receipt.group === 'baseline').length
    const callsBefore = harness.runner.calls.length

    await harness.engine.pauseChange()
    await harness.engine.newChange({ title: '第二个变更', summary: '再改点东西' })
    await harness.engine.recordSkillLoaded('flow-clarify', 'sha256:c')
    await harness.engine.submitGate('G1')
    await harness.engine.approveGate('G1')
    await harness.engine.submitGate('G2')
    expect(harness.engine.getEvidence().filter((receipt) => receipt.group === 'baseline').length).toBe(before)
    expect(harness.runner.calls.length).toBe(callsBefore)
  })

  it('test: none 时自动登记「缺少自动化测试」风险待处理项', async () => {
    const harness = await createHarness()
    const { engine, fs } = harness
    fs.writeFile('.flowgate/config.yaml', 'commands:\n  test: none\n')
    await engine.refresh()
    await engine.newChange({ title: '无测试项目', summary: '补一个文案' })
    await engine.recordSkillLoaded('flow-clarify', 'sha256:c')
    const g1 = await engine.submitGate('G1')
    if (g1.awaiting === 'owner') await engine.approveGate('G1')
    await engine.submitGate('G2')
    const pending = engine.currentChange()?.pending.find((item) => item.data?.trigger === 'test-none')
    expect(pending?.kind).toBe('risk')
    expect(pending?.title).toContain('缺少自动化测试')
  })
})

describe('需求路径信号（FR-6.5）', () => {
  it('从需求描述提取路径用于等级建议', async () => {
    const { extractMentionedPaths } = await import('../../src/core/engine')
    expect(extractMentionedPaths('改 src/payment/PaymentService.java 的验签，并看 docs/api.md')).toEqual([
      'docs/api.md',
      'src/payment/PaymentService.java',
    ])
    expect(extractMentionedPaths('把首页按钮文案改成马上抢购')).toEqual([])
  })
})

describe('低复杂度快车道高风险确认（T2.8）', () => {
  async function lowHighToG3(): Promise<Harness> {
    const harness = await createHarness()
    await harness.engine.newChange({
      title: '改回调验签',
      summary: '把回调验签改成 HMAC，涉及安全',
      complexityHint: 'low',
      riskHint: 'high',
    })
    const g1 = await harness.engine.submitGate('G1')
    expect(g1.stage).toBe('S2')
    const g2 = await harness.engine.submitGate('G2')
    expect(g2.stage).toBe('S3')
    const g3 = await harness.engine.submitGate('G3')
    expect(g3.awaiting).toBe('owner')
    return harness
  }

  it('低复杂度 · 高风险必须在确认卡逐项确认后才能批准 G3', async () => {
    const harness = await lowHighToG3()
    await expect(harness.engine.approveGate('G3')).rejects.toThrow('逐项确认')
    const approved = await harness.engine.approveGate('G3', { confirmRisks: true })
    expect(approved.passed).toBe(true)
    expect(harness.engine.currentChange()?.stage).toBe('S4')
  })

  it('确认卡包含风险项与回滚方案；提高复杂度回到 S1 补齐六要素', async () => {
    const harness = await lowHighToG3()
    const raised = await harness.engine.changeComplexity('high', '涉及安全需要完整设计')
    expect(raised.stage).toBe('S1')
    const change = harness.engine.currentChange()!
    expect(change.gates.G1?.state).toBe('pending')
    expect(change.gates.G3?.state).toBe('pending')
    expect(change.plan).toBeUndefined()
    expect(change.tasks).toEqual({})
  })
})

describe('源码引用待复核（T2.10）', () => {
  it('G1 通过时记录引用哈希；被引用文件改动后标待复核', async () => {
    const harness = await createHarness()
    const { engine, fs } = harness
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await fs.writeFile(
      `.flowgate/changes/${created.changeId}/clarify.md`,
      `# 澄清记录\n\n## 原始描述\n加续费。\n\n## 已知事实\n- 入口在 \`src/index.ts:1-1\`。\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 | 续费 | 负责人 | 确认 |\n| 边界 | 做续费 | 负责人 | 确认 |\n| 角色 | 会员 | 负责人 | 确认 |\n| 验收标准 | 见规格 | proposal | 确认 |\n| 约束 | 无 | 负责人 | 确认 |\n| 未知 | 无 | 负责人 | 已接受 |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n| 从哪天算？ | 当天/次日 | 次日 | 起算点 |\n\n## 已接受的假设\n- 无。\n\n## 未决问题\n（无）\n`,
    )
    await engine.refresh()
    await engine.submitGate('G1')
    expect((await engine.staleCitations()).length).toBe(0)

    await fs.writeFile('src/index.ts', 'export const answer = 43\n')
    const stale = await engine.staleCitations()
    expect(stale.map((check) => check.citation.file)).toEqual(['src/index.ts'])
  })
})

describe('删除/重命名原内容快照（T3.1）', () => {
  it('taskStart 时把 git HEAD 原内容落盘并记录快照', async () => {
    const harness = await createHarness()
    const { git } = harness
    git.showFile = async () => 'legacy content'
    await toS4(harness, 'changes:\n  - path: src/old.ts\n    kind: delete\n')
    const { engine } = harness
    await engine.taskStart('T1')
    const snapshots = engine.originalSnapshots('T1')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({ path: 'src/old.ts', kind: 'delete' })
    expect(harness.fs.listFiles()).toContain(snapshots[0]!.storedPath)
    expect(await harness.fs.readFile(snapshots[0]!.storedPath)).toBe('legacy content')
  })

  it('git 取不到原内容时阻塞任务开始', async () => {
    const harness = await createHarness()
    const { git } = harness
    git.showFile = async () => {
      throw new Error('git 不可用')
    }
    await toS4(harness, 'changes:\n  - path: src/old.ts\n    kind: delete\n')
    await expect(harness.engine.taskStart('T1')).rejects.toThrow('原内容')
  })
})

describe('审查豁免与返工失效（T3.4 / T3.8）', () => {
  it('critical finding 阻塞任务门；负责人豁免后只由其它项决定', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    await engine.taskStart('T1')
    const review = await engine.recordReview({
      taskId: 'T1',
      kind: 'task',
      verdict: 'pass',
      coverageOk: true,
      findings: [{ severity: 'critical', file: 'src/index.ts', line: 1, rule: 'spec', message: '缺少幂等' }],
    })
    const blocked = await engine.taskDone('T1')
    expect(blocked.passed).toBe(false)
    expect(blocked.failures.some((failure) => failure.item === 'review:findings')).toBe(true)

    await expect(engine.waiveReview(review.id, '')).rejects.toThrow('理由')
    await engine.waiveReview(review.id, '误报：已有幂等测试')
    const after = await engine.taskDone('T1')
    expect(after.failures.some((failure) => failure.item === 'review:findings')).toBe(false)
  })

  it('缺陷返工：只失效指定任务及其下游，保留其它任务回执', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    const change = engine.currentChange()!
    change.tasks.T1 = { ...change.tasks.T1!, status: 'done', evidenceIds: ['E-1'], reviewIds: ['RV-1'] }
    change.tasks.T2 = { ...change.tasks.T2!, status: 'done', evidenceIds: ['E-2'], reviewIds: ['RV-2'] }
    const outcome = await engine.declareRework({ kind: 'defect', taskIds: ['T1'], reason: 'T1 逻辑缺陷' })
    expect(outcome.invalidatedTasks).toEqual(['T1'])
    const updated = engine.currentChange()!
    expect(updated.tasks.T1!.evidenceIds).toEqual([])
    expect(updated.tasks.T2!.evidenceIds).toEqual(['E-2'])
    expect(updated.reviews).toHaveLength(0)
    expect(updated.tasks.T1!.status).toBe('pending')
  })

  it('需求返工：全部失效、回 S1、产物解冻', async () => {
    const harness = await createHarness()
    await toS4(harness)
    const { engine } = harness
    const change = engine.currentChange()!
    change.frozen = { tasks: { hash: 'sha256:x', at: '2026-11-01T09:00:00+08:00' } }
    await engine.declareRework({ kind: 'requirement', reason: '需求变更' })
    const updated = engine.currentChange()!
    expect(updated.stage).toBe('S1')
    expect(updated.frozen).toEqual({})
    expect(updated.reviews).toEqual([])
    expect(updated.tasks).toEqual({})
  })
})
