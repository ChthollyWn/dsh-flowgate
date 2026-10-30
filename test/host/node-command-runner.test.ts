/**
 * CommandRunner 的超时语义（真机回归）。
 *
 * 2026-10-31 真机发现：`flow_verify` 执行 `spring-boot:start` 时，java 后代进程
 * 继承了 stdout/stderr；只 kill shell 会让管道一直打开，Node 的 'close' 永不触发，
 * 宿主在"超时"后仍然永久挂起。现在超时会终止整个进程组并强制在宽限期后返回。
 */
import { describe, expect, it } from 'vitest'
import { NodeCommandRunner } from '../../src/host/adapters/node-command-runner.js'

describe('host/node-command-runner', () => {
  it('returns stdout/stderr and exit code for normal commands', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run(`node -e "console.log('hello'); console.error('warn')"`, {
      cwd: process.cwd(),
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('hello')
    expect(result.stderr).toContain('warn')
  })

  it('force-returns on timeout even when a descendant keeps the pipes open', async () => {
    const runner = new NodeCommandRunner()
    const started = Date.now()
    // 父进程派生一个继承 stdio 的常驻子进程，模拟 mvn spring-boot:start。
    const script = [
      "const {spawn}=require('node:child_process')",
      "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'})",
      'setInterval(()=>{},1000)',
    ].join(';')
    const result = await runner.run(`node -e "${script}"`, { cwd: process.cwd(), timeoutMs: 400 })
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(124)
    // 400ms 超时 + 3s 宽限 + 0.5s 兜底；必须远小于"永远挂起"。
    expect(elapsed).toBeLessThan(9_000)
  }, 15_000)

  it('marks timedOut for a simple long-running command', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run(`node -e "setInterval(()=>{},1000)"`, { cwd: process.cwd(), timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(124)
  }, 10_000)
})
