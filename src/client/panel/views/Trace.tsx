/**
 * Traceability view (FR-8.2): requirement → scenario → task → test evidence →
 * review verdict. Missing cells are highlighted red; uncovering every scenario
 * is what G3/G6 check.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { Badge, DataTable, EmptyState, Section } from '../Common'
import { COLORS, MONO_FONT } from '../../theme'

export function TraceView({ model, t }: ViewProps): React.ReactElement {
  const rows = model.trace ?? []
  if (rows.length === 0) {
    return (
      <div data-flowgate="view-trace">
        <Section title={t('trace.title')}>
          <EmptyState text={t('trace.empty')} />
        </Section>
      </div>
    )
  }
  const covered = rows.filter((row) => row.covered === true).length
  const evidenceByTask = new Map<string, string[]>()
  for (const row of rows) {
    for (const taskId of row.taskIds) {
      const list = evidenceByTask.get(taskId) ?? []
      list.push(...row.evidenceIds)
      evidenceByTask.set(taskId, list)
    }
  }

  const dataRows = rows.map((row) => [
    <span key="req" style={{ fontFamily: MONO_FONT }}>
      {row.requirementId}
    </span>,
    <span key="scenario" data-missing={row.covered ? 'false' : 'true'} style={{ color: row.covered ? COLORS.text : COLORS.fail }}>
      {row.scenarioId}
      {row.title !== undefined && row.title !== '' ? (
        <span style={{ color: COLORS.dim, marginInlineStart: 4 }}>{row.title}</span>
      ) : null}
    </span>,
    <span key="tasks" style={{ fontFamily: MONO_FONT, color: row.taskIds.length > 0 ? COLORS.text : COLORS.fail }}>
      {row.taskIds.length > 0 ? row.taskIds.join(', ') : t('trace.missing')}
    </span>,
    <span key="evidence" style={{ fontFamily: MONO_FONT, color: row.evidenceIds.length > 0 ? COLORS.text : COLORS.fail }}>
      {row.evidenceIds.length > 0 ? row.evidenceIds.join(', ') : t('trace.missing')}
    </span>,
    <span key="review">
      {row.covered ? (
        <Badge label={t('trace.covered')} color={COLORS.pass} dataBadge="trace-covered" />
      ) : (
        <Badge label={t('trace.uncoveredShort')} color={COLORS.fail} dataBadge="trace-missing" />
      )}
    </span>,
  ])

  return (
    <div data-flowgate="view-trace" style={{ display: 'grid', gap: 8 }}>
      <Section title={t('trace.title')} count={rows.length}>
        <div style={{ fontSize: 11, color: config_summary_color(covered, rows.length) }}>
          {t('trace.summary', { covered, total: rows.length })}
        </div>
        <DataTable
          testId="trace-table"
          emptyText={t('trace.empty')}
          headers={[
            t('trace.header.requirement'),
            t('trace.header.scenario'),
            t('trace.header.task'),
            t('trace.header.evidence'),
            t('trace.header.review'),
          ]}
          rows={dataRows}
        />
      </Section>
      {model.uncoveredScenarios.length > 0 ? (
        <div data-flowgate="trace-uncovered" style={{ color: COLORS.fail, fontSize: 11 }}>
          {t('trace.uncovered', { list: model.uncoveredScenarios.join(', ') })}
        </div>
      ) : null}
    </div>
  )
}

function config_summary_color(covered: number, total: number): string {
  return covered === total ? COLORS.pass : COLORS.warn
}
