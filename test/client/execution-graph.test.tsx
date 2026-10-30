/** SSR tests for the execution-plan SVG (T2.9 / T5.1). */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExecutionGraph } from '../../src/client/panel/ExecutionGraph'
import { buildExecutionGraph } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
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
