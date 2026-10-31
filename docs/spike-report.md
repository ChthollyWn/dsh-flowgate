# M0 探针报告：DSH 0.2.1-rc.5 扩展点实测

> 任务卡：T0.2（扩展点探针）。日期：2026-10-30。基线：DeepSeek Harness `0.2.1-rc.5`（桌面端自带）。
> 结论级别：**成立 / 部分成立 / 不成立**；"部分成立"写明采用的替代方案。
> 完整证据（d.ts 出处行号、spike 产物、复现命令）见 [impl/dsh-plugin-api-cheatsheet.md](impl/dsh-plugin-api-cheatsheet.md)。

## 结论摘要（能开工 / 要改方案）

**可以按原方案实施。** 硬门禁依赖的 4 个关键接口全部成立：守卫能读到工具名与参数（H1）、工具有 pre/execute/post 三段流水线（H5/H17/H19）、命令可异步且不进模型消息（H9）、子 agent 可带 preset/cwd/结构化输出启动（H12/H20/H21）。**要改的只有 3 处**：

1. **H10 面板直接调宿主（Typert Remote）不做**：需要构建期生成器与双份 codec 产物。改用计划里的兜底：面板按钮把 `/flow ...` 命令填进输入框（人工动作本来就只允许人触发）。
2. **H6 会话自定义事件改为 `appendPluginRecord`**：`session.append` 不能写未声明事件类型；用 `appendPluginRecord(session, 'plugin:dsh-flowgate/state', data)`，投影 `apply` 按事件类型字符串折叠。
3. **H19 的后半句不成立**：`tools/post-execute` 替换内容后，durable 会话日志记录的是替换后的内容；原始输出必须由插件自己落盘（`.flowgate/state/evidence/*.log`），这正是 03 方案里的做法。

另有 **H15（engines.dsh 拦截）不成立**：官方声明该字段不被强制校验，只能作为声明；兼容性靠 `scripts/verify-dsh-compat.mjs` 主动验证。**H13/H14 部分成立**：`ask_user_question` 问答载荷未完全验证，因此 G1 以 `clarify.md` 产物为准确认访谈质量；token 用量读取路径未实测，指标按 FR-10.4 降级为"未知"。

## 逐条结论（H1–H26）

| # | 假设 | 结论 | 证据 / 替代方案 |
|---|---|---|---|
| H1 | 守卫能读到 write/edit 目标路径、bash 命令文本 | **成立** | `ToolGuard = (exec) => string \| undefined`；`exec` 含 `name/arguments/agent/callId/rootCallId/signal`。spike 实跑收到 `{name:'bash', arguments:{command:'git status --short'}, agent:{id}}`。内置工具参数名：`bash.command`、`write/read/edit.file_path` |
| H2 | PTC 嵌套调用经过守卫 | **部分成立（代码层确认，未跑 PTC）** | 嵌套调用走同一 `ToolRuntime.execute`；受管控会话强制 `presentAs('native')` 关闭 PTC，风险已规避 |
| H3 | preset 启动的子 agent 经过同一守卫 | **成立** | plain-context 注册的 guard 全局生效，覆盖子 agent；`exec.agent` 可区分来源 |
| H4 | MCP 工具经过守卫 | **部分成立（推断）** | MCP 工具同样注册在 `ctx.tools`；未读 MCP 包源码。兜底：未分类工具一律转人工 |
| H5 | `tools/post-execute` 能读到 bash 输出与退出码 | **成立** | post-execute 收到完整 `ToolExecutionResult`（content/value），退出码在 content 文本与 value 中 |
| H6 | 能写插件自定义会话事件，投影能折叠 | **部分成立** | `session.append` 只接受已声明类型；改用 `appendPluginRecord(...'plugin:*')`，投影 `apply` 折叠 |
| H7 | `agent/pre-step` / `systemPrompt.section` 可追加注入 | **成立** | `systemPrompt.section/context` 追加式；`agent/pre-step` 返回 `enter{messages}` 可追加；KV cache 友好 |
| H8 | `agent/turn-stopping` 能 steer 并读到最后 assistant 文本 | **成立** | 事件载荷 `{agent,turn,signal}`；`agent.steer(userMessage)` 续轮；最后消息从 `session.snapshotEvents()` 读 |
| H9 | 命令在 Desktop / Web 可用，handler 能调用宿主服务 | **成立** | `ctx.commands.register`；handler 可 async，返回 `{kind:'success',text}`；命令只进 `command/*` 日志事件，不进模型消息 |
| H10 | 面板经 Typert Remote 调宿主 | **部分成立（不做）** | 需构建期生成器 + `./typert`/`./remote` 产物。兜底：按钮把命令填进输入框 |
| H11 | dock 与右侧栏 tab 可注册 | **成立** | `conversation.input.dock`（list/session）；右侧栏两段式：`sidebarRightTabs.register` + `slots.register({name:'sidebar.right.pane.tab', key})`。spike 离线验证通过 |
| H12 | 能创建只读、结构化输出的审查子 agent | **成立** | `startActivation({request:{agentPreset,outputSchema}})`；只读用 `dsh-tool-fs` config `{read:true,write:false,edit:false}` |
| H13 | 主 agent 的 ask_user_question 问答可观测 | **部分成立** | 工具存在、结果进 `tools/result`，结构化字段未逐项验证；G1 同时校验 `clarify.md` 产物作为准确认 |
| H14 | `dsh-token-meter` 可读 | **部分成立（未实测）** | 包与 usage 投影存在，读取路径未验证；指标降级为"未知"，不参与平均 |
| H15 | `engines.dsh` 范围写法能通过兼容检查 | **不成立（不依赖它拦截）** | 官方明确声明式字段不被 loader 强制；只有组合包层做版本预检。改由 `verify-dsh-compat.mjs` 主动验证并写 `docs/compat/` |
| H16 | 宿主进程写文件不受沙箱限制 | **成立（大概率）** | 宿主插件是普通 Node 代码；沙箱只作用于工具执行器。密钥/证据写 `.flowgate/` 与 `$DSH_HOME` |
| H17 | `tools/execute` 可在调用前后做异步快照 | **成立** | waterfall 包装层 `(exec, next)`，`await next()` 前后均可异步工作 |
| H18 | 守卫能区分调用方 agent | **成立** | `exec.agent` + `callId/rootCallId`；并行时可按 agent 归属 |
| H19 | post-execute 替换后模型只看到摘要、原始输出仍可读 | **部分成立** | 替换后 durable 日志即为替换内容；插件必须自己保存全文（`.flowgate/state/evidence/E-xxxx.log`） |
| H20 | 插件能指定 preset/初始消息并等结构化结果 | **成立** | `startActivation` 返回 `{childId,result,dispose}`；`delivery:'caller'` 由插件 await 结果 |
| H21 | `cwd` 可指向 worktree 且沙箱允许写入 | **部分成立（接口确认，沙箱未验）** | `SubagentStartRequest.cwd` 存在；沙箱允许范围需 profile 配置。不成立时并行批次降级为顺序 |
| H22 | 多个子 agent 并发时事件能归属到 agent | **成立** | 每次调用带 `agent/callId`；事件按 scope 过滤 |
| H23 | 会话开始/首步前可附着，关闭可监听 | **成立** | `session/created`、`agent/created`、`system-prompt/assemble`、`agent/pre-step`、`session/disposed` 均在首步前/关闭时可用 |
| H24 | 能读审查/调查子 agent 的会话事件 | **成立** | `ctx.sessionQuery.readSession/listEvents/observeSession`；`childId` 即子会话 id |
| H25 | 能在 patch 里声明三个 preset，只读取证可配置 | **成立（写法纠正）** | preset 就是插入 `@deepseek-ai/dsh-agent-preset` 行；只读靠 `dsh-tool-fs` config 开关，不是 `restrict` |
| H26 | 可用 deny + 守卫关闭原生委派、强制原生工具模式 | **成立** | `restrict({deny})`、`presentAs('native')` 均存在且 scoped；`restrict` 只过滤继承的全局工具 → 守卫作为第二层必需 |

