/**
 * Shell tokenizer / parser (03 §4.4).
 *
 * The goal is *avoiding false positives*: only command positions are matched.
 * Quoted strings, `node -e` / `python -c` script bodies and heredoc bodies are
 * not treated as commands; command substitutions and subshells are surfaced as
 * their own segments so `echo $(rm -rf /)` cannot hide a dangerous command.
 *
 * The parser is intentionally small and side-effect free: it never executes
 * anything, it only splits a command line into segments.
 */

export interface ParsedCommand {
  name: string
  args: string[]
  raw: string
  /** Output redirection targets (`>`, `>>`, `&>`...), quotes stripped. */
  redirects: string[]
  background: boolean
}

export type SegmentSeparator =
  | 'start'
  | '&&'
  | '||'
  | ';'
  | '|'
  | '&'
  | 'newline'
  | 'subshell'
  | 'backtick'

export interface CommandSegment extends ParsedCommand {
  /** Operator that preceded this segment (used for pipeline checks). */
  separator: SegmentSeparator
}

// ---------------------------------------------------------------------------
// Heredoc stripping (line oriented)
// ---------------------------------------------------------------------------

interface HeredocMarker {
  word: string
  stripTabs: boolean
}

/** Find unquoted heredoc markers (`<<EOF`, `<<-'EOF'`) on a single line. */
function findHeredocMarkers(line: string): HeredocMarker[] {
  const markers: HeredocMarker[] = []
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < line.length) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (line.startsWith('<<', i)) {
      if (line[i + 2] === '<') {
        // here-string `<<<`, not a heredoc
        i += 3
        continue
      }
      let j = i + 2
      let stripTabs = false
      if (line[j] === '-') {
        stripTabs = true
        j += 1
      }
      while (line[j] === ' ' || line[j] === '\t') j += 1
      let word = ''
      const startQuote = line[j]
      if (startQuote === '"' || startQuote === "'") {
        j += 1
        while (j < line.length && line[j] !== startQuote) {
          word += line[j]
          j += 1
        }
        j += 1
      } else {
        while (j < line.length && /[A-Za-z0-9_\\-]/.test(line[j]!)) {
          if (line[j] === '\\') j += 1
          word += line[j] ?? ''
          j += 1
        }
      }
      if (word !== '') markers.push({ word, stripTabs })
      i = j
      continue
    }
    i += 1
  }
  return markers
}

/**
 * Remove heredoc bodies and the `<<WORD` / `<<<` operators from a command line.
 * Bodies never take part in command matching; here-string content becomes a plain
 * argument so it cannot be mistaken for a command position.
 */
function stripHeredocs(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const markers = findHeredocMarkers(line)
    let cleaned = line
    if (markers.length > 0) {
      cleaned = removeHeredocOperators(line)
    }
    cleaned = cleaned.replace(/<<<\s*/g, '')
    kept.push(cleaned)
    i += 1
    for (const marker of markers) {
      while (i < lines.length) {
        const candidate = lines[i]!
        const compared = marker.stripTabs ? candidate.replace(/^\t+/, '') : candidate
        i += 1
        if (compared.trim() === marker.word) break
      }
    }
  }
  return kept.join('\n')
}

