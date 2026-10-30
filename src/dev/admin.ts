/**
 * Owner-side CLI for real-host E2E / recovery (dev tooling, not shipped).
 *
 * It drives the same FlowEngine the host plugin uses, against a real project
 * directory with real Node adapters — useful to run human-only actions
 * (approve/reject/level changes) from a script when the browser UI is not
 * available, e.g. headless E2E runs.
 *
 * Build: tsdown (tools/admin.js). Usage:
 *   node tools/admin.js <projectRoot> status
 *   node tools/admin.js <projectRoot> approve G1
 *   node tools/admin.js <projectRoot> reject G3 "plan missing rollback"
 *   node tools/admin.js <projectRoot> pending RK-1 approve "owner reason"
 *   node tools/admin.js <projectRoot> resume C-001
 *   node tools/admin.js <projectRoot> new "变更标题"
 *   node tools/admin.js <projectRoot> pause [--handoff]
 *   node tools/admin.js <projectRoot> doctor
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FlowEngine } from '../core/engine.js'
import { NodeFileSystem } from '../host/adapters/node-fs.js'
import { NodeGit } from '../host/adapters/node-git.js'
import { NodeCommandRunner } from '../host/adapters/node-command-runner.js'
import { systemClock } from '../core/util/fs.js'

const LEDGER_KEY_PATH = join(homedir(), '.dsh', 'flowgate', 'ledger.key')

async function createEngine(root: string): Promise<FlowEngine> {
  const fs = new NodeFileSystem(root)
  const ledgerKey = (await readFile(LEDGER_KEY_PATH, 'utf8')).trim()
  const git = new NodeGit()
  const runner = new NodeCommandRunner()
  const engine = new FlowEngine({
    root,
    fs,
    clock: systemClock,
    git,
    commandRunner: runner,
    pluginVersion: '0.1.0-dev',
    ledgerKey,
    sessionId: 'session-admin-cli',
    sessionLabel: 'admin-cli',
  })
  await engine.load()
  return engine
}

async function main(): Promise<void> {
  const [root, command, ...args] = process.argv.slice(2)
  if (!root || !command) {
    console.error('用法：node tools/admin.js <projectRoot> <status|approve|reject|doctor|pause>')
    process.exit(2)
  }
  const engine = await createEngine(root)
  try {
    await runCommand(engine, command, args)
  } finally {
    // Never leave a lease behind: these are short-lived owner sessions.
    await engine.releaseSession().catch(() => undefined)
  }
}

async function runCommand(engine: FlowEngine, command: string, args: string[]): Promise<void> {
  switch (command) {
    case 'status': {
      const snapshot = engine.snapshot()
      console.log(JSON.stringify({ snapshot, current: engine.currentChange()?.id ?? null, stage: engine.currentChange()?.stage ?? null }, null, 2))
      return
    }
    case 'approve': {
      const gate = args[0]
      if (!gate) throw new Error('approve 需要门编号，例如 G1')
      const result = await engine.approveGate(gate as never, { reason: args.slice(1).join(' ') || undefined })
      console.log(result.message)
      return
    }
    case 'reject': {
      const gate = args[0]
      const reason = args.slice(1).join(' ')
      if (!gate || reason === '') throw new Error('用法：reject <gate> <reason>')
      const result = await engine.rejectGate(gate as never, reason)
      console.log(result.message)
      return
    }
    case 'doctor': {
      const report = await engine.doctor()
      console.log(JSON.stringify(report, null, 2))
      return
    }
    case 'pending': {
      // Owner decision for pending items (risk takeover RK-n, scope change SC-n,
      // plan change PC-n, rule proposal RL-n). Used by headless E2E because the
      // model has no approve tools by design.
      const id = args[0]
      const decision = args[1]
      if (!id || (decision !== 'approve' && decision !== 'reject')) {
        throw new Error('用法：pending <RK-n|SC-n|PC-n|RL-n> approve|reject [理由]')
      }
      const item = await engine.decidePending(id, decision === 'approve' ? 'approved' : 'rejected', args.slice(2).join(' ') || undefined)
      console.log(`待处理项 ${item.id} 已${decision === 'approve' ? '批准' : '拒绝'}（${item.kind}）。`)
      return
    }
    case 'resume': {
      const id = args[0]
      if (!id) throw new Error('用法：resume <changeId>')
      await engine.resumeChange(id, { takeover: true })
      const current = engine.currentChange()
      console.log(`已接续 ${current?.id ?? id}（阶段 ${current?.stage ?? '?'}）`)
      return
    }
    case 'new': {
      const title = args.join(' ').trim()
      if (title === '') throw new Error('用法：new <标题>')
      const outcome = await engine.newChange({ title, summary: title })
      console.log(outcome.message ?? JSON.stringify(outcome))
      return
    }
    case 'pause-id': {
      const id = args[0]
      if (!id) throw new Error('用法：pause-id <changeId>')
      await engine.resumeChange(id, { takeover: true })
      const handoff = await engine.pauseChange()
      console.log(handoff.text)
      return
    }
    case 'pause': {
      const handoff = await engine.pauseChange()
      console.log(handoff.text)
      return
    }
    default:
      throw new Error(`未知命令：${command}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
