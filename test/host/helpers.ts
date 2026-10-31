/**
 * test/host 共用装配：假 ctx + 假 deps + 真实 host 插件启动路径
 * （`startHostPlugin` 与 `apply` 共用同一安装顺序）。
 */
import type { DshContext, DshToolSchema } from '../../src/host/adapters/dsh-types.js'
import type { HostConfig } from '../../src/host/types.js'
import type { FlowEngine } from '../../src/core/engine.js'
import {
  createFakeAgent,
  createFakeCommandRuntime,
  createFakeContext,
  createFakeDeps,
  createFakeEngine,
  createFakePorts,
  createFakeProjectionRegistry,
  createFakeSessionQuery,
  createFakeSubagents,
  createFakeSystemPrompt,
  createFakeToolRuntime,
  disposeFakeContext,
  makeTempHome,
  type FakeAgent,
} from '../../src/host/testing/fake-ctx.js'
import { startHostPlugin, activeHostRuntime } from '../../src/host/index.js'
import type { HostRuntime } from '../../src/host/runtime.js'
import * as fsp from 'node:fs/promises'

/** 默认可见工具面（覆盖 write/shell/delegate/unknown/flowgate 各类别）。 */
export const DEFAULT_SCHEMAS: DshToolSchema[] = [
  { name: 'read', description: 'read file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'write', description: 'write file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'edit', description: 'edit file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'glob', description: 'glob', parameters: { type: 'object', properties: {} } },
  { name: 'grep', description: 'grep', parameters: { type: 'object', properties: {} } },
  { name: 'bash', description: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'subagent', description: 'delegate', parameters: { type: 'object', properties: {} } },
  { name: 'subagent_fork', description: 'delegate', parameters: { type: 'object', properties: {} } },
  { name: 'workflow', description: 'delegate', parameters: { type: 'object', properties: {} } },
  { name: 'send_message', description: 'delegate', parameters: { type: 'object', properties: {} } },
  { name: 'run_code', description: 'ptc', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__demo', description: 'mcp tool', parameters: { type: 'object', properties: {} } },
  { name: 'mystery_tool', description: 'unknown tool', parameters: { type: 'object', properties: {} } },
]

export interface SetupOptions {
  engine?: FlowEngine
  schemas?: DshToolSchema[]
  missingTools?: ('guard' | 'restrict' | 'presentAs' | 'schemas')[]
  services?: Record<string, unknown>
  config?: HostConfig
  /** 不触发 agent/created（测试自己绑定会话）。 */
  bindAgent?: boolean
}

export interface PluginHarness {
  ctx: ReturnType<typeof createFakeContext>
  runtime: HostRuntime
  engine: FlowEngine
  agent: FakeAgent
  tools: ReturnType<typeof createFakeToolRuntime>
  commands: ReturnType<typeof createFakeCommandRuntime>
  prompt: ReturnType<typeof createFakeSystemPrompt>
  projections: ReturnType<typeof createFakeProjectionRegistry>
  homeDir: string
  cleanup(): Promise<void>
}

/** 等待挂起的微任务/计时器（engine.load 与 hook 是异步的）。 */
export async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** 装配并加载插件（fake engine / fake services）。 */
export async function setupPlugin(options: SetupOptions = {}): Promise<PluginHarness> {
  const homeDir = await makeTempHome()
  const engine = options.engine ?? createFakeEngine()
  const tools = createFakeToolRuntime({ schemas: options.schemas ?? DEFAULT_SCHEMAS, missing: options.missingTools })
  const commands = createFakeCommandRuntime()
  const prompt = createFakeSystemPrompt()
  const projections = createFakeProjectionRegistry()
  const subagents = createFakeSubagents()
  const childAgents = new Map<string, { ctx?: DshContext }>()
  const agents = {
    get: (id: string) => childAgents.get(id),
    list: () => [...childAgents.values()],
  }
  const services: Record<string, unknown> = {
    tools,
    commands,
    systemPrompt: prompt,
    sessionProjections: projections,
    sessions: {},
    agents,
    subagents,
    sessionQuery: createFakeSessionQuery(),
    ...options.services,
  }
  const ctx = createFakeContext({ services, available: Object.keys(services) })
  const deps = createFakeDeps({ engine, homeDir, ports: createFakePorts('/fake/project') })
  const runtime = startHostPlugin(ctx, { enabled: true, projectRoot: '/fake/project', ...options.config }, deps)
  if (!runtime) throw new Error('host 插件启动失败（startHostPlugin 返回 null）')
  const agent = createFakeAgent({ id: 'session-main', cwd: '/fake/project', ctx })
  if (options.bindAgent !== false) {
    ctx.emitEvent('agent/created', { agent, source: 'startup' })
    await flush()
    // 引擎初始化是异步的（ledger.key + engine.load）：显式等就绪，避免并行跑测试时
    // flush 次数不够导致 guard/pre-execute 拿不到 engine 的计时抖动。
    await runtime.waitForEngine()
  }
  return {
    ctx,
    runtime,
    engine,
    agent,
    tools,
    commands,
    prompt,
    projections,
    homeDir,
    async cleanup() {
      try {
        await disposeFakeContext(ctx)
      } finally {
        if (activeHostRuntime() === runtime) {
          const { resetHostPluginForTest } = await import('../../src/host/index.js')
          resetHostPluginForTest()
        }
        await fsp.rm(homeDir, { recursive: true, force: true })
      }
    },
  }
}
