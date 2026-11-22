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
import {
  type CiCheck,
  type Envelope,
  type PayloadOf,
  type PrState,
  integrationStream,
  isOpen,
  parsePrStream,
  parseTicketStream,
  prDescription,
  prStream,
  ciVerdict,
  ticketStream,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
import { type GitHub, GitHubFailed, PermissionDenied, type PullState } from '@lingtai/github'
import {
  landingsInFlight,
  listPrs,
  latestPr,
  recordPrClosed,
  recordPrMerged,
  readPr,
  readPrDraft,
  recordPrCiSkipped,
  recordPrCiFollowing,
  recordPrChecked,
  recordPrDraftOpened,
  recordPrInProgress,
  recordPrOpened,
  recordPrPushed,
  recordPrRefused,
  recordPrRestart,
  recordPrStepDone,
  recordPrWaiting,
} from '@lingtai/project'
import { type Recipe, ciOf, modeOf, remoteOf } from '@lingtai/recipe'
import { Clock, Effect, Semaphore } from 'effect'

import { CiProvider, type CiProviderShape } from './ci.ts'
import { type LandingLane, landingLane } from './landing-lane.ts'
import { type IssueChannel, tellGitHubEffect } from './tell.ts'

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
  /**
   * Runs `git` in the project's mirror **against the remote** — `ls-remote`, `push` — with the token a fetch has. A
   * non-zero exit is an answer, not a failure. `git` stays for what is local (`merge-base`, `cat-file`).
   */
  remote(project: string, args: readonly string[]): Effect.Effect<PrGitAnswer, Error>
  /**
   * The project's own ticket channel: the one its tickets are read and closed through (GitHub's issues, or its own
   * store). **Never the raw GitHub client** — a `db` project's ticket numbers are not GitHub issues, and closing
   * one there would close an unrelated issue that shares the number.
   */
  tickets(project: string): Effect.Effect<IssueChannel, Error>
  /** The project's GitHub, as the Effect face. Fails where the project has no owner on record. */
  github(project: string): Effect.Effect<GitHub, Error>
  /**
   * The project's CI provider, built over its GitHub and its mirror (#1339). Null is *none declared* (`pr.ci.provider:
   * none`). **Absent, the `ci` step answers `again`**: a host that has not wired one reads nothing and decides nothing.
   */
  readonly ci?: (project: string, github: GitHub) => Effect.Effect<CiProviderShape | null, Error>
  /** What the description reads of each ticket: whether it is still open on GitHub, and what it cost. Null is unknown. */
  facts(
    project: string,
    tickets: readonly string[],
  ): Effect.Effect<readonly { readonly ticket: string; readonly open: boolean | null; readonly spend: number | null }[]>
  /**
   * The merge lane. **The conductor's own** (`landingLane`) by default and never a second one: a lane of its own would
   * order the push against nothing, and a pr-fix landing (#1341) and this push are the PR branch's two writers.
   */
  readonly lane?: LandingLane
  /** The projects to look at on a start. */
  projects(): Effect.Effect<readonly string[], Error>
  readonly log?: (line: string) => void
  /** How long the freeze waits between looks at a landing still in flight (default 1s); 0 in a test. */
  readonly landingWaitMs?: number
}

/**
 * How many times the freeze looks again at a landing in flight before it gives up. The request stays `requested`, and
 * what ends that landing — a `TicketLanded`, `TicketReleased` or `TicketClosed` — is in `PR_EVENTS`, so it is served again.
 */
const LANDING_LOOKS = 120

/**
 * The event that proves a step, appended **in place of** `PrStepDone` — one append, so a kill between two cannot leave
 * a step recorded done without the fact that shows it. The reducer folds each into the PR's `steps`.
 */
export type PrRecord = (project: string, n: number, store: EventStore) => Effect.Effect<unknown, Error>

/** What a step answers. `again` records nothing: the next serve runs it again. */
export type StepAnswer =
  | { readonly kind: 'done'; readonly headSha: string; readonly record?: PrRecord }
  | {
      readonly kind: 'wait'
      readonly reason: PayloadOf<'PrWaiting'>['reason']
      readonly detail: string
      readonly headSha: string
    }
  | { readonly kind: 'again' }
  /** An earlier step's work is gone: In progress starts again from its first step. */
  | { readonly kind: 'restart' }

export interface PrStep {
  readonly name: string
  /** A step must be safe to run twice: a kill leaves it unrecorded and it runs again. */
  run(context: { project: string; n: number; state: PrState; ports: PrPorts }): Effect.Effect<StepAnswer, Error>
}

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

