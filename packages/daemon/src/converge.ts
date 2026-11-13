// A leaf module that imports nothing, which is why it is its own file: the
// sweep's names have to be one string on the side that publishes them and on
// both sides that delete them (`#240`).
import { agentBranch, armPrefix } from '@lingtai/conductor/branches'
/**
 * GitHub says what the log says — computed, never replayed.
 *
 * This is the half of the outbox deletion that was owed. `442f513` deleted the
 * retry queue, the backoff and the dead letter on the argument that **the
 * target is computable**: you do not need to remember a failed call if you can
 * work out from the log what the issue ought to look like and write the
 * difference. That argument was sound and the code that made it good did not
 * exist until now (`#69`), which is why `lingtai doctor` had a check that could
 * fail permanently with nobody to hand the divergence to.
 *
 * ## Convergence, not replay
 *
 * Nothing here re-sends a failed call. `labelsFor(state)` is the target, the
 * issue's current labels are the actual, and the write is the difference. Three
 * consequences fall out, and they are the reason this shape was chosen:
 *
 * - An issue somebody fixed by hand needs no write, and gets none.
 * - An issue that drifted for three unrelated reasons is fixed by one pass.
 * - There is no attempt counter, so there is nothing that can exhaust.
 *
 * ## What cannot converge, and is said rather than hidden
 *
 * **A comment is not computable.** Its text was a one-off — a question, a merge
 * sha — and nothing in the log lets a later pass reconstruct *and re-decide*
 * that it should still be said. So a failed comment is reported and left, and
 * `doctor` grades it `warn`: a fact for a person, not a job for a machine.
 * Silently re-sending it would be replay wearing convergence's clothes.
 *
 * **A refs sweep is computable, and that is why it is here** (`#240`). `end`'s
 * third effect deletes a landed item's `agent/<n>-attempt-<k>` refs, and a
 * refusal there used to have nowhere to go: `doctor` put it in the same bucket
 * as a failed label write and told an operator that the next reconcile would
 * write the difference, while the only function that swept was `tell.ts`'s and
 * the resolution it runs from is deduped per outcome — so nothing ran it again
 * and the sentence was false. The target is *no arm under this issue's branch*,
 * which needs no decision re-made: it is `armPrefix` and one request. So the
 * arms are asked for again here and deleted, and — like every other change —
 * the row this writes is the same `IssueUpdated` the inline path writes.
 *
 * ## What it looks at, and why not everything
 *
 * One `getIssue` per candidate, and the candidates are the items about which
 * the log currently *claims something about GitHub*:
 *
 * - every work item that is `claimed` or `blocked` — `labelsFor` says those
 *   should be carrying a label right now, so a missing one is a divergence;
 * - every work item whose last word on some change was `IssueUpdateFailed` —
 *   the log says we tried and did not manage.
 *
 * A landed item whose label-clear succeeded is not read, because the log has no
 * outstanding claim about it. That bound is the difference between a startup
 * cost of a dozen reads and one of every issue the project has ever had.
 */
// Subpaths, never the barrel. `@lingtai/conductor`'s index pulls in the gate
// pipeline and its child-process types, and the board imports this package —
// so a barrel import here is a compile error three packages away.
import {
  clientForSeam,
  recipeForSeam,
  ticketsOfSeam,
  type ClientFor,
  type ClientForEffect,
  type RecipeFor,
  type RecipeForEffect,
} from '@lingtai/conductor/filter'
import { foreignLabels, labelsFor } from '@lingtai/conductor/labels'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { loadProjectsEffect } from '@lingtai/conductor/projects'
// One wording for *what a part-way sweep had already deleted*, shared rather
// than written twice: the inline sweep and this one record the same row.
import { sweepFailure, type RefChannel } from '@lingtai/conductor/tell'
import { ticketedClientOf, ticketsForEffect, type ticketsFor, type Tickets } from '@lingtai/conductor/ticket-store'
import {
  parseTicketStream,
  parsePayload,
  reduceTicket,
  WAIT_EVENTS,
  TICKET_STREAM_PREFIX,
  type LabelState,
  type PayloadOf,
  type ProjectState,
  type TicketStatus,
} from '@lingtai/domain'
import { githubClientAuth, hasGitHubAuth } from '@lingtai/env'
import { paint } from '@lingtai/env/colour'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { createGitHubClient } from '@lingtai/github'
import { Cause, Effect } from 'effect'

