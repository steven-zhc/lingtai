/**
 * Serving a PR (0130 §5): the freeze, and the walk through In progress's steps.
 *
 * **A request is served by the daemon the way a discussion is** — off the pass path, from the log — but the loop
 * holds the walk in its in-flight set rather than delivering it (`work-loop.ts`'s `pr` option), so a drain waits for
 * the step in flight and a walk of minutes is not recorded as a failed plugin. Every IO here is an `Effect` (0101
 * §6); every append is a transition on the state it read (`@lingtai/project`'s `pr.ts`).
 *
 * The git side is a port, so the freeze is tested against a fake that answers by exit code, as git does.
 */
import { type Envelope, type PayloadOf, type PrState, parsePrStream } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
import { PermissionDenied } from '@lingtai/github'
import {
  landingsInFlight,
  listPrs,
  readPr,
  readPrDraft,
  recordPrInProgress,
  recordPrRefused,
  recordPrStepDone,
  recordPrWaiting,
} from '@lingtai/project'
import { type Recipe, modeOf } from '@lingtai/recipe'
import { Effect, Semaphore } from 'effect'

/** `git`'s answer in the project's mirror: its exit code (null when it never ran to one) and its stdout, trimmed. */
export interface PrGitAnswer {
  readonly code: number | null
  readonly stdout: string
}

export interface PrPorts {
  readonly store: EventStore
  /** The project's resolved recipe: its mode and its two branches. */
  recipe(project: string): Effect.Effect<Recipe, Error>
  /** Every ticket the draft may hold — the landed ones, over a window that covers all of them. */
  candidates(project: string): Effect.Effect<readonly { readonly issue: string }[], Error>
  /** Brings the project's mirror up to date with the remote. */
  fetch(project: string): Effect.Effect<void, Error>
  /** Runs `git` in the project's mirror. A non-zero exit is an answer, not a failure. */
  git(project: string, args: readonly string[]): Effect.Effect<PrGitAnswer, Error>
  /** The projects to look at on a start. */
  projects(): Effect.Effect<readonly string[], Error>
  readonly log?: (line: string) => void
  /** How long the freeze waits between looks at a landing still in flight (default 1s); 0 in a test. */
  readonly landingWaitMs?: number
}

/** How many times the freeze looks again at a landing in flight before it gives up and is served again later. */
const LANDING_LOOKS = 120

/** What a step answers. `again` records nothing: the next serve runs it again. */
export type StepAnswer =
  | { readonly kind: 'done'; readonly headSha: string }
  | {
      readonly kind: 'wait'
      readonly reason: PayloadOf<'PrWaiting'>['reason']
      readonly detail: string
      readonly headSha: string
    }
  | { readonly kind: 'again' }

export interface PrStep {
  readonly name: string
  /** A step must be safe to run twice: a kill leaves it unrecorded and it runs again. */
  run(context: { project: string; n: number; state: PrState; ports: PrPorts }): Effect.Effect<StepAnswer, Error>
}

/**
 * **In progress, as a fixed list.** Empty here: a PR stays In progress until later tickets fill it, in 0130 §5's
 * order — `sync` and `build` (#1312), `push` and `open` (#1337), `ci` (#1339), `summary` (#1318), `ready` (#1339).
 * Nothing else orders them, and the PR page draws its *What Lingtai did* rows from this list and the records.
 */
export const IN_PROGRESS_STEPS: readonly PrStep[] = []

export const inProgressStepNames = (steps: readonly PrStep[] = IN_PROGRESS_STEPS): readonly string[] =>
  steps.map((s) => s.name)

