/**
 * Host bridge tests:
 *  - click-to-execute through the host command remote (authorization-card path —
 *    the composer is never touched) and the legacy H10 composer-draft fallback;
 *  - panel navigation and the re-proved remote face;
 *  - v0.3 native runtime services: `ctx.jobs` (snapshot/subscribe/watch/observe/
 *    kill) and `ctx.uiWorkspace.openSession` for subagent-session navigation.
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
  /** Simulate a host that does not offer the native `ctx.jobs` service. Defaults to true. */
  jobs?: boolean
  /** Simulate a host without `ctx.uiWorkspace`. Defaults to true (offered). */
  uiWorkspace?: boolean
}

/** Native jobs snapshot fixture, shaped exactly like `ctx.jobs.state.getSnapshot()`. */
function makeJobsSnapshot() {
  return {
    rows: {
      'web-1': [
        {
          id: 'J-1',
          kind: 'bash',
          label: 'pnpm test',
          status: 'running',
          progress: 'running 12s',
          startedAt: 1_700_000_000_000,
          output: { total: 0, earliest: 0 },
        },
        {
          id: 'J-2',
          kind: 'bash',
          label: 'pnpm build',
          status: 'completed',
          detail: 'exit code: 0',
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_010_000,
          output: { total: 12, earliest: 3 },
        },
      ],
    },
    observed: { 'J-1': { text: 'line 1\nline 2\n' } },
  }
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

  // -- native runtime services (v0.3) ---------------------------------------
  const jobSnapshotObject = makeJobsSnapshot()
  const jobListeners: Array<() => void> = []
  const jobWatches: string[] = []
  const jobObserves: Array<[string, string]> = []
  const killCalls: Array<[string, string]> = []
  const openSessionCalls: unknown[] = []
  let jobSnapshotCalls = 0
  let jobUnsubscribeCalls = 0
  let jobWatchReleaseCalls = 0
  let jobObserveReleaseCalls = 0
  let killResult: { ok?: boolean } | undefined = { ok: true }
  let killThrows = false
  let openThrows = false
  let openResult: unknown = undefined
  const jobsService = {
    state: {
      getSnapshot: () => {
        jobSnapshotCalls += 1
        return jobSnapshotObject
      },
      subscribe: (listener: () => void) => {
        jobListeners.push(listener)
        return () => {
          jobUnsubscribeCalls += 1
        }
      },
    },
    watchRows: (sessionId: string) => {
      jobWatches.push(sessionId)
      return () => {
        jobWatchReleaseCalls += 1
      }
    },
    observe: (sessionId: string, jobId: string) => {
      jobObserves.push([sessionId, jobId])
      return () => {
        jobObserveReleaseCalls += 1
      }
    },
    kill: async (sessionId: string, jobId: string) => {
      killCalls.push([sessionId, jobId])
      if (killThrows) throw new Error('kill failed')
      return killResult
    },
  }
  const workspaceService = {
    openSession: (target: unknown) => {
      openSessionCalls.push(target)
      if (openThrows) throw new Error('open failed')
      return openResult
    },
  }
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
      if (deps.includes('jobs')) {
        const result = callback({ jobs: options.jobs === false ? undefined : jobsService })
        return typeof result === 'function' ? result : undefined
      }
      if (deps.includes('uiWorkspace')) {
        const result = callback({ uiWorkspace: options.uiWorkspace === false ? undefined : workspaceService })
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
    // -- native runtime services (v0.3) -------------------------------------
    jobSnapshotObject,
    jobListeners,
    jobWatches,
    jobObserves,
    killCalls,
    openSessionCalls,
    jobSnapshotCalls: () => jobSnapshotCalls,
    jobUnsubscribeCalls: () => jobUnsubscribeCalls,
    jobWatchReleaseCalls: () => jobWatchReleaseCalls,
    jobObserveReleaseCalls: () => jobObserveReleaseCalls,
    notifyJobs: () => {
      for (const listener of [...jobListeners]) listener()
    },
    setKillResult: (result: { ok?: boolean } | undefined) => {
      killResult = result
    },
    setKillThrows: (throws: boolean) => {
      killThrows = throws
    },
    setOpenThrows: (throws: boolean) => {
      openThrows = throws
    },
    setOpenResult: (result: unknown) => {
      openResult = result
    },
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

describe('native background jobs (ctx.jobs)', () => {
  it('reports availability and returns the host snapshot by identity', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(bridge.jobsAvailable()).toBe(true)
    // Stable reference: the native model caches one object per change, which is
    // what React's useSyncExternalStore needs.
    expect(bridge.jobsSnapshot()).toBe(wiring.jobSnapshotObject)
    expect(bridge.jobsSnapshot()).toBe(bridge.jobsSnapshot())
    expect(wiring.jobSnapshotCalls()).toBeGreaterThanOrEqual(3)
    expect(bridge.jobsSnapshot().rows['web-1']?.map((row) => row.id)).toEqual(['J-1', 'J-2'])
    expect(bridge.jobsSnapshot().observed['J-1']?.text).toContain('line 1')
  })

  it('degrades to one stable empty snapshot and false availability without the service', () => {
    const wiring = makeWiring({ jobs: false })
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(bridge.jobsAvailable()).toBe(false)
    const empty = bridge.jobsSnapshot()
    expect(empty).toEqual({ rows: {}, observed: {} })
    expect(bridge.jobsSnapshot()).toBe(empty)
    expect(() => bridge.subscribeJobs(() => {})()).not.toThrow()
    expect(() => bridge.watchJobs('web-1')()).not.toThrow()
    expect(() => bridge.observeJob('web-1', 'J-1')()).not.toThrow()
    expect(wiring.jobWatches).toEqual([])
    expect(wiring.jobObserves).toEqual([])
  })

  it('forwards snapshot subscriptions and their release to the native model', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    let calls = 0
    const release = bridge.subscribeJobs(() => {
      calls += 1
    })
    expect(wiring.jobListeners).toHaveLength(1)
    wiring.notifyJobs()
    expect(calls).toBe(1)
    release()
    // The bridge forwards the native release verbatim (the native unsubscribe
    // and reference-counted stream releases are their own guards).
    expect(wiring.jobUnsubscribeCalls()).toBe(1)
  })

  it('acquires and releases the roster watch for the session id', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    const release = bridge.watchJobs('web-1')
    expect(wiring.jobWatches).toEqual(['web-1'])
    release()
    expect(wiring.jobWatchReleaseCalls()).toBe(1)
    // Empty ids never reach the host: they yield a noop release.
    const noop = bridge.watchJobs('')
    expect(wiring.jobWatches).toEqual(['web-1'])
    expect(() => noop()).not.toThrow()
  })

  it('acquires and releases live output observation for one job', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    const release = bridge.observeJob('web-1', 'J-2')
    expect(wiring.jobObserves).toEqual([['web-1', 'J-2']])
    release()
    expect(wiring.jobObserveReleaseCalls()).toBe(1)
    expect(() => bridge.observeJob('web-1', '')()).not.toThrow()
    expect(wiring.jobObserves).toEqual([['web-1', 'J-2']])
  })

  it('kills a job through the host and resolves true only on the ok envelope', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()

    expect(await bridge.killJob('web-1', 'J-1')).toBe(true)
    expect(wiring.killCalls).toEqual([['web-1', 'J-1']])

    wiring.setKillResult({ ok: false })
    expect(await bridge.killJob('web-1', 'J-1')).toBe(false)

    wiring.setKillResult(undefined)
    expect(await bridge.killJob('web-1', 'J-1')).toBe(false)

    wiring.setKillResult({ ok: true })
    wiring.setKillThrows(true)
    expect(await bridge.killJob('web-1', 'J-1')).toBe(false)

    // Empty ids are refused before reaching the host.
    expect(await bridge.killJob('', 'J-1')).toBe(false)
    expect(await bridge.killJob('web-1', '')).toBe(false)
    expect(wiring.killCalls).toHaveLength(4)
  })

  it('cannot kill when the jobs service is missing', async () => {
    const wiring = makeWiring({ jobs: false })
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(await bridge.killJob('web-1', 'J-1')).toBe(false)
    expect(wiring.killCalls).toEqual([])
  })

  it('clears the native service references after dispose', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    const dispose = bridge.wire()
    expect(bridge.jobsAvailable()).toBe(true)
    expect(bridge.jobsSnapshot()).toBe(wiring.jobSnapshotObject)
    dispose()
    expect(bridge.jobsAvailable()).toBe(false)
    expect(bridge.jobsSnapshot()).toEqual({ rows: {}, observed: {} })
    expect(await bridge.killJob('web-1', 'J-1')).toBe(false)
    // Watches acquired after dispose never reach the host.
    expect(() => bridge.watchJobs('web-1')()).not.toThrow()
    expect(wiring.jobWatches).toEqual([])
  })

  it('tolerates a hostile jobs service without throwing', () => {
    const ctx: ClientContext = {
      inject: (deps: string[], callback: (c: ClientContext) => unknown) => {
        if (deps.includes('jobs')) {
          callback({
            jobs: {
              get state(): {
                getSnapshot: () => unknown
                subscribe: (listener: () => void) => () => void
              } {
                throw new Error('hostile jobs state')
              },
            },
          })
        }
        return () => {}
      },
    }
    const bridge = createHostBridge(ctx)
    bridge.wire()
    expect(bridge.jobsAvailable()).toBe(false)
    expect(bridge.jobsSnapshot()).toEqual({ rows: {}, observed: {} })
    expect(() => bridge.subscribeJobs(() => {})()).not.toThrow()
  })
})

