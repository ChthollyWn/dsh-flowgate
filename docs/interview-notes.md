# 面试 / 作品集材料（M6 / T6.4）

> 用途：把「六个能力 → 实现机制 → 可量化指标 → 一个真实故事」压成一页，面试时按需展开。
> 所有数字都来自本仓库可复现的验证，不虚构；未完成项在文末如实列出。
> 数字基线：2026-10-31 第四轮，代码提交 `090c143`（P0+P1 修复后；`pnpm test` 96 files / 1363 tests 全绿）。

## 一句话

FlowGate 是给 DeepSeek Harness（DSH）加「硬约束开发流程」的插件：把「澄清 → 上下文 → 设计拆解 → TDD 执行 → 验证 → 交付」做成 7 阶段状态机 + 46 项门禁检查 + 宿主层写操作守卫——前一步没完成，后一步的写操作直接被拒绝，并告诉 agent 缺什么、怎么解锁。判断由宿主代码执行，不是提示词。

## 六个能力 → 机制 → 指标

| # | 能力 | 实现机制（代码落点） | 可量化指标 |
|---|---|---|---|
| 1 | 流程顺序是硬约束 | `FlowEngine` 状态机 + 规则引擎（`src/core/rules/evaluate.ts`）；DSH `tools/pre-execute` 异步判定 + `ctx.tools.guard` 同步兜底双保险；S0–S3 写源码拒绝、S4 限定任务范围 | 46 项门禁检查（`GATE_CHECKS`）；规则 R-STAGE-SRC / R-SCOPE / R-TDD-ORDER / R-PROTECTED 等；真机拒绝带规则 id 与解锁路径 |
| 2 | 证据不能是自述 | `flow_verify` 由插件执行命令并签发回执（命令、退出码、用例数、输入哈希）；输入变化即过期；S5 全量测试/证据齐全才允许 G5 | 回执 E-000n 可追溯；输入哈希判定过期；C-001 任务卡 GREEN 41/41、G2 baseline 20/20 |
| 3 | 规格层可被检查 | 产物解析（clarify/proposal/spec/context/design/risk/tasks）+ G0–G3/G5/G6 检查；场景覆盖、模糊词、事实引用逐行核验、任务卡与执行图 | 46 项检查每项正反例；G1 首轮失败项 `scenarioCoverage`/`factsCitations` 可复现；G3 任务卡/范围/依赖检查 |
| 4 | 跨会话可接续、账本防篡改 | `.flowgate/` 目录 + 哈希链 + HMAC 账本；会话租约与 takeover；锁定模式与 `/flow repair`；归档主规格 ADDED/MODIFIED/REMOVED 合并 | 篡改可定位到行（锁定时写操作拒绝）；归档后编号不复用（C-002）；`spec.merged` R1–R5 |
| 5 | 交付闭环与指标 | S5/S6 检查、单文件 HTML 交付报告、跨会话看板、M-1～M-18 指标（取不到标"未知"不用 0）、规则沉淀、只读分析任务 | C-001 交付报告 128KB；M-6 首次通过率 28.6%、M-10 TDD 合规率 100%、M-13 人工门 4 次；18/18 组 A/B 对照 + 4 项主观指标人工评分可复现（`docs/evaluation.md` §6） |
| 6 | 可视与降级路径 | 输入框状态条 + 右侧栏 8 视图面板；`/flow doctor` 能力清单；缺服务/缺 provider/无 git 时逐项降级并提示；插件故障不阻塞宿主 | 真实 Web 宿主 **25 张截图**（会话内 preset 切换 / 8 视图 / 面板 Remote 兜底 / 低复杂度确认卡 / 拦截反馈组件级）；`restrict`/`presentAs` 能力检测 ✓；启动增量 **+12.1 / +15.5ms**（模块加载口径，不含 UI 冷启动）；卸载干净度检查通过 |

## 一个真实故事（不是编的）

**背景**：用 OpenSpec/Superpowers 这类方法时，模型可以绕过流程——Superpowers v7.0.1 的官方发布说明就承认 brainstorming 改版前有测试场景 24/24 次跳步。FlowGate 把这条纪律从提示词搬到宿主层。

**真机证据（java-renewal 副本，隔离 DSH_HOME，headless + 真模型）**：

