# 决策记录：控制面外移（plugin vs CLI/daemon，P2-13）

> 状态：**Accepted（v0.6 最小外移；daemon 推迟到 v1.0 评估）** · 日期：2026-11-01
> 背景：v0.5.1 事故（投影 wire 非 lossless JSON → 新建会话失败）暴露出一个结构性问题——
> **恢复路径本身依赖插件健康**。旧流程要求 `/flow off`（插件内命令）、面板禁用（整插件+重启）、
> 再重新安装；插件一旦让"新建会话"失败，用户就没有可用的会话去执行恢复动作（自举死锁）。
> 因此提出"控制面外移"：把状态查看、恢复、诊断等能力从插件进程里拿出来，做成独立 CLI/daemon。

## 1. 决策

| 项 | 决定 |
|---|---|
| 拦截/门禁/工具/投影/注入 | **保留在插件进程内**（不参数化、不外移）——它们必须与宿主工具调用同进程才能同步拦截 |
| 恢复/诊断/状态查看 | **v0.6 起提供独立 CLI**（`node scripts/host-recover.mjs` / `pnpm host:recover`；未来抽成独立 npm bin）——不依赖插件加载成功 |
| 独立 daemon 常驻进程 | **v0.6 不做**；v1.0 再评估（依赖多实例/远程控制需求是否出现） |
| 数据面（`.flowgate/` 状态、账本、修复/事故记录） | 继续**文件即接口**（atomic write + 账本），任何进程可只读解析；写入仍由插件（宿主内）串行化 |

一句话：**enforcement 留在进程内，recovery 必须留在进程外。**

## 2. 备选方案

### A. 纯插件（现状，v0.5.x）

- 优点：零额外安装；状态与宿主生命周期一致；sync guard/投影/工具都在进程内，无 IPC 成本；
  打包简单（一个 npm 包）；沙箱/权限模型直接继承宿主。
- 缺点：
  - 插件坏 → 恢复手段也在插件里（死锁，本次事故）；
  - 无会话时无法查看/修复项目状态（DSH 未启动 = 什么都做不了）；
  - CI/离线环境无法检查 `.flowgate` 状态与账本完整性；
  - 面板动作、命令、恢复全绑在 GUI 会话上，不适合脚本化/运维。

### B. 插件 + 独立 CLI（**v0.6 采用**）

- 优点：
  - 恢复不依赖插件健康：safe-mode sentinel 是**纯文件**，CLI 写文件即可让插件下次启动降级；
  - profile 级操作（移除插件、查看/回滚安装）本来就由 `dsh plugin` CLI 完成，外移自然；
  - 可脚本化/可审计（recovery.log、退出码、CI 可调用）；
  - 数据面文件即接口，CLI 只读/只写自己的 sentinel 与审计，不与插件抢写状态；
  - 成本低：一个 Node 脚本，无新依赖、无守护进程、无端口。
- 缺点：CLI 与插件必须对"home 路径/状态格式"保持同一口径（本轮已要求 host 侧 honor
  `DSH_HOME`）；CLI 无法做真正的强制拦截（设计如此）。

### C. 插件 + daemon（sidecar/后台服务）

- 优点（潜在）：多 DSH 实例共享状态/租约；无会话时也能跑恢复任务、指标聚合、报告生成；
  未来可做远程/多机控制面；统一鉴权入口。
- 缺点：
  - **enforcement 仍必须在进程内**（同步 pre-execute 守卫无法跨进程等待 daemon），daemon 只能做
    辅助，无法替代插件——收益有限；
  - 部署/运维成本高（macOS launchd / Windows 服务 / Linux systemd、开机自启、升级、端口/权限）；
  - 单写者问题：daemon 与插件同时写 `.flowgate/` 需要跨进程锁，账本哈希链串行化复杂化；
  - 安全面扩大：本地端口 = 新的攻击面，需要鉴权/CSRF/权限设计；
  - 与"插件即产品"的发布形态冲突（npm 包 vs 系统服务安装器），对个人开发者不友好；
  - v0.6 的需求（恢复/诊断）CLI 已能覆盖 90%，daemon 属过度设计。

## 3. 为什么 v0.6 选 B

1. **直接消除本次事故的根因**：safe-mode sentinel + CLI 让"插件坏了"时仍有可执行、可审计的
   恢复路径（见 [host-recovery.md](host-recovery.md)、[dev-loop.md](dev-loop.md)）。
