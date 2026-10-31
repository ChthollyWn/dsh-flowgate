/**
 * Subagent topology view (docs/impl/runtime-visualization.md §1).
 *
 * Renders the current session's direct children from the native
 * `subagentCatalog` projection with two native-styled modes:
 *  - graph: main session → batch columns → agent cards (horizontal scroll);
 *  - tree: main session root → collapsible batch groups → indented agent rows.
 *
 * Running state comes from the standard `useSessionStatus` map (joined into
 * the stable `runningKey` string by the Panel container), task / batch title
 * enrichment from the FlowGate projection. Pure component (only `useState`),
 * so every DOM state is SSR-renderable and testable.
 */
import React from 'react'
import type { HostBridge } from '../../bridge'
import type { FlowgateProjection } from '../../types'
import type { TFn } from '../../i18n'
import { formatDuration } from '../../runtime-model'
import type { AgentBatchModel, AgentNodeModel, AgentRole, AgentStatus, AgentsViewModel } from '../../runtime-model'
import { buildAgentsModel } from '../../runtime-model'
import type { ViewProps } from '../view-types'
import { SparkIcon } from '../../visual/icons'

export interface SubagentsRuntimeData {
  /** Raw `subagentCatalog` projection value (unknown wire data). */
  catalog?: unknown
  /** FlowGate projection used to link tasks / batches / titles / worktrees. */
  projection?: FlowgateProjection | null
  /** Per-catalog-entry `'1'/'0'` running selector result from `useSessionStatus`. */
  runningKey?: string
}

export interface SubagentsViewProps extends ViewProps {
  runtime?: SubagentsRuntimeData
  bridge?: HostBridge
  sessionId?: string
  /** Tests / preview pages: start in the requested mode. */
  defaultMode?: 'graph' | 'tree'
}

function roleLabel(role: AgentRole, t: TFn): string {
  switch (role) {
    case 'executor':
      return t('agents.role.executor')
    case 'reviewer':
      return t('agents.role.reviewer')
    case 'final-reviewer':
      return t('agents.role.finalReviewer')
    case 'investigator':
      return t('agents.role.investigator')
    default:
      return t('agents.role.subagent')
  }
}

function statusLabel(status: AgentStatus, t: TFn): string {
  switch (status) {
    case 'running':
      return t('agents.status.running')
    case 'done':
      return t('agents.status.done')
    case 'failed':
      return t('agents.status.failed')
    default:
      return t('agents.status.idle')
  }
}

/** Native StateDot semantics: running = ongoing (pulse), failed = error, done = success. */
function dotClass(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return 'fg-state-dot fg-state-dot--business fg-dot-live'
    case 'done':
      return 'fg-state-dot fg-state-dot--success'
    case 'failed':
      return 'fg-state-dot fg-state-dot--error'
    default:
      return 'fg-state-dot'
  }
}

/** Primary display text for one child (task id for executors, label otherwise). */
function nodePrimary(node: AgentNodeModel): string {
  if (node.role === 'executor' && node.taskId !== undefined) return node.taskId
  if (node.role === 'reviewer' && node.taskId !== undefined) return node.taskId
  if (node.role === 'final-reviewer' && node.kind !== undefined) return node.kind
  if (node.label !== '') return node.label
  if (node.kind !== undefined) return node.kind
  return node.id.slice(0, 10)
}

function nodeAria(node: AgentNodeModel, t: TFn): string {
  return t('agents.nodeAria', {
    role: roleLabel(node.role, t),
    label: nodePrimary(node),
    status: statusLabel(node.status, t),
  })
}

function nodeDuration(node: AgentNodeModel, t: TFn): string | undefined {
  if (node.durationMs === undefined) return undefined
  return formatDuration(node.durationMs, t)
}

interface AgentNodeViewProps {
  node: AgentNodeModel
  t: TFn
  variant: 'card' | 'row'
  onOpen?: () => void
}

