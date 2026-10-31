# 界面截图（真实 DSH 0.2.1-rc.5 Web 宿主）

采集时间：2026-10-30 20:06（Asia/Shanghai）；2026-10-31 11:19 追加"真实 Web 宿主交互走查"一轮（13–26 号，见下方分节）；2026-11-01 00:16 追加"v0.2 图形化流程 + 卡片化授权 E2E"一轮（30–33 号，见下方分节）；2026-11-01 01:38 追加"v0.3 子代理拓扑 / 后台任务视图"一轮（34–36 号，见下方分节）。
当前共 **33 张 PNG**（编号 01–10、12–26、30–37；11 与 27–29 号不存在）。

> **2026-11-01 v0.4**：学习模式已移除（面板不再有学习模式选择器/阶段学习卡/术语表，`/flow learn` 命令与 `learning` 配置/投影字段下线）。03/17/33 等历史截图里的学习模式与阶段卡保留为历史记录。环境：隔离 `DSH_HOME=/tmp/fg-demo-home` 的 `flowgate-dev` profile（web 模板 + `link:` 安装本仓库），工作区是 `examples/ts-todo-api` 的副本，**没有动日常 `desktop` profile**。
复现方式见 [../impl/host-integration.md](../impl/host-integration.md)；2026-10-31 追加轮的完整方法、逐项结论与未验证项见 [../impl/web-walkthrough.md](../impl/web-walkthrough.md)。

| 截图 | 内容 |
|---|---|
| [01-statusbar-home.png](01-statusbar-home.png) | 输入框上方状态条（dock）：`◆ FlowGate 空闲 │ 无进行中变更 · /flow new 立项`，未初始化/空闲态为灰色 |
| [02-conversation-commands.png](02-conversation-commands.png) | 会话视图里的状态条 + `/flow status`、`/flow doctor` 的命令输出（命令结果不进模型消息，以可折叠行渲染） |
| [03-panel-overview.png](03-panel-overview.png) | 右侧栏 FlowGate 面板：学习模式三档、8 个视图标签、七阶段流程、阶段卡（做什么/为什么/合格标准/产物/方法来源/反模式/正反例）与术语表 |
| [04-panel-change.png](04-panel-change.png) | 有进行中变更（C-002）时的面板：变更编号、标题、复杂度/风险与阶段进度 |
| [05-model-tool-call.png](05-model-tool-call.png) | 模型链路打通后：模型调用 `flow_status` 工具，把快照字段复述给用户（修复"注入消息 source kind"与"工具结果非 JSON"之后） |
| [06-doctor-capabilities.png](06-doctor-capabilities.png) | `/flow doctor` 的宿主能力清单：工具 15/15、守卫心跳、投影 ✓、`appendPluginRecord` ✓（对照剩余的 ✗ 项） |
| [07-allow-once.png](07-allow-once.png) | `/flow allow-once R-STAGE-SRC …` 单次放行记录（OV-1），说明人工放行只经命令、记账留痕 |
| [08-statusbar-s1.png](08-statusbar-s1.png) | 立项后状态条：`◆ FlowGate C-001 中 · 普通风险 │ ① 需求澄清 │ 下一步：写澄清/需求产物后 flow_submit({gate:"G1"})` |
| [09-preset-menu.png](09-preset-menu.png) | Agent 预设菜单中出现 **FlowGate 工程模式** 与 **FlowGate 执行者**（`cordis.patch.yml` 的 preset 行在真实宿主生效；reviewer 只供审查子 agent） |
| [10-doctor-final.png](10-doctor-final.png) | 修复后的 `/flow doctor` 自检最终态（命令结果以可折叠行渲染：插件版本 0.1.0 / 项目根；展开后的完整能力清单见 06） |
| [12-delivery-report.png](12-delivery-report.png) | S0→S6 完整闭环后的交付报告（`ts-todo-api` C-002，归档 HTML，M-1~M-18 指标；不是测试 fixture） |

### 2026-10-31 追加（真实 Web 宿主交互走查，详见 [../impl/web-walkthrough.md](../impl/web-walkthrough.md)）

