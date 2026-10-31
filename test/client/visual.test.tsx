/**
 * SSR tests for the graphical visual system (contract §1.1 – §1.3).
 *
 * Covers the shipped files:
 *  - `visual/icons.tsx`: seven distinct stage glyphs + gate/shield/arrow icons;
 *  - `visual/Motion.tsx`: pulse dot + progress-ring primitives;
 *  - `visual/FlowRail.tsx`: compact rail DOM contract, state colors, clicks;
 *  - `visual/FlowMap.tsx`: vertical timeline, you-are-here, gates, callout;
 *  - `styles.ts`: keyframes/classes, reduced-motion rules and safe injection.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FLOWGATE_CSS, FLOWGATE_STYLE_ID, installFlowgateStyles } from '../../src/client/styles'
import {
  AlertIcon,
  ArrowIcon,
  CheckIcon,
  GateGlyph,
  LockIcon,
  PanelIcon,
  ShieldIcon,
  SparkIcon,
  StageGlyph,
} from '../../src/client/visual/icons'
import { AnimatedProgress, PulseDot } from '../../src/client/visual/Motion'
import { FlowRail } from '../../src/client/visual/FlowRail'
import { FlowMap } from '../../src/client/visual/FlowMap'
import { DockView as DockViewFromDock } from '../../src/client/dock/StatusBar'
import { buildDockModel, buildPanelModel, placeholderStageNodes } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import { click, findByData } from './hook-harness'
import { makeActiveProjection, makeEmptyProjection, makeProjection } from './mock'

const zh = createTranslator('zh')
const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length
}

describe('icons', () => {
  it('renders a distinct glyph for each of the seven stages', () => {
    const shapes = new Set<string>()
    for (const stage of STAGES) {
      const html = renderToStaticMarkup(<StageGlyph stage={stage} size={16} />)
      expect(html).toContain('<svg')
      expect(html).toContain(`data-stage="${stage}"`)
      expect(html).toContain('aria-hidden="true"')
      shapes.add(html)
    }
    expect(shapes.size).toBe(7)
  })

  it('renders human / automatic / lock gate glyphs with a kind attribute', () => {
    for (const kind of ['human', 'auto', 'lock'] as const) {
      const html = renderToStaticMarkup(<GateGlyph kind={kind} size={12} />)
      expect(html).toContain(`data-gate-kind="${kind}"`)
    }
  })

  it('renders the shared UI icons and exposes an accessible name when titled', () => {
    const icons = [
      renderToStaticMarkup(<ShieldIcon size={14} />),
      renderToStaticMarkup(<LockIcon size={14} />),
      renderToStaticMarkup(<ArrowIcon size={14} />),
      renderToStaticMarkup(<CheckIcon size={14} />),
      renderToStaticMarkup(<SparkIcon size={14} />),
      renderToStaticMarkup(<AlertIcon size={14} />),
      renderToStaticMarkup(<PanelIcon size={14} />),
    ]
    for (const html of icons) expect(html).toContain('<svg')
    const titled = renderToStaticMarkup(<ShieldIcon size={14} title="授权" />)
    expect(titled).toContain('role="img"')
    expect(titled).toContain('aria-label="授权"')
    expect(titled).toContain('<title>授权</title>')
  })
})

describe('motion primitives', () => {
  it('pulse dot exposes its active state and only animates when active', () => {
    const active = renderToStaticMarkup(<PulseDot active color="#2563eb" />)
    expect(active).toContain('data-flowgate="pulse-dot"')
    expect(active).toContain('data-active="true"')
    expect(active).toContain('fg-pulse')

    const idle = renderToStaticMarkup(<PulseDot active={false} />)
    expect(idle).toContain('data-active="false"')
    expect(idle).not.toContain('fg-pulse')
  })

  it('progress ring carries value/max and animates by stroke-dashoffset only', () => {
    const html = renderToStaticMarkup(<AnimatedProgress value={3} max={7} size={52} label="3/7 阶段完成" />)
    expect(html).toContain('data-flowgate="progress-ring"')
    expect(html).toContain('data-value="3"')
    expect(html).toContain('data-max="7"')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="3"')
    expect(html).toContain('aria-valuemax="7"')
    expect(html).toContain('stroke-dashoffset=')
    expect(html).toContain('fg-ring')
    expect(html).toContain('3/7')
    // No inline duration-based animation of layout properties.
    expect(html).not.toContain('width:')
  })

  it('clamps degenerate progress values instead of throwing', () => {
    const html = renderToStaticMarkup(<AnimatedProgress value={-2} max={0} size={40} />)
    expect(html).toContain('data-value="-2"')
    expect(html).toContain('data-max="0"')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('-Infinity')
  })
})

describe('FlowRail', () => {
  function rail(projection = makeProjection(), t = zh, onSelectStage?: (stage: string) => void): string {
    const model = buildDockModel(projection, t)
    return renderToStaticMarkup(
      <FlowRail
        nodes={model.nodes}
        state={model.state}
        t={t}
        awaitingGate={model.awaitingGate}
        onSelectStage={onSelectStage}
      />,
    )
  }

  it('renders the seven-node contract with status / current / gate anchors', () => {
    const html = rail()
    expect(html).toContain('data-flowgate="flow-rail"')
    expect(count(html, /data-flowgate="rail-node"/g)).toBe(7)
    expect(html).toContain('data-current="true"')
    expect(html).toContain('data-status="done"')
    expect(html).toContain('data-status="current"')
    expect(html).toContain('data-awaiting="true"')
    expect(html).toContain('data-flowgate="rail-link"')
    expect(html).toContain('data-link-kind="done"')
    expect(html).toContain('data-link-kind="active"')
  })

  it('renders placeholders as pending nodes before FlowGate is enabled', () => {
    const nodes = placeholderStageNodes(zh)
    const html = renderToStaticMarkup(<FlowRail nodes={nodes} state="demo" t={zh} />)
    expect(count(html, /data-flowgate="rail-node"/g)).toBe(7)
    expect(count(html, /data-status="pending"/g)).toBe(7)
    expect(html).not.toContain('data-current="true"')
  })

  it('reports stage selection clicks to the caller', () => {
    const onSelectStage = vi.fn()
    const model = buildDockModel(makeProjection(), zh)
    const tree = FlowRail({
      nodes: model.nodes,
      state: model.state,
      t: zh,
      awaitingGate: model.awaitingGate,
      onSelectStage,
    })
    const node = findByData(tree, 'data-stage', 'S2')
    expect(node).toBeDefined()
    click(node as React.ReactElement)
    expect(onSelectStage).toHaveBeenCalledWith('S2')
  })
})

describe('FlowMap', () => {
  it('renders the vertical timeline with here marker, gate badges and artifact chips', () => {
    const model = buildPanelModel(makeProjection(), zh)
    const html = renderToStaticMarkup(<FlowMap model={model} t={zh} />)
    expect(html).toContain('data-flowgate="flow-map"')
    expect(count(html, /data-flowgate="flow-map-node"/g)).toBe(7)
    // Legacy stage-node anchors are kept on the clickable rows.
    expect(count(html, /data-flowgate="stage-node"/g)).toBe(7)
    expect(count(html, /data-you-are-here="true"/g)).toBe(1)
    expect(html).toContain('data-gate="G3"')
    expect(html).toContain('data-gate-kind="human"')
    expect(html).toContain('data-gate-kind="auto"')
    expect(html).toContain('data-gate-state="awaiting"')
    expect(html).toContain('data-flowgate="artifact-chip"')
    expect(html).toContain('data-flowgate="flow-map-link"')
    expect(html).toContain('data-flowgate="next-step-callout"')
    expect(html).toContain('data-kind="human"')
    expect(html).toContain('等待你在授权卡上确认 G3')
    expect(html).not.toContain('/flow')
  })

  it('marks the selected stage exactly once with aria-pressed', () => {
    const model = buildPanelModel(makeProjection(), zh)
    const html = renderToStaticMarkup(<FlowMap model={model} t={zh} selectedStage="S1" />)
    expect(count(html, /aria-pressed="true"/g)).toBe(1)
    expect(html).toContain('data-stage="S1"')
  })

  it('reports stage selection clicks to the caller', () => {
    const onSelectStage = vi.fn()
    const model = buildPanelModel(makeProjection(), zh)
    const tree = FlowMap({ model, t: zh, onSelectStage })
    const node = findByData(tree, 'data-flowgate', 'stage-node')
    expect(node).toBeDefined()
    click(node as React.ReactElement)
    expect(onSelectStage).toHaveBeenCalledTimes(1)
  })

  it('renders a setup callout for an uninitialized project', () => {
    const model = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<FlowMap model={model} t={zh} />)
    expect(html).toContain('data-flowgate="flow-map"')
    expect(html).toContain('data-kind="setup"')
    expect(html).toContain('从立项开始')
  })

  it('keeps the callout natural for the active state', () => {
    const model = buildPanelModel(makeActiveProjection(), zh)
    const html = renderToStaticMarkup(<FlowMap model={model} t={zh} />)
    expect(html).toContain('data-kind="auto"')
    expect(html).toContain('继续实现 T2')
    expect(html).not.toContain('/flow')
  })
})

describe('native design tokens / width frame (contract §1.4)', () => {
  it('copies the official PlanReviewPanel frame + inner width formula', () => {
    expect(FLOWGATE_CSS).toContain('.fg-frame {')
    expect(FLOWGATE_CSS).toContain('padding: 6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px;')
    expect(FLOWGATE_CSS).toContain('.fg-frame-inner {')
    expect(FLOWGATE_CSS).toContain('max-width: var(--dsh-chat-content-width, 748px);')
    expect(FLOWGATE_CSS).toContain('margin: 0 auto;')
  })

  it('paints the authorization card with native surface / elevation tokens', () => {
    expect(FLOWGATE_CSS).toContain('.fg-plan-card {')
    expect(FLOWGATE_CSS).toContain('background: var(--dsw-specific-input-major')
    expect(FLOWGATE_CSS).toContain('box-shadow: var(--dsw-elevation-panel')
    expect(FLOWGATE_CSS).toContain('border-radius: var(--dsw-radius-xl')
    expect(FLOWGATE_CSS).toContain('.fg-plan-strip {')
    expect(FLOWGATE_CSS).toContain('--dsw-alias-state-warn-tertiary')
    expect(FLOWGATE_CSS).toContain('--dsw-alias-state-warn-primary')
    expect(FLOWGATE_CSS).toContain('padding: 12px 16px;')
  })

  it('uses native Button tokens (primary fill / outline border) instead of blue/red', () => {
    expect(FLOWGATE_CSS).toContain('.fg-native-btn-primary {')
    expect(FLOWGATE_CSS).toContain('--dsw-alias-button-primary-fill')
    expect(FLOWGATE_CSS).toContain('--dsw-alias-label-primary-foreground')
    expect(FLOWGATE_CSS).toContain('.fg-native-btn-outline {')
    expect(FLOWGATE_CSS).toContain('--dsw-alias-border-l3')
    for (const colourful of ['#2563eb', '#dc2626', '#e5484d', '#d97706', '#16a34a', '#7c3aed', '#1d4ed8', '#b91c1c']) {
      expect(FLOWGATE_CSS).not.toContain(colourful)
    }
  })

  it('keeps every rendered colour behind a --dsw-* token', () => {
    const dockModel = buildDockModel(makeProjection(), zh)
    const dockHtml = renderToStaticMarkup(
      <DockViewFromDock model={dockModel} t={zh} />,
    )
    expect(dockHtml).toContain('data-flowgate="flow-dock-inner"')
    expect(dockHtml).toContain('var(--dsw-alias-label-secondary')
    expect(dockHtml).toContain('var(--dsw-alias-state-warn-primary')
    for (const colourful of ['#2563eb', '#dc2626', '#e5484d', '#d97706', '#16a34a', '#7c3aed']) {
      expect(dockHtml).not.toContain(colourful)
    }

    const railModel = buildDockModel(makeProjection(), zh)
    const railHtml = renderToStaticMarkup(
      <FlowRail nodes={railModel.nodes} state={railModel.state} t={zh} awaitingGate={railModel.awaitingGate} />,
    )
    expect(railHtml).toContain('var(--dsw-alias-label-secondary')
    expect(railHtml).toContain('var(--dsw-alias-border-l3')

    const mapHtml = renderToStaticMarkup(<FlowMap model={buildPanelModel(makeProjection(), zh)} t={zh} />)
    expect(mapHtml).toContain('var(--dsw-alias-label-primary')
    expect(mapHtml).toContain('var(--dsw-alias-border-l2')
    expect(mapHtml).not.toContain('#2563eb')
  })
})

describe('styles (contract §1.3)', () => {
  it('ships every contract animation class and keyframes', () => {
    for (const token of ['fg-pulse', 'fg-dash', 'fg-sweep', 'fg-rise', 'fg-ring', 'fg-arrow', 'fg-halo']) {
      expect(FLOWGATE_CSS).toContain(`.${token}`)
    }
    for (const keyframe of ['fg-pulse', 'fg-dash', 'fg-sweep', 'fg-rise', 'fg-arrow', 'fg-halo']) {
      expect(FLOWGATE_CSS).toContain(`@keyframes ${keyframe}`)
    }
  })

  it('only animates transform / opacity / stroke-dashoffset', () => {
    const animated = [...FLOWGATE_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\s*\}/g)]
    expect(animated.length).toBeGreaterThan(4)
    for (const [, name, body] of animated) {
      const properties = [...(body ?? '').matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1])
      for (const property of properties) {
        expect(['transform', 'opacity', 'stroke-dashoffset']).toContain(property)
      }
      expect(name).not.toBe('')
    }
  })

  it('opts motion in under prefers-reduced-motion and disables it under reduce', () => {
    expect(FLOWGATE_CSS).toContain('@media (prefers-reduced-motion: no-preference)')
    expect(FLOWGATE_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(FLOWGATE_CSS).toContain('animation: none !important')
    expect(FLOWGATE_CSS).toContain('transition: none !important')
  })

  it('is SSR safe: calling the installer without a document is a no-op', () => {
    expect(() => installFlowgateStyles()).not.toThrow()
    expect(FLOWGATE_STYLE_ID).toBe('dsh-flowgate-styles')
  })

  it('injects the stylesheet exactly once into a browser document', () => {
    const registry = new Map<string, Record<string, unknown>>()
    const appended: Record<string, unknown>[] = []
    const fakeDocument = {
      getElementById: (id: string): unknown => registry.get(id) ?? null,
      createElement: (): Record<string, unknown> => {
        const element: Record<string, unknown> = {}
        element['setAttribute'] = (key: string, value: string) => {
          element[key] = value
        }
        return element
      },
      head: {
        appendChild: (element: Record<string, unknown>): void => {
          appended.push(element)
          const id = element['id']
          if (typeof id === 'string') registry.set(id, element)
        },
      },
    }
    const globals = globalThis as unknown as { document?: unknown }
    const original = globals.document
    globals.document = fakeDocument
    try {
      installFlowgateStyles()
      installFlowgateStyles()
    } finally {
      if (original === undefined) delete globals.document
      else globals.document = original
    }
    expect(appended).toHaveLength(1)
    expect(appended[0]?.['id']).toBe(FLOWGATE_STYLE_ID)
    expect(appended[0]?.['data-flowgate-css']).toBe('')
    expect(String(appended[0]?.['textContent'])).toContain('fg-pulse')
  })
})
