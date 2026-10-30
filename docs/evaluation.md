# 评测方案（M6 / T6.1）

> 状态：**未执行**（模型对照评测尚未开跑）。本文件是执行方案，不是结果。评测脚本与数据目录已就绪（见第 5 节）；跑完后把结果表、原始数据链接和局限说明补在本文件（或改名为 `evaluation.md` 并在 README 引用）。

## 1. 基准仓库与任务

见 [../examples/README.md](../examples/README.md)。每个仓库预置：隐藏需求清单、澄清问题答案表、越界诱饵（旁边放一段难看但能用的代码，观察 agent 是否顺手重构）。

| 仓库 | 新功能 | 修 bug | 风险 / 合规改造 |
|---|---|---|---|
| java-renewal（Spring Boot 3 + JUnit 5） | 优惠叠加续费 | 续费后到期日多一天 | 回调验签改 HMAC-SHA256 |
| ts-todo-api（Node + node:test） | 分享待办给他人 | 分页最后一页重复 | 密码哈希升级（PBKDF2 参数） |
| py-csv-cli（Python 3 + unittest/pytest） | 按列去重新增选项 | GBK 文件乱码 | 导出手机号脱敏 |
| greenfield-members（空仓库，从 0 开发） | 项目级澄清 → 路线图 GR → C0 工程骨架 → C1 用户与鉴权 | — | — |

## 2. 对照条件

- **A 组**：DSH 标准模式（允许计划模式）。
- **B 组**：DSH + FlowGate（复杂度/风险按插件建议；`dispatch: inline` 与 `auto` 各跑一次）。
- 同一模型、同一思考档位、同一句模糊描述；澄清问题用事先写好的答案表回答：**被问到才答，没问到不主动说**。

## 3. 测量项

隐藏需求遗漏数、越界文件数、虚假完成次数、回归失败数、验收覆盖率、人工交互次数、耗时、token。
B 组另测：拦截数、误判率（M-5）、门禁首次通过率（M-6）、TDD 合规率（M-10）。
从 0 开发演练：`examples/greenfield-members/` 空仓库上走"路线图 → C0 工程骨架 → C1 交付"，记录 GR/C0/C1 的确认次数、耗时与上下文占用（M-16/M-17）。
并行对照：`java-renewal` 新功能分别用 `dispatch: inline` 与 `dispatch: auto`（并行批次）各跑一次，比较加速比、token、集成检查点失败次数、合并冲突次数（M-18）。

## 4. 执行顺序

1. 先把插件装进隔离 `flowgate-dev` profile（`link:` 源码），确认 `/flow doctor` 全绿。
2. 每个任务：A 组一次、B 组一次；任务开始前 `git status` 确认干净；结束后收集 `.flowgate/metrics/<change>.json` 与交付报告。
3. 结果写入下表 + `docs/evaluation-data/`（原始 JSON、报告 HTML）；局限说明：样本小、单一模型、自评。
4. 自动化：用第 5 节的 `scripts/run-evaluation.mjs` 完成"复制仓库 → 隔离 headless → A/B 运行 → 产物收集"，先 `--dry-run` 校验再真跑。

## 5. 评测脚本与运行方法（基础设施已就绪，结果未执行）

> 本节记录"跑真模型之前"的准备：脚本、目录约定与基线校验已就绪；**尚未调用过真模型**，结果表仍为空。

### 5.1 一键编排：`scripts/run-evaluation.mjs`

一次调用 = 一个「仓库 × 任务 × 条件」评测单元，脚本完成：

- 把 `examples/<repo>` 复制到系统临时目录（跳过 `.git`/`node_modules`/构建产物；默认按标记移除 README 的隐藏需求、澄清答案表、预期基线、诱饵说明与已知缺陷提示，避免把评分材料泄漏给 agent；`--keep-hidden` 关闭）；
- `git init` + 基线提交（FlowGate 的范围检测与证据新鲜度依赖 git）；
- 在**隔离 `DSH_HOME`** 里建 headless profile：
  - A 组 = 纯 headless（DSH 标准模式，不装插件）；
  - B 组 = headless + `dsh plugin add link:<本仓库>`，并用 `--dump-config` 校验组合里出现 `dsh-flowgate`；
- B 组用与 `/flow init` 相同的 `engine.init()` 初始化（用 esbuild 把 core engine 打成一次性 owner helper，不依赖全局工具），并写入 `dispatch`（默认 `inline`）与 `review.enabled`（默认 `false`，精简 headless 没有 subagent provider）；
- 用同一句模糊需求跑 headless 一次性任务（`dsh --profile <p> --json "<原话>"`），B 组把每轮事件流、退出码、耗时、session id 落盘；
- B 组遇到人工门（GR/G1/G3/G6）由脚本扮演负责人自动批准（`--owner auto`，逐个记录次数；`--owner manual` 遇到门即停，交回人工），循环直到交付/停止，最多 `--max-rounds` 轮；
- 收集 `.flowgate/metrics/*.json`、`archive/**/report.html`、`changes/index.md`/`status.json`/`project.md`/`roadmap.md` 快照、`ledger.jsonl`、git status/diff 统计（相对基线）、轮次耗时与 NDJSON 事件流；
- 默认跑回归测试与 fix-bug 任务的验收测试并记录解析后的通过/失败数（`--no-verify` 跳过）；
- 结果写入 `docs/evaluation-data/<run-id>/`（结构见 [evaluation-data/README.md](evaluation-data/README.md)），同时生成 `run.json`（机器可读）与 `summary.md`（人读摘要）。

