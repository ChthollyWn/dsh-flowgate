# 真实 Web 宿主交互走查（preset 切换 / 面板按钮 / 确认卡 / 拦截反馈）

> 本轮目标：补齐 [implementation-status.md](implementation-status.md) §4 缺口 1（人工按钮点击流程、低复杂度确认卡、误判反馈）
> 与缺口 2（会话内切换 preset）的真实 Web 宿主证据。
> 约束：隔离 `DSH_HOME`、**不发任何模型请求**、不碰日常 `~/.dsh`；会话内所有命令通过真实 UI 输入框执行。
> 走查时间：2026-10-31 10:54–11:47（Asia/Shanghai）。

## 0. 结论速览

| # | 验证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | preset 菜单 + **会话内真实切换**到「FlowGate 工程模式」 | ✅ 通过（菜单 3 个 FlowGate preset 均出现；`agentPresets/select` 返回 `{"ok":true,"value":"flowgate"}`，UI 标签切换，0 page error，状态条正常渲染） | [13](../screenshots/13-preset-menu-in-session.png)、[14](../screenshots/14-preset-switched-session.png) |
| 2 | `/flow init`、`/flow new` 在真实 UI 执行；状态条显示阶段；右侧栏 8 视图可打开 | ✅ 通过（命令经 `commands/execute` 真实执行并返回成功文本；状态条 idle→active；8 个 tab 全部渲染出内容） | [15](../screenshots/15-flow-init-statusbar.png)、[16](../screenshots/16-flow-new-statusbar-s1.png)、[17](../screenshots/17-panel-8-views.png) |
| 3 | 面板动作 Remote 兜底（按钮 → 填入 `/flow …` 命令） | ✅ 通过（报告 / 继续按钮均把命令写入 composer draft，并提示"无法直接调用宿主，已把命令填入输入框"，0 console error） | [18](../screenshots/18-panel-fallback-report.png)、[19](../screenshots/19-panel-fallback-continue.png) |
| 4 | 低复杂度方案确认卡（G1+G3 合并）三按钮行为 | ✅ 通过（卡在真实面板渲染：目标/范围/验证方式；确认并推进→`/flow approve G3`，退回补充→`/flow reject <理由>`，提高复杂度→`/flow complexity high <理由>`） | [20](../screenshots/20-confirm-card.png)、[21](../screenshots/21-confirm-approve-fallback.png)、[22](../screenshots/22-confirm-reject-fallback.png)、[23](../screenshots/23-confirm-raise-fallback.png) |
| 5 | 拦截视图"误判反馈 / 放行一次"按钮 | ⚠️ **仅组件级**（真实宿主下无模型 → 无真实工具拦截记录，面板空态，按钮不渲染；用真实 `InterceptsView` + 真实 `actions.ts` 在 Chrome 中验证按钮→`/flow allow-once …` 兜底） | [24](../screenshots/24-intercepts-view-harness.png)、[25](../screenshots/25-intercepts-feedback-harness.png)、[26](../screenshots/26-intercepts-allow-once-harness.png) |

另有 **1 个新发现的真实产品问题**（宿主重启后投影 revision 回退导致 UI 陈旧，见 §5.1），和 1 个环境坑（§5.2）。

## 1. 环境与验证对象

- DSH：`0.2.1-rc.5`，`/Applications/DeepSeek Harness.app`（app.asar，2026-10-29 构建）；CLI 用 `ELECTRON_RUN_AS_NODE` 启动。
- 隔离 home：`DSH_HOME=/tmp/fg-walk/dsh-home`，`HOME=/tmp/fg-walk/home`（保证 FlowGate 的 `ledger.key` 落在 `/tmp`，不会读写真实 `~/.dsh`）。
- profile：`flowgate-dev` = 官方 web 模板 + `dsh-flowgate` link 安装（组合树含 `dsh-flowgate` 行与 3 个 preset 行）。
- 插件构建快照：走查期间 lead/其他成员正在并行改 `src/host` 并重建 `lib/`，为避免证据漂移，把 11:06 的构建产物复制到 `/tmp/fg-walk/plugin-snapshot` 后以 `link:` 安装：
  - `lib/host.js` sha256 `9341766c88cbd8e63098a075c548e59ac85775fd20ed3ece9199948ecf543ece`
  - `lib/client.js` sha256 `2989f992b982c114252d1f3c3887fe670fcbaa72acaab938d97e0c004c086cc4`
  - 仓库 HEAD `43d18e5` + 当时工作区未提交改动。
