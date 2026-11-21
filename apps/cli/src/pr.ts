import { describePr, inProgressStepNames, prHostOf } from '@lingtai/conductor'
/**
 * `lingtai pr [<project>]` and `lingtai pr submit [<project>]` (0130 §5).
 *
 * The read says what the draft holds and where the open PR is. Submit is a request the daemon serves: it is refused
 * synchronously where `requestSubmit` says so (`solo`, `open-pr`), and otherwise appends and **waits as `approve`
 * does** — *in progress* once `PrInProgress` lands within a minute, the serve's own refusal if it came, and where
 * nothing conducts, the sentence that says when it will be served.
 */
import { conductorLockHolder } from '@lingtai/daemon'
import { type PrState, isOpen, prStepRows, prWaitOf } from '@lingtai/domain'
import { eventStore } from '@lingtai/event-store'
import type { EventStore } from '@lingtai/event-store/store'
import {
  type PrDraftTicket,
  type PrRequestAnswer,
  grantPrRounds,
  latestPr,
  readPr,
  readPrDraft,
  requestPrBack,
  requestPrRetry,
  requestPrSubmit,
} from '@lingtai/project'
import { type Recipe, ceilingOf, modeOf } from '@lingtai/recipe'
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
  /** The PR's generated description — what a person opens by hand where Lingtai does not follow the remote. */
  describe(project: string, n: number): Effect.Effect<{ title: string; body: string }, Error>
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
    describe: (project, n) => describePr(ports, project, n),
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

/** The view of a waiting PR, as `lingtai pr` and the PR page both read it. The checkout is null: the recipe holds none to name. */
const waitViewOf = (state: PrState, project: string, recipe: Recipe) =>
  prWaitOf(state, {
    project,
    checkout: null,
    conflictResolutions: ceilingOf(recipe).attempt.conflictResolutions,
  })

const orUnknown = <A>(value: A | null, show: (a: A) => string): string => (value === null ? 'unknown' : show(value))

