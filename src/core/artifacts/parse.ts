/**
 * Tolerant markdown artifact parsers.
 *
 * The parsers assume real, agent-written markdown: headings may be `##` or
 * `###`, titles may be Chinese or English, structured fields may live in a
 * fenced YAML block or in a markdown table. They never throw: when a structure
 * cannot be recognized they return an empty (but well-typed) structure so the
 * gate checks can report a friendly, actionable failure instead of crashing.
 */
import {
  SIX_ELEMENTS,
  type CitationRef,
  type ClarifyDoc,
  type ClarifyQA,
  type ContextDoc,
  type ContextSection,
  type DesignDoc,
  type DesignOption,
  type EvidenceReceipt,
  type ExecutionBatch,
  type ExecutionPlan,
  type PlannedFileChange,
  type ProjectDoc,
  type ProjectModuleInfo,
  type ProposalDoc,
  type Requirement,
  type RiskCategory,
  type RiskDoc,
  type RiskEntry,
  type RiskGrade,
  type RoadmapDoc,
  type RoadmapEntry,
  type Scenario,
  type SixElementKey,
  type SourceFact,
  type SpecDoc,
  type TaskCard,
  type TasksDoc,
  type TraceMatrix,
  type VerifyGroup,
} from '../types'
import {
  extractBullets,
  extractFences,
  extractSections,
  extractTables,
  findYamlBlock,
  sectionHasContent,
  stripComments,
} from '../util/markdown'
import type { Section } from '../util/markdown'
import { normalizeRelPath } from '../util/paths'

// ---------------------------------------------------------------------------
// Tiny YAML subset parser (no external dependency: core only uses node + util)
// ---------------------------------------------------------------------------

interface YamlLine {
  indent: number
  text: string
}

function isSeqLine(text: string): boolean {
  return text === '-' || text.startsWith('- ')
}

function stripYamlComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (inDouble) {
      if (ch === '\\') i += 1
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inDouble) {
      current += ch
      if (ch === '\\') {
        const next = text[i + 1]
        if (next !== undefined) {
          current += next
          i += 1
        }
      } else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === separator && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

function unquote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === '"' && last === '"') {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
    }
    if (first === "'" && last === "'") return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function splitKeyValue(text: string): { key: string; value: string } | null {
  let inSingle = false
  let inDouble = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inDouble) {
      if (ch === '\\') i += 1
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '[' || ch === '{') {
      depth += 1
      continue
    }
    if (ch === ']' || ch === '}') {
      depth -= 1
      continue
    }
    if (ch === ':' && depth === 0) {
      const key = text.slice(0, i).trim()
      if (!/^[A-Za-z_$][\w$-]*$/.test(key)) return null
      return { key, value: text.slice(i + 1).trim() }
    }
  }
  return null
}

function parseScalar(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitTopLevel(trimmed.slice(1, -1), ',').map((part) => parseScalar(part))
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const out: Record<string, unknown> = {}
    for (const part of splitTopLevel(trimmed.slice(1, -1), ',')) {
      const kv = splitKeyValue(part.trim())
      if (kv) out[kv.key] = kv.value === '' ? null : parseScalar(kv.value)
    }
    return out
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return unquote(trimmed)
  }
  if (/^(true|yes|on)$/i.test(trimmed)) return true
  if (/^(false|no|off)$/i.test(trimmed)) return false
  if (/^(null|~|—|-)$/i.test(trimmed)) return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed
}

/**
 * Parse the small YAML subset used by FlowGate artifacts: nested mappings,
 * sequences, inline arrays `[a, b]`, inline maps `{ path: x, kind: delete }`,
 * quoted scalars and `# comments`.
 */
export function parseYamlLite(source: string): unknown {
  const lines: YamlLine[] = []
  for (const raw of stripComments(source).split(/\r?\n/)) {
    const cleaned = stripYamlComment(raw).replace(/\s+$/, '')
    if (cleaned.trim() === '') continue
    const indent = cleaned.length - cleaned.trimStart().length
    lines.push({ indent, text: cleaned.trim() })
  }
  if (lines.length === 0) return null
  let cursor = 0
  const peek = (): YamlLine | undefined => lines[cursor]

  function parseMap(indent: number, seed?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = seed ?? {}
    for (;;) {
      const line = peek()
      if (!line || line.indent !== indent || isSeqLine(line.text)) break
      const kv = splitKeyValue(line.text)
      if (!kv) break
      cursor += 1
      if (kv.value === '') {
        const next = peek()
        out[kv.key] = next && next.indent > indent ? parseBlock(next.indent) : null
      } else {
        out[kv.key] = parseScalar(kv.value)
      }
    }
    return out
  }

  function parseSeq(indent: number): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const line = peek()
      if (!line || line.indent !== indent || !isSeqLine(line.text)) break
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      cursor += 1
      if (rest === '') {
        const next = peek()
        out.push(next && next.indent > indent ? parseBlock(next.indent) : null)
        continue
      }
      const kv = splitKeyValue(rest)
      if (kv) {
        const item: Record<string, unknown> = {}
        if (kv.value === '') {
          const next = peek()
          item[kv.key] = next && next.indent > indent ? parseBlock(next.indent) : null
        } else {
          item[kv.key] = parseScalar(kv.value)
        }
        const next = peek()
        if (next && next.indent > indent && !isSeqLine(next.text)) parseMap(next.indent, item)
        out.push(item)
      } else {
        out.push(parseScalar(rest))
      }
    }
    return out
  }

  function parseBlock(indent: number): unknown {
    const line = peek()
    if (!line || line.indent < indent) return null
    if (isSeqLine(line.text)) return parseSeq(line.indent)
    if (splitKeyValue(line.text)) return parseMap(line.indent)
    cursor += 1
    return parseScalar(line.text)
  }

  return parseBlock(lines[0]!.indent)
}

/** Read the first YAML fenced block in a section body, if any. */
function yamlFromBody(body: string): Record<string, unknown> | null {
  const block = findYamlBlock(body)
  if (block === null) return null
  const parsed = parseYamlLite(block)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

/** Read every YAML fenced block of the markdown. */
function allYamlBlocks(markdown: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const fence of extractFences(markdown)) {
    if (!['yaml', 'yml', ''].includes(fence.lang)) continue
    const parsed = parseYamlLite(fence.content)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      out.push(parsed as Record<string, unknown>)
    }
  }
  return out
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item) => item !== '')
  }
  const single = asString(value)
  if (single === '') return []
  return splitTopLevel(single, ',').map((part) => unquote(part.trim())).filter((part) => part !== '')
}

function splitInlineList(text: string): string[] {
  const cleaned = text.trim()
  if (cleaned === '' || /^(—|-|无|none|n\/a)$/i.test(cleaned)) return []
  return cleaned
    .split(/[;；、,，]/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^(—|-|无|none|n\/a)$/i.test(part))
}

function cleanLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim()
}

function stripEmphasis(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
}

function firstMeaningfulParagraph(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim())
  const collected: string[] = []
  for (const line of lines) {
    if (line === '') {
      if (collected.length > 0) break
      continue
    }
    if (/^[-*+]\s+/.test(line) || /^#/.test(line) || /^\|/.test(line)) {
      if (collected.length > 0) break
      continue
    }
    collected.push(line)
  }
  return collected.join(' ').trim()
}

/** `## 1. 目标` → `目标`; strips numbering, emphasis and trailing colons. */
function headingLabel(title: string): string {
  return stripEmphasis(title)
    .replace(/^[\d一二三四五六七八九十]+[.、)）]\s*/, '')
    .replace(/[:：]\s*$/, '')
    .trim()
}

function findSectionByAny(sections: Section[], patterns: RegExp[]): Section | undefined {
  for (const pattern of patterns) {
    const found = sections.find((section) => pattern.test(headingLabel(section.title)))
    if (found) return found
  }
  return undefined
}

