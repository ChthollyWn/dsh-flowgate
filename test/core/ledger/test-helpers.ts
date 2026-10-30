import { describe, expect, it } from 'vitest'
import { MemoryFileSystem } from '../../../src/core/util/memory-fs'
import type { Clock } from '../../../src/core/util/fs'

export const FIXED_NOW = '2026-11-12T10:31:05+08:00'

/** 固定时钟：所有用例离线、确定。 */
export function fixedClock(iso = FIXED_NOW): Clock {
  return { now: () => new Date(iso) }
}

export const LEDGER_PATH = '.flowgate/state/ledger.jsonl'

export function ledgerFs(seed: Record<string, string> = {}): MemoryFileSystem {
  return new MemoryFileSystem(seed)
}

/** 读取账本文件并按行切分（不含空行）。 */
export async function rawLedgerLines(fs: MemoryFileSystem): Promise<string[]> {
  const raw = await fs.readFile(LEDGER_PATH)
  return raw.split('\n').filter((line) => line.trim() !== '')
}

/** 用篡改后的行覆盖账本文件。 */
export async function writeLedgerLines(fs: MemoryFileSystem, lines: string[]): Promise<void> {
  await fs.writeFile(LEDGER_PATH, `${lines.join('\n')}\n`)
}