import { withDaemonStore } from './choose.ts'
import type { DaemonStore } from './store.ts'

/** A project this daemon start could not read a recipe for, and why. */
export interface UnresolvedProject {
  project: string
  problem: string
}

/** What `clientsForProjects` could build, and what it could not and why. */
export interface ProjectClients {
  clients: Map<string, Tickets & RefChannel & { readonly owner: string | null; readonly repo: string }>
  unresolved: UnresolvedProject[]
}

/**
 * One client per registered project.
 *
 * **A project with no owner (`#355`) builds no `GitHubClient` and needs no
 * App.** It goes through `ownerlessClient` instead — the same assembly
 * `apps/cli/src/run.ts` and `apps/cli/src/conduct.ts`'s per-project work use
 * — and is attempted whether or not `hasAuth()` answers true, because there is
 * no GitHub half for an App to gate here. The App check stays, but only on
 * the GitHub branch below: no App there still makes the whole check a no-op
 * for that project rather than an error — a machine with no credentials still
 * wants its worktrees cleaned and its expired claims returned, for every
 * project, which `reconcile` reads off `findOrphans`/`findOrphanLogs`/
 * `releaseForeignClaims` rather than off this map.
 *
 * A GitHub project whose client will not build is skipped and the others go
 * on. One repository's expired installation must not cost the rest their
 * convergence.
 *
 * **The value is `ticketedClientOf`'s shape, not `GitHubClient`** (`#382`): a
 * `db` project's ticket verbs read `dbTickets` rather than GitHub, and
 * everything this map's one reader (`findIssueDrift`/`convergeIssues`,
 * `ConvergeOptions.clients`) asks of a value is `Tickets` and `RefChannel`.
 *
 * **The client building and the recipe resolving fail independently, and a
 * recipe that will not resolve drops the project rather than falling back to
 * the raw client.** A recipe that throws — the daemon running code that
 * cannot serve a step the recipe names (#76), a `db` project's own
 * `TicketSourceConflict`, or `ownerlessRefusal`'s own sentence — leaves this
 * function not knowing whether the project's tickets live on GitHub or in
 * `dbTickets`. Handing `convergeIssues` the raw client for what might be a
 * `db` project means its ticket numbers are asked of GitHub as issue numbers,
 * which can write Lingtai's labels onto, and close, an unrelated GitHub issue
 * that happens to share the number. So this project is dropped from
 * `clients` instead — "one repository's expired installation must not cost
 * the rest theirs," extended to a recipe that will not resolve — and
 * **returned in `unresolved` rather than logged here** (`#389`): this
 * function has one caller, at daemon startup, so there is no sweep for a line
 * printed from inside it to repeat; the caller reports each entry once and
 * `lingtai doctor` reads the same filter live.
 */
export function clientsForProjectsEffect(
  projects: readonly ProjectState[],
  options: {
    hasAuth?: () => boolean
    clientFor?: ClientForEffect
    recipeFor?: RecipeForEffect
    /** The seam a test needs: `ownerlessClient`'s own third argument, following `projectFilter`'s fourth (`filter.ts`). */
    ticketsOf?: typeof ticketsForEffect
  } = {},
): Effect.Effect<ProjectClients> {
  return Effect.gen(function* () {
    const hasAuth = options.hasAuth ?? hasGitHubAuth
    // Not `clientForSeam(undefined)`: that default re-checks the process's own App and ignores `hasAuth`.
    const clientFor: ClientForEffect =
      options.clientFor ??
      ((p) =>
        Effect.tryPromise({
          try: () => createGitHubClient({ auth: githubClientAuth(), owner: p.owner!, repo: p.project! }),
          catch: (e) => e as Error,
        }))
    const recipeFor = options.recipeFor ?? recipeForSeam(undefined)
    const ticketsOf = options.ticketsOf ?? ticketsForEffect
    const clients = new Map<string, Tickets & RefChannel & { readonly owner: string | null; readonly repo: string }>()
    const unresolved: UnresolvedProject[] = []
    const reachable = hasAuth()
    for (const p of projects) {
      const project = p.project
      if (!project) continue

      // Not known whether this project's tickets are GitHub's or dbTickets' —
      // see the doc comment above for why that rules out falling back to the
      // raw client. A defect is reported as a failure is, as the `try` it replaces did.
      const unresolve = (cause: Cause.Cause<unknown>) =>
        unlessInterrupted(cause, () =>
          Effect.sync(() => {
            unresolved.push({ project, problem: oneLine(messageOf(cause)) })
          }),
        )

      if (p.owner === null) {
        // Never `clientFor`: there is no GitHub client to build.
        yield* Effect.gen(function* () {
          const resolved = yield* recipeFor(p, undefined)
          const { client } = yield* ownerlessClientEffect(p, resolved.recipe, ticketsOf)
          clients.set(project, client)
        }).pipe(Effect.catchCause(unresolve))
        continue
      }

      if (!reachable) continue
      // Named by its absence: the divergence for that project simply is not
      // found, and `doctor` still reports what the log says was not managed.
      const built = yield* clientFor(p).pipe(
        Effect.catchCause((cause) => unlessInterrupted(cause, () => Effect.succeed(null))),
      )
      if (built === null) continue
      yield* Effect.gen(function* () {
        const resolved = yield* recipeFor(p, built)
        clients.set(project, ticketedClientOf(built, yield* ticketsOf(p, resolved.recipe, built)))
      }).pipe(Effect.catchCause(unresolve))
    }
    return { clients, unresolved }
  })
}

