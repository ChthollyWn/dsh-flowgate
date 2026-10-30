/**
 * tsdown 双入口配置（spike 实测通过）。
 *
 * 关键点：
 * 1. host 入口：ESM，platform 'node'，@deepseek-ai/* 全部 external（由宿主 profile 的
 *    node_modules 提供，不能打进包里，否则 Service 单例/类型身份会分裂）。
 * 2. client 入口：CJS + 包装成 `window.__ModuleLoader__.load({ id, factory })`。
 *    dsh 0.2.1-rc.5 没有发布官方的 client 构建预设包，所以用 tsdown 的
 *    `outputOptions.footer` + 一点文本包裹最省事：
 *      - 先按 cjs 输出 client 代码（factory 函数体）
 *      - footer 关闭 static 导出，改为 `window.__ModuleLoader__.load({...})`
 *    见 scripts/stamp-client.mjs：把 tsdown 的 cjs 产物包进 load() 调用。
 *
 * 若 tsdown 升版把 footer/banner 移进 rolldown 的 outputOptions，改这里即可；
 * 另一条等价路径是自写 rolldown plugin 的 renderChunk/generateBundle 钩子。
 */
import { defineConfig } from 'tsdown'

const EXTERNAL = [
  /^@deepseek-ai\//,
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
]

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    sourcemap: true,
    external: EXTERNAL,
    outExtensions: () => ({ js: '.js' }),
    clean: false,
    // host 半侧不需要 footer；保持纯 ESM 具名导出（apply / inject / name / Config）
  },
  {
    entry: { client: 'src/client.tsx' },
    outDir: 'lib.tmp', // 先构建成普通 CJS，再由 scripts/stamp-client.mjs 包成 load({...})
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    external: EXTERNAL,
    clean: true,
    outExtensions: () => ({ js: '.cjs' }),
  },
])