/** Where a PR is pushed to: `github` where the recipe names no remote of its own, `none` for any other (0130 §5). */
export const prHostOf = (recipe: Recipe): 'github' | 'none' => (remoteOf(recipe) === null ? 'github' : 'none')

const PUSHING_PRS = (state: PrState) => ({
  prBranch: state.prBranch,
  target: state.target ?? state.frozenSha,
})

/** The sha a ref has on the remote, matched on the whole ref: `ls-remote` answers `<sha>\t<ref>` lines. Null: absent. */
const remoteSha = (ports: PrPorts, project: string, ref: string): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const args = ['ls-remote', '--heads', 'origin', ref] as const
    const answer = yield* ports.remote(project, args)
    if (answer.code !== 0) return yield* Effect.fail(new Error(gitSaid(args, answer)))
    for (const line of answer.stdout.split('\n')) {
      const [sha, name] = line.trim().split('\t')
      if (name === ref && sha !== undefined && sha !== '') return sha
    }
    return null
  })

type Turn = StepAnswer | { readonly kind: 'failed'; readonly error: Error }

/**
 * **The only push of a PR branch**, never forced, in the branch's lane turn. Every read is inside the turn. It looks
 * first: a branch at `target` is recorded `existing` and nothing is pushed; one at the last commit Lingtai pushed is
 * fast-forwarded when `target` descends from it; anything else is for a person (`branch-moved`), and a `target` that
 * does not descend from the last push is a pr-fix landing that went first — nothing is appended and the newer pass
 * through In progress starts again.
 */
const pushStep: PrStep = {
  name: 'push',
  run: ({ project, n, ports }) =>
    Effect.gen(function* () {
      const initial = yield* readPr(project, n, ports.store)
      if (initial === null || initial.prBranch === null) return { kind: 'again' } as StepAnswer
      const prBranch = initial.prBranch
      const ref = `refs/heads/${prBranch}`

      const turn = Effect.gen(function* () {
        // Re-read inside the turn: a pr-fix landing that held the lane may have moved the target and the last push.
        const state = yield* readPr(project, n, ports.store)
        if (state === null || state.status !== 'in-progress' || state.prBranch !== prBranch) {
          return { kind: 'again' } as StepAnswer
        }
        const { target } = PUSHING_PRS(state)
        if (target === null) return { kind: 'again' } as StepAnswer
        // Recorded **inside** the lane's turn: once the lane is released a pr-fix pass may move the target, and a
        // record that came after would say this push proved that pass's.
        const pushed = (found: 'pushed' | 'existing') =>
          recordPrPushed(project, n, { headSha: target, found }, ports.store).pipe(
            Effect.as<StepAnswer>({ kind: 'done', headSha: target, record: () => Effect.void }),
          )
        const moved = (at: string | null): StepAnswer => ({
          kind: 'wait',
          reason: 'branch-moved',
          detail:
            at === null
              ? `${prBranch} was pushed (${state.lastPushed?.slice(0, 7)}) and is no longer on the remote; target is ${target.slice(0, 7)}`
              : `${prBranch} is at ${at.slice(0, 7)}, which Lingtai did not push; target is ${target.slice(0, 7)}`,
          headSha: target,
        })

        const at = yield* remoteSha(ports, project, ref)
        if (at === target) return yield* pushed('existing')
        if (at === null && state.lastPushed !== null) return moved(null)
        if (at !== null && at !== state.lastPushed) return moved(at)

        // The commit has to be in the mirror to be pushed from it; a re-cloned mirror loses it, and the walk is run again.
        // git exits 1 or 128 for an object it does not have; the steps that made it are done again.
        const have = yield* ports.git(project, ['cat-file', '-e', `${target}^{commit}`])
        if (have.code === 1 || have.code === 128) return { kind: 'restart' } as StepAnswer
        if (have.code !== 0) return yield* Effect.fail(new Error(gitSaid(['cat-file', '-e', target], have)))
        if (at !== null) {
          const ask = ['merge-base', '--is-ancestor', at, target] as const
          const descends = yield* ports.git(project, ask)
          if (descends.code === 1) return { kind: 'again' } as StepAnswer
          if (descends.code !== 0) return yield* Effect.fail(new Error(gitSaid(ask, descends)))
        }

        // The refspec is built from `prBranch` alone: nothing here can name `branch.main` (0130 §7).
        const push = ['push', 'origin', `${target}:${ref}`] as const
        const answer = yield* ports.remote(project, push)
        if (answer.code === 0) return yield* pushed('pushed')
        // A lost push is one look, never a second blind push (#1125): the branch at `target` is the push having landed.
        const after = yield* remoteSha(ports, project, ref)
        if (after === target) return yield* pushed('pushed')
        return yield* Effect.fail(new Error(gitSaid(push, answer)))
      })

      const answer: Turn = yield* (ports.lane ?? landingLane).through(
        integrationStream(project, prBranch),
        { pr: prStream(project, n) },
        // A step that waits behind a pass appends nothing and is drawn as running.
        { onWait: () => Effect.void },
        turn.pipe(Effect.catch((error: Error) => Effect.succeed<Turn>({ kind: 'failed', error }))),
      )
      if (answer.kind === 'failed') return yield* Effect.fail(answer.error)
      return answer
    }),
}

