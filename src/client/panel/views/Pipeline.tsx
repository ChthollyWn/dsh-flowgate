/**
 * Pipeline view — the graphical flow page (contract §3 / §1.4).
 *
 * Layout (top → bottom):
 *  1. hero: current stage glyph + progress ring (x/7) + stage name + 你在这里,
 *     all painted with native label/border tokens (no coloured wash);
 *  2. `FlowMap`: vertical seven-stage timeline with neutral gate badges,
 *     artifact chips and the next-step callout;
 *  3. stage detail: live gate checks as small semantic dots + the learning card
 *     collapsed by default (`<details>`); learning mode `off` hides the long
 *     form entirely;
 *  4. roadmap progress (when the host sends it) + glossary in detailed mode.
 *
 * The old imperative stage-chip row is replaced by `FlowMap`, but the original
 * `data-flowgate="stage-node"` / `data-stage-status` anchors are kept on the
 * clickable nodes so the existing tests could migrate incrementally.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { EmptyState, Section } from '../Common'
import { NATIVE } from '../../theme'
import { gateForStage, isHumanGate, nextStepForPanel, stageCardFor, stageIndex, stageLabel } from '../../model'
import { StageCard } from '../../learn/StageCard'
import { visibleParts } from '../../learn/cards'
import { FlowMap } from '../../visual/FlowMap'
import { AnimatedProgress } from '../../visual/Motion'
import { GateGlyph, SparkIcon, StageGlyph } from '../../visual/icons'

const FONT = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif)'
const MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'

export function PipelineView({ model, t }: ViewProps): React.ReactElement {
  const currentStage = model.stage
  const [selected, setSelected] = React.useState<string>(currentStage ?? model.pipeline[0]?.stage ?? 'S0')
  React.useEffect(() => {
    if (currentStage !== undefined && currentStage !== '') setSelected(currentStage)
  }, [currentStage])

  if (model.pipeline.length === 0) {
    return (
      <div data-flowgate="view-pipeline">
        <Section title={t('pipeline.title')}>
          <EmptyState text={t('pipeline.empty')} />
        </Section>
      </div>
    )
  }

  const heroStage = currentStage ?? model.pipeline.find((node) => node.isCurrent)?.stage ?? model.pipeline[0]?.stage ?? 'S0'
  const stageNode = model.pipeline.find((node) => node.stage === selected) ?? model.pipeline[0]
  const card = stageCardFor(stageNode?.stage ?? 'S0', t)
  const gate = gateForStage(stageNode?.stage)
  const liveChecks =
    gate !== null && model.gate.gate === gate && model.gate.items.length > 0
      ? model.gate.items.map((item) => ({ label: item.label, passed: item.passed }))
      : undefined
  const parts = visibleParts(model.learning)
  const done = model.pipeline.filter((node) => node.status === 'done').length
  const next = nextStepForPanel(model, t)

  return (
    <div data-flowgate="view-pipeline" style={{ display: 'grid', gap: 10, fontFamily: FONT }}>
      {/* 1. Hero ---------------------------------------------------------- */}
      <section
        data-flowgate="pipeline-hero"
        data-stage={heroStage}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          borderRadius: NATIVE.radiusLg,
          border: `0.5px solid ${NATIVE.borderL2}`,
          background: NATIVE.hover,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <span
          className={model.stage !== undefined ? 'fg-pulse' : undefined}
          style={{ position: 'relative', display: 'inline-flex', color: NATIVE.labelPrimary, flex: '0 0 auto' }}
          aria-hidden="true"
        >
          <StageGlyph stage={heroStage} size={30} color={NATIVE.labelPrimary} />
        </span>
        <div style={{ display: 'grid', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500, lineHeight: '22px', color: NATIVE.labelPrimary }}>
              {model.stage !== undefined
                ? `${stageIndex(model.stage, t)} ${stageLabel(model.stage, t)}`
                : stageLabel(heroStage, t)}
            </span>
            {model.stage !== undefined ? (
              <span
                data-flowgate="hero-you-are-here"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: NATIVE.labelTertiary,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 6, height: 6, borderRadius: '50%', background: NATIVE.stateBusiness }}
                />
                {t('viz.youAreHere')}
              </span>
            ) : null}
          </div>
          <div
            data-flowgate="hero-meta"
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: NATIVE.labelTertiary }}
          >
            {model.changeId !== undefined ? (
              <span style={{ fontFamily: MONO, color: NATIVE.labelTertiary }}>{model.changeId}</span>
            ) : null}
            {model.title !== undefined && model.title !== '' ? <span>{model.title}</span> : null}
            <span>{t('viz.progressLabel', { done, total: model.pipeline.length })}</span>
          </div>
        </div>
        <AnimatedProgress
          value={done}
          max={model.pipeline.length}
          size={46}
          strokeWidth={3}
          color={NATIVE.labelSecondary}
          trackColor={NATIVE.borderL2}
          label={t('viz.progressAria', { done, total: model.pipeline.length })}
        />
      </section>

      {/* 2. Vertical flow map -------------------------------------------- */}
      <Section title={t('pipeline.title')} count={model.pipeline.length}>
        <FlowMap model={model} t={t} selectedStage={selected} onSelectStage={setSelected} />
      </Section>

      {/* 3. Stage detail: live checks + collapsed learning card ---------- */}
      <Section title={t('viz.stageDetail', { idx: stageNode?.index ?? '', stage: stageNode?.label ?? '' })}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: NATIVE.labelTertiary }}>
          {gate !== null ? (
            <>
              <GateGlyph
                kind={isHumanGate(gate) ? 'human' : 'auto'}
                size={11}
                color={isHumanGate(gate) ? NATIVE.labelSecondary : NATIVE.labelTertiary}
              />
              <span data-flowgate="stage-gate-label">
                {t('card.gateChecks', { gate })}
                {isHumanGate(gate) ? ` · ${t('viz.gateHuman')}` : ` · ${t('viz.gateAuto')}`}
              </span>
            </>
          ) : null}
        </div>
        {liveChecks !== undefined ? (
          <ul
            data-flowgate="live-checks"
            style={{ listStyle: 'none', margin: '2px 0 0', padding: 0, display: 'grid', gap: 2 }}
          >
            {liveChecks.map((check) => (
              <li
                key={check.label}
                data-flowgate="live-check"
                data-passed={check.passed ? 'true' : 'false'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: NATIVE.labelSecondary,
                }}
              >
                <span
                  aria-hidden="true"
                  className={`fg-state-dot ${check.passed ? 'fg-state-dot--success' : 'fg-state-dot--warning'}`}
                />
                <span style={{ color: check.passed ? NATIVE.labelSecondary : NATIVE.labelPrimary }}>{check.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {model.learning !== 'off' ? (
          <details data-flowgate="stage-card-details" data-collapsed="true" className="fg-collapse" style={{ marginTop: 4 }}>
            <summary
              data-flowgate="stage-card-summary"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: NATIVE.labelTertiary, padding: '2px 0' }}
            >
              <SparkIcon size={11} color={NATIVE.labelTertiary} />
              <span>{t('viz.learningCard')}</span>
              <span style={{ fontSize: 11, color: NATIVE.labelCaption }}>{t('viz.learningCardHint')}</span>
            </summary>
            <StageCard
              stage={stageNode?.stage ?? 'S0'}
              stageLabel={stageNode?.label ?? ''}
              index={stageNode?.index}
              card={card}
              mode={model.learning}
              t={t}
              checks={liveChecks}
            />
          </details>
        ) : (
          <div data-flowgate="learning-off" style={{ fontSize: 11, color: NATIVE.labelTertiary, padding: '2px 0' }}>
            {t('learning.offHint')}
          </div>
        )}
        <div
          data-flowgate="stage-next-inline"
          data-kind={next.kind}
          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: NATIVE.labelTertiary, marginTop: 3 }}
        >
          <SparkIcon size={10} color={next.kind === 'human' ? NATIVE.stateWarn : NATIVE.labelTertiary} />
          <span>{next.text}</span>
        </div>
      </Section>

      {/* 4. Roadmap (optional) ------------------------------------------- */}
      {model.roadmap !== undefined ? (
        <Section title={t('pipeline.roadmap')}>
          <div data-flowgate="roadmap" style={{ display: 'grid', gap: 4, fontSize: 12, color: NATIVE.labelSecondary }}>
            <div style={{ color: NATIVE.labelTertiary }}>
              {t('pipeline.roadmapProgress', { done: model.roadmap.delivered, total: model.roadmap.total })}
              {model.roadmap.mvpCut !== '' ? ` · ${t('pipeline.roadmapMvp')}: ${model.roadmap.mvpCut}` : ''}
            </div>
            {model.roadmap.entries.map((entry) => (
              <div
                key={entry.change}
                data-flowgate="roadmap-entry"
                style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', color: NATIVE.labelSecondary }}
              >
                <span style={{ fontFamily: MONO }}>{entry.change}</span>
                <span>{entry.capability}</span>
                <span data-flowgate="roadmap-status" data-status={entry.status} style={{ color: NATIVE.labelTertiary }}>
                  {entry.status}
                </span>
                <span
                  data-flowgate="roadmap-mvp"
                  style={{
                    fontSize: 10.5,
                    lineHeight: '16px',
                    color: NATIVE.labelTertiary,
                    border: `0.5px solid ${NATIVE.borderL2}`,
                    borderRadius: 'var(--dsw-radius-xs, 4px)',
                    padding: '0 5px',
                  }}
                >
                  {entry.mvp ? t('pipeline.roadmapMvp') : t('pipeline.roadmapOutside')}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* 5. Glossary (detailed learning mode only) ------------------------ */}
      {parts.upstream ? (
        <Section title={t('glossary.title')}>
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 11.5, lineHeight: 1.55, color: NATIVE.labelTertiary }}>
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
