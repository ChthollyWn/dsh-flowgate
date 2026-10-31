/**
 * Tests for the dependency-free YAML subset parser and the citation / vague-term
 * helpers in artifacts/parse.ts. These functions are exported precisely because
 * every artifact parser is layered on top of them; the cases below pin the
 * quoted-string, comment, inline collection and fallback arms.
 */
import { describe, expect, it } from 'vitest'
import {
  extractCitationRefs,
  findVagueTerms,
  isQuantified,
  parseTasks,
  parseYamlLite,
  vagueTermHint,
} from '../../../src/core/artifacts/parse'

describe('artifacts/parse — parseYamlLite 注释剥离', () => {
  it('行尾注释 / 引号内的 # 不剥离 / 无空格的 # 保留', () => {
    expect(parseYamlLite('a: 1 # trailing comment')).toEqual({ a: 1 })
    expect(parseYamlLite('a: "x # y"')).toEqual({ a: 'x # y' })
    expect(parseYamlLite("a: 'x # y'")).toEqual({ a: 'x # y' })
    expect(parseYamlLite('a: x#y')).toEqual({ a: 'x#y' })
    // 双引号内转义引号后仍能识别引号结束与注释
    expect(parseYamlLite('a: "x \\" #y" # c')).toEqual({ a: 'x " #y' })
    // 只有注释 -> null
    expect(parseYamlLite('# only a comment\n   # indented')).toBeNull()
    // 单引号内的双写 '' 是转义，不提前结束引号
    expect(parseYamlLite("a: 'it''s # fine'")).toEqual({ a: "it's # fine" })
  })
})

describe('artifacts/parse — parseYamlLite 标量与内联集合', () => {
  it('布尔 / null / 数字 / 引号标量', () => {
    expect(parseYamlLite('a: true\nb: yes\nc: ON\nd: false\ne: no\nf: OFF')).toEqual({
      a: true,
      b: true,
      c: true,
      d: false,
      e: false,
      f: false,
    })
    expect(parseYamlLite('a: null\nb: ~\nc: —\nd: -\ne: 42\nf: -3.5\ng: 0')).toEqual({
      a: null,
      b: null,
      c: null,
      d: null,
      e: 42,
      f: -3.5,
      g: 0,
    })
    expect(parseYamlLite('a: "quoted"\nb: \'single\'')).toEqual({ a: 'quoted', b: 'single' })
    // 双引号转义：\" \n \\
    expect(parseYamlLite('a: "say \\"hi\\""\nb: "line\\nnext"\nc: "back\\\\slash"')).toEqual({
      a: 'say "hi"',
      b: 'line\nnext',
      c: 'back\\slash',
    })
    // 单引号内单引号双写
    expect(parseYamlLite("a: 'it''s'")).toEqual({ a: "it's" })
  })

  it('内联数组 / 内联映射（含嵌套、引号内逗号、空值）', () => {
    expect(parseYamlLite('a: [1, 2, "three, four", [5, 6], {x: 1}]')).toEqual({
      a: [1, 2, 'three, four', [5, 6], { x: 1 }],
    })
    expect(parseYamlLite('a: {b: 1, c: "x, y", d: {e: 2}, empty: }')).toEqual({
      a: { b: 1, c: 'x, y', d: { e: 2 }, empty: null },
    })
    expect(parseYamlLite('a: []\nb: {}')).toEqual({ a: [], b: {} })
    // 内联映射里 key 非法（包含空格）的片段被跳过
    expect(parseYamlLite('a: {bad key: 1}')).toEqual({ a: {} })
  })
})

