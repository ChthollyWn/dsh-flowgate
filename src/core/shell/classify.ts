/**
 * Shell command classification (03 §4.4, FR-4.10/4.11).
 *
 * Matching happens only at *command positions*: quoted strings, `node -e` /
 * `python -c` script bodies and heredoc bodies are not commands. Pipeline
 * lookahead is preserved so `curl … | sh` is caught, and git global options are
 * skipped so `git -C ../repo push --force` is caught (cc-safety-net regression).
 */
import type { ShellCommandClass } from '../types'
import { posixBasename } from '../util/paths'
import { parseCommandLine, parseCommands } from './tokenize'
import type { CommandSegment, ParsedCommand } from './tokenize'

const DEV_NULL_TARGETS = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  'nul',
  'NUL',
])

const WRAPPER_COMMANDS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'timeout',
  'nice',
  'command',
  'exec',
  'builtin',
])

const PIPE_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'node',
  'python',
  'python3',
  'perl',
  'ruby',
  'php',
])

const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlcmd',
  'duckdb',
  'clickhouse-client',
  'cockroach',
])

const TEST_RUNNERS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'pytest',
  'tox',
  'nox',
  'phpunit',
  'rspec',
  'bats',
  'ctest',
  'playwright',
  'cypress',
])

const BUILD_TOOLS = new Set([
  'webpack',
  'rollup',
  'esbuild',
  'tsc',
  'vite',
  'next',
  'turbo',
  'nx',
  'cmake',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
])

const LINT_TOOLS = new Set([
  'eslint',
  'flake8',
  'pylint',
  'mypy',
  'ruff',
  'biome',
  'stylelint',
  'golangci-lint',
  'rubocop',
  'phpcs',
  'hadolint',
  'markdownlint',
  'oxlint',
  'tslint',
  'prettier',
])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
])

const GIT_MUTATING_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'merge',
  'rebase',
  'reset',
  'revert',
  'cherry-pick',
  'apply',
  'am',
  'checkout',
  'switch',
  'restore',
  'stash',
  'clean',
  'rm',
  'mv',
  'pull',
  'init',
  'clone',
])

const MUTATING_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'mkdir',
  'rmdir',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'ln',
  'truncate',
  'dd',
  'tee',
  'install',
  'patch',
  'rsync',
  'unzip',
  'zip',
  'tar',
  'gzip',
  'gunzip',
  'shred',
  'rename',
  'mv',
  'ln',
  'useradd',
  'userdel',
  'chattr',
  'setfacl',
])

const DEPENDENCY_SUBCOMMANDS: Record<string, string[]> = {
  npm: ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'upgrade', 'dedupe', 'link', 'ci', 'pkg', 'version'],
  pnpm: ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'dedupe', 'link', 'import'],
  yarn: ['add', 'install', 'remove', 'upgrade', 'up', 'dedupe', 'import'],
  bun: ['add', 'install', 'remove', 'update', 'link'],
  pip: ['install', 'uninstall', 'download'],
  pip3: ['install', 'uninstall', 'download'],
  poetry: ['add', 'remove', 'install', 'update', 'lock'],
  uv: ['add', 'remove', 'sync', 'lock'],
  cargo: ['add', 'remove', 'update', 'install'],
  composer: ['require', 'install', 'update', 'remove'],
  bundle: ['add', 'install', 'update'],
  gem: ['install', 'uninstall', 'update'],
  conda: ['install', 'update', 'remove'],
  dotnet: ['add', 'remove', 'restore'],
  nuget: ['install', 'restore'],
  go: ['get', 'mod'],
}

function baseName(command: string): string {
  return posixBasename(command).toLowerCase()
}

