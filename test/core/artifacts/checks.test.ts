import { describe, expect, it } from 'vitest'
import {
  GATE_CHECKS,
  checkAnalysisCitations,
  checkBaseline,
  checkCleanWorktree,
  checkContextCitations,
  checkG5FullTests,
  checkG5Scenarios,
  checkG5LintBuild,
  checkG5FinalReview,
  checkG6Risks,
  checkG6Reviews,
  checkProjectClarify,
  checkProjectCommands,
  checkScenarioVagueTerms,
  checkTaskCards,
  checkTaskCount,
  checkTraceability,
  checksForGate,
  runGateChecks,
  validateVerifyCommandShape,
} from '../../../src/core/artifacts/checks'
import { checkExecutionPlan } from '../../../src/core/plan/check'
import { parseIncrementalSpec } from '../../../src/core/artifacts/parse'
import type {
  ArtifactBundle,
  ChangeStatus,
  GateCheckContext,
  GateId,
  ProjectDoc,
  RiskDoc,
  RoadmapDoc,
  RoadmapEntry,
  SpecDoc,
  TaskCard,
  TasksDoc,
} from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  CLARIFY,
  CONTEXT,
  DESIGN,
  NOTIFY_SCOPE,
  NOW,
  PROJECT,
  PROPOSAL,
  RENEWAL_SCOPE,
  RENEWAL_SERVICE,
  RISK,
  ROADMAP,
  SPEC,
  TASKS,
  defaultFiles,
  levelFor,
  makeCtx,
  makeFs,
  taskCard,
  validBundle,
  validChange,
  validConfig,
  validEvidence,
  validExecutionPlan,
  validTaskCards,
} from '../../fixtures/artifacts/helpers'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function bundle(overrides: Partial<ArtifactBundle>): ArtifactBundle {
  return validBundle(overrides)
}

function change(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return validChange(overrides)
}

function fsWithoutProjectClarify(): MemoryFileSystem {
  const files = defaultFiles()
  delete files['.flowgate/project-clarify.md']
  return new MemoryFileSystem(files)
}

function emptyRoadmap(): RoadmapDoc {
  return { raw: '', title: '会员管理系统', mvpCut: '', entries: [] }
}

function roadmap(entries: RoadmapEntry[], mvpCut = ROADMAP.mvpCut): RoadmapDoc {
  return { raw: '', title: '会员管理系统', mvpCut, entries }
}

function roadmapEntry(overrides: Partial<RoadmapEntry> & { change: string }): RoadmapEntry {
  return {
    capability: '能力',
    goal: '目标',
    acceptance: '验收要点',
    dependsOn: [],
    estimatedTasks: 5,
    mvp: true,
    status: '未开始',
    ...overrides,
  }
}

function tasksWith(mutate: (tasks: TaskCard[]) => TaskCard[]): TasksDoc {
  return { ...TASKS, tasks: mutate(validTaskCards()) }
}

const SPEC_NO_SCENARIOS = parseIncrementalSpec(`## ADDED Requirements

### Requirement: R1 空需求
系统 SHALL 做点什么。
`)

const VAGUE_SPEC = parseIncrementalSpec(`## ADDED Requirements

### Requirement: R1 性能
系统 SHALL 很快。

#### Scenario: R1.S1 响应
- GIVEN 会员已登录
- WHEN 调用续费接口
- THEN 续费要快
`)

const R2_SPEC = parseIncrementalSpec(`## ADDED Requirements

### Requirement: R2 会员续费
系统 SHALL 支持续费。

#### Scenario: R2.S1 首次续费
- GIVEN 会员已登录
- WHEN 提交续费
- THEN 到期日顺延，接口返回 HTTP 200

#### Scenario: R2.S2 重复回调
- GIVEN 续费订单已处理
- WHEN 再次回调
- THEN 到期日不变，接口返回 HTTP 200

#### Scenario: R2.S3 过期续费
- GIVEN 会员已过期
- WHEN 提交续费
- THEN 到期日从支付日顺延，接口返回 HTTP 200
`)

const CONTEXT_NO_MODEL = {
  ...CONTEXT,
  sections: CONTEXT.sections.filter((section) => !/数据模型/.test(section.title)),
}

const CONTEXT_NO_CITATIONS = {
  ...CONTEXT,
  sections: CONTEXT.sections.map((section) =>
    /接口|数据模型/.test(section.title) ? { ...section, citations: [] } : section,
  ),
}

