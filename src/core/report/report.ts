/**
 * Single-file HTML delivery report (docs/03 §12.4, docs/04 T5.3).
 *
 * Eight sections: 概览 / 需求 / 计划 / 执行 / 验证 / 风险 / 指标 / 附录.
 * Everything is inlined (CSS + JS + SVG-free CSS bars), so the report opens
 * offline and never references an external resource. Every user-controlled
 * string is HTML-escaped before interpolation (XSS defence).
 */
import type {
  ArtifactBundle,
  ChangeStatus,
  EvidenceReceipt,
  ExecutionBatch,
  LedgerEvent,
  MetricSet,
  PendingItem,
  ReviewRecord,
  Scenario,
  StageId,
  TaskCard,
  TaskState,
  TaskStatus,
} from '../types'
import { METRIC_DEFINITIONS, formatMetricValue, type MetricDefinition } from '../metrics'
import { STAGE_CARD_ORDER, STAGE_CARD_TITLES } from '../stage-meta'

export interface ReportInput {
  change: ChangeStatus
  artifacts: ArtifactBundle
  evidence: EvidenceReceipt[]
  ledger: LedgerEvent[]
  reviews: ReviewRecord[]
  metrics: MetricSet
  generatedAt: string
}

// ---------------------------------------------------------------------------
// Escaping + formatting helpers
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape user text so it can be interpolated into HTML safely. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

function clip(value: unknown, max = 600): string {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function linesOf(value: unknown): string[] {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function joinList(items: readonly string[] | undefined, empty = '（无）'): string {
  if (!items || items.length === 0) return escapeHtml(empty)
  return items.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join(' ')
}

function formatDate(iso: string | undefined): string {
  return iso && iso !== '' ? escapeHtml(iso) : '—'
}

function safeNumber(value: number | undefined): string {
  return value === undefined ? '—' : String(value)
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)))
}

// ---------------------------------------------------------------------------
// Small reusable HTML pieces
// ---------------------------------------------------------------------------

