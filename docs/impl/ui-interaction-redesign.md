# UI / 交互重构设计（v0.2：图形化流程 + 卡片化授权）

> Lead 定稿于 2026-11-01。本文件是并行实现（viz / interaction / host）的唯一共享契约；
> 涉及接口的任何改动先改本文件，再改代码。
>
> 两条需求（来自负责人）：
>
> 1. **vibecoding 全流程可视化**：尽量用 UI/UX 元素、少用文字，让人一眼看懂流程怎么运作、
>    当前在哪、接下来是什么；多使用动态动画。
> 2. **确认用授权卡片，不让人手输命令**：需要人确认的步骤出现可点击的授权卡片；
>    会话输入框只承担自然语言描述；澄清等问题一律用提问卡片（ask_user_question 原生 UI）。

> **v0.4 更新（2026-11-01）**：负责人决定移除学习模式（选择器/阶段学习卡/术语表/`/flow learn`/`learning` 配置与投影字段）。本文件 §1–§3 中提到的“学习模式 / 折叠学习卡”为 v0.2/v0.3 历史设计，现已下线；Pipeline 只保留实时检查项、产物 chips 与下一步 callout。

## 0. 结论：三条硬规则

1. **点击即授权**：卡片/面板按钮点击后，客户端经 `ctx.remote.commands.execute`
   （`bridge.runCommand`）直接提交等价的 `/flow ...` 行；**绝不把命令写进输入框**。
   输入框保持为空，负责人不需要回车确认任何命令。旧宿主的 composer draft / 剪贴板路径
   仅作为降级兜底保留，正常路径不再触发（`fallback=false`）。
2. **确认 = 授权卡，提问 = 提问卡**：
   - 人工门（GR/G1/G3/G6）、待处理项（SC/RK/PC/RL/TM/CF/BL）、非 agent 改动确认、启用/修复/恢复
     等"要人拍板"的动作，全部渲染在会话输入区上方的 **授权卡**（`conversation.input.dock`）里，
     点按钮完成。
   - agent 需要用户回答的问题一律走原生 `ask_user_question`（FlowGate preset 必须带
     `@deepseek-ai/dsh-tool-ask-user`），渲染成原生提问卡片；不允许在普通文本里提问。
3. **图形优先、文字兜底**：任何状态先给图形（节点、轨道、进度、脉冲、箭头、图标），
   文本只做短标签与 tooltip/aria；动画遵循 `prefers-reduced-motion`。

## 1. 视觉系统（T1 所有）

### 1.1 新增文件

| 文件 | 内容 |
|---|---|
| `src/client/styles.ts` | `installFlowgateStyles()`：浏览器端一次性注入 `<style data-flowgate-css>`；SSR（无 document）安全；含全部 keyframes / class |
| `src/client/visual/icons.tsx` | 纯 SVG 图标：`StageGlyph`（7 阶段）、`GateGlyph`（人工/自动/锁）、`ShieldIcon`、`ArrowIcon`、`CheckIcon`、`SparkIcon` |
| `src/client/visual/FlowRail.tsx` | 紧凑七阶段轨道（dock / panel 头部共用）；`props: { nodes: StageNodeModel[]; awaitingGate?: string; state: DockState; onSelectStage?: (stage: string) => void }` |
| `src/client/visual/FlowMap.tsx` | 面板内大号流程图（纵向时间线 + 门标记 + “你在这里” + 下一步 callout）；`props: { model: PanelModel; t: TFn; onSelectStage?: ... }` |
| `src/client/visual/Motion.tsx` | `PulseDot`、`AnimatedProgress` 等基元 |

### 1.2 DOM 契约（测试依赖，不要改名）

