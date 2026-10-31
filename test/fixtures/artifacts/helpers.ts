/**
 * Shared fixtures for the spec-layer tests (artifacts / plan / citations /
 * detect / roadmap). All timestamps are fixed so checks are deterministic.
 */
import type {
  ArtifactBundle,
  ChangeStatus,
  ClarifyDoc,
  Complexity,
  EvidenceReceipt,
  ExecutionPlan,
  FlowgateConfig,
  GateCheckContext,
  LevelProfile,
  ProjectDoc,
  RiskDoc,
  RiskLevel,
  RoadmapDoc,
  SpecDoc,
  TaskCard,
  TasksDoc,
} from '../../../src/core/types'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  parseClarify,
  parseContext,
  parseDesign,
  parseIncrementalSpec,
  parseProjectDoc,
  parseProposal,
  parseRisk,
  parseRoadmap,
  parseTasks,
} from '../../../src/core/artifacts/parse'

export const NOW = '2026-11-12T10:31:05+08:00'
export const ROOT = ''

export const RENEWAL_SCOPE = 'src/main/java/com/acme/member/renewal/**'
export const NOTIFY_SCOPE = 'src/main/java/com/acme/member/notify/**'
export const RENEWAL_SERVICE = 'src/main/java/com/acme/member/renewal/RenewalService.java'

export const CLARIFY_MD = `# 澄清记录：会员续费

## 原始描述

用户输入：加个会员续费功能，让会员能自助续费。

## 已知事实

- 会员实体包含 id 和状态字段，见 src/main/java/com/acme/member/Member.java:3-4（已确认）
- 支付回调由现有支付模块处理（代码推导），见 src/main/java/com/acme/member/PaymentCallback.java:1-3

## 六要素

| 要素 | 结论 | 来源 | 状态 |
|---|---|---|---|
| 目标 | 会员可自助完成续费，支付回调幂等 | 用户描述 | 已确认 |
| 边界（做 / 不做） | 做：续费入口、回调幂等；不做：退款、报表 | 用户描述 | 已确认 |
| 角色与权限 | 已登录会员可续费；运营无额外权限 | clarify | 已确认 |
| 验收标准 | 见增量规格 R1.S1、R1.S2 | spec.md | 已确认 |
| 约束（非功能） | 回调处理 p95 < 300ms | clarify | 已确认 |
| 未知与假设 | 假设支付平台会重试回调 | clarify | 已接受为假设 |

## 问答记录

| 问题 | 选项 | 回答 | 这个回答改变了什么 | 轮次 |
|---|---|---|---|---|
| 续费后到期日如何计算？ | A. 从旧到期日顺延；B. 从支付日算 | A | 验收场景增加「旧到期日顺延」 | 1 |
| 重复回调如何处理？ | A. 幂等返回 200；B. 报错 | A | 增加幂等测试场景 | 2 |

## 已接受的假设

- 支付平台会对失败回调重试，最多 3 次
- 存量订单不需要迁移

## 未决问题

- 无
`

export const PROPOSAL_MD = `# 变更提案：会员续费

## 为什么

会员到期后需要人工续费，客服成本高。

## 做什么

- 新增续费入口与续费订单
- 支付回调幂等处理

## 影响

- 用户：可自助续费
- 代码：新增 renewal 模块，复用支付模块签名校验

## 不做

- 不做退款流程
- 不做后台报表
`

export const SPEC_MD = `## ADDED Requirements

### Requirement: R1 续费回调幂等
系统 SHALL 对同一支付流水号的续费回调只处理一次，并正确延长到期日。

#### Scenario: R1.S1 重复回调
- GIVEN 会员 A 的续费订单已因流水号 P1 处理成功
- WHEN 支付平台再次推送流水号 P1 的成功回调
- THEN 会员 A 的到期日不变，接口返回 HTTP 200

#### Scenario: R1.S2 首次回调
- GIVEN 会员 A 的到期日是 2026-11-01
- WHEN 支付平台推送流水号 P2 的成功回调
- THEN 到期日顺延到 2026-12-01，接口返回 HTTP 200
`

/** A spec with an extra uncovered scenario R2.S3 (T2 acceptance scenario). */
export const SPEC_UNCOVERED_MD = `${SPEC_MD}
#### Scenario: R1.S3 过期会员续费
- GIVEN 会员 A 已过期 10 天
- WHEN 支付平台推送流水号 P3 的成功回调
- THEN 到期日从支付日顺延 30 天，接口返回 HTTP 200
`

