/**
 * Verifiable source citations (`path:start-end`, optional quote).
 *
 * Verification can only prove that the referenced code exists and matches the
 * quote; it never proves the conclusion drawn from it. When the cited file
 * changes afterwards the citation is marked stale so G1/G2 can ask for a
 * re-check instead of silently trusting outdated evidence.
 */
import type { CitationCheck, CitationRef } from '../types'
import type { FileSystem } from '../util/fs'
import { sha256 } from '../util/hash'
import { posixJoin } from '../util/paths'
import { extractCitationRefs } from '../artifacts/parse'

/** Resolve a repo-relative citation file against the project root. */
function resolvePath(root: string, file: string): string {
  return posixJoin(root, file)
}

function normalizeWhitespace(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim()
}

function verifyQuote(quote: string, region: string): boolean {
  if (quote.trim() === '') return true
  if (region.includes(quote)) return true
  const normalizedQuote = normalizeWhitespace(quote)
  if (normalizedQuote === '') return true
  return normalizeWhitespace(region).includes(normalizedQuote)
}

/**
 * Verify citation refs against the file system: file exists, line range exists,
 * quote (when provided) is contained in the cited range, and record the file
 * hash + verification time for later freshness checks.
 */
export async function verifyCitations(
  fs: FileSystem,
  root: string,
  refs: CitationRef[],
  now: string,
): Promise<CitationCheck[]> {
  const checks: CitationCheck[] = []
  const hashCache = new Map<string, string | null>()
  for (const citation of refs) {
    const file = citation.file
    const start = Math.min(citation.startLine, citation.endLine)
    const end = Math.max(citation.startLine, citation.endLine)
    const path = resolvePath(root, file)
    let content: string | null
    try {
      content = await fs.readFile(path)
    } catch {
      content = null
    }
    if (content === null) {
      checks.push({ citation: { ...citation, startLine: start, endLine: end }, ok: false, error: `文件不存在：${file}` })
      continue
    }
    if (!hashCache.has(file)) hashCache.set(file, sha256(content))
    const hash = hashCache.get(file) ?? undefined
    const lines = content.split(/\r?\n/)
    // A trailing newline should not create a phantom last line.
    const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    if (start < 1) {
      checks.push({
        citation: { ...citation, startLine: start, endLine: end },
        ok: false,
        error: `行号必须从 1 开始（收到 ${start}）`,
      })
      continue
    }
    if (start > lineCount) {
      checks.push({
        citation: { ...citation, startLine: start, endLine: end },
        ok: false,
        hash,
        error: `行号超出范围：引用从第 ${start} 行开始，但 ${file} 只有 ${lineCount} 行`,
      })
      continue
    }
    if (end > lineCount) {
      checks.push({
        citation: { ...citation, startLine: start, endLine: end },
        ok: false,
        hash,
        error: `行号超出范围：引用到第 ${end} 行，但 ${file} 只有 ${lineCount} 行`,
      })
      continue
    }
    const region = lines.slice(start - 1, end).join('\n')
    if (!verifyQuote(citation.quote ?? '', region)) {
      checks.push({
        citation: { ...citation, startLine: start, endLine: end },
        ok: false,
        hash,
        error: `引用片段与原文不一致：${file}:${start}-${end} 中找不到所给原文`,
      })
      continue
    }
    checks.push({
      citation: { ...citation, startLine: start, endLine: end },
      ok: true,
      hash,
      verifiedAt: now,
    })
  }
  return checks
}

/** True when the cited file still has the hash recorded at verification time. */
export async function citationsFresh(fs: FileSystem, root: string, check: CitationCheck): Promise<boolean> {
  if (!check.ok || check.hash === undefined) return false
  try {
    const content = await fs.readFile(resolvePath(root, check.citation.file))
    return sha256(content) === check.hash
  } catch {
    return false
  }
}

/** Re-check verified citations; marks `stale` on those whose file changed. */
export async function citationsStale(fs: FileSystem, root: string, refs: CitationCheck[]): Promise<CitationCheck[]> {
  const stale: CitationCheck[] = []
  const hashCache = new Map<string, string | null>()
  for (const check of refs) {
    if (!check.ok) continue
    const file = check.citation.file
    let current: string | null | undefined = hashCache.get(file)
    if (current === undefined) {
      try {
        current = sha256(await fs.readFile(resolvePath(root, file)))
      } catch {
        current = null
      }
      hashCache.set(file, current)
    }
    const fresh = current !== null && check.hash !== undefined && current === check.hash
    if (!fresh) stale.push({ ...check, stale: true })
  }
  return stale
}

/** Collect citation refs from an artifact document (its `raw` markdown). */
export function documentCitations(doc: { raw: string }): CitationRef[] {
  if (!doc || typeof doc.raw !== 'string') return []
  return extractCitationRefs(doc.raw)
}
