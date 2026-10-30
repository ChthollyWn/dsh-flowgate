# 学习卡：S4–S5 代码审查

> 学习卡字段与 `LearningCard` 一一对应：做什么 / 为什么 / 合格标准 / 对应上游做法 / 常见反模式 / 正例 / 反例。

## 做什么（what）

任务通过验证后，由干净上下文、只读的审查子 agent 审查任务卡、覆盖场景和该任务的 diff，输出结构化结论（verdict + findings，按 critical/major/minor 分级）。critical 阻断任务门必须修；major 修复或由负责人书面豁免；minor 记录。修复后重新验证、必要时重审；S5 做终审，高风险额外做安全审查；重复出现的问题提议为项目规则。

## 为什么（why）

写代码的 agent 很难客观审查自己：它会漏掉自己忽略的需求，会把不符合规格的实现说成"等价方案"。独立只读审查用不同的上下文做第二双眼睛；把审查结果结构化、并核对读取覆盖，可以防止"没看全就下结论"。critical 阻断和 major 必须处理，保证了审查不是走过场。

## 合格标准（criteria）

- 被审对象干净：新鲜 GREEN、diff 可读、无调试残留。
- 审查读取覆盖完整，结论来自结构化输出。
- critical 全修，major 全修或有书面豁免，minor 已记录。
- 修复后重新验证，证据新鲜。
- S5 终审无未处理 critical/major；高风险完成安全审查。
- 重复问题提议为规则，未批准前不生效。

## 对应上游做法（upstream）

- Superpowers 的 requesting-code-review / receiving-code-review：请求独立审查、结构化回应意见。
- Superpowers 的 subagent-driven-development 两轮审查：先查规格符合，再查代码质量。
- gstack 的 `/review`、`/cso`：代码审查与安全审查分开。

FlowGate 的改写：把"审查读取覆盖、结构化提交、critical 阻断、major 需处理、按风险定审查轮次"变成代码判定；把"怎样回应意见、怎样判断严重级别"留作引导。

## 常见反模式（antiPatterns）

- 不修 critical 就宣称完成。
- 把 major 当 minor 忽略，或自行"豁免"。
- 修复后不重新验证。
- 要求审查子 agent 通融或放宽标准。
- 自己写 `review.md`。
- 只回应"已修复"不给证据。
- 把一次性误判沉淀成规则。

## 正例（good）

审查给出 critical（缺重复回调测试）、major（幂等查询无索引）、minor（命名）。agent 补测试、加唯一索引迁移、改名，逐条回应文件行号与验证结果；重跑验证后二次审查通过；把"回调类需求必须覆盖重复调用"提议为规则。任务门与 S5 均一次通过。

## 反例（bad）

审查给出 1 critical + 2 major，agent 回复"都是风格问题"不修；任务门被 critical 阻断；它新建 `review.md` 写"复检通过"（受保护文件，写入被拒）；又改弱测试断言重新提交，被篡改检测标记；最终卡在 S5，需要负责人介入。
