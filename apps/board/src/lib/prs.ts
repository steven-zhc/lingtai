/**
 * What the board reads of a project's PRs (#1319): server-only, over the log and nothing else.
 *
 * **Numbers are found by `head`, never by listing streams** — `listPrs`' own rule in `@lingtai/project`. The board's
 * *is a PR open?* must be the answer `requestPrSubmit` refuses on, and a prefix listing would also take `pr-lingtai-x-3`
 * for `lingtai`'s and sort `pr-a-10` before `pr-a-9`. The one difference from `listPrs`: one unreadable stream is
 * returned as itself and the others are still read, so a card can say what it could not read.
 */
import { inProgressStepNames } from '@lingtai/conductor'
import { conductorLockHolder } from '@lingtai/daemon'
import { type PrState, isOpen, openAmong, prStream, reducePr, ticketStream } from '@lingtai/domain'
import { githubClientAuth, hasGitHubAuth } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, makeGitHub } from '@lingtai/github'
import { type PrDraftTicket, READ_CONCURRENCY, openPr, readDraftTickets, readPr, readPrEvents } from '@lingtai/project'
import { readSpendEffect } from '@lingtai/projector'
import { type Recipe, modeOf } from '@lingtai/recipe'
import { context } from '@opentelemetry/api'
import { Effect } from 'effect'
import { cache } from 'react'

import { viewsFor, type PlaceView } from '@/app/place-line.tsx'
import { actor } from '@/lib/actor.ts'

import { type FixTicket, MERGED_SHOWN, type PrBoardView, type PrRead, prBoard, prHolding, prName } from './pr-board.ts'
import {
  type HostRead,
  type PrPageView,
  generatedBody,
  githubHosted,
  prFixTicketLink,
  prPage,
  ticketsOnGitHub,
} from './pr-page.ts'
import { projectOf, recipeOf } from './request-reads.ts'
import { requestStore } from './request-store.ts'
import type { SearchPr } from './search.ts'
import type { OnBranchRead } from './task.ts'
import { ApiContext, boardTracer, measure, timed, traced, tracedEffect } from './timing.ts'
import type { LandedWhereRead } from './where-landed.ts'

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
 * always read, and only the highest one not in `draft` can be open. A PR in `draft` is left out: the Draft column
 * is still the computed draft. Nothing older is returned then, which is what #1321 asks.
 *
 * With `merged`, the walk stops once that many merged PRs have been read (#1422): a chunk is no longer than the merged
 * PRs still wanted, so no stream past the last one is read. A failed read, an absent stream or a draft does not count.
 * With both options the walk stops at whichever comes first.
 */
export const readProjectPrs = (
  project: string,
  store: EventStore,
  options: { since?: Date; merged?: number } = {},
): Effect.Effect<PrRead[], Error> =>
  Effect.gen(function* () {
    const top = yield* tracedEffect('pr.numbers', topPrNumber(project, store))
    const reads: PrRead[] = []
    let merged = 0
    // Newest first, a chunk at a time: the reads in a chunk run together, and the `since` cut is applied to the chunk's
    // results in order, so what is returned is what the serial walk returned. Reads past the cut in its own chunk are
    // dropped, errors included.
    for (let high = top; high >= 1;) {
      const wanted = options.merged === undefined ? Infinity : options.merged - merged
      if (wanted <= 0) break
      const size = Math.min(READ_CONCURRENCY, high, wanted)
      const chunk = Array.from({ length: size }, (_, i) => high - i)
      high -= size
      const results = yield* Effect.forEach(chunk, (n) => readPr(project, n, store).pipe(Effect.result), {
        concurrency: READ_CONCURRENCY,
      })
      for (const [i, read] of results.entries()) {
        const n = chunk[i]!
        if (read._tag === 'Failure') {
          reads.push({ n, error: read.failure.message })
          continue
        }
        if (read.success === null) continue
        const pr = read.success
        if (pr.status === 'draft') continue
        reads.push({ n, pr })
        if (pr.status === 'merged') merged++
        if (options.since !== undefined && pr.status === 'merged' && pr.ended !== null && pr.ended.at < options.since)
          return reads.reverse()
      }
    }
    return reads.reverse()
  })

/**
 * `readProjectPrs` for one request, once: every PR, never a `since`, through `requestStore()`. **A reader added later
 * goes through this one**; a page that needs the `since` cut asks `readProjectPrs` itself, and reads through the same store.
 */
export const prsOf = cache((project: string) => {
  // The first caller's span, taken here because the run resumes elsewhere (#1359).
  const active = context.active()
  return Effect.runPromise(
    readProjectPrs(project, requestStore()).pipe(
      Effect.withTracer(boardTracer),
      Effect.provideService(ApiContext, active),
    ),
  )
})

/** The count of PRs waiting on the person: the open PR is the only one that can wait. */
export const waitingPrs = (project: string, store: EventStore): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const pr = yield* openPr(project, store)
    return pr !== null && pr.status === 'waiting' ? 1 : 0
  })