/** A GitHub failure that is not the person's: no answer, a server error, or a rate limit. The step is run again. */
const notThePersons = (err: GitHubFailed): boolean =>
  err.status === 0 || err.status >= 500 || err.status === 429 || err.ratelimitRemaining === 0 || err.retryAfter !== null

/** What a PR is described as: the facts read for its tickets, and the pure rendering of them. */
export const describePr = (
  ports: PrPorts,
  project: string,
  n: number,
): Effect.Effect<{ title: string; body: string }, Error> =>
  Effect.gen(function* () {
    const state = yield* readPr(project, n, ports.store)
    const tickets = state?.tickets ?? []
    const facts = yield* ports.facts(
      project,
      tickets.map((t) => t.ticket),
    )
    return prDescription({
      title: null,
      summary: null,
      tickets: tickets.map((t) => {
        const read = facts.find((f) => f.ticket === t.ticket)
        return { ...t, open: read?.open ?? null, spend: read?.spend ?? null }
      }),
    })
  })

/**
 * Opens the PR on GitHub as a **draft** (so the project's own `pull_request` workflows run on it), looking first by
 * `head` so a restart opens no second one. On another remote there is nothing to open: the PR is In review, unfollowed.
 */
const openStep: PrStep = {
  name: 'open',
  run: ({ project, n, state, ports }) =>
    Effect.gen(function* () {
      const target = state.target ?? state.frozenSha
      const prBranch = state.prBranch
      if (target === null || prBranch === null) return { kind: 'again' } as StepAnswer
      const recipe = yield* ports.recipe(project)
      if (prHostOf(recipe) === 'none') {
        return {
          kind: 'done',
          headSha: target,
          record: (project, n, store) => recordPrOpened(project, n, { host: 'none', number: null, url: null }, store),
        } as StepAnswer
      }
      const existing = (found: 'opened' | 'existing', pull: { number: number; nodeId: string; url: string }) =>
        ({
          kind: 'done',
          headSha: target,
          record: (project, n, store) =>
            recordPrDraftOpened(project, n, { number: pull.number, nodeId: pull.nodeId, url: pull.url, found }, store),
        }) as StepAnswer
      // A PR opened on an earlier pass through In progress is answered from the state.
      if (state.host !== null) return existing('existing', state.host)

      const github = yield* ports.github(project)
      const found = yield* github.findOpenPull(prBranch).pipe(
        Effect.map(
          (pulls): StepAnswer | { readonly pulls: readonly { number: number; nodeId: string; url: string }[] } =>
            pulls.length === 1 ? { pulls } : pulls.length === 0 ? { pulls: [] } : severalOpen(pulls, target),
        ),
        Effect.catch((err: unknown) =>
          err instanceof GitHubFailed && notThePersons(err)
            ? Effect.succeed({ kind: 'again' } as StepAnswer)
            : Effect.fail(asError(err)),
        ),
      )
      if ('kind' in found) return found
      if (found.pulls[0] !== undefined) return existing('existing', found.pulls[0])

      const described = yield* describePr(ports, project, n)
      const opened = yield* github
        .openDraftPull({ title: described.title, head: prBranch, base: recipe.branch.main, body: described.body })
        .pipe(
          Effect.map((pull) => existing('opened', pull)),
          Effect.catch((err: unknown): Effect.Effect<StepAnswer, Error> => {
            if (err instanceof GitHubFailed && err.status === 422 && /draft/i.test(err.detail)) {
              return Effect.succeed({
                kind: 'wait',
                reason: 'draft-unsupported',
                detail: `${err.detail} — this repository's plan has no draft pull requests, and Lingtai never asks for review before CI`,
                headSha: target,
              })
            }
            if (err instanceof GitHubFailed && notThePersons(err)) return Effect.succeed({ kind: 'again' })
            return Effect.fail(asError(err))
          }),
        )
      return opened
    }),
}

