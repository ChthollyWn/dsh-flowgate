import { describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { createFlowTools } from '../../src/host/tools/definitions.js'
import { setupPlugin } from './helpers.js'

describe('tool schemas are inside the host-supported JSON Schema subset', () => {
  it('all flow_* definitions pass assertSupportedJsonSchema', async () => {
    const harness = await setupPlugin()
    try {
      const tools = createFlowTools(harness.runtime)
      expect(tools.length).toBeGreaterThan(0)
      for (const tool of tools) {
        try {
          assertSupportedJsonSchema(tool.output.schema as never)
        } catch (error) {
          throw new Error(`${tool.name} output.schema: ${String((error as Error).message)}`)
        }
      }
    } finally {
      await harness.cleanup()
    }
  })
})
