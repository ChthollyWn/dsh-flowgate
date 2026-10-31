/** 审查读取覆盖的行级核对（T3.4 验收 #3）。 */
import { describe, expect, it } from 'vitest'
import {
  changedLinesFromDiff,
  readRangesFromEvents,
  uncoveredChangedLines,
} from '../../src/host/review/index.js'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-const a = 1',
  '+const a = 2',
  '@@ -298,2 +300,2 @@',
  '-const b = 1',
  '+const b = 2',
].join('\n')

describe('changedLinesFromDiff', () => {
  it('解析每文件的新增行号（含多处 hunk）', () => {
    expect(changedLinesFromDiff(DIFF)).toEqual({ 'src/a.ts': [1, 2, 300, 301] })
  })
})

describe('readRangesFromEvents', () => {
  it('从 read 工具调用的参数提取文件与 offset/limit', () => {
    const ranges = readRangesFromEvents([
      { type: 'tool/execute', data: { name: 'read', arguments: { file_path: 'src/a.ts', offset: 1, limit: 200 } } },
      { tool: 'read', args: { path: 'src/b.ts' } },
      { data: { name: 'grep', arguments: { path: 'src/a.ts' } } },
    ])
    expect(ranges).toContainEqual({ file: 'src/a.ts', start: 1, end: 200 })
    expect(ranges).toContainEqual({ file: 'src/b.ts', start: 1, end: Number.POSITIVE_INFINITY })
    expect(ranges).toHaveLength(2)
  })
})

describe('uncoveredChangedLines', () => {
  it('只读了前 200 行时，第 300 行改动算未覆盖', () => {
    const ranges = [{ file: 'src/a.ts', start: 1, end: 200 }]
    const uncovered = uncoveredChangedLines(DIFF, ranges)
    expect(uncovered).toEqual([{ file: 'src/a.ts', lines: [300, 301] }])
  })

  it('覆盖全部改动行时无未覆盖项', () => {
    const ranges = [{ file: 'src/a.ts', start: 1, end: 400 }]
    expect(uncoveredChangedLines(DIFF, ranges)).toEqual([])
  })

  it('完全没读该文件时列出全部改动行', () => {
    const uncovered = uncoveredChangedLines(DIFF, [])
    expect(uncovered[0]?.file).toBe('src/a.ts')
    expect(uncovered[0]?.lines).toEqual([1, 2, 300, 301])
  })
})