/** One PR is served at a time per project: the start-up resume and a live request can arrive together. */
const permits = new Map<string, Semaphore.Semaphore>()
const permitOf = (project: string): Semaphore.Semaphore => {
  const held = permits.get(project)
  if (held !== undefined) return held
  const made = Semaphore.makeUnsafe(1)
  permits.set(project, made)
  return made
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** `git` answered with a code other than the two it is expected to: the refusal's sentence. */
const gitSaid = (args: readonly string[], answer: PrGitAnswer): string =>
  `git ${args.join(' ')} answered ${answer.code === null ? 'nothing' : `exit ${answer.code}`}`

/**
 * The freeze of a `requested` PR: `branch.personal` at one commit, and the tickets that commit holds. A read that
 * fails fails the effect and records nothing, so the freeze is served again; it is never *no tickets*.
 */
export const freezePr = (ports: PrPorts, project: string, n: number): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const refuse = (reason: PayloadOf<'PrSubmitRefused'>['reason'], detail: string) =>
      recordPrRefused(project, n, { reason, detail }, ports.store).pipe(Effect.asVoid)

    const recipe = yield* ports.recipe(project)
    if (modeOf(recipe) !== 'team') {
      return yield* refuse('solo', `${project} lands on ${recipe.branch.main} itself; there is no PR`)
    }
    const main = recipe.branch.main
    const personal = recipe.branch.personal ?? main

    // **Git and the log are read together or not at all.** A landing pushes before it records `TicketLanded`, so a
    // frozen commit can hold a ticket the draft cannot yet name. Its integration is attempted before it pushes, so
    // once the commit is read a landing that reached it is visible on the lane: wait it out, and read the commit again.
    const verify = ['rev-parse', '--verify', '--quiet', `refs/heads/${personal}^{commit}`] as const
    let frozenSha = ''
    for (let look = 0; ; look++) {
      yield* ports.fetch(project)
      const head = yield* ports.git(project, verify)
      if (head.code === 1) return yield* refuse('personal-missing', `${personal} is not in the mirror`)
      if (head.code !== 0) return yield* refuse('git', gitSaid(verify, head))
      frozenSha = head.stdout.trim()
      const pending = yield* landingsInFlight(project, personal, ports.store)
      if (pending.length === 0) break
      if (look >= LANDING_LOOKS) {
        return yield* Effect.fail(new Error(`a landing on ${personal} is still in flight (${pending.join(', ')})`))
      }
      yield* Effect.sleep(ports.landingWaitMs ?? 1000)
    }

    const draft = yield* readPrDraft(project, recipe, yield* ports.candidates(project), ports.store)
    const held: PayloadOf<'PrInProgress'>['tickets'] = []
    for (const t of draft) {
      const ask = ['merge-base', '--is-ancestor', t.mergeCommit, frozenSha] as const
      const answer = yield* ports.git(project, ask)
      // 0 yes, 1 no; anything else is git failing, never *not an ancestor*.
      if (answer.code === 0) held.push({ ticket: t.ticket, mergeCommit: t.mergeCommit, title: t.title })
      else if (answer.code !== 1) return yield* refuse('git', gitSaid(ask, answer))
    }
    if (held.length === 0) {
      return yield* refuse('nothing-landed', `no ticket has landed on ${personal} that a PR does not already hold`)
    }

    yield* recordPrInProgress(project, n, { branch: personal, main, frozenSha, tickets: held }, ports.store)
  })

/**
 * Walks In progress from the first step not recorded since the latest `PrInProgress`. `done` records the step and
 * goes on; `wait` records the wait and stops; `again` records nothing and stops. A `PermissionDenied` from any step
 * is a wait `denied`.
 */
export const walkPr = (
  ports: PrPorts,
  project: string,
  n: number,
  steps: readonly PrStep[] = IN_PROGRESS_STEPS,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (;;) {
      const state = yield* readPr(project, n, ports.store)
      if (state === null || state.status !== 'in-progress') return
      const next = steps.find((s) => !state.steps.some((r) => r.step === s.name))
      if (next === undefined) return
      const answer = yield* next.run({ project, n, state, ports }).pipe(
        Effect.catch((err: unknown) =>
          err instanceof PermissionDenied
            ? Effect.succeed<StepAnswer>({
                kind: 'wait',
                reason: 'denied',
                detail: err.message,
                headSha: state.target ?? state.frozenSha ?? '',
              })
            : Effect.fail(asError(err)),
        ),
      )
      if (answer.kind === 'again') return
      if (answer.kind === 'wait') {
        yield* recordPrWaiting(
          project,
          n,
          { step: next.name, reason: answer.reason, detail: answer.detail, headSha: answer.headSha },
          ports.store,
        )
        return
      }
      yield* recordPrStepDone(project, n, { step: next.name, headSha: answer.headSha }, ports.store)
    }
  })

/** Serves one PR under its project's permit: re-reads, and stops unless it is still `requested` or `in-progress`. */
export const servePr = (
  ports: PrPorts,
  project: string,
  n: number,
  steps: readonly PrStep[] = IN_PROGRESS_STEPS,
): Effect.Effect<void, Error> =>
  permitOf(project).withPermits(1)(
    Effect.gen(function* () {
      const state = yield* readPr(project, n, ports.store)
      if (state === null) return
      if (state.status === 'requested') yield* freezePr(ports, project, n)
      yield* walkPr(ports, project, n, steps)
    }),
  )

/**
 * The handlers the loop's `pr` option takes. `serve` answers the event's own stream; `resume` serves every PR of
 * every project that is `requested` or `in-progress`.
 */
export const makePrHandlers = (ports: PrPorts, steps: readonly PrStep[] = IN_PROGRESS_STEPS) => ({
  serve: (event: Envelope): Effect.Effect<void> => {
    const named = parsePrStream(event.streamId)
    if (named === null) return Effect.void
    return servePr(ports, named.project, named.n, steps).pipe(Effect.orDie)
  },
  resume: (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const say = (line: string) => ports.log?.(line)
      const projects = yield* ports
        .projects()
        .pipe(
          Effect.catch((err: Error) => Effect.sync(() => (say(`pr resume: ${err.message}`), [] as readonly string[]))),
        )
      // One PR's failure is that PR's: the others are still owed their serve, and nothing sweeps for them later.
      for (const project of projects) {
        const prs = yield* listPrs(project, ports.store).pipe(
          Effect.catch((err: Error) =>
            Effect.sync(() => (say(`pr resume ${project}: ${err.message}`), [] as PrState[])),
          ),
        )
        for (const pr of prs) {
          if ((pr.status === 'requested' || pr.status === 'in-progress') && pr.n !== null) {
            yield* servePr(ports, project, pr.n, steps).pipe(
              Effect.catch((err: Error) => Effect.sync(() => say(`pr resume ${project} PR ${pr.n}: ${err.message}`))),
            )
          }
        }
      }
    }).pipe(Effect.orDie),
})
