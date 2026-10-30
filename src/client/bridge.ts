/**
 * Host bridge: the one place where the browser bundle reaches DSH client
 * services. Every access is structurally proved and optional — a missing
 * service degrades to the command fallback instead of throwing.
 *
 * Services used (all obtained through deferred `ctx.inject`, never imported):
 *  - `remote` + `remote.flowgate`  → panel actions / cross-session state
 *  - `sidebarRight`               → open the panel tab
 *  - `sidebarRightTabs`           → fallback navigation by tab id
 *  - `sessions` + `conversation`  → write `/flow ...` into the composer draft
 *
 * Draft filling follows the same path the official composer uses
 * (`ctx.conversation.input.for(binding.ctx).setDraft(text)`); the shape is
 * re-proved at call time and the action falls back to copying the command.
 */
import type {
  ClientContext,
  Disposer,
  FlowgateRemote,
  SidebarRightService,
  SidebarRightTabsService,
  SlotPropRecord,
} from './types'
import { REMOTE_ID, TAB_ID, TAB_KIND } from './types'

interface SessionBindingLike {
  ctx?: unknown
}

interface SessionsServiceLike {
  binding?: (sessionId: string) => SessionBindingLike | undefined
}

interface InputFaceLike {
  setDraft?: (text: string) => void
  /** Move the keyboard back to the composer (rc.5 SessionInput.focus). */
  focus?: () => void
}

interface ConversationServiceLike {
  input?: { for?: (bindingCtx: unknown) => InputFaceLike | undefined }
}

export interface HostBridge {
  /** Current remote face (re-proved each use). */
  remote: () => FlowgateRemote | undefined
  /** Read the projection through the remote (fallback when the tab has none). */
  readState: () => Promise<unknown>
  /** Open the FlowGate sidebar tab; false when the host offers no navigation. */
  openPanel: () => boolean
  /** Put a command into the composer draft for this session. */
  fillCommand: (command: string, sessionId?: string) => Promise<boolean>
  /** Clipboard fallback (browser only; resolves false during SSR). */
  copyText: (text: string) => Promise<boolean>
  /** Wire the deferred service injections. Returns a disposer. */
  wire: () => Disposer
}

export function sessionIdOf(props: SlotPropRecord | undefined): string | undefined {
  if (props === undefined) return undefined
  const direct = props.sessionId
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = props.session
  if (nested !== null && typeof nested === 'object') {
    const id = (nested as { sessionId?: unknown }).sessionId
    if (typeof id === 'string' && id !== '') return id
  }
  return undefined
}

function safeRead<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export function createHostBridge(ctx: ClientContext): HostBridge {
  let remoteFace: FlowgateRemote | undefined
  let sidebarRight: SidebarRightService | undefined
  let sidebarTabs: SidebarRightTabsService | undefined
  let sessions: SessionsServiceLike | undefined
  let conversation: ConversationServiceLike | undefined

  const remote = (): FlowgateRemote | undefined => {
    const face = remoteFace
    if (face === undefined) return undefined
    if (typeof face === 'object' && face !== null) return face
    return undefined
  }

  const openPanel = (): boolean => {
    const right = sidebarRight
    if (right !== undefined) {
      try {
        if (typeof right.openTab === 'function') {
          right.openTab(TAB_KIND)
          return true
        }
      } catch {
        /* fall through */
      }
      try {
        if (typeof right.openTab === 'function') {
          right.openTab(TAB_ID)
          return true
        }
      } catch {
        /* fall through */
      }
    }
    const tabs = sidebarTabs
    if (tabs !== undefined && typeof tabs.open === 'function') {
      try {
        tabs.open(TAB_ID)
        return true
      } catch {
        return false
      }
    }
    return false
  }

  const readState = async (): Promise<unknown> => {
    try {
      const face = remote()
      if (face === undefined || typeof face.state !== 'function') return undefined
      return await face.state()
    } catch {
      return undefined
    }
  }

  const fillCommand = async (command: string, sessionId?: string): Promise<boolean> => {
    if (command === '') return false
    const hostSessions = sessions
    const hostConversation = conversation
    if (hostSessions === undefined || hostConversation === undefined) return false
    const id = sessionId
    if (id === undefined || id === '') return false
    const binding = safeRead(() => hostSessions.binding?.(id))
    const bindingCtx = binding?.ctx
    if (bindingCtx === undefined) return false
    const face = safeRead(() => hostConversation.input?.for?.(bindingCtx))
    if (face === undefined || typeof face.setDraft !== 'function') return false
    try {
      face.setDraft(command)
      try {
        face.focus?.()
      } catch {
        /* focus is best-effort */
      }
      return true
    } catch {
      return false
    }
  }

  const copyText = async (text: string): Promise<boolean> => {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return false
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  const wire = (): Disposer => {
    const disposers: Disposer[] = []
    const inject = ctx.inject
    if (typeof inject !== 'function') return () => {}
    const own = (result: unknown): void => {
      if (typeof result === 'function') disposers.push(result as Disposer)
    }
    // Remote face: the traced `remote` proxy resolves `remote.<id>` only in a
    // fiber that declares both names (same idiom as ui-chat / dsh-context).
    own(
      inject(['remote', `remote.${REMOTE_ID}`], (c: ClientContext) => {
        try {
          const table = c.remote
          const face = table !== undefined ? table[REMOTE_ID] : undefined
          remoteFace = (face !== null && typeof face === 'object' ? face : undefined) as FlowgateRemote | undefined
        } catch {
          remoteFace = undefined
        }
        return () => {
          remoteFace = undefined
        }
      }),
    )
    own(
      inject(['sidebarRight'], (c: ClientContext) => {
        sidebarRight = c.sidebarRight
        return () => {
          sidebarRight = undefined
        }
      }),
    )
    own(
      inject(['sidebarRightTabs'], (c: ClientContext) => {
        sidebarTabs = c.sidebarRightTabs
        return () => {
          sidebarTabs = undefined
        }
      }),
    )
    own(
      inject(['sessions', 'conversation'], (c: ClientContext) => {
        sessions = c.sessions as SessionsServiceLike | undefined
        conversation = c.conversation as ConversationServiceLike | undefined
        return () => {
          sessions = undefined
          conversation = undefined
        }
      }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* bridge cleanup must never throw */
        }
      }
    }
  }

  return { remote, readState, openPanel, fillCommand, copyText, wire }
}
