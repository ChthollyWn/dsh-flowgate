# 宿主恢复 SOP（插件故障 / 新建会话失败 / 门禁误拦）

> 状态：2026-11-01。配套工具：`pnpm host:recover`（[scripts/host-recover.mjs](../../scripts/host-recover.mjs)）、
> safe-mode / 模块开关 / takeover 三态（enforce/observe/off，实现：`src/host/mode.ts`、`src/host/index.ts`）。
> 目标：插件出问题时**优先降级而不是卸载**，恢复过程可审计、不删用户数据、不形成自举死锁。

## 0. 恢复阶梯（从最轻到最重）

| 级别 | 动作 | 生效时机 | 影响 | 何时用 |
|---|---|---|---|---|
| L0 | `/flow allow-once`、面板"加入例外"、`/flow off` | 立即 | 单次/本会话/项目暂停，记账 | 单条规则误拦、临时让路 |
| L1 | **safe-mode sentinel**（`pnpm host:recover --safe-mode`） | **重启后**（插件启动时读） | takeover=off，跳过 guard/delegation/gates/dispatch；其余模块（投影/命令/工具/会话）保留 | 插件自身 bug、新建会话失败、门禁整体误伤 |
| L2 | 模块开关（`FLOWGATE_DISABLE=…` 或 `config.modules.<名>=false`） | 重启后 | 精确停掉某个模块（如只停 `guard`），用于二分定位 | 怀疑特定模块；E2E 二分 |
| L3 | 面板禁用插件 / 从 profile 移除插件 | 重启后 | 整插件不加载（`host:recover --profile <p> --remove --yes`） | 插件导致宿主无法启动、L1/L2 仍不行 |
| L4 | `dsh rescue --from-default-profile web` + dev profile 修复 | 立即（另起最小环境） | 用干净模板起一个最小宿主来修插件 | 日常 profile 完全不可用 |

> 铁律：恢复动作**不删除项目数据**（`.flowgate/`、账本、报告、会话日志都不动）。
> 唯一会删的是 safe-mode sentinel 文件本身（`--clear`）与（L3 时）profile 里的插件安装项。

## 1. 症状矩阵

| 症状 | 典型报错/表现 | 先做什么 | 再做 |
|---|---|---|---|
| **新建会话失败** | `gateway/internal: failed to create session: Error: forwarded host event "api-session/added" argument 0 is not lossless JSON data`（v0.5.1 事故；首个会话可能正常，**连续第二个起失败**） | `pnpm host:recover --safe-mode --reason "新建会话报 not lossless JSON"` → 完全重启 | 升级到修复构建（含投影边界 `toLosslessJson` + 显式 wire DTO + 自检）→ `pnpm verify:host` 通过 → `host:recover --clear` → 重启；补 incident |
| **插件加载失败 / 宿主起不来** | 启动日志 `did not activate`、`unrecognized Loader tree carrier`、仓库窗口打不开 | 写宿主级 safe-mode sentinel → 重启 | 仍失败：模块开关二分（先停 `guard`）；再不行 `--profile desktop --remove --yes` 或 `dsh rescue`；用 dev profile 修复 |
| **门禁误拦（单条）** | 某规则频繁命中、影响正常工作 | 面板"误判反馈 → 放行一次"（`/flow allow-once`）或"加入例外" | 多次误判看拦截视图与 `/flow metrics`；必要时 `/flow rule` 沉淀修正；整体误伤走 L1 |
| **门禁误拦（整体）** | 什么都没做也被拒、写文件全被拦 | `host:recover --safe-mode` → 重启（恢复期不拦截） | 排查是否误把 `desktop` 装了 dev 构建；看 `/flow doctor` 的接管模式/模块开关 |
| **插件自身 bug（工具/命令异常）** | 工具报错、`/flow` 无响应、投影自检失败 | agent 调 `flow_self_pause`（暂停写操作 + 事故记录）；人可 `/flow off` | 修复走修复通道（`flow_fix_start`）；恢复后 `flow_incident_close` 补审计 |
| **构建/版本回退** | 升级后行为异常 | 回滚 profile 里插件版本（`remove` + 装回已知好 tgz/包） | 用 dev profile 复现；按 [dev-loop.md](dev-loop.md) 打包流程重新升级 |
| **恢复动作被插件挡住** | 想改代码修 bug，却被 `R-NO-CHANGE` / `R-PROTECTED` 拒绝 | 用**隔离 dev profile**（不装/装旧版）修，或 safe-mode + 重启 | 修复完成后按修复通道留 RED→GREEN 证据 |

