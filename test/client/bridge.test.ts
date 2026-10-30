/**
 * Host bridge tests: the mandatory H10 fallback path (composer draft), panel
 * navigation and the re-proved remote face.
 */
import { describe, expect, it } from 'vitest'
import { createHostBridge, sessionIdOf } from '../../src/client/bridge'
import type { ClientContext, SlotPropRecord } from '../../src/client/types'
import { TAB_KIND } from '../../src/client/types'

function makeWiring() {
  const drafts: string[] = []
  const opened: string[] = []
  let stateCalls = 0
  let disposeCalls = 0
  const bindingCtx = { id: 'binding-1' }
  const ctx: ClientContext = {
    inject: (deps: string[], callback: (c: ClientContext) => unknown) => {
      if (deps.includes('sessions')) {
        const result = callback({
          sessions: {
            binding: (sessionId: string) => (sessionId === 'web-1' ? { ctx: bindingCtx } : undefined),
          },
          conversation: {
            input: {
              for: (target: unknown) =>
                target === bindingCtx
                  ? {
                      setDraft: (text: string) => {
                        drafts.push(text)
                      },
                    }
                  : undefined,
            },
          },
        })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('sidebarRight')) {
        const result = callback({
          sidebarRight: {
            openTab: (kind: string) => {
              opened.push(kind)
            },
          },
        })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('remote')) {
        const result = callback({
          remote: {
            flowgate: {
              state: async () => {
                stateCalls += 1
                return { snapshot: { initialized: true } }
              },
              action: async () => ({ ok: true, message: 'ok' }) as unknown,
            },
          },
        })
        return typeof result === 'function' ? result : undefined
      }
      return () => {
        disposeCalls += 1
      }
    },
  }
  return { ctx, drafts, opened, bindingCtx, getStateCalls: () => stateCalls, getDisposeCalls: () => disposeCalls }
}

describe('sessionIdOf', () => {
  it('reads direct and nested session ids, tolerating junk', () => {
    expect(sessionIdOf({ sessionId: 'web-1' })).toBe('web-1')
    expect(sessionIdOf({ session: { sessionId: 'web-2' } })).toBe('web-2')
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf(undefined)).toBeUndefined()
    expect(sessionIdOf({ session: { sessionId: 42 } } as unknown as SlotPropRecord)).toBeUndefined()
  })
})

describe('HostBridge', () => {
  it('fills the composer draft through sessions.binding + conversation.input', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    const filled = await bridge.fillCommand('/flow approve G1', 'web-1')
    expect(filled).toBe(true)
    expect(wiring.drafts).toEqual(['/flow approve G1'])
  })

  it('returns false when the session or composer is unavailable', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.fillCommand('/flow', 'unknown-session')).toBe(false)
    expect(await bridge.fillCommand('', 'web-1')).toBe(false)
    const unwired = createHostBridge({})
    expect(await unwired.fillCommand('/flow', 'web-1')).toBe(false)
  })

  it('opens the panel through sidebarRight.openTab with the panel kind', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(bridge.openPanel()).toBe(true)
    expect(wiring.opened).toEqual([TAB_KIND])
  })

  it('reports no panel navigation on a host without sidebarRight', () => {
    const bridge = createHostBridge({})
    expect(bridge.openPanel()).toBe(false)
  })

  it('reads the projection through remote.flowgate.state', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.readState()).toEqual({ snapshot: { initialized: true } })
    expect(wiring.getStateCalls()).toBe(1)
  })

  it('degrades to undefined when no remote is available', async () => {
    const bridge = createHostBridge({})
    expect(await bridge.readState()).toBeUndefined()
    expect(bridge.remote()).toBeUndefined()
  })

  it('cannot use the clipboard outside a browser (SSR safety)', async () => {
    const bridge = createHostBridge({})
    expect(await bridge.copyText('x')).toBe(false)
  })

  it('wiring cleans up silently', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    const dispose = bridge.wire()
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })

  it('tolerates a hostile remote face without throwing', async () => {
    const ctx: ClientContext = {
      inject: (deps: string[], callback: (c: ClientContext) => unknown) => {
        if (deps.includes('remote')) {
          callback({
            remote: {
              flowgate: {
                get state(): () => Promise<unknown> {
                  throw new Error('hostile')
                },
              },
            } as unknown as ClientContext['remote'],
          })
        }
        return () => {}
      },
    }
    const bridge = createHostBridge(ctx)
    bridge.wire()
    expect(await bridge.readState()).toBeUndefined()
  })
})

// The slot prop type is exercised through sessionIdOf above.
const _typecheck: SlotPropRecord = { sessionId: 'x' }
void _typecheck
