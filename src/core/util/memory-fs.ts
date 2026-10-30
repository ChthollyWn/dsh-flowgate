import type { FileSystem } from './fs'
import { normalizeRelPath } from './paths'

interface Entry {
  content: string
  mtimeMs: number
}

/**
 * In-memory FileSystem used by core unit tests and replay tests.
 * Directory semantics are implicit: a path exists when a file exists at or
 * below it, or when it was explicitly created with mkdir.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, Entry>()
  private readonly dirs = new Set<string>()
  private clock = 1_700_000_000_000
  /** Optional fault injection: throw on reads/writes matching a substring. */
  failOn: string | null = null

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(normalizeRelPath(path), { content, mtimeMs: this.clock++ })
  }

  private guard(path: string): void {
    if (this.failOn && path.includes(this.failOn)) throw new Error(`injected fs failure: ${path}`)
  }

  async readFile(path: string): Promise<string> {
    const key = normalizeRelPath(path)
    this.guard(key)
    const entry = this.files.get(key)
    if (!entry) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT', path: key })
    return entry.content
  }

  async writeFile(path: string, content: string): Promise<void> {
    const key = normalizeRelPath(path)
    this.guard(key)
    this.files.set(key, { content, mtimeMs: this.clock++ })
    this.ensureParentDirs(key)
  }

  async appendFile(path: string, content: string): Promise<void> {
    const key = normalizeRelPath(path)
    this.guard(key)
    const prev = this.files.get(key)?.content ?? ''
    this.files.set(key, { content: prev + content, mtimeMs: this.clock++ })
    this.ensureParentDirs(key)
  }

  async exists(path: string): Promise<boolean> {
    const key = normalizeRelPath(path)
    if (this.files.has(key)) return true
    if (this.dirs.has(key)) return true
    for (const file of this.files.keys()) {
      if (file.startsWith(`${key}/`)) return true
    }
    return false
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(normalizeRelPath(path))
  }

  async readdir(path: string): Promise<string[]> {
    const key = normalizeRelPath(path)
    const prefix = key === '' ? '' : `${key}/`
    const out = new Set<string>()
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue
      const rest = file.slice(prefix.length)
      const first = rest.split('/')[0]
      if (first) out.add(first)
    }
    return [...out].sort()
  }

  async remove(path: string): Promise<void> {
    const key = normalizeRelPath(path)
    this.files.delete(key)
    this.dirs.delete(key)
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(`${key}/`)) this.files.delete(file)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeRelPath(from)
    const target = normalizeRelPath(to)
    const entry = this.files.get(source)
    if (!entry) throw Object.assign(new Error(`ENOENT: ${source}`), { code: 'ENOENT' })
    this.files.delete(source)
    this.files.set(target, entry)
  }

  async statSize(path: string): Promise<number> {
    const entry = this.files.get(normalizeRelPath(path))
    if (!entry) throw Object.assign(new Error(`ENOENT: ${normalizeRelPath(path)}`), { code: 'ENOENT' })
    return Buffer.byteLength(entry.content, 'utf8')
  }

  async mtimeMs(path: string): Promise<number> {
    const entry = this.files.get(normalizeRelPath(path))
    if (!entry) throw Object.assign(new Error(`ENOENT: ${normalizeRelPath(path)}`), { code: 'ENOENT' })
    return entry.mtimeMs
  }

  // ----- test helpers -------------------------------------------------
  snapshotFiles(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [path, entry] of this.files) out[path] = entry.content
    return out
  }

  listFiles(): string[] {
    return [...this.files.keys()].sort()
  }

  touchMtime(path: string): void {
    const entry = this.files.get(normalizeRelPath(path))
    if (entry) entry.mtimeMs = this.clock++
  }

  private ensureParentDirs(path: string): void {
    const parts = path.split('/')
    parts.pop()
    while (parts.length > 0) {
      this.dirs.add(parts.join('/'))
      parts.pop()
    }
  }
}
