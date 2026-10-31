/**
 * Branch-focused tests for the ordered rule pipeline (rules/evaluate.ts).
 *
 * Each case drives a public entry point (`evaluateRules` / `actionTargetPath` /
 * `fingerprintAction` / `looksLikeTestPath` / `explainDecision`) and asserts the
 * agent-visible outcome (effect / matched rule / pending draft / notes), so the
 * uncovered arms are exercised through real guard decisions rather than by
 * calling internal helpers.
 */
import { describe, expect, it } from 'vitest'
import type {
  Action,
  ChangeStatus,
  ExceptionRecord,
  FlowgateConfig,
  OverrideRecord,
  PendingItem,
  Rule,
} from '../../../src/core/types'
import {
  actionTargetPath,
  explainDecision,
  fingerprintAction,
  looksLikeTestPath,
} from '../../../src/core/rules/evaluate'
import { AT, evaluate, makeChange, makeConfig, makeTask } from './fixtures'
import { makeTaskState } from '../state/fixtures'

const EXEC_SCOPE_PATH = 'src/main/java/com/acme/renewal/Impl.java'

function customRule(overrides: Partial<Rule>): Rule {
  return {
    id: 'P-1',
    when: {},
    decision: 'deny',
    why: '项目自定规则',
    unlock: '改 .flowgate/config.yaml',
    ...overrides,
  }
}

function configWithRules(...rules: Rule[]): FlowgateConfig {
  return makeConfig({ rules })
}

/** S4 with a green TDD task whose scope contains EXEC_SCOPE_PATH. */
function execChange(): ChangeStatus {
  return makeChange({ stage: 'S4', tasks: { T3: makeTaskState({ tdd: 'green' }) } })
}

function execTask() {
  return makeTask()
}

describe('rules/evaluate — action helpers 的边界分支', () => {
  it('归一化后为空路径的 action 没有 target，S6 交付策略也放行', () => {
    expect(actionTargetPath({ kind: 'write', tool: 'write', path: './' })).toBeUndefined()
    expect(actionTargetPath({ kind: 'read', tool: 'read', path: '.' })).toBeUndefined()
    // target 为 undefined 时 S6 交付限制无法判定路径，按放行处理（合法路径由写工具校验）
    expect(evaluate({ kind: 'write', tool: 'write', path: './' }, { stage: 'S6' }).effect).toBe('allow')
  })

  it('fingerprintAction 纳入 rename 目标、shell cwd、delegate target 与 generic detail', () => {
    const renameA = fingerprintAction({ kind: 'rename', tool: 'bash', path: 'src/a.ts', toPath: 'src/b.ts' })
    const renameB = fingerprintAction({ kind: 'rename', tool: 'bash', path: 'src/a.ts', toPath: 'src/c.ts' })
    expect(renameA).not.toBe(renameB)

    const shell = fingerprintAction({ kind: 'shell', tool: 'bash', command: 'ls' })
    expect(fingerprintAction({ kind: 'shell', tool: 'bash', command: 'ls', cwd: 'sub' })).not.toBe(shell)

    const delegate = fingerprintAction({ kind: 'delegate', tool: 'subagent' })
    expect(fingerprintAction({ kind: 'delegate', tool: 'subagent', target: 'task-x' })).not.toBe(delegate)
    // 空 target 视为没有 target，指纹与不带 target 一致
    expect(fingerprintAction({ kind: 'delegate', tool: 'subagent', target: '' })).toBe(delegate)

    expect(fingerprintAction({ kind: 'other', tool: 'mystery', detail: 'd' })).not.toBe(
      fingerprintAction({ kind: 'other', tool: 'mystery' }),
    )
  })

  it('looksLikeTestPath 覆盖空路径、目录约定与各语言测试命名', () => {
    expect(looksLikeTestPath('')).toBe(false)
    expect(looksLikeTestPath('.')).toBe(false)
    expect(looksLikeTestPath('spec/order.spec.ts')).toBe(true)
    expect(looksLikeTestPath('__tests__/x.js')).toBe(true)
    expect(looksLikeTestPath('src/renewal_test.go')).toBe(true)
    expect(looksLikeTestPath('test_api.py')).toBe(true)
    expect(looksLikeTestPath('src/Renewal.spec.cs')).toBe(true)
    expect(looksLikeTestPath('src/Renewal.spec.php')).toBe(true)
    expect(looksLikeTestPath('src/RenewalTest.java')).toBe(true)
    expect(looksLikeTestPath('src/RenewalTest.kt')).toBe(true)
    expect(looksLikeTestPath('src/renewal.php')).toBe(false)
  })
})

