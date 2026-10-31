# 面试 / 作品集材料（M6 / T6.4）

> 用途：把「六个能力 → 实现机制 → 可量化指标 → 两个真实故事」压成一页，面试时按需展开。
> 所有数字都来自本仓库可复现的验证，不虚构；未完成项在文末如实列出。
> 数字基线：2026-10-31 第六轮（独立复验后的接线修复，代码提交 `cea85dd`；`pnpm test` **112 files / 1522 tests** 全绿，lint/typecheck 通过；coverage/build 等门禁数字见 [implementation-status §2](impl/implementation-status.md)）。门禁检查数按 `src/core/artifacts/checks.ts` 中 `GATE_CHECKS` 实测为 **52 项**。

## 一句话

FlowGate 是给 DeepSeek Harness（DSH）加「硬约束开发流程」的插件：把「澄清 → 上下文 → 设计拆解 → TDD 执行 → 验证 → 交付」做成 7 阶段状态机 + 52 项门禁检查 + 宿主层写操作守卫——前一步没完成，后一步的写操作直接被拒绝，并告诉 agent 缺什么、怎么解锁。判断由宿主代码执行，不是提示词。

## 六个能力 → 机制 → 指标

| # | 能力 | 实现机制（代码落点） | 可量化指标 |
|---|---|---|---|
| 1 | 流程顺序是硬约束 | `FlowEngine` 状态机 + 规则引擎（`src/core/rules/evaluate.ts`）；DSH `tools/pre-execute` 异步判定 + `ctx.tools.guard` 同步兜底双保险；S0–S3 写源码拒绝、S4 限定任务范围 | 52 项门禁检查（`GATE_CHECKS`）；规则 R-STAGE-SRC / R-SCOPE / R-TDD-ORDER / R-PROTECTED 等；真机拒绝带规则 id 与解锁路径 |
| 2 | 证据不能是自述 | `flow_verify` 由插件执行命令并签发回执（命令、退出码、用例数、输入哈希）；输入变化即过期；S5 全量测试/证据齐全才允许 G5 | 回执 E-000n 可追溯；输入哈希判定过期；java-renewal C-001 任务卡 GREEN 41/41、G2 baseline 20/20（§3.5） |
| 3 | 规格层可被检查 | 产物解析（clarify/proposal/spec/context/design/risk/tasks）+ G0–G3/G5/G6 检查；场景覆盖、模糊词、事实引用逐行核验、任务卡与执行图 | 52 项检查每项正反例；G1 首轮失败项 `scenarioCoverage`/`factsCitations` 可复现（java-renewal C-001，§3.5）；G3 任务卡/范围/依赖检查 |
| 4 | 跨会话可接续、账本防篡改 | `.flowgate/` 目录 + 哈希链 + HMAC 账本；会话租约与 takeover；锁定模式与 `/flow repair`；归档主规格 ADDED/MODIFIED/REMOVED 合并 | 篡改可定位到行（锁定时写操作拒绝）；归档后编号不复用（java-renewal 归档 C-001 后新建为 C-002，§3.5）；`spec.merged` R1–R5（ts-todo-api C-002 / java-renewal C-001） |
| 5 | 交付闭环与指标 | S5/S6 检查、单文件 HTML 交付报告、跨会话看板、M-1～M-18 指标（取不到标"未知"不用 0）、规则沉淀、只读分析任务 | 交付报告样例：`ts-todo-api` C-002 116KB、`java-renewal` C-001 128KB；指标取 pilot（`ts-todo-api / fix-bug` B 组，原始数据 [metrics/C-001.json](evaluation-data/20261031-022858-ts-todo-api-fix-bug-B/metrics/C-001.json)）：M-6 门禁首次通过率 **42.9%**（3/7）、M-10 TDD 合规率 100%（1/1）、M-13 人工门 4 次；18/18 组 A/B 对照 + 4 项主观指标人工评分可复现（[evaluation.md](evaluation.md) §6） |
| 6 | 可视与降级路径 | 输入框状态条 + 右侧栏 8 视图面板；`/flow doctor` 能力清单；缺服务/缺 provider/无 git 时逐项降级并提示；插件故障不阻塞宿主 | 真实 Web 宿主 **25 张截图**（会话内 preset 切换 / 8 视图 / 面板 Remote 兜底 / 低复杂度确认卡 / 拦截反馈组件级）；`restrict`/`presentAs` 能力检测 ✓；启动增量 **+16.2ms**（模块加载口径，不含 UI 冷启动）；卸载干净度检查通过 |