/** Skip shell wrappers (`sudo`, `env`, `timeout`...) to reach the real command. */
function unwrap(segment: CommandSegment): { name: string; args: string[] } {
  let name = baseName(segment.name)
  let args = segment.args.slice()
  let guard = 0
  while (WRAPPER_COMMANDS.has(name) && guard < 4) {
    guard += 1
    // common wrapper flags with values
    while (args.length > 0 && /^-/.test(args[0]!)) {
      const flag = args[0]!
      args.shift()
      if (['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-n', '-s'].includes(flag) && args.length > 0 && name === 'sudo') {
        args.shift()
      }
    }
    if (name === 'timeout' && args.length > 0) args.shift()
    // leading VAR=value assignments (env)
    while (args.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) args.shift()
    if (args.length === 0) return { name, args }
    name = baseName(args[0]!)
    args = args.slice(1)
  }
  return { name, args }
}

interface GitInvocation {
  subcommand: string
  subArgs: string[]
}

/** Parse `git [-C dir] [-c k=v] <subcommand> ...`. */
function gitInvocation(args: string[]): GitInvocation | null {
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--') {
      i += 1
      break
    }
    if (arg.startsWith('-')) {
      if (GIT_GLOBAL_WITH_VALUE.has(arg)) i += 2
      else i += 1
      continue
    }
    return { subcommand: arg, subArgs: args.slice(i + 1) }
  }
  return null
}

function isOutputRedirect(segment: CommandSegment, target: string): boolean {
  return segment.redirects.includes(target) && !DEV_NULL_TARGETS.has(target)
}

function packageManagerSubcommand(name: string, args: string[]): string {
  const sub = args.find((arg) => !arg.startsWith('-')) ?? ''
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    if (sub === 'run' || sub === 'run-script') {
      const script = args[args.indexOf(sub) + 1] ?? ''
      return `run:${script}`
    }
  }
  return sub
}

function isTestSegment(name: string, args: string[]): boolean {
  if (TEST_RUNNERS.has(name)) return true
  if (name === 'python' || name === 'python3') {
    return args[0] === '-m' && ['pytest', 'unittest', 'nose', 'nose2'].includes(args[1] ?? '')
  }
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    return TEST_RUNNERS.has(baseName(args[0] ?? ''))
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = packageManagerSubcommand(name, args)
    if (sub === 'test' || sub === 't' || sub === 'run:test' || sub.startsWith('run:test:')) return true
    // `pnpm vitest run` / `yarn jest` run a local test binary directly
    const direct = args.find((arg) => !arg.startsWith('-')) ?? ''
    return TEST_RUNNERS.has(baseName(direct))
  }
  if (name === 'mvn' || name === 'mvnw') {
    return args.some(
      (arg) =>
        arg === 'test' ||
        arg === 'verify' ||
        arg === 'integration-test' ||
        arg.startsWith('test=') ||
        arg.startsWith('-Dtest='),
    )
  }
  if (name === 'gradle' || name === 'gradlew') {
    return args.some((arg) => ['test', 'check', 'integrationTest', 'testAll'].includes(arg))
  }
  if (name === 'go') return args[0] === 'test'
  if (name === 'cargo') return args[0] === 'test' || args[0] === 'nextest'
  if (name === 'dotnet') return args[0] === 'test'
  if (name === 'make') return args.some((arg) => arg === 'test' || arg === 'check' || arg === 'test-all')
  return false
}

function isBuildSegment(name: string, args: string[]): boolean {
  if (name === 'tsc') return true
  if (BUILD_TOOLS.has(name)) {
    if (name === 'mvn' || name === 'mvnw') {
      return args.some((arg) => ['package', 'compile', 'install', 'verify'].includes(arg))
    }
    if (name === 'gradle' || name === 'gradlew') {
      return args.some((arg) => ['build', 'assemble', 'jar', 'war'].includes(arg))
    }
    if (name === 'vite' || name === 'next' || name === 'turbo' || name === 'nx') return args[0] === 'build'
    if (name === 'cmake') return args.includes('--build') || args.includes('build')
    if (name === 'gradlew' || name === 'gradle') return args.some((arg) => arg === 'build')
    return true
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = packageManagerSubcommand(name, args)
    if (sub === 'build' || sub === 'run:build' || sub.startsWith('run:build:')) return true
    const direct = args.find((arg) => !arg.startsWith('-')) ?? ''
    return BUILD_TOOLS.has(baseName(direct)) || baseName(direct) === 'tsc'
  }
  if (name === 'go') return args[0] === 'build'
  if (name === 'cargo') return args[0] === 'build'
  if (name === 'dotnet') return args[0] === 'build' || args[0] === 'publish'
  if (name === 'make') return args.some((arg) => arg === 'build' || arg === 'all')
  return false
}

