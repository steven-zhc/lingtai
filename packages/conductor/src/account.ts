/**
 * The writers of `acct-{runtime}`: each reads the stream, asks the pure
 * transition (`@lingtai/domain`'s `account.ts`) and appends on the transition
 * only (0126 §3). Nothing calls `reachAccountLimit` yet — #1011 does.
 */
import {
  type AccountState,
  accountCheck,
  accountStream,
  liftTransition,
  reachTransition,
  reduceAccount,
  type PayloadOf,
  type RuntimeId,
  type ToAppend,
} from '@lingtai/domain'
import type { ProjectState } from '@lingtai/domain'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import type { ResolvedRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'

import { currentRecipe } from './projects.ts'
import { runtimesOf } from './runtimes-of.ts'

export type ReachAnswer = { kind: 'appended' } | { kind: 'already'; until: Date }
export type LiftAnswer = { kind: 'appended' } | { kind: 'not-limited' }

/** The whole stream, reduced. An absent stream is `emptyAccount`. */
export const readAccount = (store: EventStore, runtime: RuntimeId) =>
  Effect.tryPromise({ try: () => store.read(accountStream(runtime)), catch: (e) => e }).pipe(
    Effect.map(reduceAccount),
    Effect.mapError((e) => (e instanceof Error ? e : new Error(String(e)))),
  )

/**
 * Appends the transition at the head it was read at. A lost race re-reads once
 * and asks again; a second one fails.
 */
const transitionAccount = <A>(
  store: EventStore,
  runtime: RuntimeId,
  transition: (state: AccountState) => ToAppend | null,
  answer: (state: AccountState) => A,
  appended: A,
) => {
  const attempt = Effect.gen(function* () {
    const state = yield* readAccount(store, runtime)
    const next = transition(state)
    if (next === null) return answer(state)
    yield* Effect.tryPromise({
      try: () => store.append(accountStream(runtime), state.version, [next]),
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
  runtime: RuntimeId,
  fields: Omit<PayloadOf<'AccountLimitReached'>, 'runtime'>,
) =>
  transitionAccount<ReachAnswer>(
    store,
    runtime,
    (state) => reachTransition(state, runtime, fields),
    (state) => ({ kind: 'already', until: state.limit!.until }),
    { kind: 'appended' },
  )

/** A person says the limit is over. Idempotent: no standing limit answers `not-limited`. */
export const liftAccountLimit = (store: EventStore, runtime: RuntimeId, by: string) =>
  transitionAccount<LiftAnswer>(
    store,
    runtime,
    (state) => liftTransition(state, runtime, by),
    () => ({ kind: 'not-limited' }),
    { kind: 'appended' },
  )

/**
 * The guard's lift (0126 §4): appends `AccountLimitLifted` once `until` has
 * passed, and nothing otherwise. Idempotent under a race: the loser re-reads,
 * finds no limit, and appends nothing.
 */
export const liftPassedAccountLimit = (store: EventStore, runtime: RuntimeId, now: Date) =>
  transitionAccount<void>(
    store,
    runtime,
    (state) => accountCheck({ state, runtime, now })[0] ?? null,
    () => undefined,
    undefined,
  )

/**
 * The state of each `acct-{runtime}` the project's recipe uses, and no other
 * (0126 §5). **A recipe that does not resolve gives the empty map and not a
 * failure**: the project is held by its refused recipe, which every start
 * already meets, and a failure here would skip it before that refusal is
 * recorded. A store read that fails is a failure.
 */
export const accountsFor = (
  store: EventStore,
  state: ProjectState,
  recipeFor: (state: ProjectState) => Promise<ResolvedRecipe> = currentRecipe,
): Effect.Effect<ReadonlyMap<RuntimeId, AccountState>, Error> =>
  Effect.gen(function* () {
    const runtimes = yield* Effect.tryPromise({ try: () => recipeFor(state), catch: (e) => e }).pipe(
      Effect.map((resolved) => runtimesOf(resolved.recipe)),
      Effect.catch(() => Effect.succeed<readonly RuntimeId[]>([])),
    )
    const entries = yield* Effect.forEach(runtimes, (runtime) =>
      readAccount(store, runtime).pipe(Effect.map((account) => [runtime, account] as const)),
    )
    return new Map(entries)
  })