## 两个真实故事（各自可追溯，不混用仓库）

**背景**：用 OpenSpec/Superpowers 这类方法时，模型可以绕过流程——Superpowers v7.0.1 的官方发布说明就承认 brainstorming 改版前有测试场景 24/24 次跳步。FlowGate 把这条纪律从提示词搬到宿主层。

### 故事 A：`ts-todo-api` —— 守卫真机拦截 + 真模型完整闭环（C-001/C-002）

1. C-001 的 S1 阶段，agent 真实调用 `read` + `edit` 改 `src/server.js`，被 `R-STAGE-SRC` 在文件落地前拒绝；debug trace `action kind=write path=src/server.js → effect=deny rule=R-STAGE-SRC → sync-guard cache=deny`，文件未被修改，模型收到规则 id、失败原因与解锁命令。此前一次"放行"经查是消耗了上一轮遗留的单次放行 `OV-1`（账本 `override.used` 可证），语义正确。证据：[implementation-status §3.4](impl/implementation-status.md)「守卫真机证据」。
2. C-002 从 `/flow new` 到 S6 归档走完整闭环：G1 7/7、G2 baseline 34/34、G3 9/9、S5/G6 通过；产出 116KB HTML 交付报告，主规格按 R1–R5 合并。证据：[implementation-status §3.4](impl/implementation-status.md)。
3. 该仓库也是 18 组 A/B 对照评测的基准之一（pilot 即 `ts-todo-api / fix-bug`），见 [evaluation.md](evaluation.md) §6.1/§6.2。

### 故事 B：`java-renewal` —— 第二条独立闭环 + 审查子 agent 真机（C-001/C-002）

1. C-001 在 `java-renewal` 副本（git init + 基线提交，隔离 headless + 真模型）上跑完 S0→S6：G1 经 3 轮修复后通过（首轮失败项 `g1.scenarioCoverage`/`g1.factsCitations`）→ G2 baseline JUnit XML 20/20（真实 `./mvnw -B test`）→ G3 通过（低复杂度快车道）→ S4 `flow_verify` E-0002 41/41 → S5 因 build 写 `~/.m2` 被拒，负责人把 build 命令改为 compile 后通过 → S6 归档：128KB HTML 报告、主规格 `spec.merged` R1–R5、账本 7 次 `gate.passed` / 6 次 `gate.failed` / 5 次 `gate.approved` / 11 次 `verify.receipt`。证据：[implementation-status §3.5](impl/implementation-status.md)。
2. 同一副本 C-002（审查开启）上真实审查子 agent 两次启动：RV-1 因读取覆盖不足返回 `coverageOk=false`（账本 `review.coverage_failed`，不消耗轮次）；RV-2 `coverageOk=true` 并返回 5 条带 `文件:行号` 的 findings（其中一条指出测试桩在反射失败时兜底返回空页，"RED 永远不可能红"——正是流程门禁最该抓的虚假通过）。证据：[implementation-status §3.5](impl/implementation-status.md)「审查真机验证」。

> 两条故事的产物都在真实 demo 仓库（非测试 fixture）；demo 工作区未随仓库提交，报告尺寸与账本计数以 implementation-status §3.4/§3.5 的记录为准。

## 工程与验证数字

