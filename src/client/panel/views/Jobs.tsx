/**
 * Background jobs view (docs/impl/runtime-visualization.md §2).
 *
 * Read-only rendering of the native `ctx.jobs` snapshot through the bridge:
 * roster rows for the current session (exit-code chip, status dot, duration),
 * expandable live output and a two-press force-terminate control.
 *
 * `JobsView` is the connected component (bridge subscription + local UI state +
 * per-second clock); `JobsSurface` is the pure SSR surface so every visual state
 * (rows / exit code / expanded output / armed kill) can be asserted without DOM.
 */
import React from 'react'
import type { HostBridge } from '../../bridge'
import type { TFn } from '../../i18n'
import type { JobRowWire, JobsUiSnapshot } from '../../types'
import {
  EMPTY_JOBS_SNAPSHOT,
  clipJobOutput,
  formatDuration,
  isLiveJob,
  isObservableJob,
  jobDetail,
  jobDotState,
  jobElapsedMs,
  jobStatusLabel,
  jobsForSession,
  observedOutput,
  parseExitCode,
} from '../../runtime-model'
import type { ViewProps } from '../view-types'

/** How long an armed kill waits for the confirming press (official Jobs list). */
const KILL_ARM_MS = 3000
/** How long a failed kill keeps its hint. */
const KILL_FAILED_MS = 4000

function dotClass(row: JobRowWire): string {
  switch (jobDotState(row.status)) {
    case 'ongoing':
      return 'fg-state-dot fg-state-dot--business fg-dot-live'
    case 'warning':
      return 'fg-state-dot fg-state-dot--warning'
    case 'done':
      return 'fg-state-dot fg-state-dot--success'
    default:
      return 'fg-state-dot fg-state-dot--error'
  }
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <span className="fg-job-chevron" aria-hidden="true" data-open={open ? 'true' : 'false'}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d={open ? 'm6 15 6-6 6 6' : 'm9 6 6 6-6 6'} />
      </svg>
    </span>
  )
}

/** Live output block; auto-scrolls to the bottom whenever the tail changes. */
function JobOutput({ text, label, t }: { text: string; label: string; t: TFn }): React.ReactElement {
  const ref = React.useRef<HTMLPreElement>(null)
  React.useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [text])
  return (
    <pre ref={ref} data-flowgate="job-output" className="fg-job-output" aria-label={t('jobs.outputAria', { label })}>
      {text === '' ? <span className="fg-job-output-empty">{t('jobs.noOutput')}</span> : text}
    </pre>
  )
}

export interface JobsSurfaceProps {
  t: TFn
  /** False when the native jobs service is missing (host without ctx.jobs). */
  available: boolean
  rows: readonly JobRowWire[]
  /** Observed live output for the currently expanded row. */
  observed?: string
  expandedJobId?: string
  /** Job id whose stop button is in its confirming press. */
  armedJobId?: string
  /** Job id whose kill request is in flight. */
  killingJobId?: string
  /** Job id whose last kill request failed. */
  killFailedJobId?: string
  /** Clock for live durations (tests pin it; production ticks per second). */
  now: number
  onToggle?: (jobId: string) => void
  onKill?: (row: JobRowWire) => void
}

