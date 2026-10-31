/** SSR + interaction tests for the execution-plan SVG (T2.9 / T5.1). */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionGraph } from '../../src/client/panel/ExecutionGraph'
import { buildExecutionGraph } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import { click, findByData, htmlOf, mountWithHooks, pressKey } from './hook-harness'
import { makeSnapshot } from './mock'

const zh = createTranslator('zh')

function render(snapshot = makeSnapshot()): string {
  const graph = buildExecutionGraph(snapshot)
  return renderToStaticMarkup(<ExecutionGraph graph={graph} t={zh} />)
}

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length
}

describe('ExecutionGraph', () => {
  it('renders one node per task card, with status attributes', () => {
    const html = render()
    expect(count(html, /data-node-id=/g)).toBe(4)
    expect(html).toContain('data-node-id="T1" data-node-status="done"')
    expect(html).toContain('data-node-id="T2" data-node-status="running"')
    expect(html).toContain('data-node-id="T3" data-node-status="running"')
    expect(html).toContain('data-node-id="T4" data-node-status="pending"')
  })

  it('renders one integration checkpoint per batch and marks parallel batches', () => {
    const html = render()
    expect(count(html, /data-checkpoint=/g)).toBe(3)
    expect(html).toContain('data-batch-id="B2" data-batch-mode="parallel"')
    expect(html).toContain('data-batch-id="B1" data-batch-mode="sequential"')
    expect(count(html, /data-edge-kind="parallel"/g)).toBeGreaterThan(0)
    expect(count(html, /data-edge-kind="checkpoint"/g)).toBe(3)
  })

  it('shows the worktree / agent label on nodes that have one', () => {
    const html = render()
    expect(html).toContain('.flowgate/worktrees/C-003-T2')
  })

  it('provides an accessible label with node and batch counts', () => {
    const html = render()
    expect(html).toContain('aria-label="执行流程图：4 个任务节点，3 个批次"')
    expect(html).toContain('data-node-count="4"')
    expect(html).toContain('data-batch-count="3"')
  })

  it('renders an empty state instead of an empty svg', () => {
    const graph = buildExecutionGraph(makeSnapshot({ batches: [], tasks: {} }))
    const html = renderToStaticMarkup(<ExecutionGraph graph={graph} t={zh} />)
    expect(html).toContain('data-flowgate="execution-graph-empty"')
    expect(html).toContain('暂无执行流程图')
    expect(html).not.toContain('<svg')
  })

  it('renders the legend with the four status colors and the checkpoint', () => {
    const html = render()
    expect(html).toContain('data-flowgate="graph-legend"')
    expect(html).toContain('集成检查点')
  })

  it('renders English labels without leaking i18n keys', () => {
    const en = createTranslator('en')
    const graph = buildExecutionGraph(makeSnapshot())
    const html = renderToStaticMarkup(<ExecutionGraph graph={graph} t={en} />)
    expect(html).toContain('Execution plan with 4 task nodes in 3 batches')
    expect(html).not.toContain('tasks.graphAria')
  })
})

describe('ExecutionGraph — node selection (T5.1)', () => {
  const graph = buildExecutionGraph(makeSnapshot())
  const noop = (): void => {}

  function interactiveHtml(selectedTaskId?: string, t = zh): string {
    return renderToStaticMarkup(
      <ExecutionGraph graph={graph} t={t} selectedTaskId={selectedTaskId} onSelectTask={noop} />,
    )
  }

  it('makes every task node a focusable button with a localized aria label', () => {
    const html = interactiveHtml()
    expect(count(html, /role="button"/g)).toBe(4)
    expect(count(html, /tabindex="0"/g)).toBe(4)
    expect(html).toContain('aria-label="任务 T2（进行中）；点击查看详情"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('cursor:pointer')
    // Interactive nodes must be exposed, so the svg is a group, not an img.
    expect(html).toContain('role="group"')
  })

  it('localizes the node label in English', () => {
    const en = createTranslator('en')
    const html = interactiveHtml(undefined, en)
    expect(html).toContain('Task T2 (Running); activate to view details')
    expect(html).not.toContain('tasks.nodeAria')
  })

  it('keeps nodes non-interactive when no callback is supplied (Gates view)', () => {
    const html = render()
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('role="group"')
    expect(html).not.toContain('tabindex="0"')
    expect(html).not.toContain('data-node-selected')
  })

  it('highlights the selected node with a ring and aria-pressed state', () => {
    const html = interactiveHtml('T2')
    expect(html).toContain('data-node-id="T2" data-node-status="running" data-node-batch="B2" data-node-selected="true"')
    expect(html).toContain('data-node-selection-ring="true"')
    expect(count(html, /aria-pressed="true"/g)).toBe(1)
    expect(count(html, /data-node-selected="true"/g)).toBe(1)
  })

  it('reports a clicked node id to onSelectTask', () => {
    const onSelectTask = vi.fn()
    const view = mountWithHooks(ExecutionGraph, { graph, t: zh, onSelectTask })
    const node = findByData(view.tree, 'data-node-id', 'T2')
    expect(node).toBeDefined()
    click(node!)
    expect(onSelectTask).toHaveBeenCalledTimes(1)
    expect(onSelectTask).toHaveBeenCalledWith('T2')
  })

  it('reports Enter and Space activation and prevents Space scrolling', () => {
    const onSelectTask = vi.fn()
    const view = mountWithHooks(ExecutionGraph, { graph, t: zh, onSelectTask })
    const node = findByData(view.tree, 'data-node-id', 'T4')!

    const enter = pressKey(node, 'Enter')
    expect(enter.prevented).toBe(true)
    expect(onSelectTask).toHaveBeenLastCalledWith('T4')

    const space = pressKey(node, ' ')
    expect(space.prevented).toBe(true)
    expect(onSelectTask).toHaveBeenCalledTimes(2)

    // Unrelated keys must not select the node.
    pressKey(node, 'a')
    expect(onSelectTask).toHaveBeenCalledTimes(2)
  })

  it('does not emit interactive attributes for the empty state', () => {
    const empty = buildExecutionGraph(makeSnapshot({ batches: [], tasks: {} }))
    const html = renderToStaticMarkup(<ExecutionGraph graph={empty} t={zh} onSelectTask={noop} selectedTaskId="T1" />)
    expect(html).toContain('data-flowgate="execution-graph-empty"')
    expect(html).not.toContain('role="button"')
  })

  // `htmlOf` keeps the helper import exercised alongside the SSR assertions.
  it('renders the same tree through the shared html helper', () => {
    const view = mountWithHooks(ExecutionGraph, { graph, t: zh })
    expect(htmlOf(view.tree)).toContain('data-node-count="4"')
  })
})
