/**
 * What the Queued column reads to say why nothing runs (#1216, 0122 §8): the facts `lingtai status`
 * gathers, read the board's way. The *order* is `explainQueueEffect`'s, shared with status — the reads
 * are these.
 *
 * A seam and not a default: `askProject` takes it as an option, so a unit test of the column never
 * reaches the beacon, the lock file or the mirror.
 */
import { type BaseHead, type BaseRedLook, lookAtBase, type passOverBaseRed as PassOver } from '@lingtai/conductor'
import type { BlockedSkip } from '@lingtai/conductor/blockers'
import { explainQueueEffect, whyRows, type Beacon, type WhyNothingRuns } from '@lingtai/conductor/why-nothing-runs'
import { conductorLockHolder, lastBeat } from '@lingtai/daemon'
import { readStatusEffect } from '@lingtai/daemon/control'
import { eventStore } from '@lingtai/event-store'
import { readTasksEffect } from '@lingtai/projector'
import { branchOf } from '@lingtai/recipe/settings'
import { mirrorBranchShaEffect } from '@lingtai/repo'
import { Effect } from 'effect'

import type { AskableFilter } from './board.ts'
import { readControlOnce, readProjectLocks, readRegistered } from './locks.ts'

type Offered = Parameters<typeof PassOver>[1]

/** How the board explains a project: one look at the base before the queue is selected, one sentence after. */
export interface Explain {
  look: (filter: AskableFilter) => Effect.Effect<BaseRedLook>
  why: (input: {
    filter: AskableFilter
    look: BaseRedLook
    /** What the source offered, before the base: the facts' `offered`. */
    offered: Offered | null
    /** What the base left and the base's own skips. */
    seen: Offered | null
    runnable: readonly { issue: string }[]
    blocked: readonly BlockedSkip[]
  }) => Effect.Effect<WhyNothingRuns | null>
}

const problemOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The reads `explainQueueEffect` makes, the same for a project asked and one whose setup failed. */
const reads = (now: number, blocked: readonly BlockedSkip[] | null) => ({
  beacon: readStatusEffect().pipe(
    Effect.map((st): Beacon => (st === null ? { never: true } : { up: lastBeat(st, now).up })),
    Effect.catch((err: unknown) => Effect.succeed<Beacon>({ unread: problemOf(err) })),
  ),
  conductorHeld: Effect.tryPromise(() => conductorLockHolder()).pipe(
    Effect.map((holder) => holder !== null),
    Effect.catch(() => Effect.succeed(true)),
  ),
  blockers: Effect.succeed(blocked),
})

/** The conductor's own refusal of a project, off the registry the request already read; unread is none. */
const refusedOf = (project: string) =>
  Effect.tryPromise(() => readRegistered()).pipe(
    Effect.map((projects) => projects.find((p) => p.project === project)?.refused ?? null),
    Effect.catch(() => Effect.succeed(null)),
  )

/** The real reader: the mirror as it stands (no fetch), the beacon, the conductor lock, the locks and the drain. */
export const readWhy: Explain = {
  look: (filter) =>
    lookAtBase(
      { store: eventStore, project: filter.project, base: branchOf(filter.recipe), recipe: filter.recipe },
      mirrorBranchShaEffect({ project: filter.project, ref: `refs/heads/${branchOf(filter.recipe)}` }).pipe(
        Effect.map((head): BaseHead => ('at' in head ? head : { unreadable: 'the mirror has no such branch' })),
      ),
    ),
  why: ({ filter, look, offered, seen, runnable, blocked }) => {
    const now = Date.now()
    return Effect.gen(function* () {
      const tasks = yield* readTasksEffect({ project: filter.project })
      const read = yield* Effect.tryPromise(() => readProjectLocks())
      // A control stream that would not read cannot say a ceiling or a drain does not hold: unread, never none.
      const locks = !read.ok
        ? { unread: read.problem }
        : read.controlProblem !== undefined
          ? { unread: read.controlProblem }
          : (read.held.find((h) => h.project === filter.project)?.locks ?? [])
      const control = yield* Effect.tryPromise(() => readControlOnce()).pipe(Effect.option)
      const refused = yield* refusedOf(filter.project)
      // GitHub did not answer: the log's own queued rows are what is waiting.
      const logQueued = tasks.filter((t) => t.state === 'queued').map((t) => Number(t.issue))
      // A known red or unreadable base holds those rows as it would the listing's: the base needs no GitHub.
      const baseHolds = 'held' in look || 'unreadable' in look
      return yield* explainQueueEffect(
        {
          now: new Date(now),
          beacon: { up: true },
          // A read that failed cannot say a drain stands, and never says it does not: the lock root answers first.
          draining: control._tag === 'Some' && control.value.shutdown !== null,
          refused,
          queueUnseen: offered === null,
          locks,
          base: look,
          offered: offered === null ? logQueued : offered.runnable.map((o) => Number(o.ref)),
          runnable: runnable.map((r) => Number(r.issue)),
          skipped:
            seen === null
              ? baseHolds
                ? logQueued.map((ref) => ({ ref, reason: 'base-red' }))
                : []
              : seen.skipped.map((s) => ({ ref: s.ref, reason: s.reason })),
          rows: whyRows(tasks, filter.backoffMs, now),
          repository: filter.links?.repository ?? null,
          canListBlockers: filter.links !== null,
        },
        reads(now, blocked),
      )
    }).pipe(Effect.catch(() => Effect.succeed(null)))
  },
}

/**
 * Why nothing of a project runs when its setup failed — no GitHub credentials, a recipe that would not
 * resolve — and the conductor has recorded a refusal of it. Neither failure makes the refusal less true, so
 * the board says it where it has no filter to ask the queue with: the log's queued rows are what is waiting.
 * Null where the project has no recorded refusal, so a project the setup already explains says nothing more.
 */
export const readRefusedWhy = (project: string): Promise<WhyNothingRuns | null> => {
  const now = Date.now()
  return Effect.runPromise(
    Effect.gen(function* () {
      const refused = yield* refusedOf(project)
      if (refused === null) return null
      const tasks = yield* readTasksEffect({ project })
      const read = yield* Effect.tryPromise(() => readProjectLocks())
      const locks = !read.ok
        ? { unread: read.problem }
        : read.controlProblem !== undefined
          ? { unread: read.controlProblem }
          : (read.held.find((h) => h.project === project)?.locks ?? [])
      const control = yield* Effect.tryPromise(() => readControlOnce()).pipe(Effect.option)
      const queued = tasks.filter((t) => t.state === 'queued').map((t) => Number(t.issue))
      return yield* explainQueueEffect(
        {
          now: new Date(now),
          beacon: { up: true },
          draining: control._tag === 'Some' && control.value.shutdown !== null,
          refused,
          queueUnseen: true,
          locks,
          base: null,
          offered: queued,
          runnable: queued,
          skipped: [],
          rows: whyRows(tasks, 0, now),
          repository: null,
          canListBlockers: false,
        },
        reads(now, null),
      )
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  )
}
