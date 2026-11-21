/**
 * The description of a PR, generated from the log (0130 §5) — pure.
 *
 * **A list of sections, each `(pr) → markdown | null`, rendered in order.** A later release adds one more (the
 * *Evidence* a project's CI keeps) as one more function, with no change to the others. The syncs of 0130 §6 are never
 * listed here. Nothing about the body is stored: it is written when the PR is opened and when `lingtai pr` prints it.
 */

/** One ticket the PR holds, with the facts read for it: `open` and `spend` are null where they could not be read. */
export interface DescribedTicket {
  readonly ticket: string
  readonly title: string
  readonly mergeCommit: string
  /** Whether the ticket is still open on GitHub; null when that could not be read. */
  readonly open: boolean | null
  /** What the ticket cost, in dollars; null is unknown and is never printed as `$0`. */
  readonly spend: number | null
}

export interface DescribedPr {
  /** The title a summary run wrote, or null: the first ticket's is used. */
  readonly title: string | null
  /** The summary a `pr:` agent wrote (#1318), or null. */
  readonly summary: string | null
  /** In the order they landed. */
  readonly tickets: readonly DescribedTicket[]
}

export type PrSection = (pr: DescribedPr) => string | null

const isGithubTicket = (ticket: string): boolean => /^\d+$/.test(ticket)

const money = (usd: number): string => `$${usd.toFixed(2)}`

const spendOf = (usd: number | null): string => (usd === null ? 'spend unknown' : money(usd))

const hasSummary = (pr: DescribedPr): boolean => pr.summary !== null && pr.summary.trim() !== ''

const summarySection: PrSection = (pr) => (hasSummary(pr) ? (pr.summary ?? '').trim() : null)

const ticketsSection: PrSection = (pr) => {
  if (pr.tickets.length === 0) return null
  const lines = pr.tickets.map((t) => {
    // A ticket still open when this is written closes with the PR; GitHub ignores `Closes` on one already closed, and
    // an unreadable state is written as open.
    const name = !isGithubTicket(t.ticket)
      ? t.title
      : t.open === false
        ? `#${t.ticket} — ${t.title}`
        : `Closes #${t.ticket} — ${t.title}`
    return `- ${name} · ${t.mergeCommit.slice(0, 7)} · ${spendOf(t.spend)}`
  })
  return `${hasSummary(pr) ? '---\n\n' : ''}${lines.join('\n')}`
}

const footerSection: PrSection = (pr) => {
  const known = pr.tickets.filter((t) => t.spend !== null)
  const sum = known.reduce((total, t) => total + (t.spend ?? 0), 0)
  const spend =
    known.length === 0
      ? 'spend unknown'
      : known.length < pr.tickets.length
        ? `${money(sum)} (some unknown)`
        : money(sum)
  return `Made with Lingtai · ${pr.tickets.length} ticket${pr.tickets.length === 1 ? '' : 's'} · ${spend}`
}

/** In the order they are rendered: the summary, the tickets, the footer. */
export const PR_SECTIONS: readonly PrSection[] = [summarySection, ticketsSection, footerSection]

/** The title and body of a PR. The title is the summary run's, or else the first ticket's (0130 §5). */
export function prDescription(
  pr: DescribedPr,
  sections: readonly PrSection[] = PR_SECTIONS,
): { title: string; body: string } {
  const body = sections
    .map((section) => section(pr))
    .filter((part): part is string => part !== null && part !== '')
    .join('\n\n')
  return { title: pr.title ?? pr.tickets[0]?.title ?? 'Pull request', body }
}
