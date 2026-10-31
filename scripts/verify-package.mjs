#!/usr/bin/env node
/**
 * Package verification (T0.3 / NFR-11): inspect the npm tarball without
 * publishing it.
 *
 * Rules:
 *  - lib/host.js and lib/client.js must be present (build before packing)
 *  - lib/client.js must be a DSH module-loader bundle
 *  - skills/ and cordis.patch.yml must ship
 *  - no @deepseek-ai packages may be nested in the tarball (NFR-3)
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const problems = []

// `npm pack --dry-run` 也要写缓存与日志；在沙箱化环境（如 DSH workspace-write）里
// `~/.npm` 可能不可写且是本机 root 遗留目录。把 npm 的 cache/logs 固定到系统临时目录，
// 既不影响包清单（--dry-run 不产生 tarball），也让脚本在没有可写 home 的 CI/沙箱可复现。
const npmCache = join(tmpdir(), 'flowgate-npm-cache')
const npmLogs = join(tmpdir(), 'flowgate-npm-logs')
mkdirSync(npmCache, { recursive: true })
mkdirSync(npmLogs, { recursive: true })
const npmEnv = {
  ...process.env,
  npm_config_cache: npmCache,
  npm_config_logs_dir: npmLogs,
  npm_config_update_notifier: 'false',
}

let manifest
try {
  manifest = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', env: npmEnv }),
  )[0]
} catch (error) {
  console.error('无法生成包清单：', error.message)
  process.exit(1)
}

if (!manifest) {
  console.error('npm pack 没有返回清单')
  process.exit(1)
}

const files = new Set(manifest.files.map((file) => file.path))
const required = ['lib/host.js', 'lib/client.js', 'cordis.patch.yml']
for (const path of required) {
  if (!files.has(path)) problems.push(`缺少文件 ${path}（先运行 pnpm build）`)
}
if (![...files].some((path) => path.startsWith('skills/') && path.endsWith('.md'))) {
  problems.push('包中没有 skills/**/*.md（内置技能必须随包发布）')
}
for (const path of files) {
  if (path.includes('node_modules') || path.includes('@deepseek-ai')) {
    problems.push(`包中不应包含宿主或依赖文件：${path}`)
  }
  if (path.startsWith('src/') || path.startsWith('test/') || path.startsWith('docs/')) {
    problems.push(`发布包不应包含开发文件：${path}`)
  }
}

if (files.has('lib/client.js')) {
  const client = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
  if (!client.includes('window.__ModuleLoader__.load(')) {
    problems.push('lib/client.js 不是 window.__ModuleLoader__.load(...) 包装的浏览器 bundle')
  }
  if (!/id:\s*["']dsh-flowgate["']/.test(client)) {
    problems.push('lib/client.js 缺少模块 id "dsh-flowgate"')
  }
}
if (files.has('lib/host.js')) {
  const host = await readFile(join(ROOT, 'lib/host.js'), 'utf8')
  if (!/export\s*\{[^}]*\bapply\b/.test(host) && !/export\s+(async\s+)?function\s+apply/.test(host)) {
    problems.push('lib/host.js 没有导出 apply（Cordis 插件入口）')
  }
}

const sizeMb = manifest.size / (1024 * 1024)
if (sizeMb > 10) problems.push(`包体积 ${sizeMb.toFixed(2)}MB 超过 10MB`)

if (problems.length > 0) {
  console.error('包检查失败：')
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}
console.log(
  `包检查通过：${manifest.entryCount ?? files.size} 个文件，${(manifest.size / 1024).toFixed(1)}KB，包含 lib/host.js、lib/client.js 与 skills/。`,
)
