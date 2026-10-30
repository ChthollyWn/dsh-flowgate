# host 层集成验证步骤（/flow 与 flow_status）

> 目的：在不碰日常 `desktop` profile 的前提下，验证 host 层（Cordis 插件）能加载、
> `/flow` 命令族可用、`flow_status` 工具可见、守卫与投影生效。
> 依据：`docs/impl/dsh-plugin-api-cheatsheet.md` §7（隔离 profile）与 §9（spike 实测）。
> 前置：仓库根执行过 `pnpm install && pnpm build`（产物 `lib/host.js`、`lib/client.js`）。

## 0. 一键离线检查（不需要启动 DSH）

```bash
cd /path/to/dsh-flowgate

# 1) 类型检查（全仓）
pnpm exec tsc --noEmit

# 2) host 单测（fake ctx：插件加载/守卫/命令/工具/注入/覆盖/委派/投影/证据压缩）
pnpm exec vitest run test/host

# 3) 构建产物形态：host 是 ESM 且具名导出 apply / inject / name
pnpm build
tail -n 1 lib/host.js          # 期望含 export { apply, inject, name }
head -c 200 lib/client.js      # 期望 window.__ModuleLoader__.load({ id: "dsh-flowgate", ...
```

预期：`test/host` 全绿（81 用例）；`lib/host.js` 无 `@deepseek-ai/` 值导入（仅可能保留
`await import('@deepseek-ai/dsh-session')` 这类运行时探测，用于自定义会话事件）。

## 1. 隔离 profile（绝不使用 ~/.dsh/profiles/desktop）

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export DSH_HOME=/tmp/dsh-flowgate-dev

# 1) 从官方 web 模板建隔离 profile（只需第一次）
"$DSH" --profile flowgate --from-default-profile web --help

# 2) 以 link 方式装开发中的插件
cd "$DSH_HOME/profiles/flowgate"
pnpm add link:/path/to/dsh-flowgate

# 3) 确认组合树里有 FlowGate 的插件行与三个 preset 行
"$DSH" --profile flowgate --dump-config | grep -i -A4 'flowgate'

