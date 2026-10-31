/**
 * 用系统默认程序打开本地文件（T5.3：「/flow report 生成并打开」「/flow board 打开」）。
 *
 * 宿主是普通 Node 进程：macOS 用 `open`、Linux 用 `xdg-open`、Windows 用
 * `cmd /c start`。打不开（headless/CI/无桌面）时返回 false，由调用方退回
 * "已生成，路径是 …"，不当作失败。
 */
import { spawn } from 'node:child_process'
import * as nodePath from 'node:path'
import type { HostRuntime } from './runtime.js'

export interface OpenResult {
  opened: boolean
  message: string
}

/** 打开仓库相对路径（不存在时按运行时根解析）。 */
export async function openLocalPath(runtime: HostRuntime, relativePath: string): Promise<OpenResult> {
  const root = runtime.root()
  const absolute = nodePath.isAbsolute(relativePath)
    ? relativePath
    : nodePath.resolve(root === null || root === '' ? process.cwd() : root, relativePath)
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [absolute]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', absolute]]
        : ['xdg-open', [absolute]]
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args as string[], { detached: true, stdio: 'ignore' })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return { opened: true, message: `已用系统默认程序打开：${absolute}` }
  } catch (error) {
    return { opened: false, message: `已生成 ${absolute}；当前环境无法自动打开（${error instanceof Error ? error.message : String(error)}），请手动打开。` }
  }
}
