import { SCOPE } from '@lingtai/actions/spans'
import { machineOtlpEndpoint, type MachineFile } from '@lingtai/env'
import { ROOT_CONTEXT, SpanStatusCode, context, trace, type Span as OtelSpan } from '@opentelemetry/api'
import type { SpanExporter } from '@opentelemetry/sdk-trace-base'
import { Context, Exit, Layer, Option, Tracer } from 'effect'

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
 * long as it runs an operation, which is how `Effect.promise(() => runPass(…))`
 * reaches `runPass` with the run span already active.
 */
export const ATTRIBUTES: ReadonlySet<string> = new Set(['lingtai.ticket', 'lingtai.round', 'lingtai.index'])

const hrtime = (nanos: bigint): [number, number] => [Number(nanos / 1_000_000_000n), Number(nanos % 1_000_000_000n)]

class BridgedSpan implements Tracer.Span {
  readonly _tag = 'Span'
  readonly spanId: string
  readonly traceId: string
  readonly sampled: boolean
  readonly attributes = new Map<string, unknown>()
  readonly links: Tracer.SpanLink[] = []
  readonly otel: OtelSpan
  status: Tracer.SpanStatus
  readonly name: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly context: Context.Context<never>
  readonly kind: Tracer.SpanKind

  constructor(
    name: string,
    parent: Option.Option<Tracer.AnySpan>,
    ctx: Context.Context<never>,
    startTime: bigint,
    kind: Tracer.SpanKind,
  ) {
    this.name = name
    this.parent = parent
    this.context = ctx
    this.kind = kind
    this.status = { _tag: 'Started', startTime }
    let parentContext = ROOT_CONTEXT
    if (Option.isSome(parent)) {
      const p = parent.value
      parentContext = trace.setSpan(
        ROOT_CONTEXT,
        p instanceof BridgedSpan
          ? p.otel
          : trace.wrapSpanContext({ traceId: p.traceId, spanId: p.spanId, traceFlags: p.sampled ? 1 : 0 }),
      )
    }
    this.otel = trace.getTracer(SCOPE).startSpan(name, { startTime: hrtime(startTime) }, parentContext)
    const { traceId, spanId, traceFlags } = this.otel.spanContext()
    this.traceId = traceId
    this.spanId = spanId
    this.sampled = (traceFlags & 1) === 1
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = { _tag: 'Ended', startTime: this.status.startTime, endTime, exit }
    // Never the cause: it carries free text — `unappended`'s message, a thrown
    // error's — and a status message is exported.
    if (Exit.isFailure(exit)) this.otel.setStatus({ code: SpanStatusCode.ERROR })
    this.otel.end(hrtime(endTime))
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
    if (ATTRIBUTES.has(key) && (typeof value === 'number' || typeof value === 'string')) {
      this.otel.setAttribute(key, value)
    }
  }

  // Events carry a name and attributes nobody reviewed; none is exported.
  event(): void {}
  addLinks(): void {}
}

export const bridgedTracer: Tracer.Tracer = Tracer.make({
  span: (name, parent, ctx, _links, startTime, kind) => new BridgedSpan(name, parent, ctx, startTime, kind),
  context: (f, fiber) => {
    const span = fiber.currentSpan
    if (!(span instanceof BridgedSpan)) return f()
    return context.with(trace.setSpan(context.active(), span.otel), f)
  },
})

/** Provide this beside `PortsLive`. */
export const tracingLayer: Layer.Layer<never> = Layer.setTracer(bridgedTracer)

export type Tracing = {
  readonly layer: Layer.Layer<never>
  /** Bounded, and a timeout is dropped: a pass never waits on export. */
  readonly flush: (ms?: number) => Promise<void>
}

/** The SDK, loaded by these specifiers alone — production and the tests share them. */
export const loadSdk = async () => ({
  base: await import('@opentelemetry/sdk-trace-base'),
  http: await import('@opentelemetry/exporter-trace-otlp-http'),
  hooks: await import('@opentelemetry/context-async-hooks'),
  resources: await import('@opentelemetry/resources'),
})

/**
 * Reads the endpoint once; with none (or a refused one) installs nothing, loads
 * nothing and prints nothing. Once per process, at the command's entry: the
 * provider lives as long as the process and the layer only points at it. The
 * exporter is injectable so a test opens no socket.
 */
export async function installTracing(
  from: NodeJS.ProcessEnv,
  file?: MachineFile,
  exporter?: SpanExporter,
): Promise<Tracing | undefined> {
  let url: string | undefined
  try {
    url = machineOtlpEndpoint(from, file)
  } catch {
    return undefined
  }
  if (url === undefined) return undefined
  const sdk = await loadSdk()
  const provider = new sdk.base.BasicTracerProvider({
    // Given a resource, the provider does not fall back to the default one,
    // whose service.name is `unknown_service:<argv0>` — a path off this machine.
    resource: sdk.resources.resourceFromAttributes({ 'service.name': SCOPE }),
    spanProcessors: [new sdk.base.BatchSpanProcessor(exporter ?? new sdk.http.OTLPTraceExporter({ url }))],
  })
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(new sdk.hooks.AsyncLocalStorageContextManager().enable())
  return {
    layer: tracingLayer,
    flush: async (ms = 3000) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          provider.forceFlush(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms)
          }),
        ])
      } catch {
        // dropped
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
