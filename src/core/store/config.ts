/**
 * `.flowgate/config.yaml` 的读取、默认值合并、校验与哈希。
 *
 * YAML 解析使用 `yaml` 包（宿主的 tsdown 会把它打进 lib/host.js；core 只额外
 * 允许这一个第三方包，禁止任何 `@deepseek-ai/*` 引用）。
 *
 * 合并语义（默认值 ← 用户配置）：
 * - 普通对象深合并；
 * - `rules` 数组按 `id` 覆盖/追加（同一 id 深合并到默认规则上，新 id 追加）；
 * - 以 `_extra` 结尾的数组（`sensitive_paths_extra`、`hotspots_extra`）追加去重；
 * - 其余数组（`ignore`、`sensitive_paths`、`dependency_files`、`protected_paths`）
 *   提供即整体覆盖。
 *
 * YAML 语法错误会抛出带文件路径与行号的 {@link ConfigError}，宿主捕获后进入降级模式
 * （不阻塞 DSH 启动）。
 */
import type { FileSystem } from '../util/fs'
import type { FlowgateConfig, Rule, RuleDecision } from '../types'
import { sha256, stableJson } from '../util/hash'
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from 'yaml'

/** 配置解析/校验错误：带文件路径与（可选的）1 起行号，宿主据此提示与降级。 */
export class ConfigError extends Error {
  /** 出错的配置文件路径（仓库相对）。 */
  readonly path: string
  /** 1 起的行号；语义校验错误通常没有行号。 */
  readonly line?: number
  /** 给用户/agent 的修复提示。 */
  readonly hint: string

  constructor(message: string, details: { path: string; line?: number; hint?: string }) {
    super(message)
    this.name = 'ConfigError'
    this.path = details.path
    this.line = details.line
    this.hint = details.hint ?? '修正 .flowgate/config.yaml 后重试，或删除该文件以使用默认配置。'
  }
}

export const DEFAULT_CONFIG_PATH = '.flowgate/config.yaml'

/** 构造一个全新的默认配置（每次都返回新对象，调用方可安全修改）。 */
function buildDefaultConfig(): FlowgateConfig {
  return {
    levels: { complexity: 'auto', risk: 'auto' },
    learning: 'detail',
    dispatch: 'auto',
    commands: {},
    limits: {
      task_max_files: 5,
      change_max_tasks: 12,
      clarify_max_rounds: 4,
      turn_continue_max: 2,
      test_output_summary_tokens: 400,
      context_warn_ratio: 0.6,
      token_budget: { low: 200_000, medium: 600_000, high: 1_200_000, ultra: 2_000_000 },
    },
    parallel: { max_agents: 3, setup: null, hotspots_extra: [] },
    session: { lease_minutes: 10 },
    git: { change_branch: true, auto_commit: true, commit_flowgate: false },
    // 独立审查（07 §7.2）：默认启用；模型用宿主默认；中复杂度及以上任务门缺审查即阻断。
    review: { enabled: true, model: null, requireForTaskGate: true },
    ignore: [],
    rules: [],
    triggers: {
      // 03 §8.2 内置触发器：敏感路径。
      sensitive_paths: [
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
      ],
      sensitive_paths_extra: [],
      // 03 §8.2 内置触发器：依赖清单。
      dependency_files: [
        'package.json',
        'pom.xml',
        'build.gradle*',
        'requirements*.txt',
        'pyproject.toml',
        'go.mod',
        'Cargo.toml',
      ],
      // FR-4.6 受保护路径：插件写状态、git 内部、密钥文件。
      protected_paths: ['.flowgate/**', '.git/**', '**/*.pem', '**/*.key', '.env', '.env.*'],
      secret_patterns: 'builtin',
      max_scope_new_files: 3,
      consecutive_failure_limit: 3,
    },
  }
}

/** 全量默认配置；调用方**不要原地修改**，需要改时用 {@link loadConfig} 的返回值或深拷贝。 */
export const DEFAULT_CONFIG: FlowgateConfig = buildDefaultConfig()

function defaultConfig(): FlowgateConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as FlowgateConfig
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item)
    return out as T
  }
  return value
}

