/**
 * Evidence-based tech-stack detection for `/flow init`.
 *
 * Every detected fact carries a citation to the file/line actually read, so
 * `project.md` can mark each statement as 已确认 / 代码推导 / 待确认 instead of
 * pretending everything is confirmed. No external dependencies are used.
 */
import type {
  CitationRef,
  CommandSettings,
  ProjectModuleInfo,
  SourceFact,
} from '../types'
import type { FileSystem } from '../util/fs'
import { posixBasename, posixJoin, normalizeRelPath } from '../util/paths'

export interface DetectedStack {
  kind: 'maven' | 'gradle' | 'node' | 'python' | 'go' | 'rust' | 'unknown'
  name: string
  stackFacts: SourceFact[]
  commands: CommandSettings
  modules: ProjectModuleInfo[]
  readFiles: string[]
  risks: string[]
}

const IGNORED_TOP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.flowgate',
  '.idea',
  '.vscode',
  '.github',
  '.gitlab',
  '.circleci',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  'vendor',
  'tmp',
  'temp',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'bin',
  'obj',
])

const MODULE_DIR_HINTS = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'packages',
  'modules',
  'module',
  'server',
  'client',
  'web',
  'api',
  'core',
  'services',
  'service',
  'cmd',
  'internal',
  'pkg',
  'components',
  'pages',
  'tests',
  'test',
  'docs',
  'scripts',
  'deploy',
  'infra',
])

function statusLabel(status: SourceFact['status']): string {
  switch (status) {
    case 'confirmed':
      return '已确认'
    case 'derived':
      return '代码推导'
    case 'assumption':
      return '假设'
    default:
      return '待确认'
  }
}

function citationAt(file: string, content: string, pattern: RegExp): CitationRef | undefined {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (pattern.test(line)) {
      return { file, startLine: index + 1, endLine: index + 1, quote: line.trim() }
    }
  }
  return undefined
}

function citationRange(file: string, content: string, startIndex: number, endIndex?: number): CitationRef | undefined {
  const lines = content.split(/\r?\n/)
  if (startIndex < 0 || startIndex >= lines.length) return undefined
  const end = Math.min(lines.length - 1, endIndex ?? startIndex)
  return {
    file,
    startLine: startIndex + 1,
    endLine: end + 1,
    quote: lines.slice(startIndex, end + 1).join('\n').trim(),
  }
}

function fact(text: string, citations: CitationRef[]): SourceFact {
  const usable = citations.filter((citation) => citation.file !== '')
  return { text, citations: usable, status: usable.length > 0 ? 'confirmed' : 'derived' }
}

/** Read a file if it exists; record it in `readFiles` when it does. */
async function readIfExists(
  fs: FileSystem,
  root: string,
  relative: string,
  readFiles: string[],
): Promise<string | null> {
  const path = posixJoin(root, relative)
  try {
    if (!(await fs.exists(path))) return null
    const content = await fs.readFile(path)
    if (!readFiles.includes(relative)) readFiles.push(relative)
    return content
  } catch {
    return null
  }
}

async function exists(fs: FileSystem, root: string, relative: string): Promise<boolean> {
  try {
    return await fs.exists(posixJoin(root, relative))
  } catch {
    return false
  }
}

async function topLevelDirs(fs: FileSystem, root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root)
    const dirs: string[] = []
    for (const entry of entries) {
      if (IGNORED_TOP_DIRS.has(entry)) continue
      if (!MODULE_DIR_HINTS.has(entry)) continue
      if (dirs.length >= 20) break
      dirs.push(entry)
    }
    return dirs
  } catch {
    return []
  }
}

