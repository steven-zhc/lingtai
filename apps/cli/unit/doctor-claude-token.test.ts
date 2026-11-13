import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { claudeTokenRow } from '../src/doctor.ts'

const TOKEN = 'sk-ant-oat01-FAKE-0000'

describe('claudeTokenRow', () => {
  it('says set, and not set with the fix, and never a value', async () => {
    const set = await Effect.runPromise(claudeTokenRow(() => Effect.succeed(true)))
    expect(set).toMatchObject({ status: 'ok', detail: 'set' })
    const unset = await Effect.runPromise(claudeTokenRow(() => Effect.succeed(false)))
    expect(unset.status).toBe('ok')
    expect(unset.detail).toContain('claude setup-token')
    expect(unset.detail).toContain('claude.oauth_token')
  })

  it('fails with the reader sentence when the file cannot be read, quoting nothing', async () => {
    const row = await Effect.runPromise(
      claudeTokenRow(() =>
        Effect.fail(new Error('/x/config.yml could not be read or parsed, so claude.oauth_token is unknown')),
      ),
    )
    expect(row.status).toBe('fail')
    expect(JSON.stringify(row)).not.toContain(TOKEN)
  })
})
