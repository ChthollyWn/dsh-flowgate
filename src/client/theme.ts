/**
 * FlowGate client theme: noise-reduced palette + the "only nag once per rule /
 * target per 10 minutes" memory gate (FR-9.6 / T5.4).
 *
 * 阻断红 / 需处理黄 / 进行中蓝 / 历史灰。Values are plain numbers/strings and
 * the noise gate is plain memory, so this module is SSR-safe.
 */
import type { RuntimeSnapshot } from '../core/types'

export type Tone = 'blocked' | 'attention' | 'active' | 'idle' | 'disabled'

export interface ToneTokens {
  /** Foreground / accent color. */
  fg: string
  /** Tinted background for chips. */
  bg: string
  /** Border color. */
  border: string
}

export const TONES: Record<Tone, ToneTokens> = {
  blocked: { fg: '#e5484d', bg: 'rgba(229, 72, 77, 0.12)', border: 'rgba(229, 72, 77, 0.45)' },
  attention: { fg: '#d97706', bg: 'rgba(217, 119, 6, 0.12)', border: 'rgba(217, 119, 6, 0.45)' },
  active: { fg: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.4)' },
  idle: { fg: '#8b8f98', bg: 'rgba(139, 143, 152, 0.12)', border: 'rgba(139, 143, 152, 0.4)' },
  disabled: { fg: '#9ca3af', bg: 'rgba(156, 163, 175, 0.1)', border: 'rgba(156, 163, 175, 0.35)' },
}

export const COLORS = {
  text: 'inherit',
  dim: '#8b8f98',
  faint: '#a8adb5',
  border: 'rgba(128, 132, 141, 0.28)',
  borderStrong: 'rgba(128, 132, 141, 0.45)',
  surface: 'rgba(127, 131, 140, 0.07)',
  surfaceStrong: 'rgba(127, 131, 140, 0.13)',
  pass: '#16a34a',
  passBg: 'rgba(22, 163, 74, 0.12)',
  fail: '#e5484d',
  failBg: 'rgba(229, 72, 77, 0.12)',
  warn: '#d97706',
  warnBg: 'rgba(217, 119, 6, 0.12)',
  info: '#2563eb',
  infoBg: 'rgba(37, 99, 235, 0.12)',
  purple: '#7c3aed',
  purpleBg: 'rgba(124, 58, 237, 0.12)',
} as const

/** Base monospace stack for ids / commands. */
export const MONO_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

export const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

/** One-line status bar tone (FR-8.1 / FR-9.6). */
export function toneOf(snapshot: RuntimeSnapshot | null | undefined): Tone {
  if (snapshot === null || snapshot === undefined || snapshot.initialized !== true) return 'disabled'
  if (snapshot.locked === true || snapshot.off === true) return 'blocked'
  if ((snapshot.violations ?? []).length > 0) return 'blocked'
  if (snapshot.awaitingGate !== undefined || (snapshot.pending ?? []).length > 0) return 'attention'
  if (snapshot.lifecycle === 'active' || snapshot.changeId !== undefined) return 'active'
  return 'idle'
}

/** Inline style for a chip like the status bar. */
export function toneStyle(tone: Tone): Record<string, string | number> {
  const tokens = TONES[tone] ?? TONES.idle
  return {
    color: tokens.fg,
    background: tokens.bg,
    border: `1px solid ${tokens.border}`,
  }
}

/** Task-status color (execution graph nodes / board cards). */
export function taskTone(status: string | undefined): Tone {
  switch (status) {
    case 'done':
      return 'active'
    case 'running':
    case 'queued':
      return 'active'
    case 'review':
      return 'attention'
    case 'blocked':
    case 'failed':
    case 'interrupted':
      return 'blocked'
    case 'pending':
    case 'skipped':
      return 'idle'
    default:
      return 'idle'
  }
}

export function taskColor(status: string | undefined): string {
  switch (status) {
    case 'done':
      return COLORS.pass
    case 'running':
    case 'queued':
      return COLORS.info
    case 'review':
      return COLORS.warn
    case 'blocked':
    case 'failed':
    case 'interrupted':
      return COLORS.fail
    default:
      return COLORS.dim
  }
}

/** Severity color for review findings / risk grades. */
export function severityColor(value: string | undefined): string {
  switch (value) {
    case 'critical':
    case 'high':
      return COLORS.fail
    case 'major':
    case 'medium':
      return COLORS.warn
    case 'minor':
    case 'low':
      return COLORS.info
    default:
      return COLORS.dim
  }
}

// ---------------------------------------------------------------------------
// Noise reduction: same rule + same target only nags strongly once per window.
// ---------------------------------------------------------------------------

export const NOISE_WINDOW_MS = 10 * 60 * 1000

export interface NoiseGate {
  /** True when this key may produce a strong (attention-grabbing) notice now. */
  shouldNotify: (key: string, now?: number) => boolean
  /** Forget one key (tests / rule revocation). */
  forget: (key: string) => void
  /** Forget everything. */
  reset: () => void
  /** Current number of remembered keys (tests). */
  size: () => number
}

/** Pure in-memory gate; no timers, no storage, SSR safe. */
export function createNoiseGate(windowMs: number = NOISE_WINDOW_MS): NoiseGate {
  const last = new Map<string, number>()
  const prune = (now: number): void => {
    for (const [key, at] of last) {
      if (now - at >= windowMs) last.delete(key)
    }
  }
  return {
    shouldNotify(key: string, now: number = Date.now()): boolean {
      prune(now)
      const previous = last.get(key)
      if (previous !== undefined && now - previous < windowMs) return false
      last.set(key, now)
      return true
    },
    forget(key: string): void {
      last.delete(key)
    },
    reset(): void {
      last.clear()
    },
    size(): number {
      return last.size
    },
  }
}

/** Plugin-wide gate shared by the dock and the intercept view. */
export const noiseGate: NoiseGate = createNoiseGate()

/** Stable noise key for one intercept: same rule + same target. */
export function interceptNoiseKey(ruleId: string, target?: string): string {
  return `${ruleId}::${target ?? ''}`
}
