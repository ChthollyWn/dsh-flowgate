/**
 * 修复通道（v0.5.1）持久化：`.flowgate/state/repair.json`（进行中）与
 * `.flowgate/fixes/<FIX-id>.json` + `.flowgate/fixes/index.md`（完成/中止审计），
 * 以及事故记录 `.flowgate/incidents/<INC-id>.json`。
 *
 * 设计约束：
 * - 所有写入原子（`<path>.tmp` + rename），宿主崩溃不会留下半截 JSON；
 * - 读取损坏的 repair.json 返回 null（不抛错），下次 `flow_fix_start` 可重新开始；
 *   修复记录本身是审计材料，失败时宁可不返回也不误判成「进行中」；
 * - id 形如 `FIX-YYYYMMDD-HHMMSS` / `INC-YYYYMMDD-HHMMSS`，同一秒冲突追加
 *   `-2`、`-3`；测试可注入 clock。
 */
import type { Clock, FileSystem } from '../util/fs'
import type { IncidentRecord, RepairRecord } from '../types'
import { isoNow } from '../util/time'
import { layout } from './layout'

const STAMPED_ID = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/

/** 由当次时间生成 id 的时间戳段：`YYYYMMDD-HHMMSS`（本地时间，与 isoNow 一致）。 */
export function stampedId(prefix: 'FIX' | 'INC', clock: Clock, sequence = 1): string {
  const match = STAMPED_ID.exec(isoNow(clock))
  const digits = match ? `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}` : isoNow(clock).replace(/[^0-9]/g, '').slice(0, 15)
  const base = `${prefix}-${digits}`
  return sequence <= 1 ? base : `${base}-${sequence}`
}

/** 在已知 id 集合下生成唯一 id（同秒冲突追加序号）。 */
export function nextStampedId(prefix: 'FIX' | 'INC', clock: Clock, existing: readonly string[]): string {
  const taken = new Set(existing)
  for (let sequence = 1; sequence < 1_000; sequence += 1) {
    const candidate = stampedId(prefix, clock, sequence)
    if (!taken.has(candidate)) return candidate
  }
  // 极端情况下退回毫秒后缀，保证不重复。
  return `${stampedId(prefix, clock, 1)}-${clock.now().getTime()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function severity(value: unknown): RepairRecord['severity'] {
  return value === 'P0' || value === 'P1' || value === 'P2' ? value : 'P1'
}

/** 归一化 repair.json 的任意 JSON；缺少关键字段（id/title/scope/verify）返回 null。 */
export function normalizeRepairRecord(parsed: unknown): RepairRecord | null {
  if (!isRecord(parsed)) return null
  const id = str(parsed.id)
  const title = str(parsed.title)
  const verify = str(parsed.verify)
  const scope = stringArray(parsed.scope)
  if (id === undefined || title === undefined || verify === undefined || scope.length === 0) return null
  if (parsed.status !== 'open' && parsed.status !== 'done' && parsed.status !== 'aborted') return null
  const record: RepairRecord = {
    id,
    title,
    symptom: str(parsed.symptom) ?? '',
    scope,
    verify,
    acceptance: stringArray(parsed.acceptance),
    severity: severity(parsed.severity),
    status: parsed.status,
    openedAt: str(parsed.openedAt) ?? '',
    openedBy: parsed.openedBy === 'human' ? 'human' : 'agent',
    actions: typeof parsed.actions === 'number' && Number.isFinite(parsed.actions) ? parsed.actions : 0,
  }
  const repro = str(parsed.repro)
  if (repro !== undefined) record.repro = repro
  const redEvidenceId = str(parsed.redEvidenceId)
  if (redEvidenceId !== undefined) record.redEvidenceId = redEvidenceId
  const greenEvidenceId = str(parsed.greenEvidenceId)
  if (greenEvidenceId !== undefined) record.greenEvidenceId = greenEvidenceId
  const regressionEvidenceId = str(parsed.regressionEvidenceId)
  if (regressionEvidenceId !== undefined) record.regressionEvidenceId = regressionEvidenceId
  if (Array.isArray(parsed.changedFiles)) record.changedFiles = stringArray(parsed.changedFiles)
  if (parsed.commit === null || typeof parsed.commit === 'string') record.commit = parsed.commit as string | null
  const closedAt = str(parsed.closedAt)
  if (closedAt !== undefined) record.closedAt = closedAt
  const abortReason = str(parsed.abortReason)
  if (abortReason !== undefined) record.abortReason = abortReason
  const summary = str(parsed.summary)
  if (summary !== undefined) record.summary = summary
  return record
}

/** 读取进行中的修复声明；文件缺失或损坏返回 null（不抛错）。 */
export async function readActiveRepair(fs: FileSystem, root: string): Promise<RepairRecord | null> {
  const path = layout(root).repair
  try {
    if (!(await fs.exists(path))) return null
    const raw = await fs.readFile(path)
    if (raw.trim() === '') return null
    const record = normalizeRepairRecord(JSON.parse(raw))
    return record !== null && record.status === 'open' ? record : null
  } catch {
    return null
  }
}

/** 原子写进行中的修复声明。 */
export async function writeActiveRepair(fs: FileSystem, root: string, record: RepairRecord): Promise<void> {
  const l = layout(root)
  await fs.mkdir(l.dir)
  await fs.mkdir(l.stateDir)
  const tmp = `${l.repair}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
  await fs.rename(tmp, l.repair)
}

