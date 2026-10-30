import { describe, expect, it } from 'vitest'
import type { Action, ExceptionRecord, FileAction, OverrideRecord, PendingItem, Violation } from '../../../src/core/types'
import {
  actionTargetPath,
  evaluateRules,
  explainDecision,
  fingerprintAction,
} from '../../../src/core/rules/evaluate'
import { AT, evaluate, makeChange, makeConfig, makeTask } from './fixtures'
import { makeTaskState } from '../state/fixtures'

const GREEN_TASKS = { T3: makeTaskState({ id: 'T3', tdd: 'green' }) }

function greenChange(stage: NonNullable<Parameters<typeof makeChange>[0]>['stage'] = 'S4') {
  return makeChange({ stage, tasks: GREEN_TASKS })
}

function write(path: string, content?: string): FileAction {
  const action: FileAction = { kind: 'write', tool: 'write', path }
  if (content !== undefined) action.content = content
  return action
}

function edit(path: string): FileAction {
  return { kind: 'write', tool: 'edit', path }
}

function shell(command: string): Action {
  return { kind: 'shell', tool: 'bash', command }
}

function assertBlockedMessage(message: string, stage: string, ruleId: string): void {
  expect(message).toContain(stage)
  expect(message).toContain(ruleId)
  expect(message).toContain('为什么：')
  expect(message).toContain('解锁：')
}

describe('rules/evaluate — 默认与阶段策略（FR-4.1 / T1.2）', () => {
  it('allows ordinary reads and in-scope writes by default', () => {
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/app.ts' }, { change: greenChange() })).toEqual({
      effect: 'allow',
      message: '',
    })
    expect(
      evaluate(write('src/main/java/com/acme/renewal/Impl.java'), { change: greenChange() }),
    ).toMatchObject({ effect: 'allow' })
  })

  // T1.2 acceptance: GIVEN 处于 S3 的 edit 动作 WHEN 判定 THEN 拒绝，解释包含阶段、规则 id、为什么、怎么解锁
  it('T1.2: edit in S3 is denied with stage / rule id / why / unlock', () => {
    const decision = evaluate(edit('src/main/java/com/acme/renewal/RenewalService.java'), {
      stage: 'S3',
    })
    expect(decision.effect).toBe('deny')
    expect(decision.rule?.ruleId).toBe('R-STAGE-SRC')
    assertBlockedMessage(decision.message, 'S3', 'R-STAGE-SRC')
    const { short, card } = explainDecision(decision, { stage: 'S3', changeId: 'C-001' })
    expect(short).toBe(decision.message)
    expect(card['阶段']).toBe('S3 设计拆解')
    expect(card['规则']).toBe('R-STAGE-SRC')
    expect(card['为什么']).toBeTruthy()
    expect(card['怎么解锁']).toBeTruthy()
    expect(card['变更']).toBe('C-001')
  })

  it('S0-S3 deny source writes but allow the change artifacts of the current stage', () => {
    for (const stage of ['S0', 'S1', 'S2', 'S3'] as const) {
      const denied = evaluate(write('src/main/java/com/acme/renewal/A.java'), { stage })
      expect(denied.effect, stage).toBe('deny')
      expect(denied.rule?.ruleId, stage).toBe('R-STAGE-SRC')
    }
    expect(
      evaluate(write('.flowgate/changes/C-001/clarify.md'), { stage: 'S1' }),
    ).toMatchObject({ effect: 'allow' })
    expect(
      evaluate(write('.flowgate/changes/C-001/context.md'), { stage: 'S2' }),
    ).toMatchObject({ effect: 'allow' })
    expect(
      evaluate(write('.flowgate/changes/C-001/tasks.md'), { stage: 'S3' }),
    ).toMatchObject({ effect: 'allow' })
    // an artifact of the wrong stage is still source-like
    expect(evaluate(write('.flowgate/changes/C-001/design.md'), { stage: 'S1' })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-STAGE-SRC' },
    })
  })

  it('S0-S3 allow test/build/lint commands and revert commands, deny mutating commands', () => {
    for (const command of ['mvn -B test', 'pnpm vitest run', 'pnpm lint', './gradlew build']) {
      expect(evaluate(shell(command), { stage: 'S2' }).effect, command).toBe('allow')
    }
    for (const command of ['echo x >> src/main/java/A.java', 'sed -i s/a/b/ src/main/java/A.java', 'rm -rf src']) {
      const decision = evaluate(shell(command), { stage: 'S1' })
      expect(decision.effect, command).toBe('deny')
      expect(decision.rule?.ruleId, command).toBe('R-STAGE-SRC')
    }
    // reverting an out-of-scope edit must stay possible
    expect(evaluate(shell('git checkout -- src/main/java/A.java'), { stage: 'S1' }).effect).toBe('allow')
    // writes to the current change artifact are allowed in the artifact stage
    expect(
      evaluate(shell('echo "- 条款" >> .flowgate/changes/C-001/clarify.md'), { stage: 'S1' }).effect,
    ).toBe('allow')
  })

  it('S6 only allows delivery artifacts; archived is read-only', () => {
    expect(evaluate(write('CHANGELOG.md'), { stage: 'S6' })).toMatchObject({ effect: 'allow' })
    expect(evaluate(write('docs/release.md'), { stage: 'S6' })).toMatchObject({ effect: 'allow' })
    const denied = evaluate(write('src/main/java/A.java'), { stage: 'S6' })
    expect(denied).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
    expect(denied.message).toContain('交付')

    const archived = evaluate(write('src/main/java/A.java'), { stage: 'archived' })
    expect(archived).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { stage: 'archived' }).effect).toBe('allow')
  })

  it('roadmap stage only allows project-level artifacts', () => {
    const project = makeChange({ id: 'PROJECT', stage: 'roadmap' })
    expect(
      evaluate(write('.flowgate/roadmap.md'), { change: project, stage: 'roadmap' }),
    ).toMatchObject({ effect: 'allow' })
    expect(
      evaluate(write('.flowgate/project-clarify.md'), { change: project, stage: 'roadmap' }),
    ).toMatchObject({ effect: 'allow' })
    const denied = evaluate(write('src/main/java/A.java'), { change: project, stage: 'roadmap' })
    expect(denied.effect).toBe('deny')
    assertBlockedMessage(denied.message, 'roadmap', 'R-STAGE-SRC')
  })
})

