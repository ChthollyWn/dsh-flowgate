/**
 * 路线图批准后"第一个变更必须从路线图立项"（T2.7 / 从 0 开发流程）。
 *
 * 真实事故（greenfield 演练 2026-10-31 第四轮）：GR 批准后模型在新会话里用
 * `flow_new_change({ title })`（没有 fromRoadmap）直接立项 C-001；于是 C-001 不是
 * 路线图 C0，`isSkeletonChange` 判 false，G2 的 `project.md 命令可执行` 要求真实
 * build/lint/test 命令，而 `.flowgate/project.md` 受 R-PROTECTED 保护不能由 agent 改
 * → S2 死锁。修复：GR 批准后、还没有任何非 PROJECT 变更时，强制从路线图立项；
 * 注入文本与 nextStep 明确给出 `flow_new_change({ fromRoadmap: "C0" })`。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

const CLARIFY = `# 项目级澄清：会员管理系统

## 目标用户与目标
- 目标用户：门店店长；目标：管理会员与续费。

## 核心流程
- 登录 → 建会员 → 续费 → 到期提醒。

## MVP 边界（做 / 不做）
- 做：会员、续费。
- 不做：报表、营销自动化。

## 技术栈与部署
- Node.js 20+ 标准库，单机部署。

## 非功能要求
- 登录 p95 < 500ms。

## 约束与未知项
- 未知：支付渠道未定。
`

const ROADMAP = `# 路线图：会员管理系统

MVP 切线：C0–C1 在切线内。

| 变更 | 能力 | 一句话目标 | 验收要点 | 依赖 | 预计任务数 | MVP | 状态 |
|---|---|---|---|---|---|---|---|
| C0 | 工程骨架 | 能构建、能跑测试 | 测试框架跑通 1 个冒烟测试 | — | 4 | 是 | 未开始 |
| C1 | 会员 | 开通与查询会员 | 开通/查询/失败三类场景 | C0 | 8 | 是 | 未开始 |
`

async function projectWithApprovedRoadmap(): Promise<{ engine: FlowEngine; fs: MemoryFileSystem }> {
  const clock = new FakeClock()
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# empty repo\n')
  const engine = new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git: new FakeGit(clock),
    commandRunner: new FakeCommandRunner([], clock),
    pluginVersion: '0.1.0',
    ledgerKey: 'roadmap-first-change-key',
    sessionId: 'session-a',
    host: { gateChecker: ALL_PASS },
  })
  await engine.load()
  await engine.init()
  await engine.newChange({ title: '会员管理系统', project: true })
  await fs.writeFile('.flowgate/project-clarify.md', CLARIFY)
  await fs.writeFile('.flowgate/roadmap.md', ROADMAP)
  const gr = await engine.submitGate('GR')
  expect(gr.awaiting).toBe('owner')
  await engine.approveGate('GR')
  return { engine, fs }
}

describe('路线图批准后的第一个变更必须从路线图立项', () => {
  it('无 fromRoadmap 立项被拒绝，并给出 flow_new_change({ fromRoadmap: "C0" }) 提示', async () => {
    const { engine } = await projectWithApprovedRoadmap()
    const error = await engine.newChange({ title: '随便一个变更', summary: '绕过路线图' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/第一个变更必须从路线图立项（C0）/)
    // hint 给出可执行的工具调用（FlowGateError 的 hint 是第二个参数）。
    expect(String((error as { hint?: string }).hint)).toContain('fromRoadmap: "C0"')
    // 没有创建任何非 PROJECT 变更。
    expect(engine.allChanges().filter((change) => change.id !== 'PROJECT')).toHaveLength(0)
  })

  it('注入文本与 nextStep 给出从路线图立项的明确工具调用', async () => {
    const { engine } = await projectWithApprovedRoadmap()
    const injection = engine.buildInjection()
    expect(injection.text).toContain('flow_new_change({ fromRoadmap: "C0" })')
    const snapshot = engine.snapshot()
    expect(snapshot.nextStep).toContain('fromRoadmap: "C0"')
    expect(snapshot.changeId).toBeUndefined()
  })

  it('按 fromRoadmap 立项成功，并继承路线图目标 / roadmap 归属', async () => {
    const { engine } = await projectWithApprovedRoadmap()
    const created = await engine.newChange({ title: 'ignored', summary: 'ignored', fromRoadmap: 'C0' })
    expect(created.changeId).toBe('C-001')
    const current = engine.currentChange()
    expect(current?.title).toBe('能构建、能跑测试')
    expect(current?.roadmap).toBe('C0')
    expect(current?.stage).toBe('S1')
  })

  it('已有第一个变更后，允许后续无 fromRoadmap 的临时变更', async () => {
    const { engine } = await projectWithApprovedRoadmap()
    await engine.newChange({ title: 'ignored', summary: 'ignored', fromRoadmap: 'C0' })
    // 先把 C0 暂停，模拟后面再开一个不在路线图里的临时变更。
    await engine.pauseChange()
    const second = await engine.newChange({ title: '临时修复', summary: '路线图外的紧急修复' })
    expect(second.changeId).toBe('C-002')
  })
})
