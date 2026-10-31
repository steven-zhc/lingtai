import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

/**
 * Names and times every read a page makes (#774). **Server only**: this
 * imports `node:async_hooks`, so it must never reach a `"use client"` graph —
 * the Next build is the only thing that sees that (#230), not `tsc`.
 *
 * There is no `Server-Timing` response header: a Server Component cannot set
 * one, so the list travels in a `<meta>` tag the page renders itself.
 */

export type Timing = {
  readonly name: string
  readonly start: number
  readonly dur: number
  /** `failed`, or a count. Never a message: an error's text carries URLs and tokens. */
  readonly desc?: string
}

type Entry = Timing & { readonly seq: number }

type Scope = { readonly now: () => number; readonly entries: Entry[]; calls: number }

const scope = new AsyncLocalStorage<Scope>()

export type MeasureOptions = {
  readonly now?: () => number
  readonly slowMs?: number
  readonly say?: (line: string) => void
  /** The page, by a fixed label — `/` or `/task`, never an id. */
  readonly label?: string
}

const stderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

const ordered = (entries: readonly Entry[]): Timing[] =>
  entries
    .toSorted((a, b) => a.start - b.start || a.seq - b.seq)
    .map(({ name, start, dur, desc }) => (desc === undefined ? { name, start, dur } : { name, start, dur, desc }))

/** Runs `fn` in a scope that collects every `timed` read it makes, in start order. */
export async function measure<T>(fn: () => Promise<T>, options: MeasureOptions = {}): Promise<[T, readonly Timing[]]> {
  const now = options.now ?? (() => performance.now())
  const slowMs = options.slowMs ?? 1000
  const say = options.say ?? stderrLine
  const label = options.label ?? '/'
  const entries: Entry[] = []
  const began = now()
  try {
    const value = await scope.run({ now, entries, calls: 0 }, fn)
    return [value, ordered(entries)]
  } finally {
    const total = Math.round(now() - began)
    if (total > slowMs) {
      const slowest = ordered(entries)
        .toSorted((a, b) => b.dur - a.dur)
        .slice(0, 3)
        .map((t) => `${t.name} ${t.dur}ms`)
      say(`board: ${label} took ${total}ms${slowest.length === 0 ? '' : ` — ${slowest.join(', ')}`}`)
    }
  }
}

export type TimedOptions<T> = {
  /** A count to show beside the name. */
  readonly desc?: string
  /** For a read whose failure is a value, not a throw. */
  readonly failed?: (value: T) => boolean
}

/** Runs `fn`; inside a `measure`, records its name and duration. Outside one it is `fn()`. */
export async function timed<T>(name: string, fn: () => Promise<T>, options: TimedOptions<T> = {}): Promise<T> {
  const current = scope.getStore()
  if (current === undefined) return fn()
  const start = current.now()
  const seq = current.calls++
  const record = (desc: string | undefined) => {
    const dur = Math.round(current.now() - start)
    current.entries.push(desc === undefined ? { name, start, dur, seq } : { name, start, dur, desc, seq })
  }
  try {
    const value = await fn()
    record(options.failed?.(value) ? 'failed' : options.desc)
    return value
  } catch (err) {
    // The error is rethrown untouched and never read: its message may carry a
    // URL or a token.
    record('failed')
    throw err
  }
}

/** The list in Server-Timing syntax: `events.task;dur=8, github.issue;dur=723`. */
export function serverTiming(timings: readonly Timing[]): string {
  return timings
    .map((t) => (t.desc === undefined ? `${t.name};dur=${t.dur}` : `${t.name};dur=${t.dur};desc="${t.desc}"`))
    .join(', ')
}
