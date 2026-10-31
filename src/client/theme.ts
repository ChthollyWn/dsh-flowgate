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

/**
 * Host-native design tokens (docs/impl/ui-interaction-redesign.md §1.4).
 *
 * Every colour the graphical surfaces use goes through these `--dsw-*` custom
 * properties with neutral fallbacks, so the plugin follows the DSH light / dark
 * theme instead of hard-coding its own palette. Values mirror the real shell
 * tokens (`@deepseek-ai/dsh-client-ui-theme` + primitive Button CSS).
 */
export const NATIVE = {
  /** Card / input surface (`--dsw-specific-input-major`). */
  card: 'var(--dsw-specific-input-major, #ffffff)',
  /** Layer background used for subtle sections. */
  layer: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  labelPrimary: 'var(--dsw-alias-label-primary, #0f1115)',
  labelSecondary: 'var(--dsw-alias-label-secondary, #61666b)',
  labelTertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
  labelDimmed: 'var(--dsw-alias-label-dimmed, #e1e5ee)',
  labelCaption: 'var(--dsw-alias-label-caption, #adb2b8)',
  labelForeground: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  borderL1: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04))',
  borderL2: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  borderL3: 'var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  borderL4: 'var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16))',
  overlay: 'var(--dsw-alias-bg-overlay, #e9ecf2)',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))',
  hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(236, 19, 19, 0.05))',
  stateSuccess: 'var(--dsw-alias-state-success-primary, #22c55e)',
  stateWarn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  stateWarnLabel: 'var(--dsw-alias-state-warn-label, #dd8629)',
  stateWarnTertiary: 'var(--dsw-alias-state-warn-tertiary, #fef5e7)',
  stateError: 'var(--dsw-alias-state-error-primary, #ec1313)',
  stateBusiness: 'var(--dsw-alias-state-business-primary, #4176e6)',
  stateBusinessTertiary: 'var(--dsw-alias-state-business-tertiary, #e4edfd)',
  buttonPrimaryFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary, #0f1115))',
  buttonPrimaryHover: 'var(--dsw-alias-button-primary-hover, #43454a)',
  radiusSm: 'var(--dsw-radius-sm, 8px)',
  radiusMd: 'var(--dsw-radius-md, 12px)',
  radiusLg: 'var(--dsw-radius-lg, 16px)',
  radiusXl: 'var(--dsw-radius-xl, 20px)',
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
  // 修复通道活跃时与"进行中变更"同色：它是正常的工作态，不是异常。
  if (snapshot.repair !== undefined) return 'active'
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

/**
 * Task-status colour: neutral label tokens, semantic colour reserved for the
 * review / blocked accents (contract §1.4 — no self-painted palette).
 */
export function taskColor(status: string | undefined): string {
  switch (status) {
    case 'done':
      return NATIVE.labelSecondary
    case 'running':
    case 'queued':
      return NATIVE.labelPrimary
    case 'review':
      return NATIVE.stateWarn
    case 'blocked':
    case 'failed':
    case 'interrupted':
      return NATIVE.stateError
    default:
      return NATIVE.labelTertiary
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
