/** Time helpers: all timestamps persisted by FlowGate are ISO-8601 with offset. */

export function isoNow(clock: { now(): Date } = { now: () => new Date() }): string {
  const date = clock.now()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Compact local timestamp for directory names: YYYY-MM-DD-HHmm. */
export function stampForDir(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!match) return iso.replace(/[^0-9]/g, '').slice(0, 12)
  return `${match[1]}-${match[2]}-${match[3]}-${match[4]}${match[5]}`
}

export function dateOnly(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : iso
}

export function minutesBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.round(((to - from) / 60000) * 10) / 10
}

export function isOlderThanMinutes(iso: string, minutes: number, now = new Date()): boolean {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return true
  return now.getTime() - then > minutes * 60_000
}
