/**
 * Integration with the REAL gate checks (no injected checker): the artifact
 * parsers, GATE_CHECKS, execution-plan checks and evidence freshness all run
 * against an in-memory project. This is the v0.5 "requirement → plan → execute"
 * proof at the core level.
 */
import { describe, it, expect } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''

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

describe('real gate checks (no injected checker)', () => {
  it('S0 → G3 全部真实检查通过，任务卡进入执行计划', async () => {
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
      ledgerKey: 'real-gate-key',
      sessionId: 'session-real',
      host: {},
    })
    await engine.load()
    const init = await engine.init()
    expect(init.ok).toBe(true)

    const created = await engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    expect(engine.currentChange()?.stage).toBe('S1')
    await writeArtifacts(fs, created.changeId)

    await engine.recordSkillLoaded('flow-clarify', 'sha256:clarify')
    const g1 = await engine.submitGate('G1')
    if (!g1.passed) throw new Error(`G1 失败：${g1.failures.map((failure: CheckOutcome) => `${failure.label} → ${failure.hint} ${JSON.stringify(failure.details ?? [])}`).join(' | ')}`)
    expect(g1.awaiting).toBe('owner')
    await engine.approveGate('G1')

    const g2 = await engine.submitGate('G2')
    if (!g2.passed) throw new Error(`G2 失败：${g2.failures.map((failure: CheckOutcome) => `${failure.label} → ${failure.hint}`).join(' | ')}`)
    expect(engine.currentChange()?.stage).toBe('S3')

    await engine.recordSkillLoaded('flow-plan', 'sha256:plan')
    const g3 = await engine.submitGate('G3')
    if (!g3.passed) throw new Error(`G3 失败：${g3.failures.map((failure: CheckOutcome) => `${failure.label} → ${failure.hint} ${JSON.stringify(failure.details ?? [])}`).join(' | ')}`)
    expect(g3.awaiting).toBe('owner')
    // T2.9：G3 等负责人期间执行图数据已经物化，批准卡片能看到流程图。
    expect(Object.keys(engine.currentChange()?.tasks ?? {})).toEqual(['T1'])
    expect(engine.currentChange()?.batches.map((batch) => batch.id)).toEqual(['B1'])
    expect(fs.listFiles()).toContain(`.flowgate/changes/${created.changeId}/execution-plan.md`)
    await engine.approveGate('G3')
    expect(engine.currentChange()?.stage).toBe('S4')
    expect(Object.keys(engine.currentChange()?.tasks ?? {})).toEqual(['T1'])
    expect(fs.listFiles()).toContain(`.flowgate/changes/${created.changeId}/execution-plan.md`)
  }, 30_000)

  it('从 0 开发：项目级澄清 + 路线图通过 GR', async () => {
    const clock = new FakeClock()
    const fs = new MemoryFileSystem()
    await fs.writeFile('README.md', '# empty repo\n')
    const git = new FakeGit(clock)
    const runner = new FakeCommandRunner([], clock)
    const engine = new FlowEngine({
      root: ROOT,
      fs,
      clock,
      git,
      commandRunner: runner,
      pluginVersion: '0.1.0',
      ledgerKey: 'gr-key',
      sessionId: 'session-gr',
      host: {},
    })
    await engine.load()
    await engine.init()

    const project = await engine.newChange({ title: '会员管理系统', project: true })
    expect(project.changeId).toBe('PROJECT')
    expect(engine.currentChange()?.stage).toBe('roadmap')

    const clarify = `# 项目级澄清：会员管理系统\n\n## 目标用户与目标\n- 目标用户：门店店长；目标：管理会员与续费。\n\n## 核心流程\n- 登录 → 建会员 → 续费 → 到期提醒。\n\n## MVP 边界（做 / 不做）\n- 做：会员、续费。\n- 不做：报表、营销自动化。\n\n## 技术栈与部署\n- Spring Boot 3 + PostgreSQL，单机部署。\n\n## 非功能要求\n- 登录 p95 < 500ms；数据每日备份。\n\n## 约束与未知项\n- 未知：支付渠道未定（负责人后续决定）。\n`
    const roadmap = `# 路线图：会员管理系统\n\nMVP 切线：C0–C1 在切线内。\n\n| 变更 | 能力 | 一句话目标 | 验收要点 | 依赖 | 预计任务数 | MVP | 状态 |\n|---|---|---|---|---|---|---|---|\n| C0 | 工程骨架 | 能构建、能跑测试 | 测试框架跑通 1 个冒烟测试 | — | 4 | 是 | 未开始 |\n| C1 | 会员 | 开通与查询会员 | 开通/查询/失败三类场景 | C0 | 8 | 是 | 未开始 |\n`
    await fs.writeFile('.flowgate/project-clarify.md', clarify)
    await fs.writeFile('.flowgate/roadmap.md', roadmap)

    const gr = await engine.submitGate('GR')
    if (!gr.passed) throw new Error(`GR 失败：${gr.failures.map((failure: CheckOutcome) => `${failure.label} → ${failure.hint} ${JSON.stringify(failure.details ?? [])}`).join(' | ')}`)
    expect(gr.awaiting).toBe('owner')
    await engine.approveGate('GR')

    // From-roadmap change creation inherits the roadmap goal.
    const g0 = await engine.newChange({ title: 'ignored', fromRoadmap: 'C0' })
    expect(g0.changeId).toBe('C-001')
    expect(engine.currentChange()?.title).toBeTruthy()
    // T2.7：proposal.md 草稿带入路线图的目标与验收要点；路线图状态回写为「进行中」。
    const proposal = await fs.readFile('.flowgate/changes/C-001/proposal.md')
    expect(proposal).toContain('测试框架跑通 1 个冒烟测试')
    expect(proposal).toContain('验收要点（来自已批准的路线图）')
    expect(await fs.readFile('.flowgate/roadmap.md')).toContain('进行中')

    // 暂停时回写「暂停」。
    await engine.pauseChange()
    expect(await fs.readFile('.flowgate/roadmap.md')).toContain('暂停')
  }, 30_000)
})
