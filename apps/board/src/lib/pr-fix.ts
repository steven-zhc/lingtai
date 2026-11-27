/**
 * Which pr-fix ticket is fixing the open PR (#1506): one pure function over plain data, so the board, the PR page and the
 * `PRs` count decide it the same way and a test needs no store. It imports types only, never the store, the projector or
 * GitHub, so a client graph may import it. The reads that build `PrFixRead` are `readPrFixes` in `prs.ts`.
 *
 * A pr-fix ticket *is fixing* the open PR when it is open, has not landed, and — if it was claimed — its claim's
 * `cutFrom.pr` is this PR (the claim wins whenever there is one). Without a claim only one PR can be open (0131), so the
 * label decides.
 */
import { type PrState, ticketStream } from '@lingtai/domain'

import { ticketPath } from './paths.ts'

/** One open pr-fix ticket as the reads found it. */
export interface PrFixTicket {
  readonly issue: number
  readonly title: string
  /** `claim`: a `task_view` row (the conductor has claimed it). `listing`: only the ticket source knows it. */
  readonly source: 'claim' | 'listing'
  /** The `task_view` state; `queued` for a listing entry. */
  readonly state: string
  /** The claim's `cutFrom.pr`: null when no PR was open at the claim. Undefined for a listing entry (no claim). */
  readonly cutFromPr: number | null | undefined
  readonly labels: readonly string[]
  /** The run's step while running; null when none or the run stream could not be read. */
  readonly step: string | null
  /** When the claim was written (the ticket stream's first event), ISO; null for a listing entry. */
  readonly claimedAt: string | null
}

/** What the reads found, or why they could not: a failure is never an empty list. */
export type PrFixRead =
  | { readonly kind: 'read'; readonly tickets: readonly PrFixTicket[] }
  | { readonly kind: 'failed'; readonly error: string }

export interface FixingTicket {
  readonly issue: number
  readonly title: string
  /** `queued`, `running · <step>`, `running`, `waiting on you` or `landed`. */
  readonly word: string
  readonly waitsOnYou: boolean
  readonly claimedAt: string | null
  readonly landed: boolean
}

export interface Fixing {
  /** Lowest issue number first. */
  readonly tickets: readonly FixingTicket[]
  /** The first ticket that waits on the person, or null. */
  readonly waitsOn: FixingTicket | null
  /** Set when the read failed: the PR is drawn as recorded and says it could not tell. */
  readonly unknown: string | null
}

export const NOT_FIXING: Fixing = { tickets: [], waitsOn: null, unknown: null }

const LANDED = 'lingtai:landed'
const HOLD = 'lingtai:hold'
const DONE = new Set(['landed', 'satisfied', 'closed'])
const RUNNING = new Set(['running', 'verifying', 'approved'])

const wordOf = (t: PrFixTicket): { word: string; waits: boolean } => {
  if (t.source === 'listing')
    return t.labels.includes(HOLD) ? { word: 'waiting on you', waits: true } : { word: 'queued', waits: false }
  if (t.state === 'waiting') return { word: 'waiting on you', waits: true }
  if (RUNNING.has(t.state)) return { word: t.step === null ? 'running' : `running · ${t.step}`, waits: false }
  return { word: 'queued', waits: false }
}

/** Applies the three rules and the state table. `read` is null where nothing was asked. */
export function fixingOf(pr: PrState, read: PrFixRead | null): Fixing {
  const landedAlready = new Set(pr.fixesLanded.map((f) => String(f.ticket)))
  const found: FixingTicket[] = []
  if (read !== null && read.kind === 'read') {
    for (const t of read.tickets) {
      if (DONE.has(t.state) || t.labels.includes(LANDED) || landedAlready.has(String(t.issue))) continue
      if (t.source === 'claim' && t.cutFromPr !== pr.n) continue
      const { word, waits } = wordOf(t)
      found.push({ issue: t.issue, title: t.title, word, waitsOnYou: waits, claimedAt: t.claimedAt, landed: false })
    }
  }
  // A pr-fix that landed while the PR still waits for its restart: drawn from the PR's own record, so even a failed read shows it.
  if (pr.fixOwed && pr.status === 'waiting') {
    for (const f of pr.fixesLanded) {
      const issue = Number(f.ticket)
      if (found.some((x) => x.issue === issue)) continue
      found.push({ issue, title: f.title, word: 'landed', waitsOnYou: false, claimedAt: null, landed: true })
    }
  }
  found.sort((a, b) => a.issue - b.issue)
  return {
    tickets: found,
    waitsOn: found.find((t) => t.waitsOnYou) ?? null,
    unknown: read !== null && read.kind === 'failed' ? read.error : null,
  }
}

/**
 * Whether the PR counts as waiting on the person: the one rule the board's column and the place line's `PRs` share.
 * Only a `ci-red` wait with a fixing ticket that does not itself wait on the person is not waiting on you.
 */
export const countsAsWaiting = (pr: PrState, fixing: Fixing): boolean =>
  pr.status === 'waiting' && !movesToProgress(pr, fixing)

/** A `ci-red` wait with a pr-fix in flight that is not waiting on the person is drawn in In progress. */
export const movesToProgress = (pr: PrState, fixing: Fixing): boolean =>
  pr.status === 'waiting' && pr.wait?.reason === 'ci-red' && fixing.tickets.length > 0 && fixing.waitsOn === null

/** One `fixing:` line per ticket, each a link to the ticket's page; the address is `ticketPath`'s and nothing else's. */
export const fixingLines = (project: string, fixing: Fixing): { readonly text: string; readonly href: string }[] =>
  fixing.tickets.map((t) => ({
    text: `fixing: #${t.issue} ${t.title} · ${t.word}`,
    href: ticketPath(ticketStream(project, String(t.issue))),
  }))

/** The sentence a failed read leaves on the card and the page. */
export const unknownLine = (error: string): string => `could not tell whether a pr-fix is open: ${error}`
