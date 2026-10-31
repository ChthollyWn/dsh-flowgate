/**
 * Public API of the rules module. The engine / host imports only from here.
 */
export {
  BUILTIN_RULES,
  BUILTIN_RULE_IDS,
  RESERVED_RULE_IDS,
  loadRules,
  ruleById,
} from './builtin'
export {
  evaluateRules,
  fingerprintAction,
  explainDecision,
  actionTargetPath,
  actionKindOf,
} from './evaluate'
export type { RuleFeedback } from './misfire'
export {
  MISFIRE_RATE_TARGET,
  MISFIRE_MIN_SAMPLES,
  ruleMisfireRate,
  shouldDowngradeRule,
} from './misfire'
export type { ToolCategory, ToolClassification } from './toolclass'
export { classifyTool, actionFromToolCall, BLOCKED_DELEGATION_TOOLS } from './toolclass'
export type { TriggerHit } from './risk-triggers'
export {
  matchRiskTriggers,
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_DEPENDENCY_FILES,
  HOTSPOT_PATTERNS,
  isHotspot,
  sensitivePathPatterns,
  dependencyFilePatterns,
  TRIGGER_RULES,
  TRIGGER_RULE_BY_TRIGGER,
} from './risk-triggers'
