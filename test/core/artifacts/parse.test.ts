import { describe, expect, it } from 'vitest'
import {
  extractCitationRefs,
  findVagueTerms,
  isQuantified,
  knownScenarioIds,
  parseClarify,
  parseContext,
  parseDesign,
  parseIncrementalSpec,
  parseProjectDoc,
  parseProposal,
  parseRisk,
  parseRoadmap,
  parseTasks,
  parseTaskCardFragment,
  traceabilityMatrix,
  VAGUE_TERMS,
} from '../../../src/core/artifacts/parse'
import {
  CLARIFY_MD,
  CONTEXT_MD,
  DESIGN_MD,
  PROJECT_MD,
  PROPOSAL_MD,
  RISK_MD,
  ROADMAP_MD,
  SPEC_MD,
  TASKS_MD,
  validEvidence,
  validTaskCards,
} from '../../fixtures/artifacts/helpers'

describe('parseClarify', () => {
  const doc = parseClarify(CLARIFY_MD)

  it('保留 raw 原文', () => {
    expect(doc.raw).toBe(CLARIFY_MD)
  })

  it('解析原始描述', () => {
    expect(doc.originalDescription).toContain('加个会员续费功能')
  })

  it('解析已知事实、引用与状态', () => {
    expect(doc.knownFacts).toHaveLength(2)
    expect(doc.knownFacts[0]!.citations[0]).toMatchObject({
      file: 'src/main/java/com/acme/member/Member.java',
      startLine: 3,
      endLine: 4,
    })
    expect(doc.knownFacts[0]!.status).toBe('confirmed')
    expect(doc.knownFacts[1]!.status).toBe('derived')
  })

  it('解析六要素表', () => {
    expect(doc.elements.goal.conclusion).toContain('自助完成续费')
    expect(doc.elements.boundary.conclusion).toContain('不做')
    expect(doc.elements.unknowns.status).toContain('假设')
    expect(doc.elements.acceptance.conclusion).toContain('R1.S1')
  })

  it('解析问答记录与轮次', () => {
    expect(doc.qa).toHaveLength(2)
    expect(doc.qa[0]!.question).toContain('到期日')
    expect(doc.qa[0]!.changed).toContain('顺延')
    expect(doc.qa[0]!.round).toBe(1)
    expect(doc.rounds).toBe(2)
  })

  it('解析假设与未决问题（无 → 空）', () => {
    expect(doc.assumptions).toHaveLength(2)
    expect(doc.openQuestions).toEqual([])
  })

  it('宽容：段落式六要素（### 标题、无表格）', () => {
    const raw = [
      '# 澄清',
      '### 目标',
      '会员可以自助续费。',
      '### 边界（做 / 不做）',
      '做续费；不做退款。',
      '### 角色与权限',
      '已登录会员。',
      '### 验收标准',
      'R1.S1 通过。',
      '### 约束（非功能）',
      'p95 < 300ms。',
      '### 未知与假设',
      '支付平台会重试。',
    ].join('\n')
    const parsed = parseClarify(raw)
    expect(parsed.elements.goal.conclusion).toContain('自助续费')
    expect(parsed.elements.unknowns.conclusion).toContain('重试')
  })

  it('宽容：空文本返回空结构而不是抛错', () => {
    const parsed = parseClarify('')
    expect(parsed.knownFacts).toEqual([])
    expect(parsed.qa).toEqual([])
    expect(parsed.elements.goal.conclusion).toBe('')
  })
})

describe('parseProposal', () => {
  const doc = parseProposal(PROPOSAL_MD)
  it('解析 why / what / impact / 不做', () => {
    expect(doc.why).toContain('客服成本高')
    expect(doc.what).toContain('续费入口')
    expect(doc.impact).toContain('renewal')
    expect(doc.outOfScope).toEqual(['不做退款流程', '不做后台报表'])
  })
  it('宽容：缺段返回空字符串', () => {
    const parsed = parseProposal('# 提案\n\n只有一句话。')
    expect(parsed.outOfScope).toEqual([])
    expect(parsed.what).toBe('')
  })
})