function chip(text: string, kind = ''): string {
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`
}

function phaseBadge(phase: string): string {
  const map: Record<string, [string, string]> = {
    green: ['GREEN', 'ok'],
    red: ['RED', 'bad'],
    none: ['无证据', 'muted'],
    unknown: ['未知', 'muted'],
  }
  const entry = map[phase] ?? ['未知', 'muted']
  return chip(entry[0], entry[1])
}

function statusBadge(status: string): string {
  const tone =
    status === 'done'
      ? 'ok'
      : status === 'running' || status === 'review'
        ? 'info'
        : status === 'blocked' || status === 'failed'
          ? 'bad'
          : status === 'skipped'
            ? 'muted'
            : ''
  return chip(status, tone)
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">（无记录）</p>'
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

function section(id: string, number: string, title: string, body: string, subtitle = ''): string {
  return `<section class="card" id="${id}">
  <h2><span class="sec-no">${number}</span>${escapeHtml(title)}${subtitle ? `<span class="sec-sub">${escapeHtml(subtitle)}</span>` : ''}</h2>
  ${body}
</section>`
}

// ---------------------------------------------------------------------------
// Overview (阶段耗时条形图 + 门禁状态)
// ---------------------------------------------------------------------------

function stageDurationBars(change: ChangeStatus, ledger: LedgerEvent[], generatedAt: string): string {
  const entries = ledger
    .filter((event) => event.type === 'stage.entered')
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq))
  const rows: { stage: string; minutes: number }[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const stage = typeof entry.data.stage === 'string' ? entry.data.stage : typeof entry.data.to === 'string' ? entry.data.to : '未标注'
    const nextAt = index + 1 < entries.length ? entries[index + 1]!.at : generatedAt
    const from = Date.parse(entry.at)
    const to = Date.parse(nextAt)
    const minutes = Number.isFinite(from) && Number.isFinite(to) && to > from ? Math.round(((to - from) / 60_000) * 10) / 10 : 0
    rows.push({ stage, minutes })
  }
  if (rows.length === 0) {
    return `<p class="empty">还没有阶段耗时记录（账本中没有 stage.entered 事件）；当前阶段：${escapeHtml(change.stage)}</p>`
  }
  const max = Math.max(...rows.map((row) => row.minutes), 1)
  return `<div class="bars">${rows
    .map((row) => {
      const width = Math.max(2, percent(row.minutes, max))
      return `<div class="bar-row"><span class="bar-label">${escapeHtml(row.stage)}</span><span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span><span class="bar-value">${escapeHtml(String(row.minutes))} 分钟</span></div>`
    })
    .join('')}</div>`
}

function gateChips(change: ChangeStatus): string {
  const entries = Object.entries(change.gates)
  if (entries.length === 0) return '<p class="empty">（暂无门禁记录）</p>'
  return `<div class="chips">${entries
    .map(([gate, record]) => {
      if (!record) return ''
      const tone =
        record.state === 'passed'
          ? 'ok'
          : record.state === 'failed' || record.state === 'rejected'
            ? 'bad'
            : record.state === 'awaiting'
              ? 'warn'
              : 'muted'
      return `<span class="badge ${tone}">${escapeHtml(gate)} · ${escapeHtml(record.state)} · 尝试 ${safeNumber(record.attempts)}</span>`
    })
    .join(' ')}</div>`
}

function overviewSection(input: ReportInput): string {
  const { change, artifacts, ledger, generatedAt } = input
  const taskIds = Object.keys(change.tasks)
  const done = taskIds.filter((id) => change.tasks[id]?.status === 'done').length
  const complexityLabels: Record<string, string> = { low: '低', medium: '中', high: '高', ultra: '超高' }
  const riskLabels: Record<string, string> = { normal: '普通风险', high: '高风险' }
  const lifecycleLabels: Record<string, string> = {
    active: '进行中',
    paused: '已暂停',
    archived: '已归档',
    blocked: '阻塞',
    locked: '锁定',
  }
  const info = [
    ['变更编号', `<code>${escapeHtml(change.id)}</code>`],
    ['标题', escapeHtml(change.title)],
    ['复杂度', escapeHtml(complexityLabels[change.complexity] ?? change.complexity)],
    ['风险', escapeHtml(riskLabels[change.risk] ?? change.risk)],
    ['当前阶段', escapeHtml(STAGE_CARD_TITLES[change.stage] ?? change.stage)],
    ['生命周期', escapeHtml(lifecycleLabels[change.lifecycle] ?? change.lifecycle)],
    ['分支', change.branch ? `<code>${escapeHtml(change.branch)}</code>` : '—'],
    ['创建时间', formatDate(change.createdAt)],
    ['最近更新', formatDate(change.updatedAt)],
    ['报告生成', formatDate(generatedAt)],
  ] as const
  return section(
    'sec-overview',
    '①',
    '概览',
    `<div class="grid">${info.map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><strong>${value}</strong></div>`).join('')}</div>
    <h3>任务进度</h3>
    <div class="progress"><span class="progress-fill" style="width:${percent(done, taskIds.length)}%"></span></div>
    <p>已完成 ${done} / ${taskIds.length} 个任务（${percent(done, taskIds.length)}%）；批次 ${change.batches.length} 个；证据回执 ${input.evidence.length} 条；拦截记录 ${change.violations.length} 条。</p>
    <h3>阶段耗时</h3>
    ${stageDurationBars(change, ledger, generatedAt)}
    <div class="two-col">
      <div><h3>门禁状态</h3>${gateChips(change)}</div>
      <div><h3>产物概览</h3>${joinList(
        [
          artifacts.clarify ? '澄清记录' : '',
          artifacts.spec ? '增量规格' : '',
          artifacts.context ? '上下文' : '',
          artifacts.design ? '设计' : '',
          artifacts.risk ? '风险登记' : '',
          artifacts.tasks ? '任务卡' : '',
        ].filter((entry) => entry !== ''),
        '（尚无产物）',
      )}</div>
    </div>`,
    change.summary ? `目标：${clip(change.summary, 160)}` : '',
  )
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

const SIX_ELEMENT_LABELS: { key: string; label: string }[] = [
  { key: 'goal', label: '目标' },
  { key: 'boundary', label: '边界' },
  { key: 'roles', label: '角色' },
  { key: 'acceptance', label: '验收' },
  { key: 'constraints', label: '约束' },
  { key: 'unknowns', label: '未知' },
]

function requirementsSection(input: ReportInput): string {
  const { artifacts } = input
  const clarify = artifacts.clarify
  const spec = artifacts.spec
  const proposal = artifacts.proposal

  const clarifyPart = clarify
    ? `<h3>原始描述</h3><blockquote>${escapeHtml(clip(clarify.originalDescription, 2000))}</blockquote>
       <h3>六要素</h3>
       ${table(
         ['要素', '结论', '来源', '状态'],
         SIX_ELEMENT_LABELS.map((element) => {
           const entry = clarify.elements[element.key as keyof typeof clarify.elements]
           return [
             escapeHtml(element.label),
             escapeHtml(clip(entry?.conclusion ?? '', 500)),
             escapeHtml(clip(entry?.source ?? '', 200)),
             escapeHtml(entry?.status ?? ''),
           ]
         }),
       )}
       <h3>澄清问答（${clarify.qa.length} 条，${clarify.rounds} 轮）</h3>
       ${table(
         ['轮次', '问题', '回答', '改变了什么'],
         clarify.qa.map((qa) => [
           escapeHtml(String(qa.round)),
           escapeHtml(clip(qa.question, 400)),
           escapeHtml(clip(qa.answer, 400)),
           escapeHtml(clip(qa.changed, 300)),
         ]),
       )}
       <div class="two-col">
         <div><h3>假设</h3>${clarify.assumptions.length > 0 ? `<ul>${clarify.assumptions.map((item) => `<li>${escapeHtml(clip(item, 400))}</li>`).join('')}</ul>` : '<p class="empty">（无）</p>'}</div>
         <div><h3>未决问题</h3>${clarify.openQuestions.length > 0 ? `<ul>${clarify.openQuestions.map((item) => `<li>${escapeHtml(clip(item, 400))}</li>`).join('')}</ul>` : '<p class="empty">（已清零）</p>'}</div>
       </div>`
    : '<p class="empty">（未提供澄清记录 clarify.md）</p>'

  const proposalPart = proposal
    ? `<h3>提案</h3>
       ${table(
         ['为什么', '做什么', '影响', '不做'],
         [[
           escapeHtml(clip(proposal.why, 600)),
           escapeHtml(clip(proposal.what, 600)),
           escapeHtml(clip(proposal.impact, 600)),
           escapeHtml(proposal.outOfScope.length > 0 ? proposal.outOfScope.join('；') : '（未列）'),
         ]],
       )}`
    : ''

  const requirementRows = (spec?.requirements ?? []).map((requirement) => [
    `<code>${escapeHtml(requirement.id)}</code>`,
    escapeHtml(clip(requirement.title, 200)),
    escapeHtml(requirement.changeType),
    escapeHtml(String(requirement.scenarios.length)),
  ])
  const scenarioRows = (spec?.scenarios ?? []).map((scenario: Scenario) => [
    `<code>${escapeHtml(scenario.id)}</code>`,
    escapeHtml(clip(scenario.title, 200)),
    escapeHtml(clip(scenario.given.join('；'), 300)),
    escapeHtml(clip(scenario.when.join('；'), 300)),
    escapeHtml(clip(scenario.then.join('；'), 300)),
  ])

  return section(
    'sec-requirements',
    '②',
    '需求',
    `${clarifyPart}
     ${proposalPart}
     <h3>需求清单（${requirementRows.length} 条）</h3>
     ${table(['ID', '标题', '类型', '场景数'], requirementRows)}
     <h3>验收场景（${scenarioRows.length} 条）</h3>
     ${table(['场景', '标题', 'GIVEN', 'WHEN', 'THEN'], scenarioRows)}`,
  )
}

// ---------------------------------------------------------------------------
// Plan (design options, task cards, traceability, execution plan)
// ---------------------------------------------------------------------------

function planSection(input: ReportInput): string {
  const { artifacts, evidence } = input
  const design = artifacts.design
  const tasksDoc = artifacts.tasks
  const specScenarios = artifacts.spec?.scenarios ?? []
  const tasks = tasksDoc?.tasks ?? []

  const designPart = design
    ? `<h3>方案对比</h3>
       ${table(
         ['方案', '摘要', '优点', '缺点'],
         design.options.map((option) => [
           escapeHtml(option.name),
           escapeHtml(clip(option.summary, 500)),
           escapeHtml(clip(option.pros.join('；'), 400)),
           escapeHtml(clip(option.cons.join('；'), 400)),
         ]),
       )}
       <div class="two-col">
         <div><h3>推荐方案</h3><p>${escapeHtml(clip(design.recommendation, 800))}</p></div>
         <div><h3>回滚方案</h3><p>${escapeHtml(clip(design.rollback, 800))}</p></div>
       </div>
       <h3>数据流 / 错误处理</h3>
       <p><strong>数据流：</strong>${escapeHtml(clip(design.dataFlow, 1000))}</p>
       <p><strong>错误处理：</strong>${escapeHtml(clip(design.errorHandling, 1000))}</p>`
    : '<p class="empty">（未提供设计文档 design.md，低复杂度变更可免）</p>'

  const taskRows = tasks.map((task: TaskCard) => [
    `<code>${escapeHtml(task.id)}</code>`,
    escapeHtml(clip(task.title, 200)),
    escapeHtml(task.tdd),
    escapeHtml(task.size),
    escapeHtml(clip(task.scope.join('、'), 400)),
    escapeHtml(clip(task.verify.map((group) => `${group.group}: ${group.command}`).join('；'), 500)),
  ])

  const batchRows = (tasksDoc?.execution.batches ?? []).map((batch) => [
    `<code>${escapeHtml(batch.batch)}</code>`,
    escapeHtml(batch.mode),
    escapeHtml(batch.tasks.join('、')),
    escapeHtml(clip(batch.why, 400)),
    escapeHtml(batch.downgraded ?? ''),
  ])

  const traceRows = specScenarios.map((scenario) => {
    const coveringTasks = tasks.filter((task) => task.covers.includes(scenario.id))
    const evidenceIds = evidence
      .filter((receipt) => receipt.phase === 'green' && receipt.taskId !== undefined && coveringTasks.some((task) => task.id === receipt.taskId))
      .map((receipt) => receipt.id)
    const manual = evidence.filter(
      (receipt) => receipt.kind === 'manual' && receipt.taskId !== undefined && coveringTasks.some((task) => task.id === receipt.taskId),
    )
    const covered = evidenceIds.length > 0
    return [
      `<code>${escapeHtml(scenario.requirementId)}</code>`,
      `<code>${escapeHtml(scenario.id)}</code>`,
      escapeHtml(clip(scenario.title, 160)),
      escapeHtml(coveringTasks.map((task) => task.id).join('、') || '（未覆盖）'),
      escapeHtml(evidenceIds.join('、') || '（无自动化证据）'),
      covered ? chip('已覆盖', 'ok') : manual.length > 0 ? chip('仅手工证据', 'warn') : chip('未覆盖', 'bad'),
    ]
  })

  return section(
    'sec-plan',
    '③',
    '计划',
    `${designPart}
     <h3>任务清单（${tasks.length} 张卡）</h3>
     ${table(['ID', '标题', 'TDD', '规模', '范围', '验证组'], taskRows)}
     <h3>执行计划</h3>
     ${table(['批次', '模式', '任务', '理由', '降级'], batchRows)}
     <h3>追溯矩阵</h3>
     ${table(['需求', '场景', '标题', '任务', '自动化证据', '覆盖'], traceRows)}`,
  )
}

// ---------------------------------------------------------------------------
// Execution (batch + parallel-lane timeline)
// ---------------------------------------------------------------------------

interface TimelineTask {
  id: string
  title: string
  batchId: string
  startMs: number
  endMs: number
  status: TaskStatus
  phase?: string
}

function taskTimeline(change: ChangeStatus, artifacts: ArtifactBundle, evidence: EvidenceReceipt[], generatedAt: string): {
  rows: { batch: ExecutionBatch; tasks: TimelineTask[] }[]
  windowStart: number
  windowEnd: number
  serialMinutes: number
} {
  const cards = new Map((artifacts.tasks?.tasks ?? []).map((task) => [task.id, task]))
  const artifactsBatches = artifacts.tasks?.execution.batches ?? []
  const batches: ExecutionBatch[] =
    artifactsBatches.length > 0
      ? artifactsBatches
      : change.batches.map((batch) => ({ batch: batch.id, mode: batch.mode, tasks: batch.tasks, why: '' }))

  const rows: { batch: ExecutionBatch; tasks: TimelineTask[] }[] = []
  const allStarts: number[] = []
  const allEnds: number[] = []
  let serialMinutes = 0
  const generatedMs = Date.parse(generatedAt)
  for (const batch of batches) {
    const tasks: TimelineTask[] = []
    for (const taskId of batch.tasks) {
      const state: TaskState | undefined = change.tasks[taskId]
      const card = cards.get(taskId)
      const startMs = state?.startedAt ? Date.parse(state.startedAt) : Number.NaN
      const endMs = state?.finishedAt ? Date.parse(state.finishedAt) : Number.NaN
      const start = Number.isFinite(startMs) ? startMs : Number.NaN
      const end = Number.isFinite(endMs) ? endMs : Number.isFinite(generatedMs) ? generatedMs : start
      const greenReceipt = evidence.find((receipt) => receipt.taskId === taskId && receipt.phase === 'green')
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        allStarts.push(start)
        allEnds.push(end)
        serialMinutes += Math.round(((end - start) / 60_000) * 10) / 10
        tasks.push({
          id: taskId,
          title: card?.title ?? taskId,
          batchId: batch.batch,
          startMs: start,
          endMs: end,
          status: state?.status ?? 'pending',
          phase: greenReceipt ? 'green' : state?.tdd,
        })
      } else {
        tasks.push({
          id: taskId,
          title: card?.title ?? taskId,
          batchId: batch.batch,
          startMs: Number.NaN,
          endMs: Number.NaN,
          status: state?.status ?? 'pending',
          phase: greenReceipt ? 'green' : state?.tdd,
        })
      }
    }
    rows.push({ batch, tasks })
  }
  return {
    rows,
    windowStart: allStarts.length > 0 ? Math.min(...allStarts) : 0,
    windowEnd: allEnds.length > 0 ? Math.max(...allEnds) : 0,
    serialMinutes: Math.round(serialMinutes * 10) / 10,
  }
}

