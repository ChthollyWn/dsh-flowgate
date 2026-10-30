import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import type { BatchState, TaskState } from '../../../src/core/types'
import {
  formatActivityTime,
  renderChangesIndex,
  writeChangesIndex,
} from '../../../src/core/store'
import { makeChange } from './fixtures'

function task(id: string, batch: string, status: TaskState['status']): TaskState {
  return { id, batch, status, tdd: 'none', evidenceIds: [], reviewIds: [] }
}

const runningBatch: BatchState = { id: 'B2', mode: 'parallel', status: 'running', tasks: ['T3', 'T4', 'T5'] }

const activeChange = makeChange({
  id: 'C-003',
  title: '会员续费',
  complexity: 'medium',
  risk: 'normal',
  stage: 'S4',
  lifecycle: 'active',
  session: { attached: 'web-1a2b', heartbeat: '2026-11-12T10:31:05+08:00' },
  updatedAt: '2026-11-12T10:31:05+08:00',
  batches: [runningBatch],
  tasks: {
    T3: task('T3', 'B2', 'running'),
    T4: task('T4', 'B2', 'review'),
    T5: task('T5', 'B2', 'queued'),
  },
})

const deliveredChange = makeChange({
  id: 'C-002',
  title: '首页按钮文案',
  complexity: 'low',
  risk: 'normal',
  stage: 'archived',
  lifecycle: 'archived',
  updatedAt: '2026-11-10T16:02:00+08:00',
})

describe('renderChangesIndex', () => {
  it('表头列与 03 §9.8 一致', () => {
    const text = renderChangesIndex([])
    expect(text).toContain('# 变更台账')
    expect(text).toContain('| 编号 | 标题 | 复杂度 / 风险 | 当前阶段 | 状态 | 最近会话 | 最近活动 | 产物 |')
    expect(text.split('\n').filter((line) => line.startsWith('|')).length).toBe(2)
  })

  it('进行中变更：阶段含执行批次摘要、会话与最近活动、产物链接', () => {
    const text = renderChangesIndex([activeChange])
    const row = text.split('\n').find((line) => line.startsWith('| C-003'))!
    expect(row).toContain('| C-003 | 会员续费 | 中 / 普通 | S4 执行（B2 并行 2/3） | 进行中 | web-1a2b | 11-12 10:31 |')
    expect(row).toContain('[需求](C-003/proposal.md)')
    expect(row).toContain('[执行图](C-003/execution-plan.md)')
  })

  it('已交付变更：当前阶段为 —，产物链到归档报告', () => {
    const text = renderChangesIndex([deliveredChange])
    const row = text.split('\n').find((line) => line.startsWith('| C-002'))!
    expect(row).toContain('| 低 / 普通 | — | 已交付 | — | 11-10 16:02 |')
    expect(row).toContain('[报告](../archive/2026-11-10-C-002/report.html)')
  })

  it('分析任务产物链到 analysis.md；暂停状态显示暂停', () => {
    const analysis = makeChange({
      id: 'A-001',
      kind: 'analysis',
      title: '只读分析',
      stage: 'S1',
      lifecycle: 'paused',
      updatedAt: '2026-11-11T09:05:00+08:00',
    })
    const row = renderChangesIndex([analysis]).split('\n').find((line) => line.startsWith('| A-001'))!
    expect(row).toContain('| 暂停 |')
    expect(row).toContain('[分析](A-001/analysis.md)')
    expect(row).not.toContain('执行图')
  })

  it('按编号倒序排列（最新变更在前）', () => {
    const text = renderChangesIndex([activeChange, deliveredChange, makeChange({ id: 'C-001' })])
    const order = text
      .split('\n')
      .filter((line) => /^\| [CA]-\d+/.test(line))
      .map((line) => line.split('|')[1]!.trim())
    expect(order).toEqual(['C-003', 'C-002', 'C-001'])
  })

  it('标题里的竖线与换行被转义，不破坏表格', () => {
    const text = renderChangesIndex([makeChange({ title: 'A | B\nC' })])
    expect(text).toContain('A \\| B C')
  })

  it('复杂度和风险使用中文标签', () => {
    const text = renderChangesIndex([
      makeChange({ id: 'C-010', complexity: 'ultra', risk: 'high', updatedAt: '2026-11-12T10:00:00+08:00' }),
    ])
    expect(text).toContain('| 超高 / 高风险 |')
  })
})

describe('formatActivityTime', () => {
  it('按 ISO 记录里的本地时间格式化为 MM-DD HH:mm', () => {
    expect(formatActivityTime('2026-11-12T10:31:05+08:00')).toBe('11-12 10:31')
    expect(formatActivityTime('2026-01-02T03:04:05Z')).toBe('01-02 03:04')
    expect(formatActivityTime(undefined)).toBe('—')
    expect(formatActivityTime('not-a-time')).toBe('—')
  })
})

describe('writeChangesIndex', () => {
  it('原子写入台账，内容与渲染结果一致且不残留 .tmp', async () => {
    const fs = new MemoryFileSystem()
    await writeChangesIndex(fs, '', [activeChange, deliveredChange])
    const raw = await fs.readFile('.flowgate/changes/index.md')
    expect(raw).toBe(renderChangesIndex([activeChange, deliveredChange]))
    expect(fs.listFiles().some((path) => path.endsWith('.tmp'))).toBe(false)
  })
})
