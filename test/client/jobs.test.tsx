/**
 * Background jobs view tests (docs/impl/runtime-visualization.md §2/§5):
 * pure ordering/exit-code/duration helpers, the SSR surface states (rows,
 * exit-code chips, expanded output, armed kill) and bridge degradation.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { JobsSurface, JobsView } from '../../src/client/panel/views/Jobs'
import type { JobsSurfaceProps } from '../../src/client/panel/views/Jobs'
import { PanelSurface } from '../../src/client/panel/Panel'
import {
  EMPTY_JOBS_SNAPSHOT,
  clipJobOutput,
  formatDuration,
  isLiveJob,
  isObservableJob,
  jobDotState,
  jobStatusLabel,
  jobsForSession,
  normalizeJobRow,
  orderedJobs,
  parseExitCode,
} from '../../src/client/runtime-model'
import { buildPanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { HostBridge } from '../../src/client/bridge'
import { click, findByData } from './hook-harness'
import { RUNTIME_NOW, makeJobRows, makeProjection } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (): void => {}
const model = buildPanelModel(makeProjection(), zh)

function surface(overrides: Partial<JobsSurfaceProps> = {}): string {
  return renderToStaticMarkup(
    <JobsSurface t={zh} available rows={makeJobRows()} now={RUNTIME_NOW} onToggle={noop} onKill={noop} {...overrides} />,
  )
}

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length
}

/** Minimal HostBridge double exposing only the jobs face. */
function fakeBridge(rows = makeJobRows()): HostBridge {
  return {
    jobsAvailable: () => true,
    jobsSnapshot: () => ({ rows: { 'web-1': rows }, observed: { 'J-1': { text: 'compiling…' } } }),
    subscribeJobs: () => () => {},
    watchJobs: () => () => {},
    observeJob: () => () => {},
    killJob: async () => true,
    openSubagentSession: () => true,
  } as unknown as HostBridge
}

describe('runtime-model — background jobs helpers', () => {
  it('orders live rows by start, then settled rows newest-first', () => {
    const ordered = orderedJobs(makeJobRows())
    expect(ordered.map((row) => row.id)).toEqual(['J-1', 'J-4', 'J-3', 'J-2'])
    expect(ordered.filter(isLiveJob).map((row) => row.id)).toEqual(['J-1'])
    expect(isObservableJob(ordered[0])).toBe(true)
    // A settled row without retained output cannot expand.
    const completedWithoutOutput = { ...makeJobRows()[0]! }
    delete completedWithoutOutput.output
    expect(isObservableJob(completedWithoutOutput)).toBe(false)
  })

  it('parses exit codes from both colon styles and ignores unrelated details', () => {
    expect(parseExitCode('exit code: 0')).toBe(0)
    expect(parseExitCode('exit code: 2')).toBe(2)
    expect(parseExitCode('exit code：3')).toBe(3)
    expect(parseExitCode('signal SIGTERM')).toBeNull()
    expect(parseExitCode('exit code: nope')).toBeNull()
    expect(parseExitCode(undefined)).toBeNull()
  })

  it('formats durations in at most two adjacent units', () => {
    expect(formatDuration(45_000, zh)).toBe('45 秒')
    expect(formatDuration(125_000, zh)).toBe('2 分 5 秒')
    expect(formatDuration(3_725_000, zh)).toBe('1 小时 2 分')
    expect(formatDuration(65_000, en)).toBe('1m 5s')
  })

  it('maps native status semantics (dot + label)', () => {
    expect(jobDotState('running')).toBe('ongoing')
    expect(jobDotState('stopping')).toBe('warning')
    expect(jobDotState('killed')).toBe('warning')
    expect(jobDotState('completed')).toBe('done')
    expect(jobDotState('failed')).toBe('error')
    expect(jobStatusLabel('running', zh)).toBe('运行中')
    expect(jobStatusLabel('killed', en)).toBe('Killed')
  })

  it('drops malformed rows and reads only the requested session', () => {
    expect(normalizeJobRow(null)).toBeNull()
    expect(normalizeJobRow({ id: 'J-9', status: 'weird' })).toBeNull()
    const snapshot = { rows: { 'web-1': makeJobRows(), 'web-2': [null] }, observed: {} }
    expect(jobsForSession(snapshot as never, 'web-1')).toHaveLength(4)
    expect(jobsForSession(snapshot as never, 'web-3')).toEqual([])
    expect(jobsForSession(EMPTY_JOBS_SNAPSHOT, 'web-1')).toEqual([])
  })

  it('clips live output to the retained tail', () => {
    expect(clipJobOutput('abcdef', 4)).toBe('…def')
    expect(clipJobOutput('abc', 8)).toBe('abc')
  })
})