- 工作区：`examples/ts-todo-api` 的副本 `/private/tmp/fg-walk/projA`（`git init` + 一次基线提交 `7c69a89`）；macOS 下 `/tmp` 是 `/private/tmp` 的符号链接，**workspace path 必须用 realpath**（见 §5.2）。
- Web 宿主：`dsh --profile flowgate-dev --host 127.0.0.1 --port 7100 --no-open`（后台任务启动，未占用 60747）。
- 浏览器：系统 Chrome 156 + 全局 playwright 1.60（`/opt/homebrew/lib/node_modules/playwright`，Chromium 缓存与 1.60 版本不匹配，故 `executablePath` 指向系统 Chrome），视口 1600×1000。
- 模型：`DEEPSEEK_API_KEY=sk-fake-…` 仅用于解锁 UI。启动日志里只有一次 `model listing … 401`（宿主启动时列模型目录，非推理请求），**全程没有任何 completion / 模型请求**。
- 命令执行方式：真实 UI 输入框输入 `/flow`（弹出命令菜单，确认命令已注册）→ Enter 生成命令 chip → 输入参数 → Enter；宿主侧经 `commands/execute` RPC 执行，返回文本通过 `page.on('response')` 抓取。**命令不走模型消息**。

## 2. 逐项证据

### 2.1 preset 菜单与会话内切换（缺口 2）

真实会话中打开 composer 的 Agent 预设菜单，菜单包含 7 项：标准 / PTC / 极简 / 创造 / **FlowGate 工程模式 / FlowGate 执行者 / FlowGate 只读取证**（[13](../screenshots/13-preset-menu-in-session.png)）。

选择「FlowGate 工程模式」后：

- 客户端调用 `POST /api/agentPresets/select`，响应 `{"ok":true,"value":"flowgate"}`；
- composer 预设标签由「标准模式」变为「FlowGate 工程模式」；
- `pageerror` / `console.error` 均为 0；
- 输入框 dock 的 FlowGate 状态条持续渲染，此时项目未初始化：`◆ FlowGate 未启用 · /flow init 启用`（`data-tone="disabled"`，30 字符；[14](../screenshots/14-preset-switched-session.png)）。

**能观察到多少**：preset 的关键作用在 agent 侧（persona 前缀 / 工具集），不产生模型请求时无法从 UI 直接观察 person 注入内容；本轮只能确认「会话内选择 → 服务端 select 成功 → 会话继续可用、状态条/面板正常」。persona/工具集差异的运行时行为仍未验证（见 §6）。

### 2.2 `/flow init`、`/flow new` 与面板 8 视图（缺口 1 的面板部分）

`/flow` 在真实 UI 输入即出现命令菜单项 `flow — FlowGate 流程门禁：状态、立项、门禁、放行、指标与自检`，证明命令注册在浏览器侧可见。

| 命令 | 宿主返回（节选） | 状态条（dock） |
|---|---|---|
| `/flow init` | `FlowGate 已初始化。探测到 node 项目，生成 .flowgate/project.md 草稿（读了 3 个文件）…` | `tone=idle`、`◆ FlowGate 空闲 │ 无进行中变更 · /flow new 立项`（37 字符） |
| `/flow new 给待办列表增加分享链接 --complexity low` | `变更 C-001 已创建并进入 S1 需求澄清（低 · 普通，建议等级…）` | `tone=active`、`◆ FlowGate C-001 低 · 普通风险 │ ① 需求澄清 │ 下一步：写澄清/需求产物后 flow_submit({gate:"G1"})`（75 字符） |

