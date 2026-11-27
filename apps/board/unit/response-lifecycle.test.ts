import { channel } from 'node:diagnostics_channel'
import { EventEmitter } from 'node:events'

import { ROOT_CONTEXT, trace, type Span } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { afterEach, expect, it } from 'vitest'

import { observeResponses, RESPONSE_SCOPE } from '../src/lib/response-lifecycle.ts'
import { installTracing, loadSdk, OnlyScope, SCOPE } from '../src/lib/telemetry.ts'

const REQUEST = { 'next.span_type': 'BaseServer.handleRequest' }
const ROUTE = '/p/[project]/pr/[n]'
const CHANNEL = 'http.server.request.start'

const stops: (() => void)[] = []
afterEach(() => {
  while (stops.length > 0) stops.pop()!()
})

class FakeResponse extends EventEmitter {
  headersSent = false
}

async function rig(limit = 1000) {
  const sdk = await loadSdk()
  const out: ReadableSpan[] = []
  const inner = {
    onStart() {},
    onEnd: (s: ReadableSpan) => void out.push(s),
    forceFlush: async () => {},
    shutdown: async () => {},
  } as unknown as SpanProcessor
  const only = new OnlyScope(SCOPE, inner, limit)
  const provider = new sdk.base.BasicTracerProvider({ spanProcessors: [only] })
  stops.push(observeResponses(provider.getTracer(RESPONSE_SCOPE)))
  const next = provider.getTracer('next.js')
  const under = (parent: Span) => trace.setSpan(ROOT_CONTEXT, parent)
  /** One physical request: published on the channel, then Next's request span and a page, in the same async chain. */
  const serve = (route: string, opts: { page?: boolean; parent?: Span } = {}) =>
    new Promise<{ res: FakeResponse; span: Span; end: () => void }>((resolve) =>
      setImmediate(() => {
        const res = new FakeResponse()
        channel(CHANNEL).publish({ request: {}, response: res, socket: {}, server: {} })
        const span = next.startSpan(
          `GET ${route}`,
          { root: opts.parent === undefined, attributes: REQUEST },
          opts.parent && under(opts.parent),
        )
        if (opts.page !== false) provider.getTracer(SCOPE).startSpan('page /pr', {}, under(span)).end()
        resolve({
          res,
          span,
          end: () => {
            span.setAttribute('next.route', route)
            span.end()
          },
        })
      }),
    )
  const responses = () => out.filter((s) => s.name === 'node.response')
  return { only, out, serve, responses }
}

it('exports one finished response when finish is followed by close, and releases its listeners', async () => {
  const r = await rig()
  const a = await r.serve(ROUTE)
  a.res.headersSent = true
  a.res.emit('finish')
  a.res.emit('close')
  expect(a.res.listenerCount('finish')).toBe(0)
  expect(a.res.listenerCount('close')).toBe(0)
  a.end()
  const [one, ...rest] = r.responses()
  expect(rest).toEqual([])
  expect(one!.attributes).toEqual({ 'lingtai.response.outcome': 'finished', 'lingtai.response.headers_sent': true })
  expect(one!.parentSpanContext?.spanId).toBe(a.span.spanContext().spanId)
  expect(one!.instrumentationScope.name).toBe(RESPONSE_SCOPE)
  expect(r.only.phasesRemembered).toBe(0)
})

it('exports closed-before-finish for a close alone, ended after the request span or before it', async () => {
  const r = await rig()
  const before = await r.serve(ROUTE)
  before.res.emit('close') // response first, request span still live
  before.end()
  const after = await r.serve(ROUTE)
  after.end() // request span first
  expect(r.only.awaitingRemembered).toBe(1)
  after.res.emit('close')
  const outcomes = r.responses().map((s) => [s.parentSpanContext?.spanId, s.attributes['lingtai.response.outcome']])
  expect(outcomes).toEqual([
    [before.span.spanContext().spanId, 'closed-before-finish'],
    [after.span.spanContext().spanId, 'closed-before-finish'],
  ])
  expect(r.only.awaitingRemembered).toBe(0)
  expect(r.only.phasesRemembered).toBe(0)
})

it('keeps overlapping requests apart, in separate traces and in one trace', async () => {
  const r = await rig()
  const a = await r.serve(ROUTE)
  const b = await r.serve(ROUTE)
  b.res.emit('finish')
  a.res.emit('close')
  b.end()
  a.end()
  const byParent = new Map(
    r.responses().map((s) => [s.parentSpanContext?.spanId, s.attributes['lingtai.response.outcome']]),
  )
  expect(byParent.get(a.span.spanContext().spanId)).toBe('closed-before-finish')
  expect(byParent.get(b.span.spanContext().spanId)).toBe('finished')
  expect(byParent.size).toBe(2)
  // Sharing a trace: only the request the exporter admits (one per trace) gets a response, and it is its own.
  const c = await r.serve(ROUTE)
  const d = await r.serve(ROUTE, { parent: c.span })
  d.res.emit('finish')
  c.res.emit('close')
  c.end()
  d.end()
  const shared = r.responses().slice(2)
  expect(shared.map((s) => [s.parentSpanContext?.spanId, s.attributes['lingtai.response.outcome']])).toEqual([
    [c.span.spanContext().spanId, 'closed-before-finish'],
  ])
})

it('exports nothing for a response that never ends, and holds no record of it', async () => {
  const r = await rig()
  const a = await r.serve(ROUTE)
  a.end()
  expect(r.responses()).toEqual([])
  expect(r.only.phasesRemembered).toBe(0)
  expect(a.res.listenerCount('finish')).toBe(1) // only the response holds its own listeners
})

it('drops a response whose request was evicted, unmeasured, or without a page', async () => {
  const r = await rig(1)
  const evicted = await r.serve(ROUTE)
  const second = await r.serve(ROUTE) // evicts the first from the live set
  evicted.res.emit('finish')
  evicted.end()
  const unmeasured = await r.serve('/p/[project]/other')
  unmeasured.res.emit('finish')
  unmeasured.end()
  const pageless = await r.serve(ROUTE, { page: false })
  pageless.res.emit('finish')
  pageless.end()
  expect(r.responses()).toEqual([])
  second.end()
  expect(r.only.awaitingRemembered).toBeLessThanOrEqual(1)
})

it('bounds the requests awaiting a response', async () => {
  const r = await rig(2)
  for (let i = 0; i < 5; i++) (await r.serve(ROUTE)).end()
  expect(r.only.awaitingRemembered).toBe(2)
})

it('exports no attribute but the two fixed ones', async () => {
  const r = await rig()
  const a = await r.serve(ROUTE)
  a.res.emit('finish')
  a.end()
  expect(Object.keys(r.responses()[0]!.attributes).toSorted()).toEqual([
    'lingtai.response.headers_sent',
    'lingtai.response.outcome',
  ])
  expect(r.responses()[0]!.events).toEqual([])
  expect(r.responses()[0]!.links).toEqual([])
})

it('installs no subscriber without an endpoint', async () => {
  expect(await installTracing({}, undefined)).toBeUndefined()
  expect(channel(CHANNEL).hasSubscribers).toBe(false)
})