```
dock 根节点        data-flowgate="flow-dock"   data-tone=... data-state="demo|locked|off|idle|active|awaiting|pending|blocked"
七阶段轨道          data-flowgate="flow-rail"
每个节点            data-flowgate="rail-node" data-stage="S0..S6" data-status="done|current|pending|blocked" data-current="true|false"
下一步提示          data-flowgate="dock-next"  data-kind="question|action|auto|wait"
授权卡              data-flowgate="auth-card" data-kind="gate|pending|external|enable|repair|reconnect" data-gate?="G1..G6|GR"
授权卡按钮          data-action="auth-approve" | "auth-reject" | "auth-reject-submit" | "auth-raise" | "auth-confirm" | "auth-open-panel"
提问提示（非卡片）  不新增：提问卡由 DSH 原生 ui-user-questions 渲染
面板头部轨道        data-flowgate="panel-rail"
面板流程图          data-flowgate="flow-map" 节点 data-flowgate="flow-map-node" data-stage data-you-are-here="true"
下一步 callout      data-flowgate="next-step-callout"
```

> 现有 `data-flowgate="status-bar"` 的测试会重写；不要保留旧状态条文本渲染。

### 1.4 宿主原生样式与宽度（2026-11-01 负责人反馈后新增，T1 所有）

> 负责人反馈：授权卡/dock 比 composer 宽、配色花哨；要求**宽度与 DSH 原生 plan/目标 UI 框一致、风格与宿主原生一致、尽量不使用花哨颜色**。

**宽度（照抄官方 `@deepseek-ai/dsh-client-ui-user-questions` 的 PlanReviewPanel）**：

```css
/* dock frame（替换原来直接给根节点的 padding） */
.flowgate-frame {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px;
}
/* 所有内容（rail 行 + 授权卡）都在这个 wrapper 内 */
.flowgate-frame-inner {
  width: 100%;
  max-width: var(--dsh-chat-content-width, 748px);
  margin: 0 auto;
}
/* 授权卡（与原生 plan 卡一致） */
.flowgate-plan-card {
  width: 100%;
  max-width: var(--dsh-chat-content-width, 748px);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-specific-input-major);
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  border: 0;
  overflow: hidden;
}
/* strip / summary / footer 的 padding 与字号照原生 plan 卡：
   strip  background: --dsw-alias-state-warn-tertiary; color: --dsw-alias-state-warn-primary;
          padding: 12px 16px; font-size: 14px; line-height: 20px; gap: 8px;
   summary padding: 14px 16px 12px; title 15px/500/22px; desc 14px label-secondary line-height 24px 两行截断
   footer  padding: 8px 16px 12px; actions gap 8px */
```

DOM 契约新增：`data-flowgate="flow-dock-inner"`（frame 内 wrapper，E2E 用它测宽度）；`data-flowgate="flow-dock"` 仍是根节点。

**配色（原生 token，禁止写死亮色）**：

| 用途 | token（带中性回退） |
|---|---|
| 卡片底 / 输入底 | `var(--dsw-specific-input-major, #fff)` |
| 主文字 / 次文字 / 弱文字 | `--dsw-alias-label-primary` / `--dsw-alias-label-secondary` / `--dsw-alias-label-tertiary`；未激活 `--dsw-alias-label-dimmed` |
| 边框 / 分隔线 | `--dsw-alias-border-l1`~`l4` |
| hover 底 | `--dsw-alias-interactive-bg-hover` |
| 状态语义色（只允许小面积：状态点/图标/文字） | `--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-primary` / `--dsw-alias-state-error-primary`；warn 底仅用于 strip：`--dsw-alias-state-warn-tertiary` |
| 主按钮 | `background: --dsw-alias-label-primary; color: --dsw-alias-label-primary-foreground; height:28px; radius:--dsw-radius-md` |
| 次按钮 | 透明底 + `1px solid --dsw-alias-border-l2` + label-primary 文字 + hover `--dsw-alias-interactive-bg-hover` |

**明确禁止**：整卡橙色/彩色渐变洗底、大号彩色进度环、蓝/红实心大按钮、彩色 pill；绿/蓝等语义色只用于小状态点、小图标或细线。rail：done=label-secondary、current=label-primary（脉冲可用 business-primary 低透明度）、pending=label-dimmed；连接线 done=border-l3、active 虚线=business-primary 50%、pending=border-l2；change id=mono+label-tertiary。

**验收**：真实宿主中 `dock-inner` 宽度 == composer 内容宽度 == `--dsh-chat-content-width`（±1px）；授权卡无大色块；暗色主题不出现白底黑字写死。

