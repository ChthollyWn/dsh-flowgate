import { describe, expect, it } from 'vitest'
import type { EvidenceReceipt, TestSummary } from '../../../src/core/types'
import { parseTestOutput } from '../../../src/core/evidence/parse'
import { estimateTokens, summarizeEvidenceForContext, truncateOutput } from '../../../src/core/evidence/run'

function receiptFrom(summary: TestSummary, overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    id: 'E-9',
    changeId: 'C-001',
    taskId: 'T1',
    group: 'renewal-unit',
    kind: 'test',
    phase: summary.failed > 0 ? 'red' : summary.run > 0 ? 'green' : 'none',
    command: 'mvn -B test',
    runBy: 'flowgate',
    exitCode: summary.failed > 0 ? 1 : 0,
    summary,
    inputsHash: 'sha256:abc',
    outputRef: '.flowgate/state/evidence/E-9.log',
    startedAt: '2026-11-12T10:00:00+08:00',
    finishedAt: '2026-11-12T10:01:00+08:00',
    ...overrides,
  }
}

describe('summarizeEvidenceForContext：≤400 token 的人读压缩摘要', () => {
  it('2 万行失败输出压缩后仍包含失败用例名、首行错误与完整日志路径', () => {
    const noise = Array.from({ length: 20_000 }, (_, index) => `[INFO] compiled module ${index}`).join('\n')
    const failureLines = Array.from(
      { length: 10 },
      (_, index) => `[ERROR]   RenewalServiceTest.case${index}:${100 + index} expected: <${index}> but was: <${index + 1}>`,
    ).join('\n')
    const output = `${noise}\n[ERROR] Tests run: 10, Failures: 10, Errors: 0, Skipped: 0\n${failureLines}`
    const summary = parseTestOutput({ command: 'mvn -B test', stdout: output, stderr: '', exitCode: 1 })
    expect(summary.parsed).toBe(true)
    expect(summary.run).toBe(10)
    expect(summary.failed).toBe(10)

    const receipt = receiptFrom(summary)
    const text = summarizeEvidenceForContext(receipt, 400)
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('[FlowGate]')
    expect(text).toContain('RenewalServiceTest.case0')
    expect(text).toContain('expected')
    expect(text).toContain('.flowgate/state/evidence/E-9.log')
    expect(text).toContain('失败')
    // 证据数量与压缩前的解析结果一致（压缩只影响展示，不影响计数）
    expect(text).toContain('运行 10')
    expect(text).toContain('失败 10')
    expect(text.split('\n').length).toBeLessThan(40)
  })

  it('全部通过时只保留一行', () => {
    const summary = parseTestOutput({
      command: 'pnpm vitest run',
      stdout: [
        ' ✓ tests/renewal.test.ts (3 tests) 12ms',
        '',
        ' Test Files  1 passed (1)',
        '      Tests  3 passed (3)',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    })
    const receipt = receiptFrom(summary, { command: 'pnpm vitest run' })
    const text = summarizeEvidenceForContext(receipt, 400)
    expect(text.split('\n')).toHaveLength(1)
    expect(text).toContain('[FlowGate] pnpm vitest run → 通过')
    expect(text).toContain('运行 3')
    expect(text).not.toContain('完整输出')
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
  })

  it('失败摘要包含首个错误的文件:行与位置，并给出 read 提示', () => {
    const summary: TestSummary = {
      parser: 'junit-xml',
      parsed: true,
      run: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ name: 'FooTest.breaks', file: 'FooTest.java', line: 88, message: 'expected: <1> but was: <2>' }],
    }
    const text = summarizeEvidenceForContext(receiptFrom(summary), 400)
    expect(text).toContain('FooTest.breaks')
    expect(text).toContain('expected: <1> but was: <2>')
    expect(text).toContain('FooTest.java:88')
    expect(text).toContain('可用 read 查看')
  })

  it('未解析的回执说明原因并给出日志路径', () => {
    const summary: TestSummary = { parser: 'unknown', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 }
    const receipt = receiptFrom(summary, { phase: 'none', exitCode: 0, command: 'pnpm build' })
    const text = summarizeEvidenceForContext(receipt, 400)
    expect(text).toContain('未解析')
    expect(text).toContain('.flowgate/state/evidence/E-9.log')
    expect(estimateTokens(text)).toBeLessThanOrEqual(400)
  })

  it('没有失败细节时也保留日志路径（便于 read 完整输出）', () => {
    const summary: TestSummary = { parser: 'maven-console', parsed: true, run: 4, passed: 3, failed: 1, skipped: 0 }
    const text = summarizeEvidenceForContext(receiptFrom(summary), 400)
    expect(text).toContain('.flowgate/state/evidence/E-9.log')
  })
})

describe('truncateOutput：大输出保留头尾并标记截断', () => {
  it('短输出原样返回', () => {
    const result = truncateOutput('hello world', 100)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe('hello world')
  })

  it('长输出截断到预算内，保留头尾并给出说明', () => {
    const output = `${'A'.repeat(40_000)}${'B'.repeat(10_000)}`
    const result = truncateOutput(output, 1_000)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(1_000)
    expect(result.text.startsWith('AAA')).toBe(true)
    expect(result.text.endsWith('BBB')).toBe(true)
    expect(result.text).toContain('已截断')
    expect(result.text).toContain('共 50000 字符')
  })

  it('maxChars 为 0 时返回空文本', () => {
    expect(truncateOutput('abc', 0)).toEqual({ text: '', truncated: true })
  })
})
