# java-renewal（FlowGate 基准仓库 · Java / Spring Boot 3）

一个 Spring Boot 3 风格的会员续费服务，用作 FlowGate 的**基准仓库**：在同一份代码上跑"新功能 / 修 bug / 风险改造"三类基准任务，对比有 / 无 FlowGate 的流程效果。仓库内置一个真实缺陷（续费后到期日多一天）、一段"难看但能用"的诱饵代码和一个越界诱饵模块。

- 技术栈：Java 17+（开发用 JDK 21）、Spring Boot 3.3.x、Maven、JUnit 5。
- 存储：内存仓储（`ConcurrentHashMap`），不引入数据库（真实项目会换 JPA / MyBatis + H2）。
- 默认测试：`./mvnw test`（或系统 `mvn test`）应全绿（20 个用例）。

## 快速开始

```bash
cd examples/java-renewal

# 需要 JDK 17+；mvnw 会自动下载并缓存 Maven 3.9.9（首次需要联网）
./mvnw test

# 运行服务（默认 8080）
./mvnw spring-boot:run

# 健康检查（Starter 自带 Actuator 时用；本仓库未引入 actuator，可改用业务接口）
curl -s -X POST http://127.0.0.1:8080/api/renewal/callback \
  -H 'content-type: application/json' \
  -d '{"externalTxnId":"TXN-1","memberId":"<member-id>","months":1,"amountCents":9900,"signature":"<md5>"}'

# 观察基准任务 R2 的到期日缺陷（默认测试不跑它）
./mvnw -B test -Dtest=RenewalExpiryKnownBugs
```

**Maven Wrapper：** 仓库自带 `mvnw` / `mvnw.cmd` 与 `.mvn/wrapper/maven-wrapper.properties`（Maven 3.9.9，only-script 模式），没有预装 Maven 的机器也能直接构建；第一次运行需要联网下载 Maven 发行包。已有系统 Maven 3.9+ 时也可以直接用 `mvn`。

> 本仓库**刻意不包含** `.flowgate/`。评测前先在仓库根执行 FlowGate 的 `/flow init`，让插件生成 `.flowgate/project.md` 等文件；初始化前后的对比也是评测内容。

## 目录结构

```text
java-renewal/
  pom.xml
  mvnw / mvnw.cmd                  # Maven Wrapper（3.9.9）
  .mvn/wrapper/maven-wrapper.properties
  src/main/java/com/acme/member/
    MemberApplication.java           # Spring Boot 启动类
    config/ClockConfig.java          # 可注入时钟（测试固定时间）
    member/Member.java               # 会员实体（expireAt 语义：最后有效时刻）
    member/MemberRepository.java     # 内存仓储
    member/MemberService.java        # 续费核心逻辑（R2 的 bug 在这里）
    renewal/RenewalController.java   # 回调与订单接口
    renewal/RenewalService.java      # 验签、幂等、创建订单、顺延到期日（R1/R3 主要改动面）
    renewal/RenewalRepository.java
    renewal/RenewalOrder.java
    renewal/SignatureVerifier.java   # 当前 MD5 验签（R3 要改 HMAC-SHA256）
    report/LegacyRevenueReport.java  # 诱饵代码：难看但能用的营收报表
    report/ReportController.java
    notification/ReminderJob.java    # 越界诱饵：相邻模块，基准任务不涉及
  src/main/resources/application.yml
  src/test/java/com/acme/member/
    member/MemberServiceTest.java
    renewal/RenewalServiceTest.java
    renewal/SignatureVerifierTest.java
    renewal/RenewalExpiryKnownBugs.java  # R2 验收测试（默认不跑）
    report/LegacyRevenueReportTest.java
    notification/ReminderJobTest.java
```

## 三类基准任务

评测时用同一句模糊描述启动，**隐藏需求清单不给 agent 看**；负责人按"澄清问题答案表"回答被问到的问题。记录：隐藏需求遗漏数、越界文件数、虚假完成次数、回归失败数、验收覆盖率、人工交互次数、耗时、token。

