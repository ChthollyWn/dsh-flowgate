/**
 * P0-4 / P1-7：safe-mode 与自举观察在宿主插件层面的生效方式。
 *
 * - safe-mode：跳过 guard/delegation/gates/dispatch 安装，enforcement=off，
 *   其余模块（session/projection/commands/tools/doctor）保持可用；
 * - 自举仓库（项目根 package.json 是 dsh-flowgate 自身）：默认 observe，
 *   guard 仍安装但只记录不拦截；
 * - 模块开关：env FLOWGATE_DISABLE / config.modules / safe 覆盖三层合并；
 * - engine 选项透传：takeover + hostEpoch 在构造引擎前确定。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DshToolExecution } from '../../src/host/adapters/dsh-types.js'
import type { EngineOptions } from '../../src/core/engine.js'
import type { Decision } from '../../src/core/types.js'
import { moduleInstallStatus, resetHostPluginForTest } from '../../src/host/index.js'
import { executeFlowCommand } from '../../src/host/commands/index.js'
import { setupPlugin, type PluginHarness } from './helpers.js'

let harness: PluginHarness | null = null
const tempDirs: string[] = []
const originalEnv: Record<string, string | undefined> = {}

function saveEnv(name: string): void {
  if (!(name in originalEnv)) originalEnv[name] = process.env[name]
}

function setEnv(name: string, value: string | undefined): void {
  saveEnv(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function selfHostRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-selfhost-plugin-'))
  tempDirs.push(dir)
  await fsp.writeFile(
    nodePath.join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-flowgate', version: '0.1.0', dsh: { manifestVersion: 1 } }),
  )
  return dir
}

function engineState(h: PluginHarness) {
  return (h.engine as unknown as { state: import('../../src/host/testing/fake-ctx.js').FakeEngineState }).state
}

function makeExec(name: string, args: Record<string, unknown>, callId: string, agent: unknown): DshToolExecution {
  return { name, arguments: args, callId, agent, signal: new AbortController().signal } as unknown as DshToolExecution
}

async function runPreExecute(
  h: PluginHarness,
  exec: DshToolExecution = makeExec('write', { file_path: 'src/a.ts' }, 'safe-mode-call', h.agent),
): Promise<unknown> {
  return await h.ctx.runWaterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
}

/** 调用已注册的同步单调守卫（fake tool runtime 记录的是函数本身）。 */
function runSyncGuard(h: PluginHarness, exec: DshToolExecution): string | undefined {
  const guard = h.tools.state.guards[0] as ((exec: DshToolExecution) => string | undefined) | undefined
  if (!guard) throw new Error('同步守卫未注册')
  return guard(exec)
}

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
  for (const [name, value] of Object.entries(originalEnv)) setEnv(name, value)
  for (const name of Object.keys(originalEnv)) delete originalEnv[name]
  for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true })
})

describe('safe-mode（config.safeMode=true）', () => {
  it('跳过 guard/delegation/gates/dispatch，其余模块保持可用；enforcement=off', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin({ config: { safeMode: true } })
    expect(harness.runtime.isSafeMode()).toBe(true)
    expect(harness.runtime.safeModeInfo().source).toBe('config')
    expect(harness.runtime.enforcement()).toBe('off')
    const status = moduleInstallStatus()
    for (const stage of ['守卫', '原生委派关闭', '人工门', '任务派发']) {
      expect(status[stage], stage).toBe('skipped')
    }
    for (const stage of ['会话生命周期', '会话投影', '命令族', '模型工具']) {
      expect(status[stage], stage).toBe('ok')
    }
    // safe-mode 下 guard 模块不安装（同步守卫也不注册）。
    expect(harness.tools.state.guards).toHaveLength(0)
    // 投影仍然注册（wire 是显式 DTO + 自检，不会毒化会话创建）。
    expect(harness.projections.state.definitions.has('flowgate')).toBe(true)
    // tools/commands 仍可用（人工止血需要 flow_/doctor）。
    expect(harness.tools.state.tools.has('flow_status')).toBe(true)
    expect(harness.commands.state.commands.has('flow')).toBe(true)
  })

  it('即使引擎判定 deny，也不会拦截写操作（guard 未安装）', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin({ config: { safeMode: true } })
    engineState(harness).evaluateActionResult = {
      effect: 'deny',
      message: 'should not block',
      rule: { ruleId: 'R-X', decision: 'deny', why: 'x', unlock: 'y' },
    } as Decision
    const result = (await runPreExecute(harness)) as { kind?: string }
    expect(result.kind).toBe('allow')
  })

  it('doctor 展示 enforcement=off、safe-mode 来源与实际读取路径、模块跳过原因', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin({ config: { safeMode: true } })
    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('接管模式：off')
    expect(text).toContain('safe-mode：生效（config')
    expect(text).toContain('safe-mode 读取路径：')
    expect(text).toContain('模块开关：')
    expect(text).toContain('守卫（guard）：已跳过')
    expect(text).toContain('safe-mode 强制跳过')
    expect(text).toContain(`宿主 epoch：${harness.runtime.hostEpoch()}`)
  })
})