### 1.3 动画规范

| class / keyframes | 用途 |
|---|---|
| `fg-pulse` / `@keyframes fg-pulse` | 当前阶段节点呼吸环 |
| `fg-dash` / `@keyframes fg-dash` | 未完成轨道流动虚线（进度方向） |
| `fg-sweep` / `@keyframes fg-sweep` | 授权卡顶部高光扫过（等用户处理） |
| `fg-rise` / `@keyframes fg-rise` | 卡片进入（translateY + 透明） |
| `fg-ring` | 进度环 stroke-dashoffset 过渡 |
| `fg-arrow` | “下一步”箭头轻微位移 |

- 所有动画必须包在 `@media (prefers-reduced-motion: no-preference)` 或
  `@media (prefers-reduced-motion: reduce) { .fg-* { animation: none; transition: none } }`。
- 动画只跑 transform / opacity / stroke-dashoffset，避免布局抖动。

## 2. 输入区（dock）状态机（T1 所有，T2 提供动作）

| 状态 | 条件（snapshot） | 呈现 |
|---|---|---|
| `demo` | `initialized=false` | 灰度轨道 + “启用 FlowGate”授权卡（`auth-enable` → `/flow init`） |
| `locked` | `locked=true` | 红色轨道 + 修复卡（`auth-repair` → `/flow repair`） |
| `off` | `off=true` | 红色轨道 + 恢复卡（`auth-enable` → `/flow on`） |
| `idle` | 无 changeId | 灰度轨道 + 短提示“用一句话描述你想做的变更”（无按钮） |
| `awaiting` | `awaitingGate` | 高亮轨道 + 人工门授权卡（批准 / 退回+理由 / 必要时“提高复杂度”） |
| `pending` | `pending` 有 open 项 | 高亮轨道 + 顶部待处理项授权卡（批准 / 退回+理由；`blocker` → 解除熔断）；多于 1 项显示 `+n` 并“查看全部”打开面板 |
| `blocked` | `violations>0` | 红色轨道 + 越界卡（打开面板 / 确认外部改动） |
| `active` | 其余 | 高亮轨道 + 下一步 chip（图形 + 短语，不含命令） |

规则：
- 卡片出现/消失由投影 revision 驱动（host 状态变化 → 投影 → 重渲染），客户端不乐观改状态；
  点击后先置 `busy`（按钮 loading），失败显示 notice 并恢复。
- 授权卡内容尽量图形化：门徽标 + 目标/范围/验证 三个 chip + 检查项圆点；长文本折叠，
  “详情”打开面板。低复杂度 G3 合并确认卡（`panel.gate.mergedConfirm`）显示
  确认并推进 / 退回补充 / 提高复杂度 三个按钮。
- 退回必须填理由（内联 textarea，提交后 `reject` / `reject-pending`）。
- dock 高度默认一行（≈44px），授权卡可展开到两行；不要超过输入区上方的视觉重量。

## 3. 面板（T1 + T2 所有）

- `Panel.tsx` 头部：保留标题/变更号，新增 `panel-rail`（紧凑轨道，所有 tab 都能看到当前阶段）。
  `Pipeline` 作为默认 tab。
- `Pipeline.tsx` 改造为**图形流程页**：
  1. 顶部 hero：当前阶段大图标 + 进度环（x/7）+ 阶段名 + “你在这里”；
  2. `FlowMap`：纵向 7 节点时间线，节点间是门（人工=盾牌/锁，自动=闪电/齿轮），
     已走过部分实线着色 + 流动虚线，当前节点脉冲，未来节点降低对比；
     每个节点带“产物 chips”和“门状态”；点击节点切换下方详情；
  3. 详情：Live 检查项以圆点/进度条呈现（少文字）；学习卡 `StageCard` 默认折叠
     （学习模式 off/brief 时不显示长文），保留原有 `data-flowgate="view-pipeline"` 与
     `stage-node` 语义以便测试迁移；
  4. “下一步” callout：箭头 + 图标 + 一句短语（自然语言，不出现 `/flow` 命令）。
