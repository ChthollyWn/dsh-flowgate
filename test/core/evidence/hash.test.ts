import { describe, expect, it } from 'vitest'
import type { EvidenceReceipt } from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  buildEvidenceView,
  hashInputs,
  latestReceiptWins,
  receiptFailed,
  receiptFreshness,
  selectReceiptsForGroup,
} from '../../../src/core/evidence/hash'

function receipt(overrides: Partial<EvidenceReceipt>): EvidenceReceipt {
  return {
    id: 'E-1',
    changeId: 'C-001',
    taskId: 'T1',
    group: 'renewal-unit',
    kind: 'test',
    phase: 'green',
    command: 'mvn -B test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: { parser: 'junit-xml', parsed: true, run: 3, passed: 3, failed: 0, skipped: 0 },
    inputsHash: 'sha256:abc',
    outputRef: '.flowgate/state/evidence/E-1.log',
    startedAt: '2026-11-12T10:00:00+08:00',
    finishedAt: '2026-11-12T10:01:00+08:00',
    ...overrides,
  }
}

describe('hashInputs：验证组输入范围哈希', () => {
  const seed = {
    'src/RenewalService.java': 'class RenewalService {}',
    'src/RenewalServiceTest.java': 'class RenewalServiceTest {}',
    'src/nested/Helper.java': 'class Helper {}',
    'pom.xml': '<project/>',
    'package-lock.json': '{}',
    'docs/readme.md': '# docs',
    'node_modules/lib/index.js': 'module.exports = 1',
  }

  it('对具体文件求哈希，稳定且与输入顺序无关', async () => {
    const fs = new MemoryFileSystem(seed)
    const a = await hashInputs(fs, '', ['pom.xml', 'src/RenewalService.java', 'package-lock.json'])
    const b = await hashInputs(fs, '', ['package-lock.json', 'pom.xml', 'src/RenewalService.java'])
    expect(a.hash).toBe(b.hash)
    expect(a.hash.startsWith('sha256:')).toBe(true)
    expect(a.files).toEqual(['package-lock.json', 'pom.xml', 'src/RenewalService.java'])
    expect(a.missing).toEqual([])
  })

  it('支持 glob，只收匹配文件并跳过 node_modules', async () => {
    const fs = new MemoryFileSystem(seed)
    const result = await hashInputs(fs, '', ['src/**/*.java', 'pom.xml'])
    expect(result.files).toEqual(['pom.xml', 'src/RenewalService.java', 'src/RenewalServiceTest.java', 'src/nested/Helper.java'])
    expect(result.files.some((file) => file.includes('node_modules'))).toBe(false)
  })

  it('输入内容变化后哈希变化（回执过期的依据）', async () => {
    const fs = new MemoryFileSystem(seed)
    const before = await hashInputs(fs, '', ['src/RenewalService.java'])
    await fs.writeFile('src/RenewalService.java', 'class RenewalService { /* changed */ }')
    const after = await hashInputs(fs, '', ['src/RenewalService.java'])
    expect(after.hash).not.toBe(before.hash)
  })

  it('支持 ! 排除模式（引擎基线用 **/* + !**/node_modules/**）', async () => {
    const fs = new MemoryFileSystem(seed)
    const result = await hashInputs(fs, '', ['**/*', '!**/node_modules/**', '!docs/**'])
    expect(result.files).toContain('src/RenewalService.java')
    expect(result.files).toContain('pom.xml')
    expect(result.files.some((file) => file.includes('node_modules'))).toBe(false)
    expect(result.files.some((file) => file.startsWith('docs/'))).toBe(false)
    // 排除模式不应被当成缺失输入
    expect(result.missing).toEqual([])
    expect(result.hash.startsWith('sha256:')).toBe(true)
  })

  it('缺失文件与匹配不到任何文件的 glob 都会被记录并影响哈希', async () => {
    const fs = new MemoryFileSystem(seed)
    const base = await hashInputs(fs, '', ['pom.xml'])
    const withMissingFile = await hashInputs(fs, '', ['pom.xml', 'src/Deleted.java'])
    expect(withMissingFile.missing).toContain('src/Deleted.java')
    expect(withMissingFile.hash).not.toBe(base.hash)

    const withMissingGlob = await hashInputs(fs, '', ['missing-dir/**/*.md'])
    expect(withMissingGlob.missing).toEqual(['missing-dir/**/*.md'])
    expect(withMissingGlob.files).toEqual([])

    const empty = await hashInputs(fs, '', [])
    expect(empty.files).toEqual([])
    expect(empty.missing).toEqual([])
    expect(empty.hash.startsWith('sha256:')).toBe(true)
  })
})

