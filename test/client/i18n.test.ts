/**
 * i18n completeness tests: zh/en key parity, no empty strings, every dynamic
 * key family the views use exists, and no `t('...')` literal in the bundle is
 * missing from the dictionaries.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranslator, DICTS, format, localeOf, normalizeLocale } from '../../src/client/i18n'
import { PIPELINE_STAGES } from '../../src/client/stage-info'
import { PANEL_TABS } from '../../src/client/panel/Panel'

const root = process.cwd()
const zhKeys = Object.keys(DICTS.zh).sort()
const enKeys = Object.keys(DICTS.en).sort()

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(path) && !path.includes(`${join('src', 'client', 'locale')}`)) out.push(path)
  }
  return out
}

describe('dictionaries', () => {
  it('have exactly the same keys in Chinese and English', () => {
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(250)
  })

  it('never contain empty strings', () => {
    for (const key of zhKeys) {
      expect(DICTS.zh[key]?.trim(), `zh:${key}`).not.toBe('')
      expect(DICTS.en[key]?.trim(), `en:${key}`).not.toBe('')
    }
  })

  it('cover every dynamic key family used by the views', () => {
    for (const stage of PIPELINE_STAGES) {
      for (const prefix of ['stage.', 'stage.idx.']) {
        expect(DICTS.zh[`${prefix}${stage}`], `${prefix}${stage}`).toBeDefined()
      }
    }
    for (const status of ['done', 'current', 'pending', 'blocked']) {
      expect(DICTS.zh[`stage.status.${status}`]).toBeDefined()
    }
    for (const status of ['pending', 'queued', 'running', 'review', 'done', 'blocked', 'interrupted', 'failed', 'skipped']) {
      expect(DICTS.zh[`tasks.status.${status}`]).toBeDefined()
    }
    for (const state of ['pending', 'awaiting', 'passed', 'failed', 'rejected', 'skipped']) {
      expect(DICTS.zh[`gate.state.${state}`]).toBeDefined()
    }
    for (const metric of Array.from({ length: 18 }, (_, index) => `M-${index + 1}`)) {
      expect(DICTS.zh[`metric.${metric}`]).toBeDefined()
    }
    for (const tab of PANEL_TABS) {
      expect(DICTS.zh[tab.labelKey]).toBeDefined()
    }
    for (const category of ['security', 'performance', 'cost', 'compliance', 'maintainability']) {
      expect(DICTS.zh[`risk.category.${category}`]).toBeDefined()
    }
    for (const grade of ['none', 'low', 'medium', 'high']) {
      expect(DICTS.zh[`risk.grade.${grade}`]).toBeDefined()
    }
  })

  it('has no missing t(...) literal in src/client', () => {
    const used = new Set<string>()
    for (const file of walk(join(root, 'src', 'client'))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1] as string)
      for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(match[1] as string)
    }
    expect(used.size).toBeGreaterThan(100)
    const missing = [...used].filter((key) => !(key in DICTS.zh) || !(key in DICTS.en))
    expect(missing).toEqual([])
  })
})

describe('translator', () => {
  it('interpolates named parameters and leaves unknown ones verbatim', () => {
    expect(format('下一步：{next}', { next: '/flow approve G3' })).toBe('下一步：/flow approve G3')
    expect(format('x {a}', {})).toBe('x {a}')
    expect(format('no params')).toBe('no params')
  })

  it('falls back to Chinese and then to the key for unknown lookups', () => {
    const t = createTranslator('en')
    expect(t('panel.title')).toBe('FlowGate')
    // @ts-expect-error deliberately unknown key
    expect(t('definitely.not.a.key')).toBe('definitely.not.a.key')
  })

  it('reports the active locale reactively', () => {
    expect(localeOf(createTranslator('zh'))).toBe('zh')
    expect(localeOf(createTranslator('en'))).toBe('en')
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('fr')).toBe('zh')
    expect(normalizeLocale(undefined)).toBe('zh')
  })
})
