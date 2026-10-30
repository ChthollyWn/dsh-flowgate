import { describe, expect, it } from 'vitest'
import {
  checkRoadmap,
  firstChangeIsSkeleton,
  nextRoadmapChange,
  roadmapStatusLine,
} from '../../../src/core/roadmap/check'
import type { RoadmapDoc, RoadmapEntry } from '../../../src/core/types'
import { PROJECT, ROADMAP, validConfig } from '../../fixtures/artifacts/helpers'

function roadmap(entries: RoadmapEntry[], mvpCut = ROADMAP.mvpCut): RoadmapDoc {
  return { raw: '', title: '会员管理系统', mvpCut, entries }
}

function entry(overrides: Partial<RoadmapEntry> & { change: string }): RoadmapEntry {
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

function byId(outcomes: ReturnType<typeof checkRoadmap>, id: string) {
  const found = outcomes.find((outcome) => outcome.item === `roadmap.${id}`)
  expect(found, `missing roadmap.${id}`).toBeDefined()
  return found!
}

describe('checkRoadmap', () => {
  it('合法路线图全部通过', () => {
    const outcomes = checkRoadmap(ROADMAP, PROJECT, validConfig())
    expect(outcomes.map((outcome) => outcome.item)).toEqual([
      'roadmap.entries',
      'roadmap.deps',
      'roadmap.c0',
      'roadmap.mvp',
      'roadmap.scale',
      'roadmap.mvpCut',
    ])
    for (const outcome of outcomes) expect(outcome.passed, JSON.stringify(outcome)).toBe(true)
  })

  it('依赖成环 → 失败并给出环路径', () => {
    const doc = roadmap([
      entry({ change: 'C0', capability: '工程骨架', goal: '工程骨架初始化' }),
      entry({ change: 'C1', dependsOn: ['C3'] }),
      entry({ change: 'C2', dependsOn: ['C1'] }),
      entry({ change: 'C3', dependsOn: ['C1'] }),
    ])
    const outcome = byId(checkRoadmap(doc, null, validConfig()), 'deps')
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('成环')
    expect(outcome.details!.join('\n')).toMatch(/C1|C3/)
  })

  it('依赖引用不存在的变更 → 失败', () => {
    const doc = roadmap([entry({ change: 'C0', capability: '工程骨架' }), entry({ change: 'C1', dependsOn: ['C9'] })])
    const outcome = byId(checkRoadmap(doc, null, validConfig()), 'deps')
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('C9')
  })

  it('第一个变更不是工程骨架 → 失败（FR-12 验收）', () => {
    const doc = roadmap([entry({ change: 'C1', capability: '会员' }), entry({ change: 'C0', capability: '工程骨架' })])
    const outcome = byId(checkRoadmap(doc, null, validConfig()), 'c0')
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('先建工程骨架')
  })

  it('C0 在首位但能力不是工程骨架 → 失败', () => {
    const doc = roadmap([entry({ change: 'C0', capability: '会员功能', goal: '开通会员' })])
    expect(byId(checkRoadmap(doc, null, validConfig()), 'c0').passed).toBe(false)
  })

  it('MVP 能力缺少归属字段 → 失败', () => {
    const doc = roadmap([
      entry({ change: 'C0', capability: '工程骨架', goal: '工程骨架初始化' }),
      entry({ change: 'C1', capability: '', goal: '' }),
    ])
    const outcome = byId(checkRoadmap(doc, null, validConfig()), 'mvp')
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('C1')
  })

  it('单个变更预计任务数超过上限 → 失败', () => {
    const doc = roadmap([entry({ change: 'C0', capability: '工程骨架', estimatedTasks: 15 })])
    const outcome = byId(checkRoadmap(doc, null, validConfig()), 'scale')
    expect(outcome.passed).toBe(false)
    expect(outcome.details!.join('\n')).toContain('超过上限 12')
  })

  it('缺少预计任务数 / MVP 切线 → 失败', () => {
    const doc = roadmap([entry({ change: 'C0', capability: '工程骨架', estimatedTasks: null })], '')
    const outcomes = checkRoadmap(doc, null, validConfig())
    expect(byId(outcomes, 'scale').passed).toBe(false)
    expect(byId(outcomes, 'mvpCut').passed).toBe(false)
    expect(byId(outcomes, 'mvpCut').hint).toContain('MVP 切线')
  })

  it('空路线图 → entries 与 c0 检查失败', () => {
    const outcomes = checkRoadmap(roadmap([], ''), null, validConfig())
    expect(byId(outcomes, 'entries').passed).toBe(false)
    expect(byId(outcomes, 'c0').passed).toBe(false)
  })
})

describe('firstChangeIsSkeleton', () => {
  it('识别工程骨架 C0', () => {
    expect(firstChangeIsSkeleton(ROADMAP)).toBe(true)
    expect(firstChangeIsSkeleton(roadmap([entry({ change: 'C1', capability: '会员' })]))).toBe(false)
    expect(firstChangeIsSkeleton(roadmap([entry({ change: 'C0', capability: '会员' })]))).toBe(false)
  })
})

describe('roadmapStatusLine / nextRoadmapChange', () => {
  it('状态行展示 MVP 进度与下一个变更', () => {
    const line = roadmapStatusLine(ROADMAP)
    expect(line).toContain('MVP 0/2')
    expect(line).toContain('C0')
    expect(line.length).toBeLessThanOrEqual(120)
  })

  it('有进行中的变更时优先显示当前', () => {
    const doc = roadmap([
      entry({ change: 'C0', capability: '工程骨架', status: '已交付' }),
      entry({ change: 'C1', capability: '会员', status: '进行中' }),
    ])
    expect(roadmapStatusLine(doc)).toContain('当前 C1')
    expect(nextRoadmapChange(doc)?.change).toBe('C1')
  })

  it('返回首个依赖已交付的未开始变更', () => {
    const doc = roadmap([
      entry({ change: 'C0', capability: '工程骨架', status: '已交付' }),
      entry({ change: 'C1', capability: '会员', dependsOn: ['C0'] }),
      entry({ change: 'C2', capability: '报表', dependsOn: ['C1'] }),
    ])
    expect(nextRoadmapChange(doc)?.change).toBe('C1')
  })

  it('依赖未就绪或全部交付 → null', () => {
    const blocked = roadmap([
      entry({ change: 'C1', capability: '会员', dependsOn: ['C2'] }),
      entry({ change: 'C2', capability: '报表', dependsOn: ['C1'] }),
    ])
    expect(nextRoadmapChange(blocked)).toBeNull()
    const done = roadmap([entry({ change: 'C0', capability: '工程骨架', status: '已交付' })])
    expect(nextRoadmapChange(done)).toBeNull()
  })

  it('空路线图状态行', () => {
    expect(roadmapStatusLine(roadmap([], ''))).toBe('路线图：暂无变更')
  })
})
