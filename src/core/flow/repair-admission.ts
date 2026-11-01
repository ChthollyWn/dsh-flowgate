/**
 * 修复通道智能准入（v0.7，03 §7.9 / docs/impl/repair-lane.md §3）。
 *
 * 职责：把"这次到底该走修复车道还是变更/返工车道"从"纯靠模型自述"升级为
 * **信号推导 + 确定性复核**。设计原则（与 docs/impl/repair-lane.md 一致）：
 *
 * - 智能负责提出假设：从失败回执、未提交改动、项目命令里推导 scope/verify/title，
 *   把声明成本降到接近零；
 * - 流程负责把假设变成可核对的承诺：准入裁定（approved/adjusted/downgraded）、
 *   风险硬约束（敏感路径、过宽 scope、脏工作区、已有变更）一律确定性判定；
 * - 裁定不阻塞审计：无论通过还是拒绝都写账本 `repair.assessed` / `repair.rejected`，
 *   且拒绝理由回到工具结果里，agent 可以据此改输入或改走变更车道。
 *
 * 本模块是**纯函数**（无 IO）：engine 负责收集信号（git/回执/配置），这里只做规则。
 */
import type { ChangeStatus, EvidenceReceipt, FlowgateConfig, RepairSeverity } from '../types'
import { sensitivePathPatterns } from '../rules/risk-triggers'
import { validateVerifyCommand } from '../shell'
import { matchGlob } from '../util/glob'
import { isUnder, normalizeRelPath } from '../util/paths'
import { matchesScope } from '../util/scope'

/** 修复通道允许的 scope 条数上限（与 flow_fix_start 的容错一致）。 */
export const REPAIR_MAX_SCOPE_PATTERNS = 20
/** 修复通道关门时允许的最大改动文件数：超过视为"这不是小修复"。 */
export const REPAIR_MAX_CHANGED_FILES = 20

/** 准入裁定：approved=按声明开启；adjusted=自动补全/修正后开启；downgraded=不能按修复车道开。 */
export type RepairAdmissionVerdict = 'approved' | 'adjusted' | 'downgraded'

/** 准入建议车道：repair=修复车道；change=变更车道；rework=变更内返工（flow_declare_rework）。 */
export type RepairLaneRecommendation = 'repair' | 'change' | 'rework'

/** 一条确定性准入检查。weight=block 的失败会降级；warn 只记录。 */
export interface RepairAdmissionCheck {
  id: string
  label: string
  passed: boolean
  weight: 'block' | 'warn'
  detail?: string
}

/** engine 收集的准入信号（纯数据，方便单测）。 */
export interface RepairAdmissionInput {
  title: string
  symptom: string
  repro?: string
  /** 声明 scope（可为空：允许从信号推导）。 */
  scope: string[]
  /** 声明 verify（可为空：允许从失败回执/项目命令推导）。 */
  verify: string
  acceptance: string[]
  severity: RepairSeverity
  config: FlowgateConfig
  activeChange: Pick<ChangeStatus, 'id' | 'title'> | null
  activeRepairId?: string | null
  /** 项目是否 `/flow init` 过（engine.isInitialized()）。 */
  initialized: boolean
  locked: boolean
  /** 已加载的验证回执（用于找最近失败命令作为 RED 线索与 verify 候选）。 */
  receipts: readonly EvidenceReceipt[]
  /** `git status --porcelain` 收集到的未提交改动；null=收集不到。 */
  changedFiles: string[] | null
  now: string
}

