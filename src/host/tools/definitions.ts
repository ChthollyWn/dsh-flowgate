/**
 * FlowGate 暴露给模型的 20 个工具（03 §10.1 + v0.5.1 修复通道）。
 *
 * 分组：
 * - 流程推进：flow_status / flow_new_change / flow_submit / flow_task_start /
 *   flow_task_done / flow_request_scope_change / flow_request_plan_change；
 * - 证据与审查：flow_verify / flow_attach_evidence / flow_report_risk /
 *   flow_propose_rule / flow_investigate / flow_submit_analysis / flow_diff /
 *   flow_declare_rework；
 * - 修复通道（P1-8/P1-9）：flow_fix_start / flow_fix_done / flow_fix_abort；
 * - 事故与自暂停（P1-8）：flow_self_pause / flow_incident_close。
 *
 * 红线：**没有任何批准/放行/降低等级类工具**——那些只有 `/flow` 命令（负责人）
 * 能触发。修复通道里的"自由迭代"仅限声明的 scope 内，且必须留 RED→GREEN 证据；
 * 自暂停后 agent 不能自行恢复（只能负责人 `/flow on` 或宿主重启 autoRearm）。
 * 工具参数全部写清必填项与示例；错误统一返回 { error, hint, validValues }。
 */
import type { DshToolDefinition } from '../adapters/dsh-types.js'
import type { EngineLike } from '../types.js'
import type { HostRuntime } from '../runtime.js'
import type { CitationRef, EvidenceReceipt } from '../../core/types.js'
import { defineHostTool, fail, ok, type HostToolValue, type ParamSpecs } from './schema.js'
import { HostError, toAgentError } from '../errors.js'
import { captureTaskStartSnapshot } from '../postcheck/index.js'
import {
  abortRepair,
  closeIncident,
  finishRepair,
  repairView,
  safeGetProjectFlags,
  safeGetRepair,
  safeGetTakeoverMode,
  selfPause,
  startRepair,
} from '../engine-api.js'
import { readTaskDiff, reviewCapability, runFinalReview, runInvestigation, runTaskReview, taskReviewRounds } from '../review/index.js'
import { runRuntimeEvidence } from '../verify/run.js'

/** 取引擎（工具调用时引擎一定已初始化；仍做兜底）。 */
async function requireEngine(runtime: HostRuntime): Promise<EngineLike> {
  const engine = runtime.engine() ?? (await runtime.ensureEngine())
  if (!engine) throw new HostError('FlowGate 引擎未就绪', '确认项目已 /flow init；运行 /flow doctor 诊断')
  return engine
}

function envelopeSummary(changeTitle: string | undefined, stage: string | undefined): string {
  return `变更${changeTitle ? `「${changeTitle}」` : ''}｜阶段 ${stage ?? '未知'}`
}

function gateItemLines(engine: EngineLike): string[] {
  const change = engine.currentChange()
  const snapshot = engine.snapshot()
  const gate = snapshot.awaitingGate ?? snapshot.pendingGate
  if (!change || !gate) return []
  const record = change.gates[gate]
  if (!record?.items || record.items.length === 0) return []
  return [`门禁 ${gate} 检查项：`, ...record.items.map((item) => `  ${item.passed ? '✓' : '✗'} ${item.label}${item.passed ? '' : `（${item.hint ?? '未通过'}）`}`)]
}

