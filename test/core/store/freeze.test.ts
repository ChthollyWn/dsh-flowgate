import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { sha256 } from '../../../src/core/util/hash'
import type { ArtifactBundle } from '../../../src/core/types'
import {
  artifactKeyForPath,
  artifactsFingerprint,
  assertArtifactsUnmodified,
  assertNotFrozen,
  contractConfigSnapshot,
  freezeArtifacts,
  freezeContract,
  frozenContractConfig,
  unfreezeArtifacts,
} from '../../../src/core/store'
import { DEFAULT_CONFIG, parseConfig } from '../../../src/core/store'
import { makeChange } from './fixtures'

const designRaw = '# 设计\n方案 A：复用 SignatureVerifier。\n'
const riskRaw = '# 风险\n| 类别 | 等级 |\n'

const bundle: ArtifactBundle = {
  clarify: {
    raw: '# 澄清',
    originalDescription: '原始描述',
    knownFacts: [],
    elements: {
      goal: { conclusion: '', source: '', status: '' },
      boundary: { conclusion: '', source: '', status: '' },
      roles: { conclusion: '', source: '', status: '' },
      acceptance: { conclusion: '', source: '', status: '' },
      constraints: { conclusion: '', source: '', status: '' },
      unknowns: { conclusion: '', source: '', status: '' },
    },
    qa: [],
    assumptions: [],
    openQuestions: [],
    rounds: 1,
  },
  design: {
    raw: designRaw,
    options: [],
    recommendation: '复用现有验签',
    dataFlow: '',
    errorHandling: '',
    rollback: '回滚到旧版本镜像',
  },
  risk: { raw: riskRaw, entries: [] },
}

describe('freezeContract', () => {
  it('冻结插件版本、规则哈希、等级哈希与技能版本', () => {
    const contract = freezeContract(DEFAULT_CONFIG, '0.1.0', { 'flow-plan': 'sha256:s1', 'flow-clarify': 'sha256:s2' }, '2026-11-12T10:00:00+08:00')
    expect(contract.plugin).toBe('0.1.0')
    expect(contract.rules).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(contract.levels).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(contract.skills).toEqual({ 'flow-plan': 'sha256:s1', 'flow-clarify': 'sha256:s2' })
    expect(contract.createdAt).toBe('2026-11-12T10:00:00+08:00')
  })

  it('相同配置得到相同契约哈希', () => {
    const at = '2026-11-12T10:00:00+08:00'
    const a = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    const b = freezeContract(parseConfig(''), '0.1.0', {}, at)
    expect(a).toEqual(b)
  })

  it('规则/触发器变化改变 rules 哈希；限制变化改变 levels 哈希', () => {
    const at = '2026-11-12T10:00:00+08:00'
    const base = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    const changedRules = parseConfig(
      'rules:\n  - id: R-NEW\n    when: {}\n    decision: deny\n    why: 测试\n    unlock: 无\n',
    )
    const rulesContract = freezeContract(changedRules, '0.1.0', {}, at)
    expect(rulesContract.rules).not.toBe(base.rules)

    const changedLimits = parseConfig('limits:\n  task_max_files: 9\n')
    const levelsContract = freezeContract(changedLimits, '0.1.0', {}, at)
    expect(levelsContract.levels).not.toBe(base.levels)
  })

  it('插件版本不同但配置相同：contract 其余字段一致', () => {
    const at = '2026-11-12T10:00:00+08:00'
    const older = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    const newer = freezeContract(DEFAULT_CONFIG, '0.2.0', {}, at)
    expect(newer.rules).toBe(older.rules)
    expect(newer.levels).toBe(older.levels)
    expect(newer.plugin).not.toBe(older.plugin)
  })
})