/** 准入复核结果（engine 用它开启修复或拒绝，host 工具用 dryRun 展示）。 */
export interface RepairAdmissionReview {
  verdict: RepairAdmissionVerdict
  recommendedLane: RepairLaneRecommendation
  title: string
  symptom: string
  /** 最终 scope（adjusted 时是补全后的；downgraded 时是建议值）。 */
  scope: string[]
  /** 最终 verify（同上）。 */
  verify: string
  acceptance: string[]
  severity: RepairSeverity
  scopeSource: 'declared' | 'suggested' | 'none'
  verifySource: 'declared' | 'failed-receipt' | 'project' | 'none'
  suggestedScope: string[]
  suggestedVerify: string
  confidence: 'high' | 'medium' | 'low'
  checks: RepairAdmissionCheck[]
  reasons: string[]
  blockers: string[]
  /** 最近失败回执（RED 线索；只提示，不自动绑定，避免把无关失败当成本次 RED）。 */
  redEvidence: { id: string; command: string; phase: string; finishedAt: string } | null
  /** 预存未提交改动（全部命中最终 scope 才允许开始，否则关门必失败）。 */
  dirtyFiles: string[]
  /** 是否还需要先拿 RED 证据（修复通道关门硬要求，但准入时可能还没跑）。 */
  requiresRed: boolean
  /** 给 agent 的下一步（中文短句，不含必须人工执行的命令）。 */
  nextSteps: string[]
  reviewedAt: string
}

/** 常见顶层目录：`src/**` 这类"整棵目录"在修复车道里视为过宽。 */
const TOP_LEVEL_DIRS = new Set(['src', 'test', 'tests', 'docs', 'lib', 'scripts', 'packages', 'app', 'apps', 'server', 'client'])

