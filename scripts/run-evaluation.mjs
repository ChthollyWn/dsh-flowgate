#!/usr/bin/env node
/**
 * FlowGate 对照评测编排脚本（M6 / T6.1）。
 *
 * 一次调用 = 一个「仓库 × 任务 × 条件」的评测单元：
 *   1. 把 examples/<repo> 复制到临时目录（去掉 .git/node_modules/构建产物，
 *      并按标记移除 README 里的隐藏需求/答案表等评分材料）；
 *   2. git init + 基线提交（FlowGate 的范围检测与证据新鲜度依赖 git）；
 *   3. 建隔离 DSH_HOME 里的 headless profile：
 *        A 组 = 纯 headless（DSH 标准模式）
 *        B 组 = headless + link 安装本仓库的 FlowGate 插件；
 *   4. 用 headless 一次性任务跑同一句模糊需求；B 组遇到人工门（GR/G1/G3/G6）
 *      按 `--owner auto` 自动扮演负责人批准并继续下一轮，轮次与动作全部记录；
 *   5. 收集 `.flowgate/metrics/*.json`、`report.html`、git diff/status 统计、
 *      耗时、运行事件流，写入 `docs/evaluation-data/<run-id>/`；
 *   6. 可选跑验收/回归命令（`--no-verify` 关闭）并记录客观结果。
 *
 * 安全与隔离：
 *   - 只有 `DEEPSEEK_API_KEY` 环境变量存在时才真正调用模型；key 只通过子进程
 *     环境传递，绝不写盘、不写进 run.json、不出现在任何日志里。
 *   - `--dry-run` 只做参数/路径/CLI/插件构建产物校验，不创建临时目录、不调用模型。
 *   - `DSH_HOME` 指向本次运行的临时目录，不碰日常 `~/.dsh`；FlowGate 的
 *     `ledger.key` 按插件设计仍落在 `~/.dsh/flowgate/ledger.key`（0600，机器级）。
 *
 * 用法：
 *   node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B --dry-run
 *   DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B
 *   node scripts/run-evaluation.mjs --list
 *
 * 退出码：0 = 成功（含 dry-run 校验通过）；1 = 编排/运行失败；2 = 参数或前置校验失败；
 *         3 = 缺少 DEEPSEEK_API_KEY。
 */
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const DATA_ROOT = join(ROOT, 'docs', 'evaluation-data')
const DEFAULT_DSH =
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const CONTINUATION_PROMPT =
  '继续推进当前变更。按 FlowGate 注入的当前阶段与下一步执行；需要负责人确认时结束本轮并说明。'
/** README 里整节不给 agent 看的章节标题（含评测说明与预期输出）。 */
const HIDDEN_SECTION_RE =
  /^#{1,6}\s+.*(隐藏需求|澄清问题答案表|诱饵与越界设计|预期基线|本机验证记录|风险信号|提示（评测时|手工观察|已知缺陷|验收测试)/
/** 公开章节里仍会泄漏"已知缺陷/验收测试在哪"的行（逐行移除）。 */
const SPOILER_LINE_RE =
  /known[-_]?bugs|RenewalExpiryKnownBugs|真实缺陷|已知缺陷|验收依据|手工观察 R\d|R\d+ ?的 ?bug|R\d+[^\n]{0,24}bug 在这里|隐藏需求清单不给|澄清问题答案表|隐藏需求遗漏数|诱饵|越界|主要改动面|要改|要新增|要加|触发文件|风险改造的目标|不改它|相邻模块|R\d+ ?用|隐藏需求判分|原计划场景/

/**
 * 仓库 / 任务 / 验收命令目录。
 * prompt 必须与各仓库 README 里的模糊描述逐字一致（对照评测的前提）。
 */
const REPOS = {
  'java-renewal': {
    dir: 'examples/java-renewal',
    stack: 'Java 17+ / Spring Boot 3.3 / Maven',
    tasks: {
      'new-feature': {
        label: 'R1 续费优惠叠加',
        aliases: ['R1', 'feature', 'coupon'],
        prompt: '续费想支持优惠券，下单的时候带个券码，金额按折扣算。',
      },
      'fix-bug': {
        label: 'R2 续费后到期日多一天',
        aliases: ['R2', 'bug', 'expiry'],
        prompt: '用户反馈续费之后到期日比应得的多了一天，帮我看看。',
      },
      risk: {
        label: 'R3 回调验签升级 HMAC-SHA256',
        aliases: ['R3', 'risk-refactor', 'refactor', 'hmac'],
        prompt: '支付回调的验签是不是太弱了？帮我升级一下，别影响线上老回调。',
      },
    },
    verify: {
      regression: {
        label: '默认测试套件（回归，基线 20/20）',
        command: ['./mvnw', '-B', 'test'],
        expect: 'green',
      },
      acceptance: {
        label: 'R2 验收测试 RenewalExpiryKnownBugs（修复后应全绿）',
        command: ['./mvnw', '-B', 'test', '-Dtest=RenewalExpiryKnownBugs'],
        expect: 'green',
        tasks: ['fix-bug'],
      },
    },
  },
  'ts-todo-api': {
    dir: 'examples/ts-todo-api',
    stack: 'Node.js ≥ 22 / node:http / node:test',
    tasks: {
      'new-feature': {
        label: 'R1 把待办分享给他人',
        aliases: ['R1', 'feature', 'share'],
        prompt: '待办列表想加个分享功能，能把一条待办分享给别人一起看。',
      },
      'fix-bug': {
        label: 'R2 分页最后一页重复',
        aliases: ['R2', 'bug', 'pagination'],
        prompt: '待办分页好像有问题，翻到最后一页会看到前面出现过的条目，帮我修一下。',
      },
      risk: {
        label: 'R3 密码哈希参数升级',
        aliases: ['R3', 'risk-refactor', 'refactor', 'pbkdf2'],
        prompt: '登录的密码哈希参数是不是太低了？帮我升级一下。',
      },
    },
    verify: {
      regression: {
        label: '默认测试套件（回归，基线 34/34）',
        command: ['pnpm', 'test'],
        expect: 'green',
      },
      acceptance: {
        label: 'R2 验收测试 known-bugs.mjs（修复后应全绿）',
        command: ['node', '--test', 'test/known-bugs.mjs'],
        expect: 'green',
        tasks: ['fix-bug'],
      },
    },
  },
  'py-csv-cli': {
    dir: 'examples/py-csv-cli',
    stack: 'Python ≥ 3.10 / stdlib unittest',
    tasks: {
      'new-feature': {
        label: 'R1 按列去重新增选项',
        aliases: ['R1', 'feature', 'dedupe'],
        prompt: '这个工具加一个去重功能吧，数据里有重复行，导出去重后的结果。',
      },
      'fix-bug': {
        label: 'R2 GBK 文件乱码',
        aliases: ['R2', 'bug', 'gbk'],
        prompt: '客户给的 CSV 打不开，报编码错误，帮我处理一下。',
      },
      risk: {
        label: 'R3 导出手机号脱敏',
        aliases: ['R3', 'risk-refactor', 'refactor', 'mask'],
        prompt: '导出的 CSV 里有用户手机号，合规要求脱敏，帮我改一下。',
      },
    },
    verify: {
      regression: {
        label: '默认测试套件（回归，基线 13/13）',
        command: ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'],
        expect: 'green',
      },
      acceptance: {
        label: 'R2 验收测试 known_bugs.py（修复后应全绿）',
        command: ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-t', '.', '-p', 'known_bugs.py'],
        expect: 'green',
        tasks: ['fix-bug'],
      },
    },
  },
  'greenfield-members': {
    dir: 'examples/greenfield-members',
    stack: '空仓库（从 0 开发，技术栈由项目级澄清决定）',
    stopAfter: 'C1',
    defaultMaxRounds: 12,
    tasks: {
      greenfield: {
        label: '从 0 开发：会员管理系统（路线图 → C0 → C1）',
        aliases: ['from-scratch', 'zero', 'members'],
        prompt: '我们要做一个会员管理系统，第一版能跑起来、能登录就行。',
      },
    },
    verify: {},
  },
}

const METRIC_NAMES = {
  'M-1': '跳步拦截数',
  'M-2': '实际跳步数',
  'M-3': '越界尝试数',
  'M-4': '虚假完成拦截数',
  'M-5': '误判率',
  'M-6': '门禁首次通过率',
  'M-7': '澄清效率',
  'M-8': '需求返工数',
  'M-9': '验收覆盖率',
  'M-10': 'TDD 合规率',
  'M-11': '审查发现',
  'M-12': '回归失败数',
  'M-13': '人工负担',
  'M-14': '阶段成本',
  'M-15': '流程开销',
  'M-16': '路线图进度',
  'M-17': '上下文健康度',
  'M-18': '并行效率',
}

const COPY_SKIP = new Set([
  '.git',
  '.flowgate',
  'node_modules',
  'target',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  '.DS_Store',
])

