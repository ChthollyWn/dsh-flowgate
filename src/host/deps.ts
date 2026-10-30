/**
 * 生产环境依赖装配：Node 端口 + FlowEngine + core 纯函数桥。
 *
 * 只有 `src/host/index.ts` import 本文件；单测通过 fake deps 绕开真实 core/engine。
 */
import type { HostDeps, HostPorts } from './types.js'
import type { EngineOptions, FlowEngine } from './types.js'
import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { randomBytes } from 'node:crypto'
import { FlowEngine as EngineClass } from '../core/engine.js'
import { createCoreBridge } from './core-bridge.js'
import { NodeFileSystem } from './adapters/node-fs.js'
import { NodeGit } from './adapters/node-git.js'
import { NodeCommandRunner } from './adapters/node-command-runner.js'

/** 插件版本：优先读包根 package.json，读不到退回常量（doctor 用于展示）。 */
function detectPluginVersion(): string {
  try {
    // built: lib/host.js → ../package.json；source: src/host/deps.ts → ../../package.json
    for (const candidate of ['../package.json', '../../package.json']) {
      try {
        const url = new URL(candidate, import.meta.url)
        const raw = readFileSync(url, 'utf8')
        const parsed = JSON.parse(raw) as { name?: string; version?: string }
        if (parsed.name === 'dsh-flowgate' && parsed.version) return parsed.version
      } catch {
        // 继续找下一个候选。
      }
    }
  } catch {
    // 忽略：版本只用于展示。
  }
  return '0.1.0'
}

/** 构造真实依赖。`root` 为绝对项目根。 */
export function createHostDeps(overrides: Partial<Pick<HostDeps, 'log'>> = {}): HostDeps {
  const createPorts = (root: string): HostPorts => {
    const fs = new NodeFileSystem(root)
    const git = new NodeGit()
    const commandRunner = new NodeCommandRunner()
    return { fs, git, commandRunner }
  }
  return {
    createPorts,
    createEngine: (options: EngineOptions) => new EngineClass(options) as unknown as FlowEngine,
    core: createCoreBridge(),
    homeDir: () => os.homedir(),
    pluginVersion: detectPluginVersion(),
    randomKeyHex: (bytes) => randomBytes(bytes).toString('hex'),
    ...overrides,
  }
}

/** 默认 ledger key 路径（`~/.dsh/flowgate/ledger.key`）。 */
export function defaultLedgerKeyPath(homeDir: string): string {
  return nodePath.join(homeDir, '.dsh', 'flowgate', 'ledger.key')
}
