# Third-Party Notices

FlowGate（`dsh-flowgate`）以 MIT 许可发布（见仓库根目录 `LICENSE`）。

本文件声明项目借鉴的其他项目方法论、示例仓库使用的第三方组件，以及许可边界。

## 1. 方法论来源声明（未复制代码）

FlowGate 的 15 个内置技能与流程设计借鉴了以下开源项目公开的方法论与工作流形状。**我们没有复制这些项目的源代码、文档正文或提示词原文**；技能文本与方法说明均用我们自己的话重写，借鉴的只是思想与工程原则（例如"先写失败测试再写实现""先澄清再动手"）。方法到技能的逐条映射见 [`docs/method-sources.md`](docs/method-sources.md)。

| 项目 | 版本基线 | 许可 | 我们借鉴的内容 | 仓库 |
|---|---|---|---|---|
| OpenSpec | v1.15.0（2026-10-24） | MIT | 变更/规格组织方式、`specs/`、`changes/`、`archive/`、proposal / design / tasks、ADDED / MODIFIED / REMOVED、`config.yaml` 的 context / rules | <https://github.com/Fission-AI/OpenSpec> |
| Superpowers | v7.0.1（2026-10-21） | MIT | brainstorming、writing-plans、test-driven-development、systematic-debugging、verification-before-completion、requesting/receiving-code-review、subagent-driven-development、dispatching-parallel-agents、finishing-a-development-branch 的纪律与做法 | <https://github.com/obra/superpowers> |
| gstack | 仓库 main 分支 2026-10 快照（未标注版本号） | MIT | `/office-hours`、`/spec`、`/plan-eng-review`、`/freeze`、`/careful`、`/guard`、`/investigate`、`/review`、`/qa`、`/cso`、`/ship`、`/document-release`、`/retro` 的工作流形状 | <https://github.com/garrytan/gstack> |

说明：

- 上述项目的许可（MIT）允许复制与修改，但本仓库仍选择**不复制代码与文本**，只借鉴方法论并署名来源，以保持内容层独立维护。
- 产物格式（OpenSpec 风格目录与增量规格）是公开约定的兼容使用，不是代码复用。
- 方法来源的复查周期与清单见 `docs/method-sources.md` §4。

## 2. DSH 宿主

FlowGate 是 DeepSeek Harness（DSH）的插件，运行时通过 DSH 的公开插件接口（Cordis 插件、工具/命令/守卫/技能注册等）与宿主交互。

- DSH 本身不随本项目分发，也不包含在本仓库中；用户的 DSH 安装按其自身许可使用。
- 仓库中的 `docs/reference/dsh-0.2.1-rc.5/` 是 DSH 官方包 README 的中文参考副本，版权归 DeepSeek Harness 项目所有，仅用于开发参考，不构成对本项目的许可授予；`npm pack` 发布物不包含 `docs/` 下的该目录（发布清单见 `package.json` 的 `files`）。
- 本项目不把 DSH 核心包打进依赖树，`@deepseek-ai/*` 仅作为 peerDependencies 声明。

## 3. 示例仓库的第三方组件

`examples/` 下的三个基准仓库仅用于流程评测与演示，不随 npm 包发布（`package.json` 的 `files` 不含 `examples`）。它们使用的第三方组件如下：

### 3.1 `examples/ts-todo-api/`

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Node.js 内置 `node:http`、`node:test`、`node:assert` | Node.js ≥ 22（开发基线 24） | Node.js 项目许可（MIT 及第三方声明） | HTTP 服务与测试，**零 npm 运行时依赖** |

本示例没有 `dependencies`；`pnpm install` 只生成锁文件，不下载运行时依赖。

### 3.2 `examples/py-csv-cli/`

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Python 标准库（`csv`、`unittest` 等） | Python ≥ 3.10（开发基线 3.13） | PSF License | 实现与测试（零运行时依赖） |
| pytest | ≥ 8.0（仅开发依赖，`requirements-dev.txt`） | MIT | 可选的测试运行器；测试同时兼容标准库 `unittest` |

### 3.3 `examples/java-renewal/`

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Spring Boot | 3.x（由 `pom.xml` 的 parent 指定） | Apache License 2.0 | Web 层、依赖注入、测试支持 |
| JUnit 5（Jupiter） | 由 `spring-boot-starter-test` 引入 | Eclipse Public License 2.0 | 单元测试 |
| Maven Wrapper（`mvnw`/`mvnw.cmd`、`.mvn/wrapper/`） | Apache Maven Wrapper 3.x | Apache License 2.0 | 在无需预装 Maven 的机器上构建 |

上述依赖只为运行示例服务与测试而声明，不随 FlowGate 发布物打包。

## 4. 许可边界与联系

- 本仓库自有代码与文档：MIT，见 `LICENSE`。
- 上游方法论：署名来源、不复制内容；如上游作者认为某处引用不当，可提 issue 更正。
- 示例仓库中的依赖：遵循各自许可；在示例仓库内运行、修改、分发时请遵守对应许可。
- 本文件随方法来源表一起季度复查（见 `docs/method-sources.md` §4）。
