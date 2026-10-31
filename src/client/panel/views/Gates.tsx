/**
 * Gate view (FR-8.2 / T2.6 / T2.8) — graphical authorization card, restyled to
 * the host-native plan card (docs/impl/ui-interaction-redesign.md §1.4).
 *
 * Structure follows the official `PlanReviewPanel`: a warn strip with a state
 * dot, a body with title / description / check dots, and a footer with
 * feedback text plus native outline + primary buttons. No blue / red filled
 * buttons, no coloured wash, no command text: every button goes through
 * `onAction` → `performAction` → the host command remote.
 *
 * The legacy `data-flowgate="gate-items"` / `gate-item` / `data-action`
 * attributes are kept so existing SSR tests keep covering the same semantics.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { EmptyState, KeyValue, Mono, Notice, Section } from '../Common'
import { NATIVE } from '../../theme'
import { ExecutionGraph } from '../ExecutionGraph'
import type { GateItem, GateState } from '../../types'

const FONT = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif)'
const MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** Accent of a gate state — used only for small dots / short text. */
function stateColor(state: GateState): string {
  switch (state) {
    case 'awaiting':
      return NATIVE.stateWarn
    case 'passed':
      return NATIVE.labelSecondary
    case 'failed':
    case 'rejected':
      return NATIVE.stateError
    default:
      return NATIVE.labelTertiary
  }
}

function stateDotClass(state: GateState): string {
  switch (state) {
    case 'awaiting':
      return 'fg-state-dot fg-state-dot--warning'
    case 'passed':
      return 'fg-state-dot fg-state-dot--success'
    case 'failed':
    case 'rejected':
      return 'fg-state-dot fg-state-dot--error'
    default:
      return 'fg-state-dot'
  }
}

function stateLabel(state: GateState, t: ViewProps['t']): string {
  switch (state) {
    case 'awaiting':
      return t('gate.state.awaiting')
    case 'passed':
      return t('gate.state.passed')
    case 'failed':
      return t('gate.state.failed')
    case 'rejected':
      return t('gate.state.rejected')
    case 'skipped':
      return t('gate.state.skipped')
    default:
      return t('gate.state.pending')
  }
}

/** Sweep highlight on an awaiting card (styled by `src/client/styles.ts`). */
function AuthShimmer({ active }: { active: boolean }): React.ReactElement | null {
  if (!active) return null
  return (
    <span
      data-flowgate="auth-shimmer"
      aria-hidden="true"
      className="fg-sweep"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 'inherit', overflow: 'hidden' }}
    />
  )
}

/** Local native button: primary / outline / ghost (styles.ts). */
function NativeButton({
  label,
  dataAction,
  onClick,
  tone = 'outline',
  disabled,
}: {
  label: string
  dataAction: string
  onClick?: () => void
  tone?: 'primary' | 'outline' | 'danger' | 'ghost'
  disabled?: boolean
}): React.ReactElement {
  const className =
    tone === 'primary'
      ? 'fg-native-btn fg-native-btn-primary'
      : tone === 'danger'
        ? 'fg-native-btn fg-native-btn-outline fg-native-btn-danger'
        : tone === 'ghost'
          ? 'fg-native-btn fg-native-btn-ghost'
          : 'fg-native-btn fg-native-btn-outline'
  return (
    <button type="button" data-flowgate="action" data-action={dataAction} className={className} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  )
}

/** Gate badge: neutral shield outline + short gate label (state lives in the strip). */
function GateShield({ gate, state }: { gate: string; state: GateState }): React.ReactElement {
  const accent = stateColor(state)
  return (
    <span
      data-flowgate="gate-badge"
      data-gate={gate}
      data-state={state}
      aria-hidden="true"
      style={{ flex: '0 0 auto', lineHeight: 0, color: accent }}
    >
      <svg width={28} height={32} viewBox="0 0 24 28" role="presentation" focusable="false">
        <path
          d="M12 1.6 21.6 5v8c0 6.3-4.1 10.9-9.6 13-5.5-2.1-9.6-6.7-9.6-13V5z"
          fill={NATIVE.hover}
          stroke={NATIVE.borderL3}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <text x="12" y="15.8" textAnchor="middle" fontSize="8.5" fontWeight="600" fill={NATIVE.labelSecondary} fontFamily={FONT}>
          {gate}
        </text>
      </svg>
    </span>
  )
}

