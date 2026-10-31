/**
 * Compact seven-stage rail (contract §1.1 / §1.2).
 *
 * One graphic row: a glyph per stage, solid traversed links, flowing dashed
 * links for the segment in progress and a breathing ring on the current stage.
 * Used by the input dock (default `sm`) and the panel header (`md`), so the
 * owner sees "where am I" in every surface without reading a status sentence.
 *
 * Pure component: no hooks, no DOM access → SSR-renderable.
 */
import { Fragment } from 'react'
import type { ReactElement } from 'react'
import type { TFn } from '../i18n'
import type { DockState, StageNodeModel } from '../model'
import { gateForStage } from '../model'
import { NATIVE } from '../theme'
import { GateGlyph, StageGlyph } from './icons'

export interface FlowRailProps {
  nodes: StageNodeModel[]
  /** Current dock state (colors / animation intensity). */
  state: DockState
  t: TFn
  /** Human gate waiting for the owner, highlighted on its stage node. */
  awaitingGate?: string
  /** When provided, every node becomes a keyboard-focusable button. */
  onSelectStage?: (stage: string) => void
  /** `sm` = input dock, `md` = panel header. */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Neutral rail palette (contract §1.4): semantic colour is reserved for the
 * awaiting-gate marker; stages are primary / secondary / dimmed labels.
 */
const STATUS_COLOR: Record<StageNodeModel['status'], string> = {
  done: NATIVE.labelSecondary,
  current: NATIVE.labelPrimary,
  pending: NATIVE.labelCaption,
  blocked: NATIVE.stateError,
}

function statusLabel(node: StageNodeModel, t: TFn): string {
  switch (node.status) {
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

function RailLink({
  kind,
  color,
}: {
  kind: 'done' | 'active' | 'pending'
  color: string
}): ReactElement {
  const dashed = kind !== 'done'
  return (
    <svg
      data-flowgate="rail-link"
      data-link-kind={kind}
      className={kind === 'active' ? 'fg-dash' : undefined}
      width={14}
      height={8}
      viewBox="0 0 14 8"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{ flex: '1 1 8px', minWidth: 4, maxWidth: 26, height: 8, overflow: 'visible' }}
    >
      <line
        x1={0}
        y1={4}
        x2={14}
        y2={4}
        stroke={color}
        strokeWidth={1}
        strokeLinecap="round"
        strokeDasharray={dashed ? '3 3' : undefined}
        opacity={kind === 'active' ? 0.5 : kind === 'pending' ? 0.8 : 0.9}
      />
    </svg>
  )
}

export function FlowRail({
  nodes,
  state,
  t,
  awaitingGate,
  onSelectStage,
  size = 'sm',
  className,
}: FlowRailProps): ReactElement {
  const glyphSize = size === 'md' ? 16 : 14
  const currentIndex = nodes.findIndex((node) => node.status === 'current' || node.isCurrent)
  const classes = ['fg-flow-rail', className].filter((entry): entry is string => entry !== undefined)
  return (
    <div
      data-flowgate="flow-rail"
      data-state={state}
      data-size={size}
      className={classes.join(' ')}
      role="group"
      aria-label={t('viz.railAria')}
      style={{ minWidth: 0 }}
    >
      {nodes.map((node, index) => {
        const current = node.status === 'current' || node.isCurrent
        const color = STATUS_COLOR[node.status] ?? NATIVE.labelCaption
        const gate = gateForStage(node.stage)
        const awaiting = awaitingGate !== undefined && awaitingGate === gate
        const label = `${node.label} · ${statusLabel(node, t)}${awaiting ? ` · ${t('viz.awaitingBadge')}` : ''}`
        const nodeData = {
          'data-flowgate': 'rail-node',
          'data-stage': node.stage,
          'data-status': node.status,
          'data-current': current ? 'true' : 'false',
          ...(gate !== null ? { 'data-gate': gate } : {}),
          ...(awaiting ? { 'data-awaiting': 'true' } : {}),
        }
        const content = (
          <span
            className={current ? 'fg-pulse' : undefined}
            style={{
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: glyphSize + 4,
              height: glyphSize + 4,
              color,
            }}
          >
            <StageGlyph stage={node.stage} size={glyphSize} color={color} />
            {awaiting ? (
              <span style={{ position: 'absolute', right: -5, top: -5, display: 'inline-flex' }} aria-hidden="true">
                <GateGlyph kind="human" size={8} color={NATIVE.stateWarn} />
              </span>
            ) : null}
          </span>
        )
        // Link into this node: up to the current stage = solid (traversed),
        // the segment leaving it = flowing dashes while the flow is live.
        const flowingState = state === 'active' || state === 'awaiting' || state === 'pending'
        const traversed = currentIndex >= 0 && index <= currentIndex
        const linkKind: 'done' | 'active' | 'pending' =
          index === 0
            ? 'pending'
            : traversed
              ? 'done'
              : flowingState && currentIndex >= 0 && index === currentIndex + 1
                ? 'active'
                : 'pending'
        const linkColor =
          linkKind === 'done' ? NATIVE.borderL3 : linkKind === 'active' ? NATIVE.stateBusiness : NATIVE.borderL2
        return (
          <Fragment key={node.stage}>
            {index > 0 ? <RailLink kind={linkKind} color={linkColor} /> : null}
            {onSelectStage !== undefined ? (
              <button
                type="button"
                className="fg-rail-node"
                title={label}
                aria-label={t('viz.railNodeAria', {
                  stage: node.index,
                  label: node.label,
                  status: statusLabel(node, t),
                })}
                onClick={() => onSelectStage(node.stage)}
                {...nodeData}
              >
                {content}
              </button>
            ) : (
              <span className="fg-rail-node" title={label} role="img" aria-label={label} {...nodeData}>
                {content}
              </span>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
