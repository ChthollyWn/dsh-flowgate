/**
 * review 模块单测（03 §7 / §14，H12 / H20 / H24 / H25）：
 * - review.enabled=false 时 flow_task_done 跳过审查；
 * - provider 不可用 → ok:false 且原因可见；
 * - 结构化 verdict/findings 归一化 + diff 指纹记录；
 * - 启动失败自动重试 1 次：第 2 次成功可继续，两次都失败降级为 ok:false；
 * - sessionQuery 读取覆盖核对（实际读过/未读过的文件、降级路径）；
 * - 只读调查子 agent 的成功/无输出/不可用。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DshSubagentActivationSpec, DshSubagentResult } from '../../src/host/adapters/dsh-types.js'
import type { ChangeStatus, FlowgateConfig, ReviewRecord, TaskCard, TaskState } from '../../src/core/types.js'
import { flush, setupPlugin, type PluginHarness } from './helpers.js'
import { resetHostPluginForTest } from '../../src/host/index.js'
import {
  checkReadCoverage,
  REVIEW_OUTPUT_SCHEMA,
  reviewCapability,
  runFinalReview,
  runInvestigation,
  runTaskReview,
} from '../../src/host/review/index.js'
import {
  createFakeEngine,
  createFakeSessionQuery,
  createFakeSubagents,
  defaultFakeConfig,
  type FakeEngineState,
} from '../../src/host/testing/fake-ctx.js'
import { FLOWGATE_PRESETS } from '../../src/host/guard/delegation.js'
import { sha256Hex } from '../../src/core/util/hash.js'

type FakeSubagents = ReturnType<typeof createFakeSubagents>

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+export const x = 1\n'

let harness: PluginHarness | null = null

afterEach(async () => {
  await flush(4)
  if (harness) {
    await harness.cleanup()
    harness = null
  }
  resetHostPluginForTest()
})

async function start(options: Parameters<typeof setupPlugin>[0] = {}): Promise<PluginHarness> {
  harness = await setupPlugin(options)
  return harness
}

function engineState(engine: PluginHarness['engine']): FakeEngineState {
  return (engine as unknown as { state: FakeEngineState }).state
}

async function runTool(
  h: PluginHarness,
  name: string,
  args: Record<string, unknown>,
): Promise<{ value: { ok: boolean; summary: string; data?: Record<string, unknown> } }> {
  const tool = h.tools.state.tools.get(name)
  if (!tool) throw new Error(`tool ${name} 未注册`)
  const value = await tool.execute(args, {
    callId: `call-${name}`,
    name,
    arguments: args,
    agent: h.agent,
    signal: new AbortController().signal,
  } as never)
  return { value: value as { ok: boolean; summary: string; data?: Record<string, unknown> } }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'T1',
    title: '实现幂等',
    covers: [],
    scope: ['src/a.ts'],
    tests: [],
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'optional',
    verify: [],
    run: 'main',
    risk: [],
    size: 'S',
    body: '任务卡正文',
    ...overrides,
  }
}

function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return { id: 'T1', batch: 'B1', status: 'running', tdd: 'none', evidenceIds: [], reviewIds: [], ...overrides }
}

function makeChange(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    id: 'C-001',
    kind: 'change',
    title: '测试变更',
    complexity: 'low',
    risk: 'normal',
    stage: 'S4',
    lifecycle: 'active',
    gates: {},
    branch: 'main',
    batches: [],
    tasks: { T1: makeTaskState() },
    evidenceIds: [],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ChangeStatus
}

function makeEngine(options: { reviewEnabled?: boolean } = {}): PluginHarness['engine'] {
  const config = defaultFakeConfig() as unknown as FlowgateConfig
  config.review = { enabled: options.reviewEnabled !== false, requireForTaskGate: false }
  const engine = createFakeEngine({ config })
  const state = engineState(engine)
  state.current = makeChange()
  state.tasks = [makeTaskCard()]
  return engine
}

/** 用可控 diff 端口（审查输入 + 指纹来源）。 */
function withDiff(h: PluginHarness, diff = DIFF): void {
  const git = h.runtime.ports()?.git
  if (!git) throw new Error('fake deps 缺少 git 端口')
  git.diffText = async () => diff
}

