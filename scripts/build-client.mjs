#!/usr/bin/env node
/**
 * Stamp the browser half into the DSH module-loader protocol.
 *
 * tsdown emits lib.tmp/client.cjs as a plain CJS bundle. DSH's web shell loads
 * each plugin bundle by executing:
 *
 *   window.__ModuleLoader__.load({
 *     id: '<package name>',
 *     factory: (require) => { ...; return module.exports },
 *   })
 *
 * The factory receives the shell's `require`, which resolves the shared module
 * table (react, react/jsx-runtime, DSH client modules declared in dsh.client).
 * We therefore wrap the CJS body in a function body with local module/exports,
 * strip the `"use strict"` (kept inside the factory) and the sourcemap comment.
 *
 * Run after `tsdown`: `pnpm build` does both.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const id = pkg.name

let raw
try {
  raw = await readFile(join(ROOT, 'lib.tmp', 'client.cjs'), 'utf8')
} catch {
  console.error('[build-client] 找不到 lib.tmp/client.cjs，请先运行 tsdown（产出的 client bundle）')
  process.exit(1)
}

const body = raw
  .replace(/^"use strict";\n/, '')
  .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
  .replace(/^\/\/#region .*$/gm, '')
  .replace(/\n{3,}/g, '\n\n')

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    module.exports.name = ${JSON.stringify(id)};
    return module.exports;
  }
});
`

await mkdir(join(ROOT, 'lib'), { recursive: true })
await writeFile(join(ROOT, 'lib', 'client.js'), bundle)

const required = typeof pkg.dsh?.client?.external === 'object' ? pkg.dsh.client.external : []
const missing = required.filter((name) => !bundle.includes(name))
if (missing.length > 0) {
  console.error(`[build-client] 注意：以下 dsh.client.external 未在产物中出现（可能未被使用）：${missing.join(', ')}`)
}

console.log(`[build-client] 写出 lib/client.js（${(bundle.length / 1024).toFixed(1)}KB，id=${id}）`)
