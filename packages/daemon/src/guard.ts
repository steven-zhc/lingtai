import { accountsFor, liftPassedAccountLimit } from '@lingtai/conductor'
import {
  CONTROL_STREAM,
  NO_ACCOUNTS,
  ceilingCheck,
  type ControlState,
  type Lock,
  lockSentence,
  locksOn,
  projectStream,
  reduceProject,
} from '@lingtai/domain'
import { ConcurrencyError, type EventStore, type SnapshotStore } from '@lingtai/event-store'
import { Cause, Data, Effect } from 'effect'

import { readControlEffect } from './control.ts'

/**
 * The one entry every gate asks before it starts work (0126 §4).
 *
 * A gate never reads `prj-` and never calls `locksOn`: it is handed `locked`
 * (`lockedEffect`, below), built from a guard. That is what lets the day ceiling and
 * the account limit arrive as **checks run inside `locksFor`** — each
 * appends its own lock and unlock on a transition before it answers — without
 * one gate being touched. A check is one function added to `CHECKS`, not a branch
 * in a gate.
 *
 * Asked at the moment a gate would start work, every time, never cached across a
 * look: the answer is a fact about the moment it is asked (#861).
 */
export interface Guard {
  /** Rejects as the read does: unknown is not *unlocked*. A `CeilingUnchecked` is the ceiling's own. */
  locksFor(project: string): Effect.Effect<readonly Lock[], Error>
}

/** Today's spend, or the daily ceiling, could not be trusted: a stop that is not stored. */
export class CeilingUnchecked extends Data.TaggedError('CeilingUnchecked')<{ readonly why: string }> {}

/**
 * What the guard needs of the ceiling and cannot read itself: the spend trust
 * checks live in `apps/cli`, which this package cannot import.
 */
export interface CeilingPort {
  /** The configured figure, read per call. Throws where it does not parse. */
  configuredUsd: () => number | undefined
  /** Today's spend, or why it cannot be trusted. Read only where a figure is configured. */
  todaysSpend: (now: Date) => Effect.Effect<{ reportedCents: number; estimatedCents: number }, CeilingUnchecked>
}

/** An `acct-` read failed: the account's state is unknown, and unknown is not *not limited*. */
export class AccountUnchecked extends Data.TaggedError('AccountUnchecked')<{ readonly why: string }> {}

export interface GuardOptions {
  store: EventStore
  /** The project's resolved recipe, for the runtimes it uses. Defaults to `currentRecipe`. */
  recipeFor?: Parameters<typeof accountsFor>[2]
  /** Accepted for the checks that will fold a snapshotted stream; the Project aggregate is not one. */
  snapshots?: SnapshotStore
  /**
   * The ceiling, and required so a gate built without it fails typecheck rather
   * than skipping it. `'not-the-holder'` is for a caller that does not hold the
   * conductor lock (`lingtai now`): the system locks are written by the lock
   * holder only (0126 §4), so it reads the stored ceiling lock, appends nothing
   * and reads no spend. A `reached` from yesterday refuses it until the next
   * look, at most five minutes away, lifts it.
   */
  ceiling: CeilingPort | 'not-the-holder'
  now?: () => Date
}

type Check = (options: GuardOptions, project: string) => Effect.Effect<readonly Lock[], Error>

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** A person's pause of this project: `prj-{project}`, read whole, fresh. */
const projectPause: Check = ({ store }, project) =>
  Effect.tryPromise({ try: () => store.read(projectStream(project)), catch: asError }).pipe(
    Effect.map((events) => locksOn({ project: reduceProject(events), accounts: NO_ACCOUNTS })),
  )

/**
 * The day's ceiling (0126 §3, §4): bring `ctl-conductor` up to the present,
 * appending `DayCeilingReached` or `DayCeilingLifted` on the transition only,
 * and answer the lock. Appends at the head it read; on a concurrency error it
 * reads again once and decides again, as `raiseDayCeiling` does.
 */
