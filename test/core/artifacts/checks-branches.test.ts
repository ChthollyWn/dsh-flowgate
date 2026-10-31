/**
 * Branch-focused tests for the gate check table (artifacts/checks.ts).
 *
 * Each case builds a deliberately incomplete / degraded GateCheckContext (missing
 * artifact, low complexity, skeleton change, high risk, analysis kind, bad
 * commands, cycles, …) and asserts the check outcome, covering the failure arms
 * of every check family.
 */
import { describe, expect, it } from 'vitest'
import type {
  ArtifactBundle,
  CheckOutcome,
  ContextDoc,
  DesignDoc,
  GateCheckContext,
  ProjectDoc,
  Requirement,
  RiskDoc,
  RiskEntry,
  RoadmapDoc,
  Scenario,
  SpecDoc,
  TaskCard,
  TasksDoc,
} from '../../../src/core/types'
import {
  checkAnalysisCitations,
  checkBaseline,
  checkChangeCreated,
  checkClarifySixElements,
  checkContextCitations,
  checkContextSections,
  checkDesignOptions,
  checkFrozenArtifacts,
  checkG5FinalReview,
  checkG5FullTests,
  checkG5LintBuild,
  checkG5RuntimeEvidence,
  checkG6ExternalChanges,
  checkG6G5Passed,
  checkG6ManualEvidence,
  checkG6Risks,
  checkG6TaskCompletion,
  checkLevelsSet,
  checkNewFiles,
  checkOpenQuestions,
  checkOutOfScope,
  checkPlan,
  checkProjectClarify,
  checkProjectCommands,
  checkRiskCategories,
  checkScenarioCoverage,
  checkScenariosTestable,
  checkScenarioVagueTerms,
  checkSpecFormat,
  checkTaskCards,
  checkTaskCount,
  checkTestNoneRisk,
  checkTitleGoal,
  checkTraceability,
  checkVerifyCommands,
  checksForGate,
  gateProfile,
  isSkeletonChange,
  requiredArtifactsFor,
  runGateChecks,
} from '../../../src/core/artifacts/checks'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  CLARIFY,
  CONTEXT,
  DESIGN,
  PROJECT,
  RISK,
  ROADMAP,
  SPEC,
  TASKS,
  levelFor,
  makeCtx,
  makeFs,
  taskCard,
  validBundle,
  validChange,
  validEvidence,
  validExecutionPlan,
  defaultFiles,
  validTaskCards,
  RENEWAL_SCOPE,
} from '../../fixtures/artifacts/helpers'

function ctx(overrides: Partial<GateCheckContext> = {}): GateCheckContext {
  return makeCtx(overrides)
}

function expectFail(outcome: CheckOutcome, keyword?: string): void {
  expect(outcome.passed).toBe(false)
  if (keyword) expect(`${outcome.hint ?? ''} ${(outcome.details ?? []).join(' ')}`).toContain(keyword)
}

function scenario(id: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    id,
    requirementId: id.split('.')[0]!,
    title: '',
    given: ['会员已到期'],
    when: ['调用续费接口'],
    then: ['到期日顺延 30 天，p95 < 300ms'],
    raw: '',
    ...overrides,
  }
}

function requirement(id: string, scenarios: Scenario[], overrides: Partial<Requirement> = {}): Requirement {
  return { id, title: id, text: '', scenarios, changeType: 'ADDED', ...overrides }
}

function spec(overrides: Partial<SpecDoc> = {}): SpecDoc {
  return {
    raw: '## ADDED Requirements',
    requirements: [requirement('R1', [scenario('R1.S1')])],
    scenarios: [scenario('R1.S1')],
    ...overrides,
  }
}

function tasks(tasksList: TaskCard[], overrides: Partial<TasksDoc> = {}): TasksDoc {
  return { raw: '', tasks: tasksList, execution: validExecutionPlan(), ...overrides }
}

function design(overrides: Partial<DesignDoc> = {}): DesignDoc {
  return { ...DESIGN, ...overrides }
}

function riskEntry(overrides: Partial<RiskEntry>): RiskEntry {
  return { category: 'security', grade: 'medium', reason: '理由', mitigation: '缓解', verification: '验证', needsHuman: false, ...overrides }
}

function riskDoc(entries: RiskEntry[]): RiskDoc {
  return { raw: '', entries }
}

function project(overrides: Partial<ProjectDoc>): ProjectDoc {
  return { ...PROJECT, ...overrides }
}

function contextDoc(sections: ContextDoc['sections']): ContextDoc {
  return { raw: '', sections }
}

