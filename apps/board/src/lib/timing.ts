import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

import { SpanStatusCode, trace } from '@opentelemetry/api'

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

/**
 * Runs `fn` in a scope that collects every `timed` read it makes, in start
 * order, inside a span `page <label>` (#787) that those reads become the
 * children of. The span is the child of whatever span is active: under Next that
 * is the request span, which `OnlyScope` forwards as a stripped copy (#883);
 * with none active (a unit test) it is a root. The span carries no attribute
 * — the label is a route pattern, never an id.
 *
 * A page that loads outside `measure` has no page span, and its reads export
 * as orphans.
 */
export async function measure<T>(fn: () => Promise<T>, options: MeasureOptions = {}): Promise<[T, readonly Timing[]]> {
  const now = options.now ?? (() => performance.now())
  const slowMs = options.slowMs ?? 1000
  const say = options.say ?? stderrLine
  const label = options.label ?? '/'
  const entries: Entry[] = []
  const began = now()
  return trace.getTracer('lingtai-board').startActiveSpan(`page ${label}`, async (span) => {
    try {
      const value = await scope.run({ now, entries, calls: 0 }, fn)
      return [value, ordered(entries)] as [T, readonly Timing[]]
    } catch (err) {
      // Rethrown untouched and never read: its message may carry a URL or a token.
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw err
    } finally {
      span.end()
      const total = Math.round(now() - began)
      if (total > slowMs) {
        const slowest = ordered(entries)
          .toSorted((a, b) => b.dur - a.dur)
          .slice(0, 3)
          .map((t) => `${t.name} ${t.dur}ms`)
        say(`board: ${label} took ${total}ms${slowest.length === 0 ? '' : ` — ${slowest.join(', ')}`}`)
      }
    }
  })
}

export type TimedOptions<T> = {
  /** A count to show beside the name. */
  readonly desc?: string
  /** For a read whose failure is a value, not a throw. */
  readonly failed?: (value: T) => boolean
}

/**
 * Runs `fn`; inside a `measure`, records its name and duration. Outside one it
 * is `fn()`. Either way it is an OpenTelemetry span of the same name (#775),
 * which is a no-op until `instrumentation.ts` installs a provider.
 */
export async function timed<T>(name: string, fn: () => Promise<T>, options: TimedOptions<T> = {}): Promise<T> {
  return trace.getTracer('lingtai-board').startActiveSpan(name, async (span) => {
    try {
      const current = scope.getStore()
      if (current === undefined) {
        const value = await fn()
        if (options.failed?.(value)) span.setStatus({ code: SpanStatusCode.ERROR })
        return value
      }
      const start = current.now()
      const seq = current.calls++
      const record = (desc: string | undefined) => {
        const dur = Math.round(current.now() - start)
        current.entries.push(desc === undefined ? { name, start, dur, seq } : { name, start, dur, desc, seq })
      }
      try {
        const value = await fn()
        const failed = options.failed?.(value) ?? false
        record(failed ? 'failed' : options.desc)
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR })
        else if (options.desc !== undefined && /^\d+$/.test(options.desc)) {
          span.setAttribute('lingtai.count', Number(options.desc))
        }
        return value
      } catch (err) {
        // The error is rethrown untouched and never read: its message may carry
        // a URL or a token.
        record('failed')
        throw err
      }
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw err
    } finally {
      span.end()
    }
  })
}

/** The list in Server-Timing syntax: `events.task;dur=8, github.issue;dur=723`. */
export function serverTiming(timings: readonly Timing[]): string {
  return timings
    .map((t) => (t.desc === undefined ? `${t.name};dur=${t.dur}` : `${t.name};dur=${t.dur};desc="${t.desc}"`))
    .join(', ')
}