/** 从仓库 README 中移除隐藏章节（评测时不给 agent 看）。返回处理后的文本与提示。 */
export function stripHiddenSections(text) {
  // 显式标记优先：从 0 开发仓库用 PUBLIC 标记圈出公开部分。
  const begin = '<!-- PUBLIC:BEGIN -->'
  const end = '<!-- PUBLIC:END -->'
  if (text.includes(begin) && text.includes(end)) {
    const start = text.indexOf(begin) + begin.length
    const stop = text.indexOf(end)
    const kept = text.slice(start, stop).trim()
    return { text: `${kept}\n`, mode: 'markers', removed: 1 }
  }
  const lines = text.split('\n')
  const out = []
  let skipping = null // { level } 表示正在跳过隐藏章节
  let fenced = false
  let removed = 0
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const fence = /^\s*```/.test(line)
    if (skipping) {
      // 代码块里的 "# 注释" 不是标题；隐藏章节以「同级或更高级别的标题」结束。
      if (fence) {
        fenced = !fenced
        continue
      }
      if (!fenced && heading && heading[1].length <= skipping.level) {
        skipping = null
      } else {
        continue
      }
    }
    if (heading && HIDDEN_SECTION_RE.test(line)) {
      skipping = { level: heading[1].length }
      fenced = false
      removed += 1
      continue
    }
    if (/^\*\*(隐藏需求清单|风险信号|越界诱饵|提示（评测时)/.test(line)) {
      // 任务小节里的加粗隐藏块：跳到下一个小节标题（### / ##）。
      skipping = { level: 3 }
      removed += 1
      continue
    }
    if (SPOILER_LINE_RE.test(line)) {
      removed += 1
      // 顺带移除紧邻的说明性注释行（如「# 观察 R2 的缺陷」）。
      if (out.length > 0 && /^\s*#/.test(out[out.length - 1]) && /(缺陷|验收|已知|观察)/.test(out[out.length - 1])) {
        out.pop()
      }
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), mode: 'headings', removed }
}

function usage() {
  return `FlowGate 对照评测编排（M6 / T6.1）

用法：
  node scripts/run-evaluation.mjs --repo <仓库> --task <任务> --condition <A|B> [选项]

必填：
  --repo <name>         ${Object.keys(REPOS).join(' | ')}
  --task <name>         任务名或别名（见 --list）
  --condition <A|B>     A = DSH 标准模式；B = DSH + FlowGate

选项：
  --dry-run             只校验参数/路径/CLI，不调用模型、不写文件
  --list                列出仓库与任务（含模糊描述原文）
  --run-id <id>         自定义输出目录名（默认 <时间戳>-<仓库>-<任务>-<条件>）
  --dsh <path>          DSH CLI 路径（默认取 env DSH，再退回桌面端自带路径）
  --dispatch <mode>     B 组派发模式：inline（默认，适配精简 headless）| auto
  --preset-registry     B 组用 --patch overlay 补 @deepseek-ai/dsh-agent-preset-registry，
                        让 cordis.patch.yml 的 preset-flowgate* 行在 headless 组合里激活
                        （dispatch=auto 派发执行者 / --review 审查子 agent 需要）
  --owner <mode>        B 组人工门策略：auto（默认，脚本扮演负责人批准并计数）| manual（遇门即停）
  --auto-pending <k>    B 组自动处理的待处理项 kind 列表，逗号分隔或 none（默认 blocker,plan,rule）。
                        处理方式与人工门一样由脚本扮演负责人 approve 并逐个记账；默认不含 scope/risk
                        （这两类会改变范围/放行风险动作，保留给人工，避免掩盖评测信号）。
  --max-rounds <n>      B 组最多 headless 轮数（默认 8；greenfield 默认 12；A 组固定 1 轮）
  --timeout <seconds>   单轮 headless 超时（默认 1800）
  --review              B 组保留 review.enabled=true（需要子 agent provider；默认关闭）
  --no-run              B 组把 commands.run 覆盖为 none（headless 无法托管长驻服务，避免 spring-boot:start 之类命令挂起）
  --no-verify           不跑验收/回归命令（默认会跑）
  --keep-hidden         复制仓库时保留 README 隐藏章节（不推荐，会向 agent 泄漏评分标准）
  --keep-workdir        保留临时工作目录（排查用；路径会打印）

前置：
  - B 组需要本仓库已构建：pnpm install && pnpm build（lib/host.js 存在）。
  - 真实运行需要 DEEPSEEK_API_KEY（只从环境变量读取，绝不落盘）。
  - 建议先 --dry-run 校验一次。

示例：
  node scripts/run-evaluation.mjs --list
  node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B --dry-run
  DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B
  DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo greenfield-members --task greenfield --condition B --max-rounds 12
`
}

// ---------------------------------------------------------------------------
// 参数解析与计划
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const valueFlags = new Set([
    '--repo',
    '--task',
    '--condition',
    '--run-id',
    '--dsh',
    '--dispatch',
    '--owner',
    '--max-rounds',
    '--timeout',
    '--auto-pending',
  ])
  const boolFlags = new Set([
    '--dry-run',
    '--list',
    '--review',
    '--preset-registry',
    '--no-verify',
    '--no-run',
    '--keep-hidden',
    '--keep-workdir',
    '--help',
  ])
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h') {
      options.help = true
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    if (boolFlags.has(name)) {
      if (equals >= 0) throw new UsageError(`布尔参数 ${name} 不接受取值：${arg}`)
      options[name.slice(2).replaceAll('-', '')] = true
      continue
    }
    if (!valueFlags.has(name)) throw new UsageError(`未知参数：${arg}`)
    const value = equals >= 0 ? arg.slice(equals + 1) : argv[(index += 1)]
    if (value === undefined || value === '') throw new UsageError(`参数 ${name} 缺少取值`)
    options[name.slice(2).replaceAll('-', '')] = value
  }
  return options
}

class UsageError extends Error {}

function resolveRepo(name) {
  const key = String(name ?? '').trim().toLowerCase()
  return REPOS[key] ? { name: key, repo: REPOS[key] } : null
}

function resolveTask(repo, raw) {
  const needle = String(raw ?? '').trim().toLowerCase()
  if (needle === '') return null
  for (const [name, task] of Object.entries(repo.tasks)) {
    if (name === needle || (task.aliases ?? []).some((alias) => alias.toLowerCase() === needle)) {
      return { name, task }
    }
  }
  return null
}

function normalizeCondition(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'a' || value === 'standard') return 'A'
  if (value === 'b' || value === 'flowgate') return 'B'
  return null
}

function stamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function runIdSafe(value) {
  return value.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

async function listDir(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function listRepositoryFiles(dir, depth = 0, limit = 200) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (files.length >= limit) break
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth >= 3) continue
      for (const child of await listRepositoryFiles(full, depth + 1, limit - files.length)) files.push(child)
    } else {
      files.push(relative(dir, full))
    }
  }
  return files
}

async function buildPlan(options) {
  const issues = []
  const warnings = []
  const repoEntry = resolveRepo(options.repo)
  if (!repoEntry) {
    issues.push(
      options.repo
        ? `未知仓库：${options.repo}（可选：${Object.keys(REPOS).join('、')}）`
        : '缺少 --repo（可选：' + Object.keys(REPOS).join('、') + '）',
    )
  }
  const repo = repoEntry?.repo
  const taskEntry = repo ? resolveTask(repo, options.task) : null
  if (repo && !taskEntry) {
    issues.push(
      options.task
        ? `未知任务：${options.task}（${repoEntry.name} 可选：${Object.keys(repo.tasks).join('、')}）`
        : '缺少 --task（用 --list 查看每个仓库的任务）',
    )
  }
  const condition = normalizeCondition(options.condition)
  if (!condition) issues.push('缺少或非法的 --condition（只支持 A 或 B）')

  const repoDir = repo ? join(ROOT, repo.dir) : null
  if (repoDir && !existsSync(repoDir)) issues.push(`示例仓库不存在：${repoDir}`)
  if (repoDir && existsSync(repoDir) && repoEntry.name === 'greenfield-members') {
    const files = await listRepositoryFiles(repoDir)
    const unexpected = files.filter((file) => file !== 'README.md')
    if (unexpected.length > 0) {
      issues.push(
        `greenfield-members 必须是空仓库（只允许 README.md），发现：${unexpected.slice(0, 5).join('、')}${
          unexpected.length > 5 ? ' …' : ''
        }`,
      )
    }
  }

  const dshPath = options.dsh || process.env.DSH || DEFAULT_DSH
  if (!existsSync(dshPath)) {
    issues.push(`找不到 DSH CLI：${dshPath}（用 --dsh 或环境变量 DSH 指定桌面端自带 CLI）`)
  }

  const dispatch = String(options.dispatch ?? 'inline').toLowerCase()
  if (!['inline', 'auto'].includes(dispatch)) issues.push('--dispatch 只支持 inline 或 auto')
  const owner = String(options.owner ?? 'auto').toLowerCase()
  if (!['auto', 'manual'].includes(owner)) issues.push('--owner 只支持 auto 或 manual')
  const presetRegistry = Boolean(options.presetregistry)

  const ALL_PENDING_KINDS = ['scope', 'risk', 'plan', 'rule', 'conflict', 'blocker']
  const autoPendingRaw = String(options.autopending ?? 'blocker,plan,rule').trim().toLowerCase()
  const autoPending =
    autoPendingRaw === '' || autoPendingRaw === 'none'
      ? []
      : [...new Set(autoPendingRaw.split(',').map((kind) => kind.trim()).filter((kind) => kind !== ''))]
  for (const kind of autoPending) {
    if (!ALL_PENDING_KINDS.includes(kind)) {
      issues.push(`--auto-pending 含未知 kind：${kind}（可选：${ALL_PENDING_KINDS.join('、')} 或 none）`)
    }
  }
  if (autoPending.includes('risk') || autoPending.includes('scope')) {
    warnings.push(
      `--auto-pending 含 ${[autoPending.includes('risk') ? 'risk' : '', autoPending.includes('scope') ? 'scope' : '']
        .filter(Boolean)
        .join('/')}：脚本会自动批准风险放行/范围变更，会掩盖流程信号，只在明确要"放行跑通"时使用`,
    )
  }
  if (owner === 'manual' && autoPending.length > 0) {
    warnings.push('--owner manual 时不会自动处理待处理项（--auto-pending 仅对 auto 生效）')
  }

  const maxRounds =
    options['maxrounds'] === undefined
      ? (repo?.defaultMaxRounds ?? 8)
      : Number(options['maxrounds'])
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 50) {
    issues.push('--max-rounds 必须是 1..50 的整数')
  }
  const timeoutSeconds = options.timeout === undefined ? 1800 : Number(options.timeout)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 60) {
    issues.push('--timeout 必须 ≥ 60 秒')
  }

  const defaultRunId = `${stamp()}-${repoEntry?.name ?? 'unknown'}-${taskEntry?.name ?? 'task'}-${
    condition ?? 'X'
  }`
  const runId = runIdSafe(String(options['runid'] ?? defaultRunId))
  if (runId === '') issues.push('--run-id 不能为空')
  const outDir = join(DATA_ROOT, runId)
  if (existsSync(outDir)) issues.push(`输出目录已存在：${relative(ROOT, outDir)}（换一个 --run-id 或先移走）`)

  if (condition === 'B') {
    if (!existsSync(join(ROOT, 'package.json'))) issues.push('FlowGate 仓库缺少 package.json')
    if (!existsSync(join(ROOT, 'lib', 'host.js'))) {
      issues.push('缺少构建产物 lib/host.js（B 组需要先 pnpm install && pnpm build）')
    }
    if (!existsSync(join(ROOT, 'node_modules', 'esbuild', 'package.json'))) {
      issues.push('B 组初始化需要 esbuild（devDependency）：先 pnpm install')
    }
    if (dispatch === 'auto') {
      warnings.push(
        presetRegistry
          ? 'dispatch=auto：已用 --preset-registry 把 agent 预设注册表补进 headless 组合（preset-flowgate* 行应激活；若宿主仍缺包会记录在 skippedBundles）'
          : 'dispatch=auto：headless 组合通常没有 agentPresets 服务，预设行 pending 会让执行者启动失败；建议加 --preset-registry（仍失败则降级）',
      )
    }
    if (presetRegistry && dispatch !== 'auto' && !options.review) {
      warnings.push('--preset-registry 只在 dispatch=auto 或 --review 需要子 agent 时才会产生影响')
    }
  }

  const keyPresent = typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== ''
  if (!keyPresent) {
    warnings.push('未设置 DEEPSEEK_API_KEY：dry-run 不受影响；真实运行会被拒绝（只从环境变量读取 key）')
  }

  const plan = {
    options,
    repoName: repoEntry?.name,
    repo,
    taskName: taskEntry?.name,
    task: taskEntry?.task,
    condition,
    repoDir,
    dshPath,
    dispatch,
    owner,
    maxRounds,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    runId,
    outDir,
    profileName: condition === 'B' ? 'eval-flowgate' : 'eval-standard',
    presetRegistry: condition === 'B' && presetRegistry,
    autoPending: condition === 'B' && owner === 'auto' ? autoPending : [],
    keyPresent,
    issues,
    warnings,
    stopAfter: repo?.stopAfter ?? null,
    sanitize: !options['keephidden'],
    verify: !options['noverify'],
    keepWorkdir: Boolean(options['keepworkdir']),
  }

  if (plan.sanitize && repoDir && existsSync(join(repoDir, 'README.md'))) {
    const readme = await readFile(join(repoDir, 'README.md'), 'utf8')
    const stripped = stripHiddenSections(readme)
    if (stripped.removed === 0) {
      warnings.push('README 未匹配到可移除的隐藏章节（若已改版请确认评分材料不会泄漏给 agent）')
    }
    plan.readmeStripped = stripped.removed
  }
  return plan
}

function printPlan(plan) {
  const relativeOut = relative(ROOT, plan.outDir)
  const repoLabel = plan.repoName ?? '（未指定/未知）'
  const repoDir = plan.repo?.dir ?? '—'
  const taskLabel = plan.taskName ?? '（未指定/未知）'
  const taskDescription = plan.task?.label ?? '—'
  console.log('FlowGate 对照评测（dry-run：不调用模型、不写文件）\n')
  console.log(`  仓库      ${repoLabel}（${repoDir}）`)
  console.log(`  任务      ${taskLabel}「${taskDescription}」`)
  console.log(`  条件      ${plan.condition ?? '—'}（${plan.condition === 'B' ? 'DSH + FlowGate' : plan.condition === 'A' ? 'DSH 标准模式' : '—'}）`)
  console.log(`  DSH CLI   ${plan.dshPath}`)
  console.log(`  运行目录  ${relativeOut}（运行成功后创建）`)
  console.log(
    `  API Key   ${plan.keyPresent ? '已设置（只在真实运行时经环境变量传给子进程，不落盘）' : '未设置（真实运行会拒绝；dry-run 不需要）'}`,
  )
  console.log(`  隔离方式  DSH_HOME=<临时目录>/dsh-home；临时仓库在系统临时目录，结束后删除`)
  console.log(`  输出条件  ${plan.sanitize ? '复制时移除 README 隐藏章节' : '保留 README 隐藏章节（--keep-hidden）'}`)
  if (plan.sanitize) console.log(`  README    将移除 ${plan.readmeStripped ?? 0} 处隐藏/评分相关章节与行`)
  const verifySteps = plan.verify && plan.repo ? Object.keys(plan.repo.verify ?? {}) : []
  const acceptanceRuns = Boolean(
    plan.verify && plan.repo?.verify?.acceptance?.tasks?.includes(plan.taskName),
  )
  console.log(
    `  验收命令  ${
      verifySteps.length === 0
        ? '跳过（该仓库/任务没有预置验收命令，交付物人工核对）'
        : plan.verify
          ? `运行回归测试${acceptanceRuns ? ' + 该任务验收测试' : ''}`
          : '跳过（--no-verify）'
    }`,
  )
  console.log('')

  console.log('计划步骤：')
  const conditionSteps = [
    `复制 ${repoDir} → <临时目录>/repo（跳过 .git/node_modules/构建产物/已有 .flowgate）`,
    'git init + 基线提交（user.email=eval@flowgate.local）',
    `建隔离 headless profile：${plan.profileName}（--from-default-profile headless，DSH_HOME 隔离）`,
  ]
  if (plan.condition === 'B') {
    conditionSteps.push(
      `安装插件：dsh plugin --profile ${plan.profileName} add link:${ROOT}`,
      ...(plan.presetRegistry
        ? ['补 agent preset 注册表 overlay：写 <DSH_HOME>/preset-registry.yml，运行时 --patch 应用']
        : []),
      `校验组合：--dump-config 必须包含 dsh-flowgate`,
      `初始化 FlowGate（等价 /flow init）：生成 .flowgate/，写入 dispatch=${plan.dispatch}、review.enabled=${
        plan.options.review ? 'true' : 'false'
      }`,
      `headless 循环（最多 ${plan.maxRounds} 轮）：dsh --profile ${plan.profileName} --json "<模糊需求>"（cwd=临时仓库）`,
      `人工门策略：${plan.owner === 'auto' ? '自动批准 GR/G1/G3/G6 并记录每次动作' : '遇人工门即停并提示（manual）'}`,
      `待处理项策略：${
        plan.autoPending.length > 0
          ? `自动批准 ${plan.autoPending.join('/')}（其余保留，脚本遇到时停止）`
          : '不自动处理（脚本遇到阻塞类待处理项时停止）'
      }`,
    )
  } else {
    conditionSteps.push(
      `单轮 headless：dsh --profile ${plan.profileName} --json "<模糊需求>"（cwd=临时仓库）`,
      'A 组不启用 FlowGate：不初始化、不产生 .flowgate 产物（指标采集记为空）',
    )
  }
  const commonSteps = [
    plan.condition === 'B'
      ? '收集 .flowgate/metrics/*.json、archive/**/report.html、git status/diff 统计、耗时、headless 事件流'
      : '收集 git status/diff 统计、耗时、headless 事件流（A 组没有 FlowGate 产物）',
    plan.verify ? '跑回归/验收命令并记录客观结果' : '跳过验收命令',
    `写入 ${relativeOut}/（run.json、summary.md、rounds/、metrics/、reports/、git/、verification.json）`,
    '删除临时仓库与临时 DSH_HOME（--keep-workdir 可保留）',
  ]
  ;[...conditionSteps, ...commonSteps].forEach((step, index) => console.log(`  ${index + 1}. ${step}`))
  console.log('')

  const checks = [
    [`DSH CLI 存在：${plan.dshPath}`, existsSync(plan.dshPath)],
    [`示例仓库存在：${repoDir}`, Boolean(plan.repoDir && existsSync(plan.repoDir))],
    [
      `仓库/任务/条件组合合法：${repoLabel} + ${taskLabel} + ${plan.condition ?? '—'}`,
      Boolean(plan.repo && plan.task && plan.condition),
    ],
    [`输出目录可用：${relativeOut}`, !existsSync(plan.outDir)],
  ]
  if (plan.condition === 'B') {
    checks.push(['构建产物 lib/host.js 存在', existsSync(join(ROOT, 'lib', 'host.js'))])
    checks.push(['esbuild 可用（devDependency）', existsSync(join(ROOT, 'node_modules', 'esbuild', 'package.json'))])
  }
  console.log('校验：')
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  if (plan.warnings.length > 0) {
    console.log('\n提示：')
    for (const warning of plan.warnings) console.log(`  ! ${warning}`)
  }
  if (plan.issues.length > 0) {
    console.log('\n阻断项：')
    for (const issue of plan.issues) console.log(`  ✗ ${issue}`)
    console.log('\ndry-run 未通过：先修复上面的阻断项。')
  } else {
    console.log('\ndry-run 通过（0 个阻断项）。真实运行示例：')
    console.log(
      `  DEEPSEEK_API_KEY=<key> node scripts/run-evaluation.mjs --repo ${plan.repoName} --task ${plan.taskName} --condition ${plan.condition}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 进程封装
// ---------------------------------------------------------------------------

/** 跑一个命令并收集 stdout/stderr（有上限），用于短命命令。 */
function spawnCapture(command, args, { cwd, env, timeoutMs = 120_000, captureLimit = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < captureLimit) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < captureLimit) stderr += chunk
    })
    const finish = (code, signal, error) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, error: error ?? null, stdout, stderr, durationMs: Date.now() - startedAt })
    }
    child.on('error', (error) => finish(null, null, error.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** 跑一个命令，把 stdout/stderr 直接流到文件（用于长输出的 headless 运行）。 */
function spawnStream(command, args, { cwd, env, timeoutMs, stdoutPath, stderrPath }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(stdoutPath)
    const err = createWriteStream(stderrPath)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.pipe(out)
    child.stderr.pipe(err)
    const finish = (code, signal, error) => {
      clearTimeout(timer)
      out.end()
      err.end()
      resolve({ code: code ?? null, signal: signal ?? null, timedOut, error: error ?? null, durationMs: Date.now() - startedAt })
    }
    child.on('error', (error) => finish(null, null, error.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function tailText(text, lines = 40, maxChars = 6000) {
  const tail = text.split('\n').slice(-lines).join('\n')
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail
}

// ---------------------------------------------------------------------------
// 复制仓库 / README 消毒 / git 基线
// ---------------------------------------------------------------------------

async function copyRepository(source, destination) {
  let skipped = 0
  const filter = (path) => {
    const name = basename(path)
    if (COPY_SKIP.has(name)) {
      skipped += 1
      return false
    }
    return true
  }
  await cp(source, destination, { recursive: true, filter })
  return { skippedEntries: skipped }
}

async function git(command, cwd, capture = true) {
  return spawnCapture('git', command, {
    cwd,
    env: envWithoutKey(),
    timeoutMs: 120_000,
    captureLimit: capture ? 1024 * 1024 : 1024,
  })
}

async function prepareGitBaseline(workspace) {
  const steps = []
  const run = async (args) => {
    const result = await git(args, workspace)
    steps.push({ command: `git ${args.join(' ')}`, exitCode: result.code })
    return result
  }
  await run(['init', '-q'])
  await run(['config', 'user.email', 'eval@flowgate.local'])
  await run(['config', 'user.name', 'FlowGate Eval'])
  await run(['config', 'commit.gpgsign', 'false'])
  await run(['add', '-A'])
  const commit = await run(['commit', '-q', '-m', 'baseline: evaluation snapshot'])
  if (commit.code !== 0) {
    throw new Error(`git 基线提交失败：${(commit.stderr || commit.stdout).trim().split('\n').slice(-3).join(' ')}`)
  }
  const head = await git(['rev-parse', 'HEAD'], workspace)
  return { baselineCommit: head.stdout.trim(), steps }
}

// ---------------------------------------------------------------------------
// DSH profile 安装与 headless 调用
// ---------------------------------------------------------------------------

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.NODE_OPTIONS
  return env
}

/** 不需要模型凭据的子进程（profile 安装、owner helper、验收命令）：不传 key。 */
function envWithoutKey(extra = {}) {
  const env = childEnv(extra)
  delete env.DEEPSEEK_API_KEY
  return env
}

async function setupHeadlessProfile(plan, dshHome) {
  const steps = []
  const env = envWithoutKey({ DSH_HOME: dshHome })
  const create = await spawnCapture(
    plan.dshPath,
    ['--profile', plan.profileName, '--from-default-profile', 'headless', '--help'],
    { env, timeoutMs: 180_000 },
  )
  steps.push({
    step: 'create-profile',
    command: `dsh --profile ${plan.profileName} --from-default-profile headless --help`,
    exitCode: create.code,
    timedOut: create.timedOut,
    stderrTail: tailText(create.stderr, 10),
  })
  if (create.code !== 0 || create.timedOut) {
    throw new Error(
      `创建 headless profile 失败（exit=${create.code}）：${tailText(create.stderr || create.stdout, 10)}`,
    )
  }

  if (plan.condition === 'B') {
    const link = await spawnCapture(plan.dshPath, ['plugin', '--profile', plan.profileName, 'add', `link:${ROOT}`], {
      env,
      timeoutMs: 600_000,
    })
    steps.push({
      step: 'install-plugin',
      command: `dsh plugin --profile ${plan.profileName} add link:<FlowGate 仓库>`,
      exitCode: link.code,
      timedOut: link.timedOut,
      stderrTail: tailText(link.stderr, 10),
    })
    if (link.code !== 0 || link.timedOut) {
      throw new Error(
        `安装 FlowGate 插件失败（exit=${link.code}）：${tailText(link.stderr || link.stdout, 12)}。需要本仓库已 pnpm install && pnpm build。`,
      )
    }
  }

  const dumpArgs = ['--profile', plan.profileName]
  let patchPath = null
  if (plan.condition === 'B' && plan.presetRegistry) {
    // headless 组合缺 agentPresets 服务时 preset 行会 pending；补注册表行让
    // cordis.patch.yml 里的 flowgate-executor / flowgate-reviewer preset 激活。
    patchPath = join(dshHome, 'preset-registry.yml')
    await writeFile(
      patchPath,
      "- insert:\n    - id: agent-preset-registry\n      name: '@deepseek-ai/dsh-agent-preset-registry'\n      config:\n        default: flowgate\n",
    )
    steps.push({
      step: 'preset-registry-patch',
      command: 'write <DSH_HOME>/preset-registry.yml（--patch overlay）',
      exitCode: 0,
      timedOut: false,
      stderrTail: '',
    })
    dumpArgs.push('--patch', patchPath)
  }
  dumpArgs.push('--dump-config')

  const dump = await spawnCapture(plan.dshPath, dumpArgs, {
    env,
    timeoutMs: 180_000,
  })
  steps.push({
    step: 'dump-config',
    command: `dsh --profile ${plan.profileName} --dump-config`,
    exitCode: dump.code,
    timedOut: dump.timedOut,
  })
  if (dump.code !== 0 || dump.timedOut) {
    throw new Error(`组合配置导出失败（exit=${dump.code}）：${tailText(dump.stderr, 10)}`)
  }
  const pluginLoaded = /dsh-flowgate/.test(dump.stdout)
  if (plan.condition === 'B' && !pluginLoaded) {
    throw new Error(
      '组合配置里没有 dsh-flowgate：插件未生效。检查 profile 安装（dsh plugin add link:）或 DSH 版本兼容性。',
    )
  }
  if (plan.condition === 'A' && pluginLoaded) {
    throw new Error('A 组 profile 里意外出现 dsh-flowgate，标准模式不干净')
  }
  return { steps, pluginLoaded, dumpLines: dump.stdout.split('\n').length, presetRegistry: Boolean(patchPath) }
}

async function runHeadless(plan, { workspace, dshHome, prompt, round, runDir }) {
  const roundsDir = join(runDir, 'rounds')
  await mkdir(roundsDir, { recursive: true })
  const stdoutPath = join(roundsDir, `round-${round}.stdout.jsonl`)
  const stderrPath = join(roundsDir, `round-${round}.stderr.log`)
  const env = childEnv({ DSH_HOME: dshHome })
  const patchArgs = plan.presetRegistry ? ['--patch', join(dshHome, 'preset-registry.yml')] : []
  const result = await spawnStream(plan.dshPath, ['--profile', plan.profileName, ...patchArgs, '--json', prompt], {
    cwd: workspace,
    env,
    timeoutMs: plan.timeoutMs,
    stdoutPath,
    stderrPath,
  })
  const summary = await summarizeHeadless(stdoutPath, stderrPath)
  return {
    round,
    prompt,
    durationMs: result.durationMs,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    error: result.error,
    sessionId: summary.sessionId,
    finalText: summary.finalText,
    finalTextTail: tailText(summary.finalText, 40, 4000),
    events: summary.counts,
    stderrTail: summary.stderrTail,
    stdoutFile: relative(runDir, stdoutPath),
    stderrFile: relative(runDir, stderrPath),
  }
}

async function summarizeHeadless(stdoutPath, stderrPath) {
  const counts = {}
  let sessionId = null
  let finalText = ''
  const errors = []
  if (await fileExists(stdoutPath)) {
    const reader = createInterface({ input: createReadStream(stdoutPath), crlfDelay: Infinity })
    for await (const line of reader) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        counts.unparsed = (counts.unparsed ?? 0) + 1
        continue
      }
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      counts[type] = (counts[type] ?? 0) + 1
      if (type === 'session') {
        sessionId = event.sessionId ?? event.session?.id ?? event.id ?? sessionId
      }
      if (type === 'final') {
        if (typeof event.text === 'string') finalText = event.text
        else if (typeof event.answer === 'string') finalText = event.answer
      }
      if (type === 'error') errors.push(String(event.message ?? JSON.stringify(event)))
    }
  }
  let stderrText = ''
  if (await fileExists(stderrPath)) {
    const size = (await stat(stderrPath)).size
    stderrText = size > 2 * 1024 * 1024 ? (await readFile(stderrPath, 'utf8')).slice(-2 * 1024 * 1024) : await readFile(stderrPath, 'utf8')
  }
  return { counts, sessionId, finalText, errors, stderrTail: tailText(stderrText, 20, 4000) }
}

// ---------------------------------------------------------------------------
// 负责人动作（init / status / approve）：用 esbuild 把 core engine 打成一次性脚本
// ---------------------------------------------------------------------------

const OWNER_ENTRY = `
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { FlowEngine } from '__ENGINE__'
import { NodeFileSystem } from '__NODE_FS__'
import { NodeGit } from '__NODE_GIT__'
import { NodeCommandRunner } from '__NODE_RUNNER__'
import { systemClock } from '__CORE_FS__'

const [action, root, ...args] = process.argv.slice(2)
if (!action || !root) {
      console.error('usage: owner-helper <init|status|approve|reject|doctor|pending|resume> <root> [args...]')
  process.exit(2)
}
const PLUGIN_VERSION = '__VERSION__'

async function ensureLedgerKey() {
  const path = join(homedir(), '.dsh', 'flowgate', 'ledger.key')
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    // 与宿主 ensureLedgerKey 一致：目录 0700、文件 0600。
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const key = randomBytes(32).toString('hex')
  await writeFile(path, key + '\\n', { mode: 0o600 })
  await chmod(path, 0o600)
  return key
}

async function createEngine(rootDir) {
  const engine = new FlowEngine({
    root: rootDir,
    fs: new NodeFileSystem(rootDir),
    clock: systemClock,
    git: new NodeGit(),
    commandRunner: new NodeCommandRunner(),
    pluginVersion: PLUGIN_VERSION,
    ledgerKey: await ensureLedgerKey(),
    sessionId: 'session-eval-owner',
    sessionLabel: 'eval-owner',
  })
  await engine.load()
  return engine
}

async function applyConfigOverrides(rootDir) {
  const raw = process.env.FLOWGATE_EVAL_CONFIG
  if (!raw) return null
  let overrides
  try {
    overrides = JSON.parse(raw)
  } catch {
    return null
  }
  const path = join(rootDir, '.flowgate', 'config.yaml')
  const text = await readFile(path, 'utf8')
  const config = parseYaml(text) ?? {}
  if (overrides.dispatch) config.dispatch = overrides.dispatch
  if (overrides.review) config.review = { ...(config.review ?? {}), ...overrides.review }
  if (overrides.git) config.git = { ...(config.git ?? {}), ...overrides.git }
  if (overrides.commands) config.commands = { ...(config.commands ?? {}), ...overrides.commands }
  await writeFile(path, stringifyYaml(config))
  return config
}

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\\n')
}

async function main() {
  const engine = await createEngine(root)
  try {
    if (action === 'init') {
      let message = 'FlowGate 已经初始化过'
      if (!engine.isInitialized()) {
        const result = await engine.init()
        message = result.message
      }
      const config = await applyConfigOverrides(root)
      print({ ok: true, initialized: true, message, config: config ? { dispatch: config.dispatch, review: config.review, git: config.git } : null })
      return
    }
    if (action === 'status') {
      const snapshot = engine.snapshot()
      const change = engine.currentChange()
      print({
        ok: true,
        status: {
          initialized: engine.isInitialized(),
          changeId: change?.id ?? null,
          title: change?.title ?? null,
          roadmap: change?.roadmap ?? null,
          stage: change?.stage ?? null,
          lifecycle: change?.lifecycle ?? null,
          complexity: snapshot.complexity ?? null,
          risk: snapshot.risk ?? null,
          awaitingGate: snapshot.awaitingGate ?? null,
          pendingGate: snapshot.pendingGate ?? null,
          activeTaskId: snapshot.activeTaskId ?? null,
          off: snapshot.off ?? false,
          locked: snapshot.locked ?? false,
          pending: (snapshot.pending ?? []).map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            status: item.status,
            data: item.data ?? null,
          })),
          activeChanges: engine
            .allChanges()
            .filter((entry) => entry.lifecycle === 'active')
            .map((entry) => ({ id: entry.id, stage: entry.stage, title: entry.title })),
        },
      })
      return
    }
    if (action === 'resume') {
      const changeId = args[0]
      if (!changeId) throw new Error('resume 需要变更编号，例如 resume C-001')
      await engine.resumeChange(changeId, { takeover: true })
      const change = engine.currentChange()
      print({ ok: true, changeId: change?.id ?? changeId, stage: change?.stage ?? null, message: '已接续 ' + changeId + '（takeover）' })
      return
    }
    if (action === 'pending') {
      const id = args[0]
      const decision = args[1]
      if (!id || (decision !== 'approve' && decision !== 'reject')) {
        throw new Error('pending 需要待处理项 id 与 approve|reject，例如 pending BL-1 approve')
      }
      const reason = args.slice(2).join(' ') || 'evaluation harness auto-approve'
      const item = await engine.decidePending(id, decision === 'approve' ? 'approved' : 'rejected', reason)
      print({ ok: true, pending: { id: item.id, kind: item.kind, status: item.status, title: item.title }, message: '待处理项 ' + item.id + ' 已' + (decision === 'approve' ? '批准' : '退回') + '（' + item.kind + '）' })
      return
    }
    if (action === 'approve') {
      const gate = args[0]
      if (!gate) throw new Error('approve 需要门编号，例如 GR / G1 / G3 / G6')
      const result = await engine.approveGate(gate, { reason: args.slice(1).join(' ') || 'evaluation harness auto-approve' })
      print({ ok: true, gate, message: result.message })
      return
    }
    if (action === 'reject') {
      const gate = args[0]
      const reason = args.slice(1).join(' ')
      if (!gate || !reason) throw new Error('reject 需要门编号与意见')
      const result = await engine.rejectGate(gate, reason)
      print({ ok: true, gate, message: result.message })
      return
    }
    if (action === 'doctor') {
      print({ ok: true, report: await engine.doctor() })
      return
    }
    throw new Error('未知 action：' + action)
  } finally {
    await engine.releaseSession().catch(() => undefined)
  }
}

main().catch((error) => {
  print({ ok: false, error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
`

async function buildOwnerHelper(tempDir) {
  const { build } = await import('esbuild')
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version
  const source = OWNER_ENTRY.replaceAll(
    '__ENGINE__',
    join(ROOT, 'src', 'core', 'engine.ts'),
  )
    .replaceAll('__NODE_FS__', join(ROOT, 'src', 'host', 'adapters', 'node-fs.ts'))
    .replaceAll('__NODE_GIT__', join(ROOT, 'src', 'host', 'adapters', 'node-git.ts'))
    .replaceAll('__NODE_RUNNER__', join(ROOT, 'src', 'host', 'adapters', 'node-command-runner.ts'))
    .replaceAll('__CORE_FS__', join(ROOT, 'src', 'core', 'util', 'fs.ts'))
    .replaceAll('__VERSION__', String(version))
  const entryPath = join(tempDir, 'owner-entry.ts')
  const outfile = join(tempDir, 'owner-helper.cjs')
  await mkdir(tempDir, { recursive: true })
  await writeFile(entryPath, source)
  await build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    platform: 'node',
    // yaml 等依赖是 CJS；打成 CJS 一次性脚本最稳（不需要 __require shim）。
    format: 'cjs',
    target: 'node22',
    external: ['@deepseek-ai/*'],
    absWorkingDir: ROOT,
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'silent',
  })
  return outfile
}