describe('artifacts/checks — profile / skeleton / 元数据', () => {
  it('gateProfile 与 isSkeletonChange 的分支', () => {
    expect(gateProfile(validChange({ complexity: 'high', risk: 'high' }))).toEqual(levelFor('high', 'high'))
    // roadmap 字段直接是 C0
    expect(isSkeletonChange(ctx({ change: validChange({ roadmap: 'c0' }) }))).toBe(true)
    // 路线图第一项是 C0 且标题含骨架
    const roadmap: RoadmapDoc = { raw: '', title: 't', mvpCut: '', entries: [{ change: 'C0' } as RoadmapDoc['entries'][number]] }
    expect(isSkeletonChange(ctx({ change: validChange({ title: '工程骨架变更' }), roadmap }))).toBe(true)
    expect(isSkeletonChange(ctx({ change: validChange({ title: '工程骨架变更' }), roadmap: { ...roadmap, entries: [] } }))).toBe(true)
    expect(isSkeletonChange(ctx({ change: validChange({ title: '会员续费' }), roadmap: { ...roadmap, entries: [{ change: 'C1' } as RoadmapDoc['entries'][number]] } }))).toBe(false)
  })

  it('requiredArtifactsFor 覆盖各 gate 的 switch 分支', () => {
    expect(requiredArtifactsFor('G1')).toEqual(['clarify', 'proposal', 'spec'])
    expect(requiredArtifactsFor('G2')).toEqual(['context'])
    expect(requiredArtifactsFor('G3')).toEqual(['design', 'risk', 'tasks'])
    expect(requiredArtifactsFor('G0')).toEqual([])
    expect(requiredArtifactsFor('GR')).toEqual([])
    expect(requiredArtifactsFor('G5')).toEqual([])
  })
})

describe('artifacts/checks — G0', () => {
  it('标题 / 等级 / 契约 / 变更目录的失败分支', async () => {
    expectFail(checkTitleGoal(ctx({ change: validChange({ title: '', summary: '' }) })), '标题为空')
    expect(await checkLevelsSet(ctx({ change: validChange({ risk: 'weird' as never, complexity: 'weird' as never }) })).passed).toBe(false)
    expect(checkLevelsSet(ctx({ change: validChange({ risk: 'weird' as never }) })).hint).toBeTruthy()
    expect(checkTitleGoal(ctx()).passed).toBe(true)

    // 变更目录存在（默认 fixture 有 status.json）
    expect((await checkChangeCreated(ctx())).passed).toBe(true)
    // 目录不存在 -> 失败；fs.exists 抛错 -> 另一条失败提示
    const files = defaultFiles()
    delete files['.flowgate/changes/C-001/status.json']
    expect((await checkChangeCreated(ctx({ fs: new MemoryFileSystem(files) }))).passed).toBe(false)
    const broken = Object.create(makeFs()) as MemoryFileSystem
    Object.defineProperty(broken, 'exists', { value: async () => { throw new Error('EACCES') } })
    expectFail(await checkChangeCreated(ctx({ fs: broken })), '无法访问文件系统')
  })
})