/** 清空进行中的修复声明（不存在时静默）。 */
export async function clearActiveRepair(fs: FileSystem, root: string): Promise<void> {
  try {
    await fs.remove(layout(root).repair)
  } catch {
    // 文件本来就不存在 / 平台不支持删除：忽略。
  }
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}

/** `.flowgate/fixes/index.md` 的表头。 */
export function renderFixIndexHeader(): string {
  return [
    '# 修复记录（FIX）',
    '',
    '> 由 FlowGate 修复通道自动追加；一次声明 = 一条记录，RED→GREEN 证据见同目录 JSON 与 `.flowgate/state/evidence/`。',
    '',
    '| 编号 | 标题 | 级别 | 状态 | 开启 | 关闭 | 结论 |',
    '|---|---|---|---|---|---|---|',
  ].join('\n')
}

/** 追加到索引的一行。 */
export function renderFixIndexRow(record: RepairRecord): string {
  const conclusion = record.status === 'aborted' ? `中止：${record.abortReason ?? ''}` : (record.summary ?? '')
  return `| ${escapeCell(record.id)} | ${escapeCell(record.title)} | ${record.severity} | ${record.status} | ${escapeCell(record.openedAt)} | ${escapeCell(record.closedAt ?? '—')} | ${escapeCell(conclusion)} |`
}

/** 列出已有修复记录 id（用于 id 唯一性）。 */
export async function listFixIds(fs: FileSystem, root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(layout(root).fixesDir)
    return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** 列出已有事故记录 id（用于 id 唯一性）。 */
export async function listIncidentIds(fs: FileSystem, root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(layout(root).incidentsDir)
    return entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/**
 * 归档一条修复记录：写 `.flowgate/fixes/<id>.json`，并在 `index.md` 末尾追加一行。
 * 返回记录文件路径（仓库相对）。
 */
export async function writeFixRecord(fs: FileSystem, root: string, record: RepairRecord): Promise<string> {
  const l = layout(root)
  await fs.mkdir(l.dir)
  await fs.mkdir(l.fixesDir)
  const jsonPath = `${l.fixesDir}/${record.id}.json`
  const tmp = `${jsonPath}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`)
  await fs.rename(tmp, jsonPath)
  if (!(await fs.exists(l.fixesIndex))) {
    await fs.writeFile(l.fixesIndex, `${renderFixIndexHeader()}\n${renderFixIndexRow(record)}\n`)
  } else {
    await fs.appendFile(l.fixesIndex, `${renderFixIndexRow(record)}\n`)
  }
  return jsonPath
}

/** 归档一条事故记录：写 `.flowgate/incidents/<id>.json`；返回路径。 */
export async function writeIncidentRecord(fs: FileSystem, root: string, incident: IncidentRecord): Promise<string> {
  const l = layout(root)
  await fs.mkdir(l.dir)
  await fs.mkdir(l.incidentsDir)
  const jsonPath = `${l.incidentsDir}/${incident.id}.json`
  const tmp = `${jsonPath}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(incident, null, 2)}\n`)
  await fs.rename(tmp, jsonPath)
  return jsonPath
}
