/**
 * Tool classification and action extraction (03 §4.3, FR-9.5).
 *
 * The guard calls `classifyTool` for the coverage self-check and
 * `actionFromToolCall` to turn a host tool call into a structured Action the
 * rule engine understands. Unknown tools are marked `covered: false` so the gate
 * can fall back to "human" instead of silently allowing a write.
 */
import type { Action, ActionKind } from '../types'

export type ToolCategory = 'read' | 'write' | 'shell' | 'delegate' | 'mcp' | 'flowgate' | 'unknown'

export interface ToolClassification {
  tool: string
  category: ToolCategory
  actionKind?: ActionKind
  covered: boolean
  reason?: string
}

/** Native delegation tools closed in managed sessions (03 §2.4). */
export const BLOCKED_DELEGATION_TOOLS: string[] = [
  'subagent',
  'subagent_fork',
  'workflow',
  'send_message',
  'run_code',
]

const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'multi_edit',
  'multiedit',
  'notebook_edit',
  'create_file',
  'str_replace_editor',
  'insert_text',
  'move_file',
  'delete_file',
])

const SHELL_TOOLS = new Set([
  'bash',
  'pwsh',
  'powershell',
  'shell',
  'shell_command',
  'run_command',
  'execute_command',
  'terminal',
])

const READ_TOOLS = new Set([
  'read',
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'web_fetch',
  'web_search',
  'read_image',
  'search',
])

/**
 * Host meta tools that never write the repository (todo list, goals, schedules,
 * team task board, presentation...). They are covered=true and treated as
 * read-only so normal operation is never mistaken for an unknown write tool.
 *
 * `structured_output` is the headless/structured-answer final-output tool used by
 * the DSH agent loop (and by FlowGate's own subagents, which pass outputSchema);
 * it does not write the repository. Without this entry the coverage self-check
 * classifies it as an unknown writable tool and turns it into a human pending
 * item (R-MCP), which blocks task gates in headless runs (2026-10-31 real-host
 * finding).
 */
const SAFE_HOST_TOOLS = new Set([
  'structured_output',
  'ask_user_question',
  'skill',
  'todo_write',
  'create_goal',
  'update_goal',
  'get_goal',
  'exit_plan_mode',
  'working_directory',
  'load_workspace_dependencies',
  'present',
  'job_list',
  'job_output',
  'job_kill',
  'list_agents',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_list',
  'session_query',
])

const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'send_message', 'spawn_teammate'])

function normalized(tool: string): string {
  return tool.trim().toLowerCase()
}

/** Map a tool name (plus optional parameter schema keys) to a category. */
export function classifyTool(tool: string, schemaKeys?: string[]): ToolClassification {
  const name = normalized(tool)
  if (name === '') return { tool, category: 'unknown', covered: false, reason: '工具名为空，无法分类' }
  if (name.startsWith('flow_')) {
    return { tool, category: 'flowgate', actionKind: 'other', covered: true, reason: 'FlowGate 工具，按阶段约束处理' }
  }
  if (name.startsWith('mcp__') || name.startsWith('mcp:') || name.startsWith('mcp_')) {
    return {
      tool,
      category: 'mcp',
      actionKind: 'mcp',
      covered: false,
      reason: 'MCP 工具无法静态分类：能按参数识别为写/命令的按写入判定，其余在门禁阶段转人工',
    }
  }
  if (BLOCKED_DELEGATION_TOOLS.includes(name) && name !== 'run_code') {
    return { tool, category: 'delegate', actionKind: 'delegate', covered: true, reason: '受管控会话关闭原生委派工具' }
  }
  if (DELEGATE_TOOLS.has(name)) {
    return { tool, category: 'delegate', actionKind: 'delegate', covered: true, reason: '受管控会话关闭原生委派工具' }
  }
  if (WRITE_TOOLS.has(name)) {
    return { tool, category: 'write', actionKind: 'write', covered: true, reason: '文件写入工具：按目标路径事前判定' }
  }
  if (name === 'run_code') {
    return { tool, category: 'shell', actionKind: 'shell', covered: true, reason: '代码执行工具按 shell 类命令处理（受管控会话应关闭）' }
  }
  if (SHELL_TOOLS.has(name)) {
    return { tool, category: 'shell', actionKind: 'shell', covered: true, reason: 'shell 工具：命令分词 + 事后工作区检测' }
  }
  if (READ_TOOLS.has(name)) {
    return { tool, category: 'read', actionKind: 'read', covered: true, reason: '只读工具，不拦截（读密钥文件除外）' }
  }
  if (SAFE_HOST_TOOLS.has(name) || name.startsWith('team_task_') || name.startsWith('schedule_') || name.startsWith('job_') || name.startsWith('session_')) {
    return { tool, category: 'read', covered: true, reason: '宿主元数据工具，不写仓库文件' }
  }

  // Name was not recognised: try the parameter schema shape (03 §4.3).
  if (schemaKeys && schemaKeys.length > 0) {
    const keys = new Set(schemaKeys.map((key) => key.toLowerCase()))
    if (keys.has('path') || keys.has('file_path') || keys.has('filepath') || keys.has('files')) {
      if (keys.has('content') || keys.has('new_string') || keys.has('old_string') || keys.has('patch')) {
        return { tool, category: 'write', actionKind: 'write', covered: true, reason: '按 schema 参数识别为文件写入工具' }
      }
      return { tool, category: 'write', actionKind: 'write', covered: true, reason: '按 schema 参数识别为文件写入工具' }
    }
    if (keys.has('command') || keys.has('cmd') || keys.has('script')) {
      return { tool, category: 'shell', actionKind: 'shell', covered: true, reason: '按 schema 参数识别为命令执行工具' }
    }
  }
  return {
    tool,
    category: 'unknown',
    covered: false,
    reason: '未知工具：无法确认是否会写文件，门禁阶段默认转人工',
  }
}

function stringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function filePath(params: Record<string, unknown>): string | undefined {
  return stringParam(params, ['path', 'file_path', 'filePath', 'file', 'target_path', 'targetPath', 'filename'])
}

function renameTarget(params: Record<string, unknown>): string | undefined {
  return stringParam(params, ['to', 'to_path', 'toPath', 'dest', 'destination', 'new_path', 'newPath'])
}

/**
 * Turn a host tool call into a structured Action. `null` means the call cannot
 * touch the repository (pure read tools without a path, host meta tools).
 */
export function actionFromToolCall(tool: string, params: Record<string, unknown>): Action | null {
  const name = normalized(tool)
  const classification = classifyTool(name)

  if (classification.category === 'write' || WRITE_TOOLS.has(name)) {
    const path = filePath(params)
    if (!path) return null
    const content =
      stringParam(params, ['content', 'new_string', 'text', 'newText', 'code']) ??
      (typeof params.patch === 'string' ? params.patch : undefined)
    const to = renameTarget(params)
    if (name === 'move_file' || name === 'rename' || (to !== undefined && name.includes('move'))) {
      const action: Action = { kind: 'rename', tool, path, toPath: to }
      return action
    }
    if (name === 'delete_file') return { kind: 'delete', tool, path }
    const action: Action = { kind: 'write', tool, path }
    if (content !== undefined) action.content = content
    return action
  }

  if (classification.category === 'shell' && name !== 'run_code') {
    const command = stringParam(params, ['command', 'cmd', 'script'])
    if (!command) return null
    const cwd = stringParam(params, ['cwd', 'workdir', 'workingDirectory', 'working_directory'])
    const action: Action = { kind: 'shell', tool, command }
    if (cwd !== undefined) action.cwd = cwd
    return action
  }

  if (name === 'run_code') {
    const detail = stringParam(params, ['code', 'script', 'command'])
    return { kind: 'other', tool, detail }
  }

  if (classification.category === 'delegate') {
    const target = stringParam(params, ['name', 'target', 'subagent_type', 'agent', 'to'])
    if (target !== undefined) return { kind: 'delegate', tool, target }
    return { kind: 'delegate', tool }
  }

  if (classification.category === 'mcp') {
    // Try to recognise a write/command call from parameters before giving up.
    const path = filePath(params)
    if (path) {
      const content = stringParam(params, ['content', 'text', 'new_string', 'body', 'data'])
      const action: Action = { kind: 'write', tool, path }
      if (content !== undefined) action.content = content
      return action
    }
    const command = stringParam(params, ['command', 'cmd', 'script'])
    if (command) return { kind: 'shell', tool, command }
    return { kind: 'mcp', tool }
  }

  if (classification.category === 'read') {
    if (name === 'read' || name === 'read_file') {
      const path = filePath(params)
      if (!path) return null
      return { kind: 'read', tool, path }
    }
    return null
  }

  if (classification.category === 'flowgate') {
    return { kind: 'other', tool }
  }

  return { kind: 'other', tool, detail: '未分类工具调用' }
}
