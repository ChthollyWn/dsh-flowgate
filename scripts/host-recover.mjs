#!/usr/bin/env node
/**
 * 宿主恢复 CLI（host:recover）——插件自身出问题时的"不卸载也能恢复"入口。
 *
 * 事故背景（2026-11-01）：投影 wire 非 lossless JSON → 新建会话全部失败；
 * 旧恢复流程要求先 `/flow off`（人工命令、要求已有变更）或面板禁用 + 重启，
 * 再重新装回插件——恢复动作本身被插件挡住，形成自举死锁。本 CLI 只操作
 * 宿主侧的 safe-mode sentinel 与 profile 安装状态，**不写项目数据、不删用户
 * 数据**，并把每一步写进审计日志 `$DSH_HOME/flowgate/recovery.log`。
 *
 * 能力：
 *   --status                   查看当前恢复相关状态（sentinel / env / 可选项目级）
 *   --safe-mode [--reason 文本] 写 safe-mode sentinel：插件下次启动强制 takeover=off
 *                              并跳过 guard/delegation/dispatch/gates（见 src/host/mode.ts）
 *   --clear                    删除 safe-mode sentinel（修好并验证后再重启）
 *   --profile <名> --remove [--yes]
 *                              从指定 profile 移除 dsh-flowgate（最后手段；默认 dry-run）
 *   --help                     完整帮助
 *
 * sentinel 路径（与插件读取口径一致）：
 *   $DSH_HOME/flowgate/safe-mode         （DSH_HOME 未设置时 = ~/.dsh/flowgate/safe-mode）
 *   [--project <dir>] <dir>/.flowgate/safe-mode（项目级，可选，双保险）
 *   env FLOWGATE_SAFE=1                  （只读展示，CLI 不改环境）
 *
 * 用法：
 *   pnpm host:recover --status
 *   pnpm host:recover --safe-mode --reason "新建会话报 not lossless JSON"
 *   pnpm host:recover --clear
 *   pnpm host:recover --profile desktop --remove          # dry-run，只打印命令
 *   pnpm host:recover --profile desktop --remove --yes    # 真的移除（最后手段）
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const DSH = process.env.DSH ?? DEFAULT_DSH
const args = process.argv.slice(2)

function flagValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
function has(name) {
  return args.includes(name)
}

const HELP = `FlowGate host:recover —— 宿主恢复 CLI（safe-mode / 移除插件 / 审计）

插件自身出问题（新建会话失败、插件加载失败、门禁误拦、插件 bug）时，先让插件
"安全降级"而不是卸载或关掉整个 DSH。所有操作只写 sentinel 与审计日志，不删项目数据。

用法：
  node scripts/host-recover.mjs <动作> [选项]
  pnpm host:recover --status              # 等价

动作（互斥，必须选一个）：
  --status                    查看恢复状态：safe-mode sentinel、FLOWGATE_SAFE、
                              可选项目级 sentinel、以及建议的下一步
  --safe-mode                 写 safe-mode sentinel（幂等）。插件下次启动即强制
                              takeover=off 并跳过 guard/delegation/dispatch/gates
                              （见 src/host/mode.ts；不需要卸载插件）
      --reason <文本>          写入 sentinel 的原因（会展示在 /flow doctor 与审计日志）
  --clear                     删除 safe-mode sentinel（修复并 verify:host 通过后再执行）
  --profile <名> --remove     从指定 profile 移除 dsh-flowgate（最后手段：先 dry-run，
                              确认命令后再加 --yes 真正执行）
      --yes                    确认执行 --remove（没有它只打印将执行的命令）

通用选项：
  --project <dir>            同时操作/展示项目级 sentinel <dir>/.flowgate/safe-mode
                             （双保险；--status 时会显示）
  --dsh-home <dir>           覆盖 DSH_HOME（默认读取环境变量；再默认 ~/.dsh）
  --help, -h                 显示本帮助

安全边界：
  - 不删除 .flowgate/ 项目数据、不改 package.json、不动会话日志；
  - 只删 CLI 自己管理的 safe-mode sentinel 文件；
  - 每个实际改动都追加一行到 $DSH_HOME/flowgate/recovery.log（dry-run 也会记录计划）。

推荐恢复顺序（详见 docs/impl/host-recovery.md）：
  1) host:recover --safe-mode --reason "<现象>" → 2) 重启 DSH → 3) 用 dev profile
  或 dsh rescue 修复 → 4) pnpm verify:host 通过 → 5) host:recover --clear → 6) 重启验证。

退出码：0 成功；1 执行失败；2 用法错误。
`

// ---- 参数校验 ----
const ACTIONS = ['--status', '--safe-mode', '--clear', '--remove'].filter((flag) => has(flag))
if (has('--help') || has('-h')) {
  console.log(HELP)
  process.exit(0)
}
if (ACTIONS.length === 0) {
  console.error('✗ 缺少动作：--status / --safe-mode / --clear / --profile <名> --remove\n')
  console.error(HELP)
  process.exit(2)
}
if (ACTIONS.length > 1) {
  console.error(`✗ 动作必须互斥，收到：${ACTIONS.join(' ')}`)
  process.exit(2)
}
const ACTION = ACTIONS[0]
if (ACTION === '--remove' && !flagValue('--profile')) {
  console.error('✗ --remove 需要配合 --profile <名>（例如 --profile desktop）')
  process.exit(2)
}

const dshHomeFlag = flagValue('--dsh-home')
const DSH_HOME = resolve(dshHomeFlag ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const FLOWGATE_DIR = join(DSH_HOME, 'flowgate')
const SENTINEL = join(FLOWGATE_DIR, 'safe-mode')
const RECOVERY_LOG = join(FLOWGATE_DIR, 'recovery.log')
const PROJECT = flagValue('--project') ? resolve(flagValue('--project')) : null
const PROJECT_SENTINEL = PROJECT ? join(PROJECT, '.flowgate', 'safe-mode') : null
const REASON = flagValue('--reason')
const NOW = () => new Date().toISOString()

/** 追加一行审计（JSONL；失败不阻断恢复动作，但会告警）。 */
function audit(entry) {
  const line = JSON.stringify({ at: NOW(), action: ACTION, dshHome: DSH_HOME, ...entry })
  try {
    mkdirSync(FLOWGATE_DIR, { recursive: true })
    appendFileSync(RECOVERY_LOG, `${line}\n`)
    console.log(`  审计：${RECOVERY_LOG}`)
  } catch (error) {
    console.warn(`⚠ 审计日志写入失败（恢复动作已生效）：${error.message}`)
  }
}

