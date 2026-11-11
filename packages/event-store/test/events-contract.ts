/**
 * What `Events` is, stated once and run against every implementation (#1020).
 *
 * The promise contract (`contract.ts`) stays as it is. This one asserts on
 * `Exit`: a lost race is a `Fail` and everything else is a `Die`, and the
 * promise face rejects with the very instance the Effect failed with.
 */
import { Cause, Effect, Exit } from 'effect'
import { describe, expect, it } from 'vitest'

import { ConcurrencyError, type EventsPort } from '../src/event-store.ts'
import { promiseStore } from '../src/store-face.ts'

const claimed = (runId: string) => ({
  type: 'TicketClaimed' as const,
  actor: 'conductor',
  data: { runId, worker: 'test', title: null, kind: null },
})

export function describeEventsContract(name: string, make: () => EventsPort, freshStream: () => string) {
  describe(`${name}: Events`, () => {
    it('a lost race is a Fail carrying a ConcurrencyError, not a Die', async () => {
      const events = make()
      const id = freshStream()
      await Effect.runPromise(events.append(id, 0, [claimed('a')]))
      const exit = await Effect.runPromiseExit(events.append(id, 0, [claimed('b')]))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ConcurrencyError)
        expect((error as ConcurrencyError)._tag).toBe('ConcurrencyError')
      }
    })

    it('an unknown type and a negative expectedVersion are each a Die', async () => {
      const events = make()
      const id = freshStream()
      const unknown = await Effect.runPromiseExit(
        events.append(id, 0, [{ ...claimed('a'), type: 'NoSuchType' } as never]),
      )
      const negative = await Effect.runPromiseExit(events.append(id, -1, [claimed('a')]))
      for (const exit of [unknown, negative]) {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(Cause.hasFails(exit.cause)).toBe(false)
        }
      }
    })

    it('the face rejects with the very ConcurrencyError the Effect failed with', async () => {
      const events = make()
      const id = freshStream()
      const lost = new ConcurrencyError(id, 0, [1])
      const failing: EventsPort = { ...events, append: () => Effect.fail(lost) }
      await expect(promiseStore(failing).append(id, 0, [claimed('a')])).rejects.toBe(lost)
    })

    it('append, read and head agree', async () => {
      const events = make()
      const id = freshStream()
      const written = await Effect.runPromise(events.append(id, 0, [claimed('a'), claimed('b')]))
      expect(written.map((e) => e.version)).toEqual([1, 2])
      expect(await Effect.runPromise(events.head(id))).toBe(2)
      expect((await Effect.runPromise(events.read(id, 2))).map((e) => e.version)).toEqual([2])
    })
  })
}
