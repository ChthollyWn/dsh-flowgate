# 方法来源追踪表（Method Sources）

> 目的：FlowGate 的 15 个内置技能不是凭空写的，而是把 OpenSpec、Superpowers、gstack 三个上游项目的**方法论**改写成插件自己的能力。这份表记录每个技能借鉴了哪个上游项目的哪类实践、我们改写了什么、哪些由代码强制、哪些只做引导，以及如何定期复查，避免"借鉴"变成无出处的搬运。
>
> 本表由内容层维护（`skills/**` 的配套文档）。每季度对照上游发布说明复查一次；上游版本基线变化时更新此表，并同步检查 `THIRD_PARTY_NOTICES.md`。

## 1. 上游版本基线

| 上游 | 版本 / 状态 | 日期 | 许可 | 我们使用的部分 | 仓库 |
|---|---|---|---|---|---|
| OpenSpec | v1.15.0 | 2026-10-24 | MIT | 变更/规格的产物组织方式、`config.yaml` 上下文与规则、`propose`/`explore`/`archive` 的思路、需求编号与场景写法 | <https://github.com/Fission-AI/OpenSpec> |
| Superpowers | v7.0.1 | 2026-10-21 | MIT | 需求澄清（brainstorming）、计划写作（writing-plans）、TDD、系统化调试、验证前置、代码审查、子 agent 执行与并行派发的**纪律** | <https://github.com/obra/superpowers> |
| gstack | 仓库 main 分支快照（未标注版本号；复查以 commit 为准） | 2026-10 快照 | MIT | `/office-hours`、`/spec`、`/plan-eng-review`、`/freeze`、`/careful`、`/guard`、`/investigate`、`/review`、`/qa`、`/cso`、`/ship`、`/document-release`、`/retro` 的**工作流形状** | <https://github.com/garrytan/gstack> |
| dsh-task-engine | 同类 DSH 插件（对照对象，非方法论上游） | 2026-10 调研时 | 以该仓库许可为准 | 只读分析契约、宿主集成方式（见 `docs/03-技术方案.md` §2、§7）；FlowGate 不复制其代码 | —— |

**边界声明：**

- 我们**没有复制**上述项目的源代码、文档正文或提示词原文。技能和文档用我们自己的话重写，只保留思想层面的做法（例如"先写失败测试"这种工程原则）。
- 不依赖上述项目的 CLI、技能包或运行环境；FlowGate 是独立的 DSH 插件。
- 产物格式（`specs/`、`changes/`、`archive/`、proposal / design / tasks、ADDED / MODIFIED / REMOVED）沿用 OpenSpec 的公开约定，方便使用者把学到的东西迁移出去；这是格式兼容，不是代码复用。
- gstack 的许多命令是一次性工作流，我们只借鉴其"先问清、再冻结范围、再交付"的形状，改写成 DSH 里的阶段门禁，不照搬多角色编排。

## 2. 技能 → 上游来源追踪表

