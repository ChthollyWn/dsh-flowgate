/**
 * 证据输出压缩（03 §6.7）：先解析再替换、全文自己落盘、错误口径。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  buildCompressedSummary,
  duplicateSkillNotice,
  extractRunFacts,
  installEvidenceCompression,
  replaceDuplicateSkillOutput,
  shouldCompress,
  textOf,
} from '../../src/host/evidence/index.js'
import type { EvidenceReceipt } from '../../src/core/types.js'
import { createFakeAgent, createFakeEngine } from '../../src/host/testing/fake-ctx.js'
import { createFakeContext, createFakeDeps, createFakePorts, createFakeToolRuntime } from '../../src/host/testing/fake-ctx.js'
import { startHostPlugin } from '../../src/host/index.js'

let harness: PluginHarness | null = null

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

function receipt(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    id: 'agent-1',
    changeId: 'C-001',
    group: 'agent-run',
    kind: 'test',
    phase: 'red',
    command: 'pnpm vitest run',
    runBy: 'agent',
    exitCode: 1,
    summary: { parser: 'fake', parsed: true, run: 3, passed: 1, failed: 2, skipped: 0 },
    inputsHash: '',
    outputRef: '.flowgate/state/evidence/agent-1.log',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('结果解析工具', () => {
  it('textOf 只拼接 text block', () => {
    expect(
      textOf([
        { type: 'text', text: 'a' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })

  it('extractRunFacts 支持 value.exitCode 与 [exit code: N] 文本', () => {
    expect(extractRunFacts({ content: [], isError: false, value: { exitCode: 2, stdout: 'out', stderr: 'err' } } as never, '')).toEqual({
      exitCode: 2,
      stdout: 'out',
      stderr: 'err',
    })
    expect(extractRunFacts({ content: [], isError: false } as never, 'boom\n[exit code: 3]')).toMatchObject({ exitCode: 3 })
  })

  it('shouldCompress：小输出/非测试命令不压缩，大输出测试命令压缩', () => {
    const small = { content: [], isError: false } as never
    expect(shouldCompress(small, 'ok', 'test')).toBe(false)
    const large = { content: [], isError: false } as never
    expect(shouldCompress(large, 'x'.repeat(2000), 'test')).toBe(true)
    expect(shouldCompress(large, 'x'.repeat(2000), 'build')).toBe(true)
    expect(shouldCompress(large, 'x'.repeat(2000), 'run')).toBe(false)
    expect(shouldCompress(large, 'x'.repeat(2000), 'manual')).toBe(false)
  })
})

describe('摘要文本', () => {
  it('包含首行结论 + 完整输出路径 + "不算验证回执"标注', async () => {
    harness = await setupPlugin()
    const text = buildCompressedSummary({
      receipt: receipt(),
      summary: receipt().summary,
      outputRef: '.flowgate/state/evidence/agent-1.log',
      maxTokens: 400,
      runtime: harness.runtime,
    })
    expect(text).toContain('完整输出')
    expect(text).toContain('不算验证回执')
    expect(text.length).toBeLessThan(9000)
  })

  it('没有 core 摘要时退回手写一行摘要', async () => {
    harness = await setupPlugin()
    const text = buildCompressedSummary({
      receipt: receipt(),
      summary: null,
      outputRef: '.flowgate/state/evidence/agent-1.log',
      maxTokens: 400,
      runtime: harness.runtime,
    })
    expect(text).toContain('pnpm vitest run')
    expect(text).toContain('不算验证回执')
  })
})

describe('tools/post-execute 压缩', () => {
  it('大输出被替换为摘要，全文写入 .flowgate/state/evidence/', async () => {
    const { makeTempHome } = await import('../../src/host/testing/fake-ctx.js')
    const home = await makeTempHome()
    const engine = createFakeEngine()
    const tools = createFakeToolRuntime()
    const ctx = createFakeContext({ services: { tools }, available: ['tools'] })
    const runtime = startHostPlugin(
      ctx,
      { enabled: true, projectRoot: '/fake/project' },
      createFakeDeps({ engine, homeDir: home, ports: createFakePorts('/fake/project') }),
    )
    const agent = (await import('../../src/host/testing/fake-ctx.js')).createFakeAgent({ id: 's', cwd: '/fake/project', ctx })
    ctx.emitEvent('agent/created', { agent, source: 'startup' })
    const { flush } = await import('./helpers.js')
    await flush()
    ;(engine as unknown as { state: { snapshotOverrides: Record<string, unknown> } }).state.snapshotOverrides = { initialized: true, off: false }
    runtime?.emit()
    const bigOutput = `${'FAIL src/a.test.ts\n'.repeat(120)}[exit code: 1]`
    const result = await ctx.runWaterfall(
      'tools/post-execute',
      [
        { name: 'bash', arguments: { command: 'pnpm vitest run' }, callId: 'c1', agent },
        { content: [{ type: 'text', text: bigOutput }], isError: true },
      ],
      async () => ({ kind: 'accept' }),
    )
    const decision = result as { kind: string; content?: { type: string; text?: string }[] }
    expect(decision.kind).toBe('accept')
    const text = textOf(decision.content as never)
    expect(text).toContain('[FlowGate]')
    expect(text).toContain('agent 自跑命令')
    // 全文落盘（至少一次写 .log）。
    const fs = runtime?.ports()?.fs
    const raw = await fs?.readFile('.flowgate/state/evidence/agent-1.log').catch(() => null)
    // 输出 id 带时间戳，无法精确匹配；改为确认 evidence 目录里有 .log 文件。
    const entries = await fs?.readdir('.flowgate/state/evidence')
    expect(entries?.some((name) => name.endsWith('.log'))).toBe(true)
    void raw
    await runtime?.dispose()
    await import('node:fs/promises').then((fsp) => fsp.rm(home, { recursive: true, force: true }))
  })

  it('小输出不替换（保持原 content）', async () => {
    harness = await setupPlugin()
    const result = await harness.ctx.runWaterfall(
      'tools/post-execute',
      [
        { name: 'bash', arguments: { command: 'echo ok' }, callId: 'c2', agent: harness.agent },
        { content: [{ type: 'text', text: '[exit code: 0]' }], isError: false },
      ],
      async () => ({ kind: 'accept' }),
    )
    expect(result).toEqual({ kind: 'accept' })
  })
})

// ---------------------------------------------------------------------------
// H4：技能重复加载（本会话已加载时不重复注入全文）
// ---------------------------------------------------------------------------

describe('技能重复加载（H4）', () => {
  // 真实 skill 工具的 render 会把整份技能正文作为 text block 返回。
  const skillBody = `# skill flow-plan\n${'步骤：读需求、写计划、跑验证。\n'.repeat(60)}`

  async function runSkillTool(
    h: PluginHarness,
    nextDecision: () => Promise<{ kind: 'accept'; content?: { type: string; text?: string }[] }> = async () => ({ kind: 'accept' }),
  ) {
    return await h.ctx.runWaterfall(
      'tools/post-execute',
      [
        { name: 'skill', arguments: { name: 'flow-plan' }, callId: 'skill-1', agent: h.agent },
        { content: [{ type: 'text', text: skillBody }], isError: false },
      ],
      nextDecision,
    )
  }

  it('recordSkillLoaded 返回 duplicate 时把全文替换为"已加载"短提示', async () => {
    harness = await setupPlugin()
    const calls: { name: string; hash: string }[] = []
    harness.engine.recordSkillLoaded = async (name: string, hash = '') => {
      calls.push({ name, hash })
      return { duplicate: true }
    }
    const result = (await runSkillTool(harness)) as { kind: string; content?: { type: string; text?: string }[] }
    expect(result.kind).toBe('accept')
    const text = textOf(result.content as never)
    expect(text).toContain('技能 flow-plan 本会话已加载，不重复注入全文')
    expect(text).not.toContain('步骤：读需求、写计划、跑验证。')
    expect(calls.map((call) => call.name)).toEqual(['flow-plan'])
    expect(calls[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(harness.runtime.featureNotes.skills?.join('；')).toContain('技能 flow-plan 本会话已加载过（不重复注入全文）')
  })

  it('首次加载（duplicate=false）保持原输出（不覆盖 content）', async () => {
    harness = await setupPlugin()
    harness.engine.recordSkillLoaded = async () => ({ duplicate: false })
    const result = (await runSkillTool(harness)) as { kind: string; content?: { type: string; text?: string }[] }
    expect(result.kind).toBe('accept')
    // 不替换 = 不新增 content（宿主继续用原始工具结果全文）。
    expect(result.content).toBeUndefined()
    expect(harness.runtime.featureNotes.skills?.join('；')).toContain('已记录技能加载回执：flow-plan')
  })

  it('recordSkillLoaded 抛错时回退不改（不覆盖 content）并记录降级原因', async () => {
    harness = await setupPlugin()
    harness.engine.recordSkillLoaded = async () => {
      throw new Error('账本写入失败')
    }
    const result = (await runSkillTool(harness)) as { kind: string; content?: { type: string; text?: string }[] }
    expect(result.kind).toBe('accept')
    expect(result.content).toBeUndefined()
    expect(harness.runtime.featureNotes.skills?.join('；')).toContain('技能回执记录失败：账本写入失败')
  })

  it('派发子 agent 的重复加载仍保留全文（它有独立上下文）', async () => {
    harness = await setupPlugin()
    harness.engine.recordSkillLoaded = async () => ({ duplicate: true })
    const executor = createFakeAgent({ id: 'child-exec', cwd: '/fake/project', ctx: harness.ctx })
    harness.runtime.registerAgentRole('child-exec', 'executor')
    const result = (await harness.ctx.runWaterfall(
      'tools/post-execute',
      [
        { name: 'skill', arguments: { name: 'flow-plan' }, callId: 'skill-child', agent: executor },
        { content: [{ type: 'text', text: skillBody }], isError: false },
      ],
      async () => ({ kind: 'accept' }),
    )) as { kind: string; content?: unknown }
    expect(result.kind).toBe('accept')
    // 不替换 = 不新增 content（子 agent 继续拿到技能全文）。
    expect(result.content).toBeUndefined()
    expect(harness.runtime.featureNotes.skills?.join('；')).toContain('子 agent 上下文独立，保留全文')
  })

  it('replaceDuplicateSkillOutput 只替换 accept 决策；accept{value} / block 原样返回', () => {
    expect(duplicateSkillNotice('flow-plan')).toContain('技能 flow-plan 本会话已加载，不重复注入全文')
    const block = { kind: 'block', feedback: [{ type: 'text', text: 'no' }] } as never
    expect(replaceDuplicateSkillOutput(block, 'x')).toBe(block)
    const acceptValue = { kind: 'accept', value: { ok: true } } as never
    expect(replaceDuplicateSkillOutput(acceptValue, 'x')).toBe(acceptValue)
    const acceptContent = { kind: 'accept', content: [{ type: 'text', text: 'full' }], additionalContexts: [] } as never
    const replaced = replaceDuplicateSkillOutput(acceptContent, 'x') as { content: { type: string; text?: string }[] }
    expect(textOf(replaced.content)).toContain('技能 x 本会话已加载，不重复注入全文')
    // 无 content 的 accept（保留 next 结果）也可替换成短提示。
    const bareAccept = { kind: 'accept' } as never
    expect(textOf((replaceDuplicateSkillOutput(bareAccept, 'y') as { content?: { type: string; text?: string }[] }).content)).toContain(
      '技能 y 本会话已加载',
    )
  })
})
