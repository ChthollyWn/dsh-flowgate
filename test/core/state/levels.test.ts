import { describe, expect, it } from 'vitest'
import type { Complexity, LevelProfile, RiskLevel } from '../../../src/core/types'
import {
  COMPLEXITY_LABELS,
  COMPLEXITY_ORDER,
  DEFAULT_CHANGE_MAX_TASKS,
  LOW_COMPLEXITY_MAX_TASKS,
  RISK_LABELS,
  complexityLabel,
  levelLabel,
  levelMatrix,
  levelProfile,
  parseComplexity,
  parseRiskLevel,
  requiresRiskItemConfirmation,
  requiresRollbackPlan,
  reviewRequirement,
  riskLabel,
  stricterComplexity,
  stricterRisk,
} from '../../../src/core/state/levels'
import { DEFAULT_LIMITS, makeConfig } from './fixtures'

const CASES: [Complexity, RiskLevel][] = []
for (const complexity of COMPLEXITY_ORDER) {
  for (const risk of ['normal', 'high'] as RiskLevel[]) CASES.push([complexity, risk])
}

describe('state/levels — 复杂度 x 风险矩阵', () => {
  it('covers all eight combinations and stores the inputs', () => {
    const matrix = levelMatrix()
    for (const [complexity, risk] of CASES) {
      const profile: LevelProfile = matrix[complexity][risk]
      expect(profile.complexity).toBe(complexity)
      expect(profile.risk).toBe(risk)
      expect(profile.stages).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'])
    }
  })

  it('low · normal: fast lane, no design/risk doc, no per-task review, 1 task card', () => {
    const profile = levelProfile('low', 'normal')
    expect(profile.requiresDesign).toBe(false)
    expect(profile.requiresDesignOptions).toBe(false)
    expect(profile.requiresRiskDoc).toBe(false)
    expect(profile.requiresExecutionPlan).toBe(false)
    expect(profile.reviewRoundsPerTask).toBe(0)
    expect(profile.securityReview).toBe(false)
    expect(profile.tddRequiredAll).toBe(false)
    expect(profile.runtimeEvidenceRequired).toBe(false)
    expect(profile.manualEvidenceConfirmed).toBe(false)
    expect(profile.mergedGates).toBe(true)
    expect(profile.maxTasks).toBe(LOW_COMPLEXITY_MAX_TASKS)
  })

  // T1.1 acceptance: GIVEN 低复杂度 · 高风险 WHEN 计算生效的检查项
  it('T1.1 low · high: no design doc, but risk doc + rollback + item confirmation + all TDD + 2 reviews + security review', () => {
    const profile = levelProfile('low', 'high')
    expect(profile.requiresDesign).toBe(false)
    expect(profile.requiresDesignOptions).toBe(false)
    expect(profile.requiresRiskDoc).toBe(true)
    expect(profile.reviewRoundsPerTask).toBe(2)
    expect(profile.securityReview).toBe(true)
    expect(profile.tddRequiredAll).toBe(true)
    expect(profile.runtimeEvidenceRequired).toBe(true)
    expect(profile.manualEvidenceConfirmed).toBe(true)
    expect(profile.mergedGates).toBe(true)
    expect(profile.maxTasks).toBe(LOW_COMPLEXITY_MAX_TASKS)
    // risk items are confirmed one by one; a rollback plan is mandatory
    expect(requiresRiskItemConfirmation('high')).toBe(true)
    expect(requiresRollbackPlan('high')).toBe(true)
    expect(requiresRiskItemConfirmation('normal')).toBe(false)
    expect(requiresRollbackPlan('normal')).toBe(false)
    const review = reviewRequirement('low', 'high')
    expect(review).toEqual({ rounds: 2, security: true, tddRequired: true })
    // merged confirmation card in the fast lane still needs the risk items
    expect(profile.mergedGates).toBe(true)
  })

  it('medium · normal: risk doc + execution plan + one review round per task', () => {
    const profile = levelProfile('medium', 'normal')
    expect(profile.requiresDesign).toBe(false)
    expect(profile.requiresDesignOptions).toBe(false)
    expect(profile.requiresRiskDoc).toBe(true)
    expect(profile.requiresExecutionPlan).toBe(true)
    expect(profile.reviewRoundsPerTask).toBe(1)
    expect(profile.securityReview).toBe(false)
    expect(profile.tddRequiredAll).toBe(false)
    expect(profile.mergedGates).toBe(false)
    expect(profile.maxTasks).toBe(DEFAULT_CHANGE_MAX_TASKS)
  })

  it('high/ultra · normal: design with 2-3 options required', () => {
    for (const complexity of ['high', 'ultra'] as Complexity[]) {
      const profile = levelProfile(complexity, 'normal')
      expect(profile.requiresDesign, complexity).toBe(true)
      expect(profile.requiresDesignOptions, complexity).toBe(true)
      expect(profile.requiresExecutionPlan, complexity).toBe(true)
      expect(profile.reviewRoundsPerTask, complexity).toBe(1)
      expect(profile.mergedGates, complexity).toBe(false)
    }
  })

  it('high risk raises strictness for every complexity', () => {
    for (const complexity of COMPLEXITY_ORDER) {
      const normal = levelProfile(complexity, 'normal')
      const high = levelProfile(complexity, 'high')
      expect(high.reviewRoundsPerTask).toBeGreaterThan(normal.reviewRoundsPerTask)
      expect(high.securityReview).toBe(true)
      expect(high.tddRequiredAll).toBe(true)
      expect(high.runtimeEvidenceRequired).toBe(true)
      expect(high.manualEvidenceConfirmed).toBe(true)
      expect(high.requiresRiskDoc).toBe(true)
    }
  })

  it('respects limits.change_max_tasks for medium+ but keeps the low fast lane at 1', () => {
    const limits = { ...DEFAULT_LIMITS, change_max_tasks: 30 }
    expect(levelProfile('medium', 'normal', limits).maxTasks).toBe(30)
    expect(levelProfile('ultra', 'normal', limits).maxTasks).toBe(30)
    expect(levelProfile('low', 'normal', limits).maxTasks).toBe(1)
  })

  it('falls back to the default task cap when limits are missing', () => {
    expect(levelProfile('high', 'normal').maxTasks).toBe(DEFAULT_CHANGE_MAX_TASKS)
  })
})

