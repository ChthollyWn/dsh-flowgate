/**
 * Cross-session read-only dashboard (`.flowgate/dashboard.html`, docs/03 §12.5).
 *
 * Single file, inlined CSS/JS, opens offline without DSH running. It shows the
 * change ledger, each active change's stage pipeline and execution diagram,
 * pending items, recent interceptions/evidence and cumulative metrics. It is
 * display-only: approvals and overrides stay in DSH (no buttons/forms here).
 */
import type {
  BatchState,
  ChangeStatus,
  PendingItem,
  RuntimeSnapshot,
  StageId,
  TaskState,
  Violation,
} from '../types'
import { STAGE_CARD_ORDER, STAGE_CARD_TITLES } from '../learn'

export interface DashboardInput {
  changes: ChangeStatus[]
  snapshot?: RuntimeSnapshot
  pending: PendingItem[]
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Escaping helpers (dashboard is independent of the report module)
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeDashboardHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

function clip(value: unknown, max = 300): string {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function chip(text: string, tone = ''): string {
  return `<span class="badge ${tone}">${escapeDashboardHtml(text)}</span>`
}

function formatDate(iso: string | undefined): string {
  return iso ? escapeDashboardHtml(iso) : '—'
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">（无）</p>'
  return `<div class="table-wrap"><table><thead><tr>${headers
    .map((header) => `<th>${escapeDashboardHtml(header)}</th>`)
    .join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

function card(id: string, title: string, body: string): string {
  return `<section class="card" id="${id}"><h2>${escapeDashboardHtml(title)}</h2>${body}</section>`
}

const COMPLEXITY_LABELS: Record<string, string> = { low: '低', medium: '中', high: '高', ultra: '超高' }
const RISK_LABELS: Record<string, string> = { normal: '普通', high: '高' }
const LIFECYCLE_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  archived: '已交付',
  blocked: '阻塞',
  locked: '锁定',
}

function lifecycleTone(lifecycle: string): string {
  if (lifecycle === 'archived') return 'muted'
  if (lifecycle === 'blocked' || lifecycle === 'locked') return 'bad'
  if (lifecycle === 'paused') return 'warn'
  return 'info'
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function activeChanges(changes: ChangeStatus[]): ChangeStatus[] {
  return changes.filter((change) => change.lifecycle !== 'archived' && change.stage !== 'archived')
}

function taskStats(change: ChangeStatus): { done: number; total: number } {
  const ids = Object.keys(change.tasks)
  return { done: ids.filter((id) => change.tasks[id]?.status === 'done').length, total: ids.length }
}

function evidenceIds(change: ChangeStatus): string[] {
  const ids = new Set(change.evidenceIds)
  for (const task of Object.values(change.tasks)) for (const evidenceId of task.evidenceIds ?? []) ids.add(evidenceId)
  return [...ids]
}

function openPending(input: DashboardInput): PendingItem[] {
  const byId = new Map<string, PendingItem>()
  for (const item of input.pending) if (item.status === 'open') byId.set(item.id, item)
  for (const change of input.changes) for (const item of change.pending) if (item.status === 'open') byId.set(item.id, item)
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

function recentViolations(input: DashboardInput): { violation: Violation; changeId: string }[] {
  const list: { violation: Violation; changeId: string }[] = []
  if (input.snapshot) for (const violation of input.snapshot.violations) list.push({ violation, changeId: input.snapshot.changeId ?? '' })
  for (const change of input.changes) for (const violation of change.violations) list.push({ violation, changeId: change.id })
  const unique = new Map<string, { violation: Violation; changeId: string }>()
  for (const entry of list) unique.set(`${entry.changeId}:${entry.violation.id}`, entry)
  return [...unique.values()]
    .sort((a, b) => (a.violation.detectedAt < b.violation.detectedAt ? 1 : -1))
    .slice(0, 10)
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function summarySection(input: DashboardInput): string {
  const changes = input.changes
  const active = activeChanges(changes)
  const delivered = changes.filter((change) => change.lifecycle === 'archived' || change.stage === 'archived')
  let tasksDone = 0
  let tasksTotal = 0
  let evidenceCount = 0
  let violationCount = 0
  let overrideCount = 0
  for (const change of changes) {
    const stats = taskStats(change)
    tasksDone += stats.done
    tasksTotal += stats.total
    evidenceCount += evidenceIds(change).length
    violationCount += change.violations.length
    overrideCount += change.overrides.filter((override) => override.usedAt !== undefined).length
  }
  const intercepts = input.snapshot
    ? Object.values(input.snapshot.interceptCounts).reduce((sum, value) => sum + value, 0)
    : '未知'
  const pending = openPending(input)
  const coverage = input.snapshot?.coverage
  const coverageText = coverage
    ? `${coverage.coveredWritable} / ${coverage.coveredWritable + coverage.uncoveredWritable} 个可写工具（${coverage.uncoveredWritable} 个未覆盖）`
    : '未知'
  const cards = [
    ['变更总数', String(changes.length)],
    ['进行中', String(active.length)],
    ['已交付', String(delivered.length)],
    ['任务完成', `${tasksDone} / ${tasksTotal}`],
    ['证据回执', String(evidenceCount)],
    ['越界拦截', String(violationCount)],
    ['累计拦截次数', String(intercepts)],
    ['待处理事项', String(pending.length)],
    ['单次放行已用', String(overrideCount)],
    ['拦截覆盖自检', coverageText],
  ] as const
  return card(
    'sum',
    '累计指标',
    `<div class="grid">${cards
      .map(([label, value]) => `<div class="stat"><span>${escapeDashboardHtml(label)}</span><strong>${escapeDashboardHtml(value)}</strong></div>`)
      .join('')}</div>
     <p class="note">累计口径来自 <code>.flowgate/</code> 下的台账与进行状态，不依赖 DSH 是否在运行；token / 响应时间等宿主侧数据缺失时显示「未知」，不用 0 代替（FR-10.4）。</p>
     ${input.snapshot?.statusLine ? `<p class="status-line">当前状态：${escapeDashboardHtml(input.snapshot.statusLine)}</p>` : ''}`,
  )
}

function changeTableSection(input: DashboardInput): string {
  const rows = input.changes.map((change) => {
    const stats = taskStats(change)
    return [
      `<code>${escapeDashboardHtml(change.id)}</code>`,
      chip(change.kind === 'analysis' ? '分析' : '变更', change.kind === 'analysis' ? 'muted' : ''),
      escapeDashboardHtml(clip(change.title, 120)),
      escapeDashboardHtml(COMPLEXITY_LABELS[change.complexity] ?? change.complexity),
      escapeDashboardHtml(RISK_LABELS[change.risk] ?? change.risk),
      escapeDashboardHtml(STAGE_CARD_TITLES[change.stage] ?? change.stage),
      chip(LIFECYCLE_LABELS[change.lifecycle] ?? change.lifecycle, lifecycleTone(change.lifecycle)),
      `${stats.done} / ${stats.total}`,
      escapeDashboardHtml(String(evidenceIds(change).length)),
      escapeDashboardHtml(String(change.pending.filter((item) => item.status === 'open').length)),
      formatDate(change.updatedAt),
    ]
  })
  return card(
    'ledger',
    '变更台账',
    `<p class="note">全部变更与分析任务；最近活动时间来自各变更的 status.json。</p>
     ${table(['编号', '类型', '标题', '复杂度', '风险', '阶段', '状态', '任务', '证据', '待处理', '最近活动'], rows)}`,
  )
}

function pipelineSection(input: DashboardInput): string {
  const active = activeChanges(input.changes)
  if (active.length === 0) {
    return card('pipeline', '阶段流水线', '<p class="empty">（没有进行中的变更）</p>')
  }
  const blocks = active.map((change) => {
    const snapshotPipeline = input.snapshot && input.snapshot.changeId === change.id ? input.snapshot.pipeline : null
    const currentIndex = STAGE_CARD_ORDER.indexOf(change.stage as StageId)
    const stages = STAGE_CARD_ORDER.map((stage, index) => {
      let status: 'done' | 'current' | 'pending' | 'blocked'
      const snapshotStage = snapshotPipeline?.find((entry) => entry.stage === stage)
      if (snapshotStage) status = snapshotStage.status
      else if (change.lifecycle === 'blocked' || change.lifecycle === 'locked') status = index === currentIndex ? 'blocked' : index < currentIndex ? 'done' : 'pending'
      else status = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending'
      const title = snapshotStage?.label ?? STAGE_CARD_TITLES[stage] ?? stage
      return `<span class="stage ${status}" title="${escapeDashboardHtml(title)}">${status === 'done' ? '✓ ' : status === 'current' ? '● ' : status === 'blocked' ? '⛔ ' : '○ '}${escapeDashboardHtml(title)}</span>`
    }).join('')
    const gates = Object.entries(change.gates)
      .map(([gate, record]) => {
        if (!record) return ''
        const tone = record.state === 'passed' ? 'ok' : record.state === 'failed' || record.state === 'rejected' ? 'bad' : record.state === 'awaiting' ? 'warn' : 'muted'
        return chip(`${gate} ${record.state}`, tone)
      })
      .join(' ')
    return `<div class="pipeline-block">
      <h3><code>${escapeDashboardHtml(change.id)}</code> ${escapeDashboardHtml(change.title)} ${chip(LIFECYCLE_LABELS[change.lifecycle] ?? change.lifecycle, lifecycleTone(change.lifecycle))}</h3>
      <div class="stages">${stages}</div>
      <div class="chips">${gates || '<span class="empty">（暂无门禁记录）</span>'}</div>
      ${change.lock ? `<p class="bad">锁定：${escapeDashboardHtml(clip(change.lock.reason, 200))} @ ${formatDate(change.lock.at)}</p>` : ''}
      ${change.off ? '<p class="warn">该变更已临时关闭拦截（负责人操作）</p>' : ''}
    </div>`
  })
  return card('pipeline', '阶段流水线', blocks.join(''))
}

function executionSection(input: DashboardInput): string {
  const active = activeChanges(input.changes)
  if (active.length === 0) return card('execution', '执行图', '<p class="empty">（没有进行中的变更）</p>')
  const blocks = active.map((change) => {
    const snapshotBatches = input.snapshot && input.snapshot.changeId === change.id ? input.snapshot.batches : null
    const batches: BatchState[] = snapshotBatches && snapshotBatches.length > 0 ? snapshotBatches : change.batches
    const tasks: Record<string, TaskState> = input.snapshot && input.snapshot.changeId === change.id ? input.snapshot.tasks : change.tasks
    const rows = batches.map((batch) => {
      const lanes = batch.tasks
        .map((taskId) => {
          const task = tasks[taskId]
          const status = task?.status ?? 'pending'
          const tone = status === 'done' ? 'ok' : status === 'running' || status === 'review' ? 'info' : status === 'blocked' || status === 'failed' ? 'bad' : 'muted'
          const worktree = task?.worktree ? ` · ${clip(task.worktree, 60)}` : ''
          const tdd = task?.tdd === 'green' ? ' · GREEN' : task?.tdd === 'red' ? ' · RED' : ''
          return `<span class="lane-chip ${escapeDashboardHtml(status)}">${escapeDashboardHtml(taskId)} · ${escapeDashboardHtml(status)}${escapeDashboardHtml(tdd)}${escapeDashboardHtml(worktree)}</span>`
        })
        .join(' ')
      const checkpoint = batch.checkpoint ? ` · 检查点：${batch.checkpoint.status}` : ''
      return `<div class="diagram-row"><span class="diagram-batch">${escapeDashboardHtml(batch.id)}（${escapeDashboardHtml(batch.mode)}）${escapeDashboardHtml(checkpoint)}</span><span class="diagram-lanes">${lanes || '<span class="empty">（无任务）</span>'}</span></div>`
    })
    return `<div class="pipeline-block"><h3><code>${escapeDashboardHtml(change.id)}</code> · 批次 ${batches.length} 个</h3>
      ${rows.length > 0 ? rows.join('') : '<p class="empty">（没有执行计划）</p>'}
      ${input.snapshot?.activeTaskId && input.snapshot.changeId === change.id ? `<p class="note">当前活动任务：<code>${escapeDashboardHtml(input.snapshot.activeTaskId)}</code></p>` : ''}
    </div>`
  })
  return card(
    'execution',
    '执行图',
    `<p class="note">按批次与并行泳道展示；节点状态来自 status.json，子 agent 在独立 worktree 中运行时显示其 worktree 路径。</p>${blocks.join('')}`,
  )
}

function pendingSection(input: DashboardInput): string {
  const pending = openPending(input)
  const rows = pending.map((item) => [
    `<code>${escapeDashboardHtml(item.id)}</code>`,
    escapeDashboardHtml(item.kind),
    escapeDashboardHtml(clip(item.title, 200)),
    `<code>${escapeDashboardHtml(item.changeId)}</code>`,
    escapeDashboardHtml(clip(item.detail, 300)),
    formatDate(item.createdAt),
  ])
  return card(
    'pending',
    `待处理事项（${pending.length}）`,
    rows.length > 0
      ? `${table(['编号', '类型', '标题', '变更', '说明', '创建时间'], rows)}
         <p class="note">批准 / 拒绝 / 单次放行只能在 DSH 里用命令或面板完成；本看板只展示、不能操作。</p>`
      : '<p class="empty">（没有待处理事项）</p>',
  )
}

function interceptsSection(input: DashboardInput): string {
  const violations = recentViolations(input)
  const violationRows = violations.map(({ violation, changeId }) => [
    `<code>${escapeDashboardHtml(violation.id)}</code>`,
    `<code>${escapeDashboardHtml(changeId)}</code>`,
    escapeDashboardHtml(violation.kind),
    escapeDashboardHtml(clip(violation.path, 240)),
    escapeDashboardHtml(violation.source),
    formatDate(violation.detectedAt),
    violation.clearedAt ? chip('已撤销', 'ok') : chip('未撤销', 'bad'),
  ])
  const intercepts = input.snapshot
    ? Object.entries(input.snapshot.interceptCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => [`<code>${escapeDashboardHtml(rule)}</code>`, escapeDashboardHtml(String(count))])
    : []
  const evidenceRows: string[][] = []
  for (const change of input.changes) {
    for (const id of evidenceIds(change).slice(-5)) {
      const task = Object.values(change.tasks).find((entry) => (entry.evidenceIds ?? []).includes(id))
      evidenceRows.push([
        `<code>${escapeDashboardHtml(id)}</code>`,
        `<code>${escapeDashboardHtml(change.id)}</code>`,
        escapeDashboardHtml(task?.id ?? '—'),
        task ? chip(task.tdd === 'green' ? 'GREEN' : task.tdd === 'red' ? 'RED' : task.tdd, task.tdd === 'green' ? 'ok' : task.tdd === 'red' ? 'bad' : 'muted') : '—',
        formatDate(task?.finishedAt),
        `<code>${escapeDashboardHtml(`.flowgate/state/evidence/${id}.log`)}</code>`,
      ])
    }
  }
  return card(
    'intercepts',
    '最近拦截与证据',
    `<div class="two-col">
      <div><h3>最近拦截（${violationRows.length}）</h3>${table(['ID', '变更', '类型', '路径', '来源', '时间', '状态'], violationRows)}</div>
      <div><h3>按规则统计</h3>${intercepts.length > 0 ? table(['规则', '次数'], intercepts) : '<p class="empty">未知（当前快照没有拦截统计）</p>'}</div>
    </div>
    <h3>最近证据回执（每个变更最近 5 条）</h3>
    ${table(['回执', '变更', '任务', 'TDD', '完成时间', '完整日志'], evidenceRows)}`,
  )
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const DASHBOARD_CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--text:#1f2430;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#0f7b46;--bad:#c02626;--warn:#9a6a00;--info:#1d4ed8;--track:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1a1f29;--text:#e5e8ee;--muted:#9aa3b2;--line:#2b3240;--accent:#69a2ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--info:#93c5fd;--track:#242b38}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:var(--card);border-bottom:1px solid var(--line);padding:14px 22px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
header h1{font-size:17px;margin:0}header .meta{color:var(--muted);font-size:12px}
nav a{color:var(--accent);text-decoration:none;font-size:12px;margin-right:10px}
main{max-width:1180px;margin:0 auto;padding:18px 22px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0;scroll-margin-top:70px}
.card h2{font-size:18px;margin:0 0 14px;border-bottom:1px solid var(--line);padding-bottom:10px}
h3{font-size:14.5px;margin:14px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.stat{background:var(--track);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:3px}
.stat span{color:var(--muted);font-size:11.5px}.stat strong{font-size:16px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:var(--track);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:none}
code{background:var(--track);border-radius:4px;padding:1px 4px;font-size:12px;word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:2px;margin-top:6px}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--line);background:var(--track);margin:1px 2px}
.badge.ok{color:var(--ok)}.badge.bad,.bad{color:var(--bad)}.badge.warn,.warn{color:var(--warn)}.badge.info{color:var(--info)}.badge.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:12.5px}.note{background:var(--track);border-radius:8px;padding:8px 12px;font-size:12.5px;color:var(--muted)}
.status-line{font-weight:600}
.two-col{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}
.stages{display:flex;flex-wrap:wrap;gap:6px}
.stage{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;background:var(--track);white-space:nowrap}
.stage.done{color:var(--ok)}.stage.current{color:var(--info);border-color:var(--info)}.stage.blocked{color:var(--bad);border-color:var(--bad)}.stage.pending{color:var(--muted)}
.pipeline-block{border-top:1px dashed var(--line);padding-top:10px;margin-top:12px}.pipeline-block:first-of-type{border-top:none;margin-top:0}
.diagram-row{display:grid;grid-template-columns:200px 1fr;gap:10px;align-items:start;padding:6px 0;border-bottom:1px dashed var(--line)}
.diagram-batch{font-size:12px;color:var(--muted)}
.diagram-lanes{display:flex;flex-wrap:wrap;gap:4px}
.lane-chip{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:11.5px;background:var(--track)}
footer{text-align:center;color:var(--muted);font-size:11.5px;padding:18px}
@media print{header{position:static}nav{display:none}.card{break-inside:avoid}}
`

const DASHBOARD_JS = `
(function(){
  var links = document.querySelectorAll('nav a');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (event) {
      var target = document.getElementById(this.getAttribute('href').slice(1));
      if (target) { event.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  }
})();
`

/** Render the offline, read-only dashboard HTML. */
export function renderDashboard(input: DashboardInput): string {
  const sections = [
    summarySection(input),
    changeTableSection(input),
    pipelineSection(input),
    executionSection(input),
    pendingSection(input),
    interceptsSection(input),
  ].join('\n')
  const nav = [
    ['sum', '累计指标'],
    ['ledger', '台账'],
    ['pipeline', '流水线'],
    ['execution', '执行图'],
    ['pending', '待处理'],
    ['intercepts', '拦截与证据'],
  ]
    .map(([id, label]) => `<a href="#${id}">${label}</a>`)
    .join('')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="FlowGate">
<title>FlowGate 跨会话看板</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header>
  <div><h1>FlowGate 跨会话看板</h1><div class="meta">生成于 ${escapeDashboardHtml(input.generatedAt)} · 只读 · 离线可用</div></div>
  <nav>${nav}</nav>
</header>
<main>
<p class="note">本看板由 FlowGate 在每次状态变化后重新生成，单文件、断网可打开。它只展示、不能操作：批准与放行请回到 DSH 右侧栏面板或输入区授权卡片完成。</p>
${sections}
</main>
<footer>FlowGate · 硬约束开发流程门禁 · 跨会话离线看板</footer>
<script>${DASHBOARD_JS}</script>
</body>
</html>
`
}

/** Learning cards re-exported here for hosts that import the dashboard barrel. */
export { STAGE_LEARNING_CARDS, STAGE_CARD_TITLES } from '../learn'
export type { LearningCard } from '../learn'