| 截图 | 内容 |
|---|---|
| [13-preset-menu-in-session.png](13-preset-menu-in-session.png) | 真实会话 composer 的 Agent 预设菜单：7 项中含 **FlowGate 工程模式 / FlowGate 执行者 / FlowGate 只读取证** |
| [14-preset-switched-session.png](14-preset-switched-session.png) | **会话内真实切换**到「FlowGate 工程模式」（`agentPresets/select` → `{"ok":true,"value":"flowgate"}`），预设标签变化、0 page error、状态条未启用态 |
| [15-flow-init-statusbar.png](15-flow-init-statusbar.png) | 真实 UI 输入 `/flow init` 执行成功（命令 chip + `commands/execute`），状态条 `◆ FlowGate 空闲 │ 无进行中变更 · /flow new 立项` |
| [16-flow-new-statusbar-s1.png](16-flow-new-statusbar-s1.png) | 真实 UI 执行 `/flow new 给待办列表增加分享链接 --complexity low` → C-001 进入 S1，状态条 active、75 字符 |
| [17-panel-8-views.png](17-panel-8-views.png) | 点状态条打开右侧栏 FlowGate 面板：8 个视图 tab（台账/流程/门禁/任务/追溯/风险/拦截/指标）+ 七阶段流程 + 当前阶段卡 |
| [18-panel-fallback-report.png](18-panel-fallback-report.png) | 台账「报告」按钮 Remote 不可用 → H10 兜底：命令 `/flow report` 填入输入框 + warn 提示 |
| [19-panel-fallback-continue.png](19-panel-fallback-continue.png) | `/flow pause` 后台账「继续」按钮 → 命令 `/flow resume C-001` 填入输入框 + warn 提示 |
| [20-confirm-card.png](20-confirm-card.png) | 低复杂度方案确认卡（C-001 S3、低复杂度、G3 awaiting）：目标/范围/验证方式 + 确认并推进/退回补充/提高复杂度（状态由离线构造，见走查文档 §2.4） |
| [21-confirm-approve-fallback.png](21-confirm-approve-fallback.png) | 确认卡「确认并推进」→ 输入框 `/flow approve G3` |
| [22-confirm-reject-fallback.png](22-confirm-reject-fallback.png) | 确认卡「退回补充」填理由提交 → 输入框 `/flow reject …` |
| [23-confirm-raise-fallback.png](23-confirm-raise-fallback.png) | 确认卡「提高复杂度」→ 输入框 `/flow complexity high …` |
| [24-intercepts-view-harness.png](24-intercepts-view-harness.png) | **组件级**：真实 `InterceptsView` + 真实 `actions.ts` 在 Chrome 渲染 2 条拦截记录（真实宿主零模型下无拦截记录，见走查文档 §2.5） |
| [25-intercepts-feedback-harness.png](25-intercepts-feedback-harness.png) | 组件级：点「误判反馈」展开理由表单 |
| [26-intercepts-allow-once-harness.png](26-intercepts-allow-once-harness.png) | 组件级：填理由后「放行一次」→ `performAction` fallback=true，`/flow allow-once R-STAGE-SRC <理由>` 写入输入框 |

### 2026-11-01 追加（v0.2 图形化流程 + 卡片化授权：真实 Web 宿主 E2E）

采集时间 2026-11-01 00:16–00:23（Asia/Shanghai）；**2026-11-01 01:16–01:19 在「原生风格/宽度改造」后的重建上重拍 30–33**。环境：隔离 `DSH_HOME=/tmp/fg-v2/dsh-home`、`HOME=/tmp/fg-v2/home` 的 `flowgate-dev` profile（web 模板 + `link:` 安装本仓库），工作区 `/private/tmp/fg-v2/projA`（`examples/ts-todo-api` 副本，git 基线 `78fc6a8`），宿主 `dsh --profile flowgate-dev --host 127.0.0.1 --port 7130 --no-open`（未占用 60747），浏览器为全局 playwright 1.60 + 系统 Chrome，视口 1600×1000。构建：Lead 原生风格改造重建（2026-11-01 01:14），`lib/client.js` sha256 `17b59e44…`（329.9KB）、`lib/host.js` sha256 `fbfc68f2…`（不变）；**30–33 四张均在该构建下重拍**。

**宽度实测（真实宿主 1600×1000，Playwright `getBoundingClientRect`；awaiting 带卡 与 active 仅轨道两态都测）**：宿主 `--dsh-chat-content-width` 解析值 **844.8px**，`--dsh-composer-side-clearance` **16px**，可用列宽（composer hero 外框）**908.8px**。按原生 PlanReviewPanel 公式：composer 输入卡 = 可用列宽 − 2×clearance = **876.8px**（实测内容宽 877px，Δ0.2）；plan 授权卡 frame padding = clearance+16 = 32px，`max-width=var(--dsh-chat-content-width)`，故 **dock-inner == auth-card == 844.8px == var 解析值（±0px）**，比 composer 卡窄 32px = 2×clearance 属**宿主原生设计**。左右收敛：dock-inner 距可用列宽左右各内缩 **32px（= clearance+16，±0px）**；距 composer 输入卡左右边缘各内缩 **16px（= clearance，±0px）**；水平居中（inner 中点 936.49 == 列中点 936.49）。两态实测数字一致；断言 11/11（active）与 13/13（awaiting）全过，脚本 `/tmp/fg-v2/g2-measure.cjs`。

