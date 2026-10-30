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
    unlock: '让负责人在面板确认本次修改（/flow risk approve <RK-n>）；确认后只对该动作和路径单次放行。',
    source: '03 §8.2 敏感路径触发器 · FR-6.2',
    builtin: true,
  },
  {
    id: 'T-DEPENDENCY',
    when: {},
    decision: 'human',
    why: '依赖清单/锁文件变更涉及供应链安全与许可证合规，按内置触发器转人工确认。',
    unlock: '让负责人在面板确认依赖变更（/flow risk approve <RK-n>），只对该次修改单次放行。',
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
    unlock: '负责人确认后可继续（/flow risk approve <RK-n>）；先写清失败现象与根因假设。',
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

function fileWritePaths(action: FileAction): string[] {
  if (action.kind === 'read') return []
  const paths = [normalizeRelPath(action.path)]
  if (action.kind === 'rename' && action.toPath) paths.push(normalizeRelPath(action.toPath))
  return paths.filter((path) => path !== '')
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
  const dependencyHits: string[] = []
  for (const path of writePaths) {
    const normalized = normalizeRelPath(path)
    if (normalized !== '' && matchAnyGlob(dependencyPatterns, normalized)) dependencyHits.push(normalized)
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
  const limit = config?.triggers?.consecutive_failure_limit ?? 0
  if (limit > 0 && input.change) {
    const failing = Object.values(input.change.tasks).filter(
      (task) =>
        task.status !== 'done' &&
        task.status !== 'skipped' &&
        (task.failureCount ?? 0) >= limit,
    )
    if (failing.length > 0) {
      hits.push({
        trigger: 'consecutive-failure',
        decision: 'human',
        title: '连续验证失败',
        detail: `任务 ${failing.map((task) => `${task.id}（失败 ${task.failureCount} 次）`).join('、')} 达到连续失败上限 ${limit}，暂停并转人工。`,
      })
    }
  }

  return hits
}