/** 构造全部工具定义（一次注册）。 */
export function createFlowTools(runtime: HostRuntime): DshToolDefinition[] {
  const tools: DshToolDefinition[] = []

  // 1) flow_status -------------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_status',
      description:
        'FlowGate 状态（只读）：当前变更、阶段、复杂度/风险、当前门禁检查项、活动任务、待处理项、执行图进度与下一步。任何时候都可以调用。',
      parameters: {},
      execute: async () => {
        const engine = await requireEngine(runtime)
        if (!engine.isInitialized()) {
          return ok('FlowGate 未启用：项目没有 .flowgate/config.yaml。下一步：等待负责人在授权卡片上启用（agent 不能初始化）。', {
            initialized: false,
          })
        }
        const snapshot = engine.snapshot()
        const change = engine.currentChange()
        const lines: string[] = [`${snapshot.statusLine}`]
        if (snapshot.changeId) lines.push(envelopeSummary(snapshot.title, snapshot.stage))
        if (snapshot.complexity) lines.push(`复杂度：${snapshot.complexity}｜风险：${snapshot.risk ?? 'normal'}`)
        if (snapshot.activeTaskId) lines.push(`活动任务：${snapshot.activeTaskId}`)
        if (snapshot.awaitingGate) lines.push(`等待负责人批准：${snapshot.awaitingGate}`)
        if (snapshot.pending.length > 0) lines.push(`待处理项：${snapshot.pending.map((item) => `${item.id} ${item.title}`).join('；')}`)
        if (snapshot.violations.length > 0) lines.push(`越界改动：${snapshot.violations.map((violation) => violation.path).join('、')}`)
        lines.push(...gateItemLines(engine))
        lines.push(`下一步：${snapshot.nextStep}`)
        if (snapshot.off) lines.push('注意：本会话门禁已被负责人临时关闭，操作不再拦截。')
        if (snapshot.locked) lines.push('注意：处于锁定模式，写操作被拒绝；等待负责人在授权卡片上修复。')
        // v0.5.1：接管模式 / 暂停来源 / 事故 / 修复通道（让 agent 知道当前为什么没被拦）。
        const takeover = safeGetTakeoverMode(engine) ?? snapshot.takeover
        if (takeover !== undefined && takeover !== 'enforce') {
          lines.push(
            takeover === 'observe'
              ? '接管模式：observe（只记录不拦截；常见于自举开发本插件时）'
              : '接管模式：off（不拦截不记录；safe-mode 或负责人配置）',
          )
        }
        if (snapshot.offBy !== undefined) {
          lines.push(`暂停来源：${snapshot.offBy === 'human' ? '负责人手动' : 'agent 自暂停（事故）'}`)
        }
        if (snapshot.incident) {
          lines.push(
            `事故：${snapshot.incident.id}（${snapshot.incident.severity}）${snapshot.incident.reason}｜恢复：负责人 /flow on；恢复后由负责人或 agent 调 flow_incident_close 补审计。`,
          )
        }
        const repair = repairView(safeGetRepair(engine) ?? snapshot.repair)
        if (repair) {
          lines.push(
            `修复通道：${repair.id}「${repair.title}」｜RED ${repair.red ? '✓' : '✗'} GREEN ${repair.green ? '✓' : '✗'}｜已放行动作 ${repair.actions}｜完成：flow_fix_done；放弃：flow_fix_abort。`,
          )
        }
        const notices = safeTakeNotices(engine)
        if (notices.length > 0) lines.push(`通知：${notices.join('；')}`)
        return ok(lines.join('\n'), {
          initialized: true,
          snapshot: {
            changeId: snapshot.changeId,
            title: snapshot.title,
            kind: snapshot.kind,
            stage: snapshot.stage,
            lifecycle: snapshot.lifecycle,
            complexity: snapshot.complexity,
            risk: snapshot.risk,
            awaitingGate: snapshot.awaitingGate,
            pendingGate: snapshot.pendingGate,
            activeTaskId: snapshot.activeTaskId,
            pending: snapshot.pending.map((item) => ({ id: item.id, kind: item.kind, title: item.title })),
            violations: snapshot.violations.map((violation) => violation.path),
            batches: snapshot.batches,
            tasks: Object.values(change?.tasks ?? {}),
            nextStep: snapshot.nextStep,
            off: snapshot.off,
            offBy: snapshot.offBy,
            locked: snapshot.locked,
            takeover: safeGetTakeoverMode(engine) ?? snapshot.takeover,
            incident: snapshot.incident,
            repair: snapshot.repair,
            projectFlags: safeGetProjectFlags(engine),
          },
        })
      },
    }),
  )

  // 2) flow_new_change ---------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_new_change',
      description:
        '立项：创建新的变更（默认）或分析任务。FlowGate 启用后所有改动都必须先立项。' +
        '立项前先评估本次需求的大小与清晰度，用 assessment 声明自动流程路由，宿主 auto-review 会校验并可能调整：' +
        '复杂/高风险/敏感面 → full（人工门）；中等 → standard（合并 G1+G3 一次确认）；低复杂度且清晰可验证 → fast（G1/G3/G6 检查通过后自动通过，直到交付归档）。',
      parameters: {
        title: { type: 'string', required: true, description: '一句话标题，例如「续费回调幂等」' },
        summary: { type: 'string', description: '补充说明：为什么做、影响范围' },
        kind: { type: 'string', enum: ['change', 'analysis'], description: 'change=开发变更（默认）；analysis=只读分析任务' },
        complexityHint: { type: 'string', enum: ['low', 'medium', 'high', 'ultra'], description: '复杂度建议' },
        riskHint: { type: 'string', enum: ['normal', 'high'], description: '风险建议' },
        fromRoadmap: { type: 'string', description: '从路线图条目立项，如 "C2"' },
        relatedTo: { type: 'string', description: '关联的分析任务 id，如 "A-001"' },
        project: { type: 'boolean', description: '声明新项目：先做项目级澄清与路线图' },
        assessment: {
          type: 'object',
          description:
            '本次需求的规模/清晰度自评（auto-review 的输入）。越清晰、范围越小，越可能获得 fast 自动流程；不确定就写 full。',
          properties: {
            route: { type: 'string', enum: ['full', 'standard', 'fast'], description: '建议路由；省略时按复杂度推导（low/medium→standard，high/ultra→full）' },
            autoApprove: { type: 'boolean', description: 'fast 下是否自动通过 G1/G3/G6（fast 强制为 true）' },
            clear: { type: 'boolean', description: '需求是否已足够清晰、无需再澄清（fast 必要条件）' },
            goal: { type: 'string', description: '一句话目标（写入流程计划）' },
            acceptance: { type: 'array', items: { type: 'string' }, description: '可测量的验收要点（fast 至少 2 条）' },
            scope: { type: 'array', items: { type: 'string' }, description: '预计改动的路径/glob（fast 1–5 条）' },
            verify: { type: 'string', description: '任务验证命令，如 `pnpm test`（fast 必填）' },
            risks: { type: 'array', items: { type: 'string' }, description: '风险信号（支付/权限/迁移等）；命中敏感面会被降级为 full' },
            reasons: { type: 'array', items: { type: 'string' }, description: '自评理由，写入流程计划供负责人复核' },
          },
        },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const input: import('../../core/types.js').NewChangeInput = { title: String(args.title) }
        if (typeof args.summary === 'string') input.summary = args.summary
        if (args.kind === 'analysis' || args.kind === 'change') input.kind = args.kind
        if (typeof args.complexityHint === 'string') input.complexityHint = args.complexityHint as import('../../core/types.js').Complexity
        if (typeof args.riskHint === 'string') input.riskHint = args.riskHint as import('../../core/types.js').RiskLevel
        if (typeof args.fromRoadmap === 'string') input.fromRoadmap = args.fromRoadmap
        if (typeof args.relatedTo === 'string') input.relatedTo = args.relatedTo
        if (args.project === true) input.project = true
        if (args.assessment !== null && typeof args.assessment === 'object' && !Array.isArray(args.assessment)) {
          const raw = args.assessment as Record<string, unknown>
          const assessment: NonNullable<import('../../core/types.js').NewChangeInput['assessment']> = {}
          if (raw.route === 'full' || raw.route === 'standard' || raw.route === 'fast') assessment.route = raw.route
          if (typeof raw.autoApprove === 'boolean') assessment.autoApprove = raw.autoApprove
          if (typeof raw.clear === 'boolean') assessment.clear = raw.clear
          if (typeof raw.goal === 'string') assessment.goal = raw.goal
          if (Array.isArray(raw.acceptance)) assessment.acceptance = toStringArray(raw.acceptance)
          if (Array.isArray(raw.scope)) assessment.scope = toStringArray(raw.scope)
          if (typeof raw.verify === 'string') assessment.verify = raw.verify
          if (Array.isArray(raw.risks)) assessment.risks = toStringArray(raw.risks)
          if (Array.isArray(raw.reasons)) assessment.reasons = toStringArray(raw.reasons)
          input.assessment = assessment
        }
        const outcome = await engine.newChange(input)
        runtime.emit()
        const suggestion = outcome.suggestion
        const lines = [outcome.message, `变更 id：${outcome.changeId}`]
        if (suggestion) {
          lines.push(`建议复杂度：${suggestion.complexity}（${suggestion.reasons.complexity.join('；') || '无'}）`)
          lines.push(`建议风险：${suggestion.risk}（${suggestion.reasons.risk.join('；') || '无'}）`)
        }
        if (outcome.flowPlan !== undefined) {
          const plan = outcome.flowPlan
          lines.push(`自动流程：${plan.route}（${plan.verdict === 'approved' ? 'auto-review 通过模型建议' : 'auto-review 已调整'}；autoApprove=${plan.autoApprove}）`)
          for (const reason of plan.reasons) lines.push(`- ${reason}`)
          for (const check of plan.checks.filter((item) => !item.passed)) lines.push(`! ${check.label}：${check.detail ?? ''}`)
        }
        if (outcome.awaiting === 'owner') lines.push('等级需要负责人确认：等待负责人在授权卡片或面板上确认，或直接继续。')
        return ok(lines.join('\n'), { changeId: outcome.changeId, suggestion, awaiting: outcome.awaiting, flowPlan: outcome.flowPlan })
      },
    }),
  )

  // 3) flow_submit -------------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_submit',
      description:
        '提交当前阶段产物到门禁检查（GR/G0/G1/G2/G3/G5/G6）。失败会返回逐项 { item, label, hint, example }；人工门检查通过后返回 awaiting:"owner"，等待负责人在授权卡片上批准或退回。',
      parameters: {
        gate: { type: 'string', required: true, enum: ['GR', 'G0', 'G1', 'G2', 'G3', 'G5', 'G6'], description: '要提交的门' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const gate = String(args.gate) as 'GR' | 'G0' | 'G1' | 'G2' | 'G3' | 'G5' | 'G6'
        // G5/G6 要求终审（高风险还要安全审查）记录；此前没有生产者，
        // 开着 review.enabled 时提交 G5 必然"缺少 S5 终审记录"（P0-5）。
        // 这里在提交 G5 前自动跑一次只读终审子 agent 并登记记录。
        let finalReviewMessage = ''
        let runtimeMessage = ''
        if (gate === 'G5') {
          const change = engine.currentChange()
          if (change && change.stage === 'S5') {
            // T4.2：配置了 run 命令时由宿主启动服务、健康检查、采集日志并清理（不是模型自己跑）。
            const runtimeEvidence = await runRuntimeEvidence(runtime, engine)
            runtimeMessage = runtimeEvidence.attempted ? runtimeEvidence.message : ''
            if (runtimeEvidence.attempted && !runtimeEvidence.ok) {
              return fail(
                `S5 运行证据失败：${runtimeEvidence.message}`,
                '修复服务启动/health 配置后重新 flow_submit G5；或用 attach_evidence 提交日志+冒烟证据（普通风险兜底）',
                { gate: 'G5', runtimeEvidence: runtimeEvidence.message },
              )
            }
          }
          if (change && change.stage === 'S5' && engine.getConfig().review.enabled) {
            const finalReview = await runFinalReview(runtime)
            finalReviewMessage = finalReview.message
            if (!finalReview.ok) {
              // 不可用 / 启动失败：直接返回可执行提示（否则 submitGate 会因缺终审记录失败且原因不直观）。
              if (/不可用|启动失败|没有|主会话未绑定|服务消失|读取终审/.test(finalReview.message)) {
                return fail(
                  `S5 终审无法执行：${finalReview.message}`,
                  '需要带子 agent 的宿主；或在 .flowgate/config.yaml 设 review.enabled=false（会关闭审查要求，不推荐）',
                  { gate: 'G5' },
                )
              }
              // 读取覆盖不足：不能带着"未覆盖"的终审记录通过 G5（finalReviewOutcome 只看 verdict）。
              if (!finalReview.coverageOk) {
                return fail(
                  `S5 终审未覆盖全部改动：${finalReview.message}`,
                  '重新提交 G5 重试终审；若持续失败，检查宿主 sessionQuery 能力与审查子 agent 的读取行为',
                  { gate: 'G5' },
                )
              }
            }
          }
        }
        const result = await engine.submitGate(gate)
        runtime.emit()
        const lines = [
          ...(runtimeMessage !== '' ? [`运行证据：${runtimeMessage}`] : []),
          ...(finalReviewMessage !== '' ? [`终审：${finalReviewMessage}`] : []),
          result.message,
        ]
        for (const failure of result.failures) {
          lines.push(`✗ ${failure.label}：${failure.hint ?? ''}${failure.example ? `（例：${failure.example}）` : ''}`)
        }
        if (result.awaiting === 'owner') lines.push(`检查全部通过，等待负责人批准 ${gate}：等待负责人在授权卡片上批准或退回（退回需写理由）。本轮应结束并告知负责人。`)
        return ok(lines.join('\n'), {
          gate: result.gate,
          passed: result.passed,
          awaiting: result.awaiting,
          stage: result.stage,
          finalReview: finalReviewMessage === '' ? undefined : finalReviewMessage,
          failures: result.failures.map((failure) => ({ item: failure.item, label: failure.label, hint: failure.hint, example: failure.example })),
          items: result.items.map((item) => ({ item: item.item, label: item.label, passed: item.passed, hint: item.hint })),
        })
      },
    }),
  )

  // 4) flow_task_start ---------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_task_start',
      description:
        'S4 领取任务（按执行图顺序，不能跳批）。返回任务卡、覆盖场景、上下文片段、TDD 要求与验证组。派发模式（dispatch=subagent/auto）下仅 `run: main` 的任务用本工具领取（子 agent 任务用 flow_dispatch_next）；inline 模式全部用本工具。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id，如 "T2"' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const outcome = await engine.taskStart(String(args.taskId))
        if (outcome.ok) await captureTaskStartSnapshot(runtime, String(args.taskId))
        runtime.emit()
        if (!outcome.ok) return fail(outcome.message, outcome.hint ?? '按执行图顺序领取任务；在 FlowGate 面板查看可领取任务', {
          message: outcome.message,
        })
        const envelope = outcome.envelope
        const lines = [outcome.message]
        if (envelope) {
          lines.push(`任务：${envelope.task.id} ${envelope.task.title}｜批次 ${envelope.batch}｜${envelope.mode}`)
          lines.push(`范围：${[...envelope.task.scope, ...envelope.task.newFiles].join('、') || '（无）'}`)
          if (envelope.coveredScenarios.length > 0) lines.push(`覆盖场景：${envelope.coveredScenarios.map((scenario) => scenario.id).join('、')}`)
          lines.push(`TDD：${envelope.tdd ? `必须（先 RED 后 GREEN）${envelope.task.tddReason ? `：${envelope.task.tddReason}` : ''}` : '可选'}`)
          lines.push(`验证组：${envelope.verifyGroups.map((group) => `${group.group}=${group.command}`).join('；') || '（任务卡未定义，请先申请计划修订）'}`)
          if (envelope.contextExcerpt) lines.push(`上下文片段：\n${envelope.contextExcerpt}`)
          if (envelope.worktree) lines.push(`工作目录（worktree）：${envelope.worktree}`)
        }
        return ok(lines.join('\n'), outcome.envelope ?? { ok: true })
      },
    }),
  )

  // 5) flow_task_done ----------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_task_done',
      description:
        'S4 提交任务完成：检查证据新鲜度、TDD（RED→GREEN）、范围与审查。通过后自动提交并检查 G4。需要先 flow_verify 产生新鲜回执。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id，如 "T2"' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const taskId = String(args.taskId)
        const notes: string[] = []
        // 审查（03 §7.1：插件按风险自动审查；审查失败不消耗轮次，由任务门决定是否阻断）。
        let reviewNote: string | null = null
        try {
          const config = engine.getConfig()
          // 高风险任务门要求 2 轮审查（levels.reviewRoundsPerTask）；host 必须按
          // 已有 pass 数补足轮次，不能"有一条 pass 就短路"（否则任务门永久缺一轮）。
          const required = taskReviewRounds(engine)
          const passCount = (): number =>
            (engine.currentChange()?.reviews ?? []).filter(
              (review) => review.taskId === taskId && review.verdict === 'pass' && review.coverageOk,
            ).length
          if (config.review.enabled && required > 0 && passCount() < required) {
            const capability = reviewCapability(runtime)
            if (capability.available) {
              const messages: string[] = []
              for (let round = passCount(); round < required; round += 1) {
                const review = await runTaskReview(runtime, taskId)
                messages.push(review.message)
                if (!review.ok && config.review.requireForTaskGate) {
                  return fail(`任务 ${taskId} 的审查未通过或缺失：${review.message}`, '修复审查发现后重试 flow_task_done；或由负责人豁免（低风险）', {
                    taskId,
                    findings: review.findings,
                    coverageOk: review.coverageOk,
                  })
                }
              }
              reviewNote = messages.join('；')
            } else {
              reviewNote = `审查不可用（${capability.reason ?? '宿主缺少子 agent'}），任务门可能标记审查缺失`
            }
          }
        } catch (error) {
          reviewNote = `审查执行异常：${toAgentError(error).error}`
        }
        const outcome = await engine.taskDone(taskId)
        runtime.emit()
        const lines = [outcome.message]
        if (reviewNote) lines.push(`审查：${reviewNote}`)
        for (const failure of outcome.failures) {
          lines.push(`✗ ${failure.label}：${failure.hint ?? ''}${failure.example ? `（例：${failure.example}）` : ''}`)
        }
        if (outcome.committed) lines.push('已自动提交本次任务改动。')
        if (outcome.nextStage) lines.push(`下一阶段：${outcome.nextStage}`)
        return ok(lines.join('\n'), {
          ok: outcome.ok,
          passed: outcome.passed,
          committed: outcome.committed,
          nextStage: outcome.nextStage,
          failures: outcome.failures.map((failure) => ({ item: failure.item, label: failure.label, hint: failure.hint, example: failure.example })),
        })
      },
    }),
  )

  // 6) flow_request_scope_change ----------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_request_scope_change',
      description: 'S4 申请扩大任务范围（新增文件/目录）。生成待处理项 SC-n，由负责人在授权卡片上批准或退回；批准前写入仍被拒绝。',
      parameters: {
        taskId: { type: 'string', required: true, description: '任务 id' },
        add: {
          type: 'array',
          required: true,
          description: '要加入范围的路径（仓库相对路径或 glob）',
          items: { type: 'string' },
        },
        reason: { type: 'string', required: true, description: '为什么必须扩大范围' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const add = toStringArray(args.add)
        if (add.length === 0) return fail('add 不能为空', '例：add: ["src/renewal/**"]')
        const item = await engine.requestScopeChange({ taskId: String(args.taskId), add, reason: String(args.reason) })
        runtime.emit()
        return ok(`已生成范围变更申请 ${item.id}（${item.title}）。等待负责人在授权卡片上处理后生效。`, {
          id: item.id,
          status: item.status,
        })
      },
    }),
  )

  // 7) flow_report_risk --------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_report_risk',
      description: 'S3–S6 主动上报风险：生成风险接管项 RK-n，由负责人处理（批准接管或退回）。',
      parameters: {
        category: { type: 'string', required: true, enum: ['security', 'performance', 'cost', 'compliance', 'maintainability'], description: '风险类别' },
        description: { type: 'string', required: true, description: '风险描述：什么情况会出问题' },
        proposal: { type: 'string', required: true, description: '建议的处置方式' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const item = await engine.reportRisk({
          category: String(args.category),
          description: String(args.description),
          proposal: String(args.proposal),
        })
        runtime.emit()
        return ok(`已上报风险 ${item.id}（${item.title}）。等待负责人在授权卡片上处理。`, {
          id: item.id,
          status: item.status,
        })
      },
    }),
  )

  // 8) flow_attach_evidence ---------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_attach_evidence',
      description:
        'S4–S5 附加手工证据（标为"agent 自述"，不能代替 flow_verify 的回执）。用于运行日志、截图、外部报告等。',
      parameters: {
        taskId: { type: 'string', description: '任务 id（全量验证时可省略）' },
        kind: { type: 'string', required: true, enum: ['test', 'build', 'lint', 'typecheck', 'run', 'manual'], description: '证据类别' },
        path: { type: 'string', required: true, description: '证据文件路径（仓库相对）' },
        note: { type: 'string', description: '说明这份证据证明了什么' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const receipt = await engine.attachEvidence({
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
          kind: String(args.kind) as EvidenceReceipt['kind'],
          path: String(args.path),
          ...(typeof args.note === 'string' ? { note: args.note } : {}),
        })
        runtime.emit()
        return ok(`已附加证据 ${receipt.id}（${receipt.kind}，agent 自述）。注意：只有 flow_verify 的回执能作为 RED/GREEN 证据。`, {
          id: receipt.id,
          kind: receipt.kind,
          outputRef: receipt.outputRef,
        })
      },
    }),
  )

  // 9) flow_verify -------------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_verify',
      description:
        'S2–S5 由插件亲自执行验证命令并记录回执（唯一能作为 RED/GREEN 证据的来源）。返回命令、退出码、运行/通过/失败/跳过数、输入哈希与完整输出路径。修复通道（flow_fix_start 之后）下可直接用：group 自定，如 repro（先跑失败命令拿 RED、修复后再跑拿 GREEN）。',
      parameters: {
        taskId: { type: 'string', description: '任务 id（S5 全量验证可省略）' },
        group: { type: 'string', required: true, description: '验证组名（来自任务卡的 verify.group）' },
        command: { type: 'string', description: '覆盖任务卡里的命令（不推荐；默认用任务卡命令）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const receipt = await engine.runVerify({
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
          group: String(args.group),
          ...(typeof args.command === 'string' ? { command: args.command } : {}),
        })
        runtime.emit()
        const summary = receipt.summary
        const lines = [
          `flow_verify ${receipt.id}：${receipt.command}`,
          `退出码 ${receipt.exitCode}${receipt.timedOut ? '（超时）' : ''}｜阶段判定 ${receipt.phase}｜${summary ? `运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}` : '未解析出测试数量'}`,
          `完整输出：${receipt.outputRef}`,
        ]
        if (receipt.notes) lines.push(`说明：${receipt.notes}`)
        if (receipt.phase !== 'green' && receipt.phase !== 'red') lines.push('注意：这次回执不能作为 GREEN 证据；检查验证命令是否真的跑了测试。')
        return ok(lines.join('\n'), {
          receipt: {
            id: receipt.id,
            command: receipt.command,
            exitCode: receipt.exitCode,
            phase: receipt.phase,
            summary,
            inputsHash: receipt.inputsHash,
            outputRef: receipt.outputRef,
            timedOut: receipt.timedOut,
            taskId: receipt.taskId,
          },
        })
      },
    }),
  )

  // 10) flow_request_plan_change ----------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_request_plan_change',
      description: 'S4 申请修订执行计划（新增任务/调整顺序），生成计划修订申请 PC-n。已开始/已完成的任务不能改。',
      parameters: {
        add: { type: 'array', description: '要新增的任务（每个元素是任务卡 markdown 片段）', items: { type: 'string' } },
        reorder: { type: 'array', description: '新的任务顺序（任务 id 列表；只调整同一批次内未开始任务的先后）', items: { type: 'string' } },
        reason: { type: 'string', required: true, description: '为什么必须修订计划' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const request: { add?: string[]; reorder?: string[]; reason: string } = { reason: String(args.reason) }
        const add = toStringArray(args.add)
        const reorder = toStringArray(args.reorder)
        if (add.length > 0) request.add = add
        if (reorder.length > 0) request.reorder = reorder
        if (add.length === 0 && reorder.length === 0) return fail('add 与 reorder 至少提供一个', '例：reorder: ["T1","T3","T2"]')
        const item = await engine.requestPlanChange(request)
        runtime.emit()
        return ok(`已生成计划修订申请 ${item.id}（${item.title}）。等待负责人在授权卡片上处理。`, {
          id: item.id,
          status: item.status,
        })
      },
    }),
  )

  // 11) flow_propose_rule -----------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_propose_rule',
      description: 'S4–S6 把一次真实发现沉淀为规则提议 RL-n（由负责人审批后写入 .flowgate/rules/）。',
      parameters: {
        finding: { type: 'string', required: true, description: '发现了什么问题（具体到文件/行为）' },
        rule: { type: 'string', required: true, description: '建议新增的规则：命中条件 + 处置' },
        example: { type: 'string', required: true, description: '正例/反例各一个' },
        scope: { type: 'string', required: true, description: '适用范围：本变更 / 本项目 / 全局' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const item = await engine.proposeRule({
          finding: String(args.finding),
          rule: String(args.rule),
          example: String(args.example),
          scope: String(args.scope),
        })
        runtime.emit()
        return ok(`已生成规则提议 ${item.id}（${item.title}）。等待负责人在授权卡片上处理。`, {
          id: item.id,
          status: item.status,
        })
      },
    }),
  )

  // 12) flow_investigate ------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_investigate',
      description:
        '分析任务 / S1–S2 发起只读调查：启动只读取证子 agent 回答指定问题（带 文件:行号 引用）。默认最多 2 个同时运行。',
      parameters: {
        questions: { type: 'array', required: true, description: '要调查的问题列表', items: { type: 'string' } },
        benefit: { type: 'string', required: true, description: '调查收益：为什么需要它、不做会怎样' },
        taskId: { type: 'string', description: '关联的分析任务 id' },
      },
      execute: async (args) => {
        const questions = toStringArray(args.questions)
        if (questions.length === 0) return fail('questions 不能为空', '至少写一个具体问题，例如「退款状态机在哪些文件实现？」')
        const result = await runInvestigation(runtime, {
          questions,
          benefit: String(args.benefit),
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
        })
        if (!result.ok) return fail(result.message, '确认宿主支持 ctx.subagents 与只读取证 preset；运行 /flow doctor', {})
        return ok(`${result.message}\n\n${result.report}`, { report: result.report })
      },
    }),
  )

  // 13) flow_submit_analysis -------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_submit_analysis',
      description: '分析任务：提交结论与建议，插件会核验引用（文件:行号）后归档。结论必须带可核验引用。',
      parameters: {
        conclusion: { type: 'string', required: true, description: '调查结论（带 文件:行号 引用）' },
        proposal: { type: 'string', required: true, description: '建议的后续动作' },
        limitations: { type: 'array', description: '本次分析的局限/未覆盖范围', items: { type: 'string' } },
        citations: {
          type: 'array',
          description: '引用列表 [{ file, startLine, endLine, quote? }]',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', required: true },
              startLine: { type: 'integer', required: true },
              endLine: { type: 'integer', required: true },
              quote: { type: 'string' },
            },
          },
        },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const citations = toCitations(args.citations)
        const outcome = await engine.submitAnalysis({
          conclusion: String(args.conclusion),
          proposal: String(args.proposal),
          limitations: toStringArray(args.limitations),
          citations,
        })
        runtime.emit()
        const lines = [outcome.message]
        for (const check of outcome.citationChecks) {
          lines.push(`${check.ok ? '✓' : '✗'} ${check.citation.file}:${check.citation.startLine}-${check.citation.endLine}${check.error ? `（${check.error}）` : ''}`)
        }
        return ok(lines.join('\n'), { ok: outcome.ok, archived: outcome.archived, citations: outcome.citationChecks })
      },
    }),
  )

  // 15) flow_declare_rework --------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_declare_rework',
      description: 'T3.8 返工声明：按类型失效受影响任务的回执与审查（缺陷返工沿 depends_on 向下扩散；需求/影响不明全部失效并解冻产物）。必须写理由。',
      parameters: {
        kind: { type: 'string', required: true, enum: ['defect', 'requirement', 'unknown'], description: '返工类型' },
        tasks: { type: 'array', description: '缺陷返工时受影响的任务 id；省略则保守地让全部任务失效', items: { type: 'string' } },
        reason: { type: 'string', required: true, description: '返工原因（关联的缺陷/需求变更）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const kind = String(args.kind)
        if (kind !== 'defect' && kind !== 'requirement' && kind !== 'unknown') {
          return fail('kind 只能是 defect / requirement / unknown', '例：flow_declare_rework({ kind: "defect", tasks: ["T2"], reason: "回调幂等有缺陷" })')
        }
        const result = await engine.declareRework({
          kind,
          ...(Array.isArray(args.tasks) ? { taskIds: toStringArray(args.tasks) } : {}),
          reason: String(args.reason ?? ''),
        })
        runtime.emit()
        return ok(
          `返工已声明（${kind}）：失效任务 ${result.invalidatedTasks.join('、') || '无'}；保留任务 ${result.keptTasks.join('、') || '无'}；阶段 ${result.stage}。`,
          { invalidatedTasks: result.invalidatedTasks, keptTasks: result.keptTasks, stage: result.stage },
        )
      },
    }),
  )

  // 16) flow_fix_start --------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_fix_start',
      description:
        '修复通道（bugfix 一等公民）：声明一次修复，拿到 FIX-id 后可在声明的 scope 内自由迭代——不需要立项、不需要七阶段文档、不需要人工门，但必须留下 RED→GREEN 证据。' +
        '适用：生产事故、回归缺陷、行为明确的 bug。需求变更/新功能仍走 flow_new_change。' +
        '流程：flow_fix_start → 先 flow_verify 跑失败命令拿 RED（group 自定，如 repro）→ 在 scope 内修复 → flow_verify 拿 GREEN 并跑声明验证命令确认回归 → flow_fix_done。',
      parameters: {
        title: { type: 'string', required: true, description: '一句话标题，例如「续费回调重复扣款」' },
        symptom: { type: 'string', required: true, description: '可观察的故障现象：报错/错误行为/影响范围' },
        repro: { type: 'string', description: '复现步骤（建议同时用 flow_verify 跑出 RED 证据）' },
        scope: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: '允许改动的仓库相对路径/glob（1–20 条；超出会被拒绝，修复动作只放行命中 scope 的写入）',
        },
        verify: { type: 'string', required: true, description: '验证命令，如 `pnpm vitest run test/xx.test.ts`（修复完成后用于确认回归）' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '可测量的验收要点（可选，写入修复声明）' },
        severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: '优先级：P0 生产不可用 / P1 主要功能受损 / P2 一般缺陷（默认 P2）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const scope = toStringArray(args.scope)
        if (scope.length === 0) {
          return fail('scope 不能为空', '至少写一条允许改动的路径/glob，例如 scope: ["src/renewal/**"]')
        }
        const severity =
          args.severity === 'P0' || args.severity === 'P1' || args.severity === 'P2' ? args.severity : undefined
        const acceptance = toStringArray(args.acceptance)
        const repair = await startRepair(engine, {
          title: String(args.title),
          symptom: String(args.symptom),
          ...(typeof args.repro === 'string' && args.repro !== '' ? { repro: args.repro } : {}),
          scope,
          verify: String(args.verify),
          ...(acceptance.length > 0 ? { acceptance } : {}),
          ...(severity !== undefined ? { severity } : {}),
          openedBy: 'agent',
        })
        runtime.emit()
        const lines = [
          `修复通道已开启：${repair.id}「${repair.title}」（${repair.severity}）。`,
          `范围（只放行命中这些路径的修复写入）：${repair.scope.join('、')}`,
          `验证命令：${repair.verify}`,
          ...(repair.acceptance.length > 0 ? [`验收要点：${repair.acceptance.join('；')}`] : []),
          '这是一条修复通道：范围内自由迭代，无需立项/人工门；但必须留 RED→GREEN 证据。',
          '下一步（按顺序）：',
          '1) 先写复现/跑失败命令拿 RED：flow_verify({ group: "repro", command: "<必失败的命令>" })；',
          '2) 在 scope 内修复（范围外写入会被拒绝，需要时先说明理由扩 scope 或转 flow_new_change）；',
          '3) 再 flow_verify({ group: "repro" }) 拿 GREEN，并跑声明的验证命令确认回归；',
          `4) flow_fix_done({ summary }) 关闭修复通道；放弃用 flow_fix_abort({ reason })。`,
        ]
        return ok(lines.join('\n'), {
          id: repair.id,
          title: repair.title,
          severity: repair.severity,
          scope: repair.scope,
          verify: repair.verify,
          acceptance: repair.acceptance,
          opensAt: repair.openedAt,
          next: 'RED（flow_verify group=repro）→ 修复 → GREEN → flow_fix_done',
        })
      },
    }),
  )

  // 17) flow_fix_done ---------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_fix_done',
      description:
        '关闭修复通道：校验 RED→GREEN 证据、改动是否越出 scope、声明的验证命令是否通过；成功才落 .flowgate/fixes/<FIX-id>.json 与账本审计。前置失败会返回逐项原因且不清空修复声明（可继续修）。',
      parameters: {
        summary: { type: 'string', description: '修复说明：根因 / 改了什么 / 如何验证（建议写清，进入修复报告）' },
        commit: { type: 'string', description: '修复提交 SHA（自动提交关闭时由负责人/宿主提供；可选）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const result = await finishRepair(engine, {
          ...(typeof args.summary === 'string' && args.summary !== '' ? { summary: args.summary } : {}),
          ...(typeof args.commit === 'string' && args.commit !== '' ? { commit: args.commit } : {}),
        })
        runtime.emit()
        const record = result.record
        const lines = [
          result.message,
          '—— 修复报告 ——',
          `是否成功：是（${record.id}）`,
          `证据：RED ${record.redEvidenceId ?? '未记录'} → GREEN ${record.greenEvidenceId ?? '未记录'}${
            record.regressionEvidenceId !== undefined ? `；回归 ${record.regressionEvidenceId}` : ''
          }`,
          `改动文件：${(record.changedFiles ?? []).join('、') || '（宿主未采集到 git diff）'}`,
          `提交：${record.commit ?? '（未提交）'}`,
          `审计：.flowgate/fixes/${record.id}.json + 账本 repair.done`,
        ]
        return ok(lines.join('\n'), {
          id: record.id,
          ok: true,
          message: result.message,
          evidence: {
            red: record.redEvidenceId,
            green: record.greenEvidenceId,
            regression: record.regressionEvidenceId,
          },
          changedFiles: record.changedFiles ?? [],
          commit: record.commit ?? null,
          summary: record.summary,
        })
      },
    }),
  )

  // 18) flow_fix_abort --------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_fix_abort',
      description: '放弃当前修复通道（写明原因，写账本审计 repair.aborted）。修复声明关闭后再修需要重新 flow_fix_start。',
      parameters: {
        reason: { type: 'string', required: true, description: '为什么放弃这次修复（例如根因判断错了/需要走正式变更）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const reason = String(args.reason)
        const record = await abortRepair(engine, reason)
        runtime.emit()
        return ok(`已放弃修复 ${record.id}「${record.title}」：${reason}
修复通道已关闭；如仍需要修，重新 flow_fix_start。`, {
          id: record.id,
          status: record.status,
          abortReason: record.abortReason ?? reason,
        })
      },
    }),
  )

  // 19) flow_self_pause -------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_self_pause',
      description:
        'agent 自暂停（事故上报）：当遇到无法安全继续/需要负责人决策/环境不可用的情形，调用本工具暂停本项目写操作并创建事故记录（INC-id），等待负责人处理。' +
        'agent 不能自行恢复；负责人 /flow on 或下次宿主启动（hostEpoch 变化，autoRearm=true）恢复；恢复后补 flow_incident_close 审计。',
      parameters: {
        reason: { type: 'string', required: true, description: '为什么必须暂停：现象、影响、为什么 agent 不能自行继续' },
        severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: '事故等级：P0 生产不可用 / P1 主要功能受损 / P2 一般问题（默认 P2）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const severity =
          args.severity === 'P0' || args.severity === 'P1' || args.severity === 'P2' ? args.severity : undefined
        const result = await selfPause(engine, {
          reason: String(args.reason),
          ...(severity !== undefined ? { severity } : {}),
        })
        runtime.emit()
        const incident = result.incident
        const lines = [
          result.message,
          `事故 id：${incident.id}（${incident.severity}）｜${incident.reason}`,
          '已暂停本项目写操作（项目级，by=agent，autoRearm=true）：agent 不能自行恢复。',
          '恢复方式：负责人 /flow on，或下次宿主启动（hostEpoch 变化）自动恢复。',
          '恢复后请补审计：flow_incident_close({ summary, tests?, files?, commit? })。',
        ]
        return ok(lines.join('\n'), {
          incident: {
            id: incident.id,
            severity: incident.severity,
            reason: incident.reason,
            openedAt: incident.openedAt,
            openedBy: incident.openedBy,
          },
          paused: true,
          rearm: { by: 'agent', autoRearm: true, humanCommand: '/flow on' },
        })
      },
    }),
  )

  // 20) flow_incident_close ---------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_incident_close',
      description:
        '关闭事故并补审计（flow_self_pause 之后）：写摘要/提交/验证/涉及文件，清理项目级事故标记。负责人 /flow on 恢复后调用；写操作已恢复时也可调用以补闭环。',
      parameters: {
        summary: { type: 'string', required: true, description: '事故摘要：根因、处理过程、最终结论' },
        commit: { type: 'string', description: '关联修复提交 SHA（可选）' },
        tests: { type: 'string', description: '验证命令或证据摘要（可选，自由文本）' },
        files: { type: 'array', items: { type: 'string' }, description: '本次事故涉及/改动的主要文件（可选）' },
      },
      execute: async (args) => {
        const engine = await requireEngine(runtime)
        const files = toStringArray(args.files)
        const result = await closeIncident(engine, {
          summary: String(args.summary),
          ...(typeof args.commit === 'string' && args.commit !== '' ? { commit: args.commit } : {}),
          ...(typeof args.tests === 'string' && args.tests !== '' ? { tests: args.tests } : {}),
          ...(files.length > 0 ? { files } : {}),
        })
        runtime.emit()
        const incident = result.incident
        const lines = [
          result.message,
          `事故 ${incident.id}（${incident.severity}）已关闭${incident.closedAt ? `（${incident.closedAt}）` : ''}。`,
          `摘要：${incident.summary ?? ''}`,
          ...(incident.tests !== undefined ? [`验证：${incident.tests}`] : []),
          ...(incident.files !== undefined && incident.files.length > 0 ? [`涉及文件：${incident.files.join('、')}`] : []),
          ...(incident.commit !== undefined && incident.commit !== null ? [`提交：${incident.commit}`] : []),
        ]
        return ok(lines.join('\n'), {
          id: incident.id,
          severity: incident.severity,
          closedAt: incident.closedAt,
          summary: incident.summary,
          commit: incident.commit ?? null,
          tests: incident.tests,
          files: incident.files ?? [],
        })
      },
    }),
  )

  // 14) flow_diff -------------------------------------------------------
  tools.push(
    defineHostTool({
      name: 'flow_diff',
      description: '只读：返回当前任务（或工作区）的 diff 文本，供审查者核对改动。审查子 agent 专用。',
      parameters: {
        taskId: { type: 'string', description: '任务 id；省略时返回整个工作区的 diff' },
      },
      execute: async (args) => {
        const result = await readTaskDiff(runtime, typeof args.taskId === 'string' ? args.taskId : undefined)
        return ok(`diff（${result.files.length} 个文件）：\n\`\`\`diff\n${result.diff}\n\`\`\``, { files: result.files, diff: result.diff })
      },
    }),
  )

  return tools
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function toCitations(value: unknown): CitationRef[] {
  if (!Array.isArray(value)) return []
  const out: CitationRef[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.file !== 'string') continue
    const startLine = typeof record.startLine === 'number' ? record.startLine : Number.parseInt(String(record.startLine ?? ''), 10)
    const endLine = typeof record.endLine === 'number' ? record.endLine : Number.parseInt(String(record.endLine ?? ''), 10)
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue
    out.push({
      file: record.file,
      startLine,
      endLine,
      ...(typeof record.quote === 'string' ? { quote: record.quote } : {}),
    })
  }
  return out
}

function safeTakeNotices(engine: EngineLike): string[] {
  try {
    return engine.takeNotices()
  } catch {
    return []
  }
}

/** 工具名清单（测试/doctor 用）。 */
export const FLOW_TOOL_NAMES = [
  'flow_status',
  'flow_new_change',
  'flow_submit',
  'flow_task_start',
  'flow_task_done',
  'flow_request_scope_change',
  'flow_report_risk',
  'flow_attach_evidence',
  'flow_verify',
  'flow_request_plan_change',
  'flow_propose_rule',
  'flow_investigate',
  'flow_submit_analysis',
  'flow_diff',
  'flow_declare_rework',
  'flow_fix_start',
  'flow_fix_done',
  'flow_fix_abort',
  'flow_self_pause',
  'flow_incident_close',
] as const

/** 参数 schema 自检（测试用）。 */
export function toolParameterSpecs(runtime: HostRuntime): Record<string, ParamSpecs> {
  const out: Record<string, ParamSpecs> = {}
  for (const tool of createFlowTools(runtime)) {
    out[tool.name] = {}
  }
  return out
}

/** 成功结果类型导出（便于 dispatch 模块复用）。 */
export type { HostToolValue }
