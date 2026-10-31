/**
 * Test-output parsers (evidence layer).
 *
 * `parseTestOutput` prefers machine-readable report files (JUnit XML,
 * Jest/Vitest JSON, `go test -json`) and only falls back to console parsing
 * when no report file could be found. Parsers never throw: malformed output
 * yields `{ parsed: false }` so the caller can treat the evidence as
 * unparsed (auxiliary GREEN only, never RED — see `evidencePhase`).
 *
 * All parsing is pure and dependency free so the module stays unit-testable
 * against fixture files.
 */
import type { EvidenceKind, EvidencePhase, TestFailure, TestSummary } from '../types'

export interface ParseInput {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  /** Machine-readable report files discovered after the command finished. */
  reportFiles?: { path: string; content: string }[]
  now?: string
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emptySummary(parser: string): TestSummary {
  return { parser, parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 }
}

function normalizeName(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function failureOf(name: string, file?: string, line?: number, message?: string): TestFailure {
  const failure: TestFailure = { name: name || '未知用例' }
  if (file) failure.file = file
  if (line !== undefined && Number.isFinite(line)) failure.line = line
  if (message) failure.message = message
  return failure
}

function unescapeXml(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  const match = re.exec(tag)
  if (!match) return undefined
  return unescapeXml(match[1] ?? match[2] ?? '')
}

function stripTags(text: string): string {
  return unescapeXml(text.replace(/<[^>]*>/g, ' '))
}

/** First meaningful line from a failure body (usually the assertion message). */
function firstMeaningful(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim()
    if (line === '') continue
    if (/^(?:at\s|\.\.\.\s*\d+\s+more|Stacktrace|Caused by:)/i.test(line)) continue
    return line
  }
  return ''
}

const SOURCE_LOCATION_RE = /([\w./$@\\-]+\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|cs|cpp|cc|c|h))(?::(\d+))?/

function locationFromText(text: string): { file?: string; line?: number } {
  const match = SOURCE_LOCATION_RE.exec(text)
  if (!match) return {}
  const file = match[1]
  const line = match[2] === undefined ? undefined : Number.parseInt(match[2], 10)
  const out: { file?: string; line?: number } = {}
  if (file) out.file = file
  if (line !== undefined && Number.isFinite(line)) out.line = line
  return out
}

function sumCounts(summaries: TestSummary[]): TestSummary {
  let run = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  let durationMs = 0
  const failures: TestFailure[] = []
  const parsers: string[] = []
  for (const summary of summaries) {
    run += summary.run
    passed += summary.passed
    failed += summary.failed
    skipped += summary.skipped
    if (summary.durationMs !== undefined) durationMs += summary.durationMs
    if (summary.failures) failures.push(...summary.failures)
    if (!parsers.includes(summary.parser)) parsers.push(summary.parser)
  }
  const merged: TestSummary = {
    parser: parsers.join('+') || 'unknown',
    parsed: summaries.some((summary) => summary.parsed),
    run,
    passed,
    failed,
    skipped,
  }
  if (failures.length > 0) merged.failures = failures
  if (durationMs > 0) merged.durationMs = durationMs
  return merged
}

// ---------------------------------------------------------------------------
// JUnit XML (Maven Surefire / Failsafe, Gradle test-results, pytest junitxml)
// ---------------------------------------------------------------------------

