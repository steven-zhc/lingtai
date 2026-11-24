import { ROOT_CONTEXT, trace, type Span } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import { expect, it } from 'vitest'

import { loadSdk, OnlyScope, SCOPE } from '../src/lib/telemetry.ts'

const REQUEST = { 'next.span_type': 'BaseServer.handleRequest' }
const BODY = 'AppRender.getBodyResult'
const START = 'NextNodeServer.startResponse'

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
  const next = provider.getTracer('next.js')
  const under = (parent: Span) => trace.setSpan(ROOT_CONTEXT, parent)
  const request = (route: string | undefined, parent?: Span) => {
    const span = next.startSpan(
      `GET ${route}`,
      { root: parent === undefined, attributes: REQUEST },
      parent && under(parent),
    )
    return {
      span,
      end: () => {
        if (route !== undefined) span.setAttribute('next.route', route)
        span.end()
      },
    }
  }
  const phase = (type: string, parent: Span, name = 'render route (app) /task/123') =>
    next.startSpan(name, { attributes: { 'next.span_type': type, 'next.route': '/task/123' } }, under(parent))
  const page = (parent: Span) => provider.getTracer(SCOPE).startSpan('page /task', {}, under(parent))
  const names = () => out.map((s) => s.name).toSorted()
  return { only, out, next, provider, under, request, phase, page, names }
}

it('exports both phases as fixed-name copies under the request, with source timestamps and no sensitive fields', async () => {
  const r = await rig()
  const request = r.request('/task/[id]')
  const pageSpan = r.page(request.span)
  const body = r.phase(BODY, request.span)
  body.setAttribute('http.url', 'https://api.github.com/x?token=y')
  body.addEvent('exception', { 'exception.message': 'https://x?token=y' })
  const start = r.phase(START, body)
  start.end()
  pageSpan.end()
  body.setStatus({ code: 2, message: 'https://x?token=y' })
  body.end()
  request.end()
  expect(r.names()).toEqual(['GET /task/[id]', 'next.render-body', 'next.start-response', 'page /task'])
  const copy = (n: string) => r.out.find((s) => s.name === n)!
  const rid = request.span.spanContext().spanId
  expect(copy('next.render-body').parentSpanContext?.spanId).toBe(rid)
  expect(copy('next.start-response').parentSpanContext?.spanId).toBe(body.spanContext().spanId)
  expect(copy('next.render-body').attributes).toEqual({})
  expect(copy('next.render-body').events).toEqual([])
  expect(copy('next.render-body').links).toEqual([])
  expect(copy('next.render-body').status).toEqual({ code: 2 })
  expect(copy('next.render-body').startTime).toEqual((body as unknown as ReadableSpan).startTime)
  expect(copy('next.render-body').endTime).toEqual((body as unknown as ReadableSpan).endTime)
  expect(JSON.stringify(r.out.map((s) => [s.name, s.attributes, s.events]))).not.toMatch(/token|123|github/)
  // the source is untouched
  expect((body as unknown as ReadableSpan).attributes['http.url']).toBe('https://api.github.com/x?token=y')
  expect((body as unknown as ReadableSpan).status.message).toBe('https://x?token=y')
  expect(r.only.phasesRemembered).toBe(0)
})

it('exports a start-response under a render-body that ends later, and as a request child without one', async () => {
  const r = await rig()
  const request = r.request('/')
  r.page(request.span).end()
  const via = r.phase(START, request.span)
  via.end()
  request.end()
  expect(r.out.find((s) => s.name === 'next.start-response')!.parentSpanContext?.spanId).toBe(
    request.span.spanContext().spanId,
  )
  expect(r.only.phasesRemembered).toBe(0)
})

