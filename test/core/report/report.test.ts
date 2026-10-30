import { describe, expect, it } from 'vitest'
import type {
  ArtifactBundle,
  ChangeStatus,
  EvidenceReceipt,
  LedgerEvent,
  MetricSet,
  ReviewRecord,
} from '../../../src/core/types'
import { STAGE_LEARNING_CARDS, STAGE_CARD_TITLES, escapeHtml, renderChangeReport } from '../../../src/core/report'

const CHANGE: ChangeStatus = {
  id: 'C-003',
  kind: 'change',
  title: '会员续费',
  summary: '已过期会员可以续费恢复权益，重复回调不重复扣费',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S6',
  lifecycle: 'active',
  branch: 'flowgate/C-003',
  gates: {
    G0: { state: 'passed', attempts: 1, passedAt: '2026-11-12T09:05:00+08:00' },
    G1: { state: 'passed', attempts: 1, approvedAt: '2026-11-12T09:20:00+08:00' },
    G3: { state: 'passed', attempts: 1, approvedAt: '2026-11-12T09:50:00+08:00' },
    G6: { state: 'awaiting', attempts: 1 },
  },
  batches: [
    { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'], startedAt: '2026-11-12T10:00:00+08:00', completedAt: '2026-11-12T10:20:00+08:00', checkpoint: { status: 'passed', at: '2026-11-12T10:20:00+08:00' } },
    { id: 'B2', mode: 'parallel', status: 'done', tasks: ['T2', 'T3'], startedAt: '2026-11-12T10:20:00+08:00', completedAt: '2026-11-12T10:35:00+08:00', checkpoint: { status: 'passed', at: '2026-11-12T10:35:00+08:00' } },
  ],
  tasks: {
    T1: { id: 'T1', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-1', 'E-2'], reviewIds: ['R-1'], startedAt: '2026-11-12T10:00:00+08:00', finishedAt: '2026-11-12T10:20:00+08:00' },
    T2: { id: 'T2', batch: 'B2', status: 'done', tdd: 'green', evidenceIds: ['E-3'], reviewIds: [], worktree: '.flowgate/worktrees/T2', startedAt: '2026-11-12T10:20:00+08:00', finishedAt: '2026-11-12T10:35:00+08:00' },
    T3: { id: 'T3', batch: 'B2', status: 'done', tdd: 'none', evidenceIds: ['E-4'], reviewIds: [], startedAt: '2026-11-12T10:20:00+08:00', finishedAt: '2026-11-12T10:30:00+08:00' },
  },
  evidenceIds: ['E-1', 'E-2', 'E-3', 'E-4'],
  pending: [
    {
      id: 'RK-1',
      kind: 'risk',
      changeId: 'C-003',
      title: '依赖变更：新增 caffeine',
      detail: 'pom.xml 新增依赖缓存库',
      status: 'approved',
      createdAt: '2026-11-12T09:30:00+08:00',
      decidedAt: '2026-11-12T09:32:00+08:00',
      decisionReason: '允许一次',
    },
  ],
  overrides: [],
  exceptions: [],
  violations: [
    {
      id: 'V-1',
      changeId: 'C-003',
      taskId: 'T2',
      path: 'src/main/java/com/example/Wrong.java',
      kind: 'outside-scope',
      detectedAt: '2026-11-12T10:25:00+08:00',
      source: 'pre',
      clearedAt: '2026-11-12T10:26:00+08:00',
    },
  ],
  reviews: [],
  createdAt: '2026-11-12T09:00:00+08:00',
  updatedAt: '2026-11-12T12:00:00+08:00',
}

const ARTIFACTS: ArtifactBundle = {
  clarify: {
    raw: '',
    originalDescription: '给会员系统加续费功能，要求重复回调不重复扣费',
    knownFacts: [],
    elements: {
      goal: { conclusion: '续费可用', source: 'clarify.md', status: 'confirmed' },
      boundary: { conclusion: '只做续费', source: 'clarify.md', status: 'confirmed' },
      roles: { conclusion: '会员', source: 'clarify.md', status: 'confirmed' },
      acceptance: { conclusion: 'R1.S1/R1.S2', source: 'clarify.md', status: 'confirmed' },
      constraints: { conclusion: '沿用现有支付', source: 'clarify.md', status: 'confirmed' },
      unknowns: { conclusion: '无', source: 'clarify.md', status: 'confirmed' },
    },
    qa: [
      { question: '续费起算点？', options: ['支付日', '到期日'], answer: '支付日', changed: '决定起算点', round: 1 },
      { question: '幂等键？', options: ['订单号', '用户'], answer: '(orderId, cycle)', changed: '决定幂等键', round: 2 },
    ],
    assumptions: ['沿用现有的支付回调协议'],
    openQuestions: [],
    rounds: 2,
  },
  proposal: {
    raw: '',
    why: '会员到期后流失',
    what: '增加续费入口与幂等回调',
    impact: '会员模块、支付回调',
    outOfScope: ['优惠券叠加', '自动续费签约'],
  },
  spec: {
    raw: '',
    requirements: [
      {
        id: 'R1',
        title: '会员续费',
        text: '会员可以续费',
        changeType: 'ADDED',
        scenarios: [
          { id: 'R1.S1', requirementId: 'R1', title: '正常续费', given: ['会员已过期'], when: ['发起续费'], then: ['会员恢复'], raw: '' },
          { id: 'R1.S2', requirementId: 'R1', title: '重复回调', given: ['同一订单'], when: ['回调两次'], then: ['只续费一次'], raw: '' },
        ],
      },
    ],
    scenarios: [
      { id: 'R1.S1', requirementId: 'R1', title: '正常续费', given: ['会员已过期'], when: ['发起续费'], then: ['会员恢复'], raw: '' },
      { id: 'R1.S2', requirementId: 'R1', title: '重复回调', given: ['同一订单'], when: ['回调两次'], then: ['只续费一次'], raw: '' },
    ],
  },
  context: {
    raw: '',
    sections: [{ title: '接口约束', body: 'POST /api/renewal 幂等键 (orderId, cycle)', citations: [{ file: 'RenewalService.java', startLine: 42, endLine: 88 }] }],
  },
  design: {
    raw: '',
    options: [
      { name: '方案 A：幂等表', summary: '新增幂等记录表', pros: ['可靠'], cons: ['需要迁移'] },
      { name: '方案 B：唯一索引', summary: '回调表唯一索引', pros: ['无需新表'], cons: ['受限于现有模型'] },
    ],
    recommendation: '方案 B，减少迁移风险',
    dataFlow: '支付回调 → 幂等校验 → 续费服务 → 会员状态',
    errorHandling: '幂等冲突返回 200，不重复扣费',
    rollback: '回滚数据库索引并关闭续费入口',
  },
  risk: {
    raw: '',
    entries: [
      {
        category: 'security',
        grade: 'high',
        reason: '回调伪造',
        mitigation: '验签 + 重放保护',
        verification: '伪造回调测试用例',
        needsHuman: true,
      },
      {
        category: 'maintainability',
        grade: 'low',
        reason: '幂等逻辑集中',
        mitigation: '单测覆盖',
        verification: '共享输入变化后重新验证',
        needsHuman: false,
      },
    ],
  },
  tasks: {
    raw: '',
    tasks: [
      {
        id: 'T1',
        title: '幂等键与复现测试',
        covers: ['R1.S2'],
        scope: ['src/main/java/com/example/**'],
        tests: ['src/test/java/com/example/**'],
        newFiles: [],
        changes: [],
        dependsOn: [],
        tdd: 'required',
        verify: [{ group: 'renewal-unit', command: './mvnw -B -q -Dtest=RenewalServiceTest test', inputs: ['src/**/*.java', 'pom.xml'] }],
        run: 'main',
        risk: ['security'],
        size: 'S',
        body: '',
      },
      {
        id: 'T2',
        title: '回调验签',
        covers: ['R1.S1'],
        scope: ['src/main/java/com/example/callback/**'],
        tests: ['src/test/java/com/example/callback/**'],
        newFiles: [],
        changes: [],
        dependsOn: ['T1'],
        tdd: 'required',
        verify: [{ group: 'callback-unit', command: './mvnw -B -q -Dtest=CallbackTest test', inputs: ['src/**/*.java'] }],
        run: 'subagent',
        runReason: '独立模块',
        risk: [],
        size: 'M',
        body: '',
      },
      {
        id: 'T3',
        title: '续费规则',
        covers: [],
        scope: ['src/main/java/com/example/renewal/**'],
        tests: [],
        newFiles: ['src/main/java/com/example/renewal/Rule.java'],
        changes: [{ path: 'src/main/java/com/example/legacy/OldRenewal.java', kind: 'delete' }],
        dependsOn: [],
        tdd: 'optional',
        verify: [],
        run: 'main',
        risk: [],
        size: 'S',
        body: '',
      },
    ],
    execution: {
      batches: [
        { batch: 'B1', mode: 'sequential', tasks: ['T1'], why: '先有复现测试' },
        { batch: 'B2', mode: 'parallel', tasks: ['T2', 'T3'], why: '范围不重叠' },
      ],
    },
  },
}

function summary(overrides: Partial<EvidenceReceipt['summary'] & object> = {}): EvidenceReceipt['summary'] {
  return { parser: 'junit-xml', parsed: true, run: 6, passed: 6, failed: 0, skipped: 0, ...overrides } as EvidenceReceipt['summary']
}

const EVIDENCE: EvidenceReceipt[] = [
  {
    id: 'E-1',
    changeId: 'C-003',
    taskId: 'T1',
    group: 'renewal-unit',
    kind: 'test',
    phase: 'red',
    command: './mvnw -B -q -Dtest=RenewalServiceTest test',
    runBy: 'flowgate',
    exitCode: 1,
    summary: { parser: 'junit-xml', parsed: true, run: 1, passed: 0, failed: 1, skipped: 0, failures: [{ name: 'RenewalServiceTest.duplicateCallbackIsIgnored', file: 'RenewalServiceTest.java', line: 88, message: 'expected: <2026-12-01> but was: <2026-12-31>' }] },
    inputsHash: 'sha256:a',
    outputRef: '.flowgate/state/evidence/E-1.log',
    startedAt: '2026-11-12T10:01:00+08:00',
    finishedAt: '2026-11-12T10:02:00+08:00',
  },
  {
    id: 'E-2',
    changeId: 'C-003',
    taskId: 'T1',
    group: 'renewal-unit',
    kind: 'test',
    phase: 'green',
    command: './mvnw -B -q -Dtest=RenewalServiceTest test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: summary(),
    inputsHash: 'sha256:b',
    outputRef: '.flowgate/state/evidence/E-2.log',
    startedAt: '2026-11-12T10:05:00+08:00',
    finishedAt: '2026-11-12T10:06:00+08:00',
  },
  {
    id: 'E-3',
    changeId: 'C-003',
    taskId: 'T2',
    group: 'callback-unit',
    kind: 'test',
    phase: 'green',
    command: './mvnw -B -q -Dtest=CallbackTest test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: summary({ run: 4, passed: 4 }),
    inputsHash: 'sha256:c',
    outputRef: '.flowgate/state/evidence/E-3.log',
    startedAt: '2026-11-12T10:22:00+08:00',
    finishedAt: '2026-11-12T10:23:00+08:00',
  },
  {
    id: 'E-4',
    changeId: 'C-003',
    taskId: 'T3',
    group: 'full-suite',
    kind: 'test',
    phase: 'green',
    command: './mvnw -B test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: summary({ run: 48, passed: 46, skipped: 2, regressions: [] }),
    inputsHash: 'sha256:d',
    outputRef: '.flowgate/state/evidence/E-4.log',
    startedAt: '2026-11-12T11:00:00+08:00',
    finishedAt: '2026-11-12T11:02:00+08:00',
  },
]

const REVIEWS: ReviewRecord[] = [
  {
    id: 'R-1',
    changeId: 'C-003',
    taskId: 'T1',
    kind: 'task',
    verdict: 'changes-required',
    findings: [{ severity: 'major', file: 'RenewalService.java', line: 42, rule: 'idempotency', message: '缺少幂等冲突处理' }],
    coverageOk: true,
    diffFingerprint: 'sha256:x',
    createdAt: '2026-11-12T10:10:00+08:00',
    attempts: 1,
  },
  {
    id: 'R-2',
    changeId: 'C-003',
    kind: 'final',
    verdict: 'pass',
    findings: [],
    coverageOk: true,
    diffFingerprint: 'sha256:y',
    createdAt: '2026-11-12T11:30:00+08:00',
    attempts: 1,
  },
]

function event(seq: number, type: LedgerEvent['type'], data: Record<string, unknown>, at: string): LedgerEvent {
  return { seq, at, type, data, prev: `sha256:prev${seq}` }
}

const LEDGER: LedgerEvent[] = [
  event(1, 'change.created', { changeId: 'C-003' }, '2026-11-12T09:00:00+08:00'),
  event(2, 'stage.entered', { changeId: 'C-003', stage: 'S0', gate: 'G0' }, '2026-11-12T09:00:00+08:00'),
  event(3, 'stage.entered', { changeId: 'C-003', stage: 'S1', gate: 'G0' }, '2026-11-12T09:10:00+08:00'),
  event(4, 'stage.entered', { changeId: 'C-003', stage: 'S2', gate: 'G1' }, '2026-11-12T09:30:00+08:00'),
  event(5, 'stage.entered', { changeId: 'C-003', stage: 'S3', gate: 'G2' }, '2026-11-12T09:40:00+08:00'),
  event(6, 'stage.entered', { changeId: 'C-003', stage: 'S4', gate: 'G3' }, '2026-11-12T10:00:00+08:00'),
  event(7, 'stage.entered', { changeId: 'C-003', stage: 'S5', gate: 'G4' }, '2026-11-12T10:35:00+08:00'),
  event(8, 'stage.entered', { changeId: 'C-003', stage: 'S6', gate: 'G5' }, '2026-11-12T11:30:00+08:00'),
  event(9, 'rule.denied', { changeId: 'C-003', ruleId: 'R-STAGE-SRC' }, '2026-11-12T10:01:00+08:00'),
  event(10, 'violation.detected', { changeId: 'C-003', path: 'src/Wrong.java' }, '2026-11-12T10:25:14+08:00'),
]

const METRICS: MetricSet = {
  changeId: 'C-003',
  generatedAt: '2026-11-12T12:00:00+08:00',
  metrics: Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => {
      const id = `M-${index + 1}`
      if (id === 'M-15' || id === 'M-16') return [id, '未知']
      if (id === 'M-9') return [id, 50]
      return [id, index + 1]
    }),
  ),
  notes: Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => [`M-${index + 1}`, index === 14 ? '需要对照测量，未采集' : `口径说明 ${index + 1}`]),
  ),
}

