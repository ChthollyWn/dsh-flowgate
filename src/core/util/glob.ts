/**
 * Glob matching used for task scope, rule path patterns, evidence inputs and the
 * plan overlap checks. Supports `*` (one segment), `**` (any depth) and `?`.
 * Patterns and paths are repo-relative, forward-slash normalised.
 */
import { normalizeRelPath } from './paths'

const cache = new Map<string, RegExp>()

export function compileGlob(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached) return cached
  const normalized = normalizeRelPath(pattern)
  let re = ''
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] ?? ''
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (normalized[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  const compiled = new RegExp(`^${re}$`)
  cache.set(pattern, compiled)
  return compiled
}

export function matchGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(normalizeRelPath(path))
}

export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, path))
}

/**
 * Conservative intersection test for two glob patterns: returns true when the
 * patterns may match at least one common path. Used by the G3 parallel safety
 * check (two tasks in one parallel batch must not write the same file).
 */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = normalizeRelPath(a)
  const pb = normalizeRelPath(b)
  if (pa === '' || pb === '') return true
  const sa = pa.split('/')
  const sb = pb.split('/')
  return segmentsMayOverlap(sa, 0, sb, 0)
}

function segmentsMayOverlap(a: string[], ai: number, b: string[], bi: number): boolean {
  if (ai === a.length && bi === b.length) return true
  if (ai === a.length) {
    // Remaining pattern b can only match if it is entirely "**" like.
    return b.slice(bi).every((seg) => seg === '**')
  }
  if (bi === b.length) {
    return a.slice(ai).every((seg) => seg === '**')
  }
  const segA = a[ai]!
  const segB = b[bi]!
  if (segA === '**') {
    // `**` may consume zero or more segments.
    return segmentsMayOverlap(a, ai + 1, b, bi) || segmentsMayOverlap(a, ai, b, bi + 1)
  }
  if (segB === '**') {
    return segmentsMayOverlap(a, ai, b, bi + 1) || segmentsMayOverlap(a, ai + 1, b, bi)
  }
  if (segmentsMatch(segA, segB)) {
    return segmentsMayOverlap(a, ai + 1, b, bi + 1)
  }
  return false
}

/** True when two single-segment globs share at least one possible name. */
function segmentsMatch(a: string, b: string): boolean {
  const reA = new RegExp(`^${segmentToRegex(a)}$`)
  const reB = new RegExp(`^${segmentToRegex(b)}$`)
  if (a.includes('*') || a.includes('?')) {
    // Both fixed: compare directly. One wildcard: test a and b against each other.
    if (!b.includes('*') && !b.includes('?')) return reA.test(b)
    if (!a.includes('*') && !a.includes('?')) return reB.test(a)
    // Two wildcard patterns: a cheap conservative approximation.
    const literalA = a.replace(/[*?]/g, '')
    const literalB = b.replace(/[*?]/g, '')
    if (literalA === '' || literalB === '') return true
    return literalA.startsWith(literalB) || literalB.startsWith(literalA) || literalA === literalB
  }
  return a === b
}

function segmentToRegex(segment: string): string {
  let re = ''
  for (const ch of segment) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(ch)) re += `\\${ch}`
    else re += ch
  }
  return re
}

/** Render the concrete matching sub-paths when a pattern is fully concrete (for hints). */
export function isConcretePattern(pattern: string): boolean {
  return !/[*?]/.test(pattern)
}
