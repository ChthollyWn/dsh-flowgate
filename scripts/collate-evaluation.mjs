#!/usr/bin/env node
/**
 * 汇总 `docs/evaluation-data/` 下的评测运行，生成 M6/T6.1 结果表；
 * `--write` 时把表格写回 docs/evaluation.md 的
 * `<!-- EVAL-TABLE:BEGIN -->` / `<!-- EVAL-TABLE:END -->` 之间。
 *
 * 用法：
 *   node scripts/collate-evaluation.mjs           # 打印表格
 *   node scripts/collate-evaluation.mjs --write   # 更新 docs/evaluation.md
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DATA_DIR = join(ROOT, 'docs', 'evaluation-data')
const DOC = join(ROOT, 'docs', 'evaluation.md')
const WRITE = process.argv.includes('--write')

const TASKS = [
  { repo: 'ts-todo-api', task: 'new-feature' },
  { repo: 'ts-todo-api', task: 'fix-bug' },
  { repo: 'ts-todo-api', task: 'risk' },
  { repo: 'py-csv-cli', task: 'new-feature' },
  { repo: 'py-csv-cli', task: 'fix-bug' },
  { repo: 'py-csv-cli', task: 'risk' },
  { repo: 'java-renewal', task: 'new-feature' },
  { repo: 'java-renewal', task: 'fix-bug' },
  { repo: 'java-renewal', task: 'risk' },
]

function readRun(dir) {
  const runPath = join(dir, 'run.json')
  if (!existsSync(runPath)) return null
  try {
    const run = JSON.parse(readFileSync(runPath, 'utf8'))
    const verification = Array.isArray(run.verification?.results)
      ? run.verification.results
      : existsSync(join(dir, 'verification.json'))
        ? JSON.parse(readFileSync(join(dir, 'verification.json'), 'utf8')).results
        : []
    const approvals = (run.ownerActions ?? []).filter((action) => action.action === 'approve' || action.gate)
    return {
      dir: dir.split(/[\\/]/).pop(),
      repo: run.repo,
      task: run.task,
      condition: run.condition,
      // 9×2 对照矩阵的 B 组口径是 dispatch=inline（见 docs/evaluation.md §5）；
      // 后续补跑的 dispatch=auto 辅助实验不覆盖矩阵行（它们记录在 evaluation.md §6.7）。
      dispatch: run.flowgate?.configOverrides?.dispatch ?? 'inline',
      rounds: Array.isArray(run.rounds) ? run.rounds.length : 0,
      durationS: Math.round((run.durationMs ?? 0) / 1000),
      approvals: approvals.length,
      regression: verification.find((item) => item.kind === 'regression')?.status ?? '—',
      acceptance: verification.find((item) => item.kind === 'acceptance')?.status ?? '—',
    }
  } catch (error) {
    console.error(`读取 ${runPath} 失败：${error.message}`)
    return null
  }
}

const runs = new Map()
if (existsSync(DATA_DIR)) {
  for (const entry of readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const run = readRun(join(DATA_DIR, entry.name))
    if (!run) continue
    // 辅助实验（dispatch=auto 等）只出现在 §6.7，不参与 9×2 矩阵。
    if (run.dispatch !== 'inline') continue
    runs.set(`${run.repo}/${run.task}/${run.condition}`, run)
  }
}

const lines = []
lines.push('| 仓库 / 任务 | 条件 | 轮次 | 耗时(s) | 人工门 | 回归 | 验收 | 原始数据 |')
lines.push('|---|---|---|---|---|---|---|---|')
let done = 0
for (const { repo, task } of TASKS) {
  for (const condition of ['A', 'B']) {
    const run = runs.get(`${repo}/${task}/${condition}`)
    if (!run) {
      lines.push(`| ${repo} / ${task} | ${condition} | — | — | — | — | — | 待跑 |`)
      continue
    }
    done += 1
    lines.push(
      `| ${repo} / ${task} | ${condition} | ${run.rounds} | ${run.durationS} | ${run.approvals} | ${run.regression} | ${run.acceptance} | [${run.dir}](evaluation-data/${run.dir}/) |`,
    )
  }
}
lines.push('')
lines.push(`已完成 **${done}/18** 个 run；未跑任务显示"待跑"。A/B 条件、prompt、隔离 DSH_HOME 与人工门策略见 §2/§5。`)
const table = lines.join('\n')

if (WRITE) {
  const doc = readFileSync(DOC, 'utf8')
  const begin = '<!-- EVAL-TABLE:BEGIN -->'
  const end = '<!-- EVAL-TABLE:END -->'
  const startIndex = doc.indexOf(begin)
  const endIndex = doc.indexOf(end)
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    console.error(`docs/evaluation.md 缺少 ${begin} / ${end} 标记`)
    process.exit(2)
  }
  const next = `${doc.slice(0, startIndex + begin.length)}\n${table}\n${doc.slice(endIndex)}`
  writeFileSync(DOC, next)
  console.log(`已更新 docs/evaluation.md（${done}/18 个 run）`)
} else {
  console.log(table)
}
