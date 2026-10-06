/**
 * `TicketStore` — where tickets come from, and the one door a new one goes in by
 * ([0036](../../../doc/decisions-archive/0036-the-core-takes-a-ticket.md) §2).
 * `Tickets`, below, is every other verb Lingtai uses against a ticket system
 * (`#377`): 0036 named `list`, `get` and `save` as the port's shape, and this is
 * where they land, one interface rather than the three partial ports
 * (`TicketSource` in `discover.ts`, `IssueChannel` in `tell.ts`, and this file's
 * own `Pick<GitHubClient, …>`) that could drift from each other. Moving the
 * callers onto it is `#378`; this file changes no caller.
 *
 * **An adapter implements both `propose` and `withdraw`, and `withdraw` really
 * closes.** `propose` is safe to race only because the loser withdraws what it
 * wrote: the backlog's `settle` calls `withdraw` on the duplicate an opener
 * created after another recorded first, and reports it closed. A no-op
 * `withdraw` leaves that duplicate open while the caller is told it is not.
 *
 * > **Lingtai proposes; a person decides it exists.**
 *
 * The store is how it comes to exist, and it obeys 0036 §4 from this end too:
 * **the store translates and does not judge.** What the ticket says — its
 * title, body, kind and any hold — is decided before it arrives here, by the
 * person and the recipe. The adapter decides only how to write that down: on
 * GitHub, the kind is a label, so is a hold, and the key is a comment in the
 * body.
 */
import { parseWorkItemStream, type ProjectState } from '@lingtai/domain'
import type { LogQueries, TicketSql } from '@lingtai/event-store'
import type { GitHubClient } from '@lingtai/github'
import type { Recipe } from '@lingtai/recipe'
import { ticketSourceOf } from '@lingtai/recipe/settings'

import { dbTickets } from './db-tickets.ts'
import type { TicketDetail, TicketListing } from './discover.ts'

/**
 * A ticket's detail plus where it lives, if anywhere a person can browse to —
 * `TicketDetail` is the body-bearing read and `url` is the one field no
 * existing port carried: GitHub always has one, and a ticket system with no
 * web pages has none.
 */
export type Ticket = TicketDetail & { url: string | null }

/**
 * Every verb Lingtai uses against a ticket system through `@lingtai/github`'s
 * typed `GitHubClient` methods (`#377`). `GitHubClient` satisfies this
 * structurally — pinned in `unit/tickets.test.ts`, because `pnpm test` does
 * not typecheck and a `Pick` or a narrowed method here would otherwise drift
 * silently until `pnpm typecheck` next ran.
 *
 * **Not every write Lingtai makes against GitHub goes through a verb here.**
 * `wizard.ts`'s `holdAll` calls `client.request('POST', …/labels)` directly —
 * GitHub's additive label write, which has no typed method on `GitHubClient`
 * and no equivalent here, because this interface's `setLabels` replaces
 * (`wizard.ts:189-200` says why a replace is wrong for that one caller and an
 * untyped union write is right).
 *
 * `dependencies` on a `Ticket` or a `TicketListing` is `{ blockedBy: number }
 * | null`, same as `GitHubClient`'s — `discover.ts`'s `runnableNow` reads
 * `null` as *GitHub said nothing about dependencies*, not *nothing blocks
 * it*. **`memoryTickets`, having no notion of blockers, answers the zero
 * rather than the unread case**, but that is a rule on that one
 * implementation, not on every `Tickets`: a real `GitHubClient` can still
 * answer `null` here, and a caller must keep reading the null branch.
 */
export interface Tickets {
  listOpenIssues(): Promise<TicketListing[]>
  /** Every ticket, open or closed, created at or after `since` — oldest first. */
  listIssuesSince(since: Date): Promise<Ticket[]>
  /** Rejects when no ticket carries this number. */
  getIssue(number: number): Promise<Ticket>
  createIssue(input: { title: string; body: string; labels: readonly string[] }): Promise<Ticket>
  comment(issue: number, body: string): Promise<{ id: number }>
  /** Replaces the whole label set. */
  setLabels(issue: number, labels: readonly string[]): Promise<void>
  closeIssue(issue: number, reason?: 'completed' | 'not_planned'): Promise<void>
  /** Replaces the whole body. */
  updateBody(issue: number, body: string): Promise<void>
}

