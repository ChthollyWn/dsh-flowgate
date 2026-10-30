# 实现状态报告（v0.1 交付时点）

> 日期：2026-10-30。基线：DSH `0.2.1-rc.5`。对应执行方案：[docs/04-执行方案.md](../04-执行方案.md)。
> 本报告按里程碑说明**已完成 / 部分完成 / 未开始**，并给出可复现的验证命令。功能状态的对外表述以本文件为准。

## 1. 总览

| 里程碑 | 计划内容 | 状态 | 说明 |
|---|---|---|---|
| M0 预研与脚手架 | 隔离开发 profile、探针、工程化 | ✅ 完成 | 26 条假设实测；spike 在隔离 `DSH_HOME` 真实加载；pnpm+TS+tsdown+vitest+CI 就绪 |
| M1 门禁内核、项目目录与工程模式 | 状态机、规则引擎、账本、守卫、命令、状态条 | ✅ 完成 | 迁移表数据驱动测试；守卫双保险；账本哈希链 + HMAC；`/flow` 命令族与 14 个工具 |
| M2 规格层 | 产物检查、澄清/上下文/设计/拆解、路线图、执行图、引用 | ✅ 完成 | 46 项门禁检查（每项正反例）；执行图 mermaid；技术栈探测；路线图 GR |
| M3 执行纪律与跨会话接续 | 范围/TDD/证据/审查/风险/接续/返工 | ✅ 完成 | 验证由插件执行、输入哈希过期、并发会话租约、`/flow repair` |
| M4 交付闭环、工程判断、派发、上下文 | S5/S6/指标/派发/压缩/交接/并行/分析 | ✅ 主体完成 | 派发/worktree/集成检查点在 host 侧接线；缺 provider/git 时降级 |
| M5 可视化与学习 | 面板 8 视图、阶段卡、HTML 报告、看板 | 🟡 实现完成，浏览器交互待实测 | client bundle 离线验证 + SSR 渲染测试通过；真实 web 宿主未跑交互 |
| M6 评测、加固与发布 | 基准评测、故障注入、兼容矩阵、文档发布 | 🟡 部分 | 兼容验证脚本 + 真实导入验证已有；对照评测未执行；未发布 npm |

## 2. 可复现验证（截至本报告）

```bash
pnpm install
pnpm lint        # 分层规则（core 不得依赖 DSH/host/client）+ tsc --noEmit
pnpm test        # 61 个测试文件 / 925 用例
pnpm build       # lib/host.js（ESM）+ lib/client.js（loader 包装）
pnpm verify:client
pnpm verify:package
DSH_HOME=/tmp/fg-home node scripts/verify-dsh-compat.mjs --profile flowgate --write
# 真实 DSH 进程组合并导入插件（隔离 DSH_HOME，不碰日常 profile）：
DSH_HOME=/tmp/fg-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile flowgate --dump-config
DSH_HOME=/tmp/fg-home "…/dsh" --profile flowgate --dump-config-schema >/dev/null
```

最近一次结果：lint 通过（119 个源文件）；`test` 61 files / 925 tests 全绿；构建产物 host 977KB / client 181KB；`verify:package` 通过；`verify:client` 通过；`verify:compat` 7 项全过并写入 [compat/0.2.1-rc.5.md](../compat/0.2.1-rc.5.md)。核心逻辑覆盖率：语句 82.4% / 分支 67.7% / 函数 85.7% / 行 87.1%（`pnpm coverage`）。

## 3. 关键实现决策（与 03 方案的差异）

1. **入口形态**：package.json 无 host/client 入口字段；host=`main`（`lib/host.js`），client=`exports["./client"]`（`lib/client.js`），client 产物是 `window.__ModuleLoader__.load({id, factory})` 包装。见 [dsh-plugin-api-cheatsheet](dsh-plugin-api-cheatsheet.md) §2–§4。
2. **零宿主核心依赖**：host 不静态 import `@deepseek-ai/*`；`appendPluginRecord` 运行时探测（缺失时降级 `session.append`，doctor 可见）。因此包不把宿主核心包带进依赖树（NFR-3）。
3. **投影 stateSchema**：rc.5 只调用 `.parse()`，用本地 passthrough schema，不引入 zod。
4. **面板动作**：Typert Remote 需要构建期生成器，v0.1 不做；按钮走"把 `/flow …` 填进输入框"的兜底（人工动作只允许人触发）。doctor 会标注降级。
5. **会话事件**：`session.append` 不能写任意类型，改用 `appendPluginRecord('plugin:dsh-flowgate/state')`（实验性逃生舱，可丢弃记录语义）。
6. **守卫**：`tools/pre-execute`（async 判定）+ `ctx.tools.guard`（sync 消费缓存）双保险；判定缺失/异常时受管控会话 fail-closed、未初始化会话放行。
7. **测试输出压缩**：post-execute 替换后 durable 日志即替换内容，所以全文先写 `.flowgate/state/evidence/<id>.log`。

## 3.1 真实 Web 宿主端到端走查（2026-10-30，P0-1）