describe('rules/evaluate — 自定义规则条件（config.rules）', () => {
  it('stage / action / tool / path 条件不满足时不触发，满足时拒绝', () => {
    const fileAction = { kind: 'write' as const, tool: 'write', path: 'docs/release.md' }
    const config = configWithRules(
      customRule({ when: { stage: ['S4'], action: ['shell'], tool: ['bash'], path: 'src/**' } }),
    )
    // 三个条件全不满足：默认允许
    expect(evaluate(fileAction, { stage: 'S6', config }).effect).toBe('allow')
    // 只满足 stage（S6 写入被交付物策略放行后由自定义规则拒绝）
    const match = evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, {
      stage: 'S6',
      config: configWithRules(customRule({ when: { stage: ['S6'], action: ['shell'], tool: ['bash'] } })),
    })
    expect(match).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    expect(match.message).toContain('项目规则 P-1')
    // tool 条件不匹配
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { tool: ['write'] } })),
      }).effect,
    ).toBe('allow')
    // path 条件对 shell 动作（无 target）不成立
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { path: 'src/**' } })),
      }).effect,
    ).toBe('allow')
    // path 匹配 + except 命中 -> 不触发
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/secret/x.md' }, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { path: 'docs/**', except: ['docs/secret/**'] } })),
      }).effect,
    ).toBe('allow')
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { path: 'docs/**', except: ['docs/secret/**'] } })),
      }).effect,
    ).toBe('deny')
  })

  it('command 条件按命令分类匹配；对文件动作恒不匹配', () => {
    const testCommand = { kind: 'shell' as const, tool: 'bash', command: 'pnpm vitest run' }
    expect(
      evaluate(testCommand, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { command: ['test'] } })),
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    expect(
      evaluate(testCommand, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { command: ['build'] } })),
      }).effect,
    ).toBe('allow')
    // 文件动作没有命令可分类 -> 条件不成立
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, {
        stage: 'S6',
        config: configWithRules(customRule({ when: { command: ['test'] } })),
      }).effect,
    ).toBe('allow')
  })

  it('secret 条件覆盖文件内容、shell 命令与无内容动作', () => {
    // 关闭内置 T-SECRET 触发器，才能观察项目规则自身的 secret 条件分支
    const secretConfig = makeConfig({
      rules: [customRule({ id: 'T-SECRET', when: {}, decision: 'allow', why: '项目自行处理' }), customRule({ when: { secret: true } })],
    })
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md', content: 'AKIAIOSFODNN7EXAMPLE' }, {
        stage: 'S6',
        config: secretConfig,
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'export KEY=AKIAIOSFODNN7EXAMPLE' }, {
        stage: 'S6',
        config: secretConfig,
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    // 无 content / 无 command 的动作：条件不成立
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, { stage: 'S6', config: secretConfig }).effect,
    ).toBe('allow')
    expect(
      evaluate({ kind: 'read', tool: 'read', path: 'docs/x.md' }, { stage: 'S6', config: secretConfig }).effect,
    ).toBe('allow')
    // 内容不含密钥
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md', content: '普通文本' }, {
        stage: 'S6',
        config: secretConfig,
      }).effect,
    ).toBe('allow')
  })

  it('outside 条件：无任务 / 无变更 / 无 target / 在范围内 各自的分支', () => {
    const outside = configWithRules(customRule({ when: { outside: 'task.scope' } }))
    // 无 task -> 视为"在范围外" -> 拒绝
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, { stage: 'S6', config: outside }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    // 无 change -> 同样视为范围外
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, { stage: 'S6', config: outside }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })

    // 有 change + task 但动作没有 target（shell）：无法证明在范围内 -> 拒绝
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, {
        stage: 'S6',
        change: makeChange({ stage: 'S6' }),
        task: execTask(),
        config: outside,
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })

    // 目标在任务允许范围内 -> 条件不成立 -> 默认允许
    const inScope = evaluate({ kind: 'write', tool: 'write', path: EXEC_SCOPE_PATH }, {
      change: execChange(),
      task: execTask(),
      config: outside,
    })
    expect(inScope.effect).toBe('allow')
    expect(inScope.rule).toBeUndefined()
  })

  it('pending 条件只认 open 且 kind 匹配的待处理项', () => {
    const config = configWithRules(customRule({ when: { pending: 'risk' } }))
    const openRisk: PendingItem = {
      id: 'P-9',
      kind: 'risk',
      changeId: 'C-001',
      title: '风险确认',
      detail: 'd',
      status: 'open',
      createdAt: AT,
    }
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, {
        stage: 'S6',
        change: makeChange({ stage: 'S6' }),
        config,
        pending: [openRisk],
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    // 已处理的待处理项不算
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, {
        stage: 'S6',
        change: makeChange({ stage: 'S6' }),
        config,
        pending: [{ ...openRisk, status: 'approved' }],
      }).effect,
    ).toBe('allow')
    // kind 不匹配不算
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'docs/x.md' }, {
        stage: 'S6',
        change: makeChange({ stage: 'S6' }),
        config,
        pending: [{ ...openRisk, kind: 'scope' }],
      }).effect,
    ).toBe('allow')
  })

  it('changeKind 条件区分 analysis 变更与普通变更、无变更', () => {
    const config = configWithRules(customRule({ when: { changeKind: ['analysis'] } }))
    expect(
      evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, {
        stage: 'S4',
        change: makeChange({ stage: 'S4', kind: 'analysis' }),
        config,
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'P-1' } })
    expect(
      evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, {
        stage: 'S4',
        change: makeChange({ stage: 'S4' }),
        config,
      }).effect,
    ).toBe('allow')
    expect(
      evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, {
        stage: 'S4',
        config,
      }).effect,
    ).toBe('allow')
  })

  it('自定义 allow 规则成为默认允许的归因规则', () => {
    const decision = evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, {
      stage: 'S6',
      config: configWithRules(customRule({ decision: 'allow', why: '只读放行' })),
    })
    expect(decision).toMatchObject({ effect: 'allow', rule: { ruleId: 'P-1', decision: 'allow' } })
  })
})

describe('rules/evaluate — 发布（push）分支', () => {
  const push = (command: string): Action => ({ kind: 'shell', tool: 'bash', command })

  it('G6 之前的推送被拒绝', () => {
    // 没有变更信息 -> 视为 G6 未通过
    expect(evaluate(push('git push origin main'), { stage: 'S6' })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-PUSH' },
    })
    expect(
      evaluate(push('git push origin main'), {
        stage: 'S6',
        change: makeChange({ stage: 'S6' }),
      }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PUSH' } })
  })

  it('G6 通过或已归档后，推送转负责人确认并带待处理项', () => {
    const g6Passed = makeChange({ stage: 'S6' })
    g6Passed.gates = { G6: { state: 'passed', attempts: 1 } }
    const decision = evaluate(push('git push origin main'), { stage: 'S6', change: g6Passed })
    expect(decision.effect).toBe('human')
    expect(decision.rule?.ruleId).toBe('R-PUSH')
    expect(decision.pendingDraft?.kind).toBe('risk')
    expect(decision.pendingDraft?.title).toContain('R-PUSH')
    // 已归档变更同样视为 G6 已过
    expect(
      evaluate(push('git push origin main'), {
        stage: 'archived',
        change: makeChange({ stage: 'archived' }),
      }).effect,
    ).toBe('human')
  })

  it('R-PUSH 被项目配置改成 allow 时直接放行', () => {
    const config = configWithRules(
      customRule({ id: 'R-PUSH', decision: 'allow', why: '项目允许自动推送' }),
    )
    expect(evaluate(push('git push origin main'), { stage: 'S4', config })).toMatchObject({
      effect: 'allow',
      rule: { ruleId: 'R-PUSH', decision: 'allow' },
    })
  })
})

describe('rules/evaluate — 阶段策略分支', () => {
  it('roadmap 阶段文件写入只允许项目级产物，命令只允许只读/回滚', () => {
    const change = makeChange({ stage: 'roadmap', id: 'PROJECT' })
    expect(
      evaluate({ kind: 'write', tool: 'write', path: '.flowgate/project-clarify.md' }, {
        change,
      }).effect,
    ).toBe('allow')
    expect(
      evaluate({ kind: 'write', tool: 'write', path: 'src/feature.ts' }, { change }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'rm -rf src' }, { change }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
    expect(
      evaluate({ kind: 'shell', tool: 'bash', command: 'git status' }, { change }).effect,
    ).toBe('allow')
  })

  it('archived 阶段：写文件 / MCP / delegate 拒绝，只读与 FlowGate 工具放行', () => {
    const change = makeChange({ stage: 'archived' })
    expect(evaluate({ kind: 'write', tool: 'write', path: 'src/a.ts' }, { change })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-STAGE-SRC' },
    })
    expect(evaluate({ kind: 'mcp', tool: 'mcp__demo' }, { change })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-STAGE-SRC' },
    })
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { change }).effect).toBe('allow')
    expect(evaluate({ kind: 'other', tool: 'flow_status' }, { change }).effect).toBe('allow')
    // delegate 被更早的 R-DELEGATE 拦住；关闭该规则后由 archived 只读策略兜底
    const allowDelegation = configWithRules(customRule({ id: 'R-DELEGATE', decision: 'allow' }))
    expect(
      evaluate({ kind: 'delegate', tool: 'bash' } as Action, { change, config: allowDelegation }),
    ).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
  })

  it('锁定模式拦截会改仓库的动作，但只读放行；锁定不可被 allow-once 抵消', () => {
    const locked = makeChange({ stage: 'S4' })
    locked.lifecycle = 'locked'
    locked.lock = { reason: '账本被篡改', at: AT }
    const decision = evaluate({ kind: 'write', tool: 'write', path: EXEC_SCOPE_PATH }, {
      change: locked,
      task: execTask(),
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-LOCK' } })
    expect(decision.message).toContain('账本被篡改')
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { change: locked }).effect).toBe('allow')

    const override: OverrideRecord = {
      id: 'OV-LOCK',
      ruleId: 'R-LOCK',
      changeId: 'C-001',
      reason: '想绕过',
      actionFingerprint: '',
      createdAt: AT,
    }
    const withOverride = evaluate({ kind: 'write', tool: 'write', path: EXEC_SCOPE_PATH }, {
      change: locked,
      task: execTask(),
      overrides: [override],
    })
    expect(withOverride.effect).toBe('deny')
    expect(withOverride.overrideUsed).toBeUndefined()
  })
})

describe('rules/evaluate — 范围 / 新文件 / TDD 分支', () => {
  it('未声明的新文件走 R-NEWFILE 并带可执行的解锁提示', () => {
    const decision = evaluate({ kind: 'create', tool: 'write', path: 'src/main/java/com/acme/renewal/New.java' }, {
      change: execChange(),
      task: execTask(),
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-NEWFILE' } })
    expect(decision.message).toContain('new_files')
  })

  it('R-SCOPE 被改成 allow 时不再按范围拒绝', () => {
    const config = configWithRules(customRule({ id: 'R-SCOPE', decision: 'allow' }))
    const decision = evaluate({ kind: 'write', tool: 'write', path: 'unrelated/file.ts' }, {
      change: execChange(),
      task: execTask(),
      config,
    })
    expect(decision.effect).toBe('allow')
    expect(decision.rule?.ruleId).toBe('R-SCOPE')
  })

  it('R-TDD-ORDER 被改成 allow 时成为默认允许的归因规则', () => {
    const config = configWithRules(customRule({ id: 'R-TDD-ORDER', decision: 'allow' }))
    const decision = evaluate({ kind: 'write', tool: 'write', path: EXEC_SCOPE_PATH }, {
      change: makeChange({ stage: 'S4' }),
      task: execTask(),
      config,
    })
    expect(decision).toMatchObject({ effect: 'allow', rule: { ruleId: 'R-TDD-ORDER' } })
  })

  it('删除与重命名按 R-DELETE 处理；重命名目标越界同样拒绝', () => {
    const task = makeTask()
    const rename = evaluate(
      { kind: 'rename', tool: 'bash', path: EXEC_SCOPE_PATH, toPath: 'elsewhere/Impl.java' },
      { change: execChange(), task },
    )
    expect(rename).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-DELETE' } })
    const remove = evaluate({ kind: 'delete', tool: 'bash', path: EXEC_SCOPE_PATH }, {
      change: execChange(),
      task,
    })
    expect(remove).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-DELETE' } })
  })
})

describe('rules/evaluate — 未知工具与覆盖自检', () => {
  it('MCP 动作转人工并生成 risk 待处理项；other 且已分类工具放行', () => {
    const mcp = evaluate({ kind: 'mcp', tool: 'mcp__demo' }, { stage: 'S4' })
    expect(mcp.effect).toBe('human')
    expect(mcp.rule?.ruleId).toBe('R-MCP')
    expect(mcp.pendingDraft).toMatchObject({ kind: 'risk' })
    expect(mcp.pendingDraft?.detail).toContain('mcp: mcp__demo')

    // kind=other 但分类已覆盖：不转人工
    const covered = evaluate({ kind: 'other', tool: 'flow_status' }, { stage: 'S4' })
    expect(covered.effect).toBe('allow')
    // kind=other 且未知工具：转人工
    expect(evaluate({ kind: 'other', tool: 'mystery_tool' }, { stage: 'S4' }).effect).toBe('human')
  })

  it('R-MCP 被配置成 allow 时成为默认允许的归因规则', () => {
    const config = configWithRules(customRule({ id: 'R-MCP', decision: 'allow' }))
    const decision = evaluate({ kind: 'mcp', tool: 'mcp__demo' }, { stage: 'S4', config })
    expect(decision).toMatchObject({ effect: 'allow', rule: { ruleId: 'R-MCP' } })
  })
})

describe('rules/evaluate — 例外与单次放行分支', () => {
  it('override 只认同一变更；例外可匹配 rename 目标与 shell 命令里的路径', () => {
    const stageWrite = { kind: 'write', tool: 'write', path: 'src/a.ts' } as const

    const otherChangeOverride: OverrideRecord = {
      id: 'OV-2',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-999',
      reason: 'r',
      actionFingerprint: '',
      createdAt: AT,
    }
    const wrongChange = evaluate(stageWrite, {
      stage: 'S2',
      change: makeChange({ stage: 'S2' }),
      overrides: [otherChangeOverride],
    })
    expect(wrongChange.effect).toBe('deny')
    expect(wrongChange.overrideUsed).toBeUndefined()

    // rename：源路径不匹配例外模式，但目标路径匹配
    const renameException: ExceptionRecord = {
      id: 'EX-R',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      pathPattern: 'src/moved/**',
      reason: '允许迁移',
      createdAt: AT,
    }
    const rename = evaluate(
      { kind: 'rename', tool: 'bash', path: 'src/a.ts', toPath: 'src/moved/a.ts' },
      { stage: 'S2', change: makeChange({ stage: 'S2' }), exceptions: [renameException] },
    )
    expect(rename).toMatchObject({ effect: 'allow', exceptionUsed: 'EX-R' })

    // shell：命令文本里包含例外模式
    const commandException: ExceptionRecord = {
      id: 'EX-C',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      pathPattern: 'src/a.ts',
      reason: '允许回写',
      createdAt: AT,
    }
    const shell = evaluate(
      { kind: 'shell', tool: 'bash', command: 'echo x >> src/a.ts' },
      { stage: 'S2', change: makeChange({ stage: 'S2' }), exceptions: [commandException] },
    )
    expect(shell).toMatchObject({ effect: 'allow', exceptionUsed: 'EX-C' })

    // shell：命令文本不含通配模式，但解析出的写目标匹配 glob
    const globException: ExceptionRecord = {
      id: 'EX-G',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      pathPattern: 'src/**/*.ts',
      reason: '允许批量回写',
      createdAt: AT,
    }
    const shellGlob = evaluate(
      { kind: 'shell', tool: 'bash', command: 'echo x >> src/a.ts' },
      { stage: 'S2', change: makeChange({ stage: 'S2' }), exceptions: [globException] },
    )
    expect(shellGlob).toMatchObject({ effect: 'allow', exceptionUsed: 'EX-G' })
  })

  it('受保护路径的拒绝不能被 override / exception 抵消', () => {
    const protectedWrite = { kind: 'write', tool: 'write', path: '.flowgate/state/status.json' } as const
    const override: OverrideRecord = {
      id: 'OV-P',
      ruleId: 'R-PROTECTED',
      changeId: 'C-001',
      reason: 'r',
      actionFingerprint: '',
      createdAt: AT,
    }
    const decision = evaluate(protectedWrite, {
      change: makeChange({ stage: 'S4' }),
      task: execTask(),
      overrides: [override],
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PROTECTED' } })
    expect(decision.overrideUsed).toBeUndefined()
  })
})

describe('rules/evaluate — explainDecision 分支', () => {
  it('默认允许没有规则归因，human 决策带待处理项，allow 带例外/提示', () => {
    const plain = evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { stage: 'S0' })
    expect(explainDecision(plain, { stage: 'S0' }).short).toBe('允许')

    const human = evaluate({ kind: 'mcp', tool: 'mcp__demo' }, { stage: 'S4' })
    const card = explainDecision(human, { stage: 'S4', changeId: 'C-001' }).card
    expect(card['判定']).toBe('需要人工确认')
    expect(card['待处理项']).toContain('risk')
    expect(card['变更']).toBe('C-001')

    const exception: ExceptionRecord = {
      id: 'EX-1',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      pathPattern: 'src/**',
      reason: 'r',
      createdAt: AT,
    }
    const allowed = evaluate({ kind: 'write', tool: 'write', path: 'src/a.ts' }, {
      stage: 'S2',
      change: makeChange({ stage: 'S2' }),
      exceptions: [exception],
    })
    const allowedCard = explainDecision(allowed, { stage: 'S2' }).card
    expect(allowedCard['例外']).toBe('EX-1')
    expect(allowedCard['提示']).toContain('EX-1')
  })
})
