/**
 * What the board reads of a project's PRs (#1319): server-only, over the log and nothing else.
 *
 * **Numbers are found by `head`, never by listing streams** — `listPrs`' own rule in `@lingtai/project`. The board's
 * *is a PR open?* must be the answer `requestPrSubmit` refuses on, and a prefix listing would also take `pr-lingtai-x-3`
 * for `lingtai`'s and sort `pr-a-10` before `pr-a-9`. The one difference from `listPrs`: one unreadable stream is
 * returned as itself and the others are still read, so a card can say what it could not read.
 */
import { inProgressStepNames } from '@lingtai/conductor'
import { currentRecipe } from '@lingtai/conductor/projects'
import { conductorLockHolder } from '@lingtai/daemon'
import { prStream } from '@lingtai/domain'
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import { type PrDraftTicket, readPr, readPrDraft, readProject } from '@lingtai/project'
import { readSpendEffect } from '@lingtai/projector'
import { EVERY_LANDED_ROW_DAYS, readTasksEffect } from '@lingtai/projector/task-view'
import { type Recipe, modeOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import { viewsFor, type PlaceView } from '@/app/place-line.tsx'

import { type PrBoardView, type PrRead, prBoard } from './pr-board.ts'

const failed = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** The highest PR number with any event: one past it is the next. Zero when there is none. A failed read is an error. */
export const topPrNumber = (project: string, store: EventStore): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    let n = 0
    for (;;) {
      const head = yield* Effect.tryPromise({ try: () => store.head(prStream(project, n + 1)), catch: failed })
      if (head === 0) return n
      n++
    }
  })

/**
 * Every PR of `project`, in number order. A stream that cannot be read is `{ n, error }` in its place; a listing that
 * cannot be made fails the whole read.
 *
 * With `since`, merged PRs are read newest first and the read stops at the first one merged before it — an open PR is
 * always read, and only the highest one can be open. Nothing older is returned then, which is what #1321 asks.
 */
export const readProjectPrs = (
  project: string,
  store: EventStore,
  options: { since?: Date } = {},
): Effect.Effect<PrRead[], Error> =>
  Effect.gen(function* () {
    const top = yield* topPrNumber(project, store)
    const reads: PrRead[] = []
    for (let n = top; n >= 1; n--) {
      const read = yield* readPr(project, n, store).pipe(Effect.result)
      if (read._tag === 'Failure') {
        reads.push({ n, error: read.failure.message })
        continue
      }
      if (read.success === null) continue
      const pr = read.success
      reads.push({ n, pr })
      if (options.since !== undefined && pr.status === 'merged' && pr.ended !== null && pr.ended.at < options.since)
        break
    }
    return reads.reverse()
  })

/** The count of PRs waiting on the person, reading only the highest PR (one at a time, so no other can wait). */
export const waitingPrs = (project: string, store: EventStore): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const top = yield* topPrNumber(project, store)
    if (top === 0) return 0
    const pr = yield* readPr(project, top, store)
    return pr !== null && pr.status === 'waiting' ? 1 : 0
  })

/** What the board knows of a project's PRs, or why it could not be known. */
export type PrsRead =
  | { readonly kind: 'solo'; readonly recipe: Recipe }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'team'; readonly recipe: Recipe; readonly view: PrBoardView }

/** The page's one read: the recipe, the PRs, the draft (over every landed ticket, never the two-day window), spend. */
export async function readPrPage(project: string): Promise<PrsRead> {
  const state = await readProject(project).catch(() => null)
  if (state === null || state === undefined || !state.owner) return { kind: 'unknown' }
  try {
    const { recipe } = await currentRecipe(state)
    if (modeOf(recipe) !== 'team') return { kind: 'solo', recipe }
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        const prs = yield* readProjectPrs(project, eventStore)
        const cards = yield* readTasksEffect({ project, retentionDays: EVERY_LANDED_ROW_DAYS }).pipe(
          Effect.mapError(failed),
        )
        const draft: PrDraftTicket[] = yield* readPrDraft(
          project,
          recipe,
          cards.map((c) => ({ issue: c.issue })),
          eventStore,
        )
        const rows = yield* readSpendEffect({ project }).pipe(Effect.mapError(failed))
        const spend = new Map<number, number>()
        for (const row of rows) {
          if (row.costUsd === null) continue
          for (const read of prs) {
            if (row.streamId === prStream(project, read.n)) spend.set(read.n, (spend.get(read.n) ?? 0) + row.costUsd)
          }
        }
        const waitingForServe = prs.some((r) => 'pr' in r && r.pr.status === 'requested')
        const holder = waitingForServe
          ? yield* Effect.tryPromise({ try: () => conductorLockHolder(), catch: failed }).pipe(
              Effect.orElseSucceed(() => 'unknown' as string | null),
            )
          : null
        return prBoard({
          project,
          recipe,
          prs,
          draft,
          stepNames: inProgressStepNames(),
          spend,
          servedWords: servedWords(holder),
          newFixHref: `https://github.com/${state.owner}/${project}/issues/new?labels=${encodeURIComponent('lingtai:pr-fix')}`,
        })
      }),
    )
    return { kind: 'team', recipe, view }
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
}

/** Who serves a submitted PR, in one sentence: the CLI's words, from one place. */
export const servedWords = (holder: string | null): string =>
  holder === null
    ? 'it is served when a conductor runs: lingtai start, or lingtai run'
    : holder === 'unknown'
      ? 'could not tell whether a conductor is running; lingtai doctor says'
      : `${holder} is freezing it`

/**
 * The place line's views for a project: `viewsFor` with the `PRs` view a team project has and its count of PRs waiting
 * on the person. **A count that could not be read is `null`, never 0** — the view stays and the badge is absent.
 */
export async function placeViewsOf(project: string | undefined): Promise<PlaceView[]> {
  if (project === undefined) return viewsFor(undefined)
  const state = await readProject(project).catch(() => null)
  if (state === null || state === undefined || !state.owner) return viewsFor(project)
  let recipe: Recipe
  try {
    recipe = (await currentRecipe(state)).recipe
  } catch {
    return viewsFor(project)
  }
  if (modeOf(recipe) !== 'team') return viewsFor(project)
  const waiting = await Effect.runPromise(waitingPrs(project, eventStore)).catch(() => null)
  return viewsFor(project, { waiting })
}
