/**
 * 测试/构建/lint 输出压缩（03 §6.7 / H19）。
 *
 * rc.5 的关键事实（docs/impl/dsh-plugin-api-cheatsheet.md §10-9）：
 * `tools/post-execute` 用 `accept{content}` 替换后，durable log 记录的就是**替换后**
 * 的内容——原始输出在会话日志里读不到。因此这里必须自己落全文：
 * `.flowgate/state/evidence/agent-<时间戳>.log`，摘要里写明路径。
 *
 * 处理顺序（03 §6.7 要求）：先用**完整输出**解析出证据摘要，再把进入上下文的结果
 * 换成摘要；只在输出很大时替换（小输出保留原样，避免无谓的 KV cache 变动）。
 * 注意：agent 自己跑的命令只做"输入压缩"，不算 RED/GREEN 回执——回执只能由
 * `flow_verify`（插件亲自执行）产生。
 */
import type { DshContext, DshContentBlock, DshPostToolDecision, DshToolExecution, DshToolResult, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { EvidenceKind, EvidenceReceipt, TestSummary } from '../../core/types.js'
import { toAgentError } from '../errors.js'
import { collectTamperSignals } from '../../core/tamper/index.js'
import { sha256Hex } from '../../core/util/hash.js'

/** 每次工具调用后的维护任务（证据新鲜度 + 篡改扫描）去抖计时器。 */
const maintenanceTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()
const MAINTENANCE_DEBOUNCE_MS = 250

/** 工具调用后异步维护：刷新面板证据新鲜度，并扫描 diff 里的篡改信号（T3.5/T3.6）。 */
export function schedulePostToolMaintenance(runtime: HostRuntime): void {
  const key = runtime as unknown as object
  const existing = maintenanceTimers.get(key)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => {
    maintenanceTimers.delete(key)
    void runPostToolMaintenance(runtime)
  }, MAINTENANCE_DEBOUNCE_MS)
  const maybeUnref = timer as unknown as { unref?: () => void }
  maybeUnref.unref?.()
}

async function runPostToolMaintenance(runtime: HostRuntime): Promise<void> {
  const engine = runtime.engine()
  const ports = runtime.ports()
  const root = runtime.root()
  if (!engine || !ports || !root) return
  try {
    await engine.refreshEvidenceFreshness()
    engine.notifyStateChanged()
  } catch {
    // 新鲜度是展示数据：失败不影响门禁。
  }
  try {
    const snapshot = runtime.lastSnapshot
    if (!snapshot?.initialized || snapshot.off) return
    if (!ports.git || !(await ports.git.isRepo(root))) return
    const diffText = await ports.git.diffText(root)
    if (diffText.trim() === '') return
    const signals = collectTamperSignals(diffText)
    if (signals.length > 0) await engine.recordTamperSignals(signals, 'post-execute')
  } catch {
    // 篡改扫描失败时保持静默；下一轮工具调用会重试。
  }
}

/**
 * 从一次工具调用里识别「技能加载」：DSH 的 `dsh-tool-skill` 把加载结果作为工具
 * 结果返回，工具名是 `skill`。名称从参数 name/skill/id 里取（按常见写法兜底）。
 * 不是技能工具时返回 null。
 */
