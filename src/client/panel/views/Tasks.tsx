/**
 * Tasks view (FR-8.2 / T3.6 / T5.1): live execution-plan diagram plus the task
 * board (todo / running / review / done / blocked). Cards show TDD badges
 * (RED/GREEN), evidence freshness, review findings, sub-agent status and
 * worktree. Selecting a graph node or task card highlights it and expands the
 * task-detail block (status / batch / TDD / evidence / findings / scope /
 * new_files / verify groups / worktree / agent). Every owner-decidable pending
 * item (scope / risk / plan / rule / conflict / blocker) gets its approve/reject
 * (or unblock) entry here. v0.2 interaction contract: the buttons are the
 * decision — `performAction` submits the equivalent host command through
 * `bridge.runCommand` (click = authorization; the composer is never filled).
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, EmptyState, Mono, Notice, Section } from '../Common'
import { COLORS, MONO_FONT, UI_FONT, taskColor } from '../../theme'
import { ExecutionGraph } from '../ExecutionGraph'
import type { TaskCardModel } from '../../model'
import { taskStatusLabel } from '../../model'
import type { ClientAction } from '../../actions'
import type { MessageKey } from '../../i18n'
import type { PendingItem } from '../../../core/types'

const BOARD_COLUMNS: { key: 'todo' | 'running' | 'review' | 'done' | 'blocked'; titleKey: 'tasks.board.todo' | 'tasks.board.running' | 'tasks.board.review' | 'tasks.board.done' | 'tasks.board.blocked' }[] = [
  { key: 'todo', titleKey: 'tasks.board.todo' },
  { key: 'running', titleKey: 'tasks.board.running' },
  { key: 'review', titleKey: 'tasks.board.review' },
  { key: 'done', titleKey: 'tasks.board.done' },
  { key: 'blocked', titleKey: 'tasks.board.blocked' },
]

/**
 * Pending kinds an owner can decide from this view. `override`/`exception`
 * exist only as ids allocated by the engine and never appear as open pending
 * items, so they get no entry here.
 */
export const OWNER_PENDING_KINDS = ['scope', 'risk', 'plan', 'rule', 'conflict', 'blocker'] as const
export type OwnerPendingKind = (typeof OWNER_PENDING_KINDS)[number]

const PENDING_KIND_LABEL: Record<OwnerPendingKind, MessageKey> = {
  scope: 'tasks.approveScope',
  risk: 'tasks.pending.risk',
  plan: 'tasks.pending.plan',
  rule: 'tasks.pending.rule',
  conflict: 'tasks.conflict',
  blocker: 'tasks.pending.blocker',
}

/** True for open pending items this view can offer an owner entry for. */
export function isOwnerPendingItem(item: PendingItem): boolean {
  return item.status === 'open' && (OWNER_PENDING_KINDS as readonly string[]).includes(item.kind)
}

/**
 * Pure mapping from one pending item + decision to the client action. Blockers
 * are cleared through the `unblock` action (wire form `/flow unblock`); every
 * other kind goes through the `approve-pending` / `reject-pending` family
 * mapping in `../../actions`. The click executes the wire form directly.
 */
export function pendingDecisionAction(
  item: PendingItem,
  decision: 'approve' | 'reject',
  reason: string,
): ClientAction {
  if (decision === 'approve' && item.kind === 'blocker') {
    return { kind: 'unblock', id: item.id, reason: reason.trim() }
  }
  return decision === 'approve'
    ? { kind: 'approve-pending', id: item.id, reason: reason.trim() }
    : { kind: 'reject-pending', id: item.id, reason: reason.trim() }
}

function TddBadge({ tdd, t }: { tdd: string; t: ViewProps['t'] }): React.ReactElement | null {
  if (tdd === 'green') return <Badge label={t('tasks.tdd.green')} color={COLORS.pass} dataBadge="tdd-green" />
  if (tdd === 'red') return <Badge label={t('tasks.tdd.red')} color={COLORS.warn} dataBadge="tdd-red" />
  return null
}

