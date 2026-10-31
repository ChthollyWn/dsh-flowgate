/**
 * P0-1：host → DSH 的 lossless JSON 边界（v0.5.1 新建会话失败事故的根因防线）。
 *
 * 规则严格镜像 DSH `@deepseek-ai/dsh-util-values` 的 `isJsonValue`：
 * 只接受 null/布尔/有限非 -0 数字/字符串/稠密内建数组/plain 或 null-prototype
 * 记录；拒绝 undefined/函数/symbol/bigint/NaN/Infinity/Date/Map/Set/类实例/
 * 循环/稀疏数组/自有 symbol 或不可枚举属性。
 */
import { describe, expect, it } from 'vitest'
import {
  assertLosslessJson,
  isLosslessJson,
  losslessJsonFailure,
  toLosslessJson,
  toLosslessValue,
} from '../../src/host/boundary/json.js'

class DirtyClass {
  readonly label = 'dirty'
  readonly at = new Date(0)
}

describe('isLosslessJson：镜像 DSH isJsonValue', () => {
  it('接受 JSON 基本类型与嵌套 plain 结构', () => {
    for (const value of [null, true, false, 0, 1.5, -42, 'text', '', [], {}, { a: 1, b: [null, 'x', { c: false }] }]) {
      expect(isLosslessJson(value), JSON.stringify(value)).toBe(true)
    }
    // null-prototype 记录也合法（JSON 可无损表示）。
    const nullProto = Object.create(null) as Record<string, unknown>
    nullProto['a'] = 1
    expect(isLosslessJson(nullProto)).toBe(true)
  })

  it('拒绝 undefined / 函数 / symbol / bigint', () => {
    expect(isLosslessJson(undefined)).toBe(false)
    expect(isLosslessJson(() => undefined)).toBe(false)
    expect(isLosslessJson(Symbol('x'))).toBe(false)
    expect(isLosslessJson(10n)).toBe(false)
    expect(isLosslessJson({ a: undefined })).toBe(false)
    expect(isLosslessJson({ fn: () => 1 })).toBe(false)
    expect(isLosslessJson({ sym: Symbol('x') })).toBe(false)
    expect(isLosslessJson([1, 10n])).toBe(false)
  })

  it('拒绝 NaN / Infinity / -0', () => {
    for (const value of [NaN, Infinity, -Infinity, -0, { nan: NaN }, [Infinity], { zero: -0 }]) {
      expect(isLosslessJson(value)).toBe(false)
    }
    // +0 合法。
    expect(isLosslessJson(0)).toBe(true)
    expect(Object.is(0, -0)).toBe(false)
  })

  it('拒绝 Date / Map / Set / 类实例 / 内建包装对象', () => {
    for (const value of [new Date(0), new Map(), new Set([1]), new DirtyClass(), new Number(1), new String('x'), new Boolean(true)]) {
      expect(isLosslessJson(value), Object.prototype.toString.call(value)).toBe(false)
    }
    expect(isLosslessJson({ when: new Date(0) })).toBe(false)
    expect(isLosslessJson({ entries: new Map([['a', 1]]) })).toBe(false)
  })

  it('拒绝稀疏数组 / 额外属性数组 / Array 子类 / 类数组', () => {
    const sparse = [1, , 3] as unknown[] // eslint-disable-line no-sparse-arrays
    expect(isLosslessJson(sparse)).toBe(false)
    const withExtra = [1, 2] as unknown as Record<string, unknown> & unknown[]
    withExtra['extra'] = true
    expect(isLosslessJson(withExtra)).toBe(false)
    class ArraySubclass extends Array {}
    expect(isLosslessJson(new ArraySubclass())).toBe(false)
    expect(isLosslessJson({ length: 2, 0: 'a', 1: 'b' })).toBe(true) // plain 记录合法
  })

  it('拒绝循环引用，但共享引用（非环）不误判', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(isLosslessJson(circular)).toBe(false)
    const nested: Record<string, unknown> = { deep: { value: 1 } }
    nested['again'] = nested['deep']
    expect(isLosslessJson(nested)).toBe(true)
    const arrayCycle: unknown[] = []
    arrayCycle.push(arrayCycle)
    expect(isLosslessJson(arrayCycle)).toBe(false)
  })

  it('拒绝自有 symbol 键与不可枚举属性', () => {
    const withSymbol = { a: 1 } as Record<PropertyKey, unknown>
    withSymbol[Symbol('hidden')] = 2
    expect(isLosslessJson(withSymbol)).toBe(false)
    const hidden = {}
    Object.defineProperty(hidden, 'x', { value: 1, enumerable: false, writable: true, configurable: true })
    expect(isLosslessJson(hidden)).toBe(false)
    const enumerableHidden = {}
    Object.defineProperty(enumerableHidden, 'y', { value: 1, enumerable: true, writable: true, configurable: true })
    expect(isLosslessJson(enumerableHidden)).toBe(true)
  })

  it('失败路径带首个失败位置（assert 文案与诊断用）', () => {
    expect(losslessJsonFailure({ a: { b: undefined } })?.path).toBe('$.a.b')
    expect(losslessJsonFailure([1, NaN])?.path).toBe('$[1]')
    expect(losslessJsonFailure({ ok: true })).toBeNull()
  })
})