- `Gates.tsx`：门徽标 + 检查项进度环 + 授权按钮组；删除 `/flow approve` 类 Mono 文本；
  按钮一律 `onAction` → `performAction` → `runCommand`。
- 其他视图（Ledger/Tasks/Risk/Intercepts/Metrics）：
  - 所有原本提示命令的文案改为卡片/按钮导向（“用卡片处理”/“打开授权卡”），
    不再出现用户需要手输的 `/flow ...`（供高级用户的命令仍保留在 `/flow help`）。
  - 现有 `onAction` 按钮无需改签名，只改 `performAction` 的 ports（Panel 容器传入 `executeCommand`）。

## 4. 动作层（Lead 已完成，T2 补测试与接线）

- `bridge.runCommand(command, sessionId)`：inject `['remote','remote.commands']` →
  `commands.execute(sessionId, line, [])`；返回 `ok===true`。**这是授权卡的唯一执行通道。**
- `performAction(action, ports)` 新顺序：
  1. `remote.flowgate.action`（若主机提供）；
  2. `ports.executeCommand(command)`（点击即执行；`ActionOutcome.fallback=false`）；
  3. 旧降级：`fillCommand`（composer draft）→ `copyText`；
  4. 失败：`actions.executeFailed`。
- Panel 容器（`Panel.tsx`）与 dock 容器都把 `executeCommand: (cmd) => bridge.runCommand(cmd, sessionId)`
  传给 `performAction`；`fillCommand` 仅保留降级。
- 命令与动作映射不变（见 `commandFor`）：approve→`/flow approve <gate>`、
  reject→`/flow reject <reason>`、approve-pending→`/flow <family> approve <id>`、
  reject-pending→`/flow <family> reject <id> <reason>`、unblock→`/flow unblock <id>`、
  allow-once→`/flow allow-once <rule> <reason>`、confirm-external→`/flow external confirm [path|all]`、
  enable→`/flow init`、repair→`/flow repair`、resume/pause/report/board/metrics-export 同前。

## 5. Host / 提示词（T3 所有）

1. `cordis.patch.yml` 的 `preset-flowgate` 增加 `@deepseek-ai/dsh-tool-ask-user`
   （`test/host/preset-composition.test.ts` 同步断言）；执行者/审查者不加。
2. `src/host/context/index.ts` 在注入文本后追加固定交互契约（仅初始化时）：
   > 交互契约：需要负责人拍板的步骤由客户端授权卡片完成，不要要求负责人输入 `/flow` 命令；
   > 需要澄清/选择时必须调用 `ask_user_question`（带 options），不要在普通文本里提问。
3. `src/core/engine.ts` 的用户可见 nextStep / pushNotice 文案：人工门与待处理项统一改为
   “等待负责人在授权卡片上确认/处理”（不再出现 `/flow approve` 等提示）；`/flow` 命令保留。
4. 同步受影响单测（`test/host/context.test.ts`、preset 组成、engine 相关断言）。
5. 文档：README / docs/impl 中“面板按钮 → 填命令”的旧描述后续由 Lead 统一更新。

## 6. i18n