export function parseJUnitXml(xml: string): TestSummary {
  const parser = 'junit-xml'
  const failures: TestFailure[] = []
  let run = 0
  let failed = 0
  let skipped = 0
  let durationSeconds = 0

  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  let match: RegExpExecArray | null
  while ((match = caseRe.exec(xml)) !== null) {
    run += 1
    const attrs = match[1] ?? ''
    const body = match[2] ?? ''
    const name = normalizeName(attr(attrs, 'name'))
    const className = normalizeName(attr(attrs, 'classname') ?? attr(attrs, 'className'))
    const fileAttr = attr(attrs, 'file')
    const time = Number.parseFloat(attr(attrs, 'time') ?? '')
    if (Number.isFinite(time)) durationSeconds += time
    if (/<skipped\b/.test(body)) {
      skipped += 1
      continue
    }
    const failureMatch =
      /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(body) ?? /<(failure|error)\b([^>]*)\/>/.exec(body)
    if (!failureMatch) continue
    failed += 1
    const messageAttr = attr(failureMatch[2] ?? '', 'message') ?? ''
    const bodyText = stripTags(failureMatch[3] ?? '')
    const message = normalizeName(messageAttr) || firstMeaningful(bodyText)
    const location = locationFromText(`${messageAttr}\n${bodyText}`)
    const fullName = className ? `${className}.${name}` : name
    const failure = failureOf(fullName, fileAttr ?? location.file, location.line, message)
    failures.push(failure)
  }

  if (run === 0) {
    // No <testcase> elements (some toolchains only emit aggregate suite attrs).
    const suiteRe = /<testsuite\b([^>]*)>/g
    let suites = 0
    while ((match = suiteRe.exec(xml)) !== null) {
      const attrs = match[1] ?? ''
      const tests = Number.parseInt(attr(attrs, 'tests') ?? '', 10)
      if (!Number.isFinite(tests)) continue
      suites += 1
      run += tests
      failed += Number.parseInt(attr(attrs, 'failures') ?? '0', 10) || 0
      failed += Number.parseInt(attr(attrs, 'errors') ?? '0', 10) || 0
      skipped += Number.parseInt(attr(attrs, 'skipped') ?? '0', 10) || 0
      const time = Number.parseFloat(attr(attrs, 'time') ?? '')
      if (Number.isFinite(time)) durationSeconds += time
    }
    if (suites === 0) return emptySummary(parser)
  }

  const passed = Math.max(0, run - failed - skipped)
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  if (durationSeconds > 0) summary.durationMs = Math.round(durationSeconds * 1000)
  return summary
}

// ---------------------------------------------------------------------------
// Maven console
// ---------------------------------------------------------------------------

export function parseMavenConsole(output: string): TestSummary {
  const parser = 'maven-console'
  const matches = [...output.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g)]
  if (matches.length === 0) return emptySummary(parser)
  const last = matches[matches.length - 1]
  if (!last) return emptySummary(parser)
  const run = Number.parseInt(last[1] ?? '0', 10)
  const failuresCount = Number.parseInt(last[2] ?? '0', 10)
  const errors = Number.parseInt(last[3] ?? '0', 10)
  const skipped = Number.parseInt(last[4] ?? '0', 10)
  const failed = failuresCount + errors
  const failures: TestFailure[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\[ERROR\]\s{2,}([\w.$]+)\.([\w$]+)(?::(\d+))?\s*(.*)$/.exec(rawLine)
    if (!match) continue
    const className = match[1] ?? ''
    const method = match[2] ?? ''
    const line = match[3] === undefined ? undefined : Number.parseInt(match[3], 10)
    const message = normalizeName(match[4])
    const name = `${className}.${method}`
    if (seen.has(name)) continue
    seen.add(name)
    failures.push(failureOf(name, className.replace(/\./g, '/') + '.java', line, message))
  }
  const summary: TestSummary = {
    parser,
    parsed: true,
    run,
    passed: Math.max(0, run - failed - skipped),
    failed,
    skipped,
  }
  if (failures.length > 0) summary.failures = failures.slice(0, Math.max(failed, failures.length))
  return summary
}

// ---------------------------------------------------------------------------
// Gradle console
// ---------------------------------------------------------------------------

