/**
 * Built-in rules (03 §4.1). Rule data is pure configuration: the guard's ordered
 * pipeline (`evaluate.ts`) implements the semantics, and `loadRules` lets a
 * project override a built-in rule by id (e.g. flip `decision` to `human`) or
 * append project-specific rules.
 *
 * The rule ids are stable: `/flow allow-once <rule-id>` and exceptions refer to
 * them, so never rename a built-in rule without a migration.
 */
import type { FlowgateConfig, Rule } from '../types'
import { TRIGGER_RULES } from './risk-triggers'

export const BUILTIN_RULES: Rule[] = [
  {
    id: 'R-PROTECTED',
    when: { action: ['write', 'create', 'delete', 'rename'] },
    decision: 'deny',
    why:
      'FlowGate 自己维护的文件（账本、进行状态、证据、审查结论、报告、配置、密钥文件、.git 内部）不能由 agent 写，' +
      '否则过程记录可被改写，篡改检测与范围归因都会失真。',
    unlock:
      '这些文件由插件或负责人写入：改流程配置请在 .flowgate/config.yaml 里改，改状态用 flow_* 工具；' +
      '普通产物请按阶段流程写对应文件。',
    source: '威胁模型（03 §2.3）· FR-4.6',
    builtin: true,
  },
  {
    id: 'R-ANALYSIS-READONLY',
    when: {
      changeKind: ['analysis'],
      action: ['write', 'create', 'delete', 'rename', 'shell'],
    },
    decision: 'deny',
    why: '只读分析任务（A-xxx）只允许读代码、搜索和 FlowGate 工具，写文件或执行命令会改变被分析的对象。',
    unlock:
      '分析任务不产出代码：把结论写进 flow_submit_analysis 的结构化提交（带源码引用）；要动手改代码请调用 flow_new_change({ relatedTo: "<A-编号>" }) 新建关联变更。',
    source: 'FR-16 · 03 §3.7',
    builtin: true,
  },
  {
    id: 'R-DELEGATE',
    when: { action: ['delegate'] },
    decision: 'deny',
    why:
      '受管控会话关闭原生委派工具，任务必须按执行图由 FlowGate 派发，否则并行调度、范围控制和证据链都会失效。',
    unlock: '改用 flow_dispatch_next（S4 按执行图派发任务）或 flow_investigate（只读调查子 agent）。',
    source: '03 §2.4 · FR-15',
    builtin: true,
  },
  {
    id: 'R-STAGE-SRC',
    when: {
      stage: ['S0', 'S1', 'S2', 'S3'],
      action: ['write', 'create', 'delete', 'rename', 'shell'],
    },
    decision: 'deny',
    why: '先定"做什么"再动代码：需求和计划获批之前不写源码、测试或配置（S0–S3 只能写本变更的产物）。',
    unlock:
      '完成当前阶段产物并调用 flow_submit({ gate: "<当前门>" })；确需立即修改，等待负责人在授权卡片上单次放行（R-STAGE-SRC）。',
    source: 'OpenSpec——proposal 获批前不写代码 · FR-4.1',
    builtin: true,
  },
  {
    id: 'R-PUSH',
    when: { action: ['push', 'shell'] },
    decision: 'deny',
    why: '推送会把未验证的提交发布出去，必须在 G5 验证、G6 交付确认之后；agent 不能自行发布。',
    unlock: '先通过 G5、G6；推送由负责人在 G6 之后手动执行或在面板/授权卡片上确认。',
    source: '03 §8.2 推送触发器 · FR-7',
    builtin: true,
  },
  {
    id: 'R-SCOPE',
    when: { stage: ['S4', 'S5'], action: ['write', 'create', 'delete', 'rename'], outside: 'task.scope' },
    decision: 'deny',
    why: '只改当前任务范围内的文件，避免顺手重构和改变原有行为。',
    unlock:
      '用 flow_request_scope_change 说明要加的路径和理由，等负责人批准；或先领取正确的任务卡（flow_task_start / flow_dispatch_next）。',
    source: 'gstack /freeze · Superpowers writing-plans · FR-4.3',
    builtin: true,
  },
  {
    id: 'R-DELETE',
    when: { stage: ['S4', 'S5'], action: ['delete', 'rename'], outside: 'task.allowed' },
    decision: 'deny',
    why:
      '删除和重命名必须先写进任务卡 changes，插件要从 git 取出原内容交给审查；未声明的删除/重命名一律拒绝。',
    unlock:
      '在任务卡 changes 里声明 { path, kind: delete|rename, to? } 并重新过 G3；删除受版本控制的文件还会把变更风险提高为高风险。',
    source: '03 §5.6 · FR-4.12',
    builtin: true,
  },
  {
    id: 'R-NEWFILE',
    when: { stage: ['S4', 'S5'], action: ['create'], outside: 'task.allowed' },
    decision: 'deny',
    why: '新建文件必须事先写在任务卡 new_files 里，避免重复造轮子和计划外文件。',
    unlock:
      '先查 project.md 的可复用模块清单；确需新增用 flow_request_scope_change 申请范围变更，或把实现并入已有模块。',
    source: '03 §5.4 · FR-4.4',
    builtin: true,
  },
  {
    id: 'R-TDD-ORDER',
    when: { stage: ['S4'], action: ['write', 'create'] },
    decision: 'deny',
    why: '先写失败测试再写实现（RED → GREEN），避免"写完实现再补测试"导致测试没有真正约束实现。',
    unlock:
      '先写/改测试文件并调用 flow_verify 跑出失败（RED 回执），再改实现；任务卡标 tdd: optional 并写理由可豁免（高风险豁免需负责人批准）。',
    source: 'Superpowers test-driven-development · 03 §6.5',
    builtin: true,
  },
  {
    id: 'R-MCP',
    when: { action: ['mcp', 'other'] },
    decision: 'human',
    why:
      'MCP 与未知工具的写入语义无法静态确认；覆盖自检里未分类的可写工具默认转人工，避免绕过门禁。',
    unlock:
      '让负责人在面板确认本次调用（待处理项审批后单次放行）；或由负责人为该工具配置 allow 规则/例外。',
    source: '03 §4.3 工具分类与覆盖自检 · FR-9.5',
    builtin: true,
  },
]

