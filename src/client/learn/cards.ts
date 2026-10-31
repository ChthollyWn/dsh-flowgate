/**
 * Seven-stage learning cards (T5.2 / FR-8.3).
 *
 * Each card has the six required parts:
 *   1. what      —— 做什么
 *   2. why       —— 为什么
 *   3. criteria  —— 合格标准（阶段门要检查什么）
 *   4. artifacts —— 产物
 *   5. upstream  —— 方法来源（对应上游做法）
 *   6. antiPatterns / good / bad —— 常见反模式 + 一个正例一个反例
 *
 * Content is bundled with the client (the host only supplies the learning
 * mode), bilingual, and keyed by the seven pipeline stages. UI chrome labels
 * (做什么 / 为什么 …) come from i18n; the method text is content data.
 */
import type { Locale } from '../i18n'

export type PipelineStageId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export const LEARNING_STAGES: PipelineStageId[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']

export interface ClientStageCard {
  what: string
  why: string
  criteria: string[]
  artifacts: string[]
  upstream: string
  antiPatterns: string[]
  good: string
  bad: string
}

export const STAGE_CARDS: Record<Locale, Record<PipelineStageId, ClientStageCard>> = {
  zh: {
    S0: {
      what: '把一句想法变成一个可追踪的变更：标题、一句话目标、复杂度与风险建议。',
      why: '没有编号和等级，后面的门禁、证据和指标都无处挂靠；等级定得不对，流程不是太重就是太松。',
      criteria: [
        '变更目录已创建，标题与一句话目标非空',
        '复杂度和风险已建议并由负责人确认',
        '契约（规则版本、技能版本）已冻结',
      ],
      artifacts: ['proposal.md', 'status.json'],
      upstream: 'OpenSpec 的 change proposal；gstack /spec',
      antiPatterns: ['一句话需求直接开工', '为了快把高复杂度报成低复杂度', '同时开很多变更'],
      good: '需求「给会员增加续费」→ 立项 C-003，中复杂度 · 普通风险，一句话目标写清「支持微信/支付宝续费且回调幂等」。',
      bad: '需求「改一下支付」→ 直接开始改代码，没有编号、没有目标、没有等级。',
    },
    S1: {
      what: '先挖后问，把模糊描述澄清成六要素闭合、场景可测的增量规格。',
      why: '需求没澄清就写代码，做出来的东西没法验收；每个问题的答案都必须说明「改变了什么」。',
      criteria: [
        '六要素（目标/边界/角色/验收/约束/未知）各有结论或被接受为假设',
        '每条需求至少 1 个场景，场景用 GIVEN/WHEN/THEN',
        'THEN 里没有未量化的模糊词',
        '「不做」清单非空，未决问题为 0',
        '增量规格格式合法',
      ],
      artifacts: ['clarify.md', 'proposal.md', 'spec.md（增量）'],
      upstream: 'Superpowers brainstorming；gstack /office-hours、/spec；OpenSpec propose',
      antiPatterns: ['只问一句就开始写', '把「用户友好」当验收标准', '假设只留在脑子里不写进文档'],
      good: '问「续费失败时用户看到什么？」→ 答案改变验收场景，补上「失败时展示可重试的错误页」并记入 clarify.md。',
      bad: '直接把「续费要稳定」写进规格，没有阈值、没有场景。',
    },
    S2: {
      what: '把项目事实写清楚：技术栈、模块职责、命令、约定、禁区，并记录基线测试。',
      why: '没有项目事实，agent 会靠猜；基线测试是 S5 判断「有没有引入回归」的唯一依据。',
      criteria: [
        'project.md 必填段齐全（技术栈、模块、命令、约定、禁区、可复用模块）',
        '测试 / 构建 / lint 命令可执行',
        '基线测试结果已记录（没有测试时登记风险）',
        '每条描述标注已确认 / 代码推导 / 待确认',
      ],
      artifacts: ['context.md', 'project.md', '基线证据回执'],
      upstream: 'OpenSpec config.yaml 的 context / rules；gstack /init',
      antiPatterns: ['抄一遍 README 当项目文档', '测试命令没跑过就写进配置', '不标信息来源'],
      good: '探测到 Maven 项目，跑 ./mvnw -q test 记录基线 48 通过 / 2 失败，失败清单如实记录。',
      bad: '把测试命令写成「跑测试」占位，基线一条不记，S5 无从对比。',
    },
    S3: {
      what: '给出 2–3 个方案对比与推荐，把需求拆成能独立验收的任务卡，并排出执行计划（批次、顺序/并行、检查点）。',
      why: '任务太大 agent 会跑偏，你也没法一步步验收；没有执行计划，并行任务会互相覆盖范围、把依赖改乱。',
      criteria: [
        '设计里有 2–3 个方案对比和推荐理由',
        '风险登记五类（安全/性能/成本/合规/可维护）齐全',
        '每个验收场景至少被一张任务卡覆盖，无遗漏',
        '每张任务卡都有范围、测试、验证命令，任务数不超过上限',
        '执行计划：每任务恰在一个批次、依赖只指向更早批次、并行任务范围不重叠、不碰热点文件',
        'G3 人工批准后产物冻结',
      ],
      artifacts: ['design.md', 'risk.md', 'tasks.md', 'execution-plan.md'],
      upstream: 'Superpowers writing-plans；gstack /plan-eng-review；OpenSpec tasks',
      antiPatterns: ['一个任务改十几个文件', '只有一个方案、没有回滚方案', '并行批次里两个任务都改同一个文件'],
      good: '把续费拆成 T1 数据模型、T2 回调幂等、T3 重试页三张卡，T1 顺序，T2/T3 并行且范围不重叠，B2 后设集成检查点。',
      bad: '一张任务卡范围写成 src/**，所有任务串行，没有检查点。',
    },
    S4: {
      what: '按执行图顺序执行：TDD 先 RED 后 GREEN，每个任务通过任务门（新鲜证据 + 范围 + 审查）后自动提交。',
      why: '执行阶段最容易走捷径：拿旧证据宣布完成、顺手重构范围外文件、跳过测试。任务门和守卫把这些变成确定性拒绝。',
      criteria: [
        '任务按执行图顺序领取，并行批次在独立 worktree 里运行',
        '必需 TDD 的任务有 RED → GREEN 证据',
        '每个任务都有当前输入下新鲜的验证证据',
        '改动都在任务范围内，越界被拒并生成待处理项',
        '每个任务通过后自动提交；集成检查点通过才进入下一批',
      ],
      artifacts: ['变更分支上的提交', '证据回执', 'review.md'],
      upstream: 'Superpowers test-driven-development、subagent-driven-development、dispatching-parallel-agents；gstack /freeze、/review',
      antiPatterns: ['先写实现再补测试', '拿上一次的测试结果当本次证据', '并行任务互相改对方文件'],
      good: 'T3 先写失败测试（RED），守卫允许后写实现，跑出 GREEN，任务门通过自动提交，B2 集成检查点通过。',
      bad: '改完三个文件直接说「完成了」，没有跑测试，也没有 RED 记录。',
    },
    S5: {
      what: '全量测试并与基线对比，跑 lint / 构建，按配置启动服务做冒烟检查，最后做整体终审。',
      why: '单个任务通过不等于整体没坏；回归、跨任务冲突、运行期问题只有在这一步才暴露。',
      criteria: [
        '全量测试通过，且相对基线没有新增失败',
        '每个验收场景都有通过证据（自动或人工，分开统计）',
        'lint / build 通过，运行证据包含健康检查结果',
        '终审没有未处理的 critical / major 发现',
      ],
      artifacts: ['验证回执', '终审记录', '回归对比'],
      upstream: 'Superpowers verification-before-completion；gstack /qa、/cso',
      antiPatterns: ['只跑改动的测试就说没问题', '跳过运行冒烟', '把审查意见留到 S6'],
      good: '全量 52 通过 0 失败（基线 48/2：两个旧失败已修复），启动服务冒烟 200，终审 pass。',
      bad: '只看任务内测试通过就提交 G5，基线里的失败数变成了 4。',
    },
    S6: {
      what: '生成交付报告与交付物，人工确认 G6，合并规格并归档变更。',
      why: '交付前最后一道人工关：确认全部风险已处理、证据齐全、没有未确认的非 agent 改动，然后把变更收口。',
      criteria: [
        '全部任务完成，G5 通过',
        '验收场景全部有通过证据',
        '无未处理的 critical / major，风险项全部处理',
        '篡改检测项与非 agent 改动已确认',
        'G6 人工批准；报告与指标快照已生成',
      ],
      artifacts: ['report.html', 'PR 描述 / 提交说明', '归档后的 specs'],
      upstream: 'gstack /ship、/document-release；OpenSpec archive；Superpowers finishing-a-development-branch',
      antiPatterns: ['没看报告就批准 G6', '把未确认的非 agent 改动一起提交', '归档前不合并增量规格'],
      good: '打开报告核对 8 个部分后批准 G6，增量规格合并进主规格，变更目录归档。',
      bad: '直接一键批准 G6，报告没生成，风险项还有一条打开着。',
    },
  },
  en: {
    S0: {
      what: 'Turn one sentence of intent into a traceable change: title, one-line goal, suggested complexity and risk.',
      why: 'Without an id and a level, later gates, evidence and metrics have nothing to attach to; a wrong level makes the process either too heavy or too loose.',
      criteria: [
        'Change directory exists; title and one-line goal are non-empty',
        'Complexity and risk are suggested and confirmed by the owner',
        'Contract (rule and skill versions) is frozen',
      ],
      artifacts: ['proposal.md', 'status.json'],
      upstream: 'OpenSpec change proposal; gstack /spec',
      antiPatterns: ['Start coding from a one-liner', 'Report high complexity as low to move fast', 'Open many changes at once'],
      good: '“Add renewal for members” → change C-003, medium complexity · normal risk, goal states “WeChat/Alipay renewal with idempotent callbacks”.',
      bad: '“Tweak payments” → start editing code with no id, no goal, no level.',
    },
    S1: {
      what: 'Dig before asking: clarify the fuzzy description into six closed elements and testable scenarios.',
      why: 'Code written before requirements are clear cannot be accepted; every answer must say what it changed.',
      criteria: [
        'All six elements (goal/boundary/roles/acceptance/constraints/unknowns) have a conclusion or an accepted assumption',
        'Each requirement has at least one GIVEN/WHEN/THEN scenario',
        'THEN has no unquantified vague terms',
        'The out-of-scope list is non-empty and open questions are zero',
        'Incremental spec format is valid',
      ],
      artifacts: ['clarify.md', 'proposal.md', 'spec.md (incremental)'],
      upstream: 'Superpowers brainstorming; gstack /office-hours and /spec; OpenSpec propose',
      antiPatterns: ['Ask one question then start writing', 'Use “user friendly” as acceptance', 'Keep assumptions in your head'],
      good: 'Ask “what does the user see when renewal fails?” → the answer changes acceptance: add a retryable error page, recorded in clarify.md.',
      bad: 'Write “renewal must be stable” into the spec with no threshold and no scenario.',
    },
    S2: {
      what: 'Write down project facts: stack, module responsibilities, commands, conventions, forbidden areas, and record a baseline test run.',
      why: 'Without project facts the agent guesses; the baseline is the only reference S5 has to judge regressions.',
      criteria: [
        'project.md required sections are complete (stack, modules, commands, conventions, forbidden, reusable)',
        'Test / build / lint commands actually run',
        'Baseline test result recorded (register a risk when there are no tests)',
        'Each statement is marked confirmed / derived / pending',
      ],
      artifacts: ['context.md', 'project.md', 'baseline evidence receipt'],
      upstream: 'OpenSpec config.yaml context/rules; gstack /init',
      antiPatterns: ['Copy the README as project docs', 'Write test commands that were never executed', 'Do not mark sources'],
      good: 'Detected a Maven project, ran ./mvnw -q test and recorded baseline 48 pass / 2 fail, failures listed honestly.',
      bad: 'Write “run tests” as the command, record no baseline, leaving S5 with nothing to compare.',
    },
    S3: {
      what: 'Compare 2–3 design options with a recommendation, split requirements into independently acceptable task cards, and lay out an execution plan (batches, sequential/parallel, checkpoints).',
      why: 'Oversized tasks let the agent drift and make stepwise acceptance impossible; without a plan, parallel tasks overwrite each other’s scope and scramble dependencies.',
      criteria: [
        'Design contains 2–3 options compared with a recommendation',
        'Risk register covers all five categories (security/performance/cost/compliance/maintainability)',
        'Every acceptance scenario is covered by at least one task card',
        'Each task card has scope, tests and verify commands; task count within the limit',
        'Execution plan: one batch per task, dependencies only to earlier batches, parallel scopes disjoint, no hotspot files',
        'Artifacts frozen after G3 approval',
      ],
      artifacts: ['design.md', 'risk.md', 'tasks.md', 'execution-plan.md'],
      upstream: 'Superpowers writing-plans; gstack /plan-eng-review; OpenSpec tasks',
      antiPatterns: ['One task touching a dozen files', 'A single option with no rollback', 'Two parallel tasks both editing the same file'],
      good: 'Split renewal into T1 data model, T2 callback idempotency, T3 retry page; T1 sequential, T2/T3 parallel with disjoint scope and an integration checkpoint after B2.',
      bad: 'One task whose scope is src/**, everything sequential, no checkpoint.',
    },
    S4: {
      what: 'Execute in plan order: RED before GREEN for TDD tasks; each task passes its task gate (fresh evidence + scope + review) then auto-commits.',
      why: 'Execution is where shortcuts appear: claiming done on stale evidence, refactoring outside scope, skipping tests. Task gates and guards turn these into deterministic rejections.',
      criteria: [
        'Tasks are claimed in plan order; parallel batches run in isolated worktrees',
        'TDD-required tasks have RED → GREEN evidence',
        'Every task has fresh evidence for its current inputs',
        'Writes stay inside task scope; out-of-scope attempts are rejected and become pending items',
        'Each passing task auto-commits; the integration checkpoint must pass before the next batch',
      ],
      artifacts: ['commits on the change branch', 'evidence receipts', 'review.md'],
      upstream: 'Superpowers test-driven-development, subagent-driven-development, dispatching-parallel-agents; gstack /freeze and /review',
      antiPatterns: ['Implementation first, tests later', 'Reusing an old test result as current evidence', 'Parallel tasks editing each other’s files'],
      good: 'T3 writes the failing test first (RED), the guard then allows implementation, GREEN is reached, the task gate passes and auto-commits, B2 checkpoint passes.',
      bad: 'Edit three files and announce “done” without running tests or recording RED.',
    },
    S5: {
      what: 'Run the full suite against the baseline, run lint/build, start the service per config for a smoke check, then do a final review.',
      why: 'A passing task is not a working change; regressions, cross-task conflicts and runtime issues only surface here.',
      criteria: [
        'Full suite passes with no new failures versus baseline',
        'Every acceptance scenario has passing evidence (automated and manual counted separately)',
        'lint / build pass; runtime evidence includes the health check',
        'Final review has no unresolved critical/major findings',
      ],
      artifacts: ['verification receipts', 'final review record', 'regression comparison'],
      upstream: 'Superpowers verification-before-completion; gstack /qa and /cso',
      antiPatterns: ['Run only changed tests and call it good', 'Skip the runtime smoke check', 'Save review comments for S6'],
      good: 'Full suite 52 pass / 0 fail (baseline 48/2: the two known failures were fixed), smoke check returns 200, final review passes.',
      bad: 'Submit G5 because task tests pass while baseline failures grew from 2 to 4.',
    },
    S6: {
      what: 'Generate the delivery report and deliverables, get human G6 confirmation, merge the spec and archive the change.',
      why: 'The last human gate: confirm all risks are handled, evidence is complete, and no unconfirmed non-agent edits exist before closing the change.',
      criteria: [
        'All tasks done and G5 passed',
        'Every acceptance scenario has passing evidence',
        'No unresolved critical/major findings; all risks handled',
        'Tamper checks and non-agent edits confirmed',
        'G6 approved by the human; report and metrics snapshot generated',
      ],
      artifacts: ['report.html', 'PR description / commit message', 'merged specs after archive'],
      upstream: 'gstack /ship and /document-release; OpenSpec archive; Superpowers finishing-a-development-branch',
      antiPatterns: ['Approve G6 without reading the report', 'Commit unconfirmed non-agent edits', 'Archive without merging the incremental spec'],
      good: 'Review all eight report sections, approve G6, merge the incremental spec into the main spec and archive the change directory.',
      bad: 'Approve G6 in one click with no report generated and one risk item still open.',
    },
  },
}

export function cardsFor(locale: Locale): Record<PipelineStageId, ClientStageCard> {
  return STAGE_CARDS[locale] ?? STAGE_CARDS.zh
}

/** Stage ids that are pipeline stages (excludes roadmap/archived/locked). */
export function isLearningStage(value: string | undefined): value is PipelineStageId {
  return value !== undefined && (LEARNING_STAGES as string[]).includes(value)
}

/** Which of the six parts are shown for a learning mode. */
export function visibleParts(mode: 'detail' | 'brief' | 'off'): {
  what: boolean
  why: boolean
  criteria: boolean
  artifacts: boolean
  upstream: boolean
  antiPatterns: boolean
  examples: boolean
} {
  if (mode === 'off') {
    return { what: false, why: false, criteria: false, artifacts: true, upstream: false, antiPatterns: false, examples: false }
  }
  if (mode === 'brief') {
    return { what: true, why: true, criteria: true, artifacts: true, upstream: false, antiPatterns: false, examples: false }
  }
  return { what: true, why: true, criteria: true, artifacts: true, upstream: true, antiPatterns: true, examples: true }
}
