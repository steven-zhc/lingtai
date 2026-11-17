/**
 * The writers of `acct-{account}`: each reads the stream, asks the pure
 * transition (`@lingtai/domain`'s `account.ts`) and appends on the transition
 * only (0126 §3). `standDownAccount` in `conduct.ts` calls `reachAccountLimit` (#1011).
 */
import {
  type Account,
  type AccountState,
  accountCheck,
  accountStream,
  githubLimitUntil,
  liftTransition,
  reachTransition,
  reduceAccount,
  type PayloadOf,
  type ToAppend,
} from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import type { GitHubFailed, RateLimitAnswer } from '@lingtai/github'
import type { ResolvedRecipe } from '@lingtai/recipe'
import { Clock, Duration, Effect } from 'effect'

import { currentRecipe } from './projects.ts'
import { runtimesOf } from './runtimes-of.ts'

export type ReachAnswer = { kind: 'appended' } | { kind: 'already'; until: Date }
export type LiftAnswer = { kind: 'appended' } | { kind: 'not-limited' }

/** The whole stream, reduced. An absent stream is `emptyAccount`. */
export const readAccount = (store: EventStore, account: Account) =>
  Effect.tryPromise({ try: () => store.read(accountStream(account)), catch: (e) => e }).pipe(
    Effect.map(reduceAccount),
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
  )

/**
 * Appends the transition at the head it was read at. A lost race re-reads once
 * and asks again; a second one fails.
 */
const transitionAccount = <A>(
  store: EventStore,
  account: Account,
  transition: (state: AccountState) => ToAppend | null,
  answer: (state: AccountState) => A,
  appended: A,
) => {
  const attempt = Effect.gen(function* () {
    const state = yield* readAccount(store, account)
    const next = transition(state)
    if (next === null) return answer(state)
    yield* Effect.tryPromise({
      try: () => store.append(accountStream(account), state.version, [next]),
      catch: (e) => e,
    })
    return appended
  })
  return attempt.pipe(
    Effect.catchIf(
      (e): e is ConcurrencyError => e instanceof ConcurrencyError,
      () => attempt,
    ),
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
  )
}

/** An attempt met the wall. Idempotent: a standing limit answers `already`, with the first `until`. */
export const reachAccountLimit = (
  store: EventStore,
  account: Account,
  fields: Omit<PayloadOf<'AccountLimitReached'>, 'account'>,
) =>
  transitionAccount<ReachAnswer>(
    store,
    account,
    (state) => reachTransition(state, account, fields),
    (state) => ({ kind: 'already', until: state.limit!.until }),
    { kind: 'appended' },
  )

/** A person says the limit is over. Idempotent: no standing limit answers `not-limited`. */
export const liftAccountLimit = (store: EventStore, account: Account, by: string) =>
  transitionAccount<LiftAnswer>(
    store,
    account,
    (state) => liftTransition(state, account, by),
    () => ({ kind: 'not-limited' }),
    { kind: 'appended' },
  )

/**
 * The guard's lift (0126 §4): appends `AccountLimitLifted` once `until` has
 * passed, and nothing otherwise. Idempotent under a race: the loser re-reads,
 * finds no limit, and appends nothing.
 */
export const liftPassedAccountLimit = (store: EventStore, account: Account, now: Date) =>
  transitionAccount<void>(
    store,
    account,
    (state) => accountCheck({ state, account, now })[0] ?? null,
    () => undefined,
    undefined,
  )

/**
 * The state of each `acct-{account}` the project uses — its recipe's runtimes, and `github` when it has an owner — and no other
 * (0126 §5). **A recipe that does not resolve gives no runtime accounts and not
 * a failure** — `github` is still there for an owned project — the project is
 * held by its refused recipe, which every start already meets, and a failure
 * here would skip it before that refusal is recorded. A store read that fails is a failure.
 */
export const accountsFor = (
  store: EventStore,
  state: ProjectState,
  recipeFor: (state: ProjectState) => Promise<ResolvedRecipe> = currentRecipe,
): Effect.Effect<ReadonlyMap<Account, AccountState>, Error> =>
  Effect.gen(function* () {
    // The owner is the project's own state and not the recipe's, so a recipe
    // that fails to resolve still leaves `github` (#1212).
    const runtimes = yield* Effect.tryPromise({ try: () => recipeFor(state), catch: (e) => e }).pipe(
      Effect.map((resolved): readonly Account[] => runtimesOf(resolved.recipe)),
      Effect.catch(() => Effect.succeed<readonly Account[]>([])),
    )
    const accounts: readonly Account[] = state.owner !== null ? [...runtimes, 'github'] : runtimes
    const entries = yield* Effect.forEach(accounts, (account) =>
      readAccount(store, account).pipe(Effect.map((reduced) => [account, reduced] as const)),
    )
    return new Map(entries)
  })

/**
 * The port a conducted GitHub client is built with (0126 §2): locks `acct-github` when a call it
 * made met a rate limit. It cannot fail — a lock that could not be written is one line on the log
 * and the call fails as it would have.
 *
 * `wait: false` (a look) answers `fail`. `wait: true` (the pass) answers `retry` after the lock's
 * `until` — the one it appended, or the standing one's — and the client lifts that to a minimum.
 * **A store failure answers `fail` even then**: with no lock on the log there is no `until` to
 * wait for, and nothing on the banner would say why the pass stood still.
 */
export const githubLimitPort =
  (store: EventStore, log: (line: string) => void, options: { wait: boolean; now?: () => Date } = { wait: false }) =>
  (failed: GitHubFailed): Effect.Effect<RateLimitAnswer, never> =>
    Effect.gen(function* () {
      // The deadline is worked out from the very state the append is asserted against: a lost
      // race re-reads and asks again, so `until` and `doublings` can never come from different reads.
      let reason = ''
      let until: Date | null = null
      const nowMs = yield* Clock.currentTimeMillis
      const now = options.now?.() ?? new Date(nowMs)
      const answer = yield* transitionAccount<ReachAnswer>(
        store,
        'github',
        (state) => {
          if (state.limit !== null) return null
          const at = githubLimitUntil({ failed, now, account: state })
          reason = at.reason
          until = at.until
          return reachTransition(state, 'github', {
            until: at.until.toISOString(),
            untilFrom: at.untilFrom,
            said: at.said,
          })
        },
        (state) => ({ kind: 'already', until: state.limit!.until }),
        { kind: 'appended' },
      )
      if (answer.kind === 'appended') log(reason)
      if (!options.wait) return { kind: 'fail' } as const
      const standing: Date | null = answer.kind === 'already' ? answer.until : until
      if (standing === null) return { kind: 'fail' } as const
      return { kind: 'retry', after: Duration.millis(Math.max(0, standing.getTime() - nowMs)) } as const
    }).pipe(
      Effect.catch((e) =>
        Effect.sync((): RateLimitAnswer => {
          log(`could not lock acct-github: ${String(e)}`)
          return { kind: 'fail' }
        }),
      ),
    )