it('never exports other Next spans, look-alikes, another scope, other routes or a request without a page', async () => {
  const r = await rig()
  const other = r.provider.getTracer('other')
  const a = r.request('/pr/[project]')
  r.page(a.span).end()
  r.phase(BODY, a.span).end()
  a.end()
  const b = r.request(undefined)
  r.page(b.span).end()
  r.phase(BODY, b.span).end()
  b.end()
  const c = r.request('/task/[id]')
  r.phase(BODY, c.span).end()
  c.end() // no page span: no request copy, no phases
  const d = r.request('/task/[id]')
  r.page(d.span).end()
  r.phase('BaseServer.renderToResponseWithComponents', d.span).end()
  r.phase('AppRender.renderToReadableStream', d.span).end()
  r.next.startSpan(BODY, {}, r.under(d.span)).end() // named like a phase, no span_type
  other.startSpan('x', { attributes: { 'next.span_type': BODY } }, r.under(d.span)).end()
  d.end()
  expect(r.names()).toEqual([
    'GET /pr/[project]',
    'GET /task/[id]',
    'GET undefined',
    'page /task',
    'page /task',
    'page /task',
  ])
  expect(r.names().filter((n) => n.startsWith('next.'))).toEqual([])
  expect(r.only.phasesRemembered).toBe(0)
})

it('does not attribute a phase to an overlapping request that shares its trace', async () => {
  const r = await rig()
  const a = r.request('/backlog')
  // B joins A's trace through a propagated context but is a different request span.
  const b = r.request('/task/[id]', a.span)
  r.page(b.span).end()
  const aBody = r.phase(BODY, a.span)
  const bBody = r.phase(BODY, b.span)
  aBody.end()
  bBody.end()
  b.end()
  a.end()
  const phases = r.out.filter((s) => s.name === 'next.render-body')
  expect(phases).toHaveLength(1)
  expect(phases[0]!.spanContext().spanId).toBe(bBody.spanContext().spanId)
  expect(phases[0]!.parentSpanContext?.spanId).toBe(b.span.spanContext().spanId)
  expect(r.only.phasesRemembered).toBe(0)
})

it('keeps interleaved traces apart', async () => {
  const r = await rig()
  const a = r.request('/task/[id]')
  const b = r.request('/')
  r.page(a.span).end()
  r.page(b.span).end()
  const pa = r.phase(BODY, a.span)
  const pb = r.phase(START, b.span)
  pb.end()
  pa.end()
  a.end()
  b.end()
  const bodyOf = r.out.find((s) => s.name === 'next.render-body')!
  const startOf = r.out.find((s) => s.name === 'next.start-response')!
  expect(bodyOf.parentSpanContext?.spanId).toBe(a.span.spanContext().spanId)
  expect(startOf.parentSpanContext?.spanId).toBe(b.span.spanContext().spanId)
  expect(r.only.phasesRemembered).toBe(0)
})

it('handles a phase before the first page, several pages, and a phase ending after its request', async () => {
  const r = await rig()
  const request = r.request('/task/[id]')
  r.phase(BODY, request.span).end() // ends before any page span
  r.page(request.span).end()
  r.page(request.span).end()
  const late = r.phase(BODY, request.span)
  request.end()
  late.end() // after the request: absent, not retained
  expect(r.names().filter((n) => n === 'next.render-body')).toHaveLength(1)
  expect(r.only.phasesRemembered).toBe(0)
})

it('does not export a phase whose request was never found or whose phase never ended', async () => {
  const r = await rig()
  r.phase(BODY, r.next.startSpan('orphan', { root: true })).end()
  const request = r.request('/task/[id]')
  r.page(request.span).end()
  r.phase(BODY, request.span) // never ended
  request.end()
  expect(r.names()).toEqual(['GET /task/[id]', 'page /task'])
})

it('bounds live requests, copies per request and tracked spans, and cleans up on eviction', async () => {
  const r = await rig(2)
  const made = [0, 1, 2].map(() => r.request('/task/[id]'))
  const first = made[0]!
  const body = r.phase(BODY, first.span) // owner evicted when the third started
  body.end()
  first.end()
  expect(r.out).toEqual([])
  const request = made[2]!
  r.page(request.span).end()
  for (let i = 0; i < 6; i++) r.phase(BODY, request.span).end()
  request.end()
  expect(r.out.filter((s) => s.name === 'next.render-body')).toHaveLength(4)
  made[1]!.end()
  expect(r.only.phasesRemembered).toBe(0)
})