# 4) 导入/激活校验（会 import 每个组合模块；只对可信 profile 用）
"$DSH" --profile flowgate --dump-config-schema > /tmp/flowgate-schema.json && echo OK
```

**通过标准**
- `--dump-config` 输出里有 `id: dsh-flowgate` 行，以及 `preset-flowgate` / `preset-flowgate-executor` / `preset-flowgate-reviewer` 三行。
- `--dump-config-schema` 退出码 0（证明真实 DSH 进程能 import 我们的 host 入口）。
- 若 preset 行被跳过（组合缺失 `@deepseek-ai/dsh-agent-preset` 或 `dsh-tool-fs`），记录在
  `skippedBundles`，不影响 `/flow`、工具、守卫——只需在兼容矩阵里标注。

## 2. 使用工程模式 preset 启动（推荐受管控项目）

```bash
"$DSH" --profile flowgate                       # 或在 Web 端选择 “FlowGate 工程模式”
```

在会话工作目录里（必须是有写权限的普通项目目录）：

1. **未初始化**：状态条应显示 `FlowGate 未启用 · /flow init 启用`；
   agent 调用 `flow_status` 应返回 `initialized: false` 的提示文本（不拦截任何操作）。
2. 负责人输入 `/flow init`：
   - 返回探测到的技术栈/命令与 `.flowgate/project.md` 草稿路径；
   - 磁盘出现 `.flowgate/{config.yaml,project.md,ledger.jsonl,...}`（由 `engine.init()` 写，host 不重复写）；
   - `/flow`（无参数）显示阶段 S0/S1、门禁检查项、下一步。
3. 负责人输入 `/flow new 示例变更`：
   - 返回变更 id（如 `C-001`）与建议复杂度/风险；
   - 投影 `flowgate` 更新（状态条变为蓝色阶段条，revision 增长）。
4. agent 调用 `flow_status`：
   - 返回文本包含 `变更「示例变更」｜阶段 S1`、门禁检查项（✓/✗）、下一步；
   - 结构化 `data.snapshot` 含 `stage/complexity/risk/activeTaskId/pending`。
5. 守卫硬拦截（H1 验证）：
   - 在 S1 让 agent 尝试改源码（如 `write` 一个 `src/foo.ts`），应被拒绝，返回文本形如
     `[FlowGate] 已拦截（R-STAGE-SRC）：...`；`/flow` 里能看到待处理项/拦截计数增长；
   - 被拒绝的调用**不产生**文件改动。
6. 人工门（03 §2.2）：
   - agent 完成某阶段产物后 `flow_submit({gate:"G1"})` → 返回 `awaiting: "owner"`；
   - 负责人 `/flow approve G1` → agent 下一步收到 `[FlowGate] 已批准 G1 ...`（inject，不唤醒）；
   - `/flow reject <意见>` → agent 下一步收到退回意见。
7. `/flow doctor`：
   - 输出包含「插件版本 / 项目根 / 初始化 / 账本 / 配置 / 阶段 / 活动任务 / 守卫心跳 /
     工具覆盖自检 / 宿主能力（✓✗ 列表）/ 降级·未生效 / 事后检测 / 会话投影 / 预设」；
   - 至少应看到 `✓ 单调守卫 ctx.tools.guard`、`✓ 命令注册 ctx.commands`、`✓ 会话投影`。
8. `/flow off` / `/flow on`：
   - off 后 agent 写操作不再被拦截，`flow_status` 的 `data.snapshot.off === true`；on 恢复。
9. 会话关闭（新开会话/结束进程）：
   - 下次进入同一项目会话时，host 自动接续唯一进行中的变更并注入交接摘要；
   - 被关闭会话里运行中的任务标为 `interrupted`（`/flow` 可查）。

## 3. 派发模式（可选，需子 agent provider）

1. 配置里把 `dispatch` 改为 `subagent` 或 `auto`（负责人可让 agent 提议、由负责人改 config.yaml）；
2. 执行计划 G3 批准后，agent 调 `flow_dispatch_next`：
   - 返回本次启动的任务清单（顺序批次 1 个/并行批次最多 `parallel.max_agents` 个）；
   - 并行任务会在 `.flowgate/worktrees/<变更>/<任务>/` 出现 worktree；
   - 子 agent 结束后主会话收到 inject 的完成摘要（不唤醒）；
3. 并行批次全部结束后，host 自动做集成检查点（合并分支 + `commands.integration`），
   结果写入 `engine.completeCheckpoint`；失败会生成待处理项。

**降级判定**：若 `/flow doctor` 显示 `✗ 子 agent startActivation`，说明当前 profile 没有
本地 subagent provider——把 `dispatch` 改回 `inline`，用 `flow_task_start` 逐任务执行即可。

## 4. 审查/调查（可选）

- 需要 `subagents` 服务（本地 spawn provider）与 `flowgate-reviewer` preset；
- `/flow doctor` 中 `✓ 子 agent startActivation`、`✓ 会话查询 sessionQuery` 时：
  `flow_task_done` 前自动跑审查；`flow_investigate` 可发起只读调查；
- 若 preset 未加载：审查降级为"审查缺失"，由任务门按风险决定阻断/豁免（doctor 会列出原因）。

## 5. 故障排查速查

| 现象 | 排查 |
|---|---|
| 状态条一直“未启用” | 会话 cwd 不在初始化过的项目里；`.flowgate/config.yaml` 是否在该目录或其祖先 |
| `/flow` 报“引擎未就绪” | 看 `/flow doctor` 的「降级/未生效」；多为项目目录不可读或 ledger.key 无法写入 |
| 守卫不拦截 | 确认项目已初始化、当前会话未 `/flow off`；doctor 里 `守卫心跳` 应有工具调用计数增长 |
| 面板不更新 | doctor 里 `✗ 会话投影` 或 `✗ 自定义会话事件`：面板会降级为打开时读取；命令仍可用 |
| 审查/派发失败 | doctor 里 `✗ 子 agent startActivation`；改用 inline 模式 |
| 账本校验失败 | 锁定模式：先 `/flow repair`；仍失败则备份 `.flowgate/` 后联系负责人 |

## 6. 清理

```bash
rm -rf /tmp/dsh-flowgate-dev /tmp/flowgate-schema.json
# 不要删除日常 ~/.dsh/profiles/desktop 里的任何内容
```

## 调试开关（仅诊断用，不影响正常行为）

| 环境变量 | 作用 |
|---|---|
| `FLOWGATE_DEBUG_FETCH=1` | 给宿主进程的 `fetch` 装追踪器，把每个 LLM 请求/响应状态写到 `/tmp/flowgate-fetch.log`（用于定位 provider 层的 `TRANSPORT` 失败；生产不要开） |
| `FLOWGATE_DISABLE=context,tools,guard,...` | 按模块名跳过安装（E2E 二分定位用；可选：session/guard/delegation/coverage/postcheck/compression/context/projection/gates/commands/tools/dispatch） |
| `FLOWGATE_CONTEXT_MODE=pre-step` | 跳过 `systemPrompt.section`、强制走 `agent/pre-step` 注入（兼容性排查用） |
| `FLOWGATE_DEBUG_GUARD=1` | 把每次 pre-execute 的工具/动作/判定/同步守卫命中写到 `/tmp/flowgate-guard.log`（定位"为什么拦/为什么没拦"） |

已实测结论：注入给模型的 user 消息必须使用 DSH 已登记的 MessageSource kind（当前用官方 `runtime-context` + `form: 'relay'`）；自造 kind 会让 provider 在发请求前抛错，表现为 `DeepSeek Messages transport failed`。

## 真实宿主踩坑记录（rc.5）

- `ctx.tools.schemas(scope?: ScopeKey)` 的 scope key 是 **agent 对象**（不是 `agent.ctx`）。传 ctx 只会拿到 scope-local 工具；不传则只有本插件注册的工具。覆盖自检/委派关闭都需要用 agent 作为 key。
- `ctx.tools.restrict({ deny })` 只接受**可限制的全局工具名**：visible 集合里可能有 scope-local 工具或不同组合下不存在的名字，批量 deny 只要有一个未知名字就整体抛错。策略：先按可见集合过滤批量调用，失败则逐个工具名探测（本仓库 `guard/delegation.ts` 已实现）。
- DSH 的 MessageSource 是登记表：注入给模型的 user 消息必须用已登记 kind（当前用 `runtime-context`+`form:'relay'`），自造 kind 会导致 provider 在 fetch 前抛错并被包装成 `DeepSeek Messages transport failed`（详见 §3.2）。

## Headless 真机 E2E 剧本（需要真模型 key）

Web UI 在会话恢复场景下导航不稳定，评审/回归用 headless profile 更可靠（同一宿主进程、同一套插件与守卫）：

```bash
# 1) 隔离 home + headless profile（一次性）
export DSH_HOME=/tmp/fg-demo-home
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" fg-headless --from-default-profile headless --help
"$DSH" plugin --profile fg-headless add link:/path/to/dsh-flowgate