describe('artifacts/parse — parseYamlLite 块结构', () => {
  it('嵌套映射与空值处理', () => {
    expect(parseYamlLite('a:\n  b: 1\n  c: 2\nd: 3')).toEqual({ a: { b: 1, c: 2 }, d: 3 })
    // 空值后面没有更深缩进 -> null
    expect(parseYamlLite('a:\nb: 2')).toEqual({ a: null, b: 2 })
    // 非法 key 在顶层退回标量解析
    expect(parseYamlLite('bad key: value')).toBe('bad key: value')
    expect(parseYamlLite('hello world')).toBe('hello world')
    // 缩进异常的行不会被当前块消费
    expect(parseYamlLite('a: 1\n  b: 2')).toEqual({ a: 1 })
    // 1bad 不是合法 key：当前映射块在此终止
    expect(parseYamlLite('a-b: 1\n1bad: 2')).toEqual({ 'a-b': 1 })
    expect(parseYamlLite('')).toBeNull()
    expect(parseYamlLite('   \n\t\n')).toBeNull()
  })

  it('序列：标量项、裸 - 项、嵌套块项、映射项合并', () => {
    expect(parseYamlLite('- a\n- b\n- 3')).toEqual(['a', 'b', 3])
    // 裸 - 后无更深缩进 -> null
    expect(parseYamlLite('-\n- b')).toEqual([null, 'b'])
    // 裸 - 后更深缩进 -> 块
    expect(parseYamlLite('-\n  a: 1')).toEqual([{ a: 1 }])
    // 映射项 + 同名后续行的合并
    expect(parseYamlLite('- id: T1\n  name: x\n- id: T2')).toEqual([
      { id: 'T1', name: 'x' },
      { id: 'T2' },
    ])
    // 映射项的值为空 + 更深缩进块；或后面没有更深缩进
    expect(parseYamlLite('- id:\n    nested: 1')).toEqual([{ id: { nested: 1 } }])
    expect(parseYamlLite('- id:\n- b')).toEqual([{ id: null }, 'b'])
    // 顶层序列项为内联标量
    expect(parseYamlLite('- [1, 2]\n- plain # c')).toEqual([[1, 2], 'plain'])
  })
})

describe('artifacts/parse — YAML fenced block 与任务卡', () => {
  it('yaml/yml/无语言 fence 会被解析，其它语言被跳过，数组内容被丢弃', () => {
    const markdown = [
      '## T1 示例任务',
      '',
      '```json',
      '{"covers": ["WRONG"]}',
      '```',
      '',
      '```yml',
      'covers: [R1.S1]',
      'scope: [src/**]',
      'tests: [test/**]',
      'new_files: []',
      'depends_on: []',
      'tdd: required',
      'verify:',
      '  - group: unit',
      '    command: pnpm test',
      '    inputs: [src/**]',
      'size: S',
      '```',
      '',
      '实现说明。',
    ].join('\n')
    const doc = parseTasks(markdown)
    expect(doc.tasks).toHaveLength(1)
    expect(doc.tasks[0]).toMatchObject({
      id: 'T1',
      title: '示例任务',
      covers: ['R1.S1'],
      scope: ['src/**'],
      tests: ['test/**'],
      tdd: 'required',
      size: 'S',
    })
    expect(doc.tasks[0]?.verify[0]).toMatchObject({ group: 'unit', command: 'pnpm test', inputs: ['src/**'] })

    // 无语言 fence 里的数组内容不是映射：回退到全文解析（返回默认值）
    const arrayFence = parseTasks('## T1 纯数组\n\n```\n- a\n- b\n```\n\n正文。')
    expect(arrayFence.tasks[0]).toMatchObject({ id: 'T1', scope: [], tdd: 'optional' })
  })

  it('没有 fence 的任务正文直接按 YAML 解析；执行计划段退化为直接解析', () => {
    const markdown = [
      '## T2 无 fence 任务',
      '',
      'covers: [R2.S1]',
      'scope: [lib/**]',
      'tests: []',
      'new_files: []',
      'depends_on: []',
      'tdd: optional',
      'tdd_reason: 纯样式',
      'verify: []',
      'run: main',
      'size: L',
      '',
      '正文说明。',
      '',
      '## 执行计划',
      '',
      '```yaml',
      'batches:',
      '  - id: B1',
      '    mode: sequential',
      '    tasks: [T2]',
      '    why: 单任务',
      '    downgraded: 并行度不足',
      '```',
    ].join('\n')
    const doc = parseTasks(markdown)
    const task = doc.tasks[0]
    expect(task).toMatchObject({
      id: 'T2',
      title: '无 fence 任务',
      scope: ['lib/**'],
      tdd: 'optional',
      tddReason: '纯样式',
      run: 'main',
      size: 'L',
    })
    expect(doc.execution.batches[0]).toMatchObject({ batch: 'B1', mode: 'sequential', tasks: ['T2'], why: '单任务', downgraded: '并行度不足' })

    // 执行计划段没有 yaml fence，但正文本身就是 yaml
    const inlinePlan = parseTasks(
      ['## T3 任务', '', '```yaml', 'covers: [R3.S1]', 'tdd: required', 'size: S', '```', '', '## 执行计划', '', 'execution:', '  - batch: B9', '    mode: parallel', '    tasks: [T3]', ''].join('\n'),
    )
    expect(inlinePlan.execution.batches[0]).toMatchObject({ batch: 'B9', mode: 'parallel', tasks: ['T3'] })
  })
})

