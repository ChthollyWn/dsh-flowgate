# 评测运行 20261031-042601-java-renewal-risk-A

- 时间：2026-10-30T20:26:01.802Z → 2026-10-30T20:29:24.813Z（3m23s）
- 仓库：java-renewal（Java 17+ / Spring Boot 3.3 / Maven）
- 任务：risk「R3 回调验签升级 HMAC-SHA256」
- 条件：DSH 标准模式（A）
- 状态：完成

## 提示词（发给 agent 的原话）

> 支付回调的验签是不是太弱了？帮我升级一下，别影响线上老回调。

## 执行轮次

| 轮次 | 耗时 | 退出码 | 超时 | session | 事件统计 |
|---|---|---|---|---|---|
| 1 | 3m20s | 0 | 否 | session-2adfc1d5-e626-4a5d-a574-09db1c0e4cbc | {"session":1,"status":46,"thinking":22,"tool_call":32,"tool_result":32,"text":1,"final":1} |

## 最后一轮 agent 最终答复（截断，供人工判断"虚假完成"）

```text
已完成验签升级，并保留了对线上老回调的兼容。

## 改动内容

- **新签名升级为 HMAC-SHA256**
  - 格式：`v2:<timestamp>:<hmac>`
  - 签名内容：`externalTxnId:amountCents:timestamp`
  - 默认时间窗 300 秒，超出后拒绝，降低重放风险
  - 使用常量时间比较，避免时序侧信道

- **老回调继续可用**
  - 过渡期内仍接受旧版 `MD5(txnId:amount:secret)`
  - 默认开启，可通过 `renewal.callback.legacy-enabled=false` 关闭
  - 老密钥支持逗号分隔多把，便于滚动轮换；当前新密钥也会作为老签名候选
  - 原有 `sign(txnId, amount)` / `verify(txnId, amount, signature)` 方法签名保持不变

- **密钥外置**
  - `renewal.callback.secret` → 环境变量 `RENEWAL_CALLBACK_SECRET`
  - `renewal.callback.legacy-secret` → `RENEWAL_CALLBACK_LEGACY_SECRET`
  - `renewal.callback.timestamp-tolerance-seconds` → `RENEWAL_CALLBACK_TIMESTAMP_TOLERANCE_SECONDS`

- **接口兼容**
  - 回调请求新增可选 `timestamp` 字段，老报文不传也没问题
  - 保留原五参数 `CallbackRequest` / `CallbackCommand` 构造器，现有调用方和测试不受影响
  - 幂等、会员校验、续费逻辑未改动

- **新增测试**
  - `SignatureVerifierUpgradeTest` 覆盖新签名、过期时间戳、老 MD5 兼容和过渡开关

## 验证情况

当前执行环境无法启动 shell 沙箱，报错为 `sandbox-exec: sandbox_apply: Operation not permitted`，因此没能实际运行测试。请在可执行 Maven 的环境运行：

```bash
./mvnw -B test
```

生产上线时建议先保留 `legacy-enabled=true` 观察老流量，确认支付平台全部切换后再关闭旧 MD5 验签。
```

## 人工门动作（脚本扮演负责人）

A 组不涉及 FlowGate 人工门。

## FlowGate 指标（B 组）

A 组不启用 FlowGate，没有指标（预期）。

## 交付与变更统计

- 交付报告：无
- git（相对基线 1f75d03089）：4 个文件，+340/-23，未跟踪 1 个，提交 0 次
- 改动文件：src/main/java/com/acme/member/renewal/RenewalController.java、src/main/java/com/acme/member/renewal/RenewalService.java、src/main/java/com/acme/member/renewal/SignatureVerifier.java、src/main/resources/application.yml

## 验收 / 回归结果

| 类型 | 命令 | 期望 | 结果 | 解析计数 | 耗时 |
|---|---|---|---|---|---|
| regression | `./mvnw -B test` | green | green（exit 0） | tests=25 fail=0 err=0 | 2.5s |

## 产物清单

- 运行记录：`docs/evaluation-data/20261031-042601-java-renewal-risk-A/run.json`
- 单轮事件流：`docs/evaluation-data/20261031-042601-java-renewal-risk-A/rounds/`
- 指标 JSON：0 个（`docs/evaluation-data/20261031-042601-java-renewal-risk-A/metrics/`）
- 报告：0 个（`docs/evaluation-data/20261031-042601-java-renewal-risk-A/reports/`）
- FlowGate 快照：0 个（`docs/evaluation-data/20261031-042601-java-renewal-risk-A/flowgate/`）
- git 统计：`docs/evaluation-data/20261031-042601-java-renewal-risk-A/git/`

## 说明与局限

- 隐藏需求遗漏数、越界文件数、虚假完成次数、验收覆盖率按各仓库 README 的清单人工核对；脚本只收集客观信号（测试、diff、指标、报告）。
- headless 的「被问到才答」澄清无法自动完成：agent 若调用结构化提问而宿主组合不支持，会退化为写假设；这类交互质量需人工复盘事件流。
- 脚本扮演负责人自动批准人工门，因此 M-13（人工负担）记录的是「门禁次数」，不是真实人类响应时间。
- B 组默认 `dispatch=inline`、`review.enabled=false`（精简 headless 没有 subagent provider）；要测派发/审查需要换成带 provider 的组合。
- 需要长驻服务（如 Spring Boot）的项目可用 `--no-run` 把 B 组 `commands.run` 覆盖为 `none`，避免 `spring-boot:start` 之类命令在 headless 里挂起；A 组不受影响。