**零模型请求声明**：`DEEPSEEK_API_KEY=sk-fake-unlock-only` 仅用于解锁 UI，全程没有发出任何 completion / 模型请求（本轮 0 pageerror / 0 console.error）。G3 awaiting 状态按 [web-walkthrough.md §2.4](../impl/web-walkthrough.md) **离线构造**（编辑 `.flowgate/changes/C-001/status.json` + 写 proposal/spec/tasks 产物后重启宿主，属既有披露口径）；而「点击授权卡 → 状态推进」走的是**真实宿主命令链路**（`bridge.runCommand` → 宿主命令 remote 执行 `/flow approve G3` → 宿主引擎写盘）。截图复现脚本：`/tmp/fg-v2/g-active.cjs`（30 号，12 项断言全过）与 `/tmp/fg-v2/g-awaiting.cjs`（31–33 号；44 项断言中 43 项通过，唯一未过项是旧断言 `auth-card data-tone="attention"`——原生改造后 data-tone 改为 strip 语义 `warn`，`data-kind/data-gate/data-action` 均未变，属预期契约演进）；基线脚本 `/tmp/fg-v2/baseline.cjs`。

| 截图 | 内容 |
|---|---|
| [30-flow-dock-active.png](30-flow-dock-active.png) | 原生风格 dock（活跃态 C-001 · S1）：中性灰阶七阶段轨道（已完成/当前脉冲/门标记）+ 自然语言下一 chip「补齐需求澄清产物」，宽 844.8px 与内容列/原生 plan 卡对齐 |
| [31-flow-auth-card.png](31-flow-auth-card.png) | 原生 PlanReviewPanel 风格授权卡（G3 awaiting）：顶部 warn 色 strip 小字（等你确认方案 · G3）+ 白色卡体（目标/验收场景/范围/验证方式/StateDot 检查项 3/3）+ 黑色实心主按钮「确认并推进」与 outline「提高复杂度 / 退回补充 / 详情」；卡宽 844.8px 与轨道左右边缘对齐 |
| [32-flow-approved.png](32-flow-approved.png) | 点「确认并推进」后：授权卡消失、G3 通过、阶段推进到 S4（轨道 S0–S3 完成、S4 当前）、dock 提示「已执行」，**输入框始终为空**（宿主写盘 stage=S4 / G3 passed） |
| [33-panel-flow-map.png](33-panel-flow-map.png) | 面板流程页（中性风格）：面板头轨道、hero「④ 执行 · 你在这里」+ 灰阶 4/7 进度环、七阶段纵向时间线与门状态（G0–G3 已通过）、当前节点高亮、下一步 callout「按执行图开始下一个任务」 |

限制（如实披露）：原生 `ask_user_question` 提问卡与 `flow_*` 工具调用的 toolview 需要模型真正跑一轮才会出现；本轮零模型请求只验证了组合面（`preset-flowgate` 已含 `@deepseek-ai/dsh-tool-ask-user`、web 组合含 `dsh-client-ui-user-questions`），**未覆盖**原生提问卡真机渲染。目视核对（本轮）：无大色块/彩虹轨道；活动元素颜色均来自宿主语义 token（当前阶段蓝 `#4176e6`、awaiting 徽标 warn 橙、strip 为 warn tertiary 浅底、检查项 StateDot 绿），主按钮为黑底白字、退回落款为 outline + 错误色文字（无蓝/红实心按钮），符合「少用花哨颜色」。旧观察项 `flow_submit(...)` 文案已在上一轮修复，本轮 dock/面板 callout 均为自然语言。

### 2026-11-01 v0.3 追加（子代理拓扑 / 后台任务视图：真实宿主空态 + 组件级 populated）

