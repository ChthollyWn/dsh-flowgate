/**
 * SSR tests for the conversation `tool.call.toolview` rows.
 *
 * The client bundle is node/SSR-testable: rows are pure functions over the slot
 * props + session projection, so `renderToStaticMarkup` is a faithful static
 * snapshot without jsdom. Coverage:
 * - DOM contract from docs/impl/ui-interaction-redesign.md §1.2
 *   (`flow-toolview` container, `flow-rail` + `rail-node` attributes),
 * - projection-driven status line (change / stage / awaiting gate) with no
 *   user-facing `/flow ...` command text,
 * - lifecycle states from the tool call phase/result block,
 * - defensive degradation (missing projection, malformed host payloads),
 * - registration contract (name/key/locale, dedupe, disposers) against a fake
 *   Cordis context.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FLOW_TOOL_NAMES,
  TOOL_STAGE_HINT,
  TOOLVIEW_SLOT,
  FlowToolRow,
  activeFlowToolviews,
  registerFlowToolViews,
} from '../../src/client/toolviews'
import type { FlowToolRowProps } from '../../src/client/toolviews'
import { TOOLVIEW_CSS, ensureToolviewStyles } from '../../src/client/toolviews/styles'
import { createTranslator } from '../../src/client/i18n'
import type { RuntimeSnapshot } from '../../src/core/types'
import type { ClientContext, FlowgateProjection } from '../../src/client/types'
import { LOCALE_NS } from '../../src/client/types'

const zh = createTranslator('zh')
const en = createTranslator('en')

/**
 * Local projection fixture. Deliberately self-contained rather than importing
 * the shared `test/client/mock.ts` (owned by another workstream that is still
 * moving): these tests pin the exact wire shape this row reads.
 */
function makeProjection(snapshotOverrides: Partial<RuntimeSnapshot> = {}): FlowgateProjection {
  const snapshot: RuntimeSnapshot = {
    initialized: true,
    changeId: 'C-003',
    title: '会员续费',
    kind: 'change',
    complexity: 'medium',
    risk: 'normal',
    stage: 'S3',
    lifecycle: 'active',
    awaitingGate: 'G3',
    pendingGate: 'G3',
    pipeline: [
      { stage: 'S0', label: '立项', status: 'done' },
      { stage: 'S1', label: '需求澄清', status: 'done' },
      { stage: 'S2', label: '上下文', status: 'done' },
      { stage: 'S3', label: '设计拆解', status: 'current' },
      { stage: 'S4', label: '执行', status: 'pending' },
      { stage: 'S5', label: '验证', status: 'pending' },
      { stage: 'S6', label: '交付', status: 'pending' },
    ],
    tasks: {},
    batches: [],
    pending: [],
    violations: [],
    off: false,
    locked: false,
    interceptCounts: {},
    nextStep: '',
    statusLine: '',
    updatedAt: '2026-10-30T09:20:00Z',
    ...snapshotOverrides,
  }
  return {
    snapshot,
    panel: { gate: { gate: 'G3', state: 'awaiting', awaitingOwner: true, items: [] } },
    revision: 7,
    updatedAt: '2026-10-30T09:20:00Z',
  }
}

function makeEmptyProjection(): FlowgateProjection {
  return makeProjection({
    initialized: false,
    changeId: undefined,
    stage: undefined,
    awaitingGate: undefined,
    pendingGate: undefined,
    pipeline: [],
  })
}

/** The wire tool names the row must cover (definitions.ts + dispatch tool). */
const EXPECTED_TOOL_NAMES = [
  'flow_status',
  'flow_new_change',
  'flow_submit',
  'flow_task_start',
  'flow_task_done',
  'flow_request_scope_change',
  'flow_report_risk',
  'flow_attach_evidence',
  'flow_verify',
  'flow_request_plan_change',
  'flow_propose_rule',
  'flow_investigate',
  'flow_submit_analysis',
  'flow_declare_rework',
  'flow_diff',
  'flow_dispatch_next',
]

