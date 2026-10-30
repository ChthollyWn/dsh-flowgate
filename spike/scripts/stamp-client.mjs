/**
 * 把 tsdown 产出的普通 CJS 客户端 bundle 包装成 DSH 浏览器加载器认识的形状：
 *
 *   window.__ModuleLoader__.load({
 *     id: '<npm 包名>',
 *     factory: (require) => { <tsdown CJS 产物>; return module.exports },
 *   })
 *
 * factory 内只能 require 模块表里已有的名字（react、react/jsx-runtime、
 * @deepseek-ai/dsh-client-ui-primitives 等 baseline，以及 dsh.client.external 里声明的）。
 * 这里直接用 tsdown 的 CJS 输出当 factory 体：tsdown 的 CJS 产物会自己维护
 * module/exports 变量吗？不会 —— 所以这里用 `new Function('require','module','exports', code)` 方式
 * 只是最省事的包装，正式实现建议对齐官方/第三方插件（如 @michengai/dsh-codex-ui）的
 * 产物：`var module = { exports: {} }; var exports = module.exports; <code>; return module.exports`。
 * 本脚本按后者做文本拼接，产物见 lib/client.js 头部。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const id = pkg.name

const raw = await readFile(new URL('../lib.tmp/client.cjs', import.meta.url), 'utf8')

// tsdown 的 CJS 产物以 `"use strict";` + 一系列顶层声明开头，并写 `exports.xxx = ...`。
// Loader 的 factory 需要自己的 module/exports，所以把产物整体塞进函数体。
const body = raw
  .replace(/^"use strict";\n/, '')
  .replace(/^\/\/# sourceMappingURL=.*$/m, '')

const out = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    module.exports.name = ${JSON.stringify(id)};
    if (!module.exports.inject) module.exports.inject = ['slots', 'sidebarRightTabs'];
    return module.exports;
  }
});
//# sourceMappingURL=client.cjs.map
`
await writeFile(new URL('../lib/client.js', import.meta.url), out)
console.log('[stamp-client] wrote lib/client.js', out.length, 'bytes')
