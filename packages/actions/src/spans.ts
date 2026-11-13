import { SpanStatusCode, context, createContextKey, trace } from '@opentelemetry/api'
import { Effect } from 'effect'

/**
 * The action spans of a pass (#791), made through `@opentelemetry/api`. A step's
 * span is an `Effect.withSpan` since #1053. The action span is started from an Effect
 * body by `inSpanEffect`. 0101 §6 wants `Effect.withSpan` here too, but that waits
 * for the action ports, keeping the span names.
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
  return inSpanEffectIn(captured, name, attributes, () => body, failed)
}

/**
 * `inSpanEffect` for a body that opens spans of its own (`tell.ts`'s `step end`,
 * whose actions are children of it): the body is handed the context *with this
 * span active and its own sink*, to pass as `captured` to the spans under it. A
 * child that ends in error reaches this span through that sink, as it does for
 * `inSpan`; nothing is made active around the body itself, so it is the caller
 * who carries `inner` to its children, never the fiber.
 */
export function inSpanEffectIn<A>(
  captured: ReturnType<typeof context.active>,
  name: string,
  attributes: Readonly<Record<string, number>>,
  body: (inner: ReturnType<typeof context.active>) => Effect.Effect<A>,
  failed: (value: A) => boolean = () => false,
): Effect.Effect<A> {
  return Effect.suspend(() => {
    const parent = captured.getValue(SINK) as Sink | undefined
    const mine = newSink()
    const span = trace.getTracer(SCOPE).startSpan(name, { attributes }, captured)
    return Effect.onExit(body(withSink(trace.setSpan(captured, span), mine)), (exit) =>
      Effect.sync(() => {
        if (exit._tag === 'Failure' || failed(exit.value) || mine.errored) {
          span.setStatus({ code: SpanStatusCode.ERROR })
          if (parent !== undefined) parent.errored = true
        }
        span.end()
      }),
    )
  })
}