describe('toLosslessJson：JSON 往返清洗', () => {
  it('丢弃 undefined、NaN/Infinity→null、Date→ISO、类实例→plain、函数丢弃', () => {
    const cleaned = toLosslessJson({
      a: 1,
      b: undefined,
      nested: { c: undefined, d: 2 },
      arr: [1, undefined],
      nan: NaN,
      inf: Infinity,
      date: new Date(0),
      instance: new DirtyClass(),
      fn: () => 'x',
    }) as Record<string, unknown>
    expect(cleaned).toEqual({
      a: 1,
      nested: { d: 2 },
      arr: [1, null],
      nan: null,
      inf: null,
      date: '1970-01-01T00:00:00.000Z',
      instance: { label: 'dirty', at: '1970-01-01T00:00:00.000Z' },
    })
    expect(JSON.stringify(JSON.parse(JSON.stringify(cleaned)))).toBe(JSON.stringify(cleaned))
  })

  it('BigInt 与循环引用返回原值兜底（不抛错）', () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular['self'] = circular
    expect(toLosslessJson(circular)).toBe(circular)
    expect(toLosslessJson({ big: 10n })).toEqual({ big: 10n })
    // 顶层 undefined 原样返回（投影/记录都是对象，不会走到这里；工具结果用 toLosslessValue）。
    expect(toLosslessJson(undefined)).toBeUndefined()
  })

  it('性质：可 JSON 序列化的脏值清洗后必为 lossless JSON', () => {
    const dirtyRoots: unknown[] = [
      { a: undefined, b: 1 },
      { nan: NaN, inf: Infinity, zero: -0 },
      { date: new Date(0), nested: { when: new Date(1) } },
      { instance: new DirtyClass() },
      { list: [1, undefined, NaN, new Date(0)] },
      { plain: { deep: { deeper: [1, 2, 3] } } },
      Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 }),
      [],
      {},
      'text',
      42,
      -0,
      null,
    ]
    for (const root of dirtyRoots) {
      const cleaned = toLosslessJson(root)
      expect(isLosslessJson(cleaned), JSON.stringify(root)).toBe(true)
      expect(JSON.stringify(JSON.parse(JSON.stringify(cleaned)))).toBe(JSON.stringify(cleaned))
    }
  })
})

describe('toLosslessValue：工具结果专用', () => {
  it('undefined→null、失败→null、可序列化值等价于 JSON 往返', () => {
    expect(toLosslessValue(undefined)).toBeNull()
    expect(toLosslessValue(() => 1)).toBeNull()
    expect(toLosslessValue(Symbol('x'))).toBeNull()
    expect(toLosslessValue(10n)).toBeNull()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(toLosslessValue(circular)).toBeNull()
    expect(toLosslessValue(NaN)).toBeNull()
    expect(toLosslessValue({ a: undefined, b: new Date(0), c: [1, undefined] })).toEqual({
      b: '1970-01-01T00:00:00.000Z',
      c: [1, null],
    })
    expect(isLosslessJson(toLosslessValue({ a: [1, { b: 2 }], c: 'x' }))).toBe(true)
  })
})

describe('assertLosslessJson', () => {
  it('合法值不抛；不合法抛 TypeError 且含 context 与首个失败路径', () => {
    expect(() => assertLosslessJson({ a: [1, 2] }, '测试边界')).not.toThrow()
    expect(() => assertLosslessJson({ a: { b: undefined } }, '投影 wire')).toThrow(TypeError)
    expect(() => assertLosslessJson({ a: { b: undefined } }, '投影 wire')).toThrow(/投影 wire/)
    expect(() => assertLosslessJson({ a: { b: undefined } }, '投影 wire')).toThrow(/\$\.a\.b/)
    expect(() => assertLosslessJson({ when: new Date(0) }, '插件记录')).toThrow(/plain object/)
  })
})
