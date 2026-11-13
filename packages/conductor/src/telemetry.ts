import { FAILED, SCOPE, newSink, withSink } from '@lingtai/actions/spans'
import { machineOtlpEndpoint, type MachineFile } from '@lingtai/env'
import { ROOT_CONTEXT, SpanStatusCode, context, trace, type Span as OtelSpan } from '@opentelemetry/api'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import { Context, Effect, Exit, Layer, Option, Tracer } from 'effect'

import { runPort } from './port-face.ts'

/**
 * A pass as one OTLP trace (#791), when `telemetry.otlp_endpoint` is set.
 *
 * **Why Effect's tracer is bridged here rather than taken from
 * `@effect/opentelemetry`**: that package's current line needs an `effect` newer
 * than this repository's and brings five peer SDK packages with it, and the one
 * thing it would add is this file's `bridgedTracer`. Bridging by hand also keeps
 * what an Effect span may carry in one place: no stack trace, no event, no
 * message on a failure, and only the three attributes below.
 *
 * The step and action spans are `@opentelemetry/api` spans (`packages/actions/
 * src/spans.ts`), so both kinds must go to **one** provider, registered globally.
 * Effect spans are parented from the Effect side, and an api span started inside
 * a promise an Effect fiber is running finds its parent through `context`,
 * below: the fiber makes its current span the active OpenTelemetry one for as
 * long as it runs an operation, which is how a promise an Effect runs reaches the
 * run span, and how a step's `Effect.withSpan` is the parent of the action spans
 * its pipeline starts. A bridged span's failure reaches its bridged parent (a step
 * marks the run), while a bare typed failure of an inner span marks only itself.
 */
export const ATTRIBUTES: ReadonlySet<string> = new Set(['lingtai.ticket', 'lingtai.round', 'lingtai.index'])

/** What `Tracer.span` is handed for each span it starts. */
type SpanStart = Parameters<Tracer.Tracer['span']>[0]

/** The key a fiber evaluates a primitive by (`Tracer.EffectPrimitive`). */
const EVALUATE = '~effect/Effect/evaluate'

const hrtime = (nanos: bigint): [number, number] => [Number(nanos / 1_000_000_000n), Number(nanos % 1_000_000_000n)]

class BridgedSpan implements Tracer.Span {
  readonly _tag = 'Span'
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean
  readonly attributes = new Map<string, unknown>()
  readonly links: Tracer.SpanLink[] = []
  readonly otel: OtelSpan
  /** What the spans started under this one report their failures to; this span ends `ERROR` if one did. */
  readonly sink = newSink()
  /** Annotated `FAILED`: this span says it failed, and so does every bridged span above it. */
  failed = false
  status: Tracer.SpanStatus
  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: Context.Context<never>
  readonly kind: Tracer.SpanKind

  constructor(options: SpanStart) {
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.kind = options.kind
    this.status = { _tag: 'Started', startTime: options.startTime }
    let parentContext = ROOT_CONTEXT
    if (Option.isSome(options.parent)) {
      const p = options.parent.value
      parentContext = trace.setSpan(
        ROOT_CONTEXT,
        p instanceof BridgedSpan
          ? p.otel
          : trace.wrapSpanContext({ traceId: p.traceId, spanId: p.spanId, traceFlags: p.sampled ? 1 : 0 }),
      )
    }
    this.otel = trace.getTracer(SCOPE).startSpan(options.name, { startTime: hrtime(options.startTime) }, parentContext)
    const { traceId, spanId, traceFlags } = this.otel.spanContext()
    this.traceId = traceId
    this.spanId = spanId
    this.sampled = (traceFlags & 1) === 1
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = { _tag: 'Ended', startTime: this.status.startTime, endTime, exit }
    // Never the cause: it carries free text — `unappended`'s message, a thrown
    // error's — and a status message is exported.
    if (Exit.isFailure(exit) || this.sink.errored || this.failed) this.otel.setStatus({ code: SpanStatusCode.ERROR })
    // Status flows up (spans.ts): a child that failed by its own sink or by `FAILED` marks its
    // parent. A bare Exit failure does not — typed failures of inner spans stay local.
    if (this.sink.errored || this.failed) {
      const parent = Option.getOrUndefined(this.parent)
      if (parent instanceof BridgedSpan) parent.sink.errored = true
    }
    this.otel.end(hrtime(endTime))
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
    // Not an attribute: a caught defect is a returned result, an Effect
    // *success*, and the span would otherwise export as unset (#791).
    if (key === FAILED) {
      if (value === true) {
        this.failed = true
        this.otel.setStatus({ code: SpanStatusCode.ERROR })
      }
      return
    }
    if (ATTRIBUTES.has(key) && (typeof value === 'number' || typeof value === 'string')) {
      this.otel.setAttribute(key, value)
    }
  }

  // Events carry a name and attributes nobody reviewed; none is exported.
  event(): void {}
  addLinks(): void {}
}

