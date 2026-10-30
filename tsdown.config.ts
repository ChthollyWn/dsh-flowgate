import { defineConfig } from 'tsdown'

/**
 * Two halves of the plugin:
 *
 *   lib/host.js   ESM Node half. A plain Cordis plugin (named exports apply /
 *                 inject / name). It never imports @deepseek-ai/* at runtime —
 *                 DSH services come in through `ctx`, and DSH types are local
 *                 structural interfaces — so nothing host-core is bundled.
 *
 *   lib/client.js Browser half. Produced in two steps: tsdown emits a plain
 *                 CJS bundle into lib.tmp/client.cjs, then
 *                 scripts/build-client.mjs wraps it in the DSH module-loader
 *                 protocol:
 *                   window.__ModuleLoader__.load({ id, factory: (require) => ... })
 *                 Shared platform modules (react, DSH client packages) stay
 *                 external and are resolved by the loader's `require`.
 */
const HOST_EXTERNALS = [/^@deepseek-ai\//, /^node:/]

const CLIENT_EXTERNALS = [
  /^@deepseek-ai\//,
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
]

export default defineConfig([
  {
    entry: { host: 'src/host/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: true,
    sourcemap: true,
    dts: false,
    external: HOST_EXTERNALS,
    noExternal: [/.*/],
    outExtensions: () => ({ js: '.js' }),
  },
  {
    // Owner-side E2E/recovery CLI (dev tooling; tools/ is not published).
    entry: { admin: 'src/dev/admin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'tools',
    clean: true,
    sourcemap: false,
    dts: false,
    external: HOST_EXTERNALS,
    noExternal: [/.*/],
    outExtensions: () => ({ js: '.js' }),
  },
  {
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib.tmp',
    clean: true,
    sourcemap: false,
    dts: false,
    external: CLIENT_EXTERNALS,
    outExtensions: () => ({ js: '.cjs' }),
  },
])