describe('rules/evaluate — 受保护路径 / 锁定 / 分析只读 / 委派', () => {
  it('denies writes to protected plugin state and git internals', () => {
    for (const path of [
      '.flowgate/changes/C-001/status.json',
      '.flowgate/state/ledger.jsonl',
      '.flowgate/config.yaml',
      '.git/config',
      '.env',
    ]) {
      const decision = evaluate(write(path), { change: greenChange() })
      expect(decision.effect, path).toBe('deny')
      expect(decision.rule?.ruleId, path).toBe('R-PROTECTED')
      expect(decision.message, path).toContain('受保护')
    }
    const shellDecision = evaluate(shell('echo x > .git/config'), { change: greenChange() })
    expect(shellDecision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PROTECTED' } })
  })

  it('lets the agent write the current stage artifacts under .flowgate/changes/<id>/', () => {
    // S1 artifacts, including nested specs/.
    for (const path of [
      '.flowgate/changes/C-001/clarify.md',
      '.flowgate/changes/C-001/proposal.md',
      '.flowgate/changes/C-001/specs/spec.md',
    ]) {
      const decision = evaluate(write(path), { change: makeChange({ stage: 'S1' }) })
      expect(decision.effect, path).toBe('allow')
    }
    // S2 context artifact + shell redirect to it.
    const s2 = makeChange({ stage: 'S2' })
    expect(evaluate(write('.flowgate/changes/C-001/context.md'), { change: s2 }).effect).toBe('allow')
    expect(evaluate(shell('echo note > .flowgate/changes/C-001/context.md'), { change: s2 }).effect).toBe('allow')
    // Earlier-stage-only artifact is blocked by the stage rule, not protected.
    const denied = evaluate(write('.flowgate/changes/C-001/context.md'), { change: makeChange({ stage: 'S1' }) })
    expect(denied.effect).toBe('deny')
    expect(denied.rule?.ruleId).toBe('R-STAGE-SRC')
    // Plugin-owned state is still protected even inside the change dir.
    const state = evaluate(write('.flowgate/changes/C-001/status.json'), { change: s2 })
    expect(state).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PROTECTED' } })
  })

  it('protected-path denials cannot be overridden', () => {
    const action = write('.flowgate/changes/C-001/status.json')
    const override: OverrideRecord = {
      id: 'OV-1',
      ruleId: 'R-PROTECTED',
      changeId: 'C-001',
      reason: '想改状态',
      actionFingerprint: fingerprintAction(action),
      createdAt: AT,
    }
    const decision = evaluate(action, { change: greenChange(), overrides: [override] })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PROTECTED' } })
    expect(decision.overrideUsed).toBeUndefined()
  })

  it('locked mode denies repository mutations but keeps reads working', () => {
    const locked = makeChange({
      stage: 'S4',
      tasks: GREEN_TASKS,
    })
    locked.lifecycle = 'locked'
    locked.lock = { reason: '账本第 5 行签名不符', at: AT }
    const denied = evaluate(write('src/main/java/com/acme/renewal/Impl.java'), { change: locked })
    expect(denied).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-LOCK' } })
    expect(denied.message).toContain('锁定模式')
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { change: locked }).effect).toBe('allow')
    expect(evaluate(shell('git status'), { change: locked }).effect).toBe('allow')
  })

  it('analysis changes are read-only; flow tools stay allowed', () => {
    const analysis = makeChange({ kind: 'analysis', stage: 'S1' })
    const denied = evaluate(write('src/main/java/A.java'), { change: analysis, stage: 'S1' })
    expect(denied).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-ANALYSIS-READONLY' } })
    expect(denied.message).toContain('只读')
    expect(evaluate(shell('ls -la'), { change: analysis, stage: 'S1' })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-ANALYSIS-READONLY' },
    })
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/a.ts' }, { change: analysis, stage: 'S1' }).effect).toBe(
      'allow',
    )
    expect(
      evaluate({ kind: 'other', tool: 'flow_submit_analysis' }, { change: analysis, stage: 'S1' }).effect,
    ).toBe('allow')
  })

  it('native delegation tools are denied', () => {
    for (const tool of ['subagent', 'subagent_fork', 'workflow', 'send_message']) {
      const decision = evaluate({ kind: 'delegate', tool }, { change: greenChange() })
      expect(decision, tool).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-DELEGATE' } })
    }
    // run_code is closed in managed sessions even though it is shell-shaped
    expect(evaluate(shell('echo hi'), { change: greenChange() }).effect).toBe('allow')
    const runCode: Action = { kind: 'shell', tool: 'run_code', command: 'echo hi' }
    expect(evaluate(runCode, { change: greenChange() })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-DELEGATE' },
    })
  })
})