const RISK_NO_PERF = { ...RISK, entries: RISK.entries.filter((entry) => entry.category !== 'performance') }

const CLARIFY_NO_GOAL = {
  ...CLARIFY,
  elements: { ...CLARIFY.elements, goal: { conclusion: '', source: '', status: '' } },
}

const CLARIFY_OPEN_QUESTION = { ...CLARIFY, openQuestions: ['存量订单是否支持续费？'] }

const PROJECT_NO_COMMANDS: ProjectDoc = { ...PROJECT, commands: {} }

function riskWithMaintainabilityTestNone(): RiskDoc {
  return {
    ...RISK,
    entries: RISK.entries.map((entry) =>
      entry.category === 'maintainability' ? { ...entry, reason: '缺少自动化测试，需要尽快补' } : entry,
    ),
  }
}

function pending(overrides: Record<string, unknown>) {
  return {
    id: 'RK-1',
    kind: 'risk',
    changeId: 'C-001',
    title: '风险接管',
    detail: '',
    status: 'open',
    createdAt: NOW,
    ...overrides,
  } as ChangeStatus['pending'][number]
}

const dirtyGit = {
  statusPorcelain: async () => ' M src/main/java/com/acme/member/renewal/RenewalService.java',
} as unknown as GateCheckContext['git']

// ---------------------------------------------------------------------------
// Positive contexts: one per check that needs special input to pass
// ---------------------------------------------------------------------------

const POSITIVE_CONTEXTS: Record<string, () => GateCheckContext> = {
  'g3.testNoneRisk': () =>
    makeCtx({
      project: { ...PROJECT, commands: { test: 'none', lint: 'pnpm lint', build: 'pnpm build' } },
      artifacts: bundle({ risk: riskWithMaintainabilityTestNone() }),
    }),
  'g1.coreSkills': () =>
    makeCtx({ gate: 'G1', change: change({ skillReceipts: [{ name: 'flow-clarify', hash: 'sha256:x', at: NOW }] }) }),
  'g3.coreSkills': () =>
    makeCtx({ gate: 'G3', change: change({ skillReceipts: [{ name: 'flow-plan', hash: 'sha256:x', at: NOW }] }) }),
}

// ---------------------------------------------------------------------------
// Negative contexts: one per check, each breaks exactly that check's input
// ---------------------------------------------------------------------------

