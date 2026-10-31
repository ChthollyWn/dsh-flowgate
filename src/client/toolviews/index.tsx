/**
 * FlowGate conversation tool views (`tool.call.toolview`) — registration entry.
 *
 * DSH dispatches every atomic model tool call through the keyed
 * `tool.call.toolview` slot with `entryKey = wire tool name`; unregistered
 * names fall back to the generic tool card. This module registers one row for
 * every FlowGate wire name so a `flow_*` call renders as a mini seven-stage
 * rail instead of a plain tool row.
 *
 * Registration contract (verified against the shipped DSH web client):
 *
 * ```ts
 * ctx.slots.inject('tool.call.toolview', () =>
 *   ctx.slots.register(
 *     { name: 'tool.call.toolview', key: '<wire tool name>', locale: 'dsh-flowgate' },
 *     FlowToolRow,
 *   ),
 * )
 * ```
 *
 * `slots.inject` defers until the slot declaration exists (the conversation
 * package may load after us) and re-runs on redeclaration, so this is safe to
 * call from `apply()`. Every registration and controller disposer is collected
 * and returned; a missing / exotic host degrades to a no-op instead of making
 * plugin apply fail.
 *
 * Integration (Lead owns `src/client/index.tsx`; one line inside `apply()`):
 *
 * ```ts
 * ctx.effect(() => {
 *   const disposers = registerFlowToolViews(ctx)
 *   return () => {
 *     for (const dispose of disposers) {
 *       try { dispose() } catch {}
 *     }
 *   }
 * }, 'flowgate: tool views')
 * ```
 */
import type { ClientContext, Disposer, SlotsService } from '../types'
import { LOCALE_NS } from '../types'
import { FlowToolRow } from './FlowToolRow'
import { FLOW_TOOL_NAMES } from './viewmodel'
import { ensureToolviewStyles } from './styles'

/** Slot key the conversation tool rows are dispatched through. */
export const TOOLVIEW_SLOT = 'tool.call.toolview' as const

/**
 * Wire names currently registered by this module instance. Guards against a
 * double `apply()` (e.g. HMR / duplicate plugin load) registering the same
 * keyed cell twice — the slot registry throws on a duplicate key at the same
 * priority, which would otherwise surface as a load error.
 */
const activeToolviewKeys = new Set<string>()

/** Diagnostics helper (tests / doctor): wire names currently registered. */
export function activeFlowToolviews(): string[] {
  return [...activeToolviewKeys].sort()
}

/** Best-effort logger: reading an undeclared Cordis service must never throw. */
function safeWarn(ctx: ClientContext, message: string, error?: unknown): void {
  try {
    ctx.logger?.warn?.(`[flowgate] ${message}`, error)
  } catch {
    /* logger is best-effort */
  }
}

/**
 * Register the FlowGate conversation rows.
 *
 * - idempotent per wire name (duplicate calls skip already-active keys),
 * - every key is registered through `slots.inject` when available so a
 *   not-yet-declared slot is awaited instead of throwing,
 * - returns the disposers; failures are logged and skipped, never thrown.
 */
export function registerFlowToolViews(ctx: ClientContext): Disposer[] {
  const disposers: Disposer[] = []
  try {
    ensureToolviewStyles()
  } catch {
    /* cosmetic only */
  }

  let slots: SlotsService | undefined
  try {
    slots = ctx?.slots
  } catch {
    slots = undefined
  }
  if (slots === undefined || slots === null) return disposers
  const service = slots
  if (typeof service.register !== 'function') return disposers

  // Bind through the service object: `register` / `inject` are Cordis service
  // methods that read `this`, so detached references would break.
  const registerFn = service.register.bind(service)
  const injectFn = typeof service.inject === 'function' ? service.inject.bind(service) : undefined

  const registerOne = (toolName: string): Disposer | void => {
    if (activeToolviewKeys.has(toolName)) return undefined
    let result: Disposer | void
    try {
      result = registerFn({ name: TOOLVIEW_SLOT, key: toolName, locale: LOCALE_NS }, FlowToolRow)
    } catch (error) {
      safeWarn(ctx, `tool.call.toolview registration failed for ${toolName}`, error)
      return undefined
    }
    activeToolviewKeys.add(toolName)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      activeToolviewKeys.delete(toolName)
      if (typeof result === 'function') {
        try {
          result()
        } catch {
          /* idempotent disposer; ignore */
        }
      }
    }
  }

  const seen = new Set<string>()
  for (const toolName of FLOW_TOOL_NAMES) {
    if (seen.has(toolName)) continue
    seen.add(toolName)
    try {
      if (injectFn !== undefined) {
        // Deferred: the declaration may not exist yet; the callback owns the
        // registration and the registry disposes it on declaration collapse.
        const controller = injectFn(TOOLVIEW_SLOT, () => registerOne(toolName))
        if (typeof controller === 'function') disposers.push(controller as Disposer)
      } else {
        // Lean host without declaration injection: try directly (the register
        // call itself may throw if the slot is undeclared — caught below).
        const dispose = registerOne(toolName)
        if (typeof dispose === 'function') disposers.push(dispose)
      }
    } catch (error) {
      safeWarn(ctx, `tool.call.toolview inject failed for ${toolName}`, error)
    }
  }
  return disposers
}

export { FlowToolRow, FlowToolRowView } from './FlowToolRow'
export { FLOW_TOOL_NAMES, TOOL_STAGE_HINT, buildFlowToolViewModel } from './viewmodel'
export type {
  FlowToolNodeModel,
  FlowToolRowProps,
  FlowToolViewModel,
  ToolPhase,
  ToolRunState,
} from './viewmodel'
