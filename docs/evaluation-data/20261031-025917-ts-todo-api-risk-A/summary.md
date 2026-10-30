# 评测运行 20261031-025917-ts-todo-api-risk-A

- 时间：2026-10-30T18:59:17.450Z → 2026-10-30T18:59:52.144Z（34.7s）
- 仓库：ts-todo-api（Node.js ≥ 22 / node:http / node:test）
- 任务：risk「R3 密码哈希参数升级」
- 条件：DSH 标准模式（A）
- 状态：完成

## 提示词（发给 agent 的原话）

> 登录的密码哈希参数是不是太低了？帮我升级一下。

## 执行轮次

| 轮次 | 耗时 | 退出码 | 超时 | session | 事件统计 |
|---|---|---|---|---|---|
| 1 | 33.2s | 0 | 否 | session-35b06a83-68c4-420d-ac05-112aec2c5147 | {"session":1,"status":16,"thinking":7,"text":3,"tool_call":16,"tool_result":16,"final":1} |

## 最后一轮 agent 最终答复（截断，供人工判断"虚假完成"）

```text
已按“兼容旧哈希 + 登录后自动迁移”的方式完成升级。

## 改动内容

**`src/auth/passwords.js`**
- `DEFAULT_ITERATIONS`：`100_000` → `600_000`（PBKDF2-SHA256，符合 OWASP 当前建议）
- 新注册/迁移生成的哈希会写入 `pbkdf2$sha256$600000$...`
- `verifyPassword` 仍按哈希中保存的迭代次数校验，所以旧的 100000 次哈希可以继续登录
- 加固 `needsRehash`：
  - 非 `pbkdf2`、非 `sha256`、格式错误、非法迭代次数都会触发重新哈希
  - 迭代次数低于当前默认值（600000）时触发迁移，不会把更高参数的哈希降级

**`test/auth.test.js`**
- 哈希格式断言更新为 600000
- 新增旧 100000 次迭代哈希“仍可校验且需要迁移”的回归用例

登录接口原本已有迁移逻辑（`src/server.js` 中登录成功且 `needsRehash` 为真时重新哈希），因此旧用户首次成功登录后会自动升级到 600000，无需额外迁移脚本。

## 验证说明

尝试运行测试时，当前主机的沙箱后端不可用：

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

而升级到 `danger-full-access` 又没有可用的审批通道，因此本环境无法实际执行 `pnpm test`。代码已完成静态检查；在正常环境请运行：

```bash
pnpm test
```
```

## 人工门动作（脚本扮演负责人）

A 组不涉及 FlowGate 人工门。

## FlowGate 指标（B 组）

A 组不启用 FlowGate，没有指标（预期）。

## 交付与变更统计

- 交付报告：无
- git（相对基线 02392f4b61）：2 个文件，+15/-5，未跟踪 0 个，提交 0 次
- 改动文件：src/auth/passwords.js、test/auth.test.js

## 验收 / 回归结果

| 类型 | 命令 | 期望 | 结果 | 解析计数 | 耗时 |
|---|---|---|---|---|---|
| regression | `pnpm test` | green | green（exit 0） | tests=35 fail=0 err=0 | 0.9s |

## 产物清单

- 运行记录：`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/run.json`
- 单轮事件流：`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/rounds/`
- 指标 JSON：0 个（`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/metrics/`）
- 报告：0 个（`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/reports/`）
- FlowGate 快照：0 个（`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/flowgate/`）
- git 统计：`docs/evaluation-data/20261031-025917-ts-todo-api-risk-A/git/`

## 说明与局限

- 隐藏需求遗漏数、越界文件数、虚假完成次数、验收覆盖率按各仓库 README 的清单人工核对；脚本只收集客观信号（测试、diff、指标、报告）。
- headless 的「被问到才答」澄清无法自动完成：agent 若调用结构化提问而宿主组合不支持，会退化为写假设；这类交互质量需人工复盘事件流。
- 脚本扮演负责人自动批准人工门，因此 M-13（人工负担）记录的是「门禁次数」，不是真实人类响应时间。
- B 组默认 `dispatch=inline`、`review.enabled=false`（精简 headless 没有 subagent provider）；要测派发/审查需要换成带 provider 的组合。
