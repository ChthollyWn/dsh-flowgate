/**
 * Input-area dock (contract §2): seven-stage animated rail + graphic state +
 * next-step chip + authorization card.
 *
 * This replaces the old one-line status bar. The dock is the primary place the
 * owner authorizes a step: gate approvals, pending decisions, non-agent change
 * confirmations and the enable/repair/reconnect cards are all clickable — the
 * click is the authorization (sent through `performAction` → `executeCommand` →
 * `bridge.runCommand`), so the composer is never filled with a command.
 *
 * `DockView` is the pure/SSR-testable surface (its only hook is the inline
 * reject-reason form state); `StatusBar` is the slot container that reads the
 * session projection, performs actions and opens the panel.
 *
 * DOM anchors (contract §1.2): data-flowgate="flow-dock" / "flow-rail" /
 * "rail-node" / "dock-next" / "auth-card" / data-action="auth-*".
 */
import React from 'react'
import type { TFn } from '../i18n'
import type { FlowgateProjection, SlotPropRecord } from '../types'
import type { HostBridge } from '../bridge'
import { sessionIdOf } from '../bridge'
import type {
  AuthActionKind,
  AuthActionModel,
  AuthCardModel,
  AuthStripTone,
  DockModel,
  DockNextKind,
} from '../model'
import { buildDockModel, normalizeProjection, readProjection } from '../model'
import type { ActionPorts, ClientAction } from '../actions'
import { performAction } from '../actions'
import { FlowRail } from '../visual/FlowRail'
import { ArrowIcon, LockIcon, PanelIcon, ShieldIcon, SparkIcon } from '../visual/icons'

/** One button press sent up to the container (mapped back to a ClientAction). */
export interface DockActionRequest {
  kind: AuthActionKind
  dataAction: string
  /** Filled for reject/reject-pending (inline reason form). */
  reason?: string
}

export interface DockViewProps {
  model: DockModel
  t: TFn
  onAction?: (request: DockActionRequest) => void
  /** Open the right sidebar panel (rail click / “详情” / open-panel button). */
  onOpen?: () => void
  /** A host action is in flight: buttons are disabled. */
  busy?: boolean
  notice?: string
}

const STRIP_DOT: Record<AuthStripTone, string> = {
  warn: 'fg-state-dot--warning',
  error: 'fg-state-dot--error',
  business: 'fg-state-dot--business',
  neutral: '',
}

function stripClass(tone: AuthStripTone): string {
  switch (tone) {
    case 'error':
      return 'fg-plan-strip fg-plan-strip--error'
    case 'business':
      return 'fg-plan-strip fg-plan-strip--business'
    case 'neutral':
      return 'fg-plan-strip fg-plan-strip--neutral'
    case 'warn':
    default:
      return 'fg-plan-strip'
  }
}

/** Native primitive Button variants (primary / outline / ghost). */
function buttonClass(action: AuthActionModel): string {
  const base = 'fg-native-btn'
  if (action.tone === 'primary') return `${base} fg-native-btn-primary`
  if (action.kind === 'open-panel') return `${base} fg-native-btn-ghost`
  return action.tone === 'danger'
    ? `${base} fg-native-btn-outline fg-native-btn-danger`
    : `${base} fg-native-btn-outline`
}

function NextIcon({ kind, color }: { kind: DockNextKind; color: string }): React.ReactElement {
  switch (kind) {
    case 'action':
      return <ShieldIcon size={12} color={color} />
    case 'auto':
      return <SparkIcon size={12} color={color} />
    case 'wait':
      return <LockIcon size={12} color={color} />
    case 'question':
    default:
      return <SparkIcon size={12} color={color} />
  }
}

interface AuthCardViewProps {
  card: AuthCardModel
  t: TFn
  busy: boolean
  editing: boolean
  reason: string
  onStartReject: () => void
  onReason: (value: string) => void
  onCancel: () => void
  onSubmitReject: () => void
  onEmit: (kind: AuthActionKind) => void
}

/**
 * Native plan-card layout (PlanReviewPanel): strip → body → footer.
 * The strip carries state; the body is title / description / inline meta and
 * check dots; the footer holds feedback text and native buttons.
 */
