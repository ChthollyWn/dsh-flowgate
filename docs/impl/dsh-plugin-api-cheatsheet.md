# DSH 插件 API 速查表（基线 DSH 0.2.1-rc.5）

> 本文是 **实现速查表**，供 host-impl / client-ui 直接照抄。所有签名以真实 `.d.ts` / 源码为唯一证据，每节末尾给「出处」。
>
> - **证据获取方式**：应用 `app.asar` 里打包时**已剥除 `.d.ts`**（只有 `lib/*.js`），所以官方类型我用 npm 拉 rc.5 tarball 拿到：
>   `npm pack @deepseek-ai/dsh-tools@0.2.1-rc.5`（同理 24 个包），解包在 `/tmp/rc5/<pkg>`、`/tmp/rc5x/<pkg>`。
>   引用路径写作 `@deepseek-ai/<pkg>/lib/types/<file>.d.ts:<line>`（= `npm pack` 解包后的路径）。
> - **运行时入口形态**另有真实第三方插件互证：`~/.dsh/profiles/desktop/node_modules/{@michengai/dsh-codex-ui,@tt-a1i/archify-dsh,dsh-context}`（均已装在 rc 桌面 profile，可看作 rc.5 兼容）。
> - 本文件与 03 方案冲突之处在 §10 集中列出。

---

## 0. TL;DR（最重要的 12 条）

1. `package.json` 的 `dsh` 字段**没有** "host 入口 / client 入口" 路径字段。host 入口 = 包的 `main`/`exports["."]`；client 入口 = `exports["./client"]` 指向构建产物；`dsh.bundle.patch` 指向组合层 yml；`dsh.client = { platform:'web', inject:[...] }` 只是"这是浏览器插件"的声明。
2. host 插件是 **Cordis 插件**：`export const name` + `export const inject = [...]` + `export function apply(ctx, config)`（或 `export default { name, inject, apply }` / Service 类）。
3. client 插件产物是 `window.__ModuleLoader__.load({ id:'<包名>', factory:(require)=>{...} })`，factory 的 `module.exports` 必须是 `{ name, inject, apply }` 的**客户端 Cordis 插件**。
4. `/flow` 命令：`ctx.commands.register({ name, description, input?, handler })`；handler 可 async，返回 `{kind:'success'|'error', text}`；命令**不进模型消息**，但写入 `command/run`+`command/done` 会话事件。
5. 工具守卫：`ctx.tools.guard((exec) => string | undefined)`；`exec` 里有 `name / arguments / agent? / callId / rootCallId / signal`。返回字符串 = 拒绝（单调，无法被后来者翻案）。**H1 确认**。
6. 工具流水线事件：`tools/pre-execute`（waterfall，可 allow/deny/cancel/ask）→ `tools/execute`（waterfall 包装层）→ `tools/post-execute`（waterfall，可替换 content/value/追加 context）→ `tools/result`（emit 观察）。
7. 输入框状态条 `conversation.input.dock` 是 **list/session** 插槽；注册 `ctx.slots.register({ name:'conversation.input.dock', id:'...', order? }, Component)`。组件 props 自带 `sessionId / useSession / useProjection / useAccess / t`（session scope 标准套件）。
8. 右侧栏是**两段式**：stage1 `ctx.sidebarRightTabs.register({ id, kind, title, guide?, multiple? })`；stage2 `ctx.slots.register({ name:'sidebar.right.pane.tab', key:'<def.id>' }, Body)`。
9. 会话投影：host `ctx.sessionProjections.register({ key, stateSchema: zodType, stateVersion, init, apply, wire? })`；client 在 session 插槽组件里用 `useProjection(key)`（或 `ctx.sessions…projections.faceOf(key)`）。
10. 子 agent：`ctx.subagents.startActivation({ provider:'spawn', label, childId?, request:{ agentPreset?, cwd?, prompt:ContentBlock[], parent, signal, outputSchema? }, signal, delivery:'caller'|'parent' })` → `{ childId, messageId?, result: Promise<SubagentResult>, dispose() }`。
11. preset 在 `cordis.patch.yml` 里就是普通一行：`- insert: [{ id:'preset-flowgate', name:'@deepseek-ai/dsh-agent-preset', config:{ id, name, description, order, plugins:[...] } }]`。只读子 agent 用 `@deepseek-ai/dsh-tool-fs` 的 `config: { read:true, write:false, edit:false }`。
12. 面板按钮调宿主：Typert Remote 需要**构建期代码生成**（`@deepseek-ai/dsh-typert-generator`，`typertPlugin()` + `./typert`/`./remote` 导出 + codec `create`），成本高；**兜底方案更划算**：按钮把 `/flow ...` 文本填进输入框（`window.__DSH_BOOT__` 之外无需协议），批准/放行走命令。

---

## 1. 证据来源与真源位置

| 内容 | 真源 |
|---|---|
| 用户态安装的 `.d.ts` | `~/.dsh/profiles/node_modules/@deepseek-ai/*/lib/types/*.d.ts` —— **注意：这些是指向 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh@0.1.6-alpha.1` 的符号链接（旧版）**，不要当 rc.5 真源 |
| rc.5 运行时 | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`（asar 内 `.js` 完整，`.d.ts` 已剥离） |
| rc.5 类型真源（本文依据） | `npm pack @deepseek-ai/<pkg>@0.2.1-rc.5` 解包后的 `lib/types/**` |
| 官方说明文档 | `docs/reference/dsh-0.2.1-rc.5/*.zh.md`（= 同版本包 README 副本） |
| 真实第三方插件样例 | `~/.dsh/profiles/desktop/node_modules/@michengai/dsh-codex-ui`（host+client 双入口、patch、tsdown 产物）、`@tt-a1i/archify-dsh`（skill-only bundle）、`dsh-context`（projections/Remote/slots） |

取类型包的命令（复现用）：

```bash
mkdir -p /tmp/rc5 && cd /tmp/rc5
for p in dsh-package-manifest dsh-tools dsh-agent dsh-commands dsh-client-modules \
         dsh-session-projection dsh-session dsh-subagent dsh-skill dsh-skill-filesystem \
         dsh-user-questions dsh-client-ui-sidebar-right dsh-client-ui-conversation \
         dsh-client-ui-layout dsh-client-ui-slots dsh-client-ui-session dsh-api-gateway \
         dsh-typert-protocol dsh-typert-registry dsh-typert-loader dsh-system-prompt \
         dsh-hmr dsh-plugin-manager dsh-agent-preset dsh-agent-preset-registry \
         dsh-api-session-controller dsh-host-webserver; do
  npm pack "@deepseek-ai/$p@0.2.1-rc.5" --silent >/dev/null
done
for f in *.tgz; do d="${f%-0.2.1-rc.5.tgz}"; d="${d#deepseek-ai-}"; mkdir -p "$d"; tar xzf "$f" -C "$d" --strip-components=1; done
```

---

## 2. `package.json` 的 `dsh` 字段（完整结构）

rc.5 的公共字段（`DshManifest`，出处 `@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:28-37`）：

```jsonc
{
  "name": "dsh-flowgate",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/index.js",          // host 入口（Cordis 插件），**不是** dsh 字段
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },   // client 入口（构建产物，浏览器加载器按 ./client 解析）
    "./package.json": "./package.json"
  },
  "files": ["lib", "skills", "cordis.patch.yml", "README.md", "LICENSE"],
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": "0.2.1-rc.5" },  // engines.dsh 必填与否见 §10
  "peerDependencies": {                       // 宿主提供的包，不要打进 bundle
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.5"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },        // 一个路径或有序路径数组（每个相对包根）
    "client": {
      "platform": "web",
      "inject": [                                       // 包名依赖边（加载顺序/组合），不是服务注入
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-layout"
      ],
      "immediately": false,                             // 可选：boot 第一阶段预取
      "external": []                                    // 可选：模块表之外的精确请求，如 ["@deepseek-ai/dsh-client-ui-primitives"]
    }
  }
}
```

