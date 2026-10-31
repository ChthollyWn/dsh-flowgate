/**
 * 覆盖自检 + 原生委派关闭（完成定义：覆盖自检、delegation 关闭单测）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flush, setupPlugin, DEFAULT_SCHEMAS, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import { computeCoverage, ensureCoverage } from '../../src/host/coverage/index.js'
import { applyDelegationPolicy } from '../../src/host/guard/delegation.js'
import { createFakeAgent, createFakeToolRuntime } from '../../src/host/testing/fake-ctx.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

describe('能力标志（doctor 用）', () => {
  it('注册 agent 生命周期、restrict、presentAs 后能力标志为 true', async () => {
    harness = await setupPlugin()
    const caps = harness.runtime.capabilitySnapshot()
    expect(caps.agents).toBe(true)
    // 覆盖自检在引擎就绪后用 agent scope 扫描：假宿主提供 schemas 时应产生条目。
    expect(harness.runtime.coverage()).not.toBeNull()
    const entries = harness.runtime.coverage()?.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
  })
})

describe('工具覆盖自检', () => {
  it('computeCoverage 分类统计可写工具覆盖率', async () => {
    harness = await setupPlugin({ bindAgent: false })
    const report = computeCoverage(
      harness.runtime,
      [
        { name: 'read' },
        { name: 'write' },
        { name: 'bash' },
        { name: 'subagent' },
        { name: 'mcp__demo' },
        { name: 'mystery_tool' },
      ],
      '2026-01-01T00:00:00.000Z',
    )
    expect(report.entries.length).toBe(6)
    expect(report.coveredWritable).toBe(3) // write / bash / subagent 覆盖；read 不算可写
    expect(report.uncoveredWritable).toBe(2) // mcp__demo / mystery_tool
    expect(report.entries.find((entry) => entry.tool === 'write')).toMatchObject({ category: 'write', covered: true })
    expect(report.entries.find((entry) => entry.tool === 'mystery_tool')).toMatchObject({ category: 'unknown', covered: false })
  })

  it('会话开始时写入 engine.setCoverage，并在 doctor 里报告未覆盖工具', async () => {
    harness = await setupPlugin()
    const report = harness.runtime.coverage()
    expect(report).not.toBeNull()
    expect(report?.entries.length).toBe(DEFAULT_SCHEMAS.length)
    expect(report?.uncoveredWritable).toBe(2)
    // fake engine 记录了 setCoverage 调用（存在 engine.state.coverage）。
    const coverage = (harness.engine as unknown as { state: { coverage?: unknown } }).state.coverage
    expect(coverage).toBeTruthy()
    expect(harness.runtime.featureNotes.coverage?.join('；')).toContain('mcp__demo')
  })

  it('宿主没有 tools.schemas 时降级为"未检查"而不是抛错', async () => {
    harness = await setupPlugin({ missingTools: ['schemas'] })
    expect(harness.runtime.coverage()).toBeNull()
    expect(harness.runtime.featureNotes.coverage?.join('；')).toContain('schemas')
  })
})

describe('工具覆盖自检 — tools/change 去抖与读取兜底', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('合并窗口内多次 tools/change 只触发一次扫描', async () => {
    harness = await setupPlugin()
    const spy = vi.spyOn(harness.runtime, 'setCoverage')
    vi.useFakeTimers()
    try {
      for (let index = 0; index < 5; index += 1) harness.ctx.emitEvent('tools/change')
      // 事件本身不立即重扫：等合并窗口结束。
      expect(spy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(99)
      expect(spy).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(spy).toHaveBeenCalledTimes(1)
      // 窗口结束后不会再有背靠背的重扫（已采样的读取也不重复扫）。
      await vi.advanceTimersByTimeAsync(500)
      expect(spy).toHaveBeenCalledTimes(1)
      ensureCoverage(harness.runtime)
      expect(harness.runtime.coverage()).not.toBeNull()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('从未采样时 doctor/面板读取会同步补扫一次且不重复', async () => {
    // 不绑定 agent：引擎不会就绪，覆盖自检从未成功采样。
    harness = await setupPlugin({ bindAgent: false })
    expect(harness.runtime.engine()).toBeNull()
    const spy = vi.spyOn(harness.runtime, 'setCoverage')
    vi.useFakeTimers()
    try {
      harness.ctx.emitEvent('tools/change')
      harness.ctx.emitEvent('tools/change')
      expect(spy).not.toHaveBeenCalled()

      // doctor / /flow status 的读取入口：从未采样 → ensureCoverage 同步补采。
      ensureCoverage(harness.runtime)
      const report = harness.runtime.coverage()
      expect(report).not.toBeNull()
      expect(report?.entries.length).toBe(DEFAULT_SCHEMAS.length)
      expect(spy).toHaveBeenCalledTimes(1)

      // 读取兜底取消挂起的合并扫描，不会在窗口到期后重复采样。
      await vi.advanceTimersByTimeAsync(500)
      expect(spy).toHaveBeenCalledTimes(1)
      // 多次读取前兜底也只补采一次。
      ensureCoverage(harness.runtime)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('受管控会话关闭原生委派', () => {
  it('agent/created 后 presentAs(native) + restrict(deny) 生效，且只 deny 真实存在的工具', async () => {
    harness = await setupPlugin()
    expect(harness.tools.state.presentations).toContain('native')
    expect(harness.tools.state.restrictions.length).toBe(1)
    const deny = harness.tools.state.restrictions[0]?.deny ?? []
    expect(deny).toEqual(expect.arrayContaining(['subagent', 'subagent_fork', 'workflow', 'send_message', 'run_code']))
    expect(deny).not.toContain('read')
    expect(deny).not.toContain('flow_status')
    expect(harness.runtime.featureNotes.delegation?.join('；')).toContain('已关闭')
  })

  it('未初始化项目不关闭原生委派（不干扰普通项目）', async () => {
    harness = await setupPlugin({ bindAgent: false })
    const { createFakeEngine } = await import('../../src/host/testing/fake-ctx.js')
    const engine = createFakeEngine({ initialized: false })
    const { startHostPlugin } = await import('../../src/host/index.js')
    const { createFakeDeps, createFakeContext, createFakePorts } = await import('../../src/host/testing/fake-ctx.js')
    const tools = createFakeToolRuntime({ schemas: DEFAULT_SCHEMAS })
    const ctx = createFakeContext({ services: { tools }, available: ['tools'] })
    const runtime = startHostPlugin(
      ctx,
      { enabled: true, projectRoot: '/fake/project' },
      createFakeDeps({ engine, homeDir: harness.homeDir, ports: createFakePorts('/fake/project') }),
    )
    const agent = createFakeAgent({ id: 'session-x', cwd: '/fake/project', ctx })
    await applyDelegationPolicy(runtime as never, agent)
    expect(tools.state.restrictions.length).toBe(0)
    expect(tools.state.presentations.length).toBe(0)
  })

  it('restrict/presentAs 缺失时只降级记录，不抛错', async () => {
    harness = await setupPlugin({ missingTools: ['restrict', 'presentAs'] })
    expect(harness.runtime.featureNotes.delegation?.join('；')).toContain('presentAs')
    expect(harness.runtime.featureNotes.delegation?.join('；')).toContain('restrict')
    // 模块本身仍安装成功。
    await flush(2)
  })
})
