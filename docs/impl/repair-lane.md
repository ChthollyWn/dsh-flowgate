# 修复通道（repair lane）：修 bug 是一等公民

> 状态：2026-11-01。设计：负责人要求「修 bug 是 vibe coding 的核心环节，不能比新功能低一等」。
> 实现：core `startRepair/finishRepair/abortRepair`（`src/core/engine.ts`）、store
> `src/core/store/repair.ts`/`flags.ts`、host 工具 `flow_fix_start/flow_fix_done/flow_fix_abort`
> 与命令 `/flow fix`。契约字段见 `src/core/types.ts` 的 `RepairRecord`；本文与代码不一致时**以代码为准**。

## 0. 三句话

1. **双车道并列**：变更车道（七阶段，功能/大改）与修复车道（FIX-id，bug 修复）都是正式路径；
   修复不是"流程例外"，而是与功能开发同级的一等循环。
2. **修复车道不降质量**：没有人工门与 G1/G3 文档，但必须有 **RED → 修复 → GREEN → 全量回归**
   的证据链，范围内自由迭代、范围外硬拒绝（`R-FIX-SCOPE`），完成后自动归档修复记录。
3. **fast 路由仍是变更车道**：auto-review 的 `fast` 只是"变更车道"的加速（低复杂度、清晰可验证，
   G1/G3/G6 检查通过后自动通过），**不是修复车道**；选择看改动性质而不是大小——修 bug 走修复车道。

## 1. 两条车道怎么选

| 维度 | 变更车道（change lane） | 修复车道（repair lane） |
|---|---|---|
| 触发 | 新功能、需求变更、跨模块大改、探索性工作 | 生产事故、回归缺陷、行为明确的 bug |
| 入口 | `flow_new_change`（含 `assessment` 自评 → auto-review 路由 full/standard/fast） | `flow_fix_start`（声明 title/symptom/scope/verify/acceptance/severity） |
| 编号 | `C-xxx` / 分析任务 `A-xxx` | `FIX-YYYYMMDD-HHMMSS`（同秒冲突追加 `-2`…） |
| 阶段 | S0–S6 七阶段 + 人工门 GR/G1/G3/G6（按路由） | 无阶段文档、无人工门；一个声明 + 证据闭环 |
| 产物 | `.flowgate/changes/<id>/…`（proposal/specs/tasks/…） | `.flowgate/fixes/<FIX-id>.json` + `fixes/index.md` |
| 范围控制 | 任务卡 scope + `R-STAGE-*`/`R-SCOPE` | 修复声明 scope（1–20 条路径/glob）+ `R-FIX-SCOPE` |
| 完成条件 | G5 全量验证 + G6 人工交付 | RED/GREEN 证据 + 全量回归 + 改动全在 scope → 自动归档 |
| 人工介入 | 门禁处确认（full/standard） | 不逐动作拦截；只在发起/放弃命令或大改转立项时介入 |
| 审计 | 账本 + 报告 + 指标 | 账本 `repair.*` + 修复记录 + 报告文本 |

判断规则（按顺序）：
1. 用户可见故障/报错，且根因与修法明确 → **修复车道**（即使改动跨几个文件，只要在声明的 scope 内）。
2. 需求变化 / 新功能 / 行为要重新设计 → **变更车道**（可用 `fast` 加速）。
3. 不确定 → 先用 `flow_investigate` 只读调查（分析任务，属于变更车道），再决定。
4. 修复中范围越界（要改的模块不在 scope）→ 不要硬扩：`flow_fix_abort` 记录原因后转 `flow_new_change`。

## 2. 修复车道流程