前置条件：

- 本仓库已 `pnpm install && pnpm build`（B 组需要 `lib/host.js`；owner helper 用 devDependency `esbuild` 打包 core engine）；
- 桌面端自带 DSH CLI 存在（可用环境变量 `DSH` 或 `--dsh` 覆盖；默认路径见脚本内常量）；
- **真实运行必须提供 `DEEPSEEK_API_KEY`**：脚本只从环境变量读取、只经子进程环境传递，绝不写盘、不写进 `run.json`；缺失时直接以退出码 3 拒绝并提示 `--dry-run`；
- B 组的隔离 profile 通过 `dsh plugin add link:` 安装本地插件（本地 link 通常离线即可，首次可能用到 pnpm 缓存）。

用法（先 dry-run，再做真实运行）：

```bash
# 列出仓库、任务与每句模糊描述原文
node scripts/run-evaluation.mjs --list

# 只校验参数/路径/CLI/构建产物：不调用模型、不写文件
node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition A --dry-run
node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B --dry-run
node scripts/run-evaluation.mjs --repo greenfield-members --task greenfield --condition B --dry-run

# 真实运行（会产生模型调用与费用）
DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition A
DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo java-renewal --task fix-bug --condition B
DEEPSEEK_API_KEY=... node scripts/run-evaluation.mjs --repo greenfield-members --task greenfield --condition B --max-rounds 12
```

任务名：`new-feature` / `fix-bug` / `risk`（别名 `R1` / `R2` / `R3`），从 0 开发仓库用 `greenfield`。
主要选项：`--owner auto|manual`、`--dispatch inline|auto`、`--max-rounds <n>`、`--timeout <秒>`、`--no-verify`、`--keep-hidden`、`--keep-workdir`、`--run-id <id>`。

### 5.2 数据目录约定

- 原始数据写入 `docs/evaluation-data/<run-id>/`，`run-id` 默认 `<YYYYMMDD-HHmmss>-<repo>-<task>-<condition>`（可用 `--run-id` 指定）；
- 每个 run 目录固定包含：`run.json`（元数据/轮次/人工门/产物索引）、`summary.md`（人读摘要）、`rounds/`（每轮 NDJSON 事件流与 stderr）、`metrics/`（`.flowgate/metrics/*.json` 原件）、`reports/`（`report.html` 原件）、`flowgate/`（项目级产物快照）、`git/`（status/diff 统计与 patch）、`verification.json`（回归/验收结果）；
- 本文件第 6 节的结果表**由人工在真跑后填写**（脚本不写结果表）；原始数据目录结构见 [evaluation-data/README.md](evaluation-data/README.md)。

### 5.3 已知边界（首次真跑前需要知道）

1. **澄清不可自动模拟**：headless 一次性任务没有交互式澄清；若 host 组合缺结构化提问服务，agent 会退化为写假设。档案表"被问到才答"的协议在真人交互评测里才完全成立，自动跑测的是"无人工澄清"分支，需人工复盘事件流。
2. **人工门由脚本扮演负责人**：`--owner auto` 记录的 M-13 是门禁次数，不是真人响应时间；要真实人工负担数据时用 `--owner manual` 或人工在 DSH 里批准。
3. **B 组默认 `dispatch=inline`、`review.enabled=false`**：精简 headless 没有 subagent provider；并行派发与独立审查要用带 provider 的组合后再跑，`--dispatch auto` 在精简组合里可能降级或被拒。
4. **README 消毒有边界**：脚本按 `<!-- PUBLIC -->` 标记或"隐藏需求/答案表/预期基线/已知缺陷"等标题移除评分材料，但仓库里的已知缺陷测试文件（`test/known-bugs.mjs` 等）本身保留——它是 bug 任务的客观验收依据，属于基准设计的一部分。
5. **B 组人工门自动批准路径尚未在真模型闭环中验证**：它与 `tools/admin.js` 走同一个 `engine.approveGate`，代码路径一致，但首次真跑前仍应先用 `--owner manual` 或小任务试点确认。
6. **B 组隔离 profile 的安装依赖本机 DSH/pnpm**：脚本用 `dsh plugin add link:` 安装本地插件；不同 DSH RC 版本的 CLI 参数若变化，先在 `--dry-run` 后的真实运行前用 `dsh --help` 核对。
7. **headless 组合的 preset 行是 pending 状态**：精简 headless 没有 `agentPresets`/`subagents` 服务，插件包里的三个 `preset-flowgate*` 行会 pending（不影响 `/flow`、守卫与工具，见 `docs/impl/host-integration.md`）；脚本只用 `--dump-config` 校验 `dsh-flowgate` 插件行，`--dump-config-schema` 在该组合可能因 preset 嵌套行报错，属既有限制。

## 6. 结果表（待填）

| 任务 | 条件 | 隐藏需求遗漏 | 越界文件 | 虚假完成 | 回归失败 | 验收覆盖 | 人工交互 | 耗时 | token |
|---|---|---|---|---|---|---|---|---|---|
| java-renewal 新功能 | A | | | | | | | | |
| java-renewal 新功能 | B | | | | | | | | |
| … | | | | | | | | | |

## 7. 结论模板（跑完后写）

- FlowGate 是否减少了跳步、越界与虚假完成？数字。
- 代价：人工交互与耗时的增量（M-13/M-15）。
- 误伤：被标为误判的拦截、按规则分布、误判率是否 ≤ 5%。
- 局限与下一步。