字段语义（出处同文件）：

| 字段 | 行号 | 说明 |
|---|---|---|
| `dsh.manifestVersion` | 30 | 格式版本，当前 `1` |
| `dsh.bundle.patch` | 67-69 | 组合层 patch 文件，一个或有序数组；随 profile 组合包层应用 |
| `dsh.profile.bundles` | 72-74 | 只有"profile 模板"包才用；普通插件写在 profile 的 `dsh.profile.bundles` 里 |
| `dsh.client.platform` | 77 | 必填，Web 侧选 `web` |
| `dsh.client.inject` | 79-80 | **信息性**包名依赖，用于 factory 到达顺序与 Cordis 组合，不是服务注入 |
| `dsh.client.immediately` | 81-82 | 第一阶段注册屏障，缺省走 application 批 |
| `dsh.client.external` | 83-88 | 超出基座模块表的精确请求；纯类型 import 被擦除、不产生请求 |
| `engines.dsh` | 56-58 | SemVer range（含精确 prerelease） |

> 关键结论：**没有** `dsh.host` / `dsh.client.entry` 之类的入口字段。host 入口来自 `main`/`exports["."]`，client 入口来自 `exports["./client"]`（`dsh-client-modules` README：「exports a `./client` bundle」）。真实插件 `@michengai/dsh-codex-ui/package.json` 正是此形态。

---

## 3. `cordis.patch.yml` 写法

### 3.1 基本语义（出处：`dsh-app-boot` README.zh L61-65、L204）

- 顶层是 **YAML 数组**。每一项是「patch 条目」：
  - `- id: <row-id>` + `config:` → **整体替换**该行的 config（不是深合并！要重述保留字段）
  - `- id: <row-id>` + `disabled: true` → 禁用该行
  - `- insert: [ { id, name, config?, disabled? }, ... ]` → 插入新行（可多个 insert 条目）
- 按 id 匹配不到行 → stderr 警告；空文件/只有注释 → 启动失败（要禁用该层就写 `[]`）。
- `!!js <表达式>` 在启动时求值；可用变量：`ctx`（宿主 Context，如 `ctx.get('profileContext')`）、`process`、`baseUrl`（当前包安装根）、以及包的 `Config`。`disabled: !!js ...` 也可用。
- `name` 可以是 npm 包标识符、绝对路径、`file:` URL；相对路径（`./`、`../`）相对 patch 文件解析，并在加载时转换成 file URL。
- 组合顺序：bundle 层（`dsh.bundle.patch` 列表按序）→ profile 的 `cordis.patch.yml` → home 级 patch；后应用者覆盖。`--patch <path>` 可叠加额外层（开发神器）。
- `cordis:group` / `group: true` 行可嵌 `config:` 子行列表（preset 里隔离 scope 用，例如 `planMode`）。
- Loader 行 id 是本行身份；在 patch 里改 id 不存在时按 name 找。

### 3.2 插入插件行（我们的 bundle patch，`spike/cordis.patch.yml` 已验证）

```yaml
- insert:
    - id: flowgate                      # Loader row id（全局唯一）
      name: 'dsh-flowgate'              # 包名；本地开发可用绝对路径或 file: URL
      config:                           # 会作为 apply(ctx, config) 第二参
        markerPath: .flowgate/config.yaml
```

### 3.3 插入 Agent Preset（H25，**rc.5 的 preset 不是特殊语法**）

出处：`@deepseek-ai/dsh-agent-preset` README + `@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml`（app.asar 内 `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）。

```yaml
- insert:
    - id: preset-flowgate                      # 行的 Loader 身份（可被 profile patch 按 id 覆盖）
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: flowgate                           # 会话保存的 preset 身份（唯一）
        name: FlowGate 工程模式
        description: 硬约束开发流程：先澄清/设计，再 TDD，证据驱动验收。
        order: 50
        plugins:                               # 子插件 entry 列表（与 patch 行同构）
          - name: 'dsh-flowgate'               # 插件本体（命令/工具/守卫）
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: "You are FlowGate, a process-gated coding agent." }
          # 只读取证 preset：同一行再来一个 preset 即可
    - id: preset-flowgate-reviewer
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: flowgate-reviewer
        name: FlowGate 只读取证
        order: 51
        plugins:
          - name: '@deepseek-ai/dsh-tool-fs'
            config: { read: true, readImage: true, write: false, edit: false }  # ← 只读就靠这个
          - name: '@deepseek-ai/dsh-tool-fs-search'
          - name: 'dsh-flowgate'
          - id: subagent-model-selection-settings
            name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
```

**只读文件工具确认**：`@deepseek-ai/dsh-tool-fs` 的 `Config` 有 `read/readImage/write/edit` 四个开关（`tool-fs/lib/types/index.d.ts:14-31`），`write:false, edit:false` 即只读。比 `restrict()` 更硬（工具根本不可见，但会改变工具面 → 仅用于生命周期固定的子 agent）。

### 3.4 `!!js` 表达式真实样例（dsh-base / dsh-web-app 组合层）

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"
  config: { root: [] }

- id: tools
  config: { mode: !!js process.env.DSH_TOOLS_MODE }

- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js "!ctx.get('profileContext')"

# 动态路径（archify-dsh 的 skill-only bundle，硬事实：不需要 host 插件也能注册技能目录）
- insert:
    - id: archify-skill-filesystem
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: archify-plugin
        includeDefaultRoots: false
        bundledSkillDir: !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@tt-a1i/archify-dsh/package.json')), 'skills')
```

---

## 4. 入口形态与 tsdown 双入口构建

### 4.1 Host 入口形态（**已实测加载**，见 §9）

官方包统一形态（`@deepseek-ai/dsh-skill-filesystem/lib/index.js` 尾部、`dsh-context` 同）：

```js
export { Config, apply, inject, name }   // 具名导出；也可 export default 一个插件对象/Service 类
```

```ts
// src/index.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-flowgate'
export const inject: string[] = []          // 硬依赖的服务；控制"何时激活"
export interface Config { markerPath?: string }

export function apply(ctx: Context, config: Config = {}) {
  // ctx.inject([...], (ctx) => { ... }) 用于可选服务（服务出现时才跑）
}
```

- `inject` 里列的服务**必须存在**才会激活（Cordis 依赖注入）；可选能力一律用 `ctx.inject(['commands'], (ctx) => …)`。
- 注册即 effect：`ctx.tools.register`/`ctx.commands.register` 返回 disposer；`ctx.effect(() => dispose, 'label')` 或直接让返回值参与 fiber 释放。
- Config 校验：导出一个 `Config = z.object({...})`（schemastery）会被 Loader 用作行 config 的 schema；不导出则 `--dump-config-schema` 报 unknown（可接受）。

### 4.2 Client 入口形态（**已构建 + 已离线验证**，见 §9）