| 技能 | 阶段 | 上游来源（条目） | 我们改写了什么 | 代码强制的部分 | 只做引导的部分 |
|---|---|---|---|---|---|
| `flow-roadmap` | 从 0 开发 | gstack `/office-hours`、`/plan-ceo-review`；Superpowers brainstorming；OpenSpec "一个能力一个 change" | 项目级澄清 → 按能力拆变更 → MVP 切线 → C0 工程骨架 → GR 人工批准 | 路线图检查（依赖无环、C0 在首位、MVP 归属、规模 ≤ 12 任务）、GR 人工门、批准后冻结、状态列插件写 | 怎样按能力拆变更、MVP 切线放在哪、任务数怎么估 |
| `flow-clarify` | S1 | Superpowers brainstorming；gstack `/office-hours`、`/spec`；OpenSpec `propose` / `explore` | 先挖后问 → 结构化提问 → 六要素 → GIVEN/WHEN/THEN → G1 定稿 | 六要素闭合、场景格式与模糊词检查、未决为 0、事实引用核验、G1 人工门、轮数上限、问答记账 | 先挖什么、怎样设计选项、怎样复述、怎样把模糊词变可测 |
| `flow-context` | S2 | OpenSpec `config.yaml` 的 `context` / `rules`；gstack `/investigate` 的"先看现场" | 项目上下文包 + 变更级上下文 + 基线测试，事实带引用 | 必填段非空、命令可执行且至少跑到 1 个测试、基线已记录、引用可核验、缺测试自动记风险 | 哪些事实值得写、接口与模型写多细、禁区怎么描述 |
| `flow-design` | S3 | Superpowers brainstorming 的多方案；gstack `/plan-eng-review` | 2–3 方案对比 → 推荐与理由 → 数据流/错误处理/回滚 → 五类风险登记 | 有多个可行方案时必须写设计、方案对比段存在、风险五类齐全、高风险必须有回滚、G3 人工门、批准后冻结 | 怎样设计真方案对比、成本/风险/可逆性怎么评估、回滚写到什么程度 |
| `flow-plan` | S3 | Superpowers writing-plans；OpenSpec `tasks`；gstack `/plan-eng-review` 的执行顺序审查 | 任务卡字段与规模上限 → 追溯覆盖 → 执行计划批次 → 并行安全检查 → 执行图由插件生成 | 任务卡检查、依赖无环、追溯全覆盖、任务数与规模上限、验证命令形状、并行范围不重叠/不碰热点文件、G3 人工门、批准后冻结、计划修订人工批准 | 怎样竖切拆分、怎么估规模、怎么决定顺序/并行、为什么这样排 |
| `flow-orchestrate` | S4 | Superpowers subagent-driven-development、dispatching-parallel-agents | 按执行图派发 → 顺序/并行批次 → worktree 隔离 → 集成检查点 → 问题转达 | 派发顺序由插件强制、并行上限、worktree 隔离、任务门与审查、集成检查点阻断、子 agent 范围与原生委派关闭、熔断 | 主会话怎样调度、怎样转述问题、怎样处理合并冲突与失败重派 |
| `flow-tdd` | S4 | Superpowers test-driven-development | RED → GREEN → 重构，回执由插件产生 | RED 之前不能改实现（按风险）、GREEN 必须新鲜、运行数为 0 不算证据、测试篡改检测、验证由插件执行 | 怎样写最小失败测试、断言选在哪一层、何时重构 |
| `flow-debug` | S4 | Superpowers systematic-debugging；gstack `/investigate` | 复现 → 单假设验证 → 根因 → 回归测试 → 修复 | 连续失败 3 次熔断并转人工、修复后必须新鲜 GREEN、范围限制、篡改检测 | 怎么复现、假设怎么排序、何时二分、何时交回负责人 |
| `flow-scope` | S4（全阶段生效） | gstack `/freeze`、`/careful`、`/guard` | 任务范围 → 受保护路径 → shell 前后快照 → 危险命令转人工 → 范围变更申请 | 阶段写入策略、任务范围拒绝、未声明新文件拒绝、shell 事后检测、受保护路径、删除/重命名声明、危险命令转人工、篡改检测 | 怎样判断改动是否必要、范围变更理由怎么写、越界后怎么回退 |
| `flow-verify` | S4–S5 | Superpowers verification-before-completion | 插件执行验证 → 回执按输入哈希过期 → RED/GREEN → S5 与基线对比 → 运行证据 | 验证必须由 `flow_verify` 执行、0 测试不算证据、最新一次为准、轮次结束拦截虚假完成、G5 回归必须为 0、运行证据按风险 | 什么命令能证明什么、冒烟怎么设计、手工证据怎么采 |
| `flow-review` | S4–S5 | Superpowers requesting/receiving-code-review、subagent-driven-development 的两轮审查；gstack `/review`、`/cso` | 只读审查子 agent → 结构化结论 → critical/major/minor 处理 → 重验 → 规则沉淀 | 审查读取覆盖核对、只认结构化提交、critical 阻断、major 需处理或人工豁免、轮次按风险、审查结论插件写、规则需人工批准 | 怎样回应意见、严重级别怎么判断、哪些问题值得沉淀成规则 |
| `flow-qa` | S5 | gstack `/qa` | 声明命令启动服务 → 健康检查 → 按验收场景冒烟 → 证据采集 | 运行证据按风险必需、验收场景证据覆盖、手工证据标"agent 自述"、失败回 S4、浏览器 QA 需工具存在 | 冒烟怎么设计、启动失败怎么查、证据怎么采才可信 |
| `flow-ship` | S6 | gstack `/ship`、`/document-release`；OpenSpec archive；Superpowers finishing-a-development-branch | 交付清单 → 交付物（提交/PR/CHANGELOG）→ G6 → 归档 → 分支处理 → 推送受控 | G6 人工门、交付清单检查、推送与 PR 受控、归档由插件执行、按任务自动提交、报告/指标插件生成 | PR 描述怎么写、CHANGELOG 措辞、分支合并方式怎么选 |
| `flow-retro` | S6 之后 | gstack `/retro` | 读指标 → 找 1–3 个问题 → 规则提议 → 人工批准 → 规则生效 | 指标自动计算、缺失标"未知"、复盘日志与指标插件写、规则须人工批准、按契约只影响新变更 | 指标怎么解读、哪些经验值得规则化、小样本怎么克制 |
| `flow-analysis` | 分析任务 | dsh-task-engine 的只读分析契约；Superpowers systematic-debugging 的"先找根因" | 只读工具集 → 拆问题 → 从入口追踪 → 事实/推断分开 → 带引用提交 → 归档 → 转实施 | 只读工具限制、结论必须带可核验引用、引用哈希与待复核、调查子 agent 最多 2 个、分析不经过测试/审查/交付 | 怎么追调用链、何时可以下结论、limitations 怎么写、方案怎么比较 |