describe('parseIncrementalSpec', () => {
  const doc = parseIncrementalSpec(SPEC_MD)
  it('解析需求与场景', () => {
    expect(doc.requirements).toHaveLength(1)
    expect(doc.requirements[0]!.id).toBe('R1')
    expect(doc.requirements[0]!.changeType).toBe('ADDED')
    expect(doc.requirements[0]!.text).toContain('SHALL')
    expect(doc.scenarios.map((scenario) => scenario.id)).toEqual(['R1.S1', 'R1.S2'])
    expect(doc.scenarios[0]!.given).toHaveLength(1)
    expect(doc.scenarios[0]!.when).toHaveLength(1)
    expect(doc.scenarios[0]!.then[0]).toContain('HTTP 200')
  })

  it('解析 ADDED / MODIFIED / REMOVED 三种变更类型', () => {
    const raw = [
      '## ADDED Requirements',
      '',
      '### Requirement: R1 新增能力',
      '系统 SHALL 提供新能力。',
      '',
      '#### Scenario: R1.S1 新能力可用',
      '- GIVEN 系统已部署',
      '- WHEN 用户调用',
      '- THEN 返回 HTTP 200',
      '',
      '## MODIFIED Requirements',
      '',
      '### Requirement: R2 修改能力',
      '系统 SHALL 修改行为。',
      '',
      '#### Scenario: R2.S1 新行为',
      '- GIVEN 旧行为',
      '- WHEN 用户调用',
      '- THEN 新行为生效',
      '',
      '## REMOVED Requirements',
      '',
      '### Requirement: R3 移除的能力',
      '移除原因：不再需要。',
    ].join('\n')
    const parsed = parseIncrementalSpec(raw)
    expect(parsed.requirements.map((requirement) => [requirement.id, requirement.changeType])).toEqual([
      ['R1', 'ADDED'],
      ['R2', 'MODIFIED'],
      ['R3', 'REMOVED'],
    ])
    expect(parsed.scenarios).toHaveLength(2)
  })

  it('宽容：无法识别时返回空结构', () => {
    const parsed = parseIncrementalSpec('随便写点东西，没有需求。')
    expect(parsed.requirements).toEqual([])
    expect(parsed.scenarios).toEqual([])
  })
})

describe('parseContext / parseDesign / parseRisk', () => {
  it('context 解析命名段与引用', () => {
    const doc = parseContext(CONTEXT_MD)
    expect(doc.sections.map((section) => section.title)).toContain('接口约束')
    const interfaceSection = doc.sections.find((section) => section.title === '接口约束')!
    expect(interfaceSection.citations).toHaveLength(1)
    expect(interfaceSection.citations[0]!.file).toContain('Member.java')
  })

  it('design 解析方案、推荐、数据流、错误处理、回滚', () => {
    const doc = parseDesign(DESIGN_MD)
    expect(doc.options).toHaveLength(2)
    expect(doc.options[0]!.name).toContain('方案 A')
    expect(doc.options[0]!.pros.length).toBeGreaterThan(0)
    expect(doc.options[0]!.cons.length).toBeGreaterThan(0)
    expect(doc.recommendation).toContain('方案 A')
    expect(doc.dataFlow).toContain('RenewalService')
    expect(doc.errorHandling).toContain('401')
    expect(doc.rollback).toContain('回退')
    expect(doc.architecture).toContain('外部服务')
  })

  it('design 支持表格形式的方案对比', () => {
    const raw = [
      '## 方案对比',
      '',
      '| 方案 | 说明 | 优点 | 缺点 |',
      '|---|---|---|---|',
      '| A 唯一索引 | 数据库幂等 | 简单 | 需迁移 |',
      '| B 先查后写 | 应用层幂等 | 无迁移 | 并发风险 |',
      '',
      '## 推荐',
      '选 A。',
    ].join('\n')
    const doc = parseDesign(raw)
    expect(doc.options).toHaveLength(2)
    expect(doc.options[1]!.name).toContain('B')
    expect(doc.options[0]!.pros).toContain('简单')
  })

  it('risk 解析五类与高风险人工标记', () => {
    const doc = parseRisk(RISK_MD)
    expect(doc.entries).toHaveLength(5)
    const security = doc.entries.find((entry) => entry.category === 'security')!
    expect(security.grade).toBe('high')
    expect(security.needsHuman).toBe(true)
    expect(security.mitigation).toContain('SignatureVerifier')
    const cost = doc.entries.find((entry) => entry.category === 'cost')!
    expect(cost.grade).toBe('none')
  })

  it('宽容：空文档不抛错', () => {
    expect(parseContext('').sections).toEqual([])
    expect(parseDesign('').options).toEqual([])
    expect(parseRisk('').entries).toEqual([])
  })
})