describe('artifacts/checks — G1', () => {
  it('六要素：缺 clarify / 低复杂度只要求两要素 / 假设视为已接受 / 缺要素详情', () => {
    expectFail(checkClarifySixElements(ctx({ artifacts: validBundle({ clarify: undefined }) })), '缺少 clarify.md')
    const low = ctx({ change: validChange({ complexity: 'low' }), artifacts: validBundle({ clarify: undefined }) })
    expectFail(checkClarifySixElements(low), '缺少 clarify.md')
    const partial = { ...CLARIFY, elements: { ...CLARIFY.elements } }
    partial.elements.goal = { conclusion: '', source: '', status: '已接受为假设' }
    partial.elements.boundary = { conclusion: '', source: '', status: '' }
    const outcome = checkClarifySixElements(ctx({ artifacts: validBundle({ clarify: partial }) }))
    expectFail(outcome, '边界')
  })

  it('场景形状：缺 spec / 无需求 / 缺 GIVEN/WHEN/THEN', () => {
    expectFail(checkScenarioCoverage(ctx({ artifacts: validBundle({ spec: undefined }) })), '缺少增量规格')
    expectFail(checkScenarioCoverage(ctx({ artifacts: validBundle({ spec: spec({ requirements: [], scenarios: [] }) }) })), 'Requirement')
    const shapeProblems = checkScenarioCoverage(
      ctx({
        artifacts: validBundle({
          spec: spec({
            requirements: [requirement('R1', [scenario('R1.S1', { given: [], when: [], then: [] })])],
            scenarios: [scenario('R1.S1', { given: [], when: [], then: [] })],
          }),
        }),
      }),
    )
    expectFail(shapeProblems)
    expect(shapeProblems.details?.join(' ')).toContain('GIVEN')
    expect(shapeProblems.details?.join(' ')).toContain('WHEN')
    expect(shapeProblems.details?.join(' ')).toContain('THEN')
  })

  it('模糊词：缺 spec / 未量化 THEN / 已量化 THEN 通过', () => {
    expectFail(checkScenarioVagueTerms(ctx({ artifacts: validBundle({ spec: undefined }) })), '缺少增量规格')
    const vague = spec({ scenarios: [scenario('R1.S1', { then: ['响应尽快完成'] })] })
    const vagueOutcome = checkScenarioVagueTerms(ctx({ artifacts: validBundle({ spec: vague }) }))
    expectFail(vagueOutcome, '尽快')
    expect(vagueOutcome.details?.length).toBeGreaterThan(0)
    // THEN 里有数字阈值 -> 跳过
    const quantified = spec({ scenarios: [scenario('R1.S1', { then: ['p95 < 300ms 且返回 200'] })] })
    expect(checkScenarioVagueTerms(ctx({ artifacts: validBundle({ spec: quantified }) })).passed).toBe(true)
    // 一句未量化 + 一句量化：仍有问题
    const mixed = spec({ scenarios: [scenario('R1.S1', { then: ['尽快返回', 'p95 < 300ms'] })] })
    expect(checkScenarioVagueTerms(ctx({ artifacts: validBundle({ spec: mixed }) })).passed).toBe(false)
  })

  it('checkScenariosTestable 组合形状与模糊词失败', () => {
    const badShape = checkScenariosTestable(ctx({ artifacts: validBundle({ spec: spec({ requirements: [] }) }) }))
    expectFail(badShape)
    expect(badShape.item).toBe('g1.scenarios')
    const badThen = checkScenariosTestable(
      ctx({ artifacts: validBundle({ spec: spec({ scenarios: [scenario('R1.S1', { then: ['尽快完成'] })] }) }) }),
    )
    expectFail(badThen)
    expect(badThen.item).toBe('g1.scenarios')
    expect(checkScenariosTestable(ctx()).passed).toBe(true)
  })

  it('不做清单 / 未决问题 / 规格格式的失败分支', () => {
    expectFail(checkOutOfScope(ctx({ artifacts: validBundle({ proposal: undefined }) })), '缺少 proposal.md')
    expectFail(checkOpenQuestions(ctx({ artifacts: validBundle({ clarify: undefined }) })), '缺少 clarify.md')
    expectFail(checkOpenQuestions(ctx({ artifacts: validBundle({ clarify: { ...CLARIFY, openQuestions: ['还要决定支付渠道'] } }) })), '未决问题')
    expect(checkOpenQuestions(ctx()).passed).toBe(true)

    expectFail(checkSpecFormat(ctx({ artifacts: validBundle({ spec: undefined }) })), '缺少增量规格')
    // 没有 ADDED/MODIFIED/REMOVED 小节、编号非法 / 重复、场景编号前缀不一致 / 重复
    const raw = '只是普通文本'
    const badSpec: SpecDoc = {
      raw,
      requirements: [
        requirement('R1', [scenario('R1.S1'), scenario('R1.S1'), scenario('x')]),
        requirement('R1', []),
        requirement('BAD', []),
      ],
      scenarios: [scenario('R1.S1'), scenario('R1.S1'), scenario('x')],
    }
    const specOutcome = checkSpecFormat(ctx({ artifacts: validBundle({ spec: badSpec }) }))
    expectFail(specOutcome, 'ADDED')
    const details = specOutcome.details?.join(' ') ?? ''
    expect(details).toContain('需求编号重复')
    expect(details).toContain('场景编号非法')
    expect(details).toContain('不一致')
    expect(details).toContain('场景编号重复')
  })

  it('已知事实引用的缺 clarify / 假设跳过 / 核验失败 / 无事实通过', async () => {
    expectFail(await checkAnalysisCitations(ctx({ artifacts: validBundle({ clarify: undefined }) })), '缺少 clarify.md')
    const noFacts = { ...CLARIFY, knownFacts: [] }
    expect((await checkAnalysisCitations(ctx({ artifacts: validBundle({ clarify: noFacts }) }))).details).toEqual(['没有记录已知事实'])
    // 假设 / 待确认状态跳过；confirmed 但无引用 -> 问题
    const facts = {
      ...CLARIFY,
      knownFacts: [
        { text: '假设事实', citations: [], status: 'assumption' as const },
        { text: '待确认事实', citations: [], status: 'pending' as const },
        { text: '没有引用的已确认事实', citations: [], status: 'confirmed' as const },
        { text: '引用不存在文件', citations: [{ file: 'no/such.ts', startLine: 1, endLine: 1 }], status: 'confirmed' as const },
      ],
    }
    const failed = await checkAnalysisCitations(ctx({ artifacts: validBundle({ clarify: facts }) }))
    expectFail(failed, '核验失败')
    expect((failed.details ?? []).join(' ')).toContain('no/such.ts')
  })
})