```text
flow_fix_start({ symptom, title?, repro?, scope?, verify?, acceptance?, severity? })
  → 智能准入（v0.7）：信号推导 scope/verify/title + 确定性复核
     approved=按声明 ｜ adjusted=自动补全后通过 ｜ downgraded=拒绝（返回推荐车道与下一步）
  → 通过才得到 FIX-id；账本 repair.assessed + repair.started；.flowgate/state/repair.json 写进行中声明
     （被拒写 repair.rejected，不产生 repair.json）
  ↓
RED：flow_verify({ group: "repro", command: "<必失败的命令/复现测试>" })
  → 失败回执绑定为 redEvidenceId（账本 repair.evidence）
  ↓
修复：在 scope 内自由 edit/跑测试/再 edit（不需要逐动作请求许可）
  ↓
GREEN：flow_verify({ group: "repro" }) → 通过回执绑定为 greenEvidenceId
  ↓
flow_fix_done({ summary?, commit? })
  → 校验：RED 存在、GREEN 存在且晚于 RED、改动文件全在 scope、
           全量回归（config.commands.test）通过、重新跑声明 verify 通过、回执输入哈希新鲜
  → 通过：写 .flowgate/fixes/<FIX-id>.json + 追加 fixes/index.md + 账本 repair.done
  ↓
（可选）负责人 /flow fix 查看状态；`/flow fix done`/`/flow fix abort <理由>` 等价人工入口
```

失败处理：
- `flow_fix_done` 校验不通过会**保持修复通道开启**并逐项返回原因（可继续修），不会产生半截归档；
- 放弃用 `flow_fix_abort({ reason })`（或 `/flow fix abort <理由>`）：写 `status:"aborted"` 记录 +
  账本 `repair.aborted`，清空进行中声明；
- 无法安全继续 / 需要负责人决策 / 环境不可用时，用 `flow_self_pause` 上报事故（见 §5）。

### 2.1 开修复前的准备（重要，v0.6 实测口径）

`flow_fix_done` 会用 `git status --untracked-files=all` 收集**整个工作区**的改动（含未跟踪文件），
再与声明的 `scope` 比对——**开修复通道之前就存在的无关未提交改动会被判"超出范围"而拒绝关门**。
因此：

1. 开修复前先处理工作区：把无关改动 `git commit` / `git stash`（或换到干净 worktree）；
2. scope 声明要覆盖本次修复实际会碰到的**全部**文件（含测试/文档/脚本），不要只写 `src/`；
3. 修复过程中不要顺手改 scope 外文件；需要扩范围就 `flow_fix_abort` 后重新声明（写清 scope）；
4. `flow_fix_done` 的 scope 核对是**治理策略不是沙箱**（见 §8 限制）：它阻断的是"关门时留下越界
   改动"，不是运行期隔离。

### 2.2 声明字段（`RepairRecord`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✅ | 一句话标题（如「续费回调重复扣款」） |
| `symptom` | ✅ | 可观察现象/报错/影响面（复盘用） |
| `repro` | — | 复现步骤；建议同时用 `flow_verify` 跑出 RED 回执 |
| `scope` | ✅ | 允许改动的仓库相对路径/glob，1–20 条；超出即拒绝 |
| `verify` | ✅ | 声明验证命令；形状受校验（单条命令，不允许 `&& || ;` 管道/重定向/命令替换/反引号） |
| `acceptance` | — | 可测量验收要点 |
| `severity` | — | `P0` 生产不可用 / `P1` 主要功能受损 / `P2` 一般缺陷（默认 `P2`） |

> 口径：工具层 `flow_fix_start` 与 core `startRepair` 未显式传 `severity` 时**默认都为 `P2`**
> （2026-11-01 对齐；`P0` 生产不可用 / `P1` 主要功能受损 / `P2` 一般缺陷）。

### 2.3 智能准入（v0.7，`flow_fix_start` 内置）

修复车道不再只依赖模型自述"这是 bug、scope/verify 是这些"：`flow_fix_start` 在开启前先跑一次
**信号推导 + 确定性准入**（实现：`src/core/flow/repair-admission.ts`、`FlowEngine.previewRepair()`）。

**1) 信号推导（建议层，只提出假设）**

| 信号 | 用来推导 |
|---|---|
| 最近失败/非零退出回执（`flow_verify` 历史） | verify 候选（命令本身）、scope 候选（命令里的 `src/...`、`test/...` 路径 token）、RED 线索 |
| `git status --porcelain --untracked-files=all` 未提交改动 | scope 候选；预存脏工作区检查 |
| 项目 `commands.test` | verify 候选 |
| 当前变更 / 修复 / 锁定状态 | 车道选择与是否允许开启 |
| 缺省补全 | title（取 symptom 首句）、acceptance（两条通用验收）、severity 默认 P2 |

**2) 确定性复核（准入层，宁严勿松）**

