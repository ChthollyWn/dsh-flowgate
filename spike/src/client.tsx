/**
 * FlowGate 最小可加载插件 —— Client 入口（spike）。
 *
 * 产物形态（tsdown 构建 + stamp 之后）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... return module.exports } })
 * factory 里的 module.exports 必须是 Cordis 客户端插件：{ name, inject, apply }。
 *
 * 两个插槽：
 *   1. conversation.input.dock —— list 类、session scope（输入框上方状态条）
 *   2. sidebar.right.pane.tab  —— keyed 类、session scope；key = tab 定义 id（右侧栏 tab）
 * 右侧栏必须先 ctx.sidebarRightTabs.register(def)（stage 1：这个 tab 类型是什么），
 * 再 ctx.slots.register({ name: 'sidebar.right.pane.tab', key: def.id })（stage 2：body）。
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-flowgate-spike'
/** 客户端服务名：插槽注册表 + 右侧栏 tab 注册表。 */
export const inject = ['slots', 'sidebarRightTabs']

/** 输入框 dock：一行状态条，点击把 `/flow status` 填进输入框（无 Remote 时的兜底路径）。 */
function FlowGateDock(_props: Record<string, unknown>) {
  const [status, setStatus] = React.useState('FlowGate · /flow init 启用')
  return React.createElement(
    'div',
    {
      className: 'flowgate-dock',
      style: { fontSize: 12, opacity: 0.8, padding: '2px 8px' },
      onClick: () => setStatus('FlowGate · 已复制 /flow status（spike）'),
      title: 'FlowGate 开发流程门禁',
    },
    status,
  )
}

/** 右侧栏面板：FlowGate 面板骨架。 */
function FlowGatePanel(_props: Record<string, unknown>) {
  return React.createElement(
    'div',
    { style: { padding: 12, display: 'grid', gap: 8 } },
    React.createElement('h3', { style: { margin: 0 } }, 'FlowGate'),
    React.createElement('p', { style: { margin: 0, opacity: 0.7 } }, '阶段、任务、待处理项（spike 占位）。'),
    React.createElement('button', { disabled: true }, '刷新（spike 未接宿主 Remote）'),
  )
}

export function apply(ctx: Context) {
  // 1. 输入框 dock（list slot：需要 id）
  ctx.slots.register(
    { name: 'conversation.input.dock', id: 'flowgate-status', order: 50 },
    FlowGateDock as never,
  )

  // 2. 右侧栏 tab：两段式注册
  const disposeType = ctx.sidebarRightTabs.register({
    id: 'flowgate-panel', // 全局唯一的实现身份，也是 body/title 插槽的 key
    kind: 'flowgate.panel', // 类型判别键，openTab 用
    multiple: false,
    title: () => 'FlowGate',
    guide: [{ id: 'flowgate', order: 100, title: () => 'FlowGate', description: () => '流程门禁面板' }],
  })
  ctx.effect(() => disposeType, 'flowgate-spike: sidebarRightTabs')

  ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: 'flowgate-panel' },
    FlowGatePanel as never,
  )
}
