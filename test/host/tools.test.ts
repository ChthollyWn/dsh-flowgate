/**
 * flow_* 工具注册、参数校验与错误口径（完成定义：工具注册单测）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { FLOW_TOOL_NAMES } from '../../src/host/tools/definitions.js'
import type { DshToolDefinition } from '../../src/host/adapters/dsh-types.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function engineState(engine: PluginHarness['engine']) {
  return (engine as unknown as { state: import('../../src/host/testing/fake-ctx.js').FakeEngineState }).state
}

async function runTool(harness: PluginHarness, name: string, args: Record<string, unknown>) {
  const tool = harness.tools.state.tools.get(name)
  if (!tool) throw new Error(`tool ${name} 未注册`)
  const value = await tool.execute(args, {
    callId: `call-${name}`,
    name,
    arguments: args,
    agent: harness.agent,
    signal: new AbortController().signal,
  } as never)
  return { tool, value: value as { ok: boolean; summary: string; data?: Record<string, unknown> } }
}

describe('工具注册', () => {
  it('14 个 flow_* 工具全部注册', () => {
    harness = null
    return setupPlugin().then(async (setup) => {
      harness = setup
      for (const name of FLOW_TOOL_NAMES) {
        expect(harness.tools.state.tools.has(name), `${name} 未注册`).toBe(true)
      }
    })
  })

  it('每个工具都有模型可见参数 schema 与 output.render', async () => {
    harness = await setupPlugin()
    for (const [, tool] of harness.tools.state.tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.parameters).toMatchObject({ type: 'object' })
      expect(typeof tool.output.render).toBe('function')
      expect(tool.output.schema).toBeTruthy()
    }
  })

  it('没有任何批准/放行/降级类工具（红线）', async () => {
    harness = await setupPlugin()
    const names = [...harness.tools.state.tools.keys()]
    for (const forbidden of ['flow_approve', 'flow_allow', 'flow_release', 'flow_lower', 'flow_off']) {
      expect(names).not.toContain(forbidden)
    }
  })
})

describe('工具执行与错误口径', () => {
  it('flow_status 返回状态文本与结构化 data', async () => {
    harness = await setupPlugin()
    const { value, tool } = await runTool(harness, 'flow_status', {})
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('S4 执行中')
    expect(value.data?.snapshot).toBeTruthy()
    const rendered = tool.output.render({}, value)
    expect(rendered[0]?.type).toBe('text')
    expect(String(rendered[0]?.text)).toContain('S4 执行中')
  })

  it('flow_submit 无效 gate 返回 {error,hint,validValues}', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_submit', { gate: 'G99' })
    expect(value.ok).toBe(false)
    expect(value.data?.error).toBeTruthy()
    expect(value.data?.hint).toBeTruthy()
    expect(value.data?.validValues).toMatchObject({ gate: expect.arrayContaining(['G1', 'G3']) })
  })

  it('flow_submit 正常提交返回 awaiting:owner', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_submit', { gate: 'G1' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('等待负责人批准')
    expect(value.data?.awaiting).toBe('owner')
  })

  it('flow_verify 调用 engine.runVerify 并返回回执摘要', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_verify', { group: 'unit' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('E-0001')
    expect(value.data?.receipt).toMatchObject({ phase: 'green', exitCode: 0 })
  })

  it('flow_new_change 调 engine.newChange', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_new_change', { title: '续费回调幂等' })
    expect(value.ok).toBe(true)
    expect(engineState(harness.engine).calls.newChange.length).toBe(1)
    expect(value.data?.changeId).toBe('C-001')
  })

  it('flow_request_scope_change 空 add 返回错误提示', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_request_scope_change', { taskId: 'T1', add: [], reason: 'x' })
    expect(value.ok).toBe(false)
    expect(String(value.data?.error)).toContain('add 不能为空')
  })

  it('flow_attach_evidence 标注 agent 自述', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_attach_evidence', { kind: 'manual', path: '.flowgate/notes.md', note: '手工验证' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('agent 自述')
  })

  it('flow_propose_rule / flow_report_risk 生成待处理项 id', async () => {
    harness = await setupPlugin()
    const risk = await runTool(harness, 'flow_report_risk', { category: 'security', description: 'x', proposal: 'y' })
    expect(risk.value.data?.id).toBe('RK-1')
    const rule = await runTool(harness, 'flow_propose_rule', { finding: 'f', rule: 'r', example: 'e', scope: '本变更' })
    expect(rule.value.data?.id).toBe('RL-1')
  })

  it('flow_investigate 在缺少子 agent 能力时返回结构化错误', async () => {
    harness = await setupPlugin({ services: { subagents: undefined } })
    const { value } = await runTool(harness, 'flow_investigate', { questions: ['x'], benefit: 'y' })
    expect(value.ok).toBe(false)
    expect(String(value.data?.hint)).toBeTruthy()
  })

  it('flow_task_done 在审查不可用时仍调用 engine.taskDone（审查缺失由任务门决定）', async () => {
    harness = await setupPlugin({ services: { subagents: undefined } })
    engineState(harness.engine).tasks = [
      {
        id: 'T1',
        title: '任务',
        covers: [],
        scope: ['src/a.ts'],
        tests: [],
        newFiles: [],
        changes: [],
        dependsOn: [],
        tdd: 'optional',
        verify: [],
        run: 'main',
        risk: [],
        size: 'S',
        body: '',
      },
    ]
    engineState(harness.engine).current = {
      id: 'C-001',
      kind: 'change',
      title: '测试变更',
      stage: 'S4',
      complexity: 'low',
      risk: 'normal',
      lifecycle: 'active',
      reviews: [],
      tasks: {},
    }
    const { value } = await runTool(harness, 'flow_task_done', { taskId: 'T1' })
    expect(value.ok).toBe(true)
    expect(engineState(harness.engine).calls.taskDone).toContain('T1')
  })
})

describe('tool results are lossless JSON', () => {
  it('strips undefined/class values before returning to the runtime', async () => {
    const { toLosslessJson } = await import('../../src/host/tools/schema.js')
    const sanitized = toLosslessJson({ ok: true, summary: 'x', data: { a: undefined, b: new Date(0), c: [1, undefined] } }) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(sanitized)
    expect((sanitized.data as Record<string, unknown>).a).toBeUndefined()
    expect((sanitized.data as Record<string, unknown>).c).toEqual([1, null])
  })
})
