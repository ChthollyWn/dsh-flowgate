/**
 * Level suggestion (FR-6.5).
 *
 * Deterministic, explainable scoring: keyword signals, number of paths, module
 * count and sensitive paths. Complexity and risk are scored independently and
 * every suggestion carries Chinese reasons the owner can read and override.
 */
import type { Complexity, FlowgateConfig, LevelSuggestion, RiskLevel } from '../types'

export interface LevelSignalInput {
  title: string
  summary?: string
  /** Repository-relative paths the change is expected to touch. */
  paths?: string[]
  /** Module names or module paths the change spans. */
  modules?: string[]
  config?: FlowgateConfig
}

/**
 * Built-in sensitive areas (03 §8.2). Kept private here so `state/**` does not
 * depend on `rules/**`; `rules/risk-triggers.ts` owns the authoritative list used
 * for interception, this one only feeds the *suggestion*.
 */
const SUGGEST_SENSITIVE_PATHS: string[] = [
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

interface WeightedKeyword {
  words: string[]
  weight: number
  reason: string
}

const LOW_COMPLEXITY_KEYWORDS: WeightedKeyword[] = [
  {
    words: ['文案', '错别字', '拼写', 'typo', '改颜色', '样式', '颜色', 'logo', '文案调整', 'copy change'],
    weight: -3,
    reason: '需求只涉及文案/样式等边界明确的小改动',
  },
  {
    words: ['单文件', '局部修改', '小修', '一行', '配置值'],
    weight: -2,
    reason: '描述的是局部小修改',
  },
]

const MEDIUM_COMPLEXITY_KEYWORDS: WeightedKeyword[] = [
  {
    words: ['新增', '添加', '实现', '功能', '接口', '页面', '组件', '支持', '改造', 'feature', 'add ', 'implement', 'endpoint', 'component'],
    weight: 1,
    reason: '包含新增功能/接口类信号',
  },
]

const HIGH_COMPLEXITY_KEYWORDS: WeightedKeyword[] = [
  {
    words: ['重构', '跨模块', '多模块', '迁移', '升级', '重写', 'refactor', 'architecture', 'migration', 'rewrite', 'upgrade', '替换框架'],
    weight: 3,
    reason: '包含重构/迁移/跨模块等大范围改动信号',
  },
]

const ULTRA_COMPLEXITY_KEYWORDS: WeightedKeyword[] = [
  {
    words: ['新系统', '从零', '平台', '大范围', '全面重做', '全新模块', 'platform', 'from scratch', 'overhaul'],
    weight: 5,
    reason: '描述的是新系统/平台级改动',
  },
]

const RISK_KEYWORDS: { words: string[]; label: string }[] = [
  { words: ['鉴权', '认证', '登录', '权限', 'auth', 'login', 'oauth', 'session'], label: '触及鉴权/权限' },
  { words: ['支付', '扣款', '退款', '回调', '验签', 'payment', 'webhook'], label: '触及支付/回调' },
  { words: ['迁移', '数据库结构', 'schema', 'migration', 'ddl', 'sql'], label: '触及数据迁移/SQL' },
  { words: ['密钥', '私钥', '证书', 'secret', 'token', 'credential', 'password'], label: '触及密钥/凭据' },
  { words: ['基础设施', '部署', '上线', '生产', 'dockerfile', 'k8s', 'ci/cd', 'workflow', 'production', 'deploy'], label: '触及基础设施/生产配置' },
  { words: ['删除', '移除功能', '下线', 'breaking', '公共接口', 'public api'], label: '触及删除或公共接口变更' },
]

const SENSITIVE_SUGGESTION_PATTERNS = SUGGEST_SENSITIVE_PATHS

interface PathMatcher {
  test: (path: string) => boolean
}

/** Minimal glob in the same dialect as `util/glob` but kept local to avoid extra coupling. */
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

function pathMatchesAny(path: string, patterns: string[]): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalized)) return pattern
  }
  return null
}

function containsAny(text: string, words: string[]): string | null {
  const lower = text.toLowerCase()
  for (const word of words) {
    if (lower.includes(word.toLowerCase())) return word
  }
  return null
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))].sort()
}