function reportInput(overrides: Partial<Parameters<typeof renderChangeReport>[0]> = {}): Parameters<typeof renderChangeReport>[0] {
  return {
    change: CHANGE,
    artifacts: ARTIFACTS,
    evidence: EVIDENCE,
    ledger: LEDGER,
    reviews: REVIEWS,
    metrics: METRICS,
    generatedAt: '2026-11-12T12:30:00+08:00',
    ...overrides,
  }
}

function sectionBody(html: string, id: string): string {
  const match = new RegExp(`<section class="card" id="${id}">([\\s\\S]*?)</section>`).exec(html)
  return match?.[1] ?? ''
}

describe('renderChangeReport：单文件 8 部分 HTML 报告', () => {
  const html = renderChangeReport(reportInput())

  it('生成完整 HTML 文档并内联 CSS / JS', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('FlowGate 交付报告')
  })

  it('8 个部分都存在且有内容', () => {
    const sections: [string, string][] = [
      ['sec-overview', '概览'],
      ['sec-requirements', '需求'],
      ['sec-plan', '计划'],
      ['sec-execution', '执行'],
      ['sec-verification', '验证'],
      ['sec-risks', '风险'],
      ['sec-metrics', '指标'],
      ['sec-appendix', '附录'],
    ]
    for (const [id, title] of sections) {
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(title)
      const body = sectionBody(html, id)
      expect(body.length, id).toBeGreaterThan(200)
    }
  })

  it('不引用任何外部资源', () => {
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i)
    expect(html).not.toContain('@import')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<iframe')
  })

  it('文件体积 < 2MB', () => {
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2 * 1024 * 1024)
  })

  it('概览包含复杂度、风险、阶段耗时条形图与门禁状态', () => {
    const overview = sectionBody(html, 'sec-overview')
    expect(overview).toContain('中')
    expect(overview).toContain('普通风险')
    expect(overview).toContain('bar-fill')
    expect(overview).toContain('S3')
    expect(overview).toContain('G6')
  })

  it('需求包含六要素、澄清问答与场景', () => {
    const requirements = sectionBody(html, 'sec-requirements')
    expect(requirements).toContain('六要素')
    expect(requirements).toContain('续费起算点？')
    expect(requirements).toContain('R1.S2')
    expect(requirements).toContain('重复回调')
  })

  it('计划包含方案对比、任务卡、执行计划与追溯矩阵', () => {
    const plan = sectionBody(html, 'sec-plan')
    expect(plan).toContain('方案对比')
    expect(plan).toContain('方案 B')
    expect(plan).toContain('T2')
    expect(plan).toContain('renewal-unit')
    expect(plan).toContain('追溯矩阵')
    expect(plan).toContain('已覆盖')
  })

  it('执行按批次与并行泳道排列时间线，含证据 / 拦截 / 审查', () => {
    const execution = sectionBody(html, 'sec-execution')
    expect(execution).toContain('执行流程图')
    expect(execution).toContain('B1')
    expect(execution).toContain('B2')
    expect(execution).toContain('并行')
    expect(execution).toContain('T1')
    expect(execution).toContain('bar-fill lane')
    expect(execution).toContain('V-1')
    expect(execution).toContain('R-1')
    expect(execution).toContain('E-2')
    expect(execution).toContain('并行加速比')
  })

  it('验证包含全量回归对比、证据列表与终审结论', () => {
    const verification = sectionBody(html, 'sec-verification')
    expect(verification).toContain('与基线的回归对比')
    expect(verification).toContain('无回归')
    expect(verification).toContain('全量测试回执')
    expect(verification).toContain('完整日志')
    expect(verification).toContain('终审结论')
    expect(verification).toContain('通过')
  })

  it('风险包含登记表与待处理项处理结果', () => {
    const risks = sectionBody(html, 'sec-risks')
    expect(risks).toContain('风险登记')
    expect(risks).toContain('安全')
    expect(risks).toContain('回调伪造')
    expect(risks).toContain('RK-1')
    expect(risks).toContain('已批准')
  })

  it('指标包含 M-1 ~ M-18，缺失值显示未知', () => {
    const metrics = sectionBody(html, 'sec-metrics')
    for (let index = 1; index <= 18; index += 1) {
      expect(metrics).toContain(`>M-${index}<`)
    }
    expect(metrics).toContain('未知')
    expect(metrics).toContain('FR-10.4')
  })

  it('附录包含产物路径与账本摘录', () => {
    const appendix = sectionBody(html, 'sec-appendix')
    expect(appendix).toContain('.flowgate/changes/C-003/clarify.md')
    expect(appendix).toContain('账本摘录')
    expect(appendix).toContain('change.created')
    expect(appendix).toContain('stage.entered')
  })

  it('渲染结果确定（同输入同输出）', () => {
    expect(renderChangeReport(reportInput())).toBe(html)
  })

  it('大量账本事件与证据时仍小于 2MB', () => {
    const manyLedger: LedgerEvent[] = Array.from({ length: 2000 }, (_, index) =>
      event(index + 1, index % 2 === 0 ? 'verify.receipt' : 'rule.denied', {
        changeId: 'C-003',
        evidenceId: `E-${index}`,
        ruleId: 'R-SCOPE',
        detail: `很长的账本数据 ${'x'.repeat(200)}`,
      }, '2026-11-12T10:00:00+08:00'),
    )
    const manyEvidence: EvidenceReceipt[] = Array.from({ length: 400 }, (_, index) => ({
      ...EVIDENCE[index % EVIDENCE.length]!,
      id: `E-${String(index + 1000)}`,
      command: `./mvnw -B -q -Dtest=SomeTest${index} test`,
      outputRef: `.flowgate/state/evidence/E-${String(index + 1000)}.log`,
    }))
    const html = renderChangeReport(reportInput({ ledger: manyLedger, evidence: manyEvidence }))
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2 * 1024 * 1024)
    expect(html).toContain('id="sec-appendix"')
  })

  it('没有产物时也能渲染 8 个部分', () => {
    const empty = renderChangeReport(reportInput({ artifacts: {}, evidence: [], reviews: [], ledger: [] }))
    for (const id of ['sec-overview', 'sec-requirements', 'sec-plan', 'sec-execution', 'sec-verification', 'sec-risks', 'sec-metrics', 'sec-appendix']) {
      expect(empty).toContain(`id="${id}"`)
      expect(sectionBody(empty, id).length, id).toBeGreaterThan(100)
    }
  })
})