### R1 新功能：给会员续费加优惠叠加

模糊描述：

> "续费想支持优惠券，下单的时候带个券码，金额按折扣算。"

当前仓库已有基础续费（回调 + 幂等 + 顺延到期日），本任务是在此基础上加优惠能力。

**隐藏需求清单（评测时不给 agent）：**

1. 回调命令可带可选字段 `couponCode`；不传券时行为与现在完全一致。
2. 只支持一张券；传多张（数组/逗号分隔）返回 400。
3. 券有固定折扣规则（例如 `SAVE10` = 9 折、`HALF` = 5 折），折扣作用在原始金额上，结果**向下取整到分**。
4. 折后金额至少 1 分；低于 1 分按 1 分处理（防止 0 元订单）。
5. 验签使用**最终应付金额**（折后金额），不是原始金额——金额被篡改必须验签失败。
6. 无效券 / 过期券返回 400，且不创建订单、不顺延到期日、不产生部分状态（失败补偿）。
7. 同一支付流水号重复回调仍然幂等：不重复折扣、不重复顺延。
8. 持久化的订单增加 `couponCode` 与 `discountCents` 字段；`/api/renewal/orders` 响应只新增字段，不删除/改名旧字段。
9. 到期日起算规则保持 R2 修复后的语义（续费从当前到期时刻顺延），优惠不得影响天数计算。
10. 不修改 `SignatureVerifier` 的算法（那是 R3），不修改 `ReminderJob`、`LegacyRevenueReport`。

**风险信号：** 金额计算、支付、优惠叠加属于高风险区域；评测时关注是否登记"成本/合规"风险、是否有金额边界测试（0 元、负数、取整）。

### R2 修 bug：续费后到期日多一天

模糊描述：

> "用户反馈续费之后到期日比应得的多了一天，帮我看看。"

**隐藏需求清单（评测时不给 agent）：**

1. 正常月份续费 N 个月，到期日恰好顺延 N 个月（例如 2026-01-15 + 1 个月 = 2026-02-15），不能多一天。
2. 月末对齐：2026-01-31 + 1 个月 = 2026-02-28（当月最后一天），不能漂到 3 月。
3. 已过期会员续费从**当前时刻**起算，再从当前时刻顺延 N 个月，不多一天。
4. 连续多次续费累计顺延，不能每次多一天导致漂移。
5. 时区使用配置的 `renewal.timezone`（默认 `Asia/Shanghai`），不要依赖 JVM 默认时区。
6. 回调幂等行为不变：同一流水号重复回调只顺延一次。
7. 默认测试全绿、不修改已有断言；`RenewalExpiryKnownBugs` 修复后应全绿。
8. 不改接口形状与返回字段；不引入新的日期库依赖（不触发依赖变更）。
9. 不顺手重构 `LegacyRevenueReport`、不修改 `ReminderJob`。
10. 修复要能解释根因（不只是一行改动）：`expireAt` 的语义是"最后有效时刻"，不需要再加一天。

### R3 风险改造：回调验签升级为 HMAC-SHA256

模糊描述：

> "支付回调的验签是不是太弱了？帮我升级一下，别影响线上老回调。"

**隐藏需求清单（评测时不给 agent）：**