/** `clientsForProjectsEffect` over promise seams (a listed face, #790). */
export function clientsForProjects(
  projects: readonly ProjectState[],
  options: {
    hasAuth?: () => boolean
    clientFor?: ClientFor
    recipeFor?: RecipeFor
    ticketsOf?: typeof ticketsFor
  } = {},
): Promise<ProjectClients> {
  return Effect.runPromise(clientsForProjectsEffect(projects, effectSeams(options)))
}

/** Each promise seam a test handed in, lifted once; one it did not is left to the Effect's own default. */
function effectSeams(options: {
  hasAuth?: () => boolean
  clientFor?: ClientFor
  recipeFor?: RecipeFor
  ticketsOf?: typeof ticketsFor
}): Parameters<typeof clientsForProjectsEffect>[1] {
  return {
    ...(options.hasAuth === undefined ? {} : { hasAuth: options.hasAuth }),
    ...(options.clientFor === undefined ? {} : { clientFor: clientForSeam(options.clientFor) }),
    ...(options.recipeFor === undefined ? {} : { recipeFor: recipeForSeam(options.recipeFor) }),
    ...(options.ticketsOf === undefined ? {} : { ticketsOf: ticketsOfSeam(options.ticketsOf) }),
  }
}

/** A promise as an Effect whose failure is the rejection itself, unwrapped — what the `catch` below reads `.message` off. */
const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> => Effect.tryPromise({ try: f, catch: (e) => e })

/** The message of whatever a step failed with, whether it failed or died. */
const messageOf = (cause: Cause.Cause<unknown>): string => (Cause.squash(cause) as Error).message

/**
 * What a swallow-all `catch` keeps: every cause is answered, an interrupt is not.
 * A store or a seam of the process is a defect when it throws, so `Effect.catch` alone would miss it.
 */
const unlessInterrupted = <B>(cause: Cause.Cause<unknown>, answer: () => Effect.Effect<B>): Effect.Effect<B> =>
  Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : answer()

/** A promise that is allowed to fail: its answer, or `fallback` for a failure or a defect. */
const orElse = <A, B>(f: () => Promise<A>, fallback: B): Effect.Effect<A | B> =>
  attempt(f).pipe(Effect.catchCause((cause) => unlessInterrupted(cause, () => Effect.succeed(fallback))))

/**
 * `RecipeInvalidError` puts one problem per line, which reads well in a
 * thrown message and badly reduced into one. `@lingtai/conductor/filter` does
 * the same reduce for the same reason, in a function of the same name it does
 * not export.
 */
function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * The lifecycle a work item is in, in the vocabulary `labelsFor` speaks.
 *
 * The projection's `TaskState` and the reducer's `TicketStatus` are two names
 * for one idea and this is the one place they meet. Read from the *reducer*
 * rather than from `task_view`, because reconciliation has to work when a
 * projection is the thing that is broken.
 */
function labelState(status: TicketStatus): LabelState {
  switch (status) {
    case 'claimed':
      return 'running'
    case 'blocked':
      return 'waiting'
    // **An approval is not finished with** (#465) — a continuation is owed,
    // and the `default` arm below would strip the label entirely, making an
    // approved issue indistinguishable from a landed or untouched one.
    // `'approved'` and not `'running'` (#510): `labelsFor` gives it the same
    // `working` label `claimed` gets, because Lingtai, not a person, holds
    // the next move — but `running` is read by `inFlight()` as a conductor
    // actually holding the item, which an approval with no continuation
    // claimed yet is not.
    case 'approved':
      return 'approved'
    default:
      // `backlog`, `landed` and `closed` all want no Lingtai label — a
      // queued item has not been touched, and a landed or closed one is
      // finished with.
      return 'landed'
  }
}

