/**
 * A red base is the project's, not a ticket's (#1208, 0108 §13, 0122 §2).
 *
 * Leaving flakes aside (§17 runs a red base check twice), a base turns green only when a commit lands on it, so
 * *is it green yet* is *has the base's head moved* — a comparison of two shas, never a watch. Nothing here
 * checks anything: the log says what the last check found, the mirror says where the base is, and the next
 * attempt claimed asks the question itself before an agent is paid.
 */
import { baseStateOf, integrationStream, type BaseState } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import type { Recipe } from '@lingtai/recipe'
import type { TokenSource } from '@lingtai/repo'
import { Effect, Result } from 'effect'

import type { Offered } from './discover.ts'
import { Repo, type BaseHeadOptions } from './ports.ts'

/** The reason the queue gives a ticket it passed over for a red base: what `passedOver` counts. */
export const BASE_RED = 'base-red' as const

/** The recipe's `build` list as the plain `run:` actions `baseStateOf` reads. */
export function buildRunsOf(recipe: Recipe): { name: string; run: string }[] {
  return recipe.steps.build.flatMap((action) =>
    'run' in action && typeof action.run === 'string' ? [{ name: action.name, run: action.run }] : [],
  )
}

/** The project's base state off the log alone, or why the log could not be read. Unread is never green. */
export const baseStateEffect = (options: {
  store: Pick<EventStore, 'read'>
  project: string
  base: string
  recipe: Recipe
}): Effect.Effect<BaseState | { unread: string }> =>
  Effect.gen(function* () {
    const read = yield* Effect.result(
      Effect.tryPromise({
        try: () => options.store.read(integrationStream(options.project, options.base)),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    )
    if (Result.isFailure(read)) return { unread: read.failure }
    return baseStateOf(read.success, () => buildRunsOf(options.recipe))
  })

/** What the look found about the project's base. */
export type BaseRedLook =
  /** Not red: nothing is passed over. */
  | { clear: true }
  /** Red, and the base's head is still the commit the red was recorded on. */
  | { held: { command: string; baseSha: string; base: string } }
  /** Red once, and the head has moved since: the next attempt claimed checks first. */
  | { moved: true }
  /** The log or the mirror could not be read: nothing is taken this look. */
  | { unreadable: string }

/** Where the base's head is, or why it could not be read. */
export type BaseHead = { readonly at: string } | { readonly unreadable: string }

/** The look's head reader: the mirror fetched first, by the one `Repo` the daemon holds (#1208). */
export const fetchedHead = (options: Omit<BaseHeadOptions, 'project' | 'base'> & { project: string; base: string }) =>
  Effect.gen(function* () {
    const repo = yield* Repo
    return yield* repo.baseHead(options)
  })

/**
 * What a look makes of the project's base. **The head is read only when the state is red**; a base that is
 * green, or never checked, costs no fetch at all. `head` is how: the daemon's look fetches, a status read
 * does not.
 */
export const lookAtBase = <R>(
  options: { store: Pick<EventStore, 'read'>; project: string; base: string; recipe: Recipe },
  head: Effect.Effect<BaseHead, never, R>,
): Effect.Effect<BaseRedLook, never, R> =>
  Effect.gen(function* () {
    const state = yield* baseStateEffect(options)
    if ('unread' in state) return { unreadable: `the base's log could not be read: ${state.unread}` }
    if ('notRed' in state) return { clear: true }
    const found = yield* head
    if ('unreadable' in found) return { unreadable: found.unreadable }
    return found.at === state.red.baseSha
      ? { held: { command: state.red.command, baseSha: state.red.baseSha, base: state.red.base } }
      : { moved: true }
  })

/**
 * Passes the offered tickets over for a red base. `held` skips every one with reason `base-red`; `unreadable`
 * skips them too, because a base that could not be read is not a green one. Pure: the sentence for the look's
 * log comes back beside the list, and the repository's own skips keep their order ahead of it.
 */
export function passOverBaseRed(look: BaseRedLook, offered: Offered): { offered: Offered; line: string | null } {
  if ('clear' in look || 'moved' in look) return { offered, line: null }
  const n = offered.runnable.length
  const line =
    'held' in look
      ? `base-red: \`${look.held.command}\` failed on ${look.held.baseSha.slice(0, 7)}; ${n} passed over until ${look.held.base} moves`
      : `base-red: ${look.unreadable} — ${n} passed over this look`
  return {
    offered: {
      ...offered,
      runnable: [],
      skipped: [
        ...offered.skipped,
        ...offered.runnable.map((entry) => ({
          ref: Number(entry.ref),
          reason: BASE_RED,
          label: null,
          title: entry.title,
          kind: entry.kind,
          blockedBy: null,
          parent: entry.parent,
          subIssues: entry.subIssues,
        })),
      ],
    },
    line,
  }
}

/**
 * The look's whole question in one Effect: the base's state off the log, the mirror fetched only when it is
 * red, and the offered tickets passed over accordingly. Shared by every path that picks a ticket to claim —
 * the queue's and a `now` request's — so neither can take one the other would pass over (#1208).
 */
export const passOverForRedBase = (options: {
  store: Pick<EventStore, 'read'>
  project: string
  recipe: Recipe
  base: string
  owner: string
  repo: string
  offered: Offered
  token?: TokenSource
  remote?: string
  home?: string
  gitEnv?: NodeJS.ProcessEnv
}) =>
  Effect.gen(function* () {
    if (options.offered.runnable.length === 0) return { offered: options.offered, line: null as string | null }
    const looked = yield* lookAtBase(
      { store: options.store, project: options.project, base: options.base, recipe: options.recipe },
      fetchedHead({
        project: options.project,
        base: options.base,
        owner: options.owner,
        repo: options.repo,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.remote === undefined ? {} : { remote: options.remote }),
        ...(options.home === undefined ? {} : { home: options.home }),
        ...(options.gitEnv === undefined ? {} : { gitEnv: options.gitEnv }),
      }),
    )
    return passOverBaseRed(looked, options.offered)
  })
