import { machineFileFrom } from '@lingtai/env'
import { context, ROOT_CONTEXT, trace, type Tracer } from '@opentelemetry/api'
import { InMemorySpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, expect, it } from 'vitest'

import { register } from '../src/instrumentation.ts'
import { installTracing, loadSdk, OnlyScope, SCOPE } from '../src/lib/telemetry.ts'
import { measure, timed } from '../src/lib/timing.ts'

const none = machineFileFrom('/h/config.yml', null)
const on = { LINGTAI_TELEMETRY_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' } as unknown as NodeJS.ProcessEnv

afterEach(() => {
  trace.disable()
  context.disable()
})

it('loads all four SDK modules through the specifiers register uses', async () => {
  const sdk = await loadSdk()
  expect(typeof sdk.resources.resourceFromAttributes).toBe('function')
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

it('exports service.name lingtai-board and no path in the resource', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  trace.getTracer('lingtai-board').startSpan('mine').end()
  await provider!.forceFlush()
  const [span] = exporter.getFinishedSpans()
  expect(span!.resource.attributes['service.name']).toBe('lingtai-board')
  for (const v of Object.values(span!.resource.attributes)) expect(String(v)).not.toContain('/')
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
  expect(spans.map((s) => s.name)).toEqual(['events.task', 'events.run', 'page /'])
  expect(spans[1]!.attributes).toEqual({ 'lingtai.count': 7 })
})

const REQUEST = { 'next.span_type': 'BaseServer.handleRequest' }

it('a page is one trace: the page span is a child of the request span, its reads children of the page', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  await trace
    .getTracer('next.js')
    .startActiveSpan('GET /task/[id]', { attributes: { ...REQUEST, 'next.route': '/task/[id]' } }, async (request) => {
      await measure(
        async () => {
          await timed('events.task', async () => 1)
          await timed('events.run', async () => 2, { desc: '7' })
        },
        { label: '/task' },
      )
      request.end()
    })
  await provider!.forceFlush()
  const spans = exporter.getFinishedSpans()
  const request = spans.find((s) => s.name === 'GET /task/[id]')!
  const page = spans.find((s) => s.name === 'page /task')!
  expect(page.parentSpanContext?.spanId).toBe(request.spanContext().spanId)
  expect(page.spanContext().traceId).toBe(request.spanContext().traceId)
  const children = spans.filter((s) => s !== page && s !== request)
  expect(children.map((s) => s.name).toSorted()).toEqual(['events.run', 'events.task'])
  for (const c of children) {
    expect(c.parentSpanContext?.spanId).toBe(page.spanContext().spanId)
    expect(c.spanContext().traceId).toBe(page.spanContext().traceId)
  }
  for (const s of spans) {
    if (s !== request) expect(Object.keys(s.attributes).filter((k) => k !== 'lingtai.count')).toEqual([])
    expect(s.name).not.toMatch(/\/\d+(\/|$)/)
  }
})

it('the request span leaves as a copy with four attributes, no events or links, and no status message', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  await trace.getTracer('next.js').startActiveSpan(
    'GET /task/[id]',
    {
      attributes: {
        ...REQUEST,
        'http.target': '/task/123',
        'http.url': 'https://api.github.com/x?t=1',
        'http.method': 'GET',
        'next.route': '/task/[id]',
        'next.rsc': false,
      },
    },
    async (request) => {
      await measure(async () => 1, { label: '/task' })
      request.recordException(new Error('https://x?token=y'))
      request.setAttribute('http.status_code', 500)
      request.setStatus({ code: 2, message: 'https://x?token=y' })
      request.end()
    },
  )
  await provider!.forceFlush()
  const request = exporter.getFinishedSpans().find((s) => s.name === 'GET /task/[id]')!
  expect(request.attributes).toEqual({
    'next.route': '/task/[id]',
    'http.method': 'GET',
    'http.status_code': 500,
    'next.rsc': false,
  })
  expect(request.events).toEqual([])
  expect(request.links).toEqual([])
  expect(request.status).toEqual({ code: 2 })
  expect(JSON.stringify([request.attributes, request.status, request.events])).not.toMatch(/https:|token|123/)
})

it('never forwards a request span without a page span, one from another scope, or another Next span', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  await trace.getTracer('next.js').startActiveSpan('GET /static', { attributes: REQUEST }, async (r) => r.end())
  await trace.getTracer('next.js').startActiveSpan('GET /task/[id]', { attributes: REQUEST }, async (request) => {
    await measure(async () => 1, { label: '/task' })
    await trace.getTracer('other').startActiveSpan('GET /other', { attributes: REQUEST }, async (s) => s.end())
    await trace.getTracer('next.js').startActiveSpan('fetch GET https://api.github.com/x', async (s) => s.end())
    await trace
      .getTracer('next.js')
      .startActiveSpan('x', { attributes: { 'next.span_type': 'AppRender.fetch' } }, async (s) => s.end())
    request.end()
  })
  await provider!.forceFlush()
  expect(
    exporter
      .getFinishedSpans()
      .map((s) => s.name)
      .toSorted(),
  ).toEqual(['GET /task/[id]', 'page /task'])
})

/** A request span and a `page` span in its trace, built with explicit contexts and no global provider. */
function traced(provider: { getTracer(name: string): Tracer }, name: string) {
  const request = provider.getTracer('next.js').startSpan(name, { root: true, attributes: REQUEST })
  const page = provider.getTracer(SCOPE).startSpan(`page ${name}`, {}, trace.setSpan(ROOT_CONTEXT, request))
  return { request, page }
}

const recorder = (seen: string[] = []) => ({
  seen,
  inner: {
    onStart() {},
    onEnd: (s: { name: string }) => void seen.push(s.name),
    forceFlush: async () => {},
    shutdown: async () => {},
  } as unknown as SpanProcessor,
})

it('remembers at most the limit of trace ids, oldest first', async () => {
  const sdk = await loadSdk()
  const { seen, inner } = recorder()
  const only = new OnlyScope(SCOPE, inner, 3)
  const provider = new sdk.base.BasicTracerProvider({ spanProcessors: [only] })
  const made = ['a', 'b', 'c', 'd'].map((n) => traced(provider, n))
  for (const { page } of made) page.end()
  expect(only.remembered).toBe(3)
  seen.length = 0
  made[0]!.request.end() // its id was evicted
  expect(seen).toEqual([])
  made[3]!.request.end()
  expect(seen).toEqual(['d'])
  expect(only.remembered).toBe(2)
})

it('never remembers more than 1,000 trace ids when page spans arrive with no request span', async () => {
  const sdk = await loadSdk()
  const only = new OnlyScope(SCOPE, recorder().inner)
  const provider = new sdk.base.BasicTracerProvider({ spanProcessors: [only] })
  for (let i = 0; i < 1001; i++) provider.getTracer(SCOPE).startSpan('page /x', { root: true }).end()
  expect(only.remembered).toBe(1000)
})
it('a page whose load throws exports ERROR with no message and rethrows the same error', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = await installTracing(on, none, exporter)
  const boom = new Error('https://x?token=y')
  await expect(measure(() => Promise.reject(boom), { label: '/task' })).rejects.toBe(boom)
  await provider!.forceFlush()
  const [span] = exporter.getFinishedSpans()
  expect(span!.name).toBe('page /task')
  expect(span!.status).toEqual({ code: 2 })
  expect(span!.events).toEqual([])
})
