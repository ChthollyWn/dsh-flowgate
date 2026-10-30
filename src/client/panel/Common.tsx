/**
 * Small shared panel primitives. Deliberately dependency-free (inline styles,
 * no UI kit) to minimise DSH version coupling; everything is SSR-safe.
 */
import React from 'react'
import type { TFn } from '../i18n'
import { COLORS, MONO_FONT, UI_FONT } from '../theme'

export interface EmptyStateProps {
  text: string
  hint?: string
  icon?: string
}

export function EmptyState({ text, hint, icon }: EmptyStateProps): React.ReactElement {
  return (
    <div
      data-flowgate="empty-state"
      style={{
        fontFamily: UI_FONT,
        fontSize: 12,
        color: COLORS.dim,
        padding: '10px 4px',
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden="true" style={{ marginInlineEnd: 6 }}>
        {icon ?? '○'}
      </span>
      {text}
      {hint !== undefined ? (
        <span style={{ display: 'block', marginTop: 2, color: COLORS.faint, fontSize: 11 }}>{hint}</span>
      ) : null}
    </div>
  )
}

export interface BadgeProps {
  label: string
  color?: string
  background?: string
  title?: string
  /** Extra data attribute value exposed for tests. */
  dataBadge?: string
}

export function Badge({ label, color, background, title, dataBadge }: BadgeProps): React.ReactElement {
  return (
    <span
      data-flowgate="badge"
      data-badge={dataBadge ?? label}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        borderRadius: 999,
        fontSize: 10.5,
        lineHeight: 1.6,
        color: color ?? COLORS.dim,
        background: background ?? COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

export interface ButtonProps {
  label: string
  onClick?: () => void
  title?: string
  disabled?: boolean
  tone?: 'primary' | 'danger' | 'neutral'
  dataAction?: string
}

const BUTTON_COLORS: Record<NonNullable<ButtonProps['tone']>, { fg: string; bg: string; border: string }> = {
  primary: { fg: '#ffffff', bg: '#2563eb', border: '#1d4ed8' },
  danger: { fg: '#ffffff', bg: '#dc2626', border: '#b91c1c' },
  neutral: { fg: COLORS.text, bg: COLORS.surfaceStrong, border: COLORS.borderStrong },
}

export function ActionButton({ label, onClick, title, disabled, tone, dataAction }: ButtonProps): React.ReactElement {
  const palette = BUTTON_COLORS[tone ?? 'neutral']
  return (
    <button
      type="button"
      data-flowgate="action"
      data-action={dataAction}
      aria-label={title ?? label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled === true}
      style={{
        fontFamily: UI_FONT,
        fontSize: 11.5,
        lineHeight: 1.4,
        padding: '3px 10px',
        borderRadius: 7,
        border: `1px solid ${palette.border}`,
        color: disabled === true ? COLORS.faint : palette.fg,
        background: disabled === true ? COLORS.surface : palette.bg,
        cursor: disabled === true ? 'not-allowed' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

export interface SectionProps {
  title: string
  children: React.ReactNode
  count?: number
  actions?: React.ReactNode
}

export function Section({ title, children, count, actions }: SectionProps): React.ReactElement {
  return (
    <section data-flowgate="section" style={{ fontFamily: UI_FONT, display: 'grid', gap: 6 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 650, color: COLORS.text }}>{title}</h3>
        {count !== undefined ? (
          <span style={{ fontSize: 11, color: COLORS.dim }} data-flowgate="section-count">
            {count}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {actions}
      </header>
      {children}
    </section>
  )
}

export interface TableProps {
  headers: string[]
  rows: React.ReactNode[][]
  emptyText: string
  testId?: string
}

export function DataTable({ headers, rows, emptyText, testId }: TableProps): React.ReactElement {
  if (rows.length === 0) return <EmptyState text={emptyText} />
  return (
    <div style={{ overflowX: 'auto' }} data-flowgate={testId ?? 'table'} data-testid={testId}>
      <table
        style={{
          borderCollapse: 'collapse',
          width: '100%',
          fontFamily: UI_FONT,
          fontSize: 11.5,
          color: COLORS.text,
        }}
      >
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                style={{
                  textAlign: 'start',
                  padding: '4px 6px',
                  color: COLORS.dim,
                  fontWeight: 600,
                  borderBottom: `1px solid ${COLORS.border}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} data-flowgate="table-row">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  style={{
                    padding: '4px 6px',
                    borderBottom: `1px solid ${COLORS.border}`,
                    verticalAlign: 'top',
                    wordBreak: 'break-word',
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface KeyValueProps {
  label: string
  value: React.ReactNode
  mono?: boolean
}

export function KeyValue({ label, value, mono }: KeyValueProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 11.5, lineHeight: 1.5, fontFamily: UI_FONT }}>
      <span style={{ color: COLORS.dim, flex: '0 0 auto' }}>{label}</span>
      <span style={{ color: COLORS.text, fontFamily: mono === true ? MONO_FONT : UI_FONT, wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  )
}

/** Monospace command / id text. */
export function Mono({ children }: { children: React.ReactNode }): React.ReactElement {
  return <code style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{children}</code>
}

export interface NoticeProps {
  text: string
  tone?: 'ok' | 'warn' | 'error'
  onDismiss?: () => void
  t: TFn
}

export function Notice({ text, tone, onDismiss, t }: NoticeProps): React.ReactElement {
  const color = tone === 'error' ? COLORS.fail : tone === 'warn' ? COLORS.warn : COLORS.pass
  return (
    <div
      role="status"
      data-flowgate="notice"
      data-tone={tone ?? 'ok'}
      style={{
        fontFamily: UI_FONT,
        fontSize: 11.5,
        lineHeight: 1.45,
        color,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 7,
        padding: '5px 8px',
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      {onDismiss !== undefined ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('actions.dismiss')}
          style={{
            border: 'none',
            background: 'transparent',
            color: COLORS.dim,
            cursor: 'pointer',
            fontSize: 11,
            padding: 0,
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
