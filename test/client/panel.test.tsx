/** SSR tests for all eight panel views and the panel surface (FR-8.2 / T2.6 / T3.6 / T5.1). */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PanelSurface, PANEL_TABS } from '../../src/client/panel/Panel'
import type { PanelTab } from '../../src/client/panel/Panel'
import { Panel } from '../../src/client/panel/Panel'
import { LedgerView } from '../../src/client/panel/views/Ledger'
import { PipelineView } from '../../src/client/panel/views/Pipeline'
import { GatesView } from '../../src/client/panel/views/Gates'
import { TasksView } from '../../src/client/panel/views/Tasks'
import { TraceView } from '../../src/client/panel/views/Trace'
import { RiskView } from '../../src/client/panel/views/Risk'
import { InterceptsView } from '../../src/client/panel/views/Intercepts'
import { MetricsView } from '../../src/client/panel/views/Metrics'
import { buildPanelModel } from '../../src/client/model'
import type { PanelModel } from '../../src/client/model'
import { createTranslator } from '../../src/client/i18n'
import type { ClientAction } from '../../src/client/actions'
import { makeEmptyProjection, makeLowComplexityProjection, makeProjection } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (_action: ClientAction): void => {}

function model(projection = makeProjection()): PanelModel {
  return buildPanelModel(projection, zh)
}

function renderSurface(activeTab: PanelTab, panelModel = model(), t = zh, onAction = noop): string {
  return renderToStaticMarkup(
    <PanelSurface model={panelModel} t={t} activeTab={activeTab} onTabChange={() => {}} onAction={onAction} />,
  )
}

