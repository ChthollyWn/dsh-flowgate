/** Pure view-model tests (SSR-testable mapping, T1.6 / T2.9 / T10 metrics). */
import { describe, expect, it } from 'vitest'
import {
  buildDockModel,
  buildExecutionGraph,
  buildLedgerRows,
  buildMetricRows,
  buildPanelModel,
  dockStateOf,
  groupTasksByStatus,
  metricsCsv,
  metricsJson,
  nextStepForPanel,
  normalizeProjection,
  readProjection,
  sanitizeNextStep,
  toneOf,
  trialRuleLocal,
  truncateChars,
} from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { RuleRow } from '../../src/client/types'
import type { ExceptionRecord, TaskState } from '../../src/core/types'
import {
  makeActiveProjection,
  makeBlockedProjection,
  makeEmptyProjection,
  makeIdleProjection,
  makeLockedProjection,
  makeLowComplexityProjection,
  makeOffProjection,
  makePendingProjection,
  makeProjection,
  makeSnapshot,
} from './mock'

const zh = createTranslator('zh')

describe('truncateChars', () => {
  it('counts CJK and surrogate pairs as single characters', () => {
    expect(truncateChars('一二三', 3)).toBe('一二三')
    expect(truncateChars('一二三四', 3)).toBe('一二…')
    expect(truncateChars('ab😀cd', 4)).toBe('ab😀…')
    expect(truncateChars('abc', 0)).toBe('')
  })
})

describe('normalizeProjection', () => {
  it('accepts the contract shape', () => {
    const proj = normalizeProjection(makeProjection())
    expect(proj).not.toBeNull()
    expect(proj?.snapshot.changeId).toBe('C-003')
    expect(proj?.revision).toBe(7)
    expect(proj?.panel?.gate?.gate).toBe('G3')
  })

  it('accepts a bare RuntimeSnapshot (forward/backward compatible wire)', () => {
    const proj = normalizeProjection(makeSnapshot())
    expect(proj).not.toBeNull()
    expect(proj?.snapshot.changeId).toBe('C-003')
  })

  it('returns null for junk instead of throwing', () => {
    expect(normalizeProjection(null)).toBeNull()
    expect(normalizeProjection('nope')).toBeNull()
    expect(normalizeProjection({ foo: 1 })).toBeNull()
    expect(readProjection(undefined)).toBeNull()
    expect(readProjection({ useProjection: () => { throw new Error('boom') } })).toBeNull()
  })

  it('degrades missing arrays to empty ones', () => {
    const proj = normalizeProjection({ snapshot: { initialized: true, changeId: 'C-1', updatedAt: 'x' } })
    expect(proj?.snapshot.pipeline).toEqual([])
    expect(proj?.snapshot.tasks).toEqual({})
    expect(proj?.snapshot.pending).toEqual([])
    expect(proj?.snapshot.interceptCounts).toEqual({})
  })
})

