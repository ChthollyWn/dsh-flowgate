import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  ConfigError,
  DEFAULT_CONFIG,
  configHash,
  loadConfig,
  parseConfig,
  renderConfigYaml,
} from '../../../src/core/store'

describe('config defaults', () => {
  it('DEFAULT_CONFIG 覆盖 03 §9.5 的关键字段', () => {
    expect(DEFAULT_CONFIG.levels).toEqual({ complexity: 'auto', risk: 'auto' })
    expect(DEFAULT_CONFIG.dispatch).toBe('auto')
    expect(DEFAULT_CONFIG.commands).toEqual({})
    expect(DEFAULT_CONFIG.limits.task_max_files).toBe(5)
    expect(DEFAULT_CONFIG.limits.change_max_tasks).toBe(12)
    expect(DEFAULT_CONFIG.limits.test_output_summary_tokens).toBe(400)
    expect(DEFAULT_CONFIG.limits.token_budget.low).toBe(200_000)
    expect(DEFAULT_CONFIG.parallel).toEqual({ max_agents: 3, setup: null, hotspots_extra: [] })
    expect(DEFAULT_CONFIG.session.lease_minutes).toBe(10)
    expect(DEFAULT_CONFIG.git).toEqual({ change_branch: true, auto_commit: true, commit_flowgate: false })
    expect(DEFAULT_CONFIG.review).toEqual({ enabled: true, model: null, requireForTaskGate: true })
    expect(DEFAULT_CONFIG.ignore).toEqual([])
    expect(DEFAULT_CONFIG.rules).toEqual([])
    expect(DEFAULT_CONFIG.triggers.sensitive_paths).toContain('**/payment*/**')
    expect(DEFAULT_CONFIG.triggers.dependency_files).toContain('pom.xml')
    expect(DEFAULT_CONFIG.triggers.max_scope_new_files).toBe(3)
    expect(DEFAULT_CONFIG.triggers.consecutive_failure_limit).toBe(3)
  })

  it('空文本解析为默认配置（深拷贝）', () => {
    const parsed = parseConfig('')
    expect(parsed).toEqual(DEFAULT_CONFIG)
    expect(parsed).not.toBe(DEFAULT_CONFIG)
    parsed.limits.task_max_files = 99
    expect(DEFAULT_CONFIG.limits.task_max_files).toBe(5)
  })
})

describe('config merge', () => {
  it('深合并：只覆盖写到的字段，其余保留默认', () => {
    const parsed = parseConfig(
      [
        'levels:',
        '  complexity: low',
        'commands:',
        '  test: ./mvnw -q test',
        'limits:',
        '  task_max_files: 8',
        'git:',
        '  commit_flowgate: true',
      ].join('\n'),
    )
    expect(parsed.levels.complexity).toBe('low')
    expect(parsed.levels.risk).toBe('auto')
    expect(parsed.commands.test).toBe('./mvnw -q test')
    expect(parsed.limits.task_max_files).toBe(8)
    expect(parsed.limits.change_max_tasks).toBe(12)
    expect(parsed.git.commit_flowgate).toBe(true)
    expect(parsed.git.change_branch).toBe(true)
  })

  it('commands.test: none 合法', () => {
    const parsed = parseConfig('commands:\n  test: none\n')
    expect(parsed.commands.test).toBe('none')
  })

  it('rules 数组按 id 覆盖/追加（同一 id 深合并）', () => {
    const parsed = parseConfig(
      [
        'rules:',
        '  - id: R-CUSTOM',
        '    when:',
        '      stage: [S4]',
        '    decision: deny',
        '    why: 自定义规则',
        '    unlock: 申请放行',
        '  - id: R-CUSTOM',
        '    decision: human',
        '  - id: R-ANOTHER',
        '    when: {}',
        '    decision: allow',
        '    why: 另一条',
        '    unlock: 无',
      ].join('\n'),
    )
    expect(parsed.rules).toHaveLength(2)
    const custom = parsed.rules.find((rule) => rule.id === 'R-CUSTOM')!
    expect(custom.decision).toBe('human') // 后出现的同 id 覆盖
    expect(custom.why).toBe('自定义规则') // 深合并保留原有字段
    expect(parsed.rules.map((rule) => rule.id)).toEqual(['R-CUSTOM', 'R-ANOTHER'])
  })

  it('triggers 基础数组整体覆盖、*_extra 数组追加去重', () => {
    const parsed = parseConfig(
      [
        'triggers:',
        '  sensitive_paths: ["custom/**"]',
        '  sensitive_paths_extra: ["src/billing/**"]',
        '  dependency_files: ["pnpm-lock.yaml"]',
        'parallel:',
        '  hotspots_extra: ["config/routes.ts"]',
      ].join('\n'),
    )
    expect(parsed.triggers.sensitive_paths).toEqual(['custom/**'])
    expect(parsed.triggers.sensitive_paths_extra).toEqual(['src/billing/**'])
    expect(parsed.triggers.dependency_files).toEqual(['pnpm-lock.yaml'])
    expect(parsed.triggers.protected_paths).toEqual(DEFAULT_CONFIG.triggers.protected_paths)
    expect(parsed.parallel.hotspots_extra).toEqual(['config/routes.ts'])
  })

  it('ignore 数组整体覆盖', () => {
    const parsed = parseConfig('ignore: ["**/generated/**"]\n')
    expect(parsed.ignore).toEqual(['**/generated/**'])
  })
})