const severalOpen = (pulls: readonly { number: number; url: string }[], target: string): StepAnswer => ({
  kind: 'wait',
  reason: 'several-open',
  detail: `more than one pull request is open from the PR branch: ${pulls.map((p) => `#${p.number} ${p.url}`).join(', ')}`,
  headSha: target,
})

/** How a failing check is named in a wait: its name, how it ended, and where to open it. */
const failingLine = (f: { name: string; state: string; url: string }): string =>
  `${f.name} (${f.state})${f.url === '' ? '' : ` ${f.url}`}`

const checkKey = (c: { name: string; state: string; url: string }): string => JSON.stringify([c.name, c.state, c.url])

/** `failing` is matched by name, state and link together: two checks may share a name and only one of them failed. */
const checkRows = (checks: readonly CiCheck[], failing?: readonly { name: string; state: string; url: string }[]) =>
  checks.map((c) => ({
    name: c.name,
    state: c.state,
    url: c.url,
    ...(failing?.some((f) => checkKey(f) === checkKey(c)) ? { failing: true } : {}),
    ...(c.artifacts !== undefined && c.artifacts.length > 0 ? { artifacts: [...c.artifacts] } : {}),
  }))

/**
 * Reads the project's CI on the PR's head and decides **nothing itself**: `ciVerdict` does (#1339). It runs each time the
 * PR is served — the sweep's `resume` serves every PR In progress on its timer — and answers `again` while the checks
 * run, so there is one append path and one fence (`walkPr`'s target check). A read that fails appends nothing and is
 * read again; a missing permission is `PermissionDenied`, which `walkPr` turns into a wait `denied`.
 * Every CI wait is ended by *check again* (`lingtai pr retry`, #1314): Lingtai never re-runs a workflow.
 */
const ciStep: PrStep = {
  name: 'ci',
  run: ({ project, n, state, ports }) =>
    Effect.gen(function* () {
      if (state.prBranch === null || state.host === null) return { kind: 'again' } as StepAnswer
      const recipe = yield* ports.recipe(project)
      const settings = ciOf(recipe)
      if (ports.ci === undefined && settings.provider !== 'none') return { kind: 'again' } as StepAnswer
      // The head is the pull request's own *now*: the branch is shared, so it moves (a suggestion, *Update branch*, a push).
      const github = yield* ports.github(project)
      const pull = yield* github
        .getPull(state.host.number)
        .pipe(
          Effect.catch((err: unknown) =>
            err instanceof GitHubFailed && !(err instanceof PermissionDenied) && notThePersons(err)
              ? Effect.succeed(null)
              : Effect.fail(asError(err)),
          ),
        )
      if (pull === null) return { kind: 'again' } as StepAnswer
      const target = pull.headSha
      // Recorded as the step's own event, so the verdict and every wait carry the head CI followed.
      yield* recordPrCiFollowing(project, n, { headSha: target }, ports.store)
      const skipped = (why: string): StepAnswer => ({
        kind: 'done',
        headSha: target,
        record: (project, n, store) => recordPrCiSkipped(project, n, { headSha: target, why }, store),
      })
      if (settings.provider === 'none') return skipped('the recipe says pr.ci.provider: none')
      if (ports.ci === undefined) return { kind: 'again' } as StepAnswer
      // Built over the step's own (bounded) GitHub, so no read the adapter makes outlives the walk's limit.
      const provider = yield* ports.ci(project, github)
      if (provider === null) return skipped('the recipe says pr.ci.provider: none')

      const head = {
        sha: target,
        branch: state.prBranch,
        ...(state.host === null ? {} : { pr: { number: state.host.number } }),
      }
      const hostNumber = state.host.number
      const read = Effect.gen(function* () {
        const ci = yield* CiProvider
        if (settings.provider === 'detect') {
          // The head GitHub reported may be one somebody else pushed: the mirror has it only once it is fetched.
          yield* ports.fetch(project)
        }
        if (settings.provider === 'detect' && (yield* ci.detect(head)) === 'none') {
          return skipped('no workflow runs on pull requests')
        }
        const { checks } = yield* ci.observe(target)
        // An `api` provider is started by Lingtai; an on-push one is started by the push, and `start` is a no-op.
        if (ci.capabilities.trigger === 'api' && checks.length === 0) yield* ci.start(head)
        const now = yield* Clock.currentTimeMillis
        const verdict = ciVerdict({
          checks,
          required: settings.required,
          pushedAt: (yield* readPr(project, n, ports.store))?.pushedAt ?? new Date(now),
          now: new Date(now),
          timeoutMs: settings.timeoutMs,
        })
        // A verdict that waits on a person is about the head observed: if the head moved meanwhile, record nothing and
        // answer `again`, so the next sweep follows the new head.
        if (verdict.kind === 'red' || verdict.kind === 'none-started' || verdict.kind === 'timed-out') {
          const now = yield* github.getPull(hostNumber)
          if (now.headSha !== target) return { kind: 'again' } as StepAnswer
        }
        switch (verdict.kind) {
          case 'running':
            return { kind: 'again' } as StepAnswer
          case 'green':
            return {
              kind: 'done',
              headSha: target,
              record: (project, n, store) =>
                recordPrChecked(project, n, { headSha: target, verdict: 'green', checks: checkRows(checks) }, store),
            } as StepAnswer
          case 'red': {
            // The verdict is recorded once per head; the wait that follows is `walkPr`'s own record.
            yield* recordPrChecked(
              project,
              n,
              {
                headSha: target,
                verdict: 'red',
                checks: checkRows(checks, verdict.failing),
              },
              ports.store,
            )
            return {
              kind: 'wait',
              reason: 'ci-red',
              detail: `CI failed on ${target.slice(0, 7)}: ${verdict.failing.map(failingLine).join('; ')}`,
              headSha: target,
            } as StepAnswer
          }
          case 'none-started':
            return {
              kind: 'wait',
              reason: 'ci-none-started',
              detail: `no check started on ${target.slice(0, 7)} within 30 minutes of the push`,
              headSha: target,
            } as StepAnswer
          case 'timed-out':
            return {
              kind: 'wait',
              reason: 'ci-timeout',
              detail: `the checks on ${target.slice(0, 7)} did not finish within the recipe's timeout`,
              headSha: target,
            } as StepAnswer
        }
      }).pipe(Effect.provideService(CiProvider, provider))
      return yield* read.pipe(
        Effect.catch((err: unknown): Effect.Effect<StepAnswer, Error> => {
          if (err instanceof PermissionDenied) return Effect.fail(err)
          // Any other failed read is no verdict: nothing is appended and the next sweep reads again.
          ports.log?.(`pr ${project} PR ${n}: the CI read failed: ${asError(err).message}`)
          return Effect.succeed({ kind: 'again' })
        }),
      )
    }),
}

