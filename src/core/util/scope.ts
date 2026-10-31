/**
 * 修复通道的范围匹配（v0.5.1）：判断一个 repo-relative 路径是否落在声明的
 * scope 内。scope 写法与任务卡一致，但额外接受几种宽松写法，降低「声明了却
 * 永远不命中」的死锁：
 *
 * - glob：`src/**`、`**\/*.ts`、`test/*.test.ts`（`*` 单段、`**` 任意深度、`?` 单字符）；
 * - 目录前缀：`src/core` 命中 `src/core/engine.ts`；
 * - 裸文件名：`engine.ts` 命中任意目录下的同名文件（后缀语义）；
 * - 裸 glob 后缀：`*.md` 命中 `docs/a.md`（按 basename 匹配）。
 *
 * 路径与 pattern 都做反斜杠归一（Windows 输入）与 `./` 前缀清理。
 */
import { matchGlob } from './glob'
import { normalizeRelPath, posixBasename } from './paths'

function patternHasGlob(pattern: string): boolean {
  return /[*?]/.test(pattern)
}

function matchesSingle(pattern: string, path: string): boolean {
  const normalizedPattern = normalizeRelPath(pattern)
  const normalizedPath = normalizeRelPath(path)
  if (normalizedPattern === '' || normalizedPath === '') return false
  if (normalizedPattern === normalizedPath) return true

  const hasSlash = normalizedPattern.includes('/')
  if (hasSlash) {
    // 带路径的 glob 直接匹配；具体路径同时接受目录前缀语义（scope 写目录）。
    if (patternHasGlob(normalizedPattern)) {
      if (matchGlob(normalizedPattern, normalizedPath)) return true
      // `src/core/**` 之类已由 glob 覆盖；这里处理 `src/core*`（glob）不算前缀。
      return false
    }
    return normalizedPath.startsWith(`${normalizedPattern}/`)
  }

  // 不含 `/` 的 pattern：按 basename / 目录前缀 / 裸路径后缀匹配。
  if (patternHasGlob(normalizedPattern)) {
    if (matchGlob(normalizedPattern, posixBasename(normalizedPath))) return true
    // `src*` 这类模式也允许命中任意层级段（保守：逐段测试）。
    return normalizedPath.split('/').some((segment) => matchGlob(normalizedPattern, segment))
  }
  if (posixBasename(normalizedPath) === normalizedPattern) return true
  if (normalizedPath.startsWith(`${normalizedPattern}/`)) return true
  // 目录段前缀：`core` 不命中 `src/score/`，但 `src/core/...` 已由上一条覆盖。
  return false
}

/** True when `path` is inside any of the declared scope patterns. */
export function matchesScope(path: string, patterns: readonly string[]): boolean {
  const normalizedPath = normalizeRelPath(path)
  if (normalizedPath === '') return false
  return patterns.some((pattern) => matchesSingle(pattern, normalizedPath))
}

/** 找出所有未命中 scope 的路径（用于 finishRepair 的越界报告）。 */
export function outOfScopePaths(paths: readonly string[], patterns: readonly string[]): string[] {
  return paths.filter((path) => !matchesScope(path, patterns))
}