## 2. safe-mode：细节

### 2.1 sentinel 路径与优先级

插件启动时（`src/host/mode.ts#resolveSafeMode`）按以下顺序判定，命中即 active：

1. `$DSH_HOME/flowgate/safe-mode`（未设置 `DSH_HOME` 时 = `~/.dsh/flowgate/safe-mode`）；
2. `<项目根>/.flowgate/safe-mode`（项目级补充 sentinel）；
3. 环境变量 `FLOWGATE_SAFE=1`（或 `true`）；
4. 插件配置 `safeMode: true`。

> 生效时机差异：**启动期**（模块是否安装）以 home/env 为主；项目级 sentinel 需要知道项目根，
> 主要用于运行期 guard 降级（项目根确定后每步判定接管模式）。所以**恢复期请优先写 home 级
> sentinel**（`host:recover --safe-mode` 默认就是 home 级）。`--project <repo>` 会同时写项目级
> sentinel 作为双保险，但它不能替代 home 级来跳过启动期模块。
>
> 已知前提：插件与 CLI 必须对"home"理解一致——两边都以 `DSH_HOME` 优先、默认 `~/.dsh`
> （host-plugin 已按此口径对齐）。若你手工改过 `HOME`/`DSH_HOME`，先跑
> `pnpm host:recover --status` 看实际路径，再用 `/flow doctor` 的"safe-mode 读取路径"核对。

### 2.2 sentinel 内容

文件内容就是原因文本（trim 后最多 500 字符进 doctor/投影），例如：

```text
新建会话报 not lossless JSON（2026-11-01T03:20+08:00，负责人）
```

`pnpm host:recover --safe-mode --reason "..."` 会写入带时间戳的文本；手工 `echo` 也可以。

### 2.3 safe-mode 生效时会发生什么

- 生效接管模式强制为 `off`（不拦截、不记录 `takeover.observed`）；
- **跳过** `guard`（守卫）、`delegation`（关闭原生委派）、`gates`（人工门通知）、
  `dispatch`（任务派发）四个模块；日志与 `/flow doctor` 的"模块开关"逐项列出 skipped 原因；
- `projection`（显式 DTO + 启动自检）、`session`、`commands`、`tools`、`context`、`compression`、
  `coverage`、`postcheck` 仍安装：你可以继续查看面板、跑命令、用修复通道/自愈能力人工止血；
- 重启即生效，**不需要卸载插件、不需要重建 profile**。

### 2.4 takeover 三态（与 safe-mode 的区别）

| 模式 | 行为 | 何时出现 |
|---|---|---|
| `enforce`（默认） | 全部规则硬拦截 | 普通项目、日常使用 |
| `observe`（自举仓库默认） | **仅对 `R-NO-CHANGE`（未立项写入）放行**并写账本 `takeover.observed`（每会话每规则一次）；**有进行中变更时，阶段/范围/受保护路径（`.flowgate`/`.git`）/修复通道 scope 等规则仍原样拦截** | 项目根是 dsh-flowgate 自身（自举检测）或显式 `config.takeover: observe`；用于"不被自己的接管规则锁死，同时保留门禁与观测" |
| `off`（safe-mode / 配置） | 完全不拦截（guard 不安装或直通），也不记录 `takeover.observed` | safe-mode 生效、显式 `config.takeover: off`；用于插件自身故障恢复 |

