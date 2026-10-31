/**
 * SSR + interaction tests for the graphical input dock (contract §1.2 / §2).
 *
 * Covers the four contract layers:
 *  - DOM anchors: data-flowgate="flow-dock" / "flow-rail" / "rail-node" /
 *    "dock-next" / "auth-card" / data-action="auth-*";
 *  - the full state machine: demo / locked / off / idle / active / awaiting /
 *    pending / blocked;
 *  - authorization-card behaviour (approve, inline reject reason + submit) via
 *    the hook harness;
 *  - copy safety: no user-visible `/flow ...` command anywhere in the dock.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DockView, StatusBar, toClientAction } from '../../src/client/dock/StatusBar'
import type { DockActionRequest } from '../../src/client/dock/StatusBar'
import { buildDockModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { FlowgateProjection } from '../../src/client/types'
import { click, findByData, mountWithHooks } from './hook-harness'
import {
  makeActiveProjection,
  makeBlockedProjection,
  makeEmptyProjection,
  makeIdleProjection,
  makeLockedProjection,
  makeLowComplexityProjection,
  makeObserveProjection,
  makeOffProjection,
  makePendingProjection,
  makeProjection,
  makeRepairProjection,
} from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')

function render(
  projection: FlowgateProjection | null,
  t = zh,
  extra: { onAction?: (request: DockActionRequest) => void; onOpen?: () => void; busy?: boolean; notice?: string } = {},
): string {
  const model = buildDockModel(projection, t)
  return renderToStaticMarkup(
    <DockView
      model={model}
      t={t}
      onAction={extra.onAction ?? (() => {})}
      onOpen={extra.onOpen ?? (() => {})}
      busy={extra.busy}
      notice={extra.notice}
    />,
  )
}

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length
}

describe('dock DOM contract', () => {
  it('renders the auto-flow route chip from snapshot.flowPlan', () => {
    const projection = makeProjection({
      snapshot: {
        flowPlan: { route: 'fast', autoApprove: true, verdict: 'approved', reasons: ['需求清晰'] },
      },
    })
    const html = render(projection)
    expect(html).toContain('data-flowgate="dock-flow-route"')
    expect(html).toContain('data-route="fast"')
    expect(html).toContain('自动流程 · fast')
  })

  it('renders the root, seven-node rail and next-step chip with data-* anchors', () => {
    const html = render(makeActiveProjection())
    expect(html).toContain('data-flowgate="flow-dock"')
    // Width anchor: frame + inner wrapper aligned to the native composer width.
    expect(html).toContain('class="fg-frame"')
    expect(html).toContain('data-flowgate="flow-dock-inner"')
    expect(html).toContain('class="fg-frame-inner"')
    expect(html).toContain('data-state="active"')
    expect(html).toContain('data-tone="active"')
    expect(html).toContain('data-flowgate="flow-rail"')
    expect(count(html, /data-flowgate="rail-node"/g)).toBe(7)
    for (const stage of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
      expect(html).toContain(`data-stage="${stage}"`)
    }
    expect(html).toContain('data-current="true"')
    expect(html).toContain('data-flowgate="dock-next"')
    expect(html).toContain('data-kind="auto"')
  })

  it('never renders a typed `/flow ...` command in any dock state', () => {
    const projections: (FlowgateProjection | null)[] = [
      null,
      makeEmptyProjection(),
      makeLockedProjection(),
      makeOffProjection(),
      makeIdleProjection(),
      makeActiveProjection(),
      makeProjection(),
      makePendingProjection(),
      makeBlockedProjection(),
      makeLowComplexityProjection(),
    ]
    for (const projection of projections) {
      const html = render(projection)
      expect(html, `state ${buildDockModel(projection, zh).state}`).not.toContain('/flow')
    }
  })

  it('renders English copy without leaking i18n keys', () => {
    const html = render(makeProjection(), en)
    expect(html).toContain('Waiting for your approval · G3')
    expect(html).not.toContain('dock.auth')
    expect(html).not.toContain('viz.')
  })
})

describe('dock state machine', () => {
  it('demo: gray rail + enable card', () => {
    const html = render(makeEmptyProjection())
    expect(html).toContain('data-state="demo"')
    expect(html).toContain('data-tone="disabled"')
    expect(html).toContain('data-initialized="false"')
    expect(count(html, /data-flowgate="rail-node"/g)).toBe(7)
    expect(count(html, /data-status="pending"/g)).toBe(7)
    expect(html).toContain('data-flowgate="auth-card"')
    expect(html).toContain('data-kind="enable"')
    expect(html).toContain('class="fg-plan-card fg-rise fg-sweep"')
    expect(html).toContain('data-flowgate="auth-strip"')
    expect(html).toContain('data-action="auth-enable"')
    expect(html).toContain('fg-native-btn-primary')
    expect(html).toContain('启用 FlowGate')
  })

  it('locked: repair card', () => {
    const html = render(makeLockedProjection())
    expect(html).toContain('data-state="locked"')
    expect(html).toContain('data-tone="blocked"')
    expect(html).toContain('data-kind="repair"')
    expect(html).toContain('data-action="auth-repair"')
  })

  it('off: reconnect card', () => {
    const html = render(makeOffProjection())
    expect(html).toContain('data-state="off"')
    expect(html).toContain('data-tone="blocked"')
    expect(html).toContain('data-kind="reconnect"')
    expect(html).toContain('data-action="auth-enable"')
    expect(html).toContain('恢复门禁')
  })

  it('idle: gray rail + one-sentence prompt, no card', () => {
    const html = render(makeIdleProjection())
    expect(html).toContain('data-state="idle"')
    expect(html).not.toContain('data-flowgate="auth-card"')
    expect(html).toContain('data-kind="question"')
    expect(html).toContain('用一句话描述你想做的变更')
  })

  it('active: highlighted rail + natural-language next chip, no card', () => {
    const html = render(makeActiveProjection())
    expect(html).toContain('data-state="active"')
    expect(html).not.toContain('data-flowgate="auth-card"')
    expect(html).toContain('继续实现 T2')
    // Three stages are done in the fixture → solid links, no command text.
    expect(count(html, /data-status="done"/g)).toBe(3)
  })

  it('sanitizes a legacy command-style next step coming from the host', () => {
    const projection = makeProjection({
      snapshot: {
        awaitingGate: undefined,
        pendingGate: undefined,
        pending: [],
        violations: [],
        interceptCounts: {},
        nextStep: '/flow approve G3',
      },
      panel: { gate: undefined },
    })
    const html = render(projection)
    expect(html).toContain('data-state="active"')
    expect(html).not.toContain('/flow')
    // Model-facing host copy is replaced by a stage-level human phrase.
    expect(html).toContain('准备设计、风险与任务清单')
    expect(html).not.toContain('flow_submit')
  })

  it('awaiting: gate authorization card with approve / reject / details', () => {
    const html = render(makeProjection())
    expect(html).toContain('data-state="awaiting"')
    expect(html).toContain('data-tone="attention"')
    expect(html).toContain('data-flowgate="auth-card"')
    expect(html).toContain('data-kind="gate"')
    expect(html).toContain('data-gate="G3"')
    expect(html).toContain('data-action="auth-approve"')
    expect(html).toContain('data-action="auth-reject"')
    expect(html).toContain('data-action="auth-open-panel"')
    // Gate check items are rendered as graphic dots, not text commands.
    expect(count(html, /data-flowgate="auth-check"/g)).toBe(3)
    expect(html).toContain('data-passed="false"')
    expect(html).toContain('data-flowgate="auth-check-summary"')
    expect(html).toContain('2/3')
    // Native plan card structure: strip + body + footer, no big coloured ring.
    expect(html).not.toContain('data-flowgate="progress-ring"')
    expect(html).toContain('data-flowgate="auth-strip"')
    expect(html).toContain('data-flowgate="auth-body"')
    expect(html).toContain('data-flowgate="auth-footer"')
    expect(html).toContain('data-flowgate="dock-next"')
    expect(html).toContain('data-kind="action"')
    expect(html).toContain('等你批准计划')
  })

  it('pending: first open decision card with +n fold and family approve label', () => {
    const html = render(makePendingProjection())
    expect(html).toContain('data-state="pending"')
    expect(html).toContain('data-kind="pending"')
    expect(html).toContain('data-action="auth-approve"')
    expect(html).toContain('data-action="auth-reject"')
    expect(html).toContain('data-flowgate="auth-more"')
    expect(html).toContain('fg-native-btn-outline')
    expect(html).toContain('+1')
    expect(html).toContain('确认风险接管')
  })

  it('blocked: violation card offers confirming non-agent changes', () => {
    const html = render(makeBlockedProjection())
    expect(html).toContain('data-state="blocked"')
    expect(html).toContain('data-tone="blocked"')
    expect(html).toContain('data-kind="external"')
    expect(html).toContain('data-action="auth-confirm"')
    expect(html).toContain('src/manual.ts')
    expect(html).toContain('有改动越界')
  })

  it('low-complexity merged gate renders confirm / reject / raise triple', () => {
    const html = render(makeLowComplexityProjection())
    expect(html).toContain('data-flowgate="auth-card"')
    expect(html).toContain('data-action="auth-approve"')
    expect(html).toContain('data-action="auth-reject"')
    expect(html).toContain('data-action="auth-raise"')
    expect(html).toContain('class="fg-plan-card fg-rise fg-sweep"')
    expect(html).toContain('等你确认方案 · G3')
    expect(html).toContain('把首页按钮文案改成')
  })

  it('marks busy actions as disabled and shows the notice line', () => {
    const html = render(makeProjection(), zh, { busy: true, notice: '已执行' })
    expect(html).toContain('提交中…')
    expect(html).toContain('data-flowgate="dock-notice"')
    expect(count(html, /disabled=""/g)).toBeGreaterThan(0)
  })
})

describe('authorization card interaction', () => {
  it('reports the approve click to the container', () => {
    const onAction = vi.fn()
    const view = mountWithHooks(DockView, { model: buildDockModel(makeProjection(), zh), t: zh, onAction })
    const approve = findByData(view.tree, 'data-action', 'auth-approve')
    expect(approve).toBeDefined()
    click(approve as React.ReactElement)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ kind: 'approve', dataAction: 'auth-approve' })
  })

  it('opens the inline reject form and submits the typed reason', () => {
    const onAction = vi.fn()
    const view = mountWithHooks(DockView, { model: buildDockModel(makeProjection(), zh), t: zh, onAction })
    const reject = findByData(view.tree, 'data-action', 'auth-reject')
    expect(reject).toBeDefined()
    click(reject as React.ReactElement)
    view.render()

    const textarea = findByData(view.tree, 'data-flowgate', 'auth-reason')
    expect(textarea).toBeDefined()
    const onChange = (textarea?.props as { onChange?: (event: unknown) => void }).onChange
    expect(onChange).toBeTypeOf('function')
    onChange?.({ target: { value: '范围太大，先拆小' } })
    view.render()

    const submit = findByData(view.tree, 'data-action', 'auth-reject-submit')
    expect(submit).toBeDefined()
    expect((submit?.props as { disabled?: boolean }).disabled).toBe(false)
    click(submit as React.ReactElement)
    expect(onAction).toHaveBeenCalledWith({
      kind: 'reject',
      dataAction: 'auth-reject-submit',
      reason: '范围太大，先拆小',
    })
  })

  it('keeps the reject submit disabled until a reason is typed', () => {
    const view = mountWithHooks(DockView, { model: buildDockModel(makeProjection(), zh), t: zh, onAction: () => {} })
    click(findByData(view.tree, 'data-action', 'auth-reject') as React.ReactElement)
    view.render()
    const submit = findByData(view.tree, 'data-action', 'auth-reject-submit')
    expect((submit?.props as { disabled?: boolean }).disabled).toBe(true)
  })

  it('maps card buttons back to the action layer', () => {
    const gateCard = buildDockModel(makeProjection(), zh).card
    expect(toClientAction({ kind: 'approve', dataAction: 'auth-approve' }, gateCard)).toEqual({
      kind: 'approve',
      gate: 'G3',
    })
    expect(toClientAction({ kind: 'reject', dataAction: 'auth-reject', reason: 'x' }, gateCard)).toEqual({
      kind: 'reject',
      gate: 'G3',
      reason: 'x',
    })

    const pendingCard = buildDockModel(makePendingProjection(), zh).card
    expect(toClientAction({ kind: 'approve', dataAction: 'auth-approve' }, pendingCard)).toEqual({
      kind: 'approve-pending',
      id: 'RK-1',
    })
    expect(toClientAction({ kind: 'reject', dataAction: 'auth-reject', reason: 'x' }, pendingCard)).toEqual({
      kind: 'reject-pending',
      id: 'RK-1',
      reason: 'x',
    })

    expect(toClientAction({ kind: 'enable', dataAction: 'auth-enable' }, undefined)).toEqual({ kind: 'enable' })
    expect(toClientAction({ kind: 'repair', dataAction: 'auth-repair' }, undefined)).toEqual({ kind: 'repair' })
    expect(toClientAction({ kind: 'gates-on', dataAction: 'auth-enable' }, undefined)).toEqual({ kind: 'gates-on' })
    expect(toClientAction({ kind: 'confirm', dataAction: 'auth-confirm' }, undefined)).toEqual({
      kind: 'confirm-external',
    })
    expect(toClientAction({ kind: 'open-panel', dataAction: 'auth-open-panel' }, undefined)).toEqual({
      kind: 'open-panel',
    })
    expect(toClientAction({ kind: 'raise', dataAction: 'auth-raise' }, undefined)).toEqual({ kind: 'raise-complexity' })
  })
})

describe('StatusBar slot container', () => {
  it('renders the demo dock without a projection and never throws', () => {
    const html = renderToStaticMarkup(<StatusBar props={{}} t={zh} />)
    expect(html).toContain('data-flowgate="flow-dock"')
    expect(html).toContain('data-state="demo"')
  })

  it('reads the projection from the standard kit and shows the awaiting card', () => {
    const props = {
      sessionId: 'web-1a2b',
      useProjection: (key: string) => (key === 'flowgate' ? makeProjection() : undefined),
    }
    const html = renderToStaticMarkup(<StatusBar props={props} t={zh} />)
    expect(html).toContain('data-state="awaiting"')
    expect(html).toContain('data-flowgate="auth-card"')
    expect(html).toContain('data-action="auth-approve"')
  })
})

describe('修复通道 / 接管模式徽标（v0.6 客户端契约）', () => {
  it('renders the repair lane badge + RED/GREEN progress without a gate card', () => {
    const html = render(makeRepairProjection())
    expect(html).toContain('data-state="repair"')
    expect(html).toContain('data-flowgate="dock-repair"')
    expect(html).toContain('data-fix-id="FIX-20261101-031500"')
    expect(html).toContain('data-red="true"')
    expect(html).toContain('data-green="false"')
    expect(html).toContain('修复 FIX-20261101-031500')
    // 修复车道不产生人工门授权卡。
    expect(html).not.toContain('data-flowgate="auth-card"')
  })

  it('shows observe mode, agent pause and incident badges during self-hosting recovery', () => {
    const html = render(makeObserveProjection())
    expect(html).toContain('data-flowgate="dock-mode"')
    expect(html).toContain('data-mode="observe"')
    expect(html).toContain('观察模式')
    expect(html).toContain('data-flowgate="dock-off-by"')
    expect(html).toContain('agent 已暂停门禁')
    expect(html).toContain('data-flowgate="dock-incident"')
    expect(html).toContain('INC-20261101-031000')
  })

  it('does not show repair/observe badges for an ordinary change', () => {
    const html = render(makeProjection())
    expect(html).not.toContain('data-flowgate="dock-repair"')
    expect(html).not.toContain('data-flowgate="dock-mode"')
    expect(html).not.toContain('data-flowgate="dock-incident"')
  })
})
