/**
 * 上下文注入与 turn-stopping（完成定义：注入文本单测 + 拦住"宣布完成"）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  claimsCompletion,
  hasFreshGreen,
  INTERACTION_CONTRACT,
  lastAssistantText,
  resetContextStateForTest,
} from '../../src/host/context/index.js'
import type { EvidenceReceipt } from '../../src/core/types.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
  resetContextStateForTest()
})

function engineState(engine: PluginHarness['engine']) {
  return (engine as unknown as { state: import('../../src/host/testing/fake-ctx.js').FakeEngineState }).state
}

function makeReceipt(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    id: 'E-1',
    changeId: 'C-001',
    group: 'unit',
    kind: 'test',
    phase: 'green',
    command: 'pnpm test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: { parser: 'fake', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 },
    inputsHash: 'sha256:x',
    outputRef: '.flowgate/state/evidence/E-1.log',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    ...overrides,
  }
}

describe('系统提示注入', () => {
  it('systemPrompt.section 注册 flowgate:runtime，渲染 engine.buildInjection().text + 交互契约', async () => {
    harness = await setupPlugin()
    const section = harness.prompt.state.sections.get('flowgate:runtime')
    expect(section).toBeDefined()
    expect(section?.order).toBe(9000)
    const text = typeof section?.text === 'function' ? (section.text as (ctx: unknown) => string)({ agent: harness.agent }) : section?.text
    expect(String(text)).toContain('假注入')
    expect(String(text)).toContain('S4')
    // 卡片优先交互契约（§0 规则 2 / §5.2）：授权卡片 + 原生提问卡，不许要求负责人手输命令。
    expect(String(text)).toContain('交互契约：')
    expect(String(text)).toContain('授权卡片')
    expect(String(text)).toContain('ask_user_question')
    expect(String(text).endsWith(INTERACTION_CONTRACT)).toBe(true)
  })

  it('未初始化时注入空文本（不污染普通项目提示词，也不追加交互契约）', async () => {
    const { createFakeEngine } = await import('../../src/host/testing/fake-ctx.js')
    harness = await setupPlugin({ engine: createFakeEngine({ initialized: false }), bindAgent: false })
    const section = harness.prompt.state.sections.get('flowgate:runtime')
    const text = typeof section?.text === 'function' ? (section.text as (ctx: unknown) => string)({ agent: harness.agent }) : section?.text
    expect(String(text)).toBe('')
    expect(String(text)).not.toContain(INTERACTION_CONTRACT)
  })
})

describe('完成类表述检测', () => {
  it.each([
    ['已完成全部修复', true],
    ['全部通过，done', true],
    ['fixed the bug, all tests pass', true],
    ['接下来分析依赖', false],
    ['我还没开始', false],
  ])('%s → %s', (text, expected) => {
    expect(claimsCompletion(text)).toBe(expected)
  })

  it('lastAssistantText 从 assistant/message 事件末尾提取', async () => {
    const { createFakeAgent, createFakeSession } = await import('../../src/host/testing/fake-ctx.js')
    const session = createFakeSession({
      events: [
        { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '做吧' }] } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '已完成' }] } } },
      ],
    })
    const agent = createFakeAgent({ id: 'a', ctx: undefined, session })
    expect(lastAssistantText(agent)).toBe('已完成')
  })

  it('hasFreshGreen 只认本回合开始后的 GREEN 回执', () => {
    const now = Date.parse('2026-01-01T00:00:10.000Z')
    expect(hasFreshGreen([makeReceipt()], 'T1', now)).toBeNull() // 回执早于回合开始
    expect(hasFreshGreen([makeReceipt({ finishedAt: '2026-01-01T00:00:12.000Z', taskId: 'T1' })], 'T1', now)).not.toBeNull()
    expect(hasFreshGreen([makeReceipt({ phase: 'red', finishedAt: '2026-01-01T00:00:12.000Z' })], undefined, now)).toBeNull()
  })
})

describe('turn-stopping：宣布完成但无新鲜 GREEN', () => {
  it('steer 一次并写 turn.continued 账本', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { initialized: true, stage: 'S4', activeTaskId: 'T1' }
    // 最后一条 assistant 消息声称完成。
    harness.agent.session.append('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: '已完成，全部通过' }] },
    })
    harness.runtime.emit()
    // 先走一次 pre-step 记录回合开始时间。
    await harness.ctx.runWaterfall(
      'agent/pre-step',
      [{ agent: harness.agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }],
      async () => ({ kind: 'enter', messages: [] }),
    )
    harness.ctx.emitEvent('agent/turn-stopping', { agent: harness.agent, turn: 1, signal: new AbortController().signal })
    await flush()
    expect(harness.agent.state.steered.length).toBe(1)
    expect(String(harness.agent.state.steered[0]?.content[0]?.text)).toContain('验证回执')
    expect(engineState(harness.engine).calls.turnContinued.length).toBe(1)
  })

  it('有新鲜 GREEN 回执时不 steer', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { initialized: true, stage: 'S4', activeTaskId: 'T1' }
    engineState(harness.engine).receipts = [makeReceipt({ taskId: 'T1', finishedAt: new Date().toISOString() })]
    harness.agent.session.append('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: '已完成' }] },
    })
    harness.runtime.emit()
    await harness.ctx.runWaterfall(
      'agent/pre-step',
      [{ agent: harness.agent, messages: [], turn: 2, step: 1, signal: new AbortController().signal }],
      async () => ({ kind: 'enter', messages: [] }),
    )
    harness.ctx.emitEvent('agent/turn-stopping', { agent: harness.agent, turn: 2, signal: new AbortController().signal })
    await flush()
    expect(harness.agent.state.steered.length).toBe(0)
  })

  it('同一回合最多 steer limit.turn_continue_max（2）次', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { initialized: true, stage: 'S4', activeTaskId: 'T1' }
    harness.agent.session.append('assistant/message', {
      message: { role: 'assistant', content: [{ type: 'text', text: '已完成' }] },
    })
    harness.runtime.emit()
    await harness.ctx.runWaterfall(
      'agent/pre-step',
      [{ agent: harness.agent, messages: [], turn: 9, step: 1, signal: new AbortController().signal }],
      async () => ({ kind: 'enter', messages: [] }),
    )
    for (let index = 0; index < 4; index += 1) {
      harness.ctx.emitEvent('agent/turn-stopping', { agent: harness.agent, turn: 9, signal: new AbortController().signal })
      await flush(3)
    }
    expect(harness.agent.state.steered.length).toBe(2)
  })

  it('非 S4/S5 阶段不打扰', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).snapshotOverrides = { initialized: true, stage: 'S1' }
    harness.agent.session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '已完成澄清' }] } })
    harness.runtime.emit()
    harness.ctx.emitEvent('agent/turn-stopping', { agent: harness.agent, turn: 1, signal: new AbortController().signal })
    await flush()
    expect(harness.agent.state.steered.length).toBe(0)
  })
})
