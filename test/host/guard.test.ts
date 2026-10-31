/**
 * 守卫动作映射与 fail-closed（完成定义：守卫动作映射单测）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import type { DshToolExecution } from '../../src/host/adapters/dsh-types.js'
import type { Decision } from '../../src/core/types.js'
import { createFakeEngine } from '../../src/host/testing/fake-ctx.js'

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

function makeExec(overrides: Partial<DshToolExecution> & { name: string; arguments: unknown; callId: string }): DshToolExecution {
  return overrides as DshToolExecution
}

async function runPreExecute(harness: PluginHarness, exec: DshToolExecution): Promise<unknown> {
  return await harness.ctx.runWaterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
}

describe('守卫：动作映射', () => {
  it('bash → ShellAction，调用 engine.evaluateAction（带 caller 身份）', async () => {
    harness = await setupPlugin()
    const exec = makeExec({ name: 'bash', arguments: { command: 'git push --force' }, callId: 'call-bash', agent: harness.agent })
    await runPreExecute(harness, exec)
    const calls = engineState(harness.engine).calls.evaluateAction
    expect(calls.length).toBe(1)
    expect(calls[0]?.action).toMatchObject({ kind: 'shell', tool: 'bash', command: 'git push --force' })
    expect(calls[0]?.caller).toMatchObject({ tool: 'bash', agentId: 'session-main', agentRole: 'main' })
  })

  it('write → 仓库相对路径（绝对路径被归一化）', async () => {
    harness = await setupPlugin()
    const exec = makeExec({
      name: 'write',
      arguments: { file_path: '/fake/project/src/a.ts', content: 'x' },
      callId: 'call-write',
      agent: harness.agent,
    })
    await runPreExecute(harness, exec)
    const action = engineState(harness.engine).calls.evaluateAction[0]?.action
    expect(action).toMatchObject({ kind: 'write', tool: 'write', path: 'src/a.ts' })
  })

  it('delegate 工具 → DelegateAction（原生委派第二层兜底）', async () => {
    harness = await setupPlugin()
    const exec = makeExec({ name: 'subagent', arguments: { agentPreset: 'general' }, callId: 'call-delegate', agent: harness.agent })
    await runPreExecute(harness, exec)
    const action = engineState(harness.engine).calls.evaluateAction[0]?.action
    expect(action).toMatchObject({ kind: 'delegate', tool: 'subagent' })
  })

  it('只读/未知工具不产生动作时直接放行（不打扰 engine）', async () => {
    harness = await setupPlugin()
    const exec = makeExec({ name: 'read', arguments: { file_path: 'a.ts' }, callId: 'call-read', agent: harness.agent })
    const result = (await runPreExecute(harness, exec)) as { kind: string }
    expect(result.kind).toBe('allow')
    expect(engineState(harness.engine).calls.evaluateAction.length).toBe(0)
  })
})

describe('守卫：派发执行者的 worktree 路径归一', () => {
  it('worktree 内绝对路径相对 worktree 根归一（不再带 .flowgate 前缀）', async () => {
    harness = await setupPlugin()
    const worktree = '.flowgate/worktrees/C-001/T1'
    harness.runtime.registerAgentRole('child-T1', 'executor', { changeId: 'C-001', taskId: 'T1' } as never, worktree)
    const exec = makeExec({
      name: 'edit',
      arguments: { file_path: '/fake/project/.flowgate/worktrees/C-001/T1/src/main/java/A.java', content: 'x' },
      callId: 'call-executor-worktree',
      agent: { id: 'child-T1' } as never,
    })
    await runPreExecute(harness, exec)
    const call = engineState(harness.engine).calls.evaluateAction.at(-1) as
      | { action: unknown; caller: { cwd?: string } }
      | undefined
    expect(call?.action).toMatchObject({ kind: 'write', path: 'src/main/java/A.java' })
    expect(call?.caller.cwd).toBe('/fake/project/.flowgate/worktrees/C-001/T1')
  })

  it('执行者写 worktree 之外的绝对路径不会被错误归一（仍交范围规则判定）', async () => {
    harness = await setupPlugin()
    harness.runtime.registerAgentRole('child-T1', 'executor', { changeId: 'C-001', taskId: 'T1' } as never, '.flowgate/worktrees/C-001/T1')
    const exec = makeExec({
      name: 'write',
      arguments: { file_path: '/fake/project/src/outside.ts', content: 'x' },
      callId: 'call-executor-outside',
      agent: { id: 'child-T1' } as never,
    })
    await runPreExecute(harness, exec)
    const call = engineState(harness.engine).calls.evaluateAction.at(-1) as { action: unknown } | undefined
    expect(call?.action).toMatchObject({ kind: 'write', path: '/fake/project/src/outside.ts' })
  })
})

describe('守卫：拒绝与 fail-closed', () => {
  it('engine 判定 deny 时 pre-execute 返回 deny，且同步 guard 也拒绝（单调）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).evaluateActionResult = {
      effect: 'deny',
      message: '受保护路径不能写',
      rule: { ruleId: 'R-PROTECTED', decision: 'deny', why: '受保护路径', unlock: '申请例外' },
    } as Decision
    const exec = makeExec({ name: 'write', arguments: { file_path: 'src/index.ts' }, callId: 'call-deny', agent: harness.agent })
    const result = (await runPreExecute(harness, exec)) as { kind: string; reason: string }
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('R-PROTECTED')
    expect(result.reason.length).toBeLessThanOrEqual(320)
    const guard = harness.tools.state.guards[0]
    expect(guard).toBeDefined()
    const guardReason = guard?.(exec as never)
    expect(typeof guardReason).toBe('string')
    expect(guardReason).toContain('R-PROTECTED')
    // 拦截记录进 runtime（面板数据源）。
    expect(harness.runtime.intercepts.length).toBe(1)
    expect(harness.runtime.intercepts[0]?.ruleId).toBe('R-PROTECTED')
  })

  it('拦截记录的 unlock 缺省回退为面板指引（不出现需要手输的 /flow 命令）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).evaluateActionResult = {
      effect: 'human',
      message: '需要负责人处理',
      rule: { ruleId: 'R-SCOPE', decision: 'human', why: '范围外改动需要人确认' },
    } as Decision
    const exec = makeExec({ name: 'write', arguments: { file_path: 'src/x.ts' }, callId: 'call-unlock-fallback', agent: harness.agent })
    await runPreExecute(harness, exec)
    expect(harness.runtime.intercepts.length).toBe(1)
    expect(harness.runtime.intercepts[0]?.unlock).toContain('面板')
    expect(harness.runtime.intercepts[0]?.unlock).not.toContain('/flow')
  })

  it('human 判定同样拒绝（风险转人工不走 DSH 审批）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).evaluateActionResult = {
      effect: 'human',
      message: '高风险操作需要负责人确认',
      rule: { ruleId: 'R-PUSH', decision: 'human', why: 'push', unlock: '/flow allow-once' },
    } as Decision
    const exec = makeExec({ name: 'bash', arguments: { command: 'git push origin main' }, callId: 'call-human', agent: harness.agent })
    const result = (await runPreExecute(harness, exec)) as { kind: string; reason: string }
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('负责人')
  })

  it('engine 抛错时 fail-closed 拒绝（内部错误）', async () => {
    harness = await setupPlugin()
    engineState(harness.engine).evaluateActionError = new Error('engine boom')
    const exec = makeExec({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'call-error', agent: harness.agent })
    const result = (await runPreExecute(harness, exec)) as { kind: string; reason: string }
    expect(result.kind).toBe('deny')
    expect(result.reason).toContain('失败关闭')
    expect(harness.runtime.inertReasons.some((reason) => reason.stage === '守卫判定')).toBe(true)
  })

  it('未初始化项目不拦截（03 §2.4 启用范围）', async () => {
    harness = await setupPlugin({ engine: createFakeEngine({ initialized: false }) })
    await flush()
    const exec = makeExec({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'call-uninit', agent: harness.agent })
    const result = (await runPreExecute(harness, exec)) as { kind: string }
    expect(result.kind).toBe('allow')
    expect(engineState(harness.engine).calls.evaluateAction.length).toBe(0)
  })

  it('守卫未命中判定缓存时 fail-closed（判定环节被跳过）', async () => {
    harness = await setupPlugin()
    const guard = harness.tools.state.guards[0]
    const reason = guard?.(makeExec({ name: 'write', arguments: { file_path: 'src/a.ts' }, callId: 'never-seen' }) as never)
    expect(reason).toContain('失败关闭')
  })
})