function EvidenceBadge({
  evidence,
  t,
}: {
  evidence: TaskCardModel['evidence']
  t: ViewProps['t']
}): React.ReactElement {
  if (evidence === 'fresh') {
    return <Badge label={t('tasks.evidence.fresh')} color={COLORS.pass} dataBadge="evidence-fresh" />
  }
  if (evidence === 'stale') {
    return <Badge label={t('tasks.evidence.stale')} color={COLORS.warn} dataBadge="evidence-stale" />
  }
  return <Badge label={t('tasks.evidence.none')} color={COLORS.dim} dataBadge="evidence-none" />
}

/** Enter / Space activation shared by the task cards and graph nodes (T5.1). */
function activateFromKeyboard(event: React.KeyboardEvent, activate: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
  // Space would otherwise scroll the panel while activating the card.
  event.preventDefault()
  activate()
}

function TaskCard({
  task,
  t,
  selected,
  onSelect,
}: {
  task: TaskCardModel
  t: ViewProps['t']
  selected: boolean
  onSelect?: () => void
}): React.ReactElement {
  const interactive = onSelect !== undefined
  return (
    <div
      data-flowgate="task-card"
      data-task-id={task.id}
      data-task-status={task.status}
      {...(selected ? { 'data-task-selected': 'true' } : {})}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected,
            'aria-label': t('tasks.cardAria', { id: task.id, status: taskStatusLabel(task.status, t) }),
            onClick: onSelect,
            onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => activateFromKeyboard(event, onSelect),
          }
        : {})}
      style={{
        fontFamily: UI_FONT,
        border: `1px solid ${selected ? COLORS.info : COLORS.border}`,
        borderInlineStart: `3px solid ${taskColor(task.status)}`,
        borderRadius: 7,
        padding: '5px 7px',
        background: selected ? COLORS.infoBg : COLORS.surface,
        cursor: interactive ? 'pointer' : 'default',
        display: 'grid',
        gap: 3,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: MONO_FONT, fontWeight: 600 }}>{task.id}</span>
        <Badge label={taskStatusLabel(task.status, t)} dataBadge={task.status} color={taskColor(task.status)} />
        {task.batch !== '' ? <Badge label={task.batch} dataBadge={`batch-${task.batch}`} /> : null}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <TddBadge tdd={task.tdd} t={t} />
        <EvidenceBadge evidence={task.evidence} t={t} />
        {task.reviewFindings > 0 ? (
          <Badge
            label={t('tasks.reviewFindings', { n: task.reviewFindings })}
            color={COLORS.warn}
            dataBadge="review-findings"
          />
        ) : null}
        {task.failureCount > 0 ? (
          <Badge label={`×${task.failureCount}`} color={COLORS.fail} dataBadge="failure-count" />
        ) : null}
      </div>
      {task.worktree !== undefined && task.worktree !== '' ? (
        <div style={{ color: COLORS.dim, fontSize: 10 }}>
          <span style={{ marginInlineEnd: 4 }}>{t('tasks.worktree')}</span>
          <Mono>{task.worktree}</Mono>
        </div>
      ) : null}
      {task.agent !== undefined && task.agent !== '' ? (
        <div style={{ color: COLORS.dim, fontSize: 10 }}>
          <span style={{ marginInlineEnd: 4 }}>{t('tasks.agent')}</span>
          <Mono>{task.agent}</Mono>
        </div>
      ) : null}
      {task.blockReason !== undefined && task.blockReason !== '' ? (
        <div style={{ color: COLORS.fail, fontSize: 10 }}>{task.blockReason}</div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Task detail (T5.1 "点开节点看任务卡和子 agent 状态")
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 8, alignItems: 'baseline' }}>
      <span style={{ color: COLORS.dim }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}