const NEGATIVE_CONTEXTS: Record<string, (ctx: GateCheckContext) => GateCheckContext> = {
  'gr.projectClarify': (ctx) => ({ ...ctx, fs: fsWithoutProjectClarify() }),
  'gr.roadmapEntries': (ctx) => ({ ...ctx, roadmap: emptyRoadmap() }),
  'gr.roadmapDeps': (ctx) => ({
    ...ctx,
    roadmap: roadmap([
      roadmapEntry({ change: 'C0', capability: '工程骨架', goal: '工程骨架初始化' }),
      roadmapEntry({ change: 'C1', dependsOn: ['C3'] }),
      roadmapEntry({ change: 'C3', dependsOn: ['C1'] }),
    ]),
  }),
  'gr.roadmapC0': (ctx) => ({
    ...ctx,
    roadmap: roadmap([roadmapEntry({ change: 'C1', capability: '会员' }), roadmapEntry({ change: 'C0', capability: '工程骨架' })]),
  }),
  'gr.roadmapMvp': (ctx) => ({
    ...ctx,
    roadmap: roadmap([
      roadmapEntry({ change: 'C0', capability: '工程骨架', goal: '工程骨架初始化' }),
      roadmapEntry({ change: 'C1', capability: '', goal: '' }),
    ]),
  }),
  'gr.roadmapScale': (ctx) => ({
    ...ctx,
    roadmap: roadmap([roadmapEntry({ change: 'C0', capability: '工程骨架', estimatedTasks: 15 })]),
  }),
  'gr.roadmapMvpCut': (ctx) => ({ ...ctx, roadmap: roadmap([roadmapEntry({ change: 'C0', capability: '工程骨架' })], '') }),

  'g0.changeDir': (ctx) => ({ ...ctx, fs: new MemoryFileSystem({}) }),
  'g0.title': (ctx) => ({ ...ctx, change: change({ title: '', summary: '' }) }),
  'g0.levels': (ctx) => ({ ...ctx, change: change({ complexity: 'bogus' as ChangeStatus['complexity'] }) }),
  'g0.contract': (ctx) => ({ ...ctx, change: change({ contract: undefined }) }),

  'g1.sixElements': (ctx) => ({ ...ctx, artifacts: bundle({ clarify: CLARIFY_NO_GOAL }) }),
  'g1.scenarioCoverage': (ctx) => ({ ...ctx, artifacts: bundle({ spec: SPEC_NO_SCENARIOS }) }),
  'g1.vagueTerms': (ctx) => ({ ...ctx, artifacts: bundle({ spec: VAGUE_SPEC }) }),
  'g1.outOfScope': (ctx) => ({ ...ctx, artifacts: bundle({ proposal: { ...PROPOSAL, outOfScope: [] } }) }),
  'g1.openQuestions': (ctx) => ({ ...ctx, artifacts: bundle({ clarify: CLARIFY_OPEN_QUESTION }) }),
  'g1.specFormat': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      spec: {
        ...SPEC,
        requirements: SPEC.requirements.map((requirement) => ({ ...requirement, id: 'X9' })),
      },
    }),
  }),
  'g1.factsCitations': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      clarify: {
        ...CLARIFY,
        knownFacts: [{ text: '续费入口在 HomeController', citations: [], status: 'confirmed' }],
      },
    }),
  }),

  'g2.contextSections': (ctx) => ({ ...ctx, artifacts: bundle({ context: CONTEXT_NO_MODEL }) }),
  'g2.contextCitations': (ctx) => ({ ...ctx, artifacts: bundle({ context: CONTEXT_NO_CITATIONS }) }),
  'g2.projectCommands': (ctx) => ({ ...ctx, project: PROJECT_NO_COMMANDS }),
  'g2.baseline': (ctx) => ({ ...ctx, evidence: [] }),

  'g3.design': (ctx) => ({
    ...ctx,
    change: change({ complexity: 'high' }),
    artifacts: bundle({ design: undefined }),
  }),
  'g3.risk': (ctx) => ({ ...ctx, artifacts: bundle({ risk: RISK_NO_PERF }) }),
  'g3.taskCards': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: tasksWith((tasks) => {
        tasks[0]!.dependsOn = ['T2']
        tasks[1]!.dependsOn = ['T1']
        return tasks
      }),
    }),
  }),
  'g3.traceability': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: tasksWith((tasks) =>
        tasks.map((task) => (task.id === 'T2' ? { ...task, covers: [], choreReason: '占位任务' } : task)),
      ),
    }),
  }),
  'g3.taskCount': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: {
        ...TASKS,
        tasks: Array.from({ length: 13 }, (_, index) =>
          taskCard({
            id: `T${index + 1}`,
            scope: [RENEWAL_SCOPE],
            choreReason: '占位任务',
            verify: [{ group: 'unit', command: 'pnpm test', inputs: [RENEWAL_SCOPE] }],
          }),
        ),
      },
    }),
  }),
  'g3.newFiles': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: tasksWith((tasks) =>
        tasks.map((task) => (task.id === 'T1' ? { ...task, newFiles: ['src/**'] } : task)),
      ),
    }),
  }),
  'g3.verifyCommands': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: tasksWith((tasks) =>
        tasks.map((task) =>
          task.id === 'T1'
            ? { ...task, verify: [{ group: 'unit', command: 'npm test || true', inputs: ['pom.xml'] }] }
            : task,
        ),
      ),
    }),
  }),
  'g3.executionPlan': (ctx) => ({
    ...ctx,
    artifacts: bundle({
      tasks: {
        ...TASKS,
        tasks: validTaskCards().map((task) =>
          task.id === 'T3' || task.id === 'T4' ? { ...task, scope: [RENEWAL_SERVICE] } : task,
        ),
        execution: validExecutionPlan(),
      },
    }),
  }),
  'g3.frozenArtifacts': (ctx) => ({
    ...ctx,
    change: change({ frozen: { proposal: { hash: 'sha256:deadbeef', at: NOW } } }),
  }),
  'g1.coreSkills': (ctx) => ({ ...ctx, gate: 'G1', change: change({ skillReceipts: [] }) }),
  'g3.coreSkills': (ctx) => ({ ...ctx, gate: 'G3', change: change({ skillReceipts: [] }) }),
  'g3.cleanWorktree': (ctx) => ({ ...ctx, git: dirtyGit }),
  'g3.testNoneRisk': (ctx) => ({
    ...ctx,
    project: { ...PROJECT, commands: { test: 'none', lint: 'pnpm lint', build: 'pnpm build' } },
    artifacts: bundle({ risk: RISK }),
  }),

  'g5.fullTests': (ctx) => ({ ...ctx, evidence: validEvidence().filter((receipt) => receipt.kind !== 'test') }),
  'g5.lintBuild': (ctx) => ({
    ...ctx,
    evidence: validEvidence().map((receipt) => (receipt.kind === 'lint' ? { ...receipt, exitCode: 1 } : receipt)),
  }),
  'g5.scenarios': (ctx) => ({ ...ctx, evidence: validEvidence().filter((receipt) => receipt.kind !== 'test') }),
  'g5.runtime': (ctx) => ({ ...ctx, change: change({ risk: 'high' }) }),
  'g5.finalReview': (ctx) => ({ ...ctx, change: change({ reviews: [] }) }),

  'g6.taskCompletion': (ctx) => ({
    ...ctx,
    change: change({ tasks: { ...validChange().tasks, T1: { ...validChange().tasks.T1!, status: 'pending' } } }),
  }),
  'g6.g5Passed': (ctx) => ({
    ...ctx,
    change: change({ gates: { ...validChange().gates, G5: { state: 'failed', attempts: 1 } } }),
  }),
  'g6.scenarios': (ctx) => ({ ...ctx, evidence: validEvidence().filter((receipt) => receipt.kind !== 'test') }),
  'g6.reviews': (ctx) => ({ ...ctx, change: change({ reviews: [] }) }),
  'g6.risks': (ctx) => ({ ...ctx, change: change({ pending: [pending({})] }) }),
  'g6.manualEvidence': (ctx) => ({ ...ctx, change: change({ risk: 'high' }) }),
  'g6.tamper': (ctx) => ({ ...ctx, change: change({ lock: { reason: '检测到账本被篡改', at: NOW } }) }),
  'g6.externalChanges': (ctx) => ({
    ...ctx,
    change: change({ pending: [pending({ id: 'CF-1', kind: 'conflict', title: '非 agent 改动待确认' })] }),
  }),
}

