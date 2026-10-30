/**
 * core 纯函数桥：host 唯一直接 import core **值** 的地方。
 *
 * 这样做的收益：
 * - 所有与 core 的耦合点集中在一个文件，core 接口调整时只改这里；
 * - `test/host/**` 用注入的假 bridge，不需要真实 core（也不需要等它实现完）；
 * - 依赖方向仍是 host → core（core 不知道 host 存在）。
 */
import type { CoreBridge } from './types.js'
import { classifyTool, actionFromToolCall, BLOCKED_DELEGATION_TOOLS } from '../core/rules/toolclass.js'
import { extractWriteTargets } from '../core/shell/classify.js'
import { formatMetricsText, metricsCsv } from '../core/metrics/metrics.js'
import { renderConfigYaml } from '../core/store/config.js'
import {
  detectEvidenceKind,
  evidencePhase,
  parseTestOutput,
  summarizeEvidenceForContext,
  truncateOutput,
} from '../core/evidence/index.js'

/** 生产环境的 core 桥（纯函数，无 IO、无状态）。 */
export function createCoreBridge(): CoreBridge {
  return {
    classifyTool: (tool, schemaKeys) => classifyTool(tool, schemaKeys),
    actionFromToolCall: (tool, params) => actionFromToolCall(tool, params),
    detectEvidenceKind: (command) => detectEvidenceKind(command),
    parseTestOutput: (input) => parseTestOutput(input),
    evidencePhase: (summary, exitCode) => evidencePhase(summary, exitCode),
    summarizeEvidenceForContext: (receipt, maxTokens) => summarizeEvidenceForContext(receipt, maxTokens),
    truncateOutput: (output, maxChars) => truncateOutput(output, maxChars),
    extractWriteTargets: (command) => extractWriteTargets(command),
    blockedDelegationTools: () => [...BLOCKED_DELEGATION_TOOLS],
    formatMetricsText: (set) => formatMetricsText(set),
    metricsCsv: (set) => metricsCsv(set),
    renderConfigYaml: (config) => renderConfigYaml(config),
  }
}
