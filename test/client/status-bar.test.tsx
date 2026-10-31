/** SSR tests for the input-dock status bar (T1.6 / FR-8.1). */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusBarView } from '../../src/client/dock/StatusBar'
import { buildStatusBarModel, buildStatusLine, textLength } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { FlowgateProjection } from '../../src/client/types'
import { LONG_NEXT_STEP, makeEmptyProjection, makeProjection, makeSnapshot } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')

function renderView(proj: FlowgateProjection | null, t = zh, strong = true): string {
  const model = buildStatusBarModel(proj, t)
  return renderToStaticMarkup(<StatusBarView model={model} t={t} strong={strong} onOpen={() => {}} />)
}

describe('StatusBar', () => {
  it('renders the example status line: change, level, phase, waiting, counts, next step', () => {
    const text = buildStatusLine(makeSnapshot(), zh)
    expect(text).toContain('◆ FlowGate C-003 中 · 普通风险')
    expect(text).toContain('③ 设计拆解')
    expect(text).toContain('等你批准计划')
    expect(text).toContain('拦截 2')
    expect(text).toContain('待处理 2')
    expect(text).toContain('下一步：/flow approve G3')
    expect(textLength(text)).toBeLessThanOrEqual(120)
  })

  it('is always ≤ 120 characters and truncates a long next step', () => {
    const snapshot = makeSnapshot({ nextStep: LONG_NEXT_STEP })
    const text = buildStatusLine(snapshot, zh)
    expect(textLength(text)).toBeLessThanOrEqual(120)
    expect(text.endsWith('…')).toBe(true)
  })

  it('marks the blocked tone in red for open violations / lock / off', () => {
    const violations = renderView(
      makeProjection({
        snapshot: {
          violations: [
            {
              id: 'V-1',
              changeId: 'C-003',
              path: 'src/A.java',
              kind: 'outside-scope',
              detectedAt: '2026-10-30T09:00:00Z',
              source: 'post',
            },
          ],
        },
      }),
    )
    expect(violations).toContain('data-tone="blocked"')
    expect(renderView(makeProjection({ snapshot: { locked: true } }))).toContain('data-tone="blocked"')
    expect(renderView(makeProjection({ snapshot: { off: true } }))).toContain('data-tone="blocked"')
  })

  it('uses the attention tone while a gate is waiting and the idle tone when nothing needs action', () => {
    expect(renderView(makeProjection())).toContain('data-tone="attention"')
    const idle = makeProjection({
      snapshot: {
        awaitingGate: undefined,
        pendingGate: undefined,
        pending: [],
        interceptCounts: {},
        nextStep: '继续实现 T2',
      },
      panel: {},
    })
    expect(renderView(idle)).toContain('data-tone="active"')
  })

  it('shows the disabled demo line when FlowGate is not initialized', () => {
    const html = renderView(makeEmptyProjection())
    expect(html).toContain('FlowGate 未启用')
    expect(html).toContain('data-tone="disabled"')
    expect(html).toContain('data-initialized="false"')
  })

  it('exposes the exact rendered text length and an accessible aria label', () => {
    const proj = makeProjection()
    const model = buildStatusBarModel(proj, zh)
    const html = renderView(proj)
    const match = /data-length="(\d+)"/.exec(html)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBe(textLength(model.text))
    expect(html).toContain('aria-label="FlowGate 状态条')
    expect(html).toContain('role="button"')
  })

  it('downgrades the strong tone when the same intercept was already shown', () => {
    const html = renderView(makeProjection(), zh, false)
    expect(html).toContain('data-strong="false"')
    // The semantic tone is kept for accessibility; only the styling is muted.
    expect(html).toContain('data-tone="attention"')
  })

  it('renders English copy without leaking keys', () => {
    const html = renderView(makeProjection(), en)
    expect(html).toContain('◆ FlowGate C-003 Medium · normal risk')
    expect(html).toContain('data-length="120"')
    expect(html).toContain('waiting for you to approve the plan')
    expect(html).not.toContain('status.awaiting')
  })
})

describe('StatusBar context occupancy (P1-7)', () => {
  it('shows host-provided contextPct once it crosses the 60% threshold', () => {
    expect(buildStatusLine(makeSnapshot({ contextPct: 61.4 }), zh)).toContain('上下文 61%')
    // Below the threshold (or absent) the segment is hidden to keep the line short.
    expect(buildStatusLine(makeSnapshot({ contextPct: 40 }), zh)).not.toContain('上下文')
    expect(buildStatusLine(makeSnapshot(), zh)).not.toContain('上下文')
  })

  it('does not render a context segment when the host has no projection data', () => {
    const html = renderView(makeProjection())
    expect(html).not.toContain('上下文')
  })
})
