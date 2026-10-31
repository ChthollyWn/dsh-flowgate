/**
 * Tasks view task-detail interaction (T5.1):
 *
 *  - clicking a node in the execution graph selects the task, highlights the
 *    matching board card and expands the detail block;
 *  - keyboard Enter / Space on a node selects it too;
 *  - clicking a task card selects it, clicking it again collapses the detail;
 *  - the close button collapses the detail;
 *  - the detail reuses the card model and the plan extras mapped in model.ts
 *    (scope / new_files / verify groups / review findings / evidence ids).
 *
 * Interaction runs through `hook-harness` (node environment, no jsdom).
 */
import { describe, expect, it } from 'vitest'
import type React from 'react'
import type { TaskState } from '../../src/core/types'
import { buildPanelModel } from '../../src/client/model'
import { TasksView } from '../../src/client/panel/views/Tasks'
import type { ViewProps } from '../../src/client/panel/view-types'
import { createTranslator } from '../../src/client/i18n'
import type { TFn } from '../../src/client/i18n'
import type { ClientAction } from '../../src/client/actions'
import { click, findByData, findElement, mountWithHooks, pressKey } from './hook-harness'
import type { MountedView } from './hook-harness'
import { makeProjection, makeSnapshot } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (_action: ClientAction): void => {}

function mountTasks(locale: TFn = zh, project = makeProjection()): MountedView<ViewProps> {
  const model = buildPanelModel(project, locale)
  return mountWithHooks<ViewProps>(TasksView, { model, t: locale, onAction: noop })
}

function graphNode(tree: React.ReactElement, id: string): React.ReactElement | undefined {
  return findByData(tree, 'data-node-id', id)
}

function card(tree: React.ReactElement, id: string): React.ReactElement | undefined {
  return findElement(
    tree,
    (element) =>
      (element.props as Record<string, unknown>)['data-flowgate'] === 'task-card' &&
      (element.props as Record<string, unknown>)['data-task-id'] === id,
  )
}

describe('Tasks view — task detail from the execution graph (T5.1)', () => {
  it('starts collapsed with no detail section', () => {
    const view = mountTasks()
    expect(view.html).toContain('data-flowgate="execution-graph"')
    expect(view.html).not.toContain('data-flowgate="task-detail"')
    expect(view.html).not.toContain('data-task-selected')
    expect(view.html).not.toContain('data-node-selected')
  })

  it('clicking a graph node expands the detail, highlights card + node', () => {
    const view = mountTasks()
    click(graphNode(view.tree, 'T2')!)
    view.render()

    expect(view.html).toContain('data-flowgate="task-detail"')
    expect(view.html).toContain('data-task-id="T2" data-task-status="running"')
    expect(view.html).toContain('data-selected-task="T2"')
    // Board card and graph node carry the selected state.
    expect(view.html).toContain('data-task-selected="true"')
    expect(view.html).toContain('data-node-selected="true"')
    // Detail reuses the task-card data: batch mode, worktree, agent, evidence.
    expect(view.html).toContain('data-badge="detail-batch"')
    expect(view.html).toContain('B2')
    expect(view.html).toContain('并行')
    expect(view.html).toContain('.flowgate/worktrees/C-003-T2')
    expect(view.html).toContain('flowgate-executor')
    expect(view.html).toContain('证据过期')
    expect(view.html).toContain('审查发现 0')
    // The card stays in the board and the graph keeps all nodes.
    expect(view.html).toContain('data-flowgate="task-card"')
  })

  it('keyboard Enter and Space on a node select the task', () => {
    const view = mountTasks()
    pressKey(graphNode(view.tree, 'T4')!, 'Enter')
    view.render()
    expect(view.html).toContain('data-flowgate="task-detail"')
    expect(view.html).toContain('data-task-id="T4" data-task-status="pending"')
    expect(view.html).toContain('data-selected-task="T4"')

    // Space on another node moves the selection.
    pressKey(graphNode(view.tree, 'T1')!, ' ')
    view.render()
    expect(view.html).toContain('data-selected-task="T1"')
    expect(view.html).toContain('data-task-id="T1" data-task-status="done"')
  })

  it('clicking the same node again collapses the detail', () => {
    const view = mountTasks()
    click(graphNode(view.tree, 'T2')!)
    view.render()
    expect(view.html).toContain('data-flowgate="task-detail"')

    click(graphNode(view.tree, 'T2')!)
    view.render()
    expect(view.html).not.toContain('data-flowgate="task-detail"')
    expect(view.html).not.toContain('data-task-selected')
  })

  it('clicking a board card selects it, clicking it again collapses it', () => {
    const view = mountTasks()
    click(card(view.tree, 'T3')!)
    view.render()
    expect(view.html).toContain('data-flowgate="task-detail"')
    expect(view.html).toContain('data-selected-task="T3"')

    click(card(view.tree, 'T3')!)
    view.render()
    expect(view.html).not.toContain('data-flowgate="task-detail"')
  })

  it('the close button collapses the detail block', () => {
    const view = mountTasks()
    click(graphNode(view.tree, 'T1')!)
    view.render()
    const close = findByData(view.tree, 'data-action', 'task-detail-close')
    expect(close).toBeDefined()
    click(close!)
    view.render()
    expect(view.html).not.toContain('data-flowgate="task-detail"')
  })

  it('maps plan extras (scope / new files / verify / findings) into the detail', () => {
    const base = makeSnapshot()
    const enrichedTasks: Record<string, TaskState> = {
      ...base.tasks,
      T1: {
        ...base.tasks.T1!,
        title: '续费主流程',
        scope: ['src/main/java/RenewalService.java'],
        newFiles: ['src/main/java/RenewalIdempotency.java'],
        verify: [{ group: 'unit', command: 'mvn -q test' }],
        covers: ['R1.S1'],
        tests: ['RenewalServiceTest'],
        redObserved: true,
      } as unknown as TaskState,
    }
    const project = makeProjection({
      snapshot: { tasks: enrichedTasks },
    })
    const view = mountTasks(zh, project)
    click(graphNode(view.tree, 'T1')!)
    view.render()

    expect(view.html).toContain('续费主流程')
    expect(view.html).toContain('src/main/java/RenewalService.java')
    expect(view.html).toContain('src/main/java/RenewalIdempotency.java')
    expect(view.html).toContain('unit · mvn -q test')
    expect(view.html).toContain('R1.S1')
    expect(view.html).toContain('RenewalServiceTest')
    expect(view.html).toContain('RED 已观察')
    // Review findings flattened from the panel reviews row for T1.
    expect(view.html).toContain('缺少幂等键')
    expect(view.html).toContain('RenewalService.java:88')
    expect(view.html).toContain('[major]')
  })

  it('renders the detail in English without leaking i18n keys', () => {
    const view = mountTasks(en)
    click(graphNode(view.tree, 'T2')!)
    view.render()
    expect(view.html).toContain('Task detail')
    expect(view.html).toContain('Batch')
    expect(view.html).not.toMatch(/tasks\.[a-zA-Z]/)
    expect(view.html).toContain('data-task-id="T2" data-task-status="running"')
  })
})
