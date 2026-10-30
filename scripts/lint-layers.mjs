#!/usr/bin/env node
/**
 * Layering guard (T0.3): the pure core must stay independent from DSH and from
 * the host/client layers; the browser bundle must not pull Node builtins or
 * host code. Run via `pnpm lint`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

const errors = []

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

function moduleSpecifiers(source) {
  const specs = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source)) !== null) specs.push({ spec: match[1], index: match.index })
  }
  return specs
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function isTypeOnlyImport(source, index) {
  const start = Math.max(0, index - 40)
  const snippet = source.slice(start, index)
  return /import\s+type\s*$/.test(snippet) || /import\s*\{\s*type\s/.test(snippet)
}

const files = await walk(SRC)
for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const source = await readFile(file, 'utf8')
  for (const { spec, index } of moduleSpecifiers(source)) {
    const line = lineOf(source, index)
    if (rel.startsWith('src/core/')) {
      if (spec.startsWith('@deepseek-ai/')) {
        errors.push(`${rel}:${line} core 不得依赖 DSH 包（${spec}）`)
      }
      if (spec.includes('/host/') || spec.includes('/client/') || spec.startsWith('../host') || spec.startsWith('../client')) {
        errors.push(`${rel}:${line} core 不得依赖 host/client 层（${spec}）`)
      }
      if (spec.startsWith('node:fs') || spec === 'fs' || spec === 'fs/promises') {
        errors.push(`${rel}:${line} core 必须通过 FileSystem 端口访问文件系统，不得直接 import ${spec}`)
      }
      if (spec.startsWith('node:child_process') || spec === 'child_process') {
        errors.push(`${rel}:${line} core 必须通过 CommandRunner 端口执行命令，不得直接 import ${spec}`)
      }
      if (spec.startsWith('react') || spec.includes('/client/')) {
        errors.push(`${rel}:${line} core 不得依赖浏览器/React 代码（${spec}）`)
      }
    }
    if (rel.startsWith('src/host/')) {
      if (spec.startsWith('../../client/') || spec.startsWith('../client/')) {
        errors.push(`${rel}:${line} host 不得依赖 client 层（${spec}）`)
      }
      if (spec.startsWith('@deepseek-ai/')) {
        // Host may import a tiny allowlist of DSH value APIs as peerDependencies
        // (externalized at build time). Types stay local & structural.
        const HOST_DSH_ALLOWLIST = ['@deepseek-ai/dsh-session']
        if (!HOST_DSH_ALLOWLIST.includes(spec)) {
          errors.push(`${rel}:${line} host 只允许 import 白名单里的 DSH 包 [${HOST_DSH_ALLOWLIST.join(', ')}]，当前 ${spec}；其余请用本地结构性类型`)
        }
      }
      if (spec.startsWith('react')) {
        errors.push(`${rel}:${line} host 是 Node 侧代码，不得依赖 React（${spec}）`)
      }
    }
    if (rel.startsWith('src/client/')) {
      if (spec.startsWith('node:')) errors.push(`${rel}:${line} client 不得依赖 Node 内置模块（${spec}）`)
      if (spec.startsWith('../host') || spec.startsWith('../../host')) errors.push(`${rel}:${line} client 不得依赖 host 层（${spec}）`)
      if (spec.includes('../core/') || spec.startsWith('../core')) {
        if (!isTypeOnlyImport(source, index) && !spec.endsWith('/types')) {
          errors.push(`${rel}:${line} client 只能用 import type 引用 core 类型（${spec}）`)
        }
      }
      if (spec.startsWith('@deepseek-ai/')) {
        errors.push(`${rel}:${line} client 不得在源码 import DSH 包（用运行时 require/ctx，${spec}）`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error('分层规则检查失败：\n')
  for (const error of errors) console.error(`  ✗ ${error}`)
  console.error(`\n共 ${errors.length} 处违规。`)
  process.exit(1)
}
console.log(`分层规则检查通过（${files.length} 个源文件）。`)