function AuthCardView(props: AuthCardViewProps): React.ReactElement {
  const { card, t, busy, editing, reason, onStartReject, onReason, onCancel, onSubmitReject, onEmit } = props
  const failure = editing && reason.trim() === ''
  return (
    <div
      data-flowgate="auth-card"
      data-kind={card.kind}
      data-tone={card.stripTone}
      data-gate={card.gate}
      className="fg-plan-card fg-rise fg-sweep"
    >
      <div data-flowgate="auth-strip" className={stripClass(card.stripTone)}>
        <span className={`fg-state-dot ${STRIP_DOT[card.stripTone]}`} aria-hidden="true" />
        <span data-flowgate="auth-strip-text" className="fg-plan-strip-text">
          {card.strip}
        </span>
        <span className="fg-plan-strip-spacer" />
        {card.gate !== undefined ? (
          <span data-flowgate="auth-gate" className="fg-plan-strip-meta">
            {card.gate}
          </span>
        ) : null}
        {card.extraCount > 0 ? (
          <span data-flowgate="auth-more" className="fg-plan-strip-meta">
            +{card.extraCount}
          </span>
        ) : null}
      </div>

      <div data-flowgate="auth-body" className="fg-plan-body">
        <h3 data-flowgate="auth-title" className="fg-plan-title">
          {card.title}
        </h3>
        {card.subtitle !== undefined && card.subtitle !== '' ? (
          <p data-flowgate="auth-subtitle" className="fg-plan-desc">
            {card.subtitle}
          </p>
        ) : null}
        {card.chips.length > 0 ? (
          <div data-flowgate="auth-chips" className="fg-plan-meta">
            {card.chips.map((chip, index) => (
              <span key={`${index}-${chip.label}`} data-flowgate="auth-chip">
                <span className="fg-plan-meta-label">{chip.label}</span>
                <span className="fg-plan-meta-value">{chip.value}</span>
              </span>
            ))}
          </div>
        ) : null}
        {card.checks.total > 0 ? (
          <div data-flowgate="auth-checks" className="fg-plan-checks">
            {card.items.map((item, index) => (
              <span
                key={`${index}-${item.label}`}
                data-flowgate="auth-check"
                data-passed={item.passed ? 'true' : 'false'}
                className={`fg-plan-check${item.passed ? '' : ' fg-plan-check--failed'}`}
              >
                <span
                  className={`fg-state-dot ${item.passed ? 'fg-state-dot--success' : 'fg-state-dot--warning'}`}
                  aria-hidden="true"
                />
                <span className="fg-plan-check-label">{item.label}</span>
              </span>
            ))}
            <span data-flowgate="auth-check-summary" className="fg-plan-check-summary">
              {card.checks.passed}/{card.checks.total}
            </span>
          </div>
        ) : null}
        {editing ? (
          <div data-flowgate="auth-reject-form">
            <textarea
              data-flowgate="auth-reason"
              className="fg-field"
              value={reason}
              rows={2}
              placeholder={t('dock.auth.reasonPh')}
              aria-label={t('gate.rejectPrompt')}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onReason(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div data-flowgate="auth-footer" className="fg-plan-footer">
        <span
          data-flowgate="auth-feedback"
          className={`fg-plan-feedback${failure ? ' fg-plan-feedback--error' : ''}`}
        >
          {editing ? t('gate.rejectReasonRequired') : busy ? t('actions.submitting') : ''}
        </span>
        <div data-flowgate="auth-actions" className="fg-plan-actions">
          {editing ? (
            <>
              <button
                type="button"
                data-flowgate="auth-cancel"
                className="fg-native-btn fg-native-btn-ghost"
                onClick={onCancel}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-action="auth-reject-submit"
                className="fg-native-btn fg-native-btn-outline fg-native-btn-danger"
                disabled={busy || reason.trim() === ''}
                title={reason.trim() === '' ? t('actions.noReason') : t('gate.reject')}
                onClick={onSubmitReject}
              >
                {t('dock.auth.rejectSubmit')}
              </button>
            </>
          ) : (
            card.actions.map((action) => (
              <button
                key={`${action.kind}-${action.dataAction}`}
                type="button"
                data-flowgate="auth-button"
                data-action={action.dataAction}
                className={buttonClass(action)}
                disabled={busy}
                title={action.label}
                onClick={() => {
                  if (action.needsReason === true) onStartReject()
                  else onEmit(action.kind)
                }}
              >
                {action.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Pure dock surface: native-width frame + rail row + authorization card.
 * Sizes and colours are all native tokens (styles.ts); the only inline values
 * are structural (flex/borders already in classes).
 */
export function DockView({ model, t, onAction, onOpen, busy = false, notice }: DockViewProps): React.ReactElement {
  const state = model.state
  const cardSignature =
    model.card !== undefined
      ? `${model.card.kind}:${model.card.target.gate ?? ''}:${model.card.target.pendingId ?? ''}`
      : ''
  // Inline reject-reason form state is keyed by card signature so a new card
  // never inherits a stale textarea (no effect needed → harness/SSR friendly).
  const [edit, setEdit] = React.useState<{ signature: string; open: boolean; reason: string }>({
    signature: '',
    open: false,
    reason: '',
  })
  const editing = edit.signature === cardSignature && edit.open
  const reason = edit.signature === cardSignature ? edit.reason : ''
  const startReject = (): void => setEdit({ signature: cardSignature, open: true, reason: '' })
  const cancelReject = (): void => setEdit({ signature: cardSignature, open: false, reason: '' })
  const emit = (kind: AuthActionKind): void => onAction?.({ kind, dataAction: kindToDataAction(kind) })
  const submitReject = (): void => {
    if (reason.trim() === '') return
    onAction?.({ kind: 'reject', dataAction: 'auth-reject-submit', reason: reason.trim() })
    setEdit({ signature: cardSignature, open: false, reason: '' })
  }

  const next = model.next
  const nextColor =
    next?.kind === 'action'
      ? 'var(--dsw-alias-state-warn-primary, #f59e0b)'
      : next?.kind === 'auto'
        ? 'var(--dsw-alias-state-business-primary, #4176e6)'
        : 'var(--dsw-alias-label-tertiary, #81858c)'
  const openPanel = onOpen

  return (
    <div
      data-flowgate="flow-dock"
      data-state={state}
      data-tone={model.tone}
      data-initialized={model.initialized ? 'true' : 'false'}
      data-gate={model.awaitingGate}
      className="fg-frame"
      role="group"
      aria-label={t('viz.dockAria', { text: model.phrase })}
    >
      <div data-flowgate="flow-dock-inner" className="fg-frame-inner">
        <div data-flowgate="dock-row" className="fg-dock-row">
          <FlowRail
            nodes={model.nodes}
            state={state}
            t={t}
            awaitingGate={model.awaitingGate}
            {...(openPanel !== undefined ? { onSelectStage: () => openPanel() } : {})}
          />
          <span style={{ flex: '1 1 auto', minWidth: 4 }} />
          {model.changeId !== undefined ? (
            <span data-flowgate="dock-change" className="fg-dock-change">
              {model.changeId}
            </span>
          ) : null}
          {next !== undefined ? (
            <span data-flowgate="dock-next" data-kind={next.kind} className="fg-dock-next fg-rise" title={next.text}>
              <span className="fg-dock-next-icon" aria-hidden="true">
                <NextIcon kind={next.kind} color={nextColor} />
              </span>
              <span data-flowgate="dock-next-text" className="fg-dock-next-text">
                {next.text}
              </span>
            </span>
          ) : null}
          <button
            type="button"
            data-flowgate="dock-open-panel"
            data-action="auth-open-panel"
            className="fg-native-btn fg-native-btn-ghost fg-dock-panel-btn"
            aria-label={t('status.clickHint')}
            title={t('status.clickHint')}
            onClick={openPanel}
          >
            <PanelIcon size={14} color="currentColor" />
          </button>
        </div>

        {model.card !== undefined ? (
          <AuthCardView
            card={model.card}
            t={t}
            busy={busy}
            editing={editing}
            reason={reason}
            onStartReject={startReject}
            onReason={(value: string) => setEdit({ signature: cardSignature, open: true, reason: value })}
            onCancel={cancelReject}
            onSubmitReject={submitReject}
            onEmit={emit}
          />
        ) : null}

        {notice !== undefined && notice !== '' ? (
          <div role="status" data-flowgate="dock-notice" className="fg-dock-notice fg-rise">
            <ArrowIcon size={10} color="currentColor" />
            <span>{notice}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function kindToDataAction(kind: AuthActionKind): string {
  switch (kind) {
    case 'approve':
      return 'auth-approve'
    case 'reject':
      return 'auth-reject'
    case 'raise':
      return 'auth-raise'
    case 'confirm':
      return 'auth-confirm'
    case 'open-panel':
      return 'auth-open-panel'
    case 'repair':
      return 'auth-repair'
    case 'enable':
    case 'gates-on':
    default:
      return 'auth-enable'
  }
}

/**
 * Map one dock button press to the action layer's `ClientAction`.
 * `enable` / `repair` / `gates-on` reuse the same click-to-execute path added
 * for click authorization (they have no host remote payload).
 */
export function toClientAction(request: DockActionRequest, card: AuthCardModel | undefined): ClientAction | null {
  const target = card?.target
  switch (request.kind) {
    case 'enable':
      return { kind: 'enable' } as ClientAction
    case 'repair':
      return { kind: 'repair' } as ClientAction
    case 'gates-on':
      return { kind: 'gates-on' } as ClientAction
    case 'open-panel':
      return { kind: 'open-panel' }
    case 'confirm':
      return { kind: 'confirm-external' }
    case 'raise':
      return { kind: 'raise-complexity' }
    case 'approve':
      if (card?.kind === 'gate' && card.gate !== undefined) return { kind: 'approve', gate: card.gate }
      if (target?.pendingId !== undefined) return { kind: 'approve-pending', id: target.pendingId }
      return null
    case 'reject': {
      const reason = request.reason ?? ''
      if (target?.gate !== undefined) return { kind: 'reject', gate: target.gate, reason }
      if (target?.pendingId !== undefined) return { kind: 'reject-pending', id: target.pendingId, reason }
      return null
    }
    default:
      return null
  }
}

export interface StatusBarProps {
  props: SlotPropRecord
  t: TFn
  bridge?: HostBridge
}

/**
 * Slot container: projection → dock model, action port wiring (`executeCommand`
 * goes through `bridge.runCommand`; `fillCommand`/`copyText` stay as legacy
 * degradation only), panel opening and the busy/notice surface.
 */
export function StatusBar({ props, t, bridge }: StatusBarProps): React.ReactElement {
  const projection = readProjection(props)
  // Fallback projection for hosts that push the value slowly: after an action
  // we re-read through the remote so the card cannot stay on its stale state.
  const [remoteProjection, setRemoteProjection] = React.useState<FlowgateProjection | null>(null)
  const effective = projection ?? remoteProjection
  const model = React.useMemo(() => buildDockModel(effective, t), [effective, t])
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const sessionId = sessionIdOf(props)

  const refresh = React.useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    const raw = await bridge.readState()
    const next = normalizeProjection(raw)
    if (next !== null) setRemoteProjection(next)
  }, [bridge])

  React.useEffect(() => {
    if (projection !== null || bridge === undefined) return
    let alive = true
    void (async () => {
      const raw = await bridge.readState()
      const next = normalizeProjection(raw)
      if (alive && next !== null) setRemoteProjection(next)
    })()
    return () => {
      alive = false
    }
  }, [projection, bridge])

  const openPanel = (): void => {
    if (bridge !== undefined && bridge.openPanel()) {
      setNotice(undefined)
      return
    }
    setNotice(t('dock.notice.panelUnavailable'))
  }

  const runAction = (request: DockActionRequest): void => {
    setNotice(undefined)
    if (request.kind === 'open-panel') {
      openPanel()
      return
    }
    const action = toClientAction(request, model.card)
    if (action === null) {
      setNotice(t('actions.invalidAction', { kind: request.kind }))
      return
    }
    const ports: ActionPorts = {
      t,
      ...(bridge !== undefined
        ? {
            remote: bridge.remote(),
            executeCommand: (command: string) => bridge.runCommand(command, sessionId),
            fillCommand: (command: string) => bridge.fillCommand(command, sessionId),
            copyText: (text: string) => bridge.copyText(text),
            openPanel: () => bridge.openPanel(),
          }
        : {}),
    }
    setBusy(true)
    void (async () => {
      try {
        const outcome = await performAction(action, ports)
        setNotice(outcome.message)
      } finally {
        setBusy(false)
        await refresh()
      }
    })()
  }

  return (
    <DockView
      model={model}
      t={t}
      onAction={runAction}
      onOpen={openPanel}
      busy={busy}
      {...(notice !== undefined ? { notice } : {})}
    />
  )
}
