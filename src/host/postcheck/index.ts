/**
 * 调用前后工作区快照 + 事后归因（03 §5.2 / H17）。
 *
 * `tools/execute` 是 around-dispatch waterfall：`await next()` 前后可以做任意异步工作
 * （docs/impl/dsh-plugin-api-cheatsheet.md §5.3）。
 *
 * 采集方式（按 H17 首选）：
 * 1. 每次 shell 类调用前/后各拍一次快照：`git status --porcelain=v2 -z` + 已改动文件内容哈希；
 * 2. 两次快照的差异 = 本次调用产生的改动 →（在允许集合外的）越界判定交给 engine；
 * 3. 上次调用结束 → 本次调用开始之间出现的改动 = 非 agent 改动（编辑器/格式化/文件监听），
 *    记为 external，不判越界；
 * 4. `.flowgate/` 下由插件自己写的文件不参与归因。
 *
 * H17 不成立（git 不可用/非 git 仓库）时退化：用文件扫描 + "任务开始快照"，
 * 无法归因的改动标 origin='unknown'，doctor 会列出降级。
 */
import type { DshContext, DshToolExecution, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { FileSystem, GitPort } from '../../core/types.js'
import { sha256Hex } from '../../core/util/hash.js'
import { toAgentError } from '../errors.js'
import * as nodePath from 'node:path'

/** 单次快照：git 状态串 + 每个改动文件的内容哈希。 */
export interface WorkspaceSnapshot {
  at: string
  mode: 'git' | 'walk'
  /** 快照指纹（状态串 + 文件哈希的 sha256）。 */
  fingerprint: string
  /** 仓库相对路径 → 内容哈希（二进制/超大文件只记 size）。 */
  files: Map<string, string>
}

const IGNORED_PREFIXES = ['.flowgate/', '.git/', 'node_modules/']
const MAX_HASH_BYTES = 2 * 1024 * 1024
const MAX_FILES = 400

/** shell 类工具判定：优先 core 分类，其次文件名/参数形状兜底。 */
export function isShellLikeTool(runtime: HostRuntime, name: string, params: Record<string, unknown>): boolean {
  try {
    const classification = runtime.deps.core.classifyTool(name, Object.keys(params))
    if (classification.category === 'shell') return true
  } catch {
    // 分类器异常：走文件名兜底。
  }
  if (/^(bash|shell|pwsh|powershell|cmd|terminal|exec)$/i.test(name)) return true
  return typeof params.command === 'string'
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

/** 解析 `git status --porcelain=v2 -z` 的输出，提取路径。 */
export function parsePorcelainV2(output: string): string[] {
  if (output === '') return []
  const records = output.split('\0')
  const paths = new Set<string>()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const kind = record[0]
    if (kind === '1' || kind === 'u') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const match = /^[12u] \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/.exec(record)
      const path = kind === '1' ? record.split(' ').slice(8).join(' ') : match?.[1]
      if (path) paths.add(path)
    } else if (kind === '2') {
      // rename/copy：`2 <XY> ... <path>\0<origPath>`
      const path = record.split(' ').slice(9).join(' ')
      if (path) paths.add(path)
      index += 1
    } else if (kind === '?') {
      const path = record.slice(2)
      if (path) paths.add(path)
    }
  }
  return [...paths].filter((path) => !isIgnored(path)).sort()
}

function isIgnored(repoRelative: string): boolean {
  const normalized = repoRelative.replace(/^\.\//, '')
  return IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

async function hashFiles(fs: FileSystem, paths: string[]): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const path of paths.slice(0, MAX_FILES)) {
    try {
      const size = await fs.statSize(path)
      if (size > MAX_HASH_BYTES) {
        files.set(path, `size:${size}`)
        continue
      }
      const content = await fs.readFile(path)
      files.set(path, sha256Hex(content))
    } catch {
      // 删除的文件：用删除标记，重命名/删除也能被 diff 出来。
      files.set(path, 'deleted')
    }
  }
  return files
}