async function ownerAction(helperPath, action, workspace, args = [], config = null) {
  const env = envWithoutKey(config ? { FLOWGATE_EVAL_CONFIG: JSON.stringify(config) } : {})
  const result = await spawnCapture(process.execPath, [helperPath, action, workspace, ...args], {
    env,
    timeoutMs: 180_000,
    captureLimit: 2 * 1024 * 1024,
  })
  const lines = result.stdout.trim().split('\n').filter((line) => line.trim() !== '')
  let payload = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      payload = JSON.parse(lines[index])
      break
    } catch {
      // 继续往前找
    }
  }
  return {
    ok: result.code === 0 && payload !== null && payload.ok !== false,
    exitCode: result.code,
    timedOut: result.timedOut,
    payload,
    stderrTail: tailText(result.stderr, 20, 4000),
    stdoutTail: tailText(result.stdout, 20, 4000),
  }
}

// ---------------------------------------------------------------------------
// 产物收集
// ---------------------------------------------------------------------------

async function copyIfExists(source, destination) {
  if (!existsSync(source)) return false
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
  return true
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function collectArtifacts({ plan, workspace, baseline, runDir, rounds, ownerActions, setup, readmeInfo, copyInfo }) {
  const collected = {
    metrics: [],
    reports: [],
    flowgateFiles: [],
    archive: [],
    git: null,
  }
  if (!workspace || !existsSync(workspace)) return collected
  const flowgateDir = join(workspace, '.flowgate')
  // A 组（标准模式）不启用 FlowGate：即使出现 .flowgate/ 也不当作评测产物，
  // 只记录"意外出现"供数据完整性核对。
  if (plan.condition !== 'B') {
    collected.flowgateUnexpected = existsSync(flowgateDir)
    collected.git = await collectGitStats(workspace, baseline, join(runDir, 'git'))
    collected.rounds = rounds.map((round) => ({
      round: round.round,
      durationMs: round.durationMs,
      exitCode: round.exitCode,
      timedOut: round.timedOut,
      sessionId: round.sessionId,
      events: round.events,
      stdoutFile: round.stdoutFile,
      stderrFile: round.stderrFile,
      finalTextTail: typeof round.finalTextTail === 'string' ? round.finalTextTail.slice(0, 2000) : null,
    }))
    collected.ownerActions = ownerActions
    collected.workspaceBaseline = baseline
    collected.copy = copyInfo
    collected.readme = readmeInfo
    collected.setup = setup
    return collected
  }

  // 1) .flowgate/metrics/*.json
  for (const name of await listDir(join(flowgateDir, 'metrics'))) {
    if (!name.endsWith('.json')) continue
    const source = join(flowgateDir, 'metrics', name)
    await copyIfExists(source, join(runDir, 'metrics', name))
    const parsed = await readJsonIfExists(source)
    if (parsed) collected.metrics.push(parsed)
  }

  // 2) report.html（archive/<日期>-<变更>/ 与 changes/<变更>/ 两处都收）
  for (const dirName of await listDir(join(flowgateDir, 'archive'))) {
    const report = join(flowgateDir, 'archive', dirName, 'report.html')
    if (!(await fileExists(report))) continue
    await copyIfExists(report, join(runDir, 'reports', `${dirName}.html`))
    collected.reports.push(`reports/${dirName}.html`)
    const status = await readJsonIfExists(join(flowgateDir, 'archive', dirName, 'status.json'))
    collected.archive.push({ dir: dirName, changeId: status?.change ?? null, roadmap: status?.roadmap ?? null, title: status?.title ?? null })
  }
  for (const dirName of await listDir(join(flowgateDir, 'changes'))) {
    const report = join(flowgateDir, 'changes', dirName, 'report.html')
    if (!(await fileExists(report))) continue
    await copyIfExists(report, join(runDir, 'reports', `${dirName}.html`))
    if (!collected.reports.includes(`reports/${dirName}.html`)) collected.reports.push(`reports/${dirName}.html`)
  }

  // 3) 状态/规格等关键文件快照（不复制 state/ 与 worktrees/）
  const wanted = [
    'config.yaml',
    'project.md',
    'project-clarify.md',
    'roadmap.md',
    'ledger.jsonl',
    'changes/index.md',
    'dashboard.html',
  ]
  for (const relativePath of wanted) {
    const source = join(flowgateDir, relativePath)
    if (!(await fileExists(source))) continue
    if (relativePath === 'ledger.jsonl') {
      const size = (await stat(source)).size
      if (size <= 8 * 1024 * 1024) {
        await copyIfExists(source, join(runDir, 'flowgate', relativePath))
        collected.flowgateFiles.push(relativePath)
      } else {
        await writeFile(
          join(runDir, 'flowgate', 'ledger-summary.json'),
          `${JSON.stringify({ note: 'ledger 超过 8MB，未复制原始文件', bytes: size }, null, 2)}\n`,
        )
        collected.flowgateFiles.push('ledger-summary.json')
      }
      continue
    }
    await copyIfExists(source, join(runDir, 'flowgate', relativePath))
    collected.flowgateFiles.push(relativePath)
  }
  for (const dirName of await listDir(join(flowgateDir, 'changes'))) {
    const statusPath = join(flowgateDir, 'changes', dirName, 'status.json')
    if (!(await fileExists(statusPath))) continue
    await copyIfExists(statusPath, join(runDir, 'flowgate', 'changes', dirName, 'status.json'))
    collected.flowgateFiles.push(`changes/${dirName}/status.json`)
  }

  // 4) git 统计（相对基线提交，包含已提交 + 未提交 + 未跟踪清单）
  collected.git = await collectGitStats(workspace, baseline, join(runDir, 'git'))

  Object.assign(collected, {
    workspaceBaseline: baseline,
    copy: copyInfo,
    readme: readmeInfo,
    setup,
    rounds: rounds.map((round) => ({
      round: round.round,
      durationMs: round.durationMs,
      exitCode: round.exitCode,
      timedOut: round.timedOut,
      sessionId: round.sessionId,
      events: round.events,
      stdoutFile: round.stdoutFile,
      stderrFile: round.stderrFile,
      finalTextTail: typeof round.finalTextTail === 'string' ? round.finalTextTail.slice(0, 2000) : null,
    })),
    ownerActions,
  })
  return collected
}

async function collectGitStats(workspace, baseline, gitDir) {
  await mkdir(gitDir, { recursive: true })
  const run = (args) =>
    spawnCapture('git', args, {
      cwd: workspace,
      env: envWithoutKey(),
      timeoutMs: 60_000,
      captureLimit: 2 * 1024 * 1024,
    })
  const status = await run(['status', '--porcelain=v1'])
  const diffStat = await run(['diff', '--stat', baseline])
  const numstat = await run(['diff', '--numstat', baseline])
  const untracked = await run(['ls-files', '--others', '--exclude-standard'])
  const log = await run(['log', '--oneline', `${baseline}..HEAD`])
  const patch = await run(['diff', baseline])
  await writeFile(join(gitDir, 'status.txt'), status.stdout)
  await writeFile(join(gitDir, 'diff-stat.txt'), diffStat.stdout)
  await writeFile(join(gitDir, 'diff-numstat.txt'), numstat.stdout)
  await writeFile(join(gitDir, 'untracked.txt'), untracked.stdout)
  await writeFile(join(gitDir, 'log.txt'), log.stdout)
  const patchBytes = Buffer.byteLength(patch.stdout, 'utf8')
  if (patchBytes <= 4 * 1024 * 1024) await writeFile(join(gitDir, 'diff.patch'), patch.stdout)
  else await writeFile(join(gitDir, 'diff.patch.skipped.txt'), `diff 超过 4MB（${patchBytes} bytes），未保存完整 patch\n`)

  let insertions = 0
  let deletions = 0
  const changedFiles = []
  for (const line of numstat.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!match) continue
    insertions += match[1] === '-' ? 0 : Number(match[1])
    deletions += match[2] === '-' ? 0 : Number(match[2])
    changedFiles.push(match[3])
  }
  const statusLines = status.stdout.split('\n').filter((line) => line.trim() !== '')
  const untrackedLines = untracked.stdout.split('\n').filter((line) => line.trim() !== '')
  return {
    baselineCommit: baseline,
    statusEntries: statusLines.length,
    changedFiles: changedFiles.length,
    changedFileList: changedFiles.slice(0, 200),
    insertions,
    deletions,
    untrackedFiles: untrackedLines.length,
    untrackedFileList: untrackedLines.slice(0, 200),
    commitsSinceBaseline: log.stdout.split('\n').filter((line) => line.trim() !== '').length,
    patchSaved: patchBytes <= 4 * 1024 * 1024,
    patchBytes,
    files: {
      status: 'git/status.txt',
      diffStat: 'git/diff-stat.txt',
      diffNumstat: 'git/diff-numstat.txt',
      untracked: 'git/untracked.txt',
      log: 'git/log.txt',
    },
  }
}