describe('state/levels — labels 与解析', () => {
  it('labels are Chinese', () => {
    expect(COMPLEXITY_LABELS).toEqual({ low: '低', medium: '中', high: '高', ultra: '超高' })
    expect(RISK_LABELS).toEqual({ normal: '普通', high: '高风险' })
    expect(complexityLabel('low')).toBe('低')
    expect(complexityLabel('ultra')).toBe('超高')
    expect(riskLabel('high')).toBe('高风险')
    expect(levelLabel('low', 'high')).toBe('低复杂度 · 高风险')
  })

  it('parseComplexity accepts Chinese and English aliases, rejects auto/unknown', () => {
    expect(parseComplexity('低')).toBe('low')
    expect(parseComplexity('中')).toBe('medium')
    expect(parseComplexity('高')).toBe('high')
    expect(parseComplexity('超高')).toBe('ultra')
    expect(parseComplexity('LOW')).toBe('low')
    expect(parseComplexity(' Medium ')).toBe('medium')
    expect(parseComplexity('m')).toBe('medium')
    expect(parseComplexity('auto')).toBeNull()
    expect(parseComplexity('')).toBeNull()
    expect(parseComplexity('紧急')).toBeNull()
  })

  it('parseRiskLevel accepts Chinese and English aliases', () => {
    expect(parseRiskLevel('普通')).toBe('normal')
    expect(parseRiskLevel('高风险')).toBe('high')
    expect(parseRiskLevel('normal')).toBe('normal')
    expect(parseRiskLevel('HIGH')).toBe('high')
    expect(parseRiskLevel('auto')).toBeNull()
    expect(parseRiskLevel('低')).toBeNull()
  })

  it('stricterComplexity / stricterRisk never lower a level', () => {
    expect(stricterComplexity('low', 'medium')).toBe('medium')
    expect(stricterComplexity('ultra', 'high')).toBe('ultra')
    expect(stricterComplexity('medium', 'low')).toBe('medium')
    expect(stricterRisk('normal', 'normal')).toBe('normal')
    expect(stricterRisk('normal', 'high')).toBe('high')
    expect(stricterRisk('high', 'normal')).toBe('high')
  })

  it('reviewRequirement follows risk first, then complexity, then the task card', () => {
    expect(reviewRequirement('low', 'normal')).toEqual({ rounds: 0, security: false, tddRequired: false })
    expect(reviewRequirement('medium', 'normal')).toEqual({ rounds: 1, security: false, tddRequired: true })
    expect(reviewRequirement('medium', 'normal', 'optional')).toEqual({
      rounds: 1,
      security: false,
      tddRequired: false,
    })
    expect(reviewRequirement('medium', 'normal', 'required')).toEqual({
      rounds: 1,
      security: false,
      tddRequired: true,
    })
    expect(reviewRequirement('high', 'normal', 'optional')).toEqual({
      rounds: 1,
      security: false,
      tddRequired: false,
    })
    // high risk: all tasks TDD, two rounds, security review, exemption needs approval
    expect(reviewRequirement('low', 'high', 'optional')).toEqual({
      rounds: 2,
      security: true,
      tddRequired: true,
    })
  })

  it('level matrix is stable and independent from config', () => {
    const config = makeConfig()
    expect(config.limits.change_max_tasks).toBe(12)
    expect(levelMatrix()[('low')]['high'].requiresDesign).toBe(false)
  })
})
