/**
 * Built-in risk triggers (03 §8.2, FR-6.2).
 *
 * Triggers are evaluated *before* stage/scope rules. A trigger can either deny
 * outright (writing a secret) or turn the action into a human decision with a
 * pending-item draft. `TRIGGER_RULES` exposes the trigger metadata as regular
 * `Rule` objects so `/flow allow-once <id>` and config overrides work on them.
 */
import type { FileAction, FlowgateConfig, Rule, RuleDecision, RuleEvaluationInput } from '../types'
import { matchAnyGlob, matchGlob } from '../util/glob'
import { containsSecret } from '../util/hash'
import { normalizeRelPath, posixBasename } from '../util/paths'
import {
  extractWriteTargets,
  isDangerousCommand,
  isDependencyCommand,
  isMutatingCommand,
  isPushCommand,
} from '../shell'

export interface TriggerHit {
  trigger: string
  decision: RuleDecision
  title: string
  detail: string
  fingerprint?: string
}

/** Sensitive paths that always need the owner's confirmation (03 §8.2). */
export const DEFAULT_SENSITIVE_PATHS: string[] = [
  '**/auth/**',
  '**/security/**',
  '**/payment*/**',
  '**/migration*/**',
  '**/*.sql',
  '**/db/changelog/**',
  'Dockerfile',
  '.github/workflows/**',
  '**/k8s/**',
  '**/application-prod*.*',
]

/** Dependency manifests / lockfiles whose change counts as a dependency change. */
export const DEFAULT_DEPENDENCY_FILES: string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'libs.versions.toml',
  'requirements*.txt',
  'constraints*.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'Pipfile',
  'Pipfile.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'composer.json',
  'composer.lock',
  'Gemfile',
  'Gemfile.lock',
]

/**
 * Hot files that parallel batches must not touch (FR-2.8, 03 §9.3):
 * dependency manifests/locks, route registration, DI configuration, migrations,
 * shared types/enums, i18n resources, CHANGELOG.
 */
export const HOTSPOT_PATTERNS: string[] = [
  ...DEFAULT_DEPENDENCY_FILES,
  '**/routes/**',
  '**/router/**',
  '**/routers/**',
  '**/routes.*',
  '**/router.*',
  '**/urls.py',
  '**/*.routes.ts',
  '**/di/**',
  '**/providers/**',
  '**/*.module.ts',
  '**/ApplicationContext*',
  '**/beans*.xml',
  '**/migration*/**',
  '**/migrations/**',
  '**/db/changelog/**',
  '**/alembic/**',
  '**/types/**',
  '**/shared/**',
  '**/enums/**',
  '**/interfaces/**',
  '**/locales/**',
  '**/i18n/**',
  '**/lang/**',
  '**/*.po',
  '**/messages*.properties',
  'CHANGELOG*',
  '**/CHANGELOG*',
]

/** True when the path is a hotspot that must not be touched by parallel batches. */
export function isHotspot(path: string, config: FlowgateConfig): boolean {
  const normalized = normalizeRelPath(path)
  const extra = config?.parallel?.hotspots_extra ?? []
  return matchAnyGlob([...HOTSPOT_PATTERNS, ...extra], normalized)
}

/** Effective patterns for a run (config can extend the defaults). */
export function sensitivePathPatterns(config: FlowgateConfig): string[] {
  return [
    ...DEFAULT_SENSITIVE_PATHS,
    ...(config?.triggers?.sensitive_paths ?? []),
    ...(config?.triggers?.sensitive_paths_extra ?? []),
  ]
}

export function dependencyFilePatterns(config: FlowgateConfig): string[] {
  return [...DEFAULT_DEPENDENCY_FILES, ...(config?.triggers?.dependency_files ?? [])]
}

