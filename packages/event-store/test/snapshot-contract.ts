/**
 * What every `SnapshotStore` must do (#868, #869, 0124 §7–§8). Run against the
 * memory store and SQLite in `unit/`, and against Postgres in `integration/`.
 */
import type { Envelope } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import type { Snapshot, SnapshotStore } from '../src/snapshots.ts'

export interface SnapshotHarness {
  /** The stream id the harness appends to and snapshots, no other harness instance uses it. */
  sid: string
  snapshots: SnapshotStore
  /** One event on the harness's own stream `sid`; the envelope as the store returns it. */
  append(): Promise<Envelope>
  /** Writes a row with no anchor check — how a case holds a void one without emptying a shared log. */
  plant(snapshot: Snapshot): Promise<void>
  /** Empties this log's events; absent where the log is shared. */
  empty?: () => Promise<void>
}

export function describeSnapshotContract(name: string, fresh: () => Promise<SnapshotHarness> | SnapshotHarness): void {
  describe(`${name}: SnapshotStore`, () => {
    const key = (h: SnapshotHarness, reducerVersion = 1) => ({ streamId: h.sid, reducer: 'control', reducerVersion })

    /** A snapshot anchored on `env`, the event it was reduced to. */
    function snap(h: SnapshotHarness, env: Envelope, over: Partial<Snapshot> = {}): Snapshot {
      return {
        ...key(h),
        streamVersion: env.version,
        lastSeq: env.seq,
        lastAt: env.at,
        state: JSON.stringify({ a: 1, b: ['x'] }),
        ...over,
      }
    }

    it('answers null for a key nothing was put under', async () => {
      const h = await fresh()
      await h.append()
      expect(await h.snapshots.latest(key(h))).toBeNull()
    })

    it('round-trips every field, with lastSeq a bigint and lastAt a Date', async () => {
      const h = await fresh()
      const put = snap(h, await h.append())
      expect(await h.snapshots.put(put)).toBe('written')
      const got = await h.snapshots.latest(key(h))
      expect(got).not.toBeNull()
      expect(typeof got?.lastSeq).toBe('bigint')
      expect(got?.lastAt).toBeInstanceOf(Date)
      expect(got).toEqual({ ...put, state: got?.state })
      // Parsed, not compared as text: Postgres keeps the state as `jsonb`,
      // which reorders keys and normalises whitespace.
      expect(JSON.parse(got?.state ?? '')).toEqual(JSON.parse(put.state))
    })

    it('keeps the row for a lower or equal streamVersion, and replaces it for a higher one', async () => {
      const h = await fresh()
      const e1 = await h.append()
      const e2 = await h.append()
      const e3 = await h.append()
      expect(await h.snapshots.put(snap(h, e2, { state: '{"v":2}' }))).toBe('written')
      expect(await h.snapshots.put(snap(h, e2, { state: '{"v":"same"}' }))).toBe('kept')
      expect(await h.snapshots.put(snap(h, e1, { state: '{"v":1}' }))).toBe('kept')
      expect(JSON.parse((await h.snapshots.latest(key(h)))?.state ?? '')).toEqual({ v: 2 })
      expect(await h.snapshots.put(snap(h, e3, { state: '{"v":3}' }))).toBe('written')
      const got = await h.snapshots.latest(key(h))
      expect(got?.streamVersion).toBe(e3.version)
      expect(got?.lastSeq).toBe(e3.seq)
    })

    it('keeps two keys that differ only in reducerVersion as separate rows', async () => {
      const h = await fresh()
      const e = await h.append()
      await h.snapshots.put(snap(h, e, { reducerVersion: 1, state: '{"v":1}' }))
      await h.snapshots.put(snap(h, e, { reducerVersion: 2, state: '{"v":2}' }))
      expect(JSON.parse((await h.snapshots.latest(key(h, 1)))?.state ?? '')).toEqual({ v: 1 })
      expect(JSON.parse((await h.snapshots.latest(key(h, 2)))?.state ?? '')).toEqual({ v: 2 })
    })

    it('refuses a put whose anchor is not in the log, and stores nothing', async () => {
      const h = await fresh()
      const e = await h.append()
      const wrongSeq = snap(h, e, { lastSeq: e.seq + 1000n })
      await expect(h.snapshots.put(wrongSeq)).rejects.toThrow(/anchor event.*not in this log/)
      await expect(h.snapshots.put(snap(h, e, { streamVersion: e.version + 5 }))).rejects.toThrow(/not in this log/)
      await expect(h.snapshots.put(snap(h, e, { lastAt: new Date(e.at.getTime() + 1) }))).rejects.toThrow(
        /not in this log/,
      )
      expect(await h.snapshots.latest(key(h))).toBeNull()
    })

    it('refuses a snapshot out of range with a RangeError', async () => {
      const h = await fresh()
      const e = await h.append()
      await expect(h.snapshots.put(snap(h, e, { streamVersion: 0 }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(snap(h, e, { lastSeq: -1n }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(snap(h, e, { reducer: '' }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(snap(h, e, { reducerVersion: 1.5 }))).rejects.toThrow(RangeError)
      await expect(h.snapshots.put(snap(h, e, { lastAt: new Date(Number.NaN) }))).rejects.toThrow(RangeError)
    })

    describe('a row whose anchor no longer holds', () => {
      const cases: [string, (e: Envelope) => Partial<Snapshot>][] = [
        ['a version past the end of the stream', (e) => ({ streamVersion: e.version + 5 })],
        ['the right version with another seq', (e) => ({ lastSeq: e.seq + 1000n })],
        ['the right version and seq with an at off by 1ms', (e) => ({ lastAt: new Date(e.at.getTime() + 1) })],
      ]
      for (const [what, over] of cases) {
        it(`answers null and is replaced at a lower version: ${what}`, async () => {
          const h = await fresh()
          const e1 = await h.append()
          const e2 = await h.append()
          await h.plant(snap(h, e2, { state: '{"void":true}', ...over(e2) }))
          expect(await h.snapshots.latest(key(h))).toBeNull()
          expect(await h.snapshots.put(snap(h, e1, { state: '{"v":1}' }))).toBe('written')
          const got = await h.snapshots.latest(key(h))
          expect(got?.streamVersion).toBe(e1.version)
          expect(JSON.parse(got?.state ?? '')).toEqual({ v: 1 })
        })
      }
    })

    it('counts what the table holds per (reducer, reducerVersion): usable, older version, void anchor', async () => {
      const h = await fresh()
      const e1 = await h.append()
      const e2 = await h.append()
      // Names no other case uses: the census is over the whole table and a shared log holds every case's rows.
      const a = `census-a-${h.sid}`
      const b = `census-b-${h.sid}`
      await h.snapshots.put(snap(h, e2, { reducer: a, reducerVersion: 2 }))
      await h.snapshots.put(snap(h, e1, { reducer: a, reducerVersion: 1 }))
      await h.plant(snap(h, e2, { reducer: b, reducerVersion: 1, lastSeq: e2.seq + 1_000_000n }))
      const mine = (await h.snapshots.census()).filter((r) => r.reducer === a || r.reducer === b)
      const of = (reducer: string, reducerVersion: number) =>
        mine.find((r) => r.reducer === reducer && r.reducerVersion === reducerVersion)
      expect(mine).toHaveLength(3)
      expect(of(a, 2)).toMatchObject({ rows: 1, anchored: 1 })
      expect(of(a, 1)).toMatchObject({ rows: 1, anchored: 1 })
      expect(of(b, 1)).toMatchObject({ rows: 1, anchored: 0 })
      for (const r of mine) expect(r.bytes).toBeGreaterThan(0)
    })

    it('is void across a reset: the emptied log answers null and the row is replaced at a lower version', async () => {
      const h = await fresh()
      if (h.empty === undefined) return // a shared log cannot be emptied
      await h.append()
      const e2 = await h.append()
      await h.snapshots.put(snap(h, e2))
      await h.empty()
      expect(await h.snapshots.latest(key(h))).toBeNull()
      const again = await h.append()
      expect(await h.snapshots.latest(key(h))).toBeNull()
      expect(await h.snapshots.put(snap(h, again))).toBe('written')
      expect((await h.snapshots.latest(key(h)))?.streamVersion).toBe(again.version)
    })
  })
}
