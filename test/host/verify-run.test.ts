/** 运行证据执行器的纯函数部分（T4.2）。 */
import { describe, expect, it } from 'vitest'
import { isHealthUrl, summarizeRunLog } from '../../src/host/verify/run.js'

describe('isHealthUrl', () => {
  it('识别 http/https URL 与命令', () => {
    expect(isHealthUrl('http://localhost:3000/health')).toBe(true)
    expect(isHealthUrl('https://svc/health')).toBe(true)
    expect(isHealthUrl('curl -f http://localhost:3000/health')).toBe(false)
    expect(isHealthUrl('./scripts/health.sh')).toBe(false)
  })
})

describe('summarizeRunLog', () => {
  it('短日志原样返回；长日志保留头尾并标注截断', () => {
    expect(summarizeRunLog('  hello  ')).toBe('hello')
    const long = `${'a'.repeat(2_000)}${'b'.repeat(2_000)}`
    const summary = summarizeRunLog(long, 500)
    expect(summary.length).toBeLessThan(700)
    expect(summary.startsWith('a')).toBe(true)
    expect(summary).toContain('日志已截断')
    expect(summary.endsWith('b')).toBe(true)
  })
})