export const CONTEXT_MD = `# 上下文：会员续费

## 接口约束

- POST /api/member/renew 需要登录态，签名逻辑见 src/main/java/com/acme/member/Member.java:3-4（已确认）

## 数据模型

- renewal_order 表结构见 src/main/java/com/acme/member/Member.java:2-3

## 非功能要求

- 回调处理 p95 < 300ms

## 相关模块

- src/main/java/com/acme/member/renewal
`

export const DESIGN_MD = `# 设计方案：续费回调幂等

## 方案 A 唯一索引

- 优点：实现简单、幂等由数据库保证
- 缺点：需要迁移

## 方案 B 先查后写

- 优点：不需要迁移
- 缺点：并发下可能重复处理

## 推荐

选方案 A：幂等由唯一索引保证，配合事务最稳妥。

## 数据流

支付平台回调 → RenewalController → RenewalService → renewal_order 唯一索引 → 返回 200

## 错误处理

- 签名校验失败返回 401
- 唯一索引冲突按已处理返回 200

## 回滚

关闭续费入口开关，回退 renewal 模块的提交；数据迁移可逆。

## 架构边界

不引入新的外部服务，复用支付模块签名校验。
`

export const RISK_MD = `# 风险登记

| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |
|---|---|---|---|---|---|
| 安全 | 高 | 回调需要验签，伪造回调可白嫖会员 | 复用 SignatureVerifier，拒绝未签名请求 | 场景 R1.S1 的测试 | 是 |
| 性能 | 低 | 每次续费多一次幂等查询 | 流水号加唯一索引 | 压测脚本（可选） | 否 |
| 成本 | 无 | 不新增外部调用 | — | — | 否 |
| 合规 | 中 | 续费记录含手机号 | 日志脱敏 | 审查检查 | 否 |
| 可维护性 | 中 | 续费规则分散在两个服务 | 收拢到 RenewalPolicy | 审查检查 | 否 |
`

export const TASKS_MD = `# 任务卡：会员续费

## T1 续费接口与订单

\`\`\`yaml
covers: [R1.S2]
scope:
  - src/main/java/com/acme/member/renewal/**
tests:
  - src/test/java/com/acme/member/renewal/**
new_files:
  - src/main/java/com/acme/member/renewal/RenewalService.java
depends_on: []
tdd: required
verify:
  - group: renewal-unit
    command: ./mvnw -B -q -Dtest=RenewalCallbackTest test
    inputs: [src/main/java/com/acme/member/renewal/**, pom.xml]
run: main
risk: [payment]
size: S
\`\`\`

实现续费下单与到期日计算。

## T2 回调幂等

\`\`\`yaml
covers: [R1.S1]
scope:
  - src/main/java/com/acme/member/renewal/**
tests:
  - src/test/java/com/acme/member/renewal/**
new_files:
  - src/main/java/com/acme/member/renewal/RenewalIdempotencyGuard.java
depends_on: [T1]
tdd: required
verify:
  - group: renewal-idempotency
    command: ./mvnw -B -q -Dtest=RenewalIdempotencyTest test
    inputs: [src/main/java/com/acme/member/renewal/**, pom.xml]
run: main
risk: [payment]
size: S
\`\`\`

用流水号唯一索引实现幂等。

## T3 通知模块初始化

\`\`\`yaml
covers: []
chore_reason: 配置与通知模块初始化，不直接对应验收场景
scope:
  - src/main/java/com/acme/member/notify/**
new_files:
  - src/main/java/com/acme/member/notify/NotifyClient.java
depends_on: []
tdd: optional
verify:
  - group: notify-unit
    command: ./mvnw -B -q -Dtest=NotifyClientTest test
    inputs: [src/main/java/com/acme/member/notify/**, pom.xml]
run: inline
size: S
\`\`\`

## T4 文档更新

\`\`\`yaml
covers: []
chore_reason: 更新续费相关文档，不直接对应验收场景
scope:
  - docs/guides/**
new_files:
  - docs/guides/renewal.md
depends_on: []
tdd: optional
verify:
  - group: docs
    command: pnpm lint
    inputs: [docs/guides/**, package.json]
run: inline
size: S
\`\`\`

## 执行计划

\`\`\`yaml
execution:
  - batch: B1
    mode: sequential
    tasks: [T1, T2]
    why: T2 依赖 T1 建好的订单表与接口，且两者都改 pom.xml
  - batch: B2
    mode: parallel
    tasks: [T3, T4]
    why: 通知模块与文档范围互不重叠，都只依赖 B1
\`\`\`
`

