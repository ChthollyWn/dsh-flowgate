# 界面截图（真实 DSH 0.2.1-rc.5 Web 宿主）

采集时间：2026-10-30 20:06（Asia/Shanghai）。
环境：隔离 `DSH_HOME=/tmp/fg-demo-home` 的 `flowgate-dev` profile（web 模板 + `link:` 安装本仓库），工作区是 `examples/ts-todo-api` 的副本，**没有动日常 `desktop` profile**。
复现方式见 [../impl/host-integration.md](../impl/host-integration.md)。

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
| [12-delivery-report.png](12-delivery-report.png) | S0→S6 完整闭环后的交付报告（`ts-todo-api` C-002，归档 HTML，M-1~M-18 指标；不是测试 fixture） |
| [09-preset-menu.png](09-preset-menu.png) | Agent 预设菜单中出现 **FlowGate 工程模式** 与 **FlowGate 执行者**（`cordis.patch.yml` 的 preset 行在真实宿主生效；reviewer 只供审查子 agent） |

## 说明

- 截图中会话里的 `DeepSeek Messages transport failed` 是**隔离 demo home 的环境限制**（复制的凭据是引用式，只有桌面宿主能解析），不是插件问题；`/flow` 命令、状态条、面板、工具注册都在这个宿主里真实工作。
- 采集时 `appendPluginRecord` 在隔离 home 里不可用（peer 解析差异），面板数据走 host 内存快照兜底；正常安装时走会话插件记录，行为一致。
- 自动接续（打开页面即接续 C-001）与覆盖自检修复后的 doctor 截图在本轮采集失败（UI 导航脚本超时），文本证据见 implementation-status §3.3；待补。
- 低复杂度方案确认卡、拦截视图的误判反馈、批准/退回按钮点击流程等截图待补（需要模型可用的桌面会话；按钮 Remote 不可用时走"填命令"兜底）。
- 本轮走查发现并修复的真实问题见 [../impl/implementation-status.md](../impl/implementation-status.md) §3.1。
