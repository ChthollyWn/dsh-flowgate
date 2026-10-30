import { afterEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { buildAddArgs, NodeGit, runGit } from '../../src/host/adapters/node-git.js'

const temps: string[] = []

async function tempRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'flowgate-nodegit-'))
  temps.push(dir)
  await runGit(['init'], dir)
  await runGit(['config', 'user.email', 'e2e@local'], dir)
  await runGit(['config', 'user.name', 'e2e'], dir)
  await runGit(['commit', '--allow-empty', '-m', 'baseline'], dir)
  return dir
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await fsp.rm(dir, { recursive: true, force: true })
})

describe('host/node-git — git add 参数构造（真机回归）', () => {
  it('keeps options before `--` and paths after it', () => {
    // 2026-10-31 真机发现：`git add -- -A` 会把 -A 当 pathspec，导致自动提交永远失败。
    expect(buildAddArgs(['-A'])).toEqual(['add', '-A'])
    expect(buildAddArgs(['a.ts', 'b.ts'])).toEqual(['add', '--', 'a.ts', 'b.ts'])
    expect(buildAddArgs(['-A', 'a.ts'])).toEqual(['add', '-A', '--', 'a.ts'])
    expect(buildAddArgs([])).toEqual(['add'])
  })

  it('adds a new file with the -A flag and commits it', async () => {
    const root = await tempRepo()
    await fsp.writeFile(nodePath.join(root, 'note.txt'), 'hello\n')
    const git = new NodeGit()
    await git.add(root, ['-A'])
    await git.commit(root, 'add note')
    expect(await git.statusPorcelain(root)).toBe('')
    expect(await git.diffNames(root, 'HEAD~1')).toContain('note.txt')
  })
})