describe('dock state machine / model (contract §2)', () => {
  it('maps every snapshot to exactly one dock state', () => {
    expect(dockStateOf(null)).toBe('demo')
    expect(dockStateOf(makeEmptyProjection().snapshot)).toBe('demo')
    expect(dockStateOf(makeLockedProjection().snapshot)).toBe('locked')
    expect(dockStateOf(makeOffProjection().snapshot)).toBe('off')
    expect(dockStateOf(makeBlockedProjection().snapshot)).toBe('blocked')
    expect(dockStateOf(makeProjection().snapshot)).toBe('awaiting')
    expect(dockStateOf(makePendingProjection().snapshot)).toBe('pending')
    expect(dockStateOf(makeIdleProjection().snapshot)).toBe('idle')
    expect(dockStateOf(makeActiveProjection().snapshot)).toBe('active')
  })

  it('keeps the legacy toneOf classification for shared theme consumers', () => {
    expect(toneOf(null)).toBe('disabled')
    expect(toneOf(makeEmptyProjection().snapshot)).toBe('disabled')
    expect(toneOf(makeSnapshot({ locked: true }))).toBe('blocked')
    expect(toneOf(makeSnapshot({ off: true }))).toBe('blocked')
    expect(toneOf(makeSnapshot({ awaitingGate: undefined, pending: [] }))).toBe('active')
  })

  it('builds the awaiting gate card with checks, progress and approve/reject', () => {
    const model = buildDockModel(makeProjection(), zh)
    expect(model.state).toBe('awaiting')
    expect(model.tone).toBe('attention')
    expect(model.nodes).toHaveLength(7)
    expect(model.nodes.find((node) => node.isCurrent)?.stage).toBe('S3')
    expect(model.progress).toEqual({ done: 3, total: 7 })
    expect(model.stage).toBe('S3')
    const card = model.card
    expect(card?.kind).toBe('gate')
    expect(card?.gate).toBe('G3')
    expect(card?.target).toEqual({ externalCount: 0, gate: 'G3' })
    expect(card?.checks).toEqual({ passed: 2, total: 3 })
    expect(card?.items.filter((item) => !item.passed)).toHaveLength(1)
    expect(card?.strip).toContain('等你批准')
    expect(card?.stripTone).toBe('warn')
    // Native footer order: secondary / ghost actions first, primary last.
    expect(card?.actions.map((action) => action.dataAction)).toEqual([
      'auth-open-panel',
      'auth-reject',
      'auth-approve',
    ])
  })

  it('builds the low-complexity merged confirmation card with raise complexity', () => {
    const card = buildDockModel(makeLowComplexityProjection(), zh).card
    expect(card?.kind).toBe('gate')
    expect(card?.merged?.goal).toContain('把首页按钮文案改成')
    expect(card?.title).toBe('把首页按钮文案改成「马上抢购」')
    expect(card?.strip).toContain('等你确认方案')
    expect(card?.chips.map((chip) => chip.label)).toEqual(['范围', '验证方式'])
    expect(card?.actions.map((action) => action.dataAction)).toEqual([
      'auth-open-panel',
      'auth-raise',
      'auth-reject',
      'auth-approve',
    ])
  })

  it('builds the pending card from the first open decision and folds the rest', () => {
    const card = buildDockModel(makePendingProjection(), zh).card
    expect(card?.kind).toBe('pending')
    expect(card?.target.pendingId).toBe('RK-1')
    expect(card?.extraCount).toBe(1)
    expect(card?.stripTone).toBe('warn')
    expect(card?.strip).toContain('风险接管')
    expect(card?.title).toBe('新增支付依赖')
    expect(card?.actions.map((action) => action.label)).toContain('确认风险接管')
  })

  it('builds demo / locked / off / blocked cards', () => {
    const demoCard = buildDockModel(makeEmptyProjection(), zh).card
    expect(demoCard?.kind).toBe('enable')
    expect(demoCard?.stripTone).toBe('neutral')
    const lockedCard = buildDockModel(makeLockedProjection(), zh).card
    expect(lockedCard?.kind).toBe('repair')
    expect(lockedCard?.stripTone).toBe('error')
    const offCard = buildDockModel(makeOffProjection(), zh).card
    expect(offCard?.kind).toBe('reconnect')
    expect(offCard?.stripTone).toBe('error')
    const blocked = buildDockModel(makeBlockedProjection(), zh)
    expect(blocked.card?.kind).toBe('external')
    expect(blocked.card?.target.externalCount).toBe(1)
    expect(blocked.card?.actions.map((action) => action.dataAction)).toContain('auth-confirm')
    // Active / idle states never show a card.
    expect(buildDockModel(makeActiveProjection(), zh).card).toBeUndefined()
    expect(buildDockModel(makeIdleProjection(), zh).card).toBeUndefined()
  })

  it('sanitizes command-style host next steps and falls back to a natural phrase', () => {
    expect(sanitizeNextStep('/flow approve G3')).toBe('')
    expect(sanitizeNextStep('继续实现 T2')).toBe('继续实现 T2')
    expect(sanitizeNextStep('等待负责人批准 /flow approve G3 后继续')).not.toContain('/flow')
    const model = buildDockModel(
      makeProjection({
        snapshot: { awaitingGate: undefined, pendingGate: undefined, pending: [], nextStep: '/flow approve G3' },
        panel: { gate: undefined },
      }),
      zh,
    )
    expect(model.state).toBe('active')
    expect(model.next?.text).not.toContain('/flow')
    expect(model.next?.text).toBe('准备设计、风险与任务清单') // S3 mock stage → human stage phrase

    // Model-facing tool syntax is replaced by the stage-level human phrase.
    const modelFacing = buildDockModel(
      makeProjection({
        snapshot: {
          awaitingGate: undefined,
          pendingGate: undefined,
          pending: [],
          nextStep: '写澄清/需求产物后 flow_submit({gate:"G1"})',
        },
        panel: { gate: undefined },
      }),
      zh,
    )
    expect(modelFacing.state).toBe('active')
    expect(modelFacing.next?.text).not.toContain('flow_')
    expect(modelFacing.next?.text).not.toContain('{')
    expect(modelFacing.next?.text).toBe('准备设计、风险与任务清单')
  })

  it('builds the panel next-step callout in natural language', () => {
    const awaiting = nextStepForPanel(buildPanelModel(makeProjection(), zh), zh)
    expect(awaiting.kind).toBe('human')
    expect(awaiting.text).toContain('授权卡')
    expect(awaiting.text).not.toContain('/flow')

    const active = nextStepForPanel(buildPanelModel(makeActiveProjection(), zh), zh)
    expect(active.kind).toBe('auto')
    expect(active.text).toBe('继续实现 T2，然后补证据并进入 S4')

    // The panel callout never exposes model-facing tool syntax either.
    const modelFacing = nextStepForPanel(
      buildPanelModel(
        makeProjection({
          snapshot: {
            awaitingGate: undefined,
            pendingGate: undefined,
            pending: [],
            stage: 'S1',
            nextStep: '写澄清/需求产物后 flow_submit({gate:"G1"})',
          },
          panel: { gate: undefined },
        }),
        zh,
      ),
      zh,
    )
    expect(modelFacing.text).not.toContain('flow_')
    expect(modelFacing.text).toBe('补齐需求澄清产物')

    const setup = nextStepForPanel(buildPanelModel(makeEmptyProjection(), zh), zh)
    expect(setup.kind).toBe('setup')
    expect(setup.text).toContain('一句话')
  })

  it('exposes flowState on the panel model for the header rail', () => {
    expect(buildPanelModel(makeProjection(), zh).flowState).toBe('awaiting')
    expect(buildPanelModel(makeActiveProjection(), zh).flowState).toBe('active')
    expect(buildPanelModel(makeEmptyProjection(), zh).flowState).toBe('demo')
  })
})

