/**
 * Shared mock projection for the client SSR tests.
 * Mirrors docs/impl/host-client-contract.md, including the "degrade" variants
 * (not initialized / paused change / low-complexity confirm card).
 */
import type { FlowgateProjection, JobRowWire, PanelExtras } from '../../src/client/types'
import type { RuntimeSnapshot, TaskCard } from '../../src/core/types'

export interface ProjectionOverrides {
  snapshot?: Partial<RuntimeSnapshot>
  panel?: PanelExtras
}

export function makeSnapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    initialized: true,
    changeId: 'C-003',
    title: '会员续费',
    kind: 'change',
    complexity: 'medium',
    risk: 'normal',
    stage: 'S3',
    lifecycle: 'active',
    awaitingGate: 'G3',
    pendingGate: 'G3',
    pipeline: [
      { stage: 'S0', label: '立项', status: 'done' },
      { stage: 'S1', label: '需求澄清', status: 'done' },
      { stage: 'S2', label: '上下文', status: 'done' },
      { stage: 'S3', label: '设计拆解', status: 'current' },
      { stage: 'S4', label: '执行', status: 'pending' },
      { stage: 'S5', label: '验证', status: 'pending' },
      { stage: 'S6', label: '交付', status: 'pending' },
    ],
    tasks: {
      T1: {
        id: 'T1',
        batch: 'B1',
        status: 'done',
        tdd: 'green',
        evidenceIds: ['E-1'],
        reviewIds: ['R-1'],
      },
      T2: {
        id: 'T2',
        batch: 'B2',
        status: 'running',
        tdd: 'red',
        evidenceIds: ['E-2'],
        reviewIds: [],
        worktree: '.flowgate/worktrees/C-003-T2',
        agent: 'flowgate-executor',
      },
      T3: {
        id: 'T3',
        batch: 'B2',
        status: 'running',
        tdd: 'red',
        evidenceIds: [],
        reviewIds: [],
        worktree: '.flowgate/worktrees/C-003-T3',
        agent: 'flowgate-executor',
      },
      T4: {
        id: 'T4',
        batch: 'B3',
        status: 'pending',
        tdd: 'none',
        evidenceIds: [],
        reviewIds: [],
      },
    },
    batches: [
      { id: 'B1', mode: 'sequential', status: 'done', tasks: ['T1'] },
      { id: 'B2', mode: 'parallel', status: 'running', tasks: ['T2', 'T3'] },
      { id: 'B3', mode: 'sequential', status: 'pending', tasks: ['T4'] },
    ],
    activeTaskId: 'T2',
    pending: [
      {
        id: 'RK-1',
        kind: 'risk',
        changeId: 'C-003',
        title: '新增支付依赖',
        detail: 'S4 阶段要改 pom.xml，需要人工批准',
        status: 'open',
        createdAt: '2026-10-30T09:00:00Z',
        data: { category: 'security' },
      },
      {
        id: 'SC-1',
        kind: 'scope',
        changeId: 'C-003',
        title: 'T2 需要多改一个文件',
        detail: 'RenewalService.java 不在 T2 范围里',
        status: 'open',
        createdAt: '2026-10-30T09:10:00Z',
      },
    ],
    violations: [],
    off: false,
    locked: false,
    interceptCounts: { 'R-STAGE-SRC': 2 },
    coverage: {
      entries: [
        { tool: 'edit', category: 'write', covered: true },
        { tool: 'mcp__db__run', category: 'mcp', covered: false, reason: '未分类 MCP 工具' },
      ],
      coveredWritable: 1,
      uncoveredWritable: 1,
      checkedAt: '2026-10-30T09:00:00Z',
    },
    nextStep: '等待负责人在授权卡上批准 G3',
    statusLine: '',
    updatedAt: '2026-10-30T09:20:00Z',
    ...overrides,
  }
}