function isLintSegment(name: string, args: string[]): boolean {
  if (name === 'prettier') {
    // `prettier --write` mutates files, only check mode is lint
    return !args.some((arg) => arg === '--write' || arg === '-w')
  }
  if (name === 'eslint') return true
  if (LINT_TOOLS.has(name)) return true
  if (PACKAGE_MANAGERS.has(name)) {
    const direct = args.find((arg) => !arg.startsWith('-')) ?? ''
    return LINT_TOOLS.has(baseName(direct))
  }
  if (name === 'go') return args[0] === 'vet'
  if (name === 'cargo') return args[0] === 'clippy'
  if (name === 'gofmt') return !args.some((arg) => arg === '-w')
  if (name === 'mvn' || name === 'mvnw') {
    return args.some((arg) => arg === 'spotless:check' || arg === 'checkstyle:check')
  }
  if (name === 'gradle' || name === 'gradlew') {
    return args.some((arg) => arg === 'spotlessCheck' || arg === 'checkstyleMain' || arg === 'lint')
  }
  if (name === 'ruff') return args[0] !== 'format'
  if (name === 'biome') return args[0] === 'check' || args[0] === 'lint'
  if (name === 'dotnet') return args[0] === 'format' && args.includes('--verify-no-changes')
  if (name === 'make') return args.some((arg) => arg === 'lint')
  return false
}

function isDependencySegment(name: string, args: string[]): boolean {
  const table = DEPENDENCY_SUBCOMMANDS[name]
  if (table) {
    const sub = packageManagerSubcommand(name, args)
    if (table.includes(sub)) return true
    if (name === 'go') {
      if (sub === 'get') return true
      if (sub === 'mod') {
        const modSub = args[args.indexOf('mod') + 1] ?? ''
        return ['tidy', 'download', 'edit'].includes(modSub)
      }
    }
    if (name === 'dotnet') {
      return (
        (sub === 'add' || sub === 'remove') &&
        args[args.indexOf(sub) + 1] === 'package'
      )
    }
    if (name === 'uv' && sub === 'pip') {
      const pipSub = args[args.indexOf('pip') + 1] ?? ''
      return pipSub === 'install' || pipSub === 'uninstall'
    }
    return table.includes(sub)
  }
  return false
}

function isMutatingSegment(segment: CommandSegment, name: string, args: string[]): boolean {
  if (segment.redirects.some((target) => !DEV_NULL_TARGETS.has(target))) return true
  if (MUTATING_COMMANDS.has(name)) return true
  if (name === 'sed') {
    return args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg.startsWith('--in-place'))
  }
  if (name === 'perl') return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')
  if (name === 'yq' || name === 'jq') return args.some((arg) => arg === '-i' || arg === '--inplace')
  if (name === 'find') return args.includes('-delete') || args.some((arg) => arg === '-exec' || arg === '-execdir')
  if (name === 'gofmt' || name === 'goimports') return args.includes('-w')
  if (name === 'eslint') return args.some((arg) => arg === '--fix' || arg === '--fix-dry-run')
  if (name === 'prettier') return args.some((arg) => arg === '--write' || arg === '-w')
  if (name === 'ruff') return args[0] === 'format' || args.includes('--fix')
  if (name === 'biome') return args[0] === 'format' || args.includes('--write')
  if (name === 'black' || name === 'autopep8' || name === 'isort') return true
  if (name === 'git') {
    const invocation = gitInvocation(args)
    if (!invocation) return false
    return GIT_MUTATING_SUBCOMMANDS.has(invocation.subcommand)
  }
  if (name === 'mvn' || name === 'mvnw') return args.includes('clean')
  if (name === 'gradle' || name === 'gradlew') return args.includes('clean')
  if (name === 'make') {
    return !args.some((arg) => ['test', 'check', 'build', 'all', 'lint', 'format'].includes(arg))
  }
  return false
}