function mergeRuleArrays(base: unknown, override: unknown, fieldPath: string): Rule[] {
  if (!Array.isArray(override)) {
    throw new ConfigError(
      `配置项不合法（${DEFAULT_CONFIG_PATH}）：${fieldPath} 必须是数组`,
      { path: DEFAULT_CONFIG_PATH, hint: 'rules 应为规则对象数组，例如 [{ id: R-CUSTOM, when: {...}, decision: deny, why: ..., unlock: ... }]。' },
    )
  }
  const result: Rule[] = Array.isArray(base) ? (cloneValue(base) as Rule[]) : []
  const indexById = new Map<string, number>()
  result.forEach((rule, index) => {
    if (rule && typeof rule.id === 'string') indexById.set(rule.id, index)
  })
  for (const item of override) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || item.id.trim() === '') {
      throw new ConfigError(
        `配置项不合法（${DEFAULT_CONFIG_PATH}）：${fieldPath} 中的规则缺少字符串 id`,
        { path: DEFAULT_CONFIG_PATH, hint: '每条自定义规则都必须有唯一 id，例如 R-CUSTOM。' },
      )
    }
    const incoming = cloneValue(item) as unknown as Rule
    const existingIndex = indexById.get(incoming.id)
    if (existingIndex === undefined) {
      indexById.set(incoming.id, result.length)
      result.push(incoming)
    } else {
      result[existingIndex] = deepMergeValue(result[existingIndex], incoming, `${fieldPath}[${incoming.id}]`) as Rule
    }
  }
  return result
}

function mergeExtraArrays(base: unknown, override: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(override)) {
    throw new ConfigError(`配置项不合法（${DEFAULT_CONFIG_PATH}）：${fieldPath} 必须是数组`, {
      path: DEFAULT_CONFIG_PATH,
      hint: '形如 *_extra 的配置项用于追加默认清单，必须是字符串数组。',
    })
  }
  const merged: unknown[] = Array.isArray(base) ? cloneValue(base) : []
  for (const item of override) {
    if (!merged.some((existing) => stableJson(existing) === stableJson(item))) merged.push(cloneValue(item))
  }
  return merged
}

function deepMergeValue(base: unknown, override: unknown, fieldPath: string): unknown {
  if (override === undefined) return cloneValue(base)
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = cloneValue(base)
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue
      const childPath = fieldPath === '' ? key : `${fieldPath}.${key}`
      if (key === 'rules') out[key] = mergeRuleArrays(out[key], value, childPath)
      else if (key.endsWith('_extra')) out[key] = mergeExtraArrays(out[key], value, childPath)
      else out[key] = deepMergeValue(out[key], value, childPath)
    }
    return out
  }
  if (Array.isArray(override)) return override.map((item) => cloneValue(item))
  return override
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function failValidation(fieldPath: string, detail: string, hint: string): never {
  throw new ConfigError(
    `配置项不合法（${DEFAULT_CONFIG_PATH}）：${fieldPath === '' ? '根节点' : fieldPath} ${detail}`,
    { path: DEFAULT_CONFIG_PATH, hint },
  )
}

function expectStringArray(config: unknown, fieldPath: string): void {
  if (!Array.isArray(config) || config.some((item) => typeof item !== 'string')) {
    failValidation(fieldPath, '必须是字符串数组', `把 ${fieldPath} 写成字符串数组，例如 ["**/generated/**"]。`)
  }
}

function expectFiniteNumber(value: unknown, fieldPath: string, options: { min?: number; integer?: boolean } = {}): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    failValidation(fieldPath, '必须是数字', `为 ${fieldPath} 填一个数字。`)
  }
  if (options.integer && !Number.isInteger(value)) failValidation(fieldPath, '必须是整数', `为 ${fieldPath} 填一个整数。`)
  if (options.min !== undefined && (value as number) < options.min) {
    failValidation(fieldPath, `不能小于 ${options.min}`, `为 ${fieldPath} 填一个不小于 ${options.min} 的值。`)
  }
}