describe('config errors', () => {
  it('损坏的 YAML 抛出带路径与行号的 ConfigError', () => {
    const text = ['levels:', '  complexity: [unclosed', '  risk: auto'].join('\n')
    let caught: unknown
    try {
      parseConfig(text)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const configError = caught as ConfigError
    expect(configError.path).toBe('.flowgate/config.yaml')
    expect(typeof configError.line).toBe('number')
    expect(configError.message).toContain('第 ')
    expect(configError.message).toContain('行')
    expect(configError.hint.length).toBeGreaterThan(0)
  })

  it('非法枚举值给出字段级错误', () => {
    expect(() => parseConfig('levels:\n  complexity: extreme\n')).toThrowError(/levels\.complexity/)
    expect(() => parseConfig('dispatch: everywhere\n')).toThrowError(/dispatch/)
    expect(() => parseConfig('git:\n  commit_flowgate: yes-please\n')).toThrowError(/git\.commit_flowgate/)
  })

  it('根节点不是对象时报错', () => {
    expect(() => parseConfig('- a\n- b\n')).toThrowError(/根节点/)
  })

  it('loadConfig 把实际文件路径写进错误（root 前缀）', async () => {
    const fs = new MemoryFileSystem({ '/repo/.flowgate/config.yaml': 'levels:\n  risk: [oops\n' })
    let caught: unknown
    try {
      await loadConfig(fs, '/repo')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as ConfigError).path).toBe('/repo/.flowgate/config.yaml')
  })
})

describe('config load & hash', () => {
  it('配置文件不存在时返回默认配置', async () => {
    const fs = new MemoryFileSystem()
    await expect(loadConfig(fs, '')).resolves.toEqual(DEFAULT_CONFIG)
  })

  it('读取并合并真实配置文件，且不修改 DEFAULT_CONFIG', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/config.yaml': 'triggers:\n  consecutive_failure_limit: 5\n',
    })
    const loaded = await loadConfig(fs, '')
    expect(loaded.triggers.consecutive_failure_limit).toBe(5)
    expect(DEFAULT_CONFIG.triggers.consecutive_failure_limit).toBe(3)
  })

  it('旧配置里遗留的 learning 键被忽略，不影响加载', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/config.yaml': 'learning: brief\ntriggers:\n  consecutive_failure_limit: 5\n',
    })
    const loaded = await loadConfig(fs, '')
    expect(loaded.triggers.consecutive_failure_limit).toBe(5)
    // 类型上已没有 learning；运行时多余键既不参与校验也不阻塞加载。
    expect((loaded as unknown as Record<string, unknown>).learning).toBe('brief')
  })

  it('configHash 确定且对配置变化敏感', () => {
    const base = parseConfig('')
    expect(configHash(base)).toBe(configHash(parseConfig('')))
    const changed = parseConfig('limits:\n  task_max_files: 6\n')
    expect(configHash(changed)).not.toBe(configHash(base))
    expect(configHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('renderConfigYaml 生成可回读的完整配置', () => {
    const yamlText = renderConfigYaml(DEFAULT_CONFIG)
    expect(yamlText).toContain('levels:')
    expect(parseConfig(yamlText)).toEqual(DEFAULT_CONFIG)
  })
})

describe('review 设置', () => {
  it('可逐项覆盖审查设置', () => {
    const parsed = parseConfig('review:\n  enabled: false\n  model: reviewer-large\n  requireForTaskGate: false\n')
    expect(parsed.review).toEqual({ enabled: false, model: 'reviewer-large', requireForTaskGate: false })
  })

  it('review.enabled 必须是布尔值', () => {
    expect(() => parseConfig('review:\n  enabled: maybe\n')).toThrowError(/review\.enabled/)
  })
})
