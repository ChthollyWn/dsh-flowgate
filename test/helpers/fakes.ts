/**
 * Test doubles shared by core and integration tests.
 *
 * They are plain TypeScript (no DSH imports, no network, no real filesystem)
 * so tests stay deterministic and fast.
 */
import type {
  CommandResult,
  CommandRunner,
  GitPort,
  ReviewFinding,
  TestSummary,
} from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import type { FileSystem } from '../../src/core/util/fs'

export class FakeClock {
  private current = new Date('2026-11-01T09:00:00+08:00')
  now(): Date {
    return new Date(this.current.getTime())
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
  advanceMinutes(minutes: number): void {
    this.advanceMs(minutes * 60_000)
  }
}

export interface FakeCommandSpec {
  /** Match by substring of the command; first match wins. */
  match: string
  exitCode?: number
  stdout?: string
  stderr?: string
  summary?: TestSummary | null
  durationMs?: number
  timedOut?: boolean
}

export class FakeCommandRunner implements CommandRunner {
  readonly calls: { command: string; cwd: string; at: number }[] = []
  private readonly specs: FakeCommandSpec[]
  private readonly queued: FakeCommandSpec[] = []
  private readonly clock: FakeClock

  constructor(specs: FakeCommandSpec[] = [], clock = new FakeClock()) {
    this.specs = specs
    this.clock = clock
  }

  /** Queue a one-off result consumed by the next run() call (for RED → GREEN flows). */
  enqueue(spec: FakeCommandSpec): void {
    this.queued.push(spec)
  }

  async run(command: string, options: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
    this.calls.push({ command, cwd: options.cwd, at: this.clock.now().getTime() })
    this.clock.advanceMs(1_000)
    const spec = this.queued.shift() ?? this.specs.find((item) => command.includes(item.match)) ?? {
      match: '',
      exitCode: 0,
      stdout: VITEST_PASS_STDOUT,
      stderr: '',
    }
    return {
      exitCode: spec.exitCode ?? 0,
      stdout: spec.stdout ?? '',
      stderr: spec.stderr ?? '',
      timedOut: spec.timedOut ?? false,
      durationMs: spec.durationMs ?? 1_000,
    }
  }
}

export class FakeGit implements GitPort {
  private repo = true
  private branch: string | null = 'main'
  private headSha = 'abc1234'
  private files: string[] = []
  private readonly gitClock: FakeClock
  readonly commits: { message: string; at: string }[] = []
  readonly branches: string[] = ['main']

  constructor(clock: FakeClock, repo = true) {
    this.gitClock = clock
    this.repo = repo
  }

  setRepo(repo: boolean): void {
    this.repo = repo
  }

  setChangedFiles(files: string[]): void {
    this.files = files
  }

  async isRepo(): Promise<boolean> {
    return this.repo
  }

  async head(): Promise<string | null> {
    return this.repo ? this.headSha : null
  }

  async currentBranch(): Promise<string | null> {
    return this.repo ? this.branch : null
  }

  async branchExists(_cwd: string, branch: string): Promise<boolean> {
    return this.branches.includes(branch)
  }

  async createBranch(_cwd: string, branch: string): Promise<void> {
    if (!this.branches.includes(branch)) this.branches.push(branch)
  }

  async checkout(_cwd: string, branch: string, create = false): Promise<void> {
    if (create && !this.branches.includes(branch)) this.branches.push(branch)
    this.branch = branch
  }

  async statusPorcelain(): Promise<string> {
    return this.files.map((file) => ` M ${file}`).join('\n')
  }

  async diffNames(): Promise<string[]> {
    return [...this.files]
  }

  async diffText(): Promise<string> {
    return this.files.map((file) => `diff --git a/${file} b/${file}`).join('\n')
  }

  async showFile(): Promise<string | null> {
    return null
  }

  async add(): Promise<void> {}

  async commit(_cwd: string, message: string): Promise<void> {
    this.commits.push({ message, at: this.gitClock.now().toISOString() })
    this.headSha = `sha-${this.commits.length}`
    this.files = []
  }

  async push(): Promise<void> {}
}

/** Build a minimal project tree for engine tests. */
export function seedProject(fs: MemoryFileSystem): void {
  fs.writeFile('README.md', '# demo project\n')
  fs.writeFile(
    'package.json',
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', build: 'tsc' } }, null, 2),
  )
  fs.writeFile('src/index.ts', 'export const answer = 42\n')
  fs.writeFile('test/index.test.ts', "import { answer } from '../src/index'\n")
}

export function fsFiles(fs: MemoryFileSystem): string[] {
  return fs.listFiles()
}

/** Fake git/fs bundle for integration tests. */
export interface FakeSandbox {
  fs: FileSystem & MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
}

export function createSandbox(options: { testCommand?: string; runnerSpecs?: FakeCommandSpec[]; git?: boolean } = {}): FakeSandbox {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  seedProject(fs)
  const git = new FakeGit(clock, options.git ?? true)
  const runner = new FakeCommandRunner(
    options.runnerSpecs ?? [
      {
        match: 'test',
        exitCode: 0,
        stdout: VITEST_PASS_STDOUT,
        summary: { parser: 'vitest', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 },
      },
    ],
    clock,
  )
  return { fs, clock, git, runner }
}

export const VITEST_PASS_STDOUT = [
  ' RUN  v4.1.0',
  '',
  ' ✓ test/renewal.test.ts (3 tests) 12ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)',
  '   Start at  09:00:00',
  '   Duration  12ms',
  '',
].join('\n')

export const PASSING_SUMMARY: TestSummary = {
  parser: 'vitest',
  parsed: true,
  run: 3,
  passed: 3,
  failed: 0,
  skipped: 0,
}

export const FAILING_SUMMARY: TestSummary = {
  parser: 'vitest',
  parsed: true,
  run: 3,
  passed: 2,
  failed: 1,
  skipped: 0,
  failures: [{ name: 'renewal adds one extra day', file: 'test/renewal.test.ts', line: 42, message: 'expected 2026-12-01, got 2026-12-02' }],
}

export const CRITICAL_FINDING: ReviewFinding = {
  severity: 'critical',
  file: 'src/renewal.ts',
  line: 88,
  rule: 'spec-mismatch',
  message: '回调幂等没有实现：重复回调会重复延长到期日',
  suggestion: '用支付流水号唯一索引 + 先查后写',
}