function MonoList({ items, none }: { items: string[] | undefined; none: string }): React.ReactElement {
  if (items === undefined || items.length === 0) return <span style={{ color: COLORS.faint }}>{none}</span>
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((item) => (
        <Mono key={item}>{item}</Mono>
      ))}
    </span>
  )
}

/**
 * Expanded detail for the selected task. Reuses the task card model first
 * (status / batch / TDD / evidence freshness / review findings / worktree /
 * agent) and falls back to the mapped plan extras (scope / new_files / verify
 * groups) when the projection carries them.
 */
export function TaskDetail({
  task,
  t,
  onClose,
}: {
  task: TaskCardModel
  t: ViewProps['t']
  onClose?: () => void
}): React.ReactElement {
  return (
    <div
      data-flowgate="task-detail"
      data-task-id={task.id}
      data-task-status={task.status}
      style={{
        fontFamily: UI_FONT,
        fontSize: 11,
        border: `1px solid ${COLORS.info}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: COLORS.surface,
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Mono>{task.id}</Mono>
        {task.title !== task.id ? <strong style={{ fontSize: 12 }}>{task.title}</strong> : null}
        <Badge
          label={taskStatusLabel(task.status, t)}
          color={taskColor(task.status)}
          dataBadge={`detail-status-${task.status}`}
        />
        {task.batch !== '' ? <Badge label={`${t('tasks.batch')} ${task.batch}`} dataBadge="detail-batch" /> : null}
        <span style={{ flex: 1 }} />
        {onClose !== undefined ? (
          <ActionButton label={t('common.close')} dataAction="task-detail-close" onClick={onClose} />
        ) : null}
      </div>

      <div data-flowgate="task-detail-rows" style={{ display: 'grid', gap: 4 }}>
        <DetailRow label={t('tasks.statusLabel')}>
          {taskStatusLabel(task.status, t)}
          {task.batchStatus !== undefined && task.batchStatus !== '' ? (
            <span style={{ color: COLORS.dim, marginInlineStart: 6 }}>({task.batchStatus})</span>
          ) : null}
        </DetailRow>
        <DetailRow label={t('tasks.batch')}>
          {task.batch !== '' ? <Mono>{task.batch}</Mono> : <span style={{ color: COLORS.faint }}>{t('common.none')}</span>}
          {task.batchMode !== undefined ? (
            <span style={{ color: COLORS.dim, marginInlineStart: 6 }}>
              {task.batchMode === 'parallel' ? t('tasks.parallel') : t('tasks.sequential')}
            </span>
          ) : null}
        </DetailRow>
        <DetailRow label={t('tasks.tdd')}>
          {task.tdd === 'green' || task.tdd === 'red' ? (
            <TddBadge tdd={task.tdd} t={t} />
          ) : (
            <span style={{ color: COLORS.faint }}>{t('tasks.tdd.none')}</span>
          )}
          {task.redObserved === true ? (
            <span style={{ color: COLORS.pass, marginInlineStart: 6 }}>{t('tasks.redObserved')}</span>
          ) : null}
        </DetailRow>
        <DetailRow label={t('tasks.evidence')}>
          <EvidenceBadge evidence={task.evidence} t={t} />
          {task.evidenceIds !== undefined && task.evidenceIds.length > 0 ? (
            <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, marginInlineStart: 6 }}>
              {task.evidenceIds.map((id) => (
                <Mono key={id}>{id}</Mono>
              ))}
            </span>
          ) : null}
        </DetailRow>
        <DetailRow label={t('tasks.review')}>
          <span style={{ color: task.reviewFindings > 0 ? COLORS.warn : COLORS.dim }}>
            {t('tasks.reviewFindings', { n: task.reviewFindings })}
          </span>
          {task.findings !== undefined && task.findings.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 2 }}>
              {task.findings.map((finding, index) => (
                <li key={`${finding.file}-${index}`} style={{ fontSize: 10.5, color: COLORS.dim }}>
                  <span style={{ color: COLORS.warn }}>[{finding.severity}]</span>{' '}
                  <Mono>
                    {finding.file}
                    {finding.line !== undefined ? `:${finding.line}` : ''}
                  </Mono>{' '}
                  {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
        </DetailRow>
        <DetailRow label={t('tasks.worktree')}>
          {task.worktree !== undefined && task.worktree !== '' ? (
            <Mono>{task.worktree}</Mono>
          ) : (
            <span style={{ color: COLORS.faint }}>{t('common.none')}</span>
          )}
        </DetailRow>
        <DetailRow label={t('tasks.agent')}>
          {task.agent !== undefined && task.agent !== '' ? (
            <Mono>{task.agent}</Mono>
          ) : (
            <span style={{ color: COLORS.faint }}>{t('common.none')}</span>
          )}
        </DetailRow>
        {task.failureCount > 0 ? (
          <DetailRow label={t('tasks.failureCount')}>
            <span style={{ color: COLORS.fail }}>×{task.failureCount}</span>
          </DetailRow>
        ) : null}
        {task.blockReason !== undefined && task.blockReason !== '' ? (
          <DetailRow label={t('tasks.blockReason')}>
            <span style={{ color: COLORS.fail }}>{task.blockReason}</span>
          </DetailRow>
        ) : null}
        <DetailRow label={t('tasks.scope')}>
          <MonoList items={task.scope} none={t('common.none')} />
        </DetailRow>
        <DetailRow label={t('tasks.newFiles')}>
          <MonoList items={task.newFiles} none={t('common.none')} />
        </DetailRow>
        <DetailRow label={t('tasks.verify')}>
          <MonoList items={task.verify} none={t('common.none')} />
        </DetailRow>
        {task.tests !== undefined && task.tests.length > 0 ? (
          <DetailRow label={t('tasks.tests')}>
            <MonoList items={task.tests} none={t('common.none')} />
          </DetailRow>
        ) : null}
        {task.covers !== undefined && task.covers.length > 0 ? (
          <DetailRow label={t('tasks.covers')}>
            <MonoList items={task.covers} none={t('common.none')} />
          </DetailRow>
        ) : null}
      </div>
    </div>
  )
}

export function TasksView({ model, t, onAction }: ViewProps): React.ReactElement {
  const [reason, setReason] = React.useState('')
  const [pendingId, setPendingId] = React.useState<string | undefined>(undefined)
  // T5.1: selecting a node in the execution graph expands its task card below.
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | undefined>(undefined)
  // Every open item an owner can decide right now (not just scope/conflict:
  // plan/rule/risk/blocker used to be reachable only through typed commands;
  // now each one is a card rendered here and a click executes it).
  const pendingDecisions = (model.snapshot?.pending ?? []).filter(isOwnerPendingItem)

  const openDecision = (id: string): void => {
    setPendingId(id)
    setReason('')
  }
  const cancelDecision = (): void => {
    setPendingId(undefined)
    setReason('')
  }

  // Clicking the selected node/card again collapses the detail.
  const selectTask = (taskId: string): void => {
    setSelectedTaskId((current) => (current === taskId ? undefined : taskId))
  }
  const selectedTask =
    selectedTaskId !== undefined ? model.tasks.find((task) => task.id === selectedTaskId) : undefined

  const empty = model.tasks.length === 0

  return (
    <div
      data-flowgate="view-tasks"
      {...(selectedTaskId !== undefined ? { 'data-selected-task': selectedTaskId } : {})}
      style={{ display: 'grid', gap: 10 }}
    >
      <Section title={t('tasks.graph')} count={model.execution.nodes.length}>
        <ExecutionGraph
          graph={model.execution}
          t={t}
          selectedTaskId={selectedTaskId}
          onSelectTask={selectTask}
        />
      </Section>

      {selectedTask !== undefined ? (
        <Section title={t('tasks.detailTitle')}>
          <TaskDetail task={selectedTask} t={t} onClose={() => setSelectedTaskId(undefined)} />
        </Section>
      ) : null}

      <Section title={t('tasks.title')} count={model.tasks.length}>
        {empty ? (
          <EmptyState text={t('tasks.empty')} />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {BOARD_COLUMNS.map((column) => {
              const cards = model.tasksByStatus[column.key]
              return (
                <div key={column.key} data-flowgate="board-column" data-column={column.key}>
                  <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 4 }}>
                    {t(column.titleKey)} · {cards.length}
                  </div>
                  <div style={{ display: 'grid', gap: 5 }}>
                    {cards.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        t={t}
                        selected={task.id === selectedTaskId}
                        onSelect={() => selectTask(task.id)}
                      />
                    ))}
                    {cards.length === 0 ? (
                      <div style={{ fontSize: 10.5, color: COLORS.faint }}>{t('common.none')}</div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {pendingDecisions.length > 0 ? (
        <Section title={t('tasks.pendingTitle')} count={pendingDecisions.length}>
          <div style={{ display: 'grid', gap: 6 }}>
            {pendingDecisions.map((item) => {
              const kind = item.kind as OwnerPendingKind
              const isBlocker = kind === 'blocker'
              const editing = pendingId === item.id
              return (
                <div
                  key={item.id}
                  data-flowgate="pending-decision"
                  data-pending-id={item.id}
                  data-pending-kind={kind}
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 7,
                    padding: '6px 8px',
                    display: 'grid',
                    gap: 4,
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Mono>{item.id}</Mono>
                    <Badge label={t(PENDING_KIND_LABEL[kind])} dataBadge={`pending-kind-${kind}`} />
                  </div>
                  <div style={{ color: COLORS.dim }}>{item.title}</div>
                  {item.detail !== '' ? <div style={{ color: COLORS.faint, fontSize: 10.5 }}>{item.detail}</div> : null}
                  {editing ? (
                    <div style={{ display: 'grid', gap: 4 }}>
                      <textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder={t('common.reasonPh')}
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
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {isBlocker ? (
                          <ActionButton
                            label={t('tasks.unblock')}
                            tone="primary"
                            dataAction={`pending-unblock-${item.id}`}
                            onClick={() => onAction(pendingDecisionAction(item, 'approve', reason))}
                          />
                        ) : (
                          <>
                            <ActionButton
                              label={t('risk.approve')}
                              tone="primary"
                              dataAction={`pending-approve-${item.id}`}
                              onClick={() => onAction(pendingDecisionAction(item, 'approve', reason))}
                            />
                            <ActionButton
                              label={t('risk.reject')}
                              tone="danger"
                              dataAction={`pending-reject-${item.id}`}
                              onClick={() => onAction(pendingDecisionAction(item, 'reject', reason))}
                            />
                          </>
                        )}
                        <ActionButton
                          label={t('common.cancel')}
                          dataAction={`pending-cancel-${item.id}`}
                          onClick={cancelDecision}
                        />
                      </div>
                      {isBlocker ? (
                        <span style={{ color: COLORS.dim, fontSize: 10.5 }} data-flowgate="pending-hint">
                          {t('tasks.unblockHint')}
                        </span>
                      ) : reason.trim() === '' ? (
                        <Notice text={t('actions.noReason')} tone="warn" t={t} />
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 5 }}>
                      {isBlocker ? (
                        <ActionButton
                          label={t('tasks.unblock')}
                          tone="primary"
                          dataAction={`pending-open-unblock-${item.id}`}
                          onClick={() => openDecision(item.id)}
                        />
                      ) : (
                        <>
                          <ActionButton
                            label={t('risk.approve')}
                            tone="primary"
                            dataAction={`pending-open-approve-${item.id}`}
                            onClick={() => openDecision(item.id)}
                          />
                          <ActionButton
                            label={t('risk.reject')}
                            dataAction={`pending-open-reject-${item.id}`}
                            onClick={() => openDecision(item.id)}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Section>
      ) : null}
    </div>
  )
}
