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
import { type PrState, isOpen, prStream, reducePr } from '@lingtai/domain'
import { githubClientAuth, hasGitHubAuth } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, makeGitHub } from '@lingtai/github'
import { type PrDraftTicket, readPr, readPrDraft, readPrEvents, readProject } from '@lingtai/project'
import { readSpendEffect } from '@lingtai/projector'
import { EVERY_LANDED_ROW_DAYS, readTasksEffect } from '@lingtai/projector/task-view'
import { type Recipe, modeOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import { viewsFor, type PlaceView } from '@/app/place-line.tsx'

import { type PrBoardView, type PrRead, prBoard, prName } from './pr-board.ts'
import { type HostRead, type PrPageView, githubHosted, prFixTicketLink, prPage, ticketsOnGitHub } from './pr-page.ts'

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

/**
 * The draft, decided from every PR's tickets, so one stream that could not be read leaves it unknown — said as such where
 * the draft would be, while every PR that was read is still drawn. **Never an empty draft** for a read that failed. The PRs
 * board and a PR's page both ask here, so the two cannot decide the draft differently.
 */
export const readDraftOf = (
  project: string,
  recipe: Recipe,
  prs: readonly PrRead[],
): Effect.Effect<PrDraftTicket[] | { error: string }> => {
  const unread = prs.find((r) => !('pr' in r))
  if (unread !== undefined) return Effect.succeed({ error: `PR ${unread.n} could not be read` })
  return Effect.gen(function* () {
    const cards = yield* readTasksEffect({ project, retentionDays: EVERY_LANDED_ROW_DAYS }).pipe(
      Effect.mapError(failed),
    )
    return yield* readPrDraft(
      project,
      recipe,
      cards.map((c) => ({ issue: c.issue })),
      eventStore,
      prs.flatMap((r) => ('pr' in r ? [r.pr] : [])),
    )
  }).pipe(Effect.catch((err) => Effect.succeed({ error: err.message })))
}

/** Reported spend on each PR's stream, by `n`. A PR with nothing reported is absent: unknown, never `$0`. */
export const spendByPr = (project: string, ns: readonly number[]): Effect.Effect<Map<number, number>, Error> =>
  Effect.gen(function* () {
    const rows = yield* readSpendEffect({ project }).pipe(Effect.mapError(failed))
    const spend = new Map<number, number>()
    for (const row of rows) {
      if (row.costUsd === null) continue
      for (const n of ns) if (row.streamId === prStream(project, n)) spend.set(n, (spend.get(n) ?? 0) + row.costUsd)
    }
    return spend
  })

/** What the board knows of a project's PRs, or why it could not be known. */
export type PrsRead =
  | { readonly kind: 'solo'; readonly recipe: Recipe }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'team'; readonly recipe: Recipe; readonly view: PrBoardView }

