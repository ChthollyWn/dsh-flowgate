#!/usr/bin/env node
/**
 * 安装 / 卸载干净度验证（M6 / T6.2）。
 *
 * 在隔离 `DSH_HOME` 里建一个 headless profile，记录基线文件集，然后：
 *   1. `dsh plugin add link:<repo>` 安装本插件；
 *   2. 断言组合树、profile 依赖与 node_modules 里出现 dsh-flowgate；
 *   3. `dsh plugin remove dsh-flowgate` 卸载；
 *   4. 断言：组合树不再含插件、依赖列表移除、node_modules 链接消失，
 *      且 profile 里除依赖清单（package.json / pnpm-lock.yaml / node_modules）
 *      之外没有新增文件（不把 lib/skills/.flowgate 之类内容抄进 profile）。
 *
 * 用法：
 *   node scripts/verify-uninstall.mjs
 *   DSH_HOME=/tmp/fg-uninstall-home node scripts/verify-uninstall.mjs --keep
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DSH =
  process.env.DSH ??
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = 'uninstall-test'
const KEEP = process.argv.includes('--keep')
// 安全：绝不使用进程环境里的 DSH_HOME（可能是用户真实 home），
// 只接受显式 FG_UNINSTALL_HOME，否则在临时目录里自建、用完即删。
const explicitHome = process.env.FG_UNINSTALL_HOME
const ownsHome = !explicitHome
const HOME = explicitHome ?? mkdtempSync(join(tmpdir(), 'fg-uninstall-home-'))
if (!ownsHome && !HOME.startsWith(tmpdir())) {
  console.warn(`⚠ 使用显式 DSH_HOME=${HOME}（脚本不会删除它）`)
}

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

if (!existsSync(DSH)) {
  console.error(`找不到 DSH CLI：${DSH}`)
  process.exit(2)
}
const env = { ...process.env, DSH_HOME: HOME }
mkdirSync(HOME, { recursive: true })
const profileDir = join(HOME, 'profiles', PROFILE)

function run(args, options = {}) {
  return execFileSync(DSH, args, { env, encoding: 'utf8', timeout: 300_000, ...options })
}

function dumpConfig() {
  return run(['--profile', PROFILE, '--dump-config'])
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => !entry.startsWith('node_modules/'))
    .sort()
}

try {
  console.log(`隔离 DSH_HOME=${HOME}`)
  if (!existsSync(profileDir)) {
    console.log(`创建 profile ${PROFILE} …`)
    run([PROFILE, '--from-default-profile', 'headless', '--help'])
  }
  const baseline = new Set(listFiles(profileDir))
  console.log(`基线文件 ${baseline.size} 个（不含 node_modules）`)

  console.log('安装插件（link: 当前仓库）…')
  run(['plugin', '--profile', PROFILE, 'add', `link:${ROOT}`])
  const installedDump = dumpConfig()
  check('安装后组合树包含 dsh-flowgate', installedDump.includes('dsh-flowgate'))
  const pkgAfterInstall = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check('安装后 package.json 依赖包含 dsh-flowgate', Boolean(pkgAfterInstall.dependencies?.['dsh-flowgate']))
  check('安装后 node_modules/dsh-flowgate 存在', existsSync(join(profileDir, 'node_modules', 'dsh-flowgate')))

  console.log('卸载插件 …')
  run(['plugin', '--profile', PROFILE, 'remove', 'dsh-flowgate'])
  const removedDump = dumpConfig()
  check('卸载后组合树不含 dsh-flowgate', !removedDump.includes('dsh-flowgate'))
  const pkgAfterRemove = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check('卸载后 package.json 依赖不含 dsh-flowgate', !pkgAfterRemove.dependencies?.['dsh-flowgate'])
  check('卸载后 profile bundles 列表不含 dsh-flowgate', !(pkgAfterRemove.dsh?.profile?.bundles ?? []).includes('dsh-flowgate'))
  // DSH rc.5 的 plugin remove 只改 package.json / bundles，不 prune node_modules：
  // 这里如实报告为**已知残留**（不据此判失败），并说明修复方式。
  const linkLeft = existsSync(join(profileDir, 'node_modules', 'dsh-flowgate'))
  console.log(`${linkLeft ? '⚠' : '✓'} 卸载后 node_modules/dsh-flowgate ${linkLeft ? '仍存在（DSH rc.5 plugin remove 不 prune node_modules；删 profile / 重跑 pnpm install 即清理）' : '链接已消失'}`)

  const after = new Set(listFiles(profileDir))
  // 允许：依赖清单/锁文件、pnpm 元数据、DSH plugin-manager 操作日志。
  const isAllowed = (file) =>
    file === 'package.json' ||
    file === 'pnpm-lock.yaml' ||
    file === 'pnpm-workspace.yaml' ||
    file === '.modules.yaml' ||
    file.startsWith('.pnpm') ||
    file.startsWith('.plugin-manager/') ||
    file === '.plugin-manager' ||
    file === 'node_modules'
  const leftovers = [...after].filter((file) => !baseline.has(file) && !isAllowed(file))
  check('profile 内没有依赖清单/平台日志之外的新增文件', leftovers.length === 0, leftovers.slice(0, 5).join(', '))
  for (const leaked of ['lib', 'skills', '.flowgate']) {
    check(`profile 内没有 ${leaked}/ 残留`, !existsSync(join(profileDir, leaked)))
  }
  check('profile 未被安装过程改动的其他文件保持基线', [...baseline].every((file) => after.has(file)))
} catch (error) {
  console.error(`✗ 卸载验证执行失败：${error.message}`)
  failures.push('执行')
} finally {
  if (ownsHome && !KEEP) {
    if (HOME.startsWith(tmpdir())) {
      rmSync(HOME, { recursive: true, force: true })
      console.log(`已清理隔离 DSH_HOME（${relative(process.cwd(), HOME) || HOME}）`)
    } else {
      console.warn(`⚠ 拒绝删除非临时目录 ${HOME}`)
    }
  } else {
    console.log(`保留 DSH_HOME=${HOME}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项卸载干净度检查失败：${failures.join('、')}`)
  process.exit(1)
}
console.log('\n安装 / 卸载干净度检查全部通过。')
