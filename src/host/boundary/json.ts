/**
 * Lossless JSON 边界（P0-1）：host → DSH 的唯一 JSON 收口。
 *
 * 背景（v0.5.1 事故）：DSH 的 `@deepseek-ai/dsh-api-remotes` 在转发
 * `api-session/added` 等宿主事件前用 `isJsonValue()` 校验参数；工具结果、插件
 * 记录、会话投影 wire 值也都被 DSH 按同样规则校验。一个显式 `undefined`
 * 字段就会让「新建会话/子会话」失败：
 *   `forwarded host event "api-session/added" argument 0 is not lossless JSON data`
 *
 * 因此 host 层所有跨边界数据（投影 init/apply/wire、插件记录、工具结果）必须先
 * 经过本模块，**不允许各模块各自实现一份清洗 helper**（scripts/lint-layers.mjs
 * 会拒绝重复定义）。
 *
 * 判定规则严格镜像 DSH `@deepseek-ai/dsh-util-values` 的 `isJsonValue`：
 * - 只接受 null / 布尔 / 有限且非 -0 的数字 / 字符串；
 * - 数组必须是内建 Array.prototype 的稠密数组（无洞、无额外属性、无 symbol）；
 * - 记录必须是 plain object 或 null-prototype，且只有可枚举字符串键；
 * - 拒绝 undefined / 函数 / symbol / bigint / NaN / Infinity / Date / Map / Set /
 *   类实例 / 循环引用 / 自有 symbol 或不可枚举属性。
 *
 * 清洗策略与 DSH 语义对齐：JSON 往返（`JSON.stringify` + `JSON.parse`）会
 * 丢弃 undefined、把 NaN/Infinity 变成 null、把 Date 变成 ISO 字符串、把类实例
 * 变成 plain object——这正是无损 JSON 的要求。BigInt/循环引用无法往返时返回
 * 原值兜底（由调用方决定是否 assert），绝不因为清洗本身把插件带崩。
 */

/** 校验失败的第一处位置与原因（assert 的错误文案用）。 */
export interface LosslessJsonFailure {
  /** JSONPath 风格路径，如 `$.snapshot.changeId` 或 `$.tasks.T1[0]`。 */
  path: string
  reason: string
}

/** 内建构造器判定（跨 realm 时 `Function.prototype.toString` 仍一致）。 */
function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor = descriptor?.value
  if (typeof constructor !== 'function') return false
  const expected = name === 'Array' ? Array : Object
  try {
    return (
      constructor.name === name &&
      constructor.prototype === prototype &&
      Function.prototype.toString.call(constructor) === Function.prototype.toString.call(expected)
    )
  } catch {
    return false
  }
}

/** 是否是某个 realm 的内建 `Object.prototype`。 */
function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

/** 是否是某个 realm 的内建 Array.prototype（排除 Array 子类/伪造原型）。 */
function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  if (!prototype || !Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype = Object.getPrototypeOf(prototype) as object | null
  return typeof objectPrototype === 'object' && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype)
}

/** 是否是 plain object 或 null-prototype 记录（排除类实例/Date/Map/Set 等）。 */
function hasPlainObjectPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || (typeof prototype === 'object' && prototype !== null && isIntrinsicObjectPrototype(prototype))
}