export function skillNameFromTool(tool: string, args: unknown): string | null {
  if (!/^skills?$/i.test(tool.trim())) return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const record = args as Record<string, unknown>
  for (const key of ['name', 'skill', 'skillName', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/** 触发压缩的最小内容长度（字符）。 */
const COMPRESS_THRESHOLD_CHARS = 1_200
/** 替换后内容上限（防止超大摘要）。 */
const MAX_SUMMARY_CHARS = 8_000

/** 结果内容里的纯文本。 */
export function textOf(content: readonly DshContentBlock[] | undefined): string {
  if (!content) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 从 bash 风格结果里尽量拿到退出码与 stdout/stderr。 */
export function extractRunFacts(
  result: Readonly<DshToolResult>,
  contentText: string,
): { exitCode: number; stdout: string; stderr: string } {
  const value = (result as { value?: unknown }).value
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const exitCodeRaw = record.exitCode ?? record.exit_code ?? record.code
    const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : Number.parseInt(String(exitCodeRaw ?? ''), 10)
    if (Number.isFinite(exitCode)) {
      const stdout = typeof record.stdout === 'string' ? record.stdout : ''
      const stderr = typeof record.stderr === 'string' ? record.stderr : ''
      return { exitCode, stdout: stdout || contentText, stderr }
    }
  }
  const match = /\[exit code: (-?\d+)\]/.exec(contentText)
  if (match?.[1]) return { exitCode: Number.parseInt(match[1], 10), stdout: contentText, stderr: '' }
  return { exitCode: result.isError ? 1 : 0, stdout: contentText, stderr: '' }
}

/** 需要压缩的命令类别（test/build/lint/typecheck；run 类通常是启动服务，不压）。 */
export function shouldCompress(result: Readonly<DshToolResult>, contentText: string, kind: EvidenceKind | null): boolean {
  if (contentText.length < COMPRESS_THRESHOLD_CHARS) return false
  if (kind === null || kind === 'manual') return false
  return result.isError || kind === 'test' || kind === 'build' || kind === 'lint' || kind === 'typecheck'
}

/** 生成摘要文本（先解析、再摘要；完整日志路径附在末尾）。 */
export function buildCompressedSummary(input: {
  receipt: EvidenceReceipt
  summary: TestSummary | null
  outputRef: string
  maxTokens: number
  runtime: HostRuntime
}): string {
  const { receipt, summary, outputRef, maxTokens, runtime } = input
  let text = ''
  try {
    text = runtime.deps.core.summarizeEvidenceForContext(receipt, maxTokens)
  } catch (error) {
    runtime.noteFeature('evidence', `证据摘要生成失败：${toAgentError(error).error}`)
  }
  if (text.trim() === '') {
    const head = summary
      ? `[FlowGate] ${receipt.command} → ${receipt.phase === 'green' ? '通过' : receipt.phase === 'red' ? '失败' : '未知'}（运行 ${summary.run}，通过 ${summary.passed}，失败 ${summary.failed}，跳过 ${summary.skipped}）`
      : `[FlowGate] ${receipt.command} → 退出码 ${receipt.exitCode}（未解析出测试数量）`
    text = `${head}\n完整输出：${outputRef}（可用 read 查看；本条为 agent 自跑命令，不算验证回执）`
  } else if (!text.includes(outputRef)) {
    text = `${text}\n完整输出：${outputRef}（可用 read 查看）`
  }
  // 无论 core 摘要是否包含路径，都显式标注"agent 自跑、不算回执"（03 §6.7 可信度口径）。
  if (!text.includes('不算验证回执')) text = `${text}\n（本条为 agent 自跑命令的摘要，不算验证回执；回执只能由 flow_verify 产生）`
  if (text.length > MAX_SUMMARY_CHARS) {
    text = `${text.slice(0, MAX_SUMMARY_CHARS)}\n…（摘要过长已截断，完整内容见 ${outputRef}）`
  }
  return text
}

/** 安装输出压缩（tools/post-execute）。 */
export function installEvidenceCompression(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools) return
    runtime.capabilities.toolsPostExecute = true
    runtime.onScoped(
      scoped,
      'tools/post-execute',
      async (exec: DshToolExecution, result: Readonly<DshToolResult>, next: () => Promise<DshPostToolDecision>) => {
        const decision = await next()
        // 技能加载回执（T2.4）：过 G1/G3 前必须已经加载过阶段核心技能。
        const skillName = skillNameFromTool(exec.name, exec.arguments)
        const engineForSkill = runtime.engine()
        if (skillName !== null && engineForSkill) {
          try {
            const body = 'content' in decision && Array.isArray(decision.content) ? textOf(decision.content) : textOf(result.content)
            const receipt = await engineForSkill.recordSkillLoaded(skillName, sha256Hex(body))
            runtime.noteFeature(
              'skills',
              receipt.duplicate ? `技能 ${skillName} 本会话已加载过（不重复注入全文）` : `已记录技能加载回执：${skillName}`,
            )
          } catch (error) {
            runtime.noteFeature('skills', `技能回执记录失败：${toAgentError(error).error}`)
          }
        }
        const compressed = await compressPostExecute(runtime, exec, result, decision)
        // 任何工具执行后都可能改变输入文件（源码/测试），刷新证据新鲜度并扫篡改。
        schedulePostToolMaintenance(runtime)
        return compressed
      },
    )
  })
}

