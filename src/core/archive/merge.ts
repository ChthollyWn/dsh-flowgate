/**
 * Main-spec merge for S6 archive (OpenSpec-style ADDED / MODIFIED / REMOVED).
 *
 * Incremental specs are written by the agent under
 * `.flowgate/changes/<id>/specs/**.md`; on delivery they must be folded into the
 * project's main capability spec (`.flowgate/specs/<capability>/spec.md`).
 * This module is a pure string transformation so it can be unit-tested and
 * replayed; the engine owns file IO and the capability mapping.
 */
export type RequirementChangeType = 'ADDED' | 'MODIFIED' | 'REMOVED'

export interface RequirementBlock {
  /** Matching key: requirement id when present (e.g. `R2`), else normalized title. */
  key: string
  /** Requirement title without the `Requirement:` prefix. */
  title: string
  /** Full raw block (heading + body), trimmed. */
  raw: string
}

export interface IncrementalRequirement {
  changeType: RequirementChangeType
  block: RequirementBlock
}

export interface SpecMergeResult {
  /** Merged main-spec markdown. */
  markdown: string
  /** True when an existing file was modified (vs created from scratch). */
  updated: boolean
  added: string[]
  modified: string[]
  removed: string[]
  warnings: string[]
}

/** Extract the matching key from a requirement title (`R2 续费回调幂等` → `R2`). */
export function requirementKeyOf(title: string): string {
  const match = /^\s*([A-Za-z][A-Za-z0-9_-]*\d+(?:\.\S+)?)\b/.exec(title)
  if (match) return match[1]!.toUpperCase()
  return title
    .toLowerCase()
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .slice(0, 80)
}

/** Split a markdown spec into its preamble and `### Requirement:` blocks. */
export function splitRequirementBlocks(markdown: string): { preamble: string; blocks: RequirementBlock[] } {
  const lines = markdown.split(/\r?\n/)
  const starts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^###\s+Requirement\s*[:：]/.test(lines[index]!.trim())) starts.push(index)
  }
  if (starts.length === 0) {
    return { preamble: markdown.trim(), blocks: [] }
  }
  const preamble = lines.slice(0, starts[0]!).join('\n').trim()
  const blocks: RequirementBlock[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!
    const end = index + 1 < starts.length ? starts[index + 1]! : lines.length
    const raw = lines.slice(start, end).join('\n').trim()
    const heading = lines[start]!.replace(/^###\s+Requirement\s*[:：]\s*/, '').trim()
    blocks.push({ key: requirementKeyOf(heading), title: heading, raw })
  }
  return { preamble, blocks }
}

/** Read the change-type sections of an incremental spec. */
export function readIncrementalRequirements(markdown: string): IncrementalRequirement[] {
  const lines = markdown.split(/\r?\n/)
  const sections: { changeType: RequirementChangeType; start: number; end: number }[] = []
  let current: { changeType: RequirementChangeType; start: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements?\s*$/i.exec(lines[index]!.trim())
    if (heading) {
      if (current) sections.push({ ...current, end: index })
      current = { changeType: heading[1]!.toUpperCase() as RequirementChangeType, start: index + 1 }
    }
  }
  if (current) sections.push({ ...current, end: lines.length })

  const out: IncrementalRequirement[] = []
  for (const section of sections) {
    const slice = lines.slice(section.start, section.end).join('\n')
    const { blocks } = splitRequirementBlocks(slice)
    for (const block of blocks) out.push({ changeType: section.changeType, block })
  }
  // Specs without any ADDED/MODIFIED/REMOVED header are treated as ADDED.
  if (out.length === 0) {
    const { blocks } = splitRequirementBlocks(markdown)
    for (const block of blocks) out.push({ changeType: 'ADDED', block })
  }
  return out
}

/**
 * Fold an incremental spec into a main capability spec.
 *
 * - ADDED: append; if the key already exists the block is replaced and a warning
 *   is emitted (the spec should have used MODIFIED).
 * - MODIFIED: replace an existing requirement; append + warn when missing.
 * - REMOVED: drop an existing requirement; warn when missing.
 */
export function mergeIncrementalSpec(
  existing: string | null,
  incremental: string,
  options: { capability?: string } = {},
): SpecMergeResult {
  const capability = options.capability?.trim() || 'main'
  const { preamble, blocks } = splitRequirementBlocks(existing ?? '')
  const byKey = new Map(blocks.map((block) => [block.key, block]))
  const warnings: string[] = []
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []

  for (const requirement of readIncrementalRequirements(incremental)) {
    const { changeType, block } = requirement
    const existingBlock = byKey.get(block.key)
    if (changeType === 'ADDED') {
      if (existingBlock) {
        warnings.push(`ADDED 的 ${block.key} 已存在于主规格，已按替换处理（应改用 MODIFIED）`)
        byKey.set(block.key, block)
        modified.push(block.key)
      } else {
        byKey.set(block.key, block)
        added.push(block.key)
      }
    } else if (changeType === 'MODIFIED') {
      if (!existingBlock) {
        warnings.push(`MODIFIED 的 ${block.key} 在主规格中不存在，已作为新增处理`)
        added.push(block.key)
      } else {
        modified.push(block.key)
      }
      byKey.set(block.key, block)
    } else {
      if (existingBlock) {
        byKey.delete(block.key)
        removed.push(block.key)
      } else {
        warnings.push(`REMOVED 的 ${block.key} 在主规格中不存在，已忽略`)
      }
    }
  }

  const header = preamble !== '' ? preamble : `# 主规格：${capability}\n\n> 由 FlowGate 归档合并维护；需求按编号排序。`
  const ordered = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key, 'en'))
  const markdown = `${header.trim()}\n\n${ordered.map((block) => block.raw).join('\n\n')}\n`
  return { markdown, updated: existing !== null, added, modified, removed, warnings }
}

/** Filesystem-safe capability directory name. */
export function capabilityDirName(capability: string, fallback: string): string {
  const cleaned = capability
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 60)
  return cleaned !== '' ? cleaned : fallback
}
