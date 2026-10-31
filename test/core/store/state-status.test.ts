import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  ensureChangeDir,
  listChanges,
  readChangeStatus,
  writeChangeStatus,
} from '../../../src/core/store'
import { makeChange } from './fixtures'

describe('change status persistence', () => {
  it('原子写 status.json：内容可回读、不残留 .tmp', async () => {
    const fs = new MemoryFileSystem()
    const change = makeChange()
    await writeChangeStatus(fs, '', change)
    const read = await readChangeStatus(fs, '', 'C-001')
    expect(read).toEqual(change)
    expect(fs.listFiles()).toContain('.flowgate/changes/C-001/status.json')
    expect(fs.listFiles().some((path) => path.endsWith('.tmp'))).toBe(false)
    const raw = await fs.readFile('.flowgate/changes/C-001/status.json')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('"id": "C-001"')
  })

  it('覆盖写不残留旧内容', async () => {
    const fs = new MemoryFileSystem()
    await writeChangeStatus(fs, '', makeChange({ title: '旧标题' }))
    await writeChangeStatus(fs, '', makeChange({ title: '新标题' }))
    const read = await readChangeStatus(fs, '', 'C-001')
    expect(read?.title).toBe('新标题')
    expect(fs.listFiles().filter((path) => path.includes('status'))).toEqual([
      '.flowgate/changes/C-001/status.json',
    ])
  })

  it('不存在时返回 null', async () => {
    const fs = new MemoryFileSystem()
    await expect(readChangeStatus(fs, '', 'C-999')).resolves.toBeNull()
  })

  it('JSON 损坏时抛错并提示授权卡片修复（不再要求手输命令）', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/changes/C-001/status.json': '{"id": "C-001", broken' })
    await expect(readChangeStatus(fs, '', 'C-001')).rejects.toThrowError(/status\.json.*损坏|损坏.*status\.json/)
    await expect(readChangeStatus(fs, '', 'C-001')).rejects.toThrowError(/授权卡片上修复/)
  })

  it('JSON 有效但缺少 id 时抛错', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/changes/C-001/status.json': '{"title": "x"}' })
    await expect(readChangeStatus(fs, '', 'C-001')).rejects.toThrowError(/id/)
  })

  it('root 前缀参与路径计算', async () => {
    const fs = new MemoryFileSystem()
    await writeChangeStatus(fs, '/repo', makeChange())
    expect(fs.listFiles()).toEqual(['/repo/.flowgate/changes/C-001/status.json'])
    await expect(readChangeStatus(fs, '/repo', 'C-001')).resolves.toEqual(makeChange())
  })
})

describe('listChanges', () => {
  it('按编号升序列出，跳过 index.md 与损坏的状态文件', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/changes/index.md': '# 变更台账\n',
      '.flowgate/changes/C-004/status.json': '{broken',
    })
    await writeChangeStatus(fs, '', makeChange({ id: 'C-003', title: '三' }))
    await writeChangeStatus(fs, '', makeChange({ id: 'C-001', title: '一' }))
    await writeChangeStatus(fs, '', makeChange({ id: 'A-001', kind: 'analysis', title: '分析' }))
    const changes = await listChanges(fs, '')
    expect(changes.map((change) => change.id)).toEqual(['A-001', 'C-001', 'C-003'])
    expect(changes.find((change) => change.id === 'C-001')?.title).toBe('一')
  })

  it('changes 目录不存在时返回空数组', async () => {
    const fs = new MemoryFileSystem()
    await expect(listChanges(fs, '')).resolves.toEqual([])
  })
})

describe('ensureChangeDir', () => {
  it('创建变更目录与 specs 目录，可重复调用', async () => {
    const fs = new MemoryFileSystem()
    await ensureChangeDir(fs, '', 'C-007')
    await ensureChangeDir(fs, '', 'C-007')
    await expect(fs.exists('.flowgate/changes/C-007')).resolves.toBe(true)
    await expect(fs.exists('.flowgate/changes/C-007/specs')).resolves.toBe(true)
  })
})
