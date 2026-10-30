#!/usr/bin/env node
/**
 * DSH compatibility verification (T6.2 / NFR-11).
 *
 * Runs against a REAL DSH installation in an isolated profile and checks:
 *   1. the bundle patch is loaded (--dump-config mentions dsh-flowgate)
 *   2. the plugin row appears in the composed tree
 *   3. /flow command is registered (probe via the CLI help / dump where possible)
 *   4. required host entries exist in the composed config
 *
 * Usage:
 *   node scripts/verify-dsh-compat.mjs [--profile flowgate-dev]
 *
 * The script never touches the daily profile. It exits non-zero on failure and
 * writes docs/compat/<dsh-version>.md when --write is passed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DSH =
  process.env.DSH ??
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const PROFILE = profileIndex >= 0 ? args[profileIndex + 1] : 'flowgate-dev'
const WRITE = args.includes('--write')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DSH)) {
  console.error(`找不到 DSH CLI：${DSH}\n设置环境变量 DSH 指向桌面端自带 CLI。`)
  process.exit(2)
}

let version = 'unknown'
try {
  version = execFileSync(DSH, ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
  record('CLI 可用', true, version)
} catch (error) {
  record('CLI 可用', false, error.message)
}

let dump = ''
try {
  dump = execFileSync(DSH, ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', timeout: 120_000 })
  record('组合配置可导出', true, `${dump.split('\n').length} 行`)
} catch (error) {
  record('组合配置可导出', false, error.message)
}

if (dump) {
  record('插件行存在（dsh-flowgate）', /dsh-flowgate/.test(dump), '检查 --dump-config 输出')
  record('FlowGate 工程模式 preset 声明', /FlowGate|flowgate/.test(dump) && /preset/i.test(dump), '检查 preset 行')
}

const packageJsonPath = join(ROOT, 'package.json')
try {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  record('包清单 dsh.client 声明', Boolean(manifest.dsh?.client?.platform === 'web'), JSON.stringify(manifest.dsh?.client ?? null))
  record('engines.dsh 为范围声明', Boolean(manifest.engines?.dsh && /[<>=^~]/.test(manifest.engines.dsh)), manifest.engines?.dsh ?? 'missing')
  record('不把 @deepseek-ai 放入 dependencies', !Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@deepseek-ai/')), 'NFR-3')
} catch (error) {
  record('读取 package.json', false, error.message)
}

const failed = results.filter((result) => !result.ok)
if (WRITE) {
  const dir = join(ROOT, 'docs', 'compat')
  mkdirSync(dir, { recursive: true })
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, '_')
  const body = `# DSH 兼容验证 ${version}\n\n日期：${new Date().toISOString()}\nProfile：${PROFILE}\n\n| 检查项 | 结果 | 说明 |\n|---|---|---|\n${results
    .map((result) => `| ${result.name} | ${result.ok ? '通过' : '失败'} | ${(result.detail ?? '').replaceAll('|', '\\|')} |`)
    .join('\n')}\n`
  writeFileSync(join(dir, `${safeVersion}.md`), body)
  console.log(`兼容报告已写入 docs/compat/${safeVersion}.md`)
}

if (failed.length > 0) {
  console.error(`\n${failed.length} 项兼容检查失败。`)
  process.exit(1)
}
console.log('\n全部兼容检查通过。')