function executionSection(input: ReportInput): string {
  const { change, artifacts, evidence, reviews, generatedAt } = input
  const timeline = taskTimeline(change, artifacts, evidence, generatedAt)
  const span = timeline.windowEnd - timeline.windowStart
  const wallMinutes = span > 0 ? Math.round((span / 60_000) * 10) / 10 : 0
  const savings = timeline.serialMinutes > 0 ? Math.round((timeline.serialMinutes / Math.max(wallMinutes, 0.1)) * 10) / 10 : 0

  const diagram = timeline.rows
    .map((row) => {
      const lanes = row.tasks
        .map((task) => `<span class="lane-chip ${escapeHtml(task.status)}">${escapeHtml(task.id)} · ${escapeHtml(task.status)}${task.phase === 'green' ? ' · GREEN' : ''}</span>`)
        .join(' ')
      return `<div class="diagram-row"><span class="diagram-batch">${escapeHtml(row.batch.batch)}（${escapeHtml(row.batch.mode)}）</span><span class="diagram-lanes">${lanes || '<span class="empty">（无任务）</span>'}</span></div>`
    })
    .join('')

  const timelineRows = timeline.rows
    .map((row) => {
      const lanes = row.tasks
        .map((task) => {
          if (!Number.isFinite(task.startMs) || span <= 0) {
            return `<div class="bar-row"><span class="bar-label">${escapeHtml(task.id)}</span><span class="bar-track"><span class="bar-fill ${escapeHtml(task.status)}" style="width:2%"></span></span><span class="bar-value">无时间记录</span></div>`
          }
          const left = percent(task.startMs - timeline.windowStart, span)
          const width = Math.max(2, percent(task.endMs - task.startMs, span))
          const minutes = Math.round(((task.endMs - task.startMs) / 60_000) * 10) / 10
          return `<div class="bar-row"><span class="bar-label">${escapeHtml(task.id)} ${statusBadge(task.status)}</span><span class="bar-track"><span class="bar-fill lane ${escapeHtml(task.status)}" style="left:${left}%;width:${width}%"></span></span><span class="bar-value">${minutes} 分钟</span></div>`
        })
        .join('')
      return `<div class="timeline-batch"><h4>${escapeHtml(row.batch.batch)} · ${escapeHtml(row.batch.mode)}${row.batch.downgraded ? `（降级：${escapeHtml(row.batch.downgraded)}）` : ''}</h4>${lanes}</div>`
    })
    .join('')

  const checkpointRows = change.batches.map((batch) => [
    `<code>${escapeHtml(batch.id)}</code>`,
    escapeHtml(batch.mode),
    escapeHtml(batch.status),
    batch.checkpoint ? `${escapeHtml(batch.checkpoint.status)} · ${formatDate(batch.checkpoint.at)}${batch.checkpoint.detail ? ` · ${escapeHtml(clip(batch.checkpoint.detail, 300))}` : ''}` : '—',
  ])

  const violationRows = change.violations.map((violation) => [
    `<code>${escapeHtml(violation.id)}</code>`,
    escapeHtml(violation.kind),
    escapeHtml(clip(violation.path, 300)),
    escapeHtml(violation.taskId ?? '—'),
    escapeHtml(violation.source),
    formatDate(violation.detectedAt),
    violation.clearedAt ? chip('已撤销', 'ok') : chip('未撤销', 'bad'),
  ])

  const reviewRows = reviews.map((review) => [
    `<code>${escapeHtml(review.id)}</code>`,
    escapeHtml(review.taskId ?? '（终审）'),
    escapeHtml(review.kind),
    review.verdict === 'pass' ? chip('通过', 'ok') : chip('需修改', 'bad'),
    escapeHtml(String(review.findings.length)),
    escapeHtml(review.attempts),
    formatDate(review.createdAt),
  ])

  const evidenceByTask = new Map<string, EvidenceReceipt[]>()
  for (const receipt of evidence) {
    const key = receipt.taskId || '（全量/手工）'
    const list = evidenceByTask.get(key) ?? []
    list.push(receipt)
    evidenceByTask.set(key, list)
  }
  const evidenceRows = [...evidenceByTask.entries()].flatMap(([taskId, receipts]) =>
    receipts.map((receipt) => [
      `<code>${escapeHtml(taskId)}</code>`,
      `<code>${escapeHtml(receipt.id)}</code>`,
      escapeHtml(receipt.group),
      phaseBadge(receipt.phase),
      receipt.summary?.parsed ? escapeHtml(`运行 ${receipt.summary.run} / 失败 ${receipt.summary.failed}`) : escapeHtml('未解析'),
      formatDate(receipt.finishedAt),
      `<code>${escapeHtml(receipt.outputRef)}</code>`,
    ]),
  )

  return section(
    'sec-execution',
    '④',
    '执行',
    `<p class="note">串行任务耗时合计 ${timeline.serialMinutes} 分钟；实际墙钟 ${wallMinutes} 分钟；${
      savings > 0 ? `并行加速比约 ${savings}×（并行省下的时间可以直接从下面的泳道看出）。` : '本次没有记录到可比较的并行时间。'
    }</p>
     <h3>执行流程图</h3>
     <div class="diagram">${diagram || '<p class="empty">（没有执行计划）</p>'}</div>
     <h3>按批次 / 并行泳道的时间线</h3>
     <div class="timeline">${timelineRows || '<p class="empty">（没有任务时间记录）</p>'}</div>
     <h3>批次与集成检查点</h3>
     ${table(['批次', '模式', '状态', '检查点'], checkpointRows)}
     <h3>任务证据（RED / GREEN）</h3>
     ${table(['任务', '回执', '验证组', '阶段', '结果', '完成时间', '完整日志'], evidenceRows)}
     <h3>拦截与审查</h3>
     <div class="two-col">
       <div><h4>越界与违规（${violationRows.length}）</h4>${table(['ID', '类型', '路径', '任务', '来源', '时间', '状态'], violationRows)}</div>
       <div><h4>审查记录（${reviewRows.length}）</h4>${table(['ID', '任务', '类型', '结论', '发现', '轮次', '时间'], reviewRows)}</div>
     </div>`,
  )
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verificationSection(input: ReportInput): string {
  const { change, evidence, reviews, metrics } = input
  const fullSuite = evidence.filter((receipt) => receipt.group === 'full-suite')
  const latestSuite = fullSuite.slice().sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : 1)).pop()
  const regressionReceipts = evidence.filter((receipt) => Array.isArray(receipt.summary?.regressions))
  const regressions = new Set<string>()
  for (const receipt of regressionReceipts) for (const name of receipt.summary?.regressions ?? []) regressions.add(name)

  const suiteRows = fullSuite.map((receipt) => [
    `<code>${escapeHtml(receipt.id)}</code>`,
    escapeHtml(receipt.command),
    receipt.summary?.parsed
      ? escapeHtml(`运行 ${receipt.summary.run}，通过 ${receipt.summary.passed}，失败 ${receipt.summary.failed}，跳过 ${receipt.summary.skipped}`)
      : escapeHtml('未解析'),
    phaseBadge(receipt.phase),
    escapeHtml(receipt.exitCode),
    formatDate(receipt.finishedAt),
    `<code>${escapeHtml(receipt.outputRef)}</code>`,
  ])

  const evidenceRows = evidence.map((receipt) => [
    `<code>${escapeHtml(receipt.id)}</code>`,
    receipt.taskId ? `<code>${escapeHtml(receipt.taskId)}</code>` : '—',
    escapeHtml(receipt.kind),
    escapeHtml(receipt.group),
    escapeHtml(receipt.command),
    phaseBadge(receipt.phase),
    receipt.summary?.parsed
      ? escapeHtml(`运行 ${receipt.summary.run} / 通过 ${receipt.summary.passed} / 失败 ${receipt.summary.failed} / 跳过 ${receipt.summary.skipped}`)
      : escapeHtml('未解析（FR-5.2：运行数 0 不算证据）'),
    receipt.summary?.parser ? escapeHtml(receipt.summary.parser) : '—',
    formatDate(receipt.finishedAt),
    `<code>${escapeHtml(receipt.outputRef)}</code>`,
  ])

  const coverageValue = metrics.metrics['M-9'] ?? '未知'
  const coverageText = coverageValue === '未知' ? '未知（无场景或未采集）' : `${formatMetricValue(coverageValue)}%`
  const finalReview = reviews
    .filter((review) => review.kind === 'final' || review.kind === 'security')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .pop()

  const findingRows = reviews.flatMap((review) =>
    review.findings.map((finding) => [
      `<code>${escapeHtml(review.id)}</code>`,
      escapeHtml(finding.severity),
      escapeHtml(clip(finding.file, 240)),
      escapeHtml(finding.line === undefined ? '—' : String(finding.line)),
      escapeHtml(clip(finding.rule, 120)),
      escapeHtml(clip(finding.message, 400)),
      escapeHtml(clip(finding.suggestion ?? '', 300)),
    ]),
  )

  return section(
    'sec-verification',
    '⑤',
    '验证',
    `<div class="grid">
       <div class="kv"><span>全量测试回执</span><strong>${fullSuite.length} 条</strong></div>
       <div class="kv"><span>最新全量结论</span><strong>${latestSuite ? phaseBadge(latestSuite.phase) : escapeHtml('未知')}</strong></div>
       <div class="kv"><span>新增回归</span><strong>${regressionReceipts.length > 0 ? escapeHtml(String(regressions.size)) : escapeHtml('未知')}</strong></div>
       <div class="kv"><span>验收覆盖率</span><strong>${escapeHtml(coverageText)}</strong></div>
       <div class="kv"><span>终审结论</span><strong>${finalReview ? (finalReview.verdict === 'pass' ? chip('通过', 'ok') : chip('需修改', 'bad')) : escapeHtml('尚未终审')}</strong></div>
     </div>
     <h3>与基线的回归对比</h3>
     ${
       regressionReceipts.length > 0
         ? `<p>新增回归：${regressions.size === 0 ? chip('0（无回归）', 'ok') : escapeHtml([...regressions].join('、'))}</p>`
         : '<p class="empty">还没有带基线对比的全量测试回执；S2 基线未记录或尚未跑全量测试。</p>'
     }
     <h3>全量测试回执</h3>
     ${table(['回执', '命令', '计数', '判定', '退出码', '完成时间', '完整日志'], suiteRows)}
     <h3>运行证据 / 手工证据</h3>
     ${table(['回执', '任务', '类型', '验证组', '命令', '判定', '计数', '解析器', '完成时间', '完整日志'], evidenceRows)}
     <h3>审查发现（${findingRows.length} 条）</h3>
     ${table(['审查', '严重级别', '文件', '行', '规则', '说明', '建议'], findingRows)}`,
  )
}

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

