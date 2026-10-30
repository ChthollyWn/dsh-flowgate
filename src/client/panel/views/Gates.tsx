/**
 * Gate view (FR-8.2 / T2.6 / T2.8): current gate checks and hints, the
 * low-complexity confirmation card (merged G1+G3), approve/reject buttons and
 * the execution-plan diagram for G3. Every action is human-only: a button or a
 * `/flow` command, never an agent tool.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, EmptyState, KeyValue, Mono, Notice, Section } from '../Common'
import { COLORS, UI_FONT } from '../../theme'
import { ExecutionGraph } from '../ExecutionGraph'

export function GatesView({ model, t, onAction }: ViewProps): React.ReactElement {
  const gate = model.gate
  const [reason, setReason] = React.useState('')
  const [rejecting, setRejecting] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const gateName = gate.gate

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

  const rejectForm = (
    <div data-flowgate="reject-form" style={{ display: 'grid', gap: 5 }}>
      <label style={{ fontSize: 11, color: COLORS.dim }} htmlFor="flowgate-reject-reason">
        {t('gate.rejectPrompt')}
      </label>
      <textarea
        id="flowgate-reject-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t('common.reasonPh')}
        rows={2}
        style={{
          fontFamily: UI_FONT,
          fontSize: 11.5,
          background: COLORS.surface,
          color: COLORS.text,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          padding: '4px 6px',
          resize: 'vertical',
        }}
      />
      {error !== undefined ? <Notice text={error} tone="error" t={t} /> : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <ActionButton label={t('gate.reject')} tone="danger" dataAction="gate-reject-submit" onClick={submitReject} />
        <ActionButton
          label={t('actions.cancel')}
          dataAction="gate-reject-cancel"
          onClick={() => {
            setRejecting(false)
            setError(undefined)
          }}
        />
      </div>
    </div>
  )

  // Low-complexity confirmation card (T2.8): one confirmation approves G1+G3.
  if (gate.mergedConfirm !== undefined) {
    const confirm = gate.mergedConfirm
    return (
      <div data-flowgate="view-gates" data-confirm-card="true" style={{ display: 'grid', gap: 10 }}>
        <Section title={t('gate.planConfirm')}>
          <div style={{ display: 'grid', gap: 5 }}>
            <KeyValue label={t('gate.planConfirm.goal')} value={confirm.goal !== '' ? confirm.goal : '—'} />
            <KeyValue
              label={t('gate.planConfirm.acceptance')}
              value={
                confirm.acceptance.length > 0 ? (
                  <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                    {confirm.acceptance.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  '—'
                )
              }
            />
            <KeyValue
              label={t('gate.planConfirm.scope')}
              value={confirm.scope.length > 0 ? confirm.scope.join(' · ') : '—'}
            />
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
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <ActionButton
              label={t('gate.planConfirm.approve')}
              tone="primary"
              dataAction="confirm-card-approve"
              onClick={() => onAction({ kind: 'approve', gate: gateName ?? 'G3' })}
            />
            <ActionButton
              label={t('gate.planConfirm.reject')}
              tone="danger"
              dataAction="confirm-card-reject"
              onClick={() => setRejecting(true)}
            />
            <ActionButton
              label={t('gate.planConfirm.raise')}
              dataAction="confirm-card-raise"
              onClick={() => onAction({ kind: 'raise-complexity', reason: t('actions.raiseComplexityHint') })}
            />
          </div>
          {rejecting ? rejectForm : null}
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
      <div data-flowgate="view-gates">
        <Section title={t('gates.title')}>
          <EmptyState text={t('gate.noGate')} />
        </Section>
      </div>
    )
  }

  return (
    <div data-flowgate="view-gates" style={{ display: 'grid', gap: 10 }}>
      <Section
        title={t('gates.title')}
        actions={
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            {gateName !== null ? <Badge label={t('gates.gate', { gate: gateName })} dataBadge={`gate-${gateName}`} /> : null}
            <Badge
              label={t(
                gate.state === 'awaiting'
                  ? 'gate.state.awaiting'
                  : gate.state === 'passed'
                    ? 'gate.state.passed'
                    : gate.state === 'failed'
                      ? 'gate.state.failed'
                      : gate.state === 'rejected'
                        ? 'gate.state.rejected'
                        : gate.state === 'skipped'
                          ? 'gate.state.skipped'
                          : 'gate.state.pending',
              )}
              color={gate.state === 'awaiting' ? COLORS.warn : gate.state === 'passed' ? COLORS.pass : COLORS.dim}
              dataBadge={`gate-state-${gate.state}`}
            />
          </span>
        }
      >
        {gate.items.length === 0 ? (
          <EmptyState text={t('gate.noItems')} />
        ) : (
          <ul data-flowgate="gate-items" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {gate.items.map((item) => (
              <li
                key={item.item}
                data-flowgate="gate-item"
                data-item={item.item}
                data-passed={item.passed ? 'true' : 'false'}
                style={{ fontSize: 11.5, lineHeight: 1.5, color: COLORS.text }}
              >
                <span aria-hidden="true" style={{ color: item.passed ? COLORS.pass : COLORS.fail, marginInlineEnd: 6 }}>
                  {item.passed ? '✓' : '✗'}
                </span>
                <span>{item.label}</span>
                {!item.passed && item.hint !== undefined && item.hint !== '' ? (
                  <div style={{ marginInlineStart: 18, color: COLORS.warn, fontSize: 11 }}>
                    {t('gate.hint', { hint: item.hint })}
                  </div>
                ) : null}
                {!item.passed && item.example !== undefined && item.example !== '' ? (
                  <div style={{ marginInlineStart: 18, color: COLORS.dim, fontSize: 10.5, fontFamily: 'monospace' }}>
                    {t('gate.example', { example: item.example })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {gate.awaitingOwner ? (
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            {rejecting ? (
              rejectForm
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <ActionButton
                  label={t('gate.approve')}
                  tone="primary"
                  dataAction="gate-approve"
                  onClick={() => onAction({ kind: 'approve', gate: gateName ?? 'G3' })}
                />
                <ActionButton
                  label={t('gate.reject')}
                  tone="danger"
                  dataAction="gate-reject"
                  onClick={() => setRejecting(true)}
                />
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 10.5, color: COLORS.faint }}>{t('gate.actionOnlyHuman')}</div>
        )}
      </Section>

      {gateName === 'G3' && !model.execution.empty ? (
        <Section title={t('gates.planGraph')}>
          <ExecutionGraph graph={model.execution} t={t} />
        </Section>
      ) : null}
      <div style={{ fontSize: 10.5, color: COLORS.faint }}>
        <Mono>/flow approve {gateName ?? 'G1'}</Mono>
      </div>
    </div>
  )
}