function removeHeredocOperators(line: string): string {
  let out = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < line.length) {
    const ch = line[i]!
    if (quote) {
      out += ch
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        out += line[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (line.startsWith('<<', i) && line[i + 2] !== '<') {
      let j = i + 2
      if (line[j] === '-') j += 1
      while (line[j] === ' ' || line[j] === '\t') j += 1
      const startQuote = line[j]
      if (startQuote === '"' || startQuote === "'") {
        j += 1
        while (j < line.length && line[j] !== startQuote) j += 1
        j += 1
      } else {
        while (j < line.length && /[A-Za-z0-9_\\-]/.test(line[j]!)) {
          if (line[j] === '\\') j += 1
          j += 1
        }
      }
      i = j
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Word scanning with quote handling
// ---------------------------------------------------------------------------

interface WordResult {
  text: string
  end: number
  /** Command substitutions found inside the word, already recursively parsed. */
  subs: CommandSegment[]
}

function readSingleQuoted(text: string, start: number): WordResult {
  let i = start + 1
  let out = ''
  while (i < text.length && text[i] !== "'") {
    out += text[i]!
    i += 1
  }
  return { text: out, end: i < text.length ? i + 1 : i, subs: [] }
}

function readDoubleQuoted(text: string, start: number): WordResult {
  let i = start + 1
  let out = ''
  const subs: CommandSegment[] = []
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]!
      if (next === '\n') {
        i += 2
        continue
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        out += next
        i += 2
        continue
      }
      out += ch
      i += 1
      continue
    }
    if (ch === '"') {
      return { text: out, end: i + 1, subs }
    }
    if (ch === '$' && text[i + 1] === '(') {
      const substitution = readSubstitution(text, i)
      subs.push(...substitution.segments)
      i = substitution.end
      continue
    }
    if (ch === '`') {
      const substitution = readBackticks(text, i)
      subs.push(...substitution.segments)
      i = substitution.end
      continue
    }
    out += ch
    i += 1
  }
  return { text: out, end: i, subs }
}

interface SubstitutionResult {
  segments: CommandSegment[]
  end: number
}

function readSubstitution(text: string, start: number): SubstitutionResult {
  // start points at `$`; `(` is at start+1
  let i = start + 2
  let depth = 1
  let quote: '"' | "'" | null = null
  const bodyStart = i
  while (i < text.length) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        const inner = text.slice(bodyStart, i)
        return { segments: prependSeparator(scanSegments(stripHeredocs(inner)), 'subshell'), end: i + 1 }
      }
    }
    i += 1
  }
  const inner = text.slice(bodyStart)
  return { segments: prependSeparator(scanSegments(stripHeredocs(inner)), 'subshell'), end: text.length }
}

function readBackticks(text: string, start: number): SubstitutionResult {
  let i = start + 1
  const bodyStart = i
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      const inner = text.slice(bodyStart, i)
      return { segments: prependSeparator(scanSegments(stripHeredocs(inner)), 'backtick'), end: i + 1 }
    }
    i += 1
  }
  const inner = text.slice(bodyStart)
  return { segments: prependSeparator(scanSegments(stripHeredocs(inner)), 'backtick'), end: text.length }
}

function prependSeparator(segments: CommandSegment[], separator: SegmentSeparator): CommandSegment[] {
  if (segments.length === 0) return segments
  const first = segments[0]!
  return [{ ...first, separator }, ...segments.slice(1)]
}

// ---------------------------------------------------------------------------
// Command segment scanner
// ---------------------------------------------------------------------------

type RedirectKind = 'out' | 'in' | 'none'