/**
 * Marks the draft ready for review and records **In review** (`PrOpened`). It looks first (`getPull`): a pull request
 * already not a draft — marked by hand, or by a run that died before recording, or a pr-fix pass's, which is already
 * ready — is not marked again. A host `none` never reaches here: `openStep` appended `PrOpened` and the walk ended.
 */
const readyStep: PrStep = {
  name: 'ready',
  run: ({ project, state, ports }) =>
    Effect.gen(function* () {
      const followed = state.following
      if (followed === null || state.host === null) return { kind: 'again' } as StepAnswer
      const host = state.host
      const github = yield* ports.github(project)
      const pull = yield* github
        .getPull(host.number)
        .pipe(
          Effect.catch((err: unknown) =>
            err instanceof GitHubFailed && !(err instanceof PermissionDenied) && notThePersons(err)
              ? Effect.succeed(null)
              : Effect.fail(asError(err)),
          ),
        )
      if (pull === null) return { kind: 'again' } as StepAnswer
      // A moved head is the ordinary case, never a wait: nothing is marked, and the walk goes back to `ci` on the new head.
      if (pull.headSha !== followed) {
        return {
          kind: 'done',
          headSha: followed,
          record: (project, n, store) => recordPrCiFollowing(project, n, { headSha: pull.headSha }, store),
        } as StepAnswer
      }
      // The gap between this look and the mutation is accepted: GitHub has no "mark ready only if the head is still X".
      if (pull.draft) yield* github.markReadyForReview(host.nodeId).pipe(Effect.mapError(asError))
      return {
        kind: 'done',
        headSha: followed,
        record: (project, n, store) =>
          recordPrOpened(project, n, { host: 'github' as const, number: host.number, url: host.url }, store),
      } as StepAnswer
    }),
}

/**
 * **In progress, as a fixed list.** `push` and `open` here; later tickets fill the rest in 0130 §5's order — `sync` and
 * `build` (#1312) before them, `summary` (#1318) between `ci` and `ready` (#1339).
 * Nothing else orders them, and the PR page draws its *What Lingtai did* rows from this list and the records.
 */
