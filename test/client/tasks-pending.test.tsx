/**
 * Tasks view pending-decision entry points (P1-3):
 *
 * The panel used to offer approve/reject buttons only for `scope` and
 * `conflict` items; plan/rule/risk/blocker were reachable only through
 * `/flow …` commands. These tests pin:
 *  - one owner entry per open pending kind (approve/reject; blocker → unblock),
 *    decided (non-open) items stay hidden;
 *  - the action each button dispatches maps onto the documented
 *    `/flow <kind> approve|reject <id> [理由]` command (or
 *    `/flow unblock <BL-n> [理由]`) through the mandatory H10 fallback;
 *  - the blocker entry uses the `approve-pending` remote payload on hosts that
 *    implement the remote face (there is no separate `unblock` payload in the
 *    rc.5 client contract).
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isOwnerPendingItem, pendingDecisionAction, TasksView } from '../../src/client/panel/views/Tasks'
import { buildPanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import { performAction } from '../../src/client/actions'
import type { ActionPorts } from '../../src/client/actions'
import type { FlowgateAction } from '../../src/client/types'
import type { PendingItem } from '../../src/core/types'
import { makeProjection } from './mock'

const zh = createTranslator('zh')
const noop = (): void => {}

function pending(overrides: Partial<PendingItem> & Pick<PendingItem, 'id' | 'kind'>): PendingItem {
  return {
    changeId: 'C-003',
    title: `${overrides.id} 标题`,
    detail: `${overrides.id} 详情`,
    status: 'open',
    createdAt: '2026-10-30T09:00:00Z',
    ...overrides,
  }
}

const PENDING_ITEMS: PendingItem[] = [
  pending({ id: 'SC-1', kind: 'scope', title: 'T2 需要多改一个文件' }),
  pending({ id: 'RK-1', kind: 'risk', title: '新增支付依赖' }),
  pending({ id: 'PC-1', kind: 'plan', title: '计划修订：拆 B2' }),
  pending({ id: 'RL-1', kind: 'rule', title: '规则提议：新增 protected 路径' }),
  pending({ id: 'CF-1', kind: 'conflict', title: 'B2 集成检查点冲突' }),
  pending({ id: 'BL-1', kind: 'blocker', title: 'T2 连续失败触发熔断' }),
  // Decided items must not present an action entry.
  pending({ id: 'SC-0', kind: 'scope', title: '已经批准过的范围变更', status: 'approved' }),
]

function renderTasks(items: PendingItem[] = PENDING_ITEMS, locale = zh): string {
  const projection = makeProjection({ snapshot: { pending: items } })
  const model = buildPanelModel(projection, locale)
  return renderToStaticMarkup(<TasksView model={model} t={locale} onAction={noop} />)
}

function fillCommandPorts(): { ports: ActionPorts; commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    ports: {
      t: zh,
      fillCommand: (command: string) => {
        commands.push(command)
        return true
      },
    },
  }
}

function recordingRemotePorts(): { ports: ActionPorts; calls: FlowgateAction[] } {
  const calls: FlowgateAction[] = []
  return {
    calls,
    ports: {
      t: zh,
      remote: {
        action: async (payload: FlowgateAction) => {
          calls.push(payload)
          return { ok: true, message: '已提交' }
        },
      },
    },
  }
}

describe('tasks view — owner-decidable pending items (P1-3)', () => {
  it('offers an entry for every owner-decidable open pending kind', () => {
    const html = renderTasks()
    for (const item of PENDING_ITEMS.filter((entry) => entry.status === 'open')) {
      expect(html, item.id).toContain(`data-pending-id="${item.id}"`)
      expect(html, item.id).toContain(`data-pending-kind="${item.kind}"`)
    }
    // Decided items are filtered out.
    expect(html).not.toContain('data-pending-id="SC-0"')
    expect((html.match(/data-flowgate="pending-decision"/g) ?? []).length).toBe(PENDING_ITEMS.length - 1)
  })

  it('renders approve / reject buttons for plan, rule, risk, scope and conflict rows', () => {
    const html = renderTasks()
    for (const id of ['SC-1', 'RK-1', 'PC-1', 'RL-1', 'CF-1']) {
      expect(html, id).toContain(`data-action="pending-open-approve-${id}"`)
      expect(html, id).toContain(`data-action="pending-open-reject-${id}"`)
    }
    // No textarea is shown before the owner opens a decision.
    expect((html.match(/<textarea/g) ?? []).length).toBe(0)
  })

  it('renders a single unblock entry for blocker rows (no approve/reject)', () => {
    const html = renderTasks()
    expect(html).toContain('data-action="pending-open-unblock-BL-1"')
    expect(html).not.toContain('data-action="pending-open-approve-BL-1"')
    expect(html).not.toContain('data-action="pending-open-reject-BL-1"')
    expect(html).toContain('熔断待解除')
    expect(html).toContain('解除熔断')
  })

  it('labels each kind instead of reusing the scope wording', () => {
    const html = renderTasks()
    expect(html).toContain('风险接管待确认')
    expect(html).toContain('计划修订待审阅')
    expect(html).toContain('规则提议待审阅')
    expect(html).toContain('处理合并冲突')
    expect(html).toContain('批准范围变更')
  })

  it('ignores non-decidable kinds and closed items', () => {
    const items = [
      pending({ id: 'OV-1', kind: 'override', title: 'override 伪项' }),
      pending({ id: 'EX-1', kind: 'exception', title: 'exception 伪项' }),
      pending({ id: 'RL-9', kind: 'rule', title: '已退回规则', status: 'rejected' }),
    ]
    expect(items.filter(isOwnerPendingItem)).toHaveLength(0)
    expect(renderTasks(items)).not.toContain('data-flowgate="pending-decision"')
  })

  it('renders without a snapshot / pending array', () => {
    const model = buildPanelModel(makeProjection({ snapshot: { pending: [] } }), zh)
    const html = renderToStaticMarkup(<TasksView model={model} t={zh} onAction={noop} />)
    expect(html).not.toContain('data-flowgate="pending-decision"')
  })
})

describe('tasks view — button actions map to /flow commands (P1-3)', () => {
  it('plan approve → /flow plan approve PC-1', async () => {
    const { ports, commands } = fillCommandPorts()
    const item = PENDING_ITEMS.find((entry) => entry.id === 'PC-1')!
    const outcome = await performAction(pendingDecisionAction(item, 'approve', ''), ports)
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(true)
    expect(commands).toEqual(['/flow plan approve PC-1'])
  })

  it('rule reject → /flow rule reject RL-1 <理由>', async () => {
    const { ports, commands } = fillCommandPorts()
    const item = PENDING_ITEMS.find((entry) => entry.id === 'RL-1')!
    await performAction(pendingDecisionAction(item, 'reject', '规则太笼统'), ports)
    expect(commands).toEqual(['/flow rule reject RL-1 规则太笼统'])
  })

  it('risk / scope / conflict reuse their command families', async () => {
    const { ports, commands } = fillCommandPorts()
    for (const id of ['RK-1', 'SC-1', 'CF-1']) {
      const item = PENDING_ITEMS.find((entry) => entry.id === id)!
      await performAction(pendingDecisionAction(item, 'approve', '接受'), ports)
    }
    expect(commands).toEqual([
      '/flow risk approve RK-1 接受',
      '/flow scope approve SC-1 接受',
      '/flow conflict approve CF-1 接受',
    ])
  })

  it('blocker unblock → /flow unblock BL-1 <理由> (reason optional)', async () => {
    const { ports, commands } = fillCommandPorts()
    const item = PENDING_ITEMS.find((entry) => entry.id === 'BL-1')!
    await performAction(pendingDecisionAction(item, 'approve', '已修复并补了回归测试'), ports)
    await performAction(pendingDecisionAction(item, 'approve', ''), ports)
    expect(commands).toEqual(['/flow unblock BL-1 已修复并补了回归测试', '/flow unblock BL-1'])
  })

  it('uses the remote when the host exposes one (blocker reuses approve-pending)', async () => {
    const { ports, calls } = recordingRemotePorts()
    const blocker = PENDING_ITEMS.find((entry) => entry.id === 'BL-1')!
    const plan = PENDING_ITEMS.find((entry) => entry.id === 'PC-1')!
    const rule = PENDING_ITEMS.find((entry) => entry.id === 'RL-1')!
    await performAction(pendingDecisionAction(blocker, 'approve', '已修复'), ports)
    await performAction(pendingDecisionAction(plan, 'reject', '计划要拆'), ports)
    await performAction(pendingDecisionAction(rule, 'approve', ''), ports)
    expect(calls).toEqual([
      { type: 'approve-pending', id: 'BL-1', reason: '已修复' },
      { type: 'reject-pending', id: 'PC-1', reason: '计划要拆' },
      { type: 'approve-pending', id: 'RL-1' },
    ])
  })

  it('falls back to the composer when the remote errors, and never fabricates a blocker reject', async () => {
    const commands: string[] = []
    const ports: ActionPorts = {
      t: zh,
      remote: { action: async () => ({ ok: false, message: '无权调用' }) },
      fillCommand: (command: string) => {
        commands.push(command)
        return true
      },
    }
    const blocker = PENDING_ITEMS.find((entry) => entry.id === 'BL-1')!
    await performAction(pendingDecisionAction(blocker, 'approve', ''), ports)
    expect(commands).toEqual(['/flow unblock BL-1'])
    // `/flow blocker reject` is not a documented command: the client reports an
    // invalid action instead of filling an unrunnable command.
    const rejected = await performAction(pendingDecisionAction(blocker, 'reject', '不解除'), ports)
    expect(rejected.ok).toBe(false)
    expect(rejected.fallback).toBe(false)
    expect(commands).toEqual(['/flow unblock BL-1'])
  })
})
