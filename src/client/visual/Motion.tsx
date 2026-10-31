/**
 * Animation primitives shared by the dock, the panel header rail and the
 * pipeline flow map (contract §1.1 / §1.3).
 *
 * Both primitives are SSR-safe: they only emit markup + CSS classes, never
 * touch timers or the DOM. The actual motion lives in `styles.ts` and is
 * opt-in under `prefers-reduced-motion: no-preference`.
 */
import type { CSSProperties, ReactElement } from 'react'

// ---------------------------------------------------------------------------
// PulseDot — the "current node" breathing dot
// ---------------------------------------------------------------------------

export interface PulseDotProps {
  size?: number
  color?: string
  /** False renders a static dot (e.g. a done stage). */
  active?: boolean
  className?: string
  /** Accessible name; omit when the dot is decorative. */
  label?: string
}

export function PulseDot({
  size = 8,
  color = 'currentColor',
  active = true,
  className,
  label,
}: PulseDotProps): ReactElement {
  const classes = [active ? 'fg-pulse' : undefined, className].filter((entry): entry is string => entry !== undefined)
  return (
    <span
      data-flowgate="pulse-dot"
      data-active={active ? 'true' : 'false'}
      {...(classes.length > 0 ? { className: classes.join(' ') } : {})}
      style={{
        position: 'relative',
        display: 'inline-flex',
        width: size,
        height: size,
        color,
        verticalAlign: 'middle',
        flex: '0 0 auto',
      }}
      {...(label !== undefined ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: color,
          opacity: 0.9,
        }}
      />
    </span>
  )
}

// ---------------------------------------------------------------------------
// AnimatedProgress — SVG progress ring (stroke-dashoffset based)
// ---------------------------------------------------------------------------

export interface AnimatedProgressProps {
  value: number
  max?: number
  /** Outer diameter in px. */
  size?: number
  strokeWidth?: number
  color?: string
  trackColor?: string
  /** Accessible/visible label (e.g. “3/7 阶段完成”). */
  label?: string
  /** Render the x/y text in the middle (default true). */
  showValue?: boolean
  className?: string
}

const clampRatio = (value: number, max: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(1, Math.max(0, value / max))
}

export function AnimatedProgress({
  value,
  max = 7,
  size = 48,
  strokeWidth = 4,
  color = 'var(--dsw-alias-label-secondary, #61666b)',
  trackColor = 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
  label,
  showValue = true,
  className,
}: AnimatedProgressProps): ReactElement {
  const radius = Math.max((size - strokeWidth) / 2, 1)
  const circumference = 2 * Math.PI * radius
  const ratio = clampRatio(value, max)
  const offset = circumference * (1 - ratio)
  const center = size / 2
  const ringStyle = { '--fg-ring-circumference': `${circumference}px` } as CSSProperties
  return (
    <span
      data-flowgate="progress-ring"
      data-value={value}
      data-max={max}
      {...(className !== undefined ? { className } : {})}
      style={{ display: 'inline-flex', flex: '0 0 auto', lineHeight: 0 }}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      {...(label !== undefined ? { 'aria-label': label } : {})}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle cx={center} cy={center} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        <circle
          data-flowgate="progress-ring-value"
          className="fg-ring"
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
          style={ringStyle}
        />
        {showValue ? (
          <text
            x={center}
            y={center + size * 0.09}
            textAnchor="middle"
            fontSize={Math.max(size * 0.26, 9)}
            fill={color}
            stroke="none"
            fontFamily="inherit"
          >
            {`${value}/${max}`}
          </text>
        ) : null}
      </svg>
    </span>
  )
}
