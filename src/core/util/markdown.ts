/**
 * Small, dependency-free markdown helpers used by the artifact parsers.
 * They are intentionally forgiving: FlowGate checks structure, not prose style.
 */

export interface Fence {
  lang: string
  info: string
  content: string
  startLine: number
  endLine: number
}

/** Extract fenced code blocks (``` or ~~~), preserving line numbers. */
export function extractFences(markdown: string): Fence[] {
  const lines = markdown.split(/\r?\n/)
  const fences: Fence[] = []
  let open: { lang: string; info: string; start: number; marker: string } | null = null
  const body: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const match = /^\s*(`{3,}|~{3,})\s*([^\s]*)\s*(.*)$/.exec(line)
    if (open) {
      if (match && match[1]!.startsWith(open.marker[0]!) && match[1]!.length >= open.marker.length) {
        fences.push({
          lang: open.lang,
          info: open.info,
          content: body.join('\n'),
          startLine: open.start + 1,
          endLine: i + 1,
        })
        open = null
        body.length = 0
        continue
      }
      body.push(line)
    } else if (match) {
      open = { lang: (match[2] ?? '').toLowerCase(), info: match[3] ?? '', start: i, marker: match[1]! }
    }
  }
  if (open) {
    fences.push({
      lang: open.lang,
      info: open.info,
      content: body.join('\n'),
      startLine: open.start + 1,
      endLine: lines.length,
    })
  }
  return fences
}

export interface MarkdownTable {
  headers: string[]
  rows: string[][]
  /** Raw source lines of the table, header line included. */
  startLine: number
  endLine: number
}

/** Parse the first markdown table found in the text (or all tables). */
export function extractTables(markdown: string, options: { all?: boolean } = {}): MarkdownTable[] {
  const lines = markdown.split(/\r?\n/)
  const tables: MarkdownTable[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const next = lines[i + 1]
    const isHeader = /\|/.test(line) && next !== undefined && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next)
    if (!isHeader) {
      i += 1
      continue
    }
    const headers = splitTableRow(line)
    const rows: string[][] = []
    let j = i + 2
    while (j < lines.length && /\|/.test(lines[j]!)) {
      const trimmed = lines[j]!.trim()
      if (trimmed === '') break
      rows.push(splitTableRow(trimmed))
      j += 1
    }
    tables.push({ headers, rows, startLine: i + 1, endLine: j })
    i = j
    if (!options.all) break
  }
  return tables
}

export function splitTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

export interface Section {
  level: number
  title: string
  startLine: number
  endLine: number
  body: string
}

/** Split markdown into heading-delimited sections (nested bodies included). */
export function extractSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/)
  const headings: { level: number; title: string; line: number }[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) headings.push({ level: match[1]!.length, title: match[2]!.trim(), line: i })
  }
  const sections: Section[] = []
  for (let idx = 0; idx < headings.length; idx += 1) {
    const heading = headings[idx]!
    const endLine = idx + 1 < headings.length ? headings[idx + 1]!.line : lines.length
    sections.push({
      level: heading.level,
      title: heading.title,
      startLine: heading.line,
      endLine,
      body: lines.slice(heading.line + 1, endLine).join('\n'),
    })
  }
  return sections
}

export function findSection(markdown: string, matcher: RegExp): Section | undefined {
  return extractSections(markdown).find((section) => matcher.test(section.title))
}

/** Parse a YAML block that is either fenced or delimited by markers inside a section body. */
export function findYamlBlock(text: string): string | null {
  const fences = extractFences(text).filter((fence) => fence.lang === 'yaml' || fence.lang === 'yml')
  if (fences.length > 0) return fences[0]!.content
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^```ya?ml\s*$/.test(line))
  if (start >= 0) {
    const end = lines.findIndex((line, idx) => idx > start && /^```\s*$/.test(line))
    if (end > start) return lines.slice(start + 1, end).join('\n')
  }
  return null
}

export interface Bullet {
  indent: number
  text: string
  line: number
}

/** Extract list items (`-`, `*`, `1.`) with indentation, skipping fenced code. */
export function extractBullets(markdown: string): Bullet[] {
  const lines = markdown.split(/\r?\n/)
  const bullets: Bullet[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (match) bullets.push({ indent: match[1]!.length, text: match[2]!.trim(), line: i + 1 })
  }
  return bullets
}

/** Collect non-empty paragraph lines between headings, used for "required section" checks. */
export function sectionHasContent(body: string): boolean {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*+]\s+/, '').trim())
    .some((line) => line.length > 0 && !/^<!--/.test(line))
}

/** Strip HTML comments so templates left untouched do not count as content. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}
