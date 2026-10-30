/**
 * 插件加载与导出形态（完成定义：插件可加载、apply+inject 形态正确、全部模块安装成功）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import {
  activeHostRuntime,
  apply,
  inject,
  moduleInstallStatus,
  name,
  resetHostPluginForTest,
} from '../../src/host/index.js'
import { createFakeContext, createFakeDeps, createFakeEngine, createFakePorts, makeTempHome } from '../../src/host/testing/fake-ctx.js'
import { createFakeAgent } from '../../src/host/testing/fake-ctx.js'
import * as os from 'node:os'
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

describe('插件导出形态', () => {
  it('具名导出 name / inject / apply（不是 default 函数）', () => {
    expect(name).toBe('dsh-flowgate')
    expect(Array.isArray(inject)).toBe(true)
    expect(inject).toEqual([]) // 不硬依赖任何服务
    expect(typeof apply).toBe('function')
  })

  it('真实 apply() 路径可用（未初始化项目不应抛错）', async () => {
    const emptyProject = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-empty-'))
    const ctx = createFakeContext({ services: {}, available: [] })
    try {
      expect(() =>
        apply(ctx, {
          enabled: true,
          projectRoot: emptyProject,
          ledgerKeyPath: nodePath.join(emptyProject, 'ledger.key'),
        }),
      ).not.toThrow()
      // 没有任何宿主服务：允许 runtime 存在但所有能力降级，不抛错。
      const runtime = activeHostRuntime()
      expect(runtime).not.toBeNull()
      expect(runtime?.capabilitySnapshot().tools).toBe(false)
    } finally {
      await fsp.rm(emptyProject, { recursive: true, force: true })
    }
  })

  it('全部功能模块安装成功（12 个模块无 failed）', async () => {
    harness = await setupPlugin()
    const status = moduleInstallStatus()
    expect(Object.keys(status).length).toBe(12)
    for (const [stage, value] of Object.entries(status)) {
      expect(value, `${stage} 安装失败`).toBe('ok')
    }
  })

  it('已注册 /flow 命令、15 个工具、flowgate 投影、守卫与系统提示段', async () => {
    harness = await setupPlugin()
    expect(harness.commands.state.commands.has('flow')).toBe(true)
    expect(harness.tools.state.tools.size).toBe(15) // 14 个 flow_* + flow_dispatch_next
    expect(harness.tools.state.tools.has('flow_status')).toBe(true)
    expect(harness.tools.state.tools.has('flow_dispatch_next')).toBe(true)
    expect(harness.projections.state.definitions.has('flowgate')).toBe(true)
    expect(harness.projections.state.definitions.get('flowgate')?.stateVersion).toBe(1)
    expect(harness.tools.state.guards.length).toBe(1)
    expect(harness.prompt.state.sections.has('flowgate:runtime')).toBe(true)
  })

  it('所有宿主交互都做能力探测：缺服务不抛错，能力标记为 false', async () => {
    harness = await setupPlugin({ services: { commands: undefined } })
    // commands 服务存在但为 undefined：inject 判定为"存在"仍会调 get 得 undefined → install 返回，不抛错。
    expect(harness.runtime.capabilities.commands).not.toBe(true)
    expect(moduleInstallStatus()['命令族']).toBe('ok')
  })
})

describe('会话绑定与引擎初始化', () => {
  it('agent/created 后绑定主会话并启动租约心跳', async () => {
    harness = await setupPlugin({ bindAgent: false })
    harness.ctx.emitEvent('agent/created', { agent: harness.agent, source: 'startup' })
    await flush()
    expect(harness.runtime.mainAgent()).toBe(harness.agent)
    expect(harness.runtime.engine()).not.toBeNull()
    // 引擎就绪且 fake 引擎报告已初始化 → 应尝试 attachSession 并 emit 投影。
    expect(harness.runtime.lastSnapshot?.initialized).toBe(true)
  })

  it('会话关闭时释放租约（engine.releaseSession 被调用）', async () => {
    harness = await setupPlugin()
    const engineState = (harness.engine as unknown as { state: { calls: { releaseSession: number } } }).state
    const before = engineState.calls.releaseSession
    harness.ctx.emitEvent('session/disposed', harness.agent.session)
    await flush(12)
    expect(engineState.calls.releaseSession).toBeGreaterThan(before)
    expect(harness.runtime.mainAgent()).toBeNull()
  })

  it('未初始化项目：不拦截，投影照常注册', async () => {
    harness = await setupPlugin({ engine: createFakeEngine({ initialized: false }) })
    expect(harness.runtime.lastSnapshot?.initialized).toBe(false)
    expect(harness.projections.state.definitions.has('flowgate')).toBe(true)
  })
})

describe('卸载清理', () => {
  it('卸载后 runtime.dispose 释放会话并停掉心跳', async () => {
    const homeDir = await makeTempHome()
    const ctx = createFakeContext({
      services: {
        tools: undefined,
        commands: undefined,
        systemPrompt: undefined,
        sessionProjections: undefined,
        sessions: {},
        agents: {},
        subagents: undefined,
        sessionQuery: undefined,
      },
      available: ['sessions', 'agents'],
    })
    const engine = createFakeEngine()
    const runtime = (await import('../../src/host/index.js')).startHostPlugin(
      ctx,
      { enabled: true, projectRoot: '/fake/project' },
      createFakeDeps({ engine, homeDir, ports: createFakePorts('/fake/project') }),
    )
    expect(runtime).not.toBeNull()
    const agent = createFakeAgent({ id: 'session-main', cwd: '/fake/project', ctx })
    ctx.emitEvent('agent/created', { agent, source: 'startup' })
    await flush()
    await runtime?.dispose()
    const engineState = (engine as unknown as { state: { calls: { releaseSession: number } } }).state
    expect(engineState.calls.releaseSession).toBe(1)
    await fsp.rm(homeDir, { recursive: true, force: true })
  })
})
