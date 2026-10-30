/**
 * 写入会话日志的插件记录（H6 确认路径）。
 *
 * rc.5 官方逃生舱是 `appendPluginRecord(session, 'plugin:<owner>/<record>', data)`
 * （见 docs/impl/dsh-plugin-api-cheatsheet.md §5.6/§10-3）：
 * - 事件标记 `ignorable: true`，不进模型可见面，fork/resume 会带上；
 * - 投影在自己的 `apply` 里按事件 type 字符串折叠。
 *
 * 为什么用「非字面量动态 import」而不是静态 import：
 * - 我们的包不把 @deepseek-ai/* 放进 dependencies，本地开发/单测环境没有该包；
 * - tsdown 输出 ESM，动态 import 保留到运行时，由真实宿主进程解析；
 * - 解析失败时自动降级为 `session.append('plugin:...')`（rc.5 运行时接受任意
 *   type；仅持久化层面风险更高，doctor 会报告降级），再不行则只更新内存投影。
 */

/** 我们写入会话日志的插件记录类型（投影 apply 用字符串比较折叠）。 */
export const FLOWGATE_RECORD_PREFIX = 'plugin:dsh-flowgate/'

/** 会话投影状态记录的类型名。 */
export const STATE_RECORD_TYPE = `${FLOWGATE_RECORD_PREFIX}state`

export interface PluginSessionApi {
  appendPluginRecord(session: unknown, type: string, data: Record<string, unknown>): unknown
}

let cachedApi: PluginSessionApi | null | undefined

/** 尝试加载 `@deepseek-ai/dsh-session` 的 appendPluginRecord；失败缓存 null。 */
export async function loadPluginSessionApi(): Promise<PluginSessionApi | null> {
  if (cachedApi !== undefined) return cachedApi
  try {
    const specifier = '@deepseek-ai/dsh-session'
    const mod = (await import(/* @vite-ignore */ specifier)) as { appendPluginRecord?: unknown }
    if (typeof mod.appendPluginRecord === 'function') {
      cachedApi = { appendPluginRecord: mod.appendPluginRecord as PluginSessionApi['appendPluginRecord'] }
      return cachedApi
    }
  } catch {
    // 宿主未暴露该包（例如隔离测试环境）：降级。
  }
  cachedApi = null
  return cachedApi
}

/** 测试用：重置缓存。 */
export function resetPluginSessionApiForTest(api?: PluginSessionApi | null): void {
  cachedApi = api
}