const dayCeiling: Check = ({ store, snapshots, ceiling, now }) =>
  Effect.gen(function* () {
    const readState = (): Effect.Effect<ControlState, Error> =>
      readControlEffect(store, { snapshots }).pipe(Effect.mapError(asError))
    if (ceiling === 'not-the-holder') return locksOn({ control: yield* readState(), accounts: NO_ACCOUNTS })

    const at = (now ?? (() => new Date()))()
    // Before anything is appended, so a figure or a spend that cannot be trusted
    // lifts nothing either (#650): unknown is not *under the ceiling*.
    const configuredUsd = yield* Effect.try({
      try: ceiling.configuredUsd,
      catch: (err) => new CeilingUnchecked({ why: asError(err).message }),
    })
    const spend = configuredUsd === undefined ? { reportedCents: 0, estimatedCents: 0 } : yield* ceiling.todaysSpend(at)

    const attempt = Effect.gen(function* () {
      const head = yield* Effect.tryPromise({ try: () => store.head(CONTROL_STREAM), catch: asError })
      const state = yield* readState()
      const events = ceilingCheck({ state, now: at, configuredUsd, ...spend })
      if (events.length === 0) return state
      yield* Effect.tryPromise({ try: () => store.append(CONTROL_STREAM, head, [...events]), catch: asError })
      return yield* readState()
    })
    const state = yield* attempt.pipe(
      Effect.catch((err: Error) => (err instanceof ConcurrencyError ? attempt : Effect.fail(err))),
    )
    return locksOn({ control: state, accounts: NO_ACCOUNTS })
  })

/**
 * Each account limit the project's recipe uses (0126 §4, §5): bring each
 * `acct-{runtime}` up to the present, appending `AccountLimitLifted` once its
 * `until` has passed, and answer the locks that stand. A guard that is not the
 * holder appends nothing, as the ceiling's does. A recipe that does not resolve
 * gives no account lock (`accountsFor`).
 */
const accountLimits: Check = ({ store, recipeFor, ceiling, now }, project) =>
  Effect.gen(function* () {
    const events = yield* Effect.tryPromise({ try: () => store.read(projectStream(project)), catch: asError })
    const state = reduceProject(events)
    const read = accountsFor(store, state, recipeFor).pipe(
      Effect.mapError((err) => new AccountUnchecked({ why: err.message })),
    )
    if (ceiling !== 'not-the-holder') {
      const at = (now ?? (() => new Date()))()
      const before = yield* read
      yield* Effect.forEach([...before.keys()], (runtime) =>
        liftPassedAccountLimit(store, runtime, at).pipe(
          Effect.mapError((err) => new AccountUnchecked({ why: `${runtime}: ${err.message}` })),
        ),
      )
    }
    return locksOn({ accounts: yield* read })
  })

// The order is 0126 §8's: the ceiling, each account limit, then a person's pause.
const CHECKS: readonly Check[] = [dayCeiling, accountLimits, projectPause]

export function makeGuard(options: GuardOptions): Guard {
  return {
    locksFor: (project) =>
      Effect.forEach(CHECKS, (check) => check(options, project)).pipe(Effect.map((all) => all.flat())),
  }
}

/** The sentence a `locksFor` failure is answered with: the ceiling's own, or the pause read's. */
export const lockFailure = (project: string, err: Error): string =>
  err instanceof CeilingUnchecked
    ? `could not check the daily ceiling: ${err.why} — taking no work`
    : err instanceof AccountUnchecked
      ? `could not read whether ${project} is locked — ${err.why}`
      : `could not read whether ${project} is paused — ${err.message}`

/**
 * A gate's `locked` callback, as an Effect: the sentence that stops a start, or null. It never
 * fails — a read that fails answers a sentence (*could not read whether <project> is paused*, or
 * *could not check the daily ceiling*), so the project is not started and the next look asks
 * again (unknown is not *unlocked*): a read that fails
 * *or dies* answers the same sentence (`catchCause`, not `Effect.catch`), so a check that throws
 * is a project not started rather than a look that ends. An interruption passes through.
 */
export const lockedEffect =
  (guard: Guard): ((project: string) => Effect.Effect<string | null>) =>
  (project) =>
    guard.locksFor(project).pipe(
      Effect.map((locks) => lockSentence(project, locks)),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.succeed<string | null>(lockFailure(project, Cause.squash(cause) as Error)),
      ),
    )