export function parseGradleConsole(output: string): TestSummary {
  const parser = 'gradle-console'
  const summaryMatch =
    /(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/.exec(output) ??
    /(\d+)\s+tests?\s+completed/.exec(output)
  if (!summaryMatch) return emptySummary(parser)
  const run = Number.parseInt(summaryMatch[1] ?? '0', 10)
  const failed = Number.parseInt(summaryMatch[2] ?? '0', 10)
  const skipped = Number.parseInt(summaryMatch[3] ?? '0', 10)
  const failures: TestFailure[] = []
  const seen = new Set<string>()
  const failureRe = /^([\w.$]+)\s+>\s+(.+?)\s+FAILED$/gm
  for (const match of output.matchAll(failureRe)) {
    const className = match[1] ?? ''
    const method = (match[2] ?? '').replace(/\s*\(\)\s*$/, '').trim()
    const name = method.includes('.') ? method : `${className}.${method}`
    if (seen.has(name)) continue
    seen.add(name)
    failures.push(failureOf(name, className.replace(/\./g, '/') + '.java'))
  }
  if (failures.length < failed) {
    const fallbackRe = /^([\w.$]+)\s+FAILED$/gm
    for (const match of output.matchAll(fallbackRe)) {
      const name = match[1] ?? ''
      if (seen.has(name)) continue
      seen.add(name)
      failures.push(failureOf(name))
    }
  }
  const summary: TestSummary = {
    parser,
    parsed: true,
    run,
    passed: Math.max(0, run - failed - skipped),
    failed,
    skipped,
  }
  if (failures.length > 0) summary.failures = failures
  return summary
}

// ---------------------------------------------------------------------------
// pytest console
// ---------------------------------------------------------------------------

export function parsePytestConsole(output: string): TestSummary {
  const parser = 'pytest-console'
  const finalLine = /^=+\s+(.+?)\s+in\s+[\d.]+s\s+=+$/m.exec(output)
  const noTests = /(?:no tests ran|collected 0 items)/.test(output)
  if (!finalLine && !noTests) return emptySummary(parser)

  let passed = 0
  let failed = 0
  let skipped = 0
  let run = 0
  if (finalLine) {
    const counts: Record<string, number> = {}
    for (const match of finalLine[1]!.matchAll(/(\d+)\s+(passed|failed|skipped|errors?|xfailed|xpassed|deselected|warnings?)/g)) {
      const key = (match[2] ?? '').replace(/s$/, '')
      counts[key] = (counts[key] ?? 0) + Number.parseInt(match[1] ?? '0', 10)
    }
    passed = counts.passed ?? 0
    failed = (counts.failed ?? 0) + (counts.error ?? 0)
    skipped = (counts.skipped ?? 0) + (counts.xfailed ?? 0)
    run = passed + failed + skipped
    if (run === 0 && /no tests ran/.test(finalLine[1]!)) run = 0
  }

  const failures: TestFailure[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.+))?$/.exec(rawLine.trim())
    if (!match) continue
    const name = match[2] ?? ''
    if (seen.has(name)) continue
    seen.add(name)
    const location = locationFromText(name)
    failures.push(failureOf(name, location.file, location.line, normalizeName(match[3])))
  }
  if (failures.length < failed) {
    // pytest prints `_____ test_name _____` section headers for each failure.
    for (const match of output.matchAll(/^_{3,}\s+(.+?)\s+_{3,}$/gm)) {
      const name = normalizeName(match[1])
      if (name === '' || seen.has(name)) continue
      seen.add(name)
      failures.push(failureOf(name))
    }
  }

  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  return summary
}

// ---------------------------------------------------------------------------
// Python unittest console (default output goes to stderr)
// ---------------------------------------------------------------------------

/**
 * `Ran 3 tests in 0.002s` — plural is conditional (`Ran 1 test in 0.000s`).
 * Python 3.13 prints `NO TESTS RAN` instead of `OK` when nothing ran.
 */
const UNITTEST_RAN_RE = /^Ran\s+(\d+)\s+tests?\s+in\s+([\d.]+)s\s*$/

/**
 * Failure sections start with `FAIL: name (module.Class.test)` or the same
 * shape with `ERROR:`. `subTest` failures append a parameter group, e.g.
 * `FAIL: test_each (test_sub.SubTests.test_each) (i=1)`.
 */
const UNITTEST_FAILURE_RE = /^(FAIL|ERROR):\s+(.+?)\s*$/
const UNITTEST_DESCRIPTION_RE = /^(.+?)\s+\(([^()]+)\)(\s+\(.*\))?$/

/** `-v` prints one `<description> ... <status>` line per executed test. */
const UNITTEST_VERBOSE_RE =
  /^(.+?) \(([^()]+)\)(?: \(.*\))? \.\.\. (ok|FAIL|ERROR|skipped(?: '.*')?|expected failure|unexpected success)$/

interface UnittestOutcome {
  failures: number
  errors: number
  skipped: number
}

/**
 * Parse the parenthesised detail of the result line, e.g.
 * `skipped=2, expected failures=1` / `failures=1, errors=2`.
 */
function parseUnittestResultCounts(detail: string | undefined): UnittestOutcome | null {
  const counts: UnittestOutcome = { failures: 0, errors: 0, skipped: 0 }
  if (detail === undefined || detail.trim() === '') return counts
  let recognized = 0
  for (const match of detail.matchAll(/(failures|errors|skipped|expected failures|unexpected successes)\s*=\s*(\d+)/g)) {
    const value = Number.parseInt(match[2] ?? '', 10)
    if (!Number.isFinite(value)) continue
    recognized += 1
    const name = match[1]
    if (name === 'failures') counts.failures = value
    else if (name === 'errors') counts.errors = value
    else if (name === 'skipped') counts.skipped = value
    // `expected failures` / `unexpected successes` are valid result tokens but
    // are never counted as failed: FR-5.2 uses failed = failures + errors.
  }
  // An `OK`/`FAILED` line we cannot interpret is not a result: keep looking.
  return recognized > 0 ? counts : null
}

