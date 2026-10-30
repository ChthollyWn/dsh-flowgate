/**
 * Flow levels: complexity x risk.
 *
 * Complexity decides how *long* the process is (which artifacts, how many human
 * confirmations, whether design/plan documents are required); risk decides how
 * *strict* the checks are (TDD coverage, review rounds, security review, runtime
 * evidence). The two dimensions combine independently, e.g. "low complexity x
 * high risk": no design doc, but full TDD, two review rounds, security review and
 * item-by-item risk confirmation.
 */
import type { Complexity, LevelProfile, LimitSettings, RiskLevel } from '../types'
import { STAGE_ORDER } from './stages'

export type { LevelProfile }

export const COMPLEXITY_ORDER: Complexity[] = ['low', 'medium', 'high', 'ultra']

export const COMPLEXITY_LABELS: Record<Complexity, string> = {
  low: '低',
  medium: '中',
  high: '高',
  ultra: '超高',
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  normal: '普通',
  high: '高风险',
}

/** Default task cap for one change when config does not provide `limits.change_max_tasks`. */
export const DEFAULT_CHANGE_MAX_TASKS = 12

/** Low complexity is the fast lane: exactly one task card (02 §4.2, T2.8). */
export const LOW_COMPLEXITY_MAX_TASKS = 1

/**
 * Compute the effective profile for a change.
 *
 * 02 §4.2 matrix:
 * - low:  design optional/off, risk doc off unless high risk, 1 task card,
 *         0 per-task review rounds (one final review at S5), G1+G3 merged.
 * - medium: full six elements, design only when multiple options, sequential plan,
 *         1 review round per task.
 * - high/ultra: design required with 2-3 options, 1 review round per task.
 * - high risk: all tasks TDD, 2 review rounds per task, security review,
 *   runtime evidence required, risk items confirmed one by one (incl. rollback plan).
 */
export function levelProfile(
  complexity: Complexity,
  risk: RiskLevel,
  limits?: LimitSettings,
): LevelProfile {
  const low = complexity === 'low'
  const designRequired = complexity === 'high' || complexity === 'ultra'
  const highRisk = risk === 'high'
  const maxTasks = low
    ? LOW_COMPLEXITY_MAX_TASKS
    : Math.max(1, limits?.change_max_tasks ?? DEFAULT_CHANGE_MAX_TASKS)

  return {
    complexity,
    risk,
    requiresDesign: designRequired,
    requiresDesignOptions: designRequired,
    requiresRiskDoc: highRisk || !low,
    requiresExecutionPlan: !low,
    reviewRoundsPerTask: highRisk ? 2 : low ? 0 : 1,
    securityReview: highRisk,
    tddRequiredAll: highRisk,
    runtimeEvidenceRequired: highRisk,
    manualEvidenceConfirmed: highRisk,
    mergedGates: low,
    maxTasks,
    stages: [...STAGE_ORDER],
  }
}

/** Full 4x2 matrix, useful for tests and the panel's level explanation. */
export function levelMatrix(
  limits?: LimitSettings,
): Record<Complexity, Record<RiskLevel, LevelProfile>> {
  const matrix = {} as Record<Complexity, Record<RiskLevel, LevelProfile>>
  for (const complexity of COMPLEXITY_ORDER) {
    matrix[complexity] = {
      normal: levelProfile(complexity, 'normal', limits),
      high: levelProfile(complexity, 'high', limits),
    }
  }
  return matrix
}

export function complexityLabel(complexity: Complexity): string {
  return COMPLEXITY_LABELS[complexity]
}

export function riskLabel(risk: RiskLevel): string {
  return RISK_LABELS[risk]
}

/** `低复杂度 · 高风险` (used by status lines and confirmation cards). */
export function levelLabel(complexity: Complexity, risk: RiskLevel): string {
  return `${complexityLabel(complexity)}复杂度 · ${riskLabel(risk)}`
}

const COMPLEXITY_ALIASES: Record<string, Complexity> = {
  low: 'low',
  l: 'low',
  低: 'low',
  简单: 'low',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  中: 'medium',
  中等: 'medium',
  high: 'high',
  h: 'high',
  高: 'high',
  ultra: 'ultra',
  u: 'ultra',
  超高: 'ultra',
  极高: 'ultra',
}

const RISK_ALIASES: Record<string, RiskLevel> = {
  normal: 'normal',
  n: 'normal',
  普通: 'normal',
  常规: 'normal',
  低风险: 'normal',
  high: 'high',
  h: 'high',
  高风险: 'high',
  高: 'high',
}

/** Parse owner input (`/flow complexity 中`, `medium`); `auto` and unknown values return null. */
export function parseComplexity(input: string): Complexity | null {
  const key = input.trim().toLowerCase()
  return COMPLEXITY_ALIASES[key] ?? null
}

/** Parse owner input (`/flow risk-level 高`); `auto` and unknown values return null. */
export function parseRiskLevel(input: string): RiskLevel | null {
  const key = input.trim().toLowerCase()
  return RISK_ALIASES[key] ?? null
}

function complexityRank(complexity: Complexity): number {
  const index = COMPLEXITY_ORDER.indexOf(complexity)
  return index < 0 ? 0 : index
}

/** The stricter (higher) of two complexity levels. */
export function stricterComplexity(a: Complexity, b: Complexity): Complexity {
  return complexityRank(a) >= complexityRank(b) ? a : b
}

/** High risk wins over normal risk. */
export function stricterRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return a === 'high' || b === 'high' ? 'high' : 'normal'
}

/**
 * Review/TDD requirement for one task.
 * - review rounds: high risk 2 (spec conformance then code quality); medium+ normal 1;
 *   low complexity 0 per task (one final review at S5).
 * - security review: high risk only.
 * - TDD required: high risk all tasks; normal risk when the task card says
 *   `tdd: required` (or by default for medium+ when the card is silent).
 */
export function reviewRequirement(
  complexity: Complexity,
  risk: RiskLevel,
  taskTdd?: 'required' | 'optional',
): { rounds: 0 | 1 | 2; security: boolean; tddRequired: boolean } {
  const rounds: 0 | 1 | 2 = risk === 'high' ? 2 : complexity === 'low' ? 0 : 1
  const tddRequired =
    risk === 'high'
      ? true
      : taskTdd === 'required'
        ? true
        : taskTdd === 'optional'
          ? false
          : complexity !== 'low'
  return { rounds, security: risk === 'high', tddRequired }
}

/** High risk requires risk items to be confirmed one by one at G3 (or on the merged card). */
export function requiresRiskItemConfirmation(risk: RiskLevel): boolean {
  return risk === 'high'
}

/** High risk requires a rollback plan (in design.md, or in risk.md when design is not required). */
export function requiresRollbackPlan(risk: RiskLevel): boolean {
  return risk === 'high'
}
