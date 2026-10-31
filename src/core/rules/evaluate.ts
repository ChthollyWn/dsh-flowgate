/**
 * Ordered rule evaluation (03 §4.2, FR-9.1).
 *
 * Fixed order:
 *   受保护路径 → 锁定模式 → 只读分析 → 原生委派 → 风险触发器(human)
 *   → 推送 → 阶段策略 → 任务范围 → 新文件控制 → TDD 顺序
 *   → 项目自定义规则 → 未知工具控制 → 例外与单次放行 → 默认允许
 *
 * Earlier denials cannot be flipped by later rules. A single-use override or an
 * exception can only cancel the *specific* rule it names, and never a protected
 * path / locked-mode denial. Every deny/human carries stage, rule id, why and
 * unlock (FR-9.1).
 */
import type {
  Action,
  ActionKind,
  ChangeStatus,
  Decision,
  FileAction,
  PendingDraft,
  PendingKind,
  Rule,
  RuleCondition,
  RuleEvaluationInput,
  RuleMatch,
  ShellAction,
  StageId,
} from '../types'
import { matchAnyGlob, matchGlob } from '../util/glob'
import { containsSecret, sha256, stableJson } from '../util/hash'
import { normalizeRelPath } from '../util/paths'
import { STAGE_LABELS } from '../state/stages'
import {
  isAllowedWrite,
  isAllowedWriteForAction,
  isArtifactWritableInStage,
  isDeliveryWritable,
  isProtectedPath,
} from '../state/scope'
import { RESERVED_RULE_IDS, loadRules, ruleById } from './builtin'
import {
  classifyShellCommand,
  extractWriteTargets,
  isDependencyCommand,
  isDangerousCommand,
  isMutatingCommand,
  isPushCommand,
  isRevertCommand,
} from '../shell'
import { TRIGGER_RULE_BY_TRIGGER, matchRiskTriggers } from './risk-triggers'
import type { TriggerHit } from './risk-triggers'
import { BLOCKED_DELEGATION_TOOLS, classifyTool } from './toolclass'

// ---------------------------------------------------------------------------
// Internal rules (not configurable: lock mode and open violations are hard stops)
// ---------------------------------------------------------------------------

const LOCK_RULE: Rule = {
  id: 'R-LOCK',
  when: {},
  decision: 'deny',
  why: '锁定模式：状态损坏或账本被篡改时，门禁内的写入全部拒绝，避免在不可信状态上继续操作。',
  unlock: '等待负责人在授权卡片上修复（诊断后从账本和产物重建状态），锁定解除后重试。',
  source: 'FR-11.2 锁定模式',
  builtin: false,
}

const VIOLATION_RULE: Rule = {
  id: 'R-VIOLATION',
  when: {},
  decision: 'deny',
  why: '当前变更存在未撤销的越界改动：本任务的后续写入被拒绝，直到撤销或范围变更获批。',
  unlock:
    '用 git checkout -- <文件> 撤销改动，或删除新增文件（撤销操作不受限制）；也可用 flow_request_scope_change 申请范围变更。',
  source: '03 §5.3 · FR-4.5',
  builtin: false,
}

const PENDING_KIND_BY_TRIGGER: Record<string, PendingKind> = {
  'sensitive-path': 'risk',
  'dependency-change': 'risk',
  'dangerous-command': 'risk',
  'secret-write': 'exception',
  'secret-read': 'risk',
  'consecutive-failure': 'blocker',
}

const PENDING_KIND_BY_RULE: Record<string, PendingKind> = {
  'R-SCOPE': 'scope',
  'R-NEWFILE': 'scope',
  'R-DELETE': 'scope',
  'R-MCP': 'risk',
  'R-PUSH': 'risk',
  'R-STAGE-SRC': 'risk',
  'R-TDD-ORDER': 'risk',
  'R-PROTECTED': 'risk',
  'R-DELEGATE': 'risk',
  'R-LOCK': 'blocker',
  'R-VIOLATION': 'blocker',
}

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

export function actionKindOf(action: Action): ActionKind {
  switch (action.kind) {
    case 'shell':
      return 'shell'
    case 'delegate':
      return 'delegate'
    case 'mcp':
      return 'mcp'
    case 'other':
      return 'other'
    default:
      return action.kind
  }
}