/** Thin neutral progress ring (label-primary value, border track). */
function GateProgressRing({
  gate,
  passed,
  total,
  label,
}: {
  gate: string
  passed: number
  total: number
  label: string
}): React.ReactElement {
  const size = 38
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = total === 0 ? 0 : Math.min(1, passed / total)
  const offset = circumference * (1 - ratio)
  return (
    <svg
      data-flowgate="gate-ring"
      data-gate={gate}
      data-passed={passed}
      data-total={total}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      style={{ flex: '0 0 auto' }}
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={NATIVE.borderL2} strokeWidth={stroke} />
      <circle
        data-flowgate="gate-ring-progress"
        className="fg-ring"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={NATIVE.labelSecondary}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference.toFixed(2)}
        strokeDashoffset={offset.toFixed(2)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="9.5"
        fill={NATIVE.labelTertiary}
        fontFamily={FONT}
      >
        {passed}/{total}
      </text>
    </svg>
  )
}

/** One dot per check item: semantic colour stays a small dot. */
function GateDots({ items }: { items: GateItem[] }): React.ReactElement {
  return (
    <span data-flowgate="gate-dots" aria-hidden="true" style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
      {items.map((item) => (
        <span
          key={item.item}
          data-flowgate="gate-dot"
          data-item={item.item}
          data-passed={item.passed ? 'true' : 'false'}
          title={item.label}
          className={`fg-state-dot ${item.passed ? 'fg-state-dot--success' : 'fg-state-dot--warning'}`}
        />
      ))}
    </span>
  )
}

/** Thin linear progress under the checks (label-primary fill, border track). */
function GateProgressBar({ passed, total }: { passed: number; total: number }): React.ReactElement {
  const percent = total === 0 ? 0 : Math.round((passed / total) * 100)
  return (
    <div
      data-flowgate="gate-progress"
      data-passed={passed}
      data-total={total}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={passed}
      style={{
        height: 2,
        borderRadius: 999,
        background: NATIVE.borderL2,
        overflow: 'hidden',
        margin: '8px 0 2px',
      }}
    >
      <div style={{ width: `${percent}%`, height: '100%', borderRadius: 999, background: NATIVE.labelSecondary }} />
    </div>
  )
}