export function makePanel(overrides: Partial<PanelExtras> = {}): PanelExtras {
  return {
    changes: [
      {
        id: 'C-003',
        title: '会员续费',
        kind: 'change',
        complexity: 'medium',
        risk: 'normal',
        stage: 'S3',
        lifecycle: 'active',
        session: 'web-1a2b',
        updatedAt: '2026-10-30T09:20:00Z',
        artifactLinks: [{ label: 'design.md', path: '.flowgate/changes/C-003/design.md' }],
      },
      {
        id: 'C-002',
        title: '登录鉴权',
        kind: 'change',
        complexity: 'high',
        risk: 'high',
        stage: 'S5',
        lifecycle: 'paused',
        session: 'web-77aa',
        updatedAt: '2026-10-29T18:00:00Z',
      },
      {
        id: 'A-001',
        title: '排查回调丢失',
        kind: 'analysis',
        complexity: 'low',
        risk: 'normal',
        stage: 'S3',
        lifecycle: 'active',
        updatedAt: '2026-10-28T10:00:00Z',
      },
    ],
    gate: {
      gate: 'G3',
      state: 'awaiting',
      awaitingOwner: true,
      items: [
        { item: 'design-options', label: '设计里有 2–3 个方案对比', passed: true },
        { item: 'risk-categories', label: '风险登记五类齐全', passed: true },
        { item: 'traceability', label: '场景 R2.S3 有任务覆盖', passed: false, hint: '新增任务或并入 T3', example: 'R2.S3' },
      ],
    },
    trace: [
      { requirementId: 'R1', scenarioId: 'R1.S1', title: '续费成功', taskIds: ['T1'], evidenceIds: ['E-1'], covered: true },
      { requirementId: 'R2', scenarioId: 'R2.S3', title: '重复回调', taskIds: [], evidenceIds: [], covered: false },
    ],
    risks: [
      {
        category: 'security',
        grade: 'high',
        reason: '支付回调未验签',
        mitigation: '验签 + 幂等键',
        verification: '回调重放测试',
        needsHuman: true,
      },
      {
        category: 'maintainability',
        grade: 'low',
        reason: '重试逻辑分散',
        mitigation: '抽到公共模块',
        verification: 'review',
        needsHuman: false,
      },
    ],
    intercepts: [
      {
        at: '2026-10-30T09:12:00Z',
        ruleId: 'R-STAGE-SRC',
        tool: 'edit',
        target: 'src/main/java/RenewalService.java',
        effect: 'deny',
        why: 'S3 设计拆解阶段不能写源码',
        unlock: '/flow allow-once R-STAGE-SRC 理由',
        source: 'builtin',
      },
      {
        at: '2026-10-30T09:15:00Z',
        ruleId: 'R-PROTECTED',
        tool: 'bash',
        target: '.flowgate/config.yaml',
        effect: 'human',
        why: '受保护路径',
        unlock: '由负责人批准',
      },
    ],
    rules: [
      {
        id: 'R-STAGE-SRC',
        decision: 'deny',
        why: 'S0–S3 只能写本变更产物',
        unlock: '/flow allow-once R-STAGE-SRC <理由>',
        hits: 2,
      },
      { id: 'R-PROTECTED', decision: 'human', why: '受保护路径', unlock: '人工批准', hits: 1 },
    ],
    metrics: {
      change: { 'M-1': 2, 'M-3': 1, 'M-5': '未知', 'M-9': 0.75 },
      total: { 'M-1': 5, 'M-3': 0, 'M-5': '未知' },
      notes: { 'M-1': '因阶段顺序被拒绝的动作数', 'M-5': '负责人标为误判的拦截 ÷ 全部拦截' },
    },
    evidence: [
      {
        id: 'E-1',
        taskId: 'T1',
        group: 'unit',
        kind: 'test',
        phase: 'green',
        exitCode: 0,
        run: 12,
        passed: 12,
        failed: 0,
        skipped: 0,
        fresh: true,
        finishedAt: '2026-10-30T08:40:00Z',
      },
      {
        id: 'E-2',
        taskId: 'T2',
        group: 'unit',
        kind: 'test',
        phase: 'red',
        exitCode: 1,
        run: 5,
        passed: 3,
        failed: 2,
        skipped: 0,
        fresh: false,
        finishedAt: '2026-10-30T09:05:00Z',
      },
    ],
    reviews: [
      {
        id: 'R-1',
        taskId: 'T1',
        kind: 'task',
        verdict: 'changes-required',
        findings: [
          { severity: 'major', file: 'RenewalService.java', line: 88, message: '缺少幂等键' },
          { severity: 'minor', file: 'RenewalService.java', message: '命名不一致' },
        ],
        coverageOk: true,
        createdAt: '2026-10-30T08:45:00Z',
      },
    ],
    roadmap: {
      mvpCut: 'C0–C3 在切线内',
      entries: [
        { change: 'C0', capability: '工程骨架', goal: '能构建能跑测试', status: '已交付', mvp: true },
        { change: 'C3', capability: '续费', goal: '回调幂等', status: '进行中', mvp: true },
        { change: 'C4', capability: '报表', goal: '收入报表', status: '未开始', mvp: false },
      ],
      delivered: 1,
      total: 4,
    },
    ...overrides,
  }
}

