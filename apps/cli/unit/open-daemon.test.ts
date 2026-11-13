/**
 * #1103: `openDaemon` over Effect ports. A control read that dies (a store failure is a defect, 0101 §6)
 * is the restart's `unread`, not an escape; the daemon is stopped before anything is taken.
 */
import type { DaemonStartPort } from '@lingtai/daemon'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { openDaemon } from '../src/restart.ts'

const code = { sha: 'a'.repeat(40), dirty: false }

function scene(control: () => Effect.Effect<{ shutdown: null }, unknown>) {
  const said: string[] = []
  const calls: string[] = []
  const started: DaemonStartPort = {
    ok: true,
    since: 3,
    daemon: {
      stopped: () => Effect.sync(() => void calls.push('stopped') as unknown as 'asked'),
      stop: () => Effect.sync(() => void calls.push('stop')),
      stoppedProjections: [],
    },
  }
  const opened = Effect.runPromise(
    openDaemon(
      { examined: code, by: 'human:ada' },
      { start: () => Effect.succeed(started), code: () => Effect.succeed(code), control, log: (l) => said.push(l) },
    ),
  )
  return { opened, said, calls }
}

describe('openDaemon with a control read that dies', () => {
  it('refuses with the read as unread, and stops the daemon before it takes anything', async () => {
    const { opened, said, calls } = scene(() => Effect.die(new Error('x')))
    expect(await opened).toEqual({ ok: false, code: 1 })
    expect(said.join('\n')).toContain('not starting:')
    expect(said.join('\n')).toContain('x')
    expect(calls).toEqual(['stop', 'stopped'])
  })

  it('goes on when the read is clean', async () => {
    const { opened, calls } = scene(() => Effect.succeed({ shutdown: null }))
    expect((await opened).ok).toBe(true)
    expect(calls).toEqual([])
  })
})