describe('parseTasks', () => {
  const doc = parseTasks(TASKS_MD)
  it('解析任务卡字段', () => {
    expect(doc.tasks).toHaveLength(4)
    const t1 = doc.tasks.find((task) => task.id === 'T1')!
    expect(t1.title).toContain('续费接口')
    expect(t1.covers).toEqual(['R1.S2'])
    expect(t1.scope).toEqual(['src/main/java/com/acme/member/renewal/**'])
    expect(t1.newFiles).toHaveLength(1)
    expect(t1.tdd).toBe('required')
    expect(t1.run).toBe('main')
    expect(t1.size).toBe('S')
    expect(t1.verify[0]).toMatchObject({ group: 'renewal-unit', command: './mvnw -B -q -Dtest=RenewalCallbackTest test' })
    expect(t1.verify[0]!.inputs).toContain('pom.xml')
    expect(t1.body).toContain('实现续费下单')
  })

  it('解析依赖与 chore 理由', () => {
    const t2 = doc.tasks.find((task) => task.id === 'T2')!
    expect(t2.dependsOn).toEqual(['T1'])
    const t3 = doc.tasks.find((task) => task.id === 'T3')!
    expect(t3.covers).toEqual([])
    expect(t3.choreReason).toContain('配置')
  })

  it('解析任务卡内联 changes 声明（删除 / 重命名）', () => {
    const raw = [
      '## T9 清理旧入口',
      '',
      '```yaml',
      'covers: [R1.S1]',
      'scope:',
      '  - src/main/java/com/acme/member/renewal/**',
      'changes:',
      '  - { path: src/main/java/com/acme/member/renewal/LegacyHandler.java, kind: delete }',
      '  - { path: src/main/java/com/acme/member/renewal/Old.java, kind: rename, to: src/main/java/com/acme/member/renewal/New.java }',
      'verify:',
      '  - group: unit',
      '    command: ./mvnw -B test',
      '    inputs: [pom.xml]',
      '```',
    ].join('\n')
    const parsed = parseTasks(raw)
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0]!.changes).toEqual([
      { path: 'src/main/java/com/acme/member/renewal/LegacyHandler.java', kind: 'delete' },
      {
        path: 'src/main/java/com/acme/member/renewal/Old.java',
        kind: 'rename',
        to: 'src/main/java/com/acme/member/renewal/New.java',
      },
    ])
  })

  it('解析执行计划', () => {
    expect(doc.execution.batches).toHaveLength(2)
    expect(doc.execution.batches[0]).toMatchObject({ batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2'] })
    expect(doc.execution.batches[1]).toMatchObject({ batch: 'B2', mode: 'parallel', tasks: ['T3', 'T4'] })
    expect(doc.execution.batches[1]!.why).toContain('互不重叠')
  })

  it('宽容：没有任务卡时返回空结构', () => {
    const parsed = parseTasks('只有说明文字。')
    expect(parsed.tasks).toEqual([])
    expect(parsed.execution.batches).toEqual([])
  })
})

describe('parseProjectDoc / parseRoadmap', () => {
  it('解析 project.md 技术栈、模块、命令、读取记录', () => {
    const doc = parseProjectDoc(PROJECT_MD)
    expect(doc.name).toBe('会员续费示例')
    expect(doc.stack.length).toBeGreaterThanOrEqual(2)
    expect(doc.stack[0]!.status).toBe('confirmed')
    expect(doc.modules.map((module) => module.path)).toEqual(['src', 'docs'])
    expect(doc.commands.test).toBe('pnpm test')
    expect(doc.commands.typecheck).toBe('pnpm exec tsc --noEmit')
    expect(doc.readFiles).toEqual(['package.json', 'pnpm-lock.yaml'])
    expect(doc.conventions).toContain('使用 TypeScript strict')
    expect(doc.forbidden[0]).toContain('.flowgate/state')
  })

  it('解析 roadmap 表格与 MVP 切线', () => {
    const doc = parseRoadmap(ROADMAP_MD)
    expect(doc.title).toBe('会员管理系统')
    expect(doc.mvpCut).toContain('C0–C1')
    expect(doc.entries.map((entry) => entry.change)).toEqual(['C0', 'C1', 'C2'])
    expect(doc.entries[1]).toMatchObject({ capability: '会员续费', dependsOn: ['C0'], estimatedTasks: 8, mvp: true })
    expect(doc.entries[2]!.mvp).toBe(false)
  })

  it('宽容：空 project / roadmap 返回空结构', () => {
    expect(parseProjectDoc('').modules).toEqual([])
    expect(parseRoadmap('').entries).toEqual([])
  })
})

