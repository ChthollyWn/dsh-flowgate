# docs/evaluation-data：评测原始数据

本目录保存 FlowGate 对照评测的**原始数据**（M6 / T6.1），由 `scripts/run-evaluation.mjs` 写入。
结果汇总表在 [`../evaluation.md`](../evaluation.md) 第 6 节，由人工在真跑后填写；脚本只负责原始数据。

> 当前状态：**尚未执行真模型评测**，目录里还没有 run 数据。首次运行方式见 `docs/evaluation.md` 第 5 节。

## 目录约定

每次运行一个子目录，名称即 `run-id`：默认 `<YYYYMMDD-HHmmss>-<repo>-<task>-<condition>`（可用 `--run-id` 指定）。

```text
docs/evaluation-data/<run-id>/
  run.json            # 机器可读运行记录：条件/提示词/轮次/人工门/环境/产物索引（不含 API Key）
  summary.md          # 人读摘要：轮次、人工门、FlowGate 指标、git 统计、验收结果、局限
  rounds/             # 每轮 headless 运行的原始输出
    round-1.stdout.jsonl   # dsh --json 的按行事件流（session/status/tool_call/text/final…）
    round-1.stderr.log     # 推理流与诊断信息
  metrics/            # .flowgate/metrics/<change>.json 原件（M-1 ~ M-18）
  reports/            # 交付报告 report.html 原件（archive/<日期>-<变更>/ 与 changes/<变更>/）
  flowgate/           # 项目级产物快照：config.yaml、project.md、roadmap.md、
                      # project-clarify.md、changes/index.md、changes/*/status.json、ledger.jsonl
  git/                # 相对基线提交的客观改动统计
    status.txt        #   git status --porcelain
    diff-stat.txt     #   git diff --stat <baseline>
    diff-numstat.txt  #   git diff --numstat <baseline>（逐文件增删行）
    untracked.txt     #   未跟踪文件清单
    log.txt           #   基线之后的提交
    diff.patch        #   完整 diff（超过 4MB 时省略并留提示文件）
  verification.json   # 回归/验收命令的退出码、解析后的 tests/failures/errors、输出尾部
```

## 约定与注意

- **不落盘敏感信息**：`DEEPSEEK_API_KEY` 只在真实运行时经环境变量传给 DSH 子进程，不写入任何文件；`run.json` 只记录"来自环境变量且未落盘"。
- **A 组（标准模式）不产生 FlowGate 产物**：`metrics/`、`reports/`、`flowgate/` 为空是预期；若 A 组工作区意外出现 `.flowgate/`，`run.json` 的 `artifacts.flowgateUnexpected` 会标记出来供数据完整性核对。
- **不替 agent 改数据**：除按标记移除 README 隐藏章节外，复制出的工作区保持示例仓库原样；收集文件都是原件复制或只读统计。
- **人工核对项**：隐藏需求遗漏数、越界文件数、虚假完成次数、验收覆盖率需要按各仓库 README 的清单人工核对；脚本提供的客观信号（测试通过/失败、diff 文件与行数、指标 JSON、报告 HTML）是核对的依据。
- **数据体积**：单轮事件流/推理日志可能较大；`ledger.jsonl` 超过 8MB 或 patch 超过 4MB 时只写摘要/跳过原件，避免把仓库撑大。确认无用的运行目录可以按 `run-id` 删除后重跑。
