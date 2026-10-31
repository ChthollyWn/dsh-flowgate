# 界面截图（真实 DSH 0.2.1-rc.5 Web 宿主）

采集时间：2026-10-30 20:06（Asia/Shanghai）；2026-10-31 11:19 追加"真实 Web 宿主交互走查"一轮（13–26 号，见下方分节）。
当前共 **25 张 PNG**（编号 01–10、12–26；11 号不存在）。
环境：隔离 `DSH_HOME=/tmp/fg-demo-home` 的 `flowgate-dev` profile（web 模板 + `link:` 安装本仓库），工作区是 `examples/ts-todo-api` 的副本，**没有动日常 `desktop` profile**。
复现方式见 [../impl/host-integration.md](../impl/host-integration.md)；2026-10-31 追加轮的完整方法、逐项结论与未验证项见 [../impl/web-walkthrough.md](../impl/web-walkthrough.md)。

| 截图 | 内容 |
|---|---|
| [01-statusbar-home.png](01-statusbar-home.png) | 输入框上方状态条（dock）：`◆ FlowGate 空闲 │ 无进行中变更 · /flow new 立项`，未初始化/空闲态为灰色 |
| [02-conversation-commands.png](02-conversation-commands.png) | 会话视图里的状态条 + `/flow status`、`/flow doctor` 的命令输出（命令结果不进模型消息，以可折叠行渲染） |
| [03-panel-overview.png](03-panel-overview.png) | 右侧栏 FlowGate 面板：学习模式三档、8 个视图标签、七阶段流程、阶段卡（做什么/为什么/合格标准/产物/方法来源/反模式/正反例）与术语表 |
| [04-panel-change.png](04-panel-change.png) | 有进行中变更（C-002）时的面板：变更编号、标题、复杂度/风险与阶段进度 |
| [05-model-tool-call.png](05-model-tool-call.png) | 模型链路打通后：模型调用 `flow_status` 工具，把快照字段复述给用户（修复"注入消息 source kind"与"工具结果非 JSON"之后） |
| [06-doctor-capabilities.png](06-doctor-capabilities.png) | `/flow doctor` 的宿主能力清单：工具 14/14、守卫心跳、投影 ✓、`appendPluginRecord` ✓（对照剩余的 ✗ 项） |
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

## 说明

- 截图中会话里的 `DeepSeek Messages transport failed` 是**隔离 demo home 的环境限制**（复制的凭据是引用式，只有桌面宿主能解析），不是插件问题；`/flow` 命令、状态条、面板、工具注册都在这个宿主里真实工作。
- 采集时 `appendPluginRecord` 在隔离 home 里不可用（peer 解析差异），面板数据走 host 内存快照兜底；正常安装时走会话插件记录，行为一致。
- 自动接续（打开页面即接续 C-001）与**覆盖自检修复后的 doctor 扩展明细**截图仍待补：前者本轮 UI 导航脚本超时采集失败，后者现有 10 号只是可折叠的命令行、无法作为覆盖自检明细证据；文本证据见 implementation-status §3.3。
- 低复杂度方案确认卡（20–23）与拦截视图误判反馈（24–26）已在 2026-10-31 追加轮补拍；其中拦截反馈只有**组件级**证据。**仍缺**：真实 guard 拦截 → 面板拦截行 → 误判反馈的端到端链路（组件级不算），需要真模型或让宿主执行一次真实被拦截的工具调用。
- 2026-10-31 追加轮的 13–26 号截图来自另一个隔离 home（`DSH_HOME=/tmp/fg-walk/dsh-home`、`HOME=/tmp/fg-walk/home`）与 11:06 构建快照（`lib/host.js` sha256 `9341766c…`），**全程未发模型请求**：确认卡的状态是离线构造的（见 [../impl/web-walkthrough.md](../impl/web-walkthrough.md) §2.4），拦截反馈只有组件级证据（§2.5）。该轮还发现真实问题：宿主重启后投影 revision 回退导致面板/状态条显示旧快照（§5.1）。
- 本轮走查发现并修复的真实问题见 [../impl/implementation-status.md](../impl/implementation-status.md) §3.1。
