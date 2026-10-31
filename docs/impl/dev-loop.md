# 开发闭环与双 profile（dev / dogfood）SOP

> 状态：2026-11-01。对齐 [docs/04-执行方案.md](../04-执行方案.md) §9「自举：用 FlowGate 开发 FlowGate」。
> 起因：v0.5.1 事故（投影 wire 非 lossless JSON → 新建会话失败）暴露了旧开发方式的两个问题：
> ① 日常 `desktop` profile 用 `link:` 直接装工作区源码，坏构建会立刻污染日常使用；
> ② 修复要求"关插件/重启/新会话"，但恢复动作本身被坏插件挡住（自举死锁）。
> 本文件把 **dev profile（隔离、link）/ dogfood profile（打包安装）/ 日常 desktop（稳定包）**
> 三个 profile 的职责拆开，并给出"改完 → 真机冒烟 → 打包 → 装 dogfood → 重启"的固定 SOP。

## 0. 三条硬规则

1. **日常 `desktop` profile 不 `link:` 工作区源码**。日常只装 npm 已发布版本或 `pnpm pack` 的
   tgz（`file:`），且保留上一个已知好版本的 tgz 用于秒级回滚。
2. **所有"改源码"的开发/E2E 只在隔离 `flowgate-dev` profile 里做**（独立 `DSH_HOME` 或至少
   独立 profile + `link:`），随便怎么崩都不影响日常。
3. **dogfood profile 装打包产物，不装源码**：FlowGate 仓库自己的开发用它管控，但只有当
   打包产物通过 `pnpm verify:host` 之后才升级 dogfood。这样新代码的 bug 不会把你锁在自己
   的开发之外（04 §9 的原始设计，此前被"desktop 直接 link"绕过去了）。

## 1. Profile 职责表

| profile | 安装方式 | 用途 | 崩溃影响 |
|---|---|---|---|
| `desktop`（日常） | `dsh plugin --profile desktop add dsh-flowgate@<已知好版本>` | 日常使用；**唯一**长期保留的 profile | 只接受已发布/已知好版本；坏版本可秒回滚 |
| `flowgate-dev` | `add link:<repo>` | 改源码、跑单测、本地 E2E（含 `verify:host`） | 隔离，随删随建 |
| `flowgate-dogfood` | `add file:<repo>-<version>.tgz` | 用"已打包并冒烟通过"的版本管控 FlowGate 仓库自己的开发 | 回滚 = 装回上一个 tgz |
| `rescue` | `dsh rescue --from-default-profile web`（内置） | 插件导致宿主起不来时的最小可启动环境 | 官方模板，干净 |

> 隔离建议：dev/E2E 用 `DSH_HOME=/tmp/fg-dev-home`（连 `HOME` 一起隔离更好，插件
> `~/.dsh/flowgate/ledger.key` 也会落在隔离 home）。日常 `desktop` 用默认 `~/.dsh`。

## 2. 命令速查

```bash
# 桌面端自带 CLI（全局 dsh 可能是旧版，不要用）
export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# ---- 日常 desktop：装已发布版本（不用 link）----
"$DSH" plugin --profile desktop add dsh-flowgate@<已知好版本>
"$DSH" --profile desktop --dump-config | grep -i flowgate   # 组合树确认
"$DSH" plugin --profile desktop remove dsh-flowgate         # 移除（插件自身故障时先见 host-recovery.md）

# ---- dev：隔离 re-profile + link 当前工作区 ----
export DSH_HOME=/tmp/fg-dev-home HOME=/tmp/fg-dev-home/home
mkdir -p "$DSH_HOME" "$HOME"
"$DSH" flowgate-dev --from-default-profile web --help       # 第一次建 profile
"$DSH" plugin --profile flowgate-dev add link:/path/to/dsh-flowgate
pnpm build && node scripts/smoke-host.mjs                   # 或 pnpm verify:host（见 §3）
"$DSH" --profile flowgate-dev --no-open --host 127.0.0.1 --port 7100   # 手动 E2E

# ---- dogfood：打包安装 ----
pnpm build
pnpm pack                          # 生成 dsh-flowgate-<version>.tgz（含 lib/、skills/）
cp dsh-flowgate-<version>.tgz /path/to/backup/
"$DSH" plugin --profile flowgate-dogfood add "file:/abs/path/dsh-flowgate-<version>.tgz"
"$DSH" --profile flowgate-dogfood --dump-config | grep -i flowgate

# ---- 回滚：装回上一个已知好 tgz ----
"$DSH" plugin --profile flowgate-dogfood remove dsh-flowgate
"$DSH" plugin --profile flowgate-dogfood add "file:/abs/path/dsh-flowgate-<last-good>.tgz"

# ---- 起不来时：最小环境 ----
"$DSH" rescue --from-default-profile web    # 再用 dev 修复；或临时用 flowgate-dev
```

