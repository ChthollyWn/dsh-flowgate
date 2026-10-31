/**
 * core 修复通道 / 接管模式 / 事故记录 API 的宿主侧访问层（P1-8/P1-9）。
 *
 * 为什么单独一层：
 * - 命令层（`/flow fix`、`/flow off/on`、`/flow incident`）与工具层
 *   （flow_fix_*、flow_self_pause、flow_incident_close）共享同一套入参形状与读取/
 *   展示逻辑，避免两边各写一份字段映射；
 * - 读取类方法包一层 try/catch：`/flow status`、`flow_status` 是只读入口，
 *   读不到修复/事故/接管信息不能让整个工具或命令失败（降级为无该字段）。
 *
 * 入参类型直接从 core 的 FlowEngine 方法签名推导（`Parameters<...>`），core
 * 调整形状时这里自动跟随，不再维护一份容易漂移的本地副本。
 */
import type { ProjectFlags, RepairRecord, TakeoverMode } from '../core/types.js'
import type { EngineLike } from './types.js'

/** flow_fix_start / engine.startRepair 的入参。 */
export type RepairStartInput = Parameters<EngineLike['startRepair']>[0]
/** flow_fix_done / engine.finishRepair 的入参。 */
export type RepairFinishInput = Parameters<EngineLike['finishRepair']>[0]
/** flow_self_pause / engine.selfPause 的入参。 */
export type SelfPauseInput = Parameters<EngineLike['selfPause']>[0]
/** flow_incident_close / engine.closeIncident 的入参。 */
export type CloseIncidentInput = Parameters<EngineLike['closeIncident']>[0]
/** finishRepair 返回值（{ record, message }）。 */
export type FinishRepairResult = Awaited<ReturnType<EngineLike['finishRepair']>>
/** selfPause / closeIncident 返回值（{ incident, message }）。 */
export type IncidentResult = Awaited<ReturnType<EngineLike['selfPause']>>

/** 读取进行中的修复声明（失败返回 null，不抛错）。 */
export function safeGetRepair(engine: EngineLike | null | undefined): RepairRecord | null {
  try {
    return engine?.getRepair() ?? null
  } catch {
    return null
  }
}

/** 读取项目级 flags（暂停/事故）；失败返回 null。 */
export function safeGetProjectFlags(engine: EngineLike | null | undefined): ProjectFlags | null {
  try {
    return engine?.getProjectFlags() ?? null
  } catch {
    return null
  }
}

/** 读取引擎生效接管模式（失败返回 null）。 */
export function safeGetTakeoverMode(engine: EngineLike | null | undefined): TakeoverMode | null {
  try {
    return engine?.getTakeoverMode() ?? null
  } catch {
    return null
  }
}

/** 声明一次修复（flow_fix_start）。 */
export async function startRepair(engine: EngineLike, input: RepairStartInput): Promise<RepairRecord> {
  return await engine.startRepair(input)
}

/** 完成修复（flow_fix_done / `/flow fix done`）。 */
export async function finishRepair(engine: EngineLike, input: RepairFinishInput = {}): Promise<FinishRepairResult> {
  return await engine.finishRepair(input)
}

/** 放弃修复（flow_fix_abort / `/flow fix abort <理由>`）。 */
export async function abortRepair(engine: EngineLike, reason: string): Promise<RepairRecord> {
  return await engine.abortRepair(reason)
}

/** agent 自暂停（flow_self_pause）：写事故记录 + 项目级暂停（autoRearm）。 */
export async function selfPause(engine: EngineLike, input: SelfPauseInput): Promise<IncidentResult> {
  return await engine.selfPause(input)
}

/** 关闭事故并补审计（flow_incident_close）。 */
export async function closeIncident(engine: EngineLike, input: CloseIncidentInput): Promise<IncidentResult> {
  return await engine.closeIncident(input)
}

/** 恢复/暂停项目级门禁（`/flow off`/`/flow on` 无变更时使用）。 */
export async function setProjectOff(
  engine: EngineLike,
  off: boolean,
  reason: string,
  options?: { by?: 'human' | 'agent'; autoRearm?: boolean },
): Promise<void> {
  await engine.setProjectOff(off, reason, options)
}

/** 修复进度（RED/GREEN 是否已有回执）。 */
export function repairProgress(repair: RepairRecord): { red: boolean; green: boolean } {
  return {
    red: typeof repair.redEvidenceId === 'string' && repair.redEvidenceId !== '',
    green: typeof repair.greenEvidenceId === 'string' && repair.greenEvidenceId !== '',
  }
}

/**
 * 修复通道展示视图：把「完整 RepairRecord（getRepair）」与「快照摘要
 * （snapshot.repair，含 red/green 布尔）」统一成一种结构，供工具/命令渲染。
 */
export interface RepairView {
  id: string
  title: string
  severity: RepairRecord['severity']
  scope: string[]
  verify: string
  openedAt: string
  actions: number
  red: boolean
  green: boolean
  status?: string
  openedBy?: RepairRecord['openedBy']
  symptom?: string
  repro?: string
  acceptance: string[]
  redEvidenceId?: string
  greenEvidenceId?: string
  regressionEvidenceId?: string
  changedFiles?: string[]
  commit?: string | null
  abortReason?: string
  summary?: string
}

/** 快照里的修复摘要形状（RuntimeSnapshot.repair）。 */
type RepairSnapshotView = NonNullable<ReturnType<EngineLike['snapshot']>['repair']>

/** 统一修复视图（null/undefined → null）。 */
export function repairView(value: RepairRecord | RepairSnapshotView | null | undefined): RepairView | null {
  if (!value) return null
  const maybeSnapshot = value as RepairSnapshotView
  if (typeof maybeSnapshot.red === 'boolean' && typeof maybeSnapshot.green === 'boolean') {
    return {
      id: maybeSnapshot.id,
      title: maybeSnapshot.title,
      severity: maybeSnapshot.severity,
      scope: [...maybeSnapshot.scope],
      verify: maybeSnapshot.verify,
      openedAt: maybeSnapshot.openedAt,
      actions: maybeSnapshot.actions,
      red: maybeSnapshot.red,
      green: maybeSnapshot.green,
      status: 'open',
      acceptance: [],
    }
  }
  const record = value as RepairRecord
  const progress = repairProgress(record)
  return {
    id: record.id,
    title: record.title,
    severity: record.severity,
    scope: [...record.scope],
    verify: record.verify,
    openedAt: record.openedAt,
    actions: record.actions,
    red: progress.red,
    green: progress.green,
    status: record.status,
    openedBy: record.openedBy,
    symptom: record.symptom,
    repro: record.repro,
    acceptance: [...record.acceptance],
    redEvidenceId: record.redEvidenceId,
    greenEvidenceId: record.greenEvidenceId,
    regressionEvidenceId: record.regressionEvidenceId,
    changedFiles: record.changedFiles ? [...record.changedFiles] : undefined,
    commit: record.commit,
    abortReason: record.abortReason,
    summary: record.summary,
  }
}
