/**
 * Metrics view (FR-10.2 / T5.1): this change + cumulative M-1..M-18, with CSV /
 * JSON export. Missing values stay "未知" (never 0, FR-10.4). Export tries the
 * browser download first; if that is unavailable the host remote / `/flow
 * metrics --csv` fallback is used.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, EmptyState, Section } from '../Common'
import { COLORS, MONO_FONT, UI_FONT } from '../../theme'
import { metricsCsv, metricsJson } from '../../model'

function downloadFile(filename: string, mime: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  } catch {
    return false
  }
}

export function MetricsView({ model, t, onAction }: ViewProps): React.ReactElement {
  const metrics = model.metrics
  const numericRows = metrics.change.filter((row) => row.value !== t('metrics.unknown'))
  const empty = !metrics.hasData || numericRows.length === 0

  const exportCsv = (): void => {
    const ok = downloadFile('flowgate-metrics.csv', 'text/csv;charset=utf-8', metricsCsv(metrics))
    if (!ok) onAction({ kind: 'metrics-export' })
  }

  const exportJson = (): void => {
    const ok = downloadFile('flowgate-metrics.json', 'application/json;charset=utf-8', metricsJson(metrics))
    if (!ok) onAction({ kind: 'metrics-export' })
  }

  return (
    <div data-flowgate="view-metrics" style={{ display: 'grid', gap: 10 }}>
      <Section
        title={t('metrics.title')}
        count={metrics.change.length}
        actions={
          <span style={{ display: 'inline-flex', gap: 5 }}>
            <ActionButton label={t('common.exportCsv')} dataAction="metrics-export-csv" onClick={exportCsv} />
            <ActionButton label={t('common.exportJson')} dataAction="metrics-export-json" onClick={exportJson} />
          </span>
        }
      >
        {empty ? <EmptyState text={t('metrics.empty')} hint={t('metrics.exportHint')} /> : null}
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              borderCollapse: 'collapse',
              width: '100%',
              fontFamily: UI_FONT,
              fontSize: 11,
              color: COLORS.text,
            }}
            data-flowgate="metrics-table"
          >
            <thead>
              <tr>
                {[t('intercepts.header.rule'), t('metrics.change'), t('metrics.cumulative'), t('metrics.definition')].map(
                  (header) => (
                    <th
                      key={header}
                      scope="col"
                      style={{
                        textAlign: 'start',
                        padding: '4px 6px',
                        color: COLORS.dim,
                        borderBottom: `1px solid ${COLORS.border}`,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {metrics.change.map((row, index) => (
                <tr key={row.id} data-metric-id={row.id} data-value={row.value}>
                  <td style={{ padding: '4px 6px', borderBottom: `1px solid ${COLORS.border}` }}>
                    <span style={{ fontFamily: MONO_FONT, marginInlineEnd: 6 }}>{row.id}</span>
                    {row.label}
                  </td>
                  <td style={{ padding: '4px 6px', borderBottom: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }}>
                    {row.value}
                  </td>
                  <td style={{ padding: '4px 6px', borderBottom: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }}>
                    {metrics.total !== null ? metrics.total[index]?.value ?? t('metrics.unknown') : '—'}
                  </td>
                  <td
                    style={{
                      padding: '4px 6px',
                      borderBottom: `1px solid ${COLORS.border}`,
                      color: COLORS.dim,
                      fontSize: 10.5,
                    }}
                  >
                    {row.note !== undefined && row.note !== '' ? row.note : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <div style={{ fontSize: 10.5, color: COLORS.faint }}>{t('metrics.exportHint')}</div>
    </div>
  )
}
