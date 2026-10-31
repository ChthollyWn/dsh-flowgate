# 真机宿主冒烟：新建会话不报 not lossless JSON（`pnpm verify:host`）

> 证据记录（2026-11-01，Asia/Shanghai）。对应事故：`flowgate` 会话投影 wire 值含显式
> `undefined`，DSH `@deepseek-ai/dsh-api-remotes` 的 `isJsonValue()` 校验拒绝
> `api-session/added` 转发，导致**新建会话/子会话全部失败**；旧恢复流程又要求关插件/
> 重启/新会话，形成自举死锁。本脚本是该回归的**唯一真机门**：不检查源码/单测，而是在
> 隔离环境启动真实 DSH Web 宿主，走真实 `POST /api/session/create`。
>
> 脚本：[scripts/smoke-host.mjs](../../scripts/smoke-host.mjs)（`pnpm verify:host`）。

## 1. 结论（如实）

| 项 | 结果 |
|---|---|
| 当前构建（2026-11-01 v0.6 最终集成构建，`lib/host.js` 1,339,774 B / sha256 `b979dc08…`） | ✅ **GREEN**：`pnpm verify:host` 隔离宿主连续创建 3/3 会话成功，`ok:true` + `sessionId`，无 lossless 错误；隔离 web 宿主 0.8s ready、约 0.02s/会话 |
| 门本身的有效性（反向元验证） | ✅ **能抓住旧 bug**：把 `toLosslessJson$1` 中性化模拟修复前构建后，同样流程 **第 1 次 create 成功、第 2/3 次 create 报** `gateway/internal ... not lossless JSON data`（2/3 命中）；`--expect-fail` 判定通过 |
| 覆盖 | 真实 DSH Web 宿主（`dsh --profile <p> --no-open --port 0`）+ `link:` 安装本仓库构建 + 已初始化工作区（`.flowgate/`）+ `POST /api/session/create` |
| 未覆盖 | Desktop（Electron 窗口）宿主人工走查、子 agent 会话创建、真实模型轮次（脚本发 0 次模型请求） |

### 关键事实：必须连续创建 ≥2 个会话

只创建**一个**会话无法复现/捕获该 bug（实测：中性化构建上单次 create 也成功）。原因：
首个会话创建时 FlowGate 插件运行时尚未初始化，投影 cell 由 `init()` 的干净快照物化；
首个会话初始化 engine 后（工作区有 `.flowgate/`），**后续会话**的会话摘要才会带上含
`undefined` 的投影 wire 值。因此脚本默认 `--sessions 3`（最少 2），并断言全部成功。
> 这也意味着：历史记录中"旧构建单次 POST 即失败"的表述不准确——事故的手工复现应记为
> "第一个会话建立后再新建会话时失败"。

## 2. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-01（Asia/Shanghai） |
| 机器 | macOS（arm64），Node v23.11.0（脚本要求 Node 22+） |
| DSH | `0.2.1-rc.5`，CLI `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` |
| 仓库 HEAD | `1ab6ec9`（v0.5.1 修复提交；本轮 v0.6 改动为工作树未提交） |
| 被测构建 | 首次实测为 v0.5.1 修复构建（host 1,231,783 B / sha256 `009514a2…`）；**2026-11-01 最终集成后复跑为 v0.6 最终构建**：`lib/host.js` 1,339,774 B / sha256 `b979dc088265293957d79bee0bc521a314918c97b1a4f46dd5777b36ad51baf9`、`lib/client.js` 389,499 B / sha256 `7429fea340d7fa909989ee542d96fe1a4ae6f63c0cfccced2ad46e0b2c02d8c7` |
| 隔离 `DSH_HOME` / `HOME` | 脚本在 `os.tmpdir()` 下自建（本次为 `/private/var/folders/.../fg-host-smoke-*`），**不碰 `~/.dsh`**；`HOME` 也隔离，保证插件 `~/.dsh/flowgate/ledger.key` 落在临时目录 |
| profile | `flowgate-smoke` = `--from-default-profile web` 新建；组合树含 `dsh-flowgate` |
| 工作区 | 临时目录，复制仓库 `.flowgate/`（该 bug 只在 FlowGate 已初始化项目触发）；路径用 realpath |
| 模型请求 | 0（只建空会话，不发消息；子进程 `DEEPSEEK_API_KEY` 置为假值） |

## 3. 命令与结果（GREEN）

```bash
cd /path/to/dsh-flowgate
pnpm build            # 前置：脚本只验证构建产物，不代构建；缺 lib/host.js 会提示先 build
pnpm verify:host      # 或 node scripts/smoke-host.mjs
```

实测输出（2026-11-01 首次实测：v0.5.1 修复构建；集成后最终 v0.6 构建复跑结果相同）：

```text
隔离根目录：/private/var/folders/gd/.../T/fg-host-smoke-Ea6Qg6
  DSH_HOME=.../dsh-home
  HOME=.../home（护住插件 ledger.key，不落真实 ~/.dsh）
  workspace=.../workspace
插件构建：/Users/chtholly/Developer/WorkSpace/dsh-flowgate（入口 host.js）
profile：flowgate-smoke（--from-default-profile web）
✓ workspace 已带 FlowGate 初始化产物（.flowgate/）
✓ 隔离 web profile 已创建
✓ 插件已安装且组合树包含 dsh-flowgate
✓ 真实 Web 宿主已就绪 — http://127.0.0.1:54209（0.8s）
✓ 启动 URL 带鉴权 token
✓ GET /connect 换取鉴权 Cookie — HTTP 302
✓ 创建会话 #1/3 成功（ok:true + sessionId + 无 lossless 错误）
✓ 创建会话 #2/3 成功（ok:true + sessionId + 无 lossless 错误）
✓ 创建会话 #3/3 成功（ok:true + sessionId + 无 lossless 错误）
✓ 全部会话创建均成功（本次事故的回归断言） — 3/3 成功
✓ 响应中没有 not lossless JSON / gateway/internal — 未命中

verify:host 通过：隔离宿主可正常创建新会话（无 not lossless JSON）。
```

