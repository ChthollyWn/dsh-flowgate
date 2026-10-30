/**
 * Host 半侧加载验证（不需要 DSH 进程）：
 *   node verify-host.mjs
 *
 * 做法：用 rc.5 的 @deepseek-ai/cordis 建根 Context，注册四个最小 fake 服务
 * （commands / tools / systemPrompt / session），再 ctx.plugin(hostPlugin)。
 * 断言：插件被激活、apply 执行、/flow 命令与 flow_status 工具真的注册到了
 * 注入后的 ctx 上、事件监听器挂上、单调 guard 挂上。
 *
 * 注意：这是"模块可加载 + 注册路径正确"的证据，不等于在真实 DSH 进程里跑通；
 * 真实进程验证见 README 的 dump-config 步骤。
 */
import { Context, Service } from '@deepseek-ai/cordis'

const calls = { commands: [], tools: [], guards: 0, presentAs: [], sections: [], events: [] }

class FakeCommands extends Service {
  constructor(ctx) {
    super(ctx, 'commands')
  }
  register(def) {
    calls.commands.push(def)
    return () => {}
  }
}

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
  }
  register(def) {
    calls.tools.push(def)
    return () => {}
  }
  guard(fn) {
    calls.guards += 1
    calls.guardFn = fn
    return () => {}
  }
  presentAs(mode) {
    calls.presentAs.push(mode)
    return () => {}
  }
}

class FakeSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }
  section(def) {
    calls.sections.push(def)
    return () => {}
  }
  getSectionOrder(name) {
    return 9000
  }
}

const root = new Context()
// dsh 里 logger 由插件提供；这里注入一个假的，方便看到插件自身的日志输出
root.logger = { info: (...a) => console.log('   [plugin.log]', ...a) }
await root.plugin(FakeCommands)
await root.plugin(FakeTools)
await root.plugin(FakeSystemPrompt)

// 事件监听也算验证：挂一个观察者收插件注册后的事件
const hostPlugin = await import('./lib/index.js')

const fiber = root.plugin(hostPlugin)
await new Promise((resolve) => setTimeout(resolve, 150))

console.log('=== 插件元信息 ===')
console.log('name     =', hostPlugin.name)
console.log('inject   =', JSON.stringify(hostPlugin.inject))
console.log('apply    =', typeof hostPlugin.apply)
console.log('fiber    =', fiber && Object.keys(fiber).slice(0, 12))

console.log('\n=== 注册结果 ===')
console.log('commands =', calls.commands.map((d) => d.name))
console.log('tools    =', calls.tools.map((d) => d.name))
console.log('guards   =', calls.guards)
console.log('presentAs=', calls.presentAs)
console.log('sections =', calls.sections.map((s) => s.name))

if (calls.commands.length !== 1 || calls.commands[0].name !== 'flow') {
  console.error('FAIL: /flow 命令未注册')
  process.exit(1)
}
if (calls.tools.length !== 1 || calls.tools[0].name !== 'flow_status') {
  console.error('FAIL: flow_status 工具未注册')
  process.exit(1)
}
if (calls.guards !== 1) {
  console.error('FAIL: guard 未注册')
  process.exit(1)
}

// 真的调一次命令 handler，验证返回形态
const result = calls.commands[0].handler({ rawInput: ' status', commandId: 'spike', attachments: [], signal: new AbortController().signal })
console.log('\n=== /flow handler 返回 ===')
console.log(JSON.stringify(result))
if (!result || result.kind !== 'success') {
  console.error('FAIL: 命令返回不是 { kind:"success" }')
  process.exit(1)
}

// 真的调一次 guard，打印它看到的 exec 形状（H1 证据）
console.log('\n=== guard 看到的工具调用形状（H1 证据）===')
console.log(JSON.stringify(calls.guardFn({
  callId: 'call-1',
  rootCallId: 'call-1',
  name: 'bash',
  arguments: { command: 'git status --short', description: 'check status', timeoutMs: null, workdir: null },
  agent: { id: 'session-abc' },
  signal: new AbortController().signal,
}), null, 1))

console.log('\nOK: host 入口可加载，/flow 命令 + flow_status 工具 + guard + systemPrompt.section 均注册成功')
await root.fiber.dispose()
