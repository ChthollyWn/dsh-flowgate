/**
 * Test fixtures for the state / rules modules. Everything is deterministic: fixed
 * timestamps, no filesystem, no clock, no randomness.
 */
import type {
  ChangeKind,
  ChangeStatus,
  Complexity,
  FlowgateConfig,
  RiskLevel,
  StageId,
  TaskCard,
  TaskState,
} from '../../../src/core/types'
import { initialStatus } from '../../../src/core/state/transitions'

export const AT = '2026-11-12T10:00:00+08:00'
export const AT_LATER = '2026-11-12T10:30:00+08:00'

export const DEFAULT_LIMITS = {
  task_max_files: 5,
  change_max_tasks: 12,
  clarify_max_rounds: 4,
  turn_continue_max: 2,
  test_output_summary_tokens: 400,
  context_warn_ratio: 0.6,
  token_budget: { low: 200_000, medium: 600_000, high: 1_200_000, ultra: 2_000_000 },
}

export function makeConfig(overrides: Partial<FlowgateConfig> = {}): FlowgateConfig {
  const base: FlowgateConfig = {
    levels: { complexity: 'auto', risk: 'auto' },
    learning: 'detail',
    dispatch: 'auto',
    commands: {},
    limits: { ...DEFAULT_LIMITS },
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
  return { ...base, ...overrides }
}

export interface ChangeOptions {
  id?: string
  kind?: ChangeKind
  title?: string
  summary?: string
  complexity?: Complexity
  risk?: RiskLevel
  stage?: StageId
  tasks?: Record<string, TaskState>
  scopeAdditions?: Record<string, string[]>
}

export function makeChange(options: ChangeOptions = {}): ChangeStatus {
  const status = initialStatus({
    id: options.id ?? 'C-001',
    kind: options.kind ?? 'change',
    title: options.title ?? '会员续费',
    summary: options.summary ?? '新增续费回调幂等',
    complexity: options.complexity ?? 'medium',
    risk: options.risk ?? 'normal',
    stage: options.stage ?? 'S4',
    at: AT,
  })
  if (options.tasks) status.tasks = options.tasks
  if (options.scopeAdditions) status.scopeAdditions = options.scopeAdditions
  return status
}

export function makeTask(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: 'T3',
    title: '续费回调幂等',
    covers: ['R2.S1'],
    scope: ['src/main/java/com/acme/renewal/**'],
    tests: ['src/test/java/com/acme/renewal/**'],
    newFiles: [],
    changes: [],
    dependsOn: [],
    tdd: 'required',
    tddReason: '包含幂等逻辑，必须 TDD',
    verify: [{ group: 'renewal-unit', command: './mvnw -B -q -Dtest=RenewalCallbackTest test', inputs: ['pom.xml'] }],
    run: 'auto',
    risk: [],
    size: 'S',
    body: '同一流水号回调多次只生效一次。',
    ...overrides,
  }
}

export function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'T3',
    batch: 'B1',
    status: 'running',
    tdd: 'none',
    evidenceIds: [],
    reviewIds: [],
    ...overrides,
  }
}