export const IN_PROGRESS_STEPS: readonly PrStep[] = [pushStep, openStep, ciStep, readyStep]

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
      const pending: string[] = []
      for (const landing of yield* landingsInFlight(project, personal, ports.store)) {
        // A landing whose push is certain is owed. One nobody finished is for git to say: the frozen commit holds the
        // branch head if it pushed, whatever became of the ticket (a release or a close takes nothing back), and a
        // head the mirror lacks was never pushed.
        if (landing.headSha === null) {
          pending.push(landing.ticketId)
          continue
        }
        const known = yield* ports.git(project, ['rev-parse', '--verify', '--quiet', `${landing.headSha}^{commit}`])
        if (known.code === 1) continue
        if (known.code !== 0) return yield* refuse('git', gitSaid(['rev-parse', landing.headSha], known))
        const ask = ['merge-base', '--is-ancestor', landing.headSha, frozenSha] as const
        const held = yield* ports.git(project, ask)
        if (held.code === 0) pending.push(landing.ticketId)
        else if (held.code !== 1) return yield* refuse('git', gitSaid(ask, held))
      }
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
      // The answer is about the pass the step began on: a newer pass through In progress (a pr-fix landing) moved the
      // target meanwhile, so nothing is recorded and the walk begins again on it.
      const now = yield* readPr(project, n, ports.store)
      if (now === null || now.status !== 'in-progress' || now.target !== state.target) continue
      if (answer.kind === 'restart') {
        yield* recordPrRestart(project, n, ports.store)
        return
      }
      if (answer.kind === 'wait') {
        yield* recordPrWaiting(
          project,
          n,
          { step: next.name, reason: answer.reason, detail: answer.detail, headSha: answer.headSha },
          ports.store,
        )
        return
      }
      const record = answer.record
      if (record === undefined) {
        yield* recordPrStepDone(project, n, { step: next.name, headSha: answer.headSha }, ports.store)
      } else {
        yield* record(project, n, ports.store)
      }
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

/** Serves every `requested` or `in-progress` PR of the given projects. One PR's failure is that PR's. */
export const servePendingPrs = (
  ports: PrPorts,
  projects: readonly string[],
  steps: readonly PrStep[] = IN_PROGRESS_STEPS,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const say = (line: string) => ports.log?.(line)
    // One PR's failure is that PR's: the others are still owed their serve, and nothing sweeps for them later.
    for (const project of projects) {
      const prs = yield* listPrs(project, ports.store).pipe(
        Effect.catch((err: Error) => Effect.sync(() => (say(`pr resume ${project}: ${err.message}`), [] as PrState[]))),
      )
      for (const pr of prs) {
        if ((pr.status === 'requested' || pr.status === 'in-progress') && pr.n !== null) {
          yield* servePr(ports, project, pr.n, steps).pipe(
            Effect.catch((err: Error) => Effect.sync(() => say(`pr resume ${project} PR ${pr.n}: ${err.message}`))),
          )
        }
      }
    }
  })

/** How long a read (a fetch, a request to the host) may take before it is a failed read: the drain waits on the walk. */
const READ_MS = 60_000

/**
 * The ports with every **read** bounded, so a walk the loop tracks for the drain (0030) can never be held by a fetch or
 * a request that does not answer. A read that times out fails like any failed read — a step answers `again` and the
 * next sweep asks again. A push is not bounded: it is a write, and the drain waits for it on purpose.
 */
const bounded = (ports: PrPorts, ms: number): PrPorts => {
  const within = <A, E>(what: string, e: Effect.Effect<A, E>, fail: () => E): Effect.Effect<A, E> =>
    e.pipe(
      Effect.timeoutOrElse({
        duration: ms,
        // Only the timeout is logged as one: an answer that failed is its own error, said by whoever reads it.
        orElse: () =>
          Effect.sync(() => void ports.log?.(`pr: ${what} did not answer in ${ms}ms`)).pipe(
            Effect.andThen(Effect.fail(fail())),
          ),
      }),
    )
  return {
    ...ports,
    fetch: (project) => within('fetch', ports.fetch(project), () => new Error('the fetch timed out')),
    // `facts` cannot fail: null is *unknown*, which is what a read that never answered is.
    facts: (project, tickets) =>
      ports.facts(project, tickets).pipe(
        Effect.timeoutOrElse({
          duration: ms,
          orElse: () => Effect.succeed(tickets.map((ticket) => ({ ticket, open: null, spend: null }))),
        }),
      ),
    // A push is a write and is waited for; every other `git` against the remote is a read (`ls-remote`).
    remote: (project, args) =>
      args[0] === 'push'
        ? ports.remote(project, args)
        : within('remote', ports.remote(project, args), () => new Error('the remote read timed out')),
    tickets: (project) => within('tickets', ports.tickets(project), () => new Error('the ticket channel timed out')),
    ci:
      ports.ci === undefined
        ? undefined
        : (project, github) =>
            ports.ci!(project, github).pipe(
              Effect.map((provider): CiProviderShape | null =>
                provider === null
                  ? null
                  : {
                      ...provider,
                      detect: (head) =>
                        within('ci detect', provider.detect(head), () => new Error('the CI detect timed out')),
                      observe: (sha) =>
                        within('ci observe', provider.observe(sha), () => new Error('the CI read timed out')),
                    },
              ),
            ),
    // Building the client is itself a request (the installation read), so it is bounded as well as the calls on it.
    github: (project) =>
      within('github', ports.github(project), () => new Error('the GitHub client timed out')).pipe(
        Effect.map((github): GitHub => ({
          ...github,
          findOpenPull: (head) =>
            within('findOpenPull', github.findOpenPull(head), () => new GitHubFailed(0, 'pulls', 'timed out')),
          getPull: (number) =>
            within('getPull', github.getPull(number), () => new GitHubFailed(0, `pulls/${number}`, 'timed out')),
          checkRunsAt: (sha) =>
            within(
              'checkRunsAt',
              github.checkRunsAt(sha),
              () => new GitHubFailed(0, `commits/${sha}/check-runs`, 'timed out'),
            ),
          combinedStatusAt: (sha) =>
            within(
              'combinedStatusAt',
              github.combinedStatusAt(sha),
              () => new GitHubFailed(0, `commits/${sha}/status`, 'timed out'),
            ),
        })),
      ),
  }
}

