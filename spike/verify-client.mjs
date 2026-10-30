/**
 * Client 半侧构建产物验证（不需要浏览器 / DSH 进程）：
 *   node verify-client.mjs
 *
 * 1. 模拟浏览器模块表：把 window.__ModuleLoader__ 换成一个记录器
 * 2. eval lib/client.js（它只应调用 load({id, factory})）
 * 3. 用假的 require 提供 react（只用到 createElement / useState）
 * 4. 调 factory 拿到 plugins 导出，断言 { name, inject, apply }
 * 5. 用假 ctx 调 apply，断言两个插槽 + 两段式 sidebar 注册真的发生
 */
import { readFile } from 'node:fs/promises'

const registrations = []
let loaded = null

globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      loaded = spec
    },
  },
}

const code = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-eval
eval(code)

if (!loaded || !loaded.id) throw new Error('client bundle 没有调用 window.__ModuleLoader__.load({id})')
console.log('=== loader id ===', loaded.id)

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}
const requireShim = (name) => {
  if (name === 'react' || name === 'react/jsx-runtime') {
    if (name === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement }
    return fakeReact
  }
  throw new Error('client bundle 请求了模块表之外或不存在的模块: ' + name)
}
const exportsObj = loaded.factory(requireShim)
console.log('=== client plugin 导出 ===', Object.keys(exportsObj), '| name =', exportsObj.name, '| inject =', JSON.stringify(exportsObj.inject))
if (typeof exportsObj.apply !== 'function') throw new Error('client 入口没有 apply')

const slots = []
const tabs = []
const fakeCtx = {
  effect: (fn) => {
    const dispose = typeof fn === 'function' ? fn() : undefined
    return dispose
  },
  slots: {
    register: (options, component) => {
      slots.push({ options, component })
      return () => {}
    },
    inject: (_name, fn) => fn(),
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabs.push(definition)
      return () => {}
    },
  },
}
exportsObj.apply(fakeCtx)

console.log('\n=== slots 注册 ===')
for (const s of slots) console.log('  ', JSON.stringify(s.options), 'component =', typeof s.component)
console.log('=== sidebarRightTabs 注册 ===')
for (const t of tabs) console.log('  ', JSON.stringify(t))

const names = slots.map((s) => s.options.name)
if (!names.includes('conversation.input.dock')) throw new Error('缺少 conversation.input.dock')
if (!names.includes('sidebar.right.pane.tab')) throw new Error('缺少 sidebar.right.pane.tab')
if (tabs.length !== 1) throw new Error('sidebarRightTabs.register 没有注册')
if (slots.find((s) => s.options.name === 'sidebar.right.pane.tab').options.key !== tabs[0].id) {
  throw new Error('sidebar.right.pane.tab 的 key 必须等于 tab 定义的 id')
}
console.log('\nOK: client bundle 形态合法，dock 与右侧栏 tab 注册路径正确')