| 检查 | 结论 |
|---|---|
| 已有进行中的变更 | **拒绝**，推荐 `flow_declare_rework`（在变更内返工，而不是另开修复车道） |
| 已有进行中的修复 / 锁定模式 / 未启用 | 拒绝 |
| scope 为空 / >20 条 / 整棵顶层目录（`src/**`、`**`、`*`） | 拒绝，推荐 `flow_new_change` |
| scope 命中敏感面（auth/payment/migration/密钥/CI 等内置触发器） | 拒绝，推荐变更车道（auto-review 会强制全流程/人工） |
| 预存未提交改动不在 scope 内 | 拒绝（否则 `flow_fix_done` 必判越界；先提交/暂存） |
| verify 无法推导或形状非法 | 拒绝，提示补 verify 或先跑一次失败命令 |
| `.flowgate/`、`.git/` 出现在 scope | 自动剔除并留理由（永不放开受保护路径） |

**3) 裁定与审计**

- `approved`：按声明开启；
- `adjusted`：自动补全/规范化后开启（来源会写清楚是声明还是推导）；
- `downgraded`：不能开；工具返回推荐车道（`repair` / `change` / `rework`）、blockers 与下一步，**不产生半开启修复**。

通过时把裁定、scope/verify 来源（`declared` / `suggested` / `failed-receipt` / `project`）、置信度与检查项写进
`RepairRecord.admission` 和账本 `repair.assessed`；拒绝写 `repair.rejected`（含推荐车道与理由）。
最近失败回执只作为 **RED 线索展示**，不会自动绑定成某次修复的证据——RED 仍只能由真实 `flow_verify` 产生。

**4) 预演（dryRun）**

```text
flow_fix_start({ symptom: "连续新建会话第二个起报 not lossless JSON", dryRun: true })
→ 返回：裁定 / 推荐车道 / 最终 scope（来源）/ 最终 verify（来源）/ 最近 RED 线索 / 检查项 / 下一步
→ 不写 repair.json、不写 repair.started
```

省略 scope/verify 直接调用（不带 dryRun）会走同一条准入链：能推导就补全后开启；推不出来就拒绝并说明缺什么信号。
也可以先跑一次失败命令（产生回执）再开修复——这是最省事的"用证据开局"方式。

**5) 关门兜底（准入之后的硬约束仍然存在）**

准入只校验"声明/推导的 scope"；实际改动仍由 `flow_fix_done` 用 `git status` 全量核对，
并新增 **改动文件 ≤ 20 个** 上限：超过即拒绝关门并提示改用变更车道——防止有人把 feature 伪装成小修复。

> 界限：准入是**确定性规则 + 可解释信号**，不是语义分类器；它不判断"这是不是 bug"，只回答
> "以当前信号与声明，能不能安全走修复车道"。拒绝成本低（多一次调用/改车道），错误放行成本高
> （削弱门禁），所以规则宁严勿松。

## 3. 守卫规则（修复通道内）

修复通道只在"**没有进行中的变更**、项目已初始化且未锁定"时可开启；开启后守卫按修复声明判定，
不再要求立项（`R-NO-CHANGE` 让位给修复通道），但**硬边界仍然拒绝**：

| 规则 | 拒绝什么 | 解锁方式 |
|---|---|---|
| `R-FIX-SCOPE` | 写/创建/删除/重命名到 scope 之外的路径 | 把文件写进 scope 后重新 `flow_fix_start`；或 abort 后转 `flow_new_change` |
| `R-FIX-SHELL` | 危险/无关 shell：`rm -rf`、`git push`、`git reset --hard`、`npm publish`、`curl/wget`、`ssh`、`chmod/chown`、`mkfs` 等 | 修复通道只允许测试/构建/lint/typecheck/run 类命令，以及只读/提交类 git（`status/diff/log/add/commit/rev-parse/stash`） |
| `R-FIX-TOOL` | `delegate`（原生委派）、`mcp` 调用 | 修复通道内不派发子 agent、不调 MCP；完成后需要就转立项 |
| `R-PROTECTED` | 写 `.flowgate/`、`.git/` | 任何模式（含暂停/观察/修复）都拒绝；状态修复用 `/flow repair` |