点击状态条可打开右侧栏 FlowGate 面板；8 个视图逐个点击后均渲染出真实内容（`data-active-tab` 与视图内容一致）：

| tab | 内容摘要 |
|---|---|
| 台账 ledger | 1 条变更 C-001，低·普通，需求澄清/进行中，按钮：看板/继续/接管/暂停/报告 |
| 流程 pipeline | 七阶段流程 + 当前阶段卡（做什么/为什么/合格标准/产物/方法来源/反模式/正反例）+ 术语表 |
| 门禁 gates | 门 G1 待提交 / 暂无检查项 / `/flow approve G1` 提示 |
| 任务 tasks | 执行流程图 0、任务看板空态 |
| 追溯 trace | 追溯矩阵空态 |
| 风险 risk | 风险登记空态 + 待处理风险空态 |
| 拦截 intercepts | 记录/统计/覆盖/试跑 4 个子 tab，空态 |
| 指标 metrics | 18 个指标、导出 CSV/JSON、口径 |

（对比：[15](../screenshots/15-flow-init-statusbar.png)、[16](../screenshots/16-flow-new-statusbar-s1.png)、[17](../screenshots/17-panel-8-views.png)。）

### 2.3 面板按钮 → Remote 兜底（缺口 1 的"人工按钮点击流程"）

本 web 精简组合没有 `remote.flowgate`（doctor 一直标 Remote ✗），因此所有面板动作都会走 H10 兜底：把等价 `/flow` 命令写进输入框。实测：

| 按钮 | 点击前 draft | 点击后 composer draft | 面板 notice |
|---|---|---|---|
| 台账「报告」`ledger-report` | 空 | `/flow report` | `无法直接调用宿主，已把命令填入输入框：/flow report`（warn） |
| `/flow pause` 后的台账「继续」`ledger-continue` | 空 | `/flow resume C-001` | `无法直接调用宿主，已把命令填入输入框：/flow resume C-001`（warn） |

两处均无 pageerror / console error（[18](../screenshots/18-panel-fallback-report.png)、[19](../screenshots/19-panel-fallback-continue.png)）。这说明 `bridge.fillCommand`（`sessions.binding → conversation.input.for(ctx).setDraft`）在该宿主里真实可用，按钮不会直接执行人工动作（符合"人工动作只能由人触发"的设计）。

### 2.4 低复杂度方案确认卡（缺口 1 的确认卡部分）

**构造方式（如实披露）**：正常流程里 G1+G3 合并确认卡由 agent 写产物并 `flow_submit` 触发；本轮不发模型请求，因此用离线方式把 C-001 置到「S3、低复杂度、G3 awaiting」：直接改 `.flowgate/changes/C-001/status.json`（stage=S3、complexity=low、G1/G2 passed、G3 awaiting）并写 `proposal.md`、`specs/spec.md`、`tasks.md`。之后**重启真实宿主**，由宿主自己的 engine 读取该状态并投影到面板——卡片渲染、按钮、fillCommand 全部走真实宿主链路，只有"状态如何产生"是离线构造的。

实测（[20](../screenshots/20-confirm-card.png)）：

- 状态条 `tone=attention`：`◆ FlowGate C-001 低 · 普通风险 │ ③ 设计拆解 ▸ 等你批准计划 │ 拦截 0 · 待处理 0 │ 下一步：等待负责人：/flow approve G3`；
- 门禁视图 `[data-flowgate="view-gates"][data-confirm-card="true"]` 渲染「低复杂度方案确认卡」：目标=提案 `## 改什么` 文本，范围=`src/app.js · test/app.test.js`，验证方式=`pnpm test`，按钮「确认并推进 / 退回补充 / 提高复杂度」；
- 三按钮点击后（Remote 不可用 → 命令兜底）：

