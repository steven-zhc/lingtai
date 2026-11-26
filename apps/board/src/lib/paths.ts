/**
 * Every board address, built in one place (#1498). A project's pages live at
 * `/p/<project>/<view>[/<id>]`, view segments singular; the global pages
 * (`/`, `/landed`, `/backlog`, `/report`, `/setup`) keep their own.
 *
 * Pure and client-safe: no `next/*` and no `node:`. It may import `@lingtai/domain`
 * for the ticket stream id, which `unit/client-graph.test.ts` allows. The project
 * is always `encodeURIComponent`ed here and decoded once by the page that reads
 * it, so no caller encodes.
 */
import { parseTicketStream, ticketStream } from '@lingtai/domain'

import type { TabKey } from './tabs.ts'

/** A ticket, by the two halves its address is made of. `issue` is an integer, as text. */
export type TicketRef = { project: string; issue: string | number }

/** A ticket named either by its ref or by its stream id (`ticket-<project>-<n>`). */
export type TicketTarget = TicketRef | string

const enc = encodeURIComponent

/** Where a page of `/landed` starts: the last row of the one before. */
export type Cursor = { at: Date; ticket: string }

/** `<ISO outcome_at>,<ticket>`. The date has no comma, so the first one splits. */
export function cursorText(c: Cursor): string {
  return `${c.at.toISOString()},${c.ticket}`
}

/** The ref a stream id names, or null when it is not `ticket-<project>-<integer>`. */
export function ticketRefOf(id: string): { project: string; issue: string } | null {
  const ref = parseTicketStream(id)
  return ref !== null && /^[1-9]\d*$/.test(ref.issue) ? ref : null
}

/**
 * The task id the `[project]` and `[n]` segments name, or null for a segment
 * that is not a ticket (a bad escape, or an `n` that is not a whole number from
 * 1). The one place a route's params become an id.
 */
export function ticketIdOf(project: string, n: string): string | null {
  let name: string
  try {
    name = decodeURIComponent(project)
  } catch {
    return null
  }
  if (name === '' || !/^[1-9]\d*$/.test(n)) return null
  return ticketStream(name, n)
}

/** A stream id that does not parse has no address of its own; the home page stands for it. */
function base(t: TicketTarget): string | null {
  const ref = typeof t === 'string' ? ticketRefOf(t) : t
  return ref === null ? null : `/p/${enc(ref.project)}/ticket/${ref.issue}`
}

export const ticketPath = (t: TicketTarget): string => base(t) ?? '/'

/** The record tab, `/history`. */
export const historyPath = (t: TicketTarget): string => `${ticketPath(t)}/history`

/** Absolute, because a relative `attempt/N` resolves to `…/attempt/attempt/N` from inside an attempt's tab. */
export const attemptTabPath = (t: TicketTarget, attempt: number): string => `${ticketPath(t)}/attempt/${attempt}`

/** `…/sandbox`, with `?attempt=<n>` to name the attempt: a link per attempt, so a reload keeps the choice. */
export function sandboxTabPath(t: TicketTarget, attempt?: number): string {
  const path = `${ticketPath(t)}/sandbox`
  return attempt === undefined ? path : `${path}?attempt=${attempt}`
}

export function tabPath(t: TicketTarget, key: TabKey): string {
  if (key === 'ticket') return historyPath(t)
  if (key === 'sandbox') return sandboxTabPath(t)
  return attemptTabPath(t, key.attempt)
}

/** A project's home, or all projects' (`/`) for `undefined`. */
export const homePath = (project: string | undefined): string =>
  project === undefined || project === '' ? '/' : `/p/${enc(project)}/ticket`

/** The PR board, one PR, or the next one. */
export const prPath = (project: string, n?: number | 'next'): string =>
  n === undefined ? `/p/${enc(project)}/pr` : `/p/${enc(project)}/pr/${n}`

export const recipePath = (project: string): string => `/p/${enc(project)}/recipe`

/** One project's backlog, or all projects' (`/backlog`). */
export const backlogPath = (project?: string): string =>
  project === undefined || project === '' ? '/backlog' : `/p/${enc(project)}/backlog`

/** `/landed`, or one project's. `project` is the path, never the query; `before` is URL-encoded by `URLSearchParams`. */
export function landedHref(q: { project?: string | null; kind?: string | null; before?: Cursor | null }): string {
  const p = new URLSearchParams()
  if (q.kind) p.set('kind', q.kind)
  if (q.before) p.set('before', cursorText(q.before))
  const s = p.toString()
  const path = q.project ? `/p/${enc(q.project)}/ticket/landed` : '/landed'
  return s === '' ? path : `${path}?${s}`
}

/** The column heading's address on the home page. */
export const landedLink = (only: string | undefined): string => landedHref({ project: only })