function parseUnittestOutcome(line: string): UnittestOutcome | null {
  const trimmed = line.trim()
  if (trimmed === 'NO TESTS RAN') return { failures: 0, errors: 0, skipped: 0 }
  const okMatch = /^OK(?:\s+\((.+)\))?$/.exec(trimmed)
  if (okMatch) return parseUnittestResultCounts(okMatch[1])
  const failedMatch = /^FAILED\s+\((.+)\)$/.exec(trimmed)
  if (failedMatch) return parseUnittestResultCounts(failedMatch[1])
  return null
}

/** Canonical test id from `name (module.Class.test_name)`, keeping subtest params. */
function unittestFailureName(description: string): string {
  const match = UNITTEST_DESCRIPTION_RE.exec(description.trim())
  if (!match) return normalizeName(description)
  const label = normalizeName(match[1])
  const testId = normalizeName(match[2])
  const suffix = normalizeName(match[3])
  const name = testId !== '' ? testId : label
  return suffix === '' ? name : `${name} ${suffix}`
}

const PYTHON_FRAME_RE = /File\s+"([^"]+)",\s*line\s+(\d+)/g

/**
 * Python tracebacks print `File "path", line N` instead of `path:N`.
 * Prefer the first non-library frame (the test/app frame closest to the
 * failing assertion); fall back to `locationFromText` for non-Python stacks.
 */
function pointerFromPythonTraceback(text: string): { file?: string; line?: number } {
  const frames = [...text.matchAll(PYTHON_FRAME_RE)]
  if (frames.length > 0) {
    const isLibraryFrame = (file: string): boolean =>
      /(?:^|\/)lib(?:64)?\/python[\d.]+\//.test(file) || /(?:^|\/)(?:unittest|importlib)\//.test(file)
    const frame = frames.find((match) => !isLibraryFrame(match[1] ?? '')) ?? frames[frames.length - 1]
    if (frame) {
      const location: { file?: string; line?: number } = {}
      if (frame[1]) location.file = frame[1]
      const line = Number.parseInt(frame[2] ?? '', 10)
      if (Number.isFinite(line)) location.line = line
      return location
    }
  }
  return locationFromText(text)
}

/** unittest prints the exception line at column 0; frames and source lines are indented. */
function unittestMessage(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue
    if (/^[=-]{5,}$/.test(trimmed)) continue
    if (/^Traceback \(most recent call last\):$/.test(trimmed)) continue
    if (/^\s/.test(rawLine)) continue
    return normalizeName(rawLine)
  }
  return firstMeaningful(body)
}

export function parseUnittestConsole(output: string): TestSummary {
  const parser = 'unittest'
  let ran: { run: number; durationMs: number } | null = null
  let outcome: UnittestOutcome | null = null
  let verbosePassed = 0
  let verboseFailed = 0
  let verboseSkipped = 0
  const failureBlocks: { description: string; body: string[] }[] = []
  let current: { description: string; body: string[] } | null = null

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '')
    const ranMatch = UNITTEST_RAN_RE.exec(line.trim())
    if (ranMatch) {
      const seconds = Number.parseFloat(ranMatch[2] ?? '0')
      ran = {
        run: Number.parseInt(ranMatch[1] ?? '0', 10),
        durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
      }
      current = null
      continue
    }
    const parsedOutcome = parseUnittestOutcome(line)
    if (parsedOutcome) {
      outcome = parsedOutcome
      current = null
      continue
    }
    const failureHeader = UNITTEST_FAILURE_RE.exec(line)
    if (failureHeader) {
      current = { description: failureHeader[2] ?? '', body: [] }
      failureBlocks.push(current)
      continue
    }
    // `UNEXPECTED SUCCESS` sections have no body and never count as failures.
    if (/^UNEXPECTED SUCCESS:/.test(line)) {
      current = null
      continue
    }
    // `-v` per-test lines also double as a fallback when the `Ran` line was lost.
    const verboseMatch = UNITTEST_VERBOSE_RE.exec(line)
    if (verboseMatch) {
      const status = verboseMatch[3] ?? ''
      if (status === 'ok') verbosePassed += 1
      else if (status === 'FAIL' || status === 'ERROR' || status === 'unexpected success') verboseFailed += 1
      else verboseSkipped += 1 // skipped '<reason>' / expected failure
      continue
    }
    if (current) {
      if (/^={5,}$/.test(line.trim())) current = null
      else current.body.push(line)
    }
  }

  // A recognizable result line is mandatory: `Ran ...` alone may be a killed or
  // truncated run and must never be treated as evidence (FR-5.2 / docs 6.3).
  if (!outcome) return emptySummary(parser)
  const verboseTotal = verbosePassed + verboseFailed + verboseSkipped
  const run = ran ? ran.run : verboseTotal
  if (!ran && verboseTotal === 0) return emptySummary(parser)

  const failed = outcome.failures + outcome.errors
  const skipped = outcome.skipped
  const summary: TestSummary = {
    parser,
    parsed: true,
    run,
    passed: Math.max(0, run - failed - skipped),
    failed,
    skipped,
  }
  if (ran && ran.durationMs > 0) summary.durationMs = ran.durationMs
  if (failed > 0 && failureBlocks.length > 0) {
    summary.failures = failureBlocks.map((block) => {
      const body = block.body.join('\n')
      const location = pointerFromPythonTraceback(body)
      return failureOf(unittestFailureName(block.description), location.file, location.line, unittestMessage(body))
    })
  }
  return summary
}

