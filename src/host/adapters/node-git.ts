/**
 * `GitPort` 端口的 Node 实现（core/types.ts GitPort）。
 *
 * 约定：
 * - 所有 `cwd` 由调用方给绝对路径（engine 传 root，派发/worktree 传具体 worktree）；
 *   相对路径按 `process.cwd()` 解析。
 * - 设置 `GIT_TERMINAL_PROMPT=0`，任何需要交互的 git 操作都直接失败而不是挂起。
 * - 失败抛 `GitCommandError`，上层（postcheck/doctor）负责降级。
 */
import type { GitPort } from '../../core/types'
import { execFile } from 'node:child_process'
import * as nodePath from 'node:path'

export interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export class GitCommandError extends Error {
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  constructor(args: readonly string[], cwd: string, exitCode: number, stderr: string) {
    super(`git ${args.join(' ')} 失败（cwd=${cwd}，exit=${exitCode}）：${stderr.trim()}`)
    this.name = 'GitCommandError'
    this.args = args
    this.cwd = cwd
    this.exitCode = exitCode
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_BUFFER = 64 * 1024 * 1024

/** 运行一次 git；不抛错，返回退出码与输出。 */
export function runGit(args: readonly string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitRunResult> {
  const resolvedCwd = nodePath.resolve(cwd)
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: resolvedCwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : 1) : 0
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode })
      },
    )
  })
}

/** 运行 git 并要求成功，否则抛 GitCommandError。 */
async function gitOrThrow(args: readonly string[], cwd: string, timeoutMs?: number): Promise<string> {
  const result = await runGit(args, cwd, timeoutMs)
  if (result.exitCode !== 0) throw new GitCommandError(args, nodePath.resolve(cwd), result.exitCode, result.stderr)
  return result.stdout
}

/** `git status --porcelain=v2 -z`：稳定的工作区快照（NUL 分隔，原样返回给调用方哈希）。 */
export class NodeGit implements GitPort {
  async isRepo(cwd: string): Promise<boolean> {
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, 10_000)
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  }

  async head(cwd: string): Promise<string | null> {
    const result = await runGit(['rev-parse', 'HEAD'], cwd, 10_000)
    if (result.exitCode !== 0) return null
    const value = result.stdout.trim()
    return value === '' ? null : value
  }

  async currentBranch(cwd: string): Promise<string | null> {
    const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 10_000)
    if (result.exitCode !== 0) return null
    const value = result.stdout.trim()
    return value === '' || value === 'HEAD' ? null : value
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd, 10_000)
    return result.exitCode === 0
  }

  async createBranch(cwd: string, branch: string): Promise<void> {
    await gitOrThrow(['branch', branch], cwd)
  }

  async checkout(cwd: string, branch: string, create = false): Promise<void> {
    await gitOrThrow(create ? ['checkout', '-b', branch] : ['checkout', branch], cwd)
  }

  async statusPorcelain(cwd: string): Promise<string> {
    // porcelain=v2 带 -z 输出 NUL 分隔记录，避免文件名中的换行造成歧义。
    const result = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd, 30_000)
    if (result.exitCode !== 0) throw new GitCommandError(['status'], nodePath.resolve(cwd), result.exitCode, result.stderr)
    return result.stdout
  }

  async diffNames(cwd: string, fromSnapshot?: string): Promise<string[]> {
    const args = fromSnapshot
      ? ['diff', '--name-only', '--no-renames', fromSnapshot]
      : ['diff', '--name-only', '--no-renames', 'HEAD']
    const result = await runGit(args, cwd, 30_000)
    if (result.exitCode !== 0) throw new GitCommandError(args, nodePath.resolve(cwd), result.exitCode, result.stderr)
    const tracked = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    if (fromSnapshot) return tracked
    // 无基线时补上未跟踪文件（不含 .gitignore 忽略项），供"非 agent 改动"识别使用。
    const untracked = await runGit(['ls-files', '--others', '--exclude-standard'], cwd, 30_000)
    const extra = untracked.exitCode === 0 ? untracked.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '') : []
    return [...new Set([...tracked, ...extra])].sort()
  }

  async diffText(cwd: string, base?: string): Promise<string> {
    const args = base ? ['diff', '--no-renames', base] : ['diff', '--no-renames', 'HEAD']
    const result = await runGit(args, cwd)
    if (result.exitCode !== 0) throw new GitCommandError(args, nodePath.resolve(cwd), result.exitCode, result.stderr)
    return result.stdout
  }

  async showFile(cwd: string, ref: string, path: string): Promise<string | null> {
    const result = await runGit(['show', `${ref}:${path}`], cwd, 30_000)
    if (result.exitCode !== 0) return null
    return result.stdout
  }

  async add(cwd: string, paths: string[]): Promise<void> {
    await gitOrThrow(['add', '--', ...paths], cwd)
  }

  async commit(cwd: string, message: string): Promise<void> {
    await gitOrThrow(['commit', '-m', message, '--no-verify'], cwd)
  }

  async push(cwd: string, remote?: string, branch?: string): Promise<void> {
    const args = ['push']
    if (remote) args.push(remote)
    if (branch) args.push(branch)
    await gitOrThrow(args, cwd, 10 * 60_000)
  }
}
