/**
 * Gate authorization-card interaction tests (v0.2 interaction contract,
 * docs/impl/ui-interaction-redesign.md §0/§2/§3).
 *
 * - the gate waiting for the owner renders as a graphical authorization card
 *   (shield badge + check progress ring/dots + buttons), with no `/flow ...`
 *   command text to copy/type;
 * - approve / reject / raise clicks map to the documented `ClientAction`s;
 * - reject requires an inline reason; the merged low-complexity card keeps its
 *   three buttons;
 * - the panel action ports (`performAction` + `bridge.runCommand`) submit the
 *   command through the host command remote and never fill the composer — the
 *   Panel container change itself belongs to T1, but this covers the ports it
 *   will pass.
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildPanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import { performAction } from '../../src/client/actions'
import type { ClientAction } from '../../src/client/actions'
import { createHostBridge } from '../../src/client/bridge'
import type { ClientContext, FlowgateProjection } from '../../src/client/types'
import { GatesView } from '../../src/client/panel/views/Gates'
import type { ViewProps } from '../../src/client/panel/view-types'
import { click, findByData, mountWithHooks } from './hook-harness'
import type { MountedView } from './hook-harness'
import { makeLowComplexityProjection, makePanel, makeProjection } from './mock'

const zh = createTranslator('zh')
const noop = (_action: ClientAction): void => {}

function viewProps(projection: FlowgateProjection, onAction: (action: ClientAction) => void = noop): ViewProps {
  return { model: buildPanelModel(projection, zh), t: zh, onAction }
}

function renderGates(projection: FlowgateProjection): string {
  return renderToStaticMarkup(React.createElement(GatesView, viewProps(projection)))
}

function mountGates(
  projection: FlowgateProjection,
  onAction: (action: ClientAction) => void = noop,
): MountedView<ViewProps> {
  return mountWithHooks<ViewProps>(GatesView, viewProps(projection, onAction))
}

/** Type a value into a controlled input through its onChange handler. */
function typeInto(element: React.ReactElement, value: string): void {
  const onChange = (element.props as { onChange?: (event: { target: { value: string } }) => void }).onChange
  if (typeof onChange !== 'function') throw new Error('element has no onChange handler')
  onChange({ target: { value } })
}

describe('gates view — graphical authorization card', () => {
  it('renders card shell, shield badge, check ring and dots instead of command text', () => {
    const html = renderGates(makeProjection())
    expect(html).toContain('data-flowgate="gate-auth-card"')
    expect(html).toContain('data-kind="gate"')
    expect(html).toContain('data-gate="G3"')
    expect(html).toContain('data-state="awaiting"')
    expect(html).toContain('data-awaiting="true"')
    expect(html).toContain('data-flowgate="gate-badge"')
    expect(html).toContain('data-flowgate="gate-ring"')
    expect(html).toContain('data-passed="2"')
    expect(html).toContain('data-total="3"')
    expect(html).toContain('data-flowgate="gate-progress"')
    expect((html.match(/data-flowgate="gate-dot"/g) ?? []).length).toBe(3)
    // The legacy check-item semantics are preserved for older tests/consumers.
    expect((html.match(/data-flowgate="gate-item"/g) ?? []).length).toBe(3)
    // No `/flow ...` text the owner would have to type or copy.
    expect(html).not.toContain('/flow')
  })

  it('approve is a click-to-authorize button (onAction, no command text)', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'gate-approve')!)
    expect(actions).toEqual([{ kind: 'approve', gate: 'G3' }])
    expect(view.html).not.toContain('/flow')
  })

  it('reject opens the inline reason form; an empty reason is refused before any action fires', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'gate-reject')!)
    view.render()
    expect(view.html).toContain('data-flowgate="reject-form"')
    expect(view.html).toContain('data-flowgate="reject-reason"')

    click(findByData(view.tree, 'data-action', 'gate-reject-submit')!)
    view.render()
    expect(actions).toEqual([])
    expect(view.html).toContain('退回需要写理由')
  })

  it('submits the trimmed inline reject reason to onAction', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'gate-reject')!)
    view.render()
    typeInto(findByData(view.tree, 'data-flowgate', 'reject-reason')!, '  验收标准不够  ')
    view.render()
    click(findByData(view.tree, 'data-action', 'gate-reject-submit')!)
    expect(actions).toEqual([{ kind: 'reject', gate: 'G3', reason: '验收标准不够' }])
  })

  it('hides the decision buttons once the gate is no longer waiting for the owner', () => {
    const projection = makeProjection({
      panel: makePanel({
        gate: { gate: 'G3', state: 'passed', awaitingOwner: false, items: [{ item: 'risk-categories', label: '风险登记五类齐全', passed: true }] },
      }),
    })
    const html = renderGates(projection)
    expect(html).toContain('data-state="passed"')
    expect(html).toContain('data-awaiting="false"')
    expect(html).not.toContain('data-action="gate-approve"')
    expect(html).not.toContain('data-action="gate-reject"')
  })
})