describe('rules/evaluate — 风险触发器（FR-6.2 / FR-6.3）', () => {
  it('dangerous command -> human with a pending draft', () => {
    const decision = evaluate(shell('git reset --hard HEAD'), { change: greenChange() })
    expect(decision.effect).toBe('human')
    expect(decision.rule?.ruleId).toBe('T-DANGEROUS')
    expect(decision.pendingDraft?.kind).toBe('risk')
    expect(decision.pendingDraft?.actionFingerprint).toBeTruthy()
    expect(decision.message).toContain('转人工')
    assertBlockedMessage(decision.message, 'S4', 'T-DANGEROUS')
  })

  it('sensitive path -> human; dependency change -> human', () => {
    const sensitive = evaluate(write('src/main/java/com/acme/payment/Callback.java'), {
      change: greenChange(),
    })
    expect(sensitive).toMatchObject({ effect: 'human', rule: { ruleId: 'T-SENSITIVE-PATH' } })
    const dependency = evaluate(write('pom.xml'), { change: greenChange() })
    expect(dependency).toMatchObject({ effect: 'human', rule: { ruleId: 'T-DEPENDENCY' } })
    expect(dependency.pendingDraft?.title).toContain('T-DEPENDENCY')
  })

  it('secret writes are denied, including through shell commands', () => {
    const fileDecision = evaluate(
      write('src/config.ts', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'),
      { change: greenChange() },
    )
    expect(fileDecision).toMatchObject({ effect: 'deny', rule: { ruleId: 'T-SECRET' } })
    const shellDecision = evaluate(
      shell('echo "-----BEGIN RSA PRIVATE KEY-----" > key.txt'),
      { change: greenChange() },
    )
    expect(shellDecision).toMatchObject({ effect: 'deny', rule: { ruleId: 'T-SECRET' } })
  })

  it('reading .env -> human; a normal read stays allowed', () => {
    const decision = evaluate({ kind: 'read', tool: 'read', path: '.env' }, { change: greenChange() })
    expect(decision).toMatchObject({ effect: 'human', rule: { ruleId: 'T-SECRET-READ' } })
    expect(evaluate({ kind: 'read', tool: 'read', path: 'src/app.ts' }, { change: greenChange() }).effect).toBe(
      'allow',
    )
  })

  it('reuses an existing open pending item instead of duplicating it', () => {
    const action = shell('git reset --hard HEAD')
    const pending: PendingItem = {
      id: 'RK-1',
      kind: 'risk',
      changeId: 'C-001',
      title: '危险命令',
      detail: '确认',
      status: 'open',
      createdAt: AT,
      scope: { changeId: 'C-001', ruleId: 'T-DANGEROUS', actionFingerprint: fingerprintAction(action) },
    }
    const decision = evaluate(action, { change: greenChange(), pending: [pending] })
    expect(decision.effect).toBe('human')
    expect(decision.notes?.join('')).toContain('RK-1')
  })
})

describe('rules/evaluate — 推送（G6 之前拒绝、之后转人工）', () => {
  it('denies pushing before G6', () => {
    const decision = evaluate(shell('git push origin main'), { change: greenChange() })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PUSH' } })
    expect(decision.message).toContain('G6')
  })

  it('denies force push before G6 as a push (not just a dangerous command)', () => {
    const decision = evaluate(shell('git push --force origin main'), { change: greenChange() })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-PUSH' } })
  })

  it('turns pushing after G6 into a human confirmation', () => {
    const afterG6 = makeChange({ stage: 'S6' })
    afterG6.gates.G6 = { state: 'passed', attempts: 1, approvedAt: AT }
    const decision = evaluate(shell('git push origin main'), { change: afterG6, stage: 'S6' })
    expect(decision).toMatchObject({ effect: 'human', rule: { ruleId: 'R-PUSH' } })
    expect(decision.pendingDraft?.kind).toBe('risk')
  })

  it('config can allow pushes, but that is an explicit owner decision', () => {
    const config = makeConfig({
      rules: [{ id: 'R-PUSH', when: {}, decision: 'allow', why: '项目允许 agent 推送', unlock: '无需解锁' }],
    })
    expect(evaluate(shell('git push origin main'), { change: greenChange(), config }).effect).toBe('allow')
  })
})

describe('rules/evaluate — 任务范围 / 新文件 / 删除声明（FR-4.3/4.4/4.12）', () => {
  it('denies writes outside the active task scope with a scope-change hint', () => {
    const decision = evaluate(write('src/other/Unrelated.java'), { change: greenChange() })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-SCOPE' } })
    expect(decision.message).toContain('flow_request_scope_change')
  })

  it('denies source writes when there is no active task', () => {
    const decision = evaluate(write('src/main/java/com/acme/renewal/Impl.java'), {
      change: greenChange(),
      task: null,
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-SCOPE' } })
    expect(decision.message).toContain('flow_task_start')
  })

  it('denies undeclared new files even inside the scope, allows declared ones', () => {
    const undeclared = evaluate({ kind: 'create', tool: 'write', path: 'src/main/java/com/acme/renewal/New.java' }, {
      change: greenChange(),
    })
    expect(undeclared).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-NEWFILE' } })
    expect(undeclared.message).toContain('new_files')

    const task = makeTask({ newFiles: ['src/main/java/com/acme/renewal/New.java'] })
    const declared = evaluate(
      { kind: 'create', tool: 'write', path: 'src/main/java/com/acme/renewal/New.java' },
      { change: greenChange(), task },
    )
    expect(declared.effect).toBe('allow')
  })

  it('requires deletes and renames to be declared in the task card', () => {
    const undeclared = evaluate({ kind: 'delete', tool: 'bash', path: 'src/main/java/com/acme/renewal/Impl.java' }, {
      change: greenChange(),
    })
    expect(undeclared).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-DELETE' } })
    expect(undeclared.message).toContain('changes')

    const task = makeTask({
      changes: [
        { path: 'src/old/A.java', kind: 'delete' },
        { path: 'src/old/B.java', kind: 'rename', to: 'src/main/java/com/acme/renewal/B.java' },
      ],
    })
    expect(
      evaluate({ kind: 'delete', tool: 'bash', path: 'src/old/A.java' }, { change: greenChange(), task }).effect,
    ).toBe('allow')
    expect(
      evaluate(
        { kind: 'rename', tool: 'bash', path: 'src/old/B.java', toPath: 'src/main/java/com/acme/renewal/B.java' },
        { change: greenChange(), task },
      ).effect,
    ).toBe('allow')
    const undeclaredRename = evaluate(
      { kind: 'rename', tool: 'bash', path: 'src/old/C.java', toPath: 'src/main/java/com/acme/renewal/C.java' },
      { change: greenChange(), task },
    )
    expect(undeclaredRename).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-DELETE' } })
  })

  it('blocked further writes while an out-of-scope violation is open, but not reverts', () => {
    const violation: Violation = {
      id: 'V-1',
      changeId: 'C-001',
      taskId: 'T3',
      path: 'src/other/Unrelated.java',
      kind: 'outside-scope',
      detectedAt: AT,
      source: 'post',
    }
    const decision = evaluate(write('src/main/java/com/acme/renewal/Impl.java'), {
      change: greenChange(),
      violations: [violation],
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-VIOLATION' } })
    expect(decision.message).toContain('git checkout')
    // a declared delete is still allowed so the agent can revert the new file
    const task = makeTask({ changes: [{ path: 'src/main/java/com/acme/renewal/A.java', kind: 'delete' }] })
    expect(
      evaluate({ kind: 'delete', tool: 'bash', path: 'src/main/java/com/acme/renewal/A.java' }, {
        change: greenChange(),
        task,
        violations: [violation],
      }).effect,
    ).toBe('allow')
    // recovery via shell is not blocked pre-emptively (postcheck attributes it)
    expect(
      evaluate(shell('git checkout -- src/other/Unrelated.java'), {
        change: greenChange(),
        violations: [violation],
      }).effect,
    ).toBe('allow')
  })
})

describe('rules/evaluate — TDD 顺序（FR-5.4 / 03 §6.5）', () => {
  function tddChange(tdd: 'none' | 'red' | 'green') {
    const change = makeChange({ stage: 'S4', tasks: { T3: makeTaskState({ tdd }) } })
    return change
  }

  it('denies editing implementation files before a RED receipt', () => {
    const decision = evaluate(write('src/main/java/com/acme/renewal/RenewalService.java'), {
      change: tddChange('none'),
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-TDD-ORDER' } })
    expect(decision.message).toContain('RED')
    expect(decision.message).toContain('flow_verify')
  })

  it('allows after RED and allows writing tests before RED', () => {
    expect(
      evaluate(write('src/main/java/com/acme/renewal/RenewalService.java'), { change: tddChange('red') }).effect,
    ).toBe('allow')
    expect(
      evaluate(write('src/test/java/com/acme/renewal/RenewalServiceTest.java'), { change: tddChange('none') })
        .effect,
    ).toBe('allow')
  })

  it('does not enforce TDD for tdd: optional tasks', () => {
    const task = makeTask({ tdd: 'optional', tddReason: '纯配置' })
    expect(
      evaluate(write('src/main/java/com/acme/renewal/RenewalService.java'), {
        change: tddChange('none'),
        task,
      }).effect,
    ).toBe('allow')
  })
})

describe('rules/evaluate — 单次放行与例外（FR-9.2 / T1.2）', () => {
  const action = edit('src/main/java/com/acme/renewal/RenewalService.java')

  function overrideFor(fingerprint: string, ruleId = 'R-STAGE-SRC'): OverrideRecord {
    return {
      id: 'OV-1',
      ruleId,
      changeId: 'C-001',
      reason: '负责人确认这次先改一行',
      actionFingerprint: fingerprint,
      createdAt: AT,
    }
  }

  // T1.2 acceptance: GIVEN 一条单次放行 WHEN 连续两次相同动作 THEN 第一次允许、第二次拒绝
  it('T1.2: a single-use override allows exactly one matching action', () => {
    const override = overrideFor(fingerprintAction(action))
    const first = evaluate(action, { stage: 'S3', overrides: [override] })
    expect(first.effect).toBe('allow')
    expect(first.overrideUsed).toBe('OV-1')
    expect(first.notes?.join('')).toContain('单次放行')

    // the engine records usedAt after the action executes; the next attempt is denied again
    const used = { ...override, usedAt: AT }
    const second = evaluate(action, { stage: 'S3', overrides: [used] })
    expect(second).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
    expect(second.overrideUsed).toBeUndefined()
  })

  it('an empty fingerprint override applies to the next matching action (owner command)', () => {
    const decision = evaluate(action, { stage: 'S3', overrides: [overrideFor('')] })
    expect(decision.effect).toBe('allow')
    expect(decision.overrideUsed).toBe('OV-1')
  })

  it('an override only cancels the rule it names', () => {
    const decision = evaluate(action, {
      stage: 'S3',
      overrides: [overrideFor(fingerprintAction(action), 'R-SCOPE')],
    })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
  })

  it('exceptions allow repeatedly by rule + path pattern and can be revoked', () => {
    const exception: ExceptionRecord = {
      id: 'EX-1',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      pathPattern: 'src/main/java/**',
      reason: '该目录在本次变更里允许提前改',
      createdAt: AT,
    }
    const first = evaluate(action, { stage: 'S3', exceptions: [exception] })
    expect(first.effect).toBe('allow')
    expect(first.exceptionUsed).toBe('EX-1')
    const again = evaluate(action, { stage: 'S3', exceptions: [exception] })
    expect(again.effect).toBe('allow')

    const revoked = { ...exception, revokedAt: AT, revokedReason: '改完了' }
    expect(evaluate(action, { stage: 'S3', exceptions: [revoked] })).toMatchObject({
      effect: 'deny',
      rule: { ruleId: 'R-STAGE-SRC' },
    })
    const otherPattern = { ...exception, pathPattern: 'lib/**' }
    expect(evaluate(action, { stage: 'S3', exceptions: [otherPattern] })).toMatchObject({ effect: 'deny' })
  })
})

describe('rules/evaluate — 项目自定义规则与 allow 覆盖', () => {
  it('appends project deny rules after built-in checks', () => {
    const config = makeConfig({
      rules: [
        { id: 'R-STAGE-SRC', when: {}, decision: 'allow', why: '本项目允许提前改', unlock: '无需解锁' },
        {
          id: 'R-SNAP',
          when: { action: ['write'], path: '**/*.snap' },
          decision: 'deny',
          why: '快照必须重新生成，不能手改',
          unlock: '运行 pnpm vitest -u 重新生成',
        },
      ],
    })
    const decision = evaluate(write('src/__snapshots__/a.snap'), { stage: 'S3', config })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-SNAP' } })
  })

  it('allow rules only apply when nothing earlier denied (deny cannot be flipped)', () => {
    const config = makeConfig({
      rules: [
        {
          id: 'R-ALLOW-ALL-WRITES',
          when: { action: ['write'] },
          decision: 'allow',
          why: '项目自定义允许',
          unlock: '无需解锁',
        },
      ],
    })
    const decision = evaluate(write('src/main/java/com/acme/renewal/A.java'), { stage: 'S3', config })
    expect(decision).toMatchObject({ effect: 'deny', rule: { ruleId: 'R-STAGE-SRC' } })
  })

  it('config can flip a built-in rule decision (scope -> human)', () => {
    const config = makeConfig({
      rules: [{ id: 'R-SCOPE', when: {}, decision: 'human', why: '范围外改动需要人确认', unlock: '等负责人确认' }],
    })
    const decision = evaluate(write('src/other/X.java'), { change: greenChange(), config })
    expect(decision).toMatchObject({ effect: 'human', rule: { ruleId: 'R-SCOPE' } })
    expect(decision.pendingDraft?.kind).toBe('scope')
  })

  it('a project allow rule can whitelist a specific unknown tool', () => {
    const config = makeConfig({
      rules: [
        {
          id: 'R-ALLOW-MYSTERY',
          when: { tool: ['mystery_tool'] },
          decision: 'allow',
          why: '已知工具，只读',
          unlock: '无需解锁',
        },
      ],
    })
    const action: Action = { kind: 'other', tool: 'mystery_tool' }
    const decision = evaluate(action, { change: greenChange(), config })
    expect(decision.effect).toBe('allow')
    expect(decision.rule?.ruleId).toBe('R-ALLOW-MYSTERY')
  })

  it('uncovered/unknown tools fall back to human (coverage self-check)', () => {
    const decision = evaluate({ kind: 'other', tool: 'mystery_tool' }, { change: greenChange() })
    expect(decision).toMatchObject({ effect: 'human', rule: { ruleId: 'R-MCP' } })
    expect(decision.pendingDraft?.kind).toBe('risk')
    const mcp = evaluate({ kind: 'mcp', tool: 'mcp__unknown__thing' }, { change: greenChange() })
    expect(mcp).toMatchObject({ effect: 'human', rule: { ruleId: 'R-MCP' } })
  })
})

describe('rules/evaluate — 判定顺序与指纹', () => {
  it('earlier deny wins over later triggers and scope rules', () => {
    // protected path wins over the sensitive-path trigger
    const decision = evaluate(write('.flowgate/config.yaml'), { change: greenChange() })
    expect(decision.rule?.ruleId).toBe('R-PROTECTED')
    // stage policy wins over scope rules (S3 denies before scope is consulted)
    const s3 = evaluate(write('src/other/X.java'), { stage: 'S3' })
    expect(s3.rule?.ruleId).toBe('R-STAGE-SRC')
  })

  it('fingerprintAction is stable for identical actions and changes with path/content/command', () => {
    const a = fingerprintAction(write('src/a.ts', 'hello'))
    const b = fingerprintAction(write('src/a.ts', 'hello'))
    const otherPath = fingerprintAction(write('src/b.ts', 'hello'))
    const otherContent = fingerprintAction(write('src/a.ts', 'bye'))
    expect(a).toBe(b)
    expect(a).not.toBe(otherPath)
    expect(a).not.toBe(otherContent)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    const rename = fingerprintAction({
      kind: 'rename',
      tool: 'bash',
      path: 'src/a.ts',
      toPath: 'src/b.ts',
    })
    expect(rename).not.toBe(fingerprintAction({ kind: 'rename', tool: 'bash', path: 'src/a.ts', toPath: 'src/c.ts' }))
    const shellA = fingerprintAction(shell('pnpm test'))
    expect(shellA).toBe(fingerprintAction(shell('  pnpm test  ')))
    expect(shellA).not.toBe(fingerprintAction(shell('pnpm test --reporter=verbose')))
  })

  it('actionTargetPath normalises file paths and is undefined for shell actions', () => {
    expect(actionTargetPath(write('./src/a.ts'))).toBe('src/a.ts')
    expect(actionTargetPath({ kind: 'read', tool: 'read', path: 'src\\b.ts' })).toBe('src/b.ts')
    expect(actionTargetPath(shell('ls'))).toBeUndefined()
    expect(actionTargetPath({ kind: 'delegate', tool: 'subagent' })).toBeUndefined()
  })

  it('decisions are JSON-serialisable and deterministic', () => {
    const action = edit('src/main/java/com/acme/renewal/RenewalService.java')
    const first = evaluateRules({
      action,
      caller: { tool: 'edit' },
      stage: 'S3',
      change: makeChange({ stage: 'S3' }),
      config: makeConfig(),
      overrides: [],
      exceptions: [],
      pending: [],
      violations: [],
      projectRoot: '/repo',
    })
    const second = evaluateRules({
      action,
      caller: { tool: 'edit' },
      stage: 'S3',
      change: makeChange({ stage: 'S3' }),
      config: makeConfig(),
      overrides: [],
      exceptions: [],
      pending: [],
      violations: [],
      projectRoot: '/repo',
    })
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)))
  })
})

describe('rules/evaluate — 解释器（FR-9.1）', () => {
  it('allow cards say 允许 and deny cards carry all four parts', () => {
    const allow = explainDecision({ effect: 'allow', message: '' }, { stage: 'S4' })
    expect(allow.card['判定']).toBe('允许')
    expect(allow.card['规则']).toBe('默认允许')
    expect(allow.short).toBe('允许')

    const deny = explainDecision(
      evaluate(edit('src/A.java'), { stage: 'S3' }),
      { stage: 'S3', changeId: 'C-001' },
    )
    expect(deny.card['判定']).toBe('拒绝')
    expect(deny.card['阶段']).toBe('S3 设计拆解')
    expect(deny.card['规则']).toBe('R-STAGE-SRC')
    expect(deny.card['为什么']).toContain('先定')
    expect(deny.card['怎么解锁']).toContain('flow_submit')
    expect(deny.card['方法来源']).toBeTruthy()
  })

  it('human cards include the pending item and notes', () => {
    const decision = evaluate(shell('git reset --hard HEAD'), { change: greenChange() })
    const { card } = explainDecision(decision, { stage: 'S4', changeId: 'C-001' })
    expect(card['判定']).toBe('需要人工确认')
    expect(card['待处理项']).toContain('risk')
    expect(card['规则']).toBe('T-DANGEROUS')
  })

  it('cards surface single-use overrides and exceptions', () => {
    const action = edit('src/A.java')
    const first = evaluate(action, {
      stage: 'S3',
      overrides: [{ id: 'OV-9', ruleId: 'R-STAGE-SRC', changeId: 'C-001', reason: 'x', actionFingerprint: '', createdAt: AT }],
    })
    const overrideCard = explainDecision(first, { stage: 'S3', changeId: 'C-001' })
    expect(overrideCard.card['单次放行']).toBe('OV-9')

    const exception: ExceptionRecord = {
      id: 'EX-9',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-001',
      reason: 'x',
      createdAt: AT,
    }
    const second = evaluate(action, { stage: 'S3', exceptions: [exception] })
    const exceptionCard = explainDecision(second, { stage: 'S3' })
    expect(exceptionCard.card['例外']).toBe('EX-9')
  })
})