function sessionQueryWith(filesBySession: Record<string, string[]>): unknown {
  const events: Record<string, unknown[]> = {}
  for (const [sessionId, files] of Object.entries(filesBySession)) {
    events[sessionId] = files.map((file) => ({ type: 'tool_result', data: { path: file } }))
  }
  return createFakeSessionQuery(events)
}

function subagentsReturning(result: DshSubagentResult, childId = 'child-review', onDispose?: () => void): FakeSubagents {
  return createFakeSubagents({
    start: async () => ({
      childId,
      result: Promise.resolve(result),
      dispose: async () => {
        onDispose?.()
      },
    }),
  })
}

function reviewResult(structured: unknown, stopReason = 'completed'): DshSubagentResult {
  return { output: [{ type: 'text', text: '审查结论' }], structured, stopReason }
}

function passStructured(overrides: Record<string, unknown> = {}): unknown {
  return { verdict: 'pass', summary: '通过', findings: [], readFiles: ['src/a.ts'], ...overrides }
}

function specAt(subagents: FakeSubagents, index: number): DshSubagentActivationSpec {
  return subagents.state.started[index] as DshSubagentActivationSpec
}

function promptText(spec: DshSubagentActivationSpec): string {
  return spec.request.prompt.map((block) => (block.type === 'text' ? String(block.text ?? '') : '')).join('\n')
}

// ---------------------------------------------------------------------------
// 审查开关与能力降级
// ---------------------------------------------------------------------------

