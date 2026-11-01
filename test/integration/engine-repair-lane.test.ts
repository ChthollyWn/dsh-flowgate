/**
 * 修复通道端到端（v0.5.1）：一次声明（scope + verify）→ 范围内自由迭代 →
 * RED→GREEN 证据关门 → 自动落审计记录。修复是一等公民：不立项、不跑七阶段、
 * 不逐动作等人工；finish 前置失败时保持 open，不误清现场。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine, FlowGateError } from '../../src/core/engine'
import type { ChangeStatus, CheckOutcome } from '../../src/core/types'
import type { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { createSandbox, VITEST_PASS_STDOUT, type FakeCommandRunner, type FakeGit, type FakeClock } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

const FAIL_STDOUT = [
  ' RUN  v2.1.0 /repo',
  '',
  ' ❯ tests/renewal.test.ts (3 tests | 1 failed) 18ms',
  '   × duplicate callback is ignored 3ms',
  '     → expected 2026-12-01 to be 2026-12-31',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 2 passed (3)',
  '   Start at  10:00:00',
  '',
].join('\n')

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  git: FakeGit
  runner: FakeCommandRunner
  engine: FlowEngine
}

async function harness(options: { git?: boolean } = {}): Promise<Harness> {
  const sandbox = createSandbox({ git: options.git })
  const engine = new FlowEngine({
    root: ROOT,
    fs: sandbox.fs,
    clock: sandbox.clock,
    git: options.git === false ? undefined : sandbox.git,
    commandRunner: sandbox.runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'repair-key',
    sessionId: 'session-repair',
    sessionLabel: 'repair',
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

async function startRepair(h: Harness, overrides: Record<string, unknown> = {}) {
  await h.engine.init()
  return h.engine.startRepair({
    title: '修复新建会话失败',
    symptom: '新建会话返回 500（会话投影 lossless JSON 校验失败）',
    repro: '新建任意会话',
    scope: ['src/index.ts', 'test/index.test.ts'],
    verify: 'pnpm test',
    acceptance: ['新建会话成功'],
    severity: 'P0',
    ...overrides,
  })
}

/** RED → GREEN：两次 flow_verify 生成回执并自动绑定。 */
async function redGreen(h: Harness): Promise<{ red: string; green: string }> {
  h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
  const red = await h.engine.runVerify({ group: 'repair' })
  expect(red.phase).toBe('red')
  const green = await h.engine.runVerify({ group: 'repair' })
  expect(green.phase).toBe('green')
  return { red: red.id, green: green.id }
}

