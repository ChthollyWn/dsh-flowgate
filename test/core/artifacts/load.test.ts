import { describe, expect, it } from 'vitest'
import {
  CHANGE_ARTIFACTS,
  artifactHashes,
  changePaths,
  loadArtifacts,
  loadProjectClarifyRaw,
  loadProjectDoc,
  loadRoadmap,
} from '../../../src/core/artifacts/load'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import { sha256 } from '../../../src/core/util/hash'
import { CLARIFY_MD, PROJECT_MD, ROADMAP_MD, SPEC_MD, TASKS_MD } from '../../fixtures/artifacts/helpers'

function changeFileMap(): Record<string, string> {
  return {
    '.flowgate/changes/C-001/clarify.md': CLARIFY_MD,
    '.flowgate/changes/C-001/proposal.md': '# 提案\n\n## 为什么\n\n需要续费\n\n## 不做\n\n- 不做退款',
    '.flowgate/changes/C-001/specs/spec.md': SPEC_MD,
    '.flowgate/changes/C-001/context.md': '## 接口约束\n\n- POST /renew',
    '.flowgate/changes/C-001/design.md': '## 方案 A\n\n- 优点：简单\n\n## 推荐\n\n选 A',
    '.flowgate/changes/C-001/risk.md': '| 类别 | 等级 | 理由 | 缓解措施 | 验证方式 | 需人工接管 |\n|---|---|---|---|---|---|\n| 安全 | 低 | 无 | — | — | 否 |',
    '.flowgate/changes/C-001/tasks.md': TASKS_MD,
    '.flowgate/project.md': PROJECT_MD,
    '.flowgate/roadmap.md': ROADMAP_MD,
    '.flowgate/project-clarify.md': '# 项目级澄清\n\n## 目标\n\n会员系统',
  }
}

describe('changePaths', () => {
  it('root 为空时返回 repo 相对路径（与 store/layout 约定一致）', () => {
    const paths = changePaths('', 'C-001')
    expect(paths.dir).toBe('.flowgate/changes/C-001')
    expect(paths.clarify).toBe('.flowgate/changes/C-001/clarify.md')
    expect(paths.spec).toBe('.flowgate/changes/C-001/specs/spec.md')
    expect(paths.executionPlan).toBe('.flowgate/changes/C-001/execution-plan.md')
    expect(paths.status).toBe('.flowgate/changes/C-001/status.json')
  })

  it('root 非空时加上项目根前缀', () => {
    const paths = changePaths('/repo', 'C-002')
    expect(paths.dir).toBe('/repo/.flowgate/changes/C-002')
    expect(paths.tasks).toBe('/repo/.flowgate/changes/C-002/tasks.md')
  })
})

describe('loadArtifacts', () => {
  it('加载并解析全部产物，raw 保留文件原文', async () => {
    const fs = new MemoryFileSystem(changeFileMap())
    const bundle = await loadArtifacts(fs, '', 'C-001')
    expect(Object.keys(bundle).sort()).toEqual([...CHANGE_ARTIFACTS].sort())
    expect(bundle.clarify!.raw).toBe(CLARIFY_MD)
    expect(bundle.spec!.raw).toBe(SPEC_MD)
    expect(bundle.spec!.requirements).toHaveLength(1)
    expect(bundle.tasks!.tasks).toHaveLength(4)
    expect(bundle.tasks!.execution.batches).toHaveLength(2)
    expect(bundle.design!.options).toHaveLength(1)
    expect(bundle.risk!.entries).toHaveLength(1)
  })

  it('缺文件返回 undefined 而不是抛错', async () => {
    const fs = new MemoryFileSystem({ '.flowgate/changes/C-001/clarify.md': CLARIFY_MD })
    const bundle = await loadArtifacts(fs, '', 'C-001')
    expect(bundle.clarify).toBeDefined()
    expect(bundle.proposal).toBeUndefined()
    expect(bundle.spec).toBeUndefined()
    expect(bundle.tasks).toBeUndefined()
  })

  it('损坏的内容解析为空结构而不是抛错', async () => {
    const fs = new MemoryFileSystem({
      '.flowgate/changes/C-001/tasks.md': '这不是任务卡',
      '.flowgate/changes/C-001/specs/spec.md': '既没有 ADDED 也没有场景',
    })
    const bundle = await loadArtifacts(fs, '', 'C-001')
    expect(bundle.tasks!.tasks).toEqual([])
    expect(bundle.spec!.requirements).toEqual([])
    expect(bundle.tasks!.raw).toBe('这不是任务卡')
  })

  it('root 前缀生效', async () => {
    const seed: Record<string, string> = {}
    for (const [path, content] of Object.entries(changeFileMap())) seed[`repo/${path}`] = content
    const fs = new MemoryFileSystem(seed)
    const bundle = await loadArtifacts(fs, 'repo', 'C-001')
    expect(bundle.clarify).toBeDefined()
  })
})

describe('loadProjectDoc / loadRoadmap / loadProjectClarifyRaw', () => {
  it('加载项目级产物', async () => {
    const fs = new MemoryFileSystem(changeFileMap())
    const project = await loadProjectDoc(fs, '')
    expect(project?.name).toBe('会员续费示例')
    expect(project?.commands.test).toBe('pnpm test')
    const roadmap = await loadRoadmap(fs, '')
    expect(roadmap?.entries).toHaveLength(3)
    const raw = await loadProjectClarifyRaw(fs, '')
    expect(raw).toContain('项目级澄清')
  })

  it('缺文件返回 null', async () => {
    const fs = new MemoryFileSystem({})
    expect(await loadProjectDoc(fs, '')).toBeNull()
    expect(await loadRoadmap(fs, '')).toBeNull()
    expect(await loadProjectClarifyRaw(fs, '')).toBeNull()
  })
})

describe('artifactHashes', () => {
  it('key 用 ArtifactName、值为 sha256(raw)', async () => {
    const fs = new MemoryFileSystem(changeFileMap())
    const bundle = await loadArtifacts(fs, '', 'C-001')
    const hashes = artifactHashes(bundle)
    expect(Object.keys(hashes).sort()).toEqual([...CHANGE_ARTIFACTS].sort())
    expect(hashes.clarify).toBe(sha256(CLARIFY_MD))
    expect(hashes.clarify!.startsWith('sha256:')).toBe(true)
  })

  it('空 bundle 返回空对象', () => {
    expect(artifactHashes({})).toEqual({})
  })
})