| 按钮 | composer draft 断言 | notice |
|---|---|---|
| 确认并推进 | `/flow approve G3` | 无法直接调用宿主，已把命令填入输入框（warn） |
| 退回补充（填理由后提交） | `/flow reject 验收场景缺少失败路径，请补一个 WHEN 列表为空 的 THEN` | 同上 |
| 提高复杂度 | `/flow complexity high 低复杂度方案确认卡可以一键提高复杂度，回到 S1 补齐六要素。` | 同上 |

（[21](../screenshots/21-confirm-approve-fallback.png)、[22](../screenshots/22-confirm-reject-fallback.png)、[23](../screenshots/23-confirm-raise-fallback.png)。）

**观察到的残留问题**：卡片「验收场景」显示 `—`，而同一份 `specs/spec.md` 用 `loadArtifacts()` + `parseIncrementalSpec()` 直接解析能得到 2 个场景（`R1.S1/R1.S2`）。结合 §5.1 的投影 revision 回退问题，判断面板显示的是宿主重启前的旧投影（旧投影生成时 spec.md 还不存在），**不是** spec 解析器缺陷；修复 §5.1 后应可显示。这一点未再单独复验。

### 2.5 拦截视图"误判反馈 / 放行一次"（缺口 1 的误判反馈部分）

**真实宿主链路未验证成功**，原因如实记录：

1. 拦截记录 `panel.intercepts` 来自 host 进程内存 `runtime.intercepts`，只在真实工具调用被 guard 拦截时写入；本轮零模型请求，无法产生真实拦截。
2. 尝试把一条 `R-STAGE-SRC` 拦截行注入会话投影缓存（`DSH_HOME/storages/session_projcache/...json`）后重开页面：面板仍为空态（`拦截记录 0`），因为会话打开时宿主会用会话日志里的投影记录/实时投影覆盖客户端缓存；同时该注入受 §5.1 的 revision 回退影响。
3. 因此该项只有**组件级证据**：把真实 `src/client/panel/views/Intercepts.tsx` 与真实 `src/client/actions.ts` 用 esbuild 打进一个临时浏览器页面（React + 系统 Chrome），喂 2 条拦截记录，然后真实点击：
   - 「误判反馈」→ 展开理由表单 → 填理由 →「放行一次」；
   - 结果：真实 `performAction` 输出 `ok=true / fallback=true`，`fillCommand` 端口收到
     `/flow allow-once R-STAGE-SRC 误判：该文件属于当前阶段允许的文档产物`。
   （[24](../screenshots/24-intercepts-view-harness.png)、[25](../screenshots/25-intercepts-feedback-harness.png)、[26](../screenshots/26-intercepts-allow-once-harness.png)。）
   这证明组件与命令映射正确，但**不能**替代"真实 guard 拦截 → 面板行 → 点击"的端到端证据；该端到端需要真模型（或等价地让宿主执行一次被拦截的工具调用）。

## 3. 没有发生的事（诚实边界）

- 全程没有向任何模型 provider 发 completion 请求；会话消息只有命令 chip + 命令结果，agent 未执行 turn。
- 因此以下事项**未验证**，不能从本轮推导为通过：preset persona/工具集差异的运行时行为、`flow_submit` 驱动的真实 G1/G3 awaiting 与退回意见注入、真实工具拦截（R-STAGE-SRC 等）→ 面板拦截记录 → 误判反馈的完整闭环、审批通过后状态推进（本轮只验证"按钮把命令填进输入框"，没有点发送执行 `approve`）。

## 4. 复现步骤（最小）

