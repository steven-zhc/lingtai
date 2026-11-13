import { readControlEffect } from '@lingtai/daemon/control'
/**
 * `lingtai run` is a conductor, and a pause stops conductors (#166).
 *
 * The lock (#93) is about concurrency and says nothing about consent, so a
 * `lingtai pause` taken with no daemon up left the lock free and a `lingtai run`
 * took work anyway. What has to be true is that a pause on the log stops the
 * command **before it takes the lock** — and that what `lingtai pause`,
 * `lingtai doctor` and `--help` print about `run` is what the behaviour bears
 * out.
 *
 * No database: the pause is appended to a memory store, and a run that got past
 * it would reach for the conductor lock and say so — which the first test
 * asserts it does not. A pause heard *between* tickets is `runQueue`'s, and is
 * held in `packages/conductor` (`unit/schedule-pause.test.ts`).
 */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { daemonLiveness } from '../src/doctor.ts'
import { commandHelp } from '../src/help.ts'
import { RUN_UNDER_A_PAUSE, run } from '../src/run.ts'

/** The setup's pause, the one pause that stops the conductor, planted the way `pauseConductorOnce` appends it. */
async function plantSetupPause(store: EventStore, reason: string): Promise<void> {
  await store.append(CONTROL_STREAM, await store.head(CONTROL_STREAM), [
    {
      type: 'ConductorPaused',
      actor: 'conductor',
      data: parsePayload('ConductorPaused', {
        by: 'lingtai',
        reason,
        until: null,
        cause: 'setup',
        holdsAcrossStarts: true,
      }),
    },
  ])
}

describe('lingtai run under a standing pause', () => {
  it('is refused, and never reaches the lock', async () => {
    const store = createMemoryEventStore()
    await plantSetupPause(store, 'migrating the database')

    const lines: string[] = []
    const code = await run({ project: 'esctest-never-looked-up', lockKey: 'lingtai:test:paused', store }, (l) =>
      lines.push(l),
    )
    const said = lines.join('\n')

    // Exit 0: a person decided this, and nothing went wrong.
    expect(code).toBe(0)
    expect(said).toContain('paused by lingtai — migrating the database')
    expect(said).toContain(`nothing was taken: ${RUN_UNDER_A_PAUSE}`)
    // Every one of these is a stage past the pause. Their absence is the claim.
    expect(said).not.toContain('conductor lock')
    expect(said).not.toContain('GitHub App')
    expect(said).not.toContain('no project named')
    expect(said).not.toContain('run(s)')
  })

  it('is what --help says about lingtai run under lingtai pause', async () => {
    const entry = commandHelp('pause')
    expect(entry.replace(/\s+/g, ' ')).toContain(
      'lingtai run, which takes no ticket while a pause stands, daemon or none: one already working finishes the ticket in hand and takes no other',
    )
  })

  it('is what lingtai doctor reports beside the pause', async () => {
    const store = createMemoryEventStore()
    await plantSetupPause(store, 'migrating the database')

    const liveness = await Effect.runPromise(
      daemonLiveness(
        () => Effect.succeed(null),
        () => readControlEffect(store),
      ),
    )
    expect(liveness.detail).toContain('paused by lingtai (migrating the database)')
    expect(liveness.detail).toContain(RUN_UNDER_A_PAUSE)
  })
})
