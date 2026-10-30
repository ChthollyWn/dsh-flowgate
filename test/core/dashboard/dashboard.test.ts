import { describe, expect, it } from 'vitest'
import type { ChangeStatus, PendingItem, RuntimeSnapshot, StageProgress } from '../../../src/core/types'
import { renderDashboard } from '../../../src/core/dashboard'
import { STAGE_LEARNING_CARDS, STAGE_CARD_TITLES } from '../../../src/core/dashboard'

const STAGE_ORDER: StageProgress['stage'][] = ['roadmap', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'archived']

function pipeline(current: StageProgress['stage']): StageProgress[] {
  const currentIndex = STAGE_ORDER.indexOf(current)
  return STAGE_ORDER.map((stage, index) => ({
    stage,
    label: STAGE_CARD_TITLES[stage],
    status: (index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending') as StageProgress['status'],
  }))
}

const C1: ChangeStatus = {
  id: 'C-001',
  kind: 'change',
  title: '会员续费',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S4',
  lifecycle: 'active',
  gates: {
    G3: { state: 'passed', attempts: 1, approvedAt: '2026-11-12T09:50:00+08:00' },
  },
  batches: [
    { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'], startedAt: '2026-11-12T10:00:00+08:00', completedAt: '2026-11-12T10:20:00+08:00' },
    { id: 'B2', mode: 'parallel', status: 'running', tasks: ['T2', 'T3'], startedAt: '2026-11-12T10:20:00+08:00' },
  ],
  tasks: {
    T1: { id: 'T1', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-1', 'E-2'], reviewIds: [], worktree: '.flowgate/worktrees/T1', startedAt: '2026-11-12T10:00:00+08:00', finishedAt: '2026-11-12T10:20:00+08:00' },
    T2: { id: 'T2', batch: 'B2', status: 'running', tdd: 'red', evidenceIds: ['E-3'], reviewIds: [], worktree: '.flowgate/worktrees/T2', startedAt: '2026-11-12T10:20:00+08:00' },
    T3: { id: 'T3', batch: 'B2', status: 'pending', tdd: 'none', evidenceIds: [], reviewIds: [] },
  },
  evidenceIds: ['E-1', 'E-2', 'E-3'],
  pending: [
    {
      id: 'RK-1',
      kind: 'risk',
      changeId: 'C-001',
      title: '依赖变更：新增 caffeine',
      detail: 'pom.xml 新增依赖',
      status: 'open',
      createdAt: '2026-11-12T10:25:00+08:00',
    },
  ],
  overrides: [
    { id: 'OV-1', ruleId: 'R-SCOPE', changeId: 'C-001', reason: '误判', actionFingerprint: 'fp', createdAt: '2026-11-12T10:00:00+08:00', usedAt: '2026-11-12T10:01:00+08:00' },
  ],
  exceptions: [],
  violations: [
    {
      id: 'V-1',
      changeId: 'C-001',
      taskId: 'T2',
      path: 'src/main/java/com/example/<script>Wrong.java</script>',
      kind: 'outside-scope',
      detectedAt: '2026-11-12T10:25:00+08:00',
      source: 'pre',
    },
  ],
  reviews: [],
  createdAt: '2026-11-12T09:00:00+08:00',
  updatedAt: '2026-11-12T10:30:00+08:00',
}

const C2: ChangeStatus = {
  id: 'C-002',
  kind: 'change',
  title: '登录重构',
  complexity: 'low',
  risk: 'normal',
  stage: 'archived',
  lifecycle: 'archived',
  gates: {},
  batches: [],
  tasks: {
    T9: { id: 'T9', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-9'], reviewIds: [] },
  },
  evidenceIds: ['E-9'],
  pending: [],
  overrides: [],
  exceptions: [],
  violations: [],
  reviews: [],
  createdAt: '2026-11-01T09:00:00+08:00',
  updatedAt: '2026-11-05T18:00:00+08:00',
}

const PENDING: PendingItem[] = [
  {
    id: 'RK-1',
    kind: 'risk',
    changeId: 'C-001',
    title: '依赖变更：新增 caffeine',
    detail: 'pom.xml 新增依赖',
    status: 'open',
    createdAt: '2026-11-12T10:25:00+08:00',
  },
  {
    id: 'SC-1',
    kind: 'scope',
    changeId: 'C-001',
    title: '范围变更：新增 util',
    detail: '需要写 src/util/DateTime.java',
    status: 'open',
    createdAt: '2026-11-12T10:26:00+08:00',
  },
  {
    id: 'RK-0',
    kind: 'risk',
    changeId: 'C-002',
    title: '已处理的历史项',
    detail: '',
    status: 'approved',
    createdAt: '2026-11-02T09:00:00+08:00',
    decidedAt: '2026-11-02T09:05:00+08:00',
  },
]

const SNAPSHOT: RuntimeSnapshot = {
  initialized: true,
  changeId: 'C-001',
  title: '会员续费',
  kind: 'change',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S4',
  lifecycle: 'active',
  pipeline: pipeline('S4'),
  tasks: C1.tasks,
  batches: [
    { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'], startedAt: '2026-11-12T10:00:00+08:00', completedAt: '2026-11-12T10:20:00+08:00', checkpoint: { status: 'passed', at: '2026-11-12T10:20:00+08:00' } },
    { id: 'B2', mode: 'parallel', status: 'running', tasks: ['T2', 'T3'], startedAt: '2026-11-12T10:20:00+08:00' },
  ],
  activeTaskId: 'T2',
  pending: PENDING.filter((item) => item.status === 'open'),
  violations: C1.violations,
  off: false,
  locked: false,
  interceptCounts: { 'R-STAGE-SRC': 3, 'R-SCOPE': 1 },
  coverage: {
    entries: [
      { tool: 'write', category: 'write', covered: true },
      { tool: 'edit', category: 'write', covered: true },
      { tool: 'apply_patch', category: 'write', covered: false, reason: '未覆盖' },
    ],
    coveredWritable: 2,
    uncoveredWritable: 1,
    checkedAt: '2026-11-12T10:00:00+08:00',
  },
  nextStep: '等待 B2 完成',
  statusLine: '◆ FlowGate C-001 中 · 普通风险 │ ④ 执行 ▸ B2 并行 1/2 运行中 │ 待处理 2',
  updatedAt: '2026-11-12T10:30:00+08:00',
}

function dashboardInput(overrides: Partial<Parameters<typeof renderDashboard>[0]> = {}): Parameters<typeof renderDashboard>[0] {
  return {
    changes: [C1, C2],
    snapshot: SNAPSHOT,
    pending: PENDING,
    generatedAt: '2026-11-12T10:31:00+08:00',
    ...overrides,
  }
}

describe('renderDashboard：跨会话只读看板', () => {
  const html = renderDashboard(dashboardInput())

  it('生成完整单文件 HTML 并内联 CSS/JS', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('<script>')
    expect(html).toContain('跨会话看板')
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(2 * 1024 * 1024)
  })

  it('展示台账、流水线、执行图、待处理、最近拦截/证据与累计指标', () => {
    expect(html).toContain('变更台账')
    expect(html).toContain('阶段流水线')
    expect(html).toContain('执行图')
    expect(html).toContain('待处理事项')
    expect(html).toContain('最近拦截与证据')
    expect(html).toContain('累计指标')
  })

  it('台账包含进行中与已交付变更', () => {
    expect(html).toContain('C-001')
    expect(html).toContain('会员续费')
    expect(html).toContain('C-002')
    expect(html).toContain('登录重构')
    expect(html).toContain('已交付')
  })

  it('流水线显示阶段节点与门禁', () => {
    expect(html).toContain('阶段流水线')
    expect(html).toContain('S3 设计拆解')
    expect(html).toContain('G3')
    expect(html).toContain('passed')
  })

  it('执行图按批次展示并行泳道、任务状态与 worktree', () => {
    expect(html).toContain('B1')
    expect(html).toContain('B2')
    expect(html).toContain('T1')
    expect(html).toContain('T2')
    expect(html).toContain('running')
    expect(html).toContain('worktrees/T2')
    expect(html).toContain('检查点：passed')
    expect(html).toContain('当前活动任务')
  })

  it('待处理区只显示 open 项，并提示看板只读', () => {
    expect(html).toContain('RK-1')
    expect(html).toContain('SC-1')
    expect(html).not.toContain('已处理的历史项')
    expect(html).toContain('只读')
    expect(html).toContain('不能操作')
  })

  it('拦截与证据区展示快照统计、越界记录与回执路径', () => {
    expect(html).toContain('R-STAGE-SRC')
    expect(html).toContain('R-SCOPE')
    expect(html).toContain('V-1')
    expect(html).toContain('E-1')
    expect(html).toContain('.flowgate/state/evidence/E-1.log')
    expect(html).toContain(statusLineFragment())
  })

  it('累计指标展示状态条、覆盖自检与缺失值', () => {
    expect(html).toContain('◆ FlowGate C-001')
    expect(html).toContain('2 / 3 个可写工具')
    expect(html).toContain('待处理事项')
    expect(html).toContain('未知')
    expect(html).toContain('FR-10.4')
  })

  it('只读：没有按钮、表单或可编辑控件', () => {
    const lower = html.toLowerCase()
    expect(lower).not.toContain('<button')
    expect(lower).not.toContain('<form')
    expect(lower).not.toContain('<input')
    expect(lower).not.toContain('<select')
    expect(lower).not.toContain('<textarea')
    expect(lower).not.toContain('contenteditable')
  })

  it('离线：不引用任何外部资源', () => {
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i)
    expect(html).not.toContain('@import')
    expect(html).not.toContain('<img')
  })

  it('用户文本（变更标题、拦截路径）经过 HTML 转义', () => {
    expect(html).not.toContain('<script>Wrong.java</script>')
    expect(html).toContain('&lt;script&gt;Wrong.java&lt;/script&gt;')
  })

  it('没有快照时也能生成看板，缺失统计显示未知', () => {
    const withoutSnapshot = renderDashboard(dashboardInput({ snapshot: undefined }))
    expect(withoutSnapshot).toContain('C-001')
    expect(withoutSnapshot).toContain('累计指标')
    expect(withoutSnapshot).toContain('未知')
    expect(withoutSnapshot).toContain('阶段流水线')
  })

  it('渲染结果确定（同输入同输出）', () => {
    expect(renderDashboard(dashboardInput())).toBe(html)
  })

  it('变更标题注入脚本时被转义', () => {
    const xss = '<script>alert("xss")</script>'
    const change: ChangeStatus = { ...C1, title: xss }
    const rendered = renderDashboard(dashboardInput({ changes: [change], snapshot: undefined }))
    expect(rendered).not.toContain('<script>alert("xss")</script>')
    expect(rendered).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })
})

function statusLineFragment(): string {
  return SNAPSHOT.statusLine
}

describe('看板与报告共用学习卡', () => {
  it('dashboard 也导出 STAGE_LEARNING_CARDS 与阶段标题', () => {
    expect(STAGE_LEARNING_CARDS.S4.what).toContain('任务')
    expect(STAGE_CARD_TITLES.S6).toBe('S6 交付')
  })
})
