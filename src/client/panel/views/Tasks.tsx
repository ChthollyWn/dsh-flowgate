/**
 * Tasks view (FR-8.2 / T3.6 / T5.1): live execution-plan diagram plus the task
 * board (todo / running / review / done / blocked). Cards show scope, TDD
 * badges (RED/GREEN), evidence freshness, review findings, sub-agent status and
 * worktree. Every owner-decidable pending item (scope / risk / plan / rule /
 * conflict / blocker) gets its approve/reject (or unblock) entry here; the
 * actual host call + `/flow` command fallback lives in `../../actions`.
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
 * are cleared through `/flow unblock`; every other kind goes through the
 * `approve-pending` / `reject-pending` family mapping in `../../actions`.
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

function TaskCard({ task, t }: { task: TaskCardModel; t: ViewProps['t'] }): React.ReactElement {
  return (
    <div
      data-flowgate="task-card"
      data-task-id={task.id}
      data-task-status={task.status}
      style={{
        fontFamily: UI_FONT,
        border: `1px solid ${COLORS.border}`,
        borderInlineStart: `3px solid ${taskColor(task.status)}`,
        borderRadius: 7,
        padding: '5px 7px',
        background: COLORS.surface,
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

export function TasksView({ model, t, onAction }: ViewProps): React.ReactElement {
  const [reason, setReason] = React.useState('')
  const [pendingId, setPendingId] = React.useState<string | undefined>(undefined)
  // Every open item an owner can decide right now (not just scope/conflict:
  // plan/rule/risk/blocker used to be reachable only through `/flow`).
  const pendingDecisions = (model.snapshot?.pending ?? []).filter(isOwnerPendingItem)

  const openDecision = (id: string): void => {
    setPendingId(id)
    setReason('')
  }
  const cancelDecision = (): void => {
    setPendingId(undefined)
    setReason('')
  }

  const empty = model.tasks.length === 0

  return (
    <div data-flowgate="view-tasks" style={{ display: 'grid', gap: 10 }}>
      <Section title={t('tasks.graph')} count={model.execution.nodes.length}>
        <ExecutionGraph graph={model.execution} t={t} />
      </Section>

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
                      <TaskCard key={task.id} task={task} t={t} />
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
