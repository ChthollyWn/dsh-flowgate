/**
 * Large graphical flow map for the panel Pipeline view (contract §1.1 / §3 /
 * §1.4): vertical seven-stage timeline with native neutral tokens.
 *
 * Stage glyph + label on the left rail, a clickable row per stage carrying the
 * gate badge (human shield / automatic spark), artifact chips and the
 * “你在这里” marker. The current stage breathes (`fg-pulse`), traversed links
 * are solid border tokens, future stages sit on dimmed labels, and a next-step
 * callout closes the map with an arrow + short icon + one natural-language
 * phrase (never a command).
 *
 * Pure component: no hooks / DOM access → SSR-renderable and testable.
 */
import type { ReactElement } from 'react'
import type { TFn } from '../i18n'
import type { PanelModel } from '../model'
import { gateForStage, gateStateLabel, isHumanGate, nextStepForPanel, stageArtifacts } from '../model'
import { NATIVE } from '../theme'
import { ArrowIcon, GateGlyph, ShieldIcon, SparkIcon, StageGlyph } from './icons'

export interface FlowMapProps {
  model: PanelModel
  t: TFn
  /** Currently opened stage detail (defaults to the current stage). */
  selectedStage?: string
  onSelectStage?: (stage: string) => void
}

const STATUS_COLOR: Record<string, string> = {
  done: NATIVE.labelSecondary,
  current: NATIVE.labelPrimary,
  pending: NATIVE.labelCaption,
  blocked: NATIVE.stateError,
}

function stageStatusLabel(status: string, t: TFn): string {
  switch (status) {
    case 'done':
      return t('stage.status.done')
    case 'current':
      return t('stage.status.current')
    case 'blocked':
      return t('stage.status.blocked')
    default:
      return t('stage.status.pending')
  }
}

export function FlowMap({ model, t, selectedStage, onSelectStage }: FlowMapProps): ReactElement {
  const current = model.stage
  const next = nextStepForPanel(model, t)
  const lastIndex = model.pipeline.length - 1
  const token = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif)'
  return (
    <section
      data-flowgate="flow-map"
      data-stage-count={model.pipeline.length}
      aria-label={t('viz.mapAria')}
      style={{ display: 'grid', gap: 2, minWidth: 0, fontFamily: token }}
    >
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {model.pipeline.map((node, index) => {
          const isHere = node.isCurrent || (current !== undefined && node.stage === current)
          const gate = gateForStage(node.stage)
          const human = isHumanGate(gate)
          const gateState =
            model.gate.gate !== null && model.gate.gate === gate
              ? model.gate.state
              : node.status === 'done'
                ? 'passed'
                : node.status === 'blocked'
                  ? 'failed'
                  : 'pending'
          const artifacts = stageArtifacts(node.stage, t).slice(0, 2)
          const selected = selectedStage !== undefined ? selectedStage === node.stage : isHere
          const color = STATUS_COLOR[node.status] ?? NATIVE.labelCaption
          const previousDone = index > 0 && model.pipeline[index - 1]?.status === 'done'
          const gateColor = gateState === 'awaiting' ? NATIVE.stateWarn : NATIVE.labelTertiary
          return (
            <li
              key={node.stage}
              data-flowgate="flow-map-node"
              data-stage={node.stage}
              data-status={node.status}
              data-you-are-here={isHere ? 'true' : 'false'}
              data-gate={gate ?? undefined}
              data-gate-state={gateState}
              style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', columnGap: 8 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }} aria-hidden="true">
                {index > 0 ? (
                  <span
                    data-flowgate="flow-map-link"
                    data-done={previousDone ? 'true' : 'false'}
                    style={{ width: 1, height: 8, background: previousDone ? NATIVE.borderL3 : NATIVE.borderL2 }}
                  />
                ) : null}
                <span
                  data-flowgate="flow-map-glyph"
                  className={isHere ? 'fg-pulse' : undefined}
                  style={{ position: 'relative', display: 'inline-flex', color }}
                >
                  <StageGlyph stage={node.stage} size={isHere ? 18 : 16} color={color} />
                </span>
                {index < lastIndex ? (
                  <span
                    style={{
                      width: 1,
                      flex: '1 1 auto',
                      minHeight: 12,
                      background: node.status === 'done' ? NATIVE.borderL3 : NATIVE.borderL2,
                    }}
                  />
                ) : null}
              </div>
              <button
                type="button"
                className="fg-map-node"
                data-flowgate="stage-node"
                data-stage={node.stage}
                data-stage-status={node.status}
                aria-pressed={selected}
                aria-label={t('pipeline.stageAria', {
                  stage: node.stage,
                  label: node.label,
                  status: stageStatusLabel(node.status, t),
                })}
                onClick={() => onSelectStage?.(node.stage)}
                style={{
                  background: selected ? NATIVE.hover : 'transparent',
                  border: `0.5px solid ${selected ? NATIVE.borderL2 : 'transparent'}`,
                  opacity: node.status === 'pending' && !isHere ? 0.85 : 1,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: NATIVE.labelTertiary, fontVariantNumeric: 'tabular-nums' }}>
                    {node.index}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: isHere ? 500 : 400,
                      color: isHere ? NATIVE.labelPrimary : NATIVE.labelSecondary,
                    }}
                  >
                    {node.label}
                  </span>
                  {isHere ? (
                    <span
                      data-flowgate="you-are-here"
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
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: NATIVE.stateBusiness,
                          display: 'inline-block',
                        }}
                      />
                      {t('viz.youAreHere')}
                    </span>
                  ) : null}
                  <span style={{ flex: 1 }} />
                  <span
                    data-flowgate="gate-badge"
                    data-gate={gate ?? undefined}
                    data-gate-kind={human ? 'human' : 'auto'}
                    data-gate-state={gateState}
                    title={human ? t('viz.gateHuman') : t('viz.gateAuto')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 11,
                      lineHeight: '16px',
                      color: NATIVE.labelTertiary,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <GateGlyph kind={human ? 'human' : 'auto'} size={11} color={gateColor} />
                    <span>{gate ?? ''}</span>
                    <span>{gateStateLabel(gateState, t)}</span>
                  </span>
                </span>
                <span
                  data-flowgate="map-artifacts"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 2 }}
                >
                  <span style={{ fontSize: 10.5, color: NATIVE.labelCaption }}>{t('pipeline.artifacts')}</span>
                  {artifacts.map((artifact) => (
                    <span key={artifact} data-flowgate="artifact-chip" className="fg-artifact-chip" title={artifact}>
                      {artifact}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      <div data-flowgate="next-step-callout" data-kind={next.kind} className="fg-callout">
        <ArrowIcon className="fg-arrow" size={14} color={NATIVE.labelTertiary} />
        {next.kind === 'human' ? (
          <ShieldIcon size={13} color={NATIVE.stateWarn} />
        ) : (
          <SparkIcon size={13} color={NATIVE.labelTertiary} />
        )}
        <span style={{ minWidth: 0 }}>{next.text}</span>
      </div>
    </section>
  )
}
