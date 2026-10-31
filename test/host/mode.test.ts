/**
 * P0-4 / P1-7：safe-mode / 自举检测 / 生效接管模式（纯函数，无宿主）。
 *
 * 逃生口优先级约定：
 * sentinel（用户级 ~/.dsh 或 DSH_HOME → 项目级 .flowgate）> FLOWGATE_SAFE=1 >
 * 插件配置 safeMode；safe-mode 生效时 enforcement 强制 off。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import {
  detectSelfHost,
  effectiveTakeover,
  resetSelfHostCacheForTest,
  resolveSafeMode,
  safeModeCandidates,
  SAFE_MODE_ENV,
  takeoverReason,
  userSafeModeSentinel,
} from '../../src/host/mode.js'

const tempDirs: string[] = []
const originalEnv: Record<string, string | undefined> = {}

function saveEnv(name: string): void {
  if (!(name in originalEnv)) originalEnv[name] = process.env[name]
}

function setEnv(name: string, value: string | undefined): void {
  saveEnv(name)
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function tempDir(prefix = 'flowgate-mode-'): Promise<string> {
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 最小 deps：只给 homeDir。 */
function fakeDeps(homeDir: string): { homeDir(): string } {
  return { homeDir: () => homeDir }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true })
  resetSelfHostCacheForTest()
  for (const [name, value] of Object.entries(originalEnv)) setEnv(name, value)
  for (const name of Object.keys(originalEnv)) delete originalEnv[name]
})

describe('resolveSafeMode：safe-mode sentinel / env / config', () => {
  it('默认未触发', async () => {
    const home = await tempDir('flowgate-mode-home-')
    expect(resolveSafeMode({ deps: fakeDeps(home), config: {} })).toEqual({ active: false })
  })

  it('用户级 sentinel（~/.dsh/flowgate/safe-mode）触发，内容作为 reason', async () => {
    const home = await tempDir('flowgate-mode-home-')
    setEnv('DSH_HOME', undefined)
    const sentinel = nodePath.join(home, '.dsh', 'flowgate', 'safe-mode')
    await fsp.mkdir(nodePath.dirname(sentinel), { recursive: true })
    await fsp.writeFile(sentinel, '负责人维护窗口：先停门禁\n')
    const info = resolveSafeMode({ deps: fakeDeps(home), config: {} })
    expect(info.active).toBe(true)
    expect(info.source).toBe('sentinel')
    expect(info.path).toBe(sentinel)
    expect(info.reason).toContain('负责人维护窗口')
  })

  it('honor DSH_HOME：DSH_HOME 设置时读 ${DSH_HOME}/flowgate/safe-mode', async () => {
    const home = await tempDir('flowgate-mode-home-')
    const dshHome = await tempDir('flowgate-mode-dshhome-')
    setEnv('DSH_HOME', dshHome)
    const sentinel = nodePath.join(dshHome, 'flowgate', 'safe-mode')
    await fsp.mkdir(nodePath.dirname(sentinel), { recursive: true })
    await fsp.writeFile(sentinel, 'DSH_HOME 演练')
    expect(userSafeModeSentinel(fakeDeps(home))).toBe(sentinel)
    const info = resolveSafeMode({ deps: fakeDeps(home), config: {} })
    expect(info.active).toBe(true)
    expect(info.path).toBe(sentinel)
    // 默认 home 下的同名文件此时不应被读取。
    const defaultSentinel = nodePath.join(home, '.dsh', 'flowgate', 'safe-mode')
    await fsp.mkdir(nodePath.dirname(defaultSentinel), { recursive: true })
    await fsp.writeFile(defaultSentinel, '默认 home')
    expect(resolveSafeMode({ deps: fakeDeps(home), config: {} }).path).toBe(sentinel)
  })

  it('DSH_HOME 为空串时回退默认 ~/.dsh 路径', async () => {
    const home = await tempDir('flowgate-mode-home-')
    setEnv('DSH_HOME', '   ')
    expect(userSafeModeSentinel(fakeDeps(home))).toBe(nodePath.join(home, '.dsh', 'flowgate', 'safe-mode'))
  })

  it('项目级 sentinel（<root>/.flowgate/safe-mode）触发；用户级优先', async () => {
    const home = await tempDir('flowgate-mode-home-')
    const root = await tempDir('flowgate-mode-root-')
    setEnv('DSH_HOME', undefined)
    const projectSentinel = nodePath.join(root, '.flowgate', 'safe-mode')
    await fsp.mkdir(nodePath.dirname(projectSentinel), { recursive: true })
    await fsp.writeFile(projectSentinel, '项目级恢复演练')
    const info = resolveSafeMode({ deps: fakeDeps(home), config: {}, root })
    expect(info.active).toBe(true)
    expect(info.path).toBe(projectSentinel)
    // 用户级存在时优先。
    const userSentinel = nodePath.join(home, '.dsh', 'flowgate', 'safe-mode')
    await fsp.mkdir(nodePath.dirname(userSentinel), { recursive: true })
    await fsp.writeFile(userSentinel, '用户级')
    expect(resolveSafeMode({ deps: fakeDeps(home), config: {}, root }).path).toBe(userSentinel)
  })

  it('FLOWGATE_SAFE=1 触发（source=env）', async () => {
    const home = await tempDir('flowgate-mode-home-')
    setEnv('DSH_HOME', undefined)
    setEnv(SAFE_MODE_ENV, '1')
    const info = resolveSafeMode({ deps: fakeDeps(home), config: {} })
    expect(info.active).toBe(true)
    expect(info.source).toBe('env')
    expect(info.reason).toContain('FLOWGATE_SAFE')
  })

  it('config.safeMode=true 触发（source=config）；false 不触发', async () => {
    const home = await tempDir('flowgate-mode-home-')
    setEnv('DSH_HOME', undefined)
    const info = resolveSafeMode({ deps: fakeDeps(home), config: { safeMode: true } })
    expect(info.active).toBe(true)
    expect(info.source).toBe('config')
    expect(resolveSafeMode({ deps: fakeDeps(home), config: { safeMode: false } }).active).toBe(false)
  })

  it('候选路径顺序：用户级 → 项目级', async () => {
    const home = await tempDir('flowgate-mode-home-')
    const root = await tempDir('flowgate-mode-root-')
    setEnv('DSH_HOME', undefined)
    expect(safeModeCandidates({ deps: fakeDeps(home), root })).toEqual([
      nodePath.join(home, '.dsh', 'flowgate', 'safe-mode'),
      nodePath.join(root, '.flowgate', 'safe-mode'),
    ])
  })
})

