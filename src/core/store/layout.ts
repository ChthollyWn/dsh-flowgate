/**
 * `.flowgate/` 目录布局（03 §9.1）与初始化脚手架（`/flow init` 生成）。
 *
 * 所有路径都是**仓库相对路径**（正斜杠、无 `./` 前缀）。宿主的 FileSystem 适配层
 * 以项目根为基准解析这些路径；layout(root) 的 `root` 字段只作元信息。
 *
 * 提交策略（FR-14.9）：`.flowgate/.gitignore` 由插件生成——
 * - 默认内容为 `*`，整个目录不进 git（也不修改项目根目录的 .gitignore）；
 * - `git.commit_flowgate: true` 时只排除 `state/`、`worktrees/`、`dashboard.html`，
 *   其余文件（需求、任务、台账、报告）随代码提交。
 */
import type { FileSystem } from '../util/fs'
import { normalizeRelPath, posixJoin } from '../util/paths'
import { DEFAULT_CONFIG, parseConfig, renderConfigYaml } from './config'

export interface FlowgateLayout {
  root: string
  dir: string
  config: string
  projectDoc: string
  roadmap: string
  changesIndex: string
  changesDir: string
  archiveDir: string
  specsDir: string
  rulesDir: string
  stateDir: string
  ledger: string
  sessions: string
  snapshotsDir: string
  evidenceDir: string
  worktreesDir: string
  metricsDir: string
  retro: string
  dashboard: string
  /**
   * 账本 HMAC 密钥的约定位置，**仅作信息字段**：密钥在仓库之外
   * （`~/.dsh/flowgate/ledger.key`，权限 0600），由宿主生成并读取，
   * 通过 `EnginePorts.ledgerKey` 传给 core；core 不读写密钥文件。
   */
  keyPath: string
}

export interface ChangePaths {
  dir: string
  clarify: string
  proposal: string
  /** 增量规格默认单文件位置：`specs/spec.md`；多能力时见可选的 specsDir / findIncrementalSpec。 */
  spec: string
  /** 增量规格目录（`changes/<id>/specs/`），多能力时其下为 `<capability>/spec.md`。 */
  specsDir?: string
  context: string
  design: string
  risk: string
  tasks: string
  analysis: string
  executionPlan: string
  status: string
  handoff: string
  evidence: string
  review: string
  report: string
}

/** 密钥约定位置的常量（不在仓库内，core 不读写）。 */
export const LEDGER_KEY_PATH = '~/.dsh/flowgate/ledger.key'

function normalizeRoot(root: string): string {
  if (root === '' || root === '.') return ''
  return normalizeRelPath(root)
}

function under(root: string, ...parts: string[]): string {
  return posixJoin(normalizeRoot(root), ...parts)
}

/** 计算 `.flowgate/` 全部标准路径。 */
export function layout(root: string): FlowgateLayout {
  const base = normalizeRoot(root)
  const dir = under(base, '.flowgate')
  return {
    root: base,
    dir,
    config: `${dir}/config.yaml`,
    projectDoc: `${dir}/project.md`,
    roadmap: `${dir}/roadmap.md`,
    changesIndex: `${dir}/changes/index.md`,
    changesDir: `${dir}/changes`,
    archiveDir: `${dir}/archive`,
    specsDir: `${dir}/specs`,
    rulesDir: `${dir}/rules`,
    stateDir: `${dir}/state`,
    ledger: `${dir}/state/ledger.jsonl`,
    sessions: `${dir}/state/sessions.json`,
    snapshotsDir: `${dir}/state/snapshots`,
    evidenceDir: `${dir}/state/evidence`,
    worktreesDir: `${dir}/worktrees`,
    metricsDir: `${dir}/metrics`,
    retro: `${dir}/retro.md`,
    dashboard: `${dir}/dashboard.html`,
    keyPath: LEDGER_KEY_PATH,
  }
}

/** 计算单个变更（C-xxx / A-xxx）目录下的产物路径。 */
export function changePaths(root: string, changeId: string): ChangePaths {
  const id = changeId.trim()
  // 只允许单段、无路径分隔符/相对路径语义的编号，防止写到 changes/ 之外。
  if (id === '' || id === '.' || id === '..' || id.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`变更编号不合法：${JSON.stringify(changeId)}`)
  }
  const dir = `${layout(root).changesDir}/${id}`
  const specsDir = `${dir}/specs`
  return {
    dir,
    clarify: `${dir}/clarify.md`,
    proposal: `${dir}/proposal.md`,
    spec: `${specsDir}/spec.md`,
    specsDir,
    context: `${dir}/context.md`,
    design: `${dir}/design.md`,
    risk: `${dir}/risk.md`,
    tasks: `${dir}/tasks.md`,
    analysis: `${dir}/analysis.md`,
    executionPlan: `${dir}/execution-plan.md`,
    status: `${dir}/status.json`,
    handoff: `${dir}/handoff.md`,
    evidence: `${dir}/evidence.md`,
    review: `${dir}/review.md`,
    report: `${dir}/report.html`,
  }
}

/** 是否已执行过 `/flow init`（以 `.flowgate/config.yaml` 是否存在为准）。 */
export async function isInitialized(fs: FileSystem, root: string): Promise<boolean> {
  return fs.exists(layout(root).config)
}