/** 返回所有自有可枚举字符串键；含 symbol 或不可枚举自有属性时返回 undefined。 */
function enumerableStringKeys(value: object): string[] | undefined {
  const keys = Reflect.ownKeys(value)
  const invalid = keys.some(
    (key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key),
  )
  if (invalid) return undefined
  return keys as string[]
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

/**
 * 递归校验 lossless JSON，返回第一处失败（合法返回 null）。
 *
 * `ancestors` 记录当前递归路径上的对象；命中即为循环引用（同一对象在两条
 * 分支上重复出现但不是环不算循环，所以离开时删除）。
 */
function findFailure(value: unknown, path: string, ancestors: Set<object>): LosslessJsonFailure | null {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return null
    case 'number':
      if (!Number.isFinite(value)) return { path, reason: `非有限数字 ${String(value)}` }
      if (Object.is(value, -0)) return { path, reason: '负零（-0）不是无损 JSON' }
      return null
    case 'object':
      break
    default:
      return { path, reason: `不能序列化 ${typeof value}` }
  }
  const object = value as object
  if (ancestors.has(object)) return { path, reason: '循环引用' }
  if (Array.isArray(value)) {
    if (!hasPlainArrayPrototype(value)) return { path, reason: '不是内建 Array.prototype 数组（Array 子类/伪造原型）' }
    // DSH 的规则：自有键必须恰好是 length + 每个下标（稠密、无额外属性）。
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      return { path, reason: '稀疏数组或带额外属性的数组' }
    }
    ancestors.add(object)
    try {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          return { path: `${path}[${index}]`, reason: '稀疏数组（存在空洞）' }
        }
        const failure = findFailure(value[index], `${path}[${index}]`, ancestors)
        if (failure) return failure
      }
    } finally {
      ancestors.delete(object)
    }
    return null
  }
  if (!hasPlainObjectPrototype(object)) return { path, reason: '不是 plain object（类实例/Date/Map/Set 等）' }
  const keys = enumerableStringKeys(object)
  if (keys === undefined) return { path, reason: '含自有 symbol 键或不可枚举属性' }
  ancestors.add(object)
  try {
    for (const key of keys) {
      const failure = findFailure((object as Record<string, unknown>)[key], propertyPath(path, key), ancestors)
      if (failure) return failure
    }
  } finally {
    ancestors.delete(object)
  }
  return null
}

/** 镜像 DSH `isJsonValue`：值是否能无损地表示成 JSON。 */
export function isLosslessJson(value: unknown): boolean {
  return findFailure(value, '$', new Set()) === null
}

/** 找出第一处失败位置（测试/诊断用；合法返回 null）。 */
export function losslessJsonFailure(value: unknown): LosslessJsonFailure | null {
  return findFailure(value, '$', new Set())
}

/**
 * 断言 lossless JSON；不合法抛 TypeError（含 context 与首个失败路径）。
 *
 * 用于投影自检、插件记录写入前一类的"必须成功"边界；普通清洗用
 * `toLosslessJson` / `toLosslessValue` 即可。
 */
export function assertLosslessJson(value: unknown, context: string): void {
  const failure = findFailure(value, '$', new Set())
  if (!failure) return
  throw new TypeError(
    `[FlowGate] ${context}：值不是 lossless JSON（${failure.path} 处 ${failure.reason}）。` +
      'DSH 对会话投影/插件记录/工具结果做无损 JSON 校验，含 undefined/Date/类实例/NaN 等会让宿主拒绝（v0.5.1 新建会话失败回归）。',
  )
}

/**
 * JSON 往返清洗（用于投影 init/apply/wire、插件记录这类"必须过界"的数据）。
 *
 * - undefined 属性被丢弃；NaN/Infinity → null；Date → ISO 字符串；
 * - 类实例 → plain object；函数/symbol 属性被丢弃；BigInt 抛 TypeError；
 * - BigInt / 循环引用等无法往返时**返回原值兜底**（调用方需要强保证时用
 *   `assertLosslessJson`，自检会因此失败并阻止注册，而不是把坏值送进宿主）。
 */
export function toLosslessJson<T>(value: T): T {
  if (value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/**
 * 工具结果专用清洗：失败/undefined 一律 → null。
 *
 * DSH 校验工具执行的运行时值；`undefined` 顶层、BigInt、循环引用都会让工具
 * 调用报 `returned invalid output: value is not lossless JSON`。工具结果宁可
 * 退化成 null 也不能把异常抛给宿主（agent 看到 { ok, summary } 即可）。
 */
export function toLosslessValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : (JSON.parse(text) as unknown)
  } catch {
    return null
  }
}
