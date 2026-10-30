/**
 * Minimal filesystem port used by every core module.
 *
 * Core code never imports `node:fs` directly so that every decision path can be
 * unit-tested against an in-memory filesystem and replayed deterministically.
 * The host adapter provides the real implementation.
 */
export interface FileSystem {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  appendFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** File size in bytes; used for evidence retention and large-file guards. */
  statSize(path: string): Promise<number>
  /** Modification time in milliseconds since epoch. */
  mtimeMs(path: string): Promise<number>
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}
