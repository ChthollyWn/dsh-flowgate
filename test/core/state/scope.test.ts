import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROTECTED_PATHS,
  allowedWriteSet,
  isAllowedWrite,
  isAllowedWriteForAction,
  isArtifactWritableInStage,
  isDeliveryWritable,
  isProtectedPath,
  matchesProtectedPattern,
} from '../../../src/core/state/scope'
import { lockChange } from '../../../src/core/state/transitions'
import { AT, makeChange, makeConfig, makeTask } from './fixtures'

describe('state/scope — 受保护路径（FR-4.6）', () => {
  const config = makeConfig()

  it('protects plugin-owned state, config, ledger and git internals', () => {
    const protectedPaths = [
      '.flowgate/state/ledger.jsonl',
      '.flowgate/state/evidence/E-1.log',
      '.flowgate/changes/index.md',
      '.flowgate/changes/C-001/status.json',
      '.flowgate/changes/C-001/execution-plan.md',
      '.flowgate/changes/C-001/handoff.md',
      '.flowgate/changes/C-001/review.md',
      '.flowgate/changes/C-001/report.html',
      '.flowgate/changes/C-001/analysis.md',
      '.flowgate/config.yaml',
      '.flowgate/project.md',
      '.flowgate/specs/member/spec.md',
      '.flowgate/rules/R1.md',
      '.flowgate/dashboard.html',
      '.git/config',
      '.git',
    ]
    for (const path of protectedPaths) {
      const verdict = isProtectedPath(path, config)
      expect(verdict.protected, path).toBe(true)
      expect(verdict.reason, path).toBeTruthy()
    }
  })

  it('protects key files but not their example templates', () => {
    for (const path of ['.env', '.env.local', 'config/id_rsa', 'certs/server.pem', 'keys/app.key', '.npmrc']) {
      expect(isProtectedPath(path, config).protected, path).toBe(true)
    }
    for (const path of ['.env.example', '.env.sample', 'src/main/java/A.java', 'package.json', 'docs/.env.template']) {
      expect(isProtectedPath(path, config).protected, path).toBe(false)
    }
  })

  it('honours config.triggers.protected_paths including the {change} placeholder', () => {
    const custom = makeConfig({
      triggers: {
        ...config.triggers,
        protected_paths: ['secrets/**', '.flowgate/changes/{change}/frozen/**'],
      },
    })
    expect(isProtectedPath('secrets/token.txt', custom).protected).toBe(true)
    expect(isProtectedPath('.flowgate/changes/C-777/frozen/a.json', custom).protected).toBe(true)
    expect(isProtectedPath('src/app.ts', custom).protected).toBe(false)
  })

  it('agent-writable artifacts are not in the built-in protected list', () => {
    expect(matchesProtectedPattern('.flowgate/changes/C-001/clarify.md')).toBe(false)
    expect(matchesProtectedPattern('.flowgate/changes/C-001/tasks.md')).toBe(false)
    expect(BUILTIN_PROTECTED_PATHS.length).toBeGreaterThan(10)
  })
})

