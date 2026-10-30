# FlowGate spike（最小可加载 DSH 插件，仅验证 API 形状）

> 目标：证明 **host 入口可被 DSH 加载**、`/flow` 命令 / `flow_status` 工具 / guard / systemPrompt.section 注册路径正确、
> **client 入口可构建成合法 loader bundle**、插槽（输入框 dock + 右侧栏 tab）注册签名正确。
> 本目录不是产品源码；`spike/src/*` 只是骨架，`docs/impl/dsh-plugin-api-cheatsheet.md` 是结论所在。

## 目录

```
spike/
├── package.json              # dsh 清单：manifestVersion / bundle.patch / client.platform+inject / engines.dsh
├── cordis.patch.yml          # 插入插件行 + 一个 @deepseek-ai/dsh-agent-preset preset 行
├── tsconfig.json
├── tsdown.config.ts          # 双入口：ESM host + CJS client（0.23 实测）
├── scripts/stamp-client.mjs  # 把 CJS 产物包成 window.__ModuleLoader__.load({id, factory})
├── src/index.ts              # host 入口（apply + inject + name）
├── src/client.tsx            # client 入口（apply + inject + name）
├── lib/                      # 构建产物（index.js + client.js）
├── verify-host.mjs           # 进程内 cordis 加载验证
└── verify-client.mjs         # 离线 mock 模块表验证 client bundle
```

## 构建

```bash
cd spike
npm install          # @deepseek-ai/cordis@4.0.5 + @deepseek-ai/dsh-tools@0.2.1-rc.5 + tsdown@0.23.4
npm run build        # tsdown && node scripts/stamp-client.mjs
```

产物形态：

- `lib/index.js`：ESM，尾部 `export { apply, inject, name };`
- `lib/client.js`：`window.__ModuleLoader__.load({ id: "dsh-flowgate-spike", factory: (require) => { ... } })`，只 require `react`

## 验证

```bash
node verify-host.mjs      # 期望输出 OK: ... /flow 命令 + flow_status 工具 + guard + systemPrompt.section 均注册成功
node verify-client.mjs    # 期望输出 OK: client bundle 形态合法，dock 与右侧栏 tab 注册路径正确
```

真实 DSH CLI（隔离 `DSH_HOME`，不碰日常 profile）：

```bash
mkdir -p /tmp/fg-home/profiles/spike
cat > /tmp/fg-home/profiles/spike/package.json <<'J'
{ "name":"dsh-profile-spike", "private":true, "dsh": { "profile": { "bundles": [] } } }
J
cat > /tmp/fg-home/profiles/spike/cordis.patch.yml <<'Y'
- insert:
    - id: flowgate-spike
      name: /path/to/dsh-flowgate/spike/lib/index.js
Y

export DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME=/tmp/fg-home "$DSH" --profile spike --dump-config          # 组合结果里应有 flowgate-spike（file:// 形式）
DSH_HOME=/tmp/fg-home "$DSH" --profile spike --dump-config-schema   # 会 import 插件模块，退出码 0 + JSON 含 flowgate = 可导入
```

## 已知限制（如实标注）

- `--dump-config-schema` 证明真实 DSH 进程能 **import** 我们的 host 入口并读取 Config schema；但**没有**启动完整 web 服务去浏览器里点开 dock/右侧栏（需要可用 web profile 与端口，日常 profile 禁止改动）。
- client bundle 的合法性用离线 mock（`window.__ModuleLoader__` + fake react/ctx）验证，并与真实第三方产物（`@michengai/dsh-codex-ui`、`dsh-context`）的 loader 包装逐字节对照。
- `spike/` 可以整体删除/替换；产品实现落在 `src/`，结论落在 `docs/impl/dsh-plugin-api-cheatsheet.md`。