/** The page's one read: the recipe, the PRs, the draft (over every landed ticket, never the two-day window), spend. */
export async function readPrPage(project: string): Promise<PrsRead> {
  // A project that is not registered is `null`; a read that rejected is a failure, never *no such project*.
  let state: Awaited<ReturnType<typeof readProject>>
  try {
    state = await readProject(project)
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
  if (state === null || state === undefined || !state.owner) return { kind: 'unknown' }
  try {
    const { recipe } = await currentRecipe(state)
    if (modeOf(recipe) !== 'team') return { kind: 'solo', recipe }
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        const prs = yield* readProjectPrs(project, eventStore)
        const draft = yield* readDraftOf(project, recipe, prs)
        const spend = yield* spendByPr(
          project,
          prs.map((r) => r.n),
        )
        const waitingForServe = prs.some((r) => 'pr' in r && r.pr.status === 'requested')
        const holder = waitingForServe
          ? yield* Effect.tryPromise({ try: () => conductorLockHolder(), catch: failed }).pipe(
              Effect.orElseSucceed(() => 'unknown' as string | null),
            )
          : null
        const fixHref = (name: string | null): string | null => {
          const link = prFixTicketLink({
            project,
            owner: state.owner,
            github: ticketsOnGitHub(recipe),
            name: name ?? 'the PR',
          })
          return link?.kind === 'link' ? link.href : null
        }
        return prBoard({
          project,
          recipe,
          prs,
          draft,
          stepNames: inProgressStepNames(),
          spend,
          servedWords: servedWords(holder),
          newFixHref: fixHref(null),
          newFixFor: (pr) => fixHref(prName(pr)),
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
  // Whether it is a team project is not known when either read fails: `PRs` stays, saying so, and is never dropped.
  let state: Awaited<ReturnType<typeof readProject>>
  try {
    state = await readProject(project)
  } catch {
    return viewsFor(project, { waiting: null })
  }
  if (state === null || state === undefined || !state.owner) return viewsFor(project)
  let recipe: Recipe
  try {
    recipe = (await currentRecipe(state)).recipe
  } catch {
    return viewsFor(project, { waiting: null })
  }
  if (modeOf(recipe) !== 'team') return viewsFor(project)
  const waiting = await Effect.runPromise(waitingPrs(project, eventStore)).catch(() => null)
  return viewsFor(project, { waiting })
}

const ended = (pr: PrState): boolean => pr.status === 'merged' || pr.status === 'closed'

/** The project's GitHub, or null where there is no App, no owner or the client could not be made: never a failure. */
const githubOf = (project: string, owner: string | null): Effect.Effect<GitHub | null> => {
  if (owner === null || owner === '' || !hasGitHubAuth()) return Effect.succeed(null)
  return makeGitHub({ auth: githubClientAuth(), owner, repo: project }).pipe(Effect.orElseSucceed(() => null))
}

/**
 * What the description reads of each ticket, as the daemon's `facts` port does: whether it is still open on GitHub, and what
 * its runs cost (`null` where any run's cost is unreported, or the read failed). The PR's own stream is not a ticket's.
 */
const ticketFacts = (
  project: string,
  tickets: readonly string[],
  github: GitHub | null,
): Effect.Effect<{ ticket: string; open: boolean | null; spend: number | null }[]> =>
  Effect.forEach(tickets, (ticket) =>
    Effect.gen(function* () {
      const open =
        github === null || !/^\d+$/.test(ticket)
          ? null
          : yield* github.getIssue(Number(ticket)).pipe(
              Effect.map((issue) => issue.state === 'open'),
              Effect.orElseSucceed(() => null),
            )
      const rows = yield* readSpendEffect({ project, ticket }).pipe(Effect.orElseSucceed(() => null))
      const own = rows === null ? null : rows.filter((r) => !r.streamId.startsWith('pr-'))
      const spend =
        own === null || own.length === 0 || own.some((r) => r.costUsd === null)
          ? null
          : own.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      return { ticket, open, spend }
    }),
  )

/** What one PR's page knows, or why it could not be known. */
export type PrDetailRead =
  | { readonly kind: 'solo'; readonly recipe: Recipe }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'team'
      readonly recipe: Recipe
      readonly view: PrPageView
      readonly status: PrState['status']
      /** The host's number, only while the log says the PR is open there: the one thing the render asks the host. */
      readonly ask: number | null
    }

/**
 * The page's one read: `n` is Lingtai's id, or `next` for the draft. The PR's events are read once and folded, and kept —
 * the history and each step's duration need them. **A failed read is `failed` with its words, never *no such PR*.**
 */
export async function readPrDetail(project: string, n: number | 'next'): Promise<PrDetailRead> {
  let state: Awaited<ReturnType<typeof readProject>>
  try {
    state = await readProject(project)
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
  // A local project legitimately records no owner: it is registered all the same.
  if (state === null || state === undefined) return { kind: 'unknown' }
  try {
    const { recipe } = await currentRecipe(state)
    if (modeOf(recipe) !== 'team') return { kind: 'solo', recipe }
    return await Effect.runPromise(
      Effect.gen(function* () {
        const stepNames = inProgressStepNames()
        const now = new Date()
        if (n === 'next') {
          const prs = yield* readProjectPrs(project, eventStore)
          const draft = yield* readDraftOf(project, recipe, prs)
          const latest = [...prs].reverse().find((r): r is { n: number; pr: PrState } => 'pr' in r)?.pr ?? null
          const view = prPage({
            project,
            recipe,
            owner: state.owner ?? null,
            pr: null,
            events: [],
            draft,
            open: latest !== null && isOpen(latest) ? latest : null,
            spend: null,
            stepNames,
            now,
          })
          return { kind: 'team', recipe, view, status: null, ask: null } as const
        }
        const events = yield* readPrEvents(project, n, eventStore)
        if (events.length === 0) return { kind: 'none' } as const
        const pr = reducePr(events)
        // The spend the page says is the PR's whole: its tickets' runs and its own. A part that could not be read leaves the
        // total unknown — never `$0`, and never one part presented as the sum.
        const github = ended(pr) || !githubHosted(recipe) ? null : yield* githubOf(project, state.owner ?? null)
        const facts = yield* ticketFacts(
          project,
          pr.tickets.map((t) => t.ticket),
          github,
        )
        const own = yield* spendByPr(project, [n]).pipe(
          Effect.map((m) => m.get(n) ?? 0),
          Effect.orElseSucceed(() => null),
        )
        const tickets = facts.some((f) => f.spend === null) ? null : facts.reduce((sum, f) => sum + (f.spend ?? 0), 0)
        const spend = own === null || tickets === null ? null : own + tickets
        const view = prPage({
          project,
          recipe,
          owner: state.owner ?? null,
          pr,
          events,
          draft: [],
          open: null,
          spend,
          spendParts: { tickets, pr: own },
          facts,
          stepNames,
          now,
        })
        const ask = githubHosted(recipe) && pr.host !== null && isOpen(pr) ? pr.host.number : null
        return { kind: 'team', recipe, view, status: pr.status, ask } as const
      }),
    )
  } catch (err) {
    const words = (err as Error).message
    return { kind: 'failed', error: n === 'next' ? words : `${prStream(project, n)}: ${words}` }
  }
}

/**
 * The one request a render makes of the code host: this PR's state, by the fields read. A failure is its words, never
 * *closed*. The client is the one every other read builds — `githubClientForEffect`'s own auth and repository, as the
 * Effect face `getPull` is on — so there is no second way of minting an installation token.
 */
export async function readHostPull(project: string, number: number): Promise<HostRead> {
  try {
    const state = await readProject(project)
    if (state === null || state === undefined) return { kind: 'failed', reason: `no project named ${project}` }
    if (!hasGitHubAuth()) return { kind: 'failed', reason: 'no GitHub App configured' }
    if (!state.owner) return { kind: 'failed', reason: 'no owner recorded for this project' }
    const options = { auth: githubClientAuth(), owner: state.owner, repo: project }
    return await Effect.runPromise(
      makeGitHub(options).pipe(
        Effect.flatMap((github) => github.getPull(number)),
        Effect.map((pull): HostRead => ({ kind: 'ok', state: pull.state, merged: pull.merged, draft: pull.draft })),
        Effect.catch((err) =>
          Effect.succeed<HostRead>({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) }),
        ),
      ),
    )
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message }
  }
}
