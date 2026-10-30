/** Path helpers shared by rules, scope checks, evidence freshness and plan checks. */

/** Normalize a repository-relative path: forward slashes, no leading `./`, no trailing slash. */
export function normalizeRelPath(input: string): string {
  let p = input.replace(/\\/g, '/').trim()
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.') p = ''
  p = p.replace(/\/+/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

/** Normalize an absolute or relative path against a root into a repository-relative path. */
export function toRelPath(root: string, target: string): string {
  const normalizedRoot = normalizeRelPath(root)
  const normalizedTarget = normalizeRelPath(target)
  if (normalizedTarget === normalizedRoot) return ''
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1)
  }
  return normalizedTarget
}

export function posixDirname(p: string): string {
  const normalized = normalizeRelPath(p)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

export function posixBasename(p: string): string {
  const normalized = normalizeRelPath(p)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

export function posixJoin(...parts: string[]): string {
  return normalizeRelPath(parts.filter((part) => part !== '').join('/'))
}

/** True when the path is protected from agent writes regardless of stage. */
export function isUnder(path: string, prefix: string): boolean {
  const p = normalizeRelPath(path)
  const base = normalizeRelPath(prefix)
  if (base === '') return true
  return p === base || p.startsWith(`${base}/`)
}