function dangerousRmTarget(target: string): boolean {
  if (target === '') return true
  if (['/', '~', '*', '.', '..', './', '../', '/*', '~/*', '/**'].includes(target)) return true
  if (target.startsWith('/')) return true
  if (target.startsWith('~')) return true
  if (target.startsWith('..')) return true
  if (target.includes('$') || target.includes('*') || target.includes('?')) return true
  return false
}

function hasRecursiveForce(args: string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith('-') && arg !== '--')
  let recursive = false
  let force = false
  for (const flag of flags) {
    if (flag === '--recursive') recursive = true
    else if (flag === '--force') force = true
    else if (!flag.startsWith('--')) {
      if (flag.includes('r') || flag.includes('R')) recursive = true
      if (flag.includes('f')) force = true
    }
  }
  return recursive && force
}

function isDangerousSql(name: string, args: string[]): boolean {
  if (!SQL_CLIENTS.has(name)) return false
  const joined = args.join(' ')
  return /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLUMN|SEQUENCE)?/i.test(joined)
}

/** Human-readable reasons why a command line is dangerous (empty when safe). */
export function dangerousCommandReasons(command: string): string[] {
  const segments = parseCommandLine(command)
  const reasons: string[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!
    const { name, args } = unwrap(segment)
    if (name === '') continue
    if (name === 'rm' && hasRecursiveForce(args)) {
      const targets = args.filter((arg) => !arg.startsWith('-'))
      if (targets.length === 0 || targets.some((target) => dangerousRmTarget(target))) {
        reasons.push('rm -rf 作用于仓库根/仓库外/未知路径')
      }
    }
    if (name === 'git') {
      const invocation = gitInvocation(args)
      if (invocation) {
        if (invocation.subcommand === 'reset' && invocation.subArgs.includes('--hard')) {
          reasons.push('git reset --hard 会丢弃未提交改动')
        }
        if (invocation.subcommand === 'clean') {
          const flags = invocation.subArgs.filter((arg) => arg.startsWith('-')).join('')
          if (/[fdxX]/.test(flags)) {
            reasons.push('git clean 会删除未跟踪/被忽略文件（可能删掉 .flowgate/）')
          }
        }
        if (invocation.subcommand === 'push') {
          const forced = invocation.subArgs.some(
            (arg) =>
              arg === '--force' ||
              arg === '-f' ||
              arg.startsWith('--force-with-lease') ||
              arg.startsWith('--force-if-includes'),
          )
          if (forced) reasons.push('git push --force 会覆盖远端历史')
        }
      }
    }
    if (name === 'chmod' && args.some((arg) => arg === '-R' || arg === '--recursive') && args.includes('777')) {
      reasons.push('chmod -R 777 会把权限放大到所有人')
    }
    if (name === 'rsync' && args.some((arg) => arg.startsWith('--delete'))) {
      reasons.push('rsync --delete 会删除目标侧文件')
    }
    if (isDangerousSql(name, args)) {
      reasons.push('SQL DROP/TRUNCATE 会破坏数据结构')
    }
    if ((name === 'curl' || name === 'wget') && segments[index + 1]?.separator === '|') {
      const next = unwrap(segments[index + 1]!)
      if (PIPE_INTERPRETERS.has(next.name)) {
        reasons.push(`${name} … | ${next.name} 属于"下载即执行"`)
      }
    }
    if (name.startsWith('mkfs')) reasons.push('mkfs 会格式化文件系统')
    if (name === 'dd') {
      const of = args.find((arg) => arg.startsWith('of='))
      if (of) {
        const target = of.slice(3)
        if (target.startsWith('/dev/') || target === '/') reasons.push('dd 直接写块设备')
      }
    }
  }
  return reasons
}

