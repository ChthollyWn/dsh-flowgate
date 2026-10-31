/** Pure view-model tests (SSR-testable mapping, T1.6 / T2.9 / T10 metrics). */
import { describe, expect, it } from 'vitest'
import {
  buildExecutionGraph,
  buildLedgerRows,
  buildMetricRows,
  buildPanelModel,
  buildStatusLine,
  groupTasksByStatus,
  metricsCsv,
  metricsJson,
  normalizeProjection,
  readProjection,
  toneOf,
  trialRuleLocal,
  truncateChars,
} from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { RuleRow } from '../../src/client/types'
import type { ExceptionRecord, TaskState } from '../../src/core/types'
import { makeEmptyProjection, makeProjection, makeSnapshot } from './mock'

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
    expect(proj?.learning).toBe('detail')
    expect(proj?.panel?.gate?.gate).toBe('G3')
  })

  it('accepts a bare RuntimeSnapshot (forward/backward compatible wire)', () => {
    const proj = normalizeProjection(makeSnapshot())
    expect(proj).not.toBeNull()
    expect(proj?.snapshot.changeId).toBe('C-003')
    expect(proj?.learning).toBeUndefined()
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

describe('status line / tone', () => {
  it('maps waiting G1 to the requirements approval wording', () => {
    const text = buildStatusLine(makeSnapshot({ awaitingGate: 'G1', stage: 'S1', pending: [] }), zh)
    expect(text).toContain('① 需求澄清')
    expect(text).toContain('等你批准需求')
  })

  it('toneOf classifies disabled / blocked / attention / active', () => {
    expect(toneOf(null)).toBe('disabled')
    expect(toneOf(makeEmptyProjection().snapshot)).toBe('disabled')
    expect(toneOf(makeSnapshot({ locked: true }))).toBe('blocked')
    expect(toneOf(makeSnapshot({ off: true }))).toBe('blocked')
    expect(toneOf(makeSnapshot({ awaitingGate: undefined, pending: [] }))).toBe('active')
    const idle = makeSnapshot({ awaitingGate: undefined, pending: [], lifecycle: undefined, changeId: 'C-9' })
    expect(toneOf(idle)).toBe('active')
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

  it('defaults the learning mode to detail when the host omits it', () => {
    const proj = { ...makeProjection(), learning: undefined }
    expect(buildPanelModel(proj, zh).learning).toBe('detail')
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