describe('execution graph (T2.9)', () => {
  const graph = buildExecutionGraph(makeSnapshot())

  it('has one node per task and one batch per plan batch', () => {
    expect(graph.nodes).toHaveLength(4)
    expect(graph.batches).toHaveLength(3)
    expect(graph.empty).toBe(false)
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['T1', 'T2', 'T3', 'T4'])
  })

  it('carries every task status on its node', () => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node.status]))
    expect(byId.get('T1')).toBe('done')
    expect(byId.get('T2')).toBe('running')
    expect(byId.get('T3')).toBe('running')
    expect(byId.get('T4')).toBe('pending')
  })

  it('marks parallel batches and puts an integration checkpoint after each batch', () => {
    const parallel = graph.batches.filter((batch) => batch.mode === 'parallel')
    expect(parallel).toHaveLength(1)
    expect(parallel[0]?.id).toBe('B2')
    expect(graph.batches.every((batch) => batch.checkpoint !== null)).toBe(true)
    const kinds = new Set(graph.edges.map((edge) => edge.kind))
    expect(kinds.has('parallel')).toBe(true)
    expect(kinds.has('sequence')).toBe(true)
    expect(kinds.has('checkpoint')).toBe(true)
  })

  it('lays nodes inside the reported width/height', () => {
    expect(graph.width).toBeGreaterThan(0)
    expect(graph.height).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(graph.width)
      expect(node.y + node.height).toBeLessThanOrEqual(graph.height)
    }
  })

  it('degrades to a single sequential batch when only task states exist', () => {
    const derived = buildExecutionGraph(
      makeSnapshot({ batches: [], tasks: { T1: { id: 'T1', batch: 'B9', status: 'done', tdd: 'none', evidenceIds: [], reviewIds: [] } } }),
    )
    expect(derived.batches).toHaveLength(1)
    expect(derived.batches[0]?.id).toBe('B9')
    expect(derived.nodes).toHaveLength(1)
  })

  it('returns an empty graph when there is no plan', () => {
    expect(buildExecutionGraph(makeSnapshot({ batches: [], tasks: {} })).empty).toBe(true)
  })
})

