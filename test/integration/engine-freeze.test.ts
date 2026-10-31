/**
 * 契约冻结（T1.3）与产物冻结（T2.1/T2.5/T3.1）的集成回归。
 *
 * - 变更创建后改 config.yaml：在途变更仍按冻结契约判定，新变更用新规则；
 * - 人工门批准后产物哈希进入 change.frozen；agent 再改已批准产物被守卫拒绝；
 *   绕过守卫直接改文件会被 G3 的 frozenArtifacts 检查发现。
 *
 * 本文件走真实门禁检查（不注入 gateChecker），fixture 与 real-gates 测试同源。
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { FlowgateConfig } from '../../src/core/types'
import { renderConfigYaml, parseConfig } from '../../src/core/store'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function createHarness(): Promise<Harness> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# demo\n')
  await fs.writeFile(
    'package.json',
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'vitest run', build: 'tsc' } }),
  )
  await fs.writeFile('src/index.ts', 'export const answer = 42\n')
  await fs.writeFile('test/index.test.ts', "import { answer } from '../src/index'\n")
  const git = new FakeGit(clock)
  const runner = new FakeCommandRunner(
    [
      { match: 'pnpm test', exitCode: 0, stdout: VITEST_PASS_STDOUT },
      { match: 'vitest', exitCode: 0, stdout: VITEST_PASS_STDOUT },
      { match: 'tsc', exitCode: 0, stdout: '' },
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
    ledgerKey: 'freeze-test-key',
    sessionId: 'session-freeze',
    host: {},
  })
  await engine.load()
  await engine.init()
  return { fs, clock, git, runner, engine }
}

async function writeArtifacts(fs: MemoryFileSystem, changeId: string): Promise<void> {
  const base = `.flowgate/changes/${changeId}`
  await fs.writeFile(
    `${base}/clarify.md`,
    `# 澄清记录：会员续费\n\n## 原始描述\n给会员加续费功能。\n\n## 已知事实\n- 会员到期日字段在 \`src/index.ts:1-1\`。\n\n## 六要素\n\n| 要素 | 结论 | 来源 | 状态 |\n|---|---|---|---|\n| 目标 | 支持会员续费 | 负责人 | 确认 |\n| 边界（做 / 不做） | 做续费，不做自动扣款 | 负责人 | 确认 |\n| 角色与权限 | 会员本人 | 负责人 | 确认 |\n| 验收标准 | 见增量规格 R1.S1 | proposal | 确认 |\n| 约束（非功能） | p95 < 300ms | 负责人 | 确认 |\n| 未知与假设 | 回调 5 秒内到达（假设） | 负责人 | 已接受 |\n\n## 问答记录\n\n| 问题 | 选项 | 回答 | 这个回答改变了什么 |\n|---|---|---|---|\n| 续费到期日从哪天算？ | 当天 / 次日 | 次日 | 决定 R1 的起算点 |\n\n## 已接受的假设\n- 支付回调在 5 秒内到达。\n\n## 未决问题\n（无）\n`,
  )
  await fs.writeFile(
    `${base}/proposal.md`,
    `# 变更提案：会员续费\n\n## 为什么\n会员需要续费才能继续使用。\n\n## 改什么\n新增续费接口 R1。\n\n## 影响\nMemberService、续费表。\n\n## 不做\n- 不做自动扣款\n- 不做优惠叠加\n`,
  )
  await fs.writeFile(
    `${base}/specs/spec.md`,
    `## ADDED Requirements\n\n### Requirement: R1 会员续费\n系统 SHALL 允许会员在到期前续费。\n\n#### Scenario: R1.S1 续费成功\n- GIVEN 有效会员\n- WHEN 调用续费接口\n- THEN 到期日延长 30 天且 HTTP 200\n`,
  )
  await fs.writeFile(
    `${base}/context.md`,
    `# 上下文\n\n## 接口约束\n- 续费接口 p95 < 300ms（\`src/index.ts:1-1\`）。\n\n## 数据模型\n- Member 表保存到期日（\`src/index.ts:1-1\`）。\n\n## 非功能要求\n- p95 < 300ms；错误率 < 0.1%。\n\n## 相关模块\n- src/index.ts。\n`,
  )
  await fs.writeFile(
    `${base}/design.md`,
    `# 设计\n\n## 方案对比\n\n### 方案 A：幂等流水表\n- 优点：可追溯、天然幂等。\n- 缺点：多一张表。\n\n### 方案 B：唯一索引\n- 优点：改动小。\n- 缺点：迁移有风险。\n\n## 推荐方案\n方案 A：流水号唯一索引 + 先查后写。\n\n## 数据流\nHTTP → RenewalController → RenewalService → 流水表。\n\n## 错误处理\n重复回调返回 200；校验失败返回 400。\n\n## 回滚方案\n回滚迁移脚本并保留旧入口。\n`,
  )
  await fs.writeFile(
    `${base}/risk.md`,
    `# 风险登记\n\n| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |\n|---|---|---|---|---|---|\n| 安全 | 高 | 回调可伪造 | 复用验签器 | 单测 R1.S1 | 是 |\n| 性能 | 低 | 多一次查询 | 唯一索引 | 压测 | 否 |\n| 成本 | 无 | 不新增外部调用 | （无） | （无） | 否 |\n| 合规 | 中 | 续费记录含手机号 | 日志脱敏 | 审查 | 否 |\n| 可维护性 | 低 | 逻辑集中在一个服务 | 收拢策略类 | 审查 | 否 |\n`,
  )
  await fs.writeFile(
    `${base}/tasks.md`,
    `# 任务\n\n## T1 实现续费接口\n\n\`\`\`yaml\ncovers: [R1.S1]\nscope: [src/index.ts]\ntests: [test/index.test.ts]\nnew_files: []\ndepends_on: []\ntdd: required\nverify:\n  - group: unit\n    command: pnpm test\n    inputs: [src/index.ts]\nsize: S\nrun: main\n\`\`\`\n\n实现续费接口与幂等。\n\n## 执行计划\n\n\`\`\`yaml\nexecution:\n  - batch: B1\n    mode: sequential\n    tasks: [T1]\n    why: 单任务\n\`\`\`\n`,
  )
}

async function approveG1(engine: FlowEngine, fs: MemoryFileSystem, changeId: string): Promise<void> {
  await writeArtifacts(fs, changeId)
  await engine.recordSkillLoaded('flow-clarify', 'sha256:clarify')
  const g1 = await engine.submitGate('G1')
  if (!g1.passed) {
    throw new Error(`G1 失败：${g1.failures.map((failure) => `${failure.item} ${failure.hint ?? ''}`).join(' | ')}`)
  }
  await engine.approveGate('G1')
}

describe('契约冻结生效（T1.3 验收 #3）', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  it('创建变更后改 config.yaml：在途变更仍按冻结契约判定', async () => {
    const { engine, fs } = harness
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const change = engine.currentChange()!
    expect(change.contract?.snapshot).toBeDefined()
    // 默认契约没有覆盖规则 → 内置 R-STAGE-SRC 拒绝 S1 写源码。
    const before = await engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(before.effect).toBe('deny')
    expect(before.rule?.ruleId).toBe('R-STAGE-SRC')

    // 负责人把 R-STAGE-SRC 改成 allow 并刷新配置：在途变更仍用旧契约。
    const overridden = parseConfig(
      'rules:\n  - id: R-STAGE-SRC\n    when: {}\n    decision: allow\n    why: 临时放行\n    unlock: 无\n',
    )
    await fs.writeFile('.flowgate/config.yaml', renderConfigYaml(overridden))
    await engine.refresh()
    expect(engine.currentChange()?.id).toBe(created.changeId)

    const after = await engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(after.effect).toBe('deny')
    expect(after.rule?.ruleId).toBe('R-STAGE-SRC')
  })

  it('新建变更使用刷新后的新规则', async () => {
    const { engine, fs } = harness
    await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    const overridden = parseConfig(
      'rules:\n  - id: R-STAGE-SRC\n    when: {}\n    decision: allow\n    why: 临时放行\n    unlock: 无\n',
    )
    await fs.writeFile('.flowgate/config.yaml', renderConfigYaml(overridden))
    await engine.refresh()

    // 暂停旧变更后才能立项新变更。
    await engine.pauseChange()
    await engine.newChange({ title: '第二个变更', summary: '另一个需求' })
    const change = engine.currentChange()!
    expect(change.contract?.snapshot?.rules.some((rule) => rule.id === 'R-STAGE-SRC' && rule.decision === 'allow')).toBe(true)

    const allowed = await engine.evaluateAction({ kind: 'write', tool: 'write', path: 'src/index.ts' }, { tool: 'write', agentRole: 'main' })
    expect(allowed.effect).toBe('allow')
  })
})

describe('产物冻结接线（T2.1/T2.5/T3.1）', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness()
  })

  it('G1 批准后产物进入 change.frozen，agent 再改被 R-FROZEN-ARTIFACT 拒绝', async () => {
    const { engine, fs } = harness
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await approveG1(engine, fs, created.changeId)

    const change = engine.currentChange()!
    expect(change.frozen).toBeDefined()
    expect(Object.keys(change.frozen!).sort()).toEqual(['clarify', 'context', 'design', 'proposal', 'risk', 'spec', 'tasks'])

    const denied = await engine.evaluateAction(
      { kind: 'write', tool: 'edit', path: `.flowgate/changes/${created.changeId}/proposal.md` },
      { tool: 'edit', agentRole: 'main' },
    )
    expect(denied.effect).toBe('deny')
    expect(denied.rule?.ruleId).toBe('R-FROZEN-ARTIFACT')
    expect(denied.message).toContain('冻结')
  })

  it('绕过守卫直接改已批准产物：G3 的 frozenArtifacts 检查失败', async () => {
    const { engine, fs } = harness
    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await approveG1(engine, fs, created.changeId)
    await engine.submitGate('G2')
    expect(engine.currentChange()?.stage).toBe('S3')

    // 模拟绕过守卫（例如插件故障/外部改动）直接改文件。
    await fs.writeFile(`.flowgate/changes/${created.changeId}/proposal.md`, '# 变更提案：会员续费\n\n被偷偷改过。\n')

    await engine.recordSkillLoaded('flow-plan', 'sha256:plan')
    const g3 = await engine.submitGate('G3')
    expect(g3.passed).toBe(false)
    expect(g3.failures.some((failure) => failure.item === 'g3.frozenArtifacts')).toBe(true)
  })
})