describe('state/scope — 阶段产物写入（FR-4.1）', () => {
  it('S1 allows clarify/proposal/incremental spec of the current change only', () => {
    const change = makeChange({ stage: 'S1' })
    expect(isArtifactWritableInStage(change, '.flowgate/changes/C-001/clarify.md')).toBe(true)
    expect(isArtifactWritableInStage(change, '.flowgate/changes/C-001/proposal.md')).toBe(true)
    expect(
      isArtifactWritableInStage(change, '.flowgate/changes/C-001/specs/member-renewal/spec.md'),
    ).toBe(true)
    expect(isArtifactWritableInStage(change, '.flowgate/changes/C-001/design.md')).toBe(false)
    expect(isArtifactWritableInStage(change, '.flowgate/changes/C-002/clarify.md')).toBe(false)
    expect(isArtifactWritableInStage(change, 'src/main/java/A.java')).toBe(false)
    expect(isArtifactWritableInStage(change, '.flowgate/config.yaml')).toBe(false)
  })

  it('S2 only allows context.md, S3 only design/risk/tasks', () => {
    const s2 = makeChange({ stage: 'S2' })
    expect(isArtifactWritableInStage(s2, '.flowgate/changes/C-001/context.md')).toBe(true)
    expect(isArtifactWritableInStage(s2, '.flowgate/changes/C-001/clarify.md')).toBe(false)

    const s3 = makeChange({ stage: 'S3' })
    expect(isArtifactWritableInStage(s3, '.flowgate/changes/C-001/design.md')).toBe(true)
    expect(isArtifactWritableInStage(s3, '.flowgate/changes/C-001/risk.md')).toBe(true)
    expect(isArtifactWritableInStage(s3, '.flowgate/changes/C-001/tasks.md')).toBe(true)
    expect(isArtifactWritableInStage(s3, '.flowgate/changes/C-001/context.md')).toBe(false)
  })

  it('S0 and S4-S6 have no agent-writable artifacts; archived/locked deny everything', () => {
    for (const stage of ['S0', 'S4', 'S5', 'S6', 'archived'] as const) {
      const change = makeChange({ stage })
      expect(isArtifactWritableInStage(change, '.flowgate/changes/C-001/tasks.md'), stage).toBe(false)
    }
    const locked = lockChange(makeChange({ stage: 'S1' }), 'tamper', AT)
    expect(isArtifactWritableInStage(locked, '.flowgate/changes/C-001/clarify.md')).toBe(false)
  })

  it('roadmap stage allows the project-level clarify and roadmap artifacts', () => {
    const project = makeChange({ stage: 'roadmap', id: 'PROJECT' })
    expect(isArtifactWritableInStage(project, '.flowgate/project-clarify.md')).toBe(true)
    expect(isArtifactWritableInStage(project, '.flowgate/roadmap.md')).toBe(true)
    expect(isArtifactWritableInStage(project, '.flowgate/project.md')).toBe(false)
    expect(isArtifactWritableInStage(project, 'src/main/java/A.java')).toBe(false)
  })
})

describe('state/scope — 允许写入集合', () => {
  it('returns empty set without an active task', () => {
    expect(allowedWriteSet(null, makeChange())).toEqual({ scope: [], tests: [], newFiles: [], changes: [] })
  })

  it('normalises, dedupes and sorts the task scope, and adds approved scope additions', () => {
    const task = makeTask({
      scope: ['src/main/java/com/acme/renewal/**', './src/main/java/com/acme/renewal/**', 'src/shared/Util.java'],
      changes: [
        { path: './src/legacy/Old.java', kind: 'delete' },
        { path: 'src/legacy/Move.java', kind: 'rename', to: './src/new/Moved.java' },
      ],
    })
    const change = makeChange({ scopeAdditions: { T3: ['src/extra/**'] } })
    const set = allowedWriteSet(task, change)
    expect(set.scope).toEqual([
      'src/extra/**',
      'src/main/java/com/acme/renewal/**',
      'src/shared/Util.java',
    ])
    expect(set.changes).toEqual([
      { path: 'src/legacy/Old.java', kind: 'delete' },
      { path: 'src/legacy/Move.java', kind: 'rename', to: 'src/new/Moved.java' },
    ])
  })

  it('classifies allowed writes by scope / tests / new files / declared changes', () => {
    const task = makeTask({
      newFiles: ['src/main/java/com/acme/renewal/Guard.java'],
      changes: [
        { path: 'src/old/A.java', kind: 'delete' },
        { path: 'src/old/B.java', kind: 'rename', to: 'src/new/B.java' },
      ],
    })
    const change = makeChange()
    expect(isAllowedWrite(task, change, 'src/main/java/com/acme/renewal/RenewalService.java')).toEqual({
      allowed: true,
      reason: 'scope',
    })
    expect(isAllowedWrite(task, change, 'src/test/java/com/acme/renewal/RenewalServiceTest.java')).toEqual({
      allowed: true,
      reason: 'tests',
    })
    expect(isAllowedWrite(task, change, 'src/main/java/com/acme/renewal/Guard.java')).toEqual({
      allowed: true,
      reason: 'new-file',
    })
    expect(isAllowedWrite(task, change, 'src/old/A.java')).toEqual({ allowed: true, reason: 'declared-change' })
    expect(isAllowedWrite(task, change, 'src/new/B.java')).toEqual({ allowed: true, reason: 'declared-change' })
    const denied = isAllowedWrite(task, change, 'src/other/Unrelated.java')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('outside-scope')
    expect(denied.hint).toContain('flow_request_scope_change')
  })

  it('reports the missing active task in the hint', () => {
    const verdict = isAllowedWrite(null, makeChange(), 'src/a.ts')
    expect(verdict.allowed).toBe(false)
    expect(verdict.hint).toContain('flow_task_start')
  })
})