export interface ProposedTicket {
  /**
   * The identity `propose` is idempotent on: the finding's key. A store that is
   * asked twice for the same key answers with the ticket it already has.
   */
  key: string
  /** No ticket for this key can be older than this — when a person accepted it. */
  since: Date
  title: string
  /** The body a later run is prompted with, if it runs. */
  body: string
  /** The recipe's word for what this is — one of `source.kinds`. */
  kind: string
  /** Anything else the ticket should carry, verbatim — `agent:hold`, usually. */
  labels: readonly string[]
}

export interface ProposedRef {
  /** The store's own identity for the ticket: `"212"` on GitHub. */
  externalRef: string
  url: string | null
  /** This call wrote the ticket, rather than finding one an earlier call wrote. */
  created: boolean
}

export interface TicketStore {
  readonly source: string
  /**
   * The ticket for `ticket.key`: the one that exists, or a new one.
   *
   * **Safe to repeat, and to race.** Two calls with one key converge on one
   * ticket: each looks before it writes, and a call that wrote and then finds
   * an older ticket for the key withdraws its own. Anything thrown says nothing
   * about whether a write landed — which is why repeating is how a failure is
   * answered.
   */
  propose(ticket: ProposedTicket): Promise<ProposedRef>
  /**
   * Withdraw a ticket this store opened and the log did not record, naming the
   * one that is. Only ever called by the call that `created` it.
   */
  withdraw(externalRef: string, keptRef: string, why: string): Promise<void>
}

/** How a GitHub issue says which finding it is. Invisible when rendered. */
export function keyMarker(key: string): string {
  return `<!-- lingtai:finding ${key} -->`
}

/**
 * Clocks disagree, and GitHub's `since` and `created_at` are its own clock. An
 * hour is far wider than any skew and still keeps the listing to recent issues.
 */
const SKEW_MS = 60 * 60_000

/** GitHub issues. `client` is the one the caller already has for the project. */
export function githubTicketStore(
  client: Pick<Tickets, 'createIssue' | 'listIssuesSince' | 'comment' | 'closeIssue'>,
): TicketStore {
  const ref = (issue: Ticket, created: boolean): ProposedRef => ({
    externalRef: String(issue.number),
    url: issue.url,
    created,
  })

  /** The issue a key belongs to: the oldest one carrying it. */
  async function carrying(key: string, since: Date): Promise<Ticket | undefined> {
    const marker = keyMarker(key)
    const found = (await client.listIssuesSince(new Date(since.getTime() - SKEW_MS)))
      .filter((i) => i.body.includes(marker))
      .sort((a, b) => a.number - b.number)
    return found[0]
  }

  async function withdraw(externalRef: string, keptRef: string, why: string): Promise<void> {
    const n = Number(externalRef)
    await client.comment(n, `Duplicate of #${keptRef} — ${why}.`)
    await client.closeIssue(n, 'not_planned')
  }

  return {
    source: 'github-issue',
    withdraw,

    async propose(ticket) {
      const existing = await carrying(ticket.key, ticket.since)
      if (existing) return ref(existing, false)

      const labels = [...new Set([ticket.kind, ...ticket.labels].filter((l) => l.trim() !== ''))]
      const body = `${ticket.body.trimEnd()}\n\n${keyMarker(ticket.key)}\n`
      const opened = await client.createIssue({ title: ticket.title, body, labels })

      // Look again. A call that raced this one may have opened its own in the
      // meantime; the older issue is the key's, so the newer withdraws.
      const first = await carrying(ticket.key, ticket.since)
      if (first && first.number < opened.number) {
        await withdraw(
          String(opened.number),
          String(first.number),
          'two accepts of the same finding opened an issue at once, and the older one is kept',
        )
        return ref(first, false)
      }
      return ref(opened, true)
    },
  }
}

/** A project's recipe newly says `db`, but the log already has GitHub-numbered work items. */
export class TicketSourceConflict extends Error {
  constructor(project: string, streams: readonly string[]) {
    super(
      `${project}: source.tickets is db, but the log already has GitHub-numbered work items ` +
        `(${streams.join(', ')}) — db would number from 1 into them; remove source.tickets or use a fresh project`,
    )
    this.name = 'TicketSourceConflict'
  }
}

export interface TicketsForOptions {
  /** Defaults to this process's own ticket tables, opened on first use. */
  sql?: TicketSql
  /** Defaults to this process's own log. */
  log?: Pick<LogQueries, 'projectStreams'>
}

async function defaultSql(): Promise<TicketSql> {
  return (await import('@lingtai/event-store')).processTicketSql()
}

