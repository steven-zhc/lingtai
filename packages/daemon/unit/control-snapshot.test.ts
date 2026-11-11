/**
 * A whole-stream control read starts from the latest usable snapshot (0124 §6, #871)
 * and gives the answer reducing from version 1 gives.
 */
import {
  CONTROL_STREAM,
  type ControlState,
  controlReducer,
  isRetiredEventType,
  reduceAll,
  reduceControl,
} from '@lingtai/domain'
import { histories, lateHistories } from '@lingtai/domain/test/histories'
import type { Snapshot } from '@lingtai/event-store'
import { createMemoryEventStore, createMemorySnapshotStore } from '@lingtai/event-store/memory'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readControl } from '../src/control.ts'

vi.mock('@lingtai/event-store', async (orig) => {
  const real = await orig<typeof import('@lingtai/event-store')>()
  return {
    ...real,
    log: {
      get snapshots(): never {
        throw new Error('the process log was touched')
      },
    },
  }
})

const key = { streamId: CONTROL_STREAM, reducer: controlReducer.name, reducerVersion: controlReducer.version }

async function build(history: readonly { type: string; actor: string; data?: unknown }[]) {
  const store = createMemoryEventStore()
  for (const [i, e] of history.entries()) {
    await store.append(CONTROL_STREAM, i, [{ type: e.type, actor: e.actor, data: e.data } as never])
  }
  const stored = await store.read(CONTROL_STREAM)
  const snapshots = createMemorySnapshotStore(store)
  const at = (k: number, state?: string): Snapshot => ({
    ...key,
    streamVersion: stored[k - 1]!.version,
    lastSeq: stored[k - 1]!.seq,
    lastAt: stored[k - 1]!.at,
    state: state ?? controlReducer.encode(reduceAll(controlReducer, stored.slice(0, k))),
  })
  return { store, stored, snapshots, at }
}

// A store refuses to append a retired type, so the histories that hold one are replayed without it. The
// reducer's reading of a retired event is `control.test.ts`'s to prove, on envelopes it builds itself.
const all = (
  [...Object.values(histories.control), ...Object.values(lateHistories.control)] as readonly (readonly {
    type: string
    actor: string
    data?: unknown
  }[])[]
).map((h) => h.filter((e) => !isRetiredEventType(e.type)))

describe('readControl through a snapshot equals reducing from version 1', () => {
  for (const [n, history] of all.entries()) {
    for (let len = 1; len <= history.length; len++) {
      it(`history ${n}, prefix ${len}`, async () => {
        const { store, snapshots, at } = await build(history.slice(0, len))
        const want = await readControl(store)
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
        for (let k = 1; k <= len; k++) {
          snapshots.plant(at(k))
          expect(await readControl(store, 0, { snapshots })).toEqual(want)
        }
        snapshots.plant({ ...at(len), lastSeq: 999999n }) // void anchor
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
        snapshots.plant(at(len, 'not json {'))
        expect(await readControl(store, 0, { snapshots })).toEqual(want)
      })
    }
  }
})

describe('readControl offers', () => {
  const pauses = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: i % 2 === 0 ? 'ConductorPaused' : 'ConductorResumed',
      actor: 'human:steven',
      data: i % 2 === 0 ? { by: 'steven', reason: 'r', until: null } : { by: 'steven' },
    }))

  it('offers one snapshot anchored on the last envelope when the tail crosses', async () => {
    const { store, stored, snapshots } = await build(pauses(6))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).toHaveBeenCalledTimes(1)
    const s = offer.mock.calls[0]![0] as Snapshot
    const last = stored[stored.length - 1]!
    expect([s.streamVersion, s.lastSeq, s.lastAt]).toEqual([last.version, last.seq, last.at])
    expect(s.state).toBe(controlReducer.encode(reduceAll(controlReducer, stored)))
  })

  it('offers nothing when the tail does not cross, or there is none', async () => {
    const { store, snapshots, at } = await build(pauses(4))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    snapshots.plant(at(4))
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).not.toHaveBeenCalled()
  })

  it('treats an undecodable snapshot as absent for the commit point', async () => {
    const { store, snapshots, at } = await build(pauses(9))
    snapshots.plant(at(6, 'not json {'))
    const offer = vi.fn()
    await readControl(store, 0, { snapshots, writer: { offer } })
    expect(offer).toHaveBeenCalledTimes(1)
  })

  it('reads from version 1 when the anchor stops holding after the tail was read', async () => {
    const { store, snapshots, at } = await build(pauses(6))
    snapshots.plant(at(5))
    const real = snapshots.latest.bind(snapshots)
    let calls = 0
    const reset = {
      ...snapshots,
      latest: (k: Parameters<typeof real>[0]) => (++calls > 1 ? Promise.resolve(null) : real(k)),
    }
    const want = await readControl(store)
    expect(await readControl(store, 0, { snapshots: reset as never })).toEqual(want)
  })

  it('never touches the process log when a store is passed with no snapshots', async () => {
    const { store } = await build(pauses(6))
    await expect(readControl(store)).resolves.toBeDefined()
  })
})

// Today's two-reduce algorithm for `since > 0`, kept as the reference (#874). The pause is scoped by the
// watermark; a shutdown is not — it is the whole stream's, ended by a `ConductorStarted` (0126).
function reference(stored: Parameters<typeof reduceControl>[0], since: number, now: Date): ControlState {
  const events = stored
  const whole = reduceControl(events, now)
  const scoped = {
    ...reduceControl(
      events.filter((e) => e.version > since),
      now,
    ),
    shutdown: whole.shutdown,
  }
  if (scoped.paused) return scoped
  if (!whole.paused || !whole.holdsAcrossStarts) return scoped
  return { ...scoped, paused: true, by: whole.by, reason: whole.reason, until: whole.until, cause: whole.cause }
}

const pick = (s: ControlState) => ({
  paused: s.paused,
  by: s.by,
  reason: s.reason,
  until: s.until,
  cause: s.cause,
  shutdown: s.shutdown,
})

describe('readControl(store, since) equals the two-reduce reference', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const [n, history] of all.entries()) {
    for (let len = 1; len <= history.length; len++) {
      it(`history ${n}, prefix ${len}`, async () => {
        const { store, stored, snapshots, at } = await build(history.slice(0, len))
        const untils = stored
          .map((e) => (e.data as { until?: unknown } | null)?.until)
          .filter((u): u is string => typeof u === 'string')
          .map((u) => Date.parse(u))
          .filter((t) => !Number.isNaN(t))
        const nows = [new Date('2026-01-01T00:00:00Z'), ...untils.flatMap((t) => [new Date(t - 1), new Date(t + 1)])]
        vi.useFakeTimers({ toFake: ['Date'] })
        const check = async (cache: { snapshots?: typeof snapshots }) => {
          for (const now of nows) {
            vi.setSystemTime(now)
            for (let since = 0; since <= len; since++) {
              const got = await readControl(store, since, cache)
              const want = since === 0 ? reduceControl(stored, now) : reference(stored, since, now)
              expect(pick(got), `since ${since} now ${now.toISOString()}`).toEqual(pick(want))
            }
          }
        }
        await check({})
        for (let k = 1; k <= len; k++) {
          snapshots.plant(at(k))
          await check({ snapshots })
        }
      })
    }
  }
})
