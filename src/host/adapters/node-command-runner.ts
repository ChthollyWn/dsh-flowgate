/**
 * `CommandRunner` 端口的 Node 实现（core/types.ts CommandRunner）。
 *
 * core 的 `runVerifyGroup` 只传一条命令字符串（`mvn -B test`、`./mvnw test` 等），
 * 因此这里交给平台 shell 执行；超时后先 SIGTERM，宽限期后再 SIGKILL，
 * 并把 `timedOut` 如实标记（回执据此拒绝把超时当 GREEN）。
 *
 * 输出上限 8MB，超过后丢弃尾部并追加说明——证据日志本身在 core 侧还会再截断
 * 到 2MB（evidence/run.ts MAX_EVIDENCE_LOG_CHARS），这里只防止进程内存被撑爆。
 */
import type { CommandResult, CommandRunner, CommandRunOptions } from '../../core/types'
import { spawn } from 'node:child_process'

const MAX_OUTPUT_CHARS = 8 * 1024 * 1024
const KILL_GRACE_MS = 3_000

export interface RunCommandOptions extends CommandRunOptions {
  /** 额外注入的环境变量（验证命令常需要 CI=true 等）。 */
  extraEnv?: Record<string, string>
}

/**
 * 终止一个（可能已经派生了子进程树的）shell。
 *
 * POSIX 上以 `detached: true` 启动，shell 自己是进程组 leader；只 kill shell
 * 会让 `mvn spring-boot:start` 派生出的 java 子进程继续持有 stdout/stderr 管道，
 * Node 的 'close' 事件因此永远不触发（2026-10-31 真机发现：flow_verify 超时后
 * 宿主线卡住 10 分钟以上）。所以这里对**进程组**发信号。
 */
function terminate(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      // Windows 没有进程组信号；taskkill /T 才能带走 shell 派生的子进程。
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
        }
      }, KILL_GRACE_MS).unref?.()
    }
  } catch {
    // 进程可能已退出。
  }
}

export class NodeCommandRunner implements CommandRunner {
  async run(command: string, options: CommandRunOptions): Promise<CommandResult> {
    const startedAt = Date.now()
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000
    return new Promise<CommandResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      const child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        // POSIX：创建独立进程组，超时时可以整组终止（见 terminate）。
        detached: process.platform !== 'win32',
        env: { ...process.env, ...options.env, ...(process.platform === 'win32' ? {} : {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stdout.length >= MAX_OUTPUT_CHARS) stdout += '\n…（stdout 超过 8MB，已截断）\n'
        if (stderr.length >= MAX_OUTPUT_CHARS) stderr += '\n…（stderr 超过 8MB，已截断）\n'
        resolve({ exitCode, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
      }

      const timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        terminate(child)
        // 兜底：即使残留后代仍持有管道，也要在宽限期后强制返回，绝不让调用方
        // 永久挂起（管道 destroy 解除 'close' 依赖）。
        setTimeout(() => {
          try {
            child.stdout?.destroy()
            child.stderr?.destroy()
          } catch {
            // 忽略。
          }
          finish(124)
        }, KILL_GRACE_MS + 500).unref?.()
      }, timeoutMs)
      timer.unref?.()

      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const text = String(chunk)
        const current = target === 'stdout' ? stdout : stderr
        if (current.length >= MAX_OUTPUT_CHARS) return
        const room = MAX_OUTPUT_CHARS - current.length
        const slice = text.length > room ? text.slice(0, room) : text
        if (target === 'stdout') stdout += slice
        else stderr += slice
      }

      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk))
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk))

      child.on('error', (error) => {
        stderr += `${stderr === '' ? '' : '\n'}[CommandRunner] 启动命令失败：${error.message}`
        finish(127)
      })
      child.on('close', (code) => finish(timedOut ? 124 : (code ?? 1)))
    })
  }
}