/** git 模式快照。 */
export async function snapshotWithGit(git: GitPort, fs: FileSystem, absoluteRoot: string): Promise<WorkspaceSnapshot> {
  const status = await git.statusPorcelain(absoluteRoot)
  const paths = parsePorcelainV2(status)
  const files = await hashFiles(fs, paths)
  const fingerprint = sha256Hex(`${status}\n${[...files.entries()].map(([path, hash]) => `${path}:${hash}`).join('\n')}`)
  return { at: new Date().toISOString(), mode: 'git', fingerprint, files }
}

/**
 * 文件扫描模式快照（H17 降级）：只看若干常见源码根，限制文件数与大小。
 * 仅用于"任务开始快照"和无法用 git 的仓库；精度低于 git 模式。
 */
export async function snapshotWithWalk(fs: FileSystem, absoluteRoot: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, string>()
  const queue: string[] = ['']
  let visited = 0
  while (queue.length > 0 && files.size < MAX_FILES) {
    const dir = queue.shift() ?? ''
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const relative = dir === '' ? entry : `${dir}/${entry}`
      if (isIgnored(relative)) continue
      let size = 0
      try {
        size = await fs.statSize(relative)
      } catch {
        // 是目录：入队继续扫描。
        queue.push(relative)
        continue
      }
      try {
        if (size <= MAX_HASH_BYTES) files.set(relative, sha256Hex(await fs.readFile(relative)))
        else files.set(relative, `size:${size}`)
      } catch {
        files.set(relative, 'unreadable')
      }
      visited += 1
      if (visited >= MAX_FILES * 4) break
    }
  }
  const fingerprint = sha256Hex([...files.entries()].map(([path, hash]) => `${path}:${hash}`).join('\n'))
  return { at: new Date().toISOString(), mode: 'walk', fingerprint, files }
}

/** 两次快照的差异（路径集合）。 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changed = new Set<string>()
  for (const [path, hash] of after.files) {
    if (before.files.get(path) !== hash) changed.add(path)
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changed.add(path)
  }
  return [...changed].sort()
}

/** 每个工作目录的上一次结束后快照（用于识别非 agent 改动）。 */
const lastSnapshotByCwd = new Map<string, WorkspaceSnapshot>()
/** 任务开始快照（H17 降级路径）。 */
const taskStartSnapshots = new Map<string, WorkspaceSnapshot>()

/** 记录"任务开始快照"（flow_task_start 调用；H17 不成立时使用）。 */
export async function captureTaskStartSnapshot(runtime: HostRuntime, taskId: string): Promise<void> {
  const root = runtime.root()
  const ports = runtime.ports()
  if (!root || !ports) return
  try {
    const snapshot =
      ports.git && (await ports.git.isRepo(root))
        ? await snapshotWithGit(ports.git, ports.fs, root)
        : await snapshotWithWalk(ports.fs, root)
    taskStartSnapshots.set(taskId, snapshot)
  } catch (error) {
    runtime.noteFeature('postcheck', `任务开始快照失败：${toAgentError(error).error}`)
  }
}

/** 安装 postcheck（tools/execute 包装层）。 */
export function installPostcheck(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools) return
    runtime.capabilities.toolsExecute = true
    runtime.onScoped(scoped, 'tools/execute', async (exec: DshToolExecution, next: () => Promise<unknown>) => {
      return await wrapExecute(runtime, exec, next)
    })
  })
}