describe('artifacts/parse — 模糊词与可量化判定', () => {
  it('findVagueTerms 中英文词表、误伤排除与去重', () => {
    expect(findVagueTerms('')).toEqual([])
    expect(findVagueTerms('   ')).toEqual([])
    // 快照/快速是误伤保护；但“响应快，”仍会命中单字“快”（已知取舍）
    expect(findVagueTerms('页面响应快，展示快照')).toEqual(['快'])
    expect(findVagueTerms('数据快照已更新')).toEqual([])
    expect(findVagueTerms('尽快完成并保证合理与稳定')).toEqual(expect.arrayContaining(['尽快', '合理', '稳定']))
    expect(findVagueTerms('user-friendly and fast')).toEqual(expect.arrayContaining(['user-friendly', 'fast']))
    // 单字"好/多/少/大/小/等等等"本身不建 matcher；但"等等等"里含"等等"仍会命中
    expect(findVagueTerms('好处很多 少一点 大一点 小一点')).toEqual([])
    expect(findVagueTerms('还有等等等')).toEqual(['等等'])
    expect(findVagueTerms(123 as unknown as string)).toEqual([])
  })

  it('isQuantified 认数字+单位 / 分位 / HTTP 码 / 比例 / 比较符 / 中文阈值', () => {
    expect(isQuantified('')).toBe(false)
    expect(isQuantified('尽快返回')).toBe(false)
    for (const text of [
      'p95 < 300ms',
      '95% 成功率',
      'HTTP 200',
      '3/5 用例',
      '10 秒内返回',
      '<= 5 次重试',
      '不超过 3 处告警',
      '至少 2 层缓存',
      '20 个用户',
    ]) {
      expect(isQuantified(text), text).toBe(true)
    }
    expect(isQuantified(123 as unknown as string)).toBe(false)
    expect(vagueTermHint(['尽快', '合理'])).toContain('尽快、合理')
  })
})

describe('artifacts/parse — 引用提取', () => {
  it('path:line 与 path:start-end、反引号包裹、去重', () => {
    expect(extractCitationRefs('见 src/main/java/A.java:12')).toEqual([
      { file: 'src/main/java/A.java', startLine: 12, endLine: 12 },
    ])
    expect(extractCitationRefs('见 src/a.ts:10-20 与 src/a.ts:10-20')).toEqual([
      { file: 'src/a.ts', startLine: 10, endLine: 20 },
    ])
    expect(extractCitationRefs('`src/a.ts:3`')).toEqual([{ file: 'src/a.ts', startLine: 3, endLine: 3 }])
    expect(extractCitationRefs('')).toEqual([])
    expect(extractCitationRefs(42 as unknown as string)).toEqual([])
  })

  it('非法路径（绝对路径 / 包含 ..）被忽略', () => {
    expect(extractCitationRefs('/abs/path/a.ts:3')).toEqual([])
    expect(extractCitationRefs('../outside/a.ts:3')).toEqual([])
    expect(extractCitationRefs('a.ts:0')).toEqual([{ file: 'a.ts', startLine: 1, endLine: 1 }])
  })

  it('内嵌 JSON 引用对象（snake_case / camelCase / 缺失字段 / 非 JSON 片段）', () => {
    const text = [
      '{"file":"src/a.ts","start_line":1,"end_line":2}',
      '{"file":"src/b.ts","startLine":5,"endLine":6,"quote":"关键行"}',
      '{"file":"","start_line":1}',
      '{"start_line":9}',
      '{"file":"src/c.ts","quote":"no lines"}',
      '{"file":"src/d.ts","start_line":"abc"}',
      '{ not json "file" }',
      '{"file":"src/e.ts","quote":"say \\"hi\\""}',
      '{"nested":{"file":"src/f.ts","start_line":2}}',
    ].join('\n')
    const refs = extractCitationRefs(text)
    const files = refs.map((ref) => `${ref.file}:${ref.startLine}-${ref.endLine}`)
    expect(files).toEqual(expect.arrayContaining(['src/a.ts:1-2', 'src/b.ts:5-6', 'src/e.ts:1-1']))
    expect(refs.find((ref) => ref.file === 'src/b.ts')?.quote).toBe('关键行')
    expect(refs.find((ref) => ref.file === 'src/e.ts')?.quote).toBe('say "hi"')
    // 缺 start_line 时按 0 -> 钳到第 1 行；空文件 / 非数字行号 / 坏 JSON / 嵌套对象不产生引用
    expect(refs.find((ref) => ref.file === 'src/c.ts')).toMatchObject({ startLine: 1, endLine: 1 })
    expect(files.some((entry) => entry.startsWith(':') || entry.startsWith('src/d.ts') || entry.startsWith('src/f.ts'))).toBe(false)
  })
})