describe('safe-mode（env FLOWGATE_SAFE=1）', () => {
  it('环境变量触发时同样跳过拦截类模块', async () => {
    setEnv('FLOWGATE_SAFE', '1')
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin()
    expect(harness.runtime.isSafeMode()).toBe(true)
    expect(harness.runtime.safeModeInfo().source).toBe('env')
    expect(harness.runtime.enforcement()).toBe('off')
    expect(moduleInstallStatus()['守卫']).toBe('skipped')
    expect(harness.tools.state.guards).toHaveLength(0)
  })
})

describe('自举观察（项目根是 dsh-flowgate 自身）', () => {
  it('默认 observe：guard 仍安装；非 R-NO-CHANGE 的规则照常拦截（observe 不是全放行）', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    const root = await selfHostRoot()
    harness = await setupPlugin({ config: { projectRoot: root } })
    expect(harness.runtime.isSelfHost()).toBe(true)
    expect(harness.runtime.enforcement()).toBe('observe')
    expect(harness.tools.state.guards.length).toBe(1)

    // 有变更时的阶段/范围/受保护规则仍要拦：engine 返回 deny（非 R-NO-CHANGE）→ host deny。
    engineState(harness).evaluateActionResult = {
      effect: 'deny',
      message: '自举观察演练',
      rule: { ruleId: 'R-SELF', decision: 'deny', why: '演示', unlock: '无' },
    } as Decision
    const exec = makeExec('write', { file_path: 'src/a.ts' }, 'observe-deny-call', harness.agent)
    const result = (await runPreExecute(harness, exec)) as { kind?: string; reason?: string }
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('R-SELF')
    expect(harness.runtime.intercepts.at(-1)).toMatchObject({ ruleId: 'R-SELF', effect: 'deny' })
    // 同步单调守卫同样执行缓存判定（observe 下 deny 仍 deny）。
    expect(runSyncGuard(harness, exec)).toContain('R-SELF')

    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('自举检测：是')
    expect(text).toContain('接管模式：observe')
  })

  it('observe 下引擎返回 allow（如 R-NO-CHANGE 未立项写入）时正常放行', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    const root = await selfHostRoot()
    harness = await setupPlugin({ config: { projectRoot: root } })
    expect(harness.runtime.enforcement()).toBe('observe')
    engineState(harness).evaluateActionResult = { effect: 'allow', message: '' } as Decision
    const exec = makeExec('write', { file_path: 'src/a.ts' }, 'observe-allow-call', harness.agent)
    const result = (await runPreExecute(harness, exec)) as { kind?: string }
    expect(result.kind).toBe('allow')
    expect(runSyncGuard(harness, exec)).toBeUndefined()
  })

  it('config.takeover=off（非 safe-mode）：guard 仍安装但全放行', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin({ config: { takeover: 'off' } })
    expect(harness.runtime.enforcement()).toBe('off')
    // 不是 safe-mode：模块不被跳过，guard 仍安装（能力台账/覆盖自检仍可见）。
    expect(moduleInstallStatus()['守卫']).toBe('ok')
    expect(harness.tools.state.guards.length).toBe(1)
    engineState(harness).evaluateActionResult = {
      effect: 'deny',
      message: 'off 模式演练',
      rule: { ruleId: 'R-X', decision: 'deny', why: 'x', unlock: 'y' },
    } as Decision
    const exec = makeExec('write', { file_path: 'src/a.ts' }, 'off-mode-call', harness.agent)
    const result = (await runPreExecute(harness, exec)) as { kind?: string }
    expect(result.kind).toBe('allow')
    expect(runSyncGuard(harness, exec)).toBeUndefined()
  })

  it('config.takeover=enforce 可覆盖自举默认（开发时需要硬门禁）', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    const root = await selfHostRoot()
    harness = await setupPlugin({ config: { projectRoot: root, takeover: 'enforce' } })
    expect(harness.runtime.enforcement()).toBe('enforce')
    engineState(harness).evaluateActionResult = {
      effect: 'deny',
      message: 'x',
      rule: { ruleId: 'R-X', decision: 'deny', why: 'x', unlock: 'y' },
    } as Decision
    const result = (await runPreExecute(harness)) as { kind: string }
    expect(result.kind).toBe('deny')
  })
})

