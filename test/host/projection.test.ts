/**
 * 会话投影 key=flowgate（host↔client 契约 + v0.5.1 自愈/瘦身改造）。
 *
 * 覆盖：
 * - stateVersion=2、init 不再继承 latest（新会话/子会话不能拿到另一个会话的 live 状态）；
 * - init/apply/wire 全部为 lossless JSON（DSH 转发校验）；
 * - wire 是显式白名单 DTO（不整包透传内部快照/面板）；
 * - 注册前自检：失败不注册投影、不抛错、doctor 可见；
 * - 面板条数上限与单帧体积预算（< 256KB）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  createFlowgateProjection,
  PROJECTION_KEY,
  PROJECTION_STATE_VERSION,
  projectionSelfCheck,
  resetProjectionSelfCheckForTest,
  sanitizeProjection,
  setProjectionSelfCheckForTest,
} from '../../src/host/projection/index.js'
import { resetPluginSessionApiForTest, STATE_RECORD_TYPE } from '../../src/host/adapters/session-record.js'
import type { FlowgateProjection, PanelExtras } from '../../src/host/projection/types.js'
import { emptySnapshot, initialProjection } from '../../src/host/projection/types.js'
import { toWireProjection, WIRE_PANEL_LIMITS, PANEL_WIRE_BUDGET_BYTES } from '../../src/host/projection/wire.js'
import { toLosslessJson, isLosslessJson } from '../../src/host/boundary/json.js'

const NOW = '2026-01-01T00:00:00.000Z'

let harness: PluginHarness | null = null

afterEach(async () => {
  resetPluginSessionApiForTest(undefined)
  resetProjectionSelfCheckForTest()
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function projectionEvent(data: unknown) {
  return { type: STATE_RECORD_TYPE, data }
}

/** 断言值里没有任何 undefined 属性，且通过 isLosslessJson。 */
function assertLossless(value: unknown): void {
  expect(isLosslessJson(value)).toBe(true)
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        expect(item, key).not.toBeUndefined()
        walk(item)
      }
    }
  }
  walk(value)
}

