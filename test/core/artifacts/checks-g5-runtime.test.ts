/** G5 运行证据检查（T4.2 验收 #2）：配置了 run 就要求运行回执/手工证据。 */
import { describe, expect, it } from 'vitest'
import { checkG5RuntimeEvidence } from '../../../src/core/artifacts/checks'
import type { EvidenceReceipt } from '../../../src/core/types'
import { makeCtx, validConfig, validEvidence } from '../../fixtures/artifacts/helpers'

function runReceipt(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
  return {
    id: 'E-9001',
    changeId: 'C-001',
    group: 'runtime',
    kind: 'run',
    phase: 'green',
    command: 'pnpm start',
    runBy: 'flowgate',
    exitCode: 0,
    summary: null,
    inputsHash: '',
    outputRef: '.flowgate/state/evidence/run-1.log',
    startedAt: '2026-11-01T09:00:00+08:00',
    finishedAt: '2026-11-01T09:00:30+08:00',
    notes: '健康检查：通过',
    ...overrides,
  }
}

const RUN_CONFIG = { ...validConfig(), commands: { run: 'pnpm start', health: 'http://localhost:3000/health' } }

describe('checkG5RuntimeEvidence（T4.2 验收 #2）', () => {
  it('配置了 run 但没有运行回执：失败并给出 health 提示', async () => {
    const ctx = makeCtx({ gate: 'G5', config: RUN_CONFIG, evidence: validEvidence() })
    const outcome = await checkG5RuntimeEvidence(ctx)
    expect(outcome.passed).toBe(false)
    expect(outcome.hint).toContain('运行证据')
    expect(outcome.details?.join(' ')).toContain('http://localhost:3000/health')
  })

  it('有绿色运行回执：通过', async () => {
    const ctx = makeCtx({ gate: 'G5', config: RUN_CONFIG, evidence: [...validEvidence(), runReceipt()] })
    const outcome = await checkG5RuntimeEvidence(ctx)
    expect(outcome.passed).toBe(true)
    expect(outcome.details?.join(' ')).toContain('pnpm start')
  })

  it('运行回执失败时仍失败（不把 exitCode 非 0 当通过）', async () => {
    const ctx = makeCtx({
      gate: 'G5',
      config: RUN_CONFIG,
      evidence: [...validEvidence(), runReceipt({ exitCode: 1, phase: 'red' })],
    })
    expect((await checkG5RuntimeEvidence(ctx)).passed).toBe(false)
  })

  it('手工运行证据可作为普通风险兜底', async () => {
    const manual: EvidenceReceipt = {
      ...runReceipt({ id: 'E-9002', kind: 'manual', group: 'manual', command: 'attach:smoke.log', runBy: 'agent' }),
    }
    const ctx = makeCtx({ gate: 'G5', config: RUN_CONFIG, evidence: [...validEvidence(), manual] })
    const outcome = await checkG5RuntimeEvidence(ctx)
    expect(outcome.passed).toBe(true)
    expect(outcome.details?.join(' ')).toContain('手工运行证据')
  })

  it('未配置 run 时普通风险不要求运行证据', async () => {
    const ctx = makeCtx({ gate: 'G5', config: validConfig(), evidence: validEvidence() })
    expect((await checkG5RuntimeEvidence(ctx)).passed).toBe(true)
  })
})