## 3. 与上游的差异：为什么改成代码强制

三个上游都是"方法论 + 提示词/工作流"形态，它们有效的前提是模型愿意遵守。FlowGate 的出发点是：**把可判定的纪律从"建议"变成"门禁"**，把不可判定的判断保留为引导。具体差异：

1. **从"建议"到"门禁"。** 上游技能要求先写设计、先写失败测试；FlowGate 让 S3 之前的源码写入直接被拒绝、TDD 任务在 RED 之前改实现被拒绝。依据：Superpowers v7.0.1 官方发布说明提到，brainstorming 改版前的一个测试场景里，agent 24 次运行有 24 次跳过设计文档直接开工，改版后仍有 3 次——靠提示词约束不住，必须由代码执行。
2. **从"会话内状态"到"跨会话状态文件"。** 上游做法依赖当前会话的上下文记忆；FlowGate 把阶段、门、任务、证据、账本全部写到 `.flowgate/`，换会话、压缩上下文、重启宿主都不影响拦截，并支持接续与接管。
3. **从"一次性的完成声明"到"可核验、会过期的证据"。** `verification-before-completion` 要求验证后再宣布完成；FlowGate 进一步规定验证由插件执行、回执按输入范围哈希过期、0 测试不算证据、轮次结束前缺证据会拦下——"完成"有了客观定义。
4. **从"人工排期"到"执行图 + 集成检查点"。** `dispatching-parallel-agents` 要求并行任务互不依赖；FlowGate 在 G3 用代码检查批次依赖、范围不重叠、不碰热点文件，并用独立 worktree + 批次结束的集成检查点兜住合并风险。
5. **从"文档习惯"到"产物格式校验"。** OpenSpec 的规格组织很好，但格式是否闭合靠人；FlowGate 沿用它的编号与增量格式（ADDED / MODIFIED / REMOVED、`R<n>.S<m>`），同时检查六要素闭合、场景覆盖、模糊词、引用可核验。
6. **从"事后复盘"到"指标 + 规则沉淀闭环"。** gstack `/retro` 是人的复盘；FlowGate 自动计算 M-1～M-18、缺失值标"未知"，并把重复出现的问题经人工批准沉淀为项目规则（`.flowgate/rules/`），下一次变更自动遵守。
7. **没有照搬的部分。** 不引入上游 CLI、不复制多角色 workflow、不把全部检查都做成阻断——低复杂度有快车道，误判有单次放行与例外机制，避免"规则正确但没人愿意用"。

## 4. 复查周期与复查清单

**周期：** 每季度一次；上游发布新版本、或 FlowGate 调整门禁/技能时，随时加做一次。

**复查步骤：**

1. 打开三个上游仓库的 Release / CHANGELOG，记录新版本号与日期。
2. 对照第 2 节表格，逐技能确认：上游条目是否改名/废弃/新增关键做法；我们的改写是否仍然成立。
3. 检查许可是否变化（尤其是 gstack 的版本基线），更新 `THIRD_PARTY_NOTICES.md`。
4. 抽查 3 个技能文本（轮换）是否仍满足：用我们自己的话、有可执行步骤、有代码强制/引导分区、正反例仍然准确。
5. 同步 `docs/03-技术方案.md` §11 的技能表与 `src/core` 的 `STAGE_LEARNING_CARDS`（学习卡文案以 `skills/*/learn.md` 为准，避免两套说法）。
6. 在下方"复查记录"追加一行；有改动时更新第 1、2 节。

**复查清单（每季度勾选）：**

- [ ] 上游版本号、日期、许可已核对并更新。
- [ ] 第 2 节 15 个技能的上游条目仍然对得上。
- [ ] `THIRD_PARTY_NOTICES.md` 与上游许可现状一致。
- [ ] 至少抽查 3 个技能文本，确认无复制原文、无过期命令/工具名。
- [ ] `STAGE_LEARNING_CARDS` 与 `skills/*/learn.md` 一致。
- [ ] 误判率 > 5% 的规则已进入复盘（与 `flow-retro` 联动）。
- [ ] 复查记录已追加。

## 5. 复查记录

| 日期 | 复查人 | 上游版本变化 | 结论 / 改动 |
|---|---|---|---|
| 2026-10-30 | 内容层 | 初版：OpenSpec v1.15.0、Superpowers v7.0.1、gstack main 快照 | 建立 15 个技能的来源映射；下一轮复查在 2027-01 |