/** 非 agent 改动列表（T1.4 验收 #3）：G6 前必须由负责人确认。 */
function ExternalChangesSection({ model, t, onAction }: ViewProps): React.ReactElement | null {
  if (model.externalChanges.length === 0) return null
  return (
    <Section title={t('gates.externalChanges')}>
      <div data-flowgate="external-changes" style={{ display: 'grid', gap: 6, fontFamily: FONT }}>
        <div style={{ fontSize: 12, color: NATIVE.labelTertiary }}>{t('gates.externalHint')}</div>
        <ul style={{ margin: 0, paddingInlineStart: 16, fontSize: 12, color: NATIVE.labelSecondary }}>
          {model.externalChanges.map((entry) => (
            <li key={entry.path}>
              <Mono>{entry.path}</Mono>
              {entry.origin === 'unknown' ? <span style={{ color: NATIVE.labelTertiary }}> · {t('gates.externalUnknown')}</span> : ''}
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <NativeButton
            label={t('gates.confirmExternal')}
            tone="outline"
            dataAction="confirm-external-all"
            onClick={() => onAction({ kind: 'confirm-external' })}
          />
        </div>
      </div>
    </Section>
  )
}

export function GatesView({ model, t, onAction }: ViewProps): React.ReactElement {
  const gate = model.gate
  const [reason, setReason] = React.useState('')
  const [rejecting, setRejecting] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const gateName = gate.gate
  const passed = gate.items.filter((item) => item.passed).length
  const total = gate.items.length
  const awaiting = gate.awaitingOwner

  const submitReject = (): void => {
    if (reason.trim() === '') {
      setError(t('gate.rejectReasonRequired'))
      return
    }
    setError(undefined)
    setRejecting(false)
    onAction({ kind: 'reject', gate: gateName ?? 'G3', reason: reason.trim() })
    setReason('')
  }

  // Inline reject reason: it belongs to the card, never to a command prompt.
  const rejectForm = (
    <div data-flowgate="reject-form" style={{ display: 'grid', gap: 5 }}>
      <textarea
        id="flowgate-reject-reason"
        data-flowgate="reject-reason"
        className="fg-field"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('common.reasonPh')}
        aria-label={t('gate.rejectPrompt')}
        rows={2}
      />
      {error !== undefined ? <Notice text={error} tone="error" t={t} /> : null}
    </div>
  )

  const strip = (text: string, state: GateState, meta?: string): React.ReactElement => (
    <div data-flowgate="gate-strip" data-badge={`gate-state-${state}`} className="fg-plan-strip">
      <span className={stateDotClass(state)} aria-hidden="true" />
      <span className="fg-plan-strip-text">{text}</span>
      <span className="fg-plan-strip-spacer" />
      {meta !== undefined ? <span className="fg-plan-strip-meta">{meta}</span> : null}
    </div>
  )

  const footer = (
    <div data-flowgate="gate-footer" className="fg-plan-footer">
      <span data-flowgate="gate-feedback" className={`fg-plan-feedback${error !== undefined ? ' fg-plan-feedback--error' : ''}`}>
        {error ?? (rejecting ? t('gate.rejectReasonRequired') : '')}
      </span>
      <div data-flowgate="gate-actions" className="fg-plan-actions">
        {rejecting ? (
          <>
            <NativeButton
              label={t('actions.cancel')}
              tone="ghost"
              dataAction="gate-reject-cancel"
              onClick={() => {
                setRejecting(false)
                setError(undefined)
              }}
            />
            <NativeButton label={t('gate.reject')} tone="danger" dataAction="gate-reject-submit" onClick={submitReject} />
          </>
        ) : (
          <>
            <NativeButton label={t('gate.reject')} tone="danger" dataAction="gate-reject" onClick={() => setRejecting(true)} />
            <NativeButton
              label={t('gate.approve')}
              tone="primary"
              dataAction="gate-approve"
              onClick={() => onAction({ kind: 'approve', gate: gateName ?? 'G3' })}
            />
          </>
        )}
      </div>
    </div>
  )

  // Low-complexity confirmation card (T2.8): one card approves G1+G3.
  if (gate.mergedConfirm !== undefined) {
    const confirm = gate.mergedConfirm
    return (
      <div data-flowgate="view-gates" style={{ display: 'grid', gap: 10, fontFamily: FONT }}>
        <Section title={t('gate.planConfirm')}>
          <div
            data-flowgate="gate-auth-card"
            data-confirm-card="true"
            data-kind="merged-confirm"
            data-gate={gateName ?? 'G3'}
            data-state={gate.state}
            className="fg-plan-card"
            style={{ maxWidth: '100%' }}
          >
            {awaiting ? <AuthShimmer active /> : null}
            {strip(t('gate.planConfirm'), gate.state, gateName ?? 'G3')}
            <div data-flowgate="gate-body" className="fg-plan-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <GateShield gate={gateName ?? 'G3'} state={gate.state} />
                <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <h3 className="fg-plan-title" style={{ whiteSpace: 'normal' }}>
                    {confirm.goal !== '' ? confirm.goal : t('gate.planConfirm')}
                  </h3>
                  <div style={{ fontSize: 11, color: NATIVE.labelTertiary }}>
                    {t('gates.gate', { gate: gateName ?? 'G3' })} · {stateLabel(gate.state, t)}
                  </div>
                </div>
                <span style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'grid', gap: 5, marginTop: 10, fontSize: 12 }}>
                {confirm.acceptance.length > 0 ? (
                  <KeyValue
                    label={t('gate.planConfirm.acceptance')}
                    value={
                      <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                        {confirm.acceptance.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    }
                  />
                ) : null}
                <KeyValue label={t('gate.planConfirm.scope')} value={confirm.scope.length > 0 ? confirm.scope.join(' · ') : '—'} />
                <KeyValue label={t('gate.planConfirm.verify')} value={confirm.verify !== '' ? confirm.verify : '—'} />
                {confirm.risks !== undefined && confirm.risks.length > 0 ? (
                  <KeyValue
                    label={t('gate.planConfirm.risks')}
                    value={
                      <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                        {confirm.risks.map((risk, index) => (
                          <li key={index}>
                            {risk.title}
                            {risk.mitigation !== '' ? ` — ${risk.mitigation}` : ''}
                          </li>
                        ))}
                      </ul>
                    }
                  />
                ) : null}
                {confirm.rollback !== undefined ? (
                  <KeyValue label={t('gate.planConfirm.rollback')} value={confirm.rollback !== '' ? confirm.rollback : '—'} />
                ) : null}
                {confirm.requireConfirmation === true ? (
                  <div data-flowgate="confirm-risks-required" style={{ fontSize: 11, color: NATIVE.stateWarn } as React.CSSProperties}>
                    {t('gate.planConfirm.confirmRisks')}
                  </div>
                ) : null}
              </div>
              {rejecting ? rejectForm : null}
            </div>
            <div data-flowgate="gate-footer" className="fg-plan-footer">
              <span data-flowgate="gate-feedback" className={`fg-plan-feedback${error !== undefined ? ' fg-plan-feedback--error' : ''}`}>
                {error ?? (rejecting ? t('gate.rejectReasonRequired') : '')}
              </span>
              <div data-flowgate="gate-actions" className="fg-plan-actions">
                {rejecting ? (
                  <>
                    <NativeButton
                      label={t('actions.cancel')}
                      tone="ghost"
                      dataAction="gate-reject-cancel"
                      onClick={() => {
                        setRejecting(false)
                        setError(undefined)
                      }}
                    />
                    <NativeButton label={t('gate.reject')} tone="danger" dataAction="gate-reject-submit" onClick={submitReject} />
                  </>
                ) : (
                  <>
                    <NativeButton
                      label={t('gate.planConfirm.raise')}
                      tone="outline"
                      dataAction="confirm-card-raise"
                      onClick={() => onAction({ kind: 'raise-complexity', reason: t('actions.raiseComplexityHint') })}
                    />
                    <NativeButton
                      label={t('gate.planConfirm.reject')}
                      tone="danger"
                      dataAction="confirm-card-reject"
                      onClick={() => setRejecting(true)}
                    />
                    <NativeButton
                      label={t('gate.planConfirm.approve')}
                      tone="primary"
                      dataAction="confirm-card-approve"
                      onClick={() =>
                        onAction({
                          kind: 'approve',
                          gate: gateName ?? 'G3',
                          ...(confirm.requireConfirmation === true ? { confirmRisks: true } : {}),
                        })
                      }
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        </Section>
        {model.execution.empty ? null : (
          <Section title={t('gates.planGraph')}>
            <ExecutionGraph graph={model.execution} t={t} />
          </Section>
        )}
      </div>
    )
  }

  if (gateName === null && gate.items.length === 0) {
    return (
      <div data-flowgate="view-gates" style={{ display: 'grid', gap: 10, fontFamily: FONT }}>
        <Section title={t('gates.title')}>
          <EmptyState text={t('gate.noGate')} />
        </Section>
        <ExternalChangesSection model={model} t={t} onAction={onAction} />
      </div>
    )
  }

  return (
    <div data-flowgate="view-gates" style={{ display: 'grid', gap: 10, fontFamily: FONT }}>
      <Section title={t('gates.title')}>
        <div
          data-flowgate="gate-auth-card"
          data-kind="gate"
          data-gate={gateName ?? ''}
          data-state={gate.state}
          data-awaiting={awaiting ? 'true' : 'false'}
          className="fg-plan-card"
          style={{ maxWidth: '100%' }}
        >
          {awaiting ? <AuthShimmer active /> : null}
          {strip(`${t('gates.gate', { gate: gateName ?? 'G' })} · ${stateLabel(gate.state, t)}`, gate.state, total > 0 ? `${passed}/${total}` : undefined)}
          <div data-flowgate="gate-body" className="fg-plan-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <GateShield gate={gateName ?? 'G'} state={gate.state} />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <h3 className="fg-plan-title" data-flowgate="gate-title">
                    {t('gate.itemsTitle', { gate: gateName ?? 'G' })}
                  </h3>
                </div>
                {total > 0 ? <GateDots items={gate.items} /> : null}
              </div>
              <span style={{ flex: 1 }} />
              {total > 0 ? (
                <GateProgressRing
                  gate={gateName ?? ''}
                  passed={passed}
                  total={total}
                  label={t('gate.itemsTitle', { gate: gateName ?? 'G' })}
                />
              ) : null}
            </div>

            {total > 0 ? <GateProgressBar passed={passed} total={total} /> : null}

            {gate.items.length === 0 ? (
              <EmptyState text={t('gate.noItems')} />
            ) : (
              <ul data-flowgate="gate-items" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 4 }}>
                {gate.items.map((item) => (
                  <li
                    key={item.item}
                    data-flowgate="gate-item"
                    data-item={item.item}
                    data-passed={item.passed ? 'true' : 'false'}
                    style={{ fontSize: 12.5, lineHeight: 1.55, color: NATIVE.labelSecondary }}
                  >
                    <span
                      aria-hidden="true"
                      data-flowgate="gate-item-dot"
                      className={`fg-state-dot ${item.passed ? 'fg-state-dot--success' : 'fg-state-dot--warning'}`}
                      style={{ marginInlineEnd: 6, verticalAlign: 'middle' }}
                    />
                    <span>{item.label}</span>
                    {!item.passed && item.hint !== undefined && item.hint !== '' ? (
                      <div style={{ marginInlineStart: 20, color: NATIVE.labelTertiary, fontSize: 11 }}>
                        {t('gate.hint', { hint: item.hint })}
                      </div>
                    ) : null}
                    {!item.passed && item.example !== undefined && item.example !== '' ? (
                      <div style={{ marginInlineStart: 20, color: NATIVE.labelCaption, fontSize: 11, fontFamily: MONO }}>
                        {t('gate.example', { example: item.example })}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {awaiting && rejecting ? rejectForm : null}
          </div>
          {awaiting ? footer : null}
        </div>
      </Section>

      {gateName === 'G3' && !model.execution.empty ? (
        <Section title={t('gates.planGraph')}>
          <ExecutionGraph graph={model.execution} t={t} />
        </Section>
      ) : null}
      <ExternalChangesSection model={model} t={t} onAction={onAction} />
    </div>
  )
}