/** Trigger ids exposed as rules (so allow-once / exceptions / config overrides work). */
export const TRIGGER_RULES: Rule[] = [
  {
    id: 'T-SENSITIVE-PATH',
    when: {},
    decision: 'human',
    why: '目标路径位于敏感区域（鉴权、支付、迁移、基础设施、CI、生产配置）：按内置触发器转人工确认。',
    unlock: '等待负责人在授权卡片上确认本次修改（RK-n）；确认后只对该动作和路径单次放行。',
    source: '03 §8.2 敏感路径触发器 · FR-6.2',
    builtin: true,
  },
  {
    id: 'T-DEPENDENCY',
    when: {},
    decision: 'human',
    why: '依赖清单/锁文件变更涉及供应链安全与许可证合规，按内置触发器转人工确认。',
    unlock: '等待负责人在授权卡片上确认依赖变更（RK-n），只对该次修改单次放行。',
    source: '03 §8.2 依赖变更触发器 · FR-6.2',
    builtin: true,
  },
  {
    id: 'T-DANGEROUS',
    when: {},
    decision: 'human',
    why: '命令命中危险命令清单（rm -rf 仓库外/仓库根、git reset --hard、git clean、SQL DROP/TRUNCATE、curl | sh、chmod -R 777、rsync --delete 等）。',
    unlock: '危险命令需要负责人确认；先用只读命令复现问题，或让负责人手动执行。',
    source: '03 §8.2 危险命令触发器 · FR-4.10',
    builtin: true,
  },
  {
    id: 'T-SECRET',
    when: {},
    decision: 'deny',
    why: '写入内容匹配私钥、云厂商密钥或令牌格式：密钥不能进仓库，且日志与报告会脱敏。',
    unlock: '改用环境变量或密钥管理服务；确需示例请把占位符写进 .env.example。',
    source: '03 §8.2 密钥触发器 · FR-6.2',
    builtin: true,
  },
  {
    id: 'T-SECRET-READ',
    when: {},
    decision: 'human',
    why: '读取 .env / 私钥等密钥文件转人工：密钥内容不应进入模型上下文。',
    unlock: '请负责人确认后粘贴必要配置项，或改用配置/环境变量注入。',
    source: '03 §8.2 密钥触发器 · FR-4.6',
    builtin: true,
  },
  {
    id: 'T-FAILURE-LIMIT',
    when: {},
    decision: 'human',
    why: '同一任务验证连续失败达到上限（默认 3 次）：先停下按"复现 → 定位根因 → 修复 → 回归"排障。',
    unlock: '等待负责人在授权卡片上确认后解锁（BL-n；只读诊断与 flow_status/flow_report_risk 不受限）；先写清失败现象与根因假设。',
    source: '03 §8.2 连续失败触发器 · FR-4.8',
    builtin: true,
  },
]

export const TRIGGER_RULE_BY_TRIGGER: Record<string, Rule> = {
  'sensitive-path': TRIGGER_RULES[0]!,
  'dependency-change': TRIGGER_RULES[1]!,
  'dangerous-command': TRIGGER_RULES[2]!,
  'secret-write': TRIGGER_RULES[3]!,
  'secret-read': TRIGGER_RULES[4]!,
  'consecutive-failure': TRIGGER_RULES[5]!,
}