function readSentinel(path) {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8').trim()
    return { path, text: text.slice(0, 2000) }
  } catch (error) {
    return { path, text: `（读取失败：${error.message}）` }
  }
}

function printSentinel(label, info, path) {
  if (!info) {
    console.log(`  ${label}：未启用（${path}）`)
    return
  }
  console.log(`  ${label}：✅ 已启用（${info.path}）`)
  if (info.text) console.log(`    原因：${info.text.split('\n')[0].slice(0, 300)}`)
}

function printNextSteps() {
  console.log('\n下一步：')
  console.log('  1) 完全重启 DSH（桌面端退出重开；Web 宿主 Ctrl-C 后重跑）——sentinel 在插件启动时读取')
  console.log('  2) 用隔离 dev profile 或 `dsh rescue` 复现/修复（见 docs/impl/dev-loop.md）')
  console.log(`  3) 修好后先跑 \`pnpm verify:host\`（真机新建会话回归门，必须通过）`)
  console.log('  4) `pnpm host:recover --clear` 删除 sentinel，再重启一次确认恢复正常')
  console.log('  5) 在变更/事故记录里补 incident（原因、时间、证据、回归测试），审计不断')
}

console.log(`FlowGate host:recover · DSH_HOME=${DSH_HOME}`)

try {
  if (ACTION === '--status') {
    console.log('\n恢复状态：')
    printSentinel('宿主级 safe-mode', readSentinel(SENTINEL), SENTINEL)
    if (PROJECT_SENTINEL) printSentinel('项目级 safe-mode', readSentinel(PROJECT_SENTINEL), PROJECT_SENTINEL)
    const envSafe = process.env.FLOWGATE_SAFE
    console.log(`  FLOWGATE_SAFE=${envSafe ?? '（未设置）'}${envSafe === '1' || envSafe === 'true' ? ' → ✅ 生效' : ''}`)
    const ledgerKey = join(homedir(), '.dsh', 'flowgate', 'ledger.key')
    console.log(`  ledger.key 位置（只读展示，不复制不删除）：${existsSync(ledgerKey) ? ledgerKey : '未创建（首次写账本时生成）'}`)
    console.log(`  审计日志：${existsSync(RECOVERY_LOG) ? RECOVERY_LOG : '尚无记录'}`)
    if (readSentinel(SENTINEL) || (PROJECT_SENTINEL && readSentinel(PROJECT_SENTINEL))) {
      console.log('\n当前处于 safe-mode：插件下次启动会强制 takeover=off 并跳过 guard 等安装。')
      printNextSteps()
    } else {
      console.log('\n当前未处于 safe-mode。若遇到新建会话失败/门禁误拦，先执行：')
      console.log('  pnpm host:recover --safe-mode --reason "<现象一句话>"')
    }
    process.exit(0)
  }

  if (ACTION === '--safe-mode') {
    const reason = (REASON ?? `安全模式：由 host:recover CLI 在 ${NOW()} 启用`).replaceAll('\n', ' ').trim()
    mkdirSync(FLOWGATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(SENTINEL, `${reason}\n`, { mode: 0o600 })
    console.log(`\n✅ 已启用 safe-mode：${SENTINEL}`)
    console.log(`   原因：${reason}`)
    if (PROJECT_SENTINEL) {
      mkdirSync(join(PROJECT, '.flowgate'), { recursive: true })
      writeFileSync(PROJECT_SENTINEL, `${reason}\n`, { mode: 0o600 })
      console.log(`   项目级双保险：${PROJECT_SENTINEL}`)
    }
    audit({ result: 'safe-mode-on', path: SENTINEL, reason, project: PROJECT_SENTINEL })
    console.log('\n插件下次启动将强制 takeover=off（只记录、不拦截），不需要卸载插件。')
    printNextSteps()
    process.exit(0)
  }

  if (ACTION === '--clear') {
    const removed = []
    for (const path of [SENTINEL, PROJECT_SENTINEL].filter(Boolean)) {
      if (existsSync(path)) {
        rmSync(path, { force: true })
        removed.push(path)
        console.log(`✅ 已删除 ${path}`)
      } else {
        console.log(`· ${path} 不存在（无需删除）`)
      }
    }
    if (removed.length === 0) {
      console.log('没有需要清除的 sentinel。若仍想确认，运行 --status。')
    }
    audit({ result: 'safe-mode-off', removed })
    console.log('\n⚠ 删除 sentinel 后请重启 DSH 使插件回到正常接管；重启前确认：')
    console.log('  - 已用能正常新建会话的构建（`pnpm verify:host` 通过）')
    console.log('  - 已记录本次 incident（原因/时间/证据/回归测试）')
    process.exit(0)
  }

  if (ACTION === '--remove') {
    const profile = flagValue('--profile')
    const command = [DSH, 'plugin', '--profile', profile, 'remove', 'dsh-flowgate']
    const yes = has('--yes')
    console.log('\n将执行的命令（最后手段：从 profile 移除插件，不删除用户数据）：')
    console.log(`  ${command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')}`)
    if (!yes) {
      console.log('\n默认 dry-run：未执行。确认无误后加 --yes 真正移除。')
      console.log('提示：优先用 --safe-mode（保留插件、只降级），移除只用于插件导致宿主无法启动等极端情况。')
      audit({ result: 'remove-dry-run', profile, command: command.join(' ') })
      process.exit(0)
    }
    if (!existsSync(DSH)) {
      console.error(`✗ 找不到 DSH CLI：${DSH}\n  设置 DSH=/path/to/dsh 后重试（本机桌面端自带 CLI）。`)
      process.exit(1)
    }
    try {
      const output = execFileSync(DSH, command.slice(1), {
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? DSH_HOME },
      })
      console.log(output.trim())
      console.log(`\n✅ 已从 profile "${profile}" 移除 dsh-flowgate`)
      audit({ result: 'remove-executed', profile, command: command.join(' '), ok: true })
      console.log('\n下一步：重启 DSH 确认宿主可正常启动；之后用 dev profile 修复，修好再按')
      console.log('docs/impl/dev-loop.md 重新安装（`dsh plugin --profile <p> add file:<tgz>|link:<repo>`）。')
      process.exit(0)
    } catch (error) {
      console.error(`✗ 移除失败：${error.message}`)
      audit({ result: 'remove-executed', profile, command: command.join(' '), ok: false, error: error.message })
      process.exit(1)
    }
  }
} catch (error) {
  console.error(`✗ host:recover 执行失败：${error?.message ?? String(error)}`)
  process.exit(1)
}