/** True when the command line contains a dangerous command (03 §8.2). */
export function isDangerousCommand(command: string): boolean {
  return dangerousCommandReasons(command).length > 0
}

/** True for `git push`, PR creation commands and similar publication actions. */
export function isPushCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (name === 'git') {
      const invocation = gitInvocation(args)
      if (invocation?.subcommand === 'push') return true
      continue
    }
    if (name === 'gh' || name === 'glab') {
      const sub = args.filter((arg) => !arg.startsWith('-'))
      if (sub[0] === 'pr' && ['create', 'merge', 'ready', 'reopen'].includes(sub[1] ?? '')) return true
      if (name === 'gh' && sub[0] === 'release' && sub[1] === 'create') return true
      continue
    }
    if (name === 'hub' && args[0] === 'pull-request') return true
  }
  return false
}

/** True when the command line changes dependency manifests/lockfiles. */
export function isDependencyCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (isDependencySegment(name, args)) return true
  }
  return false
}

/** True when the command line runs tests. */
export function isTestCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (isTestSegment(name, args)) return true
  }
  return false
}

/** True when the command line builds the project. */
export function isBuildCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (isBuildSegment(name, args)) return true
  }
  return false
}

/** True when the command line lints/type-checks the project. */
export function isLintCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (isLintSegment(name, args)) return true
  }
  return false
}

/** True when the command line may modify the working tree. */
export function isMutatingCommand(command: string): boolean {
  const segments = parseCommandLine(command)
  if (segments.length === 0) return false
  if (isDangerousCommand(command)) return true
  if (isDependencyCommand(command)) return true
  for (const segment of segments) {
    const { name, args } = unwrap(segment)
    if (isMutatingSegment(segment, name, args)) return true
  }
  return false
}

/**
 * True for revert-shaped commands that undo working-tree changes
 * (`git checkout -- <path>`, `git restore <path>`, `git reset -- <path>`).
 * These must stay allowed so an agent can recover from an out-of-scope edit.
 */
export function isRevertCommand(command: string): boolean {
  for (const segment of parseCommandLine(command)) {
    const { name, args } = unwrap(segment)
    if (name !== 'git') continue
    const invocation = gitInvocation(args)
    if (!invocation) continue
    if (invocation.subcommand === 'restore') return true
    if (invocation.subcommand === 'checkout') {
      if (invocation.subArgs.includes('--')) return true
      if (invocation.subArgs.some((arg) => arg.startsWith('--source'))) return true
    }
    if (invocation.subcommand === 'reset' && invocation.subArgs.includes('--')) return true
  }
  return false
}

/** Classify a command line into every applicable class (03 §4.3). */
export function classifyShellCommand(command: string): ShellCommandClass[] {
  const segments = parseCommandLine(command)
  if (segments.length === 0) return []
  const classes = new Set<ShellCommandClass>()
  if (isDangerousCommand(command)) classes.add('dangerous')
  if (isPushCommand(command)) classes.add('push')
  if (isDependencyCommand(command)) classes.add('dependency')
  if (isTestCommand(command)) classes.add('test')
  if (isBuildCommand(command)) classes.add('build')
  if (isLintCommand(command)) classes.add('lint')
  const mutating = segments.some((segment) => {
    const { name, args } = unwrap(segment)
    return isMutatingSegment(segment, name, args)
  })
  if (mutating) classes.add('mutating')
  if (classes.size === 0) classes.add('readonly')
  return [...classes]
}

/**
 * Restrict verify command shape (FR-5.11): one simple command, no `&&`, `||`,
 * `;`, pipes, redirects, command substitution or background execution — these
 * hide failures (`npm test || true`, `mvn test | tee log`).
 */
