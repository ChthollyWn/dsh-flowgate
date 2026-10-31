/**
 * Pure SVG glyphs for the graphical flow system (contract §1.1).
 *
 * The plugin must not depend on an icon package or external assets, so every
 * glyph is a small inline `<svg>` drawn with strokes. Everything is a pure
 * function of its props (no DOM / window access) and therefore renders verbatim
 * under `react-dom/server` in the SSR tests.
 *
 * Glyphs are decorative by default (`aria-hidden`); pass `title` when the glyph
 * is the only content of an interactive element and needs an accessible name.
 */
import type { ReactElement, SVGProps } from 'react'

export interface GlyphProps {
  /** Square edge length in px (default 16). */
  size?: number
  /** Stroke colour (defaults to the CSS `currentColor`). */
  color?: string
  /** Accessible name; when omitted the glyph is decorative. */
  title?: string
  className?: string
  strokeWidth?: number
}

function glyphProps(props: GlyphProps): SVGProps<SVGSVGElement> {
  const { size = 16, color = 'currentColor', title, className, strokeWidth = 1.5 } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false',
    ...(className !== undefined ? { className } : {}),
    ...(title !== undefined ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true }),
  }
}

// ---------------------------------------------------------------------------
// Seven stage glyphs (one distinct shape per pipeline stage)
// ---------------------------------------------------------------------------

export type StageIdLike = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export interface StageGlyphProps extends GlyphProps {
  stage: string
}

function stageShapes(stage: string, color: string): ReactElement {
  switch (stage) {
    case 'S1':
      // 需求澄清: speech bubble with three clarification dots.
      return (
        <>
          <path d="M4 5h16v10H10l-4 4v-4H4z" />
          <circle cx="9" cy="10" r="0.9" fill={color} stroke="none" />
          <circle cx="12" cy="10" r="0.9" fill={color} stroke="none" />
          <circle cx="15" cy="10" r="0.9" fill={color} stroke="none" />
        </>
      )
    case 'S2':
      // 上下文: stacked project facts (layers).
      return (
        <>
          <path d="M12 3 3 7.5 12 12l9-4.5z" />
          <path d="M3 12.5 12 17l9-4.5" />
          <path d="M3 17.5 12 22l9-4.5" />
        </>
      )
    case 'S3':
      // 设计拆解: blueprint grid.
      return (
        <>
          <path d="M4 4h16v16H4z" />
          <path d="M4 9.5h16" />
          <path d="M9.5 9.5V20" />
          <path d="M9.5 4v5.5" />
        </>
      )
    case 'S4':
      // 执行: code brackets </>.
      return (
        <>
          <path d="M9 7 4 12l5 5" />
          <path d="m15 7 5 5-5 5" />
          <path d="m13 5-2 14" />
        </>
      )
    case 'S5':
      // 验证: shield with a check.
      return (
        <>
          <path d="M12 3 19 6v5c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
          <path d="m8.8 11.8 2.2 2.2 4.4-4.4" />
        </>
      )
    case 'S6':
      // 交付: package box.
      return (
        <>
          <path d="m4 8 8-4 8 4v9l-8 4-8-4z" />
          <path d="m4 8 8 4 8-4" />
          <path d="M12 12v9" />
        </>
      )
    case 'S0':
    default:
      // 立项: flag on a pole.
      return (
        <>
          <path d="M6 21V4" />
          <path d="M6 4h11l-2.5 3.5L17 11H6" />
        </>
      )
  }
}

export function StageGlyph({ stage, ...props }: StageGlyphProps): ReactElement {
  const merged = glyphProps(props)
  const color = props.color ?? 'currentColor'
  return (
    <svg {...merged} data-glyph="stage" data-stage={stage}>
      {props.title !== undefined ? <title>{props.title}</title> : null}
      {stageShapes(stage, color)}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Gate glyphs (human / automatic / lock)
// ---------------------------------------------------------------------------

export type GateKind = 'human' | 'auto' | 'lock'

export interface GateGlyphProps extends GlyphProps {
  kind: GateKind
}

export function GateGlyph({ kind, ...props }: GateGlyphProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="gate" data-gate-kind={kind}>
      {props.title !== undefined ? <title>{props.title}</title> : null}
      {kind === 'lock' ? (
        <>
          <rect x="6.5" y="10.5" width="11" height="9.5" rx="1.6" />
          <path d="M9 10.5V8a3 3 0 0 1 6 0v2.5" />
          <circle cx="12" cy="15.4" r="1" fill={props.color ?? 'currentColor'} stroke="none" />
        </>
      ) : kind === 'auto' ? (
        <path d="M13 2.5 5 14h6l-1 7.5L18 10h-6z" />
      ) : (
        <>
          <path d="M12 3 19 6v5c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
          <path d="m8.8 11.8 2.2 2.2 4.4-4.4" />
        </>
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Small UI icons
// ---------------------------------------------------------------------------

export interface IconProps extends GlyphProps {
  filled?: boolean
}

export function ShieldIcon({ filled, ...props }: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="shield">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path
        d="M12 3 19 6v5c0 4-3 7-7 9-4-2-7-5-7-9V6z"
        {...(filled === true ? { fill: props.color ?? 'currentColor', fillOpacity: 0.18 } : {})}
      />
      <path d="m8.8 11.8 2.2 2.2 4.4-4.4" />
    </svg>
  )
}

export function LockIcon({ filled, ...props }: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="lock">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <rect
        x="6.5"
        y="10.5"
        width="11"
        height="9.5"
        rx="1.6"
        {...(filled === true ? { fill: props.color ?? 'currentColor', fillOpacity: 0.16 } : {})}
      />
      <path d="M9 10.5V8a3 3 0 0 1 6 0v2.5" />
      <circle cx="12" cy="15.4" r="1" fill={props.color ?? 'currentColor'} stroke="none" />
    </svg>
  )
}

export function ArrowIcon(props: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="arrow">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path d="M4 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

export function CheckIcon(props: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="check">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  )
}

export function SparkIcon(props: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="spark">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m6.2 6.2 2.8 2.8" />
      <path d="m15 15 2.8 2.8" />
      <path d="m17.8 6.2-2.8 2.8" />
      <path d="M9 15l-2.8 2.8" />
    </svg>
  )
}

export function AlertIcon({ filled, ...props }: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="alert">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <path
        d="M12 3.5 21 20H3z"
        {...(filled === true ? { fill: props.color ?? 'currentColor', fillOpacity: 0.16 } : {})}
      />
      <path d="M12 9.5v5" />
      <circle cx="12" cy="17.2" r="0.9" fill={props.color ?? 'currentColor'} stroke="none" />
    </svg>
  )
}

export function PanelIcon(props: IconProps): ReactElement {
  const merged = glyphProps(props)
  return (
    <svg {...merged} data-glyph="panel">
      {props.title !== undefined ? <title>{props.title}</title> : null}
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
      <path d="M6.5 8.5h5" />
      <path d="M6.5 12h5" />
    </svg>
  )
}