describe('投影定义（v0.5.1）', () => {
  it('key/stateVersion=2/record 类型固定（客户端契约）', () => {
    expect(PROJECTION_KEY).toBe('flowgate')
    expect(PROJECTION_STATE_VERSION).toBe(2)
    expect(STATE_RECORD_TYPE).toBe('plugin:dsh-flowgate/state')
  })

  it('init 返回合法初始值（未启用状态）', () => {
    const definition = createFlowgateProjection(() => NOW)
    const state = definition.init()
    expect(state.revision).toBe(0)
    expect(state.snapshot.initialized).toBe(false)
    expect(state.snapshot.statusLine).toContain('未启用')
    assertLossless(state)
  })

  it('init 绝不继承 latest()：另一个会话的 live 状态不能成为新会话初始值', () => {
    const live = {
      ...initialProjection(NOW),
      revision: 9,
      snapshot: { ...emptySnapshot(NOW), initialized: true, stage: 'S4' as const, statusLine: '另一个会话的 live 状态' },
      epoch: 'other-session',
    }
    const definition = createFlowgateProjection(() => NOW, () => live)
    const init = definition.init()
    expect(init.revision).toBe(0)
    expect(init.snapshot.initialized).toBe(false)
    expect(init.snapshot.stage).toBeUndefined()
    expect(init.epoch).toBeUndefined()
    // 非插件记录事件的 latest 兜底仍可用（运行期刷新语义不变）。
    const applied = definition.apply(init, { type: 'user/message', data: {} })
    expect(applied.revision).toBe(9)
    expect(applied.epoch).toBe('other-session')
  })

  it('apply 折叠 flowgate 状态记录；无关事件返回原引用', () => {
    const definition = createFlowgateProjection(() => NOW)
    const initial = definition.init()
    const unrelated = definition.apply(initial, { type: 'user/message', data: {} })
    expect(unrelated).toBe(initial)

    const next = {
      ...initialProjection('2026-01-01T00:00:01.000Z'),
      revision: 3,
      snapshot: { ...initial.snapshot, initialized: true, stage: 'S4' as const, statusLine: 'FlowGate · S4' },
    }
    const applied = definition.apply(initial, projectionEvent(next))
    expect(applied.revision).toBe(3)
    expect(applied.snapshot.stage).toBe('S4')
    // 旧 revision 不允许回退。
    const older = { ...next, revision: 2 }
    expect(definition.apply(applied, projectionEvent(older))).toBe(applied)
  })

  it('损坏记录不污染投影（sanitize 返回 null）', () => {
    expect(sanitizeProjection(null)).toBeNull()
    expect(sanitizeProjection({ revision: 1 })).toBeNull()
    expect(sanitizeProjection({ snapshot: {} })).not.toBeNull()
  })

  it('apply 折叠的插件记录也过 lossless 边界（脏记录里的 Date/NaN 不会泄漏）', () => {
    const definition = createFlowgateProjection(() => NOW)
    const initial = definition.init()
    const dirty = {
      snapshot: {
        ...emptySnapshot(NOW),
        initialized: true,
        updatedAt: new Date(0),
        contextPct: Number.NaN,
        stage: 'S4',
      },
      revision: 1,
      updatedAt: NOW,
    }
    const applied = definition.apply(initial, projectionEvent(dirty))
    expect(applied.revision).toBe(1)
    assertLossless(applied)
  })

  it('wire.view 是显式白名单 DTO：不泄漏内部字段，且全部 lossless', () => {
    const now = NOW
    const dirty = {
      snapshot: {
        ...emptySnapshot(now),
        initialized: true,
        changeId: 'C-1',
        title: '白名单测试',
        stage: 'S4' as const,
        offBy: undefined,
        takeover: 'observe' as const,
        incident: undefined,
        repair: undefined,
        contextPct: undefined,
        __internalSnapshotField: 'must-not-leak',
      },
      panel: {
        changes: [
          {
            id: 'C-1',
            title: '白名单测试',
            kind: 'change',
            complexity: 'low',
            risk: 'normal',
            stage: 'S4',
            lifecycle: 'active',
            session: undefined,
            updatedAt: now,
            __internalChangeField: 'must-not-leak',
          },
        ],
        dashboardPath: '.flowgate/dashboard.html',
        __internalPanelField: 'must-not-leak',
      },
      revision: 0,
      updatedAt: now,
      epoch: 'wire-test',
      __internalTopLevel: 'must-not-leak',
    } as unknown as FlowgateProjection
    const definition = createFlowgateProjection(() => now, () => dirty)
    const wire = definition.wire.view(dirty) as unknown as Record<string, unknown>
    assertLossless(wire)
    expect(wire['__internalTopLevel']).toBeUndefined()
    const wireSnapshot = wire['snapshot'] as Record<string, unknown>
    expect(wireSnapshot['__internalSnapshotField']).toBeUndefined()
    expect(wireSnapshot['takeover']).toBe('observe')
    expect(wireSnapshot['changeId']).toBe('C-1')
    const wirePanel = wire['panel'] as Record<string, unknown>
    expect(wirePanel['__internalPanelField']).toBeUndefined()
    expect((wirePanel['changes'] as Record<string, unknown>[])[0]?.['__internalChangeField']).toBeUndefined()
    expect(wirePanel['dashboardPath']).toBe('.flowgate/dashboard.html')
    // 顶层只有契约字段（+可选 panel/epoch）。
    expect(Object.keys(wire).sort()).toEqual(['epoch', 'panel', 'revision', 'snapshot', 'updatedAt'])
    // DSH 的 isJsonValue 等价判定：JSON 往返后语义不变。
    expect(JSON.parse(JSON.stringify(wire))).toStrictEqual(wire)
  })

  it('wire DTO 含 core v0.5.1 新增字段（offBy/takeover/incident/repair）', () => {
    const state: FlowgateProjection = {
      snapshot: {
        ...emptySnapshot(NOW),
        initialized: true,
        off: true,
        offBy: 'agent',
        takeover: 'observe',
        incident: { id: 'INC-1', severity: 'P1', reason: '主流程不可用', openedAt: NOW },
        repair: {
          id: 'FIX-20260101-000000',
          title: '回调重复扣款',
          severity: 'P0',
          status: 'open',
          scope: ['src/renewal/**'],
          verify: 'pnpm test',
          red: true,
          green: false,
          openedAt: NOW,
          actions: 3,
        },
      },
      revision: 4,
      updatedAt: NOW,
    }
    const wire = toWireProjection(state)
    expect(wire.snapshot.offBy).toBe('agent')
    expect(wire.snapshot.takeover).toBe('observe')
    expect(wire.snapshot.incident?.id).toBe('INC-1')
    expect(wire.snapshot.repair?.red).toBe(true)
    expect(wire.snapshot.repair?.actions).toBe(3)
    assertLossless(toLosslessJson(wire))
  })
})