export function validateVerifyCommand(command: string): { ok: boolean; reason?: string } {
  const raw = command.trim()
  if (raw === '') {
    return { ok: false, reason: '验证命令为空：请在任务卡 verify 组或 project.md 里写明一条可执行的测试命令。' }
  }
  const shapeChecks: { pattern: RegExp; label: string }[] = [
    { pattern: /&&/, label: '&&' },
    { pattern: /\|\|/, label: '||' },
    { pattern: /;/, label: ';' },
    { pattern: /\|/, label: '管道 |' },
    { pattern: /`/, label: '反引号命令替换' },
    { pattern: /\$\(/, label: '命令替换 $()' },
    { pattern: /\n/, label: '换行' },
    { pattern: /[<>]/, label: '重定向 < >' },
  ]
  for (const check of shapeChecks) {
    if (check.pattern.test(raw)) {
      return {
        ok: false,
        reason: `验证命令不能包含 ${check.label}：这些写法会掩盖失败（例如 npm test || true），请只写一条命令，例如 ./mvnw -B test 或 pnpm vitest run。`,
      }
    }
  }
  const parsed = parseCommands(raw)
  if (parsed.length !== 1) {
    return {
      ok: false,
      reason: '验证命令只能是一条命令：不能串联多条命令或使用管道，请拆成任务卡里多个验证组。',
    }
  }
  const only = parsed[0]!
  if (only.redirects.length > 0) {
    return { ok: false, reason: '验证命令不能包含输出重定向，完整输出由 FlowGate 自己保存。' }
  }
  if (only.background) {
    return { ok: false, reason: '验证命令不能后台执行（&），插件需要拿到退出码和完整输出。' }
  }
  return { ok: true }
}

function devNull(target: string): boolean {
  return DEV_NULL_TARGETS.has(target)
}

function inPlaceFiles(args: string[]): string[] {
  const scriptViaFlag = args.some((arg) =>
    ['-e', '--expression', '-f', '--file'].includes(arg),
  )
  const nonFlags: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (['-e', '--expression', '-f', '--file'].includes(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    nonFlags.push(arg)
  }
  return scriptViaFlag ? nonFlags : nonFlags.slice(1)
}

/**
 * Extract likely file write targets for hinting and post-check attribution:
 * output redirects, `tee`, `sed -i`, `cp`/`mv`/`rsync` destinations, `dd of=`.
 * `node -e "const f = x => x * 2"` and `echo "=> x"` must not produce targets.
 */
export function extractWriteTargets(command: string): string[] {
  const targets: string[] = []
  const push = (value: string | undefined): void => {
    if (!value) return
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.startsWith('-') || devNull(trimmed)) return
    if (/^&\d+$/.test(trimmed)) return
    targets.push(trimmed)
  }
  for (const segment of parseCommandLine(command)) {
    for (const redirect of segment.redirects) push(redirect)
    const { name, args } = unwrap(segment)
    const nonFlags = args.filter((arg) => !arg.startsWith('-'))
    switch (name) {
      case 'tee':
        nonFlags.forEach(push)
        break
      case 'sed':
      case 'perl':
        if (
          name === 'sed'
            ? args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg.startsWith('--in-place'))
            : args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')
        ) {
          inPlaceFiles(args).forEach(push)
        }
        break
      case 'cp':
      case 'mv':
      case 'ln':
      case 'install':
      case 'rsync':
      case 'scp':
        push(nonFlags[nonFlags.length - 1])
        break
      case 'dd': {
        const of = args.find((arg) => arg.startsWith('of='))
        push(of?.slice(3))
        break
      }
      case 'truncate':
        push(nonFlags[nonFlags.length - 1])
        break
      case 'touch':
      case 'mkdir':
      case 'rmdir':
      case 'rm':
        nonFlags.forEach(push)
        break
      case 'chmod':
      case 'chown':
      case 'chgrp':
        nonFlags.slice(1).forEach(push)
        break
      case 'gofmt':
        if (args.includes('-w')) nonFlags.forEach(push)
        break
      default:
        break
    }
  }
  return [...new Set(targets)]
}

/** Re-exported types used by callers. */
export type { CommandSegment, ParsedCommand }
export { parseCommands }