export interface Divergence {
  /** The work item's own stream, so a finding points at the log. */
  ticketId: string
  project: string
  issue: number
  change: 'labels' | 'closed' | 'comment' | 'refs'
  /**
   * What the write is, in the vocabulary the change needs, because `Divergence`
   * carries no payload of its own: the target labels for `labels`, and for
   * `refs` the refs that are to be gone — `", "`-joined either way, so the one
   * place that writes them splits on the same string it was joined with.
   */
  expected: string
  actual: string
}

export interface ConvergeOptions {
  store?: EventStore
  url?: string
  /**
   * Where the candidate streams are looked up. Defaults to the store this
   * machine wrote down, at `url` where Postgres is what it wrote (#179).
   *
   * As `reconcile`'s: `store` is the log this reads and appends through, and
   * this answers the one question about the log that `EventStore` does not —
   * *which streams are worth reducing*. Given without `store`, the log read is
   * the one this carries — see `logOf`.
   */
  daemonStore?: DaemonStore
  /** Injected so a test needs no GitHub App. Keyed by project name. */
  clients?: ReadonlyMap<string, Pick<Tickets, 'getIssue' | 'setLabels' | 'closeIssue'> & RefChannel>
  /** Injected so a test needs no `prj-` streams. */
  projects?: readonly ProjectState[]
  dryRun?: boolean
  log?: (line: string) => void
}

/**
 * Work items the log currently claims something about, on GitHub.
 *
 * One read, and a narrow one: a `ticket-` stream is a candidate only if something
 * in it has moved a work item, which is far fewer streams than exist. Whether
 * each candidate is *actually* diverged is decided per item below, against the
 * log and then against GitHub — that part cannot be SQL, because the target
 * comes from `labelsFor` rather than from a table.
 */
/**
 * The log this reads and appends through: **the one the candidates came from.**
 *
 * `store` when a caller named one, and otherwise the log the injected
 * `daemonStore` carries, never the process-wide one. `candidates()` returns
 * stream ids from whichever store it was given, and reducing those ids out of a
 * different log answers *no drift* rather than failing — see `reconcile.ts`'s
 * `logOf`, which is the same rule for the same reason.
 */
function logOf(options: ConvergeOptions): EventStore {
  return options.store ?? options.daemonStore?.events ?? eventStore
}

function candidates(store: DaemonStore): Effect.Effect<Set<string>> {
  return store
    .streams({
      prefixes: [`${TICKET_STREAM_PREFIX}%`],
      // A continuation is claim-shaped (`claimShapeOf`); `reduceTicket` reduces it.
      types: ['TicketClaimed', 'TicketContinued', ...WAIT_EVENTS, 'TicketReleased', 'TicketLanded'],
    })
    .pipe(Effect.map((found) => new Set(found)))
}

/**
 * What GitHub would have to change to agree with the log.
 *
 * Reads only, so `lingtai doctor` can say what a reconcile would do without
 * making it happen — the same split `findOrphans` has.
 */