产物（真实插件 `@michengai/dsh-codex-ui/lib/client.js`、`dsh-context/lib/client.js` 首尾一致）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-flowgate',                  // 必须 === package.json name
  factory: (require) => {
    var module = { exports: {} };      // CJS 语义；require 是宿主模块表的同步 require
    // ...tsdown/rolldown CJS 产物...
    module.exports = { name: 'dsh-flowgate', inject: ['slots','sidebarRightTabs'], apply }
    return module.exports
  }
})
//# sourceMappingURL=client.js.map
```

- factory 内 `require('react')`、`require('react/jsx-runtime')`、`require('@deepseek-ai/dsh-client-ui-primitives')` 等**只能**用模块表 baseline 里的名字；超出基座的在 `dsh.client.external` 声明（还有纯 node_modules 依赖时）。
- 不要 `import()` 另外的相对文件当成独立 entry（除非用 `require.async`，但它只能加载同包 chunk，且与 entry 输出不能互相同步 require）。
- CSS：官方说法是"模块体副作用（含 CSS 注入）在 factory 闭包里、首次 materialize 时执行"——自己插 style 标签或引入样式字符串都行。

### 4.3 tsdown 0.23 配置（spike 实测通过）

`tsdown@0.23.4` **支持** `outputOptions`（传给 rolldown 的 output），其中 `banner`/`footer` 可用；但对 client 用 footer 包 `load({...})` 不如"先出普通 CJS，再用小脚本把产物塞进 factory"稳（因为 tsdown 的 CJS 产物本身带 `exports.xxx` 赋值，footer 无法把它包成函数体）。**spike 用后者并通过**：

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
const EXTERNAL = [/^@deepseek-ai\//, 'react', 'react-dom', 'react/jsx-runtime']

export default defineConfig([
  { // host: 纯 ESM，node 平台，@deepseek-ai/* 全部 external
    entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', platform: 'node',
    target: 'node22', sourcemap: true, external: EXTERNAL, dts: false,
    outExtensions: () => ({ js: '.js' }), clean: false,
  },
  { // client: 先出普通 CJS 到 lib.tmp，再由 scripts/stamp-client.mjs 包成 load({...})
    entry: { client: 'src/client.tsx' }, outDir: 'lib.tmp', format: 'cjs',
    target: 'es2022', sourcemap: true, external: EXTERNAL, clean: true,
    outExtensions: () => ({ js: '.cjs' }),
  },
])
```

`scripts/stamp-client.mjs` 核心（spike 可用版）：读 `lib.tmp/client.cjs`，去掉行首 `"use strict";` 与 sourceMappingURL，拼成

```js
window.__ModuleLoader__.load({
  id: JSON.stringify(require('../package.json').name),
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
<CJS 产物>
    if (!module.exports.name) module.exports.name = '<包名>'
    if (!module.exports.inject) module.exports.inject = ['slots','sidebarRightTabs']
    return module.exports;
  }
});
```

进阶（可选，非必需）：rolldown/tsdown plugin 的 `renderChunk`/`generateBundle` 钩子做同样包装，省一个临时目录；官方仓库的"shared preset stamps client.js"未随 npm 发布（`@deepseek-ai/dsh-client-modules` README 只说明行为），**第三方需要自建 stamp**（codex-ui / dsh-context 的产物就是这么来的）。

tsdown 0.23 注意事项（实测）：
- `external: [...]` 仍可用但已 deprecated → 新写法 `deps: { neverBundle: [...] }`；
- `format:'cjs'` 会忽略 `platform:'browser'` 警告；纯前端 CJS 用 `inputOptions: { platform: 'browser' }`；
- ESM 默认后缀 `.mjs`，要 `.js` 必须 `outExtensions: () => ({ js: '.js' })`。

---

## 5. Host 扩展点 API（签名 + 最小示例 + 出处）

### 5.1 命令 `ctx.commands`

出处：`@deepseek-ai/dsh-commands/lib/types/index.d.ts:19-94,142`。

```ts
interface CommandInvocation {
  commandId: CommandId; agent: Agent; rawInput: string
  attachments: readonly (ImageBlock | FileBlock)[]; signal: AbortSignal
}
interface CommandDefinition {
  definitionId?: CommandDefinitionId
  name: string          // 小写、无前导斜杠
  description: string
  input?: { hint: string; attachments?: boolean }
  recordInput?: boolean // 默认 true；payload 由领域事件承载时置 false
  handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult>
}
type CommandResult = { kind:'success'; text?: string; sourceEventSeq?: SessionSeq }
                   | { kind:'error'; text: string }
ctx.commands.register(def): () => void
```

要点：
- handler **可以 async**：在 handler 里 `await engine.run(...)` 再返回文本。返回的 `text` 由派发 UI 直接渲染（不是模型消息）。
- 在 handler 里通知 agent：`inv.agent.inject(userMessage)`（不唤醒，下一步生效）或 `inv.agent.steer(userMessage)`（最近 step 边界，主循环会消费）。`UserMessage` 的构造见 `@deepseek-ai/dsh-llm`（`MessageSource`，插件来源需要 merge 声明）。
- 命令生命周期写 `command/run` / `command/done` 会话事件（log-only，不进模型历史），可用作人工动作审计。
- 现成 dispatcher：`ctx.commands.execute(agent, '/flow status', [], signal)`，可用于面板按钮兜底（见 §8.3）。

### 5.2 工具 `ctx.tools`

出处：`@deepseek-ai/dsh-tools/lib/types/index.d.ts:47-102,216-300,435-522,610-712`；`schema.d.ts:178-248`。

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'flow_task_done',
  description: 'Mark the current FlowGate task as done with fresh evidence.',
  parameters: {                       // 隐式 open object root；每字段一个 spec
    taskId: { type: 'string', required: true, description: '...' },
    evidence: { type: 'array', items: { type: 'string' }, required: true },
  },
  output: {
    schema: {                         // 原生 JSON Schema（dsh-tools 支持子集）
      type: 'object', additionalProperties: false,
      properties: { ok: { type: 'boolean', required: true }, summary: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.summary }],
    presentationMeta: (_args, value) => ({ ... }),   // 可选，给客户端渲染器
  },
  timeoutMs: 30_000,                 // 可选；需要 execute 转发 exec.signal
  isConcurrencySafe: (args) => true, // 可选
  async execute(args, exec) {        // args 已按 schema 校验并冻结；exec 是 ToolRunContext
    return { ok: true, summary: '...' }   // 必须符合 output.schema
  },
}))  // 返回 () => void disposer
```

- 参数校验：`defineTool` 编译 schema 并在调用前用 `validateArgs` 校验（`schema.d.ts:248`）；execute 拿到的是**深度冻结**的参数。
- 结果形态：`ToolExecutionResult = { isError:false, value: JsonValue, content: ContentBlock[], ... } | { isError:true, error:{message,...}, content }`（index.d.ts:395-435）。`output.render` 生成模型可见 content；`value` 只用于结构化（不进 durable 事件）。
- disposer 返回值支持 HMR/卸载。

守卫与限制：

```ts
ctx.tools.guard((exec) => string | undefined)   // 返回字符串 = 拒绝；单调；plain ctx 作用全局，agent.ctx 只作用该 agent
ctx.tools.restrict({ allow?: string[], deny?: string[] })  // 只过滤"继承的全局工具"，不影响自己 scope 注册的；可交叉叠加
ctx.tools.presentAs('native' | 'ptc')           // 只在 scoped ctx 生效；preset 的 standing 声明覆盖其下所有 agent
ctx.tools.get(name, scope?) / ctx.tools.schemas(scope?)
```

### 5.3 事件名与载荷（完整清单）

**tools**（`@deepseek-ai/dsh-tools/lib/types/index.d.ts:47-102`）：

| 事件 | 模式 | 载荷/返回 |
|---|---|---|
| `tools/pre-execute` | waterfall | `(exec: ToolExecution, next) => Promise<PreToolDecision>`；decision = `allow`/`deny{reason,info?}`/`cancel`/`ask{reason?,displayReason?}` |
| `tools/execute` | waterfall | `(exec: ToolDispatchExecution, next) => Promise<ToolExecutionResult>`；只能改 `exec.signal` |
| `tools/post-execute` | waterfall | `(exec, result, next) => Promise<PostToolDecision>`；`accept` 可换 content（或 value）/`block{feedback}`/附加 `additionalContexts` |
| `tools/result` | emit | `(exec, result)` 终态观察，失败被隔离 |
| `tools/ptc-dispatch-log` | waterfall | `run_code` 子调用**日志副本**的内容替换 |
| `tools/change` | emit | 注册/限制变化 |

**agent**（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:227-430`）：

