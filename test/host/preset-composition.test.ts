/** 工程模式 preset 组成（T1.7 / 03 §2.4）：人设、工具集、计划模式引导。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface PatchRow {
  insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
}
interface PresetConfig {
  plugins?: { name?: string; config?: Record<string, unknown> }[]
}

function loadPresets(): Record<string, PresetConfig> {
  const rows = parse(readFileSync('cordis.patch.yml', 'utf8')) as PatchRow[]
  const inserted = rows.flatMap((row) => row.insert ?? [])
  const presets: Record<string, PresetConfig> = {}
  for (const row of inserted) {
    if (row.name !== '@deepseek-ai/dsh-agent-preset') continue
    const config = row.config as PresetConfig | undefined
    const id = typeof config === 'object' && config !== null ? (row.id ?? '') : ''
    if (id !== '' && config !== undefined) presets[id] = config
  }
  return presets
}

function pluginNames(preset: PresetConfig | undefined): string[] {
  return (preset?.plugins ?? []).map((plugin) => plugin.name ?? '')
}

describe('cordis.patch.yml preset 组成', () => {
  it('三个 preset 都存在', () => {
    const presets = loadPresets()
    expect(Object.keys(presets).sort()).toEqual(['preset-flowgate', 'preset-flowgate-executor', 'preset-flowgate-reviewer'])
  })

  it('工程模式：人设 + 文件工具集 + 搜索 + 技能；人设含计划模式引导', () => {
    const preset = loadPresets()['preset-flowgate']
    const names = pluginNames(preset)
    expect(names).toContain('@deepseek-ai/dsh-persona')
    expect(names).toContain('@deepseek-ai/dsh-tool-fs')
    expect(names).toContain('@deepseek-ai/dsh-tool-fs-search')
    expect(names).toContain('@deepseek-ai/dsh-tool-skill')
    const persona = (preset?.plugins ?? []).find((plugin) => plugin.name === '@deepseek-ai/dsh-persona')
    expect(String(persona?.config?.prefix ?? '')).toContain('先计划再执行')
  })

  it('执行者：有文件读写、搜索和 shell，没有委派工具', () => {
    const names = pluginNames(loadPresets()['preset-flowgate-executor'])
    for (const expected of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash']) {
      expect(names).toContain(expected)
    }
    expect(names.some((name) => /subagent|workflow/.test(name))).toBe(false)
  })

  it('只读取证：文件工具只读，没有 shell', () => {
    const preset = loadPresets()['preset-flowgate-reviewer']
    const names = pluginNames(preset)
    expect(names).toContain('@deepseek-ai/dsh-tool-fs')
    expect(names).not.toContain('@deepseek-ai/dsh-tool-bash')
    const fsConfig = (preset?.plugins ?? []).find((plugin) => plugin.name === '@deepseek-ai/dsh-tool-fs')?.config
    expect(fsConfig).toMatchObject({ read: true, write: false, edit: false })
  })
})
