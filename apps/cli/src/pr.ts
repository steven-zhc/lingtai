import { inProgressStepNames } from '@lingtai/conductor'
/**
 * `lingtai pr [<project>]` and `lingtai pr submit [<project>]` (0130 §5).
 *
 * The read says what the draft holds and where the open PR is. Submit is a request the daemon serves: it is refused
 * synchronously where `requestSubmit` says so (`solo`, `open-pr`), and otherwise appends and **waits as `approve`
 * does** — *in progress* once `PrInProgress` lands within a minute, the serve's own refusal if it came, and where
 * nothing conducts, the sentence that says when it will be served.
 */
import { conductorLockHolder } from '@lingtai/daemon'
import { type PrState, isOpen, prStepRows } from '@lingtai/domain'
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import { type PrDraftTicket, latestPr, readPr, readPrDraft, requestPrSubmit } from '@lingtai/project'
import { type Recipe, modeOf } from '@lingtai/recipe'
import { Effect } from 'effect'

import { livePrPorts } from './pr-ports.ts'
import { type Answered, refusal } from './verdict.ts'

/** How long a Submit waits for the freeze before it says what it is waiting on. */
export const SUBMIT_WAIT_MS = 60_000
const POLL_MS = 500

export interface PrWorld {
  readonly store: EventStore
  recipe(project: string): Effect.Effect<Recipe, Error>
  candidates(project: string): Effect.Effect<readonly { readonly issue: string }[], Error>
  /** `conductorLockHolder`: who conducts, null for nobody. */
  holder(): Promise<string | null>
  now(): number
  sleep(ms: number): Promise<void>
}

export function livePrWorld(): PrWorld {
  const ports = livePrPorts(eventStore, () => {})
  return {
    store: eventStore,
    recipe: ports.recipe,
    candidates: ports.candidates,
    holder: () => conductorLockHolder(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

const solo = (project: string, recipe: Recipe): string =>
  `${project} lands on ${recipe.branch.main} itself; there is no PR`

/** What `lingtai pr` reads. */
export interface PrReport {
  readonly code: number
  readonly lines: readonly string[]
  readonly json: Record<string, unknown>
}

const stepLines = (state: PrState): string[] =>
  prStepRows(inProgressStepNames(), state).map(
    (row) =>
      `  ${row.status === 'done' ? '✓' : row.status === 'waiting' ? '!' : '·'} ${row.step}${row.headSha === null ? '' : ` @ ${row.headSha.slice(0, 7)}`}`,
  )

/** The draft and the open PR, read from the log. Solo is refused by name; a failed read fails. */
export const prReport = (project: string, world: PrWorld): Effect.Effect<PrReport, Error> =>
  Effect.gen(function* () {
    const recipe = yield* world.recipe(project)
    if (modeOf(recipe) !== 'team') {
      const detail = solo(project, recipe)
      return { code: 1, lines: [detail], json: { outcome: 'refused', reason: 'solo', detail } }
    }
    const latest = yield* latestPr(project, world.store)
    const open = latest !== null && isOpen(latest) ? latest : null
    const draft: readonly PrDraftTicket[] = yield* readPrDraft(
      project,
      recipe,
      yield* world.candidates(project),
      world.store,
    )

    const lines: string[] = [
      draft.length === 0
        ? `draft: nothing has landed on ${recipe.branch.personal ?? recipe.branch.main} that a PR does not hold`
        : `draft: ${draft.length} ticket(s) landed on ${recipe.branch.personal ?? recipe.branch.main}`,
      ...draft.map((t) => `  #${t.ticket} ${t.title}`),
    ]
    if (open !== null && open.n !== null) {
      lines.push(
        `PR ${open.n}: ${open.status}${open.prBranch === null ? '' : ` — ${open.prBranch}`}`,
        ...(open.wait === null ? [] : [`  waiting on you at ${open.wait.step}: ${open.wait.detail}`]),
        ...stepLines(open),
      )
    }
    return {
      code: 0,
      lines,
      json: {
        project,
        draft: draft.map((t) => ({ ticket: t.ticket, title: t.title, mergeCommit: t.mergeCommit })),
        pr:
          open === null
            ? null
            : {
                n: open.n,
                status: open.status,
                prBranch: open.prBranch,
                frozenSha: open.frozenSha,
                wait: open.wait,
                steps: prStepRows(inProgressStepNames(), open),
              },
      },
    }
  })

/** Submit: refused `solo` / `open-pr` before anything is appended; otherwise appended, and followed to its freeze. */
export const prSubmitVerdict = (
  project: string,
  by: string,
  world: PrWorld,
  waitMs: number = SUBMIT_WAIT_MS,
): Effect.Effect<Answered, Error> =>
  Effect.gen(function* () {
    const recipe = yield* world.recipe(project)
    const mode = modeOf(recipe)
    const subject = project
    if (mode !== 'team') return refusal(1, 'solo', solo(project, recipe), { subject })

    const asked = yield* requestPrSubmit(project, mode, by, world.store)
    if (asked.kind === 'refused') return refusal(1, asked.reason, asked.detail, { subject })

    const n = asked.n
    const until = world.now() + waitMs
    for (;;) {
      const state = yield* readPr(project, n, world.store)
      if (state !== null && state.status === 'refused' && state.refusal !== null) {
        return refusal(1, state.refusal.reason, state.refusal.detail, { subject: `${project} PR ${n}` })
      }
      if (state !== null && state.status !== 'requested') {
        return {
          code: 0,
          verdict: {
            outcome: 'accepted',
            subject: `${project} PR ${n}`,
            form: 'sentence',
            detail: `in progress — ${state.prBranch ?? ''} frozen at ${(state.frozenSha ?? '').slice(0, 7)}`,
            extra: { project, n, status: state.status, prBranch: state.prBranch, frozenSha: state.frozenSha },
          },
        } satisfies Answered
      }
      if (world.now() >= until) break
      yield* Effect.promise(() => world.sleep(POLL_MS))
    }

    const holder = yield* Effect.tryPromise({ try: () => world.holder(), catch: (e) => e as Error }).pipe(
      Effect.orElseSucceed(() => 'unknown' as string | null),
    )
    const detail =
      holder === null
        ? 'it is served when a conductor runs: lingtai start, or lingtai run'
        : holder === 'unknown'
          ? 'could not tell whether a conductor is running; lingtai doctor says'
          : `${holder} is freezing it; lingtai pr says when`
    return {
      code: 0,
      verdict: {
        outcome: 'accepted',
        subject: `${project} PR ${n}`,
        form: 'sentence',
        detail,
        extra: { project, n, status: 'requested' },
      },
    } satisfies Answered
  })

/** The project a command is about: the one named, else the only one registered. Anything else is a refusal by name. */
export const chooseProject = (
  given: string | undefined,
  registered: () => Effect.Effect<readonly string[], Error>,
): Effect.Effect<{ project: string } | { refused: Answered }, Error> =>
  Effect.gen(function* () {
    if (given !== undefined) return { project: given }
    const projects = yield* registered()
    if (projects.length === 1) return { project: projects[0]! }
    return {
      refused: refusal(
        2,
        'usage',
        projects.length === 0
          ? 'no project is registered — run lingtai add <owner>/<repo>'
          : `name the project: lingtai pr <project> (${projects.join(', ')})`,
      ),
    }
  })

/** The registered projects' names. */
export const registeredProjects = (): Effect.Effect<readonly string[], Error> =>
  livePrPorts(eventStore, () => {}).projects()
