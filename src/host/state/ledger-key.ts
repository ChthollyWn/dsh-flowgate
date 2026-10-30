/**
 * 账本 HMAC 密钥的宿主侧管理（03 §9.6 / H16）。
 *
 * 密钥不进仓库：默认 `~/.dsh/flowgate/ledger.key`（目录 0700、文件 0600）。
 * core 只接收密钥内容（`EnginePorts.ledgerKey`），不读写密钥文件。
 */
import * as fsp from 'node:fs/promises'
import * as nodePath from 'node:path'

export interface LedgerKeyOptions {
  randomKeyHex(bytes: number): string
  /** 读取密钥时容忍的空白/换行（避免手写文件带 \n 导致 HMAC 不一致）。 */
  trim?: boolean
}

/** 读取已有密钥；不存在/为空时生成并落盘（0600）。返回密钥字符串。 */
export async function ensureLedgerKey(keyPath: string, options: LedgerKeyOptions): Promise<string> {
  const target = nodePath.resolve(keyPath)
  try {
    const existing = await fsp.readFile(target, 'utf8')
    const key = options.trim === false ? existing : existing.trim()
    if (key.length >= 32) {
      // 尽力收紧权限（失败不阻塞：某些文件系统不支持 chmod）。
      try {
        await fsp.chmod(target, 0o600)
      } catch {
        // 忽略。
      }
      return key
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = options.randomKeyHex(32)
  await fsp.mkdir(nodePath.dirname(target), { recursive: true, mode: 0o700 })
  await fsp.writeFile(target, `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await fsp.chmod(target, 0o600)
  } catch {
    // 忽略。
  }
  return key
}