function validateConfig(config: FlowgateConfig): void {
  const levels: unknown = config.levels
  if (!isPlainObject(levels)) failValidation('levels', '必须是对象', 'levels 需要包含 complexity 与 risk。')
  const allowedComplexity = ['auto', 'low', 'medium', 'high', 'ultra']
  if (!allowedComplexity.includes(String(levels.complexity))) {
    failValidation('levels.complexity', `只能取 ${allowedComplexity.join(' / ')}，实际为 ${JSON.stringify(levels.complexity)}`, '复杂度取 auto（插件建议、负责人确认）或 low / medium / high / ultra。')
  }
  if (!['auto', 'normal', 'high'].includes(String(levels.risk))) {
    failValidation('levels.risk', `只能取 auto / normal / high，实际为 ${JSON.stringify(levels.risk)}`, '风险取 auto 或 normal / high。')
  }
  if (!['detail', 'brief', 'off'].includes(String(config.learning))) {
    failValidation('learning', '只能取 detail / brief / off', '学习模式取 detail、brief 或 off。')
  }
  if (!['auto', 'subagent', 'inline'].includes(String(config.dispatch))) {
    failValidation('dispatch', '只能取 auto / subagent / inline', '派发模式取 auto、subagent 或 inline。')
  }
  const commands: unknown = config.commands
  if (!isPlainObject(commands)) failValidation('commands', '必须是对象', 'commands 写成 { test: "…" } 形式；项目确实没有测试时写 test: none。')
  for (const [key, value] of Object.entries(commands)) {
    if (value !== undefined && typeof value !== 'string') {
      failValidation(`commands.${key}`, '必须是字符串（没有测试时写 test: none）', `把 commands.${key} 写成命令字符串。`)
    }
  }
  const limits: unknown = config.limits
  if (!isPlainObject(limits)) failValidation('limits', '必须是对象', 'limits 使用默认值或逐项覆盖。')
  expectFiniteNumber(limits.task_max_files, 'limits.task_max_files', { min: 1, integer: true })
  expectFiniteNumber(limits.change_max_tasks, 'limits.change_max_tasks', { min: 1, integer: true })
  expectFiniteNumber(limits.clarify_max_rounds, 'limits.clarify_max_rounds', { min: 0, integer: true })
  expectFiniteNumber(limits.turn_continue_max, 'limits.turn_continue_max', { min: 0, integer: true })
  expectFiniteNumber(limits.test_output_summary_tokens, 'limits.test_output_summary_tokens', { min: 1, integer: true })
  expectFiniteNumber(limits.context_warn_ratio, 'limits.context_warn_ratio', { min: 0 })
  if (!isPlainObject(limits.token_budget)) failValidation('limits.token_budget', '必须是对象', 'token_budget 需要为 low / medium / high / ultra 各填一个数字。')
  for (const complexity of ['low', 'medium', 'high', 'ultra']) {
    expectFiniteNumber((limits.token_budget as Record<string, unknown>)[complexity], `limits.token_budget.${complexity}`, { min: 1 })
  }
  const parallel: unknown = config.parallel
  if (!isPlainObject(parallel)) failValidation('parallel', '必须是对象', 'parallel 使用默认值或逐项覆盖。')
  expectFiniteNumber(parallel.max_agents, 'parallel.max_agents', { min: 1, integer: true })
  if (parallel.setup !== null && typeof parallel.setup !== 'string') {
    failValidation('parallel.setup', '必须是字符串或 null', '没有准备命令时写 setup: null。')
  }
  expectStringArray(parallel.hotspots_extra, 'parallel.hotspots_extra')
  const session: unknown = config.session
  if (!isPlainObject(session)) failValidation('session', '必须是对象', 'session 使用默认值或逐项覆盖。')
  expectFiniteNumber(session.lease_minutes, 'session.lease_minutes', { min: 1 })
  const git: unknown = config.git
  if (!isPlainObject(git)) failValidation('git', '必须是对象', 'git 使用默认值或逐项覆盖。')
  for (const key of ['change_branch', 'auto_commit', 'commit_flowgate']) {
    if (typeof git[key] !== 'boolean') failValidation(`git.${key}`, '必须是布尔值', `git.${key} 写 true 或 false。`)
  }
  const review: unknown = config.review
  if (!isPlainObject(review)) failValidation('review', '必须是对象', 'review 使用默认值或逐项覆盖。')
  if (typeof review.enabled !== 'boolean') failValidation('review.enabled', '必须是布尔值', 'review.enabled 写 true 或 false。')
  if (review.model !== null && review.model !== undefined && typeof review.model !== 'string') {
    failValidation('review.model', '必须是字符串或 null', 'review.model 写模型名，或不写/写 null 用宿主默认。')
  }
  if (typeof review.requireForTaskGate !== 'boolean') {
    failValidation('review.requireForTaskGate', '必须是布尔值', 'review.requireForTaskGate 写 true 或 false。')
  }
  expectStringArray(config.ignore, 'ignore')
  if (!Array.isArray(config.rules)) failValidation('rules', '必须是数组', 'rules 写成规则对象数组；不追加规则时写 []。')
  const allowedDecisions: RuleDecision[] = ['allow', 'deny', 'human']
  config.rules.forEach((rule, index) => {
    if (!isPlainObject(rule) || typeof (rule as Rule).id !== 'string' || (rule as Rule).id.trim() === '') {
      failValidation(`rules[${index}].id`, '必须是字符串', '每条规则都要有唯一 id。')
    }
    if (!allowedDecisions.includes((rule as Rule).decision)) {
      failValidation(`rules[${index}].decision`, `只能取 allow / deny / human，实际为 ${JSON.stringify((rule as Rule).decision)}`, '规则的 decision 取 allow、deny 或 human。')
    }
    if (!isPlainObject((rule as Rule).when)) {
      failValidation(`rules[${index}].when`, '必须是对象', '规则需要 when 条件，例如 { stage: [S4] }。')
    }
  })
  const triggers: unknown = config.triggers
  if (!isPlainObject(triggers)) failValidation('triggers', '必须是对象', 'triggers 使用默认值或逐项覆盖。')
  expectStringArray(triggers.sensitive_paths, 'triggers.sensitive_paths')
  expectStringArray(triggers.sensitive_paths_extra, 'triggers.sensitive_paths_extra')
  expectStringArray(triggers.dependency_files, 'triggers.dependency_files')
  expectStringArray(triggers.protected_paths, 'triggers.protected_paths')
  if (!['builtin', 'builtin+extra'].includes(String(triggers.secret_patterns))) {
    failValidation('triggers.secret_patterns', '只能取 builtin / builtin+extra', 'secret_patterns 取 builtin 或 builtin+extra。')
  }
  expectFiniteNumber(triggers.max_scope_new_files, 'triggers.max_scope_new_files', { min: 0, integer: true })
  expectFiniteNumber(triggers.consecutive_failure_limit, 'triggers.consecutive_failure_limit', { min: 1, integer: true })
}

