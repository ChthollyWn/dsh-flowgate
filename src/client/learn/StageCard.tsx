/**
 * Learning card for one pipeline stage (FR-8.3 / T5.2).
 *
 * Renders the six required parts (做什么 / 为什么 / 合格标准 / 产物 / 方法来源 /
 * 常见反模式 + 正反例) according to the learning mode:
 *   - detail: everything
 *   - brief:  what / why / criteria / artifacts
 *   - off:    artifacts only (stage name comes from the surrounding view)
 *
 * Pure component: no DOM / window access, so it renders under
 * `react-dom/server` for SSR tests.
 */
import React from 'react'
import type { TFn } from '../i18n'
import type { LearningMode } from '../types'
import type { ClientStageCard } from './cards'
import { visibleParts } from './cards'
import { COLORS, MONO_FONT, UI_FONT } from '../theme'

export interface StageCriteriaCheck {
  label: string
  passed: boolean
}

export interface StageCardProps {
  stage: string
  stageLabel: string
  index?: string
  card: ClientStageCard
  mode: LearningMode
  t: TFn
  /** Live gate check items for the current stage (renders ✓ / ✗). */
  checks?: StageCriteriaCheck[]
  /** When true, the card is displayed without the outer heading. */
  compact?: boolean
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: COLORS.dim,
  margin: '12px 0 4px',
}

const bodyStyle: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.55,
  color: COLORS.text,
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const listStyle: React.CSSProperties = {
  ...bodyStyle,
  margin: 0,
  paddingInlineStart: 18,
}

export function StageCard(props: StageCardProps): React.ReactElement {
  const { card, mode, t, checks, compact } = props
  const parts = visibleParts(mode)
  const heading = `${props.index !== undefined ? `${props.index} ` : ''}${props.stageLabel}`
  const checkRows = Array.isArray(checks) && checks.length > 0 ? checks : null

  return (
    <section
      data-flowgate="stage-card"
      data-stage={props.stage}
      data-learning-mode={mode}
      aria-label={t('panel.stageCardTitle', { stage: props.stageLabel })}
      style={{
        fontFamily: UI_FONT,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: compact === true ? '10px 12px' : '12px 14px',
        background: COLORS.surface,
        display: 'grid',
        gap: 2,
      }}
    >
      {compact !== true ? (
        <h3 style={{ margin: 0, fontSize: 14, lineHeight: 1.35, color: COLORS.text }} data-flowgate="stage-card-heading">
          {heading}
        </h3>
      ) : null}

      {parts.what ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.what')}</h4>
          <p style={bodyStyle} data-flowgate="stage-card-what">
            {card.what}
          </p>
        </>
      ) : null}

      {parts.why ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.why')}</h4>
          <p style={bodyStyle} data-flowgate="stage-card-why">
            {card.why}
          </p>
        </>
      ) : null}

      {parts.criteria ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.criteria')}</h4>
          {checkRows !== null ? (
            <ul style={{ ...listStyle, listStyle: 'none', paddingInlineStart: 0 }} data-flowgate="stage-card-live-checks">
              {checkRows.map((check, index) => (
                <li
                  key={`${index}-${check.label}`}
                  data-check-passed={check.passed ? 'true' : 'false'}
                  style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: check.passed ? COLORS.pass : COLORS.fail }}
                >
                  <span aria-hidden="true" style={{ fontFamily: MONO_FONT }}>
                    {check.passed ? '✓' : '✗'}
                  </span>
                  <span style={{ ...bodyStyle, color: COLORS.text }}>{check.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ul style={listStyle} data-flowgate="stage-card-criteria">
              {card.criteria.map((criterion, index) => (
                <li key={`${index}-${criterion}`} style={{ color: COLORS.text }}>
                  {criterion}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {parts.artifacts ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.artifacts')}</h4>
          <p style={{ ...bodyStyle, fontFamily: MONO_FONT, fontSize: 11.5 }} data-flowgate="stage-card-artifacts">
            {card.artifacts.join(' · ')}
          </p>
        </>
      ) : null}

      {parts.upstream ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.upstream')}</h4>
          <p style={{ ...bodyStyle, color: COLORS.dim }} data-flowgate="stage-card-upstream">
            {card.upstream}
          </p>
        </>
      ) : null}

      {parts.antiPatterns ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.antiPatterns')}</h4>
          <ul style={listStyle} data-flowgate="stage-card-antipatterns">
            {card.antiPatterns.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}

      {parts.examples ? (
        <>
          <h4 style={sectionTitleStyle}>{t('card.examples')}</h4>
          <p style={{ ...bodyStyle, color: COLORS.pass }} data-flowgate="stage-card-good">
            <strong style={{ marginInlineEnd: 6 }}>{t('card.good')}</strong>
            {card.good}
          </p>
          <p style={{ ...bodyStyle, color: COLORS.fail }} data-flowgate="stage-card-bad">
            <strong style={{ marginInlineEnd: 6 }}>{t('card.bad')}</strong>
            {card.bad}
          </p>
        </>
      ) : null}
    </section>
  )
}