| 事件 | 模式 | 载荷要点 |
|---|---|---|
| `agent/created` | serial | `{ agent, source:'startup'|'resume'|'clear'|'compact', signal? }`（每 agent 的 setup 已完成，可用于子 agent 单独注册守卫） |
| `agent/disposed` | emit | `{ agent }` |
| `agent/status` | emit | `{ agent, status:'idle'|'running' }` |
| `agent/inbox/inserted|claimed|discarded` | emit | `{ agent, message, turn? }` |
| `agent/pre-step` | waterfall | `{ agent, messages: UserMessage[], turn, step, signal }` → `PreStepDecision`（`reject` 或 `enter{messages, startsRequestSeries?}`） |
| `agent/request` / `agent/request-error` | waterfall | 改请求配置 / 处理失败重试 |
| `agent/assistant-stream` | emit | 流式帧 |
| `agent/turn-stopping` | serial | `{ agent, turn, signal }`；**要"拦住宣布完成"就在这里**：`agent.steer(userMessage)` 会重新打开 inbox（data 决定，不是返回值） |
| `agent/error` | emit | `{ agent, turn, step, error }` |

Agent 实时能力（runtime-types.d.ts:141-213，interface 合并到 `Agent`）：
`agent.session`（Session，可 `snapshotEvents()/ownEvents()/seq`）、`agent.inbox`、`agent.status`、`agent.ctx`、
`cancel(cause, opts?)`、`whenIdle()`、`runMaintenance(task)`、`send(message,target,wakeup)`、`followup(message)`、`steer(message)`、`inject(message)`。

**session**（`@deepseek-ai/dsh-session/lib/types/index.d.ts:41-69`）：`session/created`、`session/disposed`、`session/event`（每个已提交事件，durable feed）、`session/flush`（parallel，等待落盘，写自定义状态后主动 flush 用）。
Session 读：`session.snapshotEvents(fromSeq?, toSeqExclusive?)`、`session.ownEvents()`、`session.seq`、`session.header`。

**system-prompt**（`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:11-33`）：`system-prompt/assemble`（waterfall，`(assembly, context, next)`；`assembly = {sections, contexts, tools, variables}`）、`system-prompt/change`。

**其它**：`skills/change`、`commands/change`、`subagent/start|end`（`{runId,provider,id,local,stopReason?}`）、`plugin-manager/changed|install-log|install-state`、`hmr/change|hmr/reload`、`app-boot/config-reload`。

### 5.4 系统提示 `ctx.systemPrompt`

出处 same package。追加式（推荐，不改工具面 → KV cache 稳定）：

```ts
ctx.systemPrompt.section({
  name: 'flowgate:runtime', order: 9000,          // 唯一 name；order 升序拼接
  text: ({ scope }) => `当前阶段=${state.phase}；待办=${state.tasks.join(',')}`,
  // interpolate?: false 保留字面 {{...}}
})
ctx.systemPrompt.context({ name:'flowgate:snapshot', order: 300, text: '...' })  // 作为 user-role 运行时快照
ctx.systemPrompt.sectionOrder('TOOL_BASH') // getSectionOrder(name) 取官方预分配 order
```

预分配 order 常量：`HARNESS_IDENTITY:-1000, PLAN_POLICY:500, TEAM_POLICY:600, PTC_ONLY:800, TOOL_*:1000-3000, TOOLS_SDK:5000, DELIVERABLE_FILE_REFERENCES:9000, STRUCTURED_OUTPUT:9900, WEB_SURFACE:10100`（`system-prompt/lib/types/index.d.ts:159-200` 附近）。`complete:true` 的 section 会独占整个系统提示（一个有且只有一个）。

### 5.5 会话投影 `ctx.sessionProjections`

出处：`@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:38-190`；类型表 `types.d.ts:17-30`。

```ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { 'flowgate': FlowGateState }   // host 内部状态（纯 JSON）
  interface SessionProjectionMap      { 'flowgate': FlowGateWire }   // 发给 client 的整值视图
}

ctx.sessionProjections.register({
  key: 'flowgate',
  stateVersion: 1,                                  // 语义/字段变化就 +1，旧缓存会被丢弃
  stateSchema: z.object({ /* 与 FlowGateState 对应 */ }),
  init: (header, inheritedEventCount) => initialState,
  apply: (state, event) => {                        // 纯同步折叠；不关心的事件必须原引用返回
    if (event.type === 'flowgate/gate') return { ...state, ...event.data }
    return state
  },
  wire: {                                           // 省略 = host-only
    viewSchema: z.object({ /* FlowGateWire */ }),
    view: (state) => ({ phase: state.phase, pending: state.pending.length })  // 引用稳定时客户端不重渲染
  },
})   // 返回 disposer；注册是 effect，随插件 fiber 卸载消失
```

- 客户端读取（session scope 的 slot 组件标准套件）：`const phase = useProjection('flowgate')?.phase`（`@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts:80-99`；类型来自 `@deepseek-ai/dsh-api-session-controller/client` 的 `UseProjection`，`sessions/projection-store.d.ts`）。
- 非 React 路径：`ctx.sessions.<session>.projections.faceOf(key)`（`api-session-controller/lib/types/client/contract/session.d.ts:48-62`），identity-stable observable。
- 投影替代"面板轮询"：host 每提交一个事件折叠一次，按 `Object.is` 去重后推给 client。

### 5.6 会话日志写入（H6）

- 官方逃生舱：`appendPluginRecord(session, 'plugin:flowgate/gate', data)`（`@deepseek-ai/dsh-session/lib/types/index.d.ts:96-117`）。类型名必须匹配 `plugin:` + 小写 segment 语法；`data` 必须 losslessly JSON；事件标记 `ignorable`，不进模型可见面，fork/resume 会带上。声明合并 `PluginRecordMap` 获得类型。
  - 注意：官方注释写"只有 packages/experimental 的源码可调用（仓库内 gate）"，但函数本身是公开导出；第三方调用**运行时可行**，语义按"实验性、可丢弃记录"对待。
- 通用路径：`session.append(type, data)` **只接受已在 `SessionEventMap` 声明的类型**（`Session.append` 见 index.d.ts:277）；第三方要新增事件类型需要声明合并 `SessionEventMap`——但 Session 格式校验/迁移在宿主侧，新增类型有风险，**不要**用这条。推荐仍走 `appendPluginRecord` 或投影只从既有事件折叠。
- 需要"立刻落盘"时 `session.flush()` 或监听 `session/flush`。

### 5.7 技能 `ctx.skills`

出处：`@deepseek-ai/dsh-skill/lib/types/index.d.ts:200-260`。

```ts
// A) 运行时注册一个 skill（markdown 内容内联）
ctx.skills.register({ name:'flowgate-tdd', description:'...', body:'# ...' /* 其余字段见 SkillRegistration */ })
// B) 注册 provider（从磁盘/远端加载）
ctx.skills.registerProvider((control) => ({ name:'flowgate', list, get }))
```

更省事：**skill-only bundle**——不写 host 插件，只在 `cordis.patch.yml` 插一行 `@deepseek-ai/dsh-skill-filesystem`，`config.bundledSkillDir` 指到包内 `skills/` 目录（`@tt-a1i/archify-dsh` 实测用例，见 §3.4）。技能扫描 `~/.agents/skills` 与 `DSH_AGENTS_HOME/skills`。

### 5.8 子 agent：`ctx.subagents.startActivation`

出处：`@deepseek-ai/dsh-subagent/lib/types/index.d.ts:61-145`；`types.d.ts:25-52,127-174`。

```ts
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',                    // backend 名字；in-process spawn 官方名 'spawn'（README 示例）
  label: 'flowgate-review-1',
  childId,                              // 可选：预留本地 child 身份（本地 provider 才可用，保证 messageId）
  request: {
    parent,                             // 父 Agent（用 exec.agent）
    prompt: [{ type:'text', text:'...' }],   // ContentBlock[]
    cwd,                                // 可选：子 agent 初始工作目录（H21；沙箱需允许）
    agentPreset: 'flowgate-reviewer',   // 可选：独立 preset（spawn 支持；fork/外部 backend 拒绝）
    outputSchema,                       // 可选：ObjectJsonSchema root；成功后 SubagentResult.structured 给匹配值
    agentOptions: { model, provider, reasoningEffort, maxTokens },  // 可选
    maxDepth: 1,                        // 可选
    signal: exec.signal,
  },
  signal,                               // 发布前取消；发布后的取消走 dispose()
  delivery: 'caller',                   // 'parent' = 结果回模型；'caller' = 只有调用方拿到
})
activation.result            // Promise<SubagentResult>：{ stopReason, output, structured? , ... }
await activation.dispose()   // 停止并释放；**必须**在 finally 里调用
ctx.subagents.sendMessage(...) // 同进程父子之间继续对话（本地 child 可续）
```