/**
 * The draft, read from the draft PR's own stream, each ticket with its title. A read that fails is said as such where the
 * draft would be, while every PR that was read is still drawn. **Never an empty draft** for a read that failed. The PRs
 * board and a PR's page both ask here, so the two cannot decide the draft differently.
 */
export const readDraftOf = (project: string): Effect.Effect<PrDraftTicket[] | { error: string }> =>
  tracedEffect(
    'pr.draft',
    readDraftTickets(project, requestStore()).pipe(Effect.catch((err) => Effect.succeed({ error: err.message }))),
  )

/** Reported spend on each PR's stream, by `n`. A PR with nothing reported is absent: unknown, never `$0`. */
export const spendByPr = (project: string, ns: readonly number[]): Effect.Effect<Map<number, number>, Error> =>
  Effect.gen(function* () {
    const rows = yield* tracedEffect('spend.read', readSpendEffect({ project }).pipe(Effect.mapError(failed)))
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
  let state: Awaited<ReturnType<typeof projectOf>>
  try {
    state = await projectOf(project)
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
  if (state === null || state === undefined || !state.owner) return { kind: 'unknown' }
  try {
    const { recipe } = await traced('recipe.resolve', () => recipeOf(project))
    if (modeOf(recipe) !== 'team') return { kind: 'solo', recipe }
    const active = context.active()
    const view = await Effect.runPromise(
      Effect.gen(function* () {
        const [prs, draft] = yield* Effect.all(
          [readProjectPrs(project, requestStore(), { merged: MERGED_SHOWN }), readDraftOf(project)],
          { concurrency: 2 },
        )
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
        const fixHref = (name: string | null): FixTicket | null =>
          prFixTicketLink({
            project,
            owner: state.owner,
            github: ticketsOnGitHub(recipe),
            name: name ?? 'the PR',
          })
        return prBoard({
          project,
          recipe,
          prs,
          draft,
          stepNames: inProgressStepNames(),
          spend,
          daemon: holder === null ? 'none' : holder === 'unknown' ? 'unknown' : 'running',
          viewer: actor(),
          newFixHref: fixHref(null),
          newFixFor: (pr) => fixHref(prName(pr)),
        })
      }).pipe(Effect.withTracer(boardTracer), Effect.provideService(ApiContext, active)),
    )
    return { kind: 'team', recipe, view }
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
}

/**
 * The home page's Landed column asks, once per team project: the PRs and the draft, **every PR and never a `since`** —
 * the draft treats a merged PR's tickets as held, so a list cut short would put a merged ticket back in the draft.
 * A solo project reads no PR stream.
 */
export async function readLandedWhere(project: string): Promise<LandedWhereRead> {
  try {
    const state = await projectOf(project)
    if (state === null || state === undefined) return { kind: 'solo' }
    const { recipe } = await traced('recipe.resolve', () => recipeOf(project))
    if (modeOf(recipe) !== 'team') return { kind: 'solo' }
    return await Effect.runPromise(
      Effect.gen(function* () {
        const [prs, draft] = yield* Effect.all(
          [Effect.tryPromise({ try: () => prsOf(project), catch: failed }), readDraftOf(project)],
          { concurrency: 2 },
        )
        return { kind: 'team', prs, draft } as const
      }),
    )
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
}

/**
 * The place line's views for a project: `viewsFor` with the `PRs` view a team project has and its count of PRs waiting
 * on the person. **A count that could not be read is `null`, never 0** — the view stays and the badge is absent.
 */
export async function placeViewsOf(project: string | undefined): Promise<PlaceView[]> {
  if (project === undefined) return viewsFor(undefined)
  // Whether it is a team project is not known when either read fails: `PRs` stays, saying so, and is never dropped.
  let state: Awaited<ReturnType<typeof projectOf>>
  try {
    state = await projectOf(project)
  } catch {
    return viewsFor(project, { waiting: null })
  }
  if (state === null || state === undefined || !state.owner) return viewsFor(project)
  let recipe: Recipe
  try {
    recipe = (await recipeOf(project)).recipe
  } catch {
    return viewsFor(project, { waiting: null })
  }
  if (modeOf(recipe) !== 'team') return viewsFor(project)
  const waiting = await Effect.runPromise(waitingPrs(project, requestStore())).catch(() => null)
  return viewsFor(project, { waiting })
}

/** How long a page waits for one ticket's state on GitHub before it says *unknown*. */
const ISSUE_READ_BUDGET = '3 seconds'

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
  Effect.forEach(
    tickets,
    (ticket) =>
      Effect.gen(function* () {
        // The log's half first and never waiting on GitHub: the issue read runs beside it, in parallel with every other
        // ticket's, and a slow or failed one is unknown after `ISSUE_READ_BUDGET` rather than holding the page.
        const openRead =
          github === null || !/^\d+$/.test(ticket)
            ? Effect.succeed(null)
            : github.getIssue(Number(ticket)).pipe(
                Effect.map((issue): boolean | null => issue.state === 'open'),
                Effect.timeout(ISSUE_READ_BUDGET),
                Effect.orElseSucceed(() => null),
              )
        // The projection keys a ticket's spend by its stream id (`ticket-<project>-<issue>`), never by the bare number.
        const rows = yield* readSpendEffect({ project, ticket: ticketStream(project, ticket) }).pipe(
          Effect.orElseSucceed(() => null),
        )
        const open = yield* openRead
        const own = rows === null ? null : rows.filter((r) => !r.streamId.startsWith('pr-'))
        const spend =
          own === null || own.length === 0 || own.some((r) => r.costUsd === null)
            ? null
            : own.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
        return { ticket, open, spend }
      }),
    { concurrency: 'unbounded' },
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
  let state: Awaited<ReturnType<typeof projectOf>>
  try {
    state = await projectOf(project)
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message }
  }
  // A local project legitimately records no owner: it is registered all the same.
  if (state === null || state === undefined) return { kind: 'unknown' }
  try {
    const { recipe } = await traced('recipe.resolve', () => recipeOf(project))
    if (modeOf(recipe) !== 'team') return { kind: 'solo', recipe }
    const active = context.active()
    return await Effect.runPromise(
      Effect.gen(function* () {
        const stepNames = inProgressStepNames()
        const now = new Date()
        if (n === 'next') {
          const prs = yield* Effect.tryPromise({ try: () => prsOf(project), catch: failed })
          const draft = yield* readDraftOf(project)
          const open = openAmong(prs.flatMap((r) => ('pr' in r ? [r.pr] : [])))
          const view = prPage({
            project,
            recipe,
            owner: state.owner ?? null,
            pr: null,
            events: [],
            draft,
            open,
            spend: null,
            stepNames,
            now,
          })
          return { kind: 'team', recipe, view, status: null, ask: null } as const
        }
        const events = yield* readPrEvents(project, n, requestStore())
        if (events.length === 0) return { kind: 'none' } as const
        const pr = reducePr(events)
        // The spend the page says is the PR's whole: its tickets' runs and its own. A part that could not be read leaves the
        // total unknown — never `$0`, and never one part presented as the sum.
        // Only the log here: whether a ticket is still open is GitHub's, and `readGeneratedBody` asks it in a streamed part, so
        // no request to the host holds the page back.
        const facts = yield* ticketFacts(
          project,
          pr.tickets.map((t) => t.ticket),
          null,
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
      }).pipe(Effect.withTracer(boardTracer), Effect.provideService(ApiContext, active)),
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
    const state = await projectOf(project)
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

/**
 * The generated rest of the description with each ticket's open state asked of its host — the one part of the page that
 * waits on GitHub, streamed after everything the log answers. A ticket whose read is slow or fails is unknown, never closed.
 */
export async function readGeneratedBody(project: string, n: number): Promise<string> {
  const state = await projectOf(project)
  if (state === null || state === undefined) throw new Error(`no project named ${project}`)
  const { recipe } = await traced('recipe.resolve', () => recipeOf(project))
  return Effect.runPromise(
    Effect.gen(function* () {
      const pr = reducePr(yield* readPrEvents(project, n, requestStore()))
      const github = ticketsOnGitHub(recipe) ? yield* githubOf(project, state.owner ?? null) : null
      const facts = yield* ticketFacts(
        project,
        pr.tickets.map((t) => t.ticket),
        github,
      )
      return generatedBody(pr, facts)
    }),
  )
}

/** What the task page's *on your branch* part asks: the recipe's branches, the project's owner, and the PRs and the draft. */
export type OnBranchPageRead =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'team'
      readonly recipe: Recipe
      readonly owner: string | null
      readonly read: OnBranchRead
    }

/**
 * The part's one read (#1323). **Only a team project reads PRs**, so a solo project's task page asks nothing new. A read
 * that fails is `{ error }`, never an empty list: the page then says it could not be read, not *not in a PR yet*.
 * A recipe that cannot be read is `none`: `branch.personal` is unknown and the page says what it says today.
 */
export const readOnBranch = (project: string): Effect.Effect<OnBranchPageRead> =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise({ try: () => projectOf(project), catch: failed })
    if (state === null || state === undefined) return { kind: 'none' } as const
    const { recipe } = yield* Effect.tryPromise({ try: () => recipeOf(project), catch: failed })
    if (modeOf(recipe) !== 'team') return { kind: 'none' } as const
    const read: OnBranchRead = yield* Effect.gen(function* () {
      const prs = yield* Effect.tryPromise({ try: () => prsOf(project), catch: failed })
      const draft = yield* readDraftOf(project)
      return { prs, draft }
    }).pipe(Effect.catch((err) => Effect.succeed({ error: err.message })))
    return { kind: 'team', recipe, owner: state.owner ?? null, read } as const
  }).pipe(Effect.catch(() => Effect.succeed({ kind: 'none' } as const)))

/**
 * What ⌘K indexes of a project's PRs (#1342): plain data for `buildIndex`, from the log alone. A solo project is not
 * read (`'solo'`); a read that fails is an `Error`, never an empty list, so the palette says it could not tell. One
 * unreadable stream is a problem of its own and leaves the other PRs listed.
 */
export const readSearchPrs = (
  project: string,
): Effect.Effect<{ readonly prs: SearchPr[]; readonly problems: string[] } | 'solo', Error> =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise({ try: () => projectOf(project), catch: failed })
    if (state === null || state === undefined) return 'solo' as const
    const { recipe } = yield* Effect.tryPromise({ try: () => recipeOf(project), catch: failed })
    if (modeOf(recipe) !== 'team') return 'solo' as const
    const reads = yield* Effect.tryPromise({ try: () => prsOf(project), catch: failed })
    const states = reads.flatMap((r) => ('pr' in r ? [r.pr] : []))
    const problems = reads.flatMap((r) => ('pr' in r ? [] : [`PR ${r.n} of ${project} could not be read`]))
    const prs = states.flatMap((pr): SearchPr[] =>
      pr.status === null
        ? []
        : [
            {
              project,
              n: pr.n ?? 0,
              host: pr.host?.number ?? null,
              name: prName(pr),
              title: pr.summary?.title ?? null,
              branch: pr.prBranch ?? null,
              status: pr.status,
              tickets: [...new Set([...pr.tickets.map((t) => t.ticket), ...pr.fixesLanded.map((f) => f.ticket)])],
              holding: [],
            },
          ],
    )
    const tickets = new Set(prs.flatMap((p) => p.tickets))
    for (const t of tickets) {
      const held = prHolding(t, states)
      if (held === null) continue
      prs.find((p) => p.n === held.pr.n)?.holding.push(t)
    }
    return { prs, problems }
  })

/** `/pr/<project>`'s load, inside `measure` so its trace has a `page` span and a `pr.board` under it (#1375). */
export const loadPrBoard = (project: string, read: (project: string) => Promise<PrsRead> = readPrPage) =>
  measure(() => timed('pr.board', () => read(project)), { label: '/pr' })

/** `/pr/<project>/<n>`'s load, measured the same way. */
export const loadPrDetail = (
  project: string,
  n: number | 'next',
  read: (project: string, n: number | 'next') => Promise<PrDetailRead> = readPrDetail,
) => measure(() => timed('pr.detail', () => read(project, n)), { label: '/pr detail' })
