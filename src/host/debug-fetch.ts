/**
 * Debug-only fetch tracer (enabled with `FLOWGATE_DEBUG_FETCH=1`).
 *
 * The provider wraps non-LlmError failures as "DeepSeek Messages transport
 * failed" and drops the cause; this tracer records whether the request even
 * reached the network and what the underlying error/status was. Enabled only
 * for E2E diagnosis; not part of normal operation.
 */
import { appendFileSync } from 'node:fs'

export const DEBUG_FETCH_LOG = '/tmp/flowgate-fetch.log'

export function installFetchDebug(): void {
  const globalObject = globalThis as {
    __FLOWGATE_FETCH_WRAPPED__?: boolean
    fetch?: (input: unknown, init?: unknown) => Promise<{ status?: number; ok?: boolean }>
  }
  if (globalObject.__FLOWGATE_FETCH_WRAPPED__) return
  globalObject.__FLOWGATE_FETCH_WRAPPED__ = true
  const original = globalObject.fetch
  if (typeof original !== 'function') return
  const log = (line: string): void => {
    try {
      appendFileSync(DEBUG_FETCH_LOG, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* ignore */
    }
  }
  log('[flowgate] fetch tracer installed')
  globalObject.fetch = async (input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { url?: string } | null | undefined)?.url ?? String(input)
    try {
      const response = await original(input, init)
      log(`HTTP ${response.status ?? '?'} ${url}`)
      const requestBody = (init as { body?: unknown } | undefined)?.body
      if (/\/messages/.test(url) && typeof requestBody === 'string') {
        try {
          const parsed = JSON.parse(requestBody) as { stream?: boolean; tools?: unknown[]; max_tokens?: number }
          log(
            `  request: bytes=${requestBody.length} stream=${String(parsed.stream)} tools=${parsed.tools?.length ?? 0} max_tokens=${parsed.max_tokens ?? '?'}`,
          )
        } catch {
          log(`  request: bytes=${requestBody.length} (not JSON string)`)
        }
      }
      const cloneable = response as unknown as { clone?: () => { text(): Promise<string>; headers?: { get?(name: string): string | null } } }
      if (/\/messages/.test(url) && typeof cloneable.clone === 'function') {
        const copy = cloneable.clone()
        const contentType = copy.headers?.get?.('content-type') ?? '?'
        void copy
          .text()
          .then((text: string) => {
            log(`  response: ctype=${contentType} bytes=${text.length} head=${JSON.stringify(text.slice(0, 240))}`)
            log(`  response tail=${JSON.stringify(text.slice(-200))}`)
          })
          .catch((error: unknown) => log(`  response read error: ${String(error)}`))
      }
      return response
    } catch (error) {
      const record = error as { name?: string; message?: string; cause?: unknown }
      log(
        `ERROR ${url} :: ${record?.name ?? 'Error'}: ${record?.message ?? String(error)} :: cause=${String(
          record?.cause ?? '',
        )}`,
      )
      throw error
    }
  }
}
