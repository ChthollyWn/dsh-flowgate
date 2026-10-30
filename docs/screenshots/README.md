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

## 说明

- 截图中会话里的 `DeepSeek Messages transport failed` 是**隔离 demo home 的环境限制**（复制的凭据是引用式，只有桌面宿主能解析），不是插件问题；`/flow` 命令、状态条、面板、工具注册都在这个宿主里真实工作。
- 采集时 `appendPluginRecord` 在隔离 home 里不可用（peer 解析差异），面板数据走 host 内存快照兜底；正常安装时走会话插件记录，行为一致。
- 低复杂度方案确认卡、拦截视图的误判反馈、批准/退回按钮点击流程等截图待补（需要模型可用的桌面会话；按钮 Remote 不可用时走"填命令"兜底）。
- 本轮走查发现并修复的真实问题见 [../impl/implementation-status.md](../impl/implementation-status.md) §3.1。
