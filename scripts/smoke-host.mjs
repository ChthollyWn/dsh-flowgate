#!/usr/bin/env node
/**
 * 真机宿主冒烟：新建会话不报 not lossless JSON（verify:host）。
 *
 * 背景（2026-11-01 事故）：`flowgate` 会话投影的 wire 值含显式 `undefined`，
 * DSH `@deepseek-ai/dsh-api-remotes` 在转发 `api-session/added` 前用
 * `isJsonValue()` 校验，失败导致**新建会话/子会话全部失败**；而修复流程又要求
 * 关插件/重启/新会话，形成自举死锁。本脚本是这件事的**唯一可靠回归门**：
 * 它不检查源码或单测，而是在隔离环境里启动真实 DSH Web 宿主，走真实
 * `POST /api/session/create` —— 与事故当时的手工复现路径完全一致。
 *
 * 流程（全部在 os.tmpdir() 下自建，绝不碰 ~/.dsh）：
 *   1. 建临时 DSH_HOME + HOME（保证插件 ledger.key 也落在临时目录）+ 临时 workspace
 *      （复制仓库 `.flowgate/`，因为该 bug 只在 FlowGate 已初始化的项目里触发）；
 *   2. `dsh <profile> --from-default-profile web --help` 新建隔离 profile；
 *   3. `dsh plugin --profile <profile> add link:<repo>` 安装当前工作区构建；
 *   4. 后台起真实 Web 宿主（`--no-open --port 0`），从日志解析
 *      `dsh web: http://127.0.0.1:<port>/?token=…`；
 *   5. `GET /connect?token=…` 换 `set-cookie` 鉴权 Cookie；
 *   6. `POST /api/session/create` 创建新会话，断言 `ok:true` + `sessionId`
 *      且响应不含 `not lossless JSON` / `gateway/internal`；
 *   7. 结束 kill 宿主、删临时目录（`--keep` 保留现场）。
 *
 * 退出码：0 = 通过；1 = 冒烟失败（真实问题）；2 = 环境/前置不满足（缺 DSH、缺 lib/）。
 *
 * 用法：
 *   node scripts/smoke-host.mjs                 # 默认：当前仓库构建
 *   node scripts/smoke-host.mjs --keep          # 保留日志与临时目录（排障）
 *   node scripts/smoke-host.mjs --plugin /tmp/old-build --expect-fail
 *                                               # 用已知坏构建验证本门确实能抓住旧 bug
 *   DSH=/path/to/dsh node scripts/smoke-host.mjs
 *
 * 依赖：本机安装 DSH 桌面端（或设置 DSH 指向其 CLI），仓库先 `pnpm build`
 * （脚本不代你构建；缺 lib/host.js 时直接报错退出 2）。
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const DSH = process.env.DSH ?? DEFAULT_DSH
const args = process.argv.slice(2)

function flagValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const HELP = `FlowGate verify:host —— 真机宿主冒烟（新建会话不报 not lossless JSON）

在隔离 DSH_HOME 中安装本仓库构建、启动真实 DSH Web 宿主，并真实创建一次新会话。
这是 2026-11-01「投影 wire 非 lossless JSON → 新建会话失败」事故的回归门。

用法：
  node scripts/smoke-host.mjs [选项]
  pnpm verify:host [-- --选项]        # 等价

选项：
  --help, -h          显示本帮助并退出
  --keep              失败/成功后都保留临时 DSH_HOME、workspace、host 日志（打印路径）
  --plugin <dir>      安装指定路径的插件构建（默认：本仓库；用于对比旧构建/快照）
  --profile <name>    隔离 profile 名（默认 flowgate-smoke；每次在全新 DSH_HOME 里创建）
  --timeout <ms>      等待宿主就绪与请求的总超时（默认 180000 = 3 分钟）
  --port <n>          宿主端口（默认 0 = 让操作系统选空闲端口）
  --workspace <dir>   使用已有 workspace（脚本会写入 .flowgate/ 状态；默认复制仓库 .flowgate/
                      到临时目录，除非要做现场排障否则不建议指向真实仓库）
  --sessions <n>      连续创建会话数（默认 3，最少 2）。必须 >1：该 bug 只在 FlowGate
                      首次初始化后**再一次**建会话时触发——首个会话初始化插件运行时，
                      后续会话摘要才会带上含 undefined 的投影值。只建一个会话会漏测。
  --expect-fail       反向模式：要求创建会话**失败**且出现 not lossless JSON
                      （用于拿已知坏构建验证本门有效，不是常规回归）

前置：
  - 本机安装 DSH 桌面端；或用 DSH=/path/to/dsh 指定 CLI
  - 仓库已 pnpm build（本脚本只验证构建产物，不替你构建）
  - 零模型请求：脚本只创建空会话、不发送消息，并把模型 key 置为假值

退出码：0 通过；1 冒烟失败（真实问题）；2 环境/前置不满足。
`

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

const KEEP = args.includes('--keep')
const EXPECT_FAIL = args.includes('--expect-fail')
const PLUGIN = resolve(flagValue('--plugin') ?? ROOT)
const PROFILE = flagValue('--profile') ?? 'flowgate-smoke'
const TIMEOUT = Number(flagValue('--timeout') ?? 180_000)
const PORT = Number(flagValue('--port') ?? 0)
const SESSIONS = Number(flagValue('--sessions') ?? 3)
const WORKSPACE_ARG = flagValue('--workspace')
const DSH_ENV_NAME = process.env.DSH ? '$DSH' : '默认桌面端 CLI'

if (!Number.isFinite(TIMEOUT) || TIMEOUT < 10_000) {
  console.error('✗ --timeout 需要 ≥10000 的毫秒数')
  process.exit(2)
}
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65_535) {
  console.error('✗ --port 需要 0–65535 的整数')
  process.exit(2)
}
if (!Number.isInteger(SESSIONS) || SESSIONS < 2) {
  console.error('✗ --sessions 需要 ≥2 的整数：该 bug 在 FlowGate 初始化后的下一次建会话才触发，单个会话会漏测。')
  process.exit(2)
}
if (!existsSync(DSH)) {
  console.error(`✗ 找不到 DSH CLI：${DSH}（${DSH_ENV_NAME}）`)
  console.error('  用 DSH=/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh 指定桌面端自带 CLI。')
  process.exit(2)
}
const pluginHost = join(PLUGIN, 'lib', 'host.js')
if (!existsSync(pluginHost)) {
  console.error(`✗ 缺少构建产物：${pluginHost}`)
  console.error('  先在本仓库执行 `pnpm build`（本脚本不代你构建，也不改源码）。')
  process.exit(2)
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function logTail(text, lines = 60) {
  const all = text.split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- 临时环境 ----
let tempRoot = null
let child = null
let childLog = ''
let hostLogPath = ''

function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  if (tempRoot && !KEEP) {
    if (tempRoot.startsWith(realpathSync(tmpdir())) || tempRoot.startsWith(tmpdir())) {
      rmSync(tempRoot, { recursive: true, force: true })
    } else {
      console.warn(`⚠ 拒绝删除非临时目录 ${tempRoot}`)
    }
  }
}

process.on('SIGINT', () => {
  console.error('\n收到 SIGINT，清理中…')
  cleanup()
  process.exit(130)
})

try {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'fg-host-smoke-')))
  const dshHome = join(tempRoot, 'dsh-home')
  const home = join(tempRoot, 'home')
  const workspace = WORKSPACE_ARG ? realpathSync(resolve(WORKSPACE_ARG)) : join(tempRoot, 'workspace')
  hostLogPath = join(tempRoot, 'host.log')
  mkdirSync(join(dshHome, 'profiles'), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(hostLogPath, '')

  console.log(`隔离根目录：${tempRoot}`)
  console.log(`  DSH_HOME=${dshHome}`)
  console.log(`  HOME=${home}（护住插件 ledger.key，不落真实 ~/.dsh）`)
  console.log(`  workspace=${workspace}`)
  console.log(`插件构建：${PLUGIN}（入口 ${basename(pluginHost)}）`)
  console.log(`profile：${PROFILE}（--from-default-profile web）`)

  const cliEnv = { ...process.env, DSH_HOME: dshHome }
  function runDsh(cliArgs, timeout = 300_000) {
    return execFileSync(DSH, cliArgs, { env: cliEnv, encoding: 'utf8', timeout })
  }

  // ---- 1) 临时 workspace：复制仓库 .flowgate/（bug 只在已初始化项目触发）----
  const repoFlowgate = join(ROOT, '.flowgate')
  if (existsSync(repoFlowgate)) {
    cpSync(repoFlowgate, join(workspace, '.flowgate'), { recursive: true })
    check('workspace 已带 FlowGate 初始化产物（.flowgate/）', existsSync(join(workspace, '.flowgate', 'config.yaml')), workspace)
  } else {
    check('workspace 已带 FlowGate 初始化产物（.flowgate/）', false, `仓库缺少 ${repoFlowgate}；该 bug 只在已初始化项目触发，请先 /flow init`)
  }
  if (checks.some((item) => !item.ok)) throw new Error('前置检查失败')

  // ---- 2) 隔离 profile ----
  if (!existsSync(join(dshHome, 'profiles', PROFILE))) {
    runDsh([PROFILE, '--from-default-profile', 'web', '--help'], 180_000)
  }
  check('隔离 web profile 已创建', existsSync(join(dshHome, 'profiles', PROFILE, 'package.json')), `DSH_HOME=${dshHome}`)

  // ---- 3) 安装本仓库构建 ----
  const install = runDsh(['plugin', '--profile', PROFILE, 'add', `link:${PLUGIN}`], 300_000)
  const dump = runDsh(['--profile', PROFILE, '--dump-config'], 180_000)
  check('插件已安装且组合树包含 dsh-flowgate', /dsh-flowgate/.test(dump), `plugin add 输出 ${install.trim().split('\n').length} 行`)

  // ---- 4) 起真实 Web 宿主 ----
  const hostArgs = ['--profile', PROFILE, '--no-open', '--host', '127.0.0.1', '--port', String(PORT)]
  const hostEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    HOME: home, // 插件 ledger.key 默认 ~/.dsh/flowgate/ledger.key → 必须隔离
    DEEPSEEK_API_KEY: 'sk-flowgate-smoke-no-model-request',
  }
  child = spawn(DSH, hostArgs, { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  childLog = ''
  const appendLog = (chunk) => {
    const text = chunk.toString()
    try {
      appendFileSync(hostLogPath, text)
    } catch {
      /* 日志写失败不影响冒烟主流程 */
    }
    childLog += text
    if (childLog.length > 2_000_000) childLog = childLog.slice(-1_000_000)
  }
  child.stdout.on('data', appendLog)
  child.stderr.on('data', appendLog)
  child.on('error', (error) => {
    childLog += `\n[spawn error] ${error.message}`
  })
  console.log(`\n启动宿主：${DSH} ${hostArgs.join(' ')}`)

  const startedAt = Date.now()
  let base = null
  let token = null
  while (Date.now() - startedAt < TIMEOUT) {
    const text = readIfExists(hostLogPath) + childLog
    const match = text.match(/dsh web:\s+(https?:\/\/\S+)/)
    if (match) {
      const url = new URL(match[1])
      base = url.origin
      token = url.searchParams.get('token') ?? ''
      break
    }
    if (child.exitCode !== null) {
      throw new Error(`宿主提前退出（exit=${child.exitCode}）：\n${logTail(childLog)}`)
    }
    await sleep(250)
  }
  if (!base) {
    throw new Error(`等宿主就绪超时（${TIMEOUT}ms）：\n${logTail(childLog)}`)
  }
  check('真实 Web 宿主已就绪', true, `${base}（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
  check('启动 URL 带鉴权 token', Boolean(token))

  // ---- 5) 换鉴权 Cookie ----
  const connect = await fetch(`${base}/connect?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  const setCookie = connect.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0].trim()
  check('GET /connect 换取鉴权 Cookie', Boolean(cookie) && /^dsh-auth-/.test(cookie), `HTTP ${connect.status}`)
  if (!cookie) throw new Error('拿不到 dsh-auth Cookie，无法继续创建会话')

  // ---- 6) 连续创建新会话（事故的手工复现路径）----
  // 关键：必须创建 >1 个。首个会话会初始化 FlowGate 插件运行时（engine 载入
  // 工作区 .flowgate/ 并 emit 一条投影记录），之后的会话摘要才带上含 undefined
  // 的投影 wire 值。只建一个会话会让旧 bug 漏测（实测：中性化修复的构建上
  // 第 1 次 create 成功、第 2 次起报 not lossless JSON）。
  const createFailures = []
  const createdIds = []
  const losslessHits = []
  for (let index = 1; index <= SESSIONS; index += 1) {
    const rpcId = `smoke-${index}-${Date.now().toString(36)}`
    const requestBody = {
      type: 'client-request',
      rpcId,
      method: 'session/create',
      payload: { args: { request: { cwd: workspace } } },
    }
    const createStarted = Date.now()
    const response = await fetch(`${base}/api/session/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(60_000),
    })
    const responseText = await response.text()
    let responseJson = null
    try {
      responseJson = JSON.parse(responseText)
    } catch {
      /* 非 JSON：按失败记录并打印原文 */
    }
    const sessionId = responseJson?.result?.value?.sessionId
    const losslessError = /not lossless JSON|gateway\/internal/i.test(responseText)
    const ok =
      response.ok &&
      responseJson?.result?.ok === true &&
      typeof sessionId === 'string' &&
      sessionId.length > 0 &&
      !losslessError
    if (losslessError) losslessHits.push(index)
    if (!ok) createFailures.push(index)
    else createdIds.push(sessionId)
    const detail = ok
      ? `${sessionId} · ${((Date.now() - createStarted) / 1000).toFixed(2)}s`
      : `HTTP ${response.status} · ${responseJson?.result?.error?.code ?? '未知错误'}`
    if (EXPECT_FAIL) {
      console.log(`${ok ? '✓' : '✗'} 创建会话 #${index}/${SESSIONS}${ok ? '成功' : '失败'} — ${detail}`)
    } else {
      check(`创建会话 #${index}/${SESSIONS} 成功（ok:true + sessionId + 无 lossless 错误）`, ok, detail)
    }
    if (!ok) {
      console.error(`\n第 ${index} 次创建会话响应原文：\n${responseText.slice(0, 4000)}`)
    }
    // 给插件运行时留出初始化/emit 的时间，确保下一次构建会话摘要时投影已物化。
    if (index < SESSIONS) await sleep(750)
  }

  if (EXPECT_FAIL) {
    // 反向模式：已知坏构建上必须复现事故错误，否则说明本门没抓住该 bug。
    const reproduced = losslessHits.length > 0
    check('反向模式：已知坏构建复现 not lossless JSON（本门有效）', reproduced, reproduced ? `第 ${losslessHits.join('、')} 次创建命中` : '全部会话创建成功，未复现事故错误')
  } else {
    check('全部会话创建均成功（本次事故的回归断言）', createFailures.length === 0 && createdIds.length === SESSIONS, `${createdIds.length}/${SESSIONS} 成功`)
    check('响应中没有 not lossless JSON / gateway/internal', losslessHits.length === 0, losslessHits.length > 0 ? `命中：第 ${losslessHits.join('、')} 次` : '未命中')
  }
  if (createFailures.length > 0) console.error(`\n宿主日志尾部：\n${logTail(childLog)}`)
  if (createFailures.length > 0) console.error(`\n宿主日志尾部：\n${logTail(childLog)}`)
} catch (error) {
  check('冒烟流程完成', false, error.message)
  if (childLog) console.error(`\n宿主日志尾部：\n${logTail(childLog)}`)
} finally {
  if (tempRoot) {
    if (KEEP) {
      console.log(`\n--keep：已保留现场 ${tempRoot}`)
      console.log(`宿主日志：${hostLogPath}（排查后可手动删除该目录）`)
    } else if (checks.some((item) => !item.ok) && childLog) {
      console.log('\n（未加 --keep：临时目录已在结束时清理；日志尾部见上）')
    }
  }
  cleanup()
}

const failed = checks.filter((item) => !item.ok)
if (failed.length > 0) {
  console.error(`\nverify:host 失败：${failed.length} 项检查未通过（${failed.map((item) => item.name).join('、')}）`)
  process.exit(1)
}
console.log(
  EXPECT_FAIL
    ? '\n反向验证通过：已知坏构建被 verify:host 抓住（复现 not lossless JSON）。'
    : '\nverify:host 通过：隔离宿主可正常创建新会话（无 not lossless JSON）。',
)
process.exit(0)