const SECRET_READ_BASENAMES = [
  /^\.env(\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^credentials(\..+)?$/i,
  /^secrets?(\..+)?$/i,
]

function looksLikeSecretFile(path: string): boolean {
  const base = posixBasename(path)
  if (/\.(example|sample|template|md)$/i.test(base)) return false
  return SECRET_READ_BASENAMES.some((pattern) => pattern.test(base))
}

function isFileAction(action: RuleEvaluationInput['action']): action is FileAction {
  return (
    action.kind === 'write' ||
    action.kind === 'create' ||
    action.kind === 'delete' ||
    action.kind === 'rename' ||
    action.kind === 'read'
  )
}

/**
 * 只读工具（不推进流程）：观测/诊断/上报/宿主元数据。
 *
 * 真实事故（docs/evaluation-data/20261031-105753-...，round-5/6）：熔断后
 * `flow_status`、`flow_report_risk` 也被 T-FAILURE-LIMIT 拦住，agent 连状态都查不了，
 * 更无法上报根因；这里把只读观测类工具和会推进流程的工具分开。
 */
export const READ_ONLY_OTHER_TOOLS: ReadonlySet<string> = new Set([
  // 只读 flow 工具（flow_investigate 是只读调查，flow_learn 是学习模式查询/切换提示）。
  'flow_status',
  'flow_diff',
  'flow_report_risk',
  'flow_investigate',
  'flow_learn',
  // 只读宿主工具（正常走 guard 时大多返回 null 动作，这里兜底直接喂给引擎的调用）。
  'read',
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'web_fetch',
  'web_search',
  'read_image',
  'skill',
])

/**
 * 熔断触发器的适用范围：只有「会推进/修改」的动作才受连续失败熔断限制。
 *
 * 只读动作（read/glob/grep、只读 shell、flow_status/flow_diff/flow_report_risk 等）
 * 必须放行，让 agent 能先取证、查状态、上报风险——否则排障第一步就被门禁自己堵死。
 * delegate/mcp/未识别的 other 无法确认只读，保守按推进处理（不降低门禁强度）。
 */
export function advancesPipeline(action: RuleEvaluationInput['action']): boolean {
  switch (action.kind) {
    case 'read':
      return false
    case 'write':
    case 'create':
    case 'delete':
    case 'rename':
      return true
    case 'shell':
      return (
        isMutatingCommand(action.command) ||
        isDangerousCommand(action.command) ||
        isDependencyCommand(action.command) ||
        isPushCommand(action.command)
      )
    case 'other':
      return !READ_ONLY_OTHER_TOOLS.has(action.tool.trim().toLowerCase())
    case 'delegate':
    case 'mcp':
    default:
      return true
  }
}

function fileWritePaths(action: FileAction): string[] {
  if (action.kind === 'read') return []
  const paths = [normalizeRelPath(action.path)]
  if (action.kind === 'rename' && action.toPath) paths.push(normalizeRelPath(action.toPath))
  return paths.filter((path) => path !== '')
}

// ---------------------------------------------------------------------------
// 4a. Dependency manifest content check (T-DEPENDENCY 误伤修复)
//
// 真实 greenfield 演练（docs/evaluation-data/20261031-1128-...-recovery3）：agent 在 S4
// 用 write 新建零依赖的 package.json（dependencies/devDependencies 都是空对象），却被
// 依赖触发器按路径判成「依赖变更」反复转人工；单次放行按 action 指纹生效，模型重写
// 内容后指纹变化 → 每轮新 RK，流程永远推进不了。docs/04 T4.1 的语义是「新增依赖 →
// 转人工」，不是「新建无依赖的工程清单」。
//
// 因此：路径命中后，写动作还要按下方判定表看内容是否真的声明/变更依赖。只有能确认
// 「这次写入没有依赖声明」时才不触发；**无法确认时一律保守触发**（无 content 字段、
// JSON/XML/TOML 解析失败、edit 片段、锁文件、删除/重命名、未知或自定义清单）。
// ---------------------------------------------------------------------------

/** 锁文件：内容变化本身就等于依赖变化，无法从清单语义判断 → 保持保守触发。 */
const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'go.sum',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
])

type DependencyManifestKind =
  | 'package-json'
  | 'pom'
  | 'gradle'
  | 'requirements'
  | 'pyproject'
  | 'go-mod'
  | 'cargo'
  | 'lockfile'
  | 'unknown'

/** 按 basename 识别「能按内容判断依赖声明」的清单；其余清单保守触发。 */
function dependencyManifestKind(path: string): DependencyManifestKind {
  const base = posixBasename(path).toLowerCase()
  if (base === 'package.json') return 'package-json'
  if (base === 'pom.xml') return 'pom'
  if (base === 'build.gradle' || base === 'build.gradle.kts') return 'gradle'
  if (/^(?:requirements|constraints).*\.txt$/.test(base)) return 'requirements'
  if (base === 'pyproject.toml') return 'pyproject'
  if (base === 'go.mod') return 'go-mod'
  if (base === 'cargo.toml') return 'cargo'
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile'
  // settings.gradle(.kts) / gradle.properties / libs.versions.toml / Pipfile / composer.json /
  // Gemfile 以及 config.triggers.dependency_files 的自定义清单：无法按内容判断 → 保守触发。
  return 'unknown'
}

function isNonEmptyRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

const PACKAGE_JSON_DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/** package.json：JSON 解析失败（含 edit 片段）保守触发；依赖对象/bundledDependencies 非空才算。 */
function packageJsonDeclaresDependency(content: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return true
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  const manifest = parsed as Record<string, unknown>
  for (const key of PACKAGE_JSON_DEPENDENCY_KEYS) {
    const value = manifest[key]
    if (isNonEmptyRecord(value) || isNonEmptyArray(value)) return true
    // 字段存在但不是对象/数组 = 清单结构非法，无法确认 → 保守触发。
    if (value !== undefined && value !== null && typeof value !== 'object') return true
  }
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies
  if (isNonEmptyRecord(bundled) || isNonEmptyArray(bundled)) return true
  return false
}

/** pom.xml：出现 <dependency> 条目才触发；<dependencyManagement> 里的也算（保守）。 */
function pomDeclaresDependency(content: string): boolean {
  return /<\s*dependency(?=[\s>/])/i.test(content)
}

/** Gradle 依赖声明符号（含 buildscript classpath 与 Kotlin/Android 常见写法）。 */
const GRADLE_DEPENDENCY_SYMBOL =
  /\b(?:implementation|api|compileOnly|compileOnlyApi|runtimeOnly|testImplementation|testRuntimeOnly|testCompileOnly|kapt|ksp|annotationProcessor|classpath)\b/

/** build.gradle(.kts)：出现依赖符号才触发；只有 plugins/repositories 骨架不算。 */
function gradleDeclaresDependency(content: string): boolean {
  return GRADLE_DEPENDENCY_SYMBOL.test(content)
}

/** requirements*.txt / constraints*.txt：去掉注释与空行后仍有内容才算声明依赖。 */
function requirementsDeclaresDependency(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
}

function stripTomlComment(line: string): string {
  const index = line.indexOf('#')
  return index >= 0 ? line.slice(0, index) : line
}

/** TOML 段头（`[table]` / `[[array]]`）名称；不是段头返回 null。 */
function tomlTableName(line: string): string | null {
  const match = /^\[\[?([^\[\]]+)\]\]?$/.exec(line)
  return match ? match[1]!.trim() : null
}

const PYPROJECT_DEPENDENCY_KEYS = new Set(['dependencies', 'optional-dependencies', 'dev-dependencies'])

function isPyprojectDependencySection(name: string): boolean {
  return /(?:^|\.)dependencies$/.test(name) || name.endsWith('-dependencies')
}

/**
 * pyproject.toml：`[tool.poetry.dependencies]` / `[project.optional-dependencies]` 等
 * 段内有内容，或 `[project]` 的 dependencies 数组非空才算；无段头（edit 片段）保守触发。
 */
function pyprojectDeclaresDependency(content: string): boolean {
  const lines = content.split(/\r?\n/)
  const hasTable = lines.some((line) => tomlTableName(stripTomlComment(line).trim()) !== null)
  if (!hasTable) return true
  let inDependencySection = false
  for (const raw of lines) {
    const line = stripTomlComment(raw).trim()
    if (line === '') continue
    const table = tomlTableName(line)
    if (table !== null) {
      inDependencySection = isPyprojectDependencySection(table)
      continue
    }
    if (inDependencySection) return true
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (!assignment || !PYPROJECT_DEPENDENCY_KEYS.has(assignment[1]!)) continue
    // `dependencies = []` 是空声明；其它值（含跨行数组）保守按有内容处理。
    if (assignment[2]!.trim() !== '[]') return true
  }
  return false
}

function isCargoDependencySection(name: string): boolean {
  return /(?:^|\.)[a-z0-9_-]*dependencies(?:\.|$)/i.test(name)
}

/**
 * Cargo.toml：`[dependencies]` / `[dev-dependencies]` / `[workspace.dependencies]` /
 * `[dependencies.foo]` 等段内有内容才算；无段头（edit 片段）保守触发。
 */
