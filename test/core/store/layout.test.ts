import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import {
  DEFAULT_CONFIG,
  LEDGER_KEY_PATH,
  changePaths,
  findIncrementalSpec,
  isInitialized,
  layout,
  parseConfig,
  renderFlowgateGitignore,
  scaffold,
} from '../../../src/core/store'

describe('store layout', () => {
  it('layout("") 生成 03 §9.1 规定的全部路径', () => {
    const l = layout('')
    expect(l.root).toBe('')
    expect(l.dir).toBe('.flowgate')
    expect(l.config).toBe('.flowgate/config.yaml')
    expect(l.projectDoc).toBe('.flowgate/project.md')
    expect(l.roadmap).toBe('.flowgate/roadmap.md')
    expect(l.changesIndex).toBe('.flowgate/changes/index.md')
    expect(l.changesDir).toBe('.flowgate/changes')
    expect(l.archiveDir).toBe('.flowgate/archive')
    expect(l.specsDir).toBe('.flowgate/specs')
    expect(l.rulesDir).toBe('.flowgate/rules')
    expect(l.stateDir).toBe('.flowgate/state')
    expect(l.ledger).toBe('.flowgate/state/ledger.jsonl')
    expect(l.sessions).toBe('.flowgate/state/sessions.json')
    expect(l.snapshotsDir).toBe('.flowgate/state/snapshots')
    expect(l.evidenceDir).toBe('.flowgate/state/evidence')
    expect(l.worktreesDir).toBe('.flowgate/worktrees')
    expect(l.metricsDir).toBe('.flowgate/metrics')
    expect(l.retro).toBe('.flowgate/retro.md')
    expect(l.dashboard).toBe('.flowgate/dashboard.html')
    expect(l.keyPath).toBe('~/.dsh/flowgate/ledger.key')
    expect(LEDGER_KEY_PATH).toBe('~/.dsh/flowgate/ledger.key')
  })

  it('layout(root) 把 root 作为前缀，路径仍是正斜杠相对/绝对形式', () => {
    const l = layout('/repo')
    expect(l.root).toBe('/repo')
    expect(l.dir).toBe('/repo/.flowgate')
    expect(l.ledger).toBe('/repo/.flowgate/state/ledger.jsonl')
    expect(layout('/repo/').dir).toBe('/repo/.flowgate')
    expect(layout('.').dir).toBe('.flowgate')
  })

  it('changePaths 生成单个变更的全部产物路径', () => {
    const paths = changePaths('', 'C-003')
    expect(paths).toEqual({
      dir: '.flowgate/changes/C-003',
      clarify: '.flowgate/changes/C-003/clarify.md',
      proposal: '.flowgate/changes/C-003/proposal.md',
      spec: '.flowgate/changes/C-003/specs/spec.md',
      specsDir: '.flowgate/changes/C-003/specs',
      context: '.flowgate/changes/C-003/context.md',
      design: '.flowgate/changes/C-003/design.md',
      risk: '.flowgate/changes/C-003/risk.md',
      tasks: '.flowgate/changes/C-003/tasks.md',
      analysis: '.flowgate/changes/C-003/analysis.md',
      executionPlan: '.flowgate/changes/C-003/execution-plan.md',
      status: '.flowgate/changes/C-003/status.json',
      handoff: '.flowgate/changes/C-003/handoff.md',
      evidence: '.flowgate/changes/C-003/evidence.md',
      review: '.flowgate/changes/C-003/review.md',
      report: '.flowgate/changes/C-003/report.html',
    })
    expect(changePaths('/repo', 'A-002').dir).toBe('/repo/.flowgate/changes/A-002')
  })

  it('changePaths 拒绝带斜杠的非法编号', () => {
    expect(() => changePaths('', '../etc/passwd')).toThrow()
    expect(() => changePaths('', '')).toThrow()
  })

  it('findIncrementalSpec 优先单文件，其次按字典序取能力目录', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/changes/C-001/specs/spec.md': '# 单文件规格',
      '.flowgate/changes/C-002/specs/payment/spec.md': '# 支付',
      '.flowgate/changes/C-002/specs/auth/spec.md': '# 鉴权',
    })
    await expect(findIncrementalSpec(fs, '', 'C-001')).resolves.toBe('.flowgate/changes/C-001/specs/spec.md')
    await expect(findIncrementalSpec(fs, '', 'C-002')).resolves.toBe('.flowgate/changes/C-002/specs/auth/spec.md')
    await expect(findIncrementalSpec(fs, '', 'C-003')).resolves.toBeNull()
  })

  it('目录内 .gitignore：默认整目录忽略；提交模式只排除运行态', () => {
    expect(renderFlowgateGitignore(false)).toBe('*\n')
    const committing = renderFlowgateGitignore(true)
    expect(committing.split('\n').filter(Boolean)).toEqual(['state/', 'worktrees/', 'dashboard.html'])
  })

  it('isInitialized 以 config.yaml 是否存在为准', async () => {
    const fs = new MemoryFileSystem()
    await expect(isInitialized(fs, '')).resolves.toBe(false)
    await fs.writeFile('.flowgate/config.yaml', 'levels: {}')
    await expect(isInitialized(fs, '')).resolves.toBe(true)
  })
})

