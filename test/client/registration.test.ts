/**
 * Registration tests: `apply(ctx)` must register the dock slot and the
 * two-stage sidebar tab exactly as the host expects, without importing any
 * `@deepseek-ai/*` runtime module.
 */
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../../src/client/index'
import type { ClientContext } from '../../src/client/types'
import { DOCK_ID, LOCALE_NS, TAB_ID, TAB_KIND } from '../../src/client/types'

interface SlotCall {
  def: Record<string, unknown>
  component: unknown
}

interface FakeCtx {
  ctx: ClientContext
  slots: SlotCall[]
  tabs: Record<string, unknown>[]
  locales: { ns: string; dicts: Record<string, Record<string, string>> }[]
  injected: string[][]
}

function makeFakeCtx(options: { withInject?: boolean } = {}): FakeCtx {
  const slots: SlotCall[] = []
  const tabs: Record<string, unknown>[] = []
  const locales: { ns: string; dicts: Record<string, Record<string, string>> }[] = []
  const injected: string[][] = []
  const disposable = (): (() => void) => () => {}

  const slotService = {
    register: (def: Record<string, unknown>, component: unknown) => {
      slots.push({ def, component })
      return disposable()
    },
  }

  const ctx: ClientContext = {
    effect: (callback: () => (() => void) | void) => {
      const dispose = callback()
      return dispose
    },
    slots: slotService,
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => {
        locales.push({ ns, dicts })
        return disposable()
      },
      bind: (ns: string) => {
        expect(ns).toBe(LOCALE_NS)
        return (key: string) => key
      },
    },
    logger: { warn: () => {}, info: () => {} },
  }

  if (options.withInject !== false) {
    ctx.inject = (deps: string[], callback: (c: ClientContext) => unknown) => {
      injected.push(deps)
      if (deps.includes('sidebarRightTabs')) {
        const injectedCtx: ClientContext = {
          slots: slotService,
          sidebarRightTabs: {
            register: (def: Record<string, unknown>) => {
              tabs.push(def)
              return disposable()
            },
          },
        }
        const result = callback(injectedCtx)
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('remote')) {
        const result = callback({
          remote: {
            flowgate: {
              state: async () => ({}) as unknown,
              action: async () => ({ ok: true, message: 'x' }) as unknown,
            },
          },
        })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('sidebarRight')) {
        const result = callback({ sidebarRight: { openTab: () => undefined } })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('sessions')) {
        const result = callback({
          sessions: { binding: () => undefined },
          conversation: { input: { for: () => undefined } },
        })
        return typeof result === 'function' ? result : undefined
      }
      return undefined
    }
  }
  return { ctx, slots, tabs, locales, injected }
}

describe('client plugin entry', () => {
  it('exports the Cordis plugin shape and hard injects slots + locale', () => {
    expect(name).toBe('dsh-flowgate')
    expect(typeof apply).toBe('function')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
  })

  it('registers the locale namespace with complete zh + en dictionaries', () => {
    const fake = makeFakeCtx()
    apply(fake.ctx)
    const registered = fake.locales.find((entry) => entry.ns === LOCALE_NS)
    expect(registered).toBeDefined()
    expect(Object.keys(registered?.dicts.zh ?? {}).length).toBeGreaterThan(250)
    expect(Object.keys(registered?.dicts.en ?? {}).length).toBe(Object.keys(registered?.dicts.zh ?? {}).length)
    expect(registered?.dicts.zh?.['panel.title']).toBe('FlowGate')
  })

  it('registers the status bar on conversation.input.dock', () => {
    const fake = makeFakeCtx()
    apply(fake.ctx)
    const dock = fake.slots.find((call) => call.def.name === 'conversation.input.dock')
    expect(dock).toBeDefined()
    expect(dock?.def.id).toBe(DOCK_ID)
    expect(typeof dock?.def.order).toBe('number')
    expect(dock?.def.locale).toBe(LOCALE_NS)
    expect(typeof dock?.component).toBe('function')
  })

  it('registers the sidebar tab type and the pane body (two-stage)', () => {
    const fake = makeFakeCtx()
    apply(fake.ctx)
    const tab = fake.tabs.find((def) => def.id === TAB_ID)
    expect(tab).toBeDefined()
    expect(tab?.kind).toBe(TAB_KIND)
    expect(tab?.multiple).toBe(false)
    expect(typeof tab?.title).toBe('function')
    expect((tab?.title as () => string)()).toBe('panel.title')
    expect(Array.isArray(tab?.guide)).toBe(true)
    const body = fake.slots.find((call) => call.def.name === 'sidebar.right.pane.tab')
    expect(body).toBeDefined()
    expect(body?.def.key).toBe(TAB_ID)
    expect(typeof body?.component).toBe('function')
  })

  it('wires the optional services through deferred injects', () => {
    const fake = makeFakeCtx()
    apply(fake.ctx)
    const deps = fake.injected.map((entry) => entry.join(','))
    expect(deps).toContain(`remote,remote.flowgate`)
    expect(deps).toContain('sidebarRight')
    expect(deps).toContain('sidebarRightTabs,slots')
    expect(deps).toContain('sessions,conversation')
  })

  it('still works on a lean host without inject / remote / sidebarRight', () => {
    const fake = makeFakeCtx({ withInject: false })
    expect(() => apply(fake.ctx)).not.toThrow()
    expect(fake.slots.some((call) => call.def.name === 'conversation.input.dock')).toBe(true)
    expect(fake.tabs).toHaveLength(0)
  })

  it('registers the sidebar tab directly when the service is already on the context', () => {
    const slots: SlotCall[] = []
    const tabs: Record<string, unknown>[] = []
    const ctx: ClientContext = {
      slots: {
        register: (def: Record<string, unknown>, component: unknown) => {
          slots.push({ def, component })
          return () => {}
        },
      },
      sidebarRightTabs: {
        register: (def: Record<string, unknown>) => {
          tabs.push(def)
          return () => {}
        },
      },
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
      },
      logger: { warn: () => {} },
    }
    expect(() => apply(ctx)).not.toThrow()
    expect(tabs.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(slots.find((call) => call.def.name === 'sidebar.right.pane.tab')?.def.key).toBe(TAB_ID)
  })
})
