/**
 * FlowGate client entry (browser half).
 *
 * The bundle is built by tsdown into a `window.__ModuleLoader__.load({id,
 * factory})` wrapper; inside, this module is a Cordis client plugin exporting
 * `{ name, inject, apply }`.
 *
 * Registrations:
 *  1. locale namespace `dsh-flowgate` (zh / en dictionaries);
 *  2. `conversation.input.dock` → status bar (session scope);
 *  3. `sidebarRightTabs.register({ id, kind, title, guide })` +
 *     `slots.register({ name: 'sidebar.right.pane.tab', key })` → 8-view panel.
 *
 * Host services are only reached through structural `ctx` / `ctx.inject` (see
 * bridge.ts); nothing from `@deepseek-ai/*` is imported at runtime.
 *
 * The sidebar tab registration runs directly when `ctx.sidebarRightTabs` is
 * already present (it is loaded before us via `dsh.client.inject` ordering) and
 * falls back to a deferred `ctx.inject` when it is not, so both a full host and
 * a minimal/verification context register the same two-stage tab type.
 */
import { createElement } from 'react'
import type {
  ClientContext,
  Disposer,
  LocaleService,
  SidebarRightTabsService,
  SlotPropRecord,
  SlotsService,
} from './types'
import { DOCK_ID, LOCALE_NS, TAB_ID, TAB_KIND } from './types'
import { DICTS, fallbackTranslator } from './i18n'
import type { TFn } from './i18n'
import { createHostBridge } from './bridge'
import { StatusBar } from './dock/StatusBar'
import { Panel } from './panel/Panel'

export const name = 'dsh-flowgate'

/**
 * Hard injects are the two services always available to a web client plugin.
 * Everything else (remote, sidebarRight, sessions, conversation) is resolved
 * through deferred `ctx.inject` in the bridge so an older/leaner host still
 * loads the plugin without the panel.
 */
export const inject: string[] = ['slots', 'locale']

function safeWarn(ctx: ClientContext, message: string, error?: unknown): void {
  try {
    ctx.logger?.warn?.(`[flowgate] ${message}`, error)
  } catch {
    /* logger is best-effort */
  }
}

/** Bind the locale service, falling back to the bundled Chinese dictionary. */
function bindTranslator(ctx: ClientContext): TFn {
  let t: TFn = fallbackTranslator()
  let locale: LocaleService | undefined
  try {
    locale = ctx.locale
  } catch {
    locale = undefined
  }
  if (locale !== undefined) {
    try {
      if (typeof locale.register === 'function') {
        const register = () => locale.register?.(LOCALE_NS, { zh: DICTS.zh, en: DICTS.en })
        if (typeof ctx.effect === 'function') {
          ctx.effect(register, 'flowgate: locale dictionaries')
        } else {
          register()
        }
      }
    } catch (error) {
      safeWarn(ctx, 'locale.register failed', error)
    }
    try {
      if (typeof locale.bind === 'function') {
        const bound = locale.bind(LOCALE_NS)
        if (typeof bound === 'function') t = bound as unknown as TFn
      }
    } catch (error) {
      safeWarn(ctx, 'locale.bind failed', error)
    }
  }
  return t
}

function registerDock(ctx: ClientContext, t: TFn, bridge: ReturnType<typeof createHostBridge>): boolean {
  const slots = ctx.slots
  if (slots === undefined || typeof slots.register !== 'function') return false
  const DockSlot = (props: SlotPropRecord) => createElement(StatusBar, { props, t, bridge })
  try {
    const register = (): void => {
      slots.register?.(
        {
          name: 'conversation.input.dock',
          id: DOCK_ID,
          order: 40,
          locale: LOCALE_NS,
        },
        DockSlot,
      )
    }
    // The slot is declared by the conversation entry's children table, which may
    // not be registered yet when this plugin applies. `slots.inject(name, cb)`
    // defers registration until the declaration exists (same idiom as ui plugins).
    const registerWhenDeclared = (): void => {
      if (typeof slots.inject === 'function') {
        slots.inject('conversation.input.dock', () => {
          register()
        })
        return
      }
      register()
    }
    if (typeof ctx.effect === 'function') ctx.effect(registerWhenDeclared, 'flowgate: input dock')
    else registerWhenDeclared()
    return true
  } catch (error) {
    safeWarn(ctx, 'conversation.input.dock registration failed', error)
    try {
      // eslint-disable-next-line no-console
      console.warn('[flowgate] conversation.input.dock registration failed:', error)
    } catch {
      /* ignore */
    }
    return false
  }
}

/**
 * Two-stage right-sidebar registration. Shared by the direct path and the
 * deferred-inject path so both behave exactly the same.
 */
function registerSidebarNow(
  tabs: SidebarRightTabsService | undefined,
  slots: SlotsService | undefined,
  t: TFn,
  bridge: ReturnType<typeof createHostBridge>,
): Disposer {
  if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return () => {}
  if (slots === undefined || slots === null || typeof slots.register !== 'function') return () => {}
  const disposers: Disposer[] = []
  const own = (result: unknown): void => {
    if (typeof result === 'function') disposers.push(result as Disposer)
  }
  try {
    own(
      tabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        multiple: false,
        keepMounted: true,
        priority: 'extension',
        title: () => t('panel.title'),
        guide: [
          {
            id: TAB_ID,
            order: 40,
            title: () => t('panel.title'),
            description: () => t('app.tagline'),
          },
        ],
      }),
    )
    const PanelSlot = (props: SlotPropRecord) => createElement(Panel, { props, t, bridge })
    own(
      slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: LOCALE_NS,
        },
        PanelSlot,
      ),
    )
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore partial cleanup */
      }
    }
    throw error
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

function registerSidebarPanel(ctx: ClientContext, t: TFn, bridge: ReturnType<typeof createHostBridge>): void {
  // Cordis contexts forbid reading a service that the plugin did not declare in
  // `inject` ("cannot get property X without inject"), and `sidebarRightTabs` is
  // optional (the dock must still work on hosts without the right sidebar). So
  // the panel is registered exclusively through deferred `ctx.inject`.
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['sidebarRightTabs', 'slots'], (injected: ClientContext) => {
      try {
        return registerSidebarNow(injected.sidebarRightTabs, injected.slots, t, bridge)
      } catch (error) {
        safeWarn(ctx, 'sidebar tab registration failed', error)
        return undefined
      }
    })
  } catch (error) {
    safeWarn(ctx, 'sidebar panel inject failed', error)
  }
}

export function apply(ctx: ClientContext): void {
  const t = bindTranslator(ctx)
  const bridge = createHostBridge(ctx)
  try {
    const dispose = bridge.wire()
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flowgate: host bridge')
  } catch (error) {
    safeWarn(ctx, 'host bridge wiring failed', error)
  }
  const dockRegistered = registerDock(ctx, t, bridge)
  registerSidebarPanel(ctx, t, bridge)
  // Diagnostics (host doctor / e2e): proves the browser half actually applied.
  try {
    ;(globalThis as { __FLOWGATE_CLIENT__?: unknown }).__FLOWGATE_CLIENT__ = {
      name,
      dockRegistered,
      at: new Date().toISOString(),
    }
  } catch {
    /* ignore */
  }
}