// ---------------------------------------------------------------------------
// Coverage of the gate table
// ---------------------------------------------------------------------------

const TABLE_GATES: GateId[] = ['GR', 'G0', 'G1', 'G2', 'G3', 'G5', 'G6']

describe('终审检查与 review 配置', () => {
  it('review.enabled=false 时 G5/G6 不因缺少终审记录而失败', () => {
    const config = validConfig()
    config.review.enabled = false
    const ctx = makeCtx({ gate: 'G5', config, change: change({ reviews: [] }) })
    const g5 = checkG5FinalReview(ctx)
    expect(g5.passed).toBe(true)
    expect(g5.details?.[0]).toContain('review.enabled=false')
    const g6 = checkG6Reviews(makeCtx({ gate: 'G6', config, change: change({ reviews: [] }) }))
    expect(g6.passed).toBe(true)
  })

  it('review 开启时仍要求终审记录', () => {
    const ctx = makeCtx({ gate: 'G5', change: change({ reviews: [] }) })
    const outcome = checkG5FinalReview(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.details?.join(' ')).toContain('缺少 S5 终审记录')
  })
})

describe('GATE_CHECKS 数据表', () => {
  it('覆盖 docs/03 §3.2 表格的全部门（GR/G0/G1/G2/G3/G5/G6）', () => {
    for (const gate of TABLE_GATES) {
      const items = GATE_CHECKS.filter((definition) => definition.gates.includes(gate))
      expect(items.length, `gate ${gate} has no checks`).toBeGreaterThan(0)
    }
  })

  it('检查项 id 唯一且都有中文 label 和非空 gates', () => {
    const ids = new Set<string>()
    for (const definition of GATE_CHECKS) {
      expect(ids.has(definition.id), `duplicate ${definition.id}`).toBe(false)
      ids.add(definition.id)
      expect(definition.label.trim()).not.toBe('')
      expect(definition.gates.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Every single check: one positive and one negative fixture
// ---------------------------------------------------------------------------

describe('GATE_CHECKS 正例', () => {
  for (const definition of GATE_CHECKS) {
    it(`${definition.id} — 合法输入通过`, async () => {
      const ctx = POSITIVE_CONTEXTS[definition.id]?.() ?? makeCtx()
      const outcome = await definition.check(ctx)
      expect(outcome.passed, JSON.stringify(outcome)).toBe(true)
      expect(outcome.item).toBe(definition.id)
    })
  }
})

describe('GATE_CHECKS 反例', () => {
  for (const definition of GATE_CHECKS) {
    it(`${definition.id} — 非法输入失败并给出 hint`, async () => {
      const mutate = NEGATIVE_CONTEXTS[definition.id]
      expect(mutate, `missing negative fixture for ${definition.id}`).toBeDefined()
      const ctx = mutate!(makeCtx())
      const outcome = await definition.check(ctx)
      expect(outcome.passed, JSON.stringify(outcome)).toBe(false)
      expect(typeof outcome.hint).toBe('string')
      expect(outcome.hint!.length).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// T2 acceptance scenarios (docs/04)
// ---------------------------------------------------------------------------

describe('T2.1 验收场景', () => {
  it('场景 R2.S3 未被任务覆盖 → 指出 R2.S3', () => {
    const tasks: TaskCard[] = [
      taskCard({ id: 'T1', covers: ['R2.S1'], scope: [RENEWAL_SCOPE], verify: [{ group: 'unit', command: 'pnpm test', inputs: [RENEWAL_SCOPE] }] }),
      taskCard({ id: 'T2', covers: ['R2.S2'], scope: ['src/other/**'], verify: [{ group: 'unit', command: 'pnpm test', inputs: ['src/other/**'] }] }),
    ]
    const ctx = makeCtx({ artifacts: bundle({ spec: R2_SPEC, tasks: { ...TASKS, tasks, execution: { batches: [] } } }) })
    const outcome = checkTraceability(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('R2.S3')
    expect(outcome.details!.join('\n')).toContain('新增任务')
  })

  it('任务范围写成 src/** → 失败并给出实际匹配文件数', async () => {
    const extra: Record<string, string> = {}
    for (let i = 0; i < 5; i += 1) extra[`src/module${i}/file${i}.ts`] = 'export {}\n'
    const fs = makeFs(extra)
    const tasks = tasksWith((list) => list.map((task) => (task.id === 'T1' ? { ...task, scope: ['src/**'] } : task)))
    const ctx = makeCtx({ fs, artifacts: bundle({ tasks }) })
    const outcome = await checkTaskCards(ctx)
    expect(outcome.passed).toBe(false)
    const text = outcome.details!.join('\n')
    expect(text).toContain('范围过宽')
    expect(text).toContain('实际匹配 7 个文件')
  })

  it('一个变更写 15 张任务卡 → 失败并提示拆成多个变更', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      taskCard({ id: `T${index + 1}`, scope: [RENEWAL_SCOPE], choreReason: '占位', verify: [{ group: 'u', command: 'pnpm test', inputs: [RENEWAL_SCOPE] }] }),
    )
    const ctx = makeCtx({ artifacts: bundle({ tasks: { ...TASKS, tasks: many } }) })
    const outcome = checkTaskCount(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('拆成多个')
    expect(outcome.details!.join('\n')).toContain('15')
  })

  it('THEN 里的「快」未量化 → 失败并给出可测量示例', () => {
    const ctx = makeCtx({ artifacts: bundle({ spec: VAGUE_SPEC }) })
    const outcome = checkScenarioVagueTerms(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('p95 < 300ms')
    expect(outcome.details!.join('\n')).toContain('快')
  })

  it('test: none 且基线改用 build/lint → 通过', () => {
    const ctx = makeCtx({
      project: { ...PROJECT, commands: { test: 'none', build: 'pnpm build', lint: 'pnpm lint' } },
    })
    expect(checkBaseline(ctx).passed).toBe(true)
  })

  it('声明了测试命令但没有解析出测试数量 → 基线失败（FR-3.4）', () => {
    const ctx = makeCtx({
      evidence: validEvidence().map((receipt) =>
        receipt.kind === 'test' ? { ...receipt, summary: { ...receipt.summary!, parsed: false } } : receipt,
      ),
    })
    const outcome = checkBaseline(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('测试数量')
  })

  it('C0 工程骨架允许基线 0 个测试', () => {
    const ctx = makeCtx({
      change: change({ roadmap: 'C0', title: '工程骨架', summary: '搭建目录、构建、测试框架' }),
      evidence: validEvidence().map((receipt) =>
        receipt.kind === 'test'
          ? { ...receipt, summary: { parser: 'vitest', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 } }
          : receipt,
      ),
    })
    expect(checkBaseline(ctx).passed).toBe(true)
  })

  it('已知事实没有引用 → G1 失败并提示补引用或改成假设', async () => {
    const ctx = makeCtx({
      artifacts: bundle({
        clarify: {
          ...CLARIFY,
          knownFacts: [{ text: '续费入口在 HomeController', citations: [], status: 'confirmed' }],
        },
      }),
    })
    const outcome = await checkAnalysisCitations(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('引用')
  })

  it('并行批次范围重叠 → 指出重叠文件（T2.9 验收）', () => {
    const tasks = validTaskCards().map((task) =>
      task.id === 'T3' || task.id === 'T4' ? { ...task, scope: [RENEWAL_SERVICE] } : task,
    )
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), validConfig())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('RenewalService.java')
  })

  it('并行批次改 pom.xml → 提示移到顺序批次（T2.9 验收）', () => {
    const tasks = validTaskCards().map((task) => (task.id === 'T4' ? { ...task, scope: ['pom.xml'] } : task))
    const outcome = checkExecutionPlan(tasks, validExecutionPlan(), validConfig())
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('热点文件 pom.xml')
    expect(outcome.details!.join('\n')).toContain('顺序批次')
  })

  it('project-clarify 缺失 → GR 失败', async () => {
    const outcome = await checkProjectClarify(makeCtx({ fs: fsWithoutProjectClarify() }))
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('项目级澄清')
  })

  it('工作区有未提交改动 → G3 失败', async () => {
    const outcome = await checkCleanWorktree(makeCtx({ git: dirtyGit }))
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('src/main/java')
  })
})

describe('引擎集成对齐（change.baseline / C0 / 缺失回执）', () => {
  it('G2 优先使用 change.baseline 中记录的基线', () => {
    const ctx = makeCtx({
      change: change({
        baseline: {
          commit: 'abc123',
          summary: { parser: 'vitest', parsed: true, run: 12, passed: 12, failed: 0, skipped: 0 },
          recordedAt: NOW,
        },
      }),
    })
    const outcome = checkBaseline(ctx)
    expect(outcome.passed).toBe(true)
    expect(outcome.details!.join('\n')).toContain('运行 12')
  })

  it('基线 0 个测试：普通变更失败，C0 工程骨架通过', () => {
    const zero = { parser: 'vitest', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 } as const
    const normal = makeCtx({ change: change({ baseline: { commit: null, summary: { ...zero }, recordedAt: NOW } }) })
    expect(checkBaseline(normal).passed).toBe(false)
    const c0 = makeCtx({
      change: change({
        roadmap: 'C0',
        title: '工程骨架',
        summary: '搭建目录与构建',
        baseline: { commit: null, summary: { ...zero }, recordedAt: NOW },
      }),
    })
    expect(checkBaseline(c0).passed).toBe(true)
  })

  it('C0 工程骨架的 project.md 命令缺失不阻塞 G2', () => {
    const ctx = makeCtx({
      change: change({ roadmap: 'C0', title: '工程骨架', summary: '搭建目录与构建' }),
      project: { ...PROJECT, commands: {} },
    })
    expect(checkProjectCommands(ctx).passed).toBe(true)
  })

  it('G5 lint/build 缺失回执不阻塞，失败回执阻断', () => {
    const missing = makeCtx({ evidence: validEvidence().filter((receipt) => receipt.kind !== 'lint') })
    const missingOutcome = checkG5LintBuild(missing)
    expect(missingOutcome.passed).toBe(true)
    expect(missingOutcome.details!.join('\n')).toContain('未收集到 lint 回执')
    const failed = makeCtx({
      evidence: validEvidence().map((receipt) => (receipt.kind === 'lint' ? { ...receipt, exitCode: 1 } : receipt)),
    })
    const failedOutcome = checkG5LintBuild(failed)
    expect(failedOutcome.passed).toBe(false)
    expect(failedOutcome.details!.join('\n')).toContain('lint 失败')
  })
})

// ---------------------------------------------------------------------------
// runGateChecks / checksForGate
// ---------------------------------------------------------------------------

function idsOf(ctx: GateCheckContext): Promise<string[]> {
  return runGateChecks(ctx).then((outcomes) => outcomes.map((outcome) => outcome.item))
}

describe('runGateChecks', () => {
  it('按 ctx.gate 运行对应门的检查项', async () => {
    const ids = await idsOf(makeCtx({ gate: 'G3' }))
    expect(ids).toEqual(expect.arrayContaining(['g3.taskCards', 'g3.traceability', 'g3.executionPlan', 'g3.frozenArtifacts']))
    expect(ids).not.toContain('g1.sixElements')
  })

  it('合法输入时全部门通过', async () => {
    for (const gate of TABLE_GATES) {
      const withSkills = change({
        skillReceipts: [
          { name: 'flow-clarify', hash: 'sha256:c', at: NOW },
          { name: 'flow-plan', hash: 'sha256:p', at: NOW },
        ],
      })
      const outcomes = await runGateChecks(makeCtx({ gate, change: withSkills }))
      expect(outcomes.length, `gate ${gate}`).toBeGreaterThan(0)
      for (const outcome of outcomes) expect(outcome.passed, `${gate}:${outcome.item} ${JSON.stringify(outcome)}`).toBe(true)
    }
  })

  it('输入非法时汇总失败项', async () => {
    const ctx = makeCtx({
      gate: 'G3',
      artifacts: bundle({
        tasks: tasksWith((tasks) => tasks.map((task) => (task.id === 'T2' ? { ...task, covers: [], choreReason: undefined } : task))),
      }),
    })
    const outcomes = await runGateChecks(ctx)
    const failures = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.item)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures).toEqual(expect.arrayContaining(['g3.taskCards']))
  })

  it('低复杂度：G1 + G3 合并，检查项集合包含 G1', async () => {
    const lowChange = change({ complexity: 'low' })
    const ctx = makeCtx({ gate: 'G3', change: lowChange, level: levelFor('low') })
    const ids = (await runGateChecks(ctx)).map((outcome) => outcome.item)
    expect(ids).toEqual(expect.arrayContaining(['g1.sixElements', 'g1.scenarioCoverage']))
    expect(ids).not.toContain('g3.executionPlan')
  })

  it('无法确定门时返回空数组', async () => {
    const ctx = makeCtx({ gate: undefined as unknown as GateId, change: change({ stage: 'S4' }) })
    expect(await runGateChecks(ctx)).toEqual([])
  })
})

describe('checksForGate', () => {
  it('高复杂度包含设计 / 风险 / 执行计划', () => {
    const ids = checksForGate('G3', levelFor('high')).map((definition) => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['g3.design', 'g3.risk', 'g3.executionPlan']))
  })

  it('中复杂度按等级矩阵过滤设计文档', () => {
    const ids = checksForGate('G3', levelFor('medium')).map((definition) => definition.id)
    expect(ids).toContain('g3.taskCards')
    expect(ids).toContain('g3.risk')
    expect(ids).not.toContain('g3.design')
  })

  it('低复杂度合并 G1 检查并跳过设计与执行计划', () => {
    const ids = checksForGate('G3', levelFor('low')).map((definition) => definition.id)
    expect(ids).toEqual(expect.arrayContaining(['g1.sixElements', 'g1.outOfScope', 'g3.taskCards']))
    expect(ids).not.toContain('g3.design')
    expect(ids).not.toContain('g3.executionPlan')
  })
})

describe('verify command shape', () => {
  it('合法验证命令通过', () => {
    expect(validateVerifyCommandShape('./mvnw -B test').ok).toBe(true)
    expect(validateVerifyCommandShape('pnpm vitest run').ok).toBe(true)
  })

  it('掩盖失败的写法被拒绝', () => {
    for (const command of ['npm test || true', 'mvn test && echo ok', 'mvn test; echo ok', 'mvn test | tee log', 'npm test > out.txt', 'echo $(date)', 'npm test `date`']) {
      const result = validateVerifyCommandShape(command)
      expect(result.ok, command).toBe(false)
      expect(result.reason).toBeTruthy()
    }
  })
})