> safe-mode = `takeover:off` + 跳过 guard/delegation/gates/dispatch（仅保留诊断/命令/工具/投影，且投影是
> 安全 DTO）。它比 observe 彻底：observe 只放宽"未立项写入"这一条，safe-mode 是恢复期完全不拦。
> `/flow doctor` 会显示生效 takeover 与原因（safe-mode 强制 / 配置 / 自举检测 / 默认）。

## 3. 模块开关（二分定位，L2）

```bash
# 环境变量（E2E/排障二分用；不要写进日常启动脚本）
FLOWGATE_DISABLE=guard dsh --profile flowgate-dev

# 插件配置（持久；写进 profile 的插件配置）
# config.modules: { guard: false, dispatch: false, ... }
```

可开关模块：`session`、`guard`、`delegation`、`coverage`、`postcheck`、`compression`、`context`、
`projection`、`gates`、`commands`、`tools`、`dispatch`。
优先级：`FLOWGATE_DISABLE`（env）> `config.modules.<名>=false` > safe-mode 强制跳过；
`/flow doctor` 的"模块开关"逐项显示实际状态与原因。

## 4. host:recover CLI

```bash
# 查看状态（sentinel 是否启用、原因、路径、FLOWGATE_SAFE、审计日志位置）
pnpm host:recover --status

# 启用 safe-mode（写 sentinel + 审计；幂等）
pnpm host:recover --safe-mode --reason "新建会话报 not lossless JSON，先降级恢复"

# 同时写项目级 sentinel（双保险；<repo> 换成你的项目根）
pnpm host:recover --safe-mode --reason "..." --project /path/to/project

# 修复并验证通过后清除 sentinel（再重启）
pnpm host:recover --clear

# 最后手段：从 profile 移除插件（默认 dry-run，只打印命令；--yes 才执行）
pnpm host:recover --profile desktop --remove
pnpm host:recover --profile desktop --remove --yes
```

行为保证：
- 默认 `DSH_HOME` 优先、否则 `~/.dsh`；`--dsh-home <dir>` 可覆盖；
- 每个实际动作写一行 JSONL 到 `$DSH_HOME/flowgate/recovery.log`（含时间、动作、路径、原因、结果；
  dry-run 也记录"计划"）；
- 不删除 `.flowgate/` 项目数据、不改 package.json、不动会话日志；只删除 safe-mode sentinel；
- 退出码：0 成功 / 1 执行失败 / 2 用法错误。

## 5. 标准恢复 SOP（以"新建会话失败"为例）

```text
1. 记录现象：报错原文、时间、DSH 版本、插件版本/构建 sha、是否连续第二个会话起失败。
2. 降级：pnpm host:recover --safe-mode --reason "<现象一句话>"
3. 完全重启 DSH（桌面端退出重开；Web 宿主 Ctrl-C 后重跑）——sentinel 在插件启动时读取。
4. 确认降级：/flow doctor → "运行模式：接管模式 off（safe-mode 强制 off…）"、
   "safe-mode 读取路径"含你写的文件；此时不拦截、可以正常建会话。
5. 修复：用隔离 dev profile（见 dev-loop.md）复现/修复；或升级到已含修复的构建。
   —— 修复本身走修复通道（flow_fix_start → RED → 修 → GREEN → 全量回归 → flow_fix_done）。
   注意：开修复前先提交/暂存工作区里的无关改动——`flow_fix_done` 会把 `git status` 的**全部**
   改动（含未跟踪文件）与声明 scope 比对，预先存在的无关改动会导致"超出范围"拒绝（修复通道
   shell 政策是治理策略不是沙箱，兜底是关门时的 scope 核对 + 全量回归，见 repair-lane.md §2.1/§8）。
6. 验证：pnpm build && pnpm verify:host 必须 GREEN（隔离真实宿主连续建 ≥2 个会话）；
   pnpm lint/test 通过。
7. 解除降级：pnpm host:recover --clear → 再完全重启。
8. 复验：新建会话正常、/flow doctor 接管模式回到 enforce、面板/dock 正常。
9. 补审计：flow_incident_close({ summary, commit, tests, files })（或负责人手工补
   .flowgate/incidents/<INC-id>.json + 账本 incident.close）；修复记录留在
   .flowgate/fixes/<FIX-id>.json + 账本 repair.*。
```