const RISK_CATEGORY_LABELS: Record<string, string> = {
  security: '安全',
  performance: '性能',
  cost: '成本',
  compliance: '合规',
  maintainability: '可维护性',
}
const RISK_GRADE_LABELS: Record<string, string> = { none: '无', low: '低', medium: '中', high: '高' }

function pendingStatusBadge(status: PendingItem['status']): string {
  if (status === 'approved') return chip('已批准', 'ok')
  if (status === 'rejected') return chip('已拒绝', 'bad')
  if (status === 'expired') return chip('已过期', 'muted')
  return chip('待处理', 'warn')
}

function risksSection(input: ReportInput): string {
  const { change, artifacts, ledger } = input
  const riskDoc = artifacts.risk
  const riskRows = (riskDoc?.entries ?? []).map((entry) => [
    escapeHtml(RISK_CATEGORY_LABELS[entry.category] ?? entry.category),
    escapeHtml(RISK_GRADE_LABELS[entry.grade] ?? entry.grade),
    escapeHtml(clip(entry.reason, 400)),
    escapeHtml(clip(entry.mitigation, 400)),
    escapeHtml(clip(entry.verification, 400)),
    entry.needsHuman ? chip('需人工确认', 'warn') : chip('否', 'muted'),
  ])
  const pendingRows = change.pending.map((item) => [
    `<code>${escapeHtml(item.id)}</code>`,
    escapeHtml(item.kind),
    escapeHtml(clip(item.title, 300)),
    pendingStatusBadge(item.status),
    formatDate(item.createdAt),
    formatDate(item.decidedAt),
    escapeHtml(clip(item.decisionReason ?? '', 300)),
  ])
  const overrideRows = change.overrides.map((override) => [
    `<code>${escapeHtml(override.id)}</code>`,
    escapeHtml(override.ruleId),
    escapeHtml(clip(override.reason, 400)),
    formatDate(override.createdAt),
    override.usedAt ? chip('已使用', 'muted') : chip('未使用', 'warn'),
  ])
  const exceptionRows = change.exceptions.map((exception) => [
    `<code>${escapeHtml(exception.id)}</code>`,
    escapeHtml(exception.ruleId),
    escapeHtml(clip(exception.pathPattern ?? '—', 240)),
    escapeHtml(clip(exception.reason, 400)),
    exception.revokedAt ? chip('已撤销', 'muted') : chip('生效中', 'warn'),
  ])
  const riskEvents = ledger
    .filter((event) => event.type === 'risk.raised' || event.type === 'risk.approved' || event.type === 'risk.rejected')
    .slice(-20)
    .map((event) => [
      escapeHtml(String(event.seq)),
      formatDate(event.at),
      escapeHtml(event.type),
      escapeHtml(clip(JSON.stringify(event.data ?? {}), 300)),
    ])

  return section(
    'sec-risks',
    '⑥',
    '风险',
    `<h3>风险登记（${riskRows.length} 项）</h3>
     ${table(['类别', '等级', '原因', '缓解', '验证方式', '人工确认'], riskRows)}
     <h3>待处理项与处理结果（${pendingRows.length} 项）</h3>
     ${table(['ID', '类型', '标题', '状态', '创建时间', '处理时间', '理由'], pendingRows)}
     <div class="two-col">
       <div><h3>单次放行（${overrideRows.length}）</h3>${table(['ID', '规则', '理由', '创建时间', '状态'], overrideRows)}</div>
       <div><h3>例外（${exceptionRows.length}）</h3>${table(['ID', '规则', '路径模式', '理由', '状态'], exceptionRows)}</div>
     </div>
     <h3>风险事件（账本）</h3>
     ${table(['序号', '时间', '事件', '数据'], riskEvents)}`,
  )
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function metricsSection(input: ReportInput): string {
  const { metrics } = input
  const rows = METRIC_DEFINITIONS.map((definition: MetricDefinition) => {
    const value = metrics.metrics[definition.id] ?? '未知'
    const unknown = value === '未知'
    return [
      `<code>${escapeHtml(definition.id)}</code>`,
      escapeHtml(definition.name),
      `<strong class="${unknown ? 'unknown' : ''}">${escapeHtml(formatMetricValue(value))}</strong>`,
      escapeHtml(definition.target),
      escapeHtml(metrics.notes[definition.id] ?? ''),
    ]
  })
  return section(
    'sec-metrics',
    '⑦',
    '指标',
    `<p class="note">M-1 ~ M-18 按变更口径自动计算；取不到的指标显示为「未知」，不用 0 代替，也不参与平均值（FR-10.4）。</p>
     ${table(['ID', '指标', '数值', '目标', '统计口径'], rows)}
     <p class="empty">指标生成时间：${formatDate(metrics.generatedAt)}</p>`,
  )
}

// ---------------------------------------------------------------------------
// Appendix (artifact links + ledger excerpt)
// ---------------------------------------------------------------------------

const ARTIFACT_FILES: { key: keyof ArtifactBundle; file: string; label: string }[] = [
  { key: 'clarify', file: 'clarify.md', label: '澄清记录' },
  { key: 'proposal', file: 'proposal.md', label: '提案' },
  { key: 'spec', file: 'spec.md', label: '增量规格' },
  { key: 'context', file: 'context.md', label: '上下文' },
  { key: 'design', file: 'design.md', label: '设计' },
  { key: 'risk', file: 'risk.md', label: '风险登记' },
  { key: 'tasks', file: 'tasks.md', label: '任务卡' },
]

function appendixSection(input: ReportInput): string {
  const { change, artifacts, ledger, generatedAt } = input
  const base = `.flowgate/changes/${change.id}`
  const artifactRows: string[][] = ARTIFACT_FILES.map((entry) => [
    escapeHtml(entry.label),
    artifacts[entry.key] ? `<code>${escapeHtml(`${base}/${entry.file}`)}</code>` : '<span class="unknown">（未生成）</span>',
  ])
  artifactRows.push(['状态', `<code>${escapeHtml(`${base}/status.json`)}</code>`])
  artifactRows.push(['回执日志目录', `<code>${escapeHtml('.flowgate/state/evidence/')}</code>`])

  const ledgerRows = ledger
    .slice(-120)
    .map((event: LedgerEvent) => [
      escapeHtml(String(event.seq)),
      formatDate(event.at),
      `<code>${escapeHtml(event.type)}</code>`,
      escapeHtml(clip(JSON.stringify(event.data ?? {}), 400)),
      event.prev ? `<code>${escapeHtml(event.prev.slice(0, 18))}…</code>` : '—',
    ])
  return section(
    'sec-appendix',
    '⑧',
    '附录',
    `<h3>产物路径</h3>
     ${table(['产物', '路径'], artifactRows)}
     <h3>账本摘录（最近 ${ledgerRows.length} 条 / 共 ${ledger.length} 条）</h3>
     ${table(['序号', '时间', '事件类型', '数据', '前序哈希'], ledgerRows)}
     <h3>关于本报告</h3>
     <ul>
       <li>本报告由 FlowGate 自动生成，单文件、离线可打开，不引用任何外部资源。</li>
       <li>生成时间：${formatDate(generatedAt)}；变更：<code>${escapeHtml(change.id)}</code>；插件版本：${escapeHtml('dsh-flowgate v0.1.0')}。</li>
       <li>报告默认位于 <code>.flowgate/changes/${escapeHtml(change.id)}/report.html</code>，不进入 git；需要放进 PR 时从 <code>.flowgate/archive/</code> 复制。</li>
       <li>页面内所有用户输入均已做 HTML 转义，避免需求/日志文本注入页面脚本。</li>
     </ul>`,
  )
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const REPORT_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1f2430;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#0f7b46;--bad:#c02626;--warn:#9a6a00;--info:#1d4ed8;--track:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1a1f29;--text:#e5e8ee;--muted:#9aa3b2;--line:#2b3240;--accent:#69a2ff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--info:#93c5fd;--track:#242b38}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:var(--card);border-bottom:1px solid var(--line);padding:14px 22px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
header h1{font-size:17px;margin:0}header .meta{color:var(--muted);font-size:12px}
nav a{color:var(--accent);text-decoration:none;font-size:12px;margin-right:10px;white-space:nowrap}nav a:hover{text-decoration:underline}
main{max-width:1180px;margin:0 auto;padding:18px 22px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0;scroll-margin-top:70px}
.card h2{font-size:18px;margin:0 0 14px;border-bottom:1px solid var(--line);padding-bottom:10px}
.card h2 .sec-no{display:inline-block;color:var(--accent);margin-right:8px}.card h2 .sec-sub{display:block;font-size:12px;color:var(--muted);font-weight:400;margin-top:4px}
h3{font-size:15px;margin:18px 0 8px}h4{font-size:13px;margin:12px 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.kv{background:var(--track);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.kv span{color:var(--muted);font-size:11px}.kv strong{font-size:13px;font-weight:600}
.two-col{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:var(--track);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:none}
code{background:var(--track);border-radius:4px;padding:1px 4px;font-size:12px;word-break:break-all}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--accent);background:var(--track);border-radius:0 8px 8px 0;color:var(--text)}
ul{margin:6px 0;padding-left:20px}
.chip,.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--line);background:var(--track);color:var(--text);margin:1px 2px}
.badge.ok,.chip.ok,.lane-chip.done{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.badge.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.badge.info{color:var(--info);border-color:color-mix(in srgb,var(--info) 40%,transparent)}
.badge.muted,.chip.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:12.5px}.unknown{color:var(--warn)}
.note{background:var(--track);border-radius:8px;padding:8px 12px;font-size:12.5px;color:var(--muted)}
.progress{height:10px;background:var(--track);border-radius:999px;overflow:hidden;margin:8px 0}
.progress-fill{display:block;height:100%;background:var(--accent)}
.bars .bar-row{display:grid;grid-template-columns:130px 1fr auto;gap:10px;align-items:center;margin:5px 0}
.bar-label{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{position:relative;display:block;height:14px;border-radius:4px;background:var(--track);overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:4px;background:var(--accent)}
.bar-fill.lane{position:absolute;top:0;background:var(--info)}
.bar-value{font-size:11.5px;color:var(--muted);white-space:nowrap}
.bar-fill.done{background:var(--ok)}.bar-fill.running,.bar-fill.review{background:var(--info)}.bar-fill.failed,.bar-fill.blocked{background:var(--bad)}
.diagram-row{display:grid;grid-template-columns:120px 1fr;gap:10px;align-items:start;padding:6px 0;border-bottom:1px dashed var(--line)}
.diagram-batch{font-size:12px;color:var(--muted);white-space:nowrap}
.diagram-lanes{display:flex;flex-wrap:wrap;gap:4px}
.lane-chip{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:11.5px;background:var(--track)}
.timeline-batch{margin:12px 0}.timeline-batch h4{margin:4px 0 6px;color:var(--muted)}
footer{text-align:center;color:var(--muted);font-size:11.5px;padding:18px}
@media print{header{position:static}nav{display:none}.card{break-inside:avoid;border-color:#ccc}body{background:#fff;color:#000}}
`

const REPORT_JS = `
(function(){
  var links = document.querySelectorAll('nav a');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function (event) {
      var id = this.getAttribute('href').slice(1);
      var target = document.getElementById(id);
      if (target) { event.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  }
  var ledger = document.getElementById('ledger-toggle');
  if (ledger) {
    ledger.addEventListener('click', function () {
      var target = document.getElementById('sec-appendix');
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
})();
`

/** Render the full single-file HTML report. */
export function renderChangeReport(input: ReportInput): string {
  const { change, generatedAt } = input
  const reviews = [...input.reviews]
  const nav = [
    ['sec-overview', '概览'],
    ['sec-requirements', '需求'],
    ['sec-plan', '计划'],
    ['sec-execution', '执行'],
    ['sec-verification', '验证'],
    ['sec-risks', '风险'],
    ['sec-metrics', '指标'],
    ['sec-appendix', '附录'],
  ]
    .map(([id, label]) => `<a href="#${id}">${label}</a>`)
    .join('')
  const title = `${change.id} ${change.title} · FlowGate 交付报告`
  const body = [
    overviewSection(input),
    requirementsSection(input),
    planSection(input),
    executionSection(input),
    verificationSection(input),
    risksSection(input),
    metricsSection(input),
    appendixSection({ ...input, reviews }),
  ].join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="FlowGate">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
  <div><h1>FlowGate 交付报告 · ${escapeHtml(change.id)} ${escapeHtml(clip(change.title, 80))}</h1>
  <div class="meta">阶段 ${escapeHtml(STAGE_CARD_TITLES[change.stage] ?? change.stage)} · 生成于 ${escapeHtml(generatedAt)}</div></div>
  <nav>${nav}<a href="#sec-appendix" id="ledger-toggle">账本</a></nav>
</header>
<main>
${body}
</main>
<footer>FlowGate · 硬约束开发流程门禁 · 单文件离线报告</footer>
<script>${REPORT_JS}</script>
</body>
</html>
`
}

/** Stage titles/order re-exported for hosts that import the report barrel. */
export { STAGE_CARD_TITLES, STAGE_CARD_ORDER } from '../stage-meta'
export type { StageId }