describe('state/scope — action-aware checks（删除声明、新文件控制）', () => {
  const task = makeTask({
    scope: ['src/main/java/com/acme/renewal/**'],
    newFiles: ['src/main/java/com/acme/renewal/Guard.java'],
    changes: [
      { path: 'src/old/A.java', kind: 'delete' },
      { path: 'src/old/B.java', kind: 'rename', to: 'src/main/java/com/acme/renewal/B.java' },
    ],
  })
  const change = makeChange()

  it('creation must be declared in new_files or as a rename destination', () => {
    expect(
      isAllowedWriteForAction(task, change, 'src/main/java/com/acme/renewal/Guard.java', 'create'),
    ).toEqual({ allowed: true, reason: 'new-file' })
    expect(
      isAllowedWriteForAction(task, change, 'src/main/java/com/acme/renewal/B.java', 'create'),
    ).toEqual({ allowed: true, reason: 'declared-change' })
    const undeclared = isAllowedWriteForAction(
      task,
      change,
      'src/main/java/com/acme/renewal/Extra.java',
      'create',
    )
    expect(undeclared.allowed).toBe(false)
    expect(undeclared.reason).toBe('undeclared-new-file')
    expect(undeclared.hint).toContain('new_files')
  })

  it('a creation outside the task scope is outside-scope, not undeclared-new-file', () => {
    const verdict = isAllowedWriteForAction(task, change, 'src/other/New.java', 'create')
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe('outside-scope')
  })

  it('delete/rename must be declared in task.changes', () => {
    expect(isAllowedWriteForAction(task, change, 'src/old/A.java', 'delete')).toEqual({
      allowed: true,
      reason: 'declared-change',
    })
    expect(isAllowedWriteForAction(task, change, 'src/old/B.java', 'rename')).toEqual({
      allowed: true,
      reason: 'declared-change',
    })
    expect(
      isAllowedWriteForAction(task, change, 'src/main/java/com/acme/renewal/Impl.java', 'delete'),
    ).toMatchObject({ allowed: false, reason: 'outside-scope' })
    const undeclared = isAllowedWriteForAction(task, change, 'src/old/C.java', 'rename')
    expect(undeclared.allowed).toBe(false)
    expect(undeclared.hint).toContain('changes')
  })

  it('plain writes fall back to the path-level check', () => {
    expect(
      isAllowedWriteForAction(task, change, 'src/main/java/com/acme/renewal/Impl.java', 'write'),
    ).toEqual({ allowed: true, reason: 'scope' })
    expect(isAllowedWriteForAction(task, change, 'src/other/X.java', 'write')).toMatchObject({
      allowed: false,
      reason: 'outside-scope',
    })
    expect(isAllowedWriteForAction(null, change, 'src/a.ts', 'write')).toMatchObject({
      allowed: false,
    })
  })
})

describe('state/scope — 交付物', () => {
  it('S6 only allows delivery artifacts', () => {
    expect(isDeliveryWritable('CHANGELOG.md')).toBe(true)
    expect(isDeliveryWritable('docs/release.md')).toBe(true)
    expect(isDeliveryWritable('README.md')).toBe(true)
    expect(isDeliveryWritable('src/main/java/A.java')).toBe(false)
    expect(isDeliveryWritable('package.json')).toBe(false)
  })
})