/**
 * Effective rules = built-ins (`BUILTIN_RULES`) + the built-in risk trigger
 * metadata (`TRIGGER_RULES`, so `/flow allow-once T-SENSITIVE-PATH` works), with
 * `config.rules` overriding by id (partial override is merged onto the built-in,
 * so flipping only `decision` works) and new ids appended in config order.
 */
export function loadRules(config: FlowgateConfig): Rule[] {
  const byId = new Map<string, Rule>()
  for (const rule of BUILTIN_RULES) byId.set(rule.id, { ...rule, builtin: true })
  for (const rule of TRIGGER_RULES) byId.set(rule.id, { ...rule, builtin: true })
  const overrides = config?.['rules'] ?? []
  for (const override of overrides) {
    if (!override || typeof override.id !== 'string' || override.id === '') continue
    const base = byId.get(override.id)
    const overrideWhen =
      override.when && Object.keys(override.when).length > 0 ? override.when : undefined
    const merged: Rule = {
      ...(base ?? {}),
      ...override,
      id: override.id,
      // An empty `when: {}` on a built-in override keeps the built-in conditions
      // (config only flips decision/why/unlock); custom rules keep their own.
      when: overrideWhen ?? base?.when ?? override.when,
      builtin: false,
      source: override.source ?? base?.source,
    }
    byId.set(override.id, merged)
  }
  return [...byId.values()]
}

export function ruleById(rules: Rule[], id: string): Rule | undefined {
  return rules.find((rule) => rule.id === id)
}

/** Built-in rule ids, used to tell appended project rules from overridden built-ins. */
export const BUILTIN_RULE_IDS: string[] = BUILTIN_RULES.map((rule) => rule.id)

/** Ids already handled by the ordered pipeline; project-appended rules skip these. */
export const RESERVED_RULE_IDS: string[] = [
  ...BUILTIN_RULE_IDS,
  ...TRIGGER_RULES.map((rule) => rule.id),
]
