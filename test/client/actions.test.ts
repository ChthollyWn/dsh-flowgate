/**
 * Action mapping + fallback tests.
 *
 * v0.2 interaction contract (docs/impl/ui-interaction-redesign.md §0/§4):
 *  - click-to-execute: the button click submits the equivalent `/flow ...` line
 *    through the host command remote (`ports.executeCommand`), the outcome is
 *    `fallback=false` and the composer draft is NEVER written;
 *  - legacy degradation (host without the command remote): composer draft, then
 *    clipboard (`fallback=true`);
 *  - everything failing: `actions.executeFailed`, never a raw command hint.
 */
import { describe, expect, it } from 'vitest'
import {
  commandFor,
  needsReason,
  performAction,
  toRemotePayload,
  unwrapEnvelope,
} from '../../src/client/actions'
import type { ActionPorts, ClientAction } from '../../src/client/actions'
import type { FlowgateAction, FlowgateRemote } from '../../src/client/types'
import { createTranslator } from '../../src/client/i18n'

const zh = createTranslator('zh')

function ports(overrides: Partial<ActionPorts> = {}): ActionPorts {
  return { t: zh, ...overrides }
}

function recordingRemote(response: unknown = { ok: true, message: '已批准' }): {
  remote: FlowgateRemote
  calls: FlowgateAction[]
} {
  const calls: FlowgateAction[] = []
  return {
    calls,
    remote: {
      action: async (payload: FlowgateAction) => {
        calls.push(payload)
        return response
      },
    },
  }
}

describe('commandFor', () => {
  it('maps every human action to its documented /flow command', () => {
    const cases: [ClientAction, string][] = [
      [{ kind: 'approve', gate: 'G1' }, '/flow approve G1'],
      [{ kind: 'reject', gate: 'G1', reason: '验收标准不够' }, '/flow reject 验收标准不够'],
      [{ kind: 'approve-pending', id: 'RK-1' }, '/flow risk approve RK-1'],
      [{ kind: 'approve-pending', id: 'PC-3', reason: '计划可以' }, '/flow plan approve PC-3 计划可以'],
      [{ kind: 'reject-pending', id: 'SC-2', reason: '范围不清' }, '/flow scope reject SC-2 范围不清'],
      [{ kind: 'reject-pending', id: 'PC-3', reason: '计划要拆' }, '/flow plan reject PC-3 计划要拆'],
      // Blockers are cleared with `/flow unblock`, never `/flow blocker …`.
      [{ kind: 'unblock', id: 'BL-1' }, '/flow unblock BL-1'],
      [{ kind: 'unblock', id: 'BL-2', reason: '已修复' }, '/flow unblock BL-2 已修复'],
      [{ kind: 'approve-pending', id: 'BL-3' }, '/flow unblock BL-3'],
      [{ kind: 'reject-pending', id: 'BL-3', reason: '不解除' }, ''],
      [{ kind: 'allow-once', ruleId: 'R-STAGE-SRC', reason: '紧急修复' }, '/flow allow-once R-STAGE-SRC 紧急修复'],
      [{ kind: 'revoke-exception', id: 'EX-1' }, '/flow exception revoke EX-1'],
      [
        { kind: 'add-exception', ruleId: 'R-SCOPE', reason: '迁移期放行' },
        '/flow exception add R-SCOPE - 迁移期放行',
      ],
      [
        { kind: 'add-exception', ruleId: 'R-SCOPE', pathPattern: 'src/legacy/**', reason: '迁移期放行' },
        '/flow exception add R-SCOPE src/legacy/** 迁移期放行',
      ],
      [{ kind: 'confirm-external' }, '/flow external confirm all'],
      [{ kind: 'confirm-external', path: 'src/manual.ts' }, '/flow external confirm src/manual.ts'],
      [{ kind: 'raise-complexity', reason: '范围变大' }, '/flow complexity high 范围变大'],
      // Dock authorization cards for non-project states (demo / locked / off).
      [{ kind: 'enable' }, '/flow init'],
      [{ kind: 'repair' }, '/flow repair'],
      [{ kind: 'gates-on' }, '/flow on'],
      [{ kind: 'resume', changeId: 'C-003' }, '/flow resume C-003'],
      [{ kind: 'resume', changeId: 'C-003', takeover: true }, '/flow resume C-003 --takeover'],
      [{ kind: 'pause' }, '/flow pause'],
      [{ kind: 'report' }, '/flow report'],
      [{ kind: 'board' }, '/flow board'],
      [{ kind: 'metrics-export' }, '/flow metrics --csv'],
    ]
    for (const [action, command] of cases) {
      expect(commandFor(action)).toBe(command)
    }
    expect(commandFor({ kind: 'open-panel' })).toBe('')
  })

  it('knows which actions require a written reason', () => {
    expect(needsReason({ kind: 'reject', gate: 'G1', reason: 'x' })).toBe(true)
    expect(needsReason({ kind: 'allow-once', ruleId: 'R', reason: 'x' })).toBe(true)
    expect(needsReason({ kind: 'approve', gate: 'G1' })).toBe(false)
    expect(needsReason({ kind: 'pause' })).toBe(false)
    expect(needsReason({ kind: 'enable' })).toBe(false)
    expect(needsReason({ kind: 'repair' })).toBe(false)
    expect(needsReason({ kind: 'gates-on' })).toBe(false)
  })

  it('maps UI actions to the host remote payload from the contract', () => {
    expect(toRemotePayload({ kind: 'approve', gate: 'G3' })).toEqual({ type: 'approve', gate: 'G3' })
    expect(toRemotePayload({ kind: 'allow-once', ruleId: 'R-1', reason: 'x' })).toEqual({
      type: 'allow-once',
      ruleId: 'R-1',
      reason: 'x',
    })
    expect(
      toRemotePayload({ kind: 'add-exception', ruleId: 'R-1', pathPattern: 'src/**', reason: 'x' }),
    ).toEqual({ type: 'add-exception', ruleId: 'R-1', pathPattern: 'src/**', reason: 'x' })
    expect(toRemotePayload({ kind: 'open-panel' })).toBeNull()
    expect(toRemotePayload({ kind: 'unblock', id: 'BL-1', reason: '已修复' })).toEqual({
      type: 'approve-pending',
      id: 'BL-1',
      reason: '已修复',
    })
    expect(toRemotePayload({ kind: 'unblock', id: 'BL-2' })).toEqual({ type: 'approve-pending', id: 'BL-2' })
  })

  it('unwraps gateway envelopes and plain values', () => {
    expect(unwrapEnvelope({ ok: true, message: 'done' })).toEqual({ ok: true, message: 'done', value: undefined })
    expect(unwrapEnvelope({ ok: false, message: 'nope' }).ok).toBe(false)
    expect(unwrapEnvelope('plain')).toEqual({ ok: true, message: 'plain' })
  })
})

