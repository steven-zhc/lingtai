/**
 * Where a team project's landed ticket is (#1321): on the person's branch, in an open PR, or merged — from the PRs and
 * the draft #1319 reads, and never from the card, which carries no base branch. **A ticket in neither the draft nor any
 * PR has no tag**: it landed on `main` before the project was team, or the read failed — never a guess.
 */
import type { PrDraftTicket } from '@lingtai/project'

import { type PrRead, prName } from './pr-board.ts'

/** What one team project's PR read answered. */
export type LandedWhereRead =
  | { readonly kind: 'solo' }
  | { readonly kind: 'failed'; readonly error: string }
  | {
      readonly kind: 'team'
      readonly prs: readonly PrRead[]
      readonly draft: readonly PrDraftTicket[] | { readonly error: string }
    }

export type Where =
  | { readonly tag: 'branch' }
  | { readonly tag: 'pr'; readonly name: string; readonly n: number }
  | { readonly tag: 'merged'; readonly name: string; readonly n: number }
  | null

const OPEN = new Set(['requested', 'in-progress', 'waiting', 'in-review'])

export const whereLanded = (ticket: string, read: LandedWhereRead | undefined): Where => {
  if (read === undefined || read.kind !== 'team') return null
  for (const r of read.prs) {
    if (!('pr' in r)) continue
    const pr = r.pr
    // What the merged head held, never what the PR holds now: a pr-fix landed after the merge is not merged.
    if (pr.status === 'merged' && pr.mergedTickets.includes(ticket)) return { tag: 'merged', name: prName(pr), n: r.n }
  }
  for (const r of read.prs) {
    if (!('pr' in r)) continue
    const pr = r.pr
    if (pr.status !== null && OPEN.has(pr.status) && pr.tickets.some((t) => t.ticket === ticket))
      return { tag: 'pr', name: prName(pr), n: r.n }
  }
  if (!('error' in read.draft) && read.draft.some((t) => t.ticket === ticket)) return { tag: 'branch' }
  return null
}

const STATE_WORD: Record<string, string> = {
  requested: 'in progress',
  'in-progress': 'in progress',
  waiting: 'waiting on you',
  'in-review': 'in review',
}

/** The foot line's words, or null when there is nothing to say. */
export type FootLine =
  | { readonly kind: 'unread' }
  | { readonly kind: 'line'; readonly draft: number | null; readonly open: string | null }

export const footLine = (read: LandedWhereRead | undefined): FootLine | null => {
  if (read === undefined || read.kind === 'solo') return null
  if (read.kind === 'failed' || 'error' in read.draft) return { kind: 'unread' }
  let open: string | null = null
  for (const r of read.prs)
    if ('pr' in r && r.pr.status !== null && OPEN.has(r.pr.status))
      open = `${prName(r.pr)} ${STATE_WORD[r.pr.status] ?? r.pr.status}`
  const draft = read.draft.length > 0 ? read.draft.length : null
  return draft === null && open === null ? null : { kind: 'line', draft, open }
}