function isFileAction(action: Action): action is FileAction {
  return (
    action.kind === 'write' ||
    action.kind === 'create' ||
    action.kind === 'delete' ||
    action.kind === 'rename' ||
    action.kind === 'read'
  )
}

type FileWriteKind = 'write' | 'create' | 'delete' | 'rename'

function fileWriteKind(action: Action): FileWriteKind | null {
  if (!isFileAction(action)) return null
  return action.kind === 'read' ? null : action.kind
}

/** Target path of an action (repo-relative); undefined for shell/delegate/mcp. */
export function actionTargetPath(action: Action): string | undefined {
  if (isFileAction(action)) {
    const normalized = normalizeRelPath(action.path)
    return normalized === '' ? undefined : normalized
  }
  return undefined
}

function actionCommand(action: Action): string | undefined {
  return action.kind === 'shell' ? (action as ShellAction).command : undefined
}

function describeAction(action: Action): string {
  if (isFileAction(action)) {
    const suffix = action.kind === 'rename' && action.toPath ? ` -> ${action.toPath}` : ''
    return `${action.kind} ${normalizeRelPath(action.path)}${suffix}`
  }
  if (action.kind === 'shell') return `shell: ${action.command.trim().slice(0, 200)}`
  if (action.kind === 'delegate') return `delegate: ${action.tool}`
  if (action.kind === 'mcp') return `mcp: ${action.tool}`
  return `${action.kind}: ${action.tool}`
}

function shortTarget(action: Action): string {
  if (isFileAction(action)) return normalizeRelPath(action.path)
  if (action.kind === 'shell') return action.command.trim().slice(0, 60)
  return action.tool
}

/** Stable fingerprint of an action, used by single-use overrides (FR-9.2). */
export function fingerprintAction(action: Action): string {
  const payload: Record<string, unknown> = { kind: actionKindOf(action), tool: action.tool }
  if (isFileAction(action)) {
    payload['path'] = normalizeRelPath(action.path)
    if (action.kind === 'rename' && action.toPath) payload['to'] = normalizeRelPath(action.toPath)
    if (typeof action.content === 'string') payload['content'] = sha256(action.content)
  } else if (action.kind === 'shell') {
    payload['command'] = action.command.trim()
    if (action.cwd) payload['cwd'] = action.cwd
  } else if (action.kind === 'delegate') {
    if ('target' in action && typeof action.target === 'string' && action.target !== '') {
      payload['target'] = action.target
    }
  } else if ('detail' in action && action.detail) {
    payload['detail'] = action.detail
  }
  return sha256(stableJson(payload))
}

/** True when the action changes repository files or runs a mutating/dangerous command. */
export function mutatesRepository(action: Action): boolean {
  if (isFileAction(action)) return action.kind !== 'read'
  if (action.kind === 'shell') {
    const command = action.command
    return (
      isMutatingCommand(command) ||
      isDangerousCommand(command) ||
      isDependencyCommand(command) ||
      isPushCommand(command)
    )
  }
  if (action.kind === 'delegate') return true
  if (action.kind === 'mcp') return true
  return false
}

function isPublishAction(action: Action): boolean {
  if (action.kind === 'shell') return isPushCommand(action.command)
  return actionKindOf(action) === 'push'
}

/**
 * 常见测试文件路径（不依赖任务卡 tests 是否写成 glob）。
 * 用于 TDD 顺序：测试文件必须先于实现被允许写入，否则 RED 无法产生。
 */
export function looksLikeTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some((segment) => segment === 'test' || segment === 'tests' || segment === '__tests__' || segment === 'spec')) {
    return true
  }
  const file = segments[segments.length - 1] ?? ''
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /_test\.(py|go|rb|rs)$/.test(file) ||
    /^test_.*\.py$/.test(file) ||
    /\.(test|spec)\.(php|cs)$/.test(file) ||
    /(?:test|tests|it)\.(java|kt|scala)$/.test(file)
  )
}


// ---------------------------------------------------------------------------
// Conditions (used by project-appended rules)
// ---------------------------------------------------------------------------

function commandClasses(command: string): string[] {
  return classifyShellCommand(command)
}