function baseProps(
  overrides: Partial<Record<string, unknown>> = {},
  projection: FlowgateProjection | null = makeProjection(),
): FlowToolRowProps {
  return {
    callId: 'call-1',
    toolName: 'flow_submit',
    phase: 'start',
    block: { phase: 'start', callId: 'call-1', name: 'flow_submit' },
    t: zh,
    ...(projection === null ? {} : { useProjection: (key: string) => (key === 'flowgate' ? projection : undefined) }),
    ...overrides,
  }
}

function render(props: FlowToolRowProps): string {
  return renderToStaticMarkup(<FlowToolRow {...props} />)
}

describe('FlowToolRow DOM contract', () => {
  it('renders the flow-toolview container with a seven-node flow-rail', () => {
    const html = render(baseProps())
    expect(html).toContain('data-flowgate="flow-toolview"')
    expect(html).toContain('data-flowgate="flow-rail"')
    expect((html.match(/data-flowgate="rail-node"/g) ?? []).length).toBe(7)
    expect(html).toContain('data-tool="flow_submit"')
    expect(html).toContain('data-projected="true"')
    expect(html).toMatch(/data-flowgate="rail-node" data-stage="S0" data-status="done" data-current="false"/)
    expect(html).toMatch(/data-flowgate="rail-node" data-stage="S3" data-status="current" data-current="true"/)
    expect(html).toMatch(/data-flowgate="rail-node" data-stage="S6" data-status="pending" data-current="false"/)
  })

  it('shows the tool name, the projection stage and the awaiting gate without shell commands', () => {
    const html = render(baseProps())
    expect(html).toContain('flow_submit')
    expect(html).toContain('C-003')
    expect(html).toContain('③ 设计拆解')
    expect(html).toContain('G3 等你批准计划')
    expect(html).toContain('进行中')
    // A tool row must never tell the owner to type a command.
    expect(html).not.toContain('/flow')
  })

  it('reflects the tool call lifecycle in data-state / the status line', () => {
    const preparing = render(baseProps({ phase: 'preparing', block: { phase: 'preparing', callId: 'call-1', name: 'flow_submit' } }))
    expect(preparing).toContain('data-state="preparing"')
    expect(preparing).toContain('排队')

    const ok = render(baseProps({ phase: 'result', block: { kind: 'result', callId: 'call-1', isError: false } }))
    expect(ok).toContain('data-state="ok"')
    expect(ok).toContain('完成')

    const failed = render(baseProps({ phase: 'result', block: { kind: 'result', callId: 'call-1', isError: true } }))
    expect(failed).toContain('data-state="error"')
    expect(failed).toContain('失败')

    const interrupted = render(
      baseProps({ phase: 'result', block: { kind: 'result', callId: 'call-1', isError: true, error: { code: 'interrupted' } } }),
    )
    expect(interrupted).toContain('data-state="stopped"')
    expect(interrupted).toContain('中断')
  })

  it('infers the phase from the block when the owner phase prop is absent', () => {
    const html = render(baseProps({ phase: undefined, block: { kind: 'result', callId: 'call-1', isError: false } }))
    expect(html).toContain('data-phase="result"')
    expect(html).toContain('data-state="ok"')
  })

  it('renders English copy without leaking locale keys', () => {
    const html = render(baseProps({ t: en }))
    expect(html).toContain('flow_submit')
    expect(html).toContain('waiting for you to approve the plan')
    expect(html).toContain('Running')
    expect(html).not.toContain('stage.S3')
    expect(html).not.toContain('tasks.status.running')
  })
})

