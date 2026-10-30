/**
 * Scope control: which paths an agent may write, which paths only the plugin may
 * write, and which artifacts are writable in the current stage (03 §5, FR-4).
 *
 * Everything is a pure function over the task card / change status; the real
 * filesystem is never read here.
 */
import type {
  ChangeStatus,
  FlowgateConfig,
  PlannedFileChange,
  StageId,
  TaskCard,
} from '../types'
import { matchAnyGlob, matchGlob } from '../util/glob'
import { normalizeRelPath, posixBasename } from '../util/paths'

/** Files only the plugin may write (FR-4.6, 03 §9.1 "仅插件写"). */
export const BUILTIN_PROTECTED_PATHS: string[] = [
  '.git',
  '.git/**',
  '.flowgate/README.md',
  '.flowgate/.gitignore',
  '.flowgate/config.yaml',
  '.flowgate/project.md',
  '.flowgate/state/**',
  '.flowgate/worktrees/**',
  '.flowgate/specs/**',
  '.flowgate/rules/**',
  '.flowgate/archive/**',
  '.flowgate/metrics/**',
  '.flowgate/retro.md',
  '.flowgate/dashboard.html',
  '.flowgate/changes/index.md',
  '.flowgate/changes/*/status.json',
  '.flowgate/changes/*/execution-plan.md',
  '.flowgate/changes/*/handoff.md',
  '.flowgate/changes/*/evidence.md',
  '.flowgate/changes/*/review.md',
  '.flowgate/changes/*/report.html',
  '.flowgate/changes/*/analysis.md',
  '.flowgate/changes/*/evidence/**',
]

/** Agent-writable artifacts of a change, relative to `.flowgate/changes/<id>/`. */
const CHANGE_ARTIFACTS_BY_STAGE: Partial<Record<StageId, string[]>> = {
  S1: ['clarify.md', 'proposal.md', 'specs/**/spec.md'],
  S2: ['context.md'],
  S3: ['design.md', 'risk.md', 'tasks.md'],
}

/** Project-level artifacts writable during the `roadmap` stage. */
const ROADMAP_ARTIFACTS = ['.flowgate/project-clarify.md', '.flowgate/roadmap.md']

function secretFileReason(path: string): string | null {
  const base = posixBasename(path).toLowerCase()
  if (base === '') return null
  if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template|md)$/.test(base)) {
    return '环境变量文件通常含密钥：agent 不能直接写入；请把占位符写进 .env.example，真实密钥用环境变量或密钥管理'
  }
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(base)) {
    return '私钥/证书材料属于密钥文件：agent 不能写入，请交给负责人或密钥管理服务'
  }
  if (/^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(base)) {
    return 'SSH 密钥文件：agent 不能写入'
  }
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc') {
    return '包管理器/网络凭证文件：agent 不能写入'
  }
  if (/^credentials(\..+)?$/.test(base) || /^secrets?(\..+)?$/.test(base)) {
    return '凭证/密钥文件：agent 不能写入'
  }
  return null
}

function protectedReasonFor(path: string): string {
  if (path === '.git' || path.startsWith('.git/')) {
    return '.git 内部文件 agent 不能写（会破坏版本历史与范围检测）'
  }
  if (path.startsWith('.flowgate/state/')) {
    return '账本/会话/快照/证据属于运行态，只有插件能写，否则改动无法归因'
  }
  if (path === '.flowgate/config.yaml') {
    return '流程配置由负责人维护：agent 不能改写门禁规则'
  }
  if (path.startsWith('.flowgate/specs/')) {
    return '主规格由插件在归档时合并，agent 不能直接写'
  }
  if (path === '.flowgate/changes/index.md') {
    return '变更台账由插件维护'
  }
  if (/\/(status\.json|execution-plan\.md|handoff\.md|evidence\.md|review\.md|report\.html|analysis\.md)$/.test(path)) {
    return '该文件由插件生成/维护，agent 不能写'
  }
  return '该路径是受保护路径，只有插件或负责人能写'
}

/**
 * True when a path is protected from agent writes regardless of stage:
 * plugin-owned `.flowgate/` files, `.git` internals, key files and any extra
 * protected path configured in `config.yaml`.
 */
export function isProtectedPath(
  path: string,
  config: FlowgateConfig,
): { protected: boolean; reason?: string } {
  const normalized = normalizeRelPath(path)
  if (normalized === '') return { protected: false }
  const secretReason = secretFileReason(normalized)
  if (secretReason) return { protected: true, reason: secretReason }
  const configured = (config.triggers?.protected_paths ?? []).map((pattern) =>
    normalizeRelPath(pattern).replace('{change}', '*'),
  )
  const patterns = [...BUILTIN_PROTECTED_PATHS, ...configured]
  if (matchAnyGlob(patterns, normalized)) {
    return { protected: true, reason: protectedReasonFor(normalized) }
  }
  return { protected: false }
}

/**
 * S0-S3 only allow writes to the current change's own artifacts (FR-4.1).
 * Roadmap stage allows the project-level clarify/roadmap artifacts.
 */
export function isArtifactWritableInStage(change: ChangeStatus, path: string): boolean {
  const normalized = normalizeRelPath(path)
  if (normalized === '' || change.lifecycle === 'locked') return false
  if (change.stage === 'roadmap') return matchAnyGlob(ROADMAP_ARTIFACTS, normalized)
  const prefix = `.flowgate/changes/${change.id}/`
  if (!normalized.startsWith(prefix)) return false
  const relative = normalized.slice(prefix.length)
  const artifacts = CHANGE_ARTIFACTS_BY_STAGE[change.stage]
  if (!artifacts) return false
  return matchAnyGlob(artifacts, relative)
}