describe('performAction', () => {
  it('uses the host remote when available', async () => {
    const { remote, calls } = recordingRemote({ ok: true, message: '已批准 G3' })
    const outcome = await performAction({ kind: 'approve', gate: 'G3' }, ports({ remote }))
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(outcome.message).toContain('已批准 G3')
    expect(calls).toEqual([{ type: 'approve', gate: 'G3' }])
  })

  it('T2.6 click-to-execute: approve G1 runs through the command remote and never fills the composer', async () => {
    const executed: string[] = []
    const drafts: string[] = []
    const outcome = await performAction(
      { kind: 'approve', gate: 'G1' },
      ports({
        executeCommand: (command) => {
          executed.push(command)
          return true
        },
        fillCommand: (command) => {
          drafts.push(command)
          return true
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(outcome.message).toBe('已执行')
    expect(outcome.command).toBe('/flow approve G1')
    expect(executed).toEqual(['/flow approve G1'])
    // The click is the human authorization: the input box stays empty.
    expect(drafts).toEqual([])
  })

  it('accepts an async command remote and still skips the composer draft', async () => {
    const drafts: string[] = []
    const outcome = await performAction(
      { kind: 'approve-pending', id: 'RK-2', reason: '接受风险' },
      ports({
        executeCommand: async (command) => command === '/flow risk approve RK-2 接受风险',
        fillCommand: (command) => {
          drafts.push(command)
          return true
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(outcome.command).toBe('/flow risk approve RK-2 接受风险')
    expect(drafts).toEqual([])
  })

  it('prefers click-to-execute over the composer when the host remote fails', async () => {
    const { remote } = recordingRemote({ ok: false, message: '无权调用' })
    const executed: string[] = []
    const drafts: string[] = []
    const outcome = await performAction(
      { kind: 'approve', gate: 'G3' },
      ports({
        remote,
        executeCommand: (command) => {
          executed.push(command)
          return true
        },
        fillCommand: (command) => {
          drafts.push(command)
          return true
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(false)
    expect(executed).toEqual(['/flow approve G3'])
    expect(drafts).toEqual([])
  })

  it('degrades to the composer draft when the command remote rejects or throws', async () => {
    const drafts: string[] = []
    const rejected = await performAction(
      { kind: 'approve', gate: 'G3' },
      ports({
        executeCommand: () => false,
        fillCommand: (command) => {
          drafts.push(command)
          return true
        },
      }),
    )
    expect(rejected.ok).toBe(true)
    expect(rejected.fallback).toBe(true)
    expect(drafts).toEqual(['/flow approve G3'])

    const thrown = await performAction(
      { kind: 'approve', gate: 'G3' },
      ports({
        executeCommand: () => {
          throw new Error('command remote crashed')
        },
        fillCommand: (command) => {
          drafts.push(command)
          return true
        },
      }),
    )
    expect(thrown.ok).toBe(true)
    expect(thrown.fallback).toBe(true)
    expect(drafts).toEqual(['/flow approve G3', '/flow approve G3'])
  })

  it('falls back to the composer draft on older hosts without the command remote', async () => {
    const filled: string[] = []
    const outcome = await performAction(
      { kind: 'approve', gate: 'G1' },
      ports({ fillCommand: (command) => { filled.push(command); return true } }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(true)
    expect(filled).toEqual(['/flow approve G1'])
    expect(outcome.command).toBe('/flow approve G1')
  })

  it('never executes a command for pending or invalid actions that need no command', async () => {
    const executed: string[] = []
    const executeCommand = (command: string): boolean => {
      executed.push(command)
      return true
    }
    const opened = await performAction(
      { kind: 'open-panel' },
      ports({ executeCommand, openPanel: () => true }),
    )
    expect(opened.ok).toBe(true)
    expect(executed).toEqual([])
    const noReason = await performAction(
      { kind: 'reject', gate: 'G3', reason: '   ' },
      ports({ executeCommand }),
    )
    expect(noReason.ok).toBe(false)
    expect(noReason.needsReason).toBe(true)
    expect(executed).toEqual([])
  })

  it('falls back to the composer draft when the remote returns an error', async () => {
    const { remote } = recordingRemote({ ok: false, message: '无权调用' })
    const filled: string[] = []
    const outcome = await performAction(
      { kind: 'approve', gate: 'G3' },
      ports({ remote, fillCommand: (command) => { filled.push(command); return true } }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(true)
    expect(filled).toEqual(['/flow approve G3'])
  })

  it('falls back to the clipboard when the composer cannot be filled', async () => {
    const copied: string[] = []
    const outcome = await performAction(
      { kind: 'reject', gate: 'G3', reason: '缺方案对比' },
      ports({
        fillCommand: () => false,
        copyText: (text) => {
          copied.push(text)
          return true
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.fallback).toBe(true)
    expect(copied).toEqual(['/flow reject 缺方案对比'])
    expect(outcome.message).toContain('/flow reject')
  })

  it('refuses actions that need a reason without one', async () => {
    const filled: string[] = []
    const outcome = await performAction(
      { kind: 'reject', gate: 'G3', reason: '   ' },
      ports({ fillCommand: (command) => { filled.push(command); return true } }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.needsReason).toBe(true)
    expect(filled).toHaveLength(0)
  })

  it('executes pending decisions with their command family', async () => {
    const filled: string[] = []
    await performAction(
      { kind: 'approve-pending', id: 'RK-2', reason: '接受风险' },
      ports({ fillCommand: (command) => { filled.push(command); return true } }),
    )
    await performAction(
      { kind: 'reject-pending', id: 'SC-3', reason: '范围太大' },
      ports({ fillCommand: (command) => { filled.push(command); return true } }),
    )
    expect(filled).toEqual(['/flow risk approve RK-2 接受风险', '/flow scope reject SC-3 范围太大'])
  })

  it('opens the panel locally and never throws when the opener fails', async () => {
    const opened = await performAction({ kind: 'open-panel' }, ports({ openPanel: () => true }))
    expect(opened.ok).toBe(true)
    const failed = await performAction(
      { kind: 'open-panel' },
      ports({ openPanel: () => { throw new Error('boom') } }),
    )
    expect(failed.ok).toBe(false)
  })

  it('copies intercept evidence for the false-positive workflow (FR-9.3)', async () => {
    const copied: string[] = []
    const outcome = await performAction(
      { kind: 'copy-evidence', text: '{"ruleId":"R-1"}' },
      ports({ copyText: (text) => { copied.push(text); return true } }),
    )
    expect(outcome.ok).toBe(true)
    expect(copied).toHaveLength(1)
    expect(outcome.message).toBe('拦截证据已复制')
  })

  it('falls back to /flow metrics --csv when export cannot be handled', async () => {
    const filled: string[] = []
    await performAction(
      { kind: 'metrics-export' },
      ports({ fillCommand: (command) => { filled.push(command); return true } }),
    )
    expect(filled).toEqual(['/flow metrics --csv'])
  })

  it('click-to-execute covers the dock state cards (enable / repair / gates-on)', async () => {
    const executed: string[] = []
    const drafts: string[] = []
    const actionPorts = ports({
      executeCommand: (command) => {
        executed.push(command)
        return true
      },
      fillCommand: (command) => {
        drafts.push(command)
        return true
      },
    })
    const messages: string[] = []
    for (const action of [{ kind: 'enable' }, { kind: 'repair' }, { kind: 'gates-on' }] as const) {
      const outcome = await performAction(action, actionPorts)
      expect(outcome.ok).toBe(true)
      expect(outcome.fallback).toBe(false)
      messages.push(outcome.message)
    }
    expect(executed).toEqual(['/flow init', '/flow repair', '/flow on'])
    expect(messages).toEqual(['已执行', '已执行', '已执行'])
    expect(drafts).toEqual([])
  })

  it('reports actions.executeFailed when every path fails (never a raw command hint)', async () => {
    const outcome = await performAction(
      { kind: 'report' },
      ports({ executeCommand: () => false, fillCommand: () => false, copyText: () => false }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.fallback).toBe(true)
    expect(outcome.message).toBe('未能执行，请稍后重试或打开面板查看')
    expect(outcome.message).not.toContain('/flow')
    expect(outcome.command).toBe('/flow report')
  })
})