/** What a person reads under a waiting PR's line: the facts first, then the ways out as commands. */
const waitLines = (state: PrState, project: string, recipe: Recipe): string[] => {
  const view = waitViewOf(state, project, recipe)
  if (view === null) return []
  const since = view.since === null ? '' : ` since ${view.since.toISOString()}`
  if (view.kind === 'plain') {
    return [
      `  waiting on you at ${view.step}${since} (${view.reason}): ${view.detail}`,
      ...(view.commands.length === 0 ? [] : ['  to go on:', ...view.commands.map((c) => `    ${c}`)]),
    ]
  }
  const rounds =
    view.roundsUsed === null || view.roundsAllowed === null
      ? 'rounds: unknown'
      : `${view.roundsUsed} of ${view.roundsAllowed} rounds spent`
  return [
    `  waiting on you at sync${since} (${view.reason}): ${view.detail.split('\n')[0] ?? ''}`,
    `  main moved: ${orUnknown(view.mainAhead, String)} commit(s); conflicts in ${orUnknown(view.paths, (p) => p.join(', '))}; ${rounds}`,
    ...(view.ours === null
      ? ['  ours: unknown']
      : ['  ours:', ...view.ours.map((o) => `    #${o.issue} ${o.title} (${o.mergeCommit.slice(0, 7)})`)]),
    ...(view.theirs === null
      ? ['  theirs: unknown']
      : ['  theirs:', ...view.theirs.map((t) => `    ${t.sha.slice(0, 7)} ${t.author}: ${t.subject}`)]),
    ...(view.lastRefusal === null ? [] : [`  last refusal at ${view.lastRefusal.step}: ${view.lastRefusal.said}`]),
    ...(view.reason === 'sync-conflict' && view.commit !== null
      ? [`  give the agent 3 more rounds: lingtai pr rounds ${project}`]
      : []),
    '  or resolve it by hand:',
    ...view.commands.map((c) => `    ${c}`),
  ]
}

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

    let description: { title: string; body: string } | null = null
    const lines: string[] = [
      draft.length === 0
        ? `draft: nothing has landed on ${recipe.branch.personal ?? recipe.branch.main} that a PR does not hold`
        : `draft: ${draft.length} ticket(s) landed on ${recipe.branch.personal ?? recipe.branch.main}`,
      ...draft.map((t) => `  #${t.ticket} ${t.title}`),
    ]
    const ended = latest !== null && (latest.status === 'merged' || latest.status === 'closed') ? latest : null
    if (ended !== null && ended.n !== null && ended.ended !== null) {
      const by = ended.ended.how === null ? '' : ended.ended.how === 'host' ? ' as the host reports' : ' by git'
      lines.push(
        `PR ${ended.n}: ${ended.status}${ended.host === null ? '' : ` (pull request #${ended.host.number})`}${by} at ${ended.ended.at.toISOString()}`,
      )
    }
    if (open !== null && open.n !== null) {
      lines.push(
        `PR ${open.n}: ${open.status}${open.prBranch === null ? '' : ` — ${open.prBranch}`}`,
        ...waitLines(open, project, recipe),
        ...stepLines(open),
      )
      if (open.host !== null) lines.push(`  pull request #${open.host.number}: ${open.host.url}`)
      // On a remote Lingtai does not follow, the person opens the PR by hand: the description is theirs to paste.
      if (open.status === 'in-review' && prHostOf(recipe) === 'none') {
        const described = yield* world.describe(project, open.n)
        lines.push(
          `  ${open.prBranch ?? 'the branch'} is pushed; open the pull request by hand with:`,
          '',
          described.title,
          '',
          described.body,
        )
        description = described
      }
    }
    return {
      code: 0,
      lines,
      json: {
        project,
        ended:
          ended === null || ended.ended === null
            ? null
            : {
                n: ended.n,
                status: ended.status,
                how: ended.ended.how,
                host: ended.host,
                at: ended.ended.at.toISOString(),
              },
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
                waitView: waitViewOf(open, project, recipe),
                host: open.host,
                description,
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

type Ask = 'retry' | 'rounds' | 'back'

/** The sentence for a request nobody has answered in time: who is conducting. */
const unanswered = (holder: string | null, what: string): string =>
  holder === null
    ? `it is served when a conductor runs: lingtai start, or lingtai run`
    : holder === 'unknown'
      ? 'could not tell whether a conductor is running; lingtai doctor says'
      : `${holder} is ${what}; lingtai pr says when`

/**
 * `lingtai pr retry`, `lingtai pr rounds` and `lingtai pr back` (#1314): each is a request on the PR's stream, refused
 * synchronously where the pure transition says so (`@lingtai/project`'s appends — the CLI never writes the event itself),
 * and otherwise waited for as Submit is: the conductor's answer is the first thing on the PR that clears the request.
 */
export const prRequestVerdict = (
  ask: Ask,
  project: string,
  by: string,
  world: PrWorld,
  waitMs: number = SUBMIT_WAIT_MS,
): Effect.Effect<Answered, Error> =>
  Effect.gen(function* () {
    const recipe = yield* world.recipe(project)
    const mode = modeOf(recipe)
    if (mode !== 'team') return refusal(1, 'solo', solo(project, recipe), { subject: project })
    const latest = yield* latestPr(project, world.store)
    if (latest === null || latest.n === null || !isOpen(latest)) {
      return refusal(1, 'no-pr', `${project} has no PR open`, { subject: project })
    }
    const n = latest.n
    const subject = `${project} PR ${n}`
    const ref = { project, n, mode }
    const conflict = latest.wait?.conflict ?? null
    const rounds0 = latest.rounds.length
    const asked: PrRequestAnswer =
      ask === 'retry'
        ? yield* requestPrRetry(ref, { by }, world.store)
        : ask === 'back'
          ? yield* requestPrBack(ref, { by }, world.store)
          : yield* grantPrRounds(
              ref,
              { by, merging: conflict?.merging ?? 'main', commit: conflict?.commit ?? '' },
              world.store,
            )
    if (asked.kind === 'refused') return refusal(1, 'refused', asked.detail, { subject })

    const accepted = (detail: string, status: string | null): Answered => ({
      code: 0,
      verdict: { outcome: 'accepted', subject, form: 'sentence', detail, extra: { project, n, status } },
    })
    const until = world.now() + waitMs
    for (;;) {
      const state = yield* readPr(project, n, world.store)
      if (state !== null) {
        if (ask === 'back' && state.status === 'closed') {
          return accepted('closed; its tickets are back in Draft, still on the personal branch', state.status)
        }
        if (ask === 'rounds' && (state.rounds.length > rounds0 || state.status !== 'in-progress')) {
          return state.status === 'waiting' && state.wait !== null
            ? accepted(`the agent went again; the PR waits at ${state.wait.step} (${state.wait.reason})`, state.status)
            : accepted('three more rounds given; the agent is resolving', state.status)
        }
        if (ask === 'retry' && state.pending === null) {
          if (state.status === 'waiting' && state.wait !== null) {
            return refusal(1, state.wait.reason, state.wait.detail, { subject })
          }
          return accepted('checking again — in progress', state.status)
        }
      }
      if (world.now() >= until) break
      yield* Effect.promise(() => world.sleep(POLL_MS))
    }
    const holder = yield* Effect.tryPromise({ try: () => world.holder(), catch: (e) => e as Error }).pipe(
      Effect.orElseSucceed(() => 'unknown' as string | null),
    )
    return accepted(
      unanswered(holder, ask === 'back' ? 'taking it back' : ask === 'retry' ? 'checking it' : 'resolving it'),
      'waiting',
    )
  })
