/**
 * 本地工具声明 DSL（**不 import `defineTool`**，宿主核心包不在依赖里）。
 *
 * rc.5 的 `ctx.tools.register()` 接受任意 `ToolDefinition` 形状：注册时只校验
 * `output.schema`（JsonSchemaNode 子集）与 `render`/`execute` 是否存在；
 * 参数校验/类型推断是 `defineTool` 自己做的（tools/lib/index.js:840-900）。
 * 因此这里实现等价的最小能力：
 * - `toJsonSchema`：把声明 DSL 转成模型可见的 JSON Schema（object root）；
 * - `validateArgs`：执行前校验必填/类型/枚举（等价于 defineTool 的 validate）；
 * - `defineHostTool`：生成 registry-ready 定义，并把所有异常收束成
 *   `{ ok:false, summary, data:{ error, hint, validValues? } }`——agent 可见错误
 *   统一 {error,hint} 口径（03 §10.1）。
 */
import type { DshContentBlock, DshToolDefinition } from '../adapters/dsh-types.js'
import { toAgentError } from '../errors.js'
// 工具结果的 lossless JSON 清洗统一走 host 边界（P0-1）：本文件不再定义本地 helper。
import { toLosslessValue } from '../boundary/json.js'

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface ParamSpec {
  type: ParamType
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean | null)[]
  /** array 元素声明。 */
  items?: ParamSpec
  /** object 字段声明（仅一层，足够本插件的参数）。 */
  properties?: Record<string, ParamSpec>
}

export type ParamSpecs = Record<string, ParamSpec>

export interface HostToolValue {
  ok: boolean
  summary: string
  data?: unknown
}

/** 声明参数 → JSON Schema（object root，模型可见）。 */
export function toJsonSchema(specs: ParamSpecs): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(specs)) {
    properties[name] = specToNode(spec)
    if (spec.required) required.push(name)
  }
  // NOTE: keep the implicit parameter object schema minimal (type/properties/
  // required). The DeepSeek provider adapter rejects some extra root keywords
  // such as `additionalProperties` synchronously (surfaces as TRANSPORT).
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function specToNode(spec: ParamSpec): Record<string, unknown> {
  const node: Record<string, unknown> = { type: spec.type }
  if (spec.description) node.description = spec.description
  if (spec.enum && spec.enum.length > 0) node.enum = [...spec.enum]
  if (spec.type === 'array') node.items = spec.items ? specToNode(spec.items) : { type: 'string' }
  if (spec.type === 'object') {
    node.properties = spec.properties ? toJsonSchema(spec.properties).properties : {}
  }
  return node
}

/** 执行前参数校验：返回违规列表（空 = 合法）。 */
export function validateArgs(specs: ParamSpecs, args: unknown): string[] {
  const violations: string[] = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['参数必须是 JSON 对象']
  }
  const record = args as Record<string, unknown>
  for (const [name, spec] of Object.entries(specs)) {
    const value = record[name]
    if (value === undefined || value === null) {
      if (spec.required) violations.push(`缺少必填参数 ${name}`)
      continue
    }
    if (!matchesType(value, spec)) violations.push(`参数 ${name} 类型应为 ${spec.type}`)
    if (spec.enum && spec.enum.length > 0 && !spec.enum.includes(value as never)) {
      violations.push(`参数 ${name} 必须是：${spec.enum.map((item) => String(item)).join(' / ')}`)
    }
  }
  return violations
}

function matchesType(value: unknown, spec: ParamSpec): boolean {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/** 渲染工具结果：模型看到 summary + 结构化 data（紧凑 JSON）。 */
function renderValue(_args: unknown, value: unknown): DshContentBlock[] {
  const result = value as HostToolValue
  if (result && typeof result === 'object' && typeof result.summary === 'string') {
    const lines = [result.summary]
    if (result.data !== undefined && result.data !== null) {
      lines.push('```json', JSON.stringify(result.data, null, 2), '```')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export interface DefineHostToolOptions {
  name: string
  description: string
  parameters: ParamSpecs
  /** 工具主体；抛出的 HostError 会被转成结构化错误返回。 */
  execute(args: Record<string, unknown>, ctx: { agentId?: string; toolCallId?: string }): Promise<HostToolValue>
  isConcurrencySafe?: boolean
}

/** 生成 registry-ready 的 ToolDefinition（参数校验 + 错误收束）。 */
export function defineHostTool(options: DefineHostToolOptions): DshToolDefinition {
  const schema = toJsonSchema(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters: schema,
    output: {
      // NOTE: ctx.tools.register() asserts the *supported JSON Schema subset*
      // (single type string, oneOf, properties/required/additionalProperties,
      // items/enum/const; type arrays are rejected). `data` is any JSON value,
      // so it is expressed with oneOf instead of a type array.
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: {
            oneOf: [
              { type: 'object' },
              { type: 'array' },
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
            ],
          },
        },
        required: ['ok', 'summary'],
        additionalProperties: true,
      },
      render: renderValue,
    },
    ...(options.isConcurrencySafe ? { isConcurrencySafe: () => options.isConcurrencySafe === true } : { isConcurrencySafe: () => true }),
    async execute(rawArgs: unknown, exec: { callId?: unknown; agent?: { id?: unknown } }) {
      const violations = validateArgs(options.parameters, rawArgs)
      if (violations.length > 0) {
        return {
          ok: false,
          summary: `参数不合法：${violations.join('；')}`,
          data: {
            error: violations.join('；'),
            hint: '按工具参数说明修正后重试',
            validValues: validValuesOf(options.parameters),
          },
        } satisfies HostToolValue
      }
      try {
        const value = await options.execute(rawArgs as Record<string, unknown>, {
          agentId: exec?.agent?.id !== undefined ? String(exec.agent.id) : undefined,
          toolCallId: exec?.callId !== undefined ? String(exec.callId) : undefined,
        })
        return toLosslessValue(value) as HostToolValue
      } catch (error) {
        const info = toAgentError(error)
        return toLosslessValue({
          ok: false,
          summary: `${info.error}${info.hint ? `。提示：${info.hint}` : ''}`,
          data: { error: info.error, hint: info.hint, ...(info.code ? { code: info.code } : {}) },
        }) as HostToolValue
      }
    },
  }
}

/** 枚举参数可取值（error 返回里给模型的自纠信息）。 */
export function validValuesOf(specs: ParamSpecs): Record<string, (string | number | boolean | null)[]> {
  const out: Record<string, (string | number | boolean | null)[]> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.enum && spec.enum.length > 0) out[name] = [...spec.enum]
  }
  return out
}

/** 便捷构造成功结果。 */
export function ok(summary: string, data?: unknown): HostToolValue {
  return data === undefined ? { ok: true, summary } : { ok: true, summary, data }
}

/** 便捷构造失败结果。 */
export function fail(error: string, hint: string, extra?: Record<string, unknown>): HostToolValue {
  return { ok: false, summary: `${error}${hint ? `。提示：${hint}` : ''}`, data: { error, hint, ...extra } }
}