function sectionBodyText(section: Section | undefined): string {
  if (!section) return ''
  return section.body.trim()
}

function bulletsOfSection(section: Section | undefined): string[] {
  if (!section) return []
  return extractBullets(section.body)
    .map((bullet) => bullet.text.trim())
    .filter((text) => text !== '')
}

function nonTrivialBullets(texts: string[]): string[] {
  return texts.filter((text) => !/^(—|-|无|none|n\/a)$/i.test(text.trim()))
}

function safe<T>(fallback: () => T, run: () => T): T {
  try {
    return run()
  } catch {
    return fallback()
  }
}

// ---------------------------------------------------------------------------
// Vague terms / quantification
// ---------------------------------------------------------------------------

/**
 * Vague-word vocabulary (Chinese + English). A THEN clause containing one of
 * these without a measurable threshold fails the G1 testability check.
 */
export const VAGUE_TERMS: readonly string[] = [
  '尽快',
  '尽快完成',
  '快速',
  '较快',
  '良好',
  '友好',
  'user-friendly',
  'friendly',
  '适当',
  '适量',
  '尽量',
  '等等',
  '合理',
  '稳定',
  '高效',
  '流畅',
  '便捷',
  '简洁',
  '灵活',
  '足够',
  '显著',
  '大幅',
  '及时',
  '易用',
  '差不多',
  '大约',
  '较为',
  '完善',
  '优化',
  'as soon as possible',
  'appropriate',
  'adequate',
  'efficient',
  'flexible',
  'reasonable',
  'sufficient',
  'fast',
  'quickly',
  'quick',
  'stable',
  'robust',
  'seamless',
  'intuitive',
  '等等等',
  '好',
  '快',
  '多',
  '少',
  '大',
  '小',
]