describe('审查开关与能力检查', () => {
  it('review.enabled=false 时 flow_task_done 跳过审查（不启动子 agent）', async () => {
    const engine = makeEngine({ reviewEnabled: false })
    const subagents = createFakeSubagents()
    const h = await start({ engine, services: { subagents } })
    const { value } = await runTool(h, 'flow_task_done', { taskId: 'T1' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('任务 T1 通过（fake）')
    expect(value.summary).not.toContain('审查')
    expect(subagents.state.started.length).toBe(0)
    expect(engineState(engine).calls.taskDone).toEqual(['T1'])
    expect(engineState(engine).calls.recordReview).toEqual([])
  })

  it('provider 不可用时 runTaskReview 返回 ok:false 且原因可见', async () => {
    const h = await start({ engine: makeEngine(), services: { subagents: undefined } })
    expect(reviewCapability(h.runtime)).toMatchObject({
      available: false,
      reason: '宿主没有 ctx.subagents.startActivation',
    })
    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(false)
    expect(outcome.verdict).toBe('changes-required')
    expect(outcome.findings).toEqual([])
    expect(outcome.coverageOk).toBe(false)
    expect(outcome.message).toContain('审查子 agent 不可用')
    expect(outcome.message).toContain('ctx.subagents.startActivation')
  })

  it('有 subagents 服务但没有 provider 时同样降级且原因可见', async () => {
    const h = await start({ engine: makeEngine(), services: { subagents: createFakeSubagents({ providers: [] }) } })
    const capability = reviewCapability(h.runtime)
    expect(capability.available).toBe(false)
    expect(capability.reason).toContain('provider')
    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('没有可用的子 agent provider')
  })
})

// ---------------------------------------------------------------------------
// 结构化输出归一化
// ---------------------------------------------------------------------------

describe('结构化结论归一化', () => {
  it('归一化 verdict/findings（严重度兜底、丢弃无 message 项）并按 diff 指纹记录审查', async () => {
    const engine = makeEngine()
    const structured = {
      verdict: 'changes-required',
      summary: '发现一处空指针风险',
      findings: [
        { severity: 'critical', file: 'src/a.ts', line: 12, rule: 'null-safety', message: '空指针风险', suggestion: '加判空' },
        { severity: 'weird', file: 'src/a.ts', message: '严重度未知' },
        { file: 'src/a.ts', message: '缺 severity 字段' },
        { severity: 'major', message: '没有文件' },
        { severity: 'minor', file: 'src/a.ts', message: '' },
        { severity: 'minor' },
        'not-an-object',
        null,
      ],
      readFiles: ['src/a.ts'],
    }
    const subagents = subagentsReturning(reviewResult(structured), 'child-norm')
    const h = await start({
      engine,
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-norm': ['src/a.ts'] }) },
    })
    withDiff(h)

    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(true)
    expect(outcome.verdict).toBe('changes-required')

    expect(outcome.coverageOk).toBe(true)
    expect(outcome.message).toBe('审查完成：需要修改（4 条发现，第 1 次尝试）')
    expect(outcome.findings).toEqual([
      { severity: 'critical', file: 'src/a.ts', line: 12, rule: 'null-safety', message: '空指针风险', suggestion: '加判空' },
      { severity: 'minor', file: 'src/a.ts', rule: '审查', message: '严重度未知' },
      { severity: 'minor', file: 'src/a.ts', rule: '审查', message: '缺 severity 字段' },
      { severity: 'major', file: '', rule: '审查', message: '没有文件' },
    ])

    // 审查记录：kind/attempts/coverage + diff 指纹。
    const recorded = engineState(engine).calls.recordReview[0] as ReviewRecord
    expect(recorded).toMatchObject({
      taskId: 'T1',
      kind: 'task',
      verdict: 'changes-required',
      coverageOk: true,
      attempts: 1,
    })
    expect(recorded.findings).toEqual(outcome.findings)
    expect(recorded.diffFingerprint).toBe(sha256Hex(DIFF))

    // 只读取证子 agent 的启动规格。
    expect(subagents.state.started.length).toBe(1)
    const spec = specAt(subagents, 0)
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('flowgate-review-T1-1')
    expect(spec.delivery).toBe('caller')
    expect(spec.request.agentPreset).toBe(FLOWGATE_PRESETS.reviewer)
    expect(spec.request.outputSchema).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(spec.request.cwd).toBe('/fake/project')
    const prompt = promptText(spec)
    expect(prompt).toContain('实现幂等')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('改动 diff')
    expect(h.runtime.agentRoles.get('child-norm')?.role).toBe('reviewer')
  })
})

// ---------------------------------------------------------------------------
// 失败重试与降级
// ---------------------------------------------------------------------------

describe('启动失败重试与降级', () => {
  it('首次启动失败自动重试 1 次，第 2 次成功则继续（不消耗轮次）', async () => {
    const engine = makeEngine()
    let attempts = 0
    let disposed = 0
    const subagents = createFakeSubagents({
      start: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn 后端不可用')
        return {
          childId: 'child-retry',
          result: Promise.resolve(reviewResult(passStructured())),
          dispose: async () => {
            disposed += 1
          },
        }
      },
    })
    const h = await start({
      engine,
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-retry': ['src/a.ts'] }) },
    })
    withDiff(h)

    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(true)
    expect(outcome.verdict).toBe('pass')
    expect(outcome.message).toBe('审查完成：通过（0 条发现，第 2 次尝试）')
    expect(attempts).toBe(2)
    expect(subagents.state.started.length).toBe(2)
    expect(specAt(subagents, 0).label).toBe('flowgate-review-T1-1')
    expect(specAt(subagents, 1).label).toBe('flowgate-review-T1-2')
    expect(disposed).toBe(1)
    expect(engineState(engine).calls.recordReview[0]).toMatchObject({ attempts: 2, coverageOk: true, verdict: 'pass' })
    // 首次失败只记 doctor（不消耗轮次）。
    expect(h.runtime.featureNotes.review?.join('；')).toContain('第 1 次启动/执行失败（不消耗轮次）：spawn 后端不可用')
  })

  it('两次启动都失败时降级为 ok:false（任务门将标记审查缺失）', async () => {
    const engine = makeEngine()
    const subagents = createFakeSubagents({
      start: async () => {
        throw new Error('spawn 后端不可用')
      },
    })
    const h = await start({ engine, services: { subagents } })

    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(false)
    expect(outcome.verdict).toBe('changes-required')
    expect(outcome.findings).toEqual([])
    expect(outcome.coverageOk).toBe(false)
    expect(outcome.message).toContain('审查子 agent 启动失败（重试 1 次后仍失败）')
    expect(outcome.message).toContain('spawn 后端不可用')
    expect(subagents.state.started.length).toBe(2)
    expect(engineState(engine).calls.recordReview).toEqual([])
    const notes = h.runtime.featureNotes.review?.join('；') ?? ''
    expect(notes).toContain('第 1 次启动/执行失败')
    expect(notes).toContain('第 2 次启动/执行失败')
  })
})

// ---------------------------------------------------------------------------
// 读取覆盖核对（H24）
// ---------------------------------------------------------------------------

describe('读取覆盖核对', () => {
  it('实际读过/未读过的文件分别进入 readFiles 与 detail', async () => {
    const h = await start({
      services: { sessionQuery: sessionQueryWith({ 'child-read': ['src/a.ts'] }) },
    })
    const partial = await checkReadCoverage(h.runtime, 'child-read', ['src/a.ts', 'src/b.ts'])
    expect(partial.ok).toBe(false)
    expect(partial.readFiles).toEqual(['src/a.ts'])
    expect(partial.detail).toContain('未读到：src/b.ts')

    const covered = await checkReadCoverage(h.runtime, 'child-read', ['src/a.ts'])
    expect(covered.ok).toBe(true)
    expect(covered.readFiles).toEqual(['src/a.ts'])
    expect(covered.detail).toBeUndefined()
  })

  it('sessionQuery 不可用时降级为"只认结构化自述"并记录 doctor', async () => {
    const h = await start({ services: { sessionQuery: undefined } })
    const outcome = await checkReadCoverage(h.runtime, 'child-x', ['src/a.ts'])
    expect(outcome.ok).toBe(true)
    expect(outcome.readFiles).toEqual([])
    expect(outcome.detail).toContain('sessionQuery 不可用（已降级）')
    expect(h.runtime.featureNotes.review?.join('；')).toContain('sessionQuery')
  })

  it('必读文件为空时直接通过', async () => {
    const h = await start()
    const empty = await checkReadCoverage(h.runtime, 'child-x', [])
    expect(empty).toEqual({ ok: true, readFiles: [] })
  })

  it('读取子会话抛错时 ok:false 且原因可见', async () => {
    const h = await start({
      services: {
        sessionQuery: {
          async readSession() {
            throw new Error('会话存储不可用')
          },
        },
      },
    })
    const failed = await checkReadCoverage(h.runtime, 'child-x', ['src/a.ts'])
    expect(failed.ok).toBe(false)
    expect(failed.detail).toContain('读取子会话失败：会话存储不可用')
  })

  it('runTaskReview 在读取覆盖不足时返回 ok:false 并记录 coverageOk=false', async () => {
    const engine = makeEngine()
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-nocover')
    // 子会话事件里只有 src/b.ts：必读的 src/a.ts 没有被读到。
    const h = await start({
      engine,
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-nocover': ['src/b.ts'] }) },
    })
    withDiff(h)

    const outcome = await runTaskReview(h.runtime, 'T1')
    expect(outcome.ok).toBe(false)
    expect(outcome.coverageOk).toBe(false)
    expect(outcome.verdict).toBe('pass')
    expect(outcome.message).toContain('审查未能覆盖全部改动文件')
    expect(outcome.message).toContain('未读到：src/a.ts')
    expect(engineState(engine).calls.recordReview[0]).toMatchObject({ coverageOk: false, verdict: 'pass' })
  })
})

// ---------------------------------------------------------------------------
// 只读调查（flow_investigate 主体）
// ---------------------------------------------------------------------------

describe('只读调查子 agent', () => {
  it('返回报告文本并使用只读取证 preset', async () => {
    const subagents = subagentsReturning(
      { output: [{ type: 'text', text: '报告：缓存命中率低' }], stopReason: 'completed' },
      'child-inv',
    )
    const h = await start({ engine: makeEngine(), services: { subagents } })
    const outcome = await runInvestigation(h.runtime, { questions: ['为什么慢？'], benefit: '减少超时' })
    expect(outcome.ok).toBe(true)
    expect(outcome.report).toBe('报告：缓存命中率低')
    expect(outcome.message).toContain('调查完成')
    expect(outcome.message).toContain('耗时')
    expect(outcome.message).toContain('token：未知')
    const spec = specAt(subagents, 0)
    expect(spec.request.agentPreset).toBe(FLOWGATE_PRESETS.reviewer)
    expect(spec.delivery).toBe('caller')
    expect(spec.label).toContain('flowgate-investigate-')
    const prompt = promptText(spec)
    expect(prompt).toContain('为什么慢？')
    expect(prompt).toContain('减少超时')
    expect(h.runtime.agentRoles.get('child-inv')?.role).toBe('investigator')
  })

  it('子 agent 无文本输出时 ok:false', async () => {
    const subagents = subagentsReturning({ output: [], stopReason: 'completed' }, 'child-empty')
    const h = await start({ engine: makeEngine(), services: { subagents } })
    const outcome = await runInvestigation(h.runtime, { questions: ['q'], benefit: 'b' })
    expect(outcome.ok).toBe(false)
    expect(outcome.report).toBe('')
    expect(outcome.message).toContain('调查子 agent 没有输出报告')
  })

  it('provider 不可用时 ok:false 且原因可见', async () => {
    const h = await start({ engine: makeEngine(), services: { subagents: undefined } })
    const outcome = await runInvestigation(h.runtime, { questions: ['q'], benefit: 'b' })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('调查子 agent 不可用')
    expect(outcome.message).toContain('ctx.subagents.startActivation')
  })
})

describe('任务门审查轮次（高风险 2 轮）', () => {
  it('flow_task_done 按 requiredReviewRounds 补满 2 轮，不再 any-pass 短路', async () => {
    const engine = makeEngine()
    // 模拟高风险变更：任务门要求 2 轮审查。
    ;(engine as unknown as { requiredReviewRounds: () => number }).requiredReviewRounds = () => 2
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-rounds')
    const h = await start({ engine, services: { subagents, sessionQuery: sessionQueryWith({ 'child-rounds': ['src/a.ts'] }) } })
    withDiff(h)
    const { value } = await runTool(h, 'flow_task_done', { taskId: 'T1' })
    expect(value.ok).toBe(true)
    const records = engineState(engine).calls.recordReview as { kind?: string; taskId?: string }[]
    expect(records.filter((record) => record.kind === 'task' && record.taskId === 'T1')).toHaveLength(2)
  })

  it('已有 1 条 pass 时只补 1 轮（不重复满足 2 轮的审查）', async () => {
    const engine = makeEngine()
    ;(engine as unknown as { requiredReviewRounds: () => number }).requiredReviewRounds = () => 2
    const state = engineState(engine)
    state.current = {
      ...(state.current as Record<string, unknown>),
      reviews: [{ id: 'RV-1', changeId: 'C-001', taskId: 'T1', kind: 'task', verdict: 'pass', findings: [], coverageOk: true, diffFingerprint: '', createdAt: '1', attempts: 1 }],
    }
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-one-more')
    const h = await start({ engine, services: { subagents, sessionQuery: sessionQueryWith({ 'child-one-more': ['src/a.ts'] }) } })
    withDiff(h)
    const { value } = await runTool(h, 'flow_task_done', { taskId: 'T1' })
    expect(value.ok).toBe(true)
    const records = engineState(engine).calls.recordReview as { kind?: string }[]
    expect(records.filter((record) => record.kind === 'task')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// S5 终审 / 安全审查生产者（P0-5）
// ---------------------------------------------------------------------------

describe('S5 终审生产者', () => {
  function s5Engine(risk: 'normal' | 'high' = 'normal'): PluginHarness['engine'] {
    const engine = makeEngine()
    const state = engineState(engine)
    state.current = makeChange({
      stage: 'S5',
      risk,
      baseline: {
        commit: 'base-sha',
        summary: { parser: 'vitest', parsed: true, run: 1, passed: 1, failed: 0, skipped: 0 },
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    return engine
  }

  function recordedKinds(engine: PluginHarness['engine']): (string | undefined)[] {
    return (engineState(engine).calls.recordReview as { kind?: string }[]).map((record) => record.kind)
  }

  it('普通风险：登记 kind=final，提示词是整体终审', async () => {
    const engine = s5Engine('normal')
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-final')
    const h = await start({ engine, services: { subagents, sessionQuery: sessionQueryWith({ 'child-final': ['src/a.ts'] }) } })
    withDiff(h)

    const outcome = await runFinalReview(h.runtime)
    expect(outcome.ok).toBe(true)
    expect(outcome.verdict).toBe('pass')
    expect(recordedKinds(engine)).toEqual(['final'])
    const spec = specAt(subagents, 0)
    expect(spec.request.agentPreset).toBe(FLOWGATE_PRESETS.reviewer)
    expect(promptText(spec)).toContain('终审')
    expect(promptText(spec)).toContain('相对 S2 基线')
  })

  it('高风险：依次登记「规格符合 / 代码质量 / 安全」三份结论（T4.3）', async () => {
    const engine = s5Engine('high')
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-final-high')
    const h = await start({
      engine,
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-final-high': ['src/a.ts'] }) },
    })
    withDiff(h)

    const outcome = await runFinalReview(h.runtime)
    expect(outcome.ok).toBe(true)
    expect(recordedKinds(engine)).toEqual(['final', 'final', 'security'])
    expect(outcome.message).toContain('三份终审结论')
    expect(promptText(specAt(subagents, 0))).toContain('规格符合性')
    expect(promptText(specAt(subagents, 2))).toContain('安全与合规')
  })

  it('flow_submit G5 在 S5 自动先跑终审，再提交门禁', async () => {
    const engine = s5Engine('normal')
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-final-submit')
    const h = await start({
      engine,
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-final-submit': ['src/a.ts'] }) },
    })
    withDiff(h)

    const { value } = await runTool(h, 'flow_submit', { gate: 'G5' })
    expect(value.ok).toBe(true)
    expect(value.summary).toContain('终审：')
    expect(value.summary).toContain('已提交 G5（fake）')
    expect(value.data?.finalReview).toContain('通过')
    expect(recordedKinds(engine)).toEqual(['final'])
  })

  it('终审子 agent 不可用时 flow_submit G5 返回可执行提示（不写空记录）', async () => {
    const engine = s5Engine('normal')
    const h = await start({ engine, services: { subagents: undefined } })
    const { value } = await runTool(h, 'flow_submit', { gate: 'G5' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('S5 终审无法执行')
    expect(recordedKinds(engine)).toEqual([])
  })

  it('终审读取覆盖不足时 flow_submit G5 拒绝通过（不能带未覆盖终审走 G5）', async () => {
    const engine = s5Engine('normal')
    const subagents = subagentsReturning(reviewResult(passStructured()), 'child-final-nocov')
    const h = await start({
      engine,
      // 子会话里没有任何读取记录 → 覆盖核对失败。
      services: { subagents, sessionQuery: sessionQueryWith({ 'child-final-nocov': [] }) },
    })
    withDiff(h)

    const { value } = await runTool(h, 'flow_submit', { gate: 'G5' })
    expect(value.ok).toBe(false)
    expect(value.summary).toContain('S5 终审未覆盖全部改动')
    // 终审记录仍会落账（coverageOk=false），供 /flow status/报告查看。
    expect(recordedKinds(engine)).toEqual(['final'])
  })
})

describe('同一 diff 去重（T3.4）', () => {
    it('同一 diff 已审查通过时直接复用结论，不再启动子 agent（T3.4）', async () => {
      const engine = makeEngine()
      const state = engineState(engine)
      state.current = makeChange({
        reviews: [
          {
            id: 'RV-9',
            changeId: 'C-001',
            taskId: 'T1',
            kind: 'task',
            verdict: 'pass',
            findings: [],
            coverageOk: true,
            diffFingerprint: sha256Hex(DIFF),
            createdAt: '2026-01-01T00:00:00.000Z',
            attempts: 1,
          },
        ],
      })
      const subagents = subagentsReturning(reviewResult(passStructured()), 'child-dedupe')
      const h = await start({ engine, services: { subagents, sessionQuery: sessionQueryWith({ 'child-dedupe': ['src/a.ts'] }) } })
      withDiff(h)
      const outcome = await runTaskReview(h.runtime, 'T1')
      expect(outcome.ok).toBe(true)
      expect(outcome.message).toContain('复用')
      expect((subagents as unknown as { state: { started: unknown[] } }).state.started).toHaveLength(0)
    })
})

describe('调查并发上限（T4.10）', () => {
  it('默认最多 2 个并发调查子 agent', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const subagents = createFakeSubagents({
      start: async () => ({
        childId: 'child-inv',
        result: (async () => {
          await gate
          return {
            output: [{ type: 'text', text: '调查报告' }],
            structured: null,
            stopReason: 'completed',
          } as unknown as DshSubagentResult
        })(),
        dispose: async () => {},
      }),
    })
    const h = await start({ engine: makeEngine(), services: { subagents } })
    const first = runInvestigation(h.runtime, { questions: ['q1'], benefit: 'b' })
    const second = runInvestigation(h.runtime, { questions: ['q2'], benefit: 'b' })
    const third = await runInvestigation(h.runtime, { questions: ['q3'], benefit: 'b' })
    expect(third.ok).toBe(false)
    expect(third.message).toContain('最多 2 个')
    release()
    const results = await Promise.all([first, second])
    expect(results.every((result) => result.ok)).toBe(true)
  })
})
