/**
 * 工具覆盖自检（03 §4.3）。
 *
 * 会话开始（引擎就绪）时枚举当前 agent 可见的全部工具 schema，用 core 的
 * `classifyTool` 分类：read / write / shell / delegate / mcp / flowgate / unknown。
 * 未分类或未覆盖的可写类工具在 doctor 与面板里标红（"转人工确认"）：
 * 守卫无法保证这类工具不写文件，因此策略是——不静默放行它的副作用，而是把
 * 覆盖缺口写进 engine.setCoverage()（G6/doctor 检查项），并在会话里提示负责人。
 *
 * 工具面变化（`tools/change`）时重算，保证子 agent / MCP 动态注册后仍准确。
 */
import type { DshContext, DshToolRuntime } from '../adapters/dsh-types.js'
import type { HostRuntime } from '../runtime.js'
import type { CoverageEntry, CoverageReport } from '../../core/types.js'
import { toAgentError } from '../errors.js'

/** 可写/有副作用、必须被守卫覆盖的工具类别。 */
const WRITABLE_CATEGORIES = new Set<CoverageEntry['category']>(['write', 'shell', 'delegate', 'mcp', 'unknown'])

/** 对当前可见工具做一次覆盖自检（纯函数，便于单测）。 */
export function computeCoverage(
  runtime: HostRuntime,
  schemas: readonly { name: string; parameters?: Record<string, unknown> }[],
  now: string,
): CoverageReport {
  const entries: CoverageEntry[] = []
  const seen = new Set<string>()
  for (const schema of schemas) {
    if (!schema || typeof schema.name !== 'string' || schema.name === '') continue
    if (seen.has(schema.name)) continue
    seen.add(schema.name)
    const schemaKeys =
      schema.parameters && typeof schema.parameters === 'object'
        ? Object.keys((schema.parameters as { properties?: Record<string, unknown> }).properties ?? {})
        : undefined
    let classification
    try {
      classification = runtime.deps.core.classifyTool(schema.name, schemaKeys)
    } catch (error) {
      runtime.noteFeature('coverage', `分类工具 ${schema.name} 失败：${toAgentError(error).error}`)
      entries.push({ tool: schema.name, category: 'unknown', covered: false, reason: '分类器异常，按未分类处理' })
      continue
    }
    entries.push({
      tool: classification.tool,
      category: classification.category,
      covered: classification.covered,
      ...(classification.reason ? { reason: classification.reason } : {}),
    })
  }
  entries.sort((a, b) => a.tool.localeCompare(b.tool))
  const writable = entries.filter((entry) => WRITABLE_CATEGORIES.has(entry.category))
  const uncovered = writable.filter((entry) => !entry.covered)
  const coveredWritable = writable.length - uncovered.length
  const report: CoverageReport = {
    entries,
    coveredWritable,
    uncoveredWritable: uncovered.length,
    checkedAt: now,
  }
  return report
}

/** 安装覆盖自检：引擎就绪 + 工具面变化时重算并写入 engine。 */
export function installCoverage(runtime: HostRuntime): void {
  runtime.injectService('tools', (scoped: DshContext) => {
    const tools = scoped.get('tools') as DshToolRuntime | null
    if (!tools || typeof tools.schemas !== 'function') {
      runtime.noteFeature('coverage', '宿主 tools 服务没有 schemas()，覆盖自检降级为"未检查"')
      return
    }
    const scan = (agent?: unknown): void => {
      if (!runtime.isEnabled()) return
      try {
        // rc.5: `schemas(scope?: ScopeKey)` — the scope key is the AGENT object
        // (not its ctx). With an agent scope this returns all inherited global
        // tools; without it only tools registered on this plugin's own context.
        let schemas: readonly { name: string; parameters?: Record<string, unknown> }[] = []
        const scopeAgent = agent ?? runtime.mainAgent()
        try {
          schemas = scopeAgent !== undefined && scopeAgent !== null ? tools.schemas?.(scopeAgent) ?? [] : tools.schemas?.() ?? []
        } catch {
          schemas = tools.schemas?.() ?? []
        }
        const report = computeCoverage(runtime, schemas, runtime.isoNow())
        runtime.setCoverage(report)
        const uncovered = report.entries.filter(
          (entry) => WRITABLE_CATEGORIES.has(entry.category) && !entry.covered,
        )
        if (uncovered.length > 0) {
          runtime.noteFeature('coverage', `未覆盖的可写工具：${uncovered.map((entry) => `${entry.tool}(${entry.category})`).join('、')}`)
        }
        runtime.emit()
      } catch (error) {
        const message = toAgentError(error).error
        runtime.noteFeature('coverage', `覆盖自检失败（降级为未检查）：${message}`)
        runtime.markInert('覆盖自检', error, '工具覆盖自检失败；门禁其余功能不受影响。')
      }
    }
    runtime.registerEngineReadyHook((agent) => {
      scan(agent)
    })
    runtime.onScoped(scoped, 'tools/change', () => {
      scan(runtime.mainAgent())
    })
    // 引擎可能先于本服务就绪（服务加载顺序不定）：如果已经就绪，立即补一次。
    if (runtime.engine()) scan(runtime.mainAgent())
  })
}