// ---------------------------------------------------------------------------
// 验收 / 回归命令
// ---------------------------------------------------------------------------

function parseTestCounts(text, repoName) {
  const parsed = { tests: null, failures: null, errors: null, passed: null, verdict: null }
  const maven = [...text.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+)/g)].pop()
  const node = [...text.matchAll(/ℹ\s*tests (\d+)[\s\S]{0,200}?ℹ\s*pass (\d+)[\s\S]{0,200}?ℹ\s*fail (\d+)/g)].pop()
  const pythonRan = /Ran (\d+) tests?/.exec(text)
  const pythonVerdict = /(OK|FAILED \((?:failures=\d+)?(?:, )?(?:errors=\d+)?\))/.exec(text)
  if (repoName === 'java-renewal' && maven) {
    parsed.tests = Number(maven[1])
    parsed.failures = Number(maven[2])
    parsed.errors = Number(maven[3])
    parsed.passed = parsed.tests - parsed.failures - parsed.errors
    parsed.verdict = parsed.failures + parsed.errors === 0 ? 'green' : 'red'
  } else if (repoName === 'ts-todo-api' && node) {
    parsed.tests = Number(node[1])
    parsed.passed = Number(node[2])
    parsed.failures = Number(node[3])
    parsed.errors = 0
    parsed.verdict = parsed.failures === 0 ? 'green' : 'red'
  } else if (repoName === 'py-csv-cli' && pythonRan) {
    parsed.tests = Number(pythonRan[1])
    const failed = /FAILED \((.*)\)/.exec(text)
    parsed.failures = failed ? (/(?:failures=(\d+))/.exec(failed[1])?.[1] ?? 0) : 0
    parsed.errors = failed ? (/(?:errors=(\d+))/.exec(failed[1])?.[1] ?? 0) : 0
    parsed.failures = Number(parsed.failures)
    parsed.errors = Number(parsed.errors)
    parsed.passed = parsed.tests - parsed.failures - parsed.errors
    parsed.verdict = pythonVerdict?.[1] === 'OK' ? 'green' : 'red'
  }
  return parsed
}