> `dsh plugin add` 走 pnpm；`link:` 装的插件不解析 peer 依赖（DSH 会提示），这是 link 的已知
> 限制——只在隔离 dev/E2E 里用 link，dogfood/日常用 tgz 或 npm 包。
> macOS 下临时目录用 realpath（`/tmp` → `/private/tmp`），DSH 的 workspace 路径校验收 realpath。

## 3. 固定 SOP：改完 → 冒烟 → 打包 → 装 dogfood → 重启

```text
1. 改代码（src/**、test/**）
2. pnpm lint && pnpm test            # 本地门禁（覆盖率/全量由 Lead 在集成时跑）
3. pnpm build                        # 产出 lib/host.js、lib/client.js
4. pnpm verify:host                  # ★真机回归门：隔离真实 DSH 宿主连续建会话，必须 GREEN
                                     #   失败就停：不要打包、不要升级 dogfood（看 docs/compat/host-smoke.md）
5. pnpm pack                         # 生成 dsh-flowgate-<version>.tgz
6. 备份 tgz：cp dsh-flowgate-<version>.tgz <已知好版本目录>/（保留最近 2 个）
7. 升级 dogfood：dsh plugin --profile flowgate-dogfood remove dsh-flowgate
                 dsh plugin --profile flowgate-dogfood add "file:<tgz 绝对路径>"
8. 完全重启 DSH（桌面端退出重开；Web 宿主 Ctrl-C 后重跑），打开 dogfood 会话验证：
   /flow doctor 正常、dock 出现、新建会话正常
9. 若发现回归 → 立刻回滚（§2 回滚命令）+ 重启；用 dev profile 复现修复；修复记录走修复通道
```

**为什么第 4 步是硬门**：`pnpm test`/`verify:compat` 都测不到"会话摘要里的投影 wire 值"
——只有真实宿主 `POST /api/session/create` 才会触发 DSH 的 lossless JSON 校验。v0.5.1 事故
就是单测全绿但新建会话全挂。该门必须装机运行 DSH 的机器上跑；CI runner 没有 DSH（见 §5）。

**升级 dogfood 的最小条件**（缺一不可）：
- `pnpm verify:host` 通过；
- `pnpm lint`、`pnpm test` 通过；
- 保留上一个已知好 tgz（回滚路径在手）。

## 3.1 重启 / 热重载 SOP（P2-12）

**结论：host 侧插件代码不会热替换，改完必须重启宿主。** `pnpm dev`（`tsdown --watch`）只负责增量重建
`lib/`，已经加载进宿主的模块不会自动换成新代码；DSH 的 Cordis loader 可能在插件管理动作后重新加载，
但**不要依赖它**，统一按"重启"验收：

| 改动 | 需要做什么 |
|---|---|
| `src/host/**` / `src/core/**` / preset / 命令 / 工具 | `pnpm build`（或让 `pnpm dev` 完成一次重建）→ **完全重启宿主** → `pnpm verify:host` 验证 |
| `src/client/**`（面板/dock/授权卡） | `pnpm build`（含 build-client）→ 重启宿主；若宿主/浏览器有缓存，强制刷新窗口 |
| 只改文档/README/CHANGELOG | 无需重启 |
| 只改 profile 安装（升级/回滚插件） | `dsh plugin ... remove/add` 后**完全重启**（插件在启动时加载） |
| 改 safe-mode sentinel / 模块开关 | **完全重启**（启动期读取；运行中不生效） |

**完全重启**：桌面端"退出"后重开（不是关窗口）；Web 宿主 `Ctrl-C` 停掉后重新执行启动命令
（`lsof -tiTCP:<port> -sTCP:LISTEN` 确认旧进程已退出再起）。重启后自检：

```bash
/flow doctor                         # 接管模式 / safe-mode / 模块开关 / 投影自检 / 版本
pnpm verify:host                     # 真机建会话回归门（新构建必跑）
```

> 为什么不能靠热重载验收：v0.5.1 事故里"改了 lib 但宿主还是旧代码"会直接误导结论；以"重启后的新会话"
> 行为为准。热重载只用于 UI 调试时加快预览，不作为发布/验收依据。