function ruleConditionMatches(when: RuleCondition, input: RuleEvaluationInput): boolean {
  const action = input.action
  const kind = actionKindOf(action)
  const target = actionTargetPath(action)
  const command = actionCommand(action)
  if (when.changeKind && (!input.change || !when.changeKind.includes(input.change.kind))) return false
  if (when.stage && !(when.stage as StageId[]).includes(input.stage)) return false
  if (when.action && !when.action.includes(kind)) return false
  if (when.tool && !when.tool.some((pattern) => matchGlob(pattern, action.tool))) return false
  if (when.path !== undefined) {
    if (!target || !matchGlob(when.path, target)) return false
  }
  if (when.except && target && when.except.some((pattern) => matchGlob(pattern, target))) return false
  if (when.command) {
    if (!command) return false
    const classes = commandClasses(command)
    if (!when.command.some((expected) => classes.includes(expected))) return false
  }
  if (when.secret) {
    const content =
      isFileAction(action) && typeof action.content === 'string'
        ? action.content
        : command !== undefined
          ? command
          : undefined
    if (!content || !containsSecret(content)) return false
  }
  if (when.outside) {
    const task = input.task ?? null
    if (!task) return true
    if (!input.change) return true
    const verdict = target
      ? isAllowedWrite(task, input.change, target)
      : { allowed: false }
    if (verdict.allowed) return false
  }
  if (when.pending) {
    if (!input.pending.some((item) => item.status === 'open' && item.kind === when.pending)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Message / decision builders
// ---------------------------------------------------------------------------

function ruleMatchOf(rule: Rule, decision?: Rule['decision']): RuleMatch {
  const match: RuleMatch = {
    ruleId: rule.id,
    decision: decision ?? rule.decision,
    why: rule.why,
    unlock: rule.unlock,
  }
  if (rule.source) match.source = rule.source
  return match
}

/** Agent-facing message with the four FR-9.1 parts: stage, rule id, why, unlock. */
function buildMessage(
  effect: 'deny' | 'human',
  rule: Rule,
  stage: StageId,
  detail?: string,
): string {
  const label = `${stage} ${STAGE_LABELS[stage] ?? ''}阶段`
  const prefix = effect === 'deny' ? 'FlowGate 拒绝' : 'FlowGate 转人工确认'
  const detailPart = detail ? `：${detail}` : ''
  return `${prefix}：${label}${detailPart}（规则 ${rule.id}）。为什么：${rule.why} 解锁：${rule.unlock}`
}

function makePendingDraft(rule: Rule, kind: PendingKind, input: RuleEvaluationInput): PendingDraft {
  const fingerprint = fingerprintAction(input.action)
  return {
    kind,
    title: `${rule.id}：${shortTarget(input.action)}`,
    detail: `${describeAction(input.action)}\n${rule.why}\n解锁：${rule.unlock}`,
    actionFingerprint: fingerprint,
    data: {
      ruleId: rule.id,
      stage: input.stage,
      target: actionTargetPath(input.action),
      command: actionCommand(input.action),
      tool: input.action.tool,
    },
  }
}

interface Matched {
  rule: Rule
  detail?: string
  pendingDraft?: PendingDraft
  /** Force the effect when the semantics are stage-dependent (e.g. push after G6). */
  effect?: 'deny' | 'human'
}

function allowDecision(rule: Rule | null, notes: string[], overrideUsed?: string, exceptionUsed?: string): Decision {
  const decision: Decision = { effect: 'allow', message: '' }
  if (rule) decision.rule = ruleMatchOf(rule, 'allow')
  if (overrideUsed) decision.overrideUsed = overrideUsed
  if (exceptionUsed) decision.exceptionUsed = exceptionUsed
  if (notes.length > 0) decision.notes = notes
  return decision
}

function blockDecision(matched: Matched, input: RuleEvaluationInput, notes: string[]): Decision {
  const effect = matched.effect ?? (matched.rule.decision === 'human' ? 'human' : 'deny')
  const decision: Decision = {
    effect,
    rule: ruleMatchOf(matched.rule, matched.rule.decision === 'allow' ? 'allow' : matched.rule.decision),
    message: buildMessage(effect, matched.rule, input.stage, matched.detail),
  }
  if (effect === 'human') {
    const pendingKind = PENDING_KIND_BY_RULE[matched.rule.id] ?? 'risk'
    decision.pendingDraft = matched.pendingDraft ?? makePendingDraft(matched.rule, pendingKind, input)
    if (input.change) {
      const fingerprint = decision.pendingDraft.actionFingerprint
      const existing = input.pending.find(
        (item) => item.status === 'open' && item.scope?.actionFingerprint === fingerprint,
      )
      if (existing) {
        notes.push(`已存在待处理项 ${existing.id}（${existing.title}），负责人处理后重试即可，不要重复申请`)
      }
    }
  }
  if (notes.length > 0) decision.notes = notes
  return decision
}

// ---------------------------------------------------------------------------
// Stage policy
// ---------------------------------------------------------------------------

interface StagePolicyContext {
  input: RuleEvaluationInput
  rule: Rule
  kind: FileWriteKind | null
  target: string | undefined
}

/** Stage-specific write policy (S0-S3 artifacts only, roadmap, S6 delivery, archived read-only). */
function stagePolicyBlocked(ctx: StagePolicyContext): { blocked: boolean; detail?: string } {
  const { input } = ctx
  const change = input.change
  const action = input.action
  const stage = input.stage
  const target = ctx.target
  const writeKind = ctx.kind

  if (stage === 'S0' || stage === 'S1' || stage === 'S2' || stage === 'S3') {
    if (writeKind && isFileAction(action)) {
      const paths = [normalizeRelPath(action.path)]
      if (action.kind === 'rename' && action.toPath) paths.push(normalizeRelPath(action.toPath))
      if (change && paths.every((path) => isArtifactWritableInStage(change, path))) {
        return { blocked: false }
      }
      return {
        blocked: true,
        detail: `该阶段只能写本变更的产物（.flowgate/changes/${change?.id ?? '<变更>'}/ 下对应的 md），不能写 ${paths[0]}`,
      }
    }
    if (action.kind === 'shell') {
      const command = action.command
      if (isRevertCommand(command)) return { blocked: false }
      if (!isMutatingCommand(command)) return { blocked: false }
      const targets = extractWriteTargets(command)
      if (change && targets.length > 0 && targets.every((path) => isArtifactWritableInStage(change, path))) {
        return { blocked: false }
      }
      return {
        blocked: true,
        detail: `该阶段不能执行会改文件的命令：${command.trim().slice(0, 120)}`,
      }
    }
    return { blocked: false }
  }

  if (stage === 'roadmap') {
    if (writeKind && isFileAction(action)) {
      if (change && isArtifactWritableInStage(change, normalizeRelPath(action.path))) {
        return { blocked: false }
      }
      return {
        blocked: true,
        detail: '项目路线图阶段只能写 .flowgate/project-clarify.md 与 .flowgate/roadmap.md',
      }
    }
    if (action.kind === 'shell' && isMutatingCommand(action.command) && !isRevertCommand(action.command)) {
      return { blocked: true, detail: '项目路线图阶段只写项目级澄清与路线图，不能执行会改文件的命令' }
    }
    return { blocked: false }
  }

  if (stage === 'S4' || stage === 'S5') {
    // Scope / new-file / TDD rules cover this; the stage itself has no extra limit.
    return { blocked: false }
  }

  if (stage === 'S6') {
    if (writeKind && isFileAction(action) && target !== undefined) {
      if (isDeliveryWritable(target)) return { blocked: false }
      return { blocked: true, detail: 'S6 交付阶段只能写交付物（CHANGELOG、docs/、README 等），源码与测试已冻结' }
    }
    return { blocked: false }
  }

  if (stage === 'archived') {
    if (mutatesRepository(action)) {
      return { blocked: true, detail: '变更已归档：产物与代码只读，不能再改' }
    }
    return { blocked: false }
  }

  return { blocked: false }
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export function evaluateRules(input: RuleEvaluationInput): Decision {
  const rules = loadRules(input.config)
  const notes: string[] = []
  const stage = input.stage
  const action = input.action
  const kind = actionKindOf(action)
  const change: ChangeStatus | undefined = input.change
  const target = actionTargetPath(action)
  const command = actionCommand(action)
  const pick = (id: string): Rule | undefined => ruleById(rules, id)

  let matched: Matched | null = null
  let allowMatched: Rule | null = null

  const block = (
    rule: Rule,
    detail?: string,
    pendingDraft?: PendingDraft,
    effect?: 'deny' | 'human',
  ): void => {
    if (matched) return
    matched = { rule, detail, pendingDraft, effect }
  }

  /** Apply a rule's configured decision: allow rules only matter when nothing earlier blocked. */
  const applyRule = (rule: Rule | undefined, detail?: string, pendingKind?: PendingKind): void => {
    if (!rule) return
    if (rule.decision === 'allow') {
      if (!allowMatched) allowMatched = rule
      return
    }
    if (rule.decision === 'human') {
      const kindForPending = pendingKind ?? PENDING_KIND_BY_RULE[rule.id] ?? 'risk'
      block(rule, detail, makePendingDraft(rule, kindForPending, input))
      return
    }
    block(rule, detail)
  }

  // ---- 1. Protected paths -------------------------------------------------
  if (!matched) {
    const protectedRule = pick('R-PROTECTED')
    if (protectedRule && protectedRule.decision !== 'allow') {
      const reason = protectedTargetReason(input)
      if (reason) applyRule(protectedRule, reason)
    } else if (protectedRule) {
      if (!allowMatched) allowMatched = protectedRule
    }
  }

  // ---- 2. Locked mode -----------------------------------------------------
  if (!matched && change?.lifecycle === 'locked' && mutatesRepository(action)) {
    block(LOCK_RULE, `变更 ${change.id} 处于锁定模式（${change.lock?.reason ?? '状态损坏或被篡改'}）`)
  }

  // ---- 3. Read-only analysis ---------------------------------------------
  if (!matched) {
    const analysisRule = pick('R-ANALYSIS-READONLY')
    if (analysisRule && ruleConditionMatches(analysisRule.when, input)) {
      applyRule(analysisRule, `分析任务 ${change?.id ?? ''} 只读（${describeAction(action)}）`)
    }
  }

  // ---- 4. Native delegation ----------------------------------------------
  if (!matched) {
    const delegateRule = pick('R-DELEGATE')
    if (delegateRule && (kind === 'delegate' || BLOCKED_DELEGATION_TOOLS.includes(action.tool))) {
      applyRule(delegateRule, `工具 ${action.tool} 属于受管控会话禁用的原生委派工具`)
    }
  }

  // ---- 5. Risk triggers ---------------------------------------------------
  if (!matched) {
    const hits = matchRiskTriggers(input)
    const hit: TriggerHit | undefined = hits[0]
    if (hit) {
      const meta = TRIGGER_RULE_BY_TRIGGER[hit.trigger]
      const effective = meta ? (pick(meta.id) ?? meta) : undefined
      const decision: Rule['decision'] =
        effective?.decision === 'allow'
          ? 'allow'
          : hit.decision === 'deny' || effective?.decision === 'deny'
            ? 'deny'
            : 'human'
      const rule: Rule = { ...(effective ?? fallbackTriggerRule(hit)), decision }
      applyRule(rule, `${hit.title}：${hit.detail}`, PENDING_KIND_BY_TRIGGER[hit.trigger] ?? 'risk')
    }
  }

  // ---- 6. Push ------------------------------------------------------------
  if (!matched) {
    const pushRule = pick('R-PUSH')
    if (pushRule && isPublishAction(action)) {
      const g6Passed =
        change !== undefined && (change.stage === 'archived' || change.gates.G6?.state === 'passed')
      if (pushRule.decision === 'allow') {
        if (!allowMatched) allowMatched = pushRule
      } else if (!g6Passed) {
        applyRule(pushRule, 'G6 交付确认之前不允许推送（推送会把未验证的提交发布出去）')
      } else {
        block(
          pushRule,
          'G6 已通过：推送仍需负责人确认（agent 不能自行发布）',
          makePendingDraft(pushRule, 'risk', input),
          'human',
        )
      }
    }
  }

  // ---- 7. Stage policy ----------------------------------------------------
  if (!matched) {
    const stageRule = pick('R-STAGE-SRC')
    if (stageRule && stageRule.decision !== 'allow') {
      const policy = stagePolicyBlocked({ input, rule: stageRule, kind: fileWriteKind(action), target })
      if (policy.blocked) applyRule(stageRule, policy.detail)
    } else if (stageRule) {
      if (!allowMatched) allowMatched = stageRule
    }
  }

  // ---- 8/9. Task scope, declared delete/rename, new file control ----------
  if (!matched) {
    const writeKind = fileWriteKind(action)
    if (writeKind && (stage === 'S4' || stage === 'S5')) {
      const scopeRule = pick('R-SCOPE')
      if (scopeRule && scopeRule.decision === 'allow') {
        if (!allowMatched) allowMatched = scopeRule
      } else {
        const openViolations = input.violations.filter((violation) => !violation.clearedAt)
        if (openViolations.length > 0 && (writeKind === 'write' || writeKind === 'create')) {
          block(
            VIOLATION_RULE,
            `存在未撤销的越界改动：${openViolations.map((violation) => violation.path).slice(0, 3).join('、')}`,
          )
        } else if (!input.task || !change) {
          applyRule(scopeRule, 'S4 执行阶段还没有活动任务：必须先 flow_task_start 领取任务卡才能改源码')
        } else {
          const task = input.task
          let verdict = isAllowedWriteForAction(task, change, target ?? '', writeKind)
          if (writeKind === 'rename' && isFileAction(action) && action.toPath && verdict.allowed) {
            const destination = isAllowedWriteForAction(
              task,
              change,
              normalizeRelPath(action.toPath),
              'rename',
            )
            if (!destination.allowed) verdict = destination
          }
          if (!verdict.allowed) {
            const ruleId =
              writeKind === 'delete' || writeKind === 'rename'
                ? 'R-DELETE'
                : verdict.reason === 'undeclared-new-file'
                  ? 'R-NEWFILE'
                  : 'R-SCOPE'
            const rule_ = pick(ruleId) ?? scopeRule
            const detail = verdict.hint ?? `路径 ${target ?? ''} 不在任务 ${task.id} 的允许写入集合内`
            if (rule_) applyRule(rule_, detail)
          }
        }
      }
    }
  }

  // ---- 10. TDD order ------------------------------------------------------
  if (!matched) {
    const writeKind = fileWriteKind(action)
    if ((writeKind === 'write' || writeKind === 'create') && stage === 'S4' && input.task && target) {
      const tddRule = pick('R-TDD-ORDER')
      if (tddRule && tddRule.decision !== 'allow') {
        const task = input.task
        const tddRequired = task.tdd === 'required'
        const tddState = change?.tasks[task.id]?.tdd ?? 'none'
        // 任务卡的 tests 字段可能是路径/glob，也可能被 agent 写成裸类名/短名；
        // 后者会让 matchAnyGlob 失配，测试文件写入被 R-TDD-ORDER 拒绝，而 RED 又
        // 必须由测试文件产生 —— 形成死锁。因此再加一层常见测试路径识别。
        const isTestFile = matchAnyGlob(task.tests, target) || looksLikeTestPath(target)
        if (tddRequired && !isTestFile && tddState === 'none') {
          applyRule(
            tddRule,
            `任务 ${task.id} 要求 TDD，但还没有 RED 回执（当前 tdd=${tddState}）；先写失败测试并 flow_verify 跑出失败`,
          )
        }
      } else if (tddRule) {
        if (!allowMatched) allowMatched = tddRule
      }
    }
  }

  // ---- 11. Project-appended rules (config.rules, non-builtin ids) ---------
  if (!matched) {
    for (const rule of rules) {
      if (RESERVED_RULE_IDS.includes(rule.id)) continue
      if (!ruleConditionMatches(rule.when, input)) continue
      if (rule.decision === 'allow') {
        if (!allowMatched) allowMatched = rule
        continue
      }
      applyRule(rule, `${describeAction(action)} 命中项目规则 ${rule.id}`)
      break
    }
  }

  // ---- 12. Uncovered tools -> human --------------------------------------
  if (!matched && !allowMatched) {
    const mcpRule = pick('R-MCP')
    if (mcpRule && mcpRule.decision !== 'allow') {
      const classification = classifyTool(action.tool)
      const uncovered = kind === 'mcp' || (kind === 'other' && !classification.covered)
      if (uncovered) {
        applyRule(
          mcpRule,
          `工具 ${action.tool} 未在覆盖自检中确认分类（${classification.reason ?? '无法分类'}）`,
        )
      }
    } else if (mcpRule) {
      if (!allowMatched) allowMatched = mcpRule
    }
  }

  // ---- 13. Exceptions and single-use overrides ---------------------------
  if (matched) {
    const matchedNow: Matched = matched
    const cancellable = matchedNow.rule.id !== 'R-PROTECTED' && matchedNow.rule.id !== 'R-LOCK'
    if (cancellable) {
      const fingerprint = fingerprintAction(action)
      const override = input.overrides.find(
        (item) =>
          item.ruleId === matchedNow.rule.id &&
          !item.usedAt &&
          (item.actionFingerprint === '' || item.actionFingerprint === fingerprint) &&
          (!change || item.changeId === change.id),
      )
      if (override) {
        notes.push(`单次放行 ${override.id} 已生效：只抵消规则 ${matchedNow.rule.id} 这一次（用后记账）`)
        return allowDecision(matchedNow.rule, notes, override.id)
      }
      const exception = input.exceptions.find(
        (item) =>
          item.ruleId === matchedNow.rule.id &&
          !item.revokedAt &&
          (!change || item.changeId === change.id) &&
          exceptionMatchesPath(item.pathPattern, action),
      )
      if (exception) {
        notes.push(`例外 ${exception.id} 允许本次动作（规则 ${matchedNow.rule.id}，可撤销）`)
        return allowDecision(matchedNow.rule, notes, undefined, exception.id)
      }
    }
    return blockDecision(matchedNow, input, notes)
  }

  // ---- 14. Default allow --------------------------------------------------
  return allowDecision(allowMatched, notes)
}

function fallbackTriggerRule(hit: TriggerHit): Rule {
  return {
    id: hit.trigger.toUpperCase().replace(/-/g, '-'),
    when: {},
    decision: hit.decision,
    why: hit.title,
    unlock: '等负责人在面板处理待处理项后再重试。',
  }
}

function exceptionMatchesPath(
  pathPattern: string | undefined,
  action: Action,
): boolean {
  if (pathPattern === undefined || pathPattern === '') return true
  const target = actionTargetPath(action)
  if (target !== undefined && matchGlob(pathPattern, target)) return true
  if (isFileAction(action) && action.kind === 'rename' && action.toPath) {
    if (matchGlob(pathPattern, normalizeRelPath(action.toPath))) return true
  }
  if (action.kind === 'shell') {
    if (action.command.includes(pathPattern)) return true
    const targets = extractWriteTargets(action.command)
    if (targets.some((path) => matchGlob(pathPattern, normalizeRelPath(path)))) return true
  }
  return false
}

function protectedTargetReason(input: RuleEvaluationInput): string | undefined {
  const action = input.action
  const config = input.config
  const paths: string[] = []
  if (isFileAction(action) && action.kind !== 'read') {
    paths.push(action.path)
    if (action.kind === 'rename' && action.toPath) paths.push(action.toPath)
  } else if (action.kind === 'shell') {
    paths.push(...extractWriteTargets(action.command))
  }
  for (const path of paths) {
    // The current stage's own artifacts live under .flowgate/ but are *meant*
    // to be written by the agent (clarify/proposal/spec/context/design/...).
    // Only plugin-owned state (ledger, status, evidence, config, keys) is
    // protected; otherwise the protected-path rule would deadlock the pipeline.
    if (input.change && isArtifactWritableInStage(input.change, path)) continue
    const verdict = isProtectedPath(path, config)
    if (verdict.protected) {
      return `路径 ${normalizeRelPath(path)} 受保护：${verdict.reason ?? '只有插件或负责人能写'}`
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Explanation (FR-9.1: short message for the agent, full card for the owner)
// ---------------------------------------------------------------------------

export function explainDecision(
  decision: Decision,
  context: { stage: StageId; changeId?: string },
): { short: string; card: Record<string, string> } {
  const label = `${context.stage} ${STAGE_LABELS[context.stage] ?? ''}`.trim()
  const ruleId = decision.rule?.ruleId ?? '默认允许'
  const card: Record<string, string> = {
    阶段: label,
    判定: decision.effect === 'deny' ? '拒绝' : decision.effect === 'human' ? '需要人工确认' : '允许',
    规则: ruleId,
  }
  if (decision.rule) {
    card['为什么'] = decision.rule.why
    card['怎么解锁'] = decision.rule.unlock
    if (decision.rule.source) card['方法来源'] = decision.rule.source
  }
  if (context.changeId) card['变更'] = context.changeId
  if (decision.pendingDraft) {
    card['待处理项'] = `${decision.pendingDraft.kind}：${decision.pendingDraft.title}`
  }
  if (decision.overrideUsed) card['单次放行'] = decision.overrideUsed
  if (decision.exceptionUsed) card['例外'] = decision.exceptionUsed
  if (decision.notes && decision.notes.length > 0) card['提示'] = decision.notes.join('；')

  const short =
    decision.effect === 'allow'
      ? decision.rule
        ? `FlowGate 允许（${ruleId}）。`
        : '允许'
      : decision.message
  return { short, card }
}