describe('回执新鲜度：输入没变才有效', () => {
  it('没有回执返回 no-receipt', () => {
    expect(receiptFreshness(undefined, 'sha256:abc')).toEqual({ fresh: false, reason: 'no-receipt' })
  })

  it('输入哈希不一致 → inputs-changed', () => {
    const result = receiptFreshness(receipt({}), 'sha256:changed')
    expect(result.fresh).toBe(false)
    expect(result.reason).toBe('inputs-changed')
    expect(result.receipt?.id).toBe('E-1')
  })

  it('输入没变且 GREEN → fresh', () => {
    const result = receiptFreshness(receipt({}), 'sha256:abc')
    expect(result.fresh).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('RED 回执即使输入没变也不是新鲜 GREEN（reason=failed）', () => {
    const result = receiptFreshness(receipt({ phase: 'red', exitCode: 1 }), 'sha256:abc')
    expect(result.fresh).toBe(false)
    expect(result.reason).toBe('failed')
  })

  it('未解析或零测试回执 → no-green', () => {
    expect(receiptFreshness(receipt({ phase: 'none' }), 'sha256:abc').reason).toBe('no-green')
  })
})

describe('同一组以最新一次为准（更早的通过不能覆盖之后的失败）', () => {
  it('latestReceiptWins 取 finishedAt 更晚者，相同则取后者', () => {
    const earlier = receipt({ id: 'E-1', finishedAt: '2026-11-12T10:01:00+08:00' })
    const later = receipt({ id: 'E-2', finishedAt: '2026-11-12T10:02:00+08:00' })
    expect(latestReceiptWins(earlier, later).id).toBe('E-2')
    expect(latestReceiptWins(later, earlier).id).toBe('E-2')
    const same = receipt({ id: 'E-3', finishedAt: '2026-11-12T10:02:00+08:00' })
    expect(latestReceiptWins(later, same).id).toBe('E-3')
  })

  it('selectReceiptsForGroup 只取本组并按时间升序', () => {
    const receipts = [
      receipt({ id: 'E-2', finishedAt: '2026-11-12T10:02:00+08:00' }),
      receipt({ id: 'E-9', group: 'other' }),
      receipt({ id: 'E-1', finishedAt: '2026-11-12T10:01:00+08:00' }),
    ]
    expect(selectReceiptsForGroup(receipts, 'renewal-unit').map((entry) => entry.id)).toEqual(['E-1', 'E-2'])
  })

  it('buildEvidenceView 输出 latestByGroup / latestFailed，后失败覆盖先通过', () => {
    const receipts = [
      receipt({ id: 'E-1', phase: 'green', exitCode: 0, finishedAt: '2026-11-12T10:01:00+08:00' }),
      receipt({
        id: 'E-2',
        phase: 'red',
        exitCode: 1,
        finishedAt: '2026-11-12T10:05:00+08:00',
        summary: { parser: 'junit-xml', parsed: true, run: 3, passed: 2, failed: 1, skipped: 0 },
      }),
      receipt({
        id: 'E-3',
        group: 'other',
        phase: 'green',
        exitCode: 0,
        finishedAt: '2026-11-12T10:03:00+08:00',
      }),
    ]
    const view = buildEvidenceView(receipts)
    expect(view.receipts.map((entry) => entry.id)).toEqual(['E-1', 'E-3', 'E-2'])
    expect(view.latestByGroup['renewal-unit']?.id).toBe('E-2')
    expect(view.latestFailed['renewal-unit']).toBe(true)
    expect(view.latestByGroup['other']?.id).toBe('E-3')
    expect(view.latestFailed['other']).toBe(false)
  })

  it('receiptFailed：非零退出码或存在失败用例都算失败', () => {
    expect(receiptFailed(receipt({ phase: 'green', exitCode: 1 }))).toBe(true)
    expect(
      receiptFailed(
        receipt({
          phase: 'none',
          summary: { parser: 'x', parsed: true, run: 2, passed: 1, failed: 1, skipped: 0 },
        }),
      ),
    ).toBe(true)
    expect(receiptFailed(receipt({}))).toBe(false)
  })
})