export const findIssueDriftEffect = (options: ConvergeOptions = {}): Effect.Effect<Divergence[]> =>
  Effect.gen(function* () {
    const store = logOf(options)
    // One read through a store opened for it and closed after it — the whole use
    // this makes of a `DaemonStore`. An injected one is the caller's and stays
    // open (`choose.ts`). A store that will not open is a defect out of here.
    const streams = yield* withDaemonStore(
      options.daemonStore,
      options.url === undefined ? {} : { url: options.url },
      candidates,
    )
    const projects = options.projects ?? (yield* loadProjectsEffect())
    const byName = new Map(projects.filter((p) => p.project).map((p) => [p.project!, p]))

    const found: Divergence[] = []

    for (const ticketId of streams) {
      const parsed = parseTicketStream(ticketId)
      if (!parsed) continue
      const issue = Number(parsed.issue)
      if (!Number.isInteger(issue)) continue
      if (!byName.has(parsed.project)) continue

      const events = yield* orElse(() => store.read(ticketId), [])
      if (events.length === 0) continue
      const item = reduceTicket(events)
      const wanted = labelsFor(labelState(item.lifecycle.status))

      // What the log last said it managed, per change, is `item.github.last`: a
      // failure with no later success is an outstanding claim; a success after it
      // means somebody or something already got there. A rewritten waiting
      // comment (#750) is attempted once and never repaired, so it is no
      // divergence and no reason to read the issue — excluded here, once.
      const failed = (c: keyof typeof item.github.last) =>
        c !== 'comment-edited' && item.github.last[c]?.outcome === 'failed'
      // And what it last said it *wrote*. An item that should carry no label but
      // was given one is drift the log can see on its own, without a request.
      const lastWrote: readonly string[] = item.github.labels ?? []
      // And whether a `refs:` effect was ever resolved for this item, with what
      // the recipe asked of it. Read off `EndActionsResolved` rather than assumed
      // from the failure row, because `branch` is the recipe's decision and
      // convergence must not widen it: an item swept with `branch: false` keeps
      // `agent/<n>` however often the sweep is retried.
      let sweep: { branch: boolean } | null = null
      for (const e of events) {
        if (e.type === 'EndActionsResolved') {
          for (const a of (e.data as PayloadOf<'EndActionsResolved'>).actions) {
            if ('refs' in a) sweep = { branch: a.branch }
          }
        }
      }

      const outstanding = (Object.keys(item.github.last) as (keyof typeof item.github.last)[]).some(failed)
      // A label Lingtai put on and no longer wants.
      //
      // Without this the commonest drift there is was invisible: a released or
      // landed item wants no label, so `wanted` is empty, so the item was skipped
      // and the `lingtai:working` it is still wearing was never seen. Found the
      // first time a run was killed mid-flight — the release landed, the label
      // stayed, and reconcile walked straight past it.
      const stale = wanted.length === 0 && lastWrote.length > 0

      // Nothing outstanding, nothing to hold, nothing left over: the log is not
      // claiming anything about this issue, so it is not worth a request.
      if (wanted.length === 0 && !outstanding && !stale) continue

      const client = options.clients?.get(parsed.project)
      if (!client) continue

      const current = yield* orElse(() => client.getIssue(issue), null)
      if (!current) continue

      // Names. GitHub sends each label's colour too, and convergence has no use
      // for it: what the log implies is a set of names, and the difference this
      // computes is between two sets of names.
      const carried = current.labels.map((l) => l.name)
      const target = [...new Set([...foreignLabels(carried), ...wanted])].sort()
      const actual = [...carried].sort()
      if (target.join(',') !== actual.join(',')) {
        found.push({
          ticketId,
          project: parsed.project,
          issue,
          change: 'labels',
          expected: target.join(', ') || '(no labels)',
          actual: actual.join(', ') || '(no labels)',
        })
      }

      if (failed('closed') && current.state === 'open') {
        found.push({
          ticketId,
          project: parsed.project,
          issue,
          change: 'closed',
          expected: 'closed — the log says the end step asked and did not manage',
          actual: 'open',
        })
      }

      if (failed('comment')) {
        found.push({
          ticketId,
          project: parsed.project,
          issue,
          change: 'comment',
          // Deliberately not repaired. See the header: a comment's text was a
          // one-off decision and a later pass cannot re-make it.
          expected: 'a comment the log says was never posted',
          actual: 'not there, and not computable — say it by hand if it still matters',
        })
      }

      // **The arms a sweep did not manage to delete** (`#240`).
      //
      // Computable, unlike a comment: the target is *no
      // `agent/<n>-attempt-<k>` under this item's branch*, and what is actually
      // there is one read away. Both conditions are needed and neither is the
      // other — the log has to say a sweep was resolved *and* that its last word
      // was a refusal, because an item nobody configured a `refs:` effect for has
      // arms on purpose.
      //
      // **Asked of GitHub rather than read off the failed row.** A sweep that
      // deleted two arms and was refused the third leaves one row saying it
      // failed, and only the remote knows which two went — so the row is evidence
      // that something is owed and never the list of what.
      if (sweep && failed('refs')) {
        const branch = agentBranch(issue)
        const arms = armPrefix(branch)
        // A read that is allowed to fail: this function repairs nothing, and a
        // request refused here means the divergence is simply not found this
        // pass. `doctor` still reports the row the log holds.
        const live = yield* orElse(() => client.matchingRefs(`heads/${branch}`), null)
        const doomed = (live ?? []).filter(
          (ref) => ref.startsWith(`heads/${arms}`) || (sweep.branch && ref === `heads/${branch}`),
        )
        if (doomed.length > 0) {
          found.push({
            ticketId,
            project: parsed.project,
            issue,
            change: 'refs',
            expected: doomed.join(', '),
            actual: `${doomed.length} still on origin — the log says the sweep asked and did not manage`,
          })
        }
      }
    }

    return found
  })

