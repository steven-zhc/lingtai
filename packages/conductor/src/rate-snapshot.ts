/**
 * The fetched half of the rate card (#658): prices LiteLLM lists for a model the
 * shipped card does not, kept as a dated local snapshot under `~/.lingtai/`.
 *
 * **One writer per machine, by construction.** Only a process holding the
 * conductor lock calls `refreshRates` (`lingtai start`, `lingtai run`), and
 * inside it one fetch runs at a time, so there is no file lock, no per-fetch
 * file and no ordering between fetches. A write is a temporary file renamed over
 * the old one, so a reader sees the old file or the new one, never half.
 *
 * Pricing only ever reads the snapshot (`readRateSnapshot`) and never the
 * network. Under a test with no `LINGTAI_HOME` of its own the snapshot reads
 * empty, so no test prices from the developer's real one.
 */
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LITELLM_URL, mergeSnapshot, ratesFromLiteLLM, shipped, type RateRow } from '@lingtai/domain/rate-card'
import { rateDir, readJson, readRateSnapshot, snapshotPath } from '@lingtai/projector'

/** What the last attempt said, for `doctor` — separate from the snapshot so a failure leaves that byte-for-byte alone. */
export interface FetchNote {
  /** When the attempt ended, ISO. */
  at: string
  ok: boolean
  error?: string
  /** Models whose entry was out of range or unusable. */
  rejected: string[]
  /** Models this refresh gave a first price (#680). Absent when none. */
  priced?: string[]
  /** What rebuilding the projections that store estimates said; present only with `priced`. */
  rebuilt?: string
}

const notePath = (from: NodeJS.ProcessEnv) => {
  const dir = rateDir(from)
  return dir === null ? null : join(dir, 'rates-fetch.json')
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

export { readRateSnapshot }

/** The last attempt's note, or null where nothing has ever been fetched. */
export function readFetchNote(from: NodeJS.ProcessEnv = process.env): FetchNote | null {
  const doc = readJson(notePath(from)) as Partial<FetchNote> | undefined
  if (doc === undefined || typeof doc.at !== 'string' || typeof doc.ok !== 'boolean') return null
  return {
    at: doc.at,
    ok: doc.ok,
    ...(doc.error === undefined ? {} : { error: doc.error }),
    rejected: doc.rejected ?? [],
    ...(doc.priced === undefined ? {} : { priced: doc.priced }),
    ...(doc.rebuilt === undefined ? {} : { rebuilt: doc.rebuilt }),
  }
}

/**
 * Models with no row of any mode in `before` and a priced one in `after`: the
 * one way a stored estimate goes stale (0110 §5). A model repriced after a
 * withdrawal is not new, and a change of price for a known model is not either.
 */
export function newlyPriced(before: readonly RateRow[], after: readonly RateRow[]): string[] {
  const known = new Set(before.map((r) => r.model))
  return [...new Set(after.filter((r) => !known.has(r.model) && r.withdrawn !== true).map((r) => r.model))]
}

export interface RatePorts {
  /** The models some run priced without a figure, with the runtime that ran them. */
  wanted: () => Promise<{ model: string; runtime: string }[]>
  /** LiteLLM's table, parsed. Throws on a failed fetch or invalid JSON. */
  table: () => Promise<unknown>
  read: () => RateRow[]
  write: (rows: RateRow[]) => void
  note: (note: FetchNote) => void
  now: () => Date
  /**
   * Re-folds the projections that store estimates, after the snapshot is
   * written (#680). Resolves to a short outcome for the note; may throw.
   */
  rebuild?: (priced: string[]) => Promise<string>
}

export const realRatePorts = (
  wanted: RatePorts['wanted'],
  from: NodeJS.ProcessEnv = process.env,
  rebuild?: RatePorts['rebuild'],
): RatePorts => ({
  wanted,
  ...(rebuild === undefined ? {} : { rebuild }),
  table: async () => {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  },
  read: () => readRateSnapshot(from),
  write: (rows) => {
    const path = snapshotPath(from)
    if (path !== null) writeAtomic(path, { rows })
  },
  note: (note) => {
    const path = notePath(from)
    if (path !== null) writeAtomic(path, note)
  },
  now: () => new Date(),
})

let inflight: Promise<void> | null = null

/**
 * Fetch prices for the wanted models the shipped card cannot price and merge
 * them into the snapshot. Never throws. A second caller while one is running
 * gets the same promise, so two passes make one fetch and one write.
 */
export function refreshRates(ports: RatePorts): Promise<void> {
  inflight ??= run(ports).finally(() => {
    inflight = null
  })
  return inflight
}

/** Resolves when no refresh is running — what a conductor awaits before it releases its lock. */
export const ratesSettled = (): Promise<void> => inflight ?? Promise.resolve()

/** Whether the last attempt (successful or not) is before today's UTC day. */
export function ratesDue(now: Date, note: FetchNote | null = readFetchNote()): boolean {
  return note === null || note.at.slice(0, 10) < now.toISOString().slice(0, 10)
}

async function run(ports: RatePorts): Promise<void> {
  // Reporting can fail on the same disk the write did; a refresh never rejects.
  const fail = (error: unknown) => {
    try {
      ports.note({ at: ports.now().toISOString(), ok: false, error: (error as Error).message, rejected: [] })
    } catch {
      // nothing left to tell anyone
    }
  }
  try {
    const wanted = (await ports.wanted()).filter((w) => !shipped(w.model))
    if (wanted.length === 0) return
    const table = await ports.table()
    const day = ports.now().toISOString().slice(0, 10)
    const { rows, rejected } = ratesFromLiteLLM(table, wanted, day)
    const before = ports.read()
    const merged = mergeSnapshot(before, rows)
    if (merged !== null) ports.write(merged)
    // After the write: replay reads the snapshot file at fold time.
    const priced = merged === null ? [] : newlyPriced(before, merged)
    let rebuilt: string | undefined
    if (priced.length > 0 && ports.rebuild !== undefined) {
      try {
        rebuilt = await ports.rebuild(priced)
      } catch (err) {
        // The write stood, so this is not `ok: false`.
        rebuilt = `rebuild failed: ${(err as Error).message}`
      }
    }
    ports.note({
      at: ports.now().toISOString(),
      ok: true,
      rejected,
      ...(priced.length === 0 ? {} : { priced }),
      ...(rebuilt === undefined ? {} : { rebuilt }),
    })
  } catch (err) {
    fail(err)
  }
}
