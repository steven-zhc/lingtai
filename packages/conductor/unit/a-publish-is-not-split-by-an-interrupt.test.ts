/**
 * **The end-of-pass publish is one region** (#1058, #468, #421).
 *
 * The push reaches origin before `published` and `armPublished` are assigned. An
 * interruption between the two would leave both stale, and the scope's finalizer
 * would then push the same head a second time. `publishWhatIsCommitted` is
 * `Effect.uninterruptible` where it is defined, so this holds it: the pass's
 * fiber is interrupted while the push is pending, the push then completes, and
 * the finalizer's own publish finds the head already published.
 *
 * Held on a `Deferred` the test completes, with no timer. Checked once by hand:
 * with the outer `Effect.uninterruptible` removed from `publishWhatIsCommitted`
 * this fails.
 */
import type { Runtime } from '@lingtai/agent'
import { resolveRecipe } from '@lingtai/recipe'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import {
  PROJECT,
  fakeGitHub,
  fakePorts,
  memoryStore,
  project,
  runtime,
  streams,
  withPorts,
} from '../test/one-attempt.ts'

const atTheWall: Runtime = {
  ...runtime,
  run: async () => ({
    exitCode: 1,
    turns: 151,
    durationMs: 1_800_000,
    costUsd: 20.81,
    failure: { kind: 'out-of-turns', detail: '151 turns, and the recipe allows 151 · $20.81' },
    text: null,
    sessionId: 'sess-237',
  }),
}

describe('a publish whose pass is interrupted while the push is pending', () => {
  it('finishes its bookkeeping, so the finalizer pushes nothing twice', async () => {
    const store = memoryStore()
    const did: string[] = []
    const said: string[] = []
    const ports = fakePorts(did, store)
    const client = fakeGitHub(said)
    const pushes: string[] = []
    const completed: string[] = []
    const inner = ports.repo.git
    const held = Deferred.makeUnsafe<void>()
    let entered!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    ports.repo.git = (args, o) => {
      if (args[0] !== 'push') return inner(args, o)
      pushes.push(args.join(' '))
      if (pushes.length > 1) return Effect.succeed('')
      return Effect.sync(entered).pipe(
        Effect.andThen(Deferred.await(held)),
        Effect.tap(() => Effect.sync(() => completed.push(args.join(' ')))),
        Effect.as(''),
      )
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const pass = yield* Effect.forkChild(
          runOnce({
            recipe: () => resolveRecipe((p, r) => client.fileAt(p, r), project.base ?? 'main'),
            project,
            client,
            runtime: atTheWall,
            issue: 7,
            hookBinary: '/tmp/fake/lingtai-hook',
            prompt: 'fix {{issue}}',
            merge: false,
            home: '/tmp/fake-home',
            store,
            log: () => {},
          }).pipe(Effect.provide(withPorts(ports))),
        )
        yield* Effect.promise(() => reached)
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(pass))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        yield* Deferred.succeed(held, undefined)
        yield* Fiber.join(interrupter)
      }),
    )

    expect(completed).toHaveLength(1)
    expect(pushes).toHaveLength(1)
    const run = [...streams(store)].find(([id]) => id.startsWith('pass-'))![1]
    const outcomes = run
      .filter((e) => e.type === 'RunRefsPublished')
      .map((e) => (e.data as { outcome: string }).outcome)
    expect(outcomes).toEqual(['published', 'already-published'])
    expect(store.streams.get(`ticket-${PROJECT}-7`)).toBeDefined()
  })
})
