/**
 * 契约冻结（FR-14.10 / 03 §9.8）与产物防篡改校验。
 *
 * - 创建变更时把「当时生效的规则、等级定义、技能版本、插件版本」冻结进
 *   `status.json` 的 `contract`；之后改配置或升级插件只影响新变更。
 * - 人工门通过后把产物内容哈希冻结进 `change.frozen`（key 为 ArtifactBundle
 *   的键名），agent 之后改产物由守卫拦截，`assertArtifactsUnmodified` 用于
 *   门禁/交付时复核。
 */
import type { FileSystem } from '../util/fs'
import type { ArtifactBundle, ChangeStatus, ContractSnapshot, FlowgateConfig } from '../types'
import { sha256, stableJson } from '../util/hash'
import { changePaths, findIncrementalSpec, layout } from './layout'

/** 冻结契约：插件版本 + 规则/触发器哈希 + 等级定义哈希 + 技能版本。 */
export function freezeContract(
  config: FlowgateConfig,
  pluginVersion: string,
  skills: Record<string, string>,
  at: string,
): ContractSnapshot {
  const skillHashes: Record<string, string> = {}
  for (const key of Object.keys(skills).sort()) {
    const value = skills[key]
    if (typeof value === 'string') skillHashes[key] = value
  }
  return {
    plugin: pluginVersion,
    // 规则与触发器共同决定判定结果，因此都计入契约哈希。
    rules: sha256(stableJson({ rules: config.rules, triggers: config.triggers })),
    // 等级定义：复杂度/风险设置 + 各类数量与预算限制。
    levels: sha256(stableJson({ levels: config.levels, limits: config.limits })),
    skills: skillHashes,
    createdAt: at,
  }
}

/**
 * 产物指纹：key 为 ArtifactBundle 的键名（clarify/proposal/spec/...），
 * 值为该产物**原文**（artifact.raw）的 sha256。只包含实际存在的产物。
 */
export function artifactsFingerprint(bundle: ArtifactBundle): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(bundle).sort()) {
    const artifact = bundle[name as keyof ArtifactBundle]
    if (!artifact || typeof artifact !== 'object') continue
    const raw = (artifact as { raw?: unknown }).raw
    if (typeof raw === 'string') out[name] = sha256(raw)
  }
  return out
}

/** 冻结 key（artifact 名或文件名）→ 仓库相对路径。 */
async function resolveArtifactPath(
  fs: FileSystem,
  root: string,
  changeId: string,
  key: string,
): Promise<string | null> {
  const paths = changePaths(root, changeId)
  const base = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
  const name = base.replace(/\.md$/i, '')
  switch (name) {
    case 'clarify':
      return paths.clarify
    case 'proposal':
      return paths.proposal
    case 'spec':
      return (await findIncrementalSpec(fs, root, changeId)) ?? paths.spec
    case 'context':
      return paths.context
    case 'design':
      return paths.design
    case 'risk':
      return paths.risk
    case 'tasks':
      return paths.tasks
    case 'project':
      return layout(root).projectDoc
    default:
      return null
  }
}

/**
 * 对比 `change.frozen` 与实际产物内容；返回内容已变或文件已删除的 key。
 * 只有产物原文哈希一致才算未修改（缺失文件按被修改处理）。
 */
export async function assertArtifactsUnmodified(
  fs: FileSystem,
  root: string,
  change: ChangeStatus,
): Promise<{ modified: string[] }> {
  const frozen = change.frozen ?? {}
  const modified: string[] = []
  for (const [key, entry] of Object.entries(frozen)) {
    const path = await resolveArtifactPath(fs, root, change.id, key)
    if (!path || !(await fs.exists(path))) {
      modified.push(key)
      continue
    }
    try {
      const raw = await fs.readFile(path)
      if (sha256(raw) !== entry.hash) modified.push(key)
    } catch {
      modified.push(key)
    }
  }
  return { modified: modified.sort() }
}

/** 从仓库相对路径推断产物 key（冻结 key 归一化：文件名去扩展名）。 */
export function artifactKeyForPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const changeArtifact = /(?:^|\/)\.flowgate\/changes\/[^/]+\/(.+)$/.exec(normalized)
  const projectArtifact = /(?:^|\/)\.flowgate\/(project\.md|project-clarify\.md|roadmap\.md)$/.exec(normalized)
  const relative = changeArtifact?.[1] ?? projectArtifact?.[1]
  if (!relative) return null
  const base = relative.slice(relative.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  if (base === 'project') return 'project'
  if (base === 'project-clarify') return 'project-clarify'
  return base
}

/**
 * 守卫用：判断 agent 要写的路径是否属于已冻结产物。冻结后不许直接改，
 * 需走返工/新变更（提示文案给出解锁方式）。
 */
export function assertNotFrozen(change: ChangeStatus, path: string): { frozen: boolean; hint?: string } {
  const frozen = change.frozen ?? {}
  const key = artifactKeyForPath(path)
  if (!key || !frozen[key]) return { frozen: false }
  const at = frozen[key]!.at
  return {
    frozen: true,
    hint: `「${key}」已在 ${at} 冻结：这是本次变更已批准的产物，不能直接修改。确需变更请走返工流程（声明返工类型）或新建变更。`,
  }
}
