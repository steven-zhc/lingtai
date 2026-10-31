import { machineOtlpEndpoint, type MachineFile } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'

/**
 * Exports the board's own timed reads as OpenTelemetry spans (#775), and only
 * when `telemetry.otlp_endpoint` is set. **Server only.**
 *
 * Next's own spans reach the same global provider once `@opentelemetry/api` is
 * installed, and its fetch spans carry the full GitHub URL: `OnlyScope` is what
 * keeps them on the machine.
 */
export const SCOPE = 'lingtai-board'

/** The SDK, loaded by these specifiers alone — production and the tests share them. */
export const loadSdk = async () => ({
  base: await import('@opentelemetry/sdk-trace-base'),
  http: await import('@opentelemetry/exporter-trace-otlp-http'),
  hooks: await import('@opentelemetry/context-async-hooks'),
})

/** Forwards a span to `inner` only when it came from `scope`. */
export class OnlyScope implements SpanProcessor {
  readonly scope: string
  readonly inner: SpanProcessor
  constructor(scope: string, inner: SpanProcessor) {
    this.scope = scope
    this.inner = inner
  }
  onStart(): void {}
  onEnding(): void {}
  onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name === this.scope) this.inner.onEnd(span)
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
    spanProcessors: [
      new OnlyScope(SCOPE, new sdk.base.BatchSpanProcessor(exporter ?? new sdk.http.OTLPTraceExporter({ url }))),
    ],
  })
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(new sdk.hooks.AsyncLocalStorageContextManager().enable())
  return provider
}

export type { Span }