/**
 * Writes the difference, and appends what it wrote.
 *
 * Each write is recorded with the same `IssueUpdated` the inline path appends,
 * so `doctor`'s check goes quiet by the log agreeing with itself rather than by
 * anything being marked resolved. That is the property worth having: there is
 * no second bookkeeping to get out of step with the first.
 */
export const convergeIssuesEffect = (
  options: ConvergeOptions = {},
): Effect.Effect<{ divergences: Divergence[]; converged: Divergence[] }> =>
  Effect.gen(function* () {
    const log = options.log ?? (() => {})
    const store = logOf(options)
    const divergences = yield* findIssueDriftEffect(options)
    const converged: Divergence[] = []
    if (options.dryRun) return { divergences, converged }

    for (const d of divergences) {
      // The one place an interrupt is taken between divergences: each step below is uninterruptible, and
      // without a point outside one a fiber asked to stop would write them all.
      yield* Effect.yieldNow
      const client = options.clients?.get(d.project)
      if (!client) continue
      // Nothing to write, by design.
      if (d.change === 'comment') continue

      // What a part-way sweep had already deleted when it was refused, so the
      // failure row can name it — `sweepRefs`'s rule and its wording, because a
      // delete is one call per ref and the second one can be the one GitHub says
      // no to. Empty for every other change, which is one call and no partial.
      const gone: string[] = []
      const write =
        d.change === 'labels'
          ? attempt(() => client.setLabels(d.issue, d.expected === '(no labels)' ? [] : d.expected.split(', ')))
          : d.change === 'refs'
            ? Effect.forEach(
                d.expected.split(', '),
                (ref) =>
                  attempt(() => client.deleteRef(ref)).pipe(Effect.tap(() => Effect.sync(() => void gone.push(ref)))),
                { discard: true },
              )
            : attempt(() => client.closeIssue(d.issue))

      // **A write and its record are one step** (#1073): an interruption between them would leave a write
      // GitHub has and the log does not, which is converged again next start, and a second `deleteRef`
      // is a refusal recorded as a failure.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const failure = yield* write.pipe(
            Effect.map(() => null),
            Effect.catch((err) => Effect.succeed({ err })),
          )
          if (failure === null) {
            yield* record(store, d.ticketId, 'IssueUpdated', {
              project: d.project,
              issue: String(d.issue),
              change: d.change,
              detail: `converged by reconcile: ${d.expected}`,
            })
            converged.push(d)
            // A repair that came out right, in the colour a verdict that passed
            // wears. It is not chrome: something was wrong and now is not.
            log(paint.pass(`reconciled: ${d.project}#${d.issue} ${d.change} — ${d.expected}`))
            return
          }
          // Recorded, not retried. The next reconcile recomputes the target from
          // the log and tries again on its own; a counter here would be the
          // machinery 0022 deleted, growing back one field at a time.
          yield* record(store, d.ticketId, 'IssueUpdateFailed', {
            project: d.project,
            issue: String(d.issue),
            change: d.change,
            error: sweepFailure(failure.err, gone),
          })
          log(
            paint.fail(
              `reconcile could not converge ${d.project}#${d.issue} ${d.change}: ${(failure.err as Error).message}`,
            ),
          )
        }),
      )
    }

    return { divergences, converged }
  })

/** Same silence as `tell.ts`: losing the record must not lose the write. */
const record = (
  store: EventStore,
  ticketId: string,
  type: 'IssueUpdated' | 'IssueUpdateFailed',
  data: Record<string, string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const at = (yield* attempt(() => store.read(ticketId))).length
    yield* attempt(() => store.append(ticketId, at, [{ type, actor: 'conductor', data: parsePayload(type, data) }]))
  }).pipe(
    // The next pass recomputes from GitHub, so an unwritten record costs a
    // request rather than a fact. A defect is swallowed too: a failed append that killed
    // the converge would skip every remaining divergence and leave no `Reconciled`.
    Effect.catchCause((cause) => unlessInterrupted(cause, () => Effect.void)),
  )
