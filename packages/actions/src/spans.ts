import { SpanStatusCode, context, createContextKey, trace } from '@opentelemetry/api'
import { Effect } from 'effect'

/**
 * The step and action spans of a pass (#791), made through `@opentelemetry/api`.
 * `inSpan` is for a promise body (`runAttempt`'s steps and the judge); the action
 * span is started from an Effect body by `inSpanEffect`. 0101 §6 wants
 * `Effect.withSpan` here, but a fiber a promise face starts has no bridged tracer
 * and would export nothing, so that waits for the conductor's pass loop (row 7),
 * keeping the span names.
 *
 * With no provider registered the api hands out non-recording spans, so this is
 * a no-op until a host that has `telemetry.otlp_endpoint` installs one.
 *
 * **Nothing else is an attribute than what the caller passes, and a caller
 * passes a number**: `lingtai.round`, `lingtai.index`. No span carries a message,
 * an event or a name taken from a recipe — a `run:` action's command can hold
 * anything a person wrote.
 */
export const SCOPE = 'lingtai-conductor'

/** Annotate the current Effect span with this as `true` to mark it `ERROR`, with no message and no attribute. */
export const FAILED = 'lingtai.failed'

/**
 * Where a failure below a span is recorded for the span above it (#791). Status
 * flows **up**: an action's span is `ERROR` by its own result, and every span
 * above it is `ERROR` because one below it was — no step and no run applies a
 * reading of its own. The sink rides the OpenTelemetry context, which is per
 * async chain, so two passes at once never share one (0122).
 */
export type Sink = { errored: boolean }
const SINK = createContextKey('lingtai.sink')

export const newSink = (): Sink => ({ errored: false })

/** The context a span's body runs in: `sink` is what its children report to. */
export const withSink = (ctx: ReturnType<typeof context.active>, sink: Sink) => ctx.setValue(SINK, sink)

const sinkOf = (): Sink | undefined => context.active().getValue(SINK) as Sink | undefined

/** Marks the span running here (and so every one above it) `ERROR`. */
export function markFailed(): void {
  const sink = sinkOf()
  if (sink !== undefined) sink.errored = true
}

/**
 * Runs `body` as a span that is the active one inside it, so a span started in
 * it is its child. `failed` is the span's own reading of a value the body
 * *returned* — given only by an action, whose result has one reading; a step
 * gives none and is `ERROR` by its children alone. A throw is always one. The
 * status carries no message.
 */
export function inSpan<T>(
  name: string,
  attributes: Readonly<Record<string, number>>,
  body: () => Promise<T>,
  failed: (value: T) => boolean = () => false,
): Promise<T> {
  const parent = sinkOf()
  const mine = newSink()
  const span = trace.getTracer(SCOPE).startSpan(name, { attributes })
  const finish = (error: boolean) => {
    if (error || mine.errored) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      if (parent !== undefined) parent.errored = true
    }
    span.end()
  }
  // Promise chains and not `async`: 0101 §6's ratchet (#792) counts the keyword,
  // and a function that is going to be an Effect is not a place to add one.
  let running: Promise<T>
  try {
    running = Promise.resolve(context.with(withSink(trace.setSpan(context.active(), span), mine), body))
  } catch (err) {
    running = Promise.reject(err)
  }
  return running.then(
    (value) => {
      finish(failed(value))
      return value
    },
    (err: unknown) => {
      finish(true)
      throw err
    },
  )
}

/**
 * `inSpan` for an Effect body (#1041): an api span started under `captured` —
 * the context active when the pipeline was built, **never read from inside the
 * fiber**, because the scheduler flushes from one `setImmediate` and the context
 * active there is not necessarily this pass's (0122). It reports to *that*
 * context's sink, and ends once, `ERROR` on a defect, an interruption or
 * `failed(value)` (a finalizer, so an interruption ends it too).
 *
 * The span is not made active around `body`: nothing under an action opens an
 * api span or calls `markFailed`.
 */
export function inSpanEffect<A>(
  captured: ReturnType<typeof context.active>,
  name: string,
  attributes: Readonly<Record<string, number>>,
  body: Effect.Effect<A>,
  failed: (value: A) => boolean = () => false,
): Effect.Effect<A> {
  return Effect.suspend(() => {
    const parent = captured.getValue(SINK) as Sink | undefined
    const span = trace.getTracer(SCOPE).startSpan(name, { attributes }, captured)
    return Effect.onExit(body, (exit) =>
      Effect.sync(() => {
        if (exit._tag === 'Failure' || failed(exit.value)) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          if (parent !== undefined) parent.errored = true
        }
        span.end()
      }),
    )
  })
}
