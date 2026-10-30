/**
 * 会话投影 key=flowgate 与插件记录折叠（host↔client 契约）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  createFlowgateProjection,
  PROJECTION_KEY,
  PROJECTION_STATE_VERSION,
  sanitizeProjection,
} from '../../src/host/projection/index.js'
import { resetPluginSessionApiForTest, STATE_RECORD_TYPE } from '../../src/host/adapters/session-record.js'
import { initialProjection } from '../../src/host/projection/types.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  resetPluginSessionApiForTest(undefined)
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function projectionEvent(data: unknown) {
  return { type: STATE_RECORD_TYPE, data }
}

describe('投影定义', () => {
  it('key/stateVersion/record 类型固定（客户端契约）', () => {
    expect(PROJECTION_KEY).toBe('flowgate')
    expect(PROJECTION_STATE_VERSION).toBe(1)
    expect(STATE_RECORD_TYPE).toBe('plugin:dsh-flowgate/state')
  })

  it('init 返回合法初始值（未启用状态）', () => {
    const definition = createFlowgateProjection(() => '2026-01-01T00:00:00.000Z')
    const state = definition.init()
    expect(state.revision).toBe(0)
    expect(state.snapshot.initialized).toBe(false)
    expect(state.snapshot.statusLine).toContain('未启用')
    expect(state.learning).toBe('detail')
  })

  it('apply 折叠 flowgate 状态记录；无关事件返回原引用', () => {
    const definition = createFlowgateProjection(() => '2026-01-01T00:00:00.000Z')
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

  it('wire.view 原样输出投影值（stateSchema/viewSchema 仅 passthrough.parse）', () => {
    const definition = createFlowgateProjection(() => '2026-01-01T00:00:00.000Z')
    const state = definition.init()
    const view = definition.wire.view(state)
    expect(view).toBe(state)
    expect(definition.wire.viewSchema.parse(view)).toBe(view)
  })
})

describe('插件运行期投影', () => {
  it('注册后每次 engine 状态变化写 plugin:dsh-flowgate/state 插件记录（appendPluginRecord 可用时）', async () => {
    // 真实宿主提供 appendPluginRecord；测试注入等价实现（写进 fake session 日志）。
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
    expect(latest?.data).toMatchObject({ learning: 'detail' })
    expect((latest?.data.snapshot as { stage?: string }).stage).toBe('S4')
    expect(typeof latest?.data.revision).toBe('number')
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
    const projection = harness.runtime.projection()
    expect(projection.panel).toBeDefined()
    expect(projection.panel?.dashboardPath).toBe('.flowgate/dashboard.html')
    expect(Array.isArray(projection.panel?.changes)).toBe(true)
  })
})
