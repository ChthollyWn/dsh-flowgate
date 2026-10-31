/**
 * Verify-group execution: the plugin runs the verification command itself
 * (never through a shell), parses the output, hashes the declared inputs and
 * persists a receipt plus the full output log.
 *
 * The engines/host only ever call `runVerifyGroup` / `runFullSuite`; agent-run
 * shell tests are reference material, never RED/GREEN evidence (docs/03 §6.2).
 */
import type {
  CommandRunner,
  CommandResult,
  EvidenceKind,
  EvidenceReceipt,
  TaskCard,
  TestSummary,
  VerifyGroup,
  ChangeStatus,
} from '../types'
import type { Clock, FileSystem } from '../util/fs'
import { redactSecrets } from '../util/hash'
import { normalizeRelPath, posixJoin } from '../util/paths'
import { isoNow } from '../util/time'
import { detectEvidenceKind, evidencePhase, parseTestOutput } from './parse'
import { hashInputs } from './hash'

/** Verification commands get 10 minutes; the host runner also enforces it. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

/** Filesystem mtime has coarse resolution on some platforms; allow 2s slop. */
const REPORT_MTIME_TOLERANCE_MS = 2_000

/** Report locations checked after the command finished (docs/03 §6.3). */
const REPORT_DIR_CANDIDATES = [
  'target/surefire-reports',
  'target/failsafe-reports',
  'target/test-reports',
  'build/test-results',
  'build/test-results/test',
  'test-results',
  'reports/junit',
  'junit-reports',
]
const REPORT_FILE_CANDIDATES = [
  'junit.xml',
  'test-results.xml',
  'test-report.xml',
  'test-results.json',
  'vitest-results.json',
  'jest-results.json',
  'report.json',
]
const MAX_REPORT_FILES = 100
const MAX_REPORT_FILE_BYTES = 5 * 1024 * 1024
const MAX_EVIDENCE_LOG_CHARS = 2 * 1024 * 1024

export interface RunVerifyOptions {
  fs: FileSystem
  root: string
  /**
   * Execution working directory (defaults to `root`).
   *
   * Parallel-batch tasks run in their own git worktree; the command must run
   * there and the declared inputs must be hashed from there, otherwise the
   * receipt would describe the main workspace while the executor edited the
   * worktree (T4.9).
   */
  cwd?: string
  runner: CommandRunner
  change: ChangeStatus
  task: TaskCard
  group: VerifyGroup
  clock: Clock
  nextEvidenceId: () => string
}

export interface BaselineResult {
  commit: string | null
  summary: TestSummary
  receipts: EvidenceReceipt[]
  failedTests: string[]
}

// ---------------------------------------------------------------------------
// Command shape guard (FR-5.11 / docs/03 §6.2)
// ---------------------------------------------------------------------------