/** 从失败回执里提取路径 token 作为 scope 候选（只取可读的测试/源码路径）。 */
const PATH_TOKEN_RE = /(?:^|[\s"'(=])((?:src|test|tests|lib|scripts|docs|packages|app|apps|server|client)\/[A-Za-z0-9_./@-]+|(?:[A-Za-z0-9_./@-]+\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|java|rs)))(?=$|[\s"'),])/g

/** 单条 scope pattern 是否过宽（整棵顶层目录 / 通配一切 / 根目录）。 */
export function isBroadScopePattern(pattern: string): boolean {
  const normalized = normalizeRelPath(pattern).replace(/\/+$/, '')
  if (normalized === '' || normalized === '.' || normalized === '**' || normalized === '*' || normalized === '**/*') return true
  const stripped = normalized.replace(/\/\*\*$/, '')
  if (stripped === normalized && !normalized.includes('/') && TOP_LEVEL_DIRS.has(normalized)) return true
  if (TOP_LEVEL_DIRS.has(stripped) && !stripped.includes('/')) return true
  return false
}

/** scope pattern 是否可能触达敏感面（敏感路径是内置触发器，不看模型自述）。 */
export function scopeTouchesSensitive(pattern: string, sensitivePatterns: readonly string[]): boolean {
  const normalized = normalizeRelPath(pattern)
  if (normalized === '') return false
  for (const sensitive of sensitivePatterns) {
    if (matchGlob(sensitive, normalized)) return true
    // 敏感 glob 的字面段（去掉 ** 与通配符）：例如 `**/auth/**` → ['auth']。
    const literalSegments = sensitive
      .split('/')
      .map((segment) => segment.replace(/^\*+|\*+$/g, ''))
      .filter((segment) => segment !== '' && !segment.includes('*'))
    if (literalSegments.length > 0 && literalSegments.every((segment) => normalized.split('/').includes(segment))) return true
  }
  return false
}

function dedupePaths(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) {
    const normalized = normalizeRelPath(value.trim())
    if (normalized === '' || out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

/** 从失败回执与未提交改动推导 scope 候选。 */
export function deriveScopeCandidates(input: {
  changedFiles: readonly string[] | null
  receipts: readonly EvidenceReceipt[]
}): string[] {
  const candidates: string[] = []
  if (input.changedFiles !== null) {
    for (const path of input.changedFiles) {
      // 预存改动本身可能是无关脏改动：只作为候选，最终仍要求全部命中最终 scope。
      if (isUnder(path, '.flowgate') || isUnder(path, '.git')) continue
      candidates.push(path)
    }
  }
  const failed = input.receipts
    .filter((receipt) => receipt.phase === 'red' || receipt.exitCode !== 0)
    .slice(-5)
    .reverse()
  for (const receipt of failed) {
    for (const match of receipt.command.matchAll(PATH_TOKEN_RE)) {
      const token = match[1]
      if (token !== undefined) candidates.push(token)
    }
  }
  return dedupePaths(candidates).slice(0, REPAIR_MAX_SCOPE_PATTERNS)
}

/** 推导 verify：优先最近一次失败的测试/构建命令，其次项目配置的全量测试命令。 */
export function deriveVerifyCandidate(input: {
  config: FlowgateConfig
  receipts: readonly EvidenceReceipt[]
}): { verify: string; source: RepairAdmissionReview['verifySource'] } {
  const failed = [...input.receipts]
    .filter((receipt) => (receipt.kind === 'test' || receipt.kind === 'build' || receipt.kind === 'lint' || receipt.kind === 'typecheck') && receipt.command.trim() !== '')
    .filter((receipt) => receipt.phase === 'red' || receipt.exitCode !== 0)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
  for (const receipt of failed) {
    if (validateVerifyCommand(receipt.command).ok) return { verify: receipt.command.trim(), source: 'failed-receipt' }
  }
  const projectTest = (input.config.commands.test ?? '').trim()
  if (projectTest !== '' && projectTest !== 'none' && validateVerifyCommand(projectTest).ok) {
    return { verify: projectTest, source: 'project' }
  }
  return { verify: '', source: 'none' }
}

function clip(text: string, max: number): string {
  const value = text.trim().replace(/\s+/g, ' ')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/** 把声明/推导结果落成一次确定性准入裁定（纯函数、可重放）。 */
export function reviewRepairAdmission(input: RepairAdmissionInput): RepairAdmissionReview {
  const checks: RepairAdmissionCheck[] = []
  const reasons: string[] = []
  const blockers: string[] = []
  const add = (check: RepairAdmissionCheck): void => {
    checks.push(check)
    if (!check.passed) {
      if (check.weight === 'block') blockers.push(check.detail ?? check.label)
      else reasons.push(check.detail ?? check.label)
    }
  }

  const symptom = input.symptom.trim()
  const symptomTitle = clip(symptom.split(/[\n。.]/)[0] ?? '', 40)
  const title = input.title.trim() !== '' ? input.title.trim() : symptomTitle
  add({
    id: 'intent',
    label: '症状与标题可核对',
    passed: symptom !== '' && title !== '',
    weight: 'block',
    detail: symptom === '' ? '必须写症状（symptom）：可观察的报错/错误行为/影响面' : undefined,
  })

  add({
    id: 'initialized',
    label: '项目已启用 FlowGate',
    passed: input.initialized === true,
    weight: 'block',
    detail: input.initialized !== true ? '项目未执行 /flow init：先启用 FlowGate 再开修复通道' : undefined,
  })

  add({
    id: 'locked',
    label: '未处于锁定模式',
    passed: input.locked !== true,
    weight: 'block',
    detail: input.locked ? 'LockGate 处于锁定模式：先从账本/产物修复状态后再开修复通道' : undefined,
  })

  const activeChange = input.activeChange
  add({
    id: 'lane',
    label: '没有进行中的变更（修复车道与变更车道互斥）',
    passed: activeChange === null || activeChange === undefined,
    weight: 'block',
    detail:
      activeChange !== null && activeChange !== undefined
        ? `已有进行中的变更 ${activeChange.id}（${activeChange.title}）：bug 修复应作为变更内返工处理（flow_declare_rework），不要另开修复车道`
        : undefined,
  })

  add({
    id: 'repair',
    label: '没有进行中的修复',
    passed: input.activeRepairId === undefined || input.activeRepairId === null,
    weight: 'block',
    detail: input.activeRepairId ? `已有进行中的修复 ${input.activeRepairId}：先 flow_fix_done 或 flow_fix_abort` : undefined,
  })

  // ---- scope：声明优先；为空时从"未提交改动 + 失败回执里的路径"推导 ----
  let declaredScope = dedupePaths(input.scope)
  const protectedScope = declaredScope.filter((pattern) => isUnder(pattern, '.flowgate') || isUnder(pattern, '.git'))
  if (protectedScope.length > 0) {
    declaredScope = declaredScope.filter((pattern) => !protectedScope.includes(pattern))
    reasons.push(`已从 scope 移除受保护路径：${protectedScope.join('、')}（.flowgate/.git 永远不允许 agent 写）`)
  }
  const suggestedScope = deriveScopeCandidates({ changedFiles: input.changedFiles, receipts: input.receipts })
  let scope = declaredScope
  let scopeSource: RepairAdmissionReview['scopeSource'] = scope.length > 0 ? 'declared' : 'none'
  if (scope.length === 0 && suggestedScope.length > 0) {
    scope = suggestedScope
    scopeSource = 'suggested'
    reasons.push(`scope 未声明，按信号推导出 ${scope.length} 条：${scope.join('、')}`)
  }
  add({
    id: 'scope',
    label: '修复范围可确定（1–20 条）',
    passed: scope.length >= 1 && scope.length <= REPAIR_MAX_SCOPE_PATTERNS,
    weight: 'block',
    detail:
      scope.length === 0
        ? '无法推导修复范围：请声明 scope（要改哪些文件/目录），或先跑一次失败命令/产生未提交改动让信号可见'
        : scope.length > REPAIR_MAX_SCOPE_PATTERNS
          ? `scope 有 ${scope.length} 条（上限 ${REPAIR_MAX_SCOPE_PATTERNS}）：缩小范围；跨模块大改请走 flow_new_change`
          : undefined,
  })
  const broad = scope.filter((pattern) => isBroadScopePattern(pattern))
  add({
    id: 'scope-broad',
    label: '修复范围不是整库/整棵顶层目录',
    passed: broad.length === 0,
    weight: 'block',
    detail: broad.length > 0 ? `scope 过宽：${broad.join('、')}（会命中整棵目录/全仓库，修复车道只接受小范围）` : undefined,
  })
  const sensitivePatterns = sensitivePathPatterns(input.config)
  const sensitive = scope.filter((pattern) => scopeTouchesSensitive(pattern, sensitivePatterns))
  add({
    id: 'scope-sensitive',
    label: '修复范围不涉及敏感面（认证/支付/迁移/密钥/CI 等）',
    passed: sensitive.length === 0,
    weight: 'block',
    detail: sensitive.length > 0 ? `scope 命中敏感面：${sensitive.join('、')}——必须走变更车道（auto-review 强制人工/全流程）` : undefined,
  })
  add({
    id: 'scope-declared',
    label: '范围来源可解释',
    passed: scopeSource !== 'none',
    weight: 'warn',
    detail: scopeSource === 'suggested' ? 'scope 由信号自动推导（可在 flow_fix_start 里显式覆盖）' : undefined,
  })

  // ---- verify：声明优先；为空时从失败回执/项目命令推导 ----
  let verify = input.verify.trim()
  let verifySource: RepairAdmissionReview['verifySource'] = verify !== '' ? 'declared' : 'none'
  const derivedVerify = deriveVerifyCandidate({ config: input.config, receipts: input.receipts })
  if (verify === '' && derivedVerify.verify !== '') {
    verify = derivedVerify.verify
    verifySource = derivedVerify.source
    reasons.push(`verify 未声明，按${derivedVerify.source === 'failed-receipt' ? '最近失败回执' : '项目测试命令'}推导：${verify}`)
  }
  const verifyShape = verify === '' ? { ok: false, reason: '没有可用的验证命令' } : validateVerifyCommand(verify)
  add({
    id: 'verify',
    label: '验证命令可执行且形状合法',
    passed: verifyShape.ok,
    weight: 'block',
    detail: verifyShape.ok
      ? undefined
      : verify === ''
        ? '无法推导验证命令：请声明 verify，或先跑一次失败测试/在 project.md 配置 commands.test'
        : `验证命令不合法：${verifyShape.reason ?? '形状非法'}`,
  })

  // ---- 预存脏改动：关门时按 git status 全量核对，开始前就要能过 ----
  const changedFiles = input.changedFiles ?? []
  const dirtyOutside = changedFiles.filter((path) => !matchesScope(path, scope))
  add({
    id: 'dirty-worktree',
    label: '工作区预存改动都在修复范围内',
    passed: dirtyOutside.length === 0,
    weight: 'block',
    detail:
      dirtyOutside.length > 0
        ? `工作区已有 ${dirtyOutside.length} 个未提交改动不在 scope 内：${dirtyOutside.slice(0, 5).join('、')}${dirtyOutside.length > 5 ? ' 等' : ''}。先提交/暂存这些改动再开修复通道（否则 flow_fix_done 会判越界）`
        : undefined,
  })

  // ---- 最近失败回执：只作 RED 线索，不自动绑定 ----
  const latestFailed = [...input.receipts]
    .filter((receipt) => receipt.phase === 'red' || receipt.exitCode !== 0)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0]
  const redEvidence =
    latestFailed === undefined
      ? null
      : { id: latestFailed.id, command: latestFailed.command, phase: latestFailed.phase, finishedAt: latestFailed.finishedAt }
  add({
    id: 'red',
    label: '关门需要 RED→GREEN 证据',
    passed: redEvidence !== null,
    weight: 'warn',
    detail:
      redEvidence === null
        ? '还没有失败回执：开启后先用 flow_verify 跑一次失败命令拿 RED（这是关门硬要求）'
        : `发现最近失败回执 ${redEvidence.id}（${redEvidence.command}）：若它对应本次症状可直接引用，否则先跑 flow_verify 重新拿 RED`,
  })

  // ---- acceptance：为空时给两条通用验收（不阻塞，但写进记录） ----
  let acceptance = input.acceptance.map((item) => item.trim()).filter((item) => item !== '')
  if (acceptance.length === 0) {
    const acceptanceSuggestion = [`「${clip(symptom, 40)}」不再复现`, `验证命令通过：${verify}`]
    if (acceptanceSuggestion[0] !== '' && acceptanceSuggestion[1] !== undefined) acceptance = acceptanceSuggestion
    reasons.push('acceptance 未声明，已生成两条默认验收要点（可随时在关闭时用 summary 补充）')
  }

  const derivedTitle = input.title.trim() === ''
  const anyAdjust = scopeSource === 'suggested' || verifySource === 'failed-receipt' || verifySource === 'project' || derivedTitle
  const blockersCount = blockers.length
  const verdict: RepairAdmissionVerdict = blockersCount > 0 ? 'downgraded' : anyAdjust ? 'adjusted' : 'approved'
  const recommendedLane: RepairLaneRecommendation =
    activeChange !== null && activeChange !== undefined
      ? 'rework'
      : sensitive.length > 0 || broad.length > 0 || scope.length > REPAIR_MAX_SCOPE_PATTERNS
        ? 'change'
        : 'repair'
  const confidence: RepairAdmissionReview['confidence'] =
    verdict === 'downgraded' ? 'low' : scopeSource === 'suggested' || verifySource !== 'declared' ? 'medium' : 'high'

  if (verdict === 'downgraded') {
    reasons.push(...blockers.map((blocker) => `准入未通过：${blocker}`))
  } else if (verdict === 'adjusted') {
    reasons.push('准入通过（已自动补全/规范化声明，写入修复记录）')
  } else {
    reasons.push('准入通过（按声明开启修复通道）')
  }

  const nextSteps: string[] = []
  if (verdict === 'downgraded') {
    nextSteps.push(
      recommendedLane === 'change'
        ? '改用 flow_new_change 立项（跨模块/敏感面/大范围改动不允许走修复通道）'
        : recommendedLane === 'rework'
          ? '用 flow_declare_rework 在现有变更内返工（修复车道只用于无进行中变更的独立 bug）'
          : '按上面的准入未通过原因修正声明（scope/verify/工作区）后重试 flow_fix_start',
    )
  } else {
    if (redEvidence === null) nextSteps.push('先 flow_verify 跑失败命令拿 RED（group 自定，如 repro）')
    else nextSteps.push(`可复用/核对 RED 回执 ${redEvidence.id}；若不对应本次症状先重新 flow_verify`)
    nextSteps.push('在 scope 内修复，改到验证命令通过（GREEN）')
    nextSteps.push('flow_fix_done：会重跑验证命令 + 全量回归 + 核对改动都在 scope 内')
  }

  return {
    verdict,
    recommendedLane,
    title,
    symptom,
    scope,
    verify,
    acceptance,
    severity: input.severity,
    scopeSource,
    verifySource,
    suggestedScope,
    suggestedVerify: derivedVerify.verify,
    confidence,
    checks,
    reasons,
    blockers,
    redEvidence,
    dirtyFiles: changedFiles,
    requiresRed: true,
    nextSteps,
    reviewedAt: input.now,
  }
}

