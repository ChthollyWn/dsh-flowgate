/**
 * Input-box status bar (T1.6 / FR-8.1).
 *
 * Slot: `conversation.input.dock` (list slot, session scope).
 * - one line, always ≤ 120 characters
 * - tone: blocked red / needs-action yellow / active blue / idle-disabled gray
 * - click opens the right sidebar panel (falls back to `/flow` command)
 * - the same rule + target only gets a strong tone once per 10 minutes (FR-9.6)
 *
 * `StatusBarView` is pure and SSR-safe; `StatusBar` is the slot container that
 * reads the host projection through the standard kit.
 */
import React from 'react'
import type { TFn } from '../i18n'
import type { SlotPropRecord } from '../types'
import type { HostBridge } from '../bridge'
import { sessionIdOf } from '../bridge'
import type { StatusBarModel } from '../model'
import { buildStatusBarModel, readProjection } from '../model'
import { COLORS, MONO_FONT, UI_FONT, noiseGate, toneStyle, interceptNoiseKey } from '../theme'
import type { Tone } from '../theme'

export interface StatusBarViewProps {
  model: StatusBarModel
  t: TFn
  /** False when this intercept was already strongly shown within the window. */
  strong?: boolean
  notice?: string
  onOpen?: () => void
}

export function StatusBarView({ model, t, strong, notice, onOpen }: StatusBarViewProps): React.ReactElement {
  const effectiveTone: Tone = strong === false && model.tone !== 'disabled' ? 'idle' : model.tone
  const style = toneStyle(effectiveTone)
  const clickable = typeof onOpen === 'function'
  return (
    <div
      data-flowgate="status-bar"
      data-tone={model.tone}
      data-strong={strong === false ? 'false' : 'true'}
      data-initialized={model.initialized ? 'true' : 'false'}
      title={t('status.clickHint')}
      onClick={onOpen}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpen?.()
              }
            }
          : undefined
      }
      aria-label={model.ariaLabel}
      style={{
        ...style,
        fontFamily: UI_FONT,
        fontSize: 11.5,
        lineHeight: 1.5,
        padding: '3px 10px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
        cursor: clickable ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      <span
        aria-hidden="true"
        style={{ fontFamily: MONO_FONT, fontSize: 11, opacity: 0.9, flex: '0 0 auto' }}
        data-flowgate="status-bar-glyph"
      >
        ◆
      </span>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        data-flowgate="status-bar-text"
        data-length={Array.from(model.text).length}
      >
        {model.text}
      </span>
      {notice !== undefined && notice !== '' ? (
        <span
          role="status"
          data-flowgate="status-bar-notice"
          style={{ color: COLORS.dim, fontSize: 10.5, flex: '0 0 auto', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {notice}
        </span>
      ) : null}
    </div>
  )
}

export interface StatusBarProps {
  props: SlotPropRecord
  t: TFn
  bridge?: HostBridge
}

/** Slot component: reads the projection, dedupes the strong tone, opens the panel. */
export function StatusBar({ props, t, bridge }: StatusBarProps): React.ReactElement {
  const proj = readProjection(props)
  const model = buildStatusBarModel(proj, t)
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  const [strong, setStrong] = React.useState(true)
  const latest = proj?.panel?.intercepts?.[0]
  const latestKey =
    latest !== undefined ? interceptNoiseKey(latest.ruleId, latest.target) : undefined
  const latestAt = latest?.at

  React.useEffect(() => {
    if (latestKey === undefined) return
    const allowed = noiseGate.shouldNotify(latestKey)
    setStrong(allowed)
    return () => {
      /* memory gate is process-wide; nothing to release */
    }
  }, [latestKey, latestAt])

  const onOpen = (): void => {
    if (bridge !== undefined && bridge.openPanel()) {
      setNotice(undefined)
      return
    }
    // H10 fallback: put /flow into the composer so the owner can still act.
    const sessionId = sessionIdOf(props)
    void (async () => {
      const filled =
        bridge !== undefined ? await bridge.fillCommand('/flow', sessionId) : false
      setNotice(filled ? t('actions.fillCommand', { cmd: '/flow' }) : t('actions.clipboardFailed', { cmd: '/flow' }))
    })()
  }

  return <StatusBarView model={model} t={t} strong={strong} notice={notice} onOpen={onOpen} />
}
