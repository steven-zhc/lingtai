/**
 * The control appends that decide on the state read `head` first, then the state, and append at that
 * head (#873): an event landing in between fails the append with `ConcurrencyError`, and the
 * retrying functions read again and succeed on the next try.
 */
import { CONTROL_STREAM } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { requestShutdownUnlessStanding, withdrawShutdown } from '../src/control.ts'

/** A store whose first `readTypes` of the control stream appends `event` behind the reader's back. */
function racing(real: EventStore, event: { type: string; actor: string; data: unknown }) {
  let raced = false
  const store = {
    ...real,
    readTypes: async (...args: Parameters<EventStore['readTypes']>) => {
      const out = await real.readTypes(...args)
      if (!raced) {
        raced = true
        await real.append(CONTROL_STREAM, await real.head(CONTROL_STREAM), [event as never])
      }
      return out
    },
  } as EventStore
  return { store, raced: () => raced }
}

describe('control appends decide at the head they read first', () => {
  it('requestShutdownUnlessStanding fails the first append, reads again, and succeeds', async () => {
    const real = createMemoryEventStore()
    const { store, raced } = racing(real, {
      type: 'ConductorPaused',
      actor: 'human:p',
      data: { by: 'a person', reason: 'x', until: null, holdsAcrossStarts: false, cause: 'person' },
    })
    const answer = await requestShutdownUnlessStanding('human:me', 'why', null, store)
    expect(raced()).toBe(true)
    expect(answer.asked).toBe(true)
    expect((await real.read(CONTROL_STREAM)).map((e) => e.type)).toEqual([
      'ConductorPaused',
      'ConductorShutdownRequested',
    ])
  })

  it('withdrawShutdown fails the first append, reads again, and succeeds', async () => {
    const real = createMemoryEventStore()
    const version = await real.append(CONTROL_STREAM, 0, [
      {
        type: 'ConductorShutdownRequested',
        actor: 'daemon',
        data: { by: 'human:me', reason: 'why', timeoutMs: null, force: false },
      } as never,
    ])
    const { store, raced } = racing(real, {
      type: 'ConductorPaused',
      actor: 'human:p',
      data: { by: 'a person', reason: 'x', until: null, holdsAcrossStarts: false, cause: 'person' },
    })
    const answer = await withdrawShutdown('human:me', typeof version === 'number' ? version : 1, 'done', store)
    expect(raced()).toBe(true)
    expect(answer.withdrew).toBe(true)
    expect((await real.read(CONTROL_STREAM)).map((e) => e.type)).toContain('ConductorShutdownWithdrawn')
  })
})