# 2) 每个阶段跑一次 headless（key 从文件读，不出现在命令历史/仓库）
cd /path/to/demo-repo
DEEPSEEK_API_KEY="$(cat /tmp/flowgate-demo.key)"   DSH_HOME=/tmp/fg-demo-home "$DSH" --profile fg-headless "只做 S1 产物并 flow_submit G1"

# 3) 负责人门用 tools/admin.js（dev 工具，不随包发布）
node tools/admin.js /path/to/demo-repo approve G1
node tools/admin.js /path/to/demo-repo status
```

经验与坑：
- headless 组合没有 `agentPresets` 服务时，三个 `preset-flowgate*` 行会 pending（不影响插件与守卫）；provider 需要 `DEEPSEEK_API_KEY` 环境变量（credentials 文件只对 web 组合生效）。
- headless 的 `agent/created` 同样会触发自动接续；同一目录只能有一个活动变更，否则自动接续会拒绝（用 admin `pause-id`/`resume` 调整）。
- 真实 `ts-todo-api` 目录不是 git 仓库：任务门自动提交、G3 cleanWorktree 会走降级分支；需要完整 git 语义时先 `git init` + 初始提交。
- 无 subagents 的精简组合跑 S5 时，把 `.flowgate/config.yaml` 的 `review.enabled` 设为 `false`（G5/G6 会按配置放行，不再死锁）。
