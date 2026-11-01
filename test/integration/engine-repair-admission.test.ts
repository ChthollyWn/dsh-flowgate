/**
 * 修复通道智能准入（v0.7）端到端：信号推导 → 确定性复核 → 开启/拒绝 → 账本留痕。
 *
 * 覆盖：preview 不开启修复、scope/verify 自动推导、脏工作区/敏感面拒绝、
 * 账本 repair.assessed / repair.rejected、关门改动文件上限。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import type { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { createSandbox, VITEST_PASS_STDOUT, type FakeClock, type FakeCommandRunner, type FakeGit } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []
const FAIL_STDOUT = [
  ' RUN  v2.1.0 /repo',
  ' ❯ test/core/engine.test.ts (1 test | 1 failed)',
  '   × sample',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
  '',
].join('\n')

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function harness(): Promise<Harness> {
  const sandbox = createSandbox()
  const engine = new FlowEngine({
    root: ROOT,
    fs: sandbox.fs,
    clock: sandbox.clock,
    git: sandbox.git,
    commandRunner: sandbox.runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'repair-admission-key',
    sessionId: 'session-admission',
    sessionLabel: 'admission',
    host: { gateChecker: ALL_PASS },
  })
  await engine.load()
  return { ...sandbox, engine }
}

async function ledgerTypes(fs: MemoryFileSystem): Promise<string[]> {
  const path = '.flowgate/state/ledger.jsonl'
  if (!(await fs.exists(path))) return []
  const raw = await fs.readFile(path)
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

async function redGreen(h: Harness): Promise<void> {
  h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
  const red = await h.engine.runVerify({ group: 'repro' })
  expect(red.phase).toBe('red')
  const green = await h.engine.runVerify({ group: 'repro' })
  expect(green.phase).toBe('green')
}

describe('修复通道智能准入：通过', () => {
  it('previewRepair 只预演不开启修复（dryRun 语义）', async () => {
    const h = await harness()
    await h.engine.init()
    const review = await h.engine.previewRepair({
      title: '修复新建会话失败',
      symptom: '新建会话失败',
      scope: ['src/host/projection/**'],
      verify: 'pnpm test',
    })
    expect(review.verdict).toBe('approved')
    expect(review.recommendedLane).toBe('repair')
    expect(h.engine.getRepair()).toBeNull()
    // 预演不写修复状态/账本。
    expect(await h.fs.exists('.flowgate/state/repair.json')).toBe(false)
    expect(await ledgerTypes(h.fs)).not.toContain('repair.started')
  })

  it('scope 省略时从预存改动推导，verify 省略时从项目命令推导', async () => {
    const h = await harness()
    h.git.setChangedFiles(['src/core/engine.ts'])
    await h.engine.init()
    const projectTest = h.engine.getConfig().commands.test
    expect(projectTest).toBeTruthy()
    const record = await h.engine.startRepair({ symptom: '修复引擎边界：重复扣款', title: '' })
    expect(record.id).toMatch(/^FIX-/)
    expect(record.title).toContain('重复扣款')
    expect(record.scope).toContain('src/core/engine.ts')
    expect(record.verify).toBe(projectTest)
    expect(record.admission?.verdict).toBe('adjusted')
    expect(record.admission?.scopeSource).toBe('suggested')
    expect(record.admission?.verifySource).toBe('project')
    const types = await ledgerTypes(h.fs)
    expect(types).toContain('repair.assessed')
    expect(types).toContain('repair.started')
  })
})

describe('修复通道智能准入：拒绝', () => {
  it('预存改动在 scope 外 → 拒绝且不产生半开启修复', async () => {
    const h = await harness()
    h.git.setChangedFiles(['README.md'])
    await h.engine.init()
    const rejected = h.engine.startRepair({ symptom: 'x', scope: ['src/index.ts'], verify: 'pnpm test' })
    await expect(rejected).rejects.toThrow('修复准入未通过')
    await expect(rejected).rejects.toThrow('README.md')
    expect(h.engine.getRepair()).toBeNull()
    expect(await h.fs.exists('.flowgate/state/repair.json')).toBe(false)
    expect(await ledgerTypes(h.fs)).toContain('repair.rejected')
  })

  it('scope 命中敏感面 → 拒绝并推荐变更车道', async () => {
    const h = await harness()
    await h.engine.init()
    await expect(
      h.engine.startRepair({ symptom: 'x', scope: ['src/auth/login.ts'], verify: 'pnpm test' }),
    ).rejects.toThrow('敏感面')
    expect(await ledgerTypes(h.fs)).toContain('repair.rejected')
  })

  it('无法推导 verify 且未声明 → 拒绝', async () => {
    const h = await harness()
    await h.fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }))
    await h.engine.init()
    await expect(h.engine.startRepair({ symptom: 'x', scope: ['src/index.ts'] })).rejects.toThrow('验证命令')
  })
})

describe('修复通道智能准入：关门上限', () => {
  it('改动文件超过修复通道上限时拒绝关门（提示改用变更车道），且保持 open', async () => {
    const h = await harness()
    await h.engine.init()
    const record = await h.engine.startRepair({ symptom: 'x', scope: ['src/core/**'], verify: 'pnpm test' })
    await redGreen(h)
    h.git.setChangedFiles(Array.from({ length: 21 }, (_, index) => `src/core/file-${index}.ts`))
    await expect(h.engine.finishRepair()).rejects.toThrow('改动文件过多')
    expect(h.engine.getRepair()?.id).toBe(record.id)
  })

  it('小范围修复正常关门（自动推导 scope 也能闭环）', async () => {
    const h = await harness()
    h.git.setChangedFiles(['src/core/engine.ts'])
    await h.engine.init()
    const record = await h.engine.startRepair({ symptom: '修复边界', verify: 'pnpm test' })
    await redGreen(h)
    const outcome = await h.engine.finishRepair({ summary: '根因与修复' })
    expect(outcome.record.status).toBe('done')
    expect(outcome.record.changedFiles).toEqual(['src/core/engine.ts'])
    expect(h.engine.getRepair()).toBeNull()
    expect(await ledgerTypes(h.fs)).toContain('repair.done')
    expect(record.id).toBe(outcome.record.id)
  })
})

describe('修复通道智能准入：RED 线索', () => {
  it('最近失败回执作为 RED 线索展示（预演只读，不改变进行中的修复）', async () => {
    const h = await harness()
    await h.engine.init()
    const record = await h.engine.startRepair({ symptom: 'x', scope: ['src/core/**'], verify: 'pnpm test' })
    h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
    const receipt = await h.engine.runVerify({ group: 'repro' })
    expect(receipt.phase).toBe('red')
    const before = JSON.stringify(h.engine.getRepair())
    const review = await h.engine.previewRepair({ symptom: 'x', scope: ['src/core/**'], verify: 'pnpm test' })
    expect(review.redEvidence?.id).toBe(receipt.id)
    expect(review.requiresRed).toBe(true)
    // 预演只读：不改变进行中的修复（RED 绑定仍只来自真实 flow_verify）。
    expect(JSON.stringify(h.engine.getRepair())).toBe(before)
    expect(h.engine.getRepair()?.redEvidenceId).toBe(receipt.id)
    expect(record.id).toBe(h.engine.getRepair()?.id)
  })

  it('测试替身输出默认 GREEN，S1 前的失败回执不会被误判为 RED', async () => {
    const h = await harness()
    await h.engine.init()
    // 直接 startRepair 后再取 RED：只有真实失败回执才算。
    const record = await h.engine.startRepair({ symptom: 'x', scope: ['src/core/**'], verify: 'pnpm test' })
    h.runner.enqueue({ match: 'test', exitCode: 0, stdout: VITEST_PASS_STDOUT })
    const green = await h.engine.runVerify({ group: 'repro' })
    expect(green.phase).toBe('green')
    // 没有 RED 时 GREEN 不会被绑定（bindRepairEvidence 只认「已有 RED 后的 GREEN」）。
    expect(h.engine.getRepair()?.greenEvidenceId).toBeUndefined()
    expect(record.id).toBe(h.engine.getRepair()?.id)
  })
})
