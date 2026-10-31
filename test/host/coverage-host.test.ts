/**
 * Host-layer branch coverage (NFR-5 口径扩展：src/host/** 纳入 coverage)。
 *
 * 只覆盖 host 侧纯函数/降级分支：Windows 路径归一、错误包装、合并门确认卡、
 * 本地工具声明 DSL、/flow init 文本渲染、postcheck 快照/归因降级路径，以及
 * tools/execute 包装层在假宿主里的行为。宿主能力缺失场景沿用 test/host/helpers。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DshToolExecution } from '../../src/host/adapters/dsh-types'
import type { EngineLike, HostPorts } from '../../src/host/types'
import type { HostRuntime } from '../../src/host/runtime'
import type { FileSystem, GitPort } from '../../src/core/types'
import { MemoryFileSystem } from '../../src/core/util/memory-fs'
import { createFakeGit } from '../../src/host/testing/fake-ctx'
import {
  CapabilityMissingError,
  EngineUnavailableError,
  HostError,
  describeError,
  silentLog,
  toAgentError,
} from '../../src/host/errors'
import {
  compareKey,
  displayPath,
  findProjectRoot,
  isAbsoluteLike,
  normalizeSlashes,
  stripWindowsPrefix,
  toAbsolute,
  toRepoRelative,
} from '../../src/host/adapters/windows-path'
import { buildMergedConfirm, renderConfirmCardText, toGatePanelConfirm } from '../../src/host/gates/merged'
import {
  defineHostTool,
  fail,
  ok,
  toJsonSchema,
  toLosslessJson,
  validValuesOf,
  validateArgs,
} from '../../src/host/tools/schema'
import { runInit } from '../../src/host/init/index'
import {
  captureTaskStartSnapshot,
  diffSnapshots,
  isShellLikeTool,
  parsePorcelainV2,
  postcheckStatus,
  resetPostcheckCacheForTest,
  resolveCwd,
  snapshotWithGit,
  snapshotWithWalk,
  cleanedPaths,
} from '../../src/host/postcheck/index'
import { DEBUG_FETCH_LOG, installFetchDebug } from '../../src/host/debug-fetch'
import { resetHostPluginForTest } from '../../src/host/index'
import { flush, setupPlugin, type PluginHarness } from './helpers'

afterEach(() => {
  resetHostPluginForTest()
  resetPostcheckCacheForTest()
})

// ---------------------------------------------------------------------------
// windows-path
// ---------------------------------------------------------------------------

describe('host/adapters/windows-path — 路径归一化', () => {
  it('长路径前缀 / 反斜杠 / 绝对路径判定', () => {
    expect(stripWindowsPrefix('\\\\?\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts')
    expect(stripWindowsPrefix('\\\\.\\C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts')
    expect(stripWindowsPrefix('/repo/a.ts')).toBe('/repo/a.ts')
    expect(normalizeSlashes('\\\\?\\C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts')
    expect(isAbsoluteLike('/repo/a.ts')).toBe(true)
    expect(isAbsoluteLike('C:\\repo\\a.ts')).toBe(true)
    expect(isAbsoluteLike('src/a.ts')).toBe(false)
    expect(isAbsoluteLike('\\\\?\\C:\\repo\\a.ts')).toBe(true)
    expect(compareKey('Src/A.ts')).toBe('Src/A.ts')
  })

  it('toRepoRelative：相对/根目录/root 内外的绝对路径与 ~ 路径', () => {
    expect(toRepoRelative('/repo', './src//a.ts/')).toBe('src//a.ts')
    expect(toRepoRelative('/repo', '.')).toBe('')
    expect(toRepoRelative('/repo', '')).toBe('')
    expect(toRepoRelative('/repo', '~/secrets.txt')).toBe('~/secrets.txt')
    expect(toRepoRelative('/repo', '/repo')).toBe('')
    expect(toRepoRelative('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(toRepoRelative('/repo', '/other/a.ts')).toBe('/other/a.ts')
    expect(toRepoRelative('/repo', 'C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts')
    expect(toAbsolute('/repo', '/abs/a.ts')).toBe('/abs/a.ts')
    expect(toAbsolute('/repo', 'src/a.ts')).toContain('src/a.ts')
  })

  it('findProjectRoot 向上查找标记 / 找不到回退 cwd；displayPath 展示', () => {
    const exists = (path: string): boolean => path === '/a/marker'
    expect(findProjectRoot('/a/b/c', 'marker', exists)).toBe('/a')
    expect(findProjectRoot('/x/y', 'nothing', () => false)).toBe('/x/y')
    expect(displayPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
    expect(displayPath('/repo', '/repo')).toBe('.')
    expect(displayPath('/repo', '/other/a.ts')).toBe('/other/a.ts')
  })
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

describe('host/errors — 结构化错误包装', () => {
  it('HostError 子类默认值 / code 透传 / 非 Error 值', () => {
    const plain = new HostError('消息')
    expect(plain.hint).toContain('/flow doctor')
    expect(plain.code).toBeUndefined()
    expect(toAgentError(plain)).toEqual({ error: '消息', hint: plain.hint })
    expect(toAgentError(new HostError('消息', '提示', 'E-1'))).toMatchObject({ error: '消息', code: 'E-1' })
    expect(toAgentError(new EngineUnavailableError())).toMatchObject({ code: 'ENGINE_UNAVAILABLE', error: 'FlowGate 引擎尚未就绪' })
    expect(toAgentError(new CapabilityMissingError('subagents')).error).toContain('subagents')

    const withHint = Object.assign(new Error('boom'), { hint: '自定义提示', code: 'CUSTOM' })
    expect(toAgentError(withHint)).toEqual({ error: 'boom', hint: '自定义提示', code: 'CUSTOM' })
    // code=ERR 是 Node 的通用错误码，不暴露给模型
    const generic = Object.assign(new Error('io'), { code: 'ERR' })
    expect(toAgentError(generic).code).toBeUndefined()
    // 空 message 时用 name
    expect(toAgentError(Object.assign(new Error(''), { name: 'EmptyError' })).error).toBe('EmptyError')
    expect(toAgentError('字符串错误')).toMatchObject({ error: '字符串错误' })
    expect(describeError(new HostError('消息', '提示'))).toBe('消息。提示')
    silentLog('error', 'noop')
  })
})

// ---------------------------------------------------------------------------
// gates/merged
// ---------------------------------------------------------------------------

function engineStub(overrides: {
  change?: unknown
  artifacts?: Record<string, unknown>
  tasks?: unknown[]
}): EngineLike {
  return {
    currentChange: () => overrides.change ?? null,
    getArtifacts: () => overrides.artifacts ?? {},
    getTasks: () => overrides.tasks ?? [],
  } as unknown as EngineLike
}

describe('host/gates/merged — 低复杂度方案确认卡', () => {
  it('数据不足返回 undefined；完整数据来自 proposal/spec/tasks/risk', () => {
    expect(buildMergedConfirm(engineStub({}))).toBeUndefined()
    const card = buildMergedConfirm(
      engineStub({
        change: { title: '回退标题' },
        artifacts: {
          proposal: { what: '目标 A' },
          spec: { scenarios: [{ id: 'R1.S1', title: '续费' }] },
          risk: {
            entries: [
              { category: 'security', grade: 'high', reason: '验签', mitigation: '签名' },
              { category: 'cost', grade: 'none', reason: '无', mitigation: '—' },
            ],
          },
        },
        tasks: [
          { scope: ['src/b/**', 'src/a/**'], newFiles: ['src/a/new.ts'], verify: [{ command: 'pnpm test' }, { command: 'pnpm test' }] },
        ],
      }),
    )
    expect(card).toMatchObject({
      goal: '目标 A',
      acceptance: ['R1.S1 续费'],
      scope: ['src/a/**', 'src/a/new.ts', 'src/b/**'],
      verify: 'pnpm test',
    })
    expect(card?.risks).toEqual([{ title: 'security：验签', mitigation: '签名' }])
    // 全 none 风险 -> risks 字段省略
    const noRisks = buildMergedConfirm(
      engineStub({ change: { title: '标题目标' }, artifacts: { risk: { entries: [{ category: 'cost', grade: 'none', reason: '', mitigation: '' }] } } }),
    )
    expect(noRisks?.goal).toBe('标题目标')
    expect(noRisks?.risks).toBeUndefined()
    expect(toGatePanelConfirm(card!)).toMatchObject({ goal: '目标 A', verify: 'pnpm test' })
  })

  it('渲染文本覆盖空字段与截断/风险列表', () => {
    const empty = renderConfirmCardText({ goal: '', acceptance: [], scope: [], verify: '' })
    expect(empty).toContain('目标：（未填写）')
    expect(empty).toContain('验证命令：（未填写）')
    expect(empty).not.toContain('验收场景')
    const long = renderConfirmCardText({
      goal: '目标',
      acceptance: ['R1.S1 续费'],
      scope: Array.from({ length: 25 }, (_, index) => `src/f${index}.ts`),
      verify: 'pnpm test',
      risks: [{ title: 'security：验签', mitigation: '签名' }],
    })
    expect(long).toContain('等 25 个文件')
    expect(long).toContain('风险与缓解')
    expect(long).toContain('验收场景')
  })
})

// ---------------------------------------------------------------------------
// tools/schema
// ---------------------------------------------------------------------------

describe('host/tools/schema — 声明 DSL 与参数校验', () => {
  const specs = {
    name: { type: 'string' as const, required: true, enum: ['a', 'b'] },
    count: { type: 'number' as const },
    retries: { type: 'integer' as const },
    flag: { type: 'boolean' as const },
    list: { type: 'array' as const, items: { type: 'string' as const } },
    bareList: { type: 'array' as const },
    obj: { type: 'object' as const, properties: { k: { type: 'string' as const } } },
    bareObj: { type: 'object' as const },
  }

  it('toJsonSchema 递归转换 / required / enum / 默认 items', () => {
    const schema = toJsonSchema(specs) as { required: string[]; properties: Record<string, Record<string, unknown>> }
    expect(schema.required).toEqual(['name'])
    expect(schema.properties['name']).toMatchObject({ type: 'string', enum: ['a', 'b'] })
    expect(schema.properties['list']).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(schema.properties['bareList']).toMatchObject({ items: { type: 'string' } })
    expect(schema.properties['obj']).toMatchObject({ properties: { k: { type: 'string' } } })
    expect(schema.properties['bareObj']).toMatchObject({ properties: {} })
    expect(toJsonSchema({})).toEqual({ type: 'object', properties: {} })
  })

  it('validateArgs：非对象 / 缺必填 / 类型 / 枚举违规', () => {
    expect(validateArgs(specs, null)).toEqual(['参数必须是 JSON 对象'])
    expect(validateArgs(specs, [])).toEqual(['参数必须是 JSON 对象'])
    expect(validateArgs(specs, 'x')).toEqual(['参数必须是 JSON 对象'])
    expect(validateArgs(specs, {})).toContain('缺少必填参数 name')
    expect(validateArgs(specs, { name: 'c' })).toContain('参数 name 必须是：a / b')
    expect(validateArgs(specs, { name: 'a', count: Number.POSITIVE_INFINITY })).toContain('参数 count 类型应为 number')
    expect(validateArgs(specs, { name: 'a', retries: 1.5 })).toContain('参数 retries 类型应为 integer')
    expect(validateArgs(specs, { name: 'a', flag: 'yes' })).toContain('参数 flag 类型应为 boolean')
    expect(validateArgs(specs, { name: 'a', list: 'x' })).toContain('参数 list 类型应为 array')
    expect(validateArgs(specs, { name: 'a', obj: [] })).toContain('参数 obj 类型应为 object')
    expect(validateArgs(specs, { name: 'a', obj: { k: 'v' }, bareObj: {} })).toEqual([])
  })

  it('toLosslessJson / validValuesOf / ok / fail', () => {
    expect(toLosslessJson(undefined)).toBeNull()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(toLosslessJson(circular)).toBeNull()
    expect(toLosslessJson({ a: undefined, b: 1 })).toEqual({ b: 1 })
    expect(validValuesOf(specs)).toEqual({ name: ['a', 'b'] })
    expect(ok('summary')).toEqual({ ok: true, summary: 'summary' })
    expect(ok('summary', { x: 1 })).toEqual({ ok: true, summary: 'summary', data: { x: 1 } })
    expect(fail('err', 'hint', { extra: 1 })).toMatchObject({ ok: false, data: { error: 'err', hint: 'hint', extra: 1 } })
  })

  it('defineHostTool：校验失败 / 成功 / 异常收束 / 渲染 / 并发标记', async () => {
    const tool = defineHostTool({
      name: 'demo',
      description: 'demo tool',
      parameters: specs,
      isConcurrencySafe: true,
      async execute(args) {
        if (args['name'] === 'b') throw new EngineUnavailableError()
        if (args['count'] === 99) throw new HostError('自定义失败', '自定义提示', 'E-2')
        return ok('执行成功', { count: args['count'] ?? 0 })
      },
    })
    const execute = tool.execute as (args: unknown, exec: unknown) => Promise<unknown>
    expect(await execute({}, {})).toMatchObject({ ok: false })
    expect(await execute({ name: 'a', count: 2 }, { agent: { id: 'agent-1' }, callId: 'call-1' })).toEqual({
      ok: true,
      summary: '执行成功',
      data: { count: 2 },
    })
    expect(await execute({ name: 'b' }, {})).toMatchObject({ ok: false, data: { code: 'ENGINE_UNAVAILABLE' } })
    expect(await execute({ name: 'a', count: 99 }, {})).toMatchObject({ ok: false, data: { code: 'E-2', hint: '自定义提示' } })
    expect((tool.isConcurrencySafe as () => boolean)()).toBe(true)

    const render = tool.output.render as (args: unknown, value: unknown) => { type: string; text: string }[]
    expect(render({}, { ok: true, summary: '摘要', data: { a: 1 } })[0]?.text).toContain('```json')
    expect(render({}, { ok: true, summary: '仅摘要' })[0]?.text).toBe('仅摘要')
    expect(render({}, 'plain')[0]?.text).toBe('"plain"')

    const unsafe = defineHostTool({ name: 'demo2', description: 'd', parameters: {}, execute: async () => ok('x') })
    expect((unsafe.isConcurrencySafe as () => boolean)()).toBe(true)
    expect(toJsonSchema({})).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// /flow init 文本渲染
// ---------------------------------------------------------------------------

function initRuntime(options: {
  engine?: unknown
  ensureEngine?: unknown
  initialized?: boolean
  inert?: { message: string; hint: string }[]
  root?: string
  git?: unknown
}): HostRuntime {
  return {
    engine: () => options.engine ?? null,
    ensureEngine: async () => options.ensureEngine ?? null,
    inertReasons: options.inert ?? [],
    isInitialized: () => options.initialized ?? false,
    root: () => options.root ?? '',
    ports: () => (options.git ? { git: options.git } : null),
    emit: () => {},
  } as unknown as HostRuntime
}

function fakeEngine(over: { initialized: boolean; init?: () => Promise<unknown> }): unknown {
  return {
    isInitialized: () => over.initialized,
    init: over.init ?? (async () => ({ ok: true, message: '初始化完成' })),
  }
}

describe('host/init — runInit 文本与降级', () => {
  it('已初始化 / 引擎不可用 / inert 原因', async () => {
    const already = await runInit(initRuntime({ engine: fakeEngine({ initialized: true }) }))
    expect(already).toContain('提示：要更新 project.md')
    // 卡片优先（§0 规则 2）：init 结果也会出现在会话命令 chip 里，不能要求负责人手输 /flow。
    expect(already).toContain('授权卡片上点「修复」')
    expect(already).toContain('用一句话描述你想做的变更')
    expect(already).not.toContain('/flow new')
    expect(already).not.toContain('/flow repair')

    await expect(
      runInit(initRuntime({ inert: [{ message: '缺少依赖', hint: '重新安装' }] })),
    ).rejects.toThrow('引擎初始化失败：缺少依赖。重新安装')
    await expect(runInit(initRuntime({ inert: [] }))).rejects.toThrow('未知原因')
    await expect(
      runInit(
        initRuntime({
          ensureEngine: fakeEngine({
            initialized: false,
            init: async () => ({ ok: true, message: '初始化完成', detectedCommands: {}, risks: [], filesRead: [] }),
          }),
          root: '',
        }),
      ),
    ).resolves.toContain('下一步：')
  })

  it('首次初始化：命令/风险/读取文件/非 git 仓库提示；init 抛错包装', async () => {
    const engine = fakeEngine({
      initialized: false,
      init: async () => ({
        ok: true,
        message: '已生成 .flowgate/project.md',
        detectedCommands: { test: 'pnpm test', lint: 'none', build: '', typecheck: 'pnpm tsc' },
        risks: ['缺少 CI 配置'],
        filesRead: ['package.json', 'README.md'],
      }),
    })
    const git = createFakeGit({ isRepo: async () => false })
    const text = await runInit(initRuntime({ ensureEngine: engine, root: '/fake/project', git }))
    expect(text).toContain('探测到的命令')
    expect(text).toContain('test: pnpm test')
    expect(text).not.toContain('lint: none')
    expect(text).toContain('风险提示')
    expect(text).toContain('读取了 2 个文件')
    expect(text).toContain('不是 git 仓库')
    // 点「启用 FlowGate」授权卡片后用户直接看到下一步：自然语言 + agent 工具，不给手输命令。
    expect(text).toContain('用一句话描述')
    expect(text).not.toContain('/flow new')

    // git 探测抛错被忽略
    const throwingGit = createFakeGit({ isRepo: async () => { throw new Error('git 坏了') } })
    const quiet = await runInit(initRuntime({ ensureEngine: fakeEngine({ initialized: false, init: async () => ({ ok: true, message: 'm', detectedCommands: {}, risks: [], filesRead: [] }) }), root: '/repo', git: throwingGit }))
    expect(quiet).not.toContain('不是 git 仓库')
    expect(quiet).not.toContain('探测到的命令')

    await expect(
      runInit(
        initRuntime({
          ensureEngine: fakeEngine({ initialized: false, init: async () => { throw new HostError('boom', 'hint-x') } }),
        }),
      ),
    ).rejects.toThrow('初始化失败：boom。提示：hint-x')
  })
})

// ---------------------------------------------------------------------------
// postcheck（快照 / 归因降级）
// ---------------------------------------------------------------------------

describe('host/postcheck — porcelain 解析 / 快照 / 归因', () => {
  it('parsePorcelainV2 支持普通/重命名/冲突/未跟踪并过滤忽略目录', () => {
    expect(parsePorcelainV2('')).toEqual([])
    const output = [
      '1 .M N... 100644 100644 100644 abc def src/a.ts',
      '2 R. N... 100644 100644 100644 abc def R100 src/new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 abc def src/conflict.ts',
      '? src/untracked.ts',
      '? node_modules/x.js',
      '? .flowgate/config.yaml',
      '',
    ].join('\0')
    expect(parsePorcelainV2(output)).toEqual(['src/a.ts', 'src/conflict.ts', 'src/new.ts', 'src/untracked.ts'])
  })

  it('isShellLikeTool 优先分类器，异常时按名字/参数兜底', () => {
    const runtimeWith = (classifyTool: unknown): HostRuntime =>
      ({ deps: { core: { classifyTool } } }) as unknown as HostRuntime
    expect(isShellLikeTool(runtimeWith(() => ({ category: 'shell' })), 'custom_shell', {})).toBe(true)
    expect(isShellLikeTool(runtimeWith(() => { throw new Error('x') }), 'bash', {})).toBe(true)
    expect(isShellLikeTool(runtimeWith(() => ({ category: 'read' })), 'mystery', { command: 'ls' })).toBe(true)
    expect(isShellLikeTool(runtimeWith(() => ({ category: 'read' })), 'mystery', {})).toBe(false)
    expect(isShellLikeTool(runtimeWith(() => ({ category: 'read' })), 'pwsh', {})).toBe(true)
  })

  it('snapshotWithGit：文件哈希、删除标记、超大文件只记大小', async () => {
    const fs = new MemoryFileSystem({ 'src/a.ts': 'hello', 'big.bin': 'x'.repeat(3 * 1024 * 1024) })
    const git = createFakeGit({
      statusPorcelain: async () =>
        ['1 .M N... 100644 100644 100644 abc def src/a.ts', '1 .D N... 100644 100644 100644 abc def src/gone.ts', '1 .M N... 100644 100644 100644 abc def big.bin', ''].join('\0'),
    }) as unknown as GitPort
    const snapshot = await snapshotWithGit(git, fs, '/repo')
    expect(snapshot.mode).toBe('git')
    expect(snapshot.files.get('src/gone.ts')).toBe('deleted')
    expect(snapshot.files.get('big.bin')).toBe(`size:${3 * 1024 * 1024}`)
    expect(snapshot.files.get('src/a.ts')).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('snapshotWithWalk：遍历目录、忽略前缀、不可读文件', async () => {
    const base = new MemoryFileSystem({
      'src/a.ts': 'a',
      'src/deep/b.ts': 'b',
      '.flowgate/config.yaml': 'x',
      'node_modules/x.js': 'x',
      'secret.bin': 'x',
    })
    const readFile = base.readFile.bind(base)
    const fs = Object.create(base) as FileSystem
    Object.defineProperty(fs, 'readFile', {
      value: async (path: string) => {
        if (path === 'secret.bin') throw new Error('EACCES')
        return readFile(path)
      },
    })
    const snapshot = await snapshotWithWalk(fs, '')
    expect(snapshot.mode).toBe('walk')
    expect([...snapshot.files.keys()].sort()).toEqual(['secret.bin', 'src/a.ts', 'src/deep/b.ts'])
    expect(snapshot.files.get('secret.bin')).toBe('unreadable')
  })

  it('diffSnapshots 覆盖新增/修改/删除；resolveCwd 与 postcheckStatus', () => {
    const before = { at: '1', mode: 'walk' as const, fingerprint: 'f1', files: new Map([['a', '1'], ['b', '2']]) }
    const after = { at: '2', mode: 'walk' as const, fingerprint: 'f2', files: new Map([['b', '3'], ['c', '4']]) }
    expect(diffSnapshots(before, after)).toEqual(['a', 'b', 'c'])
    expect(cleanedPaths(before, after)).toEqual(['a'])
    expect(diffSnapshots(after, after)).toEqual([])
    expect(resolveCwd('/repo', '/abs/x')).toBe('/abs/x')
    expect(resolveCwd('/repo', 'C:\\abs\\x')).toBe('C:\\abs\\x')
    expect(resolveCwd('/repo', 'sub/dir')).toBe('/repo/sub/dir')
    expect(postcheckStatus({ root: () => null, ports: () => null } as unknown as HostRuntime)).toEqual({
      gitAvailable: false,
      lastSnapshotAt: null,
    })
  })

  it('captureTaskStartSnapshot：git/walk/无端口/失败降级', async () => {
    const notes: string[] = []
    const fs = new MemoryFileSystem({ 'src/a.ts': 'a' })
    const gitRepo = createFakeGit({ isRepo: async () => true }) as unknown as GitPort
    const gitNotRepo = createFakeGit({ isRepo: async () => false }) as unknown as GitPort
    const makeRuntime = (ports: HostPorts | null): HostRuntime =>
      ({
        root: () => '/repo',
        ports: () => ports,
        noteFeature: (_key: string, message: string) => notes.push(message),
      }) as unknown as HostRuntime
    await captureTaskStartSnapshot(makeRuntime({ fs, git: gitRepo, commandRunner: { async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } } } as HostPorts), 'T1')
    await captureTaskStartSnapshot(makeRuntime({ fs, git: gitNotRepo, commandRunner: { async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 } } } } as HostPorts), 'T2')
    await captureTaskStartSnapshot(makeRuntime(null), 'T3')
    const brokenGit = { ...gitRepo, isRepo: async () => { throw new Error('git 坏') } } as unknown as GitPort
    await captureTaskStartSnapshot(makeRuntime({ fs, git: brokenGit } as HostPorts), 'T4')
    expect(notes.join(' ')).toContain('任务开始快照失败')
  })
})

describe('host/postcheck — tools/execute 包装层（假宿主）', () => {
  let harness: PluginHarness | null = null

  afterEach(async () => {
    if (harness) await harness.cleanup()
    harness = null
  })

  function exec(name: string, args: Record<string, unknown>): DshToolExecution {
    return { callId: 'call-1', name, arguments: args } as unknown as DshToolExecution
  }

  it('非 shell 工具直接放行；shell 工具在前后快照间归因 agent 改动', async () => {
    harness = await setupPlugin()
    const ports = harness.runtime.ports()!
    const fs = ports.fs as MemoryFileSystem
    await fs.writeFile('src/a.ts', 'v1')
    ;(ports.git as unknown as { statusPorcelain: () => Promise<string> }).statusPorcelain = async () =>
      '1 .M N... 100644 100644 100644 abc def src/a.ts\0'

    // 非 shell 工具：不进入快照逻辑
    expect(await harness.ctx.runWaterfall('tools/execute', [exec('read', { file_path: 'src/a.ts' })], async () => 'read-ok')).toBe('read-ok')

    // shell 工具：next 内修改文件 -> recordPostcheck 记录 agent 改动
    const result = await harness.ctx.runWaterfall('tools/execute', [exec('bash', { command: 'touch src/a.ts' })], async () => {
      await fs.writeFile('src/a.ts', 'v2')
      return 'shell-ok'
    })
    expect(result).toBe('shell-ok')
    const state = (harness.engine as unknown as { state: { calls: { recordPostcheck: unknown[] } } }).state
    expect(state.calls.recordPostcheck.length).toBeGreaterThan(0)
    expect(state.calls.recordPostcheck[0]).toMatchObject({ origin: 'agent', changedPaths: ['src/a.ts'] })

    // 下一次调用前出现的外部改动 -> recordExternalChanges
    await flush()
    await fs.writeFile('src/a.ts', 'external')
    await harness.ctx.runWaterfall('tools/execute', [exec('bash', { command: 'echo hi' })], async () => 'ok')
    const calls = (harness.engine as unknown as { state: { calls: { recordExternalChanges: unknown[] } } }).state.calls
    expect(calls.recordExternalChanges.length).toBeGreaterThan(0)
  })

  it('快照失败时降级放行并记录 feature note', async () => {
    harness = await setupPlugin()
    const ports = harness.runtime.ports()!
    ;(ports.git as unknown as { isRepo: () => Promise<boolean> }).isRepo = async () => {
      throw new Error('git 不可用')
    }
    const result = await harness.ctx.runWaterfall('tools/execute', [exec('bash', { command: 'ls' })], async () => 'passthrough')
    expect(result).toBe('passthrough')
    expect(harness.runtime.featureNotes.postcheck?.join('；')).toContain('快照失败')
  })
})

// ---------------------------------------------------------------------------
// debug-fetch（仅 FLOWGATE_DEBUG_FETCH=1 时使用；这里验证包装器本身）
// ---------------------------------------------------------------------------

describe('host/debug-fetch — fetch 追踪包装', () => {
  it('安装幂等 / 字符串与对象 URL / 错误路径 / 无可包装 fetch', async () => {
    const originalFetch = globalThis.fetch
    const flagObject = globalThis as { __FLOWGATE_FETCH_WRAPPED__?: boolean; fetch?: unknown }
    delete flagObject.__FLOWGATE_FETCH_WRAPPED__
    let calls = 0
    const response = {
      status: 200,
      ok: true,
      clone: () => ({
        headers: { get: () => 'application/json' },
        text: async () => '{"ok":true}',
      }),
    }
    flagObject.fetch = async (_input: unknown, _init?: unknown) => {
      calls += 1
      return response
    }
    try {
      installFetchDebug()
      expect(flagObject.__FLOWGATE_FETCH_WRAPPED__).toBe(true)
      // 再次安装是 no-op
      installFetchDebug()
      expect(typeof flagObject.fetch).toBe('function')

      await (flagObject.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('http://127.0.0.1/messages', {
        body: JSON.stringify({ stream: true, tools: [1, 2], max_tokens: 10 }),
      })
      await flush()
      await (flagObject.fetch as (input: unknown, init?: unknown) => Promise<unknown>)({ url: 'http://127.0.0.1/messages' }, { body: 'not json' })
      await flush()
      expect(calls).toBe(2)

      // 错误路径：包装器记录后原样抛出
      flagObject.fetch = async () => {
        throw Object.assign(new Error('boom'), { cause: 'root-cause' })
      }
      delete flagObject.__FLOWGATE_FETCH_WRAPPED__
      installFetchDebug()
      await expect(
        (flagObject.fetch as (input: unknown, init?: unknown) => Promise<unknown>)('http://x/messages', {}),
      ).rejects.toThrow('boom')

      // 没有可包装的 fetch：安装标记后直接返回
      flagObject.fetch = undefined
      delete flagObject.__FLOWGATE_FETCH_WRAPPED__
      installFetchDebug()
      expect(flagObject.__FLOWGATE_FETCH_WRAPPED__).toBe(true)
      expect(DEBUG_FETCH_LOG).toContain('flowgate-fetch')
    } finally {
      globalThis.fetch = originalFetch
      delete flagObject.__FLOWGATE_FETCH_WRAPPED__
    }
  })
})
