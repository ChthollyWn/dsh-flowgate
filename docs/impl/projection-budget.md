# 投影 wire 预算（P2-11）

> 状态：2026-11-01。背景：v0.5.1「新建会话失败」的直接原因是投影 wire 值含 `undefined`；
> 同样的问题也会以"体积失控"形式出现——`snapshot`/`panel` 来自 `engine.snapshot()` 与缓存，
> 若整包透传给 DSH 会话摘要与客户端，字段增长没有上限。本轮做两件事：
> **显式 wire DTO + 条数上限 + 单帧字节预算**（已实现），**面板按需拉取（remote）作为后续方向**（未实现）。

## 0. 结论

| 项 | 值 |
|---|---|
| 单帧 wire 目标 | **< 256 KiB**（`PANEL_WIRE_BUDGET_BYTES = 256 * 1024`，按 UTF-8 字节计） |
| 当前实测（v0.5.1 构建、空项目状态、真实宿主 `session/projections`） | **12111 B ≈ 11.8 KiB**（snapshot 5841 B + panel 6167 B + 元数据） |
| 新显式 DTO 满额构造估算（按代码上限构造的假数据，非实测） | **≈ 214.5 KiB**（< 256 KiB；超限时按降级顺序丢块） |
| 面板按需拉取 | ❌ 未实现（后续方向，见 §5） |
| 客户端降级 | ✅ 契约要求：缺失块显示"暂无/未启用"，不得抛错（host-client-contract §1） |

## 1. 为什么需要预算

DSH 把 `flowgate` 会话投影的 wire 值放进：

1. **会话摘要**（`POST /api/session/create` / `api-session/added` / `session/list` 的
   `projections.values.flowgate`）——每个新会话/子会话创建时都会转发，属"最热"路径；
2. **投影快照与增量帧**（`session/projections`、`session/follow`）——客户端每次连接/重连读取；
3. **前端渲染**（dock/右侧栏 10 视图）。

事故复盘教训：这条数据路径**既不能有非法值，也不能无限增长**。体积问题的现实诱因：
变更数增长（`changes` 无上限）、拦截/证据/审查记录累积、`taskCards` 全量展开、`roadmap` 条目多、
面板块在每次 emit 时重复构建。P2-11 用"上限 + 预算"先兜底，避免面板越大越拖慢会话创建与重连。

## 2. 显式 DTO（`src/host/projection/wire.ts`）

`toWireProjection(state)` 逐字段挑白名单，不再整包透传：

- **顶层**：`snapshot` / `revision` / `updatedAt` / `epoch?`（`PROJECTION_WIRE_TOP_LEVEL_KEYS`）；
- **snapshot**：客户端契约已知字段（`initialized`、`changeId`、`title`、`flowPlan`、`pipeline`、
  `tasks`、`taskCards?`、`batches`、`activeTaskId`、`pending`、`violations`、`externalChanges`、
  `resumed`、`exceptions`、`off`、`offBy?`、`takeover?`、`incident?`、`repair?`、`locked`、
  `interceptCounts`、`coverage?`、`contextPct?`、`nextStep`、`statusLine`、`updatedAt`）；
- **panel**：逐块挑选并限量（见 §3）；新增字段必须在这里显式加一行（默认不会泄漏到 wire）；
- 最后统一走 `toLosslessJson()`（`src/host/boundary/json.ts`）做 JSON 往返清洗，再交给 DSH；
- 投影注册前跑 `projectionSelfCheck()`：init/apply/wire 各阶段用脏 fixture（undefined/NaN/Date/
  类实例）验证 lossless 且顶层键齐全；失败**不注册投影**（runtime 标 inert，`/flow doctor` 可见），
  保证"坏投影不可能再毒化会话创建"。

## 3. 条数上限与降级顺序

`WIRE_PANEL_LIMITS`（wire 与 `panel.ts` 构建侧保持一致）：

| 块 | 上限 | 说明 |
|---|---|---|
| `changes` | 50 | 台账最近 50 条（客户端"最近变更"即可；历史用命令/看板按需生成） |
| `gate.items` | 50 | 当前门禁检查项 |
| `trace` | 50 | 追溯矩阵行（每行 taskIds/evidenceIds 再限 20） |
| `risks` | 20 | 风险登记 |
| `intercepts` | 50 | 拦截日志（原 100 → 50） |
| `rules` | 50 | 规则列表 |
| `evidence` | 50 | 证据回执摘要 |
| `reviews` | 20 | 审查摘要（每条 findings 再限 20） |
| `roadmap.entries` | 30 | 路线图条目 |

超预算时的降级顺序（`PANEL_DROP_ORDER`，先丢最不影响状态判断的块）：

```
trace → evidence → intercepts → rules → risks → roadmap → reviews → metrics → gate → changes
```

`changes` 最后丢（客户端契约要求它恒存在）；每丢一块重新计算字节数，直到 ≤ 256 KiB。
`snapshot` 本身不在丢块范围内（状态判断必需）——若 `snapshot` 自身超预算，属于"任务卡/管线异常
巨大"的极端情况，靠上游 `taskCards` 生成侧的条数约束兜底（见 §6 限制）。

## 4. 实测与估算

### 4.1 真实宿主实测（v0.5.1 构建）

