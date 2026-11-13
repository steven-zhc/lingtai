/**
 * The setup's pause is the one conductor-wide pause left (#1013, 0126): it holds
 * across every daemon start, and any other `ConductorPaused` stops nothing.
 */
import { CONTROL_STREAM, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { controlWatermarkEffect, readControl, resumeConductor } from '../src/control.ts'

const pause = (data: Record<string, unknown>) => ({
  type: 'ConductorPaused',
  actor: 'conductor',
  data: parsePayload('ConductorPaused', { by: 'lingtai', reason: 'r', ...data }),
})

describe('readControl and the pauses on the log', () => {
  it('reads a setup pause written before the daemon started', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [
      pause({ reason: 'no tier', cause: 'setup', holdsAcrossStarts: true }),
    ] as never)
    // What a daemon keeps as its watermark: the pause is below it, and still read.
    expect(await Effect.runPromise(controlWatermarkEffect(store))).toBe(1)

    const state = await readControl(store)
    expect(state.paused).toBe(true)
    expect(state.by).toBe('lingtai')
    expect(state.reason).toBe('no tier')
  })

  it('reads a pause with a cause of person as nothing', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [pause({ by: 'human:ada', cause: 'person' })] as never)
    expect((await readControl(store)).paused).toBe(false)
  })

  it('lifts the setup pause with a resume', async () => {
    const store = createMemoryEventStore()
    await store.append(CONTROL_STREAM, 0, [pause({ cause: 'setup', holdsAcrossStarts: true })] as never)
    await resumeConductor('human:ada', store)
    expect((await readControl(store)).paused).toBe(false)
  })
})
