# 自动流程：接管、路由自评与 auto-review（v0.5）

> 状态：2026-11-01 实现（core/host/client + 测试）；真机零模型 E2E 见文末验收记录。
> 关联需求：负责人 2026-11-01 指令——启用 FlowGate 后所有修改由 FlowGate 接管；模型在流程开始前判断改动大小，复杂走全流程、中等合并、简单不人工确认；设计 auto-review 机制自动决定是否需要人工确认与是否缩减合并流程。
> **v0.6 补充**：新增 `takeover` 三态（自举仓库默认 observe：仅对 `R-NO-CHANGE` 未立项写入放行并记账，其余规则照常拦截，§10）、`R-NO-CHANGE` 解锁话术
> 指向修复通道、以及变更车道与修复车道的边界（§11，修复通道详见 [repair-lane.md](repair-lane.md)）。

## 0. 三条结论

1. **接管**：项目 `/flow init` 后，没有进行中的变更时，任何会改变仓库的动作（写文件、mutating shell、委派）一律拒绝（`R-NO-CHANGE`，守卫返回明确解锁话术：先 `flow_new_change`）。只读操作与 `flow_*` 工具不受影响。
2. **路由**：模型在 `flow_new_change` 的 `assessment` 参数里自评规模/清晰度并建议 `route`；**宿主 auto-review 做确定性复核**（不是第二个模型），必要时调整并把理由写入 `FlowPlan.checks` 与账本。
3. **按路由执行**：
   - `full`：严格全流程，四道人工门（GR/G1/G3/G6）照旧；
   - `standard`：合并 G1+G3 为一次人工确认，G6 人工；
   - `fast`：G1/G3/G6 **检查通过后自动通过**（不生成授权卡片），状态机自动推进到交付归档；所有门禁检查仍然执行，fast 只省人工等待，不降质量门槛。

## 1. 接管：R-NO-CHANGE

| 场景 | 行为 |
|---|---|
| 未初始化（`/flow init` 前） | 不拦截（与既有 FR-4.6 一致） |
| 已初始化 + 进行中变更 | 按既有阶段/范围/风险规则 |
| 已初始化 + **无进行中变更** | 写/创建/删除/重命名、mutating shell、delegate 一律 deny，ruleId=`R-NO-CHANGE`（**v0.6 解锁话术：修 bug 用 `flow_fix_start` 开修复通道，新功能用 `flow_new_change` 立项**）；`.flowgate`/`.git` 仍由 `R-PROTECTED` 拒绝；只读动作与 `flow_*` 允许 |
| 已初始化 + **修复通道进行中** | 只放行命中修复声明 `scope` 的写动作（`R-FIX-SCOPE` 拒绝越界），shell 受 `R-FIX-SHELL` 白名单约束，delegate/MCP 被 `R-FIX-TOOL` 拒绝；不需要立项（见 [repair-lane.md](repair-lane.md)） |
| 已初始化 + `takeover=observe`（观察模式，v0.6） | **仅"未立项写入"（`R-NO-CHANGE`）放行**，账本记一次 `takeover.observed`（每会话每规则至多一次）并提示；**有进行中变更时，阶段/范围/受保护路径/修复通道 scope 等规则仍按原规则拦截**；自举仓库（项目根是 dsh-flowgate 自身）默认走此模式，避免开发插件时被自己的接管规则拦死（同时保留门禁与观测） |
| 已初始化 + `takeover=off`（safe-mode / 配置） | 全部放行、不记录（比观察模式更彻底；safe-mode 逃生口见 [host-recovery.md](host-recovery.md)） |
| 已初始化 + `off` | 全部放行（负责人 `/flow off` 或 agent 自暂停，写 `flags.off` 并记账） |

实现位置：`src/core/engine.ts#evaluateAction`（无 `change` 分支）复用 `src/core/rules/evaluate.ts#mutatesRepository`，因此写文件与 `pnpm install`/`git push` 等命令同一口径。

### 1.1 接管模式（v0.6）

| 模式 | 何时生效 | 行为 |
|---|---|---|
| `enforce` | 默认 | 硬接管：未立项/未声明修复的写动作拒绝 |
| `observe` | 项目根是 dsh-flowgate 自身（自举检测）；或显式配置 `takeover: observe` | **仅对 `R-NO-CHANGE`（未立项写入）放行**并写 `takeover.observed` + 提示；其余规则（阶段/范围/受保护路径/修复通道 scope/危险命令等）仍按原规则拦截；用于自举开发/试运行 |
| `off` | safe-mode（sentinel/env/config）、显式配置 `takeover: off`、项目暂停（`flags.off` 的另一种形态） | 不拦截不记录（safe-mode 下还会跳过 guard 等模块） |

解析优先级：safe-mode 强制 `off` > 显式 `config.takeover` > 自举检测（`observe`）> 默认 `enforce`；
`/flow doctor` 显示生效模式与原因。