## 与 03-技术方案.md 的差异（实现以此为准）

1. `dsh` 字段没有 host/client 入口字段：host 入口 = `main`，client = `exports["./client"]`；`dsh.client` 只声明 platform/inject/immediately/external。
2. `engines.dsh` 保留为声明，但兼容性验证靠脚本 + `docs/compat/`。
3. 会话事件走 `appendPluginRecord`（host 白名单 import `@deepseek-ai/dsh-session`，externalized peer），不再假设 `session.append` 可写任意类型。
4. 右侧栏两段式注册；面板调宿主用"填命令"兜底，Typert Remote 推迟到 v1.0 之后再评估。
5. `presentAs`/`restrict` 是 scoped-only；受管控会话在 `agent/created` 的 agent ctx 上应用，守卫兜底。
6. `agent/turn-stopping` 通过 `agent.steer()` 续轮（不是返回值阻止结束）。
7. 测试输出压缩：先解析证据并写 `state/evidence/<id>.log`，再替换 content。

## 复现方式

```bash
# 1) 宿主入口可加载（离线 cordis）
node spike/verify-host.mjs
# 2) client bundle 形态合法（离线 mock）
node spike/verify-client.mjs
# 3) 真实 DSH 进程可 import 组合模块（隔离 DSH_HOME，不碰日常 profile）
DSH_HOME=/tmp/fg-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile spike --dump-config-schema >/dev/null
# 4) 本仓库的正式插件
pnpm build && pnpm verify:package
```

## 遗留未验证项（2026-10-31 更新；不影响 v0.5 开工）

- ~~浏览器内真实加载 client bundle 并点击 dock/右侧栏~~ **已覆盖（2026-10-31 第二轮真实 Web 走查）**：隔离 web profile 中真实加载 `dsh-flowgate/client.js`（combo HTTP 200），dock 状态条与右侧栏 8 视图真实渲染，见 [impl/web-walkthrough.md](impl/web-walkthrough.md)、[impl/implementation-status.md](impl/implementation-status.md) §3.1/§3.8；§9.4 的离线 mock 仍作为形态对照保留。
- PTC 模式下守卫覆盖**仍未验证**（工程模式已强制 `presentAs('native')` 规避，风险低）。
- `ask_user_question` 问答的结构化字段、`dsh-token-meter` 读取路径**仍未验证**（当前按产物与"未知"降级）；MCP 工具写入经守卫同样未实测（H4，推断成立）。
- ~~worktree 路径的沙箱允许范围~~ **真机派发已完成（2026-10-31）**：真实 worktree + 子 agent + 回执/审查在 headless 宿主跑通（[impl/implementation-status.md](impl/implementation-status.md) §3.7 C-004/C-006/C-007）；但 headless 一次性进程在集成检查点合并前退出，完整合并结算仍需交互式/常驻宿主（§4 #4）。