describe('detectSelfHost：自举仓库检测', () => {
  async function writePackage(dir: string, content: unknown): Promise<void> {
    await fsp.writeFile(nodePath.join(dir, 'package.json'), JSON.stringify(content))
  }

  it('name=dsh-flowgate 且含 dsh 清单字段 → true', async () => {
    const root = await tempDir('flowgate-selfhost-')
    await writePackage(root, { name: 'dsh-flowgate', version: '0.1.0', dsh: { manifestVersion: 1 } })
    expect(detectSelfHost(root)).toBe(true)
  })

  it('普通项目 / 缺 dsh 字段 / 非法 JSON / 不存在 → false', async () => {
    const demo = await tempDir('flowgate-selfhost-')
    await writePackage(demo, { name: 'demo', scripts: { test: 'vitest' } })
    expect(detectSelfHost(demo)).toBe(false)

    const missingManifest = await tempDir('flowgate-selfhost-')
    await writePackage(missingManifest, { name: 'dsh-flowgate' })
    expect(detectSelfHost(missingManifest)).toBe(false)

    const broken = await tempDir('flowgate-selfhost-')
    await fsp.writeFile(nodePath.join(broken, 'package.json'), 'not-json{')
    expect(detectSelfHost(broken)).toBe(false)

    expect(detectSelfHost(nodePath.join(broken, 'does-not-exist'))).toBe(false)
    expect(detectSelfHost(null)).toBe(false)
    expect(detectSelfHost(undefined)).toBe(false)
  })

  it('结果缓存（检测后改 package.json 不影响；reset 后重新读）', async () => {
    const root = await tempDir('flowgate-selfhost-')
    await writePackage(root, { name: 'dsh-flowgate', dsh: {} })
    expect(detectSelfHost(root)).toBe(true)
    await writePackage(root, { name: 'demo' })
    expect(detectSelfHost(root)).toBe(true)
    resetSelfHostCacheForTest()
    expect(detectSelfHost(root)).toBe(false)
  })
})

describe('effectiveTakeover：生效接管模式', () => {
  it('safe → off（无视显式配置）', () => {
    expect(effectiveTakeover({ takeover: 'enforce' }, { selfHost: true, safe: true })).toBe('off')
    expect(effectiveTakeover({}, { selfHost: false, safe: true })).toBe('off')
  })

  it('显式 config.takeover 优先于自举检测', () => {
    expect(effectiveTakeover({ takeover: 'enforce' }, { selfHost: true, safe: false })).toBe('enforce')
    expect(effectiveTakeover({ takeover: 'observe' }, { selfHost: false, safe: false })).toBe('observe')
    expect(effectiveTakeover({ takeover: 'off' }, { selfHost: false, safe: false })).toBe('off')
    // 非法值忽略，走默认推导。
    expect(effectiveTakeover({ takeover: 'bogus' as never }, { selfHost: false, safe: false })).toBe('enforce')
  })

  it('自举仓库默认 observe；其余默认 enforce', () => {
    expect(effectiveTakeover({}, { selfHost: true, safe: false })).toBe('observe')
    expect(effectiveTakeover({}, { selfHost: false, safe: false })).toBe('enforce')
  })

  it('takeoverReason 说明来源（doctor 可读）', () => {
    expect(takeoverReason({}, { selfHost: false, safe: false })).toContain('默认强制接管')
    expect(takeoverReason({}, { selfHost: true, safe: false })).toContain('自举检测')
    expect(
      takeoverReason({ safeMode: true }, { selfHost: false, safe: true, safeMode: { active: true, source: 'sentinel', path: '/tmp/x/safe-mode' } }),
    ).toContain('safe-mode 强制 off')
    expect(takeoverReason({ takeover: 'observe' }, { selfHost: false, safe: false })).toContain('takeover=observe')
  })
})