/** Suggest complexity and risk with reasons (FR-6.5). */
export function suggestLevels(input: LevelSignalInput): LevelSuggestion {
  const text = `${input.title} ${input.summary ?? ''}`.trim()
  const paths = uniqueSorted((input.paths ?? []).map((path) => path.replace(/\\/g, '/')))
  const modules = uniqueSorted(input.modules ?? [])
  const complexityReasons: string[] = []
  const riskReasons: string[] = []
  let score = 0

  for (const group of [
    ...LOW_COMPLEXITY_KEYWORDS,
    ...MEDIUM_COMPLEXITY_KEYWORDS,
    ...HIGH_COMPLEXITY_KEYWORDS,
    ...ULTRA_COMPLEXITY_KEYWORDS,
  ]) {
    const hits = group.words.filter((word) => text.toLowerCase().includes(word.toLowerCase()))
    if (hits.length === 0) continue
    score += group.weight * hits.length
    complexityReasons.push(`${group.reason}（信号："${hits.join('"、"')}"）`)
  }

  const pathCount = paths.length
  if (pathCount >= 21) {
    score += 5
    complexityReasons.push(`预计涉及 ${pathCount} 个文件，范围很大`)
  } else if (pathCount >= 9) {
    score += 3
    complexityReasons.push(`预计涉及 ${pathCount} 个文件，超过单任务规模`)
  } else if (pathCount >= 4) {
    score += 2
    complexityReasons.push(`预计涉及 ${pathCount} 个文件`)
  } else if (pathCount >= 2) {
    score += 1
    complexityReasons.push(`预计涉及 ${pathCount} 个文件`)
  } else if (pathCount === 1) {
    complexityReasons.push('预计只涉及 1 个文件')
  }

  const moduleCount = modules.length
  if (moduleCount >= 4) {
    score += 3
    complexityReasons.push(`横跨 ${moduleCount} 个模块`)
  } else if (moduleCount >= 2) {
    score += 1
    complexityReasons.push(`横跨 ${moduleCount} 个模块`)
  }

  const topDirs = uniqueSorted(
    paths.map((path) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '.')),
  )
  if (topDirs.length >= 3) {
    score += 1
    complexityReasons.push(`改动分布在 ${topDirs.length} 个顶层目录`)
  }

  let complexity: Complexity
  if (score >= 6) complexity = 'ultra'
  else if (score >= 3) complexity = 'high'
  else if (score >= 1) complexity = 'medium'
  else complexity = 'low'
  if (complexity === 'low' && complexityReasons.length === 0) {
    complexityReasons.push('没有发现跨模块或大范围改动信号，按边界明确的局部修改处理')
  }

  // ---- risk -------------------------------------------------------------
  let risk: RiskLevel = 'normal'
  const extraSensitive = input.config?.triggers.sensitive_paths ?? []
  const extraSensitiveMore = input.config?.triggers.sensitive_paths_extra ?? []
  const sensitivePatterns = [
    ...SENSITIVE_SUGGESTION_PATTERNS,
    ...extraSensitive,
    ...extraSensitiveMore,
  ]
  const sensitiveHits: string[] = []
  for (const path of paths) {
    const pattern = pathMatchesAny(path, sensitivePatterns)
    if (pattern) sensitiveHits.push(`${path}（${pattern}）`)
  }
  if (sensitiveHits.length > 0) {
    risk = 'high'
    riskReasons.push(`预计修改敏感路径：${sensitiveHits.join('、')}`)
  }
  for (const group of RISK_KEYWORDS) {
    const hit = containsAny(text, group.words)
    if (hit) {
      risk = 'high'
      riskReasons.push(`${group.label}，属于高风险信号（"${hit}"）`)
    }
  }
  if (risk === 'normal') {
    riskReasons.push('没有命中敏感路径或高风险关键词，按普通风险处理；S3 仍需登记五类风险')
  }

  return {
    complexity,
    risk,
    reasons: {
      complexity: uniqueSorted(complexityReasons),
      risk: uniqueSorted(riskReasons),
    },
  }
}
