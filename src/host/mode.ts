/**
 * 运行模式解析（P0-4 / P1-7）：safe-mode、自举检测、接管模式生效值。
 *
 * 设计目标：把"插件当前应该拦不拦"从安装顺序里解耦出来，变成可解释、可审计的
 * 纯函数（/flow doctor 逐项展示），并保证三种退化路径都有逃生口：
 *
 * 1. **safe-mode（P0-4）**：插件自身出问题时，负责人不需要卸载插件——写一个
 *    sentinel 文件或设 `FLOWGATE_SAFE=1`，宿主下次启动即强制 `takeover='off'`
 *    并跳过 guard/delegation/dispatch/gates 安装。候选（优先级从高到低）：
 *      - `~/.dsh/flowgate/safe-mode`
 *      - `<项目根>/.flowgate/safe-mode`
 *      - 环境变量 `FLOWGATE_SAFE=1`
 *      - 插件配置 `safeMode: true`
 * 2. **自举观察（P1-7）**：如果项目根就是 dsh-flowgate 自己（package.json
 *    name=dsh-flowgate 且有 dsh 清单字段），默认 `observe`（只记录不拦截），
 *    避免开发插件时被自己拦死；显式 config.takeover 可覆盖。
 * 3. 其余默认 `enforce`。
 *
 * 判定用 node:fs 直接读文件（host 层允许 Node API）；不做任何写操作。
 */
import { existsSync, readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { HostConfig, HostDeps, SafeModeInfo, TakeoverMode } from './types.js'

/** safe-mode 环境变量（值为 1/true 视为开启）。 */
export const SAFE_MODE_ENV = 'FLOWGATE_SAFE'

/** safe-mode sentinel 文件名。 */
export const SAFE_MODE_SENTINEL = 'safe-mode'

/** sentinel 内容最多读这么多字符作为原因（避免把大文件读进投影/日志）。 */
const SAFE_MODE_REASON_LIMIT = 500

export interface ResolveSafeModeInput {
  deps: Pick<HostDeps, 'homeDir'>
  config: HostConfig
  /** 项目根（未知时不检查项目级 sentinel）。 */
  root?: string | null
}

/**
 * 用户级 safe-mode sentinel 路径。必须与 `scripts/host-recover.mjs` 及
 * `DSH_HOME` 口径一致：
 * - `DSH_HOME` 已设置 → `${DSH_HOME}/flowgate/safe-mode`；
 * - 未设置/空 → `~/.dsh/flowgate/safe-mode`（DSH 默认 home）。
 * 否则负责人按文档写 sentinel 但插件读不到（真机踩坑：写了不生效）。
 */
export function userSafeModeSentinel(deps: Pick<HostDeps, 'homeDir'>): string | null {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    const dshHome = env?.DSH_HOME?.trim()
    if (dshHome !== undefined && dshHome !== '') return nodePath.join(dshHome, 'flowgate', SAFE_MODE_SENTINEL)
    return nodePath.join(deps.homeDir(), '.dsh', 'flowgate', SAFE_MODE_SENTINEL)
  } catch {
    return null
  }
}

/** safe-mode sentinel 候选路径（用户级优先于项目根；doctor 展示实际读取的路径）。 */
export function safeModeCandidates(input: Pick<ResolveSafeModeInput, 'deps' | 'root'>): string[] {
  const candidates: string[] = []
  const userLevel = userSafeModeSentinel(input.deps)
  if (userLevel !== null) candidates.push(userLevel)
  if (input.root) candidates.push(nodePath.join(input.root, '.flowgate', SAFE_MODE_SENTINEL))
  return candidates
}

function envFlag(name: string): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    const value = env?.[name]
    return value === '1' || value === 'true'
  } catch {
    return false
  }
}

/** sentinel 文件内容 → 人类可读原因（最多 500 字，失败给默认说明）。 */
function sentinelReason(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim()
    if (text !== '') return text.slice(0, SAFE_MODE_REASON_LIMIT)
  } catch {
    // 读不到内容不影响"存在即 active"的判定。
  }
  return `检测到 safe-mode 文件：${path}`
}

/**
 * 解析 safe-mode（存在任一候选即 active）。
 *
 * 优先级：sentinel 文件（home → 项目根）> 环境变量 > 插件配置。
 * 返回 source/path 供 doctor 展示与人工清除。
 */
export function resolveSafeMode(input: ResolveSafeModeInput): SafeModeInfo {
  for (const path of safeModeCandidates(input)) {
    try {
      if (existsSync(path)) {
        return { active: true, source: 'sentinel', path, reason: sentinelReason(path) }
      }
    } catch {
      // 文件系统异常时视为不存在（safe-mode 是增强，不是硬依赖）。
    }
  }
  if (envFlag(SAFE_MODE_ENV)) {
    return { active: true, source: 'env', reason: `环境变量 ${SAFE_MODE_ENV}=1` }
  }
  if (input.config.safeMode === true) {
    return { active: true, source: 'config', reason: '插件配置 safeMode=true' }
  }
  return { active: false }
}

/** 自举检测缓存：项目根 → 是否 dsh-flowgate 自身。失败也缓存（避免重复 IO）。 */
const selfHostCache = new Map<string, boolean>()

/** 测试用：清空自举检测缓存。 */
export function resetSelfHostCacheForTest(): void {
  selfHostCache.clear()
}

/**
 * 检测"是否在 flowgate 仓库里自举"：读项目根 package.json，
 * `name === 'dsh-flowgate'` 且含 dsh 清单字段即 true；任何失败 false。
 */
export function detectSelfHost(root: string | null | undefined): boolean {
  if (!root) return false
  const key = nodePath.resolve(root)
  const cached = selfHostCache.get(key)
  if (cached !== undefined) return cached
  let result = false
  try {
    const raw = readFileSync(nodePath.join(key, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown; dsh?: unknown }
    result = parsed.name === 'dsh-flowgate' && parsed.dsh !== undefined && parsed.dsh !== null
  } catch {
    result = false
  }
  selfHostCache.set(key, result)
  return result
}

export interface EffectiveTakeoverState {
  selfHost: boolean
  safe: boolean
}

/**
 * 计算生效接管模式：
 * safe → 'off'；config.takeover 显式优先；自举 → 'observe'；否则 'enforce'。
 */
export function effectiveTakeover(config: HostConfig, state: EffectiveTakeoverState): TakeoverMode {
  if (state.safe) return 'off'
  const explicit = config.takeover
  if (explicit === 'enforce' || explicit === 'observe' || explicit === 'off') return explicit
  if (state.selfHost) return 'observe'
  return 'enforce'
}

/** 生效原因（doctor 展示；与 effectiveTakeover 的分支一一对应）。 */
export function takeoverReason(
  config: HostConfig,
  state: EffectiveTakeoverState & { safeMode?: SafeModeInfo },
): string {
  if (state.safe) {
    const info = state.safeMode
    const detail = info?.source === 'sentinel' ? `sentinel ${info.path}` : info?.reason
    return `safe-mode 强制 off${detail ? `（${detail}）` : ''}`
  }
  const explicit = config.takeover
  if (explicit === 'enforce' || explicit === 'observe' || explicit === 'off') {
    return `插件配置 takeover=${explicit}`
  }
  if (state.selfHost) return '自举检测：项目根 package.json 是 dsh-flowgate 自身，默认只观察不拦截'
  return '默认强制接管（未配置覆盖、非自举、非 safe-mode）'
}
