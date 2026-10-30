/**
 * Intercepts view (FR-8.2 / FR-9.3 / T5.1): intercept log, per-rule stats,
 * coverage self-check, rule dry-run and false-positive feedback
 * (allow-once / add exception / copy evidence). Readable and usable without a
 * remote: the dry-run falls back to a conservative local heuristic and the
 * feedback buttons fall back to `/flow` commands.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, DataTable, EmptyState, Mono, Notice, Section } from '../Common'
import { COLORS, MONO_FONT, UI_FONT } from '../../theme'
import { trialRuleLocal } from '../../model'
import type { InterceptRow } from '../../types'

type Tab = 'log' | 'stats' | 'coverage' | 'trial'

const TABS: { id: Tab; labelKey: 'intercepts.tab.log' | 'intercepts.tab.stats' | 'intercepts.tab.coverage' | 'intercepts.tab.trial' }[] = [
  { id: 'log', labelKey: 'intercepts.tab.log' },
  { id: 'stats', labelKey: 'intercepts.tab.stats' },
  { id: 'coverage', labelKey: 'intercepts.tab.coverage' },
  { id: 'trial', labelKey: 'intercepts.tab.trial' },
]

function interceptEvidence(row: InterceptRow): string {
  return JSON.stringify(
    {
      at: row.at,
      ruleId: row.ruleId,
      tool: row.tool,
      target: row.target,
      effect: row.effect,
      why: row.why,
      unlock: row.unlock,
      source: row.source,
      violationId: row.violationId,
    },
    null,
    2,
  )
}

export function InterceptsView({ model, t, onAction }: ViewProps): React.ReactElement {
  const [tab, setTab] = React.useState<Tab>('log')
  const [feedbackFor, setFeedbackFor] = React.useState<number | undefined>(undefined)
  const [reason, setReason] = React.useState('')
  const [pathPattern, setPathPattern] = React.useState('')
  const [trialTool, setTrialTool] = React.useState('edit')
  const [trialPath, setTrialPath] = React.useState('src/main/java/A.java')
  const [trialCommand, setTrialCommand] = React.useState('')
  const [trialDone, setTrialDone] = React.useState(false)

  const rows = model.intercepts
  const selected = feedbackFor !== undefined ? rows[feedbackFor] : undefined
  const trial =
    trialDone && model.rules.length > 0
      ? trialRuleLocal(
          {
            tool: trialTool,
            path: trialPath,
            command: trialCommand,
            stage: model.stage,
          },
          model.rules,
        )
      : null

  const submitFeedback = (kind: 'allow-once' | 'add-exception'): void => {
    if (selected === undefined) return
    if (reason.trim() === '') return
    if (kind === 'allow-once') {
      onAction({ kind: 'allow-once', ruleId: selected.ruleId, reason: reason.trim() })
    } else {
      onAction({
        kind: 'add-exception',
        ruleId: selected.ruleId,
        ...(pathPattern.trim() !== '' ? { pathPattern: pathPattern.trim() } : {}),
        reason: reason.trim(),
      })
    }
    setFeedbackFor(undefined)
    setReason('')
    setPathPattern('')
  }

  return (
    <div data-flowgate="view-intercepts" style={{ display: 'grid', gap: 8 }}>
      <div role="tablist" aria-label={t('intercepts.title')} style={{ display: 'flex', gap: 4 }}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            data-flowgate="intercepts-tab"
            data-tab={entry.id}
            onClick={() => setTab(entry.id)}
            style={{
              fontFamily: UI_FONT,
              fontSize: 11,
              padding: '2px 9px',
              borderRadius: 999,
              border: `1px solid ${tab === entry.id ? COLORS.info : COLORS.border}`,
              background: tab === entry.id ? COLORS.infoBg : 'transparent',
              color: COLORS.text,
              cursor: 'pointer',
            }}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'log' ? (
        <Section title={t('intercepts.log')} count={rows.length}>
          {rows.length === 0 ? (
            <EmptyState text={t('intercepts.empty')} />
          ) : (
            <>
              <DataTable
                testId="intercepts-table"
                emptyText={t('intercepts.empty')}
                headers={[
                  t('intercepts.header.time'),
                  t('intercepts.header.rule'),
                  t('intercepts.header.tool'),
                  t('intercepts.header.target'),
                  t('intercepts.header.effect'),
                  '',
                ]}
                rows={rows.map((row, index) => [
                  <span key="at" style={{ fontFamily: MONO_FONT, fontSize: 10.5 }}>
                    {row.at}
                  </span>,
                  <span key="rule" style={{ fontFamily: MONO_FONT }}>
                    {row.ruleId}
                  </span>,
                  <span key="tool">{row.tool}</span>,
                  <span key="target" style={{ fontFamily: MONO_FONT, fontSize: 10.5 }}>
                    {row.target !== undefined && row.target !== '' ? row.target : '—'}
                  </span>,
                  <Badge
                    key="effect"
                    label={row.effect === 'human' ? t('intercepts.effect.human') : t('intercepts.effect.deny')}
                    color={row.effect === 'human' ? COLORS.warn : COLORS.fail}
                    dataBadge={`effect-${row.effect}`}
                  />,
                  <span key="actions" style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                    <ActionButton
                      label={t('intercepts.misjudged')}
                      dataAction={`intercept-feedback-${index}`}
                      onClick={() => {
                        setFeedbackFor(index)
                        setReason('')
                        setPathPattern('')
                      }}
                    />
                    <ActionButton
                      label={t('intercepts.copyEvidence')}
                      dataAction={`intercept-copy-${index}`}
                      onClick={() => onAction({ kind: 'copy-evidence', text: interceptEvidence(row) })}
                    />
                  </span>,
                ])}
              />
              {selected !== undefined ? (
                <div
                  data-flowgate="intercept-feedback"
                  style={{
                    marginTop: 8,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 7,
                    padding: '7px 9px',
                    display: 'grid',
                    gap: 5,
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <Mono>{selected.ruleId}</Mono>
                    <span style={{ color: COLORS.dim }}>{selected.why}</span>
                  </div>
                  <div style={{ color: COLORS.faint, fontSize: 10.5 }}>
                    {t('intercepts.unlock')}：{selected.unlock}
                  </div>
                  <label style={{ fontSize: 11, color: COLORS.dim }} htmlFor="flowgate-intercepts-reason">
                    {t('common.reason')}
                  </label>
                  <textarea
                    id="flowgate-intercepts-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={t('intercepts.reasonPh')}
                    rows={2}
                    style={{
                      fontFamily: UI_FONT,
                      fontSize: 11.5,
                      background: COLORS.surface,
                      color: COLORS.text,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 6,
                      padding: '4px 6px',
                    }}
                  />
                  <input
                    value={pathPattern}
                    onChange={(event) => setPathPattern(event.target.value)}
                    placeholder={t('intercepts.exceptionPathPh')}
                    aria-label={t('intercepts.exceptionPathPh')}
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 11,
                      background: COLORS.surface,
                      color: COLORS.text,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 6,
                      padding: '3px 6px',
                    }}
                  />
                  {reason.trim() === '' ? <Notice text={t('actions.noReason')} tone="warn" t={t} /> : null}
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <ActionButton
                      label={t('intercepts.allowOnce')}
                      tone="primary"
                      dataAction="intercept-allow-once"
                      onClick={() => submitFeedback('allow-once')}
                    />
                    <ActionButton
                      label={t('intercepts.addException')}
                      dataAction="intercept-add-exception"
                      onClick={() => submitFeedback('add-exception')}
                    />
                    <ActionButton label={t('actions.cancel')} dataAction="intercept-cancel" onClick={() => setFeedbackFor(undefined)} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Section>
      ) : null}

      {tab === 'stats' ? (
        <Section title={t('intercepts.ruleStats')} count={model.rules.length}>
          {model.rules.length === 0 ? (
            <EmptyState text={t('common.empty')} />
          ) : (
            <DataTable
              testId="rule-stats-table"
              emptyText={t('common.empty')}
              headers={[t('intercepts.header.rule'), t('intercepts.header.effect'), t('intercepts.count'), t('intercepts.header.why')]}
              rows={model.rules.map((rule) => [
                <span key="id" style={{ fontFamily: MONO_FONT }}>
                  {rule.id}
                </span>,
                <Badge
                  key="decision"
                  label={rule.decision}
                  color={rule.decision === 'deny' ? COLORS.fail : rule.decision === 'human' ? COLORS.warn : COLORS.pass}
                  dataBadge={`rule-${rule.decision}`}
                />,
                <span key="hits" style={{ fontFamily: MONO_FONT }}>
                  {rule.hits}
                </span>,
                <span key="why" style={{ color: COLORS.dim }}>
                  {rule.why}
                </span>,
              ])}
            />
          )}
        </Section>
      ) : null}

      {tab === 'coverage' ? (
        <Section title={t('intercepts.coverage')} count={model.coverage?.entries.length ?? 0}>
          {model.coverage === null ? (
            <EmptyState text={t('intercepts.coverageEmpty')} />
          ) : (
            <>
              <div style={{ fontSize: 10.5, color: COLORS.dim }}>
                {t('intercepts.coverageCheckedAt', { time: model.coverage.checkedAt })}
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 3 }}>
                {model.coverage.entries.map((entry) => (
                  <li
                    key={`${entry.tool}-${entry.category}`}
                    data-flowgate="coverage-row"
                    data-covered={entry.covered ? 'true' : 'false'}
                    style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'baseline' }}
                  >
                    <span aria-hidden="true" style={{ color: entry.covered ? COLORS.pass : COLORS.fail }}>
                      {entry.covered ? '✓' : '✗'}
                    </span>
                    <Mono>{entry.tool}</Mono>
                    <span style={{ color: COLORS.dim }}>{entry.category}</span>
                    <span style={{ color: entry.covered ? COLORS.pass : COLORS.fail }}>
                      {entry.covered ? t('intercepts.coverage.covered') : t('intercepts.coverage.uncovered')}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      ) : null}

      {tab === 'trial' ? (
        <Section title={t('intercepts.trial')}>
          <div style={{ display: 'grid', gap: 5, fontSize: 11 }}>
            <label>
              <span style={{ color: COLORS.dim, marginInlineEnd: 6 }}>{t('intercepts.trialTool')}</span>
              <input
                value={trialTool}
                onChange={(event) => setTrialTool(event.target.value)}
                aria-label={t('intercepts.trialTool')}
                style={inputStyle}
              />
            </label>
            <label>
              <span style={{ color: COLORS.dim, marginInlineEnd: 6 }}>{t('intercepts.trialPath')}</span>
              <input
                value={trialPath}
                onChange={(event) => setTrialPath(event.target.value)}
                aria-label={t('intercepts.trialPath')}
                style={inputStyle}
              />
            </label>
            <label>
              <span style={{ color: COLORS.dim, marginInlineEnd: 6 }}>{t('intercepts.trialCommand')}</span>
              <input
                value={trialCommand}
                onChange={(event) => setTrialCommand(event.target.value)}
                aria-label={t('intercepts.trialCommand')}
                style={inputStyle}
              />
            </label>
            <div style={{ display: 'flex', gap: 5 }}>
              <ActionButton
                label={t('intercepts.trialRun')}
                tone="primary"
                dataAction="rule-trial-run"
                onClick={() => setTrialDone(true)}
              />
            </div>
            {trialDone && model.rules.length === 0 ? (
              <Notice text={t('intercepts.trialUnavailable')} tone="warn" t={t} />
            ) : null}
            {trial !== null ? (
              <div data-flowgate="trial-result" data-decision={trial.decision} style={{ fontSize: 11.5 }}>
                {trial.rule !== undefined ? (
                  <span style={{ color: trial.decision === 'allow' ? COLORS.pass : COLORS.fail }}>
                    {t('intercepts.trialResultRule', {
                      rule: trial.rule.id,
                      decision: t(
                        trial.decision === 'human' ? 'intercepts.effect.human' : trial.decision === 'deny' ? 'intercepts.effect.deny' : 'intercepts.effect.allow',
                      ),
                    })}
                  </span>
                ) : (
                  <span style={{ color: COLORS.pass }}>{t('intercepts.trialResultAllow')}</span>
                )}
                <div style={{ color: COLORS.faint, fontSize: 10, marginTop: 2 }}>{t('intercepts.trialLocal')}</div>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 11,
  background: COLORS.surface,
  color: COLORS.text,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  padding: '3px 6px',
  minWidth: 220,
}