function AgentNodeView({ node, t, variant, onOpen }: AgentNodeViewProps): React.ReactElement {
  const duration = nodeDuration(node, t)
  const attempt =
    node.attempt !== undefined && node.role !== 'investigator'
      ? t('agents.attempt', { attempt: node.attempt })
      : undefined
  const meta = (
    <>
      {node.worktree !== undefined ? (
        <span className="fg-agent-worktree" title={node.worktree}>
          {node.worktree}
        </span>
      ) : null}
      {duration !== undefined ? (
        <span className="fg-agent-duration" title={t('agents.duration')}>
          {duration}
        </span>
      ) : null}
    </>
  )
  const body = (
    <>
      <span className="fg-agent-line">
        <span className={dotClass(node.status)} aria-hidden="true" />
        <span className="fg-agent-role">{roleLabel(node.role, t)}</span>
        <span className="fg-agent-primary" title={nodePrimary(node)}>
          {nodePrimary(node)}
        </span>
        {attempt !== undefined ? <span className="fg-agent-attempt">{attempt}</span> : null}
      </span>
      {node.taskTitle !== undefined && node.taskTitle !== '' ? (
        <span className="fg-agent-title">{node.taskTitle}</span>
      ) : null}
      {(node.worktree !== undefined || duration !== undefined) && variant === 'card' ? (
        <span className="fg-agent-meta">{meta}</span>
      ) : null}
      {onOpen !== undefined && variant === 'card' ? (
        <span className="fg-agent-open-hint">{t('agents.open')}</span>
      ) : null}
    </>
  )
  const attrs = {
    'data-flowgate': 'agent-node',
    'data-session-id': node.id,
    'data-role': node.role,
    'data-status': node.status,
    'data-task': node.taskId ?? '',
  }
  if (variant === 'card') {
    if (onOpen !== undefined) {
      return (
        <button
          type="button"
          className="fg-agent-card fg-agent-card-button"
          data-action="agent-open"
          aria-label={t('agents.openAria', { label: nodePrimary(node) })}
          title={t('agents.openAria', { label: nodePrimary(node) })}
          onClick={onOpen}
          {...attrs}
        >
          {body}
        </button>
      )
    }
    return (
      <div className="fg-agent-card" aria-label={nodeAria(node, t)} {...attrs}>
        {body}
      </div>
    )
  }
  return (
    <div className="fg-tree-row fg-tree-node" aria-label={nodeAria(node, t)} {...attrs}>
      <span className="fg-tree-node-main">
        <span className={dotClass(node.status)} aria-hidden="true" />
        <span className="fg-agent-role">{roleLabel(node.role, t)}</span>
        <span className="fg-agent-primary" title={nodePrimary(node)}>
          {nodePrimary(node)}
        </span>
        {attempt !== undefined ? <span className="fg-agent-attempt">{attempt}</span> : null}
        {node.taskTitle !== undefined && node.taskTitle !== '' ? (
          <span className="fg-agent-title-inline">{node.taskTitle}</span>
        ) : null}
        {meta}
      </span>
      {onOpen !== undefined ? (
        <button
          type="button"
          className="fg-native-btn fg-native-btn-ghost fg-native-btn-sm"
          data-action="agent-open"
          data-session-id={node.id}
          aria-label={t('agents.openAria', { label: nodePrimary(node) })}
          onClick={onOpen}
        >
          {t('agents.open')}
        </button>
      ) : null}
    </div>
  )
}

/** One vertical workflow group: batch header + wrapping agent cards. */
function GraphGroup({
  id,
  label,
  mode,
  status,
  nodes,
  t,
  onOpen,
}: {
  id: string
  label: string
  mode?: 'sequential' | 'parallel'
  status: AgentStatus
  nodes: AgentNodeModel[]
  t: TFn
  onOpen: (node: AgentNodeModel) => void
}): React.ReactElement {
  return (
    <div className="fg-graph-group" data-flowgate="agent-batch" data-batch={id}>
      <div className="fg-graph-batch">
        <span className={dotClass(status)} aria-hidden="true" />
        <span className="fg-graph-batch-label">{label}</span>
        {mode !== undefined ? (
          <span className="fg-graph-batch-mode">{t(mode === 'parallel' ? 'tasks.parallel' : 'tasks.sequential')}</span>
        ) : null}
        <span className="fg-graph-batch-spacer" />
        <span className="fg-graph-batch-status">{statusLabel(status, t)}</span>
        <span className="fg-graph-batch-count">{nodes.length}</span>
      </div>
      <div className="fg-graph-cards">
        {nodes.map((node) => (
          <AgentNodeView key={node.id} node={node} t={t} variant="card" onOpen={() => onOpen(node)} />
        ))}
      </div>
    </div>
  )
}