- locale JSON 归 T1 所有；其他成员**不直接改** `src/client/locale/*.json`。
- 现有已改：`actions.executed`、`actions.executeFailed`、`status.*`、`panel.*`、`ledger.empty`。
- T1 需新增的 key 命名建议（可增补，zh/en 同步，`test/client/i18n.test.ts` 必须过）：
  `dock.*`（state/next/auth/**）、`viz.*`（progress/youAreHere/humanGate/autoGate/completed/next/...）、
  `pipeline.hero*`、`pipeline.nextStep*`、`panel.authCard*`。
- 用户可见文案不得再出现需要手输的 `/flow ...`（`/flow help` 内的帮助文本除外）。

## 7. 验收（Lead 与 verifier 共同）— 2026-11-01 已完成

- [x] `pnpm lint` / `npx vitest run`（116 files / 1638 tests）/ `pnpm coverage`（86.39/76.25/86.93/89.47）/ `pnpm build` / `pnpm verify:package` / `pnpm verify:client` 全绿；client 316.7KB、18 插槽。
- [x] 真实 Web 宿主（隔离 DSH_HOME、零模型请求）E2E **35/35 断言**：dock 七阶段轨道（当前脉冲/门标记）+ 下一步 chip；awaiting 出现授权卡；点「确认并推进」→ 真实 `POST /api/commands/execute` → G3 passed / S4 / 写盘一致；授权卡消失；**composer 全程为空**；0 pageerror / console.error（D2 复验无回归）。
- [x] 面板图形时间线：`panel-rail`、`flow-map` 7 节点、唯一 `data-you-are-here="true"`、`next-step-callout`、hero 进度环 4/7；8 tab 无用户可见「请运行 /flow …」；活跃态 next chip 已为人话（D2 14/14 断言）。
- [x] 真实宿主 `preset-flowgate` 含 `@deepseek-ai/dsh-tool-ask-user`（dump-config 断言）；web 组合含 `dsh-client-ui-user-questions`（提问卡由原生 UI 渲染，非自绘）。**未覆盖**：原生提问卡需要模型真跑一轮，零模型 E2E 只验证组合面。
- [x] `prefers-reduced-motion: reduce` 下 0 动画（真实宿主断言 + visual.test.tsx 扫描 keyframes）。
- [x] 截图：[30-flow-dock-active](../screenshots/30-flow-dock-active.png) / [31-flow-auth-card](../screenshots/31-flow-auth-card.png) / [32-flow-approved](../screenshots/32-flow-approved.png) / [33-panel-flow-map](../screenshots/33-panel-flow-map.png)，说明见 [screenshots README](../screenshots/README.md) 2026-11-01 分节。
- [x] **原生风格与宽度（2026-11-01 负责人反馈后）**：照抄官方 PlanReviewPanel 的 frame/card/strip 规则；真实宿主实测 `--dsh-chat-content-width=844.8px`，`[data-flowgate="flow-dock-inner"]`=授权卡=844.8px（±0px，与原生 plan 卡 max-width 一致），dock 外框=composer hero 外框=908.8px（±0px，active/awaiting 两态）；无大色块/彩虹轨道，语义色仅小状态点/小图标；暗色正常。注意：composer 白卡内容宽 = var + 2×clearance（宿主 token 设计），比原生 plan 卡宽 32px，属预期差异（截图 README 已披露）。

## 8. 写入范围（协作纪律）

| 成员 | 写范围（workspace 相对） |
|---|---|
| T1 viz | `src/client/visual/**`、`src/client/styles.ts`、`src/client/dock/**`、`src/client/panel/Panel.tsx`、`src/client/panel/views/Pipeline.tsx`、`src/client/panel/ExecutionGraph.tsx`、`src/client/theme.ts`、`src/client/model.ts`、`src/client/index.tsx`、`src/client/locale/**`、`test/client/status-bar.test.tsx`、`test/client/model.test.ts`、`test/client/panel.test.tsx`、`test/client/visual.test.tsx`、`test/client/mock.ts` |
| T2 interaction | `src/client/actions.ts`、`src/client/bridge.ts`、`src/client/types.ts`、`src/client/panel/views/Gates.tsx`、`src/client/panel/views/Ledger.tsx`、`src/client/panel/views/Tasks.tsx`、`src/client/panel/views/Risk.tsx`、`src/client/panel/views/Intercepts.tsx`、`src/client/panel/views/Metrics.tsx`、`test/client/actions.test.ts`、`test/client/bridge.test.ts`、`test/client/gates-auth.test.tsx`、`test/client/views-copy.test.tsx` |
| T3 host | `cordis.patch.yml`、`src/host/context/index.ts`、`src/core/engine.ts`、`test/host/preset-composition.test.ts`、`test/host/context.test.ts`（+ 相关断言） |
| T4 verifier | `/tmp` 环境、`docs/screenshots/**`（只加新图与 README 索引） |
| Lead | 本文件、`docs/impl/host-client-contract.md`、README/CHANGELOG、最终集成 |