只读动作与 `flow_*` 工具放行；每次放行的写动作 `actions` 计数（写回 `repair.json`，面板/快照可见）。

## 4. 面板 / 状态 / 命令

- 快照 `snapshot.repair`（可选字段，无进行中修复时不存在）：
  `{ id, title, severity, status:'open', scope, verify, red, green, openedAt, actions }`；
  面板可显示 RED/GREEN 进度与已放行动作数；修复完成/中止后字段消失（审计留在 `fixes/`）。
- dock/面板显示「修复通道：FIX-…｜RED ✓/✗ GREEN ✓/✗｜完成：/flow fix done」。
- 命令（负责人入口，`/flow repair` 语义**不变**——它是"从账本重建状态"的维护命令，不是修复车道）：

| 命令 | 作用 |
|---|---|
| `/flow fix` | 查看当前修复通道状态（FIX-id、RED/GREEN、scope、verify、改动/下一步） |
| `/flow fix done` | 关闭修复通道（等价 `flow_fix_done`：校验证据/范围/回归后归档） |
| `/flow fix abort <理由>` | 放弃当前修复通道（写账本 `repair.aborted`） |
| `/flow incident` | 查看未关闭的事故记录（`flow_self_pause` 之后） |
| `/flow repair` | **旧语义不变**：从账本和产物重建状态（维护命令，与修复车道无关） |

## 5. 与 incident（事故）的分工

| | 修复通道 | 事故记录（incident） |
|---|---|---|
| 触发 | 已知 bug，范围可声明，能继续工作 | agent **无法安全继续**/需负责人决策/环境不可用（`flow_self_pause`） |
| 编号 | `FIX-…` | `INC-…` |
| 副作用 | 范围内放行写操作，其余照常拦截 | 项目级暂停写操作（`flags.off`，`by=agent`，`autoRearm=true`） |
| 恢复 | 修完 `flow_fix_done` 自动解除 | 负责人 `/flow on` 或下次宿主启动自动恢复；恢复后 `flow_incident_close` 补审计 |
| 产物 | `.flowgate/fixes/<FIX-id>.json` + 账本 `repair.*` | `.flowgate/incidents/<INC-id>.json` + 账本 `incident.open/close` |

两者可以先后衔接：事故恢复后如果根因明确，再开修复通道修 bug 并留 RED/GREEN 证据；
事故只负责"停下来并留痕"，修复通道负责"修好并证明"。

## 6. 证据与审计

| 事件 | 内容 |
|---|---|
| `repair.assessed` | 智能准入裁定（approved/adjusted）、scope/verify 来源、置信度、检查项、理由 |
| `repair.rejected` | 准入拒绝：推荐车道（repair/change/rework）、blockers、建议 scope/verify（不产生修复记录） |
| `repair.started` | FIX-id、title、severity、scope、verify、symptom、openedBy、准入裁定/来源 |
| `repair.evidence` | RED/GREEN 回执 id、命令、退出码、阶段、输入哈希（回执本体在 `.flowgate/state/evidence/`） |
| `repair.done` | RED/GREEN/回归回执、改动文件、commit、摘要、记录路径、notes |
| `repair.aborted` | 原因、改动文件、记录路径 |
| `flow.project_off` / `flow.project_on` | 事故自暂停/恢复（与 incident 配套） |
| `incident.open` / `incident.close` | 事故摘要、commit、tests、files、归档路径 |

修复记录 JSON 是**归档材料**（`.flowgate/fixes/`），`index.md` 自动追加索引行；两者都随
`.flowgate/` 的 git 策略处理（默认不进 git，`git.commit_flowgate: true` 时可选提交部分）。

### 6.1 一个完整例子（v0.5.1 事故本身）

```text
flow_fix_start({
  title: "新建会话报 not lossless JSON",
  symptom: "隔离 Web 宿主连续创建会话：第一个成功，第二个起 gateway/internal ... not lossless JSON data",
  repro: "node scripts/smoke-host.mjs --plugin <旧构建> --sessions 3",
  scope: ["src/host/projection/**", "src/host/boundary/**", "test/host/**", "scripts/smoke-host.mjs"],
  verify: "pnpm vitest run test/host/projection.test.ts",
  severity: "P0"
})
→ RED：flow_verify({ group: "repro", command: "node scripts/smoke-host.mjs --plugin <旧构建> --expect-fail" })（失败）
→ 修：投影显式 DTO + toLosslessJson 边界 + 启动自检（失败则不注册投影）
→ GREEN：同上命令通过（或 verify:host 在修复构建上 3/3）
→ flow_fix_done({ summary: "…", commit })
```

