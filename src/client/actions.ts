/**
 * Panel button actions → host calls, with the mandatory command fallback
 * (H10 degradation path; docs/impl/host-client-contract.md §2).
 *
 * Rules:
 *  - Human actions are only reachable through buttons or `/flow` commands; no
 *    agent tool maps to them.
 *  - Preferred path: `remote.flowgate.action(payload)`.
 *  - Fallback: write the equivalent `/flow ...` command into the composer
 *    draft (and focus it), so the owner can press Enter. If the composer is
 *    unavailable, copy the command instead.
 *
 * Everything here is pure enough for SSR tests: no DOM is touched unless an
 * event handler actually runs.
 */
import type { FlowgateAction, FlowgateRemote, ActionEnvelope } from './types'
import type { LearningMode } from './types'
import type { TFn } from './i18n'

export type ClientAction =
  | { kind: 'approve'; gate: string }
  | { kind: 'reject'; gate: string; reason: string }
  | { kind: 'approve-pending'; id: string; reason?: string }
  | { kind: 'reject-pending'; id: string; reason: string }
  /** `kind: 'blocker'` pending item: clear the consecutive-failure circuit breaker. */
  | { kind: 'unblock'; id: string; reason?: string }
  | { kind: 'allow-once'; ruleId: string; reason: string }
  | { kind: 'add-exception'; ruleId: string; pathPattern?: string; reason: string }
  | { kind: 'revoke-exception'; id: string; reason?: string }
  | { kind: 'raise-complexity'; reason?: string }
  | { kind: 'resume'; changeId: string; takeover?: boolean }
  | { kind: 'pause'; changeId?: string }
  | { kind: 'report' }
  | { kind: 'board' }
  | { kind: 'metrics-export' }
  | { kind: 'learn'; mode: LearningMode }
  | { kind: 'open-panel' }
  | { kind: 'copy-evidence'; text: string }

export interface ActionPorts {
  t: TFn
  /** Host remote face, when the gateway provides it. */
  remote?: FlowgateRemote
  /** Write the command into the composer draft; return true when it worked. */
  fillCommand?: (command: string) => boolean | Promise<boolean>
  /** Clipboard fallback; return true when copied. */
  copyText?: (text: string) => boolean | Promise<boolean>
  /** Open the right sidebar panel locally. */
  openPanel?: () => boolean
}

export interface ActionOutcome {
  ok: boolean
  /** True when the command fallback was used instead of the remote. */
  fallback: boolean
  message: string
  command?: string
  /** True when the action requires a reason that was missing. */
  needsReason?: boolean
}

const FAMILY_BY_PREFIX: Record<string, string> = {
  RK: 'risk',
  SC: 'scope',
  PC: 'plan',
  RL: 'rule',
  OV: 'override',
  EX: 'exception',
  CF: 'conflict',
  BL: 'blocker',
}

/** Command family for a pending item id (`RK-1` → `risk`). */
export function pendingFamily(id: string): string | null {
  const prefix = id.split('-')[0]?.toUpperCase() ?? ''
  return FAMILY_BY_PREFIX[prefix] ?? null
}

/** Append a trimmed, optional reason to a command (empty → command unchanged). */
function withReason(command: string, reason: string | undefined): string {
  const trimmed = reason?.trim() ?? ''
  return trimmed === '' ? command : `${command} ${trimmed}`
}