// ---------------------------------------------------------------------------
// Vitest console
// ---------------------------------------------------------------------------

interface VitestCounts {
  passed: number
  failed: number
  skipped: number
  total: number
}

function parsePipeCounts(line: string): VitestCounts {
  const counts: VitestCounts = { passed: 0, failed: 0, skipped: 0, total: 0 }
  const totalMatch = /\((\d+)\)/.exec(line)
  if (totalMatch) counts.total = Number.parseInt(totalMatch[1] ?? '0', 10)
  const passed = /(\d+)\s+passed/.exec(line)
  if (passed) counts.passed = Number.parseInt(passed[1] ?? '0', 10)
  const failed = /(\d+)\s+failed/.exec(line)
  if (failed) counts.failed = Number.parseInt(failed[1] ?? '0', 10)
  const skipped = /(\d+)\s+(?:skipped|todo)/.exec(line)
  if (skipped) counts.skipped = Number.parseInt(skipped[1] ?? '0', 10)
  if (counts.total === 0) counts.total = counts.passed + counts.failed + counts.skipped
  return counts
}

export function parseVitestConsole(output: string): TestSummary {
  const parser = 'vitest-console'
  const testsLine = /^\s*Tests\s{2,}(.+)$/m.exec(output)
  const noTests = /No test files found|no test files found/.test(output)
  if (!testsLine && !noTests) return emptySummary(parser)
  let run = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  if (testsLine && !/no tests/i.test(testsLine[1]!)) {
    const counts = parsePipeCounts(testsLine[1]!)
    run = counts.total
    passed = counts.passed
    failed = counts.failed
    skipped = counts.skipped
  }
  const failures: TestFailure[] = []
  const seen = new Set<string>()
  let pendingName: string | null = null
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const failLine = /^(?:×|✗|FAIL)\s+(.+)$/.exec(line)
    if (failLine) {
      const name = normalizeName(failLine[1]!.replace(/\s+\d+(?:\.\d+)?m?s$/, ''))
      pendingName = name
      if (name !== '' && !seen.has(name)) {
        seen.add(name)
        failures.push(failureOf(name))
      }
      continue
    }
    const detail = /^→\s*(.+)$/.exec(line)
    if (detail && pendingName) {
      const failure = failures.find((entry) => entry.name === pendingName)
      if (failure && !failure.message) failure.message = normalizeName(detail[1])
      pendingName = null
    }
  }
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  return summary
}

// ---------------------------------------------------------------------------
// Jest console
// ---------------------------------------------------------------------------

/**
 * `node --test` default/spec reporter (Node 20+) and TAP-ish summary lines.
 * Recognised lines: `ℹ tests 34` / `# tests 34` plus pass/fail/skipped/duration.
 */
