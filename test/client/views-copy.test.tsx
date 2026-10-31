/**
 * Copy audit (v0.2 interaction contract, docs/impl/ui-interaction-redesign.md
 * §0/§3/§6): **no panel view may render a `/flow ...` command the owner has to
 * type**. Human decisions are card/button clicks; advanced users can still find
 * commands in `/flow help`, which is not panel copy.
 *
 * The contract allows trial/help hints to keep `/flow` as an advanced entry
 * point (docs/impl/ui-interaction-redesign.md §6); `/flow trial` is therefore
 * accepted by the helper. T1 has since de-commanded those hints too, so the
 * intercepts trial tab is additionally asserted to render no `/flow` at all.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildPanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { TFn } from '../../src/client/i18n'
import type { ClientAction } from '../../src/client/actions'
import type { FlowgateProjection } from '../../src/client/types'
import type { ViewProps } from '../../src/client/panel/view-types'
import { GatesView } from '../../src/client/panel/views/Gates'
import { InterceptsView } from '../../src/client/panel/views/Intercepts'
import { LedgerView } from '../../src/client/panel/views/Ledger'
import { MetricsView } from '../../src/client/panel/views/Metrics'
import { PipelineView } from '../../src/client/panel/views/Pipeline'
import { RiskView } from '../../src/client/panel/views/Risk'
import { TasksView } from '../../src/client/panel/views/Tasks'
import { TraceView } from '../../src/client/panel/views/Trace'
import { click, findByData, mountWithHooks } from './hook-harness'
import { makeEmptyProjection, makeLowComplexityProjection, makeProjection } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (_action: ClientAction): void => {}

const VIEWS: [name: string, component: React.ComponentType<ViewProps>][] = [
  ['ledger', LedgerView],
  ['pipeline', PipelineView],
  ['gates', GatesView],
  ['tasks', TasksView],
  ['trace', TraceView],
  ['risk', RiskView],
  ['intercepts', InterceptsView],
  ['metrics', MetricsView],
]

function panelProps(projection: FlowgateProjection, locale: TFn = zh): ViewProps {
  return { model: buildPanelModel(projection, locale), t: locale, onAction: noop }
}

function renderView(component: React.ComponentType<ViewProps>, projection: FlowgateProjection, locale: TFn = zh): string {
  return renderToStaticMarkup(React.createElement(component, panelProps(projection, locale)))
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Only what the owner can see: text nodes + user-facing aria/title/placeholder/alt. */
function visibleCopy(html: string): string {
  const text = decodeEntities(html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, '\n'))
  const attrs = [...html.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]*)"/g)].map((match) =>
    decodeEntities(match[1] ?? ''),
  )
  return [text, ...attrs].join('\n')
}

/** All `/flow ...` fragments in the visible copy. */
function commandFragments(copy: string): string[] {
  return copy.match(/\/flow[^\n]*/g) ?? []
}

/** Every `/flow ...` occurrence must be an allowed explanatory hint. */
function expectNoTypedCommand(copy: string, where: string, whitelist: string[] = []): void {
  for (const fragment of commandFragments(copy)) {
    const allowed =
      fragment.startsWith('/flow trial') || whitelist.some((entry) => fragment.startsWith(entry))
    expect(allowed, `${where} 仍然渲染了需要手输的命令片段：${fragment.trim()}`).toBe(true)
  }
}

describe('panel views — no typed /flow command in visible copy', () => {
  for (const [name, component] of VIEWS) {
    it(`${name}: rich projection (zh)`, () => {
      const html = renderView(component, makeProjection())
      expect(html).toContain('data-flowgate=')
      expectNoTypedCommand(visibleCopy(html), name)
    })
  }

  for (const [name, component] of VIEWS) {
    it(`${name}: empty / demo projection (zh)`, () => {
      const html = renderView(component, makeEmptyProjection())
      expect(html.length).toBeGreaterThan(0)
      expectNoTypedCommand(visibleCopy(html), `${name}(empty)`)
    })
  }

  for (const [name, component] of VIEWS) {
    it(`${name}: English locale`, () => {
      const html = renderView(component, makeProjection(), en)
      expect(html).toContain('data-flowgate=')
      expectNoTypedCommand(visibleCopy(html), `${name}(en)`)
    })
  }

  it('gates: low-complexity merged confirmation card is card-oriented too', () => {
    const html = renderView(GatesView, makeLowComplexityProjection())
    expect(html).toContain('data-confirm-card="true"')
    expectNoTypedCommand(visibleCopy(html), 'gates(merged)')
  })

  it('ledger: no legacy "human decisions only through buttons or commands" hint', () => {
    const html = renderView(LedgerView, makeProjection())
    // The old footer encouraged typed commands; the buttons are self-explanatory now.
    expect(html).not.toContain('人工动作只能由按钮或命令触发')
    expect(html).not.toContain('Human decisions only happen through buttons or commands')
  })

  it('metrics: no copy about the command being placed in the input box', () => {
    const html = renderView(MetricsView, makeProjection())
    expect(html).not.toContain('导出失败时会把命令填进输入框')
    expect(html).not.toContain('the command is placed in the input box')
  })
})

describe('intercepts view — host rule hints are card-oriented', () => {
  it('the false-positive feedback sheet never shows a host /flow unlock command', () => {
    const view = mountWithHooks<ViewProps>(InterceptsView, panelProps(makeProjection()))
    click(findByData(view.tree, 'data-action', 'intercept-feedback-0')!)
    view.render()
    expect(view.html).toContain('data-flowgate="intercept-feedback"')
    // The mock host rule carries `unlock: '/flow allow-once …'`; the card must
    // not forward that prompt to the owner.
    expect(visibleCopy(view.html)).not.toContain('/flow allow-once')
    expectNoTypedCommand(visibleCopy(view.html), 'intercepts(feedback)')
  })

  it('the local trial tab explains host authority without any typed command', () => {
    const view = mountWithHooks<ViewProps>(InterceptsView, panelProps(makeProjection()))
    click(findByData(view.tree, 'data-tab', 'trial')!)
    view.render()
    click(findByData(view.tree, 'data-action', 'rule-trial-run')!)
    view.render()
    expect(view.html).toContain('data-flowgate="trial-result"')
    expect(view.html).toContain('data-flowgate="trial-approximate"')
    // T1 de-commanded the trial disclaimer; nothing here asks the owner to type.
    expect(commandFragments(visibleCopy(view.html))).toEqual([])
  })
})

describe('pipeline view — no learning mode anymore', () => {
  it('renders the graphical flow without stage cards, glossary or mode selector', () => {
    const projection = makeProjection({ snapshot: { stage: 'S6' } })
    const html = renderView(PipelineView, projection)
    expect(html).toContain('data-flowgate="flow-map"')
    expect(html).not.toContain('data-flowgate="stage-card')
    expect(html).not.toContain('data-flowgate="glossary')
    expect(html).not.toContain('data-flowgate="learning-mode"')
    expect(html).not.toMatch(/\/flow\s+(learn|approve|reject)/)
  })
})