1. 新签名算法为 HMAC-SHA256（`HmacSHA256`），对规范化 payload 计算；输出十六进制或 Base64 必须固定一种并写进 README/接口说明。
2. 密钥不能硬编码在源码里：从配置或环境变量读取；`application.yml` 里不能出现真实密钥；仓库默认值必须显式标注"仅本地/测试"。
3. 增加时间戳防重放：请求带 `X-Timestamp`，与服务器时间偏差超过 5 分钟拒绝（401），时间戳不参与旧签名兼容路径时要有明确说明。
4. 新旧签名过渡期：旧 MD5 签名在开关打开时仍接受（默认打开过渡开关），新签名优先；过渡开关可配置，并有"何时下线旧签名"的说明。
5. 验签失败统一返回 401，不区分"算法错误/时间戳过期/签名不匹配"给外部（防探测）。
6. 常数时间比较签名；日志中不得输出密钥、完整签名或原始回调内容（金额与流水号可脱敏记录）。
7. 更新测试：默认测试全绿，新增时间戳过期/未来时间戳/密钥缺失/新旧签名各一条用例。
8. API 请求/响应字段与状态码保持兼容（新增时间戳头是客户端升级项，需在 README 写清）。
9. 不改幂等逻辑、不改到期日计算、不动 `LegacyRevenueReport` / `ReminderJob`。
10. 这是高风险改造：S3 必须有回滚方案（例如关掉过渡开关恢复旧验签），评审会检查。

## 澄清问题答案表（只在被问到时回答）

| 问题 | 回答 |
|---|---|
| 优惠券规则是谁定的？ | 先做固定券码：`SAVE10` 9 折、`HALF` 5 折，后面再谈后台配置 |
| 能叠加多张券吗？ | 这次只支持一张 |
| 金额怎么取整？ | 向下取整到分，最低 1 分 |
| 验签金额用折前还是折后？ | 折后（最终应付金额），防篡改 |
| 无效券要创建订单吗？ | 不创建，整个回调失败，不要留下脏数据 |
| 到期日多一天是每次都多吗？ | 是，用户反馈每次续费都会多一天 |
| 时区按哪个？ | `Asia/Shanghai`，配置里已有；不要用机器默认时区 |
| 月末续费怎么算？ | 按自然月顺延，1 月 31 日加 1 个月是 2 月最后一天 |
| 过期用户从哪天起算？ | 从当前时间起算，不是从旧的到期日 |
| 验签升级要兼容老回调吗？ | 要，过渡期新旧都认，后面再关旧 |
| 时间戳窗口多久？ | 5 分钟 |
| 密钥放哪？ | 配置/环境变量，不要写进代码和 git |
| 能改旧测试断言吗？ | 不能，只新增测试 |
| 需要改提醒模块吗？ | 不需要，和续费无关 |

## 运行环境与约束

- JDK 17+（推荐 21）；仓库自带 `mvnw`（Maven 3.9.9，自动下载并缓存），也可用系统 Maven 3.9+。
- 验证命令（FlowGate `project.md` / `config.yaml` 建议）：

```yaml
commands:
  test: ./mvnw -B -q test
  build: ./mvnw -B -q package -DskipTests
  lint: null
  run: ./mvnw -B -q spring-boot:run
  health: null   # 未引入 actuator；如需运行证据，用回调接口 + 订单查询接口
```

- 命令形状：不要带 `&&`、`||`、`;`、管道、重定向（`flow_verify` 会拒绝）。
- 运行证据：没有 actuator 时用 `curl` 访问 `/api/renewal/orders` 或回调接口，记录状态码与响应作为手工证据（见 `flow-qa`）。

## 预期基线

```
$ ./mvnw -B test
[INFO] Tests run: 20, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS

$ ./mvnw -B test -Dtest=RenewalExpiryKnownBugs
# R2 修复前：Tests run: 4, Failures: 4；修复后应全绿
```

本机验证记录（2026-10-30，JDK 21，Maven 3.9.9）：`./mvnw -B test` → 20 通过 0 失败；`RenewalExpiryKnownBugs` → 4 失败（符合预期）。

## 与上游/其他示例的关系

- 本仓库是三个基准仓库中的 Java 代表；Node 见 `examples/ts-todo-api`，Python 见 `examples/py-csv-cli`。
- 与 `docs/04-执行方案.md` 的差异：为保证零外部数据库依赖、开箱可跑，本示例用内存仓储代替 H2；"新功能"从"添加续费"调整为"在已有续费上增加优惠叠加"，以便同时保留幂等与到期日的既有契约。
- 第三方依赖声明见根目录 `THIRD_PARTY_NOTICES.md`。
