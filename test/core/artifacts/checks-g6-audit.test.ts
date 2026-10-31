import { describe, expect, it } from 'vitest'
import { checkG6ExternalChanges, checkG6TamperCheck } from '../../../src/core/artifacts/checks'
import { makeCtx, validChange } from '../../fixtures/artifacts/helpers'

describe('G6 篡改/外部改动检查（T3.5 / T1.4 验收 #3）', () => {
  it('有 open 的 TM-n 篡改待处理项时 g6.tamper 失败并列出信号', async () => {
    const ctx = makeCtx({
      gate: 'G6',
      change: validChange({
        pending: [
          {
            id: 'TM-1',
            kind: 'tamper',
            changeId: 'C-001',
            title: '疑似篡改测试/门禁配置',
            detail: '',
            status: 'open',
            createdAt: '',
            data: { signals: [{ kind: 'skipped-test', path: 'test/a.test.ts' }] },
          },
        ],
      }),
    })
    const outcome = await checkG6TamperCheck(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('篡改')
    expect(outcome.details?.join(' ')).toContain('test/a.test.ts')
  })

  it('没有篡改项时 g6.tamper 通过', async () => {
    const ctx = makeCtx({ gate: 'G6', change: validChange({ pending: [] }) })
    expect((await checkG6TamperCheck(ctx)).passed).toBe(true)
  })

  it('未确认的非 agent 改动让 g6.externalChanges 失败；确认后通过', async () => {
    const change = validChange({
      externalChanges: [
        { path: 'src/manual.ts', at: '2026-11-01T09:00:00+08:00', origin: 'external' },
        { path: 'src/old.ts', at: '2026-11-01T09:00:00+08:00', origin: 'external', confirmedAt: '2026-11-01T09:05:00+08:00' },
      ],
    })
    const ctx = makeCtx({ gate: 'G6', change })
    const failed = await checkG6ExternalChanges(ctx)
    expect(failed.passed).toBe(false)
    expect(failed.details?.join(' ')).toContain('src/manual.ts')
    expect(failed.details?.join(' ')).not.toContain('src/old.ts')

    const confirmed = makeCtx({
      gate: 'G6',
      change: validChange({
        externalChanges: [{ path: 'src/manual.ts', at: '2026-11-01T09:00:00+08:00', origin: 'external', confirmedAt: '2026-11-01T09:05:00+08:00' }],
      }),
    })
    expect((await checkG6ExternalChanges(confirmed)).passed).toBe(true)
  })
})
