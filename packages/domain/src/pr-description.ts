/**
 * The description of a PR, generated from the log (0131 §5) — pure.
 *
 * **A list of sections, each `(pr) → markdown | null`, rendered in order.** A later release adds one more (the
 * *Evidence* a project's CI keeps) as one more function, with no change to the others. The syncs of 0130 §6 are never
 * listed here. Nothing about the body is stored: it is written when the PR is opened and when `lingtai pr` prints it.
 */

/** One ticket the PR holds, with the fact read for it: `open` is null where it could not be read. */
export interface DescribedTicket {
  readonly ticket: string
  readonly title: string
  /** Whether the ticket is still open on GitHub; null when that could not be read. */
  readonly open: boolean | null
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

const hasSummary = (pr: DescribedPr): boolean => pr.summary !== null && pr.summary.trim() !== ''

const summarySection: PrSection = (pr) => (hasSummary(pr) ? (pr.summary ?? '').trim() : null)

const ticketsSection: PrSection = (pr) => {
  if (pr.tickets.length === 0) return null
  const summarised = hasSummary(pr)
  // A ticket still open when this is written closes with the PR; GitHub ignores `Closes` on one already closed, and an
  // unreadable state is written as open.
  const closing = pr.tickets.filter((t) => isGithubTicket(t.ticket) && t.open !== false)
  const closes = closing.length === 0 ? null : closing.map((t) => `Closes #${t.ticket}`).join(', ')
  // With a summary it names the tickets; without one the list is the only content (0131 §5).
  const list = summarised
    ? []
    : pr.tickets.map((t) => {
        const number = isGithubTicket(t.ticket) ? `#${t.ticket}` : null
        const parts = [t.title, number === null ? null : t.title === '' ? number : `(${number})`].filter(
          (part): part is string => part !== null && part !== '',
        )
        return `- ${parts.join(' ')}`
      })
  const body = [list.length === 0 ? null : list.join('\n'), closes].filter((part): part is string => part !== null)
  if (body.length === 0) return null
  return `${summarised ? '---\n\n' : ''}${body.join('\n\n')}`
}

const footerSection: PrSection = (pr) =>
  `Made with Lingtai · ${pr.tickets.length} ticket${pr.tickets.length === 1 ? '' : 's'}`

/** The sections Lingtai writes itself, under the person's or the agent's summary. */
export const GENERATED_SECTIONS: readonly PrSection[] = [ticketsSection, footerSection]

/** In the order they are rendered: the summary, the tickets, the footer. */
export const PR_SECTIONS: readonly PrSection[] = [summarySection, ...GENERATED_SECTIONS]

/** The title and body of a PR. The title is the summary run's, or else the first ticket's (0131 §5). */
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
