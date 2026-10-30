import type { ChangeStatus, PendingItem } from '../../../src/core/types'

/** 测试用变更状态；字段可在 overrides 中覆盖（每次调用返回独立对象）。 */
export function makeChange(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  const base: ChangeStatus = {
    id: 'C-001',
    kind: 'change',
    title: '会员续费',
    complexity: 'medium',
    risk: 'normal',
    stage: 'S4',
    lifecycle: 'active',
    gates: {},
    batches: [],
    tasks: {},
    evidenceIds: [],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [],
    createdAt: '2026-11-10T09:00:00+08:00',
    updatedAt: '2026-11-12T10:31:05+08:00',
  }
  return { ...base, ...overrides }
}

export function makePending(id: string, kind: PendingItem['kind'] = 'risk'): PendingItem {
  return {
    id,
    kind,
    changeId: 'C-001',
    title: `待处理 ${id}`,
    detail: '测试用待处理项',
    status: 'open',
    createdAt: '2026-11-12T10:00:00+08:00',
  }
}
