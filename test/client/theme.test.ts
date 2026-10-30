/** Noise-reduction + palette tests (FR-9.6 / T5.4). */
import { describe, expect, it } from 'vitest'
import {
  COLORS,
  createNoiseGate,
  interceptNoiseKey,
  NOISE_WINDOW_MS,
  severityColor,
  taskColor,
  taskTone,
  TONES,
  toneOf,
  toneStyle,
} from '../../src/client/theme'
import { makeEmptyProjection, makeSnapshot } from './mock'

describe('palette', () => {
  it('defines the four semantic tones plus the disabled state', () => {
    for (const tone of ['blocked', 'attention', 'active', 'idle', 'disabled'] as const) {
      expect(TONES[tone].fg).toMatch(/^#|^rgb/)
      expect(toneStyle(tone)).toHaveProperty('border')
    }
    expect(TONES.blocked.fg).toBe('#e5484d')
    expect(TONES.attention.fg).toBe('#d97706')
    expect(TONES.active.fg).toBe('#2563eb')
  })

  it('classifies snapshots into exactly one tone', () => {
    expect(toneOf(null)).toBe('disabled')
    expect(toneOf(makeEmptyProjection().snapshot)).toBe('disabled')
    expect(toneOf(makeSnapshot())).toBe('attention')
    expect(toneOf(makeSnapshot({ pending: [], awaitingGate: undefined }))).toBe('active')
  })

  it('colors task statuses for graph nodes and board cards', () => {
    expect(taskColor('done')).toBe(COLORS.pass)
    expect(taskColor('running')).toBe(COLORS.info)
    expect(taskColor('failed')).toBe(COLORS.fail)
    expect(taskColor('review')).toBe(COLORS.warn)
    expect(taskTone('blocked')).toBe('blocked')
    expect(severityColor('critical')).toBe(COLORS.fail)
    expect(severityColor('major')).toBe(COLORS.warn)
    expect(severityColor('minor')).toBe(COLORS.info)
  })
})

describe('noise gate (same rule + target only nags strongly once per 10 min)', () => {
  it('suppresses repeats inside the window and re-arms after it', () => {
    const gate = createNoiseGate()
    const start = 1_000_000
    expect(gate.shouldNotify('R-STAGE-SRC::src/A.java', start)).toBe(true)
    expect(gate.shouldNotify('R-STAGE-SRC::src/A.java', start + 1000)).toBe(false)
    expect(gate.shouldNotify('R-STAGE-SRC::src/A.java', start + NOISE_WINDOW_MS - 1)).toBe(false)
    expect(gate.shouldNotify('R-STAGE-SRC::src/A.java', start + NOISE_WINDOW_MS)).toBe(true)
  })

  it('tracks different rules / targets independently', () => {
    const gate = createNoiseGate()
    expect(gate.shouldNotify(interceptNoiseKey('R-1', 'a'), 0)).toBe(true)
    expect(gate.shouldNotify(interceptNoiseKey('R-1', 'b'), 0)).toBe(true)
    expect(gate.shouldNotify(interceptNoiseKey('R-2', 'a'), 0)).toBe(true)
    expect(gate.size()).toBe(3)
  })

  it('prunes expired keys and supports forget / reset', () => {
    const gate = createNoiseGate(1000)
    expect(gate.shouldNotify('k', 0)).toBe(true)
    expect(gate.size()).toBe(1)
    expect(gate.shouldNotify('other', 5000)).toBe(true)
    // The first key expired while checking the second one.
    expect(gate.size()).toBe(1)
    gate.forget('other')
    expect(gate.size()).toBe(0)
    expect(gate.shouldNotify('k', 5000)).toBe(true)
    gate.reset()
    expect(gate.size()).toBe(0)
  })

  it('builds stable noise keys from rule + target', () => {
    expect(interceptNoiseKey('R-1', 'src/A.java')).toBe('R-1::src/A.java')
    expect(interceptNoiseKey('R-1')).toBe('R-1::')
  })
})