async function wrapExecute(runtime: HostRuntime, exec: DshToolExecution, next: () => Promise<unknown>): Promise<unknown> {
  if (!runtime.isEnabled()) return next()
  const engine = runtime.engine()
  const root = runtime.root()
  const ports = runtime.ports()
  if (!engine || !root || !ports) return next()
  const snapshot = runtime.lastSnapshot
  if (!snapshot?.initialized || snapshot.off) return next()
  const params = asRecord(exec.arguments)
  if (!isShellLikeTool(runtime, exec.name, params)) return next()

  const taskId = snapshot.activeTaskId
  const cwd = typeof params.workdir === 'string' && params.workdir !== '' ? params.workdir : root
  const useGit = ports.git !== undefined
  let before: WorkspaceSnapshot | null = null
  try {
    if (useGit && ports.git) {
      if (await ports.git.isRepo(root)) before = await snapshotWithGit(ports.git, ports.fs, root)
      else before = await snapshotWithWalk(ports.fs, root)
    } else {
      before = await snapshotWithWalk(ports.fs, root)
    }
  } catch (error) {
    runtime.noteFeature('postcheck', `调用前快照失败（本次不做事后归因）：${toAgentError(error).error}`)
    return next()
  }

  // 非 agent 改动：上次调用结束后的快照 vs 本次调用前。
  const previous = lastSnapshotByCwd.get(cwd)
  if (previous && before) {
    try {
      const external = diffSnapshots(previous, before)
      if (external.length > 0 && typeof engine.recordExternalChanges === 'function') {
        await engine.recordExternalChanges(external)
        runtime.noteFeature('postcheck', `检测到 ${external.length} 处非 agent 改动：${external.slice(0, 5).join('、')}`)
      }
    } catch (error) {
      runtime.noteFeature('postcheck', `非 agent 改动记录失败：${toAgentError(error).error}`)
    }
  }

  let result: unknown
  let after: WorkspaceSnapshot | null = null
  try {
    result = await next()
  } finally {
    try {
      if (before) {
        after =
          useGit && ports.git && (await ports.git.isRepo(root))
            ? await snapshotWithGit(ports.git, ports.fs, root)
            : await snapshotWithWalk(ports.fs, root)
        lastSnapshotByCwd.set(cwd, after)
      }
    } catch (error) {
      runtime.noteFeature('postcheck', `调用后快照失败：${toAgentError(error).error}`)
    }
  }

  if (before && after) {
    // 调用前有未提交改动、调用后回到干净状态 → 说明这次调用把文件撤销/删除了，
    // 对应的越界记录应自动解除（T1.4 验收 #2：git checkout -- 后自动解除）。
    const engineAfter = runtime.engine()
    if (engineAfter) {
      const cleaned = cleanedPaths(before, after)
      if (cleaned.length > 0) {
        try {
          await engineAfter.clearViolationsForReverted(cleaned)
        } catch (error) {
          runtime.noteFeature('postcheck', `撤销后解除越界失败：${toAgentError(error).error}`)
        }
      }
    }
    try {
      const changed = diffSnapshots(before, after)
      if (changed.length > 0) {
        const engine2 = runtime.engine()
        if (engine2) {
          const deletedPaths = [...after!.files.entries()].filter(([, hash]) => hash === 'deleted').map(([path]) => path)
          const violations = await engine2.recordPostcheck({ origin: 'agent', changedPaths: changed, taskId, deletedPaths })
          if (violations.length > 0) {
            runtime.noteFeature('postcheck', `越界改动：${violations.map((violation) => violation.path).join('、')}`)
          }
        }
      }
    } catch (error) {
      runtime.noteFeature('postcheck', `事后归因失败：${toAgentError(error).error}`)
    }
  } else if (!before && taskId) {
    // H17 降级路径：用任务开始快照对比，无法归因的标 unknown。
    const baseline = taskStartSnapshots.get(taskId)
    if (baseline) {
      try {
        const after2 = await snapshotWithWalk(ports.fs, root)
        const changed = diffSnapshots(baseline, after2)
        if (changed.length > 0) await runtime.engine()?.recordPostcheck({ origin: 'unknown', changedPaths: changed, taskId })
      } catch {
        // 忽略。
      }
    }
  }
  return result
}

/**
 * 调用前处于「已改」状态、调用后回到干净状态的路径。
 * 用于自动解除已撤销的越界记录（T1.4）。
 */
export function cleanedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  return [...before.files.keys()].filter((path) => !after.files.has(path)).sort()
}

/** 仓库相对路径拼接（worktree 目录常在根之外）。 */
export function resolveCwd(root: string, cwd: string): string {
  if (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)) return cwd
  return nodePath.resolve(root, cwd)
}

/** doctor 用：事后检测是否处于降级模式。 */
export function postcheckStatus(runtime: HostRuntime): { gitAvailable: boolean; lastSnapshotAt: string | null } {
  const root = runtime.root()
  const ports = runtime.ports()
  const snapshot = root ? lastSnapshotByCwd.get(root) : undefined
  return {
    gitAvailable: Boolean(ports?.git),
    lastSnapshotAt: snapshot?.at ?? null,
  }
}

/** 测试用：清空快照缓存。 */
export function resetPostcheckCacheForTest(): void {
  lastSnapshotByCwd.clear()
  taskStartSnapshots.clear()
}