describe('模块开关（env / config.modules）', () => {
  it('config.modules=false 跳过指定模块并写 doctor 原因', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    harness = await setupPlugin({ config: { modules: { projection: false, guard: false } } })
    expect(moduleInstallStatus()['会话投影']).toBe('skipped')
    expect(moduleInstallStatus()['守卫']).toBe('skipped')
    expect(harness.projections.state.definitions.has('flowgate')).toBe(false)
    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('插件配置 modules.projection=false')
  })

  it('FLOWGATE_DISABLE 环境变量跳过模块（E2E 二分定位用）', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    setEnv('FLOWGATE_DISABLE', 'guard, tools')
    harness = await setupPlugin()
    expect(moduleInstallStatus()['守卫']).toBe('skipped')
    expect(moduleInstallStatus()['模型工具']).toBe('skipped')
    // dispatch 模块独立注册 flow_dispatch_next；其余 flow_* 工具来自被跳过的 tools 模块。
    expect(harness.tools.state.tools.has('flow_status')).toBe(false)
    expect(harness.tools.state.tools.size).toBe(1)
    expect(harness.tools.state.tools.has('flow_dispatch_next')).toBe(true)
    const text = await executeFlowCommand(harness.runtime, 'doctor', harness.agent)
    expect(text).toContain('环境变量 FLOWGATE_DISABLE 指定跳过')
  })
})

describe('engine 选项透传：takeover + hostEpoch（P1-7）', () => {
  it('默认（非自举、非 safe）→ takeover=enforce；hostEpoch=本次进程 epoch', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    const captured: EngineOptions[] = []
    harness = await setupPlugin({ onCreateEngine: (options) => captured.push(options) })
    expect(captured).toHaveLength(1)
    const options = captured[0] as EngineOptions & { takeover?: string; hostEpoch?: string }
    expect(options.takeover).toBe('enforce')
    expect(typeof options.hostEpoch).toBe('string')
    expect(options.hostEpoch).not.toBe('')
    expect(options.hostEpoch).toBe(harness.runtime.hostEpoch())
  })

  it('config.takeover=observe / safeMode=true 透传到 engine', async () => {
    setEnv('FLOWGATE_SAFE', undefined)
    setEnv('DSH_HOME', undefined)
    const observed: Array<{ takeover?: string }> = []
    harness = await setupPlugin({
      config: { takeover: 'observe' },
      onCreateEngine: (options) => observed.push(options as EngineOptions & { takeover?: string }),
    })
    expect(observed[0]?.takeover).toBe('observe')
    await harness.cleanup()
    harness = null
    resetHostPluginForTest()

    const safeObserved: Array<{ takeover?: string }> = []
    harness = await setupPlugin({
      config: { safeMode: true },
      onCreateEngine: (options) => safeObserved.push(options as EngineOptions & { takeover?: string }),
    })
    expect(safeObserved[0]?.takeover).toBe('off')
  })
})
