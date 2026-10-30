import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, BUILTIN_RULE_IDS, RESERVED_RULE_IDS, loadRules, ruleById } from '../../../src/core/rules/builtin'
import { makeConfig } from '../state/fixtures'

const EXPECTED_IDS = [
  'R-PROTECTED',
  'R-ANALYSIS-READONLY',
  'R-DELEGATE',
  'R-STAGE-SRC',
  'R-PUSH',
  'R-SCOPE',
  'R-DELETE',
  'R-NEWFILE',
  'R-TDD-ORDER',
  'R-MCP',
]

describe('rules/builtin — 内置规则', () => {
  it('contains the contract rule ids with Chinese why/unlock and a valid decision', () => {
    expect(BUILTIN_RULES.map((rule) => rule.id)).toEqual(EXPECTED_IDS)
    expect(BUILTIN_RULE_IDS).toEqual(EXPECTED_IDS)
    for (const rule of BUILTIN_RULES) {
      expect(rule.why.length, rule.id).toBeGreaterThan(10)
      expect(rule.unlock.length, rule.id).toBeGreaterThan(10)
      expect(['allow', 'deny', 'human']).toContain(rule.decision)
      expect(rule.builtin).toBe(true)
    }
  })

  it('stages are only referenced on stage-scoped rules', () => {
    const stageRule = ruleById(BUILTIN_RULES, 'R-STAGE-SRC')!
    expect(stageRule.when.stage).toEqual(['S0', 'S1', 'S2', 'S3'])
    expect(stageRule.decision).toBe('deny')
    const scopeRule = ruleById(BUILTIN_RULES, 'R-SCOPE')!
    expect(scopeRule.when.stage).toEqual(['S4', 'S5'])
    expect(scopeRule.when.outside).toBe('task.scope')
  })

  it('includes the read-only analysis rule', () => {
    const analysis = ruleById(BUILTIN_RULES, 'R-ANALYSIS-READONLY')!
    expect(analysis.when.changeKind).toEqual(['analysis'])
    expect(analysis.when.action).toContain('write')
    expect(analysis.when.action).toContain('shell')
    expect(analysis.decision).toBe('deny')
  })

  it('loads built-ins plus trigger metadata, and lets config override by id', () => {
    const config = makeConfig()
    const rules = loadRules(config)
    const ids = rules.map((rule) => rule.id)
    for (const id of EXPECTED_IDS) expect(ids).toContain(id)
    for (const id of RESERVED_RULE_IDS) expect(ids).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
    // trigger rules are part of the effective registry so allow-once works
    expect(ids).toContain('T-SENSITIVE-PATH')
    expect(ids).toContain('T-SECRET')
  })

  it('partial config override merges onto the built-in (decision flip keeps why/when)', () => {
    const config = makeConfig({
      rules: [{ id: 'R-SCOPE', when: {}, decision: 'human', why: '自定义原因', unlock: '自定义解锁' }],
    })
    const rules = loadRules(config)
    const scope = ruleById(rules, 'R-SCOPE')!
    expect(scope.decision).toBe('human')
    expect(scope.why).toBe('自定义原因')
    expect(scope.unlock).toBe('自定义解锁')
    expect(scope.when.stage).toEqual(['S4', 'S5'])
    expect(scope.builtin).toBe(false)
    // built-ins are not duplicated
    expect(rules.filter((rule) => rule.id === 'R-SCOPE')).toHaveLength(1)
  })

  it('appends project rules in config order and can override trigger rules', () => {
    const config = makeConfig({
      rules: [
        {
          id: 'R-NO-TESTS-IN-TASK',
          when: { action: ['write'], path: '**/*.snap' },
          decision: 'deny',
          why: '快照文件不能手改',
          unlock: '重新生成而不是手改',
        },
        { id: 'T-SENSITIVE-PATH', when: {}, decision: 'deny', why: '敏感路径直接拒绝', unlock: '找负责人' },
      ],
    })
    const rules = loadRules(config)
    const custom = ruleById(rules, 'R-NO-TESTS-IN-TASK')!
    expect(custom.when.path).toBe('**/*.snap')
    expect(custom.builtin).toBe(false)
    const trigger = ruleById(rules, 'T-SENSITIVE-PATH')!
    expect(trigger.decision).toBe('deny')
    expect(trigger.why).toBe('敏感路径直接拒绝')
    // trigger rule order stays stable in the registry
    expect(rules.findIndex((rule) => rule.id === 'T-SENSITIVE-PATH')).toBeGreaterThan(
      rules.findIndex((rule) => rule.id === 'R-MCP'),
    )
  })

  it('ruleById returns undefined for unknown ids', () => {
    expect(ruleById(loadRules(makeConfig()), 'R-NOT-THERE')).toBeUndefined()
  })

  it('ignores malformed config rules instead of crashing', () => {
    const config = makeConfig({
      rules: [{ id: '' } as never, { decision: 'deny' } as never],
    })
    expect(() => loadRules(config)).not.toThrow()
    expect(loadRules(config).some((rule) => rule.id === '')).toBe(false)
  })
})
