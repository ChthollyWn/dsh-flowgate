/**
 * Subagent topology view tests (docs/impl/runtime-visualization.md §1/§5):
 * pure role/status/link mapping, SSR DOM contract for both modes, mode switch,
 * tree collapse and the optional "open session" action.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SubagentsView } from '../../src/client/panel/views/Subagents'
import type { SubagentsViewProps } from '../../src/client/panel/views/Subagents'
import { PanelSurface } from '../../src/client/panel/Panel'
import { buildAgentsModel, parseAgentLabel, parseCatalog } from '../../src/client/runtime-model'
import { buildPanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { HostBridge } from '../../src/client/bridge'
import { FLOWGATE_CSS } from '../../src/client/styles'
import { click, findByData, mountWithHooks } from './hook-harness'
import { AGENTS_RUNNING_KEY, makeAgentsProjection, makeSubagentCatalog } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (): void => {}
const projection = makeAgentsProjection()
const model = buildPanelModel(projection, zh)

function render(overrides: Partial<SubagentsViewProps> = {}): string {
  return renderToStaticMarkup(
    <SubagentsView
      model={model}
      t={zh}
      onAction={noop}
      runtime={{ catalog: makeSubagentCatalog(), projection, runningKey: AGENTS_RUNNING_KEY }}
      {...overrides}
    />,
  )
}

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length
}

describe('runtime-model — subagent catalog mapping', () => {
  it('parses every registered role label prefix', () => {
    expect(parseAgentLabel('flowgate-exec-T2')).toEqual({ role: 'executor', taskId: 'T2' })
    expect(parseAgentLabel('flowgate-review-T2-1')).toEqual({ role: 'reviewer', taskId: 'T2', attempt: 1 })
    expect(parseAgentLabel('flowgate-final-review-2')).toEqual({ role: 'final-reviewer', kind: 'review', attempt: 2 })
    expect(parseAgentLabel('flowgate-investigate-1720000000')).toEqual({
      role: 'investigator',
      kind: '1720000000',
    })
    expect(parseAgentLabel('custom-label')).toEqual({ role: 'subagent' })
    expect(parseAgentLabel(undefined)).toEqual({ role: 'subagent' })
  })

  it('drops malformed catalog rows instead of throwing', () => {
    expect(parseCatalog(undefined)).toEqual([])
    expect(parseCatalog('junk')).toEqual([])
    expect(parseCatalog([{ id: 'child-1' }, null, { id: 2 }, { id: 'child-2', label: 'flowgate-exec-T9' }])).toEqual([
      { id: 'child-1', createdAt: 0, mode: 'unknown' },
      { id: 'child-2', createdAt: 0, mode: 'unknown', label: 'flowgate-exec-T9' },
    ])
  })

  it('links executors to tasks/batches/titles/worktrees and keeps services unbatched', () => {
    const view = buildAgentsModel(makeSubagentCatalog(), projection, AGENTS_RUNNING_KEY)
    expect(view.available).toBe(true)
    expect(view.total).toBe(5)
    expect(view.running).toBe(1)
    expect(view.batches.map((batch) => batch.id)).toEqual(['B1', 'B2'])
    expect(view.batches.find((batch) => batch.id === 'B1')?.mode).toBe('sequential')
    expect(view.batches.find((batch) => batch.id === 'B2')?.mode).toBe('parallel')
    expect(view.services.map((node) => node.role)).toEqual(['reviewer', 'final-reviewer', 'investigator'])

    const t1 = view.nodes.find((node) => node.id === 'child-T1')
    expect(t1?.role).toBe('executor')
    expect(t1?.taskId).toBe('T1')
    expect(t1?.batch).toBe('B1')
    expect(t1?.status).toBe('done')
    expect(t1?.worktree).toBe('.flowgate/worktrees/C-003-T1')
    expect(t1?.durationMs).toBe(600_000)

    const t2 = view.nodes.find((node) => node.id === 'child-T2')
    expect(t2?.status).toBe('running')
    expect(t2?.statusSource).toBe('session')
    expect(t2?.taskTitle).toBe('回调幂等')

    // Without a live session-status signal the running task state still wins.
    const fromTask = buildAgentsModel(makeSubagentCatalog(), projection, '00000')
    expect(fromTask.nodes.find((node) => node.id === 'child-T2')?.status).toBe('running')
    expect(fromTask.nodes.find((node) => node.id === 'child-T2')?.statusSource).toBe('task')
    expect(fromTask.nodes.find((node) => node.id === 'child-I1')?.status).toBe('idle')
  })

  it('treats a missing catalog as unavailable and an empty one as no agents', () => {
    expect(buildAgentsModel(undefined, projection, '').available).toBe(false)
    const empty = buildAgentsModel([], projection, '')
    expect(empty.available).toBe(true)
    expect(empty.total).toBe(0)
  })
})

describe('subagents view — contract §1', () => {
  it('renders the host-missing empty state when no catalog projection exists', () => {
    const html = render({ runtime: {} })
    expect(html).toContain('data-flowgate="view-agents"')
    expect(html).toContain('data-flowgate="agents-empty"')
    expect(html).toContain('data-reason="host-missing"')
    expect(html).toContain('宿主未提供子代理目录投影')
    expect(html).toContain('data-flowgate="agents-count"')
  })

  it('renders the empty state with the S4 explanation for an empty catalog', () => {
    const html = render({ runtime: { catalog: [], projection, runningKey: '' } })
    expect(html).toContain('data-reason="no-agents"')
    expect(html).toContain('暂无子代理')
    expect(html).toContain('S4 派发执行者')
  })

  it('renders the workflow graph with root, batches and linked/unlinked cards', () => {
    const html = render()
    expect(html).toContain('data-flowgate="agents-graph"')
    // Top-down workflow: root → trunk → vertically stacked groups with wrapping cards.
    expect(html).toContain('class="fg-graph-root"')
    expect(html).toContain('class="fg-graph-trunk"')
    expect(html).toContain('class="fg-graph-body"')
    expect(html).toContain('class="fg-graph-group"')
    expect(html).toContain('class="fg-graph-cards"')
    expect(html).not.toContain('fg-graph-col')
    expect(html).not.toContain('fg-graph-arrow')
    // Batch headers carry the mode tag (from snapshot.batches).
    expect(html).toContain('fg-graph-batch-mode')
    expect(html).toContain('并行')
    expect(html).toContain('顺序')
    // Vertical order: main session before batches before the services group.
    expect(html.indexOf('data-flowgate="agent-root"')).toBeLessThan(html.indexOf('data-batch="B1"'))
    expect(html.indexOf('data-batch="B1"')).toBeLessThan(html.indexOf('data-batch="B2"'))
    expect(html.indexOf('data-batch="B2"')).toBeLessThan(html.indexOf('data-batch="services"'))
    expect(html).toContain('data-flowgate="agents-count" data-running="1" data-total="5"')
    expect(html).toContain('data-flowgate="agent-root"')
    expect(html).toContain('data-flowgate="agent-batch" data-batch="B1"')
    expect(html).toContain('data-flowgate="agent-batch" data-batch="B2"')
    expect(html).toContain('data-flowgate="agent-batch" data-batch="services"')
    expect(count(html, /data-flowgate="agent-node"/g)).toBe(5)
    expect(html).toContain('data-session-id="child-T1" data-role="executor" data-status="done" data-task="T1"')
    expect(html).toContain('data-session-id="child-T2" data-role="executor" data-status="running" data-task="T2"')
    expect(html).toContain('data-session-id="child-R2" data-role="reviewer"')
    expect(html).toContain('data-session-id="child-F1" data-role="final-reviewer"')
    expect(html).toContain('data-session-id="child-I1" data-role="investigator"')
    expect(html).toContain('回调幂等')
    expect(html).toContain('.flowgate/worktrees/C-003-T2')
    expect(html).toContain('fg-state-dot--success')
    expect(html).toContain('fg-dot-live')
    // Mode switch, default graph pressed.
    expect(html).toContain('data-flowgate="agents-mode"')
    expect(html).toContain('data-mode="graph" aria-pressed="true"')
    expect(html).toContain('data-mode="tree" aria-pressed="false"')
  })

  it('ships a top-down wrapping graph layout (no horizontal scroll in a 560px panel)', () => {
    const graphRule = FLOWGATE_CSS.slice(FLOWGATE_CSS.indexOf('.fg-graph {'), FLOWGATE_CSS.indexOf('.fg-graph-root {'))
    expect(graphRule).toContain('flex-direction: column;')
    expect(graphRule).not.toContain('overflow-x')
    const cardStart = FLOWGATE_CSS.indexOf('.fg-graph-cards .fg-agent-card {')
    const cardsRule = FLOWGATE_CSS.slice(FLOWGATE_CSS.indexOf('.fg-graph-cards {'), cardStart)
    expect(cardsRule).toContain('flex-wrap: wrap;')
    const cardRule = FLOWGATE_CSS.slice(cardStart, FLOWGATE_CSS.indexOf('}', cardStart))
    expect(cardRule).toContain('flex: 1 1 220px;')
    expect(cardRule).toContain('min-width: 0;')
    // The removed horizontal-column classes must stay gone.
    expect(FLOWGATE_CSS).not.toContain('.fg-graph-col')
  })

  it('renders the tree mode with expanded batch groups by default', () => {
    const html = render({ defaultMode: 'tree' })
    expect(html).toContain('data-flowgate="agents-tree"')
    expect(html).not.toContain('data-flowgate="agents-graph"')
    expect(count(html, /data-flowgate="agent-node"/g)).toBe(5)
    expect(count(html, /data-flowgate="agent-batch"/g)).toBe(3)
    expect(html).toContain('data-flowgate="tree-toggle"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('批次 B1')
    expect(html).toContain('服务')
  })

  it('switches graph → tree through the segmented control', () => {
    const view = mountWithHooks(SubagentsView, {
      model,
      t: zh,
      onAction: noop,
      runtime: { catalog: makeSubagentCatalog(), projection, runningKey: AGENTS_RUNNING_KEY },
    })
    expect(view.html).toContain('data-flowgate="agents-graph"')
    const treeButton = findByData(view.tree, 'data-mode', 'tree')
    expect(treeButton).toBeDefined()
    click(treeButton as React.ReactElement)
    view.render()
    expect(view.html).toContain('data-flowgate="agents-tree"')
    expect(view.html).not.toContain('data-flowgate="agents-graph"')
    expect(view.html).toContain('data-mode="tree" aria-pressed="true"')
  })

  it('collapses a tree batch group when its toggle is pressed', () => {
    const view = mountWithHooks(SubagentsView, {
      model,
      t: zh,
      onAction: noop,
      defaultMode: 'tree',
      runtime: { catalog: makeSubagentCatalog(), projection, runningKey: AGENTS_RUNNING_KEY },
    })
    expect(count(view.html, /data-flowgate="agent-node"/g)).toBe(5)
    const toggle = findByData(view.tree, 'data-flowgate', 'tree-toggle')
    expect(toggle).toBeDefined()
    click(toggle as React.ReactElement)
    view.render()
    expect(count(view.html, /data-flowgate="agent-node"/g)).toBe(4)
    expect(view.html).toContain('aria-expanded="false"')
  })

  it('opens the child session through the bridge when available', () => {
    const openSubagentSession = vi.fn((_parent: string, _child: string) => true)
    const bridge = { openSubagentSession } as unknown as HostBridge
    const html = render({ bridge, sessionId: 'web-1' })
    expect(html).toContain('data-action="agent-open"')
    const view = mountWithHooks(SubagentsView, {
      model,
      t: zh,
      onAction: noop,
      bridge,
      sessionId: 'web-1',
      runtime: { catalog: makeSubagentCatalog(), projection, runningKey: AGENTS_RUNNING_KEY },
    })
    const open = findByData(view.tree, 'data-action', 'agent-open')
    expect(open).toBeDefined()
    click(open as React.ReactElement)
    expect(openSubagentSession).toHaveBeenCalledTimes(1)
    expect(openSubagentSession.mock.calls[0]?.[0]).toBe('web-1')
    expect(openSubagentSession.mock.calls[0]?.[1]).toBe('child-T1')
  })

  it('renders English copy without leaking i18n keys', () => {
    const html = render({ t: en })
    expect(html).toContain('Executor')
    expect(html).toContain('Main session')
    expect(html).toContain('Workflow graph')
    expect(html).not.toContain('agents.')
  })

  it('renders the view through the panel surface with runtime data', () => {
    const html = renderToStaticMarkup(
      <PanelSurface
        model={model}
        t={zh}
        activeTab="agents"
        onTabChange={noop}
        onAction={noop}
        runtime={{ catalog: makeSubagentCatalog(), projection, runningKey: AGENTS_RUNNING_KEY }}
      />,
    )
    expect(html).toContain('data-active-tab="agents"')
    expect(html).toContain('data-flowgate="view-agents"')
    expect(html).toContain('data-flowgate="agent-node"')
  })
})