/** 解析配置文本并与默认值合并；语法错误抛出带行号的 {@link ConfigError}。 */
export function parseConfig(text: string): FlowgateConfig {
  return parseConfigWithPath(text, DEFAULT_CONFIG_PATH)
}

function parseConfigWithPath(text: string, sourcePath: string): FlowgateConfig {
  const trimmed = text.trim()
  let parsed: unknown
  if (trimmed === '') {
    parsed = {}
  } else {
    try {
      parsed = parseYaml(text)
    } catch (error) {
      const yamlError = error as YAMLParseError
      const position = Array.isArray(yamlError.linePos) ? yamlError.linePos[0] : undefined
      const line = position?.line
      const reason = (yamlError.message ?? '未知 YAML 解析错误').trim()
      const location = typeof line === 'number' ? `${sourcePath} 第 ${line} 行` : sourcePath
      throw new ConfigError(`配置文件解析失败（${location}）：${reason}`, {
        path: sourcePath,
        line,
        hint: '按 YAML 语法检查缩进、冒号与引号；修好后重试，或删除配置使用默认值。',
      })
    }
  }
  if (parsed === null || parsed === undefined) parsed = {}
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`配置文件解析失败（${sourcePath}）：根节点必须是 YAML 对象（键值对）`, {
      path: sourcePath,
      hint: 'config.yaml 的顶层应是 levels / commands / limits 等键值对，而不是数组或标量。',
    })
  }
  let merged: FlowgateConfig
  try {
    merged = deepMergeValue(defaultConfig(), parsed, '') as FlowgateConfig
    validateConfig(merged)
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(error.message, { path: sourcePath, line: error.line, hint: error.hint })
    }
    throw error
  }
  return merged
}

/** 读取 `.flowgate/config.yaml`；文件不存在时返回默认配置。 */
export async function loadConfig(fs: FileSystem, root: string): Promise<FlowgateConfig> {
  const path = configPath(root)
  let text: string
  try {
    if (!(await fs.exists(path))) return defaultConfig()
    text = await fs.readFile(path)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`无法读取配置文件（${path}）：${reason}`, {
      path,
      hint: '检查文件权限；或删除该文件使用默认配置。',
    })
  }
  return parseConfigWithPath(text, path)
}

/** 配置文件的仓库相对路径（与 layout().config 保持一致）。 */
export function configPath(root: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').trim()
  if (normalizedRoot === '' || normalizedRoot === '.' || normalizedRoot === './') return DEFAULT_CONFIG_PATH
  const trimmed = normalizedRoot.replace(/\/+$/, '')
  return trimmed === '' ? DEFAULT_CONFIG_PATH : `${trimmed}/${DEFAULT_CONFIG_PATH}`
}

/** 全量配置哈希（排序键后 sha256）；用于 `config.changed` 事件与「配置是否变化」。 */
export function configHash(config: FlowgateConfig): string {
  return sha256(stableJson(config))
}

/** 把完整配置渲染为 YAML 文本（初始化写默认配置、诊断时展示用）。 */
export function renderConfigYaml(config: FlowgateConfig): string {
  const body = stringifyYaml(config, { lineWidth: 0 })
  const header = [
    '# FlowGate 项目配置',
    '# 由 FlowGate 初始化生成，可手工修改；修改只影响新变更（进行中的变更按创建时冻结的契约，见 docs/03 §9.8）。',
    '# 字段说明见 docs/03-技术方案.md §9.5。commands.test 写 none 表示项目确实没有自动化测试。',
    '',
  ].join('\n')
  return `${header}${body.endsWith('\n') ? body : `${body}\n`}`
}
