/**
 * Public API of the state module. The engine imports only from this file.
 */
export {
  STAGE_ORDER,
  STAGE_LABELS,
  STAGE_DESCRIPTIONS,
  stageLabel,
  stageIndex,
  nextStage,
  stageAfterGate,
  gateForStage,
  humanGate,
} from './stages'

export type { LevelProfile } from './levels'
export {
  COMPLEXITY_ORDER,
  COMPLEXITY_LABELS,
  RISK_LABELS,
  DEFAULT_CHANGE_MAX_TASKS,
  LOW_COMPLEXITY_MAX_TASKS,
  levelProfile,
  levelMatrix,
  complexityLabel,
  riskLabel,
  levelLabel,
  parseComplexity,
  parseRiskLevel,
  stricterComplexity,
  stricterRisk,
  reviewRequirement,
  requiresRiskItemConfirmation,
  requiresRollbackPlan,
} from './levels'

export type { LevelSignalInput } from './suggest'
export { suggestLevels } from './suggest'

export type {
  ChangeStatusInitInput,
  TransitionDef,
  VerificationFailureInput,
} from './transitions'
export {
  transitionTable,
  validateGateSubmission,
  applyGatePassed,
  applyGateFailed,
  applyGateAwaiting,
  applyGateApproved,
  applyGateRejected,
  enterStage,
  applyVerificationFailure,
  draftRepairTasks,
  lockChange,
  unlockChange,
  initialStatus,
} from './transitions'

export type { WriteDenyReason, WriteVerdict } from './scope'
export {
  BUILTIN_PROTECTED_PATHS,
  isProtectedPath,
  isArtifactWritableInStage,
  allowedWriteSet,
  isAllowedWrite,
  isAllowedWriteForAction,
  isDeliveryWritable,
  matchesProtectedPattern,
} from './scope'