describe('投影启动自检（P0-2）', () => {
  it('正常投影自检通过，wire 体积远小于预算', () => {
    const check = projectionSelfCheck(() => NOW)
    expect(check.ok).toBe(true)
    expect(check.error).toBeUndefined()
    expect(check.stateVersion).toBe(2)
    expect(check.wireBytes).toBeGreaterThan(0)
    expect(check.wireBytes!).toBeLessThan(PANEL_WIRE_BUDGET_BYTES)
  })

  it('自检失败时不注册投影、不抛错，并进 doctor 降级原因', async () => {
    setProjectionSelfCheckForTest(() => ({
      ok: false,
      checkedAt: NOW,
      stateVersion: 2,
      error: '注入的自检失败（故障演练）',
    }))
    // setupPlugin 内部走 startHostPlugin（与 apply 相同安装路径）：不得抛错。
    harness = await setupPlugin()
    expect(harness.projections.state.definitions.has('flowgate')).toBe(false)
    expect(harness.runtime.inertReasons.some((reason) => reason.stage === '投影自检')).toBe(true)
    expect(harness.runtime.projectionSelfCheck()?.ok).toBe(false)
    // 其余模块不受影响（工具/命令照常注册）。
    expect(harness.tools.state.tools.has('flow_status')).toBe(true)
    expect(harness.commands.state.commands.has('flow')).toBe(true)
  })

  it('自检通过时 register 前已缓存结果（doctor 可读）', async () => {
    harness = await setupPlugin()
    expect(harness.projections.state.definitions.has('flowgate')).toBe(true)
    const check = harness.runtime.projectionSelfCheck()
    expect(check?.ok).toBe(true)
    expect(check?.stateVersion).toBe(2)
  })
})

describe('面板瘦身（P2-11）', () => {
  function longRow(prefix: string, index: number, size = 120): string {
    return `${prefix}-${index}-${'x'.repeat(size)}`
  }

  function bigProjection(): FlowgateProjection {
    const changes = Array.from({ length: 80 }, (_, index) => ({
      id: `C-${index}`,
      title: longRow('变更', index),
      kind: 'change' as const,
      complexity: 'low' as const,
      risk: 'normal' as const,
      stage: 'S4',
      lifecycle: 'active' as const,
      session: longRow('session', index, 40),
      updatedAt: NOW,
    }))
    const trace = Array.from({ length: 80 }, (_, index) => ({
      requirementId: `R-${index}`,
      scenarioId: `S-${index}`,
      title: longRow('追溯', index, 50),
      taskIds: Array.from({ length: 20 }, (__, taskIndex) => `T-${index}-${taskIndex}-${'y'.repeat(10)}`),
      evidenceIds: Array.from({ length: 20 }, (__, evidenceIndex) => `E-${index}-${evidenceIndex}-${'z'.repeat(10)}`),
      covered: true,
    }))
    const evidence = Array.from({ length: 80 }, (_, index) => ({
      id: `E-${index}`,
      group: `group-${index}`,
      kind: 'test',
      phase: 'green',
      exitCode: 0,
      run: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      fresh: true,
      finishedAt: NOW,
    }))
    const panel: PanelExtras = {
      changes,
      gate: { gate: 'G1', state: 'pending', items: [], awaitingOwner: false },
      trace,
      evidence,
      intercepts: Array.from({ length: 80 }, (_, index) => ({
        at: NOW,
        ruleId: `R-${index}`,
        tool: 'write',
        effect: 'deny' as const,
        why: longRow('拦截', index),
        unlock: longRow('解锁', index),
      })),
      rules: Array.from({ length: 80 }, (_, index) => ({
        id: `RULE-${index}`,
        decision: 'deny',
        why: longRow('原因', index),
        unlock: longRow('解锁', index),
        hits: index,
      })),
      risks: Array.from({ length: 40 }, (_, index) => ({
        category: `cat-${index}`,
        grade: 'high',
        reason: longRow('风险', index),
        mitigation: longRow('缓解', index),
        verification: longRow('验证', index),
        needsHuman: true,
      })),
      reviews: Array.from({ length: 40 }, (_, index) => ({
        id: `RV-${index}`,
        kind: 'task',
        verdict: 'changes-required',
        findings: Array.from({ length: 10 }, (__, findingIndex) => ({
          severity: 'major',
          file: `src/file-${findingIndex}.ts`,
          line: findingIndex + 1,
          message: longRow('发现', findingIndex, 80),
        })),
        coverageOk: false,
        createdAt: NOW,
      })),
      roadmap: {
        mvpCut: 'MVP',
        entries: Array.from({ length: 60 }, (_, index) => ({
          change: `C-${index}`,
          capability: longRow('能力', index),
          goal: longRow('目标', index),
          status: '已交付',
          mvp: true,
        })),
        delivered: 60,
        total: 60,
      },
      dashboardPath: '.flowgate/dashboard.html',
    }
    return {
      snapshot: {
        ...emptySnapshot(NOW),
        initialized: true,
        changeId: 'C-BIG',
        tasks: Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [`T-${index}`, { state: 'todo', evidenceIds: [] }]),
        ) as unknown as FlowgateProjection['snapshot']['tasks'],
        pending: Array.from({ length: 50 }, (_, index) => ({
          id: `P-${index}`,
          kind: 'scope' as const,
          changeId: 'C-BIG',
          title: longRow('待处理', index, 40),
          detail: '',
          status: 'open' as const,
          createdAt: NOW,
        })),
      },
      panel,
      revision: 99,
      updatedAt: NOW,
      epoch: 'budget-test',
    }
  }

  it('大块有上限（changes/evidence/trace/rules/intercepts/reviews/roadmap）', () => {
    const wire = toWireProjection(bigProjection())
    expect(wire.panel?.changes?.length).toBe(WIRE_PANEL_LIMITS.changes)
    expect(wire.panel?.evidence?.length).toBe(WIRE_PANEL_LIMITS.evidence)
    expect(wire.panel?.trace?.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.trace)
    expect(wire.panel?.rules?.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.rules)
    expect(wire.panel?.intercepts?.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.intercepts)
    expect(wire.panel?.reviews?.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.reviews)
    expect(wire.panel?.roadmap?.entries.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.roadmapEntries)
    expect(wire.panel?.risks?.length).toBeLessThanOrEqual(WIRE_PANEL_LIMITS.risks)
  })

  it('worst-case wire JSON < 256KB 且 isLosslessJson', () => {
    const wire = toLosslessJson(toWireProjection(bigProjection()))
    const bytes = new TextEncoder().encode(JSON.stringify(wire)).length
    expect(bytes).toBeLessThan(PANEL_WIRE_BUDGET_BYTES)
    expect(isLosslessJson(wire)).toBe(true)
    expect(JSON.parse(JSON.stringify(wire))).toStrictEqual(wire)
  })
})

