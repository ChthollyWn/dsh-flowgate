/**
 * 项目级（PROJECT / roadmap 阶段）变更的跨会话接续（T2.7 / 从 0 开发流程）。
 *
 * 真实事故（greenfield 演练 2026-10-31）：模型在会话 A 里 `flow_new_change({project:true})`
 * 创建 PROJECT、写完 project-clarify/roadmap 并提交 GR 后结束本轮；会话 B 打开时
 * `autoAttach` 把 PROJECT 排除在外，模型看到"没有进行中的变更"，负责人也无法在
 * 新会话里 `/flow approve GR`，GR 被静默搁置。
 *
 * 修复：`autoAttach` / `attachSession` 允许接续 PROJECT（lifecycle=active）。
 */
import { describe, expect, it } from 'vitest'

import { FlowEngine } from '../../src/core/engine'
import type { CheckOutcome } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { FakeClock, FakeCommandRunner, FakeGit, VITEST_PASS_STDOUT } from '../helpers/fakes'

const ROOT = ''
const ALL_PASS = async (): Promise<CheckOutcome[]> => []

interface Harness {
  fs: MemoryFileSystem
  clock: FakeClock
  engine: FlowEngine
}

function makeEngine(
  fs: MemoryFileSystem,
  clock: FakeClock,
  sessionId: string,
  git = new FakeGit(clock),
  runner = new FakeCommandRunner([{ match: 'test', exitCode: 0, stdout: VITEST_PASS_STDOUT }], clock),
): FlowEngine {
  return new FlowEngine({
    root: ROOT,
    fs,
    clock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0',
    ledgerKey: 'project-attach-key',
    sessionId,
    sessionLabel: sessionId,
    host: { gateChecker: ALL_PASS },
  })
}

async function createProjectSession(): Promise<Harness> {
  const fs = new MemoryFileSystem()
  await fs.writeFile('README.md', '# members\n')
  const clock = new FakeClock()
  const engine = makeEngine(fs, clock, 'session-a')
  await engine.load()
  await engine.init()
  await engine.newChange({ project: true, title: '会员管理系统 v1', summary: '能登录、能跑起来' })
  return { fs, clock, engine }
}

describe('PROJECT（roadmap）变更的会话接续', () => {
  it('会话 A 创建 PROJECT 后结束；会话 B 加载时自动接续到 PROJECT', async () => {
    const h = await createProjectSession()
    expect(h.engine.currentChange()?.id).toBe('PROJECT')
    await h.engine.releaseSession()

    const sessionB = makeEngine(h.fs, h.clock, 'session-b')
    await sessionB.load()
    const current = sessionB.currentChange()
    expect(current?.id).toBe('PROJECT')
    expect(current?.stage).toBe('roadmap')
    const snapshot = sessionB.snapshot()
    expect(snapshot.changeId).toBe('PROJECT')
    expect(snapshot.stage).toBe('roadmap')
    expect(snapshot.statusLine).toContain('路线图')
  })

  it('显式 attachSession 也能接续 PROJECT', async () => {
    const h = await createProjectSession()
    await h.engine.releaseSession()

    const sessionB = makeEngine(h.fs, h.clock, 'session-b')
    await sessionB.load()
    await sessionB.releaseSession()
    const snapshot = await sessionB.attachSession('session-b')
    expect(snapshot.changeId).toBe('PROJECT')
    expect(sessionB.currentChange()?.id).toBe('PROJECT')
  })

  it('GR 批准后 PROJECT 归档：status.json 记录 archived，新会话不再接续', async () => {
    const h = await createProjectSession()
    const submitted = await h.engine.submitGate('GR')
    expect(submitted.awaiting).toBe('owner')
    const approved = await h.engine.approveGate('GR')
    expect(approved.passed).toBe(true)
    // GR 批准后清空 current：PROJECT 已归档，下一步是从路线图立项 C0。
    expect(h.engine.currentChange()).toBeNull()
    const disk = JSON.parse(await h.fs.readFile('.flowgate/changes/PROJECT/status.json')) as {
      lifecycle?: string
      gates?: Record<string, { state?: string }>
    }
    expect(disk.lifecycle).toBe('archived')
    expect(disk.gates?.GR?.state).toBe('passed')

    const sessionB = makeEngine(h.fs, h.clock, 'session-b')
    await sessionB.load()
    expect(sessionB.currentChange()).toBeNull()
  })

  it('PROJECT 存档（GR 批准）后不再自动接续，也不会挡住普通变更', async () => {
    const h = await createProjectSession()
    await h.engine.releaseSession()

    // 模拟隔离进程：直接把 PROJECT 标成 archived（与 approveGate('GR') 的收尾一致）。
    const statusPath = '.flowgate/changes/PROJECT/status.json'
    const raw = JSON.parse(await h.fs.readFile(statusPath)) as Record<string, unknown>
    raw.lifecycle = 'archived'
    await h.fs.writeFile(statusPath, `${JSON.stringify(raw, null, 2)}\n`)

    const sessionB = makeEngine(h.fs, h.clock, 'session-b')
    await sessionB.load()
    expect(sessionB.currentChange()).toBeNull()
    expect(sessionB.snapshot().changeId).toBeUndefined()
  })
})
