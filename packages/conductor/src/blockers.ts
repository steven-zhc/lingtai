import { Effect } from 'effect'

import { BLOCKERS_PAGE, type LandedOptions, type Offered } from './discover.ts'
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
  /** Why a team project's queue could not release it by what landed on the personal branch (#1423), when it could not. */
  held?: string
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
    // What discovery read for this very operation rides on the skip, so it is never read a second time (#1423).
    blockers: s.blockersRead ?? null,
    unread: links !== null && s.blockersRead === undefined && i >= BLOCKERS_READ_MOST,
    ...(blocked[i]!.held === undefined ? {} : { held: blocked[i]!.held }),
  }))
  if (links === null) return Effect.succeed(out)
  const at = now()
  const reads = out.slice(0, BLOCKERS_READ_MOST).map((entry) => {
    if (entry.blockers !== null) return Effect.void
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

/**
 * A link reader that answers from, and fills, the same cache `readBlockersEffect` reads (#1423): the discovery read
 * of a blocked ticket's blockers and the board's or status's explaining it are one request, not two. For the board
 * and `lingtai status` only; the conductor reads fresh, since it keeps no state across a pass.
 */
export function cachedBlockers(
  project: string,
  links: TicketLinks,
  now: () => number = Date.now,
): LandedOptions['links'] | null {
  if (links === null) return null
  return {
    // A getter, as `ticketLinksOf`'s is: building this reads nothing from the client.
    get repository() {
      return links.repository
    },
    listBlockedBy: (issue, blockedBy) => {
      const key = `${project}#${issue}`
      const count = blockedBy ?? null
      const hit = blockerCache.get(key)
      if (hit && hit.blockedBy === count && now() - hit.at < BLOCKERS_FRESH_MS) {
        return hit.blockers.ok ? Promise.resolve(hit.blockers.issues) : Promise.reject(new Error(hit.blockers.problem))
      }
      const at = now()
      return links.listBlockedBy(issue, true).then(
        (issues) => {
          // A full page may be the start of a longer list: the explaining read must not draw from it.
          if (issues.length < BLOCKERS_PAGE)
            blockerCache.set(key, { blockedBy: count, at, blockers: { ok: true, issues } })
          return issues
        },
        (error: unknown) => {
          const problem = error instanceof Error ? error.message : String(error)
          blockerCache.set(key, { blockedBy: count, at, blockers: { ok: false, problem } })
          throw error
        },
      )
    },
  }
}
