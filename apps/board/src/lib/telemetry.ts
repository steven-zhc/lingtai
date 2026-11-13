import { machineOtlpEndpoint, type MachineFile } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { installTraceSeams } from './trace-seams.ts'

/**
 * Exports the board's own timed reads as OpenTelemetry spans (#775), and only
 * when `telemetry.otlp_endpoint` is set. **Server only.**
 *
 * Next's own spans reach the same global provider once `@opentelemetry/api` is
 * installed, and its fetch spans carry the full GitHub URL: `OnlyScope` is what
 * keeps them on the machine. It is also the exported `service.name`. The one
 * exception is Next's request span for a trace that held a `page` span (#883),
 * which leaves as a stripped copy: `requestCopy`.
 */
export const SCOPE = 'lingtai-board'

/** The SDK, loaded by these specifiers alone — production and the tests share them. */
export const loadSdk = async () => ({
  base: await import('@opentelemetry/sdk-trace-base'),
  http: await import('@opentelemetry/exporter-trace-otlp-http'),
  hooks: await import('@opentelemetry/context-async-hooks'),
  resources: await import('@opentelemetry/resources'),
})

const NEXT_SCOPE = 'next.js'
const REQUEST_SPAN = 'BaseServer.handleRequest'
/** The only attributes of Next's request span that leave the machine. */
const REQUEST_ATTRIBUTES = ['next.route', 'http.method', 'http.status_code', 'next.rsc'] as const

type Context = ReturnType<ReadableSpan['spanContext']>

// Ids and flags only: a `traceState` may come from a caller's header.
const bare = ({ traceId, spanId, traceFlags }: Context): Context => ({ traceId, spanId, traceFlags })

/**
 * A copy of Next's request span that names no URL, id or error: the allowlisted
 * attributes, no events or links, and a status with its code and no message.
 * The original is never touched.
 */
function requestCopy(span: ReadableSpan): ReadableSpan {
  const attributes: ReadableSpan['attributes'] = {}
  for (const key of REQUEST_ATTRIBUTES) {
    const value = span.attributes[key]
    if (value !== undefined && value !== null) attributes[key] = value
  }
  const context = bare(span.spanContext())
  const parent = span.parentSpanContext
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => context,
    ...(parent === undefined ? {} : { parentSpanContext: bare(parent) }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: [],
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}

/**
 * The `page` span with its parent replaced by the request span (#883). Next
 * activates spans of its own (`AppRender.getBodyResult`, …) between the request
 * span and `measure`, and those are dropped, so the active span is not the one
 * that leaves. With no request span to name, the parent is dropped and the page
 * is a root, since its own parent is a span that never leaves. The original is
 * never touched.
 */
function reparented(span: ReadableSpan, parent: Context | undefined): ReadableSpan {
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(parent === undefined ? {} : { parentSpanContext: bare(parent) }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: span.attributes,
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  }
}

const isRequest = (span: ReadableSpan): boolean =>
  span.instrumentationScope.name === NEXT_SCOPE && span.attributes['next.span_type'] === REQUEST_SPAN

/**
 * Forwards a span to `inner` only when it came from `scope`, plus a stripped
 * copy of Next's request span for a trace that held a `page` span (#883).
 */
export class OnlyScope implements SpanProcessor {
  readonly scope: string
  readonly inner: SpanProcessor
  readonly #limit: number
  /**
   * Trace ids that held a `page` span, oldest first, with the request span's
   * context the page started under; bounded, and dropped once the request span ends.
   */
  readonly #pages = new Map<string, Context | undefined>()
  /** Request span contexts by trace id, from start to end; bounded the same way. */
  readonly #requests = new Map<string, Context>()
  constructor(scope: string, inner: SpanProcessor, limit = 1000) {
    this.scope = scope
    this.inner = inner
    this.#limit = limit
  }
  get remembered(): number {
    return this.#pages.size
  }
  onStart(span: Span): void {
    const context = span.spanContext()
    if (isRequest(span)) {
      this.#requests.set(context.traceId, context)
      if (this.#requests.size > this.#limit) this.#requests.delete(this.#requests.keys().next().value!)
    } else if (span.instrumentationScope.name === this.scope && span.name.startsWith('page ')) {
      // Taken now: by the time the page ends, 1,000 other requests may have evicted this one.
      this.#remember(context.traceId, this.#requests.get(context.traceId))
    }
  }
  onEnding(): void {}
  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId
    if (span.instrumentationScope.name === this.scope) {
      if (!span.name.startsWith('page ')) return this.inner.onEnd(span)
      const request = this.#pages.get(traceId) // absent if evicted, and not re-added: it would evict a live one
      const parent = span.parentSpanContext?.spanId
      if (request !== undefined) this.inner.onEnd(parent !== request.spanId ? reparented(span, request) : span)
      // No request span to name: its parent is a span that never leaves, so it is a root.
      else this.inner.onEnd(parent === undefined ? span : reparented(span, undefined))
    } else if (isRequest(span)) {
      this.#requests.delete(traceId)
      // Forwarded only when the page that left was re-parented onto it.
      const request = this.#pages.get(traceId)
      this.#pages.delete(traceId)
      if (request?.spanId === span.spanContext().spanId) this.inner.onEnd(requestCopy(span))
    }
  }
  #remember(traceId: string, request: Context | undefined): void {
    if (this.#pages.has(traceId)) {
      if (request !== undefined && this.#pages.get(traceId) === undefined) this.#pages.set(traceId, request)
      return
    }
    this.#pages.set(traceId, request)
    if (this.#pages.size > this.#limit) this.#pages.delete(this.#pages.keys().next().value!)
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

export type Installed = { readonly forceFlush: () => Promise<void> }

/**
 * Reads the endpoint once; with none (or a refused one) installs nothing and
 * prints nothing. The exporter is injectable so a test opens no socket.
 */
export async function installTracing(
  from: NodeJS.ProcessEnv,
  file?: MachineFile,
  exporter?: SpanExporter,
): Promise<Installed | undefined> {
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
    spanProcessors: [
      new OnlyScope(SCOPE, new sdk.base.BatchSpanProcessor(exporter ?? new sdk.http.OTLPTraceExporter({ url }))),
    ],
  })
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(new sdk.hooks.AsyncLocalStorageContextManager().enable())
  installTraceSeams()
  return provider
}

export type { Span }
