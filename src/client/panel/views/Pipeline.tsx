/**
 * Pipeline view (FR-8.2 / T2.6 / T3.6): seven stage nodes with status, the
 * stage card for the selected stage (six parts), optional roadmap progress,
 * and the glossary in detailed learning mode.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { Badge, EmptyState, Section } from '../Common'
import { COLORS, MONO_FONT, UI_FONT } from '../../theme'
import { gateForStage, stageCardFor } from '../../model'
import { StageCard } from '../../learn/StageCard'
import { visibleParts } from '../../learn/cards'

const STAGE_STATUS_COLOR: Record<string, string> = {
  done: COLORS.pass,
  current: COLORS.info,
  pending: COLORS.dim,
  blocked: COLORS.fail,
}

export function PipelineView({ model, t }: ViewProps): React.ReactElement {
  const currentStage = model.stage
  const [selected, setSelected] = React.useState<string>(currentStage ?? 'S0')
  React.useEffect(() => {
    if (currentStage !== undefined && currentStage !== '') setSelected(currentStage)
  }, [currentStage])

  const stageNode = model.pipeline.find((node) => node.stage === selected) ?? model.pipeline[0]
  const card = stageCardFor(stageNode?.stage ?? 'S0', t)
  const gate = gateForStage(stageNode?.stage)
  const liveChecks =
    gate !== null && model.gate.gate === gate && model.gate.items.length > 0
      ? model.gate.items.map((item) => ({ label: item.label, passed: item.passed }))
      : undefined
  const parts = visibleParts(model.learning)

  if (model.pipeline.length === 0) {
    return (
      <div data-flowgate="view-pipeline">
        <Section title={t('pipeline.title')}>
          <EmptyState text={t('pipeline.empty')} />
        </Section>
      </div>
    )
  }

  return (
    <div data-flowgate="view-pipeline" style={{ display: 'grid', gap: 10 }}>
      <Section title={t('pipeline.title')} count={model.pipeline.length}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }} role="list">
          {model.pipeline.map((node) => {
            const active = node.stage === (stageNode?.stage ?? '')
            return (
              <button
                key={node.stage}
                type="button"
                role="listitem"
                data-flowgate="stage-node"
                data-stage={node.stage}
                data-stage-status={node.status}
                aria-label={t('pipeline.stageAria', {
                  stage: node.stage,
                  label: node.label,
                  status: t(
                    node.status === 'done'
                      ? 'stage.status.done'
                      : node.status === 'current'
                        ? 'stage.status.current'
                        : node.status === 'blocked'
                          ? 'stage.status.blocked'
                          : 'stage.status.pending',
                  ),
                })}
                onClick={() => setSelected(node.stage)}
                style={{
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: `1px solid ${active ? COLORS.info : COLORS.border}`,
                  background: active ? COLORS.infoBg : COLORS.surface,
                  color: STAGE_STATUS_COLOR[node.status] ?? COLORS.text,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <span aria-hidden="true" style={{ fontFamily: MONO_FONT }}>
                  {node.index}
                </span>
                <span style={{ color: active ? COLORS.text : COLORS.text }}>{node.label}</span>
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: STAGE_STATUS_COLOR[node.status] ?? COLORS.dim,
                    display: 'inline-block',
                  }}
                />
              </button>
            )
          })}
        </div>
      </Section>

      {model.roadmap !== undefined ? (
        <Section title={t('pipeline.roadmap')}>
          <div data-flowgate="roadmap" style={{ display: 'grid', gap: 4, fontSize: 11 }}>
            <div style={{ color: COLORS.dim }}>
              {t('pipeline.roadmapProgress', { done: model.roadmap.delivered, total: model.roadmap.total })}
              {model.roadmap.mvpCut !== '' ? ` · ${t('pipeline.roadmapMvp')}: ${model.roadmap.mvpCut}` : ''}
            </div>
            {model.roadmap.entries.map((entry) => (
              <div
                key={entry.change}
                data-flowgate="roadmap-entry"
                style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: COLORS.text }}
              >
                <span style={{ fontFamily: MONO_FONT }}>{entry.change}</span>
                <span>{entry.capability}</span>
                <Badge label={entry.status} dataBadge={entry.status} />
                <Badge
                  label={entry.mvp ? t('pipeline.roadmapMvp') : t('pipeline.roadmapOutside')}
                  dataBadge={entry.mvp ? 'mvp' : 'outside'}
                  color={entry.mvp ? COLORS.info : COLORS.dim}
                />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('pipeline.stageTitle', { idx: stageNode?.index ?? '', stage: stageNode?.label ?? '' })}>
        {gate !== null ? (
          <div style={{ fontSize: 10.5, color: COLORS.dim }} data-flowgate="stage-gate-label">
            {t('card.gateChecks', { gate })}
          </div>
        ) : null}
        <StageCard
          stage={stageNode?.stage ?? 'S0'}
          stageLabel={stageNode?.label ?? ''}
          index={stageNode?.index}
          card={card}
          mode={model.learning}
          t={t}
          checks={liveChecks}
        />
      </Section>

      {parts.upstream ? (
        <Section title={t('glossary.title')}>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 11, lineHeight: 1.55, color: COLORS.dim }}>
            <li>{t('glossary.gate')}</li>
            <li>{t('glossary.evidence')}</li>
            <li>{t('glossary.fresh')}</li>
            <li>{t('glossary.scope')}</li>
            <li>{t('glossary.tdd')}</li>
            <li>{t('glossary.handoff')}</li>
          </ul>
        </Section>
      ) : null}
    </div>
  )
}
