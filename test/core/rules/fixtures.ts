/**
 * Shared fixture helpers for rule-evaluation tests.
 */
import type {
  Action,
  ChangeStatus,
  Decision,
  ExceptionRecord,
  FlowgateConfig,
  OverrideRecord,
  PendingItem,
  RuleEvaluationInput,
  StageId,
  TaskCard,
  Violation,
} from '../../../src/core/types'
import { evaluateRules } from '../../../src/core/rules/evaluate'
import { AT, makeChange, makeConfig, makeTask } from '../state/fixtures'

export interface EvalOptions {
  stage?: StageId
  change?: ChangeStatus
  task?: TaskCard | null
  config?: FlowgateConfig
  overrides?: OverrideRecord[]
  exceptions?: ExceptionRecord[]
  pending?: PendingItem[]
  violations?: Violation[]
}

export function evalInput(action: Action, options: EvalOptions = {}): RuleEvaluationInput {
  const change = options.change ?? makeChange({ stage: options.stage ?? 'S4' })
  const stage = options.stage ?? change.stage
  const defaultTask = stage === 'S4' || stage === 'S5' ? makeTask() : undefined
  const task = options.task === undefined ? defaultTask : (options.task ?? undefined)
  return {
    action,
    caller: { tool: action.tool, agentRole: 'main' },
    stage,
    change,
    config: options.config ?? makeConfig(),
    task,
    overrides: options.overrides ?? [],
    exceptions: options.exceptions ?? [],
    pending: options.pending ?? [],
    violations: options.violations ?? [],
    projectRoot: '/repo',
  }
}

export function evaluate(action: Action, options: EvalOptions = {}): Decision {
  return evaluateRules(evalInput(action, options))
}

export { AT, makeChange, makeConfig, makeTask }