describe('frozenContractConfig（T1.3：在途变更按冻结契约判定）', () => {
  const at = '2026-11-12T10:00:00+08:00'
  const changed = parseConfig(
    'rules:\n  - id: R-STAGE-SRC\n    when: {}\n    decision: allow\n    why: 测试覆盖\n    unlock: 无\nlimits:\n  task_max_files: 9\n',
  )

  it('contract.snapshot 写入完整判定配置', () => {
    const contract = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    expect(contract.snapshot).toBeDefined()
    expect(contract.snapshot!.rules).toEqual(DEFAULT_CONFIG.rules)
    expect(contract.snapshot!.limits).toEqual(DEFAULT_CONFIG.limits)
    expect(contract.snapshot).toEqual(contractConfigSnapshot(DEFAULT_CONFIG))
  })

  it('有冻结快照时忽略之后修改的规则与限制', () => {
    const contract = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    const effective = frozenContractConfig(changed, contract)
    expect(effective.rules).toEqual(DEFAULT_CONFIG.rules)
    expect(effective.limits).toEqual(DEFAULT_CONFIG.limits)
    // 命令等非契约字段仍取当前配置。
    expect(effective.commands.test).toBe(changed.commands.test)
  })

  it('旧状态没有快照时回退当前配置（兼容性）', () => {
    const legacy = { plugin: '0.1.0', rules: 'sha256:x', levels: 'sha256:y', skills: {}, createdAt: at }
    expect(frozenContractConfig(changed, legacy)).toBe(changed)
    expect(frozenContractConfig(changed, undefined)).toBe(changed)
  })

  it('返回的是深拷贝，修改结果不会污染冻结快照', () => {
    const contract = freezeContract(DEFAULT_CONFIG, '0.1.0', {}, at)
    const effective = frozenContractConfig(changed, contract)
    effective.limits.task_max_files = 123
    expect(contract.snapshot!.limits.task_max_files).not.toBe(123)
  })
})

describe('freezeArtifacts / unfreezeArtifacts（T2.1/T2.5：门通过后冻结产物）', () => {
  const at = '2026-11-12T10:00:00+08:00'

  it('把产物原文哈希合并进 change.frozen，内容未变不重复更新', () => {
    const change = makeChange({ id: 'C-001' })
    const first = freezeArtifacts(change, bundle, at)
    expect(first).toEqual(['clarify', 'design', 'risk'])
    expect(change.frozen!.design!.hash).toBe(sha256(designRaw))

    const second = freezeArtifacts(change, bundle, '2026-11-13T10:00:00+08:00')
    expect(second).toEqual([])
    // 未变化时保留原冻结时间。
    expect(change.frozen!.design!.at).toBe(at)
  })

  it('内容变化时更新哈希与冻结时间', () => {
    const change = makeChange({ id: 'C-001' })
    freezeArtifacts(change, bundle, at)
    const changed: ArtifactBundle = { ...bundle, design: { ...bundle.design!, raw: '改过的设计' } }
    const keys = freezeArtifacts(change, changed, '2026-11-13T10:00:00+08:00')
    expect(keys).toEqual(['design'])
    expect(change.frozen!.design!.hash).toBe(sha256('改过的设计'))
  })

  it('unfreezeArtifacts 可按 key 解除或全部解除', () => {
    const change = makeChange({ id: 'C-001' })
    freezeArtifacts(change, bundle, at)
    expect(unfreezeArtifacts(change, ['design'])).toEqual(['design'])
    expect(Object.keys(change.frozen!).sort()).toEqual(['clarify', 'risk'])
    expect(unfreezeArtifacts(change)).toEqual(['clarify', 'risk'])
    expect(change.frozen).toEqual({})
    expect(unfreezeArtifacts(change)).toEqual([])
  })
})

describe('artifactsFingerprint', () => {
  it('按 ArtifactBundle 键名对产物原文求 sha256，只包含存在的产物', () => {
    const fingerprint = artifactsFingerprint(bundle)
    expect(Object.keys(fingerprint).sort()).toEqual(['clarify', 'design', 'risk'])
    expect(fingerprint.design).toBe(sha256(designRaw))
    expect(fingerprint.risk).toBe(sha256(riskRaw))
  })

  it('原文变化则指纹变化', () => {
    const changed: ArtifactBundle = { design: { ...bundle.design!, raw: `${designRaw}补充` } }
    expect(artifactsFingerprint(changed).design).not.toBe(artifactsFingerprint(bundle).design)
  })

  it('空 bundle 返回空对象', () => {
    expect(artifactsFingerprint({})).toEqual({})
  })
})