describe('artifacts/checks — G2', () => {
  it('context 段与引用：低复杂度跳过 / 缺 context / 缺段 / 无引用', () => {
    const low = ctx({ change: validChange({ complexity: 'low' }) })
    expect(checkContextSections(low).passed).toBe(true)
    expect(checkContextCitations(low).passed).toBe(true)
    expectFail(checkContextSections(ctx({ artifacts: validBundle({ context: undefined }) })), '缺少 context.md')
    expectFail(checkContextCitations(ctx({ artifacts: validBundle({ context: undefined }) })), '缺少 context.md')

    const missingSections = contextDoc([{ title: '接口约束', body: '有内容', citations: [] }])
    const sectionOutcome = checkContextSections(ctx({ artifacts: validBundle({ context: missingSections }) }))
    expectFail(sectionOutcome, '数据模型')
    // 有内容的接口段但没有引用
    const noCitation = checkContextCitations(ctx({ artifacts: validBundle({ context: missingSections }) }))
    expectFail(noCitation, '没有源码引用')
    // 空 body 的接口段被跳过（不产生问题）
    const emptyBody = contextDoc([{ title: '接口约束', body: '   ', citations: [] }])
    expect(checkContextCitations(ctx({ artifacts: validBundle({ context: emptyBody }) })).passed).toBe(true)
  })

  it('project 命令：analysis / 缺 project 的骨架与非骨架 / 命令形状 / 空命令', () => {
    expect(checkProjectCommands(ctx({ change: validChange({ kind: 'analysis' }) })).passed).toBe(true)
    // 缺 project：骨架放行，非骨架失败
    const noProject = ctx({ project: null })
    expect(checkProjectCommands(ctx({ change: validChange({ title: '工程骨架' }), project: undefined })).passed).toBe(true)
    expectFail(checkProjectCommands(noProject), '缺少 project.md')

    const emptyCommands = ctx({ project: project({ commands: {} }) })
    expectFail(checkProjectCommands(emptyCommands), '命令段为空')

    const badShape = ctx({ project: project({ commands: { test: 'pnpm test', lint: 'eslint . && echo ok' } }) })
    expectFail(checkProjectCommands(badShape), '形状非法')

    // 非 test 命令写 none
    expectFail(checkProjectCommands(ctx({ project: project({ commands: { test: 'pnpm test', build: 'none' } }) })), '不能写成 none')
    // test: none 且无其它基线命令
    expectFail(checkProjectCommands(ctx({ project: project({ commands: { test: 'none' } }) })), '至少要配置')
    // test 缺失但 build 存在 -> 通过
    expect(checkProjectCommands(ctx({ project: project({ commands: { build: 'pnpm build', run: 'pnpm dev', health: 'curl localhost:3000' } }) })).passed).toBe(true)

    // 骨架 + 非法命令：skeleton 分支产生问题后落到最终失败
    const skeletonBad = ctx({
      change: validChange({ title: '工程骨架', roadmap: 'C0' }),
      project: project({ commands: { lint: 'a && b' } }),
    })
    expectFail(checkProjectCommands(skeletonBad), '形状非法')
    // 骨架 + 合法命令 -> 骨架放行分支
    const skeletonOk = ctx({ change: validChange({ title: '工程骨架', roadmap: 'C0' }), project: project({ commands: { test: 'none', lint: 'pnpm lint' } }) })
    expect(checkProjectCommands(skeletonOk).passed).toBe(true)
  })

  it('基线：analysis / 未声明测试用 build-lint 回执 / test: none 无基线 / 无法解析 / 0 测试 / 正常', () => {
    expect(checkBaseline(ctx({ change: validChange({ kind: 'analysis' }) })).passed).toBe(true)
    const noTestDeclared = project({ commands: { build: 'pnpm build', lint: 'pnpm lint' } })
    expect(checkBaseline(ctx({ project: noTestDeclared })).passed).toBe(true)
    // test: none 且没有任何 build/lint/typecheck 通过回执
    expectFail(checkBaseline(ctx({ project: project({ commands: { test: 'none' } }), evidence: [] })), 'test: none')
    expectFail(checkBaseline(ctx({ project: project({ commands: {} }), evidence: [] })), '未声明测试命令')

    // 有 change.baseline 的场景
    const baseline = (summary: object | null) => ctx({ change: validChange({ baseline: { commit: null, summary: summary as never, recordedAt: 'x' } }) })
    expect(checkBaseline(baseline({ parser: 'x', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 })).passed).toBe(true)
    expectFail(checkBaseline(baseline(null)), '测试输出未能解析')
    expectFail(checkBaseline(baseline({ parser: 'x', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 })), '测试输出未能解析')
    // 骨架 + 0 测试 -> 放行；非骨架 0 测试 -> 失败
    expect(
      checkBaseline(
        ctx({
          change: validChange({ title: '工程骨架', roadmap: 'C0', baseline: { commit: null, summary: { parser: 'x', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 }, recordedAt: 'x' } }),
        }),
      ).passed,
    ).toBe(true)
    expectFail(checkBaseline(baseline({ parser: 'x', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 })), '没有跑到任何测试')
    // 未声明测试 + baseline -> 用 build/lint 证据；无证据也放行（该分支只收集详情）
    expect(checkBaseline(ctx({ project: noTestDeclared, change: validChange({ baseline: { commit: null, summary: { parser: 'x', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 }, recordedAt: 'x' } }) })).passed).toBe(true)

    // 无 baseline、声明了测试但无 test 回执 -> 失败
    expectFail(checkBaseline(ctx({ evidence: [] })), '基线测试')
    // 有 test 回执但输出未解析
    const unparsed = ctx({ evidence: [{ ...validEvidence()[1]!, summary: null }] })
    expectFail(checkBaseline(unparsed), '未能解析')
  })
})