describe('修复通道：端到端', () => {
  it('start → 范围内 allow / 范围外 deny / 受保护 deny / shell allow&deny → RED → GREEN → finish 写记录', async () => {
    const h = await harness()
    const record = await startRepair(h)
    expect(record.id).toMatch(/^FIX-\d{8}-\d{6}$/)
    expect(record.status).toBe('open')
    expect(h.engine.getRepair()?.id).toBe(record.id)
    // 快照可见：面板/状态条能显示修复进度。
    const snapshot = h.engine.snapshot()
    expect(snapshot.repair).toMatchObject({ id: record.id, red: false, green: false, severity: 'P0', actions: 0 })
    expect(snapshot.nextStep).toContain('RED')
    expect(snapshot.statusLine).toContain('修复')
    expect(h.engine.buildInjection().text).toContain('修复通道')
    const started = await ledgerTypes(h.fs)
    expect(started).toContain('repair.started')

    // 范围内写：allow 且 actions 计数。
    const inside = await h.engine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'src/index.ts' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(inside.effect).toBe('allow')
    expect(h.engine.getRepair()?.actions).toBe(1)
    // 范围外写：R-FIX-SCOPE deny。
    const outside = await h.engine.evaluateAction(
      { kind: 'write', tool: 'write', path: 'docs/readme.md' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(outside.effect).toBe('deny')
    expect(outside.rule?.ruleId).toBe('R-FIX-SCOPE')
    expect(outside.rule?.unlock).toContain('scope')
    // 受保护路径：R-PROTECTED deny（即使 scope 写的是 .flowgate）。
    const protectedWrite = await h.engine.evaluateAction(
      { kind: 'write', tool: 'write', path: '.flowgate/state/ledger.jsonl' },
      { tool: 'write', agentRole: 'main' },
    )
    expect(protectedWrite.effect).toBe('deny')
    expect(protectedWrite.rule?.ruleId).toBe('R-PROTECTED')

    // shell：测试/构建/只读/提交放行，危险命令拒绝。
    const allowedShells = ['pnpm test', 'pnpm build', 'pnpm lint', 'pnpm typecheck', 'git status --short', 'git add src/index.ts', 'git commit -m "wip"']
    for (const command of allowedShells) {
      const decision = await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command }, { tool: 'bash', agentRole: 'main' })
      expect(decision.effect, command).toBe('allow')
    }
    const deniedShells = ['rm -rf /', 'git push origin main', 'git reset --hard', 'curl https://example.com']
    for (const command of deniedShells) {
      const decision = await h.engine.evaluateAction({ kind: 'shell', tool: 'bash', command }, { tool: 'bash', agentRole: 'main' })
      expect(decision.effect, command).toBe('deny')
      expect(decision.rule?.ruleId, command).toBe('R-FIX-SHELL')
    }
    // delegate / mcp 在修复通道内关闭。
    expect((await h.engine.evaluateAction({ kind: 'delegate', tool: 'task' }, { tool: 'task', agentRole: 'main' })).effect).toBe('deny')
    expect((await h.engine.evaluateAction({ kind: 'mcp', tool: 'mcp__demo__write' }, { tool: 'mcp__demo__write', agentRole: 'main' })).effect).toBe('deny')

    // RED → GREEN。
    const { red, green } = await redGreen(h)
    expect(h.engine.getRepair()).toMatchObject({ redEvidenceId: red, greenEvidenceId: green })
    const withEvidence = h.engine.snapshot().repair
    expect(withEvidence?.red).toBe(true)
    expect(withEvidence?.green).toBe(true)
    expect(await ledgerTypes(h.fs)).toContain('repair.evidence')

    // finish：改动文件在 scope 内，回归 + 重新 verify 都通过。
    h.git.setChangedFiles(['src/index.ts', 'test/index.test.ts'])
    const outcome = await h.engine.finishRepair({ summary: '会话投影 JSON 清洗已完成' })
    expect(outcome.record.status).toBe('done')
    expect(outcome.record.redEvidenceId).toBe(red)
    expect(outcome.record.greenEvidenceId).toBeDefined()
    expect(outcome.record.regressionEvidenceId).toBeDefined()
    expect(outcome.record.changedFiles).toEqual(['src/index.ts', 'test/index.test.ts'])
    expect(outcome.record.commit).toBe('abc1234')
    expect(outcome.message).toContain('修复完成')
    expect(outcome.message).toContain(red)
    expect(outcome.message).toContain('建议提交信息')
    expect(outcome.message).toContain('fix: 修复新建会话失败')

    // 落审计：fixes/<id>.json + index.md；active repair 清空；snapshot.repair 消失。
    const files = h.fs.listFiles()
    expect(files).toContain(`.flowgate/fixes/${record.id}.json`)
    expect(files).toContain('.flowgate/fixes/index.md')
    await expect(h.fs.exists('.flowgate/state/repair.json')).resolves.toBe(false)
    expect(h.engine.getRepair()).toBeNull()
    expect(h.engine.snapshot().repair).toBeUndefined()
    const index = await h.fs.readFile('.flowgate/fixes/index.md')
    expect(index).toContain(record.id)
    const saved = JSON.parse(await h.fs.readFile(`.flowgate/fixes/${record.id}.json`)) as Record<string, unknown>
    expect(saved['status']).toBe('done')
    expect(saved['regressionEvidenceId']).toBeDefined()
    const types = await ledgerTypes(h.fs)
    expect(types).toContain('repair.done')
  })

  it('runVerify 修复回执结构不变但 changeId = FIX-id（host 无需特殊处理）', async () => {
    const h = await harness()
    const record = await startRepair(h)
    h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
    const receipt = await h.engine.runVerify({ group: 'repair' })
    expect(receipt.changeId).toBe(record.id)
    expect(receipt).toMatchObject({ group: 'repair', kind: 'test', phase: 'red', runBy: 'flowgate' })
    expect(receipt.inputsHash).not.toBe('')
    expect(receipt.outputRef).toMatch(/^\.flowgate\/state\/evidence\//)
    // 回执写入证据索引，host 的 flow_verify 返回结构不需要变化。
    await expect(h.fs.exists('.flowgate/state/evidence/index.jsonl')).resolves.toBe(true)
  })
})

describe('修复通道：finish 前置失败保持 open', () => {
  it('缺 RED / 缺 GREEN 时拒绝且不清空修复', async () => {
    const h = await harness()
    await startRepair(h)
    await expect(h.engine.finishRepair()).rejects.toThrow('RED')
    expect(h.engine.getRepair()).not.toBeNull()
    await expect(h.fs.exists('.flowgate/state/repair.json')).resolves.toBe(true)
    await expect(h.engine.finishRepair()).rejects.toBeInstanceOf(FlowGateError)

    // 只有 RED（失败回执）时仍拒绝。
    h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
    await h.engine.runVerify({ group: 'repair' })
    await expect(h.engine.finishRepair()).rejects.toThrow('GREEN')
    expect(h.engine.getRepair()).not.toBeNull()
    // 不能留下 fixes 记录。
    expect(h.fs.listFiles().some((file) => file.startsWith('.flowgate/fixes/'))).toBe(false)
  })

  it('改动文件超出 scope 时拒绝并提示，修复保持 open', async () => {
    const h = await harness()
    await startRepair(h)
    await redGreen(h)
    h.git.setChangedFiles(['src/index.ts', 'docs/unexpected.md'])
    await expect(h.engine.finishRepair()).rejects.toThrow('超出声明范围')
    expect(h.engine.getRepair()).not.toBeNull()
    expect(h.engine.getRepair()?.status).toBe('open')
  })

  it('全量回归失败时拒绝，修复保持 open', async () => {
    const h = await harness()
    await startRepair(h)
    await redGreen(h)
    h.git.setChangedFiles(['src/index.ts'])
    // finish 的第一个命令是全量回归（npm test）。
    h.runner.enqueue({ match: 'npm test', exitCode: 1, stdout: FAIL_STDOUT })
    await expect(h.engine.finishRepair()).rejects.toThrow('全量回归失败')
    expect(h.engine.getRepair()).not.toBeNull()
  })

  it('重新运行声明的 verify 未通过时拒绝，修复保持 open', async () => {
    const h = await harness()
    await startRepair(h)
    await redGreen(h)
    h.git.setChangedFiles(['src/index.ts'])
    // 第一个 queued = 回归通过（需要可解析的通过输出），第二个 = 重新 verify 失败。
    h.runner.enqueue({ match: 'npm test', exitCode: 0, stdout: VITEST_PASS_STDOUT })
    h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
    await expect(h.engine.finishRepair()).rejects.toThrow('重新运行验证命令未通过')
    expect(h.engine.getRepair()).not.toBeNull()
  })

  it('无法收集改动文件时记 unknown 并继续（不误杀）', async () => {
    const h = await harness({ git: false })
    // 准入会先采集一次工作区信号：让 git status 失败（模拟无法收集），确认不误杀。
    h.runner.enqueue({ match: 'git status', exitCode: 1, stdout: '' })
    await startRepair(h)
    await redGreen(h)
    // git status 失败 → collected = null。
    h.runner.enqueue({ match: 'git status', exitCode: 1, stdout: '' })
    const outcome = await h.engine.finishRepair()
    expect(outcome.record.status).toBe('done')
    expect(outcome.record.changedFiles).toBeUndefined()
    expect(outcome.message).toContain('未收集到改动文件')
  })
})

describe('修复通道：abort 与准入校验', () => {
  it('abortRepair 记录 aborted + 理由 + 账本并清空 active', async () => {
    const h = await harness()
    const record = await startRepair(h)
    const aborted = await h.engine.abortRepair('根因在另一个模块，需要立项大改')
    expect(aborted.id).toBe(record.id)
    expect(aborted.status).toBe('aborted')
    expect(aborted.abortReason).toContain('另一个模块')
    expect(aborted.closedAt).toBeDefined()
    expect(h.engine.getRepair()).toBeNull()
    await expect(h.fs.exists('.flowgate/state/repair.json')).resolves.toBe(false)
    const saved = JSON.parse(await h.fs.readFile(`.flowgate/fixes/${record.id}.json`)) as Record<string, unknown>
    expect(saved['status']).toBe('aborted')
    expect((await ledgerTypes(h.fs))).toContain('repair.aborted')
    // 中止后可以重新开修复。
    const next = await h.engine.startRepair({
      title: '重新修复',
      symptom: '同一症状',
      scope: ['src/index.ts'],
      verify: 'pnpm test',
    })
    expect(next.id).not.toBe(record.id)
  })

  it('智能准入校验：活动变更 / 重复修复 / 省略字段 / 过宽 scope / 非法 verify', async () => {
    // 有进行中的变更时拒绝（修 bug 与七阶段变更互斥），并推荐变更内返工。
    const busy = await harness()
    await busy.engine.init()
    await busy.engine.newChange({ title: '会员续费', summary: '给会员加续费功能' })
    await expect(
      busy.engine.startRepair({ title: 'x', symptom: 'y', scope: ['src/index.ts'], verify: 'pnpm test' }),
    ).rejects.toThrow('修复准入未通过')
    await expect(
      busy.engine.startRepair({ title: 'x', symptom: 'y', scope: ['src/index.ts'], verify: 'pnpm test' }),
    ).rejects.toThrow('进行中的变更')

    // 无活动变更时正常开始；重复开始拒绝。
    const h = await harness()
    await h.engine.init()
    const record = await h.engine.startRepair({
      title: '修复 A',
      symptom: '症状',
      scope: ['src/index.ts'],
      verify: 'pnpm test',
    })
    const rejected = h.engine.startRepair({ title: '修复 B', symptom: '症状', scope: ['src/index.ts'], verify: 'pnpm test' })
    await expect(rejected).rejects.toThrow('修复准入未通过')
    await expect(rejected).rejects.toThrow('已有进行中的修复')

    await h.engine.abortRepair('测试用')

    // 标题可省略：准入从 symptom 推导标题。
    const derived = await h.engine.startRepair({ symptom: '症状：重复扣款', scope: ['src/index.ts'], verify: 'pnpm test' })
    expect(derived.title).toContain('重复扣款')
    expect(derived.admission?.verdict).toBe('adjusted')
    await h.engine.abortRepair('测试用')

    // 省略 scope 且没有任何信号 → 准入拒绝（不产生半开启修复）。
    const noScope = h.engine.startRepair({ title: 't', symptom: 's', verify: 'pnpm test' })
    await expect(noScope).rejects.toThrow('修复准入未通过')
    await expect(noScope).rejects.toThrow('scope')
    expect(h.engine.getRepair()).toBeNull()

    // scope 过宽 → 准入拒绝并推荐变更车道。
    const tooBroad = h.engine.startRepair({ title: 't', symptom: 's', scope: ['src/**'], verify: 'pnpm test' })
    await expect(tooBroad).rejects.toThrow('修复准入未通过')
    await expect(tooBroad).rejects.toThrow('过宽')

    // 条数上限。
    await expect(
      h.engine.startRepair({
        title: 't',
        symptom: 's',
        scope: Array.from({ length: 21 }, (_, i) => `src/core/f${i}.ts`),
        verify: 'pnpm test',
      }),
    ).rejects.toThrow('上限')

    // 非法 verify。
    await expect(
      h.engine.startRepair({ title: 't', symptom: 's', scope: ['src/index.ts'], verify: 'pnpm test && rm -rf /' }),
    ).rejects.toThrow('验证命令不合法')
    expect(record.id).toMatch(/^FIX-/)
  })

  it('修复通道打开时 flow_new_change 被拒绝（修 bug 不需要立项）', async () => {
    const h = await harness()
    await startRepair(h)
    await expect(h.engine.newChange({ title: '新功能', summary: '想加个功能' })).rejects.toThrow('修复通道')
    // 完成后恢复立项能力。
    h.runner.enqueue({ match: 'test', exitCode: 1, stdout: FAIL_STDOUT })
    await h.engine.runVerify({ group: 'repair' })
    await h.engine.runVerify({ group: 'repair' })
    h.git.setChangedFiles(['src/index.ts'])
    await h.engine.finishRepair()
    await expect(h.engine.newChange({ title: '新功能', summary: '想加个功能' })).resolves.toBeDefined()
  })
})

describe('修复通道：回归与快照细节', () => {
  it('无全量测试命令时 finish 跳过回归并在报告里写明', async () => {
    const h = await harness()
    // 改掉项目测试脚本后再 init：探测不到 commands.test。
    await h.fs.writeFile('package.json', JSON.stringify({ name: 'demo', scripts: { build: 'tsc' } }))
    await startRepair(h)
    await redGreen(h)
    h.git.setChangedFiles(['src/index.ts'])
    const outcome = await h.engine.finishRepair()
    expect(outcome.record.status).toBe('done')
    expect(outcome.record.regressionEvidenceId).toBeUndefined()
    expect(outcome.message).toContain('未配置全量测试命令')
  })

  it('getProjectFlags / getRepair 返回副本，外部修改不影响引擎', async () => {
    const h = await harness()
    const record = await startRepair(h)
    const first = h.engine.getRepair()!
    first.scope.push('hacked/**')
    expect(h.engine.getRepair()?.scope).not.toContain('hacked/**')
    expect(record.scope).toEqual(['src/index.ts', 'test/index.test.ts'])
    expect(h.engine.getProjectFlags()).toEqual({})
  })
})

/** 类型守卫：确保 currentChange 返回 ChangeStatus | null（测试里只做存在性断言）。 */
export type _RepairLaneChange = ChangeStatus