- 测试：**112 个测试文件 / 1522 个用例**（core / host / client / 集成 / 故障注入；第五轮 107/1459，本轮 +5 文件 / +63 用例），`pnpm test` 全绿；`pnpm coverage` 通过 thresholds（80/80/80/70）：合计 **86.40 / 76.25 / 86.92 / 89.46**（语句/分支/函数/行），core 83.42/69.26/82.59/88.48、host 74.09/65.71/70.00/78.20。
- 真机兼容：DSH `0.2.1-rc.5`，`verify:compat` **13/13**（2026-10-31 第六轮在隔离 `DSH_HOME=/tmp/fg-audit-env` 用新构建复跑，dump-config 1314 行；第五轮 13/13 含 6 项离线结构检查；见 [compat/](compat/)）；真实 Web 宿主走查截图 25 张（其中 24–26 为组件级）+ headless 真模型完整 S0→S6（`ts-todo-api` / `java-renewal`）。
- 加固：故障注入套件通过（含状态损坏/守卫抛错/服务缺失/配置损坏/浏览器包缺失）；启动增量 **+16.2ms**（基线 16.5 / 加载 32.6；验收线 <200ms；口径是模块加载成本，不含 Electron/UI 冷启动）；隔离 profile 安装/卸载干净度通过。
- 包：约 **39 文件 / 约 1.03MB**（`pnpm verify:package` 精确值 1032.8KB，docs 修改后重跑实测）；构建产物 `lib/host.js` 1,210,648 B（≈1.21MB）/ `lib/client.js` 223,830 B（≈219KB）；零 `@deepseek-ai/*` 运行时依赖（只作可选 peer），不联网、无遥测。
- 评测：**18/18 run**（9 任务 × A/B，真实模型 + 隔离 headless）+ 4 项主观指标（隐藏需求遗漏 / 越界文件 / 虚假完成 / 验收覆盖）**人工评分 18/18**（[evaluation.md](evaluation.md) §6.2/§6.5）；单点 pilot（`ts-todo-api / fix-bug` A/B 各 1 次）：两种条件回归 34/34、验收 4/4 全过，B 多 2 轮 / 约 13 倍耗时 / 3 次人工门（§6.1）；从 0 开发演练 6 次与派发对照见 §6.6/§6.7。
- 派发真机：`java-renewal` 新功能 `dispatch=auto` 顺序派发 3 批次完整结算到 S5（外部回归 20/20）；并行批次两个执行者真实启动（worktree + 独立子 agent + 回执 + 熔断），但 headless 一次性进程在集成检查点合并前退出（[evaluation.md](evaluation.md) §6.7）。
- 第六轮复验：独立只读复验驱动修复了 **7 项 P1 接线缺口**（并行 worktree 执行根、派发双结算、S5 全量测试回归判定、上下文压缩/跨会话重注入、澄清占位符、低复杂度任务数上限，均补回归测试，提交 `cea85dd`），并修正 T2.3/T5.1/M-16/规则试跑等 P2 与文档口径——这是"用审计反推实现接线"的真实工程故事。
- CI：GitHub Actions 覆盖 lint / test / coverage / build / verify:package / verify:client；第六轮提交（`cea85dd` + `25fffac`）已推送，CI run [41197243594](https://github.com/ChthollyWn/dsh-flowgate/actions/runs/41197243594) **success**（本地门禁同样全绿）。

## 坦诚的局限（面试时主动说）

- **对照评测不能外推**：18/18 run 已完成，但每格只有 1 次 run、单一模型、单人评分；B 组 9 个 run 里只有 1 个完整走到 G6，多数被环境/审批阻塞；从 0 开发演练走到 C0 立项后的 S1–S3（真实模型），**未完成 C1 交付**（根因之一见下条 C0 TDD 死锁）；M-18 并行/顺序对照各 1 次，**加速比不可计算**。
- **C0 骨架首任务 TDD 死锁**（真实产品发现，产品待决策）：C0 只允许写工程骨架、`package.json` 在 RED 前不可写，greenfield C0→C1 因此卡住；需决定" C0 豁免 TDD"或给出标准 allow-once SOP。
- **Desktop 宿主未走查**（兼容矩阵 Desktop 仍 ⏳）；启动增量是"模块加载"口径，**不含 Electron/UI 冷启动**（未测，不伪造数字）。
- **并行批次真机合并结算未复测**：顺序派发已完整结算到 S5；并行批次只验证到"真实启动 + 回执 + 熔断"，worktree 合并/集成检查点/合并冲突统计未在真机跑通（headless 一次性进程在集成检查点前退出），需交互式/常驻宿主复验。
- **Web 走查有边界**：全程未发模型请求——确认卡是离线构造状态后由真实宿主渲染，拦截→误判反馈只有组件级证据，真实 guard 拦截→面板端到端仍未验证；投影 epoch 修复有 6 例单测，但真机重启复验未做。
- npm 首发/GitHub Release 尚未发布（发布物料与 workflow 已就绪，按负责人决定暂缓）；远程 tag `v0.1.0` 已存在并指向 `f53d5f1`，前移需 force-move 或 bump 新版本（[release notes §8](release/v0.1.0.md)）。

## 可复现命令

```bash
pnpm install && pnpm lint && pnpm test && pnpm build
pnpm verify:client && pnpm verify:package
DSH_HOME=/tmp/fg-home pnpm verify:compat
pnpm verify:uninstall && pnpm measure:startup
```

真实宿主演示（隔离 profile，不碰日常 desktop）：

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" flowgate-dev --from-default-profile web --help
"$DSH" plugin --profile flowgate-dev add link:"$(pwd)"
"$DSH" --profile flowgate-dev
```

证据索引：[docs/impl/implementation-status.md](impl/implementation-status.md)、[docs/evaluation.md](evaluation.md)、[docs/compat/](compat/)、[docs/screenshots/](screenshots/README.md)。