在隔离 `DSH_HOME` 的 `flowgate-dev` profile 里用真实 DSH 0.2.1-rc.5 web 宿主 + Chrome（playwright-core）走查，**日常 desktop profile 哈希前后一致**。结论：

| 项 | 结果 |
|---|---|
| 插件组合与加载 | ✅ 组合树含 `dsh-flowgate` 行 + 3 个 preset；web 宿主启动无 `did not activate` |
| 浏览器 bundle | ✅ 启动图加载 `dsh-flowgate/client.js`（combo HTTP 200），client 插件 `apply` 成功 |
| `/flow` 命令族 | ✅ `/flow status`、`/flow init`、`/flow doctor`、`/flow new` 在真实会话中执行，输出渲染在会话里 |
| `/flow init` 产物 | ✅ 在示例仓库生成 `.flowgate/`（config.yaml、project.md、state、目录内 `.gitignore` 等） |
| 模型工具 | ✅ 修复后 **14/14 注册成功**（doctor 可见工具清单） |
| 输入框状态条 | ✅ dock 渲染 `◆ FlowGate …`，≤120 字符、颜色分级、点击可打开面板 |
| 右侧栏面板 | ✅ 两段式注册生效；8 视图标签、学习模式、七阶段流程、阶段卡与术语表渲染正常；有变更时显示变更编号/标题/等级 |
| 会话投影 | ⚠️ 隔离 home 里 `appendPluginRecord` 不可解析 → 走 host 内存快照兜底（正常安装时走插件记录） |
| 模型调用 | ⚠️ 隔离 demo home 的凭据是引用式，`DeepSeek Messages transport failed`；工具调用/守卫拦截需要桌面会话或有效 API key 才能端到端演示 |

**本轮走查发现并修复的真实问题（均已加回归测试）：**

1. **client 插件激活失败**（`web boot: 1 entry did not activate`）：Cordis 上下文禁止读取未 `inject` 的服务，client 的侧栏快速路径直接读 `ctx.sidebarRightTabs` 抛错。改为只走 `ctx.inject`，并新增"严格 Cordis 上下文"回归测试。
2. **dock 状态条不渲染**：`conversation.input.dock` 由对话 entry 的 children 表声明，插件 apply 时尚未声明。改用 `ctx.slots.inject('conversation.input.dock', …)` 延迟注册（与官方 UI 插件同一写法）。
3. **14 个模型工具全部注册失败**：`ctx.tools.register` 只接受受支持 JSON Schema 子集，原 `output.schema` 用了类型数组（`type: [...]`）。改为 `oneOf` 单类型集合，全部注册成功。
4. **会话日志损坏风险**：`appendPluginRecord` 不可用时曾降级 `session.append('plugin:…')`，rc.5 会把它持久化成语义不完整的事件，下一次加载报 `session event at seq N lacks an identified message` 并使会话损坏。已删除该降级路径（只写插件记录；不可用则投影退回内存快照），并对插件记录做 JSON 无损化。
5. **投影兜底**：新增 latest-snapshot 兜底——任意已提交事件都从 host 内存最新投影刷新，不依赖实验性记录 API。

复现脚本与截图见 [screenshots/](../screenshots/README.md)。走查用的 demo workspace 在 `~/Developer/WorkSpace/dsh-flowgate-demo/`（可删除）。

## 3.2 模型链路走查（2026-10-30 晚，P0-2）

用真实 DeepSeek API Key（只写入隔离 `DSH_HOME=/tmp/fg-demo-home` 的凭据存储，未进仓库、未提交；已删除）继续在真实 Web 宿主走查，发现并修复 3 个会阻断模型链路的真实问题：

1. **模型请求全部 `TRANSPORT` 失败（根因：注入消息的 source kind）**：host 用 `source: { kind: 'flowgate' }` 注入 user 消息；DSH 的 MessageSource 是 merge-extensible 的封闭登记表，provider 在组装请求时对未知 kind 抛错（在 `fetch` 之前），被 provider 包装成 `DeepSeek Messages transport failed`。逐层定位方式：给插件加 `FLOWGATE_DEBUG_FETCH=1` 的 fetch 追踪（记录请求/响应），发现主请求根本没到网络、只有标题请求到达；再用 `FLOWGATE_DISABLE=session,context` 二分确认是注入消息。修复：所有注入消息改用官方 `runtime-context` kind（`{ kind: 'runtime-context', form: 'relay' }`）。
2. **工具结果 `returned invalid output: value is not lossless JSON`**：`flow_status` 等工具把含 `undefined`/类实例的 snapshot 直接作为运行时值返回；DSH 在渲染 content 前校验 JSON 无损。修复：所有工具返回值先做 JSON round-trip（`toLosslessJson`），并加单测。
3. **工具参数 schema 的根级扩展关键字**：`parameters` 根对象曾带 `additionalProperties: true`；官方 `ctx.tools.register` 只接受受支持子集，去掉扩展关键字、保留 `type/properties/required`。
4. 顺带修复：`/flow new <描述>`（只带标题）此前 G0 因"一句话目标为空"卡在 S0；现在 summary 缺省回退为标题，立项即进入 S1。