export function parseNodeTestConsole(output: string): TestSummary {
  const parser = 'node-test'
  const counter = (name: string): number | undefined => {
    const match = new RegExp(`^\\s*(?:ℹ|#)\\s*${name}\\s+(\\d+)\\s*$`, 'm').exec(output)
    if (!match) return undefined
    const value = Number.parseInt(match[1]!, 10)
    return Number.isFinite(value) ? value : undefined
  }
  const tests = counter('tests')
  if (tests === undefined) return emptySummary(parser)
  const durationMatch = /^\s*(?:ℹ|#)\s*duration_ms\s+([\d.]+)\s*$/m.exec(output)
  const durationMs = durationMatch ? Math.round(Number.parseFloat(durationMatch[1]!)) : undefined
  const failed = counter('fail') ?? 0
  const summary: TestSummary = {
    parser,
    parsed: true,
    run: tests,
    passed: counter('pass') ?? 0,
    failed,
    skipped: (counter('skipped') ?? 0) + (counter('todo') ?? 0),
  }
  if (durationMs !== undefined && Number.isFinite(durationMs)) summary.durationMs = durationMs
  if (failed > 0) {
    // Node's spec reporter prints `✖ <name> (Nms)` for each failing test.
    const failures: TestFailure[] = []
    for (const match of output.matchAll(/^\s*✖\s+(.+?)\s*\([\d.]+m?s\)\s*$/gm)) {
      failures.push(failureOf(normalizeName(match[1])))
    }
    if (failures.length > 0) summary.failures = failures
  }
  return summary
}

export function parseJestConsole(output: string): TestSummary {
  const parser = 'jest-console'
  const testsLine = /^\s*Tests:\s+(.+)$/m.exec(output)
  const noTests = /No tests found|0 total/.test(output)
  if (!testsLine && !noTests) return emptySummary(parser)
  let run = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  if (testsLine) {
    const line = testsLine[1]!
    const total = /(\d+)\s+total/.exec(line)
    if (total) run = Number.parseInt(total[1] ?? '0', 10)
    const passedMatch = /(\d+)\s+passed/.exec(line)
    if (passedMatch) passed = Number.parseInt(passedMatch[1] ?? '0', 10)
    const failedMatch = /(\d+)\s+failed/.exec(line)
    if (failedMatch) failed = Number.parseInt(failedMatch[1] ?? '0', 10)
    const skippedMatch = /(\d+)\s+(?:skipped|pending|todo)/.exec(line)
    if (skippedMatch) skipped = Number.parseInt(skippedMatch[1] ?? '0', 10)
    if (run === 0) run = passed + failed + skipped
  }
  const failures: TestFailure[] = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*(?:✕|×|✗)\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/.exec(rawLine)
    if (!match) continue
    const name = normalizeName(match[1])
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    failures.push(failureOf(name))
  }
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  return summary
}

// ---------------------------------------------------------------------------
// go test -json
// ---------------------------------------------------------------------------

interface GoTestEvent {
  Time?: string
  Action?: string
  Package?: string
  Test?: string
  Output?: string
  Elapsed?: number
}

export function parseGoTestJson(output: string): TestSummary {
  const parser = 'go-test-json'
  const events: GoTestEvent[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as GoTestEvent).Action === 'string') {
      events.push(parsed as GoTestEvent)
    }
  }
  if (events.length === 0) return emptySummary(parser)

  // Only test-level pass/fail/skip count. Package-level `ok` lines, packages
  // where every test is skipped and packages without tests yield run = 0 and
  // therefore never count as useful passing evidence (FR-5.2 / docs 6.3).
  const states = new Map<string, { state: 'pass' | 'fail' | 'skip'; packageName: string; test: string; output: string[] }>()
  let durationMs = 0
  for (const event of events) {
    if (event.Elapsed !== undefined && Number.isFinite(event.Elapsed)) durationMs += event.Elapsed * 1000
    if (!event.Test || !event.Action) continue
    const key = `${event.Package ?? ''}\u0000${event.Test}`
    const existing = states.get(key)
    if (event.Action === 'run') {
      if (!existing) states.set(key, { state: 'skip', packageName: event.Package ?? '', test: event.Test, output: [] })
      continue
    }
    if (event.Action === 'output') {
      if (existing && event.Output) existing.output.push(event.Output)
      continue
    }
    if (event.Action === 'pass' || event.Action === 'fail' || event.Action === 'skip') {
      const entry = existing ?? { state: 'skip', packageName: event.Package ?? '', test: event.Test, output: [] }
      entry.state = event.Action === 'pass' ? 'pass' : event.Action === 'fail' ? 'fail' : 'skip'
      states.set(key, entry)
    }
  }

  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: TestFailure[] = []
  for (const entry of states.values()) {
    if (entry.state === 'pass') passed += 1
    else if (entry.state === 'fail') {
      failed += 1
      const outputText = entry.output.join('')
      const messageLine =
        outputText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line !== '' && !/^=== (?:RUN|PAUSE|CONT|NAME)/.test(line) && !/^--- (?:FAIL|PASS|SKIP)/.test(line)) ?? ''
      const location = locationFromText(outputText)
      const fullName = entry.packageName ? `${entry.packageName}.${entry.test}` : entry.test
      failures.push(failureOf(fullName, location.file, location.line, messageLine))
    } else skipped += 1
  }
  const run = passed + failed + skipped
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  if (durationMs > 0) summary.durationMs = Math.round(durationMs)
  // Packages with only package-level events (`ok pkg`, `? pkg [no test files]`)
  // leave run = 0: nothing to count even though the package "passed".
  return summary
}