环境/方法：隔离 `DSH_HOME` + 官方 web 模板 profile + `link:` 本仓库（v0.5.1 修复构建，
`lib/host.js` sha256 `009514a2…`）；工作区复制仓库 `.flowgate/`（未启用/无进行中变更）；
连续创建 3 个会话后调用 `POST /api/session/projections`（`{request:{sessionId}}`），
取 `result.value.values.flowgate` 的 `JSON.stringify` 字节数（UTF-8），零模型请求。

| 指标 | 值 |
|---|---|
| flowgate wire 值（单会话，空状态） | **12111 B**（≈ 11.8 KiB） |
| 其中 snapshot | 5841 B |
| 其中 panel | 6167 B（`changes: []`、`rules` 默认 10 条左右、`dashboardPath`） |
| 整个 `session/projections` 响应 | 13226 B（含 title/goal/tokenUsage 等宿主其他投影） |
| 3 个会话之间 | 大小相同（11.8 KiB），revision 4→5→6 |

> 该构建的 wire 仍是"整包透传 + JSON 清洗"（v0.5.1 修复层），所以这个数字是**旧 wire 的
> 空状态基线**；新显式 DTO 会去掉若干宿主内部字段、并给大块加条数上限，正常状态应小于它。

### 4.2 新 DTO 满额估算（构造假数据，非实测）

按 §3 的上限构造"每一项都满额"的 wire 值（变更 50 条含 10 个 artifactLinks、trace 50 行、
intercepts 50 条、reviews 20 条×20 findings、evidence 50 条、roadmap 30 条、gate items 50 等），
`JSON.stringify` 后：

| 块 | 估算字节 |
|---|---|
| snapshot（含 12 个任务 + taskCards + pipeline + pending…） | 8,890 |
| panel: reviews | 62,861 |
| panel: changes | 62,201 |
| panel: intercepts | 19,591 |
| panel: trace | 19,431 |
| panel: gate | 14,043 |
| panel: rules | 12,081 |
| panel: evidence | 9,331 |
| panel: risks | 6,741 |
| panel: roadmap | 4,181 |
| panel: metrics + dashboardPath | 127 |
| **合计** | **219,696 B ≈ 214.5 KiB** |

结论：**满额构造仍 < 256 KiB 目标**；若真实数据（长路径/长标题）超过预算，则按 §3 顺序降级。
注意这是**估算**（字段内容长度按典型上限假设），不是生产实测；上线后可用
`/flow doctor` 的"投影自检 wireBytes"与 `session/projections` 实测复核。

## 5. 后续方向：面板按需拉取（remote）

当前 wire 是"一次推送面板摘要"，大块（历史变更、全量证据/审查/拦截）只能靠上限截断。后续
（P2-11 的"面板按需拉取"）计划：

1. `flowgate` 投影只保留**状态判断必需**的摘要（snapshot 精简 + panel 计数/最近 N 条）；
2. 面板打开某视图时经 Remote（`remote.flowgate.action` 扩展，如 `panel-data {kind, cursor}`）
   按需拉取该块全量数据，客户端本地分页；
3. wire 预算从"单帧"降为"状态摘要"（目标 < 64 KiB），历史数据永不进会话摘要；
4. 需要处理旧宿主降级（无 Remote 时回退当前摘要 + "查看更多用命令/看板"）。

未实现原因：当前 Remote 只有 `state()`/`action()` 主路径，面板动作以命令执行为主；按需拉取
需要新的 Remote 方法与客户端缓存/分页，属独立一轮工作。本轮先用上限 + 预算保证"不失控"。

## 6. 客户端与兼容约束

1. **缺失字段必须降级**：客户端对缺失块显示"暂无/未启用"，不得抛错（host-client-contract §1）。
2. **新旧记录兼容**：`stateVersion` 升到 **2**（wire 显式 DTO）。旧 checkpoint 的宽松透传值不再
   作为当前状态使用（DSH 在版本不匹配时丢弃旧 checkpoint，投影从日志重建）。
3. **字段是可选增量**：`takeover`/`offBy`/`incident`/`repair` 等新字段对旧客户端"未知字段忽略"。
4. **负 zero / 稀疏数组 / 类实例等边界规则**以 `src/host/boundary/json.ts` 为准（镜像 DSH
   `isJsonValue`）：拒绝 `-0`、稀疏数组、带额外属性的数组、`Date/Map/Set/类实例`、`NaN/Infinity`、
   `undefined`、函数/symbol/bigint、循环引用；清洗策略是 JSON 往返，使值满足 DSH 的 lossless 检查。
5. **投影自检失败行为**：不注册投影（`/flow doctor` 显示失败原因），插件其余功能继续运行；
   这是"宁可没有面板，也不能让会话创建失败"的取舍。

## 7. 限制（如实）

1. 预算只保证"面板块可丢"；`snapshot` 自身（尤其 `taskCards` 全量）没有单独上限，极端项目
   （数百任务/超长卡片）可能使单帧仍超 256 KiB——后续按需拉取会解决；当前 `taskCards` 由任务
   计划规模约束（`change_max_tasks` 上限 12）。
2. §4.2 是构造估算，不是生产实测；§4.1 是 v0.5.1 旧 wire 的空状态实测。最终数字以新构建上线后
   的 `session/projections` 实测为准（发布前在 host 冒烟里补记）。
3. wire 字节数按 UTF-8 计（非 UTF-16 字符串长度），中文标签/路径会影响实际值。
4. 客户端当前仍是一次性接收全部面板块；按需拉取落地前，历史数据只能通过命令/看板查看。