采集时间 2026-11-01 01:38–01:52（Asia/Shanghai）；**34 号于 01:48 用「工作流图窄栏自适应」修复后的重建重拍**。环境：隔离 `DSH_HOME=/tmp/fg-v2/dsh-home`、`HOME=/tmp/fg-v2/home` 的 `flowgate-dev` profile（web 模板 + `link:` 安装本仓库），工作区 `/private/tmp/fg-v2/projA`，宿主 `dsh --profile flowgate-dev --host 127.0.0.1 --port 7130 --no-open`（未占用 60747），Playwright 1.60 + 系统 Chrome，视口 1600×1000。构建：v0.3 窄栏修复重建（2026-11-01 01:44），`lib/client.js` sha256 `ca85666cd1f4c5ef76df68f78f4789dbc8ada9bd11d738b9fa0b3288dcbd6ce3`（411,591B）、`lib/host.js` sha256 `fbfc68f2…`（不变）；35/36 仍为同轮早先构建（`f9cdfd4b…`）的组件级截图（树 / jobs 组件未改动，复核无回归）。复现脚本：`/tmp/fg-v2/k-realhost.cjs`（真实宿主 smoke）、`/tmp/fg-v2/k-preview.cjs`（35/36 组件级截图）、`/tmp/fg-v2/k2-preview.cjs`（34 重拍 + 560/719 溢出断言）。

**真实宿主零模型验证（22/22 断言通过）**：面板现为 **10 个 tab**（旧 8 个 + `子代理` / `后台`，新 tab 插在「任务」之后）；点击 `子代理` 渲染 `[data-flowgate="view-agents"]` 空态「运行中 0 / 共 0 · 暂无子代理 · S4 派发执行者/审查者/调查者后显示拓扑」；`后台` 渲染 `[data-flowgate="view-jobs"]` 空态「当前没有后台任务」；旧 8 tab 全部正常（`view-ledger/pipeline/gates/tasks/trace/risk/intercepts/metrics`）；授权卡与宽度无回归（G3 awaiting 卡正常，`dock-inner` 844.8 == `--dsh-chat-content-width` 844.8、`auth-card` 844.8）；**0 pageerror / 0 console.error / 0 模型请求**。`--dump-config` 确认 web 组合含 `job-controller = @deepseek-ai/dsh-api-job-controller`（L455，决定 `ctx.jobs` 可用）与 `ui-workspace = @deepseek-ai/dsh-client-ui-workspace`（L578，`openSubagentSession` 依赖）。窄栏修复重建（`ca85666c…`）下重跑 smoke 仍 **22/22 通过**、0 pageerror / 0 console.error / 0 模型请求。空态截图（未入库）见 `/tmp/fg-v2/k-panel-agents-empty.png`、`k-panel-jobs-empty.png`。

**组件级 populated 证据声明（34–36）**：本轮零模型请求**无法真机产生**子代理 / 后台 job；三张图为**组件级**证据——取自 viz 预览页 `/tmp/fg-viz-preview/runtime-preview.html`（**真实组件 + 真实 `--dsw-*` token CSS + 固定 fixture 数据**，fixture 见 `test/client/mock.ts`），Playwright 系统 Chrome 截取为 1600×1000；仅在预览页内做了「单面板居中」的排版处理，组件与数据未改。真机 populated 需模型运行，**不能**当作真实宿主 populated 证据。

| 截图 | 内容 |
|---|---|
| [34-panel-subagents-graph.png](34-panel-subagents-graph.png) | 子代理**工作流图**（**560px 侧栏宽、自上而下**，组件级 fixture）：主会话 → 竖向主干 → 批次组 B1（`顺序` tag，已完成，执行者 T1 绿点）/ B2（`并行` tag，运行中，执行者 T2 蓝点）→ 服务组（审查者 / 终审 / 调查者，组内卡片 flex-wrap）；顶部「运行中 1 / 共 5」与「工作流图 / 树」模式切换；graph 容器 **508px，0 横向溢出** |
| [35-panel-subagents-tree.png](35-panel-subagents-tree.png) | 子代理**树**模式（560px 侧栏宽，组件级 fixture）：批次 / 执行者 / 服务层级 + 状态「已完成 / 运行中 / 空闲」+ 各行「打开会话」入口 |
| [36-panel-jobs.png](36-panel-jobs.png) | **后台任务**（560px 侧栏宽，组件级 fixture）：运行中 `pnpm test --watch` 展开实时输出 + 两段式「确认终止」（armed，淡红底）+ 已终止（stopped by owner）/ 失败（退出码 2）/ 完成（退出码 0）行；4 行覆盖 running / completed / failed / killed |