```bash
# 1) 隔离 home + profile + 插件（本轮用构建快照，也可直接 link 仓库）
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
export DSH_HOME=/tmp/fg-walk/dsh-home HOME=/tmp/fg-walk/home
mkdir -p "$DSH_HOME" "$HOME"
"$DSH" --profile flowgate-dev --from-default-profile web --help
"$DSH" plugin --profile flowgate-dev add link:/tmp/fg-walk/plugin-snapshot
"$DSH" --profile flowgate-dev --dump-config | grep -i -A3 flowgate   # 期望 1 行插件 + 3 行 preset

# 2) 临时项目（git 基线）
mkdir -p /private/tmp/fg-walk/projA && cp -R examples/ts-todo-api/. /private/tmp/fg-walk/projA/
cd /private/tmp/fg-walk/projA && git init -q && git add -A && git commit -qm baseline

# 3) 种子 workspace（注意 path 必须是 realpath，macOS /tmp→/private/tmp）
mkdir -p "$DSH_HOME/storages"
cat > "$DSH_HOME/storages/workspace.json" <<'JSON'
{"unit":{"name":"workspace","version":2},
 "global":{"initialized":true,"workspaceIds":["aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001"],"archivedSessionIds":[],"pinnedSessionIds":[]},
 "tables":{"workspaces":{"aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001":{"path":"/private/tmp/fg-walk/projA","title":"projA","sessionIds":[],"createdAt":"2026-10-31T02:00:00.000Z","updatedAt":"2026-10-31T02:00:00.000Z"}}}}
JSON

# 4) 起 Web 宿主（后台；不要用 60747）
DEEPSEEK_API_KEY=sk-fake-unlock-only "$DSH" --profile flowgate-dev \
  --host 127.0.0.1 --port 7100 --no-open

# 5) Playwright（系统 Chrome）：token URL 打开 → 点「在 projA 中新建会话」→ 预设菜单切 FlowGate 工程模式 →
#    输入 /flow（命令菜单）→ Enter 成 chip → init / new … --complexity low → 点状态条开面板。
#    临时脚本见 /tmp/fg-walk/*.mjs（未入库；本轮结束时已随临时目录清理）。
```

结束清理：

```bash
# kill 掉 7100 的 dsh 进程，删除 /tmp/fg-walk（含 dsh-home 与临时项目）
lsof -tiTCP:7100 -sTCP:LISTEN | xargs -r kill
rm -rf /tmp/fg-walk
```

## 5. 新发现的问题

### 5.1 【真实产品 bug】宿主进程重启后，旧投影 revision 更高导致新投影被丢弃，UI 显示陈旧快照

**现象**：同一会话在宿主进程重启（本走查中为重启 `dsh web`）后，面板/状态条继续显示重启前的旧 FlowGate 快照。具体复现：C-001 处于 S3/G3 awaiting 时更新 `specs/spec.md` 并重启宿主；之后无论打开面板还是执行 `/flow` 查看状态，确认卡「验收场景」仍是旧投影里的 `—`（新 spec 已有 2 个场景）。

**证据**：

- 会话日志（`DSH_HOME/sessions/.../session.v4.jsonl.zstd`，解压后）里 `plugin:dsh-flowgate/state` 记录携带的 `revision` 序列在旧进程里递增到 **10**；重启后的新进程又出现 `revision: 2/3/4`。投影 `apply` 有单调保护 `if (next.revision >= state.revision) return next; return state`（`src/host/projection/index.ts`），于是重放日志后 `state.revision=10`，新进程的 2/3/4 全部被忽略。
- 宿主侧 `revisionValue` 在进程内从 0 开始（`src/host/runtime.ts` `private revisionValue = 0`），重启后未从日志/项目状态恢复最大值。

**影响**：宿主重启后（桌面端升级/崩溃恢复/`dsh web` 重启）面板与状态条可能长期显示重启前数据，直到新进程内累计状态变化次数超过旧 revision（本机约需 >10 次 emit）；期间人工门按钮显示的可能是已过时的阶段/门禁。属"陈旧展示"而非数据损坏（磁盘状态与命令执行正确）。

**建议修复方向**（未改源码，交由 lead 决策）：在 engine 载入并重放投影记录后，把 `revisionValue` 初始化为 `max(replayed revision)`；或把投影合并判据改为 `(updatedAt, revision)`/进程 epoch。并加回归测试：模拟日志中 revision=10 的插件记录 + 新进程 initialProjection 后 emit，断言新投影可见。