/** Collapsible tree group (batch or services). */
function TreeNodeGroup({
  id,
  label,
  status,
  nodes,
  t,
  collapsed,
  onToggle,
  onOpen,
}: {
  id: string
  label: string
  status: AgentStatus
  nodes: AgentNodeModel[]
  t: TFn
  collapsed: boolean
  onToggle: () => void
  onOpen: (node: AgentNodeModel) => void
}): React.ReactElement {
  return (
    <li className="fg-tree-group" data-flowgate="agent-batch" data-batch={id}>
      <button
        type="button"
        className="fg-tree-row fg-tree-batch"
        data-flowgate="tree-toggle"
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? 'agents.expandBatch' : 'agents.collapseBatch', { batch: label })}
        onClick={onToggle}
      >
        <span className={dotClass(status)} aria-hidden="true" />
        <span className="fg-tree-chevron" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d={collapsed ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'} />
          </svg>
        </span>
        <span className="fg-tree-batch-label">{label}</span>
        <span className="fg-graph-batch-count">{nodes.length}</span>
        <span className="fg-tree-batch-status">{statusLabel(status, t)}</span>
      </button>
      {collapsed ? null : (
        <ul className="fg-tree-branch" role="group">
          {nodes.map((node) => (
            <li key={node.id}>
              <AgentNodeView node={node} t={t} variant="row" onOpen={() => onOpen(node)} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function SubagentsView({
  runtime,
  bridge,
  sessionId,
  defaultMode = 'graph',
  t,
}: SubagentsViewProps): React.ReactElement {
  const [mode, setMode] = React.useState<'graph' | 'tree'>(defaultMode)
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set<string>())
  const catalog = runtime?.catalog
  // Cheap pure model: rebuilt on render so the view stays hook-minimal
  // (useState only — SSR harness/test friendly).
  const model: AgentsViewModel = buildAgentsModel(catalog, runtime?.projection ?? null, runtime?.runningKey)
  const canOpen = bridge !== undefined && sessionId !== undefined && typeof bridge.openSubagentSession === 'function'
  const open = (node: AgentNodeModel): void => {
    if (!canOpen) return
    try {
      bridge?.openSubagentSession(sessionId as string, node.id)
    } catch {
      /* navigation is best-effort */
    }
  }
  const toggle = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div data-flowgate="view-agents" className="fg-runtime-card" style={{ display: 'grid', gap: 8 }}>
      <div className="fg-runtime-head">
        <strong className="fg-runtime-title">{t('agents.title')}</strong>
        <span data-flowgate="agents-count" data-running={model.running} data-total={model.total} className="fg-runtime-count">
          {t('agents.count', { running: model.running, total: model.total })}
        </span>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label={t('agents.modeAria')} data-flowgate="agents-mode" className="fg-seg">
          {(['graph', 'tree'] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-mode={value}
              aria-pressed={mode === value}
              className="fg-seg-btn"
              onClick={() => setMode(value)}
            >
              {t(value === 'graph' ? 'agents.graph' : 'agents.tree')}
            </button>
          ))}
        </div>
      </div>

      {!model.available ? (
        <div data-flowgate="agents-empty" data-reason="host-missing" className="fg-runtime-empty">
          <SparkIcon size={16} color="currentColor" />
          <span>{t('agents.hostMissing')}</span>
        </div>
      ) : model.nodes.length === 0 ? (
        <div data-flowgate="agents-empty" data-reason="no-agents" className="fg-runtime-empty">
          <SparkIcon size={16} color="currentColor" />
          <span>
            {t('agents.empty')}
            <small>{t('agents.emptyHint')}</small>
          </span>
        </div>
      ) : mode === 'graph' ? (
        <div data-flowgate="agents-graph" className="fg-graph" role="list" aria-label={t('agents.graphAria')}>
          <div data-flowgate="agent-root" className="fg-graph-root" role="listitem">
            <span className="fg-state-dot fg-state-dot--business" aria-hidden="true" />
            <span>{t('agents.root')}</span>
          </div>
          <div className="fg-graph-trunk" aria-hidden="true" />
          <div className="fg-graph-body" role="group">
            {model.batches.map((batch) => (
              <GraphGroup
                key={batch.id}
                id={batch.id}
                label={t('agents.batch', { batch: batch.id })}
                {...(batch.mode !== undefined ? { mode: batch.mode } : {})}
                status={batch.status}
                nodes={batch.nodes}
                t={t}
                onOpen={open}
              />
            ))}
            {model.services.length > 0 ? (
              <GraphGroup
                id="services"
                label={t('agents.services')}
                status={
                  model.services.some((node) => node.status === 'running')
                    ? 'running'
                    : model.services.some((node) => node.status === 'failed')
                      ? 'failed'
                      : model.services.every((node) => node.status === 'done')
                        ? 'done'
                        : 'idle'
                }
                nodes={model.services}
                t={t}
                onOpen={open}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <ul data-flowgate="agents-tree" className="fg-tree" role="tree" aria-label={t('agents.treeAria')}>
          <li className="fg-tree-root">
            <div data-flowgate="agent-root" className="fg-tree-row fg-tree-root-row">
              <span className="fg-state-dot fg-state-dot--business" aria-hidden="true" />
              <span>{t('agents.root')}</span>
            </div>
            <ul className="fg-tree-branch fg-tree-root-branch" role="group">
              {model.batches.map((batch) => (
                <TreeNodeGroup
                  key={batch.id}
                  id={batch.id}
                  label={t('agents.batch', { batch: batch.id })}
                  status={batch.status}
                  nodes={batch.nodes}
                  t={t}
                  collapsed={collapsed.has(batch.id)}
                  onToggle={() => toggle(batch.id)}
                  onOpen={open}
                />
              ))}
              {model.services.length > 0 ? (
                <TreeNodeGroup
                  id="services"
                  label={t('agents.services')}
                  status={model.services.some((node) => node.status === 'running') ? 'running' : 'idle'}
                  nodes={model.services}
                  t={t}
                  collapsed={collapsed.has('services')}
                  onToggle={() => toggle('services')}
                  onOpen={open}
                />
              ) : null}
            </ul>
          </li>
        </ul>
      )}
    </div>
  )
}
