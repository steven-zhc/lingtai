/**
 * **A release runs whole, or not at all** (#1080, #1043).
 *
 * It used to be one `async` body inside `Effect.tryPromise`, which ran to the end
 * in the background however the fiber ended. As `yield*` steps an interruption
 * between `TicketReleased` and the labels write would leave the item back in the
 * queue with GitHub still saying `working`, and `released` is already set so
 * nothing would run it again. The release is `Effect.uninterruptible`.
 *
 * Held on a `Deferred` the test completes, with no timer.
 */
import { resolveRecipe } from '@lingtai/recipe'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import { PROJECT, fakeGitHub, fakePorts, memoryStore, project, runtime, withPorts } from '../test/one-attempt.ts'

describe('a release whose TicketReleased append is still in flight when the pass is interrupted', () => {
  it('records the release, the labels write and its outcome once the write is let through', async () => {
    const base = memoryStore()
    const said: string[] = []
    let refused = false
    // The claim's append is refused with something other than a lost race, so the pass
    // gives the item back through `release` on an *interruptible* path (not the
    // `Effect.ensuring` finalizer, which is uninterruptible whatever the release does).
    // No end plan is resolved on that path, so there is no `EndActionsResolved` to expect.
    let reached!: Deferred.Deferred<void>
    let latch!: Deferred.Deferred<void>
    const store: typeof base = {
      ...base,
      async append(streamId, expectedVersion, events) {
        if (!refused && events.some((e) => e.type === 'TicketClaimed')) {
          refused = true
          throw new Error('terminating connection')
        }
        // The release's own append waits here. An interrupt that lands now is cut off only
        // by the release's mask: the labels write is a *later* step, so no inner
        // `uninterruptible` (`tellGitHubEffect`'s) can be what keeps it.
        if (events.some((e) => e.type === 'TicketReleased')) {
          await Effect.runPromise(Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(latch))))
        }
        return base.append(streamId, expectedVersion, events)
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        reached = yield* Deferred.make<void>()
        latch = yield* Deferred.make<void>()
        const client = fakeGitHub(said)
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
          }).pipe(Effect.provide(withPorts(fakePorts([], store)))),
        )
        // The release is inside its TicketReleased append; nothing after it has happened.
        yield* Deferred.await(reached)
        expect(said.some((line) => line.startsWith('labels'))).toBe(false)
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(pass))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        yield* Deferred.succeed(latch, undefined)
        yield* Fiber.join(interrupter)
      }),
    )

    const events = base.streams.get(`ticket-${PROJECT}-7`) ?? []
    // The write went through, and its outcome was recorded after it.
    expect(said.some((line) => line.startsWith('labels #7'))).toBe(true)
    expect(events.some((e) => e.type === 'IssueUpdated' && (e.data as { change?: string }).change === 'labels')).toBe(
      true,
    )
  })
})

describe('a claim whose append is refused with something other than a lost race', () => {
  it('answers that the item may be held, and gives it back, rather than dying with onStream unset', async () => {
    const base = memoryStore()
    let refused = false
    const store: typeof base = {
      ...base,
      async append(streamId, expectedVersion, events) {
        // A dropped connection on the claim's own append — not a `ConcurrencyError`.
        if (!refused && events.some((e) => e.type === 'TicketClaimed')) {
          refused = true
          throw new Error('terminating connection')
        }
        return base.append(streamId, expectedVersion, events)
      },
    }
    const result = await Effect.runPromise(
      runOnce({
        recipe: () => resolveRecipe((p, r) => fakeGitHub([]).fileAt(p, r), project.base ?? 'main'),
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: false,
        home: '/tmp/fake-home',
        store,
        log: () => {},
      }).pipe(Effect.provide(withPorts(fakePorts([], store)))),
    )
    // Answered as *may hold*, not raised as a defect (0122).
    expect(result).toMatchObject({ ok: false, stage: 'claim', detail: expect.stringContaining('may be claimed') })
    const types = (base.streams.get(`ticket-${PROJECT}-7`) ?? []).map((e) => e.type)
    // `onStream` was set, so the release ran and gave back what the refused append may have held.
    expect(types).toContain('TicketReleased')
  })
})
