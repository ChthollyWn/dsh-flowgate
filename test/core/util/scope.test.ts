/**
 * 修复通道的 scope 匹配（v0.5.1）：glob、目录前缀、裸文件名/后缀、反斜杠归一，
 * 以及 finishRepair 用的越界清单。
 */
import { describe, expect, it } from 'vitest'

import { matchesScope, outOfScopePaths } from '../../../src/core/util/scope'

describe('util/scope: matchesScope', () => {
  it('glob 语义：** 任意深度、* 单段、? 单字符', () => {
    expect(matchesScope('src/core/engine.ts', ['src/core/**'])).toBe(true)
    expect(matchesScope('src/core/deep/nested/file.ts', ['src/core/**'])).toBe(true)
    expect(matchesScope('test/core/engine.test.ts', ['src/core/**'])).toBe(false)
    expect(matchesScope('src/index.ts', ['src/*.ts'])).toBe(true)
    expect(matchesScope('src/deep/index.ts', ['src/*.ts'])).toBe(false)
    expect(matchesScope('src/a.ts', ['src/?.ts'])).toBe(true)
    expect(matchesScope('test/core/engine.test.ts', ['**/*.test.ts'])).toBe(true)
  })

  it('目录前缀语义：声明目录等于允许其下所有文件', () => {
    expect(matchesScope('src/core/engine.ts', ['src/core'])).toBe(true)
    expect(matchesScope('src/core', ['src/core'])).toBe(true)
    expect(matchesScope('src/coreplus/x.ts', ['src/core'])).toBe(false)
  })

  it('裸文件名/后缀语义：不写目录也能命中（降低声明后永远不命中的死锁）', () => {
    expect(matchesScope('src/core/engine.ts', ['engine.ts'])).toBe(true)
    expect(matchesScope('src/core/engine.ts', ['core/engine.ts'])).toBe(false)
    expect(matchesScope('docs/readme.md', ['*.md'])).toBe(true)
    expect(matchesScope('src/core/engine.ts', ['*.ts'])).toBe(true)
    expect(matchesScope('src/engine.tsx', ['*.ts'])).toBe(false)
  })

  it('反斜杠归一与 ./ 前缀清理', () => {
    expect(matchesScope('src\\core\\engine.ts', ['src/core/**'])).toBe(true)
    expect(matchesScope('./src/core/engine.ts', ['src/core/**'])).toBe(true)
    expect(matchesScope('src/core/engine.ts', ['./src/core'])).toBe(true)
  })

  it('空路径 / 空 scope 一律不命中', () => {
    expect(matchesScope('', ['src/**'])).toBe(false)
    expect(matchesScope('src/a.ts', [])).toBe(false)
    expect(matchesScope('src/a.ts', [''])).toBe(false)
  })
})

describe('util/scope: outOfScopePaths', () => {
  it('返回未命中 scope 的路径（顺序保持）', () => {
    const outside = outOfScopePaths(
      ['src/core/engine.ts', 'docs/x.md', 'test/core/engine.test.ts', '.flowgate/config.yaml'],
      ['src/core/**', 'test/**'],
    )
    expect(outside).toEqual(['docs/x.md', '.flowgate/config.yaml'])
  })
})