async function compressPostExecute(
  runtime: HostRuntime,
  exec: DshToolExecution,
  result: Readonly<DshToolResult>,
  decision: DshPostToolDecision,
): Promise<DshPostToolDecision> {
  if (!runtime.isEnabled()) return decision
  if (decision.kind !== 'accept') return decision
  const engine = runtime.engine()
  const ports = runtime.ports()
  const root = runtime.root()
  if (!engine || !ports || !root) return decision
  const snapshot = runtime.lastSnapshot
  if (!snapshot?.initialized) return decision
  const params = exec.arguments
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return decision
  const command = typeof (params as Record<string, unknown>).command === 'string' ? ((params as Record<string, unknown>).command as string) : ''
  if (command === '') return decision

  const content = 'content' in decision && Array.isArray(decision.content) ? decision.content : result.content
  const text = textOf(content)
  let kind: EvidenceKind | null = null
  try {
    kind = runtime.deps.core.detectEvidenceKind(command)
  } catch {
    kind = null
  }
  if (!shouldCompress(result, text, kind)) return decision

  const { exitCode, stdout, stderr } = extractRunFacts(result, text)
  const now = runtime.isoNow()
  const stamp = now.replace(/[-:.TZ]/g, '').slice(0, 17)
  const receiptId = `agent-${stamp}-${Math.abs(hashString(command)) % 1000}`
  const outputRef = `.flowgate/state/evidence/${receiptId}.log`
  let summary: TestSummary | null = null
  try {
    summary = runtime.deps.core.parseTestOutput({ command, stdout, stderr, exitCode, now })
  } catch (error) {
    runtime.noteFeature('evidence', `测试输出解析失败，标为未解析：${toAgentError(error).error}`)
    summary = null
  }
  let phase: EvidenceReceipt['phase'] = 'unknown'
  try {
    phase = runtime.deps.core.evidencePhase(summary, exitCode)
  } catch {
    phase = exitCode === 0 ? 'green' : 'red'
  }
  const change = engine.currentChange()
  const receipt: EvidenceReceipt = {
    id: receiptId,
    changeId: change?.id ?? 'UNKNOWN',
    taskId: snapshot.activeTaskId,
    group: 'agent-run',
    kind: kind ?? 'run',
    phase,
    command,
    runBy: 'agent',
    exitCode,
    summary,
    inputsHash: '',
    outputRef,
    startedAt: now,
    finishedAt: now,
    notes: 'agent 自跑命令的结果摘要，不算 RED/GREEN 回执',
  }
  // 1) 先落全文（失败也不影响压缩，只是摘要里路径可能不存在）。
  try {
    await ports.fs.mkdir('.flowgate/state/evidence')
    await ports.fs.writeFile(
      outputRef,
      [
        `# FlowGate 输出记录 ${receiptId}`,
        `命令：${command}`,
        `退出码：${exitCode}`,
        `时间：${now}`,
        '',
        '----- output -----',
        text,
      ].join('\n'),
    )
  } catch (error) {
    runtime.noteFeature('evidence', `输出全文落盘失败：${toAgentError(error).error}`)
  }
  let maxTokens = 400
  try {
    maxTokens = engine.getConfig().limits.test_output_summary_tokens
  } catch {
    // 用默认。
  }
  const summaryText = buildCompressedSummary({ receipt, summary, outputRef, maxTokens, runtime })
  return { kind: 'accept', content: [{ type: 'text', text: summaryText }] }
}

function hashString(input: string): number {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return hash
}
