/**
 * 证据输出压缩（03 §6.7）：先解析再替换、全文自己落盘、错误口径。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  buildCompressedSummary,
  extractRunFacts,
  installEvidenceCompression,
  shouldCompress,
  textOf,
} from '../../src/host/evidence/index.js'
import type { EvidenceReceipt } from '../../src/core/types.js'
import { createFakeEngine } from '../../src/host/testing/fake-ctx.js'
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
