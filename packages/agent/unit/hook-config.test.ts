import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { renderSettings } from '../src/hook-config.ts'
import { AgentHostFailed, SUN_PATH_MAX, writeHookWiringEffect } from '../src/index.ts'

describe('writeHookWiringEffect', () => {
  const tmp = process.env['TMPDIR']
  afterEach(() => {
    if (tmp === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = tmp
  })

  it('fails with AgentHostFailed, carrying the sun_path sentence, when the socket path is too long', async () => {
    process.env['TMPDIR'] = `/${'d'.repeat(SUN_PATH_MAX)}`
    const error = await Effect.runPromise(
      Effect.flip(
        writeHookWiringEffect({ runId: 'pass-long', hookBinary: '/bin/lingtai-hook', home: '/nonexistent/home' }),
      ),
    )
    expect(error).toBeInstanceOf(AgentHostFailed)
    expect(error.operation).toBe('wire')
    expect(error.detail).toContain(`the limit is ${SUN_PATH_MAX}`)
  })
})

describe('renderSettings and the sandbox key (#1150)', () => {
  const base = { runId: 'r', hookBinary: '/bin/lingtai-hook' }

  it('a sandboxed run turns Claude Code’s own sandbox off, and nothing else changes', () => {
    const plain = renderSettings(base) as { hooks: unknown }
    const sandboxed = renderSettings({ ...base, sandboxed: true }) as { hooks: unknown; sandbox: unknown }
    expect(sandboxed.sandbox).toEqual({ enabled: false })
    expect(sandboxed.hooks).toEqual(plain.hooks)
  })

  it('an unsandboxed run’s file has no sandbox key', () => {
    expect(renderSettings(base)).not.toHaveProperty('sandbox')
    expect(renderSettings({ ...base, sandboxed: false })).not.toHaveProperty('sandbox')
  })
})