读子 agent 会话事件（H24）：`ctx.sessionQuery`（`@deepseek-ai/dsh-session-query/lib/types/index.d.ts:24-110`）
`readSession(sessionId): Promise<SessionLogSnapshot>`、`listEvents(sessionId)`、`observeSession(...)`、`searchEvents(...)`。子 agent 的 `sessionId` = `activation.childId`。
生命周期事件：`subagent/start` / `subagent/end`（scoped 到 delegating parent）。

---

## 6. Client（浏览器）扩展点

### 6.1 client 插件对象

```ts
// src/client.tsx
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
export const name = 'dsh-flowgate'
export const inject = ['slots', 'sidebarRightTabs']   // 客户端服务名
export function apply(ctx: Context) { /* 注册插槽 */ }
```

客户端 `Context` 关键服务：`ctx.slots`、`ctx.sidebarRightTabs`、`ctx.sessions`、`ctx.remote`、`ctx.layout`、`ctx.conversation`、`ctx.uiSession`、`ctx.locale`、`ctx.modules`。

### 6.2 插槽 `ctx.slots.register`

出处：`@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:551-810`（两套重载：带/不带 `inject` 业务面）。

```ts
ctx.slots.register(
  {
    name: 'conversation.input.dock',   // 目标插槽
    id: 'flowgate-status',             // list 插槽每项身份（同 id+同 priority 重复注册会抛）
    order: 50,                         // list 排序
    label?: string | (() => string),
    priority?: number,                 // 单元格遮蔽秩（single/keyed 冲突时用）
    locale?: 'flowgate',               // 声明后组件获得 t()
    inject?: (params) => ({ ... }),    // 业务面工厂（组件 props 获得这些字段）
    children?: { ... },                // 声明子插槽（声明即独占渲染权；组件必须消费 renderSlot）
    store?: ...,                       // 共享/独占 store 座位
  },
  Component,
)   // 返回 disposer
```

组件 props 组成（`PropsRuntime`，index.d.ts:218-226）：owner props + key props + inject 面 + **scope 标准套件**。
- `conversation.input.dock`：`kind:'list', scope:'session', owner: InputZone`（`client-ui-conversation/lib/types/client/contract/slots.d.ts:301-305`）。session 标准套件 = `sessionId / useSession / useProjection / useAccess`（`client-ui-session/lib/types/client/index.d.ts:80-89`）；`owner` 是输入区共享状态（InputZone，含 draft 等）。
- 其他有用插槽：`conversation.input.left/right/activity/overlay`、`conversation.composer.dock`、`settings.section`、`shell.overlay`、`sidebar.workspaces`、`plugins.bundle.config`。

### 6.3 右侧栏 tab（两段式）

出处：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:75-164`、`contract/slots.d.ts:53-206`、`client/index.d.ts:21-33`。

```ts
// stage 1: 这个 tab 类型是什么（静态）
const disposeType = ctx.sidebarRightTabs.register({
  id: 'flowgate-panel',            // 全局唯一实现身份；stage2 的 key 就是它
  kind: 'flowgate.panel',          // 类型判别键，openTab(kind) 用
  multiple: false,                 // 每次打开同一 kind 是否独立内容
  keepMounted: true,               // 可选：隐藏/换会话时保活
  priority: 'extension',           // 'extension' | 'builtin' | 'fallback'（第三方默认 extension，优先级最高）
  patterns: undefined,             // 可选：资源地址 glob（识别 dsh-resource:// 等）
  title: (address) => 'FlowGate',  // tab chip 文案
  guide: [{ id:'flowgate', order:100, title:()=>'FlowGate', description:()=>'流程门禁面板' }],
})
ctx.effect(() => disposeType)

