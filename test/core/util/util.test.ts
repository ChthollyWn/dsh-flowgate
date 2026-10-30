import { describe, expect, it } from 'vitest'
import {
  normalizeRelPath,
  posixBasename,
  posixDirname,
  posixJoin,
  isUnder,
  toRelPath,
} from '../../../src/core/util/paths'
import { compileGlob, globsMayOverlap, matchAnyGlob, matchGlob } from '../../../src/core/util/glob'
import {
  containsSecret,
  hmacSha256,
  randomKeyHex,
  redactSecrets,
  safeEqualHex,
  sha256,
  sha256Hex,
  stableJson,
} from '../../../src/core/util/hash'
import { dateOnly, isOlderThanMinutes, isoNow, minutesBetween, stampForDir } from '../../../src/core/util/time'
import {
  extractBullets,
  extractFences,
  extractSections,
  extractTables,
  findSection,
  findYamlBlock,
  sectionHasContent,
  splitTableRow,
  stripComments,
} from '../../../src/core/util/markdown'

describe('core/util/paths', () => {
  it('normalizes repository-relative paths', () => {
    expect(normalizeRelPath('  ./src//a.ts/  ')).toBe('src/a.ts')
    expect(normalizeRelPath('.//src//a.ts/')).toBe('/src/a.ts')
    expect(normalizeRelPath('.\\src\\b.ts')).toBe('src/b.ts')
    expect(normalizeRelPath('.')).toBe('')
    expect(normalizeRelPath('/')).toBe('/')
  })

  it('resolves relative targets and posix parts', () => {
    expect(toRelPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(toRelPath('/repo', '/other/a.ts')).toBe('/other/a.ts')
    expect(posixDirname('a/b/c.ts')).toBe('a/b')
    expect(posixDirname('c.ts')).toBe('')
    expect(posixBasename('a/b/c.ts')).toBe('c.ts')
    expect(posixJoin('a', '', 'b/')).toBe('a/b')
    expect(isUnder('src/host/guard/index.ts', 'src/host')).toBe(true)
    expect(isUnder('src/other.ts', 'src/host')).toBe(false)
    expect(isUnder('anything', '')).toBe(true)
  })
})

describe('core/util/glob', () => {
  it('matches *, ** and ? segments', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/nested/a.ts')).toBe(false)
    expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/**/*.ts', 'src/nested/deep/a.ts')).toBe(true)
    expect(matchGlob('src/a?.ts', 'src/ab.ts')).toBe(true)
    expect(matchGlob('src/a?.ts', 'src/abc.ts')).toBe(false)
    expect(matchAnyGlob(['docs/**', 'CHANGELOG*'], 'docs/x.md')).toBe(true)
    expect(compileGlob('src/**').test('src/a/b.ts')).toBe(true)
  })

  it('detects glob overlap for the G3 parallel safety check', () => {
    expect(globsMayOverlap('src/**', 'src/main/a.java')).toBe(true)
    expect(globsMayOverlap('src/a/**', 'src/b/**')).toBe(false)
    expect(globsMayOverlap('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globsMayOverlap('', 'src/a.ts')).toBe(true)
  })
})

describe('core/util/hash', () => {
  it('hashes deterministically and compares safely', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('abc')).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(hmacSha256('key', 'abc')).toHaveLength(64)
    expect(safeEqualHex('aa', 'aa')).toBe(true)
    expect(safeEqualHex('aa', 'ab')).toBe(false)
    expect(safeEqualHex('zz', 'zzzz')).toBe(false)
    expect(randomKeyHex(4)).toHaveLength(8)
  })

  it('stableJson sorts keys recursively', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}')
  })

  it('redacts common secrets and detects their patterns', () => {
    const redacted = redactSecrets(
      'key sk-abcdefghijklmnopqrstuvwxyz123456 and password: hunter2secret plus gh_token=ghp_abcdefghijklmnopqrstuvwxyz',
    )
    expect(redacted).toContain('[REDACTED API KEY]')
    expect(redacted).toContain('password:[REDACTED]')
    expect(redacted).not.toContain('hunter2secret')
    expect(containsSecret('AKIAABCDEFGHIJKLMNOP')).toBe(true)
    expect(containsSecret('hello world')).toBe(false)
  })
})

describe('core/util/time', () => {
  it('formats iso/stamp/date helpers', () => {
    const iso = isoNow({ now: () => new Date('2026-03-01T12:34:56+08:00') })
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(stampForDir('2026-03-01T12:34:56+08:00')).toBe('2026-03-01-1234')
    expect(stampForDir('not-a-date')).toBe('')
    expect(dateOnly('2026-03-01T12:34:56+08:00')).toBe('2026-03-01')
    expect(dateOnly('bad')).toBe('bad')
  })

  it('computes minute gaps and staleness', () => {
    expect(minutesBetween('2026-03-01T00:00:00Z', '2026-03-01T00:10:30Z')).toBe(10.5)
    expect(minutesBetween('bad', '2026-03-01T00:00:00Z')).toBeNull()
    expect(isOlderThanMinutes('bad', 5)).toBe(true)
    expect(isOlderThanMinutes('2026-03-01T00:00:00Z', 5, new Date('2026-03-01T00:01:00Z'))).toBe(false)
    expect(isOlderThanMinutes('2026-03-01T00:00:00Z', 5, new Date('2026-03-01T00:06:00Z'))).toBe(true)
  })
})

describe('core/util/markdown', () => {
  const doc = [
    '# 标题',
    '',
    '## 方案',
    '',
    '| 方案 | 说明 |',
    '|---|---|',
    '| A | `a|b` 转义 |',
    '',
    '```yaml',
    'covers: [R1.S1]',
    '```',
    '',
    '- 一',
    '  - 二',
    '',
    '<!-- 模板注释 -->',
  ].join('\n')

  it('extracts fences, tables, sections, bullets', () => {
    const fences = extractFences(doc)
    expect(fences).toHaveLength(1)
    expect(fences[0]).toMatchObject({ lang: 'yaml', content: 'covers: [R1.S1]' })
    const tables = extractTables(doc)
    expect(tables).toHaveLength(1)
    expect(tables[0]?.headers).toEqual(['方案', '说明'])
    expect(splitTableRow('| A | `a|b` |')).toEqual(['A', '`a|b`'])
    const sections = extractSections(doc)
    expect(sections.map((section) => section.title)).toEqual(['标题', '方案'])
    expect(findSection(doc, /方案/)?.body).toContain('| 方案 |')
    expect(extractBullets(doc).map((bullet) => bullet.text)).toEqual(['一', '二'])
  })

  it('finds yaml blocks and judges section content', () => {
    expect(findYamlBlock(doc)).toBe('covers: [R1.S1]')
    expect(findYamlBlock('no yaml here')).toBeNull()
    expect(sectionHasContent('- 内容')).toBe(true)
    expect(sectionHasContent('<!-- 模板注释 -->')).toBe(false)
    expect(stripComments('a<!-- x -->b')).toBe('ab')
  })
})