/** What the sweep last saw of each open PR on the host (`updated_at` and head), so a read that changed nothing ends early. */
type SweepMemory = Map<string, string>

/**
 * Whether the PR's last pushed head is in `refs/heads/<main>` of the mirror: `yes` / `no` by git's exit code, `unknown`
 * for anything else (a failed read, never *no*).
 */
const reachable = (
  ports: PrPorts,
  project: string,
  state: PrState,
): Effect.Effect<'yes' | 'no' | 'unknown' | 'none', Error> =>
  Effect.gen(function* () {
    if (state.lastPushed === null || state.main === null) return 'none' as const
    const ask = ['merge-base', '--is-ancestor', state.lastPushed, `refs/heads/${state.main}`] as const
    const answer = yield* ports.git(project, ask)
    if (answer.code === 0) return 'yes' as const
    if (answer.code === 1) return 'no' as const
    ports.log?.(`pr sweep ${project}: ${gitSaid(ask, answer)}`)
    return 'unknown' as const
  })

/**
 * Asks about one open PR and appends **the transition**, never the state: merged (the host says so, or its head is on
 * `branch.main`) or closed without merging (the host says so, and git does not find it). Anything else — open, a failed
 * read, a 404 — appends nothing and the next sweep asks again. Answers whether this call appended `PrMerged`.
 */
const learnOnePr = (
  ports: PrPorts,
  memory: SweepMemory,
  project: string,
  state: PrState,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const n = state.n
    if (n === null) return false
    const say = (line: string) => ports.log?.(`pr sweep ${project} PR ${n}: ${line}`)
    const recipe = yield* ports.recipe(project)
    const onGitHub = prHostOf(recipe) === 'github'

    let host: PullState | null = null
    let key: string | null = null
    if (onGitHub && state.host !== null) {
      const number = state.host.number
      host = yield* ports.github(project).pipe(
        Effect.flatMap((github) => github.getPull(number)),
        Effect.catch((err: unknown) =>
          Effect.sync(() => (say(`read of #${number} failed: ${asError(err).message}`), null)),
        ),
      )
      if (host !== null) {
        key = `${host.state} ${host.merged} ${host.updatedAt} ${host.headSha}`
        // An answer equal to the last one ends the host's part here; git is still asked, it costs nothing.
        if (memory.get(prStream(project, n)) === key) host = null
      }
    } else if (!onGitHub) {
      yield* ports.fetch(project)
    }

    const git = yield* reachable(ports, project, state)
    const pushed = state.lastPushed

    if (host !== null && host.merged) {
      yield* recordPrMerged(
        project,
        n,
        { how: 'host', headSha: host.headSha, mergeSha: host.mergeCommitSha },
        ports.store,
      )
      return true
    }
    if (git === 'yes' && pushed !== null) {
      return yield* recordPrMerged(project, n, { how: 'git', headSha: pushed, mergeSha: null }, ports.store)
    }
    if (host !== null && host.state === 'closed' && (git === 'no' || git === 'none')) {
      yield* recordPrClosed(project, n, { headSha: host.headSha }, ports.store)
      return false
    }
    if (host !== null && key !== null && host.state === 'open') memory.set(prStream(project, n), key)
    return false
  })