describe('assertArtifactsUnmodified', () => {
  it('冻结哈希与文件内容一致时未修改', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/changes/C-001/design.md': designRaw,
      '.flowgate/changes/C-001/specs/spec.md': '# 规格',
    })
    const change = makeChange({
      id: 'C-001',
      frozen: {
        design: { hash: sha256(designRaw), at: '2026-11-11T12:00:00+08:00' },
        spec: { hash: sha256('# 规格'), at: '2026-11-11T12:00:00+08:00' },
      },
    })
    await expect(assertArtifactsUnmodified(fs, '', change)).resolves.toEqual({ modified: [] })
  })

  it('内容被改或文件被删都算修改', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/changes/C-001/design.md': designRaw })
    const change = makeChange({
      id: 'C-001',
      frozen: {
        design: { hash: sha256(designRaw), at: '2026-11-11T12:00:00+08:00' },
        proposal: { hash: sha256('# 提案'), at: '2026-11-11T12:00:00+08:00' },
      },
    })
    await expect(assertArtifactsUnmodified(fs, '', change)).resolves.toEqual({
      modified: ['proposal'],
    })
    await fs.writeFile('.flowgate/changes/C-001/design.md', '改过的设计')
    await expect(assertArtifactsUnmodified(fs, '', change)).resolves.toEqual({
      modified: ['design', 'proposal'],
    })
  })

  it('没有冻结产物时返回空', async () => {
    const fs = new MemoryFileSystem()
    await expect(assertArtifactsUnmodified(fs, '', makeChange())).resolves.toEqual({ modified: [] })
  })
})

describe('assertNotFrozen', () => {
  const change = makeChange({
    frozen: { design: { hash: sha256(designRaw), at: '2026-11-11T12:00:00+08:00' } },
  })

  it('已冻结产物返回 frozen + 解锁提示', () => {
    const result = assertNotFrozen(change, '.flowgate/changes/C-001/design.md')
    expect(result.frozen).toBe(true)
    expect(result.hint).toContain('冻结')
    expect(result.hint).toContain('返工')
  })

  it('未冻结产物/非产物路径/无冻结记录都返回 false', () => {
    expect(assertNotFrozen(change, '.flowgate/changes/C-001/tasks.md').frozen).toBe(false)
    expect(assertNotFrozen(change, 'src/main/java/A.java').frozen).toBe(false)
    expect(assertNotFrozen(makeChange(), '.flowgate/changes/C-001/design.md').frozen).toBe(false)
  })

  it('多能力 spec 路径按文件名识别', () => {
    const specChange = makeChange({ frozen: { spec: { hash: 'sha256:x', at: '2026-11-11T12:00:00+08:00' } } })
    expect(assertNotFrozen(specChange, '.flowgate/changes/C-001/specs/payment/spec.md').frozen).toBe(true)
  })
})

describe('artifactKeyForPath', () => {
  it('识别变更产物与项目级产物', () => {
    expect(artifactKeyForPath('.flowgate/changes/C-001/design.md')).toBe('design')
    expect(artifactKeyForPath('.flowgate/changes/C-001/execution-plan.md')).toBe('execution-plan')
    expect(artifactKeyForPath('/repo/.flowgate/changes/C-001/specs/pay/spec.md')).toBe('spec')
    expect(artifactKeyForPath('.flowgate/project.md')).toBe('project')
    expect(artifactKeyForPath('.flowgate/roadmap.md')).toBe('roadmap')
    expect(artifactKeyForPath('src/main/java/A.java')).toBeNull()
  })
})