describe('native subagent session navigation (ctx.uiWorkspace)', () => {
  it('opens the child session with the Agent Team continuable target', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(bridge.openSubagentSession('web-lead', 'web-child')).toBe(true)
    expect(wiring.openSessionCalls).toEqual([
      { parentSessionId: 'web-lead', childSessionId: 'web-child', mode: 'continuable' },
    ])
  })

  it('reports dispatch for an async navigation face without leaking a rejection', async () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    wiring.setOpenResult(Promise.reject(new Error('navigation failed')))
    expect(bridge.openSubagentSession('web-lead', 'web-child')).toBe(true)
    // Let the swallowed rejection settle; an unhandled rejection would fail this test run.
    await Promise.resolve()
    await Promise.resolve()
  })

  it('degrades when the workspace service is missing, throws or gets empty ids', () => {
    const missing = makeWiring({ uiWorkspace: false })
    const missingBridge = createHostBridge(missing.ctx)
    missingBridge.wire()
    expect(missingBridge.openSubagentSession('web-lead', 'web-child')).toBe(false)

    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    bridge.wire()
    expect(bridge.openSubagentSession('', 'web-child')).toBe(false)
    expect(bridge.openSubagentSession('web-lead', '')).toBe(false)
    expect(wiring.openSessionCalls).toEqual([])

    wiring.setOpenThrows(true)
    expect(bridge.openSubagentSession('web-lead', 'web-child')).toBe(false)
    expect(wiring.openSessionCalls).toHaveLength(1)
  })

  it('clears the workspace reference after dispose', () => {
    const wiring = makeWiring()
    const bridge = createHostBridge(wiring.ctx)
    const dispose = bridge.wire()
    expect(bridge.openSubagentSession('web-lead', 'web-child')).toBe(true)
    dispose()
    expect(bridge.openSubagentSession('web-lead', 'web-child')).toBe(false)
    expect(wiring.openSessionCalls).toHaveLength(1)
  })
})

// The slot prop type is exercised through sessionIdOf above.
const _typecheck: SlotPropRecord = { sessionId: 'x' }
void _typecheck
