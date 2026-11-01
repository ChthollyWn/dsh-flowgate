/**
 * 修复通道持久化（v0.5.1）：id 生成、active repair 读写/清空、修复记录归档 + 索引、
 * 事故记录归档。所有读取都必须对损坏文件降级为 null（不抛错）。
 */
import { describe, expect, it } from 'vitest'

import type { RepairRecord } from '../../../src/core/types'
import {
  clearActiveRepair,
  listFixIds,
  listIncidentIds,
  nextStampedId,
  normalizeRepairRecord,
  readActiveRepair,
  renderFixIndexHeader,
  stampedId,
  writeActiveRepair,
  writeFixRecord,
  writeIncidentRecord,
} from '../../../src/core/store'
import { layout } from '../../../src/core/store/layout'
import { isoNow } from '../../../src/core/util/time'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { FakeClock } from '../../helpers/fakes'

const ROOT = ''

function makeRecord(overrides: Partial<RepairRecord> = {}): RepairRecord {
  return {
    id: 'FIX-20261101-090000',
    title: '修复新建会话失败',
    symptom: '新建会话返回 500',
    scope: ['src/core/**', 'test/core/**'],
    verify: 'pnpm vitest run',
    acceptance: ['新建会话成功'],
    severity: 'P0',
    status: 'open',
    openedAt: '2026-11-01T09:00:00+08:00',
    openedBy: 'agent',
    actions: 0,
    ...overrides,
  }
}

describe('store/repair: id 生成', () => {
  it('stampedId 形如 FIX-YYYYMMDD-HHMMSS / INC-...', () => {
    const clock = new FakeClock()
    // 时间戳段与 isoNow 的本地时间一致；测试不能假设运行机器时区
    // （CI runner 是 UTC，本地开发是 +08:00——写死 090000 会在 CI 挂掉）。
    const iso = isoNow(clock)
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso)
    expect(match, iso).not.toBeNull()
    const stamp = `${match![1]}${match![2]}${match![3]}-${match![4]}${match![5]}${match![6]}`
    expect(stampedId('FIX', clock)).toBe(`FIX-${stamp}`)
    expect(stampedId('INC', clock)).toBe(`INC-${stamp}`)
    expect(stampedId('FIX', clock, 2)).toBe(`FIX-${stamp}-2`)
  })

  it('同秒冲突追加序号，直到不重复', () => {
    const clock = new FakeClock()
    const base = stampedId('FIX', clock)
    expect(nextStampedId('FIX', clock, [])).toBe(base)
    expect(nextStampedId('FIX', clock, [base])).toBe(`${base}-2`)
    expect(nextStampedId('FIX', clock, [base, `${base}-2`])).toBe(`${base}-3`)
  })
})

describe('store/repair: active repair', () => {
  it('写入后可读回；clear 后读回 null', async () => {
    const fs = new MemoryFileSystem()
    const record = makeRecord()
    await writeActiveRepair(fs, ROOT, record)
    expect(fs.listFiles()).toContain(layout(ROOT).repair)
    expect(fs.listFiles()).not.toContain(`${layout(ROOT).repair}.tmp`)
    const loaded = await readActiveRepair(fs, ROOT)
    expect(loaded).toEqual(record)
    await clearActiveRepair(fs, ROOT)
    await expect(readActiveRepair(fs, ROOT)).resolves.toBeNull()
    // 重复 clear 不抛错。
    await expect(clearActiveRepair(fs, ROOT)).resolves.toBeUndefined()
  })

  it('损坏 / 非 open 的 active repair 读取返回 null（不抛错）', async () => {
    const fs = new MemoryFileSystem({ [layout(ROOT).repair]: '{"id": "FIX-1", broken' })
    await expect(readActiveRepair(fs, ROOT)).resolves.toBeNull()
    await fs.writeFile(layout(ROOT).repair, JSON.stringify(makeRecord({ status: 'done' })))
    await expect(readActiveRepair(fs, ROOT)).resolves.toBeNull()
  })

  it('normalizeRepairRecord 拒绝缺少关键字段的记录', () => {
    expect(normalizeRepairRecord(null)).toBeNull()
    expect(normalizeRepairRecord({ id: 'FIX-1' })).toBeNull()
    expect(normalizeRepairRecord({ id: 'FIX-1', title: 't', verify: 'pnpm test', scope: [] })).toBeNull()
    const valid = normalizeRepairRecord(makeRecord())
    expect(valid?.id).toBe('FIX-20261101-090000')
  })
})

describe('store/repair: 修复记录归档与索引', () => {
  it('写 JSON + 追加 index.md，多个记录共用一份表头', async () => {
    const fs = new MemoryFileSystem()
    const first = makeRecord({ status: 'done', summary: '已修复', changedFiles: ['src/core/engine.ts'] })
    const second = makeRecord({ id: 'FIX-20261101-090500', title: '第二个修复', status: 'aborted', abortReason: '换个思路' })
    const firstPath = await writeFixRecord(fs, ROOT, first)
    const secondPath = await writeFixRecord(fs, ROOT, second)
    expect(firstPath).toBe(`${layout(ROOT).fixesDir}/${first.id}.json`)
    expect(fs.listFiles()).toContain(firstPath)
    expect(fs.listFiles()).toContain(secondPath)
    const index = await fs.readFile(layout(ROOT).fixesIndex)
    expect(index.startsWith(renderFixIndexHeader())).toBe(true)
    expect((index.match(/\| 编号 \| 标题 \|/g) ?? []).length).toBe(1)
    expect(index).toContain(first.id)
    expect(index).toContain('已修复')
    expect(index).toContain(second.id)
    expect(index).toContain('中止：换个思路')
    await expect(listFixIds(fs, ROOT)).resolves.toEqual([first.id, second.id])
  })
})

describe('store/repair: 事故记录归档', () => {
  it('写 incidents/<id>.json 并可列出 id', async () => {
    const fs = new MemoryFileSystem()
    const path = await writeIncidentRecord(fs, ROOT, {
      id: 'INC-20261101-090000',
      severity: 'P0',
      reason: '新建会话失败',
      openedAt: '2026-11-01T09:00:00+08:00',
      openedBy: 'agent',
      closedAt: '2026-11-01T10:00:00+08:00',
      summary: '修复会话投影 JSON 清洗',
      commit: 'abc1234',
      tests: 'pnpm vitest run',
      files: ['src/host/projection/index.ts'],
    })
    expect(path).toBe(`${layout(ROOT).incidentsDir}/INC-20261101-090000.json`)
    const raw = JSON.parse(await fs.readFile(path)) as Record<string, unknown>
    expect(raw.summary).toBe('修复会话投影 JSON 清洗')
    expect(raw.files).toEqual(['src/host/projection/index.ts'])
    await expect(listIncidentIds(fs, ROOT)).resolves.toEqual(['INC-20261101-090000'])
    // 目录不存在时返回空数组。
    await expect(listIncidentIds(new MemoryFileSystem(), ROOT)).resolves.toEqual([])
  })
})