describe('artifacts/checks — G3', () => {
  it('设计 / 风险：低复杂度免检 / 缺文档 / 方案数量与字段缺失 / 高风险 / 超高复杂度', () => {
    const low = ctx({ change: validChange({ complexity: 'low' }), level: levelFor('low', 'normal') })
    expect(checkDesignOptions(low).passed).toBe(true)
    expect(checkRiskCategories(low).passed).toBe(true)

    // medium 缺 design -> 放行；high 缺 design -> 失败
    expect(checkDesignOptions(ctx({ artifacts: validBundle({ design: undefined }) })).passed).toBe(true)
    expectFail(checkDesignOptions(ctx({ change: validChange({ risk: 'high' }), artifacts: validBundle({ design: undefined }) })), '缺少 design.md')

    const emptyDesign = design({ options: [], recommendation: '', dataFlow: '', errorHandling: '', rollback: '', architecture: '' })
    const designProblems = checkDesignOptions(ctx({ change: validChange({ complexity: 'ultra', risk: 'high' }), artifacts: validBundle({ design: emptyDesign }) }))
    expectFail(designProblems, '方案数量')
    const details = designProblems.details?.join(' ') ?? ''
    expect(details).toContain('推荐')
    expect(details).toContain('数据流')
    expect(details).toContain('错误处理')
    expect(details).toContain('回滚')
    expect(details).toContain('架构边界')

    // 四个方案也视为不合法
    expect(checkDesignOptions(ctx({ artifacts: validBundle({ design: design({ options: [...DESIGN.options, ...DESIGN.options] }) }) })).passed).toBe(false)

    // 风险：缺 risk.md / 缺类别 / 高风险理由为空 / 高风险缺人工/缓解/验证
    expect(checkRiskCategories(ctx({ artifacts: validBundle({ risk: undefined }) })).passed).toBe(false)
    const badRisk = riskDoc([
      riskEntry({ category: 'security', grade: 'high', reason: '', needsHuman: false, mitigation: '', verification: '' }),
      riskEntry({ category: 'performance', grade: 'medium', reason: '—' }),
    ])
    const riskProblems = checkRiskCategories(ctx({ artifacts: validBundle({ risk: badRisk }) }))
    expectFail(riskProblems, '缺少「成本」类别')
    const riskDetails = riskProblems.details?.join(' ') ?? ''
    expect(riskDetails).toContain('缺少风险理由')
    expect(riskDetails).toContain('需要人工接管确认')
    expect(riskDetails).toContain('缺少缓解措施')
    expect(riskDetails).toContain('缺少验证方式')
  })

  it('任务卡：缺 tasks / 空任务 / 重复编号 / 依赖不存在与成环 / covers 缺失或不存在 / scope 非法 / 文件数超限', async () => {
    expectFail(await checkTaskCards(ctx({ artifacts: validBundle({ tasks: undefined }) })), '缺少 tasks.md')
    expectFail(await checkTaskCards(ctx({ artifacts: validBundle({ tasks: tasks([]) }) })), '没有解析到任何任务卡')

    const cyclic = [
      taskCard({ id: 'T1', title: 'A', dependsOn: ['T2'], scope: [RENEWAL_SCOPE], covers: ['R1.S1'], verify: [{ group: 'g', command: 'pnpm test', inputs: ['pom.xml'] }] }),
      taskCard({ id: 'T2', title: 'B', dependsOn: ['T1'], scope: [RENEWAL_SCOPE], covers: ['R1.S1'], verify: [{ group: 'g', command: 'pnpm test', inputs: ['pom.xml'] }] }),
      taskCard({ id: 'T3', title: '', dependsOn: ['T9'], scope: ['', '/abs', '../up'], covers: ['R9.S9'] }),
      taskCard({ id: 'T3', title: 'dup', scope: [RENEWAL_SCOPE], covers: ['R1.S1'] }),
    ]
    const structural = await checkTaskCards(
      ctx({ artifacts: validBundle({ spec: spec(), tasks: tasks(cyclic) }) }),
    )
    expectFail(structural, '依赖成环')
    const details = structural.details?.join(' ') ?? ''
    expect(details).toContain('任务编号重复')
    expect(details).toContain('依赖了不存在的任务')
    expect(details).toContain('scope 路径非法')
    expect(details).toContain('缺少标题')
    expect(details).toContain('covers 引用了不存在的场景')

    // 任务没有 covers 也没 choreReason
    const noCovers = await checkTaskCards(
      ctx({
        artifacts: validBundle({
          spec: spec(),
          tasks: tasks([
            taskCard({ id: 'T1', title: 'x', scope: ['src/**'] }),
            taskCard({ id: 'T2', title: 'y', covers: ['R1.S1'], scope: [], verify: [{ group: 'g', command: 'pnpm test', inputs: ['pom.xml'] }] }),
          ]),
        }),
      }),
    )
    expectFail(noCovers, '没有覆盖任何场景')
    expect(noCovers.details?.join(' ')).toContain('scope 为空')

    // 缺少 spec：专项提示
    const noSpec = await checkTaskCards(ctx({ artifacts: validBundle({ spec: undefined, tasks: tasks(validTaskCards()) }) }))
    expectFail(noSpec, '缺少增量规格（spec.md），无法检查场景覆盖')

    // 宽泛 scope + 单任务文件数超限 + size S 文件数 > 2
    const broad = await checkTaskCards(
      ctx({
        artifacts: validBundle({
          spec: spec(),
          tasks: tasks([taskCard({ id: 'T1', title: 'x', covers: ['R1.S1'], scope: ['src', '**', 'docs/**', 'a/*'], size: 'S' })]),
        }),
      }),
    )
    expectFail(broad, '范围过宽')
  })

  it('new_files / verify / taskCount / traceability / plan 的失败分支', () => {
    expectFail(checkNewFiles(ctx({ artifacts: validBundle({ tasks: undefined }) })), '缺少 tasks.md')
    const badNewFiles = tasks([
      taskCard({
        id: 'T1',
        title: 'x',
        covers: ['R1.S1'],
        scope: [RENEWAL_SCOPE],
        newFiles: ['', '**', 'src/**', 'outside/file.ts'],
        verify: [{ group: '', command: '', inputs: [] }, { group: 'g', command: 'pnpm test && rm x', inputs: [] }],
      }),
      taskCard({ id: 'T4', title: 'no verify', covers: ['R1.S1'], scope: [RENEWAL_SCOPE], verify: [] }),
    ])
    const newFiles = checkNewFiles(ctx({ artifacts: validBundle({ tasks: badNewFiles }) }))
    expectFail(newFiles, '根级通配')
    const nfDetails = newFiles.details?.join(' ') ?? ''
    expect(nfDetails).toContain('不在 scope 内')
    expect(nfDetails).toContain('src/**')

    const verify = checkVerifyCommands(ctx({ artifacts: validBundle({ tasks: badNewFiles }) }))
    expectFail(verify, '验证组')
    const verifyDetails = verify.details?.join(' ') ?? ''
    expect(verifyDetails).toContain('没有验证组')
    expect(verifyDetails).toContain('命令为空')
    expect(verifyDetails).toContain('形状非法')
    expect(verifyDetails).toContain('inputs 为空')

    expectFail(checkTaskCount(ctx({ artifacts: validBundle({ tasks: undefined }) })), '缺少 tasks.md')
    // 上限调小 -> 失败
    expect(checkTaskCount(ctx({ limits: { ...makeCtx().limits, change_max_tasks: 2 } })).passed).toBe(false)
    // limits 缺失时用 config.limits（并触发 maxTasks 回退）
    const noLimits = { ...ctx(), limits: undefined as never }
    expect(checkTaskCount(noLimits).passed).toBe(true)
    expect(checkTaskCount(ctx({ limits: { ...makeCtx().limits, change_max_tasks: 0 } })).passed).toBe(true)

    expectFail(checkTraceability(ctx({ artifacts: validBundle({ spec: undefined }) })), '缺少增量规格')
    expectFail(checkTraceability(ctx({ artifacts: validBundle({ tasks: undefined }) })), '缺少 tasks.md')
    const uncovered = checkTraceability(
      ctx({ artifacts: validBundle({ spec: spec({ requirements: [requirement('R1', [scenario('R1.S1'), scenario('R1.S2')])], scenarios: [scenario('R1.S1'), scenario('R1.S2')] }), tasks: tasks([taskCard({ id: 'T1', title: 'x', covers: ['R1.S1', 'R9.S9'], scope: ['src/**'] })]) }) }),
    )
    expectFail(uncovered, '未被任何任务覆盖')
    expect((uncovered.details ?? []).join(' ')).toContain('不存在的场景')

    expectFail(checkPlan(ctx({ artifacts: validBundle({ tasks: undefined }) })), '缺少 tasks.md')
  })

  it('冻结产物：未冻结通过 / 未知 key 跳过 / 文件缺失 / hash 不一致', () => {
    expect(checkFrozenArtifacts(ctx()).passed).toBe(true)
    const frozenChange = validChange({ frozen: { 'x/unknown.md': { hash: 'sha256:1', at: 'x' } } })
    expect(checkFrozenArtifacts(ctx({ change: frozenChange })).passed).toBe(true)
    const frozen = validChange({
      frozen: {
        'nope/unknown.md': { hash: 'sha256:1', at: 'x' },
        'old/clarify.md': { hash: 'sha256:1', at: 'x' },
        'design.md': { hash: 'sha256:stale', at: 'x' },
      },
    })
    const outcome = checkFrozenArtifacts(
      ctx({ change: frozen, artifacts: validBundle({ clarify: undefined, design: DESIGN }) }),
    )
    expectFail(outcome, '已冻结')
    expect((outcome.details ?? []).join(' ')).toContain('当前文件缺失或无法解析')
    expect((outcome.details ?? []).join(' ')).toContain('已被修改')
  })
})