/** Pure jobs surface (SSR-testable): header, rows, exit chips, output, kill. */
export function JobsSurface(props: JobsSurfaceProps): React.ReactElement {
  const { t, available, rows, observed, expandedJobId, armedJobId, killingJobId, killFailedJobId, now, onToggle, onKill } = props
  const liveCount = rows.filter((row) => isLiveJob(row)).length
  return (
    <div data-flowgate="view-jobs" className="fg-runtime-card" style={{ display: 'grid', gap: 6 }}>
      <div className="fg-runtime-head">
        <strong className="fg-runtime-title">{t('jobs.title')}</strong>
        <span data-flowgate="jobs-count" data-running={liveCount} data-total={rows.length} className="fg-runtime-count">
          {t('jobs.count', { running: liveCount, total: rows.length })}
        </span>
        {liveCount > 0 ? <span className="fg-state-dot fg-state-dot--business fg-dot-live" aria-hidden="true" /> : null}
      </div>

      {!available ? (
        <div data-flowgate="jobs-unavailable" data-reason="host-missing" className="fg-runtime-empty">
          <span>{t('jobs.unavailable')}</span>
        </div>
      ) : rows.length === 0 ? (
        <div data-flowgate="jobs-empty" data-reason="no-jobs" className="fg-runtime-empty">
          <span>
            {t('jobs.empty')}
            <small>{t('jobs.emptyHint')}</small>
          </span>
        </div>
      ) : (
        <ul className="fg-job-list" role="list">
          {rows.map((row) => {
            const live = isLiveJob(row)
            const observable = isObservableJob(row)
            const expanded = expandedJobId === row.id
            const armed = armedJobId === row.id
            const killing = killingJobId === row.id
            const exitCode = parseExitCode(row.detail)
            const detail = jobDetail(row)
            const duration = formatDuration(jobElapsedMs(row, now), t)
            const rowBody = (
              <>
                <span className={dotClass(row)} aria-hidden="true" />
                <span className="fg-job-kind">{row.kind}</span>
                <span className="fg-job-label" title={row.label}>
                  {row.label}
                </span>
                <span className="fg-job-meta">
                  {exitCode !== null ? (
                    <span data-flowgate="job-exit" data-code={exitCode} className="fg-job-chip">
                      {t('jobs.exitCode', { code: exitCode })}
                    </span>
                  ) : null}
                  {exitCode === null ? (
                    <span className="fg-job-detail" title={detail ?? jobStatusLabel(row.status, t)}>
                      {detail ?? jobStatusLabel(row.status, t)}
                    </span>
                  ) : null}
                  <span className="fg-job-duration">{duration}</span>
                </span>
              </>
            )
            return (
              <li
                key={row.id}
                data-flowgate="job-row"
                data-job-id={row.id}
                data-status={row.status}
                data-live={live ? 'true' : 'false'}
                className={`fg-job-row${live ? ' fg-job-row-live' : ''}${expanded ? ' fg-job-row-open' : ''}`}
              >
                <div className="fg-job-line">
                  {observable ? (
                    <button
                      type="button"
                      data-action="job-expand"
                      aria-expanded={expanded}
                      aria-label={t(expanded ? 'jobs.collapse' : 'jobs.expand')}
                      title={t(expanded ? 'jobs.collapse' : 'jobs.expand')}
                      className="fg-job-main"
                      onClick={() => onToggle?.(row.id)}
                    >
                      {rowBody}
                      <Chevron open={expanded} />
                    </button>
                  ) : (
                    <div className="fg-job-main fg-job-main-static">{rowBody}</div>
                  )}
                  {live ? (
                    <button
                      type="button"
                      data-action="job-kill"
                      data-armed={armed ? 'true' : 'false'}
                      className={`fg-job-kill${armed ? ' fg-job-kill-armed' : ''}`}
                      aria-label={armed ? t('jobs.killConfirm') : t('jobs.kill')}
                      title={armed ? t('jobs.killConfirm') : t('jobs.kill')}
                      disabled={killing}
                      onClick={() => onKill?.(row)}
                    >
                      {armed ? t('jobs.killConfirm') : t('jobs.kill')}
                    </button>
                  ) : null}
                </div>
                {expanded ? <JobOutput text={clipJobOutput(observed ?? '')} label={row.label} t={t} /> : null}
                {killFailedJobId === row.id ? (
                  <div role="status" data-flowgate="job-kill-failed" className="fg-job-error">
                    {t('jobs.killFailed')}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export interface JobsViewProps extends ViewProps {
  bridge?: HostBridge
  sessionId?: string
}

/**
 * Connected jobs view: native snapshot subscription, roster/observe streams and
 * the two-press kill flow. SSR-safe: the server snapshot is the stable empty
 * snapshot, so no window/bridge is required to render.
 */
export function JobsView({ t, bridge, sessionId }: JobsViewProps): React.ReactElement {
  const available = bridge !== undefined && typeof bridge.jobsAvailable === 'function' && bridge.jobsAvailable()
  const subscribe = React.useCallback(
    (listener: () => void) => {
      if (bridge === undefined || typeof bridge.subscribeJobs !== 'function') return () => {}
      const release = bridge.subscribeJobs(listener)
      return typeof release === 'function' ? release : () => {}
    },
    [bridge],
  )
  const getSnapshot = React.useCallback((): JobsUiSnapshot => {
    if (bridge === undefined || typeof bridge.jobsSnapshot !== 'function') return EMPTY_JOBS_SNAPSHOT
    return bridge.jobsSnapshot()
  }, [bridge])
  const getServerSnapshot = React.useCallback((): JobsUiSnapshot => EMPTY_JOBS_SNAPSHOT, [])
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const rows = React.useMemo(() => jobsForSession(snapshot, sessionId), [snapshot, sessionId])
  const [expandedJobId, setExpandedJobId] = React.useState<string | undefined>(undefined)
  const [armedJobId, setArmedJobId] = React.useState<string | undefined>(undefined)
  const [killingJobId, setKillingJobId] = React.useState<string | undefined>(undefined)
  const [killFailedJobId, setKillFailedJobId] = React.useState<string | undefined>(undefined)
  const [now, setNow] = React.useState<number>(() => Date.now())
  const liveIds = rows.filter((row) => isLiveJob(row)).map((row) => row.id).join(',')
  const observedTail = observedOutput(snapshot, expandedJobId)

  // Keep the native roster stream open while the view is mounted.
  React.useEffect(() => {
    if (!available || bridge === undefined || sessionId === undefined) return
    if (typeof bridge.watchJobs !== 'function') return
    const release = bridge.watchJobs(sessionId)
    return () => {
      if (typeof release === 'function') release()
    }
  }, [available, bridge, sessionId])

  // Observe only the expanded job; release on collapse/unmount.
  React.useEffect(() => {
    if (!available || bridge === undefined || sessionId === undefined || expandedJobId === undefined) return
    if (typeof bridge.observeJob !== 'function') return
    const release = bridge.observeJob(sessionId, expandedJobId)
    return () => {
      if (typeof release === 'function') release()
    }
  }, [available, bridge, sessionId, expandedJobId])

  // Live elapsed time refreshes once per second only while a live row exists.
  React.useEffect(() => {
    if (liveIds === '') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [liveIds])

  // Armed kill auto-disarms; a failed kill resets after a short hint.
  React.useEffect(() => {
    if (armedJobId === undefined) return
    const timer = setTimeout(() => setArmedJobId(undefined), KILL_ARM_MS)
    return () => clearTimeout(timer)
  }, [armedJobId])
  React.useEffect(() => {
    if (killFailedJobId === undefined) return
    const timer = setTimeout(() => setKillFailedJobId(undefined), KILL_FAILED_MS)
    return () => clearTimeout(timer)
  }, [killFailedJobId])

  // Drop transient UI state when its row settles or disappears.
  React.useEffect(() => {
    if (expandedJobId !== undefined && !rows.some((row) => row.id === expandedJobId)) setExpandedJobId(undefined)
    if (armedJobId !== undefined && !rows.some((row) => row.id === armedJobId && isLiveJob(row))) setArmedJobId(undefined)
  }, [rows, expandedJobId, armedJobId])

  const handleToggle = (jobId: string): void => {
    setExpandedJobId((current) => (current === jobId ? undefined : jobId))
  }

  const handleKill = (row: JobRowWire): void => {
    if (armedJobId !== row.id) {
      setArmedJobId(row.id)
      setKillFailedJobId(undefined)
      return
    }
    setArmedJobId(undefined)
    setKillingJobId(row.id)
    void (async () => {
      try {
        const accepted =
          bridge !== undefined && typeof bridge.killJob === 'function' && sessionId !== undefined
            ? await bridge.killJob(sessionId, row.id)
            : false
        if (!accepted) setKillFailedJobId(row.id)
      } catch {
        setKillFailedJobId(row.id)
      } finally {
        setKillingJobId(undefined)
      }
    })()
  }

  return (
    <JobsSurface
      t={t}
      available={available}
      rows={rows}
      observed={observedTail}
      {...(expandedJobId !== undefined ? { expandedJobId } : {})}
      {...(armedJobId !== undefined ? { armedJobId } : {})}
      {...(killingJobId !== undefined ? { killingJobId } : {})}
      {...(killFailedJobId !== undefined ? { killFailedJobId } : {})}
      now={now}
      onToggle={handleToggle}
      onKill={handleKill}
    />
  )
}
