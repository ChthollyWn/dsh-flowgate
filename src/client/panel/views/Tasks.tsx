/**
 * Tasks view (FR-8.2 / T3.6 / T5.1): live execution-plan diagram plus the task
 * board (todo / running / review / done / blocked). Cards show scope, TDD
 * badges (RED/GREEN), evidence freshness, review findings, sub-agent status and
 * worktree. Scope changes and merge conflicts are human decisions.
 */
import React from 'react'
import type { ViewProps } from '../view-types'
import { ActionButton, Badge, EmptyState, KeyValue, Mono, Notice, Section } from '../Common'
import { COLORS, MONO_FONT, UI_FONT, taskColor } from '../../theme'
import { ExecutionGraph } from '../ExecutionGraph'
import type { TaskCardModel } from '../../model'
import { taskStatusLabel } from '../../model'

const BOARD_COLUMNS: { key: 'todo' | 'running' | 'review' | 'done' | 'blocked'; titleKey: 'tasks.board.todo' | 'tasks.board.running' | 'tasks.board.review' | 'tasks.board.done' | 'tasks.board.blocked' }[] = [
  { key: 'todo', titleKey: 'tasks.board.todo' },
  { key: 'running', titleKey: 'tasks.board.running' },
  { key: 'review', titleKey: 'tasks.board.review' },
  { key: 'done', titleKey: 'tasks.board.done' },
  { key: 'blocked', titleKey: 'tasks.board.blocked' },
]

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
  const pendingDecisions = (model.snapshot?.pending ?? []).filter(
    (item) => item.kind === 'scope' || item.kind === 'conflict',
  )

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
        <Section title={t('risk.pending')} count={pendingDecisions.length}>
          <div style={{ display: 'grid', gap: 6 }}>
            {pendingDecisions.map((item) => (
              <div
                key={item.id}
                data-flowgate="pending-decision"
                data-pending-id={item.id}
                style={{
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 7,
                  padding: '6px 8px',
                  display: 'grid',
                  gap: 4,
                  fontSize: 11,
                }}
              >
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Mono>{item.id}</Mono>
                  <span>{item.kind === 'conflict' ? t('tasks.conflict') : t('tasks.approveScope')}</span>
                </div>
                <div style={{ color: COLORS.dim }}>{item.title}</div>
                {item.detail !== '' ? <div style={{ color: COLORS.faint, fontSize: 10.5 }}>{item.detail}</div> : null}
                {pendingId === item.id ? (
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
                    <div style={{ display: 'flex', gap: 5 }}>
                      <ActionButton
                        label={t('risk.approve')}
                        tone="primary"
                        dataAction={`pending-approve-${item.id}`}
                        onClick={() => onAction({ kind: 'approve-pending', id: item.id, reason: reason.trim() })}
                      />
                      <ActionButton
                        label={t('risk.reject')}
                        tone="danger"
                        dataAction={`pending-reject-${item.id}`}
                        onClick={() => onAction({ kind: 'reject-pending', id: item.id, reason: reason.trim() })}
                      />
                    </div>
                    {reason.trim() === '' ? <Notice text={t('actions.noReason')} tone="warn" t={t} /> : null}
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 5 }}>
                    <ActionButton
                      label={t('risk.approve')}
                      tone="primary"
                      dataAction={`pending-open-approve-${item.id}`}
                      onClick={() => {
                        setPendingId(item.id)
                        setReason('')
                      }}
                    />
                    <ActionButton
                      label={t('risk.reject')}
                      dataAction={`pending-open-reject-${item.id}`}
                      onClick={() => {
                        setPendingId(item.id)
                        setReason('')
                      }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}