/** Human-facing command for an action; empty string when there is none. */
export function commandFor(action: ClientAction): string {
  switch (action.kind) {
    case 'approve':
      return `/flow approve ${action.gate}`
    case 'reject':
      return `/flow reject ${action.reason.trim()}`
    case 'approve-pending': {
      const family = pendingFamily(action.id)
      // `kind: 'blocker'` items are not decided through `/flow blocker …`: the
      // documented entry is `/flow unblock <BL-n> [理由]` (engine decides the
      // item as approved and clears the failure count). Map defensively so a
      // stale caller still produces a runnable command.
      if (family === 'blocker') return withReason(`/flow unblock ${action.id}`, action.reason)
      return family !== null
        ? withReason(`/flow ${family} approve ${action.id}`, action.reason)
        : `/flow approve ${action.id}`
    }
    case 'reject-pending': {
      const family = pendingFamily(action.id)
      if (family === 'blocker') {
        // No human command rejects a circuit breaker: the only decision is
        // "clear it". Returning '' makes performAction report invalid instead
        // of filling an unrunnable `/flow blocker reject …` command.
        return ''
      }
      return family !== null
        ? `/flow ${family} reject ${action.id} ${action.reason.trim()}`
        : `/flow reject ${action.reason.trim()}`
    }
    case 'unblock':
      return withReason(`/flow unblock ${action.id}`, action.reason)
    case 'allow-once':
      return `/flow allow-once ${action.ruleId} ${action.reason.trim()}`
    case 'add-exception':
      // No dedicated documented command; allow-once is the safe equivalent for one action.
      return `/flow allow-once ${action.ruleId} ${action.reason.trim()}`
    case 'revoke-exception':
      return `/flow exception revoke ${action.id}`
    case 'raise-complexity':
      return `/flow complexity high ${action.reason?.trim() ?? ''}`.trim()
    case 'resume':
      return `/flow resume ${action.changeId}${action.takeover === true ? ' --takeover' : ''}`
    case 'pause':
      return '/flow pause'
    case 'report':
      return '/flow report'
    case 'board':
      return '/flow board'
    case 'metrics-export':
      return '/flow metrics --csv'
    case 'learn':
      return `/flow learn ${action.mode}`
    case 'open-panel':
    case 'copy-evidence':
      return ''
  }
}

/** Actions that require a written reason (recorded in the ledger). */
export function needsReason(action: ClientAction): boolean {
  switch (action.kind) {
    case 'reject':
    case 'reject-pending':
    case 'allow-once':
    case 'add-exception':
      return true
    default:
      return false
  }
}

/** Map a UI action to the host remote payload from the contract. */
export function toRemotePayload(action: ClientAction): FlowgateAction | null {
  switch (action.kind) {
    case 'approve':
      return { type: 'approve', gate: action.gate }
    case 'reject':
      return { type: 'reject', gate: action.gate, reason: action.reason.trim() }
    case 'approve-pending':
      return action.reason !== undefined && action.reason.trim() !== ''
        ? { type: 'approve-pending', id: action.id, reason: action.reason.trim() }
        : { type: 'approve-pending', id: action.id }
    case 'reject-pending':
      return { type: 'reject-pending', id: action.id, reason: action.reason.trim() }
    case 'unblock':
      // The rc.5 client contract has no separate `unblock` payload and the host
      // remote is not implemented in-tree; approving a blocker pending item is
      // exactly the engine's unblock transition, so reuse `approve-pending`.
      return action.reason !== undefined && action.reason.trim() !== ''
        ? { type: 'approve-pending', id: action.id, reason: action.reason.trim() }
        : { type: 'approve-pending', id: action.id }
    case 'allow-once':
      return { type: 'allow-once', ruleId: action.ruleId, reason: action.reason.trim() }
    case 'add-exception':
      return action.pathPattern !== undefined && action.pathPattern.trim() !== ''
        ? { type: 'add-exception', ruleId: action.ruleId, pathPattern: action.pathPattern.trim(), reason: action.reason.trim() }
        : { type: 'add-exception', ruleId: action.ruleId, reason: action.reason.trim() }
    case 'revoke-exception':
      return action.reason !== undefined && action.reason.trim() !== ''
        ? { type: 'revoke-exception', id: action.id, reason: action.reason.trim() }
        : { type: 'revoke-exception', id: action.id }
    case 'raise-complexity':
      return { type: 'complexity', level: 'high', reason: action.reason?.trim() }
    case 'resume':
      return action.takeover === true
        ? { type: 'resume', changeId: action.changeId, takeover: true }
        : { type: 'resume', changeId: action.changeId }
    case 'pause':
      return { type: 'pause' }
    case 'report':
      return { type: 'generate-report' }
    case 'board':
      return { type: 'open-board' }
    case 'metrics-export':
      return { type: 'metrics-export' }
    default:
      return null
  }
}