async function defaultLogQueries(): Promise<Pick<LogQueries, 'projectStreams'>> {
  return (await import('@lingtai/event-store')).log.queries
}

/**
 * Where a project's tickets come from, by its recipe (`#382`).
 *
 * `'github'`, or the field absent: returns `client` itself, the identical
 * value a caller had before this existed. `'db'`: `dbTickets` on `sql`, after
 * the refusal below.
 *
 * `sql` and `log` default through a **dynamic** import of
 * `@lingtai/event-store`, for `projects.ts`'s reason: a caller that brings its
 * own log should still load no store at all, and `filter.ts` — which `lingtai
 * status` reaches before anything else — must not open one merely by
 * importing this function.
 *
 * **The refusal.** A project whose log already has `wi-<project>-*` streams
 * and whose recipe newly says `db` would number tickets from 1 into streams
 * that belong to GitHub issues (`workItemStream`, `@lingtai/domain`). Once
 * `dbTickets` holds any ticket of its own, the project switched deliberately
 * and this passes regardless of what the log holds from before.
 */
export async function ticketsFor(
  state: ProjectState,
  recipe: Recipe,
  client: Tickets,
  options: TicketsForOptions = {},
): Promise<Tickets> {
  if (ticketSourceOf(recipe) !== 'db') return client

  const project = state.project
  if (!project) throw new Error('no repository name recorded — re-run lingtai add')

  const sql = options.sql ?? (await defaultSql())
  const tickets = dbTickets(sql, project)

  const already = await tickets.listIssuesSince(new Date(0))
  if (already.length === 0) {
    const log = options.log ?? (await defaultLogQueries())
    const streams = (await log.projectStreams(`wi-${project}-`)).filter(
      (id) => parseWorkItemStream(id)?.project === project,
    )
    if (streams.length > 0) throw new TicketSourceConflict(project, streams)
  }

  return tickets
}

/**
 * `passClientOf`'s return type: every member of `GitHubClient` except the
 * eight `Tickets` verbs, which come from `Tickets` instead.
 *
 * **Not `GitHubClient` itself.** `dbTickets` answers a label's `color` and
 * the array it carries both as read-only — the same shape `Tickets.getIssue`
 * promises — where `GitHubClient`'s own `Issue` promises a mutable `Label[]`
 * for the issue it actually fetched; the two cannot both be true of the
 * shared verbs' return type. `Omit`ting them from `GitHubClient` and taking
 * them from `Tickets` alone is how both sides of that disagreement get to be
 * right (#383).
 *
 * **Wider than the old `PassClient`-shaped return on purpose.** `runOnce`,
 * `runQueue` and `runnableNow` only ever asked for `Tickets`, `RefChannel` and
 * `owner`/`repo`, which is what this returned before #383. The sites #383
 * moved off building their own `GitHubClient` — `close()`, `approve()`, the
 * board's actions, `lingtai backlog`/`close`/`approve`/`end replay` — also
 * need `token()`, `defaultBranch()` and `refSha()` on the one client they are
 * handed, so this keeps every member `Tickets` does not replace rather than
 * dropping them for a narrower type each caller would have had to recover.
 */
export type TicketedClient = Omit<GitHubClient, keyof Tickets> & Tickets

/**
 * The client a pass — or any other caller that touches a ticket — is handed,
 * with its ticket verbs taken from `tickets`.
 *
 * `tickets === client` (`ticketsFor`'s `'github'` branch): returns `client`
 * unchanged. Otherwise returns a copy of `client` with each of `Tickets`'
 * eight verbs replaced — named explicitly rather than spread from `tickets`,
 * because a `DbTickets` carries extras (`commentBodies`) `GitHubClient` does
 * not have.
 *
 * **The refs, `fileAt`, the default branch and the token are untouched.**
 * Those still go to GitHub for a project that is on GitHub; only the ticket
 * verbs move.
 */
export function passClientOf(client: GitHubClient, tickets: Tickets): TicketedClient {
  if ((tickets as unknown) === (client as unknown)) return client
  return {
    ...client,
    listOpenIssues: tickets.listOpenIssues,
    listIssuesSince: tickets.listIssuesSince,
    getIssue: tickets.getIssue,
    createIssue: tickets.createIssue,
    comment: tickets.comment,
    setLabels: tickets.setLabels,
    closeIssue: tickets.closeIssue,
    updateBody: tickets.updateBody,
  }
}