describe('store scaffold', () => {
  it('生成目录、README、目录内 .gitignore 与默认 config.yaml，且不动项目根 .gitignore', async () => {
    const fs = new MemoryFileSystem({ '.gitignore': 'node_modules/\n' })
    await scaffold(fs, '')
    for (const dir of [
      '.flowgate',
      '.flowgate/changes',
      '.flowgate/archive',
      '.flowgate/specs',
      '.flowgate/rules',
      '.flowgate/state/snapshots',
      '.flowgate/state/evidence',
      '.flowgate/worktrees',
      '.flowgate/metrics',
    ]) {
      await expect(fs.exists(dir)).resolves.toBe(true)
    }
    const readme = await fs.readFile('.flowgate/README.md')
    expect(readme).toContain('FlowGate')
    expect(readme).toContain('ledger.jsonl')
    await expect(fs.readFile('.flowgate/.gitignore')).resolves.toBe('*\n')
    // 项目根 .gitignore 不许被修改。
    await expect(fs.readFile('.gitignore')).resolves.toBe('node_modules/\n')
    // 默认配置文件可被解析，且等于 DEFAULT_CONFIG。
    const raw = await fs.readFile('.flowgate/config.yaml')
    expect(raw).toContain('levels:')
    expect(parseConfig(raw)).toEqual(DEFAULT_CONFIG)
  })

  it('已存在配置时保留用户配置，并按 commit_flowgate 刷新 .gitignore', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/config.yaml': 'git:\n  commit_flowgate: true\nlevels:\n  complexity: low\n',
    })
    await scaffold(fs, '')
    await expect(fs.readFile('.flowgate/.gitignore')).resolves.toBe(renderFlowgateGitignore(true))
    // 用户配置不被覆盖。
    const raw = await fs.readFile('.flowgate/config.yaml')
    expect(raw).toContain('commit_flowgate: true')
    expect(parseConfig(raw).levels.complexity).toBe('low')
  })

  it('配置损坏时 scaffold 退回默认提交策略，不抛错', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/config.yaml': 'levels: [broken' })
    await expect(scaffold(fs, '')).resolves.toBeUndefined()
    await expect(fs.readFile('.flowgate/.gitignore')).resolves.toBe('*\n')
  })

  it('重复 scaffold 幂等：不覆盖 README 与 config.yaml', async () => {
    const fs = new MemoryFileSystem()
    await scaffold(fs, '')
    await fs.writeFile('.flowgate/README.md', '# 自定义说明\n')
    const configBefore = await fs.readFile('.flowgate/config.yaml')
    await scaffold(fs, '')
    await expect(fs.readFile('.flowgate/README.md')).resolves.toBe('# 自定义说明\n')
    await expect(fs.readFile('.flowgate/config.yaml')).resolves.toBe(configBefore)
  })
})

describe('changePaths 路径安全', () => {
  it('拒绝 . / .. 与路径穿越编号', () => {
    expect(() => changePaths('', '..')).toThrow()
    expect(() => changePaths('', '.')).toThrow()
    expect(() => changePaths('', 'a/../../etc')).toThrow()
    expect(() => changePaths('', 'C-001/../C-002')).toThrow()
  })

  it('接受常见编号格式（C-001 / A-2 / C-1000）', () => {
    expect(changePaths('', 'C-001').dir).toBe('.flowgate/changes/C-001')
    expect(changePaths('', 'A-2').dir).toBe('.flowgate/changes/A-2')
    expect(changePaths('', 'C-1000').dir).toBe('.flowgate/changes/C-1000')
  })
})