const VAGUE_MATCHERS: ReadonlyArray<{ term: string; re: RegExp }> = (() => {
  const matchers: { term: string; re: RegExp }[] = []
  for (const term of VAGUE_TERMS) {
    if (/^[a-z]/i.test(term)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      matchers.push({ term, re: new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i') })
      continue
    }
    if (term === '快') {
      // Avoid false positives on 快照/快速/快递/赶快 — 快速 is its own term.
      matchers.push({ term, re: /快(?!照|速|递|乐|讯|门|餐)/ })
      continue
    }
    if (term === '好') {
      // 好 is too noisy on its own (好处/良好/更好); only "要好" style is caught by 良好.
      continue
    }
    if (term === '多' || term === '少' || term === '大' || term === '小') continue
    if (term === '等等等') continue
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matchers.push({ term, re: new RegExp(escaped) })
  }
  return matchers
})()

/** List the vague terms found in the text (deduplicated, in vocabulary order). */
export function findVagueTerms(text: string): string[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  const found: string[] = []
  for (const matcher of VAGUE_MATCHERS) {
    if (matcher.re.test(text) && !found.includes(matcher.term)) found.push(matcher.term)
  }
  return found
}

const QUANTIFIED_PATTERNS: readonly RegExp[] = [
  /\d+(?:\.\d+)?\s*(?:ms|毫秒|s|秒|分钟|min|小时|h|天|%|px|kb|mb|gb|tb|qps|tps|rps|rpm|次|个|条|行|并发|线程|用户|请求|万|千|倍|元|人|台|张|页)/i,
  /\d+\s*(?:ms|s)\b/i,
  /\bp(?:50|90|95|99|999)\b/i,
  /HTTP\s*\d{3}/i,
  /\d+\s*\/\s*\d+/,
  /\d+\s*≤|≤\s*\d+|≥\s*\d+|\d+\s*≥/,
  /(?:<=|>=|<|>)\s*\d|\d\s*(?:<=|>=|<|>)/,
  /(?:不超过|不低于|至少|最多|至少|至多|以内|之内|高于|低于|少于|大于|不少于|不多于)\s*\d/,
  /\d+\s*(?:处|步|层|项|位|字符|字|条)/,
]

/** True when the text carries a measurable threshold (numbers + unit/comparison). */
export function isQuantified(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false
  return QUANTIFIED_PATTERNS.some((re) => re.test(text))
}

/** Explain why a vague term is not testable, with a measurable example. */
export function vagueTermHint(terms: string[]): string {
  const list = terms.slice(0, 5).join('、')
  return `THEN 里的「${list}」无法验收：改成可测量阈值，例如 p95 < 300ms、错误率 < 0.1%、10 秒内返回、最多 3 次重试。`
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const CITATION_PATH = String.raw`(?:[A-Za-z0-9_][A-Za-z0-9_.@+-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.@+-]*\.[A-Za-z0-9]{1,12}`
const CITATION_TEXT_RE = new RegExp(
  String.raw`(?<![\w/])(${CITATION_PATH}):(\d+)(?:\s*-\s*(\d+))?`,
  'g',
)

function pushCitation(out: CitationRef[], seen: Set<string>, file: string, startLine: number, endLine: number, quote?: string): void {
  const normalized = normalizeRelPath(unquote(file).replace(/^`+|`+$/g, ''))
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').includes('..')) return
  const start = Math.max(1, Math.min(startLine, endLine))
  const end = Math.max(1, Math.max(startLine, endLine))
  const key = `${normalized}:${start}:${end}:${quote ?? ''}`
  if (seen.has(key)) return
  seen.add(key)
  const citation: CitationRef = { file: normalized, startLine: start, endLine: end }
  if (quote !== undefined && quote.trim() !== '') citation.quote = quote.trim()
  out.push(citation)
}

function jsonObjectSnippets(text: string): string[] {
  const snippets: string[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    if (end > i) {
      const snippet = text.slice(i, end + 1)
      if (snippet.includes('"file"')) snippets.push(snippet)
      i = end
    }
  }
  return snippets
}

function tryParseJsonCitationObjects(text: string, out: CitationRef[], seen: Set<string>): void {
  for (const raw of jsonObjectSnippets(text)) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      const file = typeof value.file === 'string' ? value.file : ''
      const start = Number(value.start_line ?? value.startLine ?? 0)
      const end = Number(value.end_line ?? value.endLine ?? start)
      if (file === '' || !Number.isFinite(start)) continue
      const quote = typeof value.quote === 'string' ? value.quote : undefined
      pushCitation(out, seen, file, start, Number.isFinite(end) ? end : start, quote)
    } catch {
      // Not JSON after all; the text regex below still gets a chance.
    }
  }
}

/**
 * Extract `path/to/File.ext:12-34` / `path:12` citations, plus embedded JSON
 * citation objects (`{ "file": ..., "start_line": ..., "end_line": ... }`).
 */
export function extractCitationRefs(text: string): CitationRef[] {
  if (typeof text !== 'string' || text === '') return []
  const out: CitationRef[] = []
  const seen = new Set<string>()
  try {
    tryParseJsonCitationObjects(text, out, seen)
    for (const match of text.matchAll(CITATION_TEXT_RE)) {
      const file = match[1] ?? ''
      const start = Number(match[2] ?? '')
      const end = match[3] === undefined ? start : Number(match[3])
      if (file === '' || !Number.isFinite(start)) continue
      pushCitation(out, seen, file, start, Number.isFinite(end) ? end : start)
    }
  } catch {
    return out
  }
  return out
}

// ---------------------------------------------------------------------------
// Clarify
// ---------------------------------------------------------------------------

const ELEMENT_LABELS: Record<SixElementKey, RegExp[]> = {
  goal: [/目标|goal|目的|要解决/i],
  boundary: [/边界|范围|scope|boundary|做.*不做|不做/i],
  roles: [/角色|权限|role|stakeholder|用户/i],
  acceptance: [/验收|acceptance|criteri|完成标准/i],
  constraints: [/约束|非功能|constraint|non-?functional|性能|兼容/i],
  unknowns: [/未知|假设|unknown|assumption|待确认|风险/i],
}

function emptyElements(): Record<SixElementKey, { conclusion: string; source: string; status: string }> {
  const out = {} as Record<SixElementKey, { conclusion: string; source: string; status: string }>
  for (const key of SIX_ELEMENTS) out[key] = { conclusion: '', source: '', status: '' }
  return out
}

function elementFromLabel(label: string): SixElementKey | null {
  const cleaned = headingLabel(label)
  for (const key of SIX_ELEMENTS) {
    if (ELEMENT_LABELS[key].some((re) => re.test(cleaned))) return key
  }
  return null
}

function statusFromText(text: string, hasCitation: boolean): SourceFact['status'] {
  if (/已确认|confirmed|已核实|已核验/i.test(text)) return 'confirmed'
  if (/代码推导|推导|derived|推断/i.test(text)) return 'derived'
  if (/假设|assumption|假定/i.test(text)) return 'assumption'
  if (/待确认|pending|未确认|待核实/i.test(text)) return 'pending'
  return hasCitation ? 'confirmed' : 'pending'
}

function sourceFactFromBullet(text: string): SourceFact {
  const citations = extractCitationRefs(text)
  return { text: text.trim(), citations, status: statusFromText(text, citations.length > 0) }
}

function negatedListItems(texts: string[]): string[] {
  return texts.filter((text) => {
    const trimmed = text.trim()
    if (trimmed === '') return false
    return !/^(无|暂无|没有|none|n\/a|—|-|\/|\（无\）|\(无\))$/i.test(trimmed)
  })
}

function parseClarifyTable(raw: string, elements: Record<SixElementKey, { conclusion: string; source: string; status: string }>): void {
  for (const table of extractTables(raw, { all: true })) {
    const elementCol = table.headers.findIndex((header) => /要素|element/i.test(header))
    if (elementCol < 0) continue
    const conclusionCol = table.headers.findIndex((header) => /结论|conclusion|结果/i.test(header))
    const sourceCol = table.headers.findIndex((header) => /来源|source|引用/i.test(header))
    const statusCol = table.headers.findIndex((header) => /状态|status/i.test(header))
    for (const row of table.rows) {
      const key = elementFromLabel(row[elementCol] ?? '')
      if (!key) continue
      const conclusion = conclusionCol >= 0 ? (row[conclusionCol] ?? '').trim() : ''
      const source = sourceCol >= 0 ? (row[sourceCol] ?? '').trim() : ''
      const status = statusCol >= 0 ? (row[statusCol] ?? '').trim() : ''
      if (conclusion === '' && source === '' && status === '') continue
      elements[key] = { conclusion, source, status }
    }
  }
}

function parseClarifyFromSections(
  sections: Section[],
  elements: Record<SixElementKey, { conclusion: string; source: string; status: string }>,
): void {
  for (const section of sections) {
    if (section.level < 2) continue
    const key = elementFromLabel(section.title)
    if (!key) continue
    if (elements[key].conclusion !== '') continue
    const body = section.body.trim()
    if (!sectionHasContent(body)) continue
    const source = extractCitationRefs(body)[0]
    elements[key] = {
      conclusion: body,
      source: source ? `${source.file}:${source.startLine}-${source.endLine}` : '',
      status: statusFromText(body, source !== undefined) === 'confirmed' ? '已确认' : '代码推导',
    }
  }
}

function parseClarifyQA(raw: string): ClarifyQA[] {
  const qa: ClarifyQA[] = []
  for (const table of extractTables(raw, { all: true })) {
    const questionCol = table.headers.findIndex((header) => /问题|question/i.test(header))
    if (questionCol < 0) continue
    const optionsCol = table.headers.findIndex((header) => /选项|候选|option/i.test(header))
    const answerCol = table.headers.findIndex((header) => /回答|答案|answer/i.test(header))
    const changedCol = table.headers.findIndex((header) => /改变|影响|changed/i.test(header))
    const roundCol = table.headers.findIndex((header) => /轮次|轮|round/i.test(header))
    for (const [index, row] of table.rows.entries()) {
      const question = (row[questionCol] ?? '').trim()
      if (question === '') continue
      const options = optionsCol >= 0 ? splitInlineList(row[optionsCol] ?? '') : []
      const answer = answerCol >= 0 ? (row[answerCol] ?? '').trim() : ''
      const changed = changedCol >= 0 ? (row[changedCol] ?? '').trim() : ''
      const parsedRound = roundCol >= 0 ? Number.parseInt((row[roundCol] ?? '').replace(/[^\d]/g, ''), 10) : NaN
      qa.push({
        question,
        options,
        answer,
        changed,
        round: Number.isFinite(parsedRound) && parsedRound > 0 ? parsedRound : index + 1,
      })
    }
  }
  return qa
}

function roundCount(raw: string, qa: ClarifyQA[]): number {
  const headingRounds = (raw.match(/(?:^|\n)#{1,6}\s*[^\n]*第\s*\d+\s*轮/g) ?? []).length
  const qaRounds = qa.reduce((max, item) => Math.max(max, item.round), 0)
  return Math.max(headingRounds, qaRounds)
}

/** Parse `clarify.md` (原始描述 / 已知事实 / 六要素表 / 问答记录 / 假设 / 未决问题). */
export function parseClarify(raw: string): ClarifyDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<ClarifyDoc>(
    () => ({
      raw: safeRaw,
      originalDescription: safeRaw.trim(),
      knownFacts: [],
      elements: emptyElements(),
      qa: [],
      assumptions: [],
      openQuestions: [],
      rounds: 0,
    }),
    () => {
      const sections = extractSections(safeRaw)
      const originalSection = findSectionByAny(sections, [
        /原始描述|需求原文|用户输入|原始需求|用户描述|背景/,
        /original|description/i,
      ])
      let originalDescription = sectionBodyText(originalSection)
      if (originalDescription === '') {
        const lines = safeRaw.split(/\r?\n/)
        const collected: string[] = []
        for (const line of lines) {
          if (/^#{1,6}\s+/.test(line)) break
          if (line.trim() !== '') collected.push(line.trim())
        }
        originalDescription = collected.join(' ').trim()
      }

      const factsSection = findSectionByAny(sections, [/已知事实|项目事实|已知信息|发现的事实/, /known facts|facts/i])
      const knownFacts = nonTrivialBullets(bulletsOfSection(factsSection)).map(sourceFactFromBullet)

      const elements = emptyElements()
      parseClarifyTable(safeRaw, elements)
      parseClarifyFromSections(sections, elements)

      const qa = parseClarifyQA(safeRaw)

      const assumptionsSection = findSectionByAny(sections, [/已接受.*假设|接受的假设|assumptions?/i, /假设/])
      const assumptions = nonTrivialBullets(bulletsOfSection(assumptionsSection))

      const openSection = findSectionByAny(sections, [/未决问题|待确认问题|未解决的问题|open questions/i])
      const openQuestions = negatedListItems(bulletsOfSection(openSection))

      return {
        raw: safeRaw,
        originalDescription,
        knownFacts,
        elements,
        qa,
        assumptions,
        openQuestions,
        rounds: roundCount(safeRaw, qa),
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

const PROPOSAL_SECTIONS = {
  why: [/为什么|背景|动机|目的|要解决的问题|why|motivation/i],
  what: [/做什么|变更内容|方案描述|改什么|what/i],
  impact: [/影响|改动范围|波及|impact/i],
  outOfScope: [/不做|范围外|不包含|非目标|out of scope|不做的事/i],
}

function parseProposalInline(raw: string): { hint: string; values: Record<string, string> } {
  const values: Record<string, string> = {}
  const labels: Record<string, RegExp> = {
    why: /^(为什么|背景|动机)[:：]/,
    what: /^(做什么|变更内容|方案)[:：]/,
    impact: /^(影响|影响范围|改动范围)[:：]/,
    outOfScope: /^(不做|范围外|非目标)[:：]/,
  }
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = cleanLine(stripEmphasis(line))
    for (const [key, re] of Object.entries(labels)) {
      if (re.test(cleaned)) {
        const match = new RegExp(`${re.source}\\s*(.+)$`).exec(cleaned)
        if (match && values[key] === undefined) values[key] = match[1]!.trim()
      }
    }
  }
  return { hint: '', values }
}

/** Parse `proposal.md` (why / what / impact / 不做清单). */
export function parseProposal(raw: string): ProposalDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<ProposalDoc>(
    () => ({ raw: safeRaw, why: '', what: '', impact: '', outOfScope: [] }),
    () => {
      const sections = extractSections(safeRaw)
      const why = sectionBodyText(findSectionByAny(sections, PROPOSAL_SECTIONS.why))
      const what = sectionBodyText(findSectionByAny(sections, PROPOSAL_SECTIONS.what))
      const impact = sectionBodyText(findSectionByAny(sections, PROPOSAL_SECTIONS.impact))
      const scopeSection = findSectionByAny(sections, PROPOSAL_SECTIONS.outOfScope)
      const outOfScope = nonTrivialBullets(bulletsOfSection(scopeSection))
      const inline = parseProposalInline(safeRaw)
      return {
        raw: safeRaw,
        why: why || inline.values.why || firstMeaningfulParagraph(safeRaw),
        what: what || inline.values.what || '',
        impact: impact || inline.values.impact || '',
        outOfScope: outOfScope.length > 0 ? outOfScope : splitInlineList(inline.values.outOfScope ?? ''),
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Incremental spec
// ---------------------------------------------------------------------------

interface Heading {
  level: number
  title: string
  line: number
}

function scanHeadings(text: string): Heading[] {
  const lines = text.split(/\r?\n/)
  const headings: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (match) headings.push({ level: match[1]!.length, title: match[2]!.trim(), line: i })
  }
  return headings
}

function bodyOfSection(text: string, headings: Heading[], index: number): string {
  const heading = headings[index]!
  const lines = text.split(/\r?\n/)
  let end = lines.length
  for (let i = index + 1; i < headings.length; i += 1) {
    if (headings[i]!.level <= heading.level) {
      end = headings[i]!.line
      break
    }
  }
  return lines.slice(heading.line + 1, end).join('\n').trim()
}

function changeTypeFromHeading(title: string): Requirement['changeType'] | null {
  if (/\bADDED\b|新增要求|新增需求|新增/i.test(title)) return 'ADDED'
  if (/\bMODIFIED\b|修改要求|修改需求|修改/i.test(title)) return 'MODIFIED'
  if (/\bREMOVED\b|移除要求|删除需求|移除|删除/i.test(title)) return 'REMOVED'
  return null
}

const REQUIREMENT_HEADING_RE = /^(?:Requirement|需求)\s*[:：]\s*(R\d+)\s*(.*)$/i
const REQUIREMENT_PLAIN_RE = /^(R\d+)\s*[:：\s-]\s*(.*)$/i
const SCENARIO_HEADING_RE = /^(?:Scenario|场景)\s*[:：]\s*(R\d+\.S\d+)\s*(.*)$/i

function keywordLines(body: string): { given: string[]; when: string[]; then: string[] } {
  const given: string[] = []
  const when: string[] = []
  const then: string[] = []
  let target: string[] | null = null
  for (const rawLine of body.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(rawLine)) continue
    const cleaned = cleanLine(rawLine)
    if (cleaned === '') continue
    const keywordOnly = /^(GIVEN|WHEN|THEN|给定|假如|如果|当|则)$/i.exec(cleaned)
    const match = keywordOnly ?? /^(GIVEN|WHEN|THEN|给定|假如|如果|当|则)(?:\s*[:：]\s*|\s+)(.*)$/i.exec(cleaned)
    if (match) {
      const keyword = match[1]!.toUpperCase()
      const content = (match[2] ?? '').trim()
      if (keyword === 'GIVEN' || keyword === '给定' || keyword === '假如' || keyword === '如果') {
        given.push(content)
        target = given
      } else if (keyword === 'WHEN' || keyword === '当') {
        when.push(content)
        target = when
      } else {
        then.push(content)
        target = then
      }
      continue
    }
    if (target && target.length > 0 && !/^[-*+]/.test(rawLine.trim()) && /^[\u4e00-\u9fa5A-Za-z0-9（(]/.test(cleaned)) {
      target[target.length - 1] = `${target[target.length - 1]} ${cleaned}`
    }
  }
  return { given, when, then }
}

function parseScenarioBlock(text: string, headings: Heading[], index: number, requirementId: string, scenarioIndex: number): Scenario {
  const heading = headings[index]!
  const body = bodyOfSection(text, headings, index)
  const match = SCENARIO_HEADING_RE.exec(heading.title)
  const id = match ? match[1]! : `${requirementId}.S${scenarioIndex + 1}`
  const title = match ? (match[2] ?? '').trim() : headingLabel(heading.title)
  const { given, when, then } = keywordLines(body)
  return {
    id,
    requirementId: match ? (match[1]!.split('.')[0] ?? requirementId) : requirementId,
    title,
    given,
    when,
    then,
    raw: `### ${heading.title}\n${body}`.trim(),
  }
}

/** Parse the incremental spec (ADDED / MODIFIED / REMOVED requirements + scenarios). */
export function parseIncrementalSpec(raw: string): SpecDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<SpecDoc>(
    () => ({ raw: safeRaw, requirements: [], scenarios: [] }),
    () => {
      const headings = scanHeadings(safeRaw)
      const requirements: Requirement[] = []
      let currentChangeType: Requirement['changeType'] = 'ADDED'
      let generated = 0
      for (let i = 0; i < headings.length; i += 1) {
        const heading = headings[i]!
        let reqId = ''
        let reqTitle = ''
        const explicit = REQUIREMENT_HEADING_RE.exec(heading.title)
        if (explicit) {
          reqId = explicit[1]!
          reqTitle = (explicit[2] ?? '').trim()
        } else {
          const plain = REQUIREMENT_PLAIN_RE.exec(heading.title)
          if (plain) {
            reqId = plain[1]!
            reqTitle = (plain[2] ?? '').trim()
          }
        }
        if (reqId === '') {
          const type = changeTypeFromHeading(heading.title)
          if (type && /requirements?|要求|需求|change/i.test(heading.title)) {
            currentChangeType = type
          }
          continue
        }
        generated += 1
        const body = bodyOfSection(safeRaw, headings, i)
        const nested: Heading[] = []
        for (let j = i + 1; j < headings.length; j += 1) {
          if (headings[j]!.level <= heading.level) break
          nested.push(headings[j]!)
        }
        const scenarioIndices: number[] = []
        for (let j = i + 1; j < headings.length; j += 1) {
          if (headings[j]!.level <= heading.level) break
          if (SCENARIO_HEADING_RE.test(headings[j]!.title)) scenarioIndices.push(j)
        }
        const scenarios = scenarioIndices.map((index, order) => parseScenarioBlock(safeRaw, headings, index, reqId, order))
        const scenarioLines = new Set<number>()
        for (const index of scenarioIndices) scenarioLines.add(headings[index]!.line)
        const statement = body
          .split(/\r?\n/)
          .filter((line) => {
            if (line.trim() === '') return false
            if (/^#{1,6}\s+/.test(line)) return false
            const currentLine = safeRaw.split(/\r?\n/).indexOf(line)
            return !scenarioLines.has(currentLine)
          })
          .filter((line) => !/^(?:[-*+]\s*)?(?:GIVEN|WHEN|THEN|给定|当|则)\b/i.test(cleanLine(line)))
          .map((line) => stripEmphasis(cleanLine(line)))
          .filter((line) => line !== '')
          .join(' ')
          .trim()
        requirements.push({
          id: reqId,
          title: reqTitle || reqId,
          text: statement,
          scenarios,
          changeType: currentChangeType,
        })
        void generated
        void nested
      }
      const scenarios = requirements.flatMap((requirement) => requirement.scenarios)
      return { raw: safeRaw, requirements, scenarios }
    },
  )
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Parse `context.md` into named sections with citations. */
export function parseContext(raw: string): ContextDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<ContextDoc>(
    () => ({ raw: safeRaw, sections: [] }),
    () => {
      const sections: ContextSection[] = extractSections(safeRaw)
        .filter((section) => section.level >= 2)
        .map((section) => ({
          title: headingLabel(section.title),
          body: section.body.trim(),
          citations: extractCitationRefs(section.body),
        }))
      return { raw: safeRaw, sections }
    },
  )
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

function parseProsCons(body: string): { pros: string[]; cons: string[] } {
  const pros: string[] = []
  const cons: string[] = []
  let target: string[] | null = null
  for (const rawLine of body.split(/\r?\n/)) {
    const cleaned = cleanLine(stripEmphasis(rawLine))
    if (cleaned === '') continue
    if (/^(?:优点|优势|收益|pros?|benefits?)\s*[:：]?\s*(.*)$/i.test(cleaned)) {
      target = pros
      const rest = cleaned.replace(/^(?:优点|优势|收益|pros?|benefits?)\s*[:：]?\s*/i, '').trim()
      if (rest !== '') pros.push(...splitInlineList(rest))
      continue
    }
    if (/^(?:缺点|劣势|风险|代价|cons?|drawbacks?)\s*[:：]?\s*(.*)$/i.test(cleaned)) {
      target = cons
      const rest = cleaned.replace(/^(?:缺点|劣势|风险|代价|cons?|drawbacks?)\s*[:：]?\s*/i, '').trim()
      if (rest !== '') cons.push(...splitInlineList(rest))
      continue
    }
    if (target) target.push(cleaned)
  }
  return { pros: nonTrivialBullets(pros), cons: nonTrivialBullets(cons) }
}

/** Parse `design.md`: 2–3 options, recommendation, data flow, error handling, rollback. */
export function parseDesign(raw: string): DesignDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<DesignDoc>(
    () => ({ raw: safeRaw, options: [], recommendation: '', dataFlow: '', errorHandling: '', rollback: '' }),
    () => {
      const sections = extractSections(safeRaw)
      const options: DesignOption[] = []

      for (const table of extractTables(safeRaw, { all: true })) {
        const nameCol = table.headers.findIndex((header) => /方案|选项|option/i.test(header))
        if (nameCol < 0) continue
        const summaryCol = table.headers.findIndex((header) => /说明|描述|摘要|summary|做法/i.test(header))
        const prosCol = table.headers.findIndex((header) => /优点|优势|收益|pros?/i.test(header))
        const consCol = table.headers.findIndex((header) => /缺点|劣势|代价|cons?/i.test(header))
        for (const row of table.rows) {
          const name = (row[nameCol] ?? '').trim()
          if (name === '' || /^[-—]+$/.test(name)) continue
          options.push({
            name,
            summary: summaryCol >= 0 ? (row[summaryCol] ?? '').trim() : '',
            pros: prosCol >= 0 ? splitInlineList(row[prosCol] ?? '') : [],
            cons: consCol >= 0 ? splitInlineList(row[consCol] ?? '') : [],
          })
        }
      }

      if (options.length === 0) {
        for (const section of sections) {
          if (section.level < 2) continue
          const title = headingLabel(section.title)
          if (/方案对比|候选方案|方案列表|options?/i.test(title)) {
            for (const bullet of extractBullets(section.body)) {
              const text = bullet.text.trim()
              const match = /^(?:方案\s*)?([A-Za-z0-9一二三四五六七八九十]+|[\u4e00-\u9fa5]{1,8})\s*[:：、]\s*(.+)$/.exec(text)
              if (!match) continue
              if (!/方案|option/i.test(text) && !/方案对比|候选方案/i.test(title)) continue
              const { pros, cons } = parseProsCons(text)
              options.push({ name: match[1]!.trim(), summary: match[2]!.trim(), pros, cons })
            }
            continue
          }
          if (!/方案|option/i.test(title)) continue
          if (/推荐|结论|回滚|对比/i.test(title)) continue
          const { pros, cons } = parseProsCons(section.body)
          options.push({
            name: title,
            summary: firstMeaningfulParagraph(section.body),
            pros,
            cons,
          })
        }
      }

      const recommendation = sectionBodyText(findSectionByAny(sections, [/推荐|recommendation|结论|选定/i]))
      let recommendationText = recommendation
      if (recommendationText === '') {
        const match = /(?:推荐方案|推荐|建议采用)\s*[:：]\s*(.+)/.exec(safeRaw)
        if (match) recommendationText = match[1]!.trim()
      }
      const dataFlow = sectionBodyText(findSectionByAny(sections, [/数据流|数据流转|data flow|流程/i]))
      const errorHandling = sectionBodyText(findSectionByAny(sections, [/错误处理|异常处理|失败处理|error handling/i]))
      const rollback = sectionBodyText(findSectionByAny(sections, [/回滚|回退|rollback/i]))
      const architecture = sectionBodyText(findSectionByAny(sections, [/架构边界|架构|取舍|影响|architecture/i]))
      const doc: DesignDoc = {
        raw: safeRaw,
        options,
        recommendation: recommendationText,
        dataFlow,
        errorHandling,
        rollback,
      }
      if (architecture !== '') doc.architecture = architecture
      return doc
    },
  )
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

const RISK_CATEGORY_MATCHERS: ReadonlyArray<{ category: RiskCategory; re: RegExp }> = [
  { category: 'security', re: /安全|权限|鉴权|security|auth/i },
  { category: 'performance', re: /性能|吞吐|延迟|performance|perf/i },
  { category: 'cost', re: /成本|费用|开销|cost/i },
  { category: 'compliance', re: /合规|隐私|法规|compliance|privacy/i },
  { category: 'maintainability', re: /可维护|维护|技术债|maintainab|maintain/i },
]

function riskCategoryFromText(text: string): RiskCategory | null {
  for (const matcher of RISK_CATEGORY_MATCHERS) {
    if (matcher.re.test(text)) return matcher.category
  }
  return null
}

function parseRiskGrade(text: string): RiskGrade | null {
  if (/^(无|none|n\/a|—|-)$/i.test(text.trim())) return 'none'
  if (/高|high|严重|critical/i.test(text)) return 'high'
  if (/中|medium|moderate/i.test(text)) return 'medium'
  if (/低|low|minor/i.test(text)) return 'low'
  return null
}

function truthyCell(text: string): boolean {
  return /^(是|需要|需|yes|true|y|1|✓|√)/i.test(text.trim())
}

function nonEmptyCell(text: string | undefined, allowDash = false): string {
  const value = (text ?? '').trim()
  if (!allowDash && /^(—|-|\/|n\/a|none)$/i.test(value)) return ''
  return value
}

/** Parse `risk.md` (five categories, grade, reason, mitigation, verification, human flag). */
export function parseRisk(raw: string): RiskDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<RiskDoc>(
    () => ({ raw: safeRaw, entries: [] }),
    () => {
      const entries: RiskEntry[] = []
      for (const table of extractTables(safeRaw, { all: true })) {
        const categoryCol = table.headers.findIndex((header) => /类别|分类|category/i.test(header))
        if (categoryCol < 0) continue
        const gradeCol = table.headers.findIndex((header) => /等级|级别|grade|severity/i.test(header))
        const reasonCol = table.headers.findIndex((header) => /理由|原因|reason/i.test(header))
        const mitigationCol = table.headers.findIndex((header) => /缓解|应对|mitigation/i.test(header))
        const verificationCol = table.headers.findIndex((header) => /验证|verification/i.test(header))
        const humanCol = table.headers.findIndex((header) => /人工|接管|human|needs?/i.test(header))
        for (const row of table.rows) {
          const category = riskCategoryFromText(row[categoryCol] ?? '')
          const grade = gradeCol >= 0 ? parseRiskGrade(row[gradeCol] ?? '') : null
          if (!category || !grade) continue
          entries.push({
            category,
            grade,
            reason: (reasonCol >= 0 ? row[reasonCol] : '')?.trim() ?? '',
            mitigation: (mitigationCol >= 0 ? row[mitigationCol] : '')?.trim() ?? '',
            verification: (verificationCol >= 0 ? row[verificationCol] : '')?.trim() ?? '',
            needsHuman: humanCol >= 0 ? truthyCell(row[humanCol] ?? '') : grade === 'high',
          })
        }
      }
      if (entries.length === 0) {
        for (const section of extractSections(safeRaw)) {
          if (section.level < 2) continue
          const category = riskCategoryFromText(headingLabel(section.title))
          if (!category) continue
          const body = section.body
          const gradeMatch = /(?:等级|级别|风险程度)\s*[:：]\s*([^\n]+)/.exec(body)
          const grade = parseRiskGrade(gradeMatch?.[1] ?? '') ?? 'medium'
          const mitigationMatch = /(?:缓解措施|缓解|应对)\s*[:：]\s*([^\n]+)/.exec(body)
          const verificationMatch = /(?:验证方式|验证)\s*[:：]\s*([^\n]+)/.exec(body)
          entries.push({
            category,
            grade,
            reason: firstMeaningfulParagraph(body),
            mitigation: mitigationMatch?.[1]?.trim() ?? '',
            verification: verificationMatch?.[1]?.trim() ?? '',
            needsHuman: grade === 'high',
          })
        }
      }
      const deduped: RiskEntry[] = []
      const seen = new Set<RiskCategory>()
      for (const entry of entries) {
        if (seen.has(entry.category)) continue
        seen.add(entry.category)
        deduped.push({
          category: entry.category,
          grade: entry.grade,
          reason: nonEmptyCell(entry.reason, true),
          mitigation: nonEmptyCell(entry.mitigation, true),
          verification: nonEmptyCell(entry.verification, true),
          needsHuman: entry.needsHuman,
        })
      }
      return { raw: safeRaw, entries: deduped }
    },
  )
}

// ---------------------------------------------------------------------------
// Tasks + execution plan
// ---------------------------------------------------------------------------

const TASK_HEADING_RE = /^(?:Task|任务)?\s*[:：-]?\s*(T\d+)\s*[:：-]?\s*(.*)$/i

function normalizeTaskId(value: string): string {
  const match = /T\s*0*(\d+)/i.exec(value)
  return match ? `T${Number.parseInt(match[1]!, 10)}` : value.trim()
}

function parsePlannedChanges(value: unknown): PlannedFileChange[] {
  if (!Array.isArray(value)) return []
  const out: PlannedFileChange[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const cleaned = unquote(item.trim())
      if (cleaned === '') continue
      out.push({ path: normalizeRelPath(cleaned), kind: 'delete' })
      continue
    }
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const path = normalizeRelPath(asString(record.path ?? record.file))
      if (path === '') continue
      const kind = asString(record.kind).toLowerCase() === 'rename' ? 'rename' : 'delete'
      const change: PlannedFileChange = { path, kind }
      const to = normalizeRelPath(asString(record.to ?? record.to_path ?? record.target))
      if (kind === 'rename' && to !== '') change.to = to
      out.push(change)
    }
  }
  return out
}

function parseVerifyGroups(value: unknown): VerifyGroup[] {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const out: VerifyGroup[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const group = asString(record.group ?? record.name)
    const command = asString(record.command)
    const inputs = asStringArray(record.inputs ?? record.files ?? record.paths).map((input) => normalizeRelPath(input))
    out.push({ group: group || `verify-${out.length + 1}`, command, inputs })
  }
  return out
}

function stripYamlFence(body: string): string {
  const parsed = findYamlBlock(body)
  if (parsed === null) return body.trim()
  const marker = body.indexOf('```')
  const endMarker = body.indexOf('```', marker + 3)
  if (marker < 0 || endMarker < 0) return body.trim()
  return `${body.slice(0, marker)}${body.slice(endMarker + 3)}`.trim()
}

function parseTaskCard(heading: Heading, body: string, raw: string): TaskCard {
  const match = TASK_HEADING_RE.exec(heading.title)
  const id = match ? normalizeTaskId(match[1]!) : normalizeTaskId(heading.title)
  const title = match ? (match[2] ?? '').trim() : headingLabel(heading.title)
  let yaml: Record<string, unknown> | null = null
  const block = findYamlBlock(body)
  if (block !== null) {
    const parsed = parseYamlLite(block)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yaml = parsed as Record<string, unknown>
  }
  if (!yaml) {
    const parsed = parseYamlLite(stripYamlFence(body))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yaml = parsed as Record<string, unknown>
  }
  const data = yaml ?? {}
  const tddRaw = asString(data.tdd).toLowerCase()
  const runRaw = asString(data.run).toLowerCase()
  const sizeRaw = asString(data.size).toUpperCase()
  const run: TaskCard['run'] = runRaw === 'main' || runRaw === 'subagent' ? runRaw : 'auto'
  const card: TaskCard = {
    id,
    title: title || id,
    covers: asStringArray(data.covers).map((value) => value.trim().toUpperCase()),
    scope: asStringArray(data.scope).map((value) => normalizeRelPath(value)),
    tests: asStringArray(data.tests).map((value) => normalizeRelPath(value)),
    newFiles: asStringArray(data.new_files ?? data.newFiles).map((value) => normalizeRelPath(value)),
    changes: parsePlannedChanges(data.changes),
    dependsOn: asStringArray(data.depends_on ?? data.dependsOn).map(normalizeTaskId),
    tdd: tddRaw === 'required' ? 'required' : 'optional',
    verify: parseVerifyGroups(data.verify).map((group) => ({
      ...group,
      inputs: group.inputs,
    })),
    run,
    risk: asStringArray(data.risk),
    size: sizeRaw === 'S' || sizeRaw === 'L' ? sizeRaw : 'M',
    body: stripYamlFence(body),
  }
  const tddReason = asString(data.tdd_reason ?? data.tddReason)
  if (tddReason !== '') card.tddReason = tddReason
  const runReason = asString(data.run_reason ?? data.runReason)
  if (runReason !== '') card.runReason = runReason
  const choreReason = asString(data.chore_reason ?? data.choreReason)
  if (choreReason !== '') card.choreReason = choreReason
  if (card.tdd === 'optional' && card.choreReason === undefined && /chore/i.test(title)) card.choreReason = title
  void raw
  return card
}

function parseExecutionPlan(raw: string): ExecutionPlan {
  let executionRaw: unknown = null
  for (const block of allYamlBlocks(raw)) {
    if (Object.prototype.hasOwnProperty.call(block, 'execution')) {
      executionRaw = block.execution
    } else if (Array.isArray(block.batches)) {
      executionRaw = block
    }
  }
  if (executionRaw === null) {
    const planSection = extractSections(raw).find((section) => /执行计划|execution plan|batches/i.test(headingLabel(section.title)))
    if (planSection) {
      const parsed = yamlFromBody(planSection.body) ?? (() => {
        const direct = parseYamlLite(planSection.body)
        return direct !== null && typeof direct === 'object' && !Array.isArray(direct)
          ? (direct as Record<string, unknown>)
          : null
      })()
      if (parsed) executionRaw = parsed.execution ?? parsed.batches ?? null
    }
  }
  const list = Array.isArray(executionRaw)
    ? executionRaw
    : executionRaw !== null && typeof executionRaw === 'object' && Array.isArray((executionRaw as Record<string, unknown>).batches)
      ? ((executionRaw as Record<string, unknown>).batches as unknown[])
      : []
  const batches: ExecutionBatch[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = asString(record.batch ?? record.id ?? record.name) || `B${batches.length + 1}`
    const modeRaw = asString(record.mode).toLowerCase()
    const mode: ExecutionBatch['mode'] = modeRaw === 'parallel' || modeRaw === '并行' ? 'parallel' : 'sequential'
    const tasks = asStringArray(record.tasks).map(normalizeTaskId)
    const why = asString(record.why ?? record.reason)
    const batch: ExecutionBatch = { batch: id, mode, tasks, why }
    const downgraded = asString(record.downgraded)
    if (downgraded !== '') batch.downgraded = downgraded
    batches.push(batch)
  }
  return { batches }
}

/** Parse `tasks.md`: task cards (`## T1 ...` + fenced YAML) and the trailing execution plan. */
export function parseTasks(raw: string): TasksDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<TasksDoc>(
    () => ({ raw: safeRaw, tasks: [], execution: { batches: [] } }),
    () => {
      const headings = scanHeadings(safeRaw)
      const tasks: TaskCard[] = []
      for (let i = 0; i < headings.length; i += 1) {
        const heading = headings[i]!
        if (!TASK_HEADING_RE.test(heading.title)) continue
        if (/^(?:任务|task)/i.test(heading.title) && !/T\d+/i.test(heading.title)) continue
        const body = bodyOfSection(safeRaw, headings, i)
        tasks.push(parseTaskCard(heading, body, safeRaw))
      }
      return { raw: safeRaw, tasks, execution: parseExecutionPlan(safeRaw) }
    },
  )
}

// ---------------------------------------------------------------------------
// Project doc
// ---------------------------------------------------------------------------

/**
 * Parse a single task-card markdown fragment.
 *
 * Used by approved plan amendments (`plan.amend_requested` → `add: string[]`):
 * each element is one task-card fragment that must start with a task heading
 * such as `## T9 标题` and carry the usual YAML block. Returns `null` when no
 * task heading can be recognized so callers can raise an actionable error
 * instead of silently dropping a task.
 */
export function parseTaskCardFragment(markdown: string): TaskCard | null {
  const safe = typeof markdown === 'string' ? markdown : String(markdown ?? '')
  if (safe.trim() === '') return null
  const parsed = parseTasks(safe)
  return parsed.tasks[0] ?? null
}

const COMMAND_KEY_MATCHERS: ReadonlyArray<{ key: keyof ProjectDoc['commands']; re: RegExp }> = [
  { key: 'integration', re: /集成|integration|verify/i },
  { key: 'typecheck', re: /类型|typecheck|tsc/i },
  { key: 'test', re: /测试|test/i },
  { key: 'lint', re: /lint|静态检查|代码检查|规范/i },
  { key: 'build', re: /构建|build|编译|打包/i },
  { key: 'run', re: /运行|启动|run|dev|serve/i },
  { key: 'health', re: /健康|health|探活/i },
]

function normalizeCommandKey(label: string): keyof ProjectDoc['commands'] | null {
  const cleaned = headingLabel(label)
  for (const matcher of COMMAND_KEY_MATCHERS) {
    if (matcher.re.test(cleaned)) return matcher.key
  }
  return null
}

function cleanCommandValue(value: string): string | null {
  const cleaned = unquote(value.trim()).replace(/^`+|`+$/g, '').trim()
  if (cleaned === '') return null
  if (/^(none|无|n\/a|待定|待确认|—|-|\/)$/i.test(cleaned)) return 'none'
  return cleaned
}

function parseCommands(raw: string, sections: Section[]): ProjectDoc['commands'] {
  const commands: ProjectDoc['commands'] = {}
  const setCommand = (key: keyof ProjectDoc['commands'] | null, value: string): void => {
    if (!key) return
    const cleaned = cleanCommandValue(value)
    if (cleaned === null) return
    if (cleaned === 'none' && key !== 'test') return
    commands[key] = cleaned
  }
  const section = findSectionByAny(sections, [/命令|commands?/i])
  if (section) {
    for (const table of extractTables(section.body, { all: true })) {
      const nameCol = table.headers.findIndex((header) => /名称|命令|name|command/i.test(header))
      if (nameCol < 0) continue
      const valueCol = table.headers.findIndex((header) => /命令|值|写法|command|value/i.test(header))
      for (const row of table.rows) {
        const key = normalizeCommandKey(row[nameCol] ?? '')
        const value = valueCol >= 1 ? (row[valueCol] ?? '') : nameCol === 0 ? (row[1] ?? '') : ''
        setCommand(key, value)
      }
    }
    for (const bullet of extractBullets(section.body)) {
      const match = /^([^:：`]+)[:：]\s*(.+)$/.exec(bullet.text.trim())
      if (!match) continue
      setCommand(normalizeCommandKey(match[1]!), match[2]!)
    }
  }
  return commands
}

function bulletTableOrList(body: string, headers: readonly RegExp[]): ProjectModuleInfo[] {
  const modules: ProjectModuleInfo[] = []
  for (const table of extractTables(body, { all: true })) {
    const pathCol = table.headers.findIndex((header) => headers[0]!.test(header))
    if (pathCol < 0) continue
    const responsibilityCol = table.headers.findIndex((header) => headers[1]!.test(header))
    for (const row of table.rows) {
      const path = normalizeRelPath((row[pathCol] ?? '').replace(/`/g, '').trim())
      if (path === '') continue
      modules.push({ path, responsibility: responsibilityCol >= 0 ? (row[responsibilityCol] ?? '').trim() : '' })
    }
  }
  if (modules.length > 0) return modules
  for (const bullet of extractBullets(body)) {
    const text = bullet.text.trim()
    const match = /^`?([^`\s—–:：]+)`?\s*(?:[—–:：-]|\s{2,})\s*(.*)$/.exec(text)
    if (!match) continue
    modules.push({ path: normalizeRelPath(match[1]!), responsibility: match[2]!.trim() })
  }
  return modules
}

function factList(texts: string[]): SourceFact[] {
  return nonTrivialBullets(texts)
    .filter((text) => !/^(待补充|待确认填写|todo|tbd)$/i.test(text.trim()))
    .map(sourceFactFromBullet)
}

/** Parse project-level `project.md` (stack / modules / commands / conventions / read files). */
export function parseProjectDoc(raw: string): ProjectDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<ProjectDoc>(
    () => ({
      raw: safeRaw,
      name: '',
      stack: [],
      modules: [],
      commands: {},
      conventions: [],
      forbidden: [],
      reusable: [],
      readFiles: [],
      claims: [],
    }),
    () => {
      const sections = extractSections(safeRaw)
      const titleSection = sections.find((section) => section.level === 1)
      let name = titleSection ? headingLabel(titleSection.title) : ''
      name = name.replace(/^(?:项目上下文|项目上下文包|项目|project)\s*[:：]?\s*/i, '').trim()
      if (name === '') {
        const match = /^#\s+(.+)$/m.exec(safeRaw)
        name = match ? headingLabel(match[1]!) : ''
      }

      const stackSection = findSectionByAny(sections, [/技术栈|技术栈与版本|stack/i])
      const stack = factList(bulletsOfSection(stackSection))

      const modulesSection = findSectionByAny(sections, [/目录与模块|模块职责|模块|modules?/i])
      const modules = bulletTableOrList(modulesSection?.body ?? '', [/路径|目录|模块|path|module/i, /职责|说明|responsibility/i])

      const commands = parseCommands(safeRaw, sections)

      const conventions = nonTrivialBullets(bulletsOfSection(findSectionByAny(sections, [/编码约定|约定|规范|conventions?/i])))
      const forbidden = nonTrivialBullets(bulletsOfSection(findSectionByAny(sections, [/禁区|禁止|forbidden|不能做/i])))
      const reusable = nonTrivialBullets(
        bulletsOfSection(findSectionByAny(sections, [/可复用|复用|reusable/i])),
      )

      const readSection = findSectionByAny(sections, [/读取记录|已读文件|实际读取|read files|files read/i])
      const readFiles: string[] = []
      for (const text of bulletsOfSection(readSection)) {
        if (/^(无|none|—|-)$/i.test(text.trim())) continue
        const codeMatch = /`([^`]+)`/.exec(text)
        const candidate = codeMatch ? codeMatch[1]! : text.split(/\s*(?:[—–:：]|\s{2,})\s*/)[0] ?? ''
        const cleaned = normalizeRelPath(candidate.replace(/`/g, '').trim())
        if (cleaned === '') continue
        if (!cleaned.includes('/') && !cleaned.includes('.') && !/^(pom\.xml|go\.mod|Cargo\.toml|package\.json|mvnw|gradlew)$/.test(cleaned)) {
          continue
        }
        if (!readFiles.includes(cleaned)) readFiles.push(cleaned)
      }

      const claims = factList(
        bulletsOfSection(findSectionByAny(sections, [/描述与结论|结论|claims?|事实|已知事实/i])),
      )

      const doc: ProjectDoc = {
        raw: safeRaw,
        name,
        stack,
        modules,
        commands,
        conventions,
        forbidden,
        reusable,
        readFiles,
        claims,
      }
      return doc
    },
  )
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

function parseMvpCut(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const match = /MVP\s*切线\s*[:：]\s*(.+)$/i.exec(line)
    if (match) return stripEmphasis(match[1]!.trim())
  }
  const section = findSectionByAny(extractSections(raw), [/MVP\s*切线|MVP cut/i])
  if (section) {
    const paragraph = firstMeaningfulParagraph(section.body)
    if (paragraph !== '') return paragraph
  }
  return ''
}

function parseMvpCell(text: string): boolean {
  const value = text.trim()
  if (/否|×|✗|false|no|切线外|不在/i.test(value)) return false
  return true
}

/** Parse `roadmap.md` (MVP cut line + capability table). */
export function parseRoadmap(raw: string): RoadmapDoc {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '')
  return safe<RoadmapDoc>(
    () => ({ raw: safeRaw, title: '', mvpCut: '', entries: [] }),
    () => {
      const firstHeading = /^#\s+(.+)$/m.exec(safeRaw)
      const title = firstHeading ? headingLabel(firstHeading[1]!).replace(/^路线图\s*[:：]\s*/, '').trim() : ''
      const mvpCut = parseMvpCut(safeRaw)
      const entries: RoadmapEntry[] = []
      for (const table of extractTables(safeRaw, { all: true })) {
        const changeCol = table.headers.findIndex((header) => /^变更$|变更|编号|change|id/i.test(header))
        if (changeCol < 0) continue
        const capabilityCol = table.headers.findIndex((header) => /能力|capabilit/i.test(header))
        const goalCol = table.headers.findIndex((header) => /目标|goal/i.test(header))
        const acceptanceCol = table.headers.findIndex((header) => /验收|accept/i.test(header))
        const dependsCol = table.headers.findIndex((header) => /依赖|depends/i.test(header))
        const estimatedCol = table.headers.findIndex((header) => /预计.*任务|任务数|tasks?/i.test(header))
        const mvpCol = table.headers.findIndex((header) => /mvp|切线/i.test(header))
        const statusCol = table.headers.findIndex((header) => /状态|status/i.test(header))
        for (const row of table.rows) {
          const change = (row[changeCol] ?? '').replace(/`/g, '').trim()
          if (change === '' || /^[-—]+$/.test(change)) continue
          const dependsRaw = dependsCol >= 0 ? (row[dependsCol] ?? '') : ''
          const dependsOn = dependsRaw
            .split(/[、,，;；\s]+/)
            .map((value) => value.trim())
            .filter((value) => value !== '' && !/^(—|-|无|none|n\/a)$/i.test(value))
          const estimatedRaw = estimatedCol >= 0 ? (row[estimatedCol] ?? '') : ''
          const estimatedMatch = /\d+/.exec(estimatedRaw)
          entries.push({
            change,
            capability: capabilityCol >= 0 ? (row[capabilityCol] ?? '').trim() : '',
            goal: goalCol >= 0 ? (row[goalCol] ?? '').trim() : '',
            acceptance: acceptanceCol >= 0 ? (row[acceptanceCol] ?? '').trim() : '',
            dependsOn,
            estimatedTasks: estimatedMatch ? Number.parseInt(estimatedMatch[0], 10) : null,
            mvp: mvpCol >= 0 ? parseMvpCell(row[mvpCol] ?? '') : true,
            status: statusCol >= 0 && (row[statusCol] ?? '').trim() !== '' ? (row[statusCol] ?? '').trim() : '未开始',
          })
        }
      }
      if (entries.length === 0) {
        const section = findSectionByAny(extractSections(safeRaw), [/变更|能力|changes?|capabilit/i])
        for (const bullet of section ? extractBullets(section.body) : []) {
          const text = bullet.text.trim()
          const match = /^(C\d+)\s*[:：、\s-]\s*(.+)$/i.exec(text)
          if (!match) continue
          entries.push({
            change: match[1]!.toUpperCase(),
            capability: match[2]!.trim(),
            goal: '',
            acceptance: '',
            dependsOn: [],
            estimatedTasks: null,
            mvp: true,
            status: '未开始',
          })
        }
      }
      return { raw: safeRaw, title, mvpCut, entries }
    },
  )
}

// ---------------------------------------------------------------------------
// Traceability matrix
// ---------------------------------------------------------------------------

function taskCoversScenario(covers: readonly string[], scenario: Scenario): boolean {
  const scenarioId = scenario.id.toUpperCase()
  const requirementId = scenario.requirementId.toUpperCase()
  return covers.some((cover) => {
    const normalized = cover.trim().toUpperCase()
    return normalized === scenarioId || (requirementId !== '' && normalized === requirementId)
  })
}

/** Build the requirement → scenario → task → evidence matrix. */
export function traceabilityMatrix(spec: SpecDoc, tasks: TaskCard[], evidence: EvidenceReceipt[]): TraceMatrix {
  const rows: TraceMatrix['rows'] = []
  try {
    for (const scenario of spec.scenarios) {
      const taskIds = tasks.filter((task) => taskCoversScenario(task.covers, scenario)).map((task) => task.id)
      const evidenceIds = evidence
        .filter((receipt) => receipt.taskId !== undefined && taskIds.includes(receipt.taskId))
        .map((receipt) => receipt.id)
      rows.push({
        requirementId: scenario.requirementId,
        scenarioId: scenario.id,
        taskIds,
        evidenceIds,
        covered: taskIds.length > 0,
      })
    }
  } catch {
    return { rows, uncoveredScenarios: [] }
  }
  return {
    rows,
    uncoveredScenarios: rows.filter((row) => !row.covered).map((row) => row.scenarioId),
  }
}

/** All known scenario ids, used to detect `covers` entries that point nowhere. */
export function knownScenarioIds(spec: SpecDoc): Set<string> {
  return new Set(spec.scenarios.map((scenario) => scenario.id.toUpperCase()))
}

export type { Section }
