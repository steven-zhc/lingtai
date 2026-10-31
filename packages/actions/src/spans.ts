import { SpanStatusCode, context, trace } from '@opentelemetry/api'

/**
 * The step and action spans of a pass (#791), made through `@opentelemetry/api`
 * because `runPass` and `runActionPipeline` are still promises. 0101 §6 wants
 * `Effect.withSpan` here, and #790's later children replace this file's callers
 * as they move those functions, keeping the span names.
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

/**
 * Runs `body` as a span that is the active one inside it, so a span started in
 * it is its child. `failed` says whether a value the body *returned* is a
 * refusal; a throw is always one. The status carries no message.
 */
export async function inSpan<T>(
  name: string,
  attributes: Readonly<Record<string, number>>,
  body: () => Promise<T>,
  failed: (value: T) => boolean = () => false,
): Promise<T> {
  const span = trace.getTracer(SCOPE).startSpan(name, { attributes })
  try {
    const value = await context.with(trace.setSpan(context.active(), span), body)
    if (failed(value)) span.setStatus({ code: SpanStatusCode.ERROR })
    return value
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw err
  } finally {
    span.end()
  }
}
