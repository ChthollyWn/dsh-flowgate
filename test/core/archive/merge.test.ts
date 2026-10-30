import { describe, expect, it } from 'vitest'
import {
  capabilityDirName,
  mergeIncrementalSpec,
  readIncrementalRequirements,
  requirementKeyOf,
  splitRequirementBlocks,
} from '../../../src/core/archive/merge'

const ADDED = `## ADDED Requirements

### Requirement: R1 会员续费
系统 SHALL 允许会员续费。

#### Scenario: R1.S1 续费成功
- GIVEN 有效会员
- WHEN 调用续费接口
- THEN 到期日延长 30 天
`

const MODIFIED = `## MODIFIED Requirements

### Requirement: R2 续费起算点
续费从次日开始计算，而不是当天。

#### Scenario: R2.S1 次日生效
- GIVEN 会员当天续费
- WHEN 支付成功
- THEN 到期日从次日开始累加 30 天
`

const REMOVED = `## REMOVED Requirements

### Requirement: R3 旧的手动续费入口
移除原因：改为支付回调自动续费；迁移方式：旧入口返回 410。
`

describe('spec merge (ADDED / MODIFIED / REMOVED)', () => {
  it('creates a main spec header and appends ADDED requirements', () => {
    const result = mergeIncrementalSpec(null, ADDED, { capability: 'membership' })
    expect(result.updated).toBe(false)
    expect(result.added).toEqual(['R1'])
    expect(result.markdown).toContain('# 主规格：membership')
    expect(result.markdown).toContain('### Requirement: R1 会员续费')
    expect(result.warnings).toEqual([])
  })

  it('adds a first MODIFIED as a warning, then replaces it on the next merge', () => {
    const first = mergeIncrementalSpec(null, ADDED, { capability: 'membership' }).markdown
    const added = mergeIncrementalSpec(first, MODIFIED, { capability: 'membership' })
    expect(added.added).toEqual(['R2'])
    expect(added.warnings[0]).toContain('MODIFIED')
    const replaced = mergeIncrementalSpec(added.markdown, MODIFIED, { capability: 'membership' })
    expect(replaced.modified).toEqual(['R2'])
    expect(replaced.markdown.match(/### Requirement: R2/g)).toHaveLength(1)
    expect(replaced.markdown).toContain('续费从次日开始计算')
    expect(replaced.markdown).toContain('### Requirement: R1 会员续费')
  })

  it('removes an existing requirement and warns when REMOVED is missing', () => {
    const removedR1 = `## REMOVED Requirements\n\n### Requirement: R1 会员续费\n移除原因：需求取消。\n`
    const first = mergeIncrementalSpec(null, ADDED + '\n' + MODIFIED, {}).markdown
    const removed = mergeIncrementalSpec(first, removedR1, {})
    expect(removed.removed).toEqual(['R1'])
    expect(removed.markdown).not.toContain('R1 会员续费')
    expect(removed.markdown).toContain('R2 续费起算点')
    const missing = mergeIncrementalSpec(removed.markdown, removedR1, {})
    expect(missing.warnings[0]).toContain('R1')
    // R3 从未存在：只产生警告，不删除任何东西。
    const untouched = mergeIncrementalSpec(first, REMOVED, {})
    expect(untouched.removed).toEqual([])
    expect(untouched.warnings[0]).toContain('R3')
  })

  it('warns when ADDED duplicates an existing requirement (replace semantics)', () => {
    const first = mergeIncrementalSpec(null, ADDED, {}).markdown
    const duplicate = mergeIncrementalSpec(first, ADDED, {})
    expect(duplicate.modified).toEqual(['R1'])
    expect(duplicate.warnings[0]).toContain('ADDED')
    expect(duplicate.markdown.match(/### Requirement: R1/g)).toHaveLength(1)
  })

  it('treats MODIFIED of an unknown requirement as an addition with a warning', () => {
    const result = mergeIncrementalSpec(null, MODIFIED, {})
    expect(result.added).toEqual(['R2'])
    expect(result.warnings[0]).toContain('MODIFIED')
  })

  it('parses change-type sections and requirement blocks', () => {
    const incremental = readIncrementalRequirements(ADDED + '\n' + REMOVED)
    expect(incremental.map((entry) => `${entry.changeType}:${entry.block.key}`)).toEqual(['ADDED:R1', 'REMOVED:R3'])
    const split = splitRequirementBlocks(ADDED)
    expect(split.blocks).toHaveLength(1)
    expect(split.blocks[0]!.raw).toContain('R1.S1')
  })

  it('derives stable requirement keys and capability directory names', () => {
    expect(requirementKeyOf('R2 续费起算点')).toBe('R2')
    expect(requirementKeyOf('AB-12 场景增强')).toBe('AB-12')
    expect(requirementKeyOf('Naming Convention')).toBe('naming-convention')
    expect(capabilityDirName('会员 续费/升级', 'C-001')).toBe('会员-续费升级')
    expect(capabilityDirName('...', 'C-001')).toBe('C-001')
  })
})
