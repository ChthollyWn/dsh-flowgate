import type { LevelProfile, RiskCategory, RiskDoc, RiskEntry, RiskGrade } from '../../../src/core/types'

export function profile(overrides: Partial<LevelProfile> = {}): LevelProfile {
  const base: LevelProfile = {
    complexity: 'medium',
    risk: 'normal',
    requiresDesign: true,
    requiresDesignOptions: false,
    requiresRiskDoc: true,
    requiresExecutionPlan: true,
    reviewRoundsPerTask: 1,
    securityReview: false,
    tddRequiredAll: false,
    runtimeEvidenceRequired: false,
    manualEvidenceConfirmed: false,
    mergedGates: false,
    maxTasks: 12,
    stages: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
  }
  return { ...base, ...overrides }
}

export function entry(
  category: RiskCategory,
  grade: RiskGrade,
  reason = '理由',
  mitigation = '缓解措施',
  verification = '验证方式',
  needsHuman = false,
): RiskEntry {
  return { category, grade, reason, mitigation, verification, needsHuman }
}

export function doc(entries: RiskEntry[]): RiskDoc {
  return { raw: '# 风险登记\n', entries }
}

/** 五类齐全、高风险标人工接管且带回滚线索的合法风险登记。 */
export const validEntries: RiskEntry[] = [
  entry('security', 'high', '续费回调需要验签', '复用 SignatureVerifier；异常时回滚到旧版本', '场景 R3.S2 测试', true),
  entry('performance', 'low', '每次续费多一次幂等查询', '流水号加唯一索引', '压测脚本（可选）', false),
  entry('cost', 'none', '不新增外部调用', '—', '—', false),
  entry('compliance', 'medium', '续费记录含手机号', '日志脱敏', '审查检查', false),
  entry('maintainability', 'medium', '续费规则分散在两个服务', '收拢到 RenewalPolicy', '审查检查', false),
]
