#!/usr/bin/env node
/**
 * Verify the built browser bundle without a browser or a DSH process.
 *
 * 1. Replace `window.__ModuleLoader__` with a recorder.
 * 2. Evaluate lib/client.js — it must only call load({ id, factory }).
 * 3. Provide a fake `require` for react / react-dom shared modules.
 * 4. Materialise the factory and assert the plugin exports { name, inject, apply }.
 * 5. Call apply() with a fake client ctx and assert the two slot registrations
 *    and the two-stage right-sidebar tab registration really happen.
 *
 * Run after `pnpm build`: `pnpm verify:client`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

const code = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
// eslint-disable-next-line no-eval
eval(code)

if (!loaded || !loaded.id) {
  console.error('✗ lib/client.js 没有调用 window.__ModuleLoader__.load({id})（先运行 pnpm build）')
  process.exit(1)
}
if (loaded.id !== pkg.name) {
  console.error(`✗ loader id "${loaded.id}" 与包名 "${pkg.name}" 不一致`)
  process.exit(1)
}

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  Fragment: Symbol('Fragment'),
}
const requireShim = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') {
    return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: fakeReact.Fragment }
  }
  if (name === 'react-dom') return { createPortal: (node) => node }
  if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`client bundle 请求了模块表之外的模块：${name}`)
}

const fallbackT = (key) => key

let plugin
try {
  plugin = loaded.factory(requireShim)
} catch (error) {
  console.error(`✗ client factory 物化失败：${error.message}`)
  process.exit(1)
}

const missing = ['name', 'inject', 'apply'].filter((key) => !(key in plugin))
if (missing.length > 0) {
  console.error(`✗ client 插件缺少导出：${missing.join(', ')}`)
  process.exit(1)
}
if (plugin.name !== pkg.name) {
  console.error(`✗ client 插件 name "${plugin.name}" 与包名不一致`)
  process.exit(1)
}

const slots = []
const tabs = []
const effects = []
const fakeCtx = {
  logger: { warn() {}, info() {}, debug() {}, error() {} },
  effect(fn) {
    effects.push(fn)
    const dispose = typeof fn === 'function' ? fn() : undefined
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  /** Deferred injection: run the callback now because all fake services exist. */
  inject(deps, callback) {
    const missing = (Array.isArray(deps) ? deps : []).filter((dep) => fakeCtx[dep] === undefined)
    if (missing.length > 0) return
    callback(fakeCtx)
  },
  sessions: { get: () => undefined, list: () => [] },
  sidebarRight: { openTab() {} },
  conversation: { input: { for: () => ({ setDraft() {}, focus() {} }) } },
  remote: {},
  locale: { register() {}, bind: () => fallbackT },
  slots: {
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
    inject(_name, fn) {
      fn()
    },
  },
  sidebarRightTabs: {
    register(definition) {
      tabs.push(definition)
      return () => {}
    },
  },
}

try {
  plugin.apply(fakeCtx)
} catch (error) {
  console.error(`✗ client apply() 抛错：${error.message}`)
  process.exit(1)
}

const names = slots.map((slot) => slot.options?.name)
const problems = []
if (!names.includes('conversation.input.dock')) problems.push('缺少 conversation.input.dock 注册（输入框状态条）')
if (!names.includes('sidebar.right.pane.tab')) problems.push('缺少 sidebar.right.pane.tab 注册（右侧栏面板）')
if (tabs.length === 0) problems.push('缺少 sidebarRightTabs.register（右侧栏 tab 类型）')
const pane = slots.find((slot) => slot.options?.name === 'sidebar.right.pane.tab')
if (pane && tabs[0] && pane.options.key !== tabs[0].id) {
  problems.push(`sidebar.right.pane.tab 的 key (${pane.options.key}) 必须等于 tab 定义的 id (${tabs[0].id})`)
}
for (const slot of slots) {
  if (typeof slot.component !== 'function') problems.push(`插槽 ${slot.options?.name} 的组件不是函数`)
}

if (problems.length > 0) {
  console.error('✗ client bundle 验证失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`✓ client bundle 合法：id=${loaded.id}，导出 ${Object.keys(plugin).join('/')}，${slots.length} 个插槽、${tabs.length} 个右栏 tab。`)
console.log(`  插槽：${slots.map((slot) => `${slot.options.name}${slot.options.key ? `#${slot.options.key}` : ''}`).join(', ')}`)
