/**
 * The control appends that decide on the state read `head` first, then the state, and append at that
 * head (#873): an event landing in between fails the append with `ConcurrencyError`, and the
 * retrying functions read again and succeed on the next try.
 */
import { CONTROL_STREAM } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { readControl, recordStartEffect, requestShutdownUnlessStanding } from '../src/control.ts'

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
})

const recordStart = (...args: Parameters<typeof recordStartEffect>) => Effect.runPromise(recordStartEffect(...args))

describe('recordStart decides and appends at the head it read', () => {
  const code = { sha: 'abc1234', dirty: false }
  const request = {
    type: 'ConductorShutdownRequested',
    actor: 'daemon',
    data: { by: 'human:me', reason: 'why', timeoutMs: null, force: false },
  } as never

  it('over a request at or below `since` appends a start, and the request is then ended', async () => {
    const real = createMemoryEventStore()
    await real.append(CONTROL_STREAM, 0, [request])
    expect(await recordStart('daemon', null, code, 1, real)).toEqual({ recorded: true })
    expect((await real.read(CONTROL_STREAM)).map((e) => e.type)).toEqual([
      'ConductorShutdownRequested',
      'ConductorStarted',
    ])
    expect((await readControl(real)).shutdown).toBeNull()
  })

  it('over a request above `since` appends nothing and answers that request', async () => {
    const real = createMemoryEventStore()
    await real.append(CONTROL_STREAM, 0, [request])
    const answer = await recordStart('daemon', null, code, 0, real)
    expect(answer).toMatchObject({ recorded: false, standing: { by: 'human:me', version: 1 } })
    expect((await real.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ConductorShutdownRequested'])
  })

  it('reads again when a request lands between its read and its append, and obeys it', async () => {
    const real = createMemoryEventStore()
    const { store, raced } = racing(real, request as never)
    const answer = await recordStart('daemon', null, code, 0, store)
    expect(raced()).toBe(true)
    expect(answer).toMatchObject({ recorded: false })
    expect((await real.read(CONTROL_STREAM)).map((e) => e.type)).toEqual(['ConductorShutdownRequested'])
  })

  it('throws when the append fails with anything but a lost race', async () => {
    const real = createMemoryEventStore()
    const store = {
      ...real,
      append: async () => {
        throw new Error('the disk is gone')
      },
    } as unknown as EventStore
    await expect(recordStart('daemon', null, code, 0, store)).rejects.toThrow('the disk is gone')
  })
})
