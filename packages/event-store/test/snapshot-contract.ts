/**
 * What every `SnapshotStore` must do (#868, 0124 §7–§8). Run against the
 * memory store and SQLite in `unit/`, and against Postgres in `integration/`.
 */
import { describe, expect, it } from 'vitest'

import type { Snapshot, SnapshotStore } from '../src/snapshots.ts'

export interface SnapshotHarness {
  /** A stream id no other harness instance uses, so a shared table starts empty for this case. */
  sid: string
  snapshots: SnapshotStore
  /** One event on a stream of the harness's own. */
  append(): Promise<void>
  /** Empties this log's events; absent where the log is shared. */
  empty?: () => Promise<void>
}

export function describeSnapshotContract(name: string, fresh: () => Promise<SnapshotHarness> | SnapshotHarness): void {
  describe(`${name}: SnapshotStore`, () => {
    const key = (h: SnapshotHarness, reducerVersion = 1) => ({ streamId: h.sid, reducer: 'control', reducerVersion })

    async function snap(h: SnapshotHarness, over: Partial<Snapshot> = {}): Promise<Snapshot> {
      const epoch = await h.snapshots.epoch()
      if (epoch === null) throw new Error('the case must append before it snapshots')
      return {
        ...key(h),
        streamVersion: 3,
        lastSeq: 12n,
        epoch,
        state: JSON.stringify({ a: 1, b: ['x'] }),
        ...over,
      }
    }

    it('answers null for a key nothing was put under', async () => {
      const h = await fresh()
      await h.append()
      expect(await h.snapshots.latest(key(h))).toBeNull()
    })

    it('round-trips every field, with lastSeq a bigint', async () => {
      const h = await fresh()
      await h.append()
      const put = await snap(h, { lastSeq: 9007199254740991n })
      expect(await h.snapshots.put(put)).toBe('written')
      const got = await h.snapshots.latest(key(h))
      expect(got).not.toBeNull()
      expect(typeof got?.lastSeq).toBe('bigint')
      expect(got).toEqual({ ...put, state: got?.state })
      // Parsed, not compared as text: Postgres keeps the state as `jsonb`,
      // which reorders keys and normalises whitespace.
      expect(JSON.parse(got?.state ?? '')).toEqual(JSON.parse(put.state))
    })

    it('keeps the row for a lower or equal streamVersion, and replaces it for a higher one', async () => {
      const h = await fresh()
      await h.append()
      const first = await snap(h, { streamVersion: 5, state: '{"v":5}' })
      expect(await h.snapshots.put(first)).toBe('written')
      expect(await h.snapshots.put({ ...first, streamVersion: 5, state: '{"v":"same"}' })).toBe('kept')
      expect(await h.snapshots.put({ ...first, streamVersion: 4, state: '{"v":4}' })).toBe('kept')
      expect(JSON.parse((await h.snapshots.latest(key(h)))?.state ?? '')).toEqual({ v: 5 })
      expect(await h.snapshots.put({ ...first, streamVersion: 6, lastSeq: 20n, state: '{"v":6}' })).toBe('written')
      const got = await h.snapshots.latest(key(h))
      expect(got?.streamVersion).toBe(6)
      expect(got?.lastSeq).toBe(20n)
    })

    it('keeps two keys that differ only in reducerVersion as separate rows', async () => {
      const h = await fresh()
      await h.append()
      await h.snapshots.put(await snap(h, { reducerVersion: 1, state: '{"v":1}' }))
      await h.snapshots.put(await snap(h, { reducerVersion: 2, state: '{"v":2}' }))
      expect(JSON.parse((await h.snapshots.latest(key(h, 1)))?.state ?? '')).toEqual({ v: 1 })
      expect(JSON.parse((await h.snapshots.latest(key(h, 2)))?.state ?? '')).toEqual({ v: 2 })
    })

    it('has no epoch on an empty log, a stable one across appends, and refuses a put against it', async () => {
      const h = await fresh()
      // A shared log already holds other cases' events; only an owned one starts empty.
      if (h.empty !== undefined) {
        expect(await h.snapshots.epoch()).toBeNull()
        await expect(
          h.snapshots.put({ ...key(h), streamVersion: 1, lastSeq: 1n, epoch: 'nope', state: '{}' }),
        ).rejects.toThrow()
      }
      await h.append()
      const e = await h.snapshots.epoch()
      expect(e).not.toBeNull()
      await h.append()
      expect(await h.snapshots.epoch()).toBe(e)
    })

    it('refuses a put whose epoch is not the current one, and stores nothing', async () => {
      const h = await fresh()
      await h.append()
      await expect(h.snapshots.put(await snap(h, { epoch: 'not-this-log' }))).rejects.toThrow(/epoch/)
      expect(await h.snapshots.latest(key(h))).toBeNull()
    })

    it('refuses a snapshot out of range with a RangeError', async () => {
      const h = await fresh()
      await h.append()
      await expect(h.snapshots.put(await snap(h, { streamVersion: 0 }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(await snap(h, { lastSeq: -1n }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(await snap(h, { reducer: '' }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(await snap(h, { reducerVersion: 1.5 }))).rejects.toThrow(RangeError)
    })

    it('is void across a reset: another epoch answers null and is replaced at a lower version', async () => {
      const h = await fresh()
      if (h.empty === undefined) return // a shared log cannot be emptied
      await h.append()
      await h.snapshots.put(await snap(h, { streamVersion: 9 }))
      const before = await h.snapshots.epoch()
      await h.empty()
      expect(await h.snapshots.epoch()).toBeNull()
      await h.append()
      expect(await h.snapshots.epoch()).not.toBe(before)
      expect(await h.snapshots.latest(key(h))).toBeNull()
      expect(await h.snapshots.put(await snap(h, { streamVersion: 2 }))).toBe('written')
      expect((await h.snapshots.latest(key(h)))?.streamVersion).toBe(2)
    })
  })
}