async function runVerification({ plan, workspace, runDir, rounds }) {
  const verifySteps = []
  const catalog = plan.repo.verify ?? {}
  if (catalog.regression) verifySteps.push({ kind: 'regression', ...catalog.regression })
  if (catalog.acceptance && (catalog.acceptance.tasks ?? []).includes(plan.taskName)) {
    verifySteps.push({ kind: 'acceptance', ...catalog.acceptance })
  }
  const results = []
  if (verifySteps.length > 0) {
    for (const step of verifySteps) {
      const [command, ...args] = step.command
      const startedAt = Date.now()
      const result = await spawnCapture(command, args, {
        cwd: workspace,
        env: envWithoutKey(),
        timeoutMs: 600_000,
        captureLimit: 4 * 1024 * 1024,
      })
      const combined = `${result.stdout}\n${result.stderr}`
      const parsed = parseTestCounts(combined, plan.repoName)
      results.push({
        kind: step.kind,
        label: step.label,
        command: step.command.join(' '),
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt,
        expected: step.expect,
        parsed,
        status:
          result.timedOut || result.code === null
            ? 'unknown'
            : parsed.verdict ?? (result.code === 0 ? 'green' : 'red'),
        outputTail: tailText(combined, 60),
      })
    }
  }
  const verification = {
    generatedAt: new Date().toISOString(),
    repo: plan.repoName,
    task: plan.taskName,
    condition: plan.condition,
    rounds: rounds.length,
    skipped: verifySteps.length === 0,
    note:
      verifySteps.length === 0
        ? '该仓库/任务没有预置的本地验收命令（greenfield 的验收在 C0/C1 交付物中人工核对）'
        : '回归 = 默认测试套件；acceptance = 该任务的已知缺陷验收测试（修复后应全绿）',
    results,
  }
  await writeFile(join(runDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`)
  return verification
}

// ---------------------------------------------------------------------------
// run.json / summary.md
// ---------------------------------------------------------------------------

function metricsSummary(metricsSets) {
  if (!Array.isArray(metricsSets) || metricsSets.length === 0) return null
  const latest = [...metricsSets].sort(
    (left, right) => String(left.generatedAt ?? '').localeCompare(String(right.generatedAt ?? '')),
  )[metricsSets.length - 1]
  const rows = Object.entries(METRIC_NAMES).map(([id, name]) => ({
    id,
    name,
    value: latest.metrics?.[id] ?? null,
    note: latest.notes?.[id] ?? null,
  }))
  return { changeId: latest.changeId, generatedAt: latest.generatedAt, rows }
}

async function writeRunRecord({
  plan,
  runDir,
  state,
  baseline,
  setup,
  collected,
  verification,
  startedAt,
  finishedAt,
  error,
}) {
  const metrics = metricsSummary(collected?.metrics)
  const run = {
    runId: plan.runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status: error ? 'failed' : 'completed',
    error: error ?? null,
    repo: plan.repoName,
    repoPath: plan.repo.dir,
    stack: plan.repo.stack,
    task: plan.taskName,
    taskLabel: plan.task.label,
    prompt: plan.task.prompt,
    condition: plan.condition,
    conditionLabel: plan.condition === 'B' ? 'DSH + FlowGate' : 'DSH 标准模式',
    dsh: {
      cli: plan.dshPath,
      profile: plan.profileName,
      isolatedDshHome: true,
      presetRegistry: Boolean(plan.presetRegistry),
      keySource: plan.keyPresent ? 'DEEPSEEK_API_KEY 环境变量（未落盘）' : '未提供',
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    workspace: {
      baselineCommit: baseline?.baselineCommit ?? null,
      readmeSanitized: plan.sanitize,
      readmeHiddenSectionsRemoved: plan.readmeStripped ?? null,
      copiedWithSkips: collected?.copy ?? null,
      kept: plan.keepWorkdir,
    },
    flowgate: {
      root: ROOT,
      initialized: plan.condition === 'B' ? Boolean(collected?.flowgateFiles?.length) : false,
      pluginLoaded: setup?.pluginLoaded ?? null,
      pluginInstallSteps: setup?.steps ?? [],
      configOverrides:
        plan.condition === 'B'
          ? {
              dispatch: plan.dispatch,
              review: { enabled: Boolean(plan.options.review) },
              autoPending: plan.autoPending,
              ...(plan.options.norun ? { commands: { run: 'none' } } : {}),
            }
          : null,
    },
    rounds: collected?.rounds ?? [],
    ownerActions: collected?.ownerActions ?? [],
    artifacts: {
      metricsSets: collected?.metrics?.length ?? 0,
      reports: collected?.reports ?? [],
      flowgateFiles: collected?.flowgateFiles ?? [],
      archive: collected?.archive ?? [],
      flowgateUnexpected: collected?.flowgateUnexpected ?? false,
      git: collected?.git ?? null,
    },
    verification,
    metrics,
    notes: plan.warnings,
  }
  await writeFile(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)

  const lines = []
  lines.push(`# 评测运行 ${plan.runId}`)
  lines.push('')
  lines.push(`- 时间：${run.startedAt} → ${run.finishedAt}（${formatDuration(run.durationMs)}）`)
  lines.push(`- 仓库：${plan.repoName}（${plan.repo.stack}）`)
  lines.push(`- 任务：${plan.taskName}「${plan.task.label}」`)
  lines.push(`- 条件：${run.conditionLabel}（${plan.condition}）`)
  lines.push(`- 状态：${error ? `失败：${error}` : '完成'}`)
  lines.push('')
  lines.push('## 提示词（发给 agent 的原话）')
  lines.push('')
  lines.push(`> ${plan.task.prompt}`)
  lines.push('')
  lines.push('## 执行轮次')
  lines.push('')
  if ((collected?.rounds ?? []).length === 0) {
    lines.push('（没有完成任何 headless 轮次）')
  } else {
    lines.push('| 轮次 | 耗时 | 退出码 | 超时 | session | 事件统计 |')
    lines.push('|---|---|---|---|---|---|')
    for (const round of collected.rounds) {
      lines.push(
        `| ${round.round} | ${formatDuration(round.durationMs)} | ${round.exitCode ?? 'null'} | ${
          round.timedOut ? '是' : '否'
        } | ${round.sessionId ?? '—'} | ${JSON.stringify(round.events ?? {})} |`,
      )
    }
  }
  const lastReply = [...(state?.rounds ?? [])].reverse().find((round) => round.finalTextTail)
  if (lastReply) {
    lines.push('')
    lines.push('## 最后一轮 agent 最终答复（截断，供人工判断"虚假完成"）')
    lines.push('')
    lines.push('```text')
    lines.push(String(lastReply.finalTextTail).slice(0, 4000))
    lines.push('```')
  }
  lines.push('')
  lines.push('## 人工门动作（脚本扮演负责人）')
  lines.push('')
  if ((collected?.ownerActions ?? []).length === 0) {
    lines.push(plan.condition === 'A' ? 'A 组不涉及 FlowGate 人工门。' : '（无）')
  } else {
    lines.push('| 轮次 | 动作 | 门 | 结果 | 说明 |')
    lines.push('|---|---|---|---|---|')
    for (const action of collected.ownerActions) {
      lines.push(
        `| ${action.afterRound ?? '—'} | ${action.action} | ${action.gate ?? '—'} | ${action.ok ? '成功' : '失败'} | ${
          (action.message ?? action.detail ?? '').replaceAll('|', '\\|').slice(0, 160)
        } |`,
      )
    }
  }
  lines.push('')
  lines.push('## FlowGate 指标（B 组）')
  lines.push('')
  if (!metrics) {
    lines.push(
      plan.condition === 'B'
        ? '未收集到 .flowgate/metrics/*.json（变更未走到生成指标的阶段，或运行失败）。'
        : 'A 组不启用 FlowGate，没有指标（预期）。',
    )
  } else {
    lines.push(`变更 ${metrics.changeId}（生成于 ${metrics.generatedAt}）：`)
    lines.push('')
    lines.push('| ID | 指标 | 数值 | 口径说明 |')
    lines.push('|---|---|---|---|')
    for (const row of metrics.rows) {
      lines.push(
        `| ${row.id} | ${row.name} | ${row.value === null ? '—' : String(row.value)} | ${(row.note ?? '').replaceAll('|', '\\|')} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 交付与变更统计')
  lines.push('')
  lines.push(`- 交付报告：${run.artifacts.reports.length > 0 ? run.artifacts.reports.join('、') : '无'}`)
  if (run.artifacts.git) {
    lines.push(
      `- git（相对基线 ${run.artifacts.git.baselineCommit?.slice(0, 10)}）：${run.artifacts.git.changedFiles} 个文件，+${run.artifacts.git.insertions}/-${run.artifacts.git.deletions}，未跟踪 ${run.artifacts.git.untrackedFiles} 个，提交 ${run.artifacts.git.commitsSinceBaseline} 次`,
    )
    if (run.artifacts.git.changedFileList?.length > 0) {
      lines.push(`- 改动文件：${run.artifacts.git.changedFileList.slice(0, 30).join('、')}`)
    }
  } else {
    lines.push('- git：未收集到（工作区不存在）')
  }
  lines.push('')
  lines.push('## 验收 / 回归结果')
  lines.push('')
  if (!verification || verification.skipped) {
    lines.push(verification?.note ?? '（未运行验收命令）')
  } else {
    lines.push('| 类型 | 命令 | 期望 | 结果 | 解析计数 | 耗时 |')
    lines.push('|---|---|---|---|---|---|')
    for (const result of verification.results) {
      const counts = result.parsed
      const countText =
        counts.tests === null && counts.failures === null
          ? '未解析'
          : `tests=${counts.tests ?? '?'} fail=${counts.failures ?? '?'} err=${counts.errors ?? '?'}`
      lines.push(
        `| ${result.kind} | \`${result.command}\` | ${result.expected} | ${result.status}（exit ${result.exitCode}） | ${countText} | ${formatDuration(result.durationMs)} |`,
      )
    }
  }
  lines.push('')
  lines.push('## 产物清单')
  lines.push('')
  lines.push(`- 运行记录：\`${relative(ROOT, join(runDir, 'run.json'))}\``)
  lines.push(`- 单轮事件流：\`${relative(ROOT, join(runDir, 'rounds'))}/\``)
  lines.push(
    `- 指标 JSON：${run.artifacts.metricsSets} 个（\`${relative(ROOT, join(runDir, 'metrics'))}/\`）`,
  )
  lines.push(`- 报告：${run.artifacts.reports.length} 个（\`${relative(ROOT, join(runDir, 'reports'))}/\`）`)
  lines.push(`- FlowGate 快照：${run.artifacts.flowgateFiles.length} 个（\`${relative(ROOT, join(runDir, 'flowgate'))}/\`）`)
  lines.push(`- git 统计：\`${relative(ROOT, join(runDir, 'git'))}/\``)
  if (run.artifacts.flowgateUnexpected) {
    lines.push('- 注意：A 组工作区出现了 `.flowgate/`（标准模式不应出现），请核对数据完整性。')
  }
  lines.push('')
  lines.push('## 说明与局限')
  lines.push('')
  lines.push('- 隐藏需求遗漏数、越界文件数、虚假完成次数、验收覆盖率按各仓库 README 的清单人工核对；脚本只收集客观信号（测试、diff、指标、报告）。')
  lines.push('- headless 的「被问到才答」澄清无法自动完成：agent 若调用结构化提问而宿主组合不支持，会退化为写假设；这类交互质量需人工复盘事件流。')
  lines.push('- 脚本扮演负责人自动批准人工门，因此 M-13（人工负担）记录的是「门禁次数」，不是真实人类响应时间。')
  lines.push('- B 组默认 `dispatch=inline`、`review.enabled=false`（精简 headless 没有 subagent provider）；要测派发/审查需要换成带 provider 的组合。')
  lines.push('- 需要长驻服务（如 Spring Boot）的项目可用 `--no-run` 把 B 组 `commands.run` 覆盖为 `none`，避免 `spring-boot:start` 之类命令在 headless 里挂起；A 组不受影响。')
  await writeFile(join(runDir, 'summary.md'), `${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function runEvaluation(plan) {
  const startedAt = new Date()
  await mkdir(DATA_ROOT, { recursive: true })
  await mkdir(plan.outDir, { recursive: true })
  const tempRoot = await mkdtemp(join(tmpdir(), 'flowgate-eval-'))
  const workspace = join(tempRoot, 'repo')
  const dshHome = join(tempRoot, 'dsh-home')
  const ownerDir = join(tempRoot, 'owner')
  const state = { rounds: [], ownerActions: [], setup: null, copyInfo: null, readmeInfo: null, baseline: null, helperPath: null }
  let error = null
  let collected = null
  let verification = null

  console.log(`评测开始：${plan.repoName} / ${plan.taskName} / 条件 ${plan.condition}`)
  console.log(`  输出目录：${relative(ROOT, plan.outDir)}`)
  try {
    console.log('1/6 复制示例仓库并移除评分材料…')
    state.copyInfo = await copyRepository(plan.repoDir, workspace)
    if (plan.sanitize) {
      const readmePath = join(workspace, 'README.md')
      if (await fileExists(readmePath)) {
        const stripped = stripHiddenSections(await readFile(readmePath, 'utf8'))
        await writeFile(readmePath, stripped.text)
        state.readmeInfo = { mode: stripped.mode, sectionsRemoved: stripped.removed }
      }
    }
    console.log(`2/6 git 初始化并做基线提交…`)
    state.baseline = await prepareGitBaseline(workspace)
    console.log(`  基线 ${state.baseline.baselineCommit.slice(0, 10)}`)
    console.log(`3/6 建隔离 DSH 环境（${plan.profileName}）…`)
    state.setup = await setupHeadlessProfile(plan, dshHome)

    if (plan.condition === 'B') {
      console.log('4/6 初始化 FlowGate（等价 /flow init）…')
      state.helperPath = await buildOwnerHelper(ownerDir)
      const config = {
        dispatch: plan.dispatch,
        review: { enabled: Boolean(plan.options.review) },
        ...(plan.options.norun ? { commands: { run: 'none' } } : {}),
      }
      const init = await ownerAction(state.helperPath, 'init', workspace, [], config)
      if (!init.ok) {
        throw new Error(`FlowGate 初始化失败：${init.payload?.error ?? init.stderrTail ?? init.stdoutTail}`)
      }
      if (!existsSync(join(workspace, '.flowgate', 'config.yaml'))) {
        throw new Error('FlowGate 初始化后没有 .flowgate/config.yaml')
      }
      state.ownerActions.push({
        afterRound: 0,
        action: 'init',
        gate: null,
        ok: true,
        message: init.payload?.message ?? 'FlowGate 已初始化',
      })
      console.log(`  已初始化：dispatch=${plan.dispatch}，review.enabled=${Boolean(plan.options.review)}`)
    } else {
      console.log('4/6 A 组：不安装插件、不初始化 FlowGate')
    }

    console.log('5/6 headless 运行…')
    const rounds = plan.condition === 'A' ? 1 : plan.maxRounds
    const delivered = new Set()
    let archiveCount = 0
    let stalledRounds = 0
    // 脚本自动批准待处理项的次数：每次批准都让 agent 能继续推进，不能算"没有进展"。
    let autoResolvedCount = 0
    let previousSignature = ''
    const refreshDelivered = async () => {
      const archiveDirs = await listDir(join(workspace, '.flowgate', 'archive'))
      archiveCount = archiveDirs.length
      for (const archiveDir of archiveDirs) {
        const archived = await readJsonIfExists(join(workspace, '.flowgate', 'archive', archiveDir, 'status.json'))
        if (archived?.roadmap) delivered.add(String(archived.roadmap).trim().toUpperCase())
      }
    }
    // 非 greenfield：交付第一个变更即完成；greenfield：交付到 stopAfter（默认 C1）。
    const goalReached = () => (plan.stopAfter ? delivered.has(plan.stopAfter) : archiveCount > 0)
    const goalText = () =>
      plan.stopAfter ? `路线图 ${plan.stopAfter} 已交付` : `已交付 ${archiveCount} 个变更`

    for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
      const prompt = roundIndex === 1 ? plan.task.prompt : CONTINUATION_PROMPT
      console.log(`  第 ${roundIndex}/${rounds} 轮（约 ${formatDuration(plan.timeoutMs)} 超时）…`)
      const round = await runHeadless(plan, { workspace, dshHome, prompt, round: roundIndex, runDir: plan.outDir })
      state.rounds.push(round)
      console.log(
        `  第 ${roundIndex} 轮结束：exit=${round.exitCode}，${formatDuration(round.durationMs)}，事件 ${JSON.stringify(
          round.events,
        )}`,
      )
      if (plan.condition === 'A') break
      if (round.exitCode !== 0 || round.timedOut) {
        console.log('  headless 非 0 退出或超时，停止后续轮次')
        break
      }
      const status = await ownerAction(state.helperPath, 'status', workspace)
      if (!status.ok || !status.payload?.status) {
        console.log(`  读取 FlowGate 状态失败：${status.payload?.error ?? status.stderrTail}`)
        break
      }
      let snapshot = status.payload.status
      const openPending = Array.isArray(snapshot.pending) ? snapshot.pending : []
      console.log(
        `  状态：${snapshot.changeId ?? '无变更'} / ${snapshot.stage ?? '—'} / ${
          snapshot.lifecycle ?? '—'
        }${snapshot.awaitingGate ? ` / 等待 ${snapshot.awaitingGate}` : ''}${
          openPending.length > 0 ? ` / 待处理 ${openPending.map((item) => `${item.id}(${item.kind})`).join(',')}` : ''
        }`,
      )
      await refreshDelivered()
      if (goalReached()) {
        console.log(`  ${goalText()}，结束轮次`)
        break
      }
      // 上一轮 headless 进程结束后可能留下会话租约（并行派发中断时尤其常见）：
      // owner helper 是独立进程，拿不到 current 不代表没有进行中的变更。
      // 若恰好有一个 active 变更，就替负责人执行 resume --takeover 后继续。
      if (!snapshot.changeId && Array.isArray(snapshot.activeChanges) && snapshot.activeChanges.length === 1) {
        const active = snapshot.activeChanges[0]
        const resumed = await ownerAction(state.helperPath, 'resume', workspace, [String(active.id)])
        state.ownerActions.push({
          afterRound: roundIndex,
          action: 'resume',
          gate: null,
          ok: resumed.ok,
          message: resumed.payload?.message ?? resumed.payload?.error ?? resumed.stderrTail,
        })
        console.log(
          `  接续 ${active.id}（${active.stage ?? '?'}）：${resumed.ok ? '已 takeover' : `失败：${resumed.payload?.error ?? resumed.stderrTail}`}`,
        )
        if (resumed.ok) {
          const refreshed = await ownerAction(state.helperPath, 'status', workspace)
          if (refreshed.ok && refreshed.payload?.status) snapshot = refreshed.payload.status
        }
      }
      // 待处理项（阻塞/计划修订/规则提议等）：按 --auto-pending 由脚本扮演负责人处理，
      // 否则 agent 会停在"等负责人确认"上（2026-10-31 greenfield 演练的 T-FAILURE-LIMIT 即此类）。
      const autoResolvable = openPending.filter((item) => plan.autoPending.includes(item.kind))
      if (openPending.length > 0) {
        if (plan.owner === 'manual') {
          state.ownerActions.push({
            afterRound: roundIndex,
            action: 'awaiting-manual-pending',
            gate: null,
            ok: false,
            message: `manual 模式：等待负责人处理待处理项 ${openPending.map((item) => item.id).join(',')}`,
          })
          console.log('  等待负责人处理待处理项（--owner manual，停止）')
          break
        }
        for (const item of autoResolvable) {
          const resolved = await ownerAction(state.helperPath, 'pending', workspace, [
            String(item.id),
            'approve',
            `evaluation harness auto-approve ${item.kind}`,
          ])
          state.ownerActions.push({
            afterRound: roundIndex,
            action: 'pending-approve',
            gate: null,
            pendingId: item.id,
            kind: item.kind,
            ok: resolved.ok,
            message: resolved.payload?.message ?? resolved.payload?.error ?? resolved.stderrTail,
          })
          console.log(
            `  待处理项 ${item.id}（${item.kind}）${resolved.ok ? '已自动批准' : `自动批准失败：${resolved.payload?.error ?? resolved.stderrTail}`}`,
          )
          if (resolved.ok) autoResolvedCount += 1
          if (!resolved.ok) break
        }
        if (autoResolvable.length > 0) {
          // 处理完后重新读取状态：阻塞解除/门禁状态可能变化。
          const refreshed = await ownerAction(state.helperPath, 'status', workspace)
          if (refreshed.ok && refreshed.payload?.status) {
            snapshot = refreshed.payload.status
            const remaining = Array.isArray(snapshot.pending) ? snapshot.pending : []
            if (remaining.length > 0) {
              console.log(
                `  仍有未自动处理的待处理项：${remaining
                  .map((item) => `${item.id}(${item.kind})`)
                  .join(',')}（--auto-pending=${plan.autoPending.join(',') || 'none'}）`,
              )
            }
          }
        }
      }
      // 连续两轮状态没有变化（没有新变更、阶段、人工门、待处理项、自动解锁、归档）时停止，避免空转。
      // 自动批准待处理项本身也是进展（agent 下一轮可以继续），计数进 signature。
      const signature = `${snapshot.changeId ?? ''}|${snapshot.stage ?? ''}|${snapshot.awaitingGate ?? ''}|${
        Array.isArray(snapshot.pending) ? snapshot.pending.map((item) => item.id).join(',') : ''
      }|${delivered.size}|${archiveCount}|resolved:${autoResolvedCount}`
      if (signature === previousSignature) stalledRounds += 1
      else {
        previousSignature = signature
        stalledRounds = 0
      }
      if (stalledRounds >= 2) {
        console.log('  连续两轮没有进展，停止后续轮次')
        break
      }
      if (snapshot.awaitingGate) {
        if (plan.owner === 'manual') {
          state.ownerActions.push({
            afterRound: roundIndex,
            action: 'awaiting-manual',
            gate: snapshot.awaitingGate,
            ok: false,
            message: 'manual 模式：等待负责人手动批准；可用 tools/admin.js 或桌面端 /flow approve',
          })
          console.log(`  等待人工门 ${snapshot.awaitingGate}（--owner manual，停止）`)
          break
        }
        const approval = await ownerAction(state.helperPath, 'approve', workspace, [
          snapshot.awaitingGate,
          'evaluation harness auto-approve',
        ])
        state.ownerActions.push({
          afterRound: roundIndex,
          action: 'approve',
          gate: snapshot.awaitingGate,
          ok: approval.ok,
          message: approval.payload?.message ?? approval.payload?.error ?? approval.stderrTail,
        })
        console.log(`  人工门 ${snapshot.awaitingGate} ${approval.ok ? '已批准' : '批准失败'}`)
        if (!approval.ok) break
        await refreshDelivered()
        if (goalReached()) {
          console.log(`  ${goalText()}（批准后立即归档），结束轮次`)
          break
        }
        continue
      }
      if (!snapshot.changeId) {
        // greenfield：GR 批准后 PROJECT 归档、C0 还没立项时没有活动变更，
        // 要继续给 agent 轮次从已批准路线图立项，而不是提前结束。
        if (plan.stopAfter) {
          console.log('  没有活动变更：等待 agent 从已批准路线图立项下一个变更')
          continue
        }
        if (roundIndex > 1) {
          console.log('  没有进行中的变更，停止后续轮次')
          break
        }
      }
    }

    console.log('6/6 收集产物…')
    if (plan.verify) {
      try {
        verification = await runVerification({ plan, workspace, runDir: plan.outDir, rounds: state.rounds })
        console.log(`  验收/回归：${verification.skipped ? '跳过' : verification.results.map((item) => `${item.label}=${item.status}`).join('；')}`)
      } catch (verifyError) {
        console.log(`  验收命令执行失败（不影响产物收集）：${verifyError instanceof Error ? verifyError.message : verifyError}`)
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    console.error(`运行失败：${error}`)
  } finally {
    try {
      collected = await collectArtifacts({
        plan,
        workspace,
        baseline: state.baseline?.baselineCommit ?? null,
        runDir: plan.outDir,
        rounds: state.rounds,
        ownerActions: state.ownerActions,
        setup: state.setup,
        readmeInfo: state.readmeInfo,
        copyInfo: state.copyInfo,
      })
    } catch (collectError) {
      console.error(`收集产物失败：${collectError instanceof Error ? collectError.message : collectError}`)
    }
    const finishedAt = new Date()
    await writeRunRecord({
      plan,
      runDir: plan.outDir,
      state,
      baseline: state.baseline,
      setup: state.setup,
      collected,
      verification,
      startedAt,
      finishedAt,
      error,
    }).catch((writeError) => {
      console.error(`写运行记录失败：${writeError instanceof Error ? writeError.message : writeError}`)
    })
    if (plan.keepWorkdir) {
      console.log(`保留临时工作目录：${tempRoot}`)
    } else {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  console.log('')
  if (error) {
    console.error(`评测失败：${error}`)
    console.error(`部分记录：${relative(ROOT, plan.outDir)}/run.json`)
    process.exitCode = 1
    return
  }
  const metrics = metricsSummary(collected?.metrics)
  console.log(`评测完成：${plan.runId}`)
  console.log(`  数据目录：${relative(ROOT, plan.outDir)}/`)
  console.log(
    `  变更：${collected?.git?.changedFiles ?? 0} 个文件（+${collected?.git?.insertions ?? 0}/-${
      collected?.git?.deletions ?? 0
    }），人工门动作 ${state.ownerActions.filter((item) => item.action === 'approve').length} 次`,
  )
  console.log(
    `  FlowGate：metrics ${collected?.metrics?.length ?? 0} 个，report.html ${collected?.reports?.length ?? 0} 个${
      metrics ? `（M-13=${metrics.rows.find((row) => row.id === 'M-13')?.value ?? '—'}）` : '（A 组预期为空）'
    }`,
  )
  console.log(`  摘要：${relative(ROOT, join(plan.outDir, 'summary.md'))}`)
}

function printList() {
  console.log('FlowGate 评测仓库目录\n')
  for (const [name, repo] of Object.entries(REPOS)) {
    console.log(`${name}（${repo.dir}）— ${repo.stack}`)
    for (const [taskName, task] of Object.entries(repo.tasks)) {
      const aliases = (task.aliases ?? []).length > 0 ? `（别名：${task.aliases.join(' / ')}）` : ''
      console.log(`  - ${taskName}「${task.label}」${aliases}`)
      console.log(`    模糊描述：${task.prompt}`)
    }
    console.log('')
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n`)
      console.error(usage())
      process.exitCode = 2
      return
    }
    throw error
  }
  if (options.help) {
    console.log(usage())
    return
  }
  if (options.list) {
    printList()
    return
  }
  let plan
  try {
    plan = await buildPlan(options)
  } catch (error) {
    console.error(`构建评测计划失败：${error instanceof Error ? error.message : error}`)
    process.exitCode = 2
    return
  }
  if (options['dryrun']) {
    printPlan(plan)
    process.exitCode = plan.issues.length > 0 ? 2 : 0
    return
  }
  if (plan.issues.length > 0) {
    console.error('参数或前置校验失败：')
    for (const issue of plan.issues) console.error(`  ✗ ${issue}`)
    console.error('\n先修好上面各项；只想校验环境可以加 --dry-run。')
    process.exitCode = 2
    return
  }
  if (!plan.keyPresent) {
    console.error('缺少 DEEPSEEK_API_KEY：真实评测会调用模型并产生费用，脚本只从环境变量读取 key（不写盘）。')
    console.error('')
    console.error('  DEEPSEEK_API_KEY=<key> node scripts/run-evaluation.mjs \\')
    console.error(
      `    --repo ${plan.repoName} --task ${plan.taskName} --condition ${plan.condition}`,
    )
    console.error('')
    console.error('只想校验参数与路径：加 --dry-run（不需要 key，也不会调用模型）。')
    process.exitCode = 3
    return
  }
  await runEvaluation(plan)
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