## 4. 版本与回滚策略

| 项 | 做法 |
|---|---|
| 版本号 | 发布由 Lead 统一管理；dogfood 用 `pnpm pack` 的当前版本号（未发版时版本号可能与 npm 不同，属预期） |
| 已知好版本 | 至少保留最近 2 个 tgz + 对应 git commit sha 记录在一个本地清单（如 `~/flowgate-backups/MANIFEST.md`；不要把 tgz 提交进仓库） |
| 回滚触发条件 | 新建会话失败 / 宿主启动失败 / `verify:host` 失败 / 门禁明显误伤且无法用 safe-mode 恢复 |
| 回滚演练 | 每次升级后确认 `remove`+`add file:` 命令可用（不需要真的降级，但要确认 tgz 在） |
| 日常 desktop | 只跟 npm 已发布版本；升级前先在 dev 跑 `verify:host` + `verify:compat`，再升 desktop |

## 5. 验证脚本清单与运行环境

| 命令 | 验证什么 | 需要 DSH？ | 何时跑 |
|---|---|---|---|
| `pnpm lint` | 分层依赖 + 类型 | 否 | 每次改完 |
| `pnpm test` | 单测/集成（fake ctx） | 否 | 每次改完 |
| `pnpm coverage` | 覆盖率阈值 | 否 | 集成/发布前 |
| `pnpm verify:package` | npm 包内容（不含宿主核心包） | 否 | 发布前 |
| `pnpm verify:client` | 浏览器 bundle 加载协议/插槽 | 否 | 改 client 后 |
| `pnpm verify:compat` | 隔离 profile 里真实组合/导入插件 | **是** | 改 host/清单/preset 后 |
| `pnpm verify:uninstall` | 安装→卸载干净度 | **是** | 改安装/清理逻辑后 |
| **`pnpm verify:host`** | **隔离真实宿主连续新建会话（v0.5.1 事故回归门）** | **是** | **每次 build 后、打包/升级 dogfood 前必跑** |
| `pnpm measure:startup` | host 入口模块加载成本（<200ms） | 否（真实 Node） | 发布前 |

> GitHub Actions 的 `ci.yml` 跑离线项（lint/test/coverage/build/verify:package/verify:client），
> **不跑** `verify:compat`/`verify:uninstall`/`verify:host`（runner 没有 DSH 桌面端）。
> 发布 workflow 也同理：release 清单要求发布者在有 DSH 的本机执行并记录证据
> （见 [docs/release/v0.1.0.md](../release/v0.1.0.md)）。

## 6. 与恢复/SOP 的关系

- 插件把宿主搞挂（起不来/新建会话失败）时：先 `pnpm host:recover --safe-mode --reason "<现象>"`
  → 重启（插件自动降级 takeover=off，不拦截）→ 用 dev profile/rescue 修复 →
  `pnpm verify:host` 通过 → `pnpm host:recover --clear` → 重启验证。详见
  [host-recovery.md](host-recovery.md)。
- 插件 bug 本身的修复走**修复通道**（`flow_fix_start`，范围内自由迭代 + RED→GREEN + 回归），
  不走七阶段变更流程；回归证据里 `verify:host` 是必跑项。详见 [repair-lane.md](repair-lane.md)。
- 如果修复通道本身不可用（工具/命令都没注册、插件加载失败），用 `host:recover` 与
  dev profile 手工修，属于**环境级恢复**而不是流程例外（见 host-recovery.md §4）。

## 7. 常见坑

| 坑 | 处理 |
|---|---|
| 用全局 `dsh`（旧版）建 profile/装插件 | 用桌面端自带 CLI，或 `export DSH=<桌面端路径>` |
| `--from-default-profile` 指向已存在的内置 profile 报错 | 只对**自定义** profile 名用；`dsh --profile web --from-default-profile web` 会报错 |
| `link:` 安装后 peer 依赖未解析 | 预期行为；日常/dogfood 用 tgz/npm 包 |
| workspace 路径没 realpath | 会话创建报 `session/workspace-attach-failed`；用 `pwd -P` / `realpath` |
| 改了 `lib/` 但宿主还是旧代码 | 重启宿主；dogfood 要重新 `remove`+`add file:<新 tgz>`（重新打包后旧 tgz 不会自动更新） |
| 在 `desktop` profile 里 link 源码 | **禁止**；改用 `flowgate-dev` |
| `pnpm verify:host` 在 Docker/CI 里失败 | 该门需要本机 DSH 桌面端；CI 不跑，见 §5 |
