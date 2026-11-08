/**
 * Where a project's tickets come from, decided from what has been read — pure,
 * so `askTickets` (a question) and `proposeSetup` (a proposal) share one rule
 * and neither writes it twice (#974).
 */

export type TicketSourceName = 'github' | 'db'

/**
 * The source a project holds: the recipe's own `source.tickets` where it names
 * one, else what the log's history proves, else `github` (the schema default).
 * A `db ticket #<n>` entry is only ever written by `dbTickets.createIssue`, so
 * it is decisive even where there is no file at all (#432 fix round, finding 1).
 */
export function ticketSourceOf(rawTickets: unknown, history: readonly string[]): TicketSourceName {
  return rawTickets === 'db' || (rawTickets === null && history.some((h) => h.startsWith('db ticket #')))
    ? 'db'
    : 'github'
}

/** `owner/repo` of a remote URL on github.com, or null for any other host or shape. */
export function githubSlugOfRemote(url: string): { owner: string; repo: string } | null {
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim()) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m === null ? null : { owner: m[1]!, repo: m[2]! }
}