> 第 4 步和第 8 步的 `/flow doctor` 输出建议截图/粘贴到事故记录里（证据链）。

## 6. 恢复过程中的审计

| 审计对象 | 位置 | 何时写 |
|---|---|---|
| safe-mode 启用/清除 | `$DSH_HOME/flowgate/recovery.log` | 每次 `host:recover --safe-mode/--clear` |
| profile 移除插件 | 同上（含 dry-run 计划） | `host:recover --profile <p> --remove` |
| 事故记录 | `.flowgate/incidents/<INC-id>.json` + 账本 `incident.open`/`incident.close` | `flow_self_pause` / `flow_incident_close` |
| 项目级暂停 | `.flowgate/state/flags.json` + 账本 `flow.project_off`/`flow.project_on` | agent 自暂停 / 负责人 `/flow off`·`/flow on` |
| 修复通道 | `.flowgate/fixes/<FIX-id>.json` + `.flowgate/fixes/index.md` + 账本 `repair.started`/`repair.evidence`/`repair.done`/`repair.aborted` | 修复通道工具调用 |
| 接管观察 | 账本 `takeover.observed`（每会话每规则一次） | observe 模式放行的**未立项写入**（仅 `R-NO-CHANGE`；其余规则仍拦截） |

**审计不断**原则：即使恢复动作让插件"不拦截"，恢复过程本身也必须留痕——`recovery.log`
（宿主级）+ incident/fix 记录（项目级）+ 账本事件（可追溯）。不要因为"先恢复再说"就跳过第 9 步。

## 7. 最后手段：面板禁用 / 整插件卸载

- **面板禁用/整插件卸载**只用于"插件导致宿主无法启动且 L1/L2 无效"：DSH 侧禁用会同时停掉
  投影/工具/命令，面板也不再提供恢复入口（旧流程里"面板禁用 = 整插件 + 重启"正是自举死锁的
  来源之一，现在应优先用 safe-mode + `host:recover`）。
- 卸载命令见 §4；卸载后：
  1. 重启 DSH 确认能正常建会话；
  2. 用 dev profile / rescue 修复插件；
  3. 打包并通过 `verify:host` 后重新安装（`dev-loop.md` §3）；
  4. 恢复后补 incident 记录。
- **永远不要**为了恢复删除 `.flowgate/` 或账本：那会丢失审计链与未归档的修复/事故记录。
  真需要"干净状态"时新建一个 profile/项目目录验证，而不是删用户数据。

## 8. 已知限制

1. safe-mode 是**启动时**读取：写完必须重启；运行中的宿主不会立刻变。
2. 项目级 sentinel 不能跳过启动期模块（需要项目根才能解析）；恢复期优先 home 级。
3. `host:recover` 的 `--remove` 依赖本机 DSH CLI（`DSH` 环境变量可覆盖默认路径）；DSH rc.5 的
   `plugin remove` 不 prune `node_modules`（已知残留，删 profile 或重跑 `pnpm install` 清理）。
4. 若插件连命令/工具都没注册（加载失败），`/flow doctor` 与文件状态不可用：按 §4/§7 直接
   操作 sentinel/profile，再由 dev profile 修复；此时审计由 `recovery.log` 承担，事后补 incident。
5. 恢复期间用修复通道时：先清理工作区的无关未提交改动（`flow_fix_done` 按 `git status
   --untracked-files=all` 全量比对 scope）；修复通道不是沙箱，强隔离请用宿主沙箱/容器。
5. 恢复 CLI 不联网、不收集遥测；不修改项目文件。
