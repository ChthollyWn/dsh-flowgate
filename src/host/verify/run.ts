/**
 * S5 运行证据执行器（T4.2 验收 #2 / 03 §7.2）：
 *
 * 配置了 `commands.run` 时，由宿主（不是模型）启动服务、轮询 `commands.health`、
 * 采集日志摘要，结束后杀掉整个进程组，并把结果登记成 kind='run' 的证据回执。
 * G5 的 `g5.runtime` 检查读这条回执。
 *
 * 边界：
 * - 不联网（只访问配置的 health URL，通常是 localhost）；
 * - 超时/失败也登记失败回执，如实说明原因，不伪造通过；
 * - 已有绿色运行回执时直接复用，避免每次重试 G5 都重启服务。
 */
import { spawn } from 'node:child_process'
import * as nodePath from 'node:path'
import type { HostRuntime } from '../runtime.js'

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_POLL_MS = 500
const START_GRACE_MS = 3_000
const MAX_LOG_CHARS = 64_000

export interface RuntimeEvidenceOutcome {
  /** 没配置 run 命令时不尝试执行。 */
  attempted: boolean
  ok: boolean
  message: string
  receiptId?: string
}

/** health 配置是 URL（http/https）还是命令。 */
export function isHealthUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** 保留头尾的日志摘要（给回执 notes / 注入文本用）。 */
export function summarizeRunLog(text: string, maxChars = 1_500): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const head = trimmed.slice(0, Math.floor(maxChars / 2))
  const tail = trimmed.slice(-Math.floor(maxChars / 2))
  return `${head}\n…（日志已截断，全文见 .flowgate/state/evidence/）…\n${tail}`
}

interface HealthResult {
  ok: boolean
  url?: string
  status?: number
  detail: string
}

async function pollHealthUrl(url: string): Promise<HealthResult> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastDetail = '尚未收到响应'
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(2_000, HEALTH_POLL_MS * 2))
      timer.unref?.()
      try {
        const response = await fetch(url, { signal: controller.signal })
        if (response.ok) return { ok: true, url, status: response.status, detail: `健康检查通过（HTTP ${response.status}）` }
        lastDetail = `健康检查返回 HTTP ${response.status}`
        return { ok: false, url, status: response.status, detail: lastDetail }
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }
  return { ok: false, url, detail: `健康检查超时（${HEALTH_TIMEOUT_MS / 1000}s）：${lastDetail}` }
}

/** 启动服务命令；返回句柄与输出收集器。 */
function startService(command: string, cwd: string): {
  child: ReturnType<typeof spawn>
  output: () => string
  exited: () => boolean
} {
  let buffer = ''
  const append = (chunk: Buffer | string): void => {
    buffer += chunk.toString()
    if (buffer.length > MAX_LOG_CHARS) buffer = buffer.slice(-MAX_LOG_CHARS)
  }
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  return { child, output: () => buffer, exited: () => exited }
}

function killService(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出。
    }
  }
  setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-pid, 'SIGKILL')
    } catch {
      // 已退出。
    }
  }, 2_000).unref?.()
}

/**
 * 执行一次运行证据采集。由 `flow_submit` 在 G5 前调用；返回 attempted=false
 * 表示没有配置 run 命令，交给 `g5.runtime` 自行判定。
 */
export async function runRuntimeEvidence(runtime: HostRuntime, engine: ReturnType<HostRuntime['engine']>): Promise<RuntimeEvidenceOutcome> {
  if (!engine) return { attempted: false, ok: true, message: '' }
  const config = engine.getConfig()
  const runCommand = config.commands.run
  if (runCommand === undefined || runCommand === 'none' || runCommand.trim() === '') {
    return { attempted: false, ok: true, message: '未配置 run 命令，跳过运行证据' }
  }
  const change = engine.currentChange()
  if (!change || change.stage !== 'S5') {
    return { attempted: false, ok: true, message: `当前阶段 ${change?.stage ?? '无'} 不采集运行证据` }
  }
  // 已有绿色运行回执：复用（避免重试 G5 反复重启服务）。
  const existing = engine.getEvidence().find((receipt) => receipt.changeId === change.id && receipt.kind === 'run' && receipt.exitCode === 0)
  if (existing) return { attempted: true, ok: true, message: `复用已有运行证据 ${existing.id}`, receiptId: existing.id }

  const healthConfig = config.commands.health
  const rootValue = runtime.root()
  const cwd = rootValue === null || rootValue === '' ? process.cwd() : nodePath.resolve(rootValue)
  const service = startService(runCommand, cwd)
  let health: HealthResult
  try {
    if (healthConfig !== undefined && healthConfig !== 'none' && healthConfig.trim() !== '') {
      if (isHealthUrl(healthConfig)) {
        health = await pollHealthUrl(healthConfig.trim())
      } else {
        // health 命令：用命令执行器轮询（0 = 健康）。
        const runner = runtime.ports()?.commandRunner
        const deadline = Date.now() + HEALTH_TIMEOUT_MS
        let last = '尚未执行'
        health = { ok: false, detail: '健康检查命令未执行' }
        while (Date.now() < deadline && runner) {
          const result = await runner.run(healthConfig, { cwd, timeoutMs: 10_000 })
          if (result.exitCode === 0) {
            health = { ok: true, detail: `健康检查命令通过：${healthConfig}` }
            break
          }
          last = `exit=${result.exitCode} ${(result.stderr || result.stdout || '').slice(0, 200)}`
          await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
        }
        if (!health.ok) health = { ok: false, detail: `健康检查命令超时（${HEALTH_TIMEOUT_MS / 1000}s）：${last}` }
      }
    } else {
      // 没有 health：只确认进程在启动宽限期内没有退出（如实记录，不冒充健康检查）。
      await new Promise((resolve) => setTimeout(resolve, START_GRACE_MS))
      health = service.exited()
        ? { ok: false, detail: `服务进程在 ${START_GRACE_MS / 1000}s 内退出` }
        : { ok: true, detail: '未配置 health 命令：按进程存活判定（未做健康检查）' }
    }
  } finally {
    killService(service.child)
  }

  const log = service.output()
  const logRelative = `.flowgate/state/evidence/run-${Date.now()}.log`
  try {
    await runtime.ports()?.fs.writeFile(logRelative, log)
  } catch {
    // 日志落盘失败不影响回执（notes 里仍带摘要）。
  }
  const receipt = await engine.recordRunEvidence({
    command: runCommand,
    ok: health.ok,
    detail: `${health.detail}｜日志：${logRelative}｜输出摘要：${summarizeRunLog(log, 400)}`,
    logPath: logRelative,
    health: { url: isHealthUrl(healthConfig ?? '') ? healthConfig : undefined, status: health.status, ok: health.ok },
  })
  runtime.noteFeature('runEvidence', receipt.exitCode === 0 ? '运行证据采集通过' : '运行证据采集失败')
  runtime.emit()
  return {
    attempted: true,
    ok: receipt.exitCode === 0,
    message: receipt.exitCode === 0 ? `运行证据 ${receipt.id}：${health.detail}` : `运行证据失败（${receipt.id}）：${health.detail}`,
    receiptId: receipt.id,
  }
}
