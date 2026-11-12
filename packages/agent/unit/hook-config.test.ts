import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

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
