import { describe, expect, it } from 'vitest'
import {
  BLOCKED_DELEGATION_TOOLS,
  actionFromToolCall,
  classifyTool,
} from '../../../src/core/rules/toolclass'

describe('rules/toolclass — 工具分类与覆盖自检（03 §4.3）', () => {
  it('classifies file tools, shell tools, delegation and FlowGate tools', () => {
    expect(classifyTool('read')).toMatchObject({ category: 'read', covered: true, actionKind: 'read' })
    expect(classifyTool('grep')).toMatchObject({ category: 'read', covered: true })
    expect(classifyTool('write')).toMatchObject({ category: 'write', covered: true, actionKind: 'write' })
    expect(classifyTool('edit')).toMatchObject({ category: 'write', covered: true })
    expect(classifyTool('bash')).toMatchObject({ category: 'shell', covered: true, actionKind: 'shell' })
    expect(classifyTool('pwsh')).toMatchObject({ category: 'shell', covered: true })
    expect(classifyTool('subagent')).toMatchObject({ category: 'delegate', covered: true })
    expect(classifyTool('workflow')).toMatchObject({ category: 'delegate', covered: true })
    expect(classifyTool('send_message')).toMatchObject({ category: 'delegate', covered: true })
    expect(classifyTool('flow_status')).toMatchObject({ category: 'flowgate', covered: true })
    expect(classifyTool('flow_evaluate')).toMatchObject({ category: 'flowgate', covered: true })
  })

  it('marks run_code as shell-classified but blocked in managed sessions', () => {
    expect(classifyTool('run_code')).toMatchObject({ category: 'shell', covered: true })
    expect(BLOCKED_DELEGATION_TOOLS).toEqual([
      'subagent',
      'subagent_fork',
      'workflow',
      'send_message',
      'run_code',
    ])
  })

  it('marks MCP and unknown tools as uncovered so gates can fall back to human', () => {
    const mcp = classifyTool('mcp__filesystem__write_file')
    expect(mcp.category).toBe('mcp')
    expect(mcp.covered).toBe(false)
    expect(mcp.reason).toContain('MCP')

    const unknown = classifyTool('totally_new_tool')
    expect(unknown.category).toBe('unknown')
    expect(unknown.covered).toBe(false)
    expect(unknown.reason).toContain('未知工具')
  })

  it('treats host metadata tools as covered non-writes (no false coverage alarms)', () => {
    for (const tool of ['todo_write', 'ask_user_question', 'schedule_create', 'team_task_list', 'present', 'structured_output']) {
      const classification = classifyTool(tool)
      expect(classification.covered, tool).toBe(true)
      expect(classification.category, tool).toBe('read')
    }
  })

  it('uses schema keys to classify unknown write/command tools', () => {
    const writeLike = classifyTool('mystery_writer', ['path', 'content'])
    expect(writeLike).toMatchObject({ category: 'write', covered: true })
    const shellLike = classifyTool('mystery_runner', ['command'])
    expect(shellLike).toMatchObject({ category: 'shell', covered: true })
    expect(classifyTool('mystery_reader', ['url', 'query'])).toMatchObject({
      category: 'unknown',
      covered: false,
    })
  })
})

describe('rules/toolclass — actionFromToolCall', () => {
  it('extracts write actions and keeps the content for secret detection', () => {
    const write = actionFromToolCall('write', { path: './src/main/java/A.java', content: 'hello' })
    expect(write).toEqual({ kind: 'write', tool: 'write', path: './src/main/java/A.java', content: 'hello' })
    const edit = actionFromToolCall('edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
    expect(edit).toMatchObject({ kind: 'write', path: 'src/a.ts', content: 'b' })
    expect(actionFromToolCall('write', {})).toBeNull()
  })

  it('extracts rename/delete actions', () => {
    expect(actionFromToolCall('move_file', { path: 'a.ts', to: 'b.ts' })).toMatchObject({
      kind: 'rename',
      path: 'a.ts',
      toPath: 'b.ts',
    })
    expect(actionFromToolCall('delete_file', { path: 'a.ts' })).toMatchObject({ kind: 'delete' })
  })

  it('extracts shell actions with cwd', () => {
    expect(actionFromToolCall('bash', { command: 'pnpm test', cwd: '/repo' })).toEqual({
      kind: 'shell',
      tool: 'bash',
      command: 'pnpm test',
      cwd: '/repo',
    })
    expect(actionFromToolCall('bash', {})).toBeNull()
  })

  it('extracts read actions for file reads and ignores search tools', () => {
    expect(actionFromToolCall('read', { path: 'src/.env' })).toEqual({
      kind: 'read',
      tool: 'read',
      path: 'src/.env',
    })
    expect(actionFromToolCall('grep', { pattern: 'x' })).toBeNull()
    expect(actionFromToolCall('glob', { pattern: '**/*.ts' })).toBeNull()
    expect(actionFromToolCall('read', {})).toBeNull()
  })

  it('extracts delegation actions with the optional target', () => {
    expect(actionFromToolCall('subagent', { name: 'reviewer' })).toEqual({
      kind: 'delegate',
      tool: 'subagent',
      target: 'reviewer',
    })
    expect(actionFromToolCall('workflow', {})).toEqual({ kind: 'delegate', tool: 'workflow' })
  })

  it('recognises MCP writes by parameters and otherwise keeps them generic', () => {
    expect(actionFromToolCall('mcp__fs__write', { path: 'src/a.ts', content: 'x' })).toMatchObject({
      kind: 'write',
      path: 'src/a.ts',
    })
    expect(actionFromToolCall('mcp__sh__run', { command: 'rm x' })).toMatchObject({
      kind: 'shell',
      command: 'rm x',
    })
    expect(actionFromToolCall('mcp__unknown__thing', { foo: 1 })).toEqual({
      kind: 'mcp',
      tool: 'mcp__unknown__thing',
    })
  })

  it('classifies flow tools and unclassified tools as generic actions', () => {
    expect(actionFromToolCall('flow_task_done', { taskId: 'T3' })).toEqual({
      kind: 'other',
      tool: 'flow_task_done',
    })
    const unknown = actionFromToolCall('totally_new_tool', { foo: 'bar' })
    expect(unknown).toMatchObject({ kind: 'other', tool: 'totally_new_tool' })
    expect(actionFromToolCall('run_code', { code: 'console.log(1)' })).toMatchObject({
      kind: 'other',
      tool: 'run_code',
    })
  })
})