describe('FlowToolRow degradation', () => {
  it('degrades to one safe line when there is no projection hook at all', () => {
    const html = render(baseProps({}, null))
    expect(html).toContain('data-flowgate="flow-toolview"')
    expect(html).toContain('data-projected="false"')
    expect(html).not.toContain('data-flowgate="flow-rail"')
    expect(html).toContain('flow_submit')
    // "阶段文字": the tool's usual stage is still shown as a fallback hint.
    expect(html).toContain('设计拆解')
  })

  it('degrades to a demo line when FlowGate is not initialized', () => {
    const html = render(baseProps({}, makeEmptyProjection()))
    expect(html).toContain('data-initialized="false"')
    expect(html).not.toContain('data-flowgate="flow-rail"')
    expect(html).toContain('未启用')
  })

  it('keeps the rail stable when the host pipeline is partial', () => {
    const projection = makeProjection({
      pipeline: [
        { stage: 'S0', label: '立项', status: 'done' },
        { stage: 'S3', label: '设计拆解', status: 'current' },
      ],
    })
    const html = render(baseProps({}, projection))
    expect((html.match(/data-flowgate="rail-node"/g) ?? []).length).toBe(7)
    expect(html).toMatch(/data-stage="S1" data-status="pending"/)
    expect(html).toMatch(/data-stage="S4" data-status="pending"/)
  })

  it('keeps a blocked current stage blocked while still marking it current', () => {
    const projection = makeProjection({
      awaitingGate: undefined,
      pendingGate: undefined,
      pipeline: [
        { stage: 'S0', label: '立项', status: 'done' },
        { stage: 'S3', label: '设计拆解', status: 'blocked' },
      ],
    })
    const html = render(baseProps({}, projection))
    expect(html).toMatch(/data-flowgate="rail-node" data-stage="S3" data-status="blocked" data-current="true"/)
  })

  it('never throws on malformed props / hostile payloads', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
        has() {
          throw new Error('boom')
        },
      },
    ) as never
    expect(() =>
      render({
        callId: 42,
        toolName: '<script>alert(1)</script>',
        phase: { nope: true },
        block: hostile,
        t: 'not-a-translator',
        useProjection: () => {
          throw new Error('projection exploded')
        },
      }),
    ).not.toThrow()
    const html = render({
      toolName: '<script>alert(1)</script>',
      phase: {},
      block: hostile,
      useProjection: () => {
        throw new Error('projection exploded')
      },
    })
    expect(html).toContain('data-flowgate="flow-toolview"')
    // Unsafe tool names never reach the DOM verbatim.
    expect(html).not.toContain('<script>')
    expect(html).toContain('FlowGate')
  })

  it('renders a throw-immune fallback for a completely empty props object', () => {
    const html = render({})
    expect(html).toContain('data-flowgate="flow-toolview"')
    expect(html).toContain('data-tool="FlowGate"')
    expect(html).toContain('未知')
  })
})