describe('jobs view — contract §2', () => {
  it('renders the host-missing state without a bridge', () => {
    const html = renderToStaticMarkup(<JobsView model={model} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="view-jobs"')
    expect(html).toContain('data-flowgate="jobs-unavailable"')
    expect(html).toContain('宿主未提供后台任务服务')
  })

  it('is SSR safe with a bridge (server snapshot is the stable empty snapshot)', () => {
    const html = renderToStaticMarkup(
      <JobsView model={model} t={zh} onAction={noop} bridge={fakeBridge()} sessionId="web-1" />,
    )
    expect(html).toContain('data-flowgate="view-jobs"')
    expect(html).toContain('data-flowgate="jobs-empty"')
    expect(html).toContain('当前没有后台任务')
  })

  it('renders rows, live status, exit-code chips and durations', () => {
    const html = surface()
    expect(html).toContain('data-flowgate="jobs-count" data-running="1" data-total="4"')
    expect(count(html, /data-flowgate="job-row"/g)).toBe(4)
    expect(html).toContain('data-job-id="J-1" data-status="running" data-live="true"')
    expect(html).toContain('data-job-id="J-2" data-status="completed" data-live="false"')
    expect(html).toContain('fg-state-dot--business fg-dot-live')
    expect(html).toContain('fg-state-dot--error')
    expect(html).toContain('data-flowgate="job-exit" data-code="0"')
    expect(html).toContain('data-flowgate="job-exit" data-code="2"')
    expect(html).toContain('退出码 0')
    expect(html).toContain('1 分 5 秒')
    expect(html).toContain('data-action="job-kill" data-armed="false"')
    // Only the live row offers a stop control.
    expect(count(html, /data-action="job-kill"/g)).toBe(1)
    expect(count(html, /data-action="job-expand"/g)).toBe(2)
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders the expanded live output panel', () => {
    const html = surface({ expandedJobId: 'J-1', observed: 'compiling…\ndone' })
    expect(html).toContain('data-action="job-expand" aria-expanded="true"')
    expect(html).toContain('data-flowgate="job-output"')
    expect(html).toContain('compiling…')
    const empty = surface({ expandedJobId: 'J-2', observed: '' })
    expect(empty).toContain('data-flowgate="job-output"')
    expect(empty).toContain('暂无输出')
  })

  it('renders the two-press kill confirmation and failure hint', () => {
    const html = surface({ armedJobId: 'J-1' })
    expect(html).toContain('data-action="job-kill" data-armed="true"')
    expect(html).toContain('确认终止')
    const failed = surface({ killFailedJobId: 'J-1' })
    expect(failed).toContain('data-flowgate="job-kill-failed"')
    expect(failed).toContain('终止失败')
    const pending = surface({ killingJobId: 'J-1' })
    expect(pending).toContain('disabled=""')
  })

  it('reports expand and kill presses to the caller', () => {
    const onToggle = vi.fn()
    const onKill = vi.fn()
    const tree = JobsSurface({ t: zh, available: true, rows: orderedJobs(makeJobRows()), now: RUNTIME_NOW, onToggle, onKill })
    const expand = findByData(tree, 'data-action', 'job-expand')
    expect(expand).toBeDefined()
    click(expand as React.ReactElement)
    expect(onToggle).toHaveBeenCalledWith('J-1')
    const kill = findByData(tree, 'data-action', 'job-kill')
    expect(kill).toBeDefined()
    click(kill as React.ReactElement)
    expect(onKill).toHaveBeenCalledTimes(1)
    expect((onKill.mock.calls[0]?.[0] as { id: string }).id).toBe('J-1')
  })

  it('renders English copy without leaking i18n keys', () => {
    const html = surface({ t: en })
    expect(html).toContain('Background jobs')
    expect(html).toContain('Exit code 0')
    expect(html).toContain('Stop')
    expect(html).not.toContain('jobs.')
  })

  it('renders through the panel surface in the jobs tab', () => {
    const html = renderToStaticMarkup(
      <PanelSurface
        model={model}
        t={zh}
        activeTab="jobs"
        onTabChange={noop}
        onAction={noop}
        runtime={{ bridge: fakeBridge(), sessionId: 'web-1' }}
      />,
    )
    expect(html).toContain('data-active-tab="jobs"')
    expect(html).toContain('data-flowgate="view-jobs"')
    expect(html).toContain('data-flowgate="jobs-count"')
  })
})
