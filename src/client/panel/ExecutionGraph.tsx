/**
 * Execution-plan diagram (T2.9 / T5.1): batches (sequential / parallel),
 * task nodes whose color follows status, and one integration checkpoint per
 * batch. Rendered as inline SVG with a deterministic layout computed by
 * `buildExecutionGraph` (pure, tested under SSR), so the browser bundle needs
 * no diagram library.
 */
import React from 'react'
import type { TFn } from '../i18n'
import type { ExecutionGraphModel, ExecutionNodeModel } from '../model'
import { COLORS, MONO_FONT, UI_FONT, taskColor } from '../theme'

export interface ExecutionGraphProps {
  graph: ExecutionGraphModel
  t: TFn
  /** Height cap for very tall parallel batches. */
  maxHeight?: number
}

const NODE_RADIUS = 6
const CP_RADIUS = 7

function textFor(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

function edgePath(x1: number, y1: number, x2: number, y2: number, elbow: boolean): string {
  if (!elbow || Math.abs(y1 - y2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`
  const midX = x1 + (x2 - x1) / 2
  return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`
}

function batchStatusColor(status: string): string {
  switch (status) {
    case 'done':
      return COLORS.pass
    case 'running':
      return COLORS.info
    case 'checkpoint':
      return COLORS.warn
    case 'failed':
    case 'blocked':
      return COLORS.fail
    default:
      return COLORS.dim
  }
}

export function ExecutionGraph({ graph, t, maxHeight = 420 }: ExecutionGraphProps): React.ReactElement {
  if (graph.empty) {
    return (
      <div data-flowgate="execution-graph-empty" style={{ fontFamily: UI_FONT, fontSize: 11.5, color: COLORS.dim }}>
        {t('tasks.graphEmpty')}
      </div>
    )
  }
  const width = Math.max(graph.width, 320)
  const height = Math.max(graph.height, 60)
  const clipped = height > maxHeight
  return (
    <div data-flowgate="execution-graph" style={{ fontFamily: UI_FONT }}>
      <div
        style={{
          overflowX: 'auto',
          overflowY: clipped ? 'auto' : 'visible',
          maxHeight: clipped ? maxHeight : undefined,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          background: COLORS.surface,
          padding: 2,
        }}
      >
        <svg
          role="img"
          aria-label={t('tasks.graphAria', { n: graph.nodes.length, b: graph.batches.length })}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          data-node-count={graph.nodes.length}
          data-batch-count={graph.batches.length}
          style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
        >
          {/* Batch containers. */}
          {graph.batches.map((batch) => (
            <g key={`batch-${batch.id}`} data-batch-id={batch.id} data-batch-mode={batch.mode} data-batch-status={batch.status}>
              <rect
                x={batch.x}
                y={batch.y}
                width={batch.width}
                height={batch.height}
                rx={8}
                fill={COLORS.surface}
                stroke={batchStatusColor(batch.status)}
                strokeOpacity={0.4}
                strokeDasharray={batch.mode === 'parallel' ? '4 3' : undefined}
              />
              <text
                x={batch.x + 8}
                y={batch.y + batch.height / 2 + 3}
                fontSize={10}
                fill={COLORS.dim}
                fontFamily={MONO_FONT}
              >
                {textFor(batch.id, 10)}
              </text>
              <text
                x={batch.x + 8}
                y={batch.y + batch.height / 2 + 14}
                fontSize={8.5}
                fill={COLORS.faint}
                fontFamily={UI_FONT}
              >
                {batch.mode === 'parallel' ? t('tasks.parallel') : t('tasks.sequential')}
              </text>
            </g>
          ))}

          {/* Edges. */}
          {graph.edges.map((edge) => {
            const isCheckpoint = edge.kind === 'checkpoint'
            const color = edge.kind === 'parallel' ? COLORS.info : isCheckpoint ? COLORS.warn : COLORS.dim
            return (
              <path
                key={`edge-${edge.id}`}
                data-edge-kind={edge.kind}
                d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2, edge.kind !== 'sequence' || edge.y1 !== edge.y2)}
                fill="none"
                stroke={color}
                strokeWidth={isCheckpoint ? 1.5 : 1}
                strokeDasharray={edge.kind === 'checkpoint' ? '2 3' : edge.kind === 'parallel' ? '3 2' : undefined}
                markerEnd={undefined}
                opacity={0.85}
              />
            )
          })}

          {/* Task nodes. */}
          {graph.nodes.map((node) => (
            <TaskNode key={`node-${node.batch}-${node.id}`} node={node} />
          ))}

          {/* Integration checkpoints. */}
          {graph.batches.map((batch) =>
            batch.checkpoint === null ? null : (
              <g key={`cp-${batch.id}`} data-checkpoint={batch.id} data-checkpoint-status={batch.checkpoint.status}>
                <circle
                  cx={batch.checkpoint.x}
                  cy={batch.checkpoint.y}
                  r={CP_RADIUS}
                  fill={COLORS.surfaceStrong}
                  stroke={batchStatusColor(batch.checkpoint.status)}
                  strokeWidth={1.5}
                />
                <text
                  x={batch.checkpoint.x}
                  y={batch.checkpoint.y + 3}
                  fontSize={8}
                  textAnchor="middle"
                  fill={batchStatusColor(batch.checkpoint.status)}
                  fontFamily={MONO_FONT}
                >
                  ✓
                </text>
              </g>
            ),
          )}
        </svg>
      </div>
      <GraphLegend t={t} />
    </div>
  )
}

function TaskNode({ node }: { node: ExecutionNodeModel }): React.ReactElement {
  const color = taskColor(node.status)
  return (
    <g data-node-id={node.id} data-node-status={node.status} data-node-batch={node.batch}>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={NODE_RADIUS}
        fill={COLORS.surfaceStrong}
        stroke={color}
        strokeWidth={1.2}
      />
      <rect x={node.x} y={node.y} width={4} height={node.height} rx={2} fill={color} />
      <text x={node.x + 10} y={node.y + 15} fontSize={10} fill={COLORS.text} fontFamily={MONO_FONT}>
        {textFor(node.id, 16)}
      </text>
      <text x={node.x + 10} y={node.y + 29} fontSize={8.5} fill={color} fontFamily={UI_FONT}>
        {textFor(node.worktree !== undefined && node.worktree !== '' ? node.worktree : node.agent ?? node.status, 32)}
      </text>
    </g>
  )
}

function GraphLegend({ t }: { t: TFn }): React.ReactElement {
  const items: { label: string; color: string }[] = [
    { label: t('tasks.status.pending'), color: COLORS.dim },
    { label: t('tasks.status.running'), color: COLORS.info },
    { label: t('tasks.status.done'), color: COLORS.pass },
    { label: t('tasks.status.blocked'), color: COLORS.fail },
    { label: t('tasks.checkpoint'), color: COLORS.warn },
  ]
  return (
    <div
      data-flowgate="graph-legend"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4, fontSize: 10, color: COLORS.dim }}
    >
      <span>{t('tasks.legend')}：</span>
      {items.map((item) => (
        <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            aria-hidden="true"
            style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, display: 'inline-block' }}
          />
          {item.label}
        </span>
      ))}
    </div>
  )
}