**修复状态（2026-10-31，本轮已修）**：采用"宿主进程 epoch"方案——每条投影记录带 `epoch`（`src/host/runtime.ts` 的 `projectionEpoch`），投影 `apply` 在 epoch 不同时直接接受新记录，同一 epoch 内仍按 revision 单调去重（`src/host/projection/index.ts`）；wire 契约新增可选字段 `epoch`（旧记录缺失时回退原语义）。回归测试 `test/host/projection-epoch.test.ts`（6 例：旧进程 revision 1..10 后新进程 revision 1 可见、同 epoch 乱序仍丢弃、无 epoch 旧记录语义不变、`latest()` 兜底同样按 epoch、sanitize 保留/忽略非法 epoch）。**本轮走查所用构建快照不含该修复，§4 的 UI 证据仍是修复前的宿主；修复已由单测覆盖，尚未再做一次真机重启复验**（见 §6）。

### 5.2 环境坑（DSH Web，非插件 bug）：workspace path 必须 realpath

在隔离 home 里手工种 `workspaces` 时若用 `/tmp/...`，而会话 cwd realpath 是 `/private/tmp/...`，`session/create` 会返回
`session/workspace-attach-failed … its cwd resolves to '/private/tmp/...'`，UI 停留在 splash。改成 `/private/tmp/...` 后正常。之前的 Web 走查/复现脚本如用 /tmp 路径可能踩到同一坑。

### 5.3 一次性现象（未归因）

首次启动（当时 `lib/` 正在被并行重建、且 workspace path 还是 /tmp）创建会话时，`session/create` 返回
`failed to create session: Error: forwarded host event "api-session/added" argument 0 is not lossless JSON data`
（DSH `@deepseek-ai/dsh-api-remotes` 对转发事件做 lossless-JSON 校验）。改用 realpath + 固定构建快照后未再复现，**无法确认**是插件投影含 `undefined` 触发还是并行重建期的临时状态；若后续复现，优先检查 `api-session/added` 的 summary 里 flowgate 投影值是否含 `undefined` 字段（`engine.snapshot()` 里 `changeId/title/…` 在无变更时是显式 `undefined`）。

## 6. 仍未验证（下一轮建议）

> 状态复核（2026-10-31，按当前 HEAD `4457386` 的文档口径）：以下 1–4 项在本轮走查后**仍未被真机验证**，不能从本轮推导为通过；第 5 项的修复有单测覆盖，但真机复验未做。

1. **preset 运行时行为**（仍未验证）：切换 FlowGate 工程模式后，让真模型跑一轮，确认 persona 注入与工具集差异、以及 preset 对 `flow_*` 工具可见性的影响——本轮零模型请求，只验证了会话内选择/切换成功。
2. **真实确认卡产生路径**（仍未验证）：真模型写 S1 产物 → `flow_submit G1`（低复杂度自动过）→ S3 产物 → `flow_submit G3` → awaiting → 面板确认卡（本轮是离线构造状态）。
3. **拦截 → 误判反馈端到端**（仍未验证）：真模型在 S1 触发 `R-STAGE-SRC` 拦截 → 面板拦截行出现 → 误判反馈/放行一次按钮 → `/flow allow-once` 填入（或真实 Remote 可用时直接执行）。当前只有 §2.5 的组件级证据。
4. **Remote 非降级路径**（仍未验证）：本组合无 `remote.flowgate`；需带 Remote 的组合/桌面宿主验证按钮直接执行（而非只填命令）。
5. **投影 epoch 修复后的真机重启复验**（单测已覆盖，真机未复验）：`test/host/projection-epoch.test.ts` 6 例覆盖 epoch 语义；但本轮 UI 证据仍是修复前宿主，重启宿主后面板/状态条是否即反映最新状态、§2.4 确认卡「验收场景 —」是否恢复，均**未再做真机复验**。