/** Unwrap the gateway envelope `{ok, message, value?}`; also accepts plain values. */
export function unwrapEnvelope(raw: unknown): { ok: boolean; message: string; value?: unknown } {
  if (raw !== null && typeof raw === 'object' && 'ok' in raw) {
    const envelope = raw as ActionEnvelope
    return {
      ok: envelope.ok === true,
      message: typeof envelope.message === 'string' ? envelope.message : '',
      value: envelope.value,
    }
  }
  if (typeof raw === 'string') return { ok: true, message: raw }
  return { ok: true, message: '' }
}

async function tryRemote(ports: ActionPorts, action: ClientAction): Promise<{ ok: boolean; message: string } | null> {
  const remote = ports.remote
  if (remote === undefined || typeof remote.action !== 'function') return null
  const payload = toRemotePayload(action)
  if (payload === null) return null
  try {
    const raw = await remote.action(payload)
    const envelope = unwrapEnvelope(raw)
    return { ok: envelope.ok, message: envelope.message }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute one panel action. Always resolves (never throws) so a click can never
 * take the panel down.
 */
export async function performAction(action: ClientAction, ports: ActionPorts): Promise<ActionOutcome> {
  const t = ports.t

  if (action.kind === 'copy-evidence') {
    const copied = await safeCopy(ports, action.text)
    return {
      ok: copied,
      fallback: true,
      message: copied ? t('intercepts.evidenceCopied') : t('actions.clipboardFailed', { cmd: action.text }),
    }
  }

  if (action.kind === 'open-panel') {
    const opened = ports.openPanel !== undefined ? safeCall(ports.openPanel) : false
    return { ok: opened, fallback: false, message: opened ? t('actions.done') : t('actions.openPanel') }
  }

  const reasonValue = 'reason' in action && typeof action.reason === 'string' ? action.reason : ''
  if (needsReason(action) && reasonValue.trim() === '') {
    return { ok: false, fallback: false, message: t('actions.noReason'), needsReason: true }
  }

  const remoteResult = await tryRemote(ports, action)
  if (remoteResult !== null && remoteResult.ok) {
    const detail = remoteResult.message !== '' ? remoteResult.message : t('actions.done')
    return { ok: true, fallback: false, message: t('actions.remoteOk', { msg: detail }) }
  }

  const command = commandFor(action)
  if (command === '') {
    return {
      ok: false,
      fallback: false,
      message: t('actions.invalidAction', { kind: action.kind }),
    }
  }

  // Fallback (H10): composer draft first, then clipboard.
  if (ports.fillCommand !== undefined) {
    const filled = await safeAsyncCall(() => ports.fillCommand?.(command))
    if (filled) {
      return { ok: true, fallback: true, message: t('actions.fillCommand', { cmd: command }), command }
    }
  }
  const copied = await safeCopy(ports, command)
  if (copied) {
    return { ok: true, fallback: true, message: t('actions.copyCommand', { cmd: command }), command }
  }
  return { ok: false, fallback: true, message: t('actions.clipboardFailed', { cmd: command }), command }
}

function safeCall(fn: () => boolean): boolean {
  try {
    return fn() === true
  } catch {
    return false
  }
}

async function safeAsyncCall(fn: () => boolean | Promise<boolean> | undefined): Promise<boolean> {
  try {
    const result = await fn()
    return result === true
  } catch {
    return false
  }
}

async function safeCopy(ports: ActionPorts, text: string): Promise<boolean> {
  if (ports.copyText === undefined) return false
  try {
    return (await ports.copyText(text)) === true
  } catch {
    return false
  }
}
