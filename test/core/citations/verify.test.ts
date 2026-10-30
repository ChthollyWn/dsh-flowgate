import { describe, expect, it } from 'vitest'
import {
  citationsFresh,
  citationsStale,
  documentCitations,
  verifyCitations,
} from '../../../src/core/citations/verify'
import { extractCitationRefs } from '../../../src/core/artifacts/parse'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import type { CitationCheck } from '../../../src/core/types'

const NOW = '2026-11-12T10:31:05+08:00'

const SERVICE = `package com.acme.member;

public class RenewalService {
  public void renew() {
    // 幂等处理
    return;
  }
}
`

function fsWithService(extra: Record<string, string> = {}): MemoryFileSystem {
  return new MemoryFileSystem({ 'src/main/java/com/acme/member/RenewalService.java': SERVICE, ...extra })
}

describe('verifyCitations', () => {
  it('文件和行号存在、quote 一致 → 通过并记录 hash 与时间', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [{ file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 3, endLine: 6 }],
      NOW,
    )
    expect(checks).toHaveLength(1)
    expect(checks[0]).toMatchObject({ ok: true, verifiedAt: NOW })
    expect(checks[0]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('quote 是引用范围内的原文 → 通过', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [
        {
          file: 'src/main/java/com/acme/member/RenewalService.java',
          startLine: 3,
          endLine: 6,
          quote: 'public void renew() {',
        },
      ],
      NOW,
    )
    expect(checks[0]!.ok).toBe(true)
  })

  it('行号超出范围 → 失败并指出文件行数', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [{ file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 80, endLine: 95 }],
      NOW,
    )
    expect(checks[0]!.ok).toBe(false)
    expect(checks[0]!.error).toContain('行号超出范围')
    expect(checks[0]!.error).toContain('只有 8 行')
  })

  it('quote 与原文不一致 → 失败', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [
        {
          file: 'src/main/java/com/acme/member/RenewalService.java',
          startLine: 3,
          endLine: 4,
          quote: '这段代码根本不存在',
        },
      ],
      NOW,
    )
    expect(checks[0]!.ok).toBe(false)
    expect(checks[0]!.error).toContain('引用片段与原文不一致')
  })

  it('文件不存在 → 失败', async () => {
    const checks = await verifyCitations(
      new MemoryFileSystem({}),
      '',
      [{ file: 'src/missing/File.java', startLine: 1, endLine: 1 }],
      NOW,
    )
    expect(checks[0]!.ok).toBe(false)
    expect(checks[0]!.error).toContain('文件不存在')
  })

  it('startLine > endLine 时自动归一化，且容忍文件末尾换行', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [{ file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 8, endLine: 7 }],
      NOW,
    )
    expect(checks[0]!.ok).toBe(true)
    expect(checks[0]!.citation.startLine).toBe(7)
    expect(checks[0]!.citation.endLine).toBe(8)
  })

  it('支持带 root 前缀的路径', async () => {
    const fs = new MemoryFileSystem({ 'repo/src/a.ts': 'line1\nline2\n' })
    const checks = await verifyCitations(fs, 'repo', [{ file: 'src/a.ts', startLine: 2, endLine: 2 }], NOW)
    expect(checks[0]!.ok).toBe(true)
  })

  it('批量引用各自独立判定', async () => {
    const checks = await verifyCitations(
      fsWithService(),
      '',
      [
        { file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 1, endLine: 1 },
        { file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 100, endLine: 100 },
        { file: 'nope.ts', startLine: 1, endLine: 1 },
      ],
      NOW,
    )
    expect(checks.map((check) => check.ok)).toEqual([true, false, false])
  })
})

describe('citationsFresh / citationsStale', () => {
  function checksFor(text: string): Promise<CitationCheck[]> {
    return verifyCitations(
      fsWithService(),
      '',
      [{ file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 1, endLine: 2 }],
      NOW,
    ).then((checks) => {
      void text
      return checks
    })
  }

  it('文件未改 → fresh', async () => {
    const fs = fsWithService()
    const checks = await checksFor('')
    expect(await citationsFresh(fs, '', checks[0]!)).toBe(true)
    expect(await citationsStale(fs, '', checks)).toEqual([])
  })

  it('文件被修改 → 不再 fresh，标记 stale', async () => {
    const fs = fsWithService()
    const checks = await checksFor('')
    await fs.writeFile('src/main/java/com/acme/member/RenewalService.java', `${SERVICE}\n// changed\n`)
    expect(await citationsFresh(fs, '', checks[0]!)).toBe(false)
    const stale = await citationsStale(fs, '', checks)
    expect(stale).toHaveLength(1)
    expect(stale[0]!.stale).toBe(true)
  })

  it('文件被删除 → 视为 stale', async () => {
    const fs = fsWithService()
    const checks = await checksFor('')
    await fs.remove('src/main/java/com/acme/member/RenewalService.java')
    const stale = await citationsStale(fs, '', checks)
    expect(stale).toHaveLength(1)
  })

  it('核验失败的引用不参与 stale 判断', async () => {
    const failed: CitationCheck = {
      citation: { file: 'missing.ts', startLine: 1, endLine: 1 },
      ok: false,
      error: '文件不存在',
    }
    expect(await citationsFresh(fsWithService(), '', failed)).toBe(false)
    expect(await citationsStale(fsWithService(), '', [failed])).toEqual([])
  })
})

describe('documentCitations', () => {
  it('从文档 raw 中提取引用', () => {
    const raw = '已知事实：续费入口在 src/main/java/com/acme/member/RenewalService.java:3-6。'
    const refs = documentCitations({ raw })
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ file: 'src/main/java/com/acme/member/RenewalService.java', startLine: 3, endLine: 6 })
    expect(documentCitations({ raw })).toEqual(extractCitationRefs(raw))
  })

  it('空文档返回空数组', () => {
    expect(documentCitations({ raw: '' })).toEqual([])
  })
})