> 真机回归门是 `pnpm verify:host`（见 [docs/compat/host-smoke.md](../compat/host-smoke.md)）；
> 单测只能作为补充证据。注意该事故要**连续创建 ≥2 个会话**才会复现，回归证据必须按此跑。

## 7. 与 vibe coding 的关系

- vibe coding 的核心循环是「试 → 发现 bug → 修 → 再试」。修复通道把这个循环变成**有证据的
  一等路径**：不需要为了修一个 bug 先立项、写 proposal/specs/tasks、等人批准，避免"流程本身
  成为 bug 修复的阻力"。
- 但"快"不等于"无证据"：RED（先复现/失败）→ GREEN（修好且验证通过）→ 全量回归是硬要求；
  范围内自由迭代，范围外硬拒绝。质量门槛不降，只省掉与 bug 修复无关的人工门与文档。
- fast 路由与修复车道的关系：`fast` 仍是变更车道（要产出最小需求/验收/scope/verify 并过检查），
  适合"小功能"；修复车道适合"已知坏行为"。两者并列，不互相替代。
- 自举/开发 FlowGate 本身时：自举仓库默认 `takeover=observe`——**仅对 `R-NO-CHANGE` 未立项写入放行并记账，
  其余规则（阶段/范围/受保护路径/修复通道 scope）仍拦截**，避免被自己的接管规则锁死同时保留门禁；
  修 bug 用 dev profile + 修复通道 + `verify:host` 闭环。

## 8. 已知限制（如实）

1. **scope/verify 可由信号推导，但推导只是启发式**：v0.7 起可省略由失败回执/未提交改动/项目命令推导，
   准入会做宽度/敏感面/脏工作区检查，但不会替 agent 判断"这是不是 bug"；运行中越界仍被
   `R-FIX-SCOPE` 拒绝，关门仍按 git 全量核对（且 ≤20 个改动文件）。跨模块/高风险请走变更车道。
2. **没有独立审查子 agent**：修复车道靠 RED/GREEN + 全量回归 + 声明 verify 把关；高风险/跨模块
   改动仍应走变更车道（有审查与终审）。这是有意的成本折中，不是"修复车道质量更低"的结论。
3. **shell 政策是治理策略，不是沙箱**：`R-FIX-SHELL` 按命令形状白名单允许测试/构建/lint/run 类命令
   （如 `node`、`pnpm run`、`vitest`），这意味着理论上可通过脚本间接写 scope 外文件；兜底是
   `flow_fix_done` 的 git status scope 核对 + 全量回归 + 账本审计。需要强隔离时用宿主沙箱/容器，
   修复通道不承诺运行期文件系统隔离。
4. **工作区必须预先干净**：`flow_fix_done` 比对的是 `git status --untracked-files=all` 的**全部**
   工作区改动；开修复前已有的无关未提交改动会被判越界（§2.1）。非 git 仓库/收集失败时记
   `changedFiles: unknown` 并继续（证据弱一档）。
5. **verify 命令形状受限**（无管道/重定向/替换），复杂验证需包成项目脚本（如 `pnpm test:xxx`）。
6. **回归命令取 `config.commands.test`**；项目没配（`none`/缺失）时跳过并记录 notes——证据链会弱一档。
7. 修复通道要求"没有进行中的变更"：正在走变更时发现 bug，需先 finish/pause 该变更，或把修复
   作为该变更内的返工（`flow_declare_rework`）/ 修复任务批次处理。
8. 项目级暂停（`/flow off` / 自暂停）下写操作放行；observe 只放宽未立项写入这一条接管规则（其余规则照常），
   但修复通道仍建议在正常 `enforce` 模式下使用，以保证证据与拦截统计真实（恢复期先用环境级恢复）。
9. 修复记录默认不进 git（与 `.flowgate/` 整体策略一致）；需要长期留档请开 `git.commit_flowgate`
   或手工导出 `fixes/` 到发布材料。