describe('gates view — low-complexity merged confirmation card', () => {
  it('keeps the three authorization buttons and an empty-reason guard', () => {
    const html = renderGates(makeLowComplexityProjection())
    expect(html).toContain('data-flowgate="gate-auth-card"')
    expect(html).toContain('data-kind="merged-confirm"')
    expect(html).toContain('data-confirm-card="true"')
    expect(html).toContain('低复杂度方案确认卡')
    for (const dataAction of ['confirm-card-approve', 'confirm-card-reject', 'confirm-card-raise']) {
      expect(html).toContain(`data-action="${dataAction}"`)
    }
    expect(html).not.toContain('/flow')
  })

  it('confirm advances with the approve action', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeLowComplexityProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'confirm-card-approve')!)
    expect(actions).toEqual([{ kind: 'approve', gate: 'G3' }])
  })

  it('confirm carries confirmRisks when the host requires it', () => {
    const projection = makeProjection({
      panel: makePanel({
        gate: {
          gate: 'G3',
          state: 'awaiting',
          awaitingOwner: true,
          items: [],
          mergedConfirm: {
            goal: '把首页按钮文案改成「马上抢购」',
            acceptance: ['点击按钮进入抢购页'],
            scope: ['src/pages/Home.tsx'],
            verify: 'pnpm test',
            requireConfirmation: true,
          },
        },
      }),
    })
    const actions: ClientAction[] = []
    const view = mountGates(projection, (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'confirm-card-approve')!)
    expect(actions).toEqual([{ kind: 'approve', gate: 'G3', confirmRisks: true }])
  })

  it('reject asks for an inline reason and submits it', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeLowComplexityProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'confirm-card-reject')!)
    view.render()
    expect(view.html).toContain('data-flowgate="reject-form"')
    typeInto(findByData(view.tree, 'data-flowgate', 'reject-reason')!, '范围还缺迁移脚本')
    view.render()
    click(findByData(view.tree, 'data-action', 'gate-reject-submit')!)
    expect(actions).toEqual([{ kind: 'reject', gate: 'G3', reason: '范围还缺迁移脚本' }])
  })

  it('raise complexity is one click (no command to type)', () => {
    const actions: ClientAction[] = []
    const view = mountGates(makeLowComplexityProjection(), (action) => actions.push(action))
    click(findByData(view.tree, 'data-action', 'confirm-card-raise')!)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('raise-complexity')
  })
})

describe('panel action ports — click-to-execute end to end (no typed command)', () => {
  /** Fake client context: host command remote + legacy composer draft recorder. */
  function fakeContext(): { ctx: ClientContext; executed: string[]; drafts: string[] } {
    const executed: string[] = []
    const drafts: string[] = []
    const ctx: ClientContext = {
      inject: (deps: string[], callback: (c: ClientContext) => unknown) => {
        if (deps.includes('remote.commands')) {
          const result = callback({
            remote: {
              commands: {
                execute: async (_agentId: string, line: string) => {
                  executed.push(line)
                  return { ok: true }
                },
              },
            } as unknown as ClientContext['remote'],
          })
          return typeof result === 'function' ? result : undefined
        }
        if (deps.includes('sessions')) {
          const result = callback({
            sessions: { binding: (sessionId: string) => (sessionId === 'web-1' ? { ctx: {} } : undefined) },
            conversation: {
              input: {
                for: () => ({
                  setDraft: (text: string) => {
                    drafts.push(text)
                  },
                }),
              },
            },
          })
          return typeof result === 'function' ? result : undefined
        }
        return () => {}
      },
    }
    return { ctx, executed, drafts }
  }

  it('approve from the panel goes through runCommand, fallback=false, composer untouched', async () => {
    const fake = fakeContext()
    const bridge = createHostBridge(fake.ctx)
    bridge.wire()
    const outcome = await performAction(
      { kind: 'approve', gate: 'G3' },
      {
        t: zh,
        executeCommand: (command) => bridge.runCommand(command, 'web-1'),
        fillCommand: (command) => bridge.fillCommand(command, 'web-1'),
      },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(outcome.message).toBe('已执行')
    expect(outcome.command).toBe('/flow approve G3')
    expect(fake.executed).toEqual(['/flow approve G3'])
    // Click = authorization: nothing was written into the session input box.
    expect(fake.drafts).toEqual([])
  })

  it('reject with a reason from the panel goes through runCommand as well', async () => {
    const fake = fakeContext()
    const bridge = createHostBridge(fake.ctx)
    bridge.wire()
    const outcome = await performAction(
      { kind: 'reject', gate: 'G3', reason: '缺方案对比' },
      {
        t: zh,
        executeCommand: (command) => bridge.runCommand(command, 'web-1'),
        fillCommand: (command) => bridge.fillCommand(command, 'web-1'),
      },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(fake.executed).toEqual(['/flow reject 缺方案对比'])
    expect(fake.drafts).toEqual([])
  })
})