describe('FlowToolRow model helpers', () => {
  it('covers every FlowGate wire tool name exactly once', () => {
    expect([...FLOW_TOOL_NAMES]).toEqual(EXPECTED_TOOL_NAMES)
    expect(new Set(FLOW_TOOL_NAMES).size).toBe(FLOW_TOOL_NAMES.length)
  })

  it('only hints at stages that exist in the rail', () => {
    for (const [tool, stage] of Object.entries(TOOL_STAGE_HINT)) {
      expect(FLOW_TOOL_NAMES).toContain(tool)
      expect(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']).toContain(stage)
    }
  })
})

// ---------------------------------------------------------------------------
// Registration (fake Cordis context — the row components are covered above)
// ---------------------------------------------------------------------------

interface SlotCall {
  def: Record<string, unknown>
  component: unknown
}

function makeFakeCtx(options: { inject?: boolean; throwFor?: string } = {}): {
  ctx: ClientContext
  calls: SlotCall[]
  warnings: string[]
} {
  const calls: SlotCall[] = []
  const warnings: string[] = []
  const slotService = {
    register: (def: Record<string, unknown>, component: unknown) => {
      if (def.key === options.throwFor) throw new Error(`registration rejected for ${String(def.key)}`)
      calls.push({ def, component })
      const dispose = () => {
        const index = calls.findIndex((call) => call.def === def)
        if (index >= 0) calls.splice(index, 1)
      }
      return dispose
    },
    ...(options.inject === false
      ? {}
      : {
          inject: (_name: string, callback: () => unknown) => {
            const result = callback()
            return () => {
              if (typeof result === 'function') (result as () => void)()
            }
          },
        }),
  }
  const ctx: ClientContext = {
    slots: slotService,
    logger: {
      warn: (message?: unknown) => {
        warnings.push(String(message))
      },
    },
  }
  return { ctx, calls, warnings }
}

describe('registerFlowToolViews', () => {
  // The active-key guard is module state, so every test must dispose its
  // registrations (same discipline as a plugin fiber unload).
  let pendingDisposers: (() => void)[] = []
  const track = (disposers: (() => void)[]): (() => void)[] => {
    pendingDisposers.push(...disposers)
    return disposers
  }
  afterEach(() => {
    for (const dispose of pendingDisposers.reverse()) {
      try {
        dispose()
      } catch {
        /* idempotent disposers must survive double cleanup */
      }
    }
    pendingDisposers = []
  })

  it('registers one keyed row per wire tool name with the FlowGate locale', () => {
    const fake = makeFakeCtx()
    const disposers = track(registerFlowToolViews(fake.ctx))
    expect(disposers.length).toBe(EXPECTED_TOOL_NAMES.length)
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length)
    expect(fake.calls.every((call) => call.def.name === TOOLVIEW_SLOT)).toBe(true)
    expect(fake.calls.map((call) => call.def.key)).toEqual(EXPECTED_TOOL_NAMES)
    expect(fake.calls.every((call) => call.def.locale === LOCALE_NS)).toBe(true)
    expect(fake.calls.every((call) => typeof call.component === 'function')).toBe(true)
    expect(fake.calls[0]?.component).toBe(FlowToolRow)
  })

  it('registers a component that renders the rail for a real fake host slot render', () => {
    const fake = makeFakeCtx()
    track(registerFlowToolViews(fake.ctx))
    const Registered = fake.calls[0]?.component as (props: FlowToolRowProps) => React.ReactElement
    const html = renderToStaticMarkup(<Registered {...baseProps({ toolName: 'flow_verify' })} />)
    expect(html).toContain('data-flowgate="flow-toolview"')
    expect(html).toContain('data-flowgate="flow-rail"')
    expect(html).toContain('flow_verify')
  })

  it('is idempotent: a duplicate apply skips already-active wire names', () => {
    const fake = makeFakeCtx()
    const first = track(registerFlowToolViews(fake.ctx))
    expect(activeFlowToolviews()).toEqual([...EXPECTED_TOOL_NAMES].sort())
    track(registerFlowToolViews(fake.ctx))
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length)
    expect(activeFlowToolviews()).toHaveLength(EXPECTED_TOOL_NAMES.length)
    // Disposing all controllers clears the active set and allows a clean re-register.
    for (const dispose of first) dispose()
    expect(fake.calls.length).toBe(0)
    expect(activeFlowToolviews()).toEqual([])
    track(registerFlowToolViews(fake.ctx))
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length)
    // Stale disposers of the previous generation are no-ops (idempotent).
    for (const dispose of first) dispose()
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length)
  })

  it('tolerates a lean host without slots / inject and never throws', () => {
    expect(registerFlowToolViews({} as ClientContext)).toEqual([])
    expect(registerFlowToolViews({ slots: {} } as unknown as ClientContext)).toEqual([])
    const fake = makeFakeCtx({ inject: false })
    expect(() => track(registerFlowToolViews(fake.ctx))).not.toThrow()
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length)
  })

  it('skips one failing tool registration but keeps the rest', () => {
    const fake = makeFakeCtx({ throwFor: 'flow_verify' })
    const disposers = track(registerFlowToolViews(fake.ctx))
    expect(fake.calls.map((call) => call.def.key)).not.toContain('flow_verify')
    expect(fake.calls.length).toBe(EXPECTED_TOOL_NAMES.length - 1)
    expect(fake.warnings.some((warning) => warning.includes('flow_verify'))).toBe(true)
    expect(disposers.length).toBe(EXPECTED_TOOL_NAMES.length)
  })

  it('survives a host whose slots service throws on access', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('cannot get property "slots" without inject')
        },
      },
    ) as ClientContext
    expect(() => registerFlowToolViews(hostile)).not.toThrow()
    expect(registerFlowToolViews(hostile)).toEqual([])
  })
})

describe('toolview stylesheet', () => {
  it('gates every animation behind prefers-reduced-motion', () => {
    expect(TOOLVIEW_CSS).toContain('prefers-reduced-motion: no-preference')
    expect(TOOLVIEW_CSS).toContain('prefers-reduced-motion: reduce')
    expect(TOOLVIEW_CSS).toContain('animation:none!important')
    expect(TOOLVIEW_CSS).toContain('fg-tv-')
  })

  it('is a safe no-op without a document (SSR/node)', () => {
    expect(() => ensureToolviewStyles()).not.toThrow()
    expect(typeof ensureToolviewStyles()).toBe('boolean')
  })
})