2. **enforcement 的进程内属性不可让渡**：守卫必须在工具执行的同步路径上返回 deny，跨进程 IPC
   会引入延迟、可绕过窗口与单点故障，违反硬约束的产品前提。
3. **数据面已经是文件**：`.flowgate/` + 账本 + 修复/事故记录天然支持外部只读；CLI 不需要数据库
   或新协议。
4. **发布形态不变**：CLI 随 npm 包分发（`bin` 或 `node scripts/...`），不引入系统服务与安装器。
5. **可逆**：v1.0 若真出现多实例/远程需求，可在 B 的基础上加 daemon（读同一数据面），不需要
   推翻 C 的架构判断。

## 4. 控制面能力拆分表

| 能力 | 放哪 | 原因 |
|---|---|---|
| 工具调用拦截（guard/pre-execute） | 插件进程内 | 必须同步判定；跨进程不可靠 |
| 人工门/待处理项通知、注入上下文 | 插件进程内 | 依赖宿主会话/agent API |
| 会话投影（wire） | 插件进程内 | 必须是宿主提供的投影注册点 |
| `flow_*` 工具、`/flow` 命令 | 插件进程内 | 模型/会话接口绑定 |
| 状态查看（只读） | 插件 + **CLI/脚本** | 文件即接口；CLI 可离线用 |
| doctor / 账本校验 / 报告生成 | 插件 + **CLI（离线）** | 无宿主也可诊断 |
| safe-mode 启用/清除 | **CLI（文件）** | 恢复不应依赖插件 |
| 插件安装/卸载/版本回滚 | **DSH CLI（profile）** | 平台提供，天然进程外 |
| 修复/事故记录写入 | 插件（宿主内串行）；CLI 可读 | 单写者，保账本一致性 |
| 指标导出/看板 | 插件生成文件；CLI 可读/汇总 | 离线可消费 |
| 多实例协调（租约/锁） | 插件（文件锁/租约） | 现状已覆盖；daemon 非必需 |

## 5. v1.0 方向（若做 daemon）

前置条件（满足任一再评估，而不是默认做）：
- 用户明确要求多 DSH 实例共享一个 FlowGate 状态/租约，或远程（跨机器）查看/控制；
- 需要"宿主未启动时"执行长任务（如定时指标聚合、CI 门禁校验、批量报告）；
- 桌面端插件机制无法提供某个必需能力（如系统级通知/定时器）。

候选形态：
1. `flowgate daemon`（本地 HTTP/Unix socket，仅监听 loopback + 单用户 token），插件作为客户端
   上报状态/租约；enforcement 仍在插件；
2. 保持"文件即接口"，daemon 只做只读聚合与写恢复动作，不接管 `.flowgate` 写路径；
3. 状态写入用文件锁 + 账本追加（复用现有 hash chain），禁止 daemon 直接改 `status.json`；
4. 安全基线：无网络监听（Unix socket / loopback）、token 文件 0600、拒绝远程默认开启；
5. 打包：作为可选 `flowgate` npm bin，不强制安装为系统服务。

验收线（若立项）：单写者不破、账本校验不降级、enforcement 延迟不变、安装/卸载干净度不倒退、
无新增默认监听端口。未满足则继续维持方案 B。

## 6. 影响与后续动作

| 项 | 动作 |
|---|---|
| 文档 | 本决策记录；[host-recovery.md](host-recovery.md) 的 L0–L4 恢复阶梯；[dev-loop.md](dev-loop.md) 双 profile |
| 代码（已做） | `scripts/host-recover.mjs` + `pnpm host:recover`；safe-mode sentinel；模块开关；takeover observe |
| 代码（后续） | 把 CLI 抽成 npm `bin`（`flowgate-recover`），复用同一实现；`/flow doctor` 输出补充 sentinel 路径（已加） |
| 风险 | CLI 与插件 home 口径漂移 → 已要求 host 侧 honor `DSH_HOME`，doctor 展示实际读取路径；文档明确"以 doctor 显示为准" |
| 不做 | v0.6 不引入 daemon、本地端口、系统服务、数据库 |

## 7. 参考

- 事故与根因：[docs/impl/implementation-status.md](../impl/implementation-status.md) §3.17、[docs/compat/host-smoke.md](../compat/host-smoke.md)
- 恢复 SOP：[docs/impl/host-recovery.md](host-recovery.md)
- 双 profile 与开发闭环：[docs/impl/dev-loop.md](dev-loop.md)
- 自举设计：[docs/04-执行方案.md](../04-执行方案.md) §9