// ---------------------------------------------------------------------------
// cargo test console
// ---------------------------------------------------------------------------

export function parseCargoConsole(output: string): TestSummary {
  const parser = 'cargo-console'
  const resultRe = /test result:\s*(?:ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/g
  const matches = [...output.matchAll(resultRe)]
  if (matches.length === 0) return emptySummary(parser)
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const match of matches) {
    passed += Number.parseInt(match[1] ?? '0', 10)
    failed += Number.parseInt(match[2] ?? '0', 10)
    skipped += Number.parseInt(match[3] ?? '0', 10)
  }
  const failures: TestFailure[] = []
  const seen = new Set<string>()
  for (const match of output.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm)) {
    const name = match[1] ?? ''
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    const blockRe = new RegExp(`----\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+stdout\\s+----\\n([\\s\\S]*?)(?:\\n\\n|\\n----)`)
    const block = blockRe.exec(output)
    const text = block?.[1] ?? ''
    const messageLine = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('----')) ?? ''
    const location = locationFromText(text)
    failures.push(failureOf(name, location.file, location.line, messageLine))
  }
  const run = passed + failed + skipped
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  return summary
}

// ---------------------------------------------------------------------------
// Report-file dispatch + parser selection
// ---------------------------------------------------------------------------

function parseJestLikeJson(parser: string, text: string): TestSummary | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  const results = obj.testResults
  if (!Array.isArray(results) && typeof obj.numTotalTests !== 'number') return null
  let run = 0
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: TestFailure[] = []
  if (Array.isArray(results)) {
    for (const fileResult of results) {
      if (!fileResult || typeof fileResult !== 'object') continue
      const record = fileResult as Record<string, unknown>
      const fileName = typeof record.name === 'string' ? record.name : undefined
      const assertions = record.assertionResults
      if (!Array.isArray(assertions)) continue
      for (const assertion of assertions) {
        if (!assertion || typeof assertion !== 'object') continue
        const entry = assertion as Record<string, unknown>
        const status = typeof entry.status === 'string' ? entry.status : 'passed'
        run += 1
        if (status === 'passed') {
          passed += 1
        } else if (status === 'failed') {
          failed += 1
          const messages = Array.isArray(entry.failureMessages) ? entry.failureMessages : []
          const firstMessage = messages.find((message) => typeof message === 'string')
          const messageText = typeof firstMessage === 'string' ? firstMessage : ''
          const location = locationFromText(messageText)
          const title = typeof entry.fullName === 'string' ? entry.fullName : typeof entry.title === 'string' ? entry.title : ''
          failures.push(failureOf(normalizeName(title), location.file ?? fileName, location.line, normalizeName(firstMeaningful(messageText))))
        } else {
          skipped += 1
        }
      }
    }
  }
  if (run === 0) {
    const total = typeof obj.numTotalTests === 'number' ? obj.numTotalTests : 0
    const numPassed = typeof obj.numPassedTests === 'number' ? obj.numPassedTests : 0
    const numFailed = typeof obj.numFailedTests === 'number' ? obj.numFailedTests : 0
    const numPending = typeof obj.numPendingTests === 'number' ? obj.numPendingTests : 0
    run = total
    passed = numPassed
    failed = numFailed
    skipped = numPending
  }
  const summary: TestSummary = { parser, parsed: true, run, passed, failed, skipped }
  if (failures.length > 0) summary.failures = failures
  return summary
}

function parseReportFile(file: { path: string; content: string }): TestSummary | null {
  const content = file.content.trim()
  if (content === '') return null
  if (content.startsWith('<')) {
    const summary = parseJUnitXml(content)
    return summary.parsed ? summary : null
  }
  if (content.startsWith('{')) {
    const json = parseJestLikeJson(/vitest/i.test(file.path) ? 'vitest-json' : 'jest-json', content)
    if (json && json.parsed) return json
  }
  // JSON-lines go test output.
  if (/"Action"\s*:/.test(content)) {
    const summary = parseGoTestJson(content)
    return summary.parsed ? summary : null
  }
  return null
}

