/**
 * Host bridge tests: click-to-execute through the host command remote (the
 * authorization-card path — the composer is never touched), the legacy H10
 * composer-draft degradation, panel navigation and the re-proved remote face.
 */
import { describe, expect, it } from 'vitest'
import { createHostBridge, sessionIdOf } from '../../src/client/bridge'
import type { ClientContext, SlotPropRecord } from '../../src/client/types'
import { TAB_KIND } from '../../src/client/types'

interface CommandCall {
  agentId: string
  line: string
  attachments: readonly unknown[]
}

interface WiringOptions {
  /** Simulate a host that does not offer `remote.commands`. Defaults to true (offered). */
  commands?: boolean
  /** Simulate a host without `sessions.binding(id).session.command`. Defaults to true. */
  sessionCommand?: boolean
}

function makeWiring(options: WiringOptions = {}) {
  const drafts: string[] = []
  const opened: string[] = []
  const executed: CommandCall[] = []
  const sessionCommands: string[] = []
  let commandResult: { ok?: boolean } | undefined = { ok: true }
  let commandThrows = false
  let sessionResult: { ok?: boolean } | undefined = { ok: true }
  let sessionThrows = false
  let stateCalls = 0
  let disposeCalls = 0
  const bindingCtx = { id: 'binding-1' }
  const sessionFace =
    options.sessionCommand === false
      ? undefined
      : {
          command: async (line: string) => {
            sessionCommands.push(line)
            if (sessionThrows) throw new Error('session command crashed')
            return sessionResult
          },
        }
  const ctx: ClientContext = {
    inject: (deps: string[], callback: (c: ClientContext) => unknown) => {
      if (deps.includes('remote.commands')) {
        if (options.commands === false) {
          const result = callback({ remote: {} as unknown as ClientContext['remote'] })
          return typeof result === 'function' ? result : undefined
        }
        const result = callback({
          remote: {
            commands: {
              execute: async (agentId: string, line: string, attachments: readonly unknown[]) => {
                executed.push({ agentId, line, attachments })
                if (commandThrows) throw new Error('command remote crashed')
                return commandResult
              },
            },
          } as unknown as ClientContext['remote'],
        })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('sessions')) {
        const result = callback({
          sessions: {
            binding: (sessionId: string) =>
              sessionId === 'web-1'
                ? { ctx: bindingCtx, ...(sessionFace !== undefined ? { session: sessionFace } : {}) }
                : undefined,
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
  return {
    ctx,
    drafts,
    opened,
    executed,
    sessionCommands,
    bindingCtx,
    setCommandResult: (result: { ok?: boolean } | undefined) => {
      commandResult = result
    },
    setCommandThrows: (throws: boolean) => {
      commandThrows = throws
    },
    setSessionResult: (result: { ok?: boolean } | undefined) => {
      sessionResult = result
    },
    setSessionThrows: (throws: boolean) => {
      sessionThrows = throws
    },
    getStateCalls: () => stateCalls,
    getDisposeCalls: () => disposeCalls,
  }
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

describe('runCommand (click-to-execute authorization path)', () => {
  it('layer 1: submits the /flow line through ctx.remote.commands.execute without touching the composer', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(true)
    expect(wiring.executed).toEqual([{ agentId: 'web-1', line: '/flow approve G3', attachments: [] }])
    // The command namespace wins; the session fallback is not used.
    expect(wiring.sessionCommands).toEqual([])
    // Click-to-execute never writes into the input box.
    expect(wiring.drafts).toEqual([])
  })

  it('layer 2: falls back to sessions.binding(id).session.command when remote.commands is missing', async () => {
    const wiring = makeWiring({ commands: false })
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(true)
    expect(wiring.executed).toEqual([])
    expect(wiring.sessionCommands).toEqual(['/flow approve G3'])
    // The fallback keeps the same click-to-execute contract: composer stays empty.
    expect(wiring.drafts).toEqual([])
  })

  it('layer 2: falls back to the session face when the commands namespace rejects or throws', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()

    wiring.setCommandResult({ ok: false })
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(true)

    wiring.setCommandThrows(true)
    expect(await bridge.runCommand('/flow repair', 'web-1')).toBe(true)

    expect(wiring.executed.map((call) => call.line)).toEqual(['/flow approve G3', '/flow repair'])
    expect(wiring.sessionCommands).toEqual(['/flow approve G3', '/flow repair'])
    expect(wiring.drafts).toEqual([])
  })

  it('returns false when neither command path is available', async () => {
    const wiring = makeWiring({ commands: false, sessionCommand: false })
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(false)
    expect(wiring.executed).toEqual([])
    expect(wiring.sessionCommands).toEqual([])
    // The legacy composer path is unaffected; it is simply a separate port.
    expect(await bridge.fillCommand('/flow approve G3', 'web-1')).toBe(true)
  })

  it('returns false for unwired bridges, empty commands and missing session ids', async () => {
    const unwired = createHostBridge({})
    expect(await unwired.runCommand('/flow approve G3', 'web-1')).toBe(false)

    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.runCommand('', 'web-1')).toBe(false)
    expect(await bridge.runCommand('/flow approve G3', undefined)).toBe(false)
    expect(await bridge.runCommand('/flow approve G3', '')).toBe(false)
    expect(wiring.executed).toEqual([])
    expect(wiring.sessionCommands).toEqual([])
  })

  it('returns false when both layers fail (rejected / empty / thrown results)', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()

    // Layer 1 empty result and layer 2 rejected.
    wiring.setCommandResult(undefined)
    wiring.setSessionResult({ ok: false })
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(false)

    // Layer 1 null result and layer 2 empty result.
    wiring.setCommandResult(null as unknown as { ok?: boolean } | undefined)
    wiring.setSessionResult(undefined)
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(false)

    // Layer 1 throws and layer 2 throws.
    wiring.setCommandThrows(true)
    wiring.setSessionThrows(true)
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(false)
    expect(wiring.drafts).toEqual([])
  })

  it('stops executing commands after the bridge is disposed', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    const dispose = bridge.wire()
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(true)
    dispose()
    expect(await bridge.runCommand('/flow approve G3', 'web-1')).toBe(false)
    expect(wiring.executed).toHaveLength(1)
  })
})

// The slot prop type is exercised through sessionIdOf above.
const _typecheck: SlotPropRecord = { sessionId: 'x' }
void _typecheck