export const bridgedTracer: Tracer.Tracer = Tracer.make({
  span: (options) => new BridgedSpan(options),
  // Called for every primitive the fiber evaluates: it runs each one with the
  // fiber's span as the active OpenTelemetry span, which is what an api span
  // started in a promise underneath finds as its parent.
  context: (primitive, fiber) => {
    const span = fiber.cache.span
    if (!(span instanceof BridgedSpan)) return primitive[EVALUATE](fiber)
    return context.with(withSink(trace.setSpan(context.active(), span.otel), span.sink), () =>
      primitive[EVALUATE](fiber),
    )
  },
})

/** Provide this beside `PortsLive`. */
export const tracingLayer: Layer.Layer<never> = Layer.succeed(Tracer.Tracer, bridgedTracer)

export type Tracing = {
  readonly layer: Layer.Layer<never>
  /** Bounded, and a timeout is dropped: a pass never waits on export. */
  readonly flush: (ms?: number) => Promise<void>
  /** Ends the processor's timers and the exporter's in-flight request; bounded, a refusal dropped. Once, at exit. */
  readonly shutdown: (ms?: number) => Promise<void>
}

/**
 * The SDK, loaded by these specifiers alone — production and the tests share
 * them. Dynamic on purpose: nothing loads unless an endpoint is set, and the
 * SDK's own advice is not to import `http.Agent` or `https.Agent` statically.
 */
export const loadSdkEffect = Effect.tryPromise(() =>
  Promise.all([
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/context-async-hooks'),
    import('@opentelemetry/resources'),
    import('node:http'),
    import('node:https'),
  ]),
)

const EXPORT_MS = 3000

/**
 * Bounded, and a timeout or a refusal is dropped. When the budget runs out,
 * `cancel` runs: it destroys what is still in flight, and not only stops
 * waiting for it — `timeoutMillis` is the socket's inactivity, so a collector
 * that trickles bytes would otherwise hold the process past the budget.
 */
const boundedEffect = (flushing: () => Promise<void>, ms: number, cancel: () => void = () => {}) =>
  Effect.tryPromise(() => flushing()).pipe(
    // The SDK has its own budget, and at an equal deadline its rejection can
    // arrive before ours: a flush that did not finish cleanly cancels too.
    Effect.as(true),
    Effect.orElseSucceed(() => false),
    Effect.timeoutOption(ms),
    Effect.flatMap((done) => (Option.isSome(done) && done.value ? Effect.void : Effect.sync(cancel))),
  )

/**
 * Reads the endpoint once; with none (or a refused one) installs nothing, loads
 * nothing and prints nothing. A tracer that fails to install installs nothing
 * and fails nothing: a trace is never worth a pass. Once per process, at the
 * command's entry: the provider lives as long as the process and the layer only
 * points at it. The exporter is injectable so a test opens no socket.
 */
export const installTracingEffect = (
  from: NodeJS.ProcessEnv,
  file?: MachineFile,
  exporter?: SpanExporter,
): Effect.Effect<Tracing | undefined> =>
  Effect.gen(function* () {
    const url = yield* Effect.try(() => machineOtlpEndpoint(from, file)).pipe(Effect.orElseSucceed(() => undefined))
    if (url === undefined) return undefined
    const loaded = yield* Effect.option(loadSdkEffect)
    if (Option.isNone(loaded)) return undefined
    const [base, http, hooks, resources, nodeHttp, nodeHttps] = loaded.value
    // Every agent the exporter makes, so a flush that ran out of time can destroy
    // their sockets — destroying a socket errors the request it carries and ends
    // its timers, which `forceFlush`/`shutdown` do not.
    const agents: Array<{ destroy(): void }> = []
    const cancel = () => {
      for (const agent of agents) agent.destroy()
    }
    return yield* Effect.sync((): Tracing => {
      const provider = new base.BasicTracerProvider({
        // Given a resource, the provider does not fall back to the default one,
        // whose service.name is `unknown_service:<argv0>` — a path off this machine.
        resource: resources.resourceFromAttributes({ 'service.name': SCOPE }),
        // Both bounded to the flush's own budget, so a slow collector leaves no
        // request or export timer holding the process past it.
        spanProcessors: [
          new base.BatchSpanProcessor(
            exporter ??
              new http.OTLPTraceExporter({
                url,
                timeoutMillis: EXPORT_MS,
                httpAgentOptions: (protocol: string) => {
                  const agent = new (protocol === 'http:' ? nodeHttp : nodeHttps).Agent({ keepAlive: true })
                  agents.push(agent)
                  return agent
                },
              }),
            { exportTimeoutMillis: EXPORT_MS },
          ),
        ],
      })
      trace.setGlobalTracerProvider(provider)
      context.setGlobalContextManager(new hooks.AsyncLocalStorageContextManager().enable())
      return {
        layer: tracingLayer,
        flush: (ms = EXPORT_MS) => runPort(boundedEffect(() => provider.forceFlush(), ms, cancel)),
        shutdown: (ms = EXPORT_MS) => runPort(boundedEffect(() => provider.shutdown(), ms, cancel)),
      }
    })
  })

/** The promise face of `installTracingEffect`, for `apps/cli/src/tracing.ts` and the tests, until #790. */
export function installTracing(
  from: NodeJS.ProcessEnv,
  file?: MachineFile,
  exporter?: SpanExporter,
): Promise<Tracing | undefined> {
  return Effect.runPromise(installTracingEffect(from, file, exporter))
}