1. C-001 的 S1 阶段，agent 想改 `src/server.js`，被 `R-STAGE-SRC` 在文件落地前拒绝，模型收到规则 id、失败原因与解锁命令；debug trace 与账本 `rule.denied` 可查。
2. 同一变更走完 S0→S6：G1 三轮修复（补场景与 `文件:起止行` 引用）→ G2 baseline 20/20 → G3 通过 → G4 任务门 → G5 全量验证 → G6 批准 → 归档，产出 128KB HTML 报告并把主规格合并为 R1–R5。
3. C-002 打开真实审查子 agent 后返回 5 条带 `文件:行号` 的 findings（其中一条指出测试桩在反射失败时兜底返回空页，"RED 永远不可能红"——正是流程门禁最该抓的虚假通过）。
4. **完整对照（18/18 run，真实模型 + 隔离 headless）**：9 任务 × A/B 全部跑完——两种条件回归通过数相同（各 7/9）；B 组多 2–20 倍耗时与 1–3 次人工门（由脚本扮演负责人），B 组 0 虚假完成 vs A 组 2 次，但 B 的隐藏需求遗漏反而更多（41 vs 22 条）——不能吹成"FlowGate 让交付更好"，诚实结论见 `docs/evaluation.md` §6.4/§6.5。单点 pilot（`ts-todo-api` 修分页 bug，A/B 各 1 次：B 多 2 轮、约 13 倍耗时、3 次人工门）是最直观的对照。真机还验证了：顺序派发 3 批次完整结算到 S5（外部回归 20/20）、并行批次两个执行者真实启动（worktree + 独立子 agent + 回执 + 熔断），但 headless 进程在集成检查点合并前退出。

## 工程与验证数字

- 测试：**96 个测试文件 / 1363 个用例**（core / host / client / 集成 / 故障注入），`pnpm test` 全绿（约 3.3s）；CI 同时跑 coverage。
- 真机兼容：DSH `0.2.1-rc.5`，`verify:compat` 7/7（2026-10-31，HEAD `43d18e5`；当前 HEAD 尚未复跑，见 [compat/](compat/)）；真实 Web 宿主走查截图 25 张（其中 24–26 为组件级）+ headless 真模型完整 S0→S6（`ts-todo-api` / `java-renewal`）。
- 加固：故障注入 **7/7**；启动增量 **+12.1 / +15.5ms**（两次采样，验收线 <200ms；口径是模块加载成本，不含 Electron/UI 冷启动）；隔离 profile 安装/卸载干净度通过。
- 包：**39 文件 / 928.0KB**（`pnpm verify:package`），零 `@deepseek-ai/*` 运行时依赖（只作可选 peer），不联网、无遥测。
- 评测：**18/18 run**（9 任务 × A/B，真实模型 + 隔离 headless）+ 4 项主观指标（隐藏需求遗漏 / 越界文件 / 虚假完成 / 验收覆盖）**人工评分 18/18**；从 0 开发演练 6 次与派发对照见 `docs/evaluation.md` §6.6/§6.7。
- CI：GitHub Actions 覆盖 lint / test / build / verify:package / verify:client；当前 HEAD 本地全量验证通过（本轮未推送，CI 需推送后重跑）。

## 坦诚的局限（面试时主动说）

- **对照评测不能外推**：18/18 run 已完成，但每格只有 1 次 run、单一模型、单人评分；B 组 9 个 run 里只有 1 个完整走到 G6，多数被环境/审批阻塞；从 0 开发演练只走到 C0 执行，**未完成 C1 交付**；M-18 并行/顺序对照各 1 次，**加速比不可计算**。
- **Desktop 宿主未走查**（兼容矩阵 Desktop 仍 ⏳）；启动增量是"模块加载"口径，**不含 Electron/UI 冷启动**（未测，不伪造数字）。
- **并行批次真机合并结算未复测**：顺序派发已完整结算到 S5；并行批次只验证到"真实启动 + 回执 + 熔断"，worktree 合并/集成检查点/合并冲突统计未在真机跑通（headless 一次性进程在集成检查点前退出），需交互式/常驻宿主复验。
- **Web 走查有边界**：全程未发模型请求——确认卡是离线构造状态后由真实宿主渲染，拦截→误判反馈只有组件级证据，真实 guard 拦截→面板端到端仍未验证；投影 epoch 修复有 6 例单测，但真机重启复验未做。
- npm 首发/GitHub Release 尚未发布（发布物料与 workflow 已就绪，按负责人决定暂缓）。

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
