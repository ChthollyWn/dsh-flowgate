/**
 * 修复通道智能准入（v0.7）：纯函数规则矩阵。
 *
 * 覆盖：approved / adjusted（scope、verify、title、acceptance 自动补全）/
 * downgraded（已有变更、锁定、敏感面、过宽 scope、脏工作区、非法 verify、无信号），
 * 以及 RED 线索识别、受保护路径剔除、置信度与推荐车道。
 */
import { describe, expect, it } from 'vitest'
import {
  REPAIR_MAX_CHANGED_FILES,
  deriveScopeCandidates,
  deriveVerifyCandidate,
  isBroadScopePattern,
  reviewRepairAdmission,
  scopeTouchesSensitive,
  type RepairAdmissionInput,
} from '../../../src/core/flow/repair-admission'
import { DEFAULT_CONFIG } from '../../../src/core/store/config'
import type { EvidenceReceipt, FlowgateConfig } from '../../../src/core/types'

const NOW = '2026-11-01T10:00:00+08:00'
const SEP = 'pnpm vitest run test/flowgate/repair.test.ts'

function receipt(over: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    id: 'E-0001',
    changeId: 'C-003',
    group: 'repro',
    kind: 'test',
    phase: 'red',
    command: 'pnpm vitest run test/core/engine-repair-lane.test.ts',
    runBy: 'flowgate',
    exitCode: 1,
    summary: null,
    inputsHash: 'hash-1',
    outputRef: '.flowgate/state/evidence/E-0001.log',
    startedAt: '2026-11-01T09:30:00+08:00',
    finishedAt: '2026-11-01T09:31:00+08:00',
    ...over,
  }
}

function config(over: Partial<FlowgateConfig['commands']> = {}): FlowgateConfig {
  return {
    ...DEFAULT_CONFIG,
    commands: { ...over },
  }
}

function input(over: Partial<RepairAdmissionInput> = {}): RepairAdmissionInput {
  return {
    title: '修复续费回调重复扣款',
    symptom: '续费回调被重复处理，用户被扣两次钱',
    scope: ['src/core/**', 'test/core/**'],
    verify: SEP,
    acceptance: [],
    severity: 'P2',
    config: config({ test: 'pnpm test' }),
    activeChange: null,
    activeRepairId: null,
    initialized: true,
    locked: false,
    receipts: [],
    changedFiles: [],
    now: NOW,
    ...over,
  }
}

describe('修复准入：approved', () => {
  it('声明齐全且无风险时按声明通过', () => {
    const review = reviewRepairAdmission(input())
    expect(review.verdict).toBe('approved')
    expect(review.recommendedLane).toBe('repair')
    expect(review.scopeSource).toBe('declared')
    expect(review.verifySource).toBe('declared')
    expect(review.confidence).toBe('high')
    expect(review.blockers).toEqual([])
    expect(review.checks.find((check) => check.id === 'scope')?.passed).toBe(true)
    expect(review.nextSteps.length).toBeGreaterThan(0)
  })
})

describe('修复准入：adjusted（信号推导）', () => {
  it('scope/verify 缺失时从失败回执与未提交改动推导', () => {
    const review = reviewRepairAdmission(
      input({
        title: '',
        scope: [],
        verify: '',
        changedFiles: ['src/core/engine.ts'],
        receipts: [receipt()],
      }),
    )
    expect(review.verdict).toBe('adjusted')
    expect(review.scopeSource).toBe('suggested')
    expect(review.verifySource).toBe('failed-receipt')
    expect(review.verify).toBe('pnpm vitest run test/core/engine-repair-lane.test.ts')
    expect(review.scope).toContain('src/core/engine.ts')
    expect(review.scope).toContain('test/core/engine-repair-lane.test.ts')
    expect(review.title).not.toBe('')
    expect(review.acceptance).toHaveLength(2)
    expect(review.redEvidence?.id).toBe('E-0001')
    expect(review.confidence).toBe('medium')
  })

  it('verify 缺失时回退到项目测试命令', () => {
    const review = reviewRepairAdmission(input({ verify: '', config: config({ test: 'pnpm test' }) }))
    expect(review.verify).toBe('pnpm test')
    expect(review.verifySource).toBe('project')
    expect(review.verdict).toBe('adjusted')
  })

  it('title 省略时从 symptom 推导', () => {
    const review = reviewRepairAdmission(input({ title: '' }))
    expect(review.title).toContain('续费回调')
    expect(review.verdict).toBe('adjusted')
  })
})