const FORBIDDEN_COMMAND_PARTS: { pattern: RegExp; label: string; hint: string }[] = [
  { pattern: /\|\|/, label: '||', hint: '去掉 `|| true` 之类的兜底，让失败真实反映出来' },
  { pattern: /&&/, label: '&&', hint: '一个验证组只放一条命令；需要多步就拆成多个验证组' },
  { pattern: /(?<!\|)\|(?!\|)/, label: '|', hint: '不要用管道截取输出，回执需要完整输出' },
  { pattern: /;/, label: ';', hint: '一个验证组只执行一条命令' },
  { pattern: /`/, label: '`', hint: '不允许反引号命令替换' },
  { pattern: /\$\(/, label: '$(...)', hint: '不允许命令替换' },
  { pattern: /(?<!=)>(?!=)/, label: '>', hint: '不允许重定向到文件' },
  { pattern: /(?<!=)</, label: '<', hint: '不允许从文件重定向输入' },
  { pattern: /[\r\n]/, label: '换行', hint: '验证命令必须是单行' },
]

/** Throws a Chinese, host-wrapped error when the command shape is not allowed. */
export function assertVerifiableCommand(command: string): void {
  const trimmed = command.trim()
  if (trimmed === '') {
    throw Object.assign(new Error('验证命令为空：请在任务卡的验证组里写明可执行的测试命令'), {
      code: 'FLOWGATE_VERIFY_COMMAND',
      hint: '推荐写法：`mvn -B test`、`./gradlew test --rerun-tasks`、`pnpm vitest run`、`pytest`、`go test -json ./...`、`cargo test`',
    })
  }
  for (const part of FORBIDDEN_COMMAND_PARTS) {
    if (part.pattern.test(trimmed)) {
      throw Object.assign(
        new Error(`验证命令不能包含 ${part.label}：${trimmed}。${part.hint}`),
        { code: 'FLOWGATE_VERIFY_COMMAND', hint: part.hint },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Report file discovery
// ---------------------------------------------------------------------------

function reportDirsForCommand(command: string): string[] {
  const normalized = command.toLowerCase()
  if (/(?:^|[\s/])mvn(?:w)?(?:\s|$)/.test(normalized)) {
    return ['target/surefire-reports', 'target/failsafe-reports', 'target/test-reports']
  }
  if (/(?:^|[\s/])gradle(?:w)?(?:\s|$)/.test(normalized)) {
    return ['build/test-results', 'build/test-results/test', 'build/reports/tests']
  }
  if (/(?:^|[\s/])pytest(?:\s|$)/.test(normalized)) {
    return ['test-results', 'reports/junit', 'build/test-results']
  }
  if (/(?:^|[\s/])(?:vitest|jest|mocha)(?:\s|$)/.test(normalized)) {
    return ['test-results', 'reports/junit', 'coverage/test-results']
  }
  return REPORT_DIR_CANDIDATES
}

async function collectReportFiles(
  fs: FileSystem,
  root: string,
  dir: string,
  depth: number,
  output: string[],
): Promise<void> {
  if (depth > 6 || output.length >= MAX_REPORT_FILES) return
  let names: string[]
  try {
    names = await fs.readdir(posixJoin(root, dir))
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (output.length >= MAX_REPORT_FILES) return
    const relative = `${dir}/${name}`
    try {
      const size = await fs.statSize(posixJoin(root, relative))
      if (size > MAX_REPORT_FILE_BYTES) continue
      output.push(relative)
    } catch {
      await collectReportFiles(fs, root, relative, depth + 1, output)
    }
  }
}

/** Explicit report paths from the command line (e.g. pytest `--junitxml=...`). */
function explicitReportPaths(command: string): string[] {
  const paths: string[] = []
  const pattern = /(?:--junitxml[=\s]+|--junit-xml[=\s]+|--outputFile[=\s]+|--output-file[=\s]+)([^\s"'`]+)/g
  for (const match of command.matchAll(pattern)) {
    const raw = (match[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (raw !== '') paths.push(normalizeRelPath(raw))
  }
  return paths
}

async function discoverReportFiles(
  fs: FileSystem,
  root: string,
  startedAtMs: number,
  command: string,
): Promise<{ path: string; content: string }[]> {
  const discovered: string[] = [...explicitReportPaths(command)]
  for (const file of REPORT_FILE_CANDIDATES) discovered.push(file)
  for (const dir of reportDirsForCommand(command)) await collectReportFiles(fs, root, dir, 0, discovered)

  const files: { path: string; content: string }[] = []
  for (const relative of [...new Set(discovered)].sort()) {
    if (!/\.(?:xml|json)$/i.test(relative)) continue
    const absolute = posixJoin(root, relative)
    try {
      const mtime = await fs.mtimeMs(absolute)
      if (mtime + REPORT_MTIME_TOLERANCE_MS < startedAtMs) continue
      const content = await fs.readFile(absolute)
      if (content.length > MAX_REPORT_FILE_BYTES) continue
      files.push({ path: normalizeRelPath(relative), content })
    } catch {
      // Report disappeared mid-read: ignore it and fall back to console parsing.
    }
    if (files.length >= MAX_REPORT_FILES) break
  }
  return files
}

// ---------------------------------------------------------------------------
// Receipt helpers
// ---------------------------------------------------------------------------

function renderEvidenceLog(input: {
  id: string
  changeId: string
  taskId?: string
  group: string
  command: string
  exitCode: number
  timedOut: boolean
  startedAt: string
  finishedAt: string
  summary: TestSummary | null
  inputsHash: string
  result: CommandResult
}): string {
  const header = [
    `# FlowGate 验证回执 ${input.id}`,
    `变更：${input.changeId}`,
    `任务：${input.taskId ?? '（全量验证）'}`,
    `验证组：${input.group}`,
    `命令：${input.command}`,
    `退出码：${input.exitCode}${input.timedOut ? '（超时）' : ''}`,
    `开始：${input.startedAt}`,
    `结束：${input.finishedAt}`,
    `输入哈希：${input.inputsHash}`,
    `解析：${input.summary ? `${input.summary.parser}（parsed=${input.summary.parsed}, run=${input.summary.run}, failed=${input.summary.failed}）` : '未解析'}`,
    '',
    '----- stdout -----',
  ].join('\n')
  const body = redactSecrets(input.result.stdout ?? '')
  const stderr = redactSecrets(input.result.stderr ?? '')
  let text = `${header}\n${body}\n----- stderr -----\n${stderr}\n`
  if (text.length > MAX_EVIDENCE_LOG_CHARS) {
    text = `${text.slice(0, MAX_EVIDENCE_LOG_CHARS)}\n…（日志超过 ${MAX_EVIDENCE_LOG_CHARS} 字符，已截断）\n`
  }
  return text
}

function receiptNotes(input: {
  summary: TestSummary
  exitCode: number
  timedOut: boolean
  reportUsed: boolean
}): string[] {
  const notes: string[] = []
  if (input.timedOut) notes.push('验证命令超时后被终止：本次回执不能作为 GREEN 证据')
  if (input.reportUsed) notes.push('已优先使用机器可读报告文件解析结果（docs/03 §6.3）')
  if (!input.summary.parsed) {
    if (input.exitCode === 0) {
      notes.push('未能解析出测试数量（parsed=false）：退出码 0，只能作为 GREEN 的辅助证据（FR-5.2 要求运行数>0）')
    } else {
      notes.push('未能解析出测试数量（parsed=false）：不能判定为 RED（RED 需要看到失败用例数）')
    }
  } else if (input.summary.run === 0) {
    notes.push('运行数为 0：不算证据（FR-5.2）')
  } else if (input.summary.failed > 0) {
    notes.push(`存在 ${input.summary.failed} 个失败用例：本次回执为 RED 证据`)
  } else if (input.summary.passed === 0) {
    notes.push('所有用例都被跳过：不算有用例通过（docs/03 §6.3）')
  }
  return notes
}

async function writeEvidenceLog(fs: FileSystem, root: string, relative: string, content: string): Promise<void> {
  const absolute = posixJoin(root, relative)
  try {
    await fs.mkdir(posixJoin(root, '.flowgate/state/evidence'))
  } catch {
    // Directory may already exist.
  }
  await fs.writeFile(absolute, content)
}

// ---------------------------------------------------------------------------
// runVerifyGroup / runFullSuite
// ---------------------------------------------------------------------------

export async function runVerifyGroup(options: RunVerifyOptions): Promise<EvidenceReceipt> {
  const { fs, root, runner, change, task, group, clock } = options
  const executionRoot = options.cwd ?? root
  const declared = task.verify.find((entry) => entry.group === group.group) ?? group
  assertVerifiableCommand(declared.command)

  const inputHash = await hashInputs(fs, executionRoot, declared.inputs ?? [])
  const startedAt = isoNow(clock)
  const startedAtMs = Date.parse(startedAt)
  let result: CommandResult
  try {
    result = await runner.run(declared.command, { cwd: executionRoot, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS })
  } catch (error) {
    result = {
      exitCode: 1,
      stdout: '',
      stderr: `验证命令执行失败：${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
      durationMs: 0,
    }
  }
  const finishedAt = isoNow(clock)
  const reportFiles = await discoverReportFiles(fs, executionRoot, Number.isNaN(startedAtMs) ? 0 : startedAtMs, declared.command)
  const summary = parseTestOutput({
    command: declared.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    reportFiles,
    now: finishedAt,
  })
  const phase = result.timedOut ? 'none' : evidencePhase(summary, result.exitCode)
  const id = options.nextEvidenceId()
  const outputRef = `.flowgate/state/evidence/${id}.log`
  const notes = receiptNotes({
    summary,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    reportUsed: reportFiles.length > 0,
  })
  await writeEvidenceLog(
    fs,
    root,
    outputRef,
    renderEvidenceLog({
      id,
      changeId: change.id,
      taskId: task.id,
      group: declared.group,
      command: declared.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      startedAt,
      finishedAt,
      summary,
      inputsHash: inputHash.hash,
      result,
    }),
  )

  const receipt: EvidenceReceipt = {
    id,
    changeId: change.id,
    taskId: task.id,
    group: declared.group,
    kind: detectEvidenceKind(declared.command),
    phase,
    command: declared.command,
    runBy: 'flowgate',
    exitCode: result.exitCode,
    summary,
    inputsHash: inputHash.hash,
    outputRef,
    startedAt,
    finishedAt,
  }
  if (result.timedOut) receipt.timedOut = true
  if (notes.length > 0) receipt.notes = notes.join('；')
  return receipt
}

export async function runFullSuite(
  options: Omit<RunVerifyOptions, 'task' | 'group'> & {
    command: string
    inputs: string[]
    baseline?: BaselineResult
  },
): Promise<EvidenceReceipt> {
  const { fs, root, runner, change, clock } = options
  const executionRoot = options.cwd ?? root
  assertVerifiableCommand(options.command)
  const inputHash = await hashInputs(fs, executionRoot, options.inputs)
  const startedAt = isoNow(clock)
  const startedAtMs = Date.parse(startedAt)
  let result: CommandResult
  try {
    result = await runner.run(options.command, { cwd: executionRoot, timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS })
  } catch (error) {
    result = {
      exitCode: 1,
      stdout: '',
      stderr: `验证命令执行失败：${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
      durationMs: 0,
    }
  }
  const finishedAt = isoNow(clock)
  const reportFiles = await discoverReportFiles(fs, executionRoot, Number.isNaN(startedAtMs) ? 0 : startedAtMs, options.command)
  const summary = parseTestOutput({
    command: options.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    reportFiles,
    now: finishedAt,
  })
  let phase: EvidenceReceipt['phase'] = result.timedOut ? 'none' : evidencePhase(summary, result.exitCode)
  const notes = receiptNotes({
    summary,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    reportUsed: reportFiles.length > 0,
  })
  if (options.baseline) {
    const comparison = compareWithBaseline(options.baseline, summary)
    summary.regressions = comparison.regressions
    if (!comparison.ok && phase === 'green') phase = 'none'
    notes.push(
      comparison.ok
        ? `与基线对比：无新增回归（新增通过 ${comparison.newPasses.length} 个）`
        : `与基线对比：新增回归 ${comparison.regressions.length} 个（${comparison.regressions.slice(0, 5).join('、')}）`,
    )
  } else {
    notes.push('未提供基线：本次全量测试不能判定回归数')
  }
  const id = options.nextEvidenceId()
  const outputRef = `.flowgate/state/evidence/${id}.log`
  await writeEvidenceLog(
    fs,
    root,
    outputRef,
    renderEvidenceLog({
      id,
      changeId: change.id,
      group: 'full-suite',
      command: options.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      startedAt,
      finishedAt,
      summary,
      inputsHash: inputHash.hash,
      result,
    }),
  )
  const receipt: EvidenceReceipt = {
    id,
    changeId: change.id,
    group: 'full-suite',
    kind: detectEvidenceKind(options.command) as EvidenceKind,
    phase,
    command: options.command,
    runBy: 'flowgate',
    exitCode: result.exitCode,
    summary,
    inputsHash: inputHash.hash,
    outputRef,
    startedAt,
    finishedAt,
  }
  if (result.timedOut) receipt.timedOut = true
  if (notes.length > 0) receipt.notes = notes.join('；')
  return receipt
}

function failureNames(summary: TestSummary): string[] {
  return (summary.failures ?? []).map((failure) => failure.name)
}

/**
 * Compare the current full-suite summary with the S2 baseline: a regression is
 * a test that fails now but passed (or did not exist) in the baseline.
 */
export function compareWithBaseline(
  baseline: BaselineResult | null,
  current: TestSummary,
): { regressions: string[]; newPasses: string[]; ok: boolean } {
  const currentFailed = failureNames(current)
  if (!baseline) {
    return { regressions: currentFailed, newPasses: [], ok: current.parsed && current.failed === 0 }
  }
  const baselineFailed = baseline.failedTests.length > 0 ? baseline.failedTests : failureNames(baseline.summary)
  const regressions = currentFailed.filter((name) => !baselineFailed.includes(name))
  const newPasses = baselineFailed.filter((name) => !currentFailed.includes(name))
  const parsed = current.parsed
  return {
    regressions,
    newPasses,
    ok: parsed && regressions.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Context summary compression (docs/03 §6.7)
// ---------------------------------------------------------------------------

/**
 * Rough token estimate used only for budget control: mixed Chinese/code text
 * is approximated as 3 characters per token. It deliberately over-estimates
 * (CJK is denser) so the summary stays under the configured budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `用时 ${Math.round(ms)}ms`
  const seconds = Math.round(ms / 100) / 10
  return `用时 ${seconds}s`
}

function stateText(receipt: EvidenceReceipt): string {
  if (receipt.timedOut) return '超时'
  if (receipt.summary && receipt.summary.parsed) {
    if (receipt.summary.failed > 0) return '失败'
    if (receipt.summary.run === 0) return '没有运行任何测试'
    if (receipt.summary.passed === 0) return '全部跳过'
    return '通过'
  }
  return receipt.exitCode === 0 ? '未解析（退出码 0，仅辅助）' : '未解析（失败）'
}

/**
 * One human-readable compressed summary (Chinese, <= maxTokens approximated).
 * Passing runs keep a single line; failing runs list the failure names, the
 * first error line with its source location and the full log path.
 */
export function summarizeEvidenceForContext(receipt: EvidenceReceipt, maxTokens: number): string {
  const summary = receipt.summary
  const counts =
    summary && summary.parsed
      ? `运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}`
      : `未解析测试数量，退出码 ${receipt.exitCode}`
  const duration = formatDuration(summary?.durationMs)
  const header = `[FlowGate] ${receipt.command} → ${stateText(receipt)}（${counts}）${duration ? `，${duration}` : ''}`
  const logLine = `完整输出：${receipt.outputRef}（可用 read 查看）`
  const failures = summary?.failures ?? []

  // All green: one line only (docs/03 §6.7).
  if (summary && summary.parsed && summary.failed === 0 && summary.passed > 0 && receipt.exitCode === 0 && !receipt.timedOut) {
    return header
  }

  const lines: string[] = [header]
  let truncatedFailures = 0
  for (const [index, failure] of failures.entries()) {
    const detail: string[] = [`失败 ${index + 1}：${failure.name}`]
    const message = (failure.message ?? '').split(/\r?\n/).find((line) => line.trim() !== '')
    if (message) detail.push(`  ${message.trim()}`)
    if (failure.file) detail.push(`  位置：${failure.file}${failure.line !== undefined ? `:${failure.line}` : ''}`)
    const candidate = [...lines, ...detail, logLine].join('\n')
    if (lines.length === 1 || estimateTokens(candidate) <= maxTokens) {
      lines.push(...detail)
    } else {
      truncatedFailures = failures.length - index
      break
    }
  }
  if (failures.length === 0) {
    if (receipt.notes) lines.push(receipt.notes.split('；')[0] ?? receipt.notes)
    lines.push(logLine)
  } else {
    if (truncatedFailures > 0) lines.push(`……还有 ${truncatedFailures} 个失败，见完整输出`)
    const withLog = [...lines, logLine].join('\n')
    if (estimateTokens(withLog) <= maxTokens) {
      lines.push(logLine)
    } else {
      lines.push(logLine)
    }
  }
  let text = lines.join('\n')
  // Hard stop: trim failure detail lines if the estimate still exceeds budget.
  while (estimateTokens(text) > maxTokens && lines.length > 2) {
    const removed = lines.pop()
    if (removed === logLine) break
    text = lines.join('\n')
  }
  if (!text.includes(receipt.outputRef)) text = `${text}\n${logLine}`
  return text
}

/** Keep head and tail of a large output, marking the cut in the middle. */
export function truncateOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: output.length > 0 }
  if (output.length <= maxChars) return { text: output, truncated: false }
  const marker = `\n…（输出过长已截断，共 ${output.length} 字符）…\n`
  const budget = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(budget * 0.6)
  const tail = Math.floor(budget * 0.4)
  return { text: output.slice(0, head) + marker + output.slice(output.length - tail), truncated: true }
}
