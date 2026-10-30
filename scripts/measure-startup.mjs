#!/usr/bin/env node
/**
 * 启动耗时增量测量（M6 / T6.2，验收线：增量 < 200ms）。
 *
 * 口径（如实标注）：DSH 的 Web/桌面上游启动包含进程、Electron、UI 三层，无法在
 * 纯命令行里无损拆出"插件那一份"；这里测量的是 **插件 host 入口的模块加载成本**：
 * 在一个全新 Node 进程里 `import('lib/host.js')`（约 1MB bundle 的解析 + 顶层求值）
 * 对比空进程的基线耗时，取中位数。这是插件启动成本的主体；注册与 UI 渲染成本很小
 * 且无法在无 UI 的 CI 里复现，需要桌面端人工计时（见 docs/compat/startup.md）。
 *
 * 用法：
 *   node scripts/measure-startup.mjs            # 默认 5 次
 *   node scripts/measure-startup.mjs --iters 7 --write
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const hostBundle = join(ROOT, 'lib', 'host.js')
const args = process.argv.slice(2)
const iterIndex = args.indexOf('--iters')
const ITERS = iterIndex >= 0 ? Number(args[iterIndex + 1]) : 5
const WRITE = args.includes('--write')

if (!existsSync(hostBundle)) {
  console.error('缺少 lib/host.js（先运行 pnpm build）')
  process.exit(2)
}
if (!Number.isFinite(ITERS) || ITERS < 1) {
  console.error('--iters 需要正整数')
  process.exit(2)
}

function measure(nodeArgs) {
  const samples = []
  for (let index = 0; index <= ITERS; index += 1) {
    const started = process.hrtime.bigint()
    execFileSync(process.execPath, nodeArgs, { encoding: 'utf8', timeout: 120_000, stdio: 'ignore' })
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    if (index > 0) samples.push(elapsed)
  }
  return samples
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

console.log(`采样 ${ITERS} 次（首轮预热丢弃），测量 lib/host.js 的模块加载成本。`)
const base = measure(['--no-warnings', '--input-type=module', '-e', 'void 0'])
const plugin = measure(['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(hostBundle)})`])
const delta = median(plugin) - median(base)
const pass = delta < 200
const lines = [
  `# 启动耗时增量（${new Date().toISOString()}）`,
  '',
  '> 口径：插件 host 入口在**全新 Node 进程**中的模块加载成本（解析 + 顶层求值），',
  '> 对比空进程基线；不含 Electron/UI 启动与窗口创建。注册与 UI 成本很小，',
  '> 完整 UI 冷启动需要桌面端人工计时（本仓库不伪造该数字）。',
  '',
  '| 指标 | 基线（空进程） | 加载 lib/host.js | 增量 |',
  '|---|---|---|---|',
  `| 中位数（ms） | ${median(base).toFixed(1)} | ${median(plugin).toFixed(1)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} |`,
  '',
  `验收线：增量 < 200ms → **${pass ? '通过' : '未通过'}**`,
  '',
]
const text = lines.join('\n')
console.log(text)
if (WRITE) {
  const dir = join(ROOT, 'docs', 'compat')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'startup.md'), text)
  console.log('结果已写入 docs/compat/startup.md')
}
process.exit(pass ? 0 : 1)