function responsibilityFromReadme(readme: string | null, modulePath: string): string {
  if (!readme) return '待确认（未读取模块说明）'
  const base = normalizeRelPath(modulePath).split('/').pop() ?? modulePath
  for (const rawLine of readme.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const cleaned = line.replace(/^[-*+]\s+/, '')
    const match = /^`?([^`\s:：|—–]+)`?\s*(?:[:：|—–-]|\s{2,})\s*(.+)$/.exec(cleaned)
    if (!match) continue
    if (match[1] === modulePath || match[1] === base || match[1]!.replace(/\/+$/, '') === modulePath) {
      return match[2]!.trim()
    }
  }
  return '待确认（未读取模块说明）'
}

function modulesFromDirs(dirs: string[], readme: string | null, prefix = ''): ProjectModuleInfo[] {
  return dirs.map((dir) => ({
    path: normalizeRelPath(prefix === '' ? dir : `${prefix}/${dir}`),
    responsibility: responsibilityFromReadme(readme, dir),
  }))
}

// ---------------------------------------------------------------------------
// Maven
// ---------------------------------------------------------------------------

async function detectMaven(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const pom = (await readIfExists(fs, root, 'pom.xml', readFiles)) ?? ''
  const hasWrapper = await exists(fs, root, 'mvnw')
  if (hasWrapper) await readIfExists(fs, root, 'mvnw', readFiles)
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const prefix = hasWrapper ? './mvnw' : 'mvn'
  const facts: SourceFact[] = []
  facts.push(fact(`Maven 项目（pom.xml 存在；使用 ${hasWrapper ? './mvnw' : '系统 mvn'}）`, [
    citationAt('pom.xml', pom, /<artifactId>|<project/i) ?? citationRange('pom.xml', pom, 0),
  ].filter((citation): citation is CitationRef => citation !== undefined)))

  const pomWithoutParent = pom.replace(/<parent>[\s\S]*?<\/parent>/i, '')
  const artifactId =
    /<artifactId>([^<]+)<\/artifactId>/.exec(pomWithoutParent)?.[1]?.trim() ??
    /<artifactId>([^<]+)<\/artifactId>/.exec(pom)?.[1]?.trim() ??
    ''
  const parentIndex = pom.split(/\r?\n/).findIndex((line) => /<artifactId>spring-boot-starter-parent<\/artifactId>/.test(line))
  if (parentIndex >= 0) {
    const lines = pom.split(/\r?\n/)
    let versionIndex = -1
    for (let i = parentIndex; i < Math.min(lines.length, parentIndex + 6); i += 1) {
      if (/<version>/.test(lines[i]!)) {
        versionIndex = i
        break
      }
    }
    const version = versionIndex >= 0 ? /<version>([^<]+)<\/version>/.exec(lines[versionIndex]!)![1]!.trim() : ''
    facts.push(
      fact(`Spring Boot${version !== '' ? ` ${version}` : ''}（spring-boot-starter-parent）`, [
        versionIndex >= 0 ? citationRange('pom.xml', pom, parentIndex, versionIndex) : citationRange('pom.xml', pom, parentIndex),
      ].filter((citation): citation is CitationRef => citation !== undefined)),
    )
  }

  const javaVersion =
    /<java\.version>([^<]+)<\/java\.version>/.exec(pom)?.[1]?.trim() ??
    /<maven\.compiler\.(?:source|release)>([^<]+)<\/maven\.compiler\.(?:source|release)>/.exec(pom)?.[1]?.trim() ??
    ''
  if (javaVersion !== '') {
    facts.push(fact(`Java ${javaVersion}`, [
      citationAt('pom.xml', pom, /<java\.version>|<maven\.compiler\.(?:source|release)>/),
    ].filter((citation): citation is CitationRef => citation !== undefined)))
  }

  const commands: CommandSettings = {
    test: `${prefix} -B test`,
    integration: `${prefix} -B verify`,
    build: `${prefix} -B -DskipTests package`,
  }
  if (/spotless/i.test(pom)) commands.lint = `${prefix} -q spotless:check`
  else if (/checkstyle/i.test(pom)) commands.lint = `${prefix} -q checkstyle:check`
  if (/spring-boot-maven-plugin/i.test(pom)) commands.run = `${prefix} -q spring-boot:run`

  const modules: ProjectModuleInfo[] = []
  const moduleMatches = pom.matchAll(/<module>([^<]+)<\/module>/g)
  for (const match of moduleMatches) {
    modules.push({ path: normalizeRelPath(match[1]!.trim()), responsibility: '待确认（pom.xml 子模块）' })
  }
  if (modules.length === 0) {
    const dirs = await topLevelDirs(fs, root)
    modules.push(...modulesFromDirs(dirs.filter((dir) => dir !== 'src'), readme))
  }

  const risks: string[] = []
  if (!hasWrapper) risks.push('未发现 Maven Wrapper（mvnw）：CI 与本地 Maven 版本可能不一致')
  if (/spotless/i.test(pom)) {
    // commands.lint already set; no extra risk
  }
  return {
    kind: 'maven',
    name: artifactId || posixBasename(root) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks,
  }
}

// ---------------------------------------------------------------------------
// Gradle
// ---------------------------------------------------------------------------

async function detectGradle(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const buildFile = (await readIfExists(fs, root, 'build.gradle', readFiles))
    ?? (await readIfExists(fs, root, 'build.gradle.kts', readFiles))
    ?? ''
  const buildName = buildFile.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'
  const settings = (await readIfExists(fs, root, 'settings.gradle', readFiles))
    ?? (await readIfExists(fs, root, 'settings.gradle.kts', readFiles))
  const hasWrapper = await exists(fs, root, 'gradlew')
  if (hasWrapper) await readIfExists(fs, root, 'gradlew', readFiles)
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const prefix = hasWrapper ? './gradlew' : 'gradle'
  const facts: SourceFact[] = [
    fact(`Gradle 项目（${buildName}）`, [citationAt(buildName, buildFile, /plugins|java|kotlin|application/i) ?? citationRange(buildName, buildFile, 0)].filter(
      (citation): citation is CitationRef => citation !== undefined,
    )),
    fact(`Gradle Wrapper ${hasWrapper ? '已就绪（./gradlew）' : '缺失（使用系统 gradle）'}`, [
      citationRange(buildName, buildFile, 0),
    ].filter((citation): citation is CitationRef => citation !== undefined)),
  ]
  const javaVersion =
    /sourceCompatibility\s*=\s*['"]?([0-9.]+)/.exec(buildFile)?.[1] ??
    /JavaLanguageVersion\.of\((\d+)\)/.exec(buildFile)?.[1] ??
    ''
  if (javaVersion !== '') {
    facts.push(fact(`Java ${javaVersion}`, [
      citationAt(buildName, buildFile, /sourceCompatibility|JavaLanguageVersion/),
    ].filter((citation): citation is CitationRef => citation !== undefined)))
  }
  const commands: CommandSettings = {
    test: `${prefix} test --rerun-tasks`,
    build: `${prefix} build`,
  }
  if (/spotless/i.test(buildFile)) commands.lint = `${prefix} spotlessCheck`
  else if (/ktlint/i.test(buildFile)) commands.lint = `${prefix} ktlintCheck`
  if (/org\.springframework\.boot|spring-boot/i.test(buildFile)) commands.run = `${prefix} bootRun`

  const modules: ProjectModuleInfo[] = []
  if (settings) {
    for (const match of settings.matchAll(/include\s*\(?\s*['"]:?([^'"]+)['"]/g)) {
      modules.push({ path: normalizeRelPath(match[1]!.replace(/:/g, '/')), responsibility: '待确认（settings 子项目）' })
    }
    const rootName = /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(settings)?.[1]?.trim()
    if (rootName) facts.push(fact(`Gradle 根项目 ${rootName}`, [citationAt('settings.gradle', settings, /rootProject\.name/)].filter(
      (citation): citation is CitationRef => citation !== undefined,
    )))
  }
  if (modules.length === 0) {
    modules.push(...modulesFromDirs((await topLevelDirs(fs, root)).filter((dir) => dir !== 'src'), readme))
  }
  const risks: string[] = []
  if (!hasWrapper) risks.push('未发现 Gradle Wrapper（gradlew）：CI 与本地 Gradle 版本可能不一致')
  return {
    kind: 'gradle',
    name: posixBasename(root) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks,
  }
}

// ---------------------------------------------------------------------------
// Node.js
// ---------------------------------------------------------------------------

type PackageManager = 'pnpm' | 'npm' | 'yarn'

async function detectPackageManager(fs: FileSystem, root: string): Promise<{ pm: PackageManager; source: string }> {
  if (await exists(fs, root, 'pnpm-lock.yaml')) return { pm: 'pnpm', source: 'pnpm-lock.yaml' }
  if (await exists(fs, root, 'yarn.lock')) return { pm: 'yarn', source: 'yarn.lock' }
  if (await exists(fs, root, 'package-lock.json')) return { pm: 'npm', source: 'package-lock.json' }
  if (await exists(fs, root, 'pnpm-workspace.yaml')) return { pm: 'pnpm', source: 'pnpm-workspace.yaml' }
  return { pm: 'npm', source: '' }
}

function runScript(pm: PackageManager, script: string): string {
  if (pm === 'pnpm') return `pnpm ${script}`
  if (pm === 'yarn') return `yarn ${script}`
  if (script === 'test') return 'npm test'
  if (script === 'start') return 'npm start'
  return `npm run ${script}`
}

function execBin(pm: PackageManager, bin: string, args: string): string {
  if (pm === 'pnpm') return `pnpm exec ${bin}${args !== '' ? ` ${args}` : ''}`
  if (pm === 'yarn') return `yarn ${bin}${args !== '' ? ` ${args}` : ''}`
  return `npx ${bin}${args !== '' ? ` ${args}` : ''}`
}

async function detectNode(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const pkgText = (await readIfExists(fs, root, 'package.json', readFiles)) ?? '{}'
  let pkg: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(pkgText) as unknown
    if (parsed !== null && typeof parsed === 'object') pkg = parsed as Record<string, unknown>
  } catch {
    pkg = {}
  }
  const { pm, source: pmSource } = await detectPackageManager(fs, root)
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const scripts =
    pkg.scripts !== null && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {}
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) }
  const depNames = new Set(Object.keys(deps ?? {}))
  const hasScript = (name: string): boolean => typeof scripts[name] === 'string' && String(scripts[name]).trim() !== ''

  const testFrameworks: string[] = []
  if (depNames.has('vitest') || (await exists(fs, root, 'vitest.config.ts')) || (await exists(fs, root, 'vitest.config.js'))) {
    testFrameworks.push('vitest')
  }
  if (depNames.has('jest') || (await exists(fs, root, 'jest.config.js')) || (await exists(fs, root, 'jest.config.ts'))) {
    testFrameworks.push('jest')
  }
  if (depNames.has('mocha')) testFrameworks.push('mocha')
  if (depNames.has('@playwright/test')) testFrameworks.push('playwright')

  const commands: CommandSettings = {}
  let testNone = false
  if (hasScript('test')) commands.test = runScript(pm, 'test')
  else if (testFrameworks.includes('vitest')) commands.test = execBin(pm, 'vitest', 'run')
  else if (testFrameworks.includes('jest')) commands.test = execBin(pm, 'jest', '--ci')
  else if (testFrameworks.includes('mocha')) commands.test = execBin(pm, 'mocha', '')
  else if (testFrameworks.includes('playwright')) commands.test = execBin(pm, 'playwright', 'test')
  else {
    commands.test = 'none'
    testNone = true
  }
  if (hasScript('lint')) commands.lint = runScript(pm, 'lint')
  else if (depNames.has('eslint')) commands.lint = execBin(pm, 'eslint', '.')
  else if (depNames.has('biome') || depNames.has('@biomejs/biome')) commands.lint = execBin(pm, 'biome', 'check .')
  if (hasScript('build')) commands.build = runScript(pm, 'build')
  if (hasScript('typecheck')) commands.typecheck = runScript(pm, 'typecheck')
  else if (hasScript('type-check')) commands.typecheck = runScript(pm, 'type-check')
  else if (depNames.has('typescript') && ((await exists(fs, root, 'tsconfig.json')) || (await exists(fs, root, 'tsconfig.build.json')))) {
    commands.typecheck = execBin(pm, 'tsc', '--noEmit')
  }
  if (hasScript('dev')) commands.run = runScript(pm, 'dev')
  else if (hasScript('start')) commands.run = runScript(pm, 'start')

  const facts: SourceFact[] = []
  const pkgName = typeof pkg.name === 'string' ? pkg.name : ''
  const pkgVersion = typeof pkg.version === 'string' ? pkg.version : ''
  facts.push(
    fact(`Node.js 项目${pkgName !== '' ? `（${pkgName}${pkgVersion !== '' ? `@${pkgVersion}` : ''}）` : ''}`, [
      citationAt('package.json', pkgText, /"name"|"version"/) ?? citationRange('package.json', pkgText, 0),
    ].filter((citation): citation is CitationRef => citation !== undefined)),
  )
  if (pmSource !== '') {
    const lockText = (await readIfExists(fs, root, pmSource, readFiles)) ?? ''
    facts.push(
      fact(`包管理器：${pm}（${pmSource}）`, [citationRange(pmSource, lockText, 0)].filter(
        (citation): citation is CitationRef => citation !== undefined,
      )),
    )
  } else {
    facts.push(fact('包管理器：未发现锁文件，默认使用 npm', []))
  }
  if (testFrameworks.length > 0) {
    const framework = testFrameworks[0]!
    facts.push(
      fact(`测试框架：${framework}`, [
        citationAt('package.json', pkgText, new RegExp(`"${framework}"`)) ?? citationRange('package.json', pkgText, 0),
      ].filter((citation): citation is CitationRef => citation !== undefined)),
    )
  }

  const modules: ProjectModuleInfo[] = []
  const workspaces = Array.isArray(pkg.workspaces)
    ? (pkg.workspaces as unknown[])
    : pkg.workspaces !== null && typeof pkg.workspaces === 'object'
      ? ((pkg.workspaces as Record<string, unknown>).packages as unknown[] | undefined) ?? []
      : []
  for (const raw of workspaces) {
    const pattern = String(raw).replace(/\/\*\*?$/, '')
    if (pattern === '' || pattern.includes('*')) continue
    if (!modules.some((module) => module.path === normalizeRelPath(pattern))) {
      modules.push({ path: normalizeRelPath(pattern), responsibility: '待确认（workspaces）' })
    }
  }
  if (modules.length === 0) {
    modules.push(...modulesFromDirs(await topLevelDirs(fs, root), readme))
  }

  const risks: string[] = []
  if (testNone) risks.push('缺少自动化测试：未发现测试脚本或测试框架，请在 project.md 中写 test: none 并以构建 / 类型检查 / lint 作为基线')
  if (pmSource === '') risks.push('未发现依赖锁文件：依赖版本不可复现')
  if (!(await exists(fs, root, '.github/workflows')) && !(await exists(fs, root, '.gitlab-ci.yml'))) {
    risks.push('未发现 CI 配置：建议在工程骨架变更中补齐')
  }

  return {
    kind: 'node',
    name: pkgName || posixBasename(root) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks,
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

async function detectPython(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const pyproject = (await readIfExists(fs, root, 'pyproject.toml', readFiles)) ?? ''
  const setupPy = (await readIfExists(fs, root, 'setup.py', readFiles)) ?? ''
  const requirements = (await readIfExists(fs, root, 'requirements.txt', readFiles)) ?? ''
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const combined = `${pyproject}\n${setupPy}\n${requirements}`
  const facts: SourceFact[] = [
    fact('Python 项目（pyproject.toml / setup.py / requirements.txt）', [
      pyproject !== ''
        ? citationAt('pyproject.toml', pyproject, /\[project\]|\[tool\.|name\s*=|requires-python/i) ?? citationRange('pyproject.toml', pyproject, 0)
        : setupPy !== ''
          ? citationRange('setup.py', setupPy, 0)
          : citationRange('requirements.txt', requirements, 0),
    ].filter((citation): citation is CitationRef => citation !== undefined)),
  ]
  const pythonVersion = /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject)?.[1] ?? ''
  if (pythonVersion !== '') facts.push(fact(`Python ${pythonVersion}`, [
    citationAt('pyproject.toml', pyproject, /requires-python/),
  ].filter((citation): citation is CitationRef => citation !== undefined)))
  const framework = /(django|flask|fastapi)/i.exec(combined)?.[1]?.toLowerCase() ?? ''
  if (framework !== '') facts.push(fact(`Web 框架：${framework}`, [citationAt('pyproject.toml', pyproject, new RegExp(framework, 'i')) ?? citationAt('requirements.txt', requirements, new RegExp(framework, 'i'))].filter(
    (citation): citation is CitationRef => citation !== undefined,
  )))

  const commands: CommandSettings = {}
  const usesPytest = /pytest/i.test(combined)
  const usesUnittest = /unittest/i.test(combined)
  if (usesPytest) commands.test = 'pytest -q'
  else if (usesUnittest) commands.test = 'python -m unittest discover -v'
  else commands.test = 'none'
  if (/\bruff\b/i.test(combined)) commands.lint = 'ruff check .'
  else if (/\bflake8\b/i.test(combined)) commands.lint = 'flake8'
  if (/\[build-system\]/i.test(pyproject)) commands.build = 'python -m build'
  if (/\bmypy\b/i.test(combined)) commands.typecheck = 'mypy .'
  else if (/\bpyright\b/i.test(combined)) commands.typecheck = 'pyright'
  const scriptMatch = /\[project\.scripts\][\s\S]*?^([A-Za-z0-9_-]+)\s*=/m.exec(pyproject)
  if (scriptMatch) commands.run = `python -m ${scriptMatch[1]!}`

  const modules: ProjectModuleInfo[] = []
  const dirs = await topLevelDirs(fs, root)
  for (const dir of dirs) {
    if (dir === 'src' || dir === 'tests' || dir === 'test' || dir === 'docs') continue
    if (await exists(fs, root, `${dir}/__init__.py`)) {
      modules.push({ path: dir, responsibility: responsibilityFromReadme(readme, dir) })
    }
  }
  if (modules.length === 0) modules.push(...modulesFromDirs(dirs, readme))

  const risks: string[] = []
  if (commands.test === 'none') risks.push('缺少自动化测试：未发现 pytest / unittest，请在 project.md 中写 test: none 并以构建 / 类型检查 / lint 作为基线')
  if (pyproject === '' && setupPy === '') risks.push('未发现 pyproject.toml / setup.py：无法确定构建方式')
  return {
    kind: 'python',
    name: (/\bname\s*=\s*["']([^"']+)["']/.exec(pyproject)?.[1] ?? posixBasename(root)) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks,
  }
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

async function detectGo(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const goMod = (await readIfExists(fs, root, 'go.mod', readFiles)) ?? ''
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const facts: SourceFact[] = []
  const moduleName = /^module\s+(\S+)/m.exec(goMod)?.[1] ?? ''
  facts.push(fact(`Go 项目（go.mod${moduleName !== '' ? `：${moduleName}` : ''}）`, [
    citationAt('go.mod', goMod, /^module\s/) ?? citationRange('go.mod', goMod, 0),
  ].filter((citation): citation is CitationRef => citation !== undefined)))
  const goVersion = /^go\s+([\d.]+)/m.exec(goMod)?.[1] ?? ''
  if (goVersion !== '') facts.push(fact(`Go ${goVersion}`, [
    citationAt('go.mod', goMod, /^go\s+/),
  ].filter((citation): citation is CitationRef => citation !== undefined)))
  const commands: CommandSettings = {
    test: 'go test -json ./...',
    build: 'go build ./...',
    lint: 'go vet ./...',
  }
  const modules = modulesFromDirs((await topLevelDirs(fs, root)).filter((dir) => dir !== 'src'), readme)
  return {
    kind: 'go',
    name: posixBasename(root) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks: [],
  }
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

async function detectRust(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const cargo = (await readIfExists(fs, root, 'Cargo.toml', readFiles)) ?? ''
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const packageName = /^name\s*=\s*["']([^"']+)["']/m.exec(cargo)?.[1] ?? ''
  const edition = /^edition\s*=\s*["']([^"']+)["']/m.exec(cargo)?.[1] ?? ''
  const facts: SourceFact[] = [
    fact(`Rust 项目（Cargo.toml${packageName !== '' ? `：${packageName}` : ''}${edition !== '' ? `，edition ${edition}` : ''}）`, [
      citationAt('Cargo.toml', cargo, /^name\s*=/m) ?? citationRange('Cargo.toml', cargo, 0),
    ].filter((citation): citation is CitationRef => citation !== undefined)),
  ]
  const commands: CommandSettings = {
    test: 'cargo test',
    build: 'cargo build',
    lint: 'cargo clippy --all-targets',
    typecheck: 'cargo check',
  }
  const modules = modulesFromDirs((await topLevelDirs(fs, root)).filter((dir) => dir !== 'src'), readme)
  return {
    kind: 'rust',
    name: packageName || posixBasename(root) || '未知项目',
    stackFacts: facts,
    commands,
    modules,
    readFiles,
    risks: [],
  }
}

// ---------------------------------------------------------------------------
// Unknown
// ---------------------------------------------------------------------------

async function detectUnknown(fs: FileSystem, root: string, readFiles: string[]): Promise<DetectedStack> {
  const readme = await readIfExists(fs, root, 'README.md', readFiles)
  const dirs = await topLevelDirs(fs, root)
  return {
    kind: 'unknown',
    name: posixBasename(root) || '未知项目',
    stackFacts: [],
    commands: {},
    modules: modulesFromDirs(dirs, readme),
    readFiles,
    risks: ['未识别技术栈：请在 .flowgate/project.md 中填写 test / build / lint 命令'],
  }
}

/** Detect the build system and the commands FlowGate should use for verification. */
export async function detectTechStack(fs: FileSystem, root: string): Promise<DetectedStack> {
  const readFiles: string[] = []
  try {
    if (await exists(fs, root, 'pom.xml')) return await detectMaven(fs, root, readFiles)
    if ((await exists(fs, root, 'build.gradle')) || (await exists(fs, root, 'build.gradle.kts'))) {
      return await detectGradle(fs, root, readFiles)
    }
    if (await exists(fs, root, 'package.json')) return await detectNode(fs, root, readFiles)
    if (
      (await exists(fs, root, 'pyproject.toml')) ||
      (await exists(fs, root, 'setup.py')) ||
      (await exists(fs, root, 'requirements.txt'))
    ) {
      return await detectPython(fs, root, readFiles)
    }
    if (await exists(fs, root, 'go.mod')) return await detectGo(fs, root, readFiles)
    if (await exists(fs, root, 'Cargo.toml')) return await detectRust(fs, root, readFiles)
  } catch {
    // fall through to unknown
  }
  return detectUnknown(fs, root, readFiles)
}

/** Render a `project.md` draft that `parseProjectDoc` can read back. */
export function renderProjectDocDraft(stack: DetectedStack, now: string): string {
  const lines: string[] = []
  lines.push(`# 项目上下文：${stack.name || '未知项目'}`)
  lines.push('')
  lines.push(`> 由 FlowGate 于 ${now} 自动生成草稿。标记说明：已确认 = 读取到对应文件/行；代码推导 = 由构建文件推断；待确认 = 需负责人补充确认。`)
  lines.push('')
  lines.push('## 技术栈')
  lines.push('')
  if (stack.stackFacts.length === 0) {
    lines.push('- 待确认：未识别技术栈，请负责人补充')
  } else {
    for (const factItem of stack.stackFacts) {
      const citation = factItem.citations[0]
      const source = citation ? `（来源：${citation.file}:${citation.startLine}-${citation.endLine}）` : ''
      lines.push(`- ${factItem.text}${source}（${statusLabel(factItem.status)}）`)
    }
  }
  lines.push('')
  lines.push('## 目录与模块职责')
  lines.push('')
  lines.push('| 路径 | 职责 |')
  lines.push('|---|---|')
  if (stack.modules.length === 0) {
    lines.push('| 待确认 | 待负责人补充模块划分 |')
  } else {
    for (const module of stack.modules) {
      lines.push(`| ${module.path} | ${module.responsibility || '待确认'} |`)
    }
  }
  lines.push('')
  lines.push('## 命令')
  lines.push('')
  lines.push('| 名称 | 命令 |')
  lines.push('|---|---|')
  const commandKeys: (keyof CommandSettings)[] = ['test', 'integration', 'build', 'lint', 'typecheck', 'run', 'health']
  let written = 0
  for (const key of commandKeys) {
    const value = stack.commands[key]
    if (value === undefined) continue
    lines.push(`| ${key} | ${value} |`)
    written += 1
  }
  if (written === 0) lines.push('| test | none |')
  lines.push('')
  lines.push('## 编码约定')
  lines.push('')
  lines.push('- 待负责人补充（FlowGate 不根据依赖列表自动生成编码规范）')
  lines.push('')
  lines.push('## 禁区')
  lines.push('')
  lines.push('- 待负责人补充')
  lines.push('')
  lines.push('## 可复用模块')
  lines.push('')
  lines.push('- 待负责人补充')
  lines.push('')
  lines.push('## 读取记录')
  lines.push('')
  if (stack.readFiles.length === 0) {
    lines.push('- 无（未读到任何构建或说明文件）')
  } else {
    for (const file of stack.readFiles) lines.push(`- \`${file}\``)
  }
  lines.push('')
  lines.push('## 描述与结论')
  lines.push('')
  if (stack.stackFacts.length === 0) {
    lines.push('- 未识别技术栈（待确认）')
  } else {
    for (const factItem of stack.stackFacts) {
      lines.push(`- ${factItem.text}（${statusLabel(factItem.status)}）`)
    }
  }
  if (stack.risks.length > 0) {
    lines.push('')
    lines.push('## 风险提示')
    lines.push('')
    for (const risk of stack.risks) lines.push(`- ${risk}`)
  }
  return lines.join('\n')
}
