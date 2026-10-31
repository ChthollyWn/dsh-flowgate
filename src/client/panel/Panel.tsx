/**
 * Right-sidebar panel (T2.6 / T3.6 / T5.1): header and
 * the eight views. `PanelSurface` is the pure SSR-testable body; `Panel` is the
 * slot container that reads the session projection, wires host actions and
 * applies the command fallback.
 */
import React from 'react'
import type { TFn } from '../i18n'
import type { FlowgateProjection, SlotPropRecord } from '../types'
import type { HostBridge } from '../bridge'
import { sessionIdOf } from '../bridge'
import type { PanelModel } from '../model'
import {
  buildPanelModel,
  complexityLabel,
  normalizeProjection,
  placeholderStageNodes,
  readProjection,
  riskLabel,
  stageIndex,
  stageLabel,
} from '../model'
import type { ClientAction } from '../actions'
import { performAction } from '../actions'
import { Notice } from './Common'
import { COLORS, MONO_FONT, TONES, UI_FONT } from '../theme'
import { FlowRail } from '../visual/FlowRail'
import { LedgerView } from './views/Ledger'
import { PipelineView } from './views/Pipeline'
import { GatesView } from './views/Gates'
import { TasksView } from './views/Tasks'
import { TraceView } from './views/Trace'
import { RiskView } from './views/Risk'
import { InterceptsView } from './views/Intercepts'
import { MetricsView } from './views/Metrics'
import { SubagentsView } from './views/Subagents'
import type { SubagentsRuntimeData } from './views/Subagents'
import { JobsView } from './views/Jobs'
import { catalogIds, parseCatalog } from '../runtime-model'

export type PanelTab =
  | 'ledger'
  | 'pipeline'
  | 'gates'
  | 'tasks'
  | 'agents'
  | 'jobs'
  | 'trace'
  | 'risk'
  | 'intercepts'
  | 'metrics'

export const PANEL_TABS: {
  id: PanelTab
  labelKey:
    | 'tab.ledger'
    | 'tab.pipeline'
    | 'tab.gates'
    | 'tab.tasks'
    | 'tab.agents'
    | 'tab.jobs'
    | 'tab.trace'
    | 'tab.risk'
    | 'tab.intercepts'
    | 'tab.metrics'
}[] = [
  { id: 'ledger', labelKey: 'tab.ledger' },
  { id: 'pipeline', labelKey: 'tab.pipeline' },
  { id: 'gates', labelKey: 'tab.gates' },
  { id: 'tasks', labelKey: 'tab.tasks' },
  { id: 'agents', labelKey: 'tab.agents' },
  { id: 'jobs', labelKey: 'tab.jobs' },
  { id: 'trace', labelKey: 'tab.trace' },
  { id: 'risk', labelKey: 'tab.risk' },
  { id: 'intercepts', labelKey: 'tab.intercepts' },
  { id: 'metrics', labelKey: 'tab.metrics' },
]

/** Native runtime data passed into the two v0.3 views (agents / jobs). */
export interface PanelRuntimeData extends SubagentsRuntimeData {
  bridge?: HostBridge
  sessionId?: string
}

export interface PanelSurfaceProps {
  model: PanelModel
  t: TFn
  activeTab: PanelTab
  onTabChange: (tab: PanelTab) => void
  onAction: (action: ClientAction) => void
  notice?: { text: string; tone: 'ok' | 'warn' | 'error' }
  onDismissNotice?: () => void
  /** v0.3: native runtime data for the agents / jobs tabs. */
  runtime?: PanelRuntimeData
}

