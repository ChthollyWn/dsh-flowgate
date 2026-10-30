# 面试 / 作品集材料（M6 / T6.4）

> 用途：把「六个能力 → 实现机制 → 可量化指标 → 一个真实故事」压成一页，面试时按需展开。
> 所有数字都来自本仓库可复现的验证，不虚构；未完成项在文末如实列出。

## 一句话

FlowGate 是给 DeepSeek Harness（DSH）加「硬约束开发流程」的插件：把「澄清 → 上下文 → 设计拆解 → TDD 执行 → 验证 → 交付」做成 7 阶段状态机 + 46 项门禁检查 + 宿主层写操作守卫——前一步没完成，后一步的写操作直接被拒绝，并告诉 agent 缺什么、怎么解锁。判断由宿主代码执行，不是提示词。

## 六个能力 → 机制 → 指标

| # | 能力 | 实现机制（代码落点） | 可量化指标 |
|---|---|---|---|
| 1 | 流程顺序是硬约束 | `FlowEngine` 状态机 + 规则引擎（`src/core/rules/evaluate.ts`）；DSH `tools/pre-execute` 异步判定 + `ctx.tools.guard` 同步兜底双保险；S0–S3 写源码拒绝、S4 限定任务范围 | 46 项门禁检查（`GATE_CHECKS`）；规则 R-STAGE-SRC / R-SCOPE / R-TDD-ORDER / R-PROTECTED 等；真机拒绝带规则 id 与解锁路径 |
| 2 | 证据不能是自述 | `flow_verify` 由插件执行命令并签发回执（命令、退出码、用例数、输入哈希）；输入变化即过期；S5 全量测试/证据齐全才允许 G5 | 回执 E-000n 可追溯；输入哈希判定过期；C-001 任务卡 GREEN 41/41、G2 baseline 20/20 |
| 3 | 规格层可被检查 | 产物解析（clarify/proposal/spec/context/design/risk/tasks）+ G0–G3/G5/G6 检查；场景覆盖、模糊词、事实引用逐行核验、任务卡与执行图 | 46 项检查每项正反例；G1 首轮失败项 `scenarioCoverage`/`factsCitations` 可复现；G3 任务卡/范围/依赖检查 |
| 4 | 跨会话可接续、账本防篡改 | `.flowgate/` 目录 + 哈希链 + HMAC 账本；会话租约与 takeover；锁定模式与 `/flow repair`；归档主规格 ADDED/MODIFIED/REMOVED 合并 | 篡改可定位到行（锁定时写操作拒绝）；归档后编号不复用（C-002）；`spec.merged` R1–R5 |
| 5 | 交付闭环与指标 | S5/S6 检查、单文件 HTML 交付报告、跨会话看板、M-1～M-18 指标（取不到标"未知"不用 0）、规则沉淀、只读分析任务 | C-001 交付报告 128KB；M-6 首次通过率 28.6%、M-10 TDD 合规率 100%、M-13 人工门 4 次；pilot A/B 对照数据可复现 |
| 6 | 可视与降级路径 | 输入框状态条 + 右侧栏 8 视图面板；`/flow doctor` 能力清单；缺服务/缺 provider/无 git 时逐项降级并提示；插件故障不阻塞宿主 | 真实 web 宿主 11 张截图；`restrict`/`presentAs` 能力检测 ✓；启动增量 +14.2ms（模块加载代理）；卸载干净度检查通过 |

## 一个真实故事（不是编的）

**背景**：用 OpenSpec/Superpowers 这类方法时，模型可以绕过流程——Superpowers v7.0.1 的官方发布说明就承认 brainstorming 改版前有测试场景 24/24 次跳步。FlowGate 把这条纪律从提示词搬到宿主层。

**真机证据（java-renewal 副本，隔离 DSH_HOME，headless + 真模型）**：

1. C-001 的 S1 阶段，agent 想改 `src/server.js`，被 `R-STAGE-SRC` 在文件落地前拒绝，模型收到规则 id、失败原因与解锁命令；debug trace 与账本 `rule.denied` 可查。
2. 同一变更走完 S0→S6：G1 三轮修复（补场景与 `文件:起止行` 引用）→ G2 baseline 20/20 → G3 通过 → G4 任务门 → G5 全量验证 → G6 批准 → 归档，产出 128KB HTML 报告并把主规格合并为 R1–R5。
3. C-002 打开真实审查子 agent 后返回 5 条带 `文件:行号` 的 findings（其中一条指出测试桩在反射失败时兜底返回空页，"RED 永远不可能红"——正是流程门禁最该抓的虚假通过）。
4. M6 对照 pilot：`ts-todo-api` 修分页 bug，A（标准模式）与 B（FlowGate）各跑 1 次，两者都修对；B 多 2 轮、约 13 倍耗时、3 次人工门，换来 RED/GREEN 回执、门禁留痕与交付报告。

## 工程与验证数字

- 测试：**67 个测试文件 / 976 个用例**（core / host / client / 集成 / 故障注入）。
- 真机兼容：DSH `0.2.1-rc.5`，`verify:compat` 7/7；web 宿主走查 + headless 真模型 S0→S6。
- 加固：故障注入 4/4；启动增量 +14.2ms（验收线 <200ms）；隔离 profile 安装/卸载干净度通过。
- 包：39 文件 / 848.7KB，零 `@deepseek-ai/*` 运行时依赖（只作可选 peer），不联网、无遥测。
- CI：GitHub Actions 全绿（lint / test / build / verify:package / verify:client）。

## 坦诚的局限（面试时主动说）

- 对照评测只完成 1/9 任务的 pilot：样本小、单一模型、自评，不能外推；完整矩阵与从 0 开发演练仍在跑。
- Desktop 宿主需人工走查；启动增量是"模块加载"口径，不含 Electron/UI 冷启动。
- 派发/并行 worktree 的完整结算需要交互式会话（headless 一次性运行会在子 agent 结算前退出），host 单测已覆盖但其真机闭环待补。
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
