/**
 * 第六轮清理回归（2026-10-31）：
 * - T2.8 低复杂度快车道只允许 1 张任务卡；
 * - T2.2 自动落账的「（待补充）」占位符不能通过 G1 的「改变说明」检查；
 * - T2.3 `test: none` 必须以真实跑通的 build/lint/typecheck 回执作基线。
 */
import { describe, expect, it } from 'vitest'

import { checkBaseline, checkClarifyQaChanged, checkTaskCount } from '../../../src/core/artifacts/checks'
import {
  CLARIFY,
  PROJECT,
  TASKS,
  levelFor,
  makeCtx,
  taskCard,
  validBundle,
  validChange,
  validConfig,
} from '../../fixtures/artifacts/helpers'

const NOW = '2026-11-12T10:31:05+08:00'

function cards(): ReturnType<typeof taskCard>[] {
  return [
    taskCard({ id: 'T1', covers: ['R1.S1'], scope: ['src/main/java/com/acme/member/**'], size: 'S' }),
    taskCard({ id: 'T2', covers: ['R1.S2'], scope: ['src/main/java/com/acme/member/**'], size: 'S' }),
  ]
}

describe('第六轮清理：门禁检查补强', () => {
  it('低复杂度只允许 1 张任务卡（T2.8）', () => {
    const two = cards()
    const ctx = makeCtx({
      change: { ...validChange(), complexity: 'low' },
      level: levelFor('low', 'normal'),
      artifacts: validBundle({ tasks: { ...TASKS, tasks: two } }),
    })
    const outcome = checkTaskCount(ctx)
    expect(outcome.passed).toBe(false)
    expect(`${outcome.hint ?? ''} ${(outcome.details ?? []).join(' ')}`).toContain('上限 1')

    const single = checkTaskCount({
      ...ctx,
      artifacts: validBundle({ tasks: { ...TASKS, tasks: [two[0]!] } }),
    })
    expect(single.passed).toBe(true)
  })

  it('中复杂度仍用配置上限（低复杂度限制不误伤）', () => {
    const outcome = checkTaskCount(
      makeCtx({ artifacts: validBundle({ tasks: { ...TASKS, tasks: cards() } }) }),
    )
    expect(outcome.passed).toBe(true)
  })

  it('问答记录占位符不算「写清改变了什么」（T2.2）', () => {
    const placeholder = checkClarifyQaChanged(
      makeCtx({
        artifacts: validBundle({
          clarify: { ...CLARIFY, qa: CLARIFY.qa.map((row) => ({ ...row, changed: '（待补充）' })) },
        }),
      }),
    )
    expect(placeholder.passed).toBe(false)
    expect((placeholder.details ?? []).join(' ')).toContain('缺少改变说明')

    const filled = checkClarifyQaChanged(
      makeCtx({
        artifacts: validBundle({
          clarify: { ...CLARIFY, qa: CLARIFY.qa.map((row) => ({ ...row, changed: '增加验收场景' })) },
        }),
      }),
    )
    expect(filled.passed).toBe(true)
  })

  it('test:none：只有 baseline 字段、没有真实 build/lint 回执时 G2 失败（T2.3）', () => {
    const config = { ...validConfig(), commands: { test: 'none', build: 'pnpm build' } }
    const outcome = checkBaseline(
      makeCtx({
        config,
        change: {
          ...validChange(),
          baseline: {
            commit: null,
            summary: { parser: 'none', parsed: false, run: 0, passed: 0, failed: 0, skipped: 0 },
            recordedAt: NOW,
          },
        },
        project: { ...PROJECT, commands: { test: 'none', build: 'pnpm build' } },
        evidence: [],
      }),
    )
    expect(outcome.passed).toBe(false)
    expect(`${outcome.hint ?? ''}`).toContain('构建')
  })
})
