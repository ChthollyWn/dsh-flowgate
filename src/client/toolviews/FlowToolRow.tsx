/**
 * Conversation row for FlowGate model tool calls (`tool.call.toolview`).
 *
 * Rendered by DSH for every atomic call whose wire name we registered. The row
 * shows: a leading glyph, the wire tool name (plain text, not localized), a
 * mini seven-stage rail (current stage pulses, done stages solid, future stages
 * dashed — all motion gated on `prefers-reduced-motion`), and one status line
 * composed from the session projection (`pipeline` + `awaitingGate` + pending
 * count) and the tool call lifecycle (`preparing` / `start` / `result`).
 *
 * Defensive by construction: this component renders inside the transcript, so
 * any malformed projection / call block degrades to a single safe line instead
 * of throwing (DOM contract: `data-flowgate="flow-toolview"`, optional
 * `data-flowgate="flow-rail"` with `rail-node` children — see
 * docs/impl/ui-interaction-redesign.md §1.2).
 *
 * No `@deepseek-ai/*` import: the slot kit arrives as props.
 */
import React from 'react'
import type { FlowToolNodeModel, FlowToolRowProps, FlowToolViewModel } from './viewmodel'
import {
  asPlainRecord,
  buildFlowToolViewModel,
  fallbackViewModel,
  readFlowProjection,
  safeToolName,
  safeTranslator,
} from './viewmodel'

/** Status → accent color for the mini rail (plain literals: no theme import). */
const NODE_COLORS: Record<FlowToolNodeModel['status'], string> = {
  done: '#16a34a',
  current: '#2563eb',
  pending: '#8b8f98',
  blocked: '#e5484d',
}

const TONE_COLORS: Record<FlowToolViewModel['tone'], string> = {
  blocked: '#e5484d',
  attention: '#d97706',
  active: '#2563eb',
  idle: '#8b8f98',
  disabled: '#9ca3af',
}

const MONO_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/** Node glyph: graphic-first, no localized text needed. */
function nodeGlyph(node: FlowToolNodeModel): string {
  switch (node.status) {
    case 'done':
      return '✓'
    case 'blocked':
      return '✕'
    case 'current':
      return '◆'
    default:
      return ''
  }
}

function nodeStyle(node: FlowToolNodeModel): React.CSSProperties {
  const color = NODE_COLORS[node.status]
  return {
    color,
    borderColor: color,
    borderStyle: node.status === 'pending' ? 'dashed' : 'solid',
    opacity: node.status === 'pending' ? 0.55 : node.status === 'done' ? 0.85 : 1,
    fontWeight: node.isCurrent ? 600 : 400,
  }
}

function linkStyle(status: FlowToolNodeModel['status']): React.CSSProperties {
  return { color: status === 'pending' ? NODE_COLORS.pending : NODE_COLORS.current }
}

/** Pure presentational row (exported so tests can render the model directly). */
export function FlowToolRowView({ model }: { model: FlowToolViewModel }): React.ReactElement {
  const railLabel = model.nodes
    .map((node) => node.label)
    .filter((label) => label !== '')
    .join(' → ')
  return (
    <div
      data-flowgate="flow-toolview"
      data-tool={model.toolName}
      data-phase={model.phase}
      data-state={model.state}
      data-tone={model.tone}
      data-projected={model.projected ? 'true' : 'false'}
      data-initialized={model.initialized ? 'true' : 'false'}
      data-has-rail={model.hasRail ? 'true' : 'false'}
      data-stage={model.stage}
      data-stage-gate={model.stageGate}
      data-gate={model.gate}
      data-change={model.changeId}
      data-pending={model.pendingCount > 0 ? String(model.pendingCount) : undefined}
      className="fg-tv-root"
      role="group"
      aria-label={model.ariaLabel}
      title={model.ariaLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        maxWidth: '100%',
        lineHeight: '20px',
        fontSize: 12,
      }}
    >
      <span
        aria-hidden="true"
        data-flowgate="flow-toolview-glyph"
        className="fg-tv-glyph"
        style={{ flex: '0 0 auto', fontSize: 10, lineHeight: 1, opacity: 0.72, color: TONE_COLORS[model.tone] }}
      >
        ◆
      </span>
      <span
        data-flowgate="flow-toolview-title"
        className="fg-tv-title"
        style={{
          flex: '0 0 auto',
          maxWidth: '46%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: MONO_FONT,
          fontSize: 11.5,
          opacity: 0.92,
        }}
      >
        {model.toolName}
      </span>
      {model.hasRail ? (
        <span
          data-flowgate="flow-rail"
          className="fg-tv-rail"
          role="img"
          aria-label={railLabel}
          style={{ display: 'inline-flex', alignItems: 'center', flex: '0 1 auto', minWidth: 0 }}
        >
          {model.nodes.map((node, index) => {
            const previous = index > 0 ? model.nodes[index - 1] : undefined
            const linkStatus: FlowToolNodeModel['status'] =
              previous === undefined ? 'pending' : previous.status === 'pending' ? 'pending' : previous.status
            return (
              <React.Fragment key={node.stage}>
                {index > 0 ? (
                  <span
                    aria-hidden="true"
                    data-flowgate="rail-link"
                    data-status={linkStatus}
                    className="fg-tv-link"
                    style={{ display: 'inline-block', flex: '0 0 auto', width: 8, height: 0, margin: '0 1px', borderTop: '1px dashed currentColor', ...linkStyle(linkStatus) }}
                  />
                ) : null}
                <span
                  data-flowgate="rail-node"
                  data-stage={node.stage}
                  data-status={node.status}
                  data-current={node.isCurrent ? 'true' : 'false'}
                  className="fg-tv-node"
                  title={node.label}
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: '0 0 auto',
                    width: 14,
                    height: 14,
                    boxSizing: 'border-box',
                    borderRadius: 999,
                    borderWidth: 1,
                    borderStyle: node.status === 'pending' ? 'dashed' : 'solid',
                    fontSize: 9,
                    lineHeight: 1,
                    fontFamily: MONO_FONT,
                    ...nodeStyle(node),
                  }}
                >
                  <span aria-hidden="true">{nodeGlyph(node)}</span>
                </span>
              </React.Fragment>
            )
          })}
        </span>
      ) : null}
      <span
        data-flowgate="flow-toolview-status"
        className="fg-tv-status"
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11.5,
          opacity: 0.82,
        }}
      >
        {model.statusText}
      </span>
    </div>
  )
}

/**
 * Slot component. Reads the owner props + session standard kit defensively:
 * 1. never throws (a crash here would take down the transcript render),
 * 2. falls back to a one-line row when the projection is absent or malformed,
 * 3. keeps the hook call shape stable (one `useProjection` read when present).
 */
export function FlowToolRow(rawProps: FlowToolRowProps): React.ReactElement {
  let model: FlowToolViewModel
  try {
    const props = asPlainRecord(rawProps) ?? {}
    const t = safeTranslator(props['t'])
    const projection = readFlowProjection(props as FlowToolRowProps)
    model = buildFlowToolViewModel({
      toolName: props['toolName'],
      phase: props['phase'],
      block: props['block'],
      projection,
      t,
    })
  } catch {
    // Last-resort guard: horrible payloads still render one safe line.
    model = fallbackViewModel(safeToolName(asPlainRecord(rawProps)?.['toolName']), safeTranslator(undefined))
  }
  return <FlowToolRowView model={model} />
}