## 2. 模型自评：assessment 字段

`flow_new_change({ title, summary, complexityHint, riskHint, assessment })`：

| 字段 | 类型 | 用途 |
|---|---|---|
| `route` | `full \| standard \| fast` | 建议路由；省略时按复杂度推导（low/medium→standard，high/ultra→full） |
| `autoApprove` | boolean | fast 下是否自动通过人工门（fast 强制 true；其他路由强制 false） |
| `clear` | boolean | 需求是否足够清晰、无需再澄清（fast 必要条件） |
| `goal` | string | 一句话目标 |
| `acceptance` | string[] | 可测量验收要点（fast ≥2 条） |
| `scope` | string[] | 预计改动路径/glob（fast 1–5 条） |
| `verify` | string | 任务验证命令（fast 必填，且通过命令形状校验） |
| `risks` | string[] | 模型识别的风险信号 |
| `reasons` | string[] | 自评理由，写入流程计划供负责人复核 |

未提交 `assessment` 的旧入口（`/flow new` 命令、旧调用）保持既有行为（不自动放行），避免静默改变人工门语义。

## 3. auto-review（确定性复核）

`src/core/flow/routing.ts#reviewFlowAssessment` 按顺序检查，任一失败都会**降级**并记录，不会阻断立项：

| 检查 | 失败时 |
|---|---|
| 风险等级 | 高风险 → `full`、autoApprove=false |
| 复杂度 | high/ultra → `full` |
| 敏感信号（认证/登录/密码/支付/权限/安全/迁移/部署/密钥/数据库/CI，扫描标题+描述+目标+范围） | → `full` |
| fast 复杂度 | 非低复杂度 → `standard` |
| fast 清晰度 | `clear !== true` → `standard` |
| fast 验收 | 不足 2 条 → `standard` |
| fast 验证命令 | 缺失/形状不合法 → `standard` |
| fast 范围 | 0 条或 >5 条 → `standard` |
| 非 fast 自动放行 | 强制 autoApprove=false |

输出 `FlowPlan`：`route/proposedRoute/autoApprove/proposedAutoApprove/verdict('approved'|'adjusted')/checks[]/reasons[]/complexity/risk/assessedAt/assessedBy='auto-review'`。
持久化：`status.json` 的 `change.flowPlan`；账本事件 `flow.assessed`；快照 `snapshot.flowPlan`（客户端徽标）。

## 4. 路由对状态机的影响

| 门 | full | standard | fast |
|---|---|---|---|
| GR（项目路线图） | 人工 | 人工 | 人工（不属于变更自评） |
| G1 | 人工确认 | 检查通过自动进入 S2（与 G3 合并确认） | 检查通过自动通过，进入 S2 |
| G3 | 人工确认 | 人工一次确认（同时批准 G1） | 检查通过自动批准，冻结产物并进入 S4 |
| G6 | 人工确认 | 人工确认 | 检查通过自动交付归档（生成报告、归档目录） |

- fast 的自动批准会像人工批准一样冻结产物（`artifacts.frozen`），后续直接改已批准产物仍会被守卫拒绝。
- G2/G4/G5 本来自动，行为不变；fast 不跳过任何检查（G1 六要素/规格、G2 基线、G3 任务卡/追溯、G5 全量验证/终审都要过）。
- 授权卡片：fast 不再产生 G1/G3/G6 卡片；`awaitingGate` 为空，dock 保持 active。

## 5. 负责人覆盖

`/flow route <full|standard|fast> <理由>`：负责人可在任意时刻覆盖 auto-review（写账本 `flow.route_override`，`assessedBy='owner-override'`）。
硬约束保留：fast 只允许低复杂度 · 普通风险；standard 只允许低/中复杂度 · 普通风险；复杂/高风险必须 full。

## 6. UI

- dock：`[data-flowgate="dock-flow-route"] data-route=... data-auto=... data-verdict=...`，中文文案「自动流程 · fast」等（英语 `Auto flow · fast`）。
- 面板头部：`[data-flowgate="panel-flow-route"]` 同款中性 chip，`title` 为 auto-review 理由。
- 无 flowPlan 的旧投影不显示徽标（向后兼容）。

## 7. 审计与可追溯

| 事件 | 内容 |
|---|---|
| `flow.assessed` | 变更创建时的 route/proposedRoute/autoApprove/verdict/reasons |
| `flow.route_override` | 负责人覆盖 route、理由、from |
| `gate.approved`（auto:true） | fast 自动通过 G1/G3/G6，含 `flowRoute` |
| `artifacts.frozen` | fast G3 自动批准后的产物冻结 |

## 8. 限制与后续

