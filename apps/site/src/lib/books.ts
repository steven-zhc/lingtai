import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { repoRoot } from './docs.ts'

/**
 * Lingtai's own books, as a committed file (#811).
 *
 * `scripts/books.ts` is run by the operator at each release, reads the log, and
 * writes `apps/site/books.json`; the site's build reads that file. CI cannot
 * read the log (`deploy-site.yml`), so a deploy shows the same real books until
 * the next release replaces them.
 *
 * **No total of any kind is in this file**, and `parseBooks` refuses a key it
 * does not know, so a total slipped in later fails to read rather than
 * rendering. A figure that could not be computed is `null`, never `0`.
 *
 * This module is the type and the reader only. The shaping needs the
 * conductor's `report()`, which must never reach the Next graph, so it lives
 * in `scripts/take-books.ts`.
 */

export const BOOKS_FILE = path.join(repoRoot, 'apps', 'site', 'books.json')

export interface Spread {
  median: number | null
  mean: number | null
}

export interface Receipt {
  /** The median ticket is not a real ticket: no number, no title. */
  median: false
  number: number
  title: string
  kind: string | null
  outcome: 'open' | 'landed' | 'closed'
  fixRounds: number
  passes: number
  waits: number
  machineMinutes: number
  /** Dollars, reported plus estimated; null when nothing could price its runs. */
  cost: number | null
}

export interface MedianReceipt {
  median: true
  fixRounds: number
  machineMinutes: number
  waits: number
  /** Null when no landed ticket could be priced. */
  cost: number | null
}

export interface Books {
  version: 1
  /** `YYYY-MM-DD`, local days, `to` included. */
  window: { from: string; to: string }
  capturedAt: string
  commit: string | null
  outcomes: {
    landed: number
    closed: number
    open: number
    landedByKind: { kind: string | null; count: number }[]
  }
  fixRounds: { median: number | null; zeroOrOneShare: number | null; fiveOrMoreShare: number | null }
  /** Dollars per landed ticket. */
  cost: {
    median: number | null
    mean: number | null
    p90: number | null
    includesEstimates: boolean
    /** Runs nothing could price: left out of the figures, counted here. */
    costUnknown: number
  }
  machineMinutes: Spread
  elapsedMinutes: { median: number | null; mean: number | null; withinHourShare: number | null }
  waitedShare: number | null
  /** Each purpose's share of landed tickets' spend, adding to 1; null when nothing was spent. */
  spendShare: { purpose: string; share: number }[] | null
  receipts: (MedianReceipt | Receipt)[]
}

const KEYS = [
  'version',
  'window',
  'capturedAt',
  'commit',
  'outcomes',
  'fixRounds',
  'cost',
  'machineMinutes',
  'elapsedMinutes',
  'waitedShare',
  'spendShare',
  'receipts',
]

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): boolean => v === null || num(v)

/** Whether `v` is exactly the object whose fields pass `checks`: no field missing, none extra. */
function shaped(v: unknown, checks: Record<string, (x: unknown) => boolean>): v is Rec {
  if (!isRec(v)) return false
  const keys = Object.keys(v)
  return keys.length === Object.keys(checks).length && Object.entries(checks).every(([k, ok]) => ok(v[k]))
}

const OUTCOMES = ['open', 'landed', 'closed']

function receiptOk(v: unknown): boolean {
  if (isRec(v) && v.median === true) {
    return shaped(v, { median: (x) => x === true, fixRounds: num, machineMinutes: num, waits: num, cost: numOrNull })
  }
  return shaped(v, {
    median: (x) => x === false,
    number: num,
    title: str,
    kind: (x) => x === null || str(x),
    outcome: (x) => str(x) && OUTCOMES.includes(x),
    fixRounds: num,
    passes: num,
    waits: num,
    machineMinutes: num,
    cost: numOrNull,
  })
}

/** The file's value as `Books`, or null when it is not one: a wrong version, a missing field, an extra one. */
export function parseBooks(value: unknown): Books | null {
  if (!isRec(value) || value.version !== 1) return null
  const keys = Object.keys(value)
  if (keys.length !== KEYS.length || !KEYS.every((k) => k in value)) return null
  const ok =
    shaped(value.window, { from: str, to: str }) &&
    str(value.capturedAt) &&
    (value.commit === null || str(value.commit)) &&
    shaped(value.outcomes, {
      landed: num,
      closed: num,
      open: num,
      landedByKind: (x) =>
        Array.isArray(x) && x.every((k) => shaped(k, { kind: (y) => y === null || str(y), count: num })),
    }) &&
    shaped(value.fixRounds, { median: numOrNull, zeroOrOneShare: numOrNull, fiveOrMoreShare: numOrNull }) &&
    shaped(value.cost, {
      median: numOrNull,
      mean: numOrNull,
      p90: numOrNull,
      includesEstimates: (x) => typeof x === 'boolean',
      costUnknown: num,
    }) &&
    shaped(value.machineMinutes, { median: numOrNull, mean: numOrNull }) &&
    shaped(value.elapsedMinutes, { median: numOrNull, mean: numOrNull, withinHourShare: numOrNull }) &&
    numOrNull(value.waitedShare) &&
    (value.spendShare === null ||
      (Array.isArray(value.spendShare) && value.spendShare.every((s) => shaped(s, { purpose: str, share: num })))) &&
    Array.isArray(value.receipts) &&
    value.receipts.every(receiptOk)
  return ok ? (value as unknown as Books) : null
}

/** The committed books, or null when there is no file yet or it is not a books file. */
export async function readBooks(file: string = BOOKS_FILE): Promise<Books | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    return parseBooks(JSON.parse(raw))
  } catch {
    return null
  }
}