describe('panel model', () => {
  const model = buildPanelModel(makeProjection(), zh)

  it('counts tasks per board column', () => {
    expect(model.tasksByStatus.done).toHaveLength(1)
    expect(model.tasksByStatus.running).toHaveLength(2)
    expect(model.tasksByStatus.todo).toHaveLength(1)
    expect(model.tasksByStatus.blocked).toHaveLength(0)
    expect(groupTasksByStatus([]).todo).toHaveLength(0)
  })

  it('derives evidence freshness and review findings per task card', () => {
    const t2 = model.tasks.find((task) => task.id === 'T2')
    const t1 = model.tasks.find((task) => task.id === 'T1')
    expect(t1?.evidence).toBe('fresh')
    expect(t2?.evidence).toBe('stale')
    expect(t1?.reviewFindings).toBe(2)
    expect(t2?.worktree).toBe('.flowgate/worktrees/C-003-T2')
    expect(t2?.agent).toBe('flowgate-executor')
  })

  it('builds ledger rows with the current change flagged', () => {
    const rows = buildLedgerRows(makeProjection(), zh)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual(['C-003'])
    expect(rows[1]?.lifecycleDisplay).toBe('已暂停')
    expect(rows[0]?.complexity).toBe('中')
  })

  it('keeps unknown metric values as 未知 instead of 0', () => {
    const metrics = buildMetricRows(makeProjection().panel?.metrics, zh)
    const byId = new Map(metrics.change.map((row) => [row.id, row.value]))
    expect(byId.get('M-1')).toBe('2')
    expect(byId.get('M-5')).toBe('未知')
    expect(byId.get('M-18')).toBe('未知')
    expect(metrics.hasData).toBe(true)
    expect(metricsCsv(metrics)).toContain('"M-1"')
    const json = JSON.parse(metricsJson(metrics)) as { change: Record<string, { value: string }> }
    expect(json.change['M-1']?.value).toBe('2')
  })

  it('collects uncovered scenarios', () => {
    expect(model.uncoveredScenarios).toEqual(['R2.S3'])
    expect(model.trace).toHaveLength(2)
  })

  it('derives the gate from the snapshot when panel extras are absent', () => {
    const bare = buildPanelModel({ ...makeProjection(), panel: {} }, zh)
    expect(bare.gate.gate).toBe('G3')
    expect(bare.gate.state).toBe('awaiting')
    expect(bare.gate.awaitingOwner).toBe(true)
    expect(bare.ledger).toHaveLength(1)
  })


  it('maps task-card plan extras used by the task detail (T5.1)', () => {
    const base = makeSnapshot()
    const tasks: Record<string, TaskState> = {
      ...base.tasks,
      T2: {
        ...base.tasks.T2!,
        title: '回调幂等',
        scope: ['src/main/java/RenewalService.java'],
        newFiles: ['src/main/java/RenewalIdempotency.java'],
        verify: [{ group: 'unit', command: 'mvn -q test' }],
        covers: ['R1.S1'],
        tests: ['RenewalServiceTest'],
        redObserved: true,
      } as unknown as TaskState,
    }
    const model = buildPanelModel(makeProjection({ snapshot: { tasks } }), zh)
    const t2 = model.tasks.find((task) => task.id === 'T2')
    expect(t2?.title).toBe('回调幂等')
    expect(t2?.batchMode).toBe('parallel')
    expect(t2?.batchStatus).toBe('running')
    expect(t2?.scope).toEqual(['src/main/java/RenewalService.java'])
    expect(t2?.newFiles).toEqual(['src/main/java/RenewalIdempotency.java'])
    expect(t2?.verify).toEqual(['unit · mvn -q test'])
    expect(t2?.covers).toEqual(['R1.S1'])
    expect(t2?.tests).toEqual(['RenewalServiceTest'])
    expect(t2?.redObserved).toBe(true)
    expect(t2?.evidenceIds).toEqual(['E-2'])
    expect(t2?.reviewIds).toBeUndefined()
    expect(t2?.findings).toBeUndefined()
    // Review findings are flattened from the panel review rows for the task.
    const t1 = model.tasks.find((task) => task.id === 'T1')
    expect(t1?.findings).toEqual([
      { severity: 'major', file: 'RenewalService.java', line: 88, message: '缺少幂等键' },
      { severity: 'minor', file: 'RenewalService.java', message: '命名不一致' },
    ])
    expect(t1?.reviewIds).toEqual(['R-1'])
  })
})