/**
 * Closes every ticket a merged PR held, keyed by its `PrMerged`: a ticket whose stream already has
 * `IssueUpdated { change: 'closed' }` after it is skipped, so a second sweep closes none and a restart in the middle
 * finishes the rest. Every merged PR is visited, so a close that failed under an earlier PR is retried after later
 * ones merge; `memory` remembers a PR whose tickets are all closed, so the reads stop once it is done.
 */
const closeMergedTickets = (
  ports: PrPorts,
  memory: SweepMemory,
  project: string,
  state: PrState,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (state.status !== 'merged' || state.ended === null || state.n === null) return
    const doneKey = `closed ${prStream(project, state.n)}`
    if (memory.get(doneKey) === 'done') return
    const after = state.ended.seq
    let channel: IssueChannel | null = null
    for (const t of state.tickets) {
      const ticketId = ticketStream(project, t.ticket)
      const events = yield* Effect.tryPromise({ try: () => ports.store.read(ticketId), catch: asError })
      const closed = events.some(
        (e) => e.type === 'IssueUpdated' && e.seq > after && (e.data as PayloadOf<'IssueUpdated'>).change === 'closed',
      )
      if (closed) continue
      channel ??= yield* ports.tickets(project)
      yield* tellGitHubEffect({ store: ports.store, github: channel, ticketId, change: { kind: 'closed' } })
    }
    // Only a pass that found every ticket with a recorded close is done (a failed close is `IssueUpdateFailed`).
    let all = true
    for (const t of state.tickets) {
      const events = yield* Effect.tryPromise({
        try: () => ports.store.read(ticketStream(project, t.ticket)),
        catch: asError,
      })
      if (
        !events.some(
          (e) =>
            e.type === 'IssueUpdated' && e.seq > after && (e.data as PayloadOf<'IssueUpdated'>).change === 'closed',
        )
      )
        all = false
    }
    if (all) memory.set(doneKey, 'done')
  })

/**
 * The sweep's read (#1317): for each project, the latest PR if it is open, asked about once; then the tickets of the
 * merged PRs closed. One project's failure is that project's.
 */
export const learnPrEnds = (
  ports: PrPorts,
  projects: readonly string[],
  memory: SweepMemory = new Map(),
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const project of projects) {
      yield* Effect.gen(function* () {
        const latest = yield* latestPr(project, ports.store)
        if (latest !== null && isOpen(latest) && latest.status !== 'requested') {
          yield* learnOnePr(ports, memory, project, latest)
        }
        const prs = yield* listPrs(project, ports.store)
        for (const merged of prs.filter((p) => p.status === 'merged')) {
          yield* closeMergedTickets(ports, memory, project, merged).pipe(
            Effect.catch((err: Error) => Effect.sync(() => ports.log?.(`pr sweep ${project}: ${err.message}`))),
          )
        }
      }).pipe(Effect.catch((err: Error) => Effect.sync(() => ports.log?.(`pr sweep ${project}: ${err.message}`))))
    }
  })

/**
 * The handlers the loop's `pr` option takes. `serve` answers the event's own stream — or, for a ticket's event (a
 * landing that ended, a release, a close), the PRs of that ticket's project, since a freeze that gave up waiting on a
 * landing is served again by what ends it. `resume` serves every PR of every project that is `requested` or
 * `in-progress`.
 */
export const makePrHandlers = (
  raw: PrPorts,
  steps: readonly PrStep[] = IN_PROGRESS_STEPS,
  readMs: number = READ_MS,
) => {
  const ports = bounded(raw, readMs)
  const memory: SweepMemory = new Map()
  const projectsOf = (label: string) =>
    ports.projects().pipe(
      Effect.catch((err: Error) =>
        Effect.sync(() => {
          ports.log?.(`${label}: ${err.message}`)
          return [] as readonly string[]
        }),
      ),
    )
  return {
    serve: (event: Envelope): Effect.Effect<void> => {
      const named = parsePrStream(event.streamId)
      if (named !== null) return servePr(ports, named.project, named.n, steps).pipe(Effect.orDie)
      const ticket = parseTicketStream(event.streamId)
      if (ticket === null) return Effect.void
      return servePendingPrs(ports, [ticket.project], steps)
    },
    resume: (): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* servePendingPrs(ports, yield* projectsOf('pr resume'), steps)
      }),
    /**
     * What the daemon runs at startup and on its sweep timer, **paused or not** — learning that a PR merged records a
     * fact and takes no work: what each open PR came to, and the tickets of a merged one closed. It pushes nothing, so it
     * can be interrupted; the walks owed are `resume`'s.
     */
    sweep: (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const projects = yield* projectsOf('pr sweep')
        yield* learnPrEnds(ports, projects, memory)
      }),
  }
}
