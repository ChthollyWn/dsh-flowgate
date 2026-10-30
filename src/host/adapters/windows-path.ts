/**
 * 跨平台路径归一化工具（Windows 盘符 / 反斜杠 / 长路径前缀 / 大小写不敏感比较）。
 *
 * guard 拿到的写文件路径可能是：
 * - 相对路径：`src/foo.ts`、`./src/foo.ts`、`src\\foo.ts`
 * - 绝对路径：`/repo/src/foo.ts`、`C:\\repo\\src\\foo.ts`、`\\\\?\\C:\\repo\\src\\foo.ts`
 * 受保护路径、任务范围、新文件控制都要求**仓库相对路径**（core/util/paths.ts 约定），
 * 因此这里统一负责"任意宿主路径 → 仓库相对路径"的转换与大小写敏感策略。
 */
import * as nodePath from 'node:path'

/** 去掉 Windows 长路径前缀 `\\?\` / `\\.\`。 */
export function stripWindowsPrefix(input: string): string {
  if (input.startsWith('\\\\?\\')) return input.slice(4)
  if (input.startsWith('\\\\.\\')) return input.slice(4)
  return input
}

/** 统一成 core 使用的正斜杠形式。 */
export function normalizeSlashes(input: string): string {
  return stripWindowsPrefix(input).replace(/\\/g, '/')
}

/** 判断是否为绝对路径（POSIX 或 Windows 盘符）。 */
export function isAbsoluteLike(input: string): boolean {
  const p = normalizeSlashes(input)
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/** Windows 等价的小写归一（仅用于比较，不用于实际 IO）。 */
export function compareKey(input: string): string {
  const p = normalizeSlashes(input)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 去掉末尾多余斜杠。 */
function trimTrailing(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p
}

/**
 * 把工具调用里的路径转成**仓库相对路径**（正斜杠、无 `./` 前缀）。
 *
 * - 绝对路径：若在 root 之下则取相对部分；不在 root 之下时原样返回（带前导 `/` 或盘符），
 *   由 core 的受保护路径/范围规则判定为越界，而不是静默改写成相对路径。
 * - 相对路径：直接归一化。
 * - `~` 开头的路径不展开（agent 写 `~/x` 应被拒绝，而不是落到用户目录）。
 */
export function toRepoRelative(root: string, input: string): string {
  let p = trimTrailing(normalizeSlashes(input).trim())
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.' || p === '') return ''
  if (!isAbsoluteLike(p)) return p

  const normalizedRoot = trimTrailing(normalizeSlashes(nodePath.resolve(root)))
  if (compareKey(p) === compareKey(normalizedRoot)) return ''
  const prefix = `${compareKey(normalizedRoot)}/`
  if (compareKey(p).startsWith(prefix)) {
    return p.slice(normalizedRoot.length + 1)
  }
  return p
}

/**
 * 把仓库相对路径拼到绝对根上（用于落盘、git 工作目录、快照对比）。
 * 已经是绝对路径时原样返回。
 */
export function toAbsolute(root: string, repoRelative: string): string {
  if (isAbsoluteLike(repoRelative)) return nodePath.resolve(normalizeSlashes(repoRelative))
  return nodePath.resolve(root, normalizeSlashes(repoRelative))
}

/** 找出 `cwd` 所在项目的根：向上查找标记文件；找不到时返回 cwd 本身。 */
export function findProjectRoot(cwd: string, marker: string, exists: (absolute: string) => boolean): string {
  let current = nodePath.resolve(cwd)
  const parsed = nodePath.parse(current)
  for (;;) {
    if (exists(nodePath.join(current, marker))) return current
    if (current === parsed.root) return nodePath.resolve(cwd)
    const parent = nodePath.dirname(current)
    if (parent === current) return nodePath.resolve(cwd)
    current = parent
  }
}

/** 把绝对路径转成相对 root 的展示路径（不可相对时返回绝对路径）。 */
export function displayPath(root: string, absolute: string): string {
  const rel = toRepoRelative(root, absolute)
  return rel === '' ? '.' : rel
}