describe('trialRuleLocal (FR-9.4 fallback)', () => {
  const rules: RuleRow[] = [
    { id: 'R-STAGE-SRC', decision: 'deny', why: '', unlock: '', hits: 0 },
    { id: 'R-PROTECTED', decision: 'deny', why: '', unlock: '', hits: 0 },
    { id: 'R-PUSH', decision: 'human', why: '', unlock: '', hits: 0 },
  ]
  const sourceWrite = { tool: 'edit', path: 'src/main/java/A.java', stage: 'S3' }

  function exception(overrides: Partial<ExceptionRecord> = {}): ExceptionRecord {
    return {
      id: 'EX-1',
      ruleId: 'R-STAGE-SRC',
      changeId: 'C-003',
      pathPattern: 'src/**',
      reason: '迁移期放行',
      createdAt: '2026-10-31T09:00:00+08:00',
      ...overrides,
    }
  }

  it('blocks writing source code during S0–S3', () => {
    const result = trialRuleLocal(sourceWrite, rules)
    expect(result.decision).toBe('deny')
    expect(result.rule?.id).toBe('R-STAGE-SRC')
  })

  it('blocks protected paths', () => {
    const result = trialRuleLocal({ tool: 'bash', path: '.flowgate/config.yaml' }, rules)
    expect(result.rule?.id).toBe('R-PROTECTED')
  })

  it('routes git push to a human', () => {
    const result = trialRuleLocal({ tool: 'bash', command: 'git push origin main' }, rules)
    expect(result.decision).toBe('human')
    expect(result.rule?.id).toBe('R-PUSH')
  })

  it('allows ordinary docs writes in S3', () => {
    expect(trialRuleLocal({ tool: 'edit', path: 'docs/notes.md', stage: 'S3' }, rules).decision).toBe('allow')
  })

  it('keeps the two-argument call backward compatible', () => {
    const result = trialRuleLocal(sourceWrite, rules)
    expect(result.decision).toBe('deny')
    expect(result.basis).toBe('rule')
    expect(result.uncoveredRules).toEqual([])
    // The result is always marked as an approximation of the host engine.
    expect(result.approximate).toBe(true)
  })

  describe('snapshot-aware fidelity (T5.1)', () => {
    it('allows everything when FlowGate is off', () => {
      const result = trialRuleLocal(sourceWrite, rules, { off: true, exceptions: [exception()] })
      expect(result.decision).toBe('allow')
      expect(result.basis).toBe('off')
      expect(result.uncoveredRules).toEqual([])
    })

    it('denies in locked mode, even with a matching exception', () => {
      const result = trialRuleLocal(sourceWrite, rules, { locked: true, exceptions: [exception()] })
      expect(result.decision).toBe('deny')
      expect(result.basis).toBe('locked')
      expect(result.heuristic).toBe('R-LOCK')
      expect(result.exception).toBeUndefined()
    })

    it('uses the effective rule decisions projected by the host', () => {
      const overridden: RuleRow[] = [
        { id: 'R-STAGE-SRC', decision: 'human', why: '', unlock: '', hits: 0 },
        { id: 'R-PROTECTED', decision: 'allow', why: '', unlock: '', hits: 0 },
        { id: 'R-PUSH', decision: 'human', why: '', unlock: '', hits: 0 },
        { id: 'R-DELETE', decision: 'allow', why: '', unlock: '', hits: 0 },
      ]
      expect(trialRuleLocal(sourceWrite, overridden).decision).toBe('human')
      expect(trialRuleLocal({ tool: 'bash', path: '.flowgate/config.yaml' }, overridden).decision).toBe('allow')
      expect(
        trialRuleLocal({ tool: 'delete', path: 'src/main/java/A.java', stage: 'S4' }, overridden).decision,
      ).toBe('allow')
    })

    it('allows when an active exception cancels the matched rule', () => {
      const result = trialRuleLocal(sourceWrite, rules, { changeId: 'C-003', exceptions: [exception()] })
      expect(result.decision).toBe('allow')
      expect(result.basis).toBe('exception')
      expect(result.rule?.id).toBe('R-STAGE-SRC')
      expect(result.exception).toEqual({ id: 'EX-1', ruleId: 'R-STAGE-SRC' })
    })

    it('ignores exceptions for another rule, path, change or a revoked one', () => {
      const cases: ExceptionRecord[][] = [
        [exception({ ruleId: 'R-PUSH' })],
        [exception({ pathPattern: 'docs/**' })],
        [exception({ changeId: 'C-999' })],
        [exception({ revokedAt: '2026-10-31T10:00:00+08:00' })],
      ]
      for (const exceptions of cases) {
        const result = trialRuleLocal(sourceWrite, rules, { changeId: 'C-003', exceptions })
        expect(result.decision, JSON.stringify(exceptions)).toBe('deny')
        expect(result.basis).toBe('rule')
        expect(result.exception).toBeUndefined()
      }
    })

    it('does not let exceptions cancel protected paths (core §13 hard stop)', () => {
      const result = trialRuleLocal({ tool: 'bash', path: '.flowgate/config.yaml' }, rules, {
        changeId: 'C-003',
        exceptions: [exception({ ruleId: 'R-PROTECTED', pathPattern: '.flowgate/**' })],
      })
      expect(result.decision).toBe('deny')
      expect(result.basis).toBe('rule')
    })

    it('reports project-defined rules the browser cannot evaluate', () => {
      const extended: RuleRow[] = [
        ...rules,
        { id: 'R-CUSTOM', decision: 'deny', why: '项目规则', unlock: '找负责人', hits: 0, source: '项目' },
      ]
      const result = trialRuleLocal(sourceWrite, extended)
      expect(result.uncoveredRules).toEqual(['R-CUSTOM'])
      expect(result.basis).toBe('rule')
      expect(result.approximate).toBe(true)
      // Built-in ids are not reported as uncovered.
      expect(trialRuleLocal({ tool: 'edit', path: 'docs/notes.md', stage: 'S3' }, extended).uncoveredRules).toEqual([
        'R-CUSTOM',
      ])
    })
  })
})