describe('模糊词与可量化判定', () => {
  it('识别中英文模糊词', () => {
    expect(findVagueTerms('续费要快')).toContain('快')
    expect(findVagueTerms('交互要快速、友好')).toEqual(expect.arrayContaining(['快速', '友好']))
    expect(findVagueTerms('Use a user-friendly and fast UI')).toEqual(
      expect.arrayContaining(['user-friendly', 'fast']),
    )
    expect(findVagueTerms('as soon as possible')).toContain('as soon as possible')
    expect(VAGUE_TERMS).toContain('适当')
  })

  it('快照里的「快」不算模糊词', () => {
    expect(findVagueTerms('记录快照并在快照之后继续')).not.toContain('快')
  })

  it('可量化判定', () => {
    expect(isQuantified('p95 < 300ms')).toBe(true)
    expect(isQuantified('接口返回 HTTP 200')).toBe(true)
    expect(isQuantified('10 秒内返回')).toBe(true)
    expect(isQuantified('最多 3 次重试')).toBe(true)
    expect(isQuantified('错误率 < 0.1%')).toBe(true)
    expect(isQuantified('续费要快')).toBe(false)
    expect(isQuantified('体验良好')).toBe(false)
  })
})

describe('extractCitationRefs', () => {
  it('解析 文件:起止行 与单行引用', () => {
    const refs = extractCitationRefs('见 src/a.ts:12-34 与 RenewalService.java:80，还有 README.md:3')
    expect(refs).toHaveLength(3)
    expect(refs[0]).toMatchObject({ file: 'src/a.ts', startLine: 12, endLine: 34 })
    expect(refs[1]).toMatchObject({ file: 'RenewalService.java', startLine: 80, endLine: 80 })
  })

  it('解析 JSON 引用对象（含 quote）', () => {
    const text = '{"file": "src/main/java/com/acme/member/RenewalService.java", "start_line": 80, "end_line": 95, "quote": "public void renew() {"}'
    const refs = extractCitationRefs(text)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      file: 'src/main/java/com/acme/member/RenewalService.java',
      startLine: 80,
      endLine: 95,
      quote: 'public void renew() {',
    })
  })

  it('去重并忽略绝对路径 / 越界路径', () => {
    const refs = extractCitationRefs('a.ts:1-2 a.ts:1-2 /abs/x.ts:3 ../outside.ts:4')
    expect(refs.map((ref) => ref.file)).toEqual(['a.ts'])
  })
})

describe('traceabilityMatrix', () => {
  const spec = parseIncrementalSpec(SPEC_MD)
  const tasks = validTaskCards()

  it('场景 → 任务 → 证据矩阵', () => {
    const matrix = traceabilityMatrix(spec, tasks, validEvidence())
    expect(matrix.rows).toHaveLength(2)
    expect(matrix.uncoveredScenarios).toEqual([])
    const s1 = matrix.rows.find((row) => row.scenarioId === 'R1.S1')!
    expect(s1.taskIds).toEqual(['T2'])
    expect(s1.evidenceIds).toContain('E-0003')
    expect(s1.covered).toBe(true)
  })

  it('未覆盖场景会列出', () => {
    const matrix = traceabilityMatrix(spec, tasks.filter((task) => task.id !== 'T2'), [])
    expect(matrix.uncoveredScenarios).toEqual(['R1.S1'])
  })

  it('knownScenarioIds 返回大写编号集合', () => {
    const ids = knownScenarioIds(spec)
    expect(ids.has('R1.S1')).toBe(true)
    expect(ids.has('R9.S9')).toBe(false)
  })
})

describe('parseTaskCardFragment', () => {
  const fragment = [
    '## T9 补充回归',
    '',
    '```yaml',
    'covers: [R1.S1]',
    'scope: [src/index.ts]',
    'verify:',
    '  - group: unit',
    '    command: pnpm test',
    '    inputs: [src/index.ts]',
    'tdd: optional',
    'size: S',
    'run: main',
    '```',
    '',
    '补充回归验证。',
  ].join('\n')

  it('解析单个任务卡片段（标题 + YAML）', () => {
    const card = parseTaskCardFragment(fragment)
    expect(card?.id).toBe('T9')
    expect(card?.title).toBe('补充回归')
    expect(card?.scope).toEqual(['src/index.ts'])
    expect(card?.run).toBe('main')
    expect(card?.verify[0]?.command).toBe('pnpm test')
  })

  it('没有任务标题或为空时返回 null', () => {
    expect(parseTaskCardFragment('')).toBeNull()
    expect(parseTaskCardFragment('not-a-task-card')).toBeNull()
  })
})
