/**
 * 存储层公共 API。engine 只从本 index 导入（见 docs/impl/module-contracts.md 第 5 节）。
 */
export type { ProjectState } from '../types'

export {
  layout,
  changePaths,
  isInitialized,
  scaffold,
  findIncrementalSpec,
  renderFlowgateGitignore,
  LEDGER_KEY_PATH,
} from './layout'
export type { FlowgateLayout, ChangePaths } from './layout'

export {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_PATH,
  ConfigError,
  loadConfig,
  parseConfig,
  configHash,
  configPath,
  renderConfigYaml,
} from './config'

export {
  loadProjectState,
  readChangeStatus,
  writeChangeStatus,
  listChanges,
  listChangesDetailed,
  renderChangesIndex,
  writeChangesIndex,
  readLeases,
  writeLeases,
  nextChangeId,
  nextPendingId,
  ensureChangeDir,
  rebuildState,
  foldLedgerToChanges,
  readLedgerEvents,
  formatActivityTime,
} from './state'
export type {
  CorruptStateFile,
  ChangesScanResult,
  LoadedProjectState,
  LoadProjectStatePorts,
  RebuildStateResult,
} from './state'

export {
  emptyProjectFlags,
  normalizeProjectFlags,
  readProjectFlags,
  writeProjectFlags,
} from './flags'

export {
  stampedId,
  nextStampedId,
  normalizeRepairRecord,
  readActiveRepair,
  writeActiveRepair,
  clearActiveRepair,
  renderFixIndexHeader,
  renderFixIndexRow,
  listFixIds,
  listIncidentIds,
  writeFixRecord,
  writeIncidentRecord,
} from './repair'

export {
  freezeContract,
  contractConfigSnapshot,
  frozenContractConfig,
  artifactsFingerprint,
  freezeArtifacts,
  unfreezeArtifacts,
  assertArtifactsUnmodified,
  assertNotFrozen,
  artifactKeyForPath,
} from './freeze'
