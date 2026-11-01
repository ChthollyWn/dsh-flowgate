/**
 * flow_* 工具注册、参数校验与错误口径（完成定义：工具注册单测）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { FLOW_TOOL_NAMES } from '../../src/host/tools/definitions.js'
import type { DshToolDefinition } from '../../src/host/adapters/dsh-types.js'
import { isLosslessJson } from '../../src/host/boundary/json.js'

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
  it('20 个 flow_* 工具全部注册（FLOW_TOOL_NAMES 与注册表一致）', () => {
    harness = null
    return setupPlugin().then(async (setup) => {
      harness = setup
      expect(FLOW_TOOL_NAMES.length).toBe(20)
      for (const name of FLOW_TOOL_NAMES) {
        expect(harness.tools.state.tools.has(name), `${name} 未注册`).toBe(true)
      }
      // 修复通道/事故工具必须在清单里（P1-8）。
      for (const name of ['flow_fix_start', 'flow_fix_done', 'flow_fix_abort', 'flow_self_pause', 'flow_incident_close']) {
        expect(FLOW_TOOL_NAMES).toContain(name)
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

describe('修复通道工具（P1-8/P1-9）', () => {
  it('flow_fix_start 声明修复并返回 FIX-id/scope/verify 与 RED→GREEN→done 下一步', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_fix_start', {
      title: '续费回调重复扣款',
      symptom: '生产回调重试导致重复扣款',
      scope: ['src/renewal/**'],
      verify: 'pnpm vitest run test/renewal',
      severity: 'P0',
    })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('修复通道已开启')
    expect(value.summary).toContain('无需立项/人工门')
    expect(value.summary).toContain('RED')
    expect(value.data?.id).toBe('FIX-20260101-000000')
    expect(value.data?.scope).toEqual(['src/renewal/**'])
    expect(value.data?.verify).toBe('pnpm vitest run test/renewal')
    expect(engineState(harness.engine).calls.startRepair.length).toBe(1)
  })

  it('flow_fix_start 省略 scope 时交给 engine 智能准入（host 不再本地拒绝）', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_fix_start', { symptom: 'y', verify: 'pnpm test' })
    expect(value.ok).toBe(true)
    expect(engineState(harness.engine).calls.startRepair.length).toBe(1)
    expect(engineState(harness.engine).calls.startRepair[0]).toMatchObject({ symptom: 'y', verify: 'pnpm test' })
  })

  it('flow_fix_start dryRun 只做智能准入预演，不开启修复', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_fix_start', { symptom: '重复扣款', dryRun: true })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('修复准入预演')
    expect(value.summary).toContain('推荐车道')
    expect(value.data?.started).toBe(false)
    expect(engineState(harness.engine).calls.startRepair.length).toBe(0)
    expect(engineState(harness.engine).calls.previewRepair.length).toBe(1)
  })

  it('flow_fix_done 关闭修复并返回中文修复报告（证据/改动/是否成功）', async () => {
    harness = await setupPlugin()
    await runTool(harness, 'flow_fix_start', {
      title: '回调重复扣款',
      symptom: '重复扣款',
      scope: ['src/renewal/**'],
      verify: 'pnpm test',
    })
    const { value } = await runTool(harness, 'flow_fix_done', { summary: '根因是重试未幂等；已加幂等键' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('修复报告')
    expect(value.summary).toContain('是否成功：是')
    expect(value.summary).toContain('RED')
    expect(value.summary).toContain('GREEN')
    expect(value.summary).toContain('.flowgate/fixes/')
    expect(value.data?.ok).toBe(true)
    expect(value.data?.evidence).toMatchObject({ red: 'E-RED-1', green: 'E-GREEN-1' })
    expect(engineState(harness.engine).calls.finishRepair.length).toBe(1)
  })

  it('flow_fix_abort 放弃修复并写审计原因', async () => {
    harness = await setupPlugin()
    await runTool(harness, 'flow_fix_start', { title: 'x', symptom: 'y', scope: ['src/a.ts'], verify: 'pnpm test' })
    const { value } = await runTool(harness, 'flow_fix_abort', { reason: '根因判断错误，改走正式变更' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('已放弃修复')
    expect(value.summary).toContain('根因判断错误')
    expect(engineState(harness.engine).calls.abortRepair).toEqual(['根因判断错误，改走正式变更'])
  })

  it('flow_self_pause 返回事故 id、暂停说明与恢复方式（agent 不能自行恢复）', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_self_pause', { reason: '主流程不可用，需要负责人决策', severity: 'P1' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('INC-1')
    expect(value.summary).toContain('不能自行恢复')
    expect(value.summary).toContain('/flow on')
    expect(value.summary).toContain('flow_incident_close')
    expect(value.data?.paused).toBe(true)
    expect(engineState(harness.engine).calls.selfPause.length).toBe(1)
  })

  it('flow_incident_close 关闭事故并补审计摘要', async () => {
    harness = await setupPlugin()
    await runTool(harness, 'flow_self_pause', { reason: '环境不可用', severity: 'P2' })
    const { value } = await runTool(harness, 'flow_incident_close', {
      summary: '环境恢复，重跑通过',
      tests: 'pnpm vitest run',
      files: ['src/a.ts'],
    })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('已关闭')
    expect(value.summary).toContain('环境恢复')
    expect(value.data?.summary).toBe('环境恢复，重跑通过')
    expect(engineState(harness.engine).calls.closeIncident.length).toBe(1)
  })

  it('flow_status 展示修复通道 / 事故 / 暂停来源', async () => {
    harness = await setupPlugin()
    await runTool(harness, 'flow_self_pause', { reason: '需要负责人介入', severity: 'P0' })
    let status = await runTool(harness, 'flow_status', {})
    expect(status.value.summary).toContain('事故：INC-1')
    expect(status.value.summary).toContain('暂停来源：agent 自暂停')
    expect((status.value.data?.snapshot as Record<string, unknown>).incident).toBeTruthy()

    // 新的 engine 实例状态：清事故 + 开修复通道。
    engineState(harness.engine).incident = null
    delete engineState(harness.engine).projectFlags.incident
    delete engineState(harness.engine).projectFlags.off
    engineState(harness.engine).takeover = 'observe'
    await runTool(harness, 'flow_fix_start', { title: '修 bug', symptom: 'x', scope: ['src/a.ts'], verify: 'pnpm test' })
    status = await runTool(harness, 'flow_status', {})
    expect(status.value.summary).toContain('修复通道：FIX-20260101-000000')
    expect(status.value.summary).toContain('接管模式：observe')
    expect((status.value.data?.snapshot as Record<string, unknown>).repair).toBeTruthy()
  })

  it('修复通道工具的参数 schema：必填项与 severity 枚举', async () => {
    harness = await setupPlugin()
    const tool = harness.tools.state.tools.get('flow_fix_start')
    expect(tool).toBeDefined()
    const schema = tool!.parameters as {
      properties?: Record<string, { type?: string; enum?: string[] }>
      required?: string[]
    }
    // v0.7 智能准入：只有 symptom 必填；title/scope/verify 可省略由 engine 推导。
    expect(schema.required).toEqual(expect.arrayContaining(['symptom']))
    expect(schema.required).not.toContain('scope')
    expect(schema.required).not.toContain('verify')
    expect(schema.properties?.scope?.type).toBe('array')
    expect(schema.properties?.verify?.type).toBe('string')
    expect(schema.properties?.severity?.enum).toEqual(['P0', 'P1', 'P2'])
    for (const name of ['flow_fix_done', 'flow_fix_abort', 'flow_self_pause', 'flow_incident_close']) {
      expect(harness.tools.state.tools.get(name)?.description.length).toBeGreaterThan(10)
    }
  })
})

describe('tool results are lossless JSON', () => {
  it('strips undefined/class values before returning to the runtime', async () => {
    const { toLosslessValue } = await import('../../src/host/boundary/json.js')
    const sanitized = toLosslessValue({
      ok: true,
      summary: 'x',
      data: { a: undefined, b: new Date(0), c: [1, undefined] },
    }) as Record<string, unknown>
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(sanitized)
    expect(isLosslessJson(sanitized)).toBe(true)
    expect((sanitized.data as Record<string, unknown>).a).toBeUndefined()
    expect((sanitized.data as Record<string, unknown>).b).toBe('1970-01-01T00:00:00.000Z')
    expect((sanitized.data as Record<string, unknown>).c).toEqual([1, null])
  })

  it('flow_status 的运行时返回值（summary+data）是 lossless JSON', async () => {
    harness = await setupPlugin()
    const { value } = await runTool(harness, 'flow_status', {})
    // 引擎快照里大量可选字段是 undefined：工具边界必须清洗掉。
    expect(isLosslessJson(value)).toBe(true)
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      if (node !== null && typeof node === 'object') {
        for (const [key, item] of Object.entries(node)) {
          expect(item, key).not.toBeUndefined()
          walk(item)
        }
      }
    }
    walk(value)
  })
})