1. **真正的“跳过 S1–S3 直接开发”（direct 模式）未启用**：fast 仍要求产出最小需求/规格/任务卡并通过检查；这是为了不牺牲证据链和 G5/G6 可验证性。若负责人确认要跳过，需要另行设计“最小产物自动生成 + 检查豁免白名单”。
2. **auto-review 是确定性的**，不理解语义；模型可以误报规模。缓解：宿主独立扫描敏感词、fast 必须有 acceptance/verify/scope、复杂/高风险硬降级、全流程检查仍执行、负责人可 `/flow route full` 一票否决。
3. 后续可考虑：只读审查子 agent 对 assessment 做第二意见（成本换准确度）、按仓库变更量估计 scope、`fast` 的 G6 通知（桌面通知/邮件）等。

## 9. 验收

- 新增单测：`test/core/flow/routing.test.ts`（8 类 auto-review 规则）、`test/integration/engine-auto-flow.test.ts`（fast 自动 G1→S4→归档、standard 合并确认、负责人覆盖、高风险降级）。
- 既有测试全绿（见 CHANGELOG/implementation-status 的最终数字）。
- 真机零模型 E2E（隔离 DSH_HOME / flowgate-dev，Chrome+Playwright，1600×1000）：
  - v0.5 徽标 **7/7 PASS**：`/flow help` 含 `/flow route`；创建低复杂度变更后 `/flow route fast 理由` 成功；dock `[data-flowgate="dock-flow-route"]` 与面板 `[data-flowgate="panel-flow-route"]` 均为 `data-route="fast"`、`data-auto="true"`、文案「自动流程 · fast」；pipeline 正常；0 pageerror / 0 console.error / 0 模型请求。截图 [38-panel-auto-flow-v05](../screenshots/38-panel-auto-flow-v05.png)。
  - v0.4 回归 E2E **14/14 PASS**（面板/流程页/无学习模式/旧配置兼容）。
  - 接管拒绝本身无法在零模型真机触发（需要模型发起写工具调用），由 engine 守卫集成测试覆盖；路由行为由 auto-review 单测 + engine fast/standard 集成测试覆盖。


## 10. takeover 观察模式（v0.6）

**问题**：FlowGate 仓库自己的 `package.json` 就是 `dsh-flowgate`；默认 `enforce` 时，开发者在该仓库里
改插件源码会立刻被 `R-NO-CHANGE` 拒绝——自己把自己拦死（自举死锁的另一种形态）。

**做法**：`resolveSafeMode` 之后的第二层模式判定（`src/host/mode.ts#detectSelfHost`）：
项目根 `package.json` 的 `name === 'dsh-flowgate'` 且含 `dsh` 清单字段 → 自举仓库，默认
`takeover='observe'`；显式 `config.takeover` 可覆盖（`enforce`/`observe`/`off`）。

**observe 行为**（精确语义）：
- 放行的**只有** `R-NO-CHANGE`（"已初始化 + 无进行中变更"的未立项写入）这一条接管规则；每次放行照常计数，
  每会话每规则至多写一次账本 `takeover.observed`（含 mode/ruleId/tool/target），并注入一次提示；
- **其它规则照常拦截**：有进行中变更时的阶段/范围/顺序规则、`R-PROTECTED`（`.flowgate`/`.git`）、
  修复通道的 `R-FIX-SCOPE`/`R-FIX-SHELL`/`R-FIX-TOOL`、危险命令/风险触发器等都不因 observe 而放宽；
- 修复/变更流程本身不被跳过：observe 不会替你推进阶段；`off` 才是"完全不拦截"（safe-mode/config）。

**何时不该用 observe**：日常项目误把 observe 当"关掉门禁"会失去硬约束——需要关就用
`/flow off`（记账）或 safe-mode（恢复期），并且都要在复盘时说明原因。

## 11. 与修复通道的边界（v0.6）

| 场景 | 走哪条车道 | 入口 |
|---|---|---|
| 新功能 / 需求变化 / 跨模块大改 | 变更车道（本文件描述的七阶段 + auto-review 路由） | `flow_new_change`（含 `assessment`） |
| 已知 bug、事故回归、行为明确的小修 | **修复车道** | `flow_fix_start`（FIX-id：scope + verify + RED→GREEN，无人工门） |
| 修复中越界/需要设计变更 | 放弃修复后转变更车道 | `flow_fix_abort` → `flow_new_change` |

- 修复车道**不是** `route=fast`：fast 仍是变更车道的加速（要产出最小需求/验收/scope/verify 并过检查）；
  修复车道是并列的一等公民，不产生 `C-xxx`、不要求七阶段文档、不需要人工门，但必须留 RED→GREEN 证据
  与全量回归。详见 [repair-lane.md](repair-lane.md)。
- `R-NO-CHANGE` 的解锁话术已指向两条车道（修复/立项），模型不再被引导"先立项再修 bug"。
- observe（§10）只放宽"未立项写入"这一条接管规则，修复通道/变更车道的阶段与范围规则仍生效（它们才是流程硬约束）；
  自举开发时建议用 dev profile + 修复通道 + `pnpm verify:host` 闭环。