function cargoDeclaresDependency(content: string): boolean {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => stripTomlComment(line).trim())
    .filter((line) => line !== '')
  if (normalized.length === 0) return false
  if (!normalized.some((line) => tomlTableName(line) !== null)) return true
  let inDependencySection = false
  for (const line of normalized) {
    const table = tomlTableName(line)
    if (table !== null) {
      inDependencySection = isCargoDependencySection(table)
      continue
    }
    if (inDependencySection) return true
  }
  return false
}

/**
 * go.mod：先有 `module` 行才视为完整文件（无 module 的片段保守触发）；
 * 只有 require 块内的模块行或单行 require 才算声明依赖，module/go 行不算。
 */
function goModDeclaresDependency(content: string): boolean {
  if (content.trim() === '') return false
  if (!/^\s*module\s+\S+/m.test(content)) return true
  const block = /^\s*require\s*\(([\s\S]*?)\)/m.exec(content)
  if (block) {
    const hasModule = block[1]!.split(/\r?\n/).some((line) => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('//')
    })
    if (hasModule) return true
  }
  return /^\s*require\s+[^\s(]+\s+v\d/m.test(content)
}

/**
 * 写动作命中依赖清单路径后，内容是否真的声明/变更了依赖。
 *
 * 返回 false 仅当能确认这次写入只是「无依赖的工程脚手架」（docs/04 T4.1 的语义是
 * 「新增依赖」才转人工）。其余情况——无 content 字段、解析失败、edit 片段、锁文件、
 * 删除/重命名、自定义/未知清单——一律返回 true，保持保守触发，不放宽门禁。
 */
function declaresDependencyChange(path: string, content: string | undefined): boolean {
  if (typeof content !== 'string') return true
  switch (dependencyManifestKind(path)) {
    case 'package-json':
      return packageJsonDeclaresDependency(content)
    case 'pom':
      return pomDeclaresDependency(content)
    case 'gradle':
      return gradleDeclaresDependency(content)
    case 'requirements':
      return requirementsDeclaresDependency(content)
    case 'pyproject':
      return pyprojectDeclaresDependency(content)
    case 'go-mod':
      return goModDeclaresDependency(content)
    case 'cargo':
      return cargoDeclaresDependency(content)
    case 'lockfile':
      return true
    case 'unknown':
    default:
      return true
  }
}

/**
 * Match all built-in risk triggers for an action. Deterministic order:
 * secret write -> dangerous command -> sensitive path -> dependency change ->
 * secret read -> consecutive failures.
 */