describe('报告防 XSS：所有用户文本必须 HTML 转义', () => {
  it('变更标题与需求文本中的脚本/图片注入被转义', () => {
    const xss = '<script>alert("xss")</script><img src=x onerror=alert(1)>'
    const change: ChangeStatus = { ...CHANGE, title: xss, summary: xss }
    const artifacts: ArtifactBundle = {
      ...ARTIFACTS,
      clarify: { ...ARTIFACTS.clarify!, originalDescription: xss },
      tasks: {
        ...ARTIFACTS.tasks!,
        tasks: [{ ...ARTIFACTS.tasks!.tasks[0]!, title: xss }],
      },
    }
    const html = renderChangeReport(reportInput({ change, artifacts }))
    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('escapeHtml 覆盖 & < > " \'', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('日志/命令等账本数据中的 HTML 也被转义', () => {
    const ledger: LedgerEvent[] = [
      event(1, 'rule.denied', { changeId: 'C-003', ruleId: '<b>evil</b>' }, '2026-11-12T09:00:00+08:00'),
    ]
    const html = renderChangeReport(reportInput({ ledger }))
    expect(html).not.toContain('<b>evil</b>')
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;')
  })
})

describe('STAGE_LEARNING_CARDS：7 个阶段学习卡（+ 路线图 + 归档）', () => {
  it('覆盖 roadmap 与 S0–S6，每项六部分齐全且内容具体', () => {
    const required = ['roadmap', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const
    for (const stage of required) {
      const card = STAGE_LEARNING_CARDS[stage]
      expect(card, stage).toBeDefined()
      expect(card.what.length, `${stage}.what`).toBeGreaterThan(60)
      expect(card.why.length, `${stage}.why`).toBeGreaterThan(40)
      expect(card.criteria.length, `${stage}.criteria`).toBeGreaterThanOrEqual(3)
      expect(card.upstream.length, `${stage}.upstream`).toBeGreaterThan(20)
      expect(card.antiPatterns.length, `${stage}.antiPatterns`).toBeGreaterThanOrEqual(3)
      expect(card.good.length, `${stage}.good`).toBeGreaterThan(40)
      expect(card.bad.length, `${stage}.bad`).toBeGreaterThan(40)
      // 六部分都用中文书写
      const all = [card.what, card.why, card.criteria.join(''), card.upstream, card.antiPatterns.join(''), card.good, card.bad].join('')
      expect(all, stage).toMatch(/[\u4e00-\u9fa5]/)
    }
    expect(STAGE_CARD_TITLES.S3).toContain('设计')
  })

  it('归档阶段也有完整卡片（满足 Record<StageId, LearningCard>）', () => {
    const card = STAGE_LEARNING_CARDS.archived
    expect(card.what.length).toBeGreaterThan(20)
    expect(card.criteria.length).toBeGreaterThanOrEqual(3)
    expect(card.good.length).toBeGreaterThan(20)
  })

  it('每个阶段都写明了对应的上游做法', () => {
    for (const stage of ['roadmap', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const) {
      expect(STAGE_LEARNING_CARDS[stage].upstream, stage).toMatch(/借鉴|Superpowers|OpenSpec|gstack/)
    }
  })
})
