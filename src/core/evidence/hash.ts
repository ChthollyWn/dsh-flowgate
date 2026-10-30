/**
 * Evidence input hashing, freshness and the receipt view.
 *
 * A verification receipt records the hash of the files its verify group
 * declared as inputs (source files, tests, build config, lock files). As long
 * as those inputs do not change the receipt stays fresh; changing any of them
 * makes it stale and the agent has to run `flow_verify` again (docs/03 §6.4).
 *
 * Missing inputs are recorded too: a glob that matches no file, or a declared
 * file that disappeared, changes the hash (it becomes "missing") instead of
 * silently disappearing from the fingerprint.
 */
import type { EvidenceFreshness, EvidenceReceipt, EvidenceView } from '../types'
import type { FileSystem } from '../util/fs'
import { matchAnyGlob, matchGlob } from '../util/glob'
import { sha256, sha256Hex, stableJson } from '../util/hash'
import { normalizeRelPath, posixJoin } from '../util/paths'

/** Directories never worth walking when expanding input globs. */
const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.flowgate',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'venv',
  'vendor',
  '__pycache__',
  '.idea',
  '.cache',
  '.turbo',
  '.gradle',
])

const MAX_WALK_FILES = 20_000

async function walkFiles(fs: FileSystem, root: string, relative = '', files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_WALK_FILES) return files
  let names: string[]
  try {
    names = await fs.readdir(relative === '' ? root : posixJoin(root, relative))
  } catch {
    return files
  }
  for (const name of names.sort()) {
    if (files.length >= MAX_WALK_FILES) break
    const childRelative = relative === '' ? name : `${relative}/${name}`
    if (WALK_SKIP_DIRS.has(name)) continue
    try {
      await fs.statSize(posixJoin(root, childRelative))
      files.push(childRelative)
    } catch {
      await walkFiles(fs, root, childRelative, files)
    }
  }
  return files
}

function isGlobPattern(pattern: string): boolean {
  return /[*?]/.test(pattern)
}

/**
 * Hash the declared inputs of a verify group. Returns the aggregate hash, the
 * matched files and the input patterns that yielded no file.
 */
export async function hashInputs(
  fs: FileSystem,
  root: string,
  inputs: string[],
): Promise<{ hash: string; files: string[]; missing: string[] }> {
  // `!pattern` entries are exclusions (the engine's baseline inputs use
  // `**/*` with `!**/node_modules/**` and similar). Exclusions never appear as
  // "missing inputs"; they only filter matches of the positive patterns.
  const normalized = inputs.map((input) => normalizeRelPath(input)).filter((pattern) => pattern !== '')
  const patterns = [...new Set(normalized.filter((pattern) => !pattern.startsWith('!')))].sort()
  const exclusions = [...new Set(normalized.filter((pattern) => pattern.startsWith('!')).map((pattern) => normalizeRelPath(pattern.slice(1))))]
  const needsWalk = patterns.some(isGlobPattern)
  const walked = needsWalk ? await walkFiles(fs, root) : []
  const files: string[] = []
  const missing: string[] = []
  const entries: { pattern: string; files: { path: string; hash: string }[] }[] = []

  for (const pattern of patterns) {
    let matched = needsWalk ? walked.filter((path) => matchGlob(pattern, path)).sort() : [pattern]
    if (exclusions.length > 0) matched = matched.filter((path) => !matchAnyGlob(exclusions, path))
    const hashed: { path: string; hash: string }[] = []
    for (const path of matched) {
      try {
        const content = await fs.readFile(posixJoin(root, path))
        hashed.push({ path, hash: sha256Hex(content) })
        files.push(path)
      } catch {
        missing.push(path)
        hashed.push({ path, hash: 'missing' })
      }
    }
    if (hashed.length === 0) {
      missing.push(pattern)
    }
    entries.push({ pattern, files: hashed })
  }

  const hash = sha256(stableJson(entries))
  return { hash, files: [...new Set(files)].sort(), missing: [...new Set(missing)].sort() }
}

function finishedAtMs(receipt: EvidenceReceipt): number {
  const parsed = Date.parse(receipt.finishedAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** True when the receipt is a failure: RED phase, non-zero exit or failed cases. */
export function receiptFailed(receipt: EvidenceReceipt): boolean {
  if (receipt.phase === 'red') return true
  if (receipt.exitCode !== 0) return true
  return (receipt.summary?.failed ?? 0) > 0
}

/** The later receipt wins; equal timestamps fall back to the second argument. */
export function latestReceiptWins(a: EvidenceReceipt, b: EvidenceReceipt): EvidenceReceipt {
  return finishedAtMs(b) >= finishedAtMs(a) ? b : a
}

/** Receipts of one verify group, oldest first (the last element is authoritative). */
export function selectReceiptsForGroup(receipts: EvidenceReceipt[], group: string): EvidenceReceipt[] {
  return receipts
    .filter((receipt) => receipt.group === group)
    .slice()
    .sort((a, b) => finishedAtMs(a) - finishedAtMs(b))
}

/**
 * Group receipts for a change: per-group latest receipt plus a failure flag.
 * Receipt order is oldest-first so `receipts[receipts.length - 1]` is the most
 * recent receipt overall.
 */
export function buildEvidenceView(receipts: EvidenceReceipt[]): EvidenceView {
  const sorted = receipts.slice().sort((a, b) => finishedAtMs(a) - finishedAtMs(b))
  const latestByGroup: Record<string, EvidenceReceipt> = {}
  const latestFailed: Record<string, boolean> = {}
  for (const receipt of sorted) {
    latestByGroup[receipt.group] = receipt
    latestFailed[receipt.group] = receiptFailed(receipt)
  }
  return { receipts: sorted, latestByGroup, latestFailed }
}

/**
 * Freshness of a receipt against the current input hash.
 *
 * `superseded` cannot be decided from a single receipt; callers use
 * `buildEvidenceView(...).latestByGroup` to pick the authoritative receipt
 * first, then ask this function whether it is still valid.
 */
export function receiptFreshness(receipt: EvidenceReceipt | undefined, inputsHash: string): EvidenceFreshness {
  if (!receipt) return { fresh: false, reason: 'no-receipt' }
  if (receipt.inputsHash !== inputsHash) {
    return { fresh: false, reason: 'inputs-changed', receipt }
  }
  if (receipt.phase === 'red') return { fresh: false, reason: 'failed', receipt }
  if (receipt.phase !== 'green') return { fresh: false, reason: 'no-green', receipt }
  return { fresh: true, receipt }
}