// stage 2: body（keyed 插槽，key = 定义 id）
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'flowgate-panel' }, FlowGatePanel)
// 可选：动态标题
ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'flowgate-panel' }, FlowGateTitle)
```

- 同 kind 的 `builtin` 可被 `extension` 接管，卸载后回退；同 band 二次注册/重复 id 抛错。
- 打开 tab：`ctx.sidebarRight.openTab({ kind:'flowgate.panel', ... })`（controller 在 `client/index.d.ts` 导出类型；具体方法见 `service.d.ts`）。
- 若你要做"整个右侧栏"（8 个视图自己管），也可以接管 `rightbar`（single/root，occupant 是 `ui-sidebar-right`）——成本高，FlowGate 不需要。

### 6.4 调宿主：Typert Remote（真义 + 成本）+ 兜底

**结论：Typert Remote 可行但需要构建期代码生成，M0/M1 不建议。**

真源：`@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts:439-520`；`@deepseek-ai/dsh-typert-generator` README。

- Host：Service 类 `extends TypertRemoteService`（`typert-protocol/lib/types/index.d.ts:105-115`），方法加 `@Remote(...)` 装饰器（SRC 模式），或直接用构建期生成物：包 `exports["./typert"]` 指向 `lib/typert.host.js`（导出 `TYPERT` 贡献 + `TYPERT.invocations`）。
- Client：包 `exports["./remote"]` 指向生成物 `lib/typert.remote-client.js`（`TYPERT_REMOTE` + `declare module` 合并 `TypertRemoteMap`/`TypertRemoteNamespaceMap`/`TypertRemoteScopeMap`）；随后用 `ctx.remote['flowgate/approve'](...)` 调用，结果 `RemoteResult<T>`（ok/fail 判别）。`ctx.remote` 由 `@deepseek-ai/dsh-api-gateway/client` 提供（`api-gateway/lib/types/client/index.d.ts:41-44`）。
- 生成：`@deepseek-ai/dsh-typert-generator/tsdown` 的 `typertPlugin()`；每方法一个 `TypertRemoteMethodSpec`，参数/结果各带 **`codec` 与 `strictCodec`**，每个 codec spec = `TypertRemoteCodecSpec { mode:'strict', typeSymbol, create: () => ZodType, decode?/encode? }`（`typert-protocol/lib/types/types.d.ts:489-520`）——即任务里说的 "create + schema"：`create()` 返回带 `parse` 的 Zod schema（`TypertRemoteValue`，同文件 439-448）。
- `dsh-typert-loader` 会自动发现已加载包的 `./typert` 导出并 `ctx.typert.register()`（`dsh-typert-loader` README：「没有该导出的包会被静默跳过」），所以**插件不需要自己注册**。
- 生成器要求包内 face 聚合 tsconfig（`tsconfig.host.json` + `packages/` workspace 根）→ 对单包第三方项目不友好；实测量级：`dsh-api-gateway` 的 client 面就靠它。

**推荐兜底（FlowGate 面板按钮）**：
1. 按钮 → 面板已知当前 `sessionId`（session scope props）→ 走命令：在客户端没有"命令 Remote"之前，最稳的是**把命令文本填进输入框**（`ctx.conversation` 的 `InputActions`/draft 接口，见 `client-ui-conversation/lib/types/client/contract/input.ts`），用户回车即触发 `/flow approve T3`，命令 handler 直接改状态。
2. 或面板自己写 `ctx.sessions.prompt([{type:'text',text:'/flow status'}], 'queue')`？注意：prompt 进的是**模型会话**，不是命令执行——不可行。
3. 因此：人工动作面板 = 按钮填斜杠命令 / 或后续接 Typert。**不要**为了面板按钮在 M0 引入生成器。

---

## 7. 开发与联调工作流

### 7.1 link 安装到隔离 profile（不要碰 `~/.dsh/profiles/desktop`）

```bash
# 1) 建开发 profile（DSH_HOME 隔离，绝不改日常 profile）
export DSH_HOME=/tmp/dsh-flowgate-dev
"$DSH_APP/Contents/Resources/runtime/cli/bin/dsh" --profile flowgate --from-default-profile web --help  # 触发 profile 初始化（--help 不启动服务）
# 2) 把插件 link 进该 profile（两种等价）
cd "$DSH_HOME/profiles/flowgate"
pnpm add link:/Users/chtholly/Developer/WorkSpace/dsh-flowgate      # plugin-manager/CLI 推荐 spec
# 或者在 profile/package.json 的 dependencies 写 "dsh-flowgate": "link:/abs/path"，再 pnpm install
# 3) 在 profile/cordis.patch.yml 插入自己的行（或让插件 bundle patch 生效：把包名加进 dsh.profile.bundles）
# 4) 组合校验（不启动、不导入插件）
"$DSH_APP/.../bin/dsh" --profile flowgate --dump-config | grep -A3 flowgate
# 5) 导入/激活校验（会 import 每个组合模块，只对可信 profile 用）
"$DSH_APP/.../bin/dsh" --profile flowgate --dump-config-schema > /tmp/schema.json
# 6) 真正启动（会占用端口，务必 timeout/后台 + kill）
"$DSH_APP/.../bin/dsh" --profile flowgate &   # 然后从日志确认 apply() 被执行
```

- 源码开发时 `link:` 安装即可；`pnpm run build` 后需要重启或依赖 HMR（见 §7.2）。
- `dsh plugin --profile <name> add <spec>` 是 CLI 内置包管理（走 pnpm，会改 profile 的 package.json/lockfile）。开发 checkout 场景它提供的是 `link:<abs dir>`。
- **别名/独占**：一个 profile 里不要同时装两个同 id 插槽实现（如右侧栏接管者），会激活失败（codex-ui 的 patch 注释就是先 `disabled` 官方 `ui-sidebar`/`ui-settings-general`）。

### 7.2 HMR

- 启动器给 base 组合包启用 `dsh-hmr`（web profile 默认开）；它监视 profile manifest 与用户 patch 文件，并（配置 `root` 后）监听源码模块替换。
- **默认 `root: []` 只做配置热重载**。要模块热替换，在 profile patch 里给它配置（`dsh-hmr` README L27-36）：
  ```yaml
  - id: hmr
    config: { root: ['/Users/chtholly/Developer/WorkSpace/dsh-flowgate'] }
  ```
- 已安装包的 `lib/` 文件原地变化也会在下一次 recompose 时生效（含 link 包）。改 client bundle 后页面需要重新拉取（graph rev 由 mtime/ctime/size 决定，会换 URL；必要时刷新页面）。
- HMR 只会替换经 Loader 导入的模块；纯运行时 `import()` 的代码不保证。

---

## 8. FlowGate 落地建议（映射 03 方案）

> 完整的 03 §2 接口 ↔ 本表章节映射。

| 03 需求 | 本表章节 | 结论 |
|---|---|---|
| 写操作硬拦截 | §5.2 guard | ✅ |
| 风险转人工 | §5.2 guard（返回 reason）/ §5.1 命令 | ✅（命令处理器里人工放行） |
| 事后检测/证据 | §5.3 tools/post-execute & tools/result | ✅（content/value 都能读；见 §10-H5/H19） |
| 调用前后快照 | §5.3 tools/execute | ✅（wrapper 里 `await snapshot(); const r = await next(); await snapshot()`） |
| 测试输出压缩 | §5.3 post-execute `accept{content}` | ✅ |
| 每步注入状态 | §5.4 systemPrompt.section / pre-step | ✅（推荐 systemPrompt.context + pre-step 兜底） |
| 拦住宣布完成 | §5.3 agent/turn-stopping + `agent.steer` | ✅ |
| 中途通知 agent | `inv.agent.inject` / `agent.inject` | ✅ |
| 结构化提问 | `ask_user_question`（tool-bash 同族：tool package `dsh-tool-ask-user`） | ✅（H13 细节见 §10） |
| 人工专属动作 | §5.1 commands | ✅ |
| 会话内状态 | §5.5 projections + §5.6 appendPluginRecord | ✅ |
| 跨会话状态 | 宿主 fs | ✅ |
| 模型工具 | §5.2 | ✅ |
| 技能 | §5.7 两种 | ✅ |
| 审查/派发子 agent | §5.8 | ✅ |
| 会话生命周期 | session/disposed + agent/disposed | ✅ |
| 工程模式/preset | §3.3 | ✅ |
| 关委派/原生模式 | §5.2 restrict/presentAs | ✅ |
| 读子 agent 事件 | §5.8 sessionQuery | ✅ |
| 右侧栏/输入框 | §6.2/6.3 | ✅ |
| 面板调宿主 | §6.4 | ⚠️ 需 Typert 生成；兜底填命令 |
| 崩溃不丢状态 | checkpoint-policy + 投影 stateSchema | ✅（纯 JSON 状态会被持久化缓存） |
| token 用量 | `dsh-token-meter`（`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.d.ts`） | 未实测 |

---

## 9. spike 实测证据（可复现）

目录：`spike/`（我独占写入，允许后续删除/替换）。产物已提交进 workspace：

| 文件 | 作用 |
|---|---|
| `spike/package.json` | 完整 `dsh` 清单：`manifestVersion` / `bundle.patch` / `client.platform+inject` / `engines.dsh` |
| `spike/cordis.patch.yml` | 插入插件行 + 一个 `flowgate` preset（含只读工具示例） |
| `spike/src/index.ts` | host 入口：`/flow` 命令、`flow_status` 工具、guard、5 个事件监听、`presentAs('native')`、systemPrompt.section |
| `spike/src/client.tsx` | client 入口：`conversation.input.dock` + 右侧栏两段式注册 |
| `spike/tsdown.config.ts` | tsdown 0.23 双入口（ESM host + CJS client） |
| `spike/scripts/stamp-client.mjs` | 把 CJS 产物包成 `window.__ModuleLoader__.load({id, factory})` |
| `spike/verify-host.mjs` | 进程内 cordis 加载，用 fake services 断言注册 |
| `spike/verify-client.mjs` | mock 模块表 + fake react/ctx，断言 client bundle 与插槽注册 |

### 9.1 构建（实测通过）

```bash
cd spike
npm install                 # 已装 @deepseek-ai/cordis@4.0.5、@deepseek-ai/dsh-tools@0.2.1-rc.5、tsdown@0.23.4
npm run build               # tsdown + stamp-client → lib/index.js（ESM）+ lib/client.js（loader 包装）
```

产物核对：

```
lib/index.js    135: export { apply, inject, name };
lib/client.js   window.__ModuleLoader__.load({ id:"dsh-flowgate-spike", factory:(require)=>{...
                client requires: require("react")  ← 模块表 baseline
```

### 9.2 host 半侧加载验证（**成功**）

```bash
cd spike && node verify-host.mjs
```

实际输出（节选）：

```
[plugin.log] [flowgate-spike] apply() 进入，markerPath = .flowgate/config.yaml cwd = .../spike
=== 注册结果 ===
commands = [ 'flow' ]
tools    = [ 'flow_status' ]
guards   = 1
presentAs= [ 'native' ]
sections = [ 'flowgate:spike' ]
=== /flow handler 返回 ===
{"kind":"success","text":"FlowGate spike 命令可用。...","observed":...}
[plugin.log] [flowgate-spike] guard: name=bash agent=session-abc callId=call-1
             args={"command":"git status --short","description":"check status","timeoutMs":null,"workdir":null}
OK: host 入口可加载，/flow 命令 + flow_status 工具 + guard + systemPrompt.section 均注册成功
```

### 9.3 真实 DSH CLI 加载验证（**成功**，隔离 DSH_HOME）

```bash
# 造一个只有我们插件的隔离 profile（绝不碰 ~/.dsh/profiles/desktop）
mkdir -p /tmp/fg-home/profiles/spike
cat > /tmp/fg-home/profiles/spike/package.json <<'J'
{ "name":"dsh-profile-spike", "private":true, "dsh": { "profile": { "bundles": [] } } }
J
cat > /tmp/fg-home/profiles/spike/cordis.patch.yml <<'Y'
- insert:
    - id: flowgate-spike
      name: /Users/chtholly/Developer/WorkSpace/dsh-flowgate/spike/lib/index.js
Y

export DSH=/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh
DSH_HOME=/tmp/fg-home "$DSH" --profile spike --dump-config
DSH_HOME=/tmp/fg-home "$DSH" --profile spike --dump-config-schema
```

实测结果：
- `--dump-config` 输出（证明 patch 组合生效、相对/绝对路径被规范成 file URL）：
  ```yaml
  # == /tmp/fg-home/profiles/spike/cordis.patch.yml
  - id: flowgate-spike
    name: file:///Users/chtholly/Developer/WorkSpace/dsh-flowgate/spike/lib/index.js
  ```
- `--dump-config-schema` 退出码 0、stdout 10.5KB JSON，内容含 `flowgate` 5 处（该命令会**导入**每个组合模块读 Config schema → 证明真实 DSH 进程能 import 我们的 host 入口）。

> 未验证（成本/风险高，明确标注）：用 DSH 启动 web 服务加载 client bundle 到浏览器（需要可用的完整 web profile + 端口，且桌面 profile 不可动）。client bundle 的合法性目前用 §9.4 的离线 mock 验证 + 与真实第三方产物逐字节对照形态。

### 9.4 client 半侧验证（**成功**，离线 mock）

```bash
cd spike && node verify-client.mjs
```

输出：

```
=== loader id === dsh-flowgate-spike
=== client plugin 导出 === [ 'apply', 'inject', 'name' ] | name = dsh-flowgate-spike | inject = ["slots","sidebarRightTabs"]
=== slots 注册 ===
   {"name":"conversation.input.dock","id":"flowgate-status","order":50} component = function
   {"name":"sidebar.right.pane.tab","key":"flowgate-panel"} component = function
=== sidebarRightTabs 注册 ===
   {"id":"flowgate-panel","kind":"flowgate.panel","multiple":false,"guide":[...]}
OK: client bundle 形态合法，dock 与右侧栏 tab 注册路径正确
```

---

## 10. 与 03 方案的冲突 / 纠正（硬事实）

1. **`package.json` 没有 host/client 入口字段**。03 §13 若写了"dsh.host / dsh.client.entry"之类，改为：host=`main`，client=`exports["./client"]`，`dsh.client` 只有 platform/inject/immediately/external。
2. **`engines.dsh` 不会被强制校验**。官方 `dsh-package-manifest` README 明确："installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts"（`dsh-package-manifest/README.zh.md` 已知限制节）。但 `dsh.bundle.patch` 的**组合包**在 profile 重载时会做版本兼容预检（`dsh-app-boot` README L54），不兼容会被跳过并列入 `skippedBundles`。→ H15 结论：写法合法但不可依赖它拦截；兼容声明建议 + 运行时自检。
3. **会话自定义事件不能随意 `session.append(type, data)`**。只能 `appendPluginRecord(session, 'plugin:<name>/<record>', data)`（实验性），或从既有事件折叠投影。03 的 `session.append` 直写方案要改。
4. **右侧栏不是"注册一个 slot 组件"**，而是 `sidebarRightTabs.register` + `sidebar.right.pane.tab`(keyed) 两段式；`ctx.slots.register({name:'sidebar.right.pane.tab', key})` 的 key 必须是 tab 定义的 `id`。
5. **面板调宿主 Typert Remote 不是"写个方法就通"**：需要生成器与 `./typert`/`./remote` 构建产物。03 的 H10 与 §2 "40 个 Remote 方法"要按"先兜底填命令、M2 再上 Typert"重排。
6. **`ToolsTool.presentation` / `presentAs` 是 scoped-only**：只能在 agent scope（或 preset 的 standing 声明）里调用，plain root ctx 调用无效/报错。
7. **`restrict({deny})` 只过滤继承的全局工具**，不影响该 scope 自己注册的工具（即：想禁"原生委派"，子 agent 自己注册的同名工具仍可见）。守卫作为第二层是必需的，03 §2.4 的方向是对的。
8. **`agent/turn-stopping` 没有返回值**，要拦住必须调 `agent.steer(...)`（数据驱动），不存在"return false 阻止结束"。
9. **`tools/post-execute` 替换 content 后，durable log 记的是替换后的内容**（`tool/result` 事件由规范化后的结果产生）；"原始输出仍能从会话日志读到"**不成立**，需要插件自己落全文（H19 的备选方案）。
10. **`tool-fs` 只读靠 config**：`{ read:true, write:false, edit:false }`（不是 restrict），这是 H25 "只读取证 preset 的文件工具可配置为只读"的肯定答案。

---

## 11. 25+ 条关键假设（对应 03 §15 H1–H26）逐条结论

| # | 结论 | 证据 / 说明 |
|---|---|---|
| H1 | ✅ **确认** | `ToolGuard = (exec: Readonly<ToolExecution>) => string \| undefined`（dsh-tools index.d.ts:522）；`ToolExecution` 含 `name`、`arguments: unknown`（解析后的 JSON 参数）、`agent?`、`callId`、`rootCallId`、`signal`（同文件 216-300）。内置工具参数名：`bash.command`、`write/read/edit.file_path`（asar 内 `dsh-tool-bash`/`dsh-tool-fs` 的 `defineTool({name, parameters})` 源码；`npm pack` 版无 JS，用 asar 版）。spike 实跑 guard 收到 `{name:'bash', arguments:{command:'git status --short'}, agent:{id}}`（§9.2） |
| H2 | 🟡 **代码层确认，未跑 PTC** | PTC 子派发走同一 pipeline：`ToolExecutionInput.parent` 注释（index.d.ts:231-247）说明嵌套调用经 `ToolRuntime.execute`；guard 在派发前统一评估。工程模式另有 `presentAs('native')` 兜底，风险低 |
| H3 | ✅ **确认** | plain-context 注册的 guard "applies globally"；`agent.ctx` 注册的 "applies only to that agent"（index.d.ts:616-630）。全局 guard 必然覆盖子 agent 的工具调用；`exec.agent` 可区分来源（H18） |
| H4 | ⚠️ **未验证** | MCP 工具也走 `ctx.tools` 注册/分发（`dsh-mcp-client` 组合），推断成立；未读 MCP 包源码确认 |
| H5 | ✅ **确认（有细节）** | `tools/post-execute` 收到 `ToolExecutionResult`：`{isError, value, content, error?}`（index.d.ts:395-435），bash 的 stdout/stderr/`[exit code: N]` 在 `content`/`value` 里；退出码也能从 content 文本解析或由工具 value 提供 |
| H6 | ✅ **确认（替代路径）** | `appendPluginRecord(session,'plugin:gate',data)`（dsh-session index.d.ts:96-117）+ 投影 `apply` 折叠任意 committed event；`session.append` 不能写未声明类型（§10-3） |
| H7 | ✅ **确认** | `ctx.systemPrompt.section/context` 是追加式（system-prompt index.d.ts:56-120）；`agent/pre-step` 可返回 `enter{messages}`（agent runtime-types.d.ts:304-320） |
| H8 | ✅ **确认（含读最后文本方式）** | `agent/turn-stopping` payload `{agent,turn,signal}`（runtime-types.d.ts:387-400）；用 `agent.steer(userMessage)` 续轮；最后 assistant 文本 = `agent.session.snapshotEvents()`/`ownEvents()` 末尾的 `assistant/message` |
| H9 | ✅ **确认** | `ctx.commands` 服务 + web/desktop 组合含 `dsh-client-ui-commands`（asar 包清单）；handler 内可 await + 访问宿主服务 + `inv.agent.inject/steer` |
| H10 | 🟡 **可行但需生成器**；建议兜底 | §6.4；Typert loader 自动发现 `./typert`（dsh-typert-loader README） |
| H11 | ✅ **确认** | `conversation.input.dock`（conversation contract/slots.d.ts:301）与 `sidebar.right.pane.tab`（sidebar-right contract/slots.d.ts:53）声明均在；spike 两处注册离线验证通过 |
| H12 | ✅ **确认** | `startActivation.request.outputSchema`（ObjectJsonSchema）+ `agentPreset`（本包 types.d.ts:127-174）；只读 preset 用 tool-fs config 关写、或 `restrict` |
| H13 | 🟡 **工具存在，载荷未验** | `ask_user_question` 工具存在（asar `dsh-tool-ask-user` 的 tool name 常量）；问答应进 `tools/result` 的 content/value，但具体结构化字段没验证 → 门禁建议同时校验 `clarify.md` 产物（03 的备选） |
| H14 | ⚠️ **未验证** | `@deepseek-ai/dsh-token-meter` 存在，`usage-projection.d.ts` 提供 usage 投影；读取路径未实测 |
| H15 | ❌ **依赖它拦截不成立** | 官方明确 `engines.dsh` 声明式、loader 不强制（dsh-package-manifest README 已知限制）；组合包预检只在 bundle 层（§10-2） |
| H16 | 🟡 **大概率成立，未实测** | 宿主插件是普通 Node 进程代码，直接用 `node:fs`；沙箱只作用于工具执行器（`dsh-sandbox*`）。建议：密钥/状态写 `$DSH_HOME` 或项目 `.flowgate/`，不要把密钥写进工作区 |
| H17 | ✅ **确认（代码层）** | `tools/execute` waterfall：`(exec, next) => Promise<ToolExecutionResult>`，注释明确 "wrappers may change only exec.signal"（index.d.ts:40-50），即在 `await next()` 前后可做任意异步工作（快照） |
| H18 | ✅ **确认** | guard 收到 `exec.agent`（含 id）；scoped guard/vs global 的语义见 index.d.ts:616-630；`callId/rootCallId` 可在并行时归属 |
| H19 | ❌ **后半句不成立** | post-execute `accept{content}` 替换后，durable 记录的是替换后的结果（`tool/result` 是规范化后结果）；原始输出需插件自己落文件（03 的备选） |
| H20 | ✅ **确认** | `startActivation` 返回 `activation.result`（`Promise<SubagentResult>`）、本地 child 可 `sendMessage` 续聊/冷恢复（README L61-65）；`delivery:'caller'` 可 await 结构化结果 |
| H21 | 🟡 **接口确认，沙箱未验** | `SubagentStartRequest.cwd`（types.d.ts:127-135）；沙箱允许范围由 `dsh-sandbox-policy` 配置决定，需在目标 profile 配置允许 worktree 路径 |
| H22 | ✅ **确认** | 每次调用带 `agent`/`callId`；tools 事件按 scope 过滤；并行调度由 agent-loop（`DEFAULT_MAX_PARALLEL_TOOL_CALLS`）控制，事件层可归因 |
| H23 | ✅ **确认** | 会话开始即触发 `agent/created`/`session/created`/`system-prompt/assemble`；首步之前 `agent/pre-step` 已可注入；关闭释放用 `session/disposed`/`agent/disposed` |
| H24 | ✅ **确认** | `ctx.sessionQuery.readSession/listEvents/observeSession`（session-query index.d.ts:24-110）；`activation.childId` 即会话 id |
| H25 | ✅ **确认（纠正写法）** | preset 行见 §3.3；"文件工具只读"用 `dsh-tool-fs` config `write:false,edit:false`（tool-fs index.d.ts:14-31），不是 restrict |
| H26 | ✅ **确认** | `restrict({deny})`（tools index.d.ts:645）、`presentAs('native')`（610）均存在且 scoped；注意 restrict 只过滤继承的全局工具（§10-7），守卫兜底必需 |
| H2'(新增) | ✅ `tools/pre-execute` 可替代 guard | waterfall 返回 `{kind:'deny', reason}`（index.d.ts:445-463）——但它是 waterfall，**可被后续 listener 改写**，硬门禁用 `guard` 更稳 |
| H3'(新增) | ✅ `tools/change` 可追踪工具面变化 | index.d.ts:102 |

---

## 12. 给 host-impl 的最小代码骨架（可直接落 `src/host/`）

```ts
// src/host/index.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-flowgate'
export const inject: string[] = []           // 用 ctx.inject 接可选服务，避免强耦合
export interface Config { markerPath?: string }

export function apply(ctx: Context, config: Config = {}) {
  // 0) 挂载期：从 cwd 找 .flowgate/config.yaml，未初始化就只登记命令（不拦工具）
  // 1) 命令族
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register({ name: 'flow', description: 'FlowGate', input: { hint: 'init|status|approve <id>' },
      handler: async ({ rawInput, agent }) => ({ kind: 'success', text: await engine.handle(rawInput, agent) }) })
  })
  // 2) 守卫（全局、单调）
  ctx.inject(['tools'], (ctx) => {
    const dispose = ctx.tools.guard((exec) => engine.guard(exec))   // 返回 reason → 拒绝
    ctx.effect(() => dispose)
    ctx.tools.register(...defineTool(flowStatusTool))
  })
  // 3) 事件：pre-step/turn-stopping/post-execute/result/session disposed
  ctx.on('agent/turn-stopping', ({ agent }) => engine.onTurnStopping(agent))
  ctx.on('tools/post-execute', async (exec, result, next) => engine.onPost(exec, result) ?? next())
  // 4) 系统提示（追加）
  ctx.inject(['systemPrompt'], (ctx) =>
    ctx.systemPrompt.section({ name: 'flowgate', order: 9000, text: () => engine.promptText() }))
  // 5) 投影（panel/状态条数据源）
  ctx.inject(['sessionProjections'], (ctx) => ctx.sessionProjections.register(flowgateProjection))
  // 6) 子 agent：审查/派发用 ctx.subagents.startActivation(...)
}
```

## 13. 给 client-ui 的最小代码骨架（可直接落 `src/client/`）

```tsx
// src/client/index.tsx
import React from 'react'
export const name = 'dsh-flowgate'
export const inject = ['slots', 'sidebarRightTabs']

const Dock = ({ useProjection }: { useProjection: Function }) => {
  const v = useProjection('flowgate') as { phase?: string; pending?: number } | undefined
  return <div className="flowgate-dock">FlowGate · {v?.phase ?? '未启用'}{v?.pending ? ` · 待办 ${v.pending}` : ''}</div>
}

const Panel = ({ sessionId, useProjection }: any) => {
  const v = useProjection('flowgate')
  return <div style={{ padding: 12 }}>…{v?.phase}…</div>
}

export function apply(ctx: any) {
  ctx.slots.register({ name: 'conversation.input.dock', id: 'flowgate-status', order: 50 }, Dock as never)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'flowgate-panel', kind: 'flowgate.panel', title: () => 'FlowGate', multiple: false,
    guide: [{ id: 'flowgate', order: 100, title: () => 'FlowGate' }],
  }))
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'flowgate-panel' }, Panel as never)
}
```

---

## 14. 复现清单（从零到"加载成功"）

1. `npm pack @deepseek-ai/*@0.2.1-rc.5` 并解包（§1）；
2. 写 `package.json`（§2）+ `src/index.ts` / `src/client.tsx`（§12/§13）+ `cordis.patch.yml`（§3.2）；
3. `npm i -D tsdown@0.23 typescript` + `npm i @deepseek-ai/cordis @deepseek-ai/dsh-tools`（dev 依赖；发布时改为 peerDependencies，不打包）；
4. `npm run build`（§4.3 + stamp）；
5. `node verify-host.mjs` / `node verify-client.mjs`（§9.2/9.4）；
6. 隔离 profile + `--dump-config` / `--dump-config-schema`（§9.3）；
7. 最后才在**隔离的** `DSH_HOME` 里真正启动 web（另开端口，timeout 管理），从日志确认 `apply()`。

