/**
 * **The claim and the assignment of `onStream` are one region** (#1056, #269).
 *
 * `take` sets `onStream` on the line the claim's append committed, and `release`
 * acts only on `onStream`. An interruption between `claimTicket` returning and
 * that assignment would leave the item claimed with nothing to give it back, so
 * the whole span is uninterruptible. This holds it: the pass's fiber is
 * interrupted while the claim's append is still in flight, the append then
 * commits, and the ticket stream still ends in the release the interrupted pass
 * owes.
 *
 * Held on promises the test completes, with no timer.
 */
import { resolveRecipe } from '@lingtai/recipe'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import { PROJECT, fakeGitHub, fakePorts, memoryStore, project, runtime, withPorts } from '../test/one-attempt.ts'

describe('a claim that settles after the pass was interrupted', () => {
  it('still sets onStream, so the interrupted pass gives the item back', async () => {
    const base = memoryStore()
    let reachClaim!: () => void
    const reached = new Promise<void>((resolve) => (reachClaim = resolve))
    let letItCommit!: () => void
    const held = new Promise<void>((resolve) => (letItCommit = resolve))
    const store: typeof base = {
      ...base,
      async append(streamId, expectedVersion, events) {
        // The claim's own append is held back until the test lets it commit.
        if (events.some((e) => e.type === 'TicketClaimed')) {
          reachClaim()
          await held
        }
        return base.append(streamId, expectedVersion, events)
      },
    }
    const said: string[] = []
    const did: string[] = []
    const client = fakeGitHub(said)

    await Effect.runPromise(
      Effect.gen(function* () {
        const pass = yield* Effect.forkChild(
          runOnce({
            recipe: () => resolveRecipe((p, r) => client.fileAt(p, r), project.base ?? 'main'),
            project,
            client,
            runtime,
            issue: 7,
            hookBinary: '/tmp/fake/lingtai-hook',
            prompt: 'fix {{issue}}',
            merge: false,
            home: '/tmp/fake-home',
            store,
            log: () => {},
          }).pipe(Effect.provide(withPorts(fakePorts(did, store)))),
        )
        yield* Effect.promise(() => reached)
        // Interrupt the pass while the claim is in flight, and let the signal land
        // before the append is allowed to commit.
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(pass))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        letItCommit()
        yield* Fiber.join(interrupter)
      }),
    )

    const events = base.streams.get(`ticket-${PROJECT}-7`) ?? []
    const types = events.map((e) => e.type)
    expect(types).toContain('TicketClaimed')
    // The claim committed, and what is left of the pass gave the item back.
    const released = events.find((e) => e.type === 'TicketReleased')
    expect(released, 'the claimed item was not given back').toBeDefined()
    expect((released!.data as { reason: string }).reason).toBe('the run was interrupted')
  })
})