describe('修复准入：downgraded（确定性拒绝）', () => {
  it('已有进行中的变更 → 推荐变更内返工', () => {
    const review = reviewRepairAdmission(input({ activeChange: { id: 'C-009', title: '会员续费' } }))
    expect(review.verdict).toBe('downgraded')
    expect(review.recommendedLane).toBe('rework')
    expect(review.blockers.join()).toContain('C-009')
    expect(review.nextSteps.join()).toContain('flow_declare_rework')
  })

  it('锁定模式 / 未初始化都拒绝', () => {
    expect(reviewRepairAdmission(input({ locked: true })).verdict).toBe('downgraded')
    const uninitialized = reviewRepairAdmission(input({ initialized: false }))
    expect(uninitialized.verdict).toBe('downgraded')
    expect(uninitialized.blockers.join()).toContain('flow init')
  })

  it('scope 过宽（整棵目录/通配一切）→ 推荐变更车道', () => {
    for (const scope of [['src/**'], ['**'], ['*'], ['src']]) {
      const review = reviewRepairAdmission(input({ scope }))
      expect(review.verdict, scope.join()).toBe('downgraded')
      expect(review.recommendedLane).toBe('change')
      expect(review.checks.find((check) => check.id === 'scope-broad')?.passed).toBe(false)
    }
  })

  it('scope 命中敏感面 → 推荐变更车道', () => {
    const review = reviewRepairAdmission(input({ scope: ['src/auth/login.ts'] }))
    expect(review.verdict).toBe('downgraded')
    expect(review.recommendedLane).toBe('change')
    expect(review.blockers.join()).toContain('敏感面')
  })

  it('预存未提交改动不在 scope 内 → 拒绝（否则关门必失败）', () => {
    const review = reviewRepairAdmission(input({ scope: ['src/core/**'], changedFiles: ['README.md'] }))
    expect(review.verdict).toBe('downgraded')
    expect(review.blockers.join()).toContain('README.md')
    expect(review.recommendedLane).toBe('repair') // 修正声明/工作区后可重试，不是改车道
  })

  it('验证命令形状非法 → 拒绝', () => {
    const review = reviewRepairAdmission(input({ verify: 'pnpm test && rm -rf dist' }))
    expect(review.verdict).toBe('downgraded')
    expect(review.blockers.join()).toContain('验证命令不合法')
  })

  it('scope 条数超过上限 → 拒绝', () => {
    const scope = Array.from({ length: 21 }, (_, index) => `src/core/file-${index}.ts`)
    const review = reviewRepairAdmission(input({ scope }))
    expect(review.verdict).toBe('downgraded')
    expect(review.blockers.join()).toContain('上限')
  })

  it('没有任何信号也推导不出 scope/verify → 拒绝并提示怎么补信号', () => {
    const review = reviewRepairAdmission(input({ scope: [], verify: '', receipts: [], changedFiles: [], config: config() }))
    expect(review.verdict).toBe('downgraded')
    expect(review.blockers.join()).toContain('scope')
    expect(review.blockers.join()).toContain('验证命令')
    expect(review.nextSteps[0]).toContain('准入')
  })

  it('受保护路径从 scope 剔除并留理由', () => {
    const review = reviewRepairAdmission(input({ scope: ['.flowgate/state/repair.json', 'src/core/**'] }))
    expect(review.scope).toEqual(['src/core/**'])
    expect(review.reasons.join()).toContain('受保护路径')
    expect(review.verdict).not.toBe('downgraded')
  })
})

describe('修复准入：信号推导辅助函数', () => {
  it('deriveScopeCandidates 从失败回执命令里提取路径并去重', () => {
    const scope = deriveScopeCandidates({
      changedFiles: ['src/core/a.ts'],
      receipts: [receipt({ command: 'pnpm vitest run test/core/b.test.ts' }), receipt({ id: 'E-0002', command: 'pnpm vitest run test/core/b.test.ts' })],
    })
    expect(scope).toContain('src/core/a.ts')
    expect(scope.filter((path) => path === 'test/core/b.test.ts')).toHaveLength(1)
  })

  it('deriveVerifyCandidate 优先最近失败测试命令，其次项目命令，形状非法时跳过', () => {
    const failed = deriveVerifyCandidate({
      config: config({ test: 'pnpm test' }),
      receipts: [receipt({ command: 'pnpm test || true', finishedAt: '2026-11-01T09:59:00+08:00' })],
    })
    expect(failed.source).toBe('project')
    expect(failed.verify).toBe('pnpm test')
    const none = deriveVerifyCandidate({ config: config(), receipts: [] })
    expect(none.source).toBe('none')
  })

  it('isBroadScopePattern / scopeTouchesSensitive 的边界', () => {
    expect(isBroadScopePattern('src/core/**')).toBe(false)
    expect(isBroadScopePattern('src/**')).toBe(true)
    expect(isBroadScopePattern('docs/impl/repair-lane.md')).toBe(false)
    expect(scopeTouchesSensitive('src/auth/session.ts', ['**/auth/**'])).toBe(true)
    expect(scopeTouchesSensitive('src/host/projection/wire.ts', ['**/auth/**'])).toBe(false)
  })

  it('改动文件上限常量可被关门校验引用', () => {
    expect(REPAIR_MAX_CHANGED_FILES).toBeGreaterThan(0)
  })
})