**本轮实测通过：**
- 模型可正常调用（DeepSeek-V4.1-Flash，经 API Key provider），主请求带 46 个工具、HTTP 200、无 transport 错误；
- `flow_status` 工具调用成功并把当前快照返回给模型（模型复述了 `initialized/stage/nextStep` 等字段）；
- `/flow init`、`/flow new`（C-001 → S1）、`/flow allow-once R-STAGE-SRC`（OV-1）在真实会话执行并留痕；
- `/flow doctor`：**工具 14/14 已注册**、守卫心跳 3 次调用/3 次判定、会话投影 ✓、`appendPluginRecord` ✓（devDependency 让隔离环境也能解析 peer）、会话租约与接管提示正常。

**本轮未完成（下一步）**：
- 真实宿主里"FlowGate 守卫拒绝 S1 写操作"的端到端演示：本次两次尝试都被 DSH 自身的"先读后写"文件策略或会话租约挡住（`/flow resume` 需 `--takeover`），没有真正走到 FlowGate 的 R-STAGE-SRC 判定；守卫规则本身由 host fake-ctx 与 core 单测覆盖。下一步：takeover 后先 read 再 edit，观察 `R-STAGE-SRC` 拒绝与 `allow-once` 放行。
- `restrict`/`presentAs` 仍显示 ✗（scoped-only，应在 `agent/created` 的 agent ctx 上应用，H26 待补）；
- `agent 生命周期事件` 能力标志 ✗（实际 `agent/created` 已在用于会话注入，属检测标志误报，待修）；
- `subagent/sessionQuery/结构化提问/Remote` 在该精简 web 组合未启用（按降级处理）。

## 4. 已知缺口（如实列出）

| # | 缺口 | 影响 | 后续 |
|---|---|---|---|
| 1 | ~~浏览器端交互未在真实 DSH web/desktop 会话里跑过~~（已 2026-10-30 实测，见 §3.1） | 剩余：人工按钮点击流程（Remote 兜底）、低复杂度确认卡 | 用桌面会话补做 |
| 2 | 三个 agent preset 行语法按速查表写出但未在真实会话中切换验证 | 工程模式/执行者/只读 preset 可能需微调 | 隔离 profile 实测后更新 `cordis.patch.yml` |
| 3 | 有 / 无插件对照评测未执行（M6 T6.1） | 无法给出 M-15/M-18 实测数字 | 按 [evaluation.md](../evaluation.md) 跑 9 任务 × 2 条件 |
| 4 | 审查/派发的读取覆盖为事件文本启发式核对；并行依赖 git worktree | 非 git 仓库或 provider 缺失时降级为顺序 | 保留降级提示，M6 加固 |
| 5 | `appendPluginRecord` 属实验性 API | DSH 升级可能失效 | 每个 RC 跑 `verify:compat`；保留降级路径 |
| 6 | 主规格归档合并为"复制增量规格到 `specs/<id>/`"，未做完整 ADDED/MODIFIED/REMOVED 合并 | 归档后的主规格不是 OpenSpec 的最终形态 | v1.0 前按 T4.4 补齐 |
| 7 | 覆盖率分支 67.7% 低于 80% 目标 | 部分错误/降级分支缺测 | 补 config 错误分支、host 降级路径测试 |

## 5. 文件地图（主干）

- 纯逻辑：`src/core/{state,rules,shell,artifacts,plan,citations,detect,roadmap,ledger,store,evidence,risk,revision,metrics,report,dashboard,learn}/`，编排入口 `src/core/engine.ts`。
- 宿主适配：`src/host/`（入口 `index.ts`；`adapters/`、`guard/`、`commands/`、`tools/`、`projection/`、`review/`、`dispatch/` 等）。
- 浏览器半侧：`src/client/`（`dock/StatusBar.tsx`、`panel/` 8 视图、`learn/`、`actions.ts`、`i18n/`）。
- 内容：`skills/`（15 技能 × SKILL+learn）、`examples/`（3 个基准仓库）、`docs/`（00–04 原始方案 + 本目录实现文档 + spike-report + compat）。
- 脚本：`scripts/{lint-layers,verify-package,verify-client-bundle,verify-dsh-compat}.mjs`；CI：`.github/workflows/ci.yml`。

## 6. 下一步（按优先级）

1. 隔离 web profile 起真实宿主，手工走查状态条/面板/按钮，截图并修复问题。
2. 在真实宿主里切换三个 preset，确认工程模式可用；更新 `cordis.patch.yml` 的"待实测"注释。
3. 用 `examples/java-renewal` 跑一次完整 S0→S6（含审查/派发/报告），产出真实交付报告与指标。
4. 执行 M6 对照评测与故障注入；补归档主规格合并；补覆盖率缺口。
5. npm 发布与 README 截图/演示动图；awesome-dsh-plugin 收录申请。