describe('artifacts/checks — G5 / G6', () => {
  it('G5 全量测试：analysis / test:none / 无回执 / 未解析 / 0 测试 / 失败 / 回归 / 通过', () => {
    expect(checkG5FullTests(ctx({ change: validChange({ kind: 'analysis' }) })).passed).toBe(true)
    expect(checkG5FullTests(ctx({ project: project({ commands: { test: 'none' } }), evidence: [] })).passed).toBe(true)
    expectFail(checkG5FullTests(ctx({ evidence: [] })), '缺少全量测试回执')
    expectFail(checkG5FullTests(ctx({ evidence: [{ ...validEvidence()[1]!, summary: null }] })), '未能解析')
    expectFail(
      checkG5FullTests(
        ctx({ evidence: [{ ...validEvidence()[1]!, summary: { parser: 'x', parsed: true, run: 0, passed: 0, failed: 0, skipped: 0 } }] }),
      ),
      '没有跑到任何测试',
    )
    const failed = { ...validEvidence()[1]!, exitCode: 1, summary: { parser: 'x', parsed: true, run: 3, passed: 2, failed: 1, skipped: 0, failures: [{ name: 'f1' }, { name: 'f2' }] } }
    expectFail(checkG5FullTests(ctx({ evidence: [failed] })), '全量测试失败')
    const regression = { ...validEvidence()[1]!, summary: { parser: 'x', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0, regressions: ['旧用例失败'] } }
    expectFail(checkG5FullTests(ctx({ evidence: [regression] })), '回归')
    expect(checkG5FullTests(ctx()).passed).toBe(true)
  })

  it('G5 lint/build：空配置通过 / 缺回执详情 / 失败 / 通过', () => {
    expect(checkG5LintBuild(ctx({ project: project({ commands: {} }), evidence: [] })).details).toEqual(['未配置 lint / build / typecheck 命令'])
    const missing = checkG5LintBuild(ctx({ project: project({ commands: { lint: 'pnpm lint', build: 'pnpm build' } }), evidence: [] }))
    expect(missing.passed).toBe(true)
    expect((missing.details ?? []).join(' ')).toContain('未收集到 lint 回执')
    const failedReceipt = validEvidence().map((receipt) => (receipt.kind === 'lint' ? { ...receipt, exitCode: 1 } : receipt))
    expectFail(checkG5LintBuild(ctx({ project: project({ commands: { lint: 'pnpm lint' } }), evidence: failedReceipt })), 'lint 失败')
    expect(checkG5LintBuild(ctx()).passed).toBe(true)
  })

  it('G5 运行证据：高风险缺回执 / 高风险有回执 / 普通风险 run 命令缺回执 / 有回执 / 未配置 run', () => {
    expectFail(checkG5RuntimeEvidence(ctx({ change: validChange({ risk: 'high' }), evidence: [] })), '高风险变更需要运行证据')
    const runReceipt = { ...validEvidence()[0]!, kind: 'run' as const, exitCode: 1 }
    expectFail(checkG5RuntimeEvidence(ctx({ change: validChange({ risk: 'high' }), evidence: [runReceipt] })), '高风险变更需要运行证据')
    expect(checkG5RuntimeEvidence(ctx({ change: validChange({ risk: 'high' }), evidence: [{ ...runReceipt, exitCode: 0 }] })).passed).toBe(true)
    expect(checkG5RuntimeEvidence(ctx({ project: project({ commands: { run: 'pnpm dev' } }), evidence: [] })).passed).toBe(true)
    expect(checkG5RuntimeEvidence(ctx({ project: project({ commands: { run: 'pnpm dev' } }), evidence: [{ ...runReceipt, exitCode: 0 }] })).passed).toBe(true)
    expect(checkG5RuntimeEvidence(ctx()).passed).toBe(true)
  })

  it('G5 终审：review 关闭 / 缺终审 / changes-required / critical-major / 高风险缺安全审查 / 安全审查未过 / 通过', () => {
    const reviews = (list: unknown[], risk: 'normal' | 'high' = 'normal', enabled = true) =>
      ctx({ change: validChange({ reviews: list as never, risk }), config: { ...makeCtx().config, review: { enabled, model: null, requireForTaskGate: true } } })
    expect(checkG5FinalReview(reviews([], 'normal', false)).passed).toBe(true)
    expectFail(checkG5FinalReview(reviews([])), '缺少 S5 终审记录')
    expectFail(
      checkG5FinalReview(reviews([{ id: 'R1', kind: 'final', verdict: 'changes-required', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '2', attempts: 1 }])),
      'changes-required',
    )
    const critical = checkG5FinalReview(
      reviews([
        {
          id: 'R1',
          kind: 'final',
          verdict: 'pass',
          findings: [{ severity: 'major', file: 'src/a.ts', message: '大问题' }],
          coverageOk: true,
          diffFingerprint: '',
          createdAt: '2',
          attempts: 1,
        },
      ]),
    )
    expectFail(critical, 'critical / major')
    expectFail(
      checkG5FinalReview(reviews([{ id: 'R1', kind: 'final', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '1', attempts: 1 }], 'high')),
      '安全审查',
    )
    expectFail(
      checkG5FinalReview(
        reviews(
          [
            { id: 'R1', kind: 'final', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '1', attempts: 1 },
            { id: 'R2', kind: 'security', verdict: 'changes-required', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '2', attempts: 1 },
          ],
          'high',
        ),
      ),
      '安全审查未通过',
    )
    expect(
      checkG5FinalReview(
        reviews(
          [
            { id: 'R1', kind: 'final', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '1', attempts: 1 },
            { id: 'R2', kind: 'security', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '2', attempts: 1 },
          ],
          'high',
        ),
      ).passed,
    ).toBe(true)
  })

  it('G6 任务完成 / G5 已通过 / 风险 / 手工证据 / 非 agent 改动', () => {
    expectFail(checkG6TaskCompletion(ctx({ change: validChange({ tasks: {}, batches: [] }) })), '没有任何任务记录')
    expect(
      checkG6TaskCompletion(
        ctx({ change: validChange({ tasks: { T1: { id: 'T1', batch: 'B1', status: 'running', tdd: 'none', evidenceIds: [], reviewIds: [] } }, batches: [{ id: 'B1', mode: 'sequential', status: 'running', tasks: ['T1'] }] }) }),
    ).passed === false)
    expect(checkG6TaskCompletion(ctx()).passed).toBe(true)

    expectFail(checkG6G5Passed(ctx({ change: validChange({ gates: {} }) })), '未提交')
    expect(checkG6G5Passed(ctx()).details).toBeUndefined()

    const riskCtx = ctx({
      change: validChange({
        risk: 'high',
        pending: [{ id: 'RK-1', kind: 'risk', changeId: 'C-001', title: '风险', detail: '', status: 'open', createdAt: 'x' }],
        violations: [{ id: 'V1', changeId: 'C-001', path: 'src/x.ts', kind: 'outside-scope', detectedAt: 'x', source: 'pre' }],
      }),
      artifacts: validBundle({ risk: riskDoc([riskEntry({ category: 'security', grade: 'high', needsHuman: false })]), design: design({ rollback: '' }) }),
    })
    const riskProblems = checkG6Risks(riskCtx)
    expectFail(riskProblems, '风险接管项未处理')
    const riskDetails = riskProblems.details?.join(' ') ?? ''
    expect(riskDetails).toContain('未清理的越界记录')
    expect(riskDetails).toContain('未安排人工确认')
    expect(riskDetails).toContain('缺少回滚方案')
    expect(checkG6Risks(ctx()).passed).toBe(true)

    expect(checkG6ManualEvidence(ctx()).details).toEqual(['没有手工证据项'])
    const manual = { id: 'M1', changeId: 'C-001', group: 'manual', kind: 'manual' as const, phase: 'green' as const, command: 'manual', runBy: 'agent' as const, exitCode: 0, summary: null, inputsHash: '', outputRef: '', startedAt: 'x', finishedAt: 'x' }
    expect(checkG6ManualEvidence(ctx({ change: validChange({ risk: 'high' }), evidence: [] })).passed).toBe(false)
    expect(checkG6ManualEvidence(ctx({ evidence: [{ ...manual, exitCode: 1 }] })).passed).toBe(false)
    expect(checkG6ManualEvidence(ctx({ evidence: [manual] })).passed).toBe(true)

    expect(checkG6ExternalChanges(ctx()).passed).toBe(true)
    const external = ctx({
      change: validChange({
        pending: [
          { id: 'CF-1', kind: 'conflict', changeId: 'C-001', title: '冲突', detail: '', status: 'open', createdAt: 'x' },
          { id: 'RK-1', kind: 'risk', changeId: 'C-001', title: '风险', detail: '', status: 'open', createdAt: 'x' },
        ],
        violations: [{ id: 'V1', changeId: 'C-001', path: 'src/x.ts', kind: 'outside-scope', detectedAt: 'x', source: 'pre' }],
      }),
    })
    expectFail(checkG6ExternalChanges(external), '未处理的人工确认项')
    expect((checkG6ExternalChanges(external).details ?? []).join(' ')).toContain('未清理的越界改动')
  })
})