const CONSOLE_PARSERS: { id: string; match: RegExp; parse: (output: string) => TestSummary }[] = [
  { id: 'maven', match: /(?:^|[\s/])(?:mvn(?:w)?|maven)(?:\s|$)/i, parse: parseMavenConsole },
  { id: 'gradle', match: /(?:^|[\s/])gradle(?:w)?(?:\s|$)/i, parse: parseGradleConsole },
  { id: 'pytest', match: /(?:^|[\s/])(?:pytest|py\.test)(?:\s|$)/i, parse: parsePytestConsole },
  {
    id: 'unittest',
    match: /(?:^|[\s/])(?:python(?:\d+(?:\.\d+)*)?\s+-m\s+unittest|unittest)(?:\s|$)/i,
    parse: parseUnittestConsole,
  },
  { id: 'vitest', match: /(?:^|[\s/])vitest(?:\s|$)/i, parse: parseVitestConsole },
  { id: 'jest', match: /(?:^|[\s/])jest(?:\s|$)/i, parse: parseJestConsole },
  { id: 'go', match: /\bgo\s+test\b/i, parse: parseGoTestJson },
  { id: 'cargo', match: /\bcargo\s+(?:test|nextest)\b/i, parse: parseCargoConsole },
  { id: 'node-test', match: /\bnode\s+(?:--test|--experimental-test)/i, parse: parseNodeTestConsole },
]

function consoleParserOrder(command: string): ((output: string) => TestSummary)[] {
  const ordered: ((output: string) => TestSummary)[] = []
  for (const parser of CONSOLE_PARSERS) {
    if (parser.match.test(command)) ordered.push(parser.parse)
  }
  for (const parser of CONSOLE_PARSERS) {
    if (!ordered.includes(parser.parse)) ordered.push(parser.parse)
  }
  return ordered
}

/** Detect what kind of evidence a verification command produces. */
export function detectEvidenceKind(command: string): EvidenceKind {
  const normalized = command.trim().toLowerCase()
  if (normalized === '') return 'run'
  if (
    /\b(?:test|tests|pytest|vitest|jest|mocha|junit|unittest|cargo\s+nextest)\b/.test(normalized) ||
    /\bgo\s+test\b/.test(normalized)
  ) {
    if (/\btest\s*:\s*none\b/.test(normalized)) return 'manual'
    return 'test'
  }
  if (/\b(?:tsc|typecheck|type-check|mypy|pyright|vue-tsc)\b/.test(normalized)) return 'typecheck'
  if (/\b(?:lint|eslint|prettier|stylelint|ruff|flake8|pylint|golangci-lint|clippy|rubocop)\b/.test(normalized)) return 'lint'
  if (/\b(?:build|compile|assemble|package|install|wheel)\b/.test(normalized)) return 'build'
  if (/\b(?:manual|手工)\b/.test(normalized)) return 'manual'
  return 'run'
}

/**
 * Phase judgement for a receipt.
 *
 * - RED requires a parsed failure count > 0 (an unresolved failure is never
 *   treated as RED, so a broken parser cannot manufacture a RED receipt).
 * - GREEN requires exit code 0, a parsed summary, at least one executed test
 *   and at least one passing test (FR-5.2: `run: 0` is not evidence; packages
 *   where every test is skipped never count as useful passing evidence).
 * - Anything else is `none`: unparsed output with exit 0 is auxiliary GREEN
 *   only for the caller/host, never a complete evidence receipt.
 */
export function evidencePhase(summary: TestSummary | null, exitCode: number): EvidencePhase {
  if (summary && summary.parsed && summary.failed > 0) return 'red'
  if (exitCode !== 0) return 'none'
  if (!summary || !summary.parsed) return 'none'
  if (summary.run <= 0 || summary.passed <= 0) return 'none'
  return summary.failed === 0 ? 'green' : 'red'
}

/** Parse a command's output, preferring machine-readable report files. */
export function parseTestOutput(input: ParseInput): TestSummary {
  const reportSummaries: TestSummary[] = []
  for (const file of input.reportFiles ?? []) {
    const summary = parseReportFile(file)
    if (summary && summary.parsed) reportSummaries.push(summary)
  }
  if (reportSummaries.length > 0) return sumCounts(reportSummaries)

  const output = [input.stdout, input.stderr].filter((text) => text !== '').join('\n')
  for (const parse of consoleParserOrder(input.command)) {
    const summary = parse(output)
    if (summary.parsed) return summary
  }
  return emptySummary('unknown')
}

/** Merge several parsed summaries (one per report file) into one receipt summary. */
export function mergeTestSummaries(summaries: TestSummary[]): TestSummary {
  return sumCounts(summaries)
}
