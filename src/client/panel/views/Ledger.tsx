/**
 * Ledger view (FR-8.2 / T3.7): every change and analysis task with level,
 * stage, state, last session and activity time. Per-row human actions:
 * continue / take over / pause / report / board.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, DataTable, EmptyState, Section } from '../Common'
import { COLORS, MONO_FONT } from '../../theme'
import { shortTime } from '../../model'

export function ledgerResumeCommand(changeId: string, takeover = false): string {
  return `/flow resume ${changeId}${takeover ? ' --takeover' : ''}`
}

export function LedgerView({ model, t, onAction }: ViewProps): React.ReactElement {
  const rows = model.ledger
  if (rows.length === 0) {
    return (
      <div data-flowgate="view-ledger">
        <Section title={t('ledger.title')} actions={<ActionButton label={t('ledger.board')} dataAction="ledger-board" onClick={() => onAction({ kind: 'board' })} />}>
          <EmptyState text={t('ledger.empty')} hint={t('panel.demoHint')} />
        </Section>
      </div>
    )
  }

  const dataRows = rows.map((row) => [
    <span key="id" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontFamily: MONO_FONT }}>
      {row.id}
      {row.current ? <Badge label={t('ledger.current')} color={COLORS.info} dataBadge="current" /> : null}
    </span>,
    <Badge
      key="kind"
      label={row.kind === 'analysis' ? t('ledger.kind.analysis') : t('ledger.kind.change')}
      dataBadge={row.kind}
    />,
    <span key="title" title={row.title}>
      {row.title !== '' ? row.title : '—'}
    </span>,
    <span key="level">
      {row.complexity} · {row.risk}
    </span>,
    <span key="stage">{row.stageDisplay}</span>,
    <span key="life" style={{ color: row.lifecycle === 'active' ? COLORS.info : COLORS.dim }}>
      {row.lifecycleDisplay}
    </span>,
    <span key="session" style={{ fontFamily: MONO_FONT, fontSize: 10.5 }}>
      {row.session !== undefined && row.session !== '' ? row.session : t('ledger.session.none')}
    </span>,
    <span key="updated" style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: COLORS.dim }}>
      {shortTime(row.updatedAt)}
    </span>,
    <span key="actions" style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <ActionButton
        label={t('ledger.continue')}
        dataAction={`ledger-continue-${row.id}`}
        onClick={() => onAction({ kind: 'resume', changeId: row.id })}
      />
      <ActionButton
        label={t('ledger.takeover')}
        dataAction={`ledger-takeover-${row.id}`}
        onClick={() => onAction({ kind: 'resume', changeId: row.id, takeover: true })}
      />
      {row.current ? (
        <ActionButton
          label={t('ledger.pause')}
          dataAction={`ledger-pause-${row.id}`}
          onClick={() => onAction({ kind: 'pause', changeId: row.id })}
        />
      ) : null}
      <ActionButton label={t('ledger.report')} dataAction={`ledger-report-${row.id}`} onClick={() => onAction({ kind: 'report' })} />
    </span>,
  ])

  return (
    <div data-flowgate="view-ledger">
      <Section
        title={t('ledger.title')}
        count={rows.length}
        actions={
          <ActionButton label={t('ledger.board')} dataAction="ledger-board" onClick={() => onAction({ kind: 'board' })} />
        }
      >
        <DataTable
          testId="ledger-table"
          emptyText={t('ledger.empty')}
          headers={[
            t('ledger.header.id'),
            t('ledger.header.title'),
            t('ledger.header.title'),
            t('ledger.header.level'),
            t('ledger.header.stage'),
            t('ledger.header.status'),
            t('ledger.header.session'),
            t('ledger.header.updated'),
            '',
          ]}
          rows={dataRows}
        />
      </Section>
      <div style={{ marginTop: 8, fontSize: 10.5, color: COLORS.faint }}>{t('gate.actionOnlyHuman')}</div>
    </div>
  )
}
