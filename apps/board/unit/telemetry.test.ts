import { machineFileFrom } from '@lingtai/env'
import { context, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { afterEach, expect, it } from 'vitest'

import { register } from '../src/instrumentation.ts'
import { installTracing, loadSdk } from '../src/lib/telemetry.ts'
import { measure, timed } from '../src/lib/timing.ts'

const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

afterEach(() => {
  trace.disable()
  context.disable()
})

it('loads all three SDK modules through the specifiers register uses', async () => {
  const sdk = await loadSdk()
  expect(typeof sdk.base.BasicTracerProvider).toBe('function')
  expect(typeof sdk.http.OTLPTraceExporter).toBe('function')
  expect(typeof sdk.hooks.AsyncLocalStorageContextManager).toBe('function')
})

it('installs nothing without an endpoint', async () => {
  expect(await installTracing({} as NodeJS.ProcessEnv, none)).toBeUndefined()
  expect(trace.getTracer('lingtai-board').startSpan('x').isRecording()).toBe(false)
  expect(trace.getTracerProvider().constructor.name).toBe('ProxyTracerProvider')
  expect((trace.getTracerProvider() as unknown as { getDelegate(): object }).getDelegate().constructor.name).toBe(
    'NoopTracerProvider',
  )
})

it('register does nothing outside the node runtime', async () => {
  await register()
  expect(trace.getTracer('lingtai-board').startSpan('x').isRecording()).toBe(false)
})

it('exports lingtai-board spans and drops every other scope', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  trace.getTracer('lingtai-board').startSpan('mine').end()
  trace
    .getTracer('next.js')
    .startSpan('fetch GET https://api.github.com/x', { attributes: { 'http.url': 'https://api.github.com/x?t=1' } })
    .end()
  await provider!.forceFlush()
  expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(['mine'])
})

it('a failing read exports ERROR with no message, events or leaking attribute', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  const boom = new Error('https://x?token=y')
  await expect(timed('github.issue', () => Promise.reject(boom))).rejects.toBe(boom)
  await provider!.forceFlush()
  const [span] = exporter.getFinishedSpans()
  expect(span!.name).toBe('github.issue')
  expect(span!.status).toEqual({ code: 2 })
  expect(span!.events).toEqual([])
  expect(JSON.stringify(span!.attributes)).not.toMatch(/https:\/\/|token/)
})

it("#774's names come out as span names, with the count", async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  await measure(async () => {
    await timed('events.task', async () => 1)
    await timed('events.run', async () => 2, { desc: '7' })
  })
  await provider!.forceFlush()
  const spans = exporter.getFinishedSpans()
  expect(spans.map((s) => s.name)).toEqual(['events.task', 'events.run'])
  expect(spans[1]!.attributes).toEqual({ 'lingtai.count': 7 })
})