**布局观察（原问题已修复，2026-11-01 01:44 重建）**：`子代理` 的**工作流图**已改为窄栏**自上而下**布局（主会话 → 竖向主干 → 逐组垂直堆叠的批次组 / 服务组，组内卡片 flex-wrap）。实测 `[data-flowgate="agents-graph"]`：**560px 容器 clientWidth=scrollWidth=508（横向溢出 0px）**、**719px 容器 667/667（0px）**；修复前同样两侧栏宽度下曾分别溢出 421px / 262px。tree / jobs 视图复核无回归、560px 下仍 0 溢出。**风格核对**：中性 token，无大色块 / 彩虹；饱和色仅 8px StateDot（蓝/绿/黄/红语义点）与 armed 终止按钮（62×24、10% 红底），无大面积色块。

### 2026-11-01 追加（v0.4 移除学习模式：真实 Web 宿主验证）

采集时间 2026-11-01 02:07（Asia/Shanghai）。环境：隔离 `DSH_HOME=/tmp/fg-v2/dsh-home`、`HOME=/tmp/fg-v2/home` 的 `flowgate-dev` profile（link 本仓库），宿主 `dsh --profile flowgate-dev --host 127.0.0.1 --port 7130 --no-open`，Playwright 1.60 + 系统 Chrome，视口 1600×1000。构建：v0.4 移除学习模式后重建，`lib/client.js` sha256 `f5c7016c…`、`lib/host.js` sha256 `244d3b8b…`。**零模型请求**（fake key 仅解锁 UI）。

| 截图 | 内容 |
|---|---|
| [37-panel-pipeline-v04.png](37-panel-pipeline-v04.png) | v0.4 面板 Pipeline：**面板头已无学习模式选择器**；图形流程页保留 hero/flow-map/产物 chips/实时检查项/下一步 callout；**不再渲染阶段学习卡与术语表** |

本轮真实宿主断言 **14/14 PASS**：10 tab；面板 `[data-flowgate="learning-mode"]` count 0 且 header 文案无「学习模式」；Pipeline 无 `stage-card`/`glossary`，有 `flow-map`（14 个 artifact chips）与 next-step callout；`/flow help` 不含 learn；`/flow learn brief` 返回「未知子命令：learn」；旧 `.flowgate/config.yaml` 追加 `learning: brief` 后宿主重载仍正常；0 pageerror / 0 console.error / 0 模型请求。证据 `/tmp/fg-v2/v04-e2e.json`、脚本 `/tmp/fg-v04-e2e.cjs`。历史截图 03/17/33 等仍含学习模式/阶段卡，保留为历史记录。

## 说明

- 截图中会话里的 `DeepSeek Messages transport failed` 是**隔离 demo home 的环境限制**（复制的凭据是引用式，只有桌面宿主能解析），不是插件问题；`/flow` 命令、状态条、面板、工具注册都在这个宿主里真实工作。
- 采集时 `appendPluginRecord` 在隔离 home 里不可用（peer 解析差异），面板数据走 host 内存快照兜底；正常安装时走会话插件记录，行为一致。
- 自动接续（打开页面即接续 C-001）与**覆盖自检修复后的 doctor 扩展明细**截图仍待补：这两类截图**可以离线补做**（Playwright + Chrome 在本机可用：全局 `playwright@1.60.0` + 系统 Chrome，见 [web-walkthrough.md §1](../impl/web-walkthrough.md#1-环境与验证对象)；用真实 DSH Web 宿主渲染即可，不需要模型请求），**不属于环境受限**；上次自动接续截图失败是 UI 导航脚本超时，属工具问题。列入后续补拍；文本证据见 implementation-status §3.3。
- 低复杂度方案确认卡（20–23）与拦截视图误判反馈（24–26）已在 2026-10-31 追加轮补拍；其中拦截反馈只有**组件级**证据。**仍缺**：真实 guard 拦截 → 面板拦截行 → 误判反馈的端到端链路（组件级不算），需要真模型或让宿主执行一次真实被拦截的工具调用——这是目前唯一必须真模型才能补的截图证据。
- 2026-10-31 追加轮的 13–26 号截图来自另一个隔离 home（`DSH_HOME=/tmp/fg-walk/dsh-home`、`HOME=/tmp/fg-walk/home`）与 11:06 构建快照（`lib/host.js` sha256 `9341766c…`），**全程未发模型请求**：确认卡的状态是离线构造的（见 [../impl/web-walkthrough.md](../impl/web-walkthrough.md) §2.4），拦截反馈只有组件级证据（§2.5）。该轮还发现真实问题：宿主重启后投影 revision 回退导致面板/状态条显示旧快照（§5.1）。
- 本轮走查发现并修复的真实问题见 [../impl/implementation-status.md](../impl/implementation-status.md) §3.1。