export function PanelSurface(props: PanelSurfaceProps): React.ReactElement {
  const { model, t, activeTab, onTabChange, onAction, notice, onDismissNotice, runtime } = props
  return (
    <div
      data-flowgate="panel"
      data-initialized={model.initialized ? 'true' : 'false'}
      style={{ fontFamily: UI_FONT, color: COLORS.text, display: 'grid', gap: 8, padding: '10px 12px', fontSize: 12 }}
    >
      <header data-flowgate="panel-header" style={{ display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{t('panel.title')}</strong>
          {model.changeId !== undefined ? (
            <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.info }} data-flowgate="panel-change-id">
              {model.changeId}
            </span>
          ) : null}
          {model.title !== undefined && model.title !== '' ? (
            <span style={{ fontSize: 11.5, color: COLORS.dim }} data-flowgate="panel-change-title">
              {model.title}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {model.updatedAt !== '' ? (
            <span style={{ fontSize: 10, color: COLORS.faint }}>{t('panel.updatedAt', { time: model.updatedAt })}</span>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Compact seven-stage rail: current stage is visible from every tab. */}
          <div
            data-flowgate="panel-rail"
            style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 220px' }}
          >
            <FlowRail
              nodes={model.pipeline.length > 0 ? model.pipeline : placeholderStageNodes(t)}
              state={model.flowState}
              t={t}
              size="md"
              onSelectStage={() => onTabChange('pipeline')}
              {...(model.gate.awaitingOwner && model.gate.gate !== null ? { awaitingGate: model.gate.gate } : {})}
            />
          </div>
          {model.complexity !== undefined ? (
            <span style={{ fontSize: 11, color: COLORS.dim }} data-flowgate="panel-level">
              {t('panel.complexityRisk', {
                complexity: complexityLabel(model.complexity, t),
                risk: riskLabel(model.risk, t),
              })}
            </span>
          ) : null}
          {model.stage !== undefined ? (
            <span style={{ fontSize: 11, color: COLORS.dim }} data-flowgate="panel-stage">
              {stageIndex(model.stage, t)} {stageLabel(model.stage, t)}
            </span>
          ) : null}
          {model.flowPlan !== undefined ? (
            <span
              data-flowgate="panel-flow-route"
              data-route={model.flowPlan.route}
              data-auto={model.flowPlan.autoApprove ? 'true' : 'false'}
              data-verdict={model.flowPlan.verdict}
              title={model.flowPlan.reasons.join('\n')}
              style={{
                fontSize: 10.5,
                lineHeight: '16px',
                color: COLORS.dim,
                border: `0.5px solid ${COLORS.border}`,
                borderRadius: 999,
                padding: '0 6px',
              }}
            >
              {t('panel.flowRoute', { route: model.flowPlan.route })}
            </span>
          ) : null}
          {model.snapshot?.repair !== undefined ? (
            <span
              data-flowgate="panel-repair"
              data-fix-id={model.snapshot.repair.id}
              data-red={model.snapshot.repair.red ? 'true' : 'false'}
              data-green={model.snapshot.repair.green ? 'true' : 'false'}
              title={model.snapshot.repair.verify}
              style={{
                fontSize: 10.5,
                lineHeight: '16px',
                color: COLORS.info,
                border: `0.5px solid ${COLORS.border}`,
                borderRadius: 999,
                padding: '0 6px',
              }}
            >
              {t('dock.repair.badge', { id: model.snapshot.repair.id })}
            </span>
          ) : null}
          {model.snapshot?.takeover === 'observe' ? (
            <span
              data-flowgate="panel-mode"
              data-mode="observe"
              style={{ fontSize: 10.5, color: COLORS.dim, border: `0.5px solid ${COLORS.border}`, borderRadius: 999, padding: '0 6px' }}
            >
              {t('dock.mode.observe')}
            </span>
          ) : null}
          {model.snapshot?.incident !== undefined ? (
            <span
              data-flowgate="panel-incident"
              data-incident-id={model.snapshot.incident.id}
              data-severity={model.snapshot.incident.severity}
              title={model.snapshot.incident.reason}
              style={{ fontSize: 10.5, color: COLORS.warn, border: `0.5px solid ${COLORS.border}`, borderRadius: 999, padding: '0 6px' }}
            >
              {t('dock.incident.badge', { id: model.snapshot.incident.id })}
            </span>
          ) : null}
          {model.off ? <span style={{ fontSize: 11, color: COLORS.fail }}>{t('tone.blocked')}</span> : null}
        </div>
      </header>

      {!model.initialized ? (
        <div
          data-flowgate="panel-demo"
          style={{
            fontSize: 11.5,
            color: COLORS.warn,
            background: TONES.attention.bg,
            border: `1px solid ${TONES.attention.border}`,
            borderRadius: 7,
            padding: '5px 8px',
          }}
        >
          {t('panel.notInitialized')}
        </div>
      ) : null}

      {notice !== undefined ? (
        <Notice text={notice.text} tone={notice.tone} onDismiss={onDismissNotice} t={t} />
      ) : null}

      <div role="tablist" aria-label={t('panel.tabsAria')} data-flowgate="panel-tabs" style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
        {PANEL_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            data-tab={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              fontFamily: UI_FONT,
              fontSize: 11,
              padding: '2px 9px',
              borderRadius: 7,
              border: `1px solid ${activeTab === tab.id ? COLORS.info : COLORS.border}`,
              background: activeTab === tab.id ? COLORS.infoBg : 'transparent',
              color: activeTab === tab.id ? COLORS.text : COLORS.dim,
              cursor: 'pointer',
            }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div role="tabpanel" data-flowgate="panel-view" data-active-tab={activeTab}>
        {activeTab === 'ledger' ? <LedgerView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'pipeline' ? <PipelineView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'gates' ? <GatesView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'tasks' ? <TasksView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'agents' ? (
          <SubagentsView
            model={model}
            t={t}
            onAction={onAction}
            {...(runtime !== undefined ? { runtime } : {})}
            {...(runtime?.bridge !== undefined ? { bridge: runtime.bridge } : {})}
            {...(runtime?.sessionId !== undefined ? { sessionId: runtime.sessionId } : {})}
          />
        ) : null}
        {activeTab === 'jobs' ? (
          <JobsView
            model={model}
            t={t}
            onAction={onAction}
            {...(runtime?.bridge !== undefined ? { bridge: runtime.bridge } : {})}
            {...(runtime?.sessionId !== undefined ? { sessionId: runtime.sessionId } : {})}
          />
        ) : null}
        {activeTab === 'trace' ? <TraceView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'risk' ? <RiskView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'intercepts' ? <InterceptsView model={model} t={t} onAction={onAction} /> : null}
        {activeTab === 'metrics' ? <MetricsView model={model} t={t} onAction={onAction} /> : null}
      </div>
    </div>
  )
}

export interface PanelProps {
  props: SlotPropRecord
  t: TFn
  bridge?: HostBridge
}

/** Structural access to the standard session-status hook beyond the base record. */
interface RuntimeSlotProps {
  useSessionStatus?: (selector: (statuses: ReadonlyMap<string, { running?: boolean } | undefined>) => string) => string
}

/** Read one additional session projection value (never throws during SSR). */
function readSlotProjection(props: SlotPropRecord, key: string): unknown {
  if (typeof props.useProjection !== 'function') return undefined
  try {
    return props.useProjection(key)
  } catch {
    return undefined
  }
}

/**
 * Ask the standard `useSessionStatus` hook for a stable running-key string in
 * catalog order (`'1'/'0'` per child). Missing hook → '' (views fall back to
 * task states / idle dots).
 */
function readRunningKey(props: SlotPropRecord, catalogRaw: unknown): string {
  const useSessionStatus = (props as RuntimeSlotProps).useSessionStatus
  if (typeof useSessionStatus !== 'function') return ''
  const ids = catalogIds(parseCatalog(catalogRaw))
  try {
    return useSessionStatus((statuses) =>
      ids.map((id) => (statuses.get(id)?.running === true ? '1' : '0')).join(''),
    )
  } catch {
    return ''
  }
}

/** Slot container. */
export function Panel({ props, t, bridge }: PanelProps): React.ReactElement {
  const projection = readProjection(props)
  // Standard session projections for the v0.3 runtime views; both hook calls
  // stay unconditional so the hook order never changes across renders.
  const runtimeCatalog = readSlotProjection(props, 'subagentCatalog')
  const runtimeRunningKey = readRunningKey(props, runtimeCatalog)
  const [remoteProjection, setRemoteProjection] = React.useState<FlowgateProjection | null>(null)
  const [activeTab, setActiveTab] = React.useState<PanelTab>('pipeline')
  const [notice, setNotice] = React.useState<{ text: string; tone: 'ok' | 'warn' | 'error' } | undefined>(undefined)

  const effective = projection ?? remoteProjection

  const refresh = React.useCallback(async (): Promise<void> => {
    if (bridge === undefined) return
    const raw = await bridge.readState()
    const next = normalizeProjection(raw)
    if (next !== null) setRemoteProjection(next)
  }, [bridge])

  React.useEffect(() => {
    if (projection !== null || bridge === undefined) return
    let alive = true
    void (async () => {
      const raw = await bridge.readState()
      const next = normalizeProjection(raw)
      if (alive && next !== null) setRemoteProjection(next)
    })()
    return () => {
      alive = false
    }
  }, [projection, bridge])

  const model = React.useMemo(() => buildPanelModel(effective, t), [effective, t])

  const sessionId = sessionIdOf(props)
  const handleAction = (action: ClientAction): void => {
    void (async () => {
      const outcome = await performAction(action, {
        t,
        ...(bridge !== undefined ? { remote: bridge.remote() } : {}),
        ...(bridge !== undefined
          ? {
              // Click-to-execute: the panel button click is the authorization.
              // The equivalent /flow line is submitted through the host command
              // remote, so the composer draft never receives a command.
              executeCommand: (command: string) => bridge.runCommand(command, sessionId),
              fillCommand: (command: string) => bridge.fillCommand(command, sessionId),
              copyText: (text: string) => bridge.copyText(text),
              openPanel: () => bridge.openPanel(),
            }
          : {}),
      })
      setNotice({
        text: outcome.message,
        tone: outcome.ok ? (outcome.fallback ? 'warn' : 'ok') : 'error',
      })
      await refresh()
    })()
  }

  return (
    <PanelSurface
      model={model}
      t={t}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onAction={handleAction}
      {...(notice !== undefined ? { notice } : {})}
      onDismissNotice={() => setNotice(undefined)}
      runtime={{
        catalog: runtimeCatalog,
        projection: effective,
        runningKey: runtimeRunningKey,
        ...(bridge !== undefined ? { bridge } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      }}
    />
  )
}
