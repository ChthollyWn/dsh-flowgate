import { describe, expect, it } from 'vitest'
import type {
  ArtifactBundle,
  ChangeStatus,
  EvidenceReceipt,
  LedgerEvent,
  MetricSet,
  TestSummary,
} from '../../../src/core/types'
import { computeMetrics, formatMetricsText, metricsCsv } from '../../../src/core/metrics'

const CHANGE: ChangeStatus = {
  id: 'C-001',
  kind: 'change',
  title: '会员续费',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S5',
  lifecycle: 'active',
  gates: {
    G0: { state: 'passed', attempts: 1, passedAt: '2026-11-12T09:05:00+08:00' },
    G1: { state: 'passed', attempts: 2, approvedAt: '2026-11-12T09:30:00+08:00' },
    G2: { state: 'passed', attempts: 1, passedAt: '2026-11-12T09:35:00+08:00' },
    G3: { state: 'failed', attempts: 2 },
  },
  batches: [
    { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'], startedAt: '2026-11-12T09:40:00+08:00', completedAt: '2026-11-12T09:45:00+08:00' },
    { id: 'B2', mode: 'parallel', status: 'done', tasks: ['T2', 'T3'], startedAt: '2026-11-12T09:45:00+08:00', completedAt: '2026-11-12T09:50:00+08:00' },
  ],
  tasks: {
    T1: { id: 'T1', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-1', 'E-2'], reviewIds: ['R-1'], startedAt: '2026-11-12T09:40:00+08:00', finishedAt: '2026-11-12T09:45:00+08:00' },
    T2: { id: 'T2', batch: 'B2', status: 'done', tdd: 'green', evidenceIds: ['E-3'], reviewIds: [], startedAt: '2026-11-12T09:45:00+08:00', finishedAt: '2026-11-12T09:48:00+08:00' },
    T3: { id: 'T3', batch: 'B2', status: 'running', tdd: 'none', evidenceIds: [], reviewIds: [], startedAt: '2026-11-12T09:45:00+08:00', finishedAt: '2026-11-12T09:50:00+08:00' },
  },
  evidenceIds: ['E-1', 'E-2', 'E-3'],
  pending: [
    {
      id: 'RK-1',
      kind: 'risk',
      changeId: 'C-001',
      title: '依赖变更',
      detail: 'pom.xml 新增依赖',
      status: 'approved',
      createdAt: '2026-11-12T09:10:00+08:00',
      decidedAt: '2026-11-12T09:14:00+08:00',
      decisionReason: '允许一次',
    },
    {
      id: 'SC-1',
      kind: 'scope',
      changeId: 'C-001',
      title: '范围变更',
      detail: '',
      status: 'open',
      createdAt: '2026-11-12T09:50:00+08:00',
    },
  ],
  overrides: [
    { id: 'OV-1', ruleId: 'R-SCOPE', changeId: 'C-001', reason: '误判', actionFingerprint: 'fp', createdAt: '2026-11-12T09:12:00+08:00', usedAt: '2026-11-12T09:13:00+08:00' },
  ],
  exceptions: [],
  violations: [
    { id: 'V-1', changeId: 'C-001', path: 'src/Other.java', kind: 'outside-scope', detectedAt: '2026-11-12T09:41:00+08:00', source: 'pre' },
    { id: 'V-2', changeId: 'C-001', path: 'src/Typo.java', kind: 'undeclared-new-file', detectedAt: '2026-11-12T09:42:00+08:00', source: 'post', clearedAt: '2026-11-12T09:43:00+08:00' },
  ],
  reviews: [
    {
      id: 'R-1',
      changeId: 'C-001',
      taskId: 'T1',
      kind: 'task',
      verdict: 'changes-required',
      findings: [
        { severity: 'critical', file: 'src/RenewalService.java', line: 42, rule: 'idempotency', message: '缺少幂等键' },
        { severity: 'major', file: 'src/RenewalService.java', rule: 'error-handling', message: '异常被吞' },
        { severity: 'minor', file: 'src/RenewalService.java', rule: 'naming', message: '命名不一致' },
        { severity: 'minor', file: 'src/RenewalService.java', rule: 'comment', message: '缺少注释' },
      ],
      coverageOk: true,
      diffFingerprint: 'sha256:x',
      createdAt: '2026-11-12T09:44:00+08:00',
      attempts: 1,
    },
    {
      id: 'R-2',
      changeId: 'C-001',
      kind: 'final',
      verdict: 'pass',
      findings: [{ severity: 'minor', file: 'src/Other.java', rule: 'style', message: '格式建议' }],
      coverageOk: true,
      diffFingerprint: 'sha256:y',
      createdAt: '2026-11-12T09:55:00+08:00',
      attempts: 1,
    },
  ],
  createdAt: '2026-11-12T09:00:00+08:00',
  updatedAt: '2026-11-12T11:00:00+08:00',
}

const ARTIFACTS: ArtifactBundle = {
  clarify: {
    raw: '',
    originalDescription: '给会员系统加续费功能',
    knownFacts: [],
    elements: {
      goal: { conclusion: '续费可用', source: 'clarify', status: 'confirmed' },
      boundary: { conclusion: '只做续费', source: 'clarify', status: 'confirmed' },
      roles: { conclusion: '会员', source: 'clarify', status: 'confirmed' },
      acceptance: { conclusion: 'R1', source: 'clarify', status: 'confirmed' },
      constraints: { conclusion: '沿用现有支付', source: 'clarify', status: 'confirmed' },
      unknowns: { conclusion: '无', source: 'clarify', status: 'confirmed' },
    },
    qa: [
      { question: '起算点？', options: ['支付日', '到期日'], answer: '支付日', changed: '决定续费起算点', round: 1 },
      { question: '幂等键？', options: ['订单号', '用户'], answer: '(orderId, cycle)', changed: '决定幂等键', round: 2 },
    ],
    assumptions: [],
    openQuestions: [],
    rounds: 2,
  },
  spec: {
    raw: '',
    requirements: [
      {
        id: 'R1',
        title: '续费',
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
  tasks: {
    raw: '',
    tasks: [
      { id: 'T1', title: '续费幂等', covers: ['R1.S1'], scope: ['src/**'], tests: [], newFiles: [], changes: [], dependsOn: [], tdd: 'required', verify: [], run: 'main', risk: [], size: 'S', body: '' },
      { id: 'T2', title: '续费规则', covers: [], scope: ['src/**'], tests: [], newFiles: [], changes: [], dependsOn: ['T1'], tdd: 'required', verify: [], run: 'main', risk: [], size: 'S', body: '' },
      { id: 'T3', title: '回调幂等', covers: ['R1.S2'], scope: ['src/**'], tests: [], newFiles: [], changes: [], dependsOn: [], tdd: 'optional', verify: [], run: 'main', risk: [], size: 'S', body: '' },
    ],
    execution: {
      batches: [
        { batch: 'B1', mode: 'sequential', tasks: ['T1'], why: '先做基础' },
        { batch: 'B2', mode: 'parallel', tasks: ['T2', 'T3'], why: '范围不重叠' },
      ],
    },
  },
}

function summaryOf(overrides: Partial<TestSummary>): TestSummary {
  return { parser: 'junit-xml', parsed: true, run: 4, passed: 4, failed: 0, skipped: 0, ...overrides }
}

const EVIDENCE: EvidenceReceipt[] = [
  { id: 'E-1', changeId: 'C-001', taskId: 'T1', group: 'renewal-unit', kind: 'test', phase: 'red', command: 'mvn -B test', runBy: 'flowgate', exitCode: 1, summary: summaryOf({ run: 1, passed: 0, failed: 1, failures: [{ name: 'duplicateCallbackIsIgnored' }] }), inputsHash: 'sha256:a', outputRef: '.flowgate/state/evidence/E-1.log', startedAt: '2026-11-12T09:41:00+08:00', finishedAt: '2026-11-12T09:42:00+08:00' },
  { id: 'E-2', changeId: 'C-001', taskId: 'T1', group: 'renewal-unit', kind: 'test', phase: 'green', command: 'mvn -B test', runBy: 'flowgate', exitCode: 0, summary: summaryOf({}), inputsHash: 'sha256:b', outputRef: '.flowgate/state/evidence/E-2.log', startedAt: '2026-11-12T09:43:00+08:00', finishedAt: '2026-11-12T09:44:00+08:00' },
  { id: 'E-3', changeId: 'C-001', taskId: 'T2', group: 'renewal-rules', kind: 'test', phase: 'green', command: 'mvn -B test', runBy: 'flowgate', exitCode: 0, summary: summaryOf({}), inputsHash: 'sha256:c', outputRef: '.flowgate/state/evidence/E-3.log', startedAt: '2026-11-12T09:47:00+08:00', finishedAt: '2026-11-12T09:48:00+08:00' },
]

function event(seq: number, type: LedgerEvent['type'], data: Record<string, unknown> = {}, at = '2026-11-12T09:30:00+08:00'): LedgerEvent {
  return { seq, at, type, data, prev: 'sha256:prev' }
}

const LEDGER: LedgerEvent[] = [
  event(1, 'change.created', { changeId: 'C-001' }, '2026-11-12T09:00:00+08:00'),
  event(2, 'rule.denied', { changeId: 'C-001', ruleId: 'R-STAGE-SRC' }, '2026-11-12T09:10:00+08:00'),
  event(3, 'rule.denied', { changeId: 'C-001', ruleId: 'R-STAGE-SRC' }, '2026-11-12T09:11:00+08:00'),
  event(4, 'rule.denied', { changeId: 'C-001', ruleId: 'R-VERIFY', check: 'evidence' }, '2026-11-12T09:12:00+08:00'),
  event(5, 'rule.human', { changeId: 'C-001', ruleId: 'R-DEPENDENCY' }, '2026-11-12T09:13:00+08:00'),
  event(6, 'override.granted', { changeId: 'C-001', ruleId: 'R-DEPENDENCY', misjudged: true }, '2026-11-12T09:14:00+08:00'),
  event(7, 'stage.entered', { changeId: 'C-001', stage: 'S2' }, '2026-11-12T09:20:00+08:00'),
  event(8, 'stage.entered', { changeId: 'C-001', stage: 'S1', gate: 'G0' }, '2026-11-12T09:05:00+08:00'),
  event(9, 'stage.entered', { changeId: 'C-001', stage: 'S3', bypass: true }, '2026-11-12T09:25:00+08:00'),
  event(10, 'turn.continued', { changeId: 'C-001' }, '2026-11-12T09:46:00+08:00'),
  event(11, 'gate.submitted', { changeId: 'C-001', gate: 'G1' }, '2026-11-12T09:15:00+08:00'),
  event(12, 'gate.submitted', { changeId: 'C-001', gate: 'G1' }, '2026-11-12T09:20:00+08:00'),
  event(13, 'session.attached', { changeId: 'C-001' }, '2026-11-12T09:00:30+08:00'),
  event(14, 'checkpoint.failed', { changeId: 'C-001', batch: 'B2' }, '2026-11-12T09:50:00+08:00'),
  event(15, 'merge.conflict', { changeId: 'C-001', task: 'T2' }, '2026-11-12T09:51:00+08:00'),
  event(16, 'merge.conflict', { changeId: 'C-001', task: 'T3' }, '2026-11-12T09:52:00+08:00'),
  event(17, 'metrics.snapshot', { changeId: 'C-001', contextPeakRatio: 0.6 }, '2026-11-12T10:00:00+08:00'),
]

function compute(overrides: { evidence?: EvidenceReceipt[]; ledger?: LedgerEvent[]; now?: string } = {}): MetricSet {
  return computeMetrics({
    change: CHANGE,
    ledger: overrides.ledger ?? LEDGER,
    artifacts: ARTIFACTS,
    evidence: overrides.evidence ?? EVIDENCE,
    now: overrides.now ?? '2026-11-12T11:00:00+08:00',
  })
}

describe('computeMetrics：M-1 ~ M-18 与账本/状态逐条对应', () => {
  it('输出 18 个指标且每个都有统计口径说明', () => {
    const set = compute()
    expect(Object.keys(set.metrics)).toHaveLength(18)
    for (let index = 1; index <= 18; index += 1) {
      const id = `M-${index}`
      expect(set.metrics[id], id).toBeDefined()
      expect(typeof set.notes[id], id).toBe('string')
      expect(set.notes[id]!.length, id).toBeGreaterThan(0)
    }
    expect(set.changeId).toBe('C-001')
    expect(set.generatedAt).toBe('2026-11-12T11:00:00+08:00')
  })

  it('M-1 跳步拦截数来自 R-STAGE-SRC 拒绝事件', () => {
    expect(compute().metrics['M-1']).toBe(2)
  })

  it('M-2 实际跳步数来自缺少来源门禁的 stage.entered 审计', () => {
    expect(compute().metrics['M-2']).toBe(2)
  })

  it('M-2 正常走门禁流程时为 0，回退阶段不计跳步', () => {
    const normalLedger: LedgerEvent[] = [
      event(1, 'change.created', { changeId: 'C-001' }, '2026-11-12T09:00:00+08:00'),
      event(2, 'gate.passed', { changeId: 'C-001', gate: 'G0' }, '2026-11-12T09:05:00+08:00'),
      event(3, 'stage.entered', { changeId: 'C-001', stage: 'S1' }, '2026-11-12T09:05:00+08:00'),
      event(4, 'gate.submitted', { changeId: 'C-001', gate: 'G1' }, '2026-11-12T09:10:00+08:00'),
      event(5, 'gate.approved', { changeId: 'C-001', gate: 'G1' }, '2026-11-12T09:15:00+08:00'),
      event(6, 'stage.entered', { changeId: 'C-001', stage: 'S2' }, '2026-11-12T09:15:00+08:00'),
      event(7, 'gate.passed', { changeId: 'C-001', gate: 'G2' }, '2026-11-12T09:20:00+08:00'),
      event(8, 'stage.entered', { changeId: 'C-001', stage: 'S3' }, '2026-11-12T09:20:00+08:00'),
      // 风险提升导致从 S5 回退 S4：回退不是跳步。
      event(9, 'stage.entered', { changeId: 'C-001', stage: 'S5', reason: 'normal' }, '2026-11-12T09:30:00+08:00'),
      event(10, 'stage.entered', { changeId: 'C-001', stage: 'S4', reason: 'risk-raised' }, '2026-11-12T09:32:00+08:00'),
    ]
    // S5 进入缺少 G4 门禁 → 1 次跳步；回退到 S4 不计。
    const set = compute({ ledger: normalLedger })
    expect(set.metrics['M-2']).toBe(1)
    expect(set.notes['M-2']).toContain('回退')
  })

  it('M-3 越界尝试数与残留数', () => {
    const set = compute()
    expect(set.metrics['M-3']).toBe(2)
    expect(set.notes['M-3']).toContain('残留 1')
  })

  it('M-4 虚假完成拦截 = turn.continued + 证据类拒绝', () => {
    expect(compute().metrics['M-4']).toBe(2)
  })

  it('M-5 误判率 = 误判拦截 ÷ 全部拦截', () => {
    const set = compute()
    expect(set.metrics['M-5']).toBe(25)
    expect(set.notes['M-5']).toContain('全部拦截 4')
  })

  it('M-6 门禁首次通过率', () => {
    const set = compute()
    expect(set.metrics['M-6']).toBe(50)
    expect(set.notes['M-6']).toContain('2 ÷ 4')
  })

  it('M-7 澄清效率取轮数，问题/自定义回答写入口径', () => {
    const set = compute()
    expect(set.metrics['M-7']).toBe(2)
    expect(set.notes['M-7']).toContain('问题 2 个')
    expect(set.notes['M-7']).toContain('自定义回答 1 个')
  })

  it('M-8 G1 之后的重复提交计为需求返工', () => {
    expect(compute().metrics['M-8']).toBe(1)
  })

  it('M-9 验收覆盖率：只有带 GREEN 回执的任务覆盖的场景算数', () => {
    const set = compute()
    expect(set.metrics['M-9']).toBe(50)
    expect(set.notes['M-9']).toContain('1/2')
  })

  it('M-10 TDD 合规率：RED 必须早于 GREEN', () => {
    const set = compute()
    expect(set.metrics['M-10']).toBe(50)
    expect(set.notes['M-10']).toContain('1 ÷ 2')
  })

  it('M-11 审查发现总数与分级统计', () => {
    const set = compute()
    expect(set.metrics['M-11']).toBe(5)
    expect(set.notes['M-11']).toContain('critical 1')
    expect(set.notes['M-11']).toContain('major 1')
    expect(set.notes['M-11']).toContain('minor 3')
    expect(set.notes['M-11']).toContain('修复轮次 1')
  })

  it('M-13 人工负担：审批次数、放行次数、平均响应时间', () => {
    const set = compute()
    expect(set.metrics['M-13']).toBe(1)
    expect(set.notes['M-13']).toContain('单次放行 1 次')
    expect(set.notes['M-13']).toContain('4 分钟')
  })

  it('M-14 阶段成本：总耗时分钟', () => {
    const set = compute()
    expect(set.metrics['M-14']).toBe(120)
    expect(set.notes['M-14']).toContain('token 用量宿主未提供')
  })

  it('M-17 上下文峰值占用来自账本快照，缺失部分标未知', () => {
    const set = compute()
    expect(set.metrics['M-17']).toBe(60)
    expect(set.notes['M-17']).toContain('跨会话接续 1 次')
  })

  it('M-18 并行加速比 = 任务耗时之和 ÷ 墙钟', () => {
    const set = compute()
    // B2 并行批次：T2 3 分钟 + T3 5 分钟 = 8 分钟；墙钟 5 分钟 → 1.6
    expect(set.metrics['M-18']).toBe(1.6)
    expect(set.notes['M-18']).toContain('集成检查点失败 1 次')
    expect(set.notes['M-18']).toContain('合并冲突 2 次')
  })

  it('取不到的指标返回字符串「未知」而不是 0，并写明原因', () => {
    const set = compute()
    expect(set.metrics['M-12']).toBe('未知')
    expect(set.metrics['M-15']).toBe('未知')
    expect(set.metrics['M-16']).toBe('未知')
    expect(set.notes['M-12']).toContain('不用 0 代替')
    expect(set.notes['M-15']).toContain('对照测量')
    expect(set.notes['M-16']).toContain('路线图')
  })

  it('M-12 有带基线回执时统计回归数', () => {
    const regressionReceipt: EvidenceReceipt = {
      id: 'E-4',
      changeId: 'C-001',
      group: 'full-suite',
      kind: 'test',
      phase: 'none',
      command: 'pnpm vitest run',
      runBy: 'flowgate',
      exitCode: 1,
      summary: summaryOf({ run: 5, passed: 3, failed: 2, failures: [{ name: 'X' }, { name: 'Y' }], regressions: ['X', 'Y'] }),
      inputsHash: 'sha256:d',
      outputRef: '.flowgate/state/evidence/E-4.log',
      startedAt: '2026-11-12T10:30:00+08:00',
      finishedAt: '2026-11-12T10:35:00+08:00',
    }
    const set = compute({ evidence: [...EVIDENCE, regressionReceipt] })
    expect(set.metrics['M-12']).toBe(2)
    expect(set.notes['M-12']).toContain('全量测试回执')
  })

  it('没有拦截记录时误判率保持未知，不用 0 代替', () => {
    const set = compute({ ledger: [event(1, 'change.created', { changeId: 'C-001' })], evidence: [] })
    expect(set.metrics['M-5']).toBe('未知')
    expect(set.notes['M-5']).toContain('没有任何拦截记录')
  })

  it('同一输入计算结果确定（可复现）', () => {
    expect(compute()).toEqual(compute())
  })
})

describe('formatMetricsText / metricsCsv', () => {
  it('中文表格包含全部 18 个指标与口径说明', () => {
    const text = formatMetricsText(compute())
    expect(text).toContain('FlowGate 指标 · C-001')
    for (let index = 1; index <= 18; index += 1) {
      expect(text).toContain(`| M-${index} |`)
    }
    expect(text).toContain('| M-1 | 跳步拦截数 | 2 |')
    expect(text).toContain('未知')
    expect(text).toContain('FR-10.4')
  })

  it('CSV 导出 18 行数据 + 表头，并正确转义逗号与引号', () => {
    const csv = metricsCsv(compute())
    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(19)
    expect(lines[0]).toBe('指标ID,指标名称,数值,统计口径')
    expect(csv).toContain('M-18')
    expect(csv).toContain('未知')

    const custom: MetricSet = {
      changeId: 'C-002',
      generatedAt: '2026-11-12T12:00:00+08:00',
      metrics: { 'M-1': 1 },
      notes: { 'M-1': '包含逗号,和"引号"的说明' },
    }
    const customCsv = metricsCsv(custom)
    expect(customCsv).toContain('"包含逗号,和""引号""的说明"')
    expect(customCsv.trimEnd().split('\n')).toHaveLength(19)
  })
})
