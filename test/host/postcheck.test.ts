/** 事后检测纯函数（T1.4：撤销后自动解除越界的判定）。 */
import { describe, expect, it } from 'vitest'
import { cleanedPaths } from '../../src/host/postcheck/index.js'
import type { WorkspaceSnapshot } from '../../src/host/postcheck/index.js'

function snapshot(files: Record<string, string>): WorkspaceSnapshot {
  return { at: '2026-11-01T09:00:00+08:00', mode: 'git', fingerprint: 'fp', files: new Map(Object.entries(files)) }
}

describe('cleanedPaths', () => {
  it('调用前已改、调用后回到干净状态的路径才会被解除', () => {
    const before = snapshot({ 'src/a.ts': 'h1', 'src/b.ts': 'h2', 'src/c.ts': 'h3' })
    const after = snapshot({ 'src/b.ts': 'h2', 'src/d.ts': 'h4' })
    expect(cleanedPaths(before, after)).toEqual(['src/a.ts', 'src/c.ts'])
  })

  it('没有撤销时返回空', () => {
    const before = snapshot({ 'src/a.ts': 'h1' })
    expect(cleanedPaths(before, before)).toEqual([])
  })
})
