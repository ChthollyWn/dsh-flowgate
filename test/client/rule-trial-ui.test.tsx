/**
 * Rule dry-run card (T5.1 / FR-9.4 fallback): the browser-local trial must be
 * honest about its fidelity.
 *
 *  - it honours `snapshot.off` (allow) and `snapshot.locked` (deny);
 *  - it honours active `snapshot.exceptions` (allow the matched rule);
 *  - it always states "本地近似试跑：精确判定以宿主规则引擎为准" and lists
 *    project-defined rules the browser cannot evaluate.
 *
 * Interaction runs through `hook-harness` (node environment, no jsdom).
 */
import { describe, expect, it } from 'vitest'
import { buildPanelModel } from '../../src/client/model'
import { InterceptsView } from '../../src/client/panel/views/Intercepts'
import type { ViewProps } from '../../src/client/panel/view-types'
import { createTranslator } from '../../src/client/i18n'
import type { TFn } from '../../src/client/i18n'
import type { ClientAction } from '../../src/client/actions'
import type { ExceptionRecord } from '../../src/core/types'
import { click, findByData, htmlOf, mountWithHooks } from './hook-harness'
import type { MountedView } from './hook-harness'
import { makePanel, makeProjection } from './mock'

const zh = createTranslator('zh')
const en = createTranslator('en')
const noop = (_action: ClientAction): void => {}

function mountTrial(
  project = makeProjection(),
  locale: TFn = zh,
): MountedView<ViewProps> {
  const view = mountWithHooks<ViewProps>(InterceptsView, {
    model: buildPanelModel(project, locale),
    t: locale,
    onAction: noop,
  })
  click(findByData(view.tree, 'data-tab', 'trial')!)
  view.render()
  click(findByData(view.tree, 'data-action', 'rule-trial-run')!)
  view.render()
  return view
}

describe('intercepts view — rule trial card (T5.1)', () => {
  it('renders the local approximation result and disclaimer', () => {
    const view = mountTrial()
    expect(view.html).toContain('data-flowgate="trial-result"')
    // Default trial input (edit src/main/java/A.java, stage S3) hits R-STAGE-SRC.
    expect(view.html).toContain('data-decision="deny"')
    expect(view.html).toContain('data-basis="rule"')
    expect(view.html).toContain('data-approximate="true"')
    expect(view.html).toContain('命中 R-STAGE-SRC')
    expect(view.html).toContain('本地近似试跑：精确判定以宿主规则引擎为准')
    expect(view.html).not.toContain('data-flowgate="trial-uncovered"')
  })

  it('lists project-defined rules it cannot evaluate locally', () => {
    const panel = makePanel()
    const project = makeProjection({
      panel: {
        ...panel,
        rules: [
          ...(panel.rules ?? []),
          { id: 'R-CUSTOM', decision: 'deny', why: '项目自定义规则', unlock: '找负责人', hits: 0, source: '项目' },
        ],
      },
    })
    const view = mountTrial(project)
    expect(view.html).toContain('data-flowgate="trial-uncovered"')
    expect(view.html).toContain('R-CUSTOM')
    expect(view.html).toContain('精确判定以宿主规则引擎为准')
  })

  it('respects snapshot.off by allowing the action', () => {
    const view = mountTrial(makeProjection({ snapshot: { off: true } }))
    expect(view.html).toContain('data-decision="allow"')
    expect(view.html).toContain('data-basis="off"')
    expect(view.html).toContain('FlowGate 已关闭 off')
    expect(view.html).toContain('本地近似试跑')
  })

  it('respects snapshot.locked by denying the action', () => {
    const view = mountTrial(makeProjection({ snapshot: { locked: true } }))
    expect(view.html).toContain('data-decision="deny"')
    expect(view.html).toContain('data-basis="locked"')
    expect(view.html).toContain('锁定模式')
  })

  it('allows the action when an active exception matches the rule path', () => {
    const exceptions: ExceptionRecord[] = [
      {
        id: 'EX-1',
        ruleId: 'R-STAGE-SRC',
        changeId: 'C-003',
        pathPattern: 'src/**',
        reason: '迁移期放行',
        createdAt: '2026-10-31T09:00:00+08:00',
      },
    ]
    const view = mountTrial(makeProjection({ snapshot: { exceptions } }))
    expect(view.html).toContain('data-decision="allow"')
    expect(view.html).toContain('data-basis="exception"')
    expect(view.html).toContain('EX-1')
    expect(view.html).toContain('R-STAGE-SRC')
  })

  it('keeps the denial when the exception path does not match', () => {
    const exceptions: ExceptionRecord[] = [
      {
        id: 'EX-2',
        ruleId: 'R-STAGE-SRC',
        changeId: 'C-003',
        pathPattern: 'docs/**',
        reason: '只放行文档',
        createdAt: '2026-10-31T09:00:00+08:00',
      },
    ]
    const view = mountTrial(makeProjection({ snapshot: { exceptions } }))
    expect(view.html).toContain('data-decision="deny"')
    expect(view.html).toContain('data-basis="rule"')
    // The exception still shows in the active-exceptions section, but it must
    // not have allowed the verdict.
    expect(htmlOf(findByData(view.tree, 'data-flowgate', 'trial-result')!)).not.toContain('例外 EX-2')
  })

  it('ignores revoked exceptions', () => {
    const exceptions: ExceptionRecord[] = [
      {
        id: 'EX-3',
        ruleId: 'R-STAGE-SRC',
        changeId: 'C-003',
        pathPattern: 'src/**',
        reason: '已撤销',
        createdAt: '2026-10-31T09:00:00+08:00',
        revokedAt: '2026-10-31T10:00:00+08:00',
      },
    ]
    const view = mountTrial(makeProjection({ snapshot: { exceptions } }))
    expect(view.html).toContain('data-decision="deny"')
    expect(htmlOf(findByData(view.tree, 'data-flowgate', 'trial-result')!)).not.toContain('例外 EX-3')
  })

  it('localizes the disclaimer in English', () => {
    const view = mountTrial(makeProjection(), en)
    expect(view.html).toContain('the host rule engine is authoritative')
    expect(view.html).not.toMatch(/intercepts\.[a-zA-Z]/)
  })
})
