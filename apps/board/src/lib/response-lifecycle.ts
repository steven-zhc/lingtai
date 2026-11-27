import { AsyncLocalStorage } from 'node:async_hooks'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

import { ROOT_CONTEXT, trace, type SpanContext, type Tracer } from '@opentelemetry/api'

/**
 * Observes whether each HTTP response finished or was closed first (#1442).
 * **Server only**, and installed only once an OTLP endpoint is configured.
 *
 * The seam is Node's own `http.server.request.start` diagnostics channel, which
 * `_http_server` publishes just before it emits `'request'`; the standalone board
 * and the source path both reach it, and no Next method is involved. The
 * subscriber puts a small record in an `AsyncLocalStorage`, so Next's request
 * span, started further down the same async chain, can bind to it: attribution
 * is by async context, never by trace id, URL or time.
 *
 * `finish` means the server handed the last bytes to its transport — not that
 * the browser received them. `close` before `finish` means the connection went
 * first. `close` after `finish` is the normal end and is not an abort. No
 * `error` listener is added and `write` is not wrapped, so no response behaviour
 * changes. The record holds no response; only the two listeners do, and they
 * belong to the response, so one that never ends takes its record with it.
 */
export const RESPONSE_SCOPE = 'lingtai-board.response'
export const RESPONSE_SPAN = 'node.response'
export const OUTCOME = 'lingtai.response.outcome'
export const HEADERS_SENT = 'lingtai.response.headers_sent'

export type Outcome = 'finished' | 'closed-before-finish'

export type Lifecycle = {
  /** `performance.now()` when Node handed the request to the server. */
  readonly startedAt: number
  /** The request span this response belongs to; set once, by `OnlyScope`. */
  request: SpanContext | undefined
  done: boolean
}

type Emitter = {
  readonly headersSent: boolean
  once(event: 'finish' | 'close', listener: () => void): unknown
  off(event: 'finish' | 'close', listener: () => void): unknown
}

const store = new AsyncLocalStorage<Lifecycle>()
const CHANNEL = 'http.server.request.start'

/** The record of the response being served in this async chain, if any. */
export const currentLifecycle = (): Lifecycle | undefined => store.getStore()

/** Subscribes; returns the function that undoes it. Exports one span per response that was bound to a request. */
export function observeResponses(tracer: Tracer): () => void {
  const onRequest = (message: unknown): void => {
    const response = (message as { response?: Emitter } | null)?.response
    if (response === undefined || typeof response.once !== 'function') return
    const record: Lifecycle = { startedAt: performance.now(), request: undefined, done: false }
    store.enterWith(record)
    const end = (outcome: Outcome): void => {
      if (record.done) return
      record.done = true
      response.off('finish', onFinish)
      response.off('close', onClose)
      const request = record.request
      if (request === undefined) return
      const span = tracer.startSpan(
        RESPONSE_SPAN,
        {
          startTime: record.startedAt,
          attributes: { [OUTCOME]: outcome, [HEADERS_SENT]: response.headersSent === true },
        },
        trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(request)),
      )
      span.end(performance.now())
    }
    const onFinish = (): void => end('finished')
    const onClose = (): void => end('closed-before-finish')
    response.once('finish', onFinish)
    response.once('close', onClose)
  }
  subscribe(CHANNEL, onRequest)
  return () => void unsubscribe(CHANNEL, onRequest)
}
