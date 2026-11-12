/**
 * **Merged work is recorded as landed, never given back** (#1056).
 *
 * When the append that closes the merge step is refused after the integration
 * succeeded, the pass dies with a defect. The handler used to release the item,
 * returning merged work to the queue; it now records `TicketLanded` first.
 */
import { resolveRecipe } from '@lingtai/recipe'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { runOnce } from '../src/conduct.ts'
import { PROJECT, fakeGitHub, fakePorts, memoryStore, once, project, runtime, withPorts } from '../test/one-attempt.ts'

describe('a merge whose StepEnded append is refused', () => {
  it('records the landing and does not release the ticket', async () => {
    const base = memoryStore()
    const store: typeof base = {
      ...base,
      async append(streamId, expectedVersion, events) {
        const ended = events.find((e) => e.type === 'StepEnded')
        if (ended && (ended.data as { step?: string }).step === 'merge') throw new Error('store refused')
        return base.append(streamId, expectedVersion, events)
      },
    }
    const did: string[] = []
    await once(
      {
        project,
        client: fakeGitHub([]),
        runtime,
        issue: 7,
        hookBinary: '/tmp/fake/lingtai-hook',
        prompt: 'fix {{issue}}',
        merge: true,
        home: '/tmp/fake-home',
        store,
        log: () => {},
      },
      fakePorts(did, store, true),
    )
    expect(did).toContain('integrate')
    const types = (base.streams.get(`ticket-${PROJECT}-7`) ?? []).map((e) => e.type)
    expect(types).toContain('TicketLanded')
    expect(types).not.toContain('TicketReleased')
  })
})

describe('a pass interrupted while the integration is in flight', () => {
  it('records the landing the lane finished, and does not release the ticket', async () => {
    const store = memoryStore()
    const did: string[] = []
    const client = fakeGitHub([])
    const ports = fakePorts(did, store, true)
    await Effect.runPromise(
      Effect.gen(function* () {
        const inside = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const held = {
          ...ports,
          repo: {
            ...ports.repo,
            integrate: (...args: Parameters<typeof ports.repo.integrate>) =>
              Deferred.succeed(inside, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.andThen(ports.repo.integrate(...args)),
              ),
          },
        }
        const pass = yield* Effect.forkChild(
          runOnce({
            recipe: () => resolveRecipe((p, r) => client.fileAt(p, r), project.base ?? 'main'),
            project,
            client,
            runtime,
            issue: 7,
            hookBinary: '/tmp/fake/lingtai-hook',
            prompt: 'fix {{issue}}',
            merge: true,
            home: '/tmp/fake-home',
            store,
            log: () => {},
          }).pipe(Effect.provide(withPorts(held))),
        )
        yield* Deferred.await(inside)
        const interrupter = yield* Effect.forkChild(Fiber.interrupt(pass))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(interrupter)
      }),
    )
    expect(did).toContain('integrate')
    const types = (store.streams.get(`ticket-${PROJECT}-7`) ?? []).map((e) => e.type)
    expect(types).toContain('TicketLanded')
    expect(types).not.toContain('TicketReleased')
  })
})