export function makeProjection(overrides: ProjectionOverrides = {}): FlowgateProjection {
  return {
    snapshot: makeSnapshot(overrides.snapshot),
    panel: overrides.panel ?? makePanel(),
    revision: 7,
    updatedAt: '2026-10-30T09:20:00Z',
  }
}

/** Low-complexity scenario: merged G1+G3 confirmation card. */
export function makeLowComplexityProjection(): FlowgateProjection {
  return makeProjection({
    snapshot: {
      changeId: 'C-007',
      title: '改文案',
      complexity: 'low',
      stage: 'S3',
      awaitingGate: 'G3',
      pending: [],
      interceptCounts: {},
      tasks: {
        T1: { id: 'T1', batch: 'B1', status: 'pending', tdd: 'none', evidenceIds: [], reviewIds: [] },
      },
      batches: [{ id: 'B1', mode: 'sequential', status: 'pending', tasks: ['T1'] }],
      nextStep: '/flow approve G3',
    },
    panel: makePanel({
      gate: {
        gate: 'G3',
        state: 'awaiting',
        awaitingOwner: true,
        items: [],
        mergedConfirm: {
          goal: '把首页按钮文案改成「马上抢购」',
          acceptance: ['点击按钮进入抢购页'],
          scope: ['src/pages/Home.tsx'],
          verify: 'pnpm test && pnpm build',
          risks: [{ title: '文案与运营口径不一致', mitigation: '与运营确认文案' }],
        },
      },
    }),
  })
}

export function makeEmptyProjection(): FlowgateProjection {
  return {
    snapshot: makeSnapshot({
      initialized: false,
      changeId: undefined,
      title: undefined,
      stage: undefined,
      lifecycle: undefined,
      awaitingGate: undefined,
      pendingGate: undefined,
      pipeline: [],
      tasks: {},
      batches: [],
      pending: [],
      interceptCounts: {},
      nextStep: '',
      coverage: undefined,
      updatedAt: '',
    }),
    panel: {},
    revision: 0,
    updatedAt: '',
  }
}

export const LONG_NEXT_STEP =
  '继续实现 T2，然后跑集成检查点、补齐新鲜证据并进入 S4 阶段 ' + 'x'.repeat(160)

// ---------------------------------------------------------------------------
// Dock-state fixtures (contract §2): one projection per input-dock state.
// ---------------------------------------------------------------------------

/** Active change without any human decision waiting (`data-state="active"`). */
export function makeActiveProjection(): FlowgateProjection {
  return makeProjection({
    snapshot: {
      awaitingGate: undefined,
      pendingGate: undefined,
      pending: [],
      violations: [],
      interceptCounts: {},
      nextStep: '继续实现 T2，然后补证据并进入 S4',
    },
    panel: { gate: undefined },
  })
}

/** No active change: the dock asks for one sentence instead of showing a card. */
export function makeIdleProjection(): FlowgateProjection {
  return makeProjection({
    snapshot: {
      changeId: undefined,
      title: undefined,
      kind: undefined,
      complexity: undefined,
      risk: undefined,
      stage: undefined,
      lifecycle: undefined,
      awaitingGate: undefined,
      pendingGate: undefined,
      pipeline: [],
      tasks: {},
      batches: [],
      pending: [],
      violations: [],
      interceptCounts: {},
      nextStep: '',
    },
    panel: {},
  })
}

/** One open risk takeover and one scope change (`data-state="pending"`). */
export function makePendingProjection(): FlowgateProjection {
  return makeProjection({
    snapshot: {
      awaitingGate: undefined,
      pendingGate: undefined,
      pending: makeSnapshot().pending,
      violations: [],
      interceptCounts: { 'R-STAGE-SRC': 1 },
      nextStep: '',
    },
    panel: { gate: undefined },
  })
}

/** Locked mode (`data-state="locked"` → repair card). */
export function makeLockedProjection(): FlowgateProjection {
  return makeProjection({ snapshot: { locked: true, awaitingGate: undefined, pending: [] }, panel: {} })
}

/** Gates switched off (`data-state="off"` → reconnect card). */
export function makeOffProjection(): FlowgateProjection {
  return makeProjection({ snapshot: { off: true, awaitingGate: undefined, pending: [] }, panel: {} })
}