/** Scan an operator-free-ish cleaned command line into segments with separators. */
function scanSegments(text: string): CommandSegment[] {
  const segments: CommandSegment[] = []
  let i = 0
  let current = ''
  let hasCurrent = false
  let tokens: string[] = []
  let redirects: string[] = []
  let pendingRedirect: RedirectKind = 'none'
  let background = false
  let separator: SegmentSeparator = 'start'
  let rawStart = 0
  let segmentEnd = 0

  const flushWord = (): void => {
    if (!hasCurrent) return
    const word = current
    current = ''
    hasCurrent = false
    if (pendingRedirect !== 'none') {
      if (pendingRedirect === 'out') redirects.push(word)
      pendingRedirect = 'none'
      return
    }
    tokens.push(word)
  }

  const flushSegment = (nextSeparator: SegmentSeparator, endIndex: number): void => {
    flushWord()
    const raw = text.slice(rawStart, endIndex).trim()
    if (tokens.length > 0 || redirects.length > 0) {
      segments.push({
        name: tokens[0] ?? '',
        args: tokens.slice(1),
        raw,
        redirects,
        background,
        separator,
      })
    } else if (pendingRedirect !== 'none') {
      pendingRedirect = 'none'
    }
    tokens = []
    redirects = []
    background = false
    pendingRedirect = 'none'
    separator = nextSeparator
  }

  while (i < text.length) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t') {
      flushWord()
      i += 1
      continue
    }
    if (ch === '\n') {
      flushSegment('newline', i)
      i += 1
      rawStart = i
      segmentEnd = i
      continue
    }
    if (ch === ';') {
      flushSegment(';', i)
      i += 1
      rawStart = i
      continue
    }
    if (ch === '&') {
      if (text[i + 1] === '&') {
        flushSegment('&&', i)
        i += 2
        rawStart = i
        continue
      }
      background = true
      flushSegment('&', i)
      i += 1
      rawStart = i
      continue
    }
    if (ch === '|') {
      if (text[i + 1] === '|') {
        flushSegment('||', i)
        i += 2
        rawStart = i
        continue
      }
      flushSegment('|', i)
      i += 1
      rawStart = i
      continue
    }
    if (ch === '>' || ch === '<') {
      if (hasCurrent && /^\d+$/.test(current)) {
        // file-descriptor prefix such as `2>` — not part of the command name
        current = ''
        hasCurrent = false
      }
      flushWord()
      let kind: RedirectKind = ch === '>' ? 'out' : 'in'
      i += 1
      if (text[i] === ch) {
        i += 1
      }
      if (text[i] === '&') {
        i += 1
        // fd duplication (`2>&1`, `>&2`): consume the fd and do not treat it as a path
        while (i < text.length && /[0-9-]/.test(text[i]!)) i += 1
        continue
      }
      pendingRedirect = kind
      continue
    }
    if (ch === '(') {
      flushSegment('subshell', i)
      const closing = findClosingParen(text, i)
      const inner = text.slice(i + 1, closing.end)
      segments.push(...prependSeparator(scanSegments(inner), 'subshell'))
      i = closing.end
      rawStart = i
      continue
    }
    if (ch === ')') {
      flushSegment('subshell', i)
      i += 1
      rawStart = i
      continue
    }
    if (ch === '`') {
      const substitution = readBackticks(text, i)
      segments.push(...substitution.segments)
      i = substitution.end
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const substitution = readSubstitution(text, i)
      segments.push(...substitution.segments)
      i = substitution.end
      continue
    }
    if (ch === '\\') {
      if (i + 1 < text.length) {
        current += text[i + 1]
        hasCurrent = true
        i += 2
      } else {
        i += 1
      }
      continue
    }
    if (ch === "'") {
      const quoted = readSingleQuoted(text, i)
      current += quoted.text
      hasCurrent = true
      i = quoted.end
      continue
    }
    if (ch === '"') {
      const quoted = readDoubleQuoted(text, i)
      if (quoted.text !== '') {
        current += quoted.text
        hasCurrent = true
      }
      segments.push(...quoted.subs)
      i = quoted.end
      continue
    }
    if (ch === '#' && !hasCurrent) {
      while (i < text.length && text[i] !== '\n') i += 1
      segmentEnd = i
      continue
    }
    current += ch
    hasCurrent = true
    i += 1
  }
  segmentEnd = text.length
  flushSegment('newline', segmentEnd)
  return segments
}

function findClosingParen(text: string, start: number): { end: number } {
  let i = start + 1
  let depth = 1
  let quote: '"' | "'" | null = null
  while (i < text.length) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) return { end: i + 1 }
    }
    i += 1
  }
  return { end: text.length }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a command line into segments with operators, quote-aware. */
export function parseCommandLine(command: string): CommandSegment[] {
  return scanSegments(stripHeredocs(command))
}

/** Split a command line into simple commands (`&&`, `||`, `;`, `|`, subshells, newlines). */
export function parseCommands(command: string): ParsedCommand[] {
  return parseCommandLine(command).map((segment) => ({
    name: segment.name,
    args: segment.args,
    raw: segment.raw,
    redirects: segment.redirects,
    background: segment.background,
  }))
}

/** Tokenize a command line into words (quotes removed, escapes resolved, operators split). */
export function tokenizeShell(command: string): string[] {
  const tokens: string[] = []
  for (const segment of parseCommandLine(command)) {
    if (segment.name !== '') tokens.push(segment.name)
    tokens.push(...segment.args)
    tokens.push(...segment.redirects)
  }
  return tokens
}

/** Names of every simple command in the line (including command substitutions). */
export function commandNames(command: string): string[] {
  return parseCommands(command)
    .map((parsed) => parsed.name)
    .filter((name) => name !== '')
}

/** First command name, used for "readonly shell command" classification. */
export function firstCommandName(command: string): string | null {
  const names = commandNames(command)
  return names[0] ?? null
}
