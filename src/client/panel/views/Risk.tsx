/**
 * Risk view (FR-8.2 / T4.1): risk register (five categories, grade, mitigation,
 * verification) and the risk pending items waiting for a human decision.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, DataTable, EmptyState, Mono, Section } from '../Common'
import { COLORS, severityColor } from '../../theme'

function riskCategoryLabel(category: string, t: ViewProps['t']): string {
  switch (category) {
    case 'security':
      return t('risk.category.security')
    case 'performance':
      return t('risk.category.performance')
    case 'cost':
      return t('risk.category.cost')
    case 'compliance':
      return t('risk.category.compliance')
    case 'maintainability':
      return t('risk.category.maintainability')
    default:
      return category
  }
}

function riskGradeLabel(grade: string, t: ViewProps['t']): string {
  switch (grade) {
    case 'none':
      return t('risk.grade.none')
    case 'low':
      return t('risk.grade.low')
    case 'medium':
      return t('risk.grade.medium')
    case 'high':
      return t('risk.grade.high')
    default:
      return grade
  }
}

export function RiskView({ model, t, onAction }: ViewProps): React.ReactElement {
  const risks = model.risks
  const pendings = model.pendingRisks
  const [reason, setReason] = React.useState('')

  return (
    <div data-flowgate="view-risk" style={{ display: 'grid', gap: 10 }}>
      <Section title={t('risk.title')} count={risks.length}>
        {risks.length === 0 ? (
          <EmptyState text={t('risk.empty')} />
        ) : (
          <DataTable
            testId="risk-table"
            emptyText={t('risk.empty')}
            headers={[
              t('risk.header.category'),
              t('risk.header.grade'),
              t('risk.header.reason'),
              t('risk.header.mitigation'),
              t('risk.header.verification'),
              t('risk.header.needsHuman'),
            ]}
            rows={risks.map((risk) => [
              <span key="category">{riskCategoryLabel(risk.category, t)}</span>,
              <Badge
                key="grade"
                label={riskGradeLabel(risk.grade, t)}
                color={severityColor(risk.grade)}
                dataBadge={`grade-${risk.grade}`}
              />,
              <span key="reason">{risk.reason}</span>,
              <span key="mitigation">{risk.mitigation}</span>,
              <span key="verification">{risk.verification}</span>,
              <span key="human" style={{ color: risk.needsHuman ? COLORS.warn : COLORS.dim }}>
                {risk.needsHuman ? t('risk.needsHuman') : t('common.no')}
              </span>,
            ])}
          />
        )}
      </Section>

      <Section title={t('risk.pending')} count={pendings.length}>
        {pendings.length === 0 ? (
          <EmptyState text={t('risk.pendingEmpty')} />
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {pendings.map((item) => (
              <div
                key={item.id}
                data-flowgate="risk-pending"
                data-pending-id={item.id}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 7,
                  padding: '6px 8px',
                  display: 'grid',
                  gap: 4,
                  fontSize: 11,
                }}
              >
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Mono>{item.id}</Mono>
                  <Badge label={riskCategoryLabel(String(item.data?.category ?? ''), t)} dataBadge="pending-risk" />
                </div>
                <div>{item.title}</div>
                <div style={{ color: COLORS.dim }}>{item.detail}</div>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t('common.reasonPh')}
                  rows={1}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 11.5,
                    background: COLORS.surface,
                    color: COLORS.text,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    padding: '3px 6px',
                  }}
                />
                <div style={{ display: 'flex', gap: 5 }}>
                  <ActionButton
                    label={t('risk.approve')}
                    tone="primary"
                    dataAction={`risk-approve-${item.id}`}
                    onClick={() => onAction({ kind: 'approve-pending', id: item.id, reason: reason.trim() })}
                  />
                  <ActionButton
                    label={t('risk.reject')}
                    tone="danger"
                    dataAction={`risk-reject-${item.id}`}
                    onClick={() => onAction({ kind: 'reject-pending', id: item.id, reason: reason.trim() })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