/** Boundary violations + an unconfirmed non-agent change (`data-state="blocked"`). */
export function makeBlockedProjection(): FlowgateProjection {
  return makeProjection({
    snapshot: {
      awaitingGate: undefined,
      pendingGate: undefined,
      pending: [],
      violations: [
        {
          id: 'V-1',
          changeId: 'C-003',
          path: 'src/A.java',
          kind: 'outside-scope',
          detectedAt: '2026-10-30T09:00:00Z',
          source: 'post',
        },
      ],
      externalChanges: [{ path: 'src/manual.ts', at: '2026-11-01T09:00:00+08:00', origin: 'external' }],
      nextStep: '',
    },
    panel: { gate: undefined },
  })
}

// ---------------------------------------------------------------------------
// v0.3 runtime visualization fixtures (subagent catalog + background jobs)
// ---------------------------------------------------------------------------

/** Fixed clock for deterministic job durations in SSR tests/previews. */
export const RUNTIME_NOW = Date.UTC(2026, 10, 1, 1, 0, 0)

/** Native `subagentCatalog` projection rows for one parent session. */
export function makeSubagentCatalog(): unknown[] {
  return [
    { id: 'child-T1', createdAt: RUNTIME_NOW - 180_000, mode: 'one-shot', label: 'flowgate-exec-T1' },
    { id: 'child-T2', createdAt: RUNTIME_NOW - 120_000, mode: 'continuable', label: 'flowgate-exec-T2' },
    { id: 'child-R2', createdAt: RUNTIME_NOW - 90_000, mode: 'one-shot', label: 'flowgate-review-T2-1' },
    { id: 'child-F1', createdAt: RUNTIME_NOW - 60_000, mode: 'one-shot', label: 'flowgate-final-review-1' },
    { id: 'child-I1', createdAt: RUNTIME_NOW - 30_000, mode: 'one-shot', label: 'flowgate-investigate-1720000000' },
  ]
}

/** FlowGate projection whose task cards link the executor subagents above. */
export function makeAgentsProjection(): FlowgateProjection {
  const base = makeProjection()
  const tasks = {
    T1: {
      id: 'T1',
      batch: 'B1',
      status: 'done',
      tdd: 'green',
      evidenceIds: ['E-1'],
      reviewIds: ['R-1'],
      agent: 'child-T1',
      worktree: '.flowgate/worktrees/C-003-T1',
      startedAt: '2026-10-30T08:30:00Z',
      finishedAt: '2026-10-30T08:40:00Z',
    },
    T2: {
      id: 'T2',
      batch: 'B2',
      status: 'running',
      tdd: 'red',
      evidenceIds: [],
      reviewIds: [],
      agent: 'child-T2',
      worktree: '.flowgate/worktrees/C-003-T2',
      startedAt: '2026-10-30T09:00:00Z',
    },
  } as unknown as RuntimeSnapshot['tasks']
  const taskCards = {
    T2: { id: 'T2', title: '回调幂等' } as unknown as TaskCard,
  }
  return {
    ...base,
    snapshot: { ...base.snapshot, tasks, taskCards },
  }
}

/** Per-catalog running selector result: child-T2 (executor) is running. */
export const AGENTS_RUNNING_KEY = '01000'

/** Native background-job rows covering live / completed / failed / killed. */
export function makeJobRows(now: number = RUNTIME_NOW): JobRowWire[] {
  return [
    {
      id: 'J-2',
      kind: 'bash',
      label: 'pnpm build',
      status: 'completed',
      detail: 'exit code: 0',
      startedAt: now - 300_000,
      finishedAt: now - 240_000,
      output: { total: 42 },
    },
    {
      id: 'J-1',
      kind: 'bash',
      label: 'pnpm test --watch',
      status: 'running',
      progress: 'running tests…',
      startedAt: now - 65_000,
    },
    {
      id: 'J-3',
      kind: 'bash',
      label: 'node scripts/check.mjs',
      status: 'failed',
      detail: 'exit code: 2',
      startedAt: now - 120_000,
      finishedAt: now - 100_000,
    },
    {
      id: 'J-4',
      kind: 'task',
      label: 'parallel smoke',
      status: 'killed',
      detail: 'stopped by owner',
      startedAt: now - 90_000,
      finishedAt: now - 80_000,
    },
  ]
}