/** Normalized allowed write set of a task card (task.scope + approved scope additions). */
export function allowedWriteSet(
  task: TaskCard | null,
  change: ChangeStatus,
): {
  scope: string[]
  tests: string[]
  newFiles: string[]
  changes: PlannedFileChange[]
} {
  if (!task) return { scope: [], tests: [], newFiles: [], changes: [] }
  const additions = change.scopeAdditions?.[task.id] ?? []
  return {
    scope: uniquePaths([...task.scope, ...additions]),
    tests: uniquePaths(task.tests),
    newFiles: uniquePaths(task.newFiles),
    changes: task.changes.map((change_) => {
      const planned: PlannedFileChange = {
        path: normalizeRelPath(change_.path),
        kind: change_.kind,
      }
      if (change_.to !== undefined) planned.to = normalizeRelPath(change_.to)
      return planned
    }),
  }
}

function uniquePaths(paths: string[]): string[] {
  const cleaned = paths.map((path) => normalizeRelPath(path)).filter((path) => path !== '')
  return [...new Set(cleaned)].sort()
}

export type WriteDenyReason =
  | 'outside-scope'
  | 'undeclared-new-file'

export interface WriteVerdict {
  allowed: boolean
  reason: 'scope' | 'tests' | 'new-file' | 'declared-change' | WriteDenyReason
  hint?: string
}

/**
 * Path-level check: is `path` writable under the active task? Returned `reason`
 * tells the rule engine why; `undeclared-new-file` is only produced by
 * `isAllowedWriteForAction` (it needs the action kind to know it is a creation).
 */
export function isAllowedWrite(
  task: TaskCard | null,
  change: ChangeStatus,
  path: string,
): WriteVerdict {
  const normalized = normalizeRelPath(path)
  if (!task) {
    return {
      allowed: false,
      reason: 'outside-scope',
      hint: 'S4 执行阶段还没有活动任务：先 flow_task_start 领取任务卡（或 flow_dispatch_next 派发），之后只能写任务卡里列出的文件。',
    }
  }
  const set = allowedWriteSet(task, change)
  if (set.changes.some((planned) => planned.path === normalized || planned.to === normalized)) {
    return { allowed: true, reason: 'declared-change' }
  }
  if (matchAnyGlob(set.newFiles, normalized)) return { allowed: true, reason: 'new-file' }
  if (matchAnyGlob(set.scope, normalized)) return { allowed: true, reason: 'scope' }
  if (matchAnyGlob(set.tests, normalized)) return { allowed: true, reason: 'tests' }
  return {
    allowed: false,
    reason: 'outside-scope',
    hint: `不在当前任务 ${task.id}（${task.title}）范围内；确需修改请用 flow_request_scope_change 说明路径和理由，等负责人批准后再改。`,
  }
}

/**
 * Action-aware check used by the rule engine. Creation must be declared in
 * `new_files` (FR-4.4); delete/rename must be declared in `changes` (03 §5.6).
 */
export function isAllowedWriteForAction(
  task: TaskCard | null,
  change: ChangeStatus,
  path: string,
  kind: 'write' | 'create' | 'delete' | 'rename',
): WriteVerdict {
  const normalized = normalizeRelPath(path)
  if (!task) return isAllowedWrite(null, change, normalized)
  const set = allowedWriteSet(task, change)
  const declared = set.changes.find(
    (planned) => planned.path === normalized || planned.to === normalized,
  )

  if (kind === 'delete' || kind === 'rename') {
    if (declared) return { allowed: true, reason: 'declared-change' }
    return {
      allowed: false,
      reason: 'outside-scope',
      hint: `任务 ${task.id} 的 changes 里没有声明要${kind === 'delete' ? '删除' : '重命名'} ${normalized}；未声明的删除/重命名一律拒绝，请先写进任务卡 changes 并重新过 G3。`,
    }
  }

  if (kind === 'create') {
    if (declared && declared.to === normalized) return { allowed: true, reason: 'declared-change' }
    if (matchAnyGlob(set.newFiles, normalized)) return { allowed: true, reason: 'new-file' }
    const insideScope =
      matchAnyGlob(set.scope, normalized) || matchAnyGlob(set.tests, normalized)
    if (insideScope) {
      return {
        allowed: false,
        reason: 'undeclared-new-file',
        hint: `新建文件 ${normalized} 不在任务 ${task.id} 的 new_files 里：先查 project.md 的可复用模块清单，确需新增用 flow_request_scope_change 申请范围变更。`,
      }
    }
    return {
      allowed: false,
      reason: 'outside-scope',
      hint: `新建文件 ${normalized} 不在任务 ${task.id} 范围内；先申请范围变更或把文件并入任务范围。`,
    }
  }

  return isAllowedWrite(task, change, normalized)
}

/** Convenience predicate for stage S6: which files may be delivered/edited. */
export function isDeliveryWritable(path: string): boolean {
  const normalized = normalizeRelPath(path)
  return matchAnyGlob(['CHANGELOG*', 'CHANGELOG/**', 'docs/**', 'README*', '*.md'], normalized)
}

/** Re-exported for callers that want a single glob check against the static protected list. */
export function matchesProtectedPattern(path: string): boolean {
  return matchAnyGlob(BUILTIN_PROTECTED_PATHS, normalizeRelPath(path))
}

export { matchGlob }