describe('artifacts/checks — runGateChecks / checksForGate', () => {
  it('按 stage 推导 gate、缺 gate 返回空、检查抛错被捕获', async () => {
    // analysis 变更用 G1 检查全部跑通
    const outcomes = await runGateChecks(ctx({ gate: 'G1', artifacts: validBundle({ spec: undefined }) }))
    expect(outcomes.length).toBeGreaterThan(0)
    expect(outcomes.every((outcome) => typeof outcome.passed === 'boolean')).toBe(true)
    // 没有 gate 且 stage 不在映射表 -> 空数组
    const archived = await runGateChecks(ctx({ change: validChange({ stage: 'archived' }), gate: undefined as never }))
    expect(archived).toEqual([])
    // stage 推导 gate（S3 -> G3）且 level 回退 gateProfile
    const derived = { ...ctx({ gate: undefined as never }), level: undefined as never }
    const derivedOutcomes = await runGateChecks(derived)
    expect(derivedOutcomes.some((outcome) => outcome.item === 'g3.taskCards')).toBe(true)
    // clarify.knownFacts 为 null 时 check 抛错 -> 被捕获成 fail 结果
    const throwing = ctx({ gate: 'G1', artifacts: validBundle({ clarify: { ...CLARIFY, knownFacts: null as never } }) })
    const throwingOutcomes = await runGateChecks(throwing)
    const citations = throwingOutcomes.find((outcome) => outcome.item === 'g1.factsCitations')
    expect(citations?.passed).toBe(false)
    expect(citations?.hint).toContain('检查执行失败')
    // checksForGate：合并门（low complexity 的 G3 并入 G1 检查）
    const merged = checksForGate('G3', { ...levelFor('low', 'normal'), mergedGates: true })
    expect(merged.some((definition) => definition.id.startsWith('g1.'))).toBe(true)
    const lean = checksForGate('G3', levelFor('low', 'normal'))
    expect(lean.some((definition) => definition.id === 'g3.design')).toBe(false)
  })
})
