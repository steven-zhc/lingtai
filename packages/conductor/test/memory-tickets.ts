/**
 * `Tickets`, with nothing behind it but memory — the first implementation
 * `tickets-contract.ts` runs against (`#377`).
 *
 * **Touches no clock and no filesystem.** `vitest.config.ts`'s unit/integration
 * line counts the wall clock as outside the system, so a created ticket's time
 * comes from `now`, which defaults to a counter rather than `Date.now()` — a
 * fresh `memoryTickets()` never reads the real clock unless a caller hands it
 * one.
 */
import type { TicketListing } from '../src/discover.ts'
import { BodyChanged, type Ticket, type Tickets } from '../src/ticket-store.ts'

export interface MemoryTicketsOptions {
  /** The clock a created ticket's time is read from. */
  now?: () => Date
}

interface StoredTicket {
  number: number
  title: string
  body: string
  labels: string[]
  state: 'open' | 'closed'
  reason?: 'completed' | 'not_planned'
  createdAt: Date
  comments: string[]
}

/**
 * `memoryTickets()`'s return, widened past `Tickets` with one inspection seam
 * that no production caller gets. Nothing in this codebase reads a comment
 * back (`comment(issue, body)`'s own comment in `@lingtai/github/client.ts`:
 * *"nothing renders comments into a prompt"*), so `Tickets` carries no verb
 * for it — but a test fake that threw the text away regardless would be
 * indistinguishable from one that stored it, to every caller that only has a
 * `Tickets`. `commentBodies` is handed to `tickets-contract.ts` as its
 * `commentBodies` option (`unit/tickets.test.ts`), so the shared suite's own
 * comment case verifies storage rather than only `id` and the issue body.
 */
export interface MemoryTickets extends Tickets {
  commentBodies(issue: number): readonly string[]
}

export function memoryTickets(options: MemoryTicketsOptions = {}): MemoryTickets {
  let tick = 0
  const now = options.now ?? (() => new Date(tick++))
  const byNumber = new Map<number, StoredTicket>()
  let nextNumber = 1
  let nextCommentId = 1

  function require(number: number): StoredTicket {
    const found = byNumber.get(number)
    if (!found) throw new Error(`no ticket #${number}`)
    return found
  }

  /** Fresh objects every call: a caller mutating what it got back must not change what the next call answers. */
  function toListing(t: StoredTicket): TicketListing {
    return {
      number: t.number,
      title: t.title,
      state: t.state,
      labels: t.labels.map((name) => ({ name, color: null })),
      assignees: [],
      // Never null: this implementation has no notion of an unread dependency,
      // only of one that is clear (CLAUDE.md, "Null is not zero").
      dependencies: { blockedBy: 0 },
    }
  }

  function toTicket(t: StoredTicket): Ticket {
    return { ...toListing(t), body: t.body, url: null, stateReason: t.state === 'closed' ? (t.reason ?? null) : null }
  }

  return {
    async listOpenIssues() {
      return [...byNumber.values()].filter((t) => t.state === 'open').map(toListing)
    },

    async listIssuesSince(since) {
      return [...byNumber.values()]
        .filter((t) => t.createdAt >= since)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(toTicket)
    },

    async getIssue(number) {
      return toTicket(require(number))
    },

    async createIssue(input) {
      const t: StoredTicket = {
        number: nextNumber++,
        title: input.title,
        body: input.body,
        labels: [...input.labels],
        state: 'open',
        createdAt: now(),
        comments: [],
      }
      byNumber.set(t.number, t)
      return toTicket(t)
    },

    async comment(number, body) {
      require(number).comments.push(body)
      return { id: nextCommentId++ }
    },

    commentBodies(number) {
      return [...require(number).comments]
    },

    async setLabels(number, labels) {
      require(number).labels = [...labels]
    },

    async closeIssue(number, reason) {
      const t = require(number)
      t.state = 'closed'
      if (reason !== undefined) t.reason = reason
    },

    async updateBody(number, body, opts) {
      const t = require(number)
      if (opts?.ifUnchanged !== undefined && t.body !== opts.ifUnchanged) throw new BodyChanged(number)
      t.body = body
    },
  }
}