export const PROJECT_MD = `# 项目上下文：会员续费示例

## 技术栈

- Node.js 项目（package.json）（已确认）
- 包管理器：pnpm（pnpm-lock.yaml）（已确认）

## 目录与模块职责

| 路径 | 职责 |
|---|---|
| src | 业务源码 |
| docs | 文档 |

## 命令

| 名称 | 命令 |
|---|---|
| test | pnpm test |
| lint | pnpm lint |
| build | pnpm build |
| typecheck | pnpm exec tsc --noEmit |

## 编码约定

- 使用 TypeScript strict

## 禁区

- 不修改 .flowgate/state

## 可复用模块

- src/core/util

## 读取记录

- \`package.json\`
- \`pnpm-lock.yaml\`

## 描述与结论

- 项目使用 pnpm 管理依赖（已确认）
`

export const ROADMAP_MD = `# 路线图：会员管理系统

MVP 切线：C0–C1 在切线内；C2 在切线外。

| 变更 | 能力 | 一句话目标 | 验收要点 | 依赖 | 预计任务数 | MVP | 状态 |
|---|---|---|---|---|---|---|---|
| C0 | 工程骨架 | 能构建、能跑测试、有 CI | 测试框架跑通 1 个冒烟测试；CI 通过 | — | 4 | 是 | 未开始 |
| C1 | 会员续费 | 会员可自助续费 | 续费、幂等、到期日三类场景 | C0 | 8 | 是 | 未开始 |
| C2 | 后台报表 | 会员与收入报表 | 报表导出 | C1 | 6 | 否 | 未开始 |
`

export const PROJECT_CLARIFY_MD = `# 项目级澄清：会员管理系统

## 目标用户与目标

- 目标用户：门店店长；目标：会员可自助续费

## 核心流程

- 登录 → 开通会员 → 续费 → 到期提醒

## MVP 边界（做 / 不做）

- 做：会员、续费
- 不做：报表、退款

## 技术栈与部署

- 前端 React，后端 Node.js；单机 Docker 部署

## 非功能要求

- 回调 p95 < 300ms

## 约束与未知项

- 未知：支付平台是否支持幂等重试
`

export const PAYMENT_CALLBACK_JAVA = `package com.acme.member;

/** 支付回调入口。 */
public class PaymentCallback {
  public void onCallback() {
    // 验签后处理
  }
}
`

export const MEMBER_JAVA = `package com.acme.member;

public class Member {
  private String id;
  private boolean active;

  public boolean isActive() {
    return this.active;
  }
}
`

/** Repo state every check expects: change dir, project clarify, cited source. */
export function defaultFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    '.flowgate/changes/C-001/status.json': '{}',
    '.flowgate/project-clarify.md': PROJECT_CLARIFY_MD,
    'src/main/java/com/acme/member/Member.java': MEMBER_JAVA,
    'src/main/java/com/acme/member/PaymentCallback.java': PAYMENT_CALLBACK_JAVA,
    ...extra,
  }
}

export function makeFs(extra: Record<string, string> = {}): MemoryFileSystem {
  return new MemoryFileSystem(defaultFiles(extra))
}

export function validConfig(): FlowgateConfig {
  return {
    levels: { complexity: 'auto', risk: 'auto' },
    dispatch: 'auto',
    commands: {},
    limits: {
      task_max_files: 5,
      change_max_tasks: 12,
      clarify_max_rounds: 4,
      turn_continue_max: 2,
      test_output_summary_tokens: 400,
      context_warn_ratio: 0.6,
      token_budget: { low: 200000, medium: 600000, high: 1200000, ultra: 2000000 },
    },
    parallel: { max_agents: 3, setup: null, hotspots_extra: [] },
    session: { lease_minutes: 10 },
    git: { change_branch: true, auto_commit: true, commit_flowgate: false },
    review: { enabled: true, model: null, requireForTaskGate: true },
    ignore: [],
    rules: [],
    triggers: {
      sensitive_paths: [],
      sensitive_paths_extra: [],
      dependency_files: [],
      protected_paths: [],
      secret_patterns: 'builtin',
      max_scope_new_files: 3,
      consecutive_failure_limit: 3,
    },
  }
}