/**
 * 读取变更的增量规格文件：
 * 1. 优先 `changes/<id>/specs/spec.md`（单文件模式，插件写入的默认位置）；
 * 2. 否则扫描 `specs/<capability>/spec.md`（多能力模式），按字典序返回第一个；
 * 3. 都没有返回 null。
 */
export async function findIncrementalSpec(
  fs: FileSystem,
  root: string,
  changeId: string,
): Promise<string | null> {
  const paths = changePaths(root, changeId)
  if (await fs.exists(paths.spec)) return paths.spec
  try {
    const entries = await fs.readdir(paths.specsDir as string)
    for (const entry of [...entries].sort()) {
      const candidate = `${paths.specsDir}/${entry}/spec.md`
      if (await fs.exists(candidate)) return candidate
    }
  } catch {
    // specs 目录不存在：视为没有增量规格。
  }
  return null
}

/**
 * 目录内 `.gitignore` 的内容。
 * @param commitFlowgate config.git.commit_flowgate：true 时除运行态外随代码提交。
 */
export function renderFlowgateGitignore(commitFlowgate: boolean): string {
  if (!commitFlowgate) return '*\n'
  return 'state/\nworktrees/\ndashboard.html\n'
}

const README = `# .flowgate/ 目录说明

本目录由 **FlowGate** 生成，是跨会话的唯一事实来源：任何会话、面板、看板都从这里读状态。
默认整个目录不进 git（见本目录的 .gitignore）；若在 config.yaml 里设置
\`git.commit_flowgate: true\`，则只有 \`state/\`、\`worktrees/\`、\`dashboard.html\` 被忽略。

## 文件

- \`config.yaml\` —— 规则、流程等级、触发器、命令、并行与会话设置。修改只影响新变更。
- \`project.md\` —— 项目级上下文包（/flow init 生成，负责人维护）。
- \`project-clarify.md\` —— 项目级澄清记录（仅从 0 开发时）。
- \`roadmap.md\` —— 项目路线图（仅从 0 开发时；GR 后冻结）。
- \`specs/<capability>/spec.md\` —— 主规格：系统现在"应该怎样"。
- \`rules/<rule-id>.md\` —— 负责人确认后沉淀的项目规则。
- \`changes/index.md\` —— 变更台账（仅插件写）。
- \`changes/<id>/\` —— 每个变更的澄清、提案、增量规格、上下文、设计、风险、任务、执行图、
  进行状态、交接摘要、证据摘要、审查结论与交付报告。
- \`archive/<日期>-<id>/\` —— 已交付的变更。
- \`retro.md\` —— 复盘日志；\`metrics/<id>.json\` —— 指标快照；
  \`dashboard.html\` —— 跨会话看板。
- \`state/ledger.jsonl\` —— 审计账本：只追加，哈希链 + HMAC；\`state/sessions.json\` 会话租约；
  \`state/snapshots/\` 工作区快照；\`state/evidence/<id>.log\` 完整命令输出。
- \`worktrees/<change-id>/<task-id>/\` —— 并行任务的独立检出目录（合并后删除）。

## 谁能写

- **agent 写**：只在对应阶段允许写本变更的产物，过门后冻结。
- **仅插件写**：台账、进行状态、执行流程图、证据摘要、审查结论、报告、账本、releases 等。
- \`state/\` 与 \`worktrees/\` 只由插件管理；并行任务的子 agent 只能写自己那个 worktree。

## 恢复

\`/flow doctor\` 检查账本完整性；\`/flow repair\` 从账本和产物重建 status.json 与台账。
账本损坏或被篡改时进入锁定模式，拒绝门禁内的写入。
`

/** 需要创建的运行目录（顺序即创建顺序，父目录在前）。 */
function scaffoldDirs(root: string): string[] {
  const l = layout(root)
  return [
    l.dir,
    l.changesDir,
    l.archiveDir,
    l.specsDir,
    l.rulesDir,
    l.stateDir,
    l.snapshotsDir,
    l.evidenceDir,
    l.worktreesDir,
    l.metricsDir,
  ]
}

/**
 * 生成 `.flowgate/` 骨架：目录、README.md、目录内 .gitignore、默认 config.yaml。
 *
 * 幂等：已存在的 config.yaml 不会被覆盖（保护负责人修改过的配置）；README 与
 * .gitignore 是插件生成物，会按当前配置刷新。**绝不修改项目根目录的 .gitignore。**
 */
export async function scaffold(fs: FileSystem, root: string): Promise<void> {
  const l = layout(root)
  for (const dir of scaffoldDirs(root)) await fs.mkdir(dir)

  // 已初始化过的项目保留用户配置，只根据其中的 commit_flowgate 刷新 .gitignore。
  let commitFlowgate = DEFAULT_CONFIG.git.commit_flowgate
  if (await fs.exists(l.config)) {
    try {
      const existing = parseConfig(await fs.readFile(l.config))
      commitFlowgate = existing.git.commit_flowgate
    } catch {
      // 配置损坏时退回默认提交策略；`/flow doctor` 会报告配置错误。
      commitFlowgate = DEFAULT_CONFIG.git.commit_flowgate
    }
  } else {
    await fs.writeFile(l.config, renderConfigYaml(DEFAULT_CONFIG))
  }

  if (!(await fs.exists(`${l.dir}/README.md`))) {
    await fs.writeFile(`${l.dir}/README.md`, README)
  }
  await fs.writeFile(`${l.dir}/.gitignore`, renderFlowgateGitignore(commitFlowgate))
}
