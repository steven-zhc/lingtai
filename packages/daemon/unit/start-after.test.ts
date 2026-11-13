/** `startAfter` reads only `ConductorStarted` events from just past `version` (#872). */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { controlWatermarkEffect, startAfterEffect } from '../src/control.ts'

const started = (by: string) => ({
  type: 'ConductorStarted' as const,
  actor: 'conductor',
  data: parsePayload('ConductorStarted', {
    by,
    reason: 'test',
    sha: 'abc',
    dirty: false,
    worker: 'h:1',
    handoff: null,
  } as never),
})
const resumed = { type: 'ConductorResumed' as const, actor: 'conductor', data: { by: 'x' } }

describe('startAfter', () => {
  it('skips a start at version and returns the first one after it', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [started('one'), resumed, started('two'), started('three')])

    expect((await Effect.runPromise(startAfterEffect(1, store)))?.by).toBe('two')
    expect((await Effect.runPromise(startAfterEffect(3, store)))?.by).toBe('three')
    expect(await Effect.runPromise(startAfterEffect(4, store))).toBeNull()
    expect(await Effect.runPromise(controlWatermarkEffect(store))).toBe(4)
  })
})