describe('插件运行期投影', () => {
  beforeEach(() => {
    resetProjectionSelfCheckForTest()
  })

  it('注册后每次 engine 状态变化写 plugin:dsh-flowgate/state 插件记录（appendPluginRecord 可用时）', async () => {
    resetPluginSessionApiForTest({
      appendPluginRecord(session: unknown, type: string, data: Record<string, unknown>) {
        ;(session as { append(type: string, data: Record<string, unknown>): unknown }).append(type, data)
      },
    })
    harness = await setupPlugin()
    const definition = harness.projections.state.definitions.get('flowgate')
    expect(definition).toBeDefined()
    const session = harness.agent.session as unknown as { state: { appended: { type: string; data: Record<string, unknown> }[] } }
    const before = session.state.appended.filter((event) => event.type === STATE_RECORD_TYPE).length
    ;(harness.engine as unknown as { state: { snapshotOverrides: Record<string, unknown> } }).state.snapshotOverrides = {
      initialized: true,
      stage: 'S4',
      statusLine: 'FlowGate · S4 执行中',
    }
    harness.runtime.emit()
    let after = before
    for (let index = 0; index < 100 && after === before; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      after = session.state.appended.filter((event) => event.type === STATE_RECORD_TYPE).length
    }
    expect(after).toBeGreaterThan(before)
    const latest = [...session.state.appended].reverse().find((event) => event.type === STATE_RECORD_TYPE)
    expect((latest?.data.snapshot as { stage?: string }).stage).toBe('S4')
    expect(typeof latest?.data.revision).toBe('number')
    expect(isLosslessJson(latest?.data)).toBe(true)
  })

  it('appendPluginRecord 不可用时不写 session.append（避免损坏会话日志）', async () => {
    resetPluginSessionApiForTest(null)
    harness = await setupPlugin()
    const session = harness.agent.session as unknown as { state: { appended: { type: string }[] } }
    const before = session.state.appended.length
    harness.runtime.emit()
    for (let index = 0; index < 50 && session.state.appended.length === before; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(session.state.appended.length).toBe(before)
    // 投影仍然在内存里更新，供 client 的 latest-snapshot 兜底读取。
    expect(harness.runtime.projection().revision).toBeGreaterThanOrEqual(0)
  })

  it('内容不变时去重（revision 不增长、不重复写日志）', async () => {
    harness = await setupPlugin()
    harness.runtime.emit()
    const revision = harness.runtime.projection().revision
    harness.runtime.emit()
    harness.runtime.emit()
    expect(harness.runtime.projection().revision).toBe(revision)
  })

  it('投影 wire 值包含 panel 字段（client 面板降级显示用）', async () => {
    harness = await setupPlugin()
    harness.runtime.emit()
    const definition = harness.projections.state.definitions.get('flowgate') as
      | { wire: { view(state: FlowgateProjection): FlowgateProjection } }
      | undefined
    const wire = definition?.wire.view(harness.runtime.projection())
    expect(wire?.panel).toBeDefined()
    expect(wire?.panel?.dashboardPath).toBe('.flowgate/dashboard.html')
    expect(Array.isArray(wire?.panel?.changes)).toBe(true)
    expect(isLosslessJson(wire)).toBe(true)
  })
})