export function matchRiskTriggers(input: RuleEvaluationInput): TriggerHit[] {
  const hits: TriggerHit[] = []
  const action = input.action
  const config = input.config
  const sensitivePatterns = sensitivePathPatterns(config)
  const dependencyPatterns = dependencyFilePatterns(config)

  // 1. Secrets written into the repo.
  if (isFileAction(action) && (action.kind === 'write' || action.kind === 'create')) {
    if (typeof action.content === 'string' && containsSecret(action.content)) {
      hits.push({
        trigger: 'secret-write',
        decision: 'deny',
        title: '疑似密钥写入',
        detail: `准备写入 ${normalizeRelPath(action.path)} 的内容匹配私钥/令牌格式（内容已脱敏，不会写进日志）。`,
      })
    }
  } else if (action.kind === 'shell' && containsSecret(action.command)) {
    hits.push({
      trigger: 'secret-write',
      decision: 'deny',
      title: '疑似密钥出现在命令里',
      detail: 'shell 命令里出现私钥/令牌格式的字符串：密钥不能出现在命令历史或日志中。',
    })
  }

  // 2. Dangerous commands (push force is handled by R-PUSH, not here).
  if (action.kind === 'shell' && isDangerousCommand(action.command) && !isPushCommand(action.command)) {
    hits.push({
      trigger: 'dangerous-command',
      decision: 'human',
      title: '危险命令',
      detail: `命令命中危险清单：${action.command.trim().slice(0, 160)}`,
    })
  }

  // 3. Sensitive paths (file writes and shell write targets).
  const writePaths = isFileAction(action) ? fileWritePaths(action) : []
  if (action.kind === 'shell') writePaths.push(...extractWriteTargets(action.command))
  const sensitiveHits: string[] = []
  for (const path of writePaths) {
    const normalized = normalizeRelPath(path)
    if (normalized === '') continue
    for (const pattern of sensitivePatterns) {
      if (matchGlob(pattern, normalized)) {
        sensitiveHits.push(`${normalized}（${pattern}）`)
        break
      }
    }
  }
  if (sensitiveHits.length > 0) {
    hits.push({
      trigger: 'sensitive-path',
      decision: 'human',
      title: '敏感路径修改',
      detail: `目标位于敏感区域：${sensitiveHits.join('、')}`,
    })
  }

  // 4. Dependency manifest / lockfile changes.
  //    T-DEPENDENCY 误伤修复：路径命中还不够——写动作还要看内容是否真的声明/变更依赖
  //    （新建零依赖的 package.json 等纯脚手架不再转人工）；删除/重命名、锁文件、
  //    未知/自定义清单、拿不到内容时保持保守触发（见 declaresDependencyChange）。
  const dependencyHits: string[] = []
  for (const path of writePaths) {
    const normalized = normalizeRelPath(path)
    if (normalized === '' || !matchAnyGlob(dependencyPatterns, normalized)) continue
    if ((action.kind === 'write' || action.kind === 'create') && !declaresDependencyChange(normalized, action.content)) {
      continue
    }
    dependencyHits.push(normalized)
  }
  if (action.kind === 'shell' && isDependencyCommand(action.command)) {
    dependencyHits.push(`依赖命令：${action.command.trim().slice(0, 120)}`)
  }
  if (dependencyHits.length > 0) {
    hits.push({
      trigger: 'dependency-change',
      decision: 'human',
      title: '依赖变更',
      detail: `涉及依赖清单/锁文件：${dependencyHits.join('、')}`,
    })
  }

  // 5. Reading secret files.
  if (isFileAction(action) && action.kind === 'read' && looksLikeSecretFile(action.path)) {
    hits.push({
      trigger: 'secret-read',
      decision: 'human',
      title: '读取密钥文件',
      detail: `读取 ${normalizeRelPath(action.path)} 会把密钥暴露给模型，需要负责人确认。`,
    })
  }

  // 6. Consecutive verification failures.
  //    只对会推进/修改的动作生效：熔断后 read/只读 shell/flow_status 等必须放行，
  //    否则 agent 无法取证、查状态或上报风险（真实事故见文件头注释）。
  const limit = config?.triggers?.consecutive_failure_limit ?? 0
  if (limit > 0 && input.change && advancesPipeline(action)) {
    const failing = Object.values(input.change.tasks).filter(
      (task) =>
        task.status !== 'done' &&
        task.status !== 'skipped' &&
        (task.failureCount ?? 0) >= limit,
    )
    if (failing.length > 0) {
      const failingIds = new Set(failing.map((task) => task.id))
      // 复用一个已存在的熔断阻断项：避免每个被拦动作都新建 BL-n（真实 run 里膨胀到 BL-1～BL-8）。
      const existing = input.pending.find(
        (item) =>
          item.status === 'open' &&
          item.kind === 'blocker' &&
          (failingIds.has(String(item.data?.taskId ?? item.scope?.taskId ?? '')) ||
            item.data?.ruleId === 'T-FAILURE-LIMIT'),
      )
      hits.push({
        trigger: 'consecutive-failure',
        decision: 'human',
        title: '连续验证失败',
        detail: `任务 ${failing.map((task) => `${task.id}（失败 ${task.failureCount} 次）`).join('、')} 达到连续失败上限 ${limit}，暂停并转人工。只读动作（read/grep、只读 shell、flow_status/flow_diff/flow_report_risk）已放行，可先取证；${
          existing
            ? `已有阻断项 ${existing.id}，等待负责人在授权卡片上确认后解锁。`
            : '等待负责人在授权卡片上确认后解锁（BL-n）。'
        }`,
      })
    }
  }

  return hits
}