export function validChange(overrides: Partial<ChangeStatus> = {}): ChangeStatus {
  return {
    id: 'C-001',
    kind: 'change',
    title: '会员续费',
    summary: '给会员增加续费入口，支付回调幂等',
    complexity: 'medium',
    risk: 'normal',
    stage: 'S3',
    lifecycle: 'active',
    contract: { plugin: '0.1.0', rules: 'sha256:rules', levels: 'sha256:levels', skills: {}, createdAt: NOW },
    gates: {
      G0: { state: 'passed', attempts: 1 },
      G1: { state: 'passed', attempts: 1 },
      G2: { state: 'passed', attempts: 1 },
      G3: { state: 'passed', attempts: 1 },
      G5: { state: 'passed', attempts: 1 },
    },
    branch: 'flowgate/C-001',
    batches: [
      { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1', 'T2'] },
      { id: 'B2', mode: 'parallel', status: 'done', tasks: ['T3', 'T4'] },
    ],
    tasks: {
      T1: { id: 'T1', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-0002'], reviewIds: ['R-1'] },
      T2: { id: 'T2', batch: 'B1', status: 'done', tdd: 'green', evidenceIds: ['E-0003'], reviewIds: ['R-1'] },
      T3: { id: 'T3', batch: 'B2', status: 'done', tdd: 'none', evidenceIds: [], reviewIds: [] },
      T4: { id: 'T4', batch: 'B2', status: 'done', tdd: 'none', evidenceIds: [], reviewIds: [] },
    },
    evidenceIds: ['E-0001', 'E-0002', 'E-0003'],
    pending: [],
    overrides: [],
    exceptions: [],
    violations: [],
    reviews: [
      {
        id: 'R-1',
        changeId: 'C-001',
        kind: 'final',
        verdict: 'pass',
        findings: [],
        coverageOk: true,
        diffFingerprint: 'sha256:diff',
        createdAt: NOW,
        attempts: 1,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function task(overrides: Partial<TaskCard> & { id: string }): TaskCard {
  return {
    title: overrides.id,
    covers: [],
    scope: [],
    tests: [],
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'optional',
    verify: [],
    run: 'auto',
    risk: [],
    size: 'M',
    body: '',
    ...overrides,
  }
}

export function validTaskCards(): TaskCard[] {
  return [
    task({
      id: 'T1',
      title: '续费接口与订单',
      covers: ['R1.S2'],
      scope: [RENEWAL_SCOPE],
      tests: ['src/test/java/com/acme/member/renewal/**'],
      newFiles: [RENEWAL_SERVICE],
      tdd: 'required',
      verify: [
        {
          group: 'renewal-unit',
          command: './mvnw -B -q -Dtest=RenewalCallbackTest test',
          inputs: [RENEWAL_SCOPE, 'pom.xml'],
        },
      ],
      run: 'main',
      risk: ['payment'],
      size: 'S',
      body: '实现续费下单与到期日计算。',
    }),
    task({
      id: 'T2',
      title: '回调幂等',
      covers: ['R1.S1'],
      scope: [RENEWAL_SCOPE],
      tests: ['src/test/java/com/acme/member/renewal/**'],
      newFiles: ['src/main/java/com/acme/member/renewal/RenewalIdempotencyGuard.java'],
      dependsOn: ['T1'],
      tdd: 'required',
      verify: [
        {
          group: 'renewal-idempotency',
          command: './mvnw -B -q -Dtest=RenewalIdempotencyTest test',
          inputs: [RENEWAL_SCOPE, 'pom.xml'],
        },
      ],
      run: 'main',
      risk: ['payment'],
      size: 'S',
      body: '用流水号唯一索引实现幂等。',
    }),
    task({
      id: 'T3',
      title: '通知模块初始化',
      scope: [NOTIFY_SCOPE],
      newFiles: ['src/main/java/com/acme/member/notify/NotifyClient.java'],
      choreReason: '配置与通知模块初始化，不直接对应验收场景',
      verify: [{ group: 'notify-unit', command: './mvnw -B -q -Dtest=NotifyClientTest test', inputs: [NOTIFY_SCOPE, 'pom.xml'] }],
      run: 'main',
      size: 'S',
      body: '',
    }),
    task({
      id: 'T4',
      title: '文档更新',
      scope: ['docs/guides/**'],
      newFiles: ['docs/guides/renewal.md'],
      choreReason: '更新续费相关文档，不直接对应验收场景',
      verify: [{ group: 'docs', command: 'pnpm lint', inputs: ['docs/guides/**', 'package.json'] }],
      run: 'main',
      size: 'S',
      body: '',
    }),
  ]
}

export function validExecutionPlan(): ExecutionPlan {
  return {
    batches: [
      { batch: 'B1', mode: 'sequential', tasks: ['T1', 'T2'], why: 'T2 依赖 T1 建好的订单表与接口，且两者都改 pom.xml' },
      { batch: 'B2', mode: 'parallel', tasks: ['T3', 'T4'], why: '通知模块与文档范围互不重叠，都只依赖 B1' },
    ],
  }
}

export const CLARIFY: ClarifyDoc = parseClarify(CLARIFY_MD)
export const PROPOSAL = parseProposal(PROPOSAL_MD)
export const SPEC: SpecDoc = parseIncrementalSpec(SPEC_MD)
export const CONTEXT = parseContext(CONTEXT_MD)
export const DESIGN = parseDesign(DESIGN_MD)
export const RISK: RiskDoc = parseRisk(RISK_MD)
export const TASKS: TasksDoc = { ...parseTasks(TASKS_MD), tasks: validTaskCards(), execution: validExecutionPlan() }
export const PROJECT: ProjectDoc = parseProjectDoc(PROJECT_MD)
export const ROADMAP: RoadmapDoc = parseRoadmap(ROADMAP_MD)

export function validBundle(overrides: Partial<ArtifactBundle> = {}): ArtifactBundle {
  return {
    clarify: CLARIFY,
    proposal: PROPOSAL,
    spec: SPEC,
    context: CONTEXT,
    design: DESIGN,
    risk: RISK,
    tasks: TASKS,
    project: PROJECT,
    ...overrides,
  }
}

function receipt(overrides: Partial<EvidenceReceipt> & { id: string }): EvidenceReceipt {
  return {
    changeId: 'C-001',
    group: 'baseline',
    kind: 'test',
    phase: 'green',
    command: 'pnpm test',
    runBy: 'flowgate',
    exitCode: 0,
    summary: { parser: 'vitest', parsed: true, run: 12, passed: 12, failed: 0, skipped: 0 },
    inputsHash: 'sha256:inputs',
    outputRef: '.flowgate/state/evidence/E.log',
    startedAt: NOW,
    finishedAt: NOW,
    ...overrides,
  }
}

export function validEvidence(): EvidenceReceipt[] {
  const base = receipt({ id: 'E-0001', group: 'baseline' })
  const t1 = receipt({ id: 'E-0002', group: 'renewal-unit', taskId: 'T1', command: './mvnw -B test' })
  const t2 = receipt({ id: 'E-0003', group: 'renewal-idempotency', taskId: 'T2', command: './mvnw -B test' })
  const lint = receipt({ id: 'E-0004', group: 'lint', kind: 'lint', phase: 'none', command: 'pnpm lint', summary: null })
  const build = receipt({ id: 'E-0005', group: 'build', kind: 'build', phase: 'none', command: 'pnpm build', summary: null })
  const typecheck = receipt({
    id: 'E-0006',
    group: 'typecheck',
    kind: 'typecheck',
    phase: 'none',
    command: 'pnpm exec tsc --noEmit',
    summary: null,
  })
  return [base, t1, t2, lint, build, typecheck]
}

/** Level profile identical to state/levels.ts#levelProfile for the same inputs. */
export function levelFor(complexity: Complexity = 'medium', risk: RiskLevel = 'normal'): LevelProfile {
  const low = complexity === 'low'
  const highRisk = risk === 'high'
  const designRequired = complexity === 'high' || complexity === 'ultra'
  return {
    complexity,
    risk,
    requiresDesign: designRequired,
    requiresDesignOptions: designRequired,
    requiresRiskDoc: highRisk || !low,
    requiresExecutionPlan: !low,
    reviewRoundsPerTask: highRisk ? 2 : low ? 0 : 1,
    securityReview: highRisk,
    tddRequiredAll: highRisk,
    runtimeEvidenceRequired: highRisk,
    manualEvidenceConfirmed: highRisk,
    mergedGates: low,
    maxTasks: low ? 1 : 12,
    stages: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'],
  }
}

export function makeCtx(overrides: Partial<GateCheckContext> = {}): GateCheckContext {
  const config = overrides.config ?? validConfig()
  const change = overrides.change ?? validChange()
  return {
    root: ROOT,
    gate: overrides.gate ?? 'G3',
    level: overrides.level ?? levelFor(change.complexity, change.risk),
    change,
    config,
    artifacts: overrides.artifacts ?? validBundle(),
    fs: overrides.fs ?? makeFs(),
    evidence: overrides.evidence ?? validEvidence(),
    project: overrides.project ?? PROJECT,
    roadmap: overrides.roadmap ?? ROADMAP,
    now: overrides.now ?? NOW,
    limits: overrides.limits ?? config.limits,
    ...overrides,
  }
}

export { task as taskCard }
