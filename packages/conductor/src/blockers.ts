import { Effect } from 'effect'

import type { Offered } from './discover.ts'
import type { TicketLink, TicketLinks } from './filter.ts'

/**
 * One `blocked-by` skip with its blockers read (#954, #1215): data only.
 *
 * `blockers: null` is two things, told apart by `unread`: false means no link
 * reader was available and nothing was asked; true means the skip was past
 * `BLOCKERS_READ_MOST` and was counted rather than read. A failure is the
 * error's message, because this crosses into a client component.
 */
export type BlockedSkip = {
  project: string
  ref: number
  title: string
  kind: string | null
  blockedBy: number | null
  blockers: { ok: true; issues: readonly TicketLink[] } | { ok: false; problem: string } | null
  unread: boolean
}

/** The most `blocked-by` skips per project whose blockers are read, lowest number first. */
export const BLOCKERS_READ_MOST = 20
/** How long a read blocker list is trusted while the count is unchanged. */
export const BLOCKERS_FRESH_MS = 60_000

type BlockerRead = NonNullable<BlockedSkip['blockers']>
const blockerCache = new Map<string, { blockedBy: number | null; at: number; blockers: BlockerRead }>()

/** Forgets every cached blocker list, so a test can start from *nothing read*. */
export function forgetBlockers(): void {
  blockerCache.clear()
}

/**
 * Reads the blockers of each `blocked-by` skip, through the per-process cache.
 * Never fails: one failed read is that skip's `ok: false`. The board and
 * `lingtai status` both call this one function.
 */
export const readBlockersEffect = (
  owner: { project: string; links: TicketLinks },
  skipped: Offered['skipped'],
  now: () => number,
): Effect.Effect<BlockedSkip[]> => {
  const blocked = skipped.filter((s) => s.reason === 'blocked-by').sort((a, b) => a.ref - b.ref)
  const links = owner.links ?? null
  const out: BlockedSkip[] = blocked.map((s, i) => ({
    project: owner.project,
    ref: s.ref,
    title: s.title,
    kind: s.kind,
    blockedBy: s.blockedBy,
    blockers: null,
    unread: links !== null && i >= BLOCKERS_READ_MOST,
  }))
  if (links === null) return Effect.succeed(out)
  const at = now()
  const reads = out.slice(0, BLOCKERS_READ_MOST).map((entry) => {
    const key = `${owner.project}#${entry.ref}`
    const hit = blockerCache.get(key)
    if (hit && hit.blockedBy === entry.blockedBy && at - hit.at < BLOCKERS_FRESH_MS) {
      entry.blockers = hit.blockers
      return Effect.void
    }
    return Effect.tryPromise({
      try: () => links.listBlockedBy(entry.ref),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(
      Effect.match({
        onSuccess: (issues): BlockerRead => ({ ok: true, issues }),
        onFailure: (problem): BlockerRead => ({ ok: false, problem }),
      }),
      Effect.map((blockers) => {
        entry.blockers = blockers
        blockerCache.set(key, { blockedBy: entry.blockedBy, at, blockers })
      }),
    )
  })
  return Effect.all(reads, { concurrency: 'unbounded' }).pipe(Effect.as(out))
}
