/**
 * 项目级运行开关：`.flowgate/state/flags.json`（v0.5.1）。
 *
 * - `off`：门禁暂停（写操作放行）。负责人手动暂停 `by: 'human'`；agent 自暂停
 *   `by: 'agent'` + `autoRearm: true` + `hostEpoch`，宿主重启（epoch 变化）时
 *   在 engine load 阶段自动恢复。
 * - `incident`：未关闭的事故记录；`flow_incident_close` 补齐摘要并归档到
 *   `.flowgate/incidents/<id>.json` 后清除。
 *
 * 约定：本模块**绝不因为文件损坏而抛错**。flags 是运行态辅助状态，损坏时按
 * 「没有暂停」降级（fail-open 到正常门禁），否则一个坏文件会把 agent 永久锁死。
 * 写入使用 `<path>.tmp` + rename 原子替换，不留半截 JSON。
 */
import type { FileSystem } from '../util/fs'
import type { EnforcerKind, IncidentRecord, ProjectFlags, RepairSeverity } from '../types'
import { layout } from './layout'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asEnforcerKind(value: unknown): EnforcerKind | undefined {
  return value === 'human' || value === 'agent' ? value : undefined
}

function asSeverity(value: unknown): RepairSeverity | undefined {
  return value === 'P0' || value === 'P1' || value === 'P2' ? value : undefined
}

function normalizeIncident(value: unknown): IncidentRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = str(value.id)
  const reason = str(value.reason)
  if (id === undefined || reason === undefined) return undefined
  const incident: IncidentRecord = {
    id,
    severity: asSeverity(value.severity) ?? 'P1',
    reason,
    openedAt: str(value.openedAt) ?? '',
    openedBy: asEnforcerKind(value.openedBy) ?? 'agent',
  }
  const closedAt = str(value.closedAt)
  const summary = str(value.summary)
  const tests = str(value.tests)
  if (closedAt !== undefined) incident.closedAt = closedAt
  if (summary !== undefined) incident.summary = summary
  if (tests !== undefined) incident.tests = tests
  if (value.commit === null || typeof value.commit === 'string') incident.commit = value.commit as string | null
  if (Array.isArray(value.files)) incident.files = value.files.filter((item): item is string => typeof item === 'string')
  return incident
}

/** 未暂停、无事故的空 flags（返回值是新对象，调用方可安全修改）。 */
export function emptyProjectFlags(): ProjectFlags {
  return {}
}

/** 归一化任意 JSON 为 ProjectFlags；结构非法时丢弃对应字段（不抛错）。 */
export function normalizeProjectFlags(parsed: unknown): ProjectFlags {
  if (!isRecord(parsed)) return {}
  const flags: ProjectFlags = {}
  if (isRecord(parsed.off)) {
    const by = asEnforcerKind(parsed.off.by)
    const reason = str(parsed.off.reason)
    if (by !== undefined && reason !== undefined) {
      flags.off = {
        by,
        reason,
        at: str(parsed.off.at) ?? '',
        ...(parsed.off.autoRearm === true ? { autoRearm: true } : {}),
        ...(str(parsed.off.hostEpoch) !== undefined ? { hostEpoch: str(parsed.off.hostEpoch) } : {}),
      }
    }
  }
  const incident = normalizeIncident(parsed.incident)
  if (incident !== undefined) flags.incident = incident
  return flags
}

/**
 * 读取项目级 flags；文件缺失或损坏都返回 `{}`（不抛错）。
 *
 * 损坏时静默降级为「未暂停」是有意的：flags 只承载可重新生成的运行态，
 * 而门禁本身的完整性由锁定模式（status.json/账本）负责。
 */
export async function readProjectFlags(fs: FileSystem, root: string): Promise<ProjectFlags> {
  const path = layout(root).flags
  try {
    if (!(await fs.exists(path))) return {}
    const raw = await fs.readFile(path)
    if (raw.trim() === '') return {}
    return normalizeProjectFlags(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** 原子写项目级 flags（先写 `.tmp` 再 rename）。 */
export async function writeProjectFlags(fs: FileSystem, root: string, flags: ProjectFlags): Promise<void> {
  const l = layout(root)
  await fs.mkdir(l.stateDir)
  await fs.mkdir(l.dir)
  const tmp = `${l.flags}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(flags, null, 2)}\n`)
  await fs.rename(tmp, l.flags)
}
