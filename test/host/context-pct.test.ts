/**
 * P1-7：上下文占用（contextPct）数据源。
 *
 * rc.5 里占用由 `@deepseek-ai/dsh-token-meter` 的 `contextPressure` 会话投影提供
 * （wire 值 `{ projectedTokens?, pressureTokens?, contextWindow? }`）。host 在
 * `runtime.emit()` 时把它换算成百分比写进投影快照的 `contextPct`：
 *  - 有投影且数字齐全 → 正确百分比；
 *  - 没有投影 / 没有 token-meter / 字段缺失 / 读取抛错 → 保持 undefined
 *    （绝不编造），且不降级插件其他功能；
 *  - 只有 host-only state（无 wire）时退回 `stateOf` 读取。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import {
  CONTEXT_PRESSURE_KEY,
  contextPctFromPressure,
  readContextPct,
} from '../../src/host/projection/context.js'
import { createFakeProjectionRegistry, createFakeSession } from '../../src/host/testing/fake-ctx.js'
import type { DshSessionProjectionRegistry } from '../../src/host/adapters/dsh-types.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
})

function projectionContextPct(plugin: PluginHarness): number | undefined {
  return plugin.runtime.projection().snapshot.contextPct
}

describe('contextPctFromPressure（纯换算）', () => {
  it('uses projectedTokens (next-request budget) over pressureTokens', () => {
    expect(
      contextPctFromPressure({ pressureTokens: 100_000, projectedTokens: 150_000, contextWindow: 200_000 }),
    ).toBe(75)
  })

  it('falls back to pressureTokens when projectedTokens is absent', () => {
    expect(contextPctFromPressure({ pressureTokens: 50_000, contextWindow: 100_000 })).toBe(50)
  })

  it('rounds to one decimal and clamps to 0–100', () => {
    expect(contextPctFromPressure({ pressureTokens: 1, contextWindow: 3 })).toBe(33.3)
    expect(contextPctFromPressure({ pressureTokens: 999, contextWindow: 1_000 })).toBe(99.9)
    expect(contextPctFromPressure({ pressureTokens: 500, contextWindow: 100 })).toBe(100)
  })

  it('never fabricates a number when a field is missing or malformed', () => {
    expect(contextPctFromPressure(undefined)).toBeUndefined()
    expect(contextPctFromPressure(null)).toBeUndefined()
    expect(contextPctFromPressure('120000/200000')).toBeUndefined()
    // No denominator → no ratio, even when pressure is known.
    expect(contextPctFromPressure({ pressureTokens: 120_000 })).toBeUndefined()
    // No numerator.
    expect(contextPctFromPressure({ contextWindow: 200_000 })).toBeUndefined()
    // Zero / negative / non-finite values are "absent", not zero-percent.
    expect(contextPctFromPressure({ pressureTokens: 0, contextWindow: 200_000 })).toBeUndefined()
    expect(contextPctFromPressure({ pressureTokens: -5, contextWindow: 200_000 })).toBeUndefined()
    expect(contextPctFromPressure({ pressureTokens: Number.POSITIVE_INFINITY, contextWindow: 200_000 })).toBeUndefined()
    expect(contextPctFromPressure({ pressureTokens: 10, contextWindow: Number.NaN })).toBeUndefined()
    expect(contextPctFromPressure({ pressureTokens: '1000', contextWindow: 200_000 })).toBeUndefined()
  })
})

describe('readContextPct（会话投影读取路径）', () => {
  const session = createFakeSession({ id: 'session-main' })

  it('reads the client-visible contextPressure wire value', () => {
    const registry = createFakeProjectionRegistry({
      values: { [CONTEXT_PRESSURE_KEY]: { projectedTokens: 120_000, contextWindow: 200_000 } },
    })
    expect(readContextPct(registry, session)).toBe(60)
  })

  it('falls back to stateOf when no wire value is registered (host-only unit)', () => {
    const registry = createFakeProjectionRegistry({
      values: {},
      states: { [CONTEXT_PRESSURE_KEY]: { pressureTokens: 25_000, contextWindow: 100_000 } },
    })
    expect(readContextPct(registry, session)).toBe(25)
  })

  it('returns undefined without a registry, a session, or a contextPressure key', () => {
    expect(readContextPct(null, session)).toBeUndefined()
    expect(readContextPct(createFakeProjectionRegistry(), null)).toBeUndefined()
    expect(readContextPct(createFakeProjectionRegistry(), session)).toBeUndefined()
  })

  it('degrades on a throwing registry instead of propagating', () => {
    const throwing = {
      snapshot: () => {
        throw new Error('projection unavailable')
      },
      stateOf: () => {
        throw new Error('projection unavailable')
      },
    } as unknown as DshSessionProjectionRegistry
    expect(readContextPct(throwing, session)).toBeUndefined()
  })
})

describe('runtime 投影快照的 contextPct（P1-7）', () => {
  it('fills contextPct from the contextPressure projection', async () => {
    harness = await setupPlugin({
      projectionValues: {
        [CONTEXT_PRESSURE_KEY]: { projectedTokens: 120_000, contextWindow: 200_000 },
      },
    })
    expect(harness.runtime.contextPct()).toBe(60)
    expect(projectionContextPct(harness)).toBe(60)
    // 快照仍是引擎快照 + 可选字段：lastSnapshot 不写回 contextPct。
    expect(harness.runtime.lastSnapshot?.contextPct).toBeUndefined()
  })

  it('leaves contextPct absent when the host has no contextPressure projection', async () => {
    harness = await setupPlugin()
    expect(harness.runtime.contextPct()).toBeUndefined()
    expect(projectionContextPct(harness)).toBeUndefined()
    // 没有编造的默认值；快照字段保持缺失（序列化后不会出现）。
    expect('contextPct' in harness.runtime.projection().snapshot).toBe(false)
    // 其余功能不受影响：命令族仍注册、投影仍可读。
    expect(harness.commands.state.commands.has('flow')).toBe(true)
    expect(harness.runtime.inertReasons.some((reason) => reason.stage === 'contextPct')).toBe(false)
  })

  it('keeps contextPct absent when the host composition has no sessionProjections service at all', async () => {
    harness = await setupPlugin({ missingServices: ['sessionProjections'] })
    expect(harness.runtime.capabilities.sessionProjections).toBe(false)
    expect(harness.runtime.contextPct()).toBeUndefined()
    expect(projectionContextPct(harness)).toBeUndefined()
    expect(harness.commands.state.commands.has('flow')).toBe(true)
  })

  it('leaves contextPct absent when pressure or contextWindow is missing (no fabrication)', async () => {
    harness = await setupPlugin({
      projectionValues: { [CONTEXT_PRESSURE_KEY]: { pressureTokens: 120_000 } },
    })
    expect(projectionContextPct(harness)).toBeUndefined()

    await harness.cleanup()
    harness = await setupPlugin({
      projectionValues: { [CONTEXT_PRESSURE_KEY]: { contextWindow: 200_000 } },
    })
    expect(projectionContextPct(harness)).toBeUndefined()
  })

  it('survives a throwing projection registry while the plugin keeps working', async () => {
    const throwing = {
      register: () => () => {},
      snapshot: () => {
        throw new Error('boom')
      },
    }
    harness = await setupPlugin({ services: { sessionProjections: throwing } })
    expect(harness.runtime.contextPct()).toBeUndefined()
    expect(projectionContextPct(harness)).toBeUndefined()
    expect(harness.commands.state.commands.has('flow')).toBe(true)
  })

  it('refreshes on the next emit when the projection value changes, and dedupes unchanged frames', async () => {
    harness = await setupPlugin()
    const initialRevision = harness.runtime.projection().revision
    harness.projections.state.values[CONTEXT_PRESSURE_KEY] = { projectedTokens: 90_000, contextWindow: 200_000 }
    harness.runtime.emit()
    expect(projectionContextPct(harness)).toBe(45)
    const bumped = harness.runtime.projection().revision
    expect(bumped).toBeGreaterThan(initialRevision)
    // 同样的引擎快照 + 同样的 contextPct：hash 不变，不重复 bump。
    harness.runtime.emit()
    expect(harness.runtime.projection().revision).toBe(bumped)
  })

  it('uninstalls the data source with the plugin (no stale contextPct after dispose)', async () => {
    harness = await setupPlugin({
      projectionValues: {
        [CONTEXT_PRESSURE_KEY]: { projectedTokens: 150_000, contextWindow: 200_000 },
      },
    })
    expect(projectionContextPct(harness)).toBe(75)
    const plugin = harness
    await plugin.cleanup()
    harness = null
    expect(plugin.runtime.contextPct()).toBeUndefined()
  })
})

describe('contextPct live 路径（token-meter 变更通知）', () => {
  /** 等微任务 + 计时器：onChanged 的 emit 被延后到微任务。 */
  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('refreshes the projection when token-meter pushes a contextPressure change', async () => {
    harness = await setupPlugin()
    expect(projectionContextPct(harness)).toBeUndefined()
    expect(harness.projections.state.listeners.size).toBeGreaterThan(0)

    harness.projections.emitChange(harness.runtime.mainSession()!, CONTEXT_PRESSURE_KEY, {
      projectedTokens: 100_000,
      contextWindow: 200_000,
    })
    await flushMicrotasks()
    expect(harness.runtime.contextPct()).toBe(50)
    expect(projectionContextPct(harness)).toBe(50)
  })

  it('ignores changes of other projection keys and other sessions', async () => {
    harness = await setupPlugin()
    harness.projections.emitChange(harness.runtime.mainSession()!, CONTEXT_PRESSURE_KEY, {
      pressureTokens: 60_000,
      contextWindow: 200_000,
    })
    await flushMicrotasks()
    const revision = harness.runtime.projection().revision
    expect(projectionContextPct(harness)).toBe(30)

    // Unrelated key: no engine emit, projection unchanged.
    harness.projections.emitChange(harness.runtime.mainSession()!, 'tokenUsage', {
      uncachedInputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    await flushMicrotasks()
    expect(harness.runtime.projection().revision).toBe(revision)

    // Another session's contextPressure: ignored (FlowGate only tracks the main session).
    const other = createFakeSession({ id: 'other-session' })
    harness.projections.emitChange(other, CONTEXT_PRESSURE_KEY, {
      projectedTokens: 190_000,
      contextWindow: 200_000,
    })
    await flushMicrotasks()
    expect(projectionContextPct(harness)).toBe(30)
    expect(harness.runtime.projection().revision).toBe(revision)
  })

  it('stops listening after plugin dispose', async () => {
    harness = await setupPlugin()
    const plugin = harness
    expect(plugin.projections.state.listeners.size).toBeGreaterThan(0)
    await plugin.cleanup()
    harness = null
    expect(plugin.projections.state.listeners.size).toBe(0)
  })
})
