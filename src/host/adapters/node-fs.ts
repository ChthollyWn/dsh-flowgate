/**
 * `FileSystem` 端口的 Node 实现（core/util/fs.ts 的接口）。
 *
 * 语义约定（见 core/util/memory-fs.ts 与 core/store/layout.ts 注释）：
 * - core 传入的路径是**仓库相对路径**（正斜杠、无 `./` 前缀）；偶尔也会传绝对路径
 *   （engine.root 是绝对路径时，layout() 生成的路径就是绝对路径）。
 * - 因此本适配器：绝对路径原样使用，相对路径以项目根为基准解析。
 * - 目录语义与 MemoryFileSystem 对齐：readdir 返回一层的条目名（文件与目录名合并去重排序）。
 * - 所有错误保持 Node 原始错误（带 code），由上层翻译成 {error,hint}。
 */
import type { FileSystem } from '../../core/util/fs'
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'

/** 判断路径是否已经是绝对路径（POSIX 与 Windows 盘符两类写法）。 */
export function isAbsolutePath(input: string): boolean {
  if (input.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(input)) return true
  if (input.startsWith('\\\\')) return true
  return false
}

/** 把 Windows 分隔符统一成正斜杠（core 内部一律正斜杠）。 */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/')
}

export class NodeFileSystem implements FileSystem {
  /** 项目根绝对路径；相对路径一律相对它解析。 */
  readonly root: string

  constructor(root: string) {
    this.root = nodePath.resolve(root)
  }

  /** 把 core 传入的路径解析成宿主绝对路径。 */
  resolve(input: string): string {
    if (isAbsolutePath(input)) return nodePath.normalize(input)
    return nodePath.resolve(this.root, input)
  }

  async readFile(path: string): Promise<string> {
    return fsp.readFile(this.resolve(path), 'utf8')
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.resolve(path)
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, 'utf8')
  }

  async appendFile(path: string, content: string): Promise<void> {
    const target = this.resolve(path)
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.appendFile(target, content, 'utf8')
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(path))
      return true
    } catch {
      return false
    }
  }

  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(this.resolve(path), { recursive: true })
  }

  async readdir(path: string): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.resolve(path), { withFileTypes: true })
      const names = new Set(entries.map((entry) => entry.name))
      return [...names].sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async remove(path: string): Promise<void> {
    await fsp.rm(this.resolve(path), { recursive: true, force: true })
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.resolve(to)
    await fsp.mkdir(nodePath.dirname(target), { recursive: true })
    await fsp.rename(this.resolve(from), target)
  }

  async statSize(path: string): Promise<number> {
    const stat = await fsp.stat(this.resolve(path))
    return stat.size
  }

  async mtimeMs(path: string): Promise<number> {
    const stat = await fsp.stat(this.resolve(path))
    return stat.mtimeMs
  }
}
