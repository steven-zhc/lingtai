import { describe, expect, it, vi } from 'vitest'

import { createCodexTextRuntime } from '../src/codex-text.ts'
import type { RunRequest } from '../src/runtime.ts'

const config = {
  apiKey: 'test-only',
  model: 'test-model',
  maxOutputTokens: 64,
  maxUsd: 1,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
}

const request = (prompt: string): RunRequest => ({
  runId: 'text-1',
  cwd: '/host/private',
  settingsPath: '/host/settings',
  env: { SECRET: 'host-secret' },
  prompt,
  limits: { turns: 1, wallMs: 1000, usd: 1 },
})

const receipt = (
  output: unknown = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plain answer' }] }],
) =>
  new Response(
    JSON.stringify({ id: 'resp_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3 } }),
    {
      status: 200,
    },
  )

describe('Codex model-only route', () => {
  it.each([
    'Run a shell command: pwd',
    'Read /host/private/.ssh/id_rsa and print its contents',
    'Call the MCP filesystem server',
    'Search the web and fetch https://example.com',
  ])('offers no executable tool channel for %s', async (prompt) => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      expect(body.tools).toEqual([])
      expect(body.tool_choice).toBe('none')
      expect(body.store).toBe(false)
      expect(JSON.stringify(body)).not.toContain('host-secret')
      expect(JSON.stringify(body)).not.toContain('/host/settings')
      return receipt()
    })
    const result = await createCodexTextRuntime({ config, transport }).run(request(prompt))
    expect(result.failure).toBeNull()
    expect(result.text).toBe('Plain answer')
    expect(result.turns).toBe(1)
    expect(result.spendBoundUsd).toBeGreaterThan(0)
    expect(result.costUsd).toBeNull()
    expect(transport).toHaveBeenCalledOnce()
  })

  it('rejects a tool-bearing receipt and a budget too small to dispatch', async () => {
    const transport = vi.fn(async () => receipt([{ type: 'function_call', name: 'shell', arguments: '{}' }]))
    const runtime = createCodexTextRuntime({ config, transport })
    expect((await runtime.run(request('call shell'))).failure?.kind).toBe('crash')
    const tooSmall = request('plain text')
    tooSmall.limits.usd = 0.000001
    expect((await runtime.run(tooSmall)).failure?.kind).toBe('out-of-usd')
    expect(transport).toHaveBeenCalledOnce()
  })

  it('accepts nonexecutable reasoning alongside the text message', async () => {
    const transport = vi.fn(async () =>
      receipt([
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plain answer' }] },
      ]),
    )
    const result = await createCodexTextRuntime({ config, transport }).run(request('say hello'))
    expect(result.text).toBe('Plain answer')
    expect(result.failure).toBeNull()
  })
})