describe('panel surface', () => {
  it('renders the header, all eight tabs and the active view', () => {
    const html = renderSurface('pipeline')
    expect(html).toContain('data-flowgate="panel"')
    expect(html).toContain('C-003')
    expect(html).toContain('会员续费')
    expect(html).toContain('中 · 普通风险')
    expect(html).toContain('③ 设计拆解')
    // The compact seven-stage rail is visible from every tab.
    expect(html).toContain('data-flowgate="panel-rail"')
    expect(html).toContain('data-flowgate="flow-rail"')
    expect((html.match(/data-flowgate="rail-node"/g) ?? []).length).toBe(7)
    for (const tab of PANEL_TABS) {
      expect(html).toContain(`data-tab="${tab.id}"`)
    }
    // v0.3 runtime views are registered as native tabs (zh labels).
    expect(html).toContain('data-tab="agents"')
    expect(html).toContain('子代理')
    expect(html).toContain('data-tab="jobs"')
    expect(html).toContain('后台')
    expect((html.match(/data-tab="/g) ?? []).length).toBe(10)
    expect(html).toContain('data-active-tab="pipeline"')
    expect(html).toContain('data-flowgate="view-pipeline"')
  })

  it('no longer renders the removed learning-mode selector', () => {
    const html = renderSurface('pipeline')
    expect(html).not.toContain('data-flowgate="learning-mode"')
    expect(html).not.toContain('学习模式')
    expect(html).not.toContain('Learning mode')
  })

  it('shows the auto-flow route badge from snapshot.flowPlan', () => {
    const projection = makeProjection({
      snapshot: {
        flowPlan: { route: 'fast', autoApprove: true, verdict: 'approved', reasons: ['需求清晰、范围小'] },
      },
    })
    const html = renderSurface('pipeline', buildPanelModel(projection, zh))
    expect(html).toContain('data-flowgate="panel-flow-route"')
    expect(html).toContain('data-route="fast"')
    expect(html).toContain('自动流程 · fast')
  })

  it('shows the not-enabled banner and empty states for an uninitialized project', () => {
    const html = renderSurface('ledger', buildPanelModel(makeEmptyProjection(), zh))
    expect(html).toContain('data-flowgate="panel-demo"')
    expect(html).toContain('FlowGate 未启用')
    expect(html).toContain('data-initialized="false"')
    expect(html).toContain('还没有变更')
  })

  it('renders English chrome without leaking keys', () => {
    const html = renderSurface('pipeline', model(), en)
    expect(html).toContain('Seven-stage pipeline')
    expect(html).not.toContain('tab.pipeline')
  })

  it('every tab renders its view with mock data', () => {
    const markers: Record<PanelTab, string> = {
      ledger: 'view-ledger',
      pipeline: 'view-pipeline',
      gates: 'view-gates',
      tasks: 'view-tasks',
      agents: 'view-agents',
      jobs: 'view-jobs',
      trace: 'view-trace',
      risk: 'view-risk',
      intercepts: 'view-intercepts',
      metrics: 'view-metrics',
    }
    for (const tab of PANEL_TABS) {
      const html = renderSurface(tab.id)
      expect(html).toContain(`data-active-tab="${tab.id}"`)
      expect(html).toContain(`data-flowgate="${markers[tab.id]}"`)
    }
  })
})

describe('ledger view (T3.7)', () => {
  it('lists every change with level, stage, lifecycle and actions', () => {
    const html = renderToStaticMarkup(<LedgerView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('C-003')
    expect(html).toContain('C-002')
    expect(html).toContain('A-001')
    expect(html).toContain('已暂停')
    expect(html).toContain('data-badge="current"')
    expect(html).toContain('data-action="ledger-takeover-C-002"')
    expect(html).toContain('data-action="ledger-continue-C-003"')
    expect(html).toContain('web-1a2b')
  })

  it('falls back to the snapshot when the host sends no ledger', () => {
    const bare = buildPanelModel({ ...makeProjection(), panel: {} }, zh)
    const html = renderToStaticMarkup(<LedgerView model={bare} t={zh} onAction={noop} />)
    expect(html).toContain('C-003')
    expect(html).toContain('会员续费')
  })

  it('shows an empty state with /flow new hint', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<LedgerView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('还没有变更')
  })
})

describe('pipeline view (graphical flow page, contract §3)', () => {
  it('renders the hero, vertical flow map, you-are-here marker and next callout', () => {
    const html = renderToStaticMarkup(<PipelineView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="pipeline-hero"')
    expect(html).toContain('data-stage="S3"')
    expect(html).toContain('data-flowgate="progress-ring"')
    expect(html).toContain('data-value="3"')
    expect(html).toContain('data-max="7"')
    expect(html).toContain('data-flowgate="flow-map"')
    expect((html.match(/data-flowgate="flow-map-node"/g) ?? []).length).toBe(7)
    expect((html.match(/data-you-are-here="true"/g) ?? []).length).toBe(1)
    expect(html).toContain('你在这里')
    // Human gates get a shield glyph, automatic gates a spark glyph.
    expect(html).toContain('data-gate-kind="human"')
    expect(html).toContain('data-gate-kind="auto"')
    expect(html).toContain('data-flowgate="next-step-callout"')
    expect(html).toContain('data-kind="human"')
    expect(html).toContain('data-flowgate="live-checks"')
    // No user-visible command anywhere on the flow page.
    expect(html).not.toContain('/flow')
    // Native tokens only: no hard-coded palette on the flow page.
    expect(html).toContain('var(--dsw-alias-label-primary')
    expect(html).toContain('var(--dsw-alias-border-l2')
    expect(html).not.toContain('#2563eb')
    // StageCard keeps tiny semantic ✓/✗ accents (learning content, T5 scope).
  })

  it('renders seven stage nodes with status, artifact chips and live checks', () => {
    const html = renderToStaticMarkup(<PipelineView model={model()} t={zh} onAction={noop} />)
    expect((html.match(/data-flowgate="stage-node"/g) ?? []).length).toBe(7)
    expect(html).toContain('data-stage="S3"')
    expect(html).toContain('data-stage-status="current"')
    expect(html).toContain('data-stage-status="done"')
    expect(html).toContain('data-flowgate="map-artifacts"')
    expect((html.match(/data-flowgate="artifact-chip"/g) ?? []).length).toBeGreaterThan(0)
    expect(html).toContain('data-flowgate="live-checks"')
    // The removed learning cards/glossary never render again.
    expect(html).not.toContain('data-flowgate="stage-card')
    expect(html).not.toContain('data-flowgate="glossary')
    expect(html).not.toContain('Superpowers writing-plans')
    expect(html).toContain('S3')
    expect(html).toContain('设计拆解')
  })

  it('shows roadmap progress when the host sends it', () => {
    const html = renderToStaticMarkup(<PipelineView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('1/4 已交付')
    expect(html).toContain('MVP 内')
    expect(html).toContain('MVP 外')
    expect((html.match(/data-flowgate="roadmap-entry"/g) ?? []).length).toBe(3)
  })

  it('shows an empty state without pipeline data', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<PipelineView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无阶段数据')
  })
})

describe('gates view (T2.6 / T2.8)', () => {
  it('renders gate items, failed hints and approve/reject buttons', () => {
    const html = renderToStaticMarkup(<GatesView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="gate-items"')
    expect((html.match(/data-flowgate="gate-item"/g) ?? []).length).toBe(3)
    expect(html).toContain('data-passed="false"')
    expect(html).toContain('提示：新增任务或并入 T3')
    expect(html).toContain('data-action="gate-approve"')
    expect(html).toContain('data-action="gate-reject"')
    // Native plan-card shell + native buttons (no blue/red filled buttons).
    expect(html).toContain('class="fg-plan-card"')
    expect(html).toContain('data-flowgate="auth-shimmer"')
    expect(html).toContain('fg-native-btn-primary')
    expect(html).toContain('fg-native-btn-outline')
    expect(html).not.toContain('#2563eb')
    expect(html).toContain('门 G3')
    expect(html).toContain('data-flowgate="execution-graph"')
  })

  it('renders the low-complexity confirmation card with approve / reject / raise', () => {
    const low = buildPanelModel(makeLowComplexityProjection(), zh)
    const html = renderToStaticMarkup(<GatesView model={low} t={zh} onAction={noop} />)
    expect(html).toContain('data-confirm-card="true"')
    expect(html).toContain('低复杂度方案确认卡')
    expect(html).toContain('把首页按钮文案改成')
    expect(html).toContain('data-action="confirm-card-approve"')
    expect(html).toContain('data-action="confirm-card-reject"')
    expect(html).toContain('data-action="confirm-card-raise"')
  })

  it('shows the no-gate empty state', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<GatesView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('当前没有等待你的门禁')
  })

  it('lists active exceptions with a revoke action (T5.1 验收 #1)', () => {
    const projection = makeProjection({
      snapshot: {
        exceptions: [
          { id: 'EX-1', ruleId: 'R-SCOPE', pathPattern: 'src/legacy/**', reason: '迁移期放行', createdAt: '2026-11-01T09:00:00+08:00', changeId: 'C-003' },
        ],
      },
    })
    const html = renderToStaticMarkup(<GatesView model={buildPanelModel(projection, zh)} t={zh} onAction={noop} />)
    void html
    const intercepts = renderToStaticMarkup(<InterceptsView model={buildPanelModel(projection, zh)} t={zh} onAction={noop} />)
    expect(intercepts).toContain('data-flowgate="exceptions"')
    expect(intercepts).toContain('src/legacy/**')
    expect(intercepts).toContain('data-action="revoke-exception-EX-1"')
  })

  it('lists non-agent changes with a confirm action (T1.4 验收 #3)', () => {
    const projection = makeProjection({
      snapshot: {
        externalChanges: [
          { path: 'src/manual.ts', at: '2026-11-01T09:00:00+08:00', origin: 'external' },
          { path: 'src/unknown.ts', at: '2026-11-01T09:01:00+08:00', origin: 'unknown' },
        ],
      },
    })
    const html = renderToStaticMarkup(<GatesView model={buildPanelModel(projection, zh)} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="external-changes"')
    expect(html).toContain('src/manual.ts')
    expect(html).toContain('src/unknown.ts')
    expect(html).toContain('来源未归因')
    expect(html).toContain('data-action="confirm-external-all"')
  })
})

describe('tasks view (T3.6 / T5.1)', () => {
  it('renders the execution graph and the four board columns', () => {
    const html = renderToStaticMarkup(<TasksView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="execution-graph"')
    expect(html).toContain('data-node-count="4"')
    expect(html).toContain('data-column="todo"')
    expect(html).toContain('data-column="running"')
    expect(html).toContain('data-column="done"')
    expect(html).toContain('data-column="blocked"')
    expect((html.match(/data-flowgate="task-card"/g) ?? []).length).toBe(4)
  })

  it('marks a stale GREEN badge and shows worktrees and review findings', () => {
    const html = renderToStaticMarkup(<TasksView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-badge="evidence-stale"')
    expect(html).toContain('data-badge="evidence-fresh"')
    expect(html).toContain('data-badge="tdd-red"')
    expect(html).toContain('.flowgate/worktrees/C-003-T2')
    expect(html).toContain('审查发现 2')
  })

  it('shows scope-change pending decisions', () => {
    const html = renderToStaticMarkup(<TasksView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-pending-id="SC-1"')
    expect(html).toContain('批准范围变更')
  })

  it('shows an empty state without task cards', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<TasksView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无执行流程图')
    expect(html).toContain('暂无任务卡')
  })
})

describe('trace view (FR-8.2)', () => {
  it('renders the matrix with covered and missing cells highlighted', () => {
    const html = renderToStaticMarkup(<TraceView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="trace-table"')
    expect(html).toContain('R1.S1')
    expect(html).toContain('R2.S3')
    expect(html).toContain('data-missing="true"')
    expect(html).toContain('data-badge="trace-missing"')
    expect(html).toContain('未覆盖场景：R2.S3')
    expect(html).toContain('覆盖 1/2')
  })

  it('shows an empty state without traceability data', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<TraceView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无追溯数据')
  })
})

describe('risk view (T4.1 / T5.1)', () => {
  it('renders the risk register and pending risk items', () => {
    const html = renderToStaticMarkup(<RiskView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="risk-table"')
    expect(html).toContain('安全')
    expect(html).toContain('支付回调未验签')
    expect(html).toContain('data-badge="grade-high"')
    expect(html).toContain('data-pending-id="RK-1"')
    expect(html).toContain('data-action="risk-approve-RK-1"')
    expect(html).toContain('data-action="risk-reject-RK-1"')
  })

  it('shows empty states without risk data', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<RiskView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无风险登记')
    expect(html).toContain('暂无待处理风险项')
  })
})

describe('intercepts view (FR-9.3 / T5.1)', () => {
  it('renders the intercept log with false-positive feedback and evidence actions', () => {
    const html = renderToStaticMarkup(<InterceptsView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="intercepts-table"')
    expect(html).toContain('R-STAGE-SRC')
    expect(html).toContain('src/main/java/RenewalService.java')
    expect(html).toContain('data-badge="effect-deny"')
    expect(html).toContain('data-badge="effect-human"')
    expect(html).toContain('data-action="intercept-feedback-0"')
    expect(html).toContain('data-action="intercept-copy-0"')
    expect(html).toContain('data-tab="trial"')
  })

  it('shows an empty state without intercepts', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<InterceptsView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无拦截记录')
  })
})

describe('metrics view (FR-10.2 / T5.1)', () => {
  it('renders M-1..M-18 rows, 未知 values and export buttons', () => {
    const html = renderToStaticMarkup(<MetricsView model={model()} t={zh} onAction={noop} />)
    expect(html).toContain('data-flowgate="metrics-table"')
    expect((html.match(/data-metric-id="/g) ?? []).length).toBe(18)
    expect(html).toContain('data-metric-id="M-1" data-value="2"')
    expect(html).toContain('data-metric-id="M-5" data-value="未知"')
    expect(html).toContain('data-action="metrics-export-csv"')
    expect(html).toContain('data-action="metrics-export-json"')
    expect(html).toContain('导出 CSV')
  })

  it('shows an empty metrics state when nothing was generated', () => {
    const empty = buildPanelModel(makeEmptyProjection(), zh)
    const html = renderToStaticMarkup(<MetricsView model={empty} t={zh} onAction={noop} />)
    expect(html).toContain('暂无指标')
  })
})

describe('Panel slot container', () => {
  it('renders the demo surface without a projection and never throws', () => {
    const html = renderToStaticMarkup(<Panel props={{}} t={zh} />)
    expect(html).toContain('data-flowgate="panel"')
    expect(html).toContain('data-initialized="false"')
  })

  it('reads the projection from the standard kit and shows data', () => {
    const props = {
      sessionId: 'web-1a2b',
      useProjection: (key: string) => (key === 'flowgate' ? makeProjection() : undefined),
    }
    const html = renderToStaticMarkup(<Panel props={props} t={zh} />)
    expect(html).toContain('data-initialized="true"')
    expect(html).toContain('C-003')
  })
})

// Keep `vi` available for future interaction tests without changing the file shape.
void vi