退出码 0；全程约 2–4s（profile/安装/宿主启动均为本地操作），单次建会话约 0.01–0.02s。2026-11-01 最终集成后复跑
（v0.6 最终构建：host 1,339,774 B / sha256 `b979dc08…`、client 389,499 B）同样 **3/3 通过、0.8s ready、约 0.02s/会话**；
这也是本轮 Lead 集成验证口径中的 `verify:host` 结果。

> 历史触发条件：该 bug 存在于修复提交 `1ab6ec9` 之前的 v0.5 构建（旧构建已不可重建，只能通过中性化
> 副本复现）；旧构建上**连续第 2 个会话起失败**，单次 POST 可能成功。

## 4. 反向元验证（证明门有效，RED）

没有历史旧构建产物，因此把当前 `lib/` 复制到 `/tmp/fg-old-build`，仅把投影边界的
`toLosslessJson$1` 改成恒等（模拟修复前行为），其余字节不变：

```bash
node scripts/smoke-host.mjs --plugin /tmp/fg-old-build --expect-fail
```

实测输出（节选）：

```text
✓ 创建会话 #1/3成功 — session-dc70c1ef-...（首个会话仍成功）
✗ 创建会话 #2/3失败 — HTTP 200 · gateway/internal
  响应原文：{"type":"server-response",...,"result":{"ok":false,"error":{"code":"gateway/internal",
  "message":"failed to create session: Error: forwarded host event \"api-session/added\"
  argument 0 is not lossless JSON data","details":{}}}}
✗ 创建会话 #3/3失败 — HTTP 200 · gateway/internal
✓ 反向模式：已知坏构建复现 not lossless JSON（本门有效） — 第 2、3 次创建命中
```

`--expect-fail` 只在"确实复现事故错误"时 exit 0；正常模式（不带 `--expect-fail`）下
上述输出会 exit 1。因此该门能真实拦截本类回归。

> 如果将来需要复核"门仍有效"，重新做一次上述中性化副本演练即可；不要把 `--expect-fail`
> 当作日常回归命令。

## 5. 复现配方（供其他机器/脚本参考）

```bash
# 1) 隔离环境
ROOT=$(mktemp -d); DSH_HOME="$ROOT/dsh-home"; HOME="$ROOT/home"; umask 077
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 2) 从官方 web 模板建 profile + link 安装当前构建
"$DSH" smoke --from-default-profile web --help
"$DSH" plugin --profile smoke add link:/path/to/dsh-flowgate

# 3) 起真实 Web 宿主（端口 0 让 OS 选；--no-open）
"$DSH" --profile smoke --no-open --host 127.0.0.1 --port 0 > host.log 2>&1 &
# 从 host.log 解析：dsh web: http://127.0.0.1:<port>/?token=<TOKEN>

# 4) 换鉴权 Cookie
curl -i -c cookies.txt "http://127.0.0.1:<port>/connect?token=<TOKEN>"   # 302 + Set-Cookie: dsh-auth-…

# 5) 连续创建 ≥2 个会话（cwd 必须是 realpath 且含 .flowgate/）
curl -s -X POST "http://127.0.0.1:<port>/api/session/create" \
  -H 'content-type: application/json' -H "origin: http://127.0.0.1:<port>" -b cookies.txt \
  -d '{"type":"client-request","rpcId":"smoke-1","method":"session/create","payload":{"args":{"request":{"cwd":"<workspace realpath>"}}}}'
# 期望：{"type":"server-response","rpcId":"smoke-1","result":{"ok":true,"value":{"sessionId":"session-…","agentPreset":"standard"}}}
```

要点：
- `payload.args` 必须是一个 plain object（DSH Remote 协议：`Remote payload must contain exactly one plain-object args field`）。
- 成功后清理：kill 宿主进程、删临时目录（脚本 `--keep` 可保留现场）。
- `--sessions 3` 的间隔 750ms 是给插件运行时初始化/emit 留时间；不要把这个门简化成单会话。

## 6. 已知限制与后续

1. 只覆盖 **Web 宿主**；Desktop 窗口/子 agent 会话创建仍需人工或 Playwright 走查（未自动化）。
2. 只验证"会话创建"这一条事故路径，不验证投影内容正确性/客户端渲染（单测与既有 E2E 覆盖）。
3. 依赖本机安装 DSH；CI（GitHub 托管 runner）没有 DSH，**不跑此门**。发布前在装有 DSH 的机器上
   手工执行并记录（见 [docs/release/v0.1.0.md](../release/v0.1.0.md) 发布清单与
   [docs/impl/dev-loop.md](../impl/dev-loop.md) SOP）。
4. 脚本不代替 `pnpm build`：缺 `lib/host.js` 时退出码 2 并提示先构建。
5. 历史 RED 证据：事故发生在修复提交 `1ab6ec9` 之前（v0.5 构建），现仅能通过上述中性化
   副本复核，不能重建旧构建产物（不伪造旧构建实跑记录）。
