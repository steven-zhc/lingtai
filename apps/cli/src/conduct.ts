/**
 * One pass of the conductor, for the daemon to call.
 *
 * A pass is: ask GitHub what is runnable, write it into `task_view`, and take
 * **one** item. One rather than draining, because the completion event that
 * item produces is what triggers the next pass — so the loop advances by
 * itself, and an operator's pause (#45) can take effect between items instead
 * of only after a whole queue has been worked.
 *
 * This lives in the CLI and not in `@lingtai/daemon` on purpose. The daemon
 * hosts a loop and knows nothing about GitHub clients, runtimes or prompts;
 * assembling those is what this application already does for `lingtai run`, and
 * giving the daemon package those dependencies would make it the thing it is
 * supposed to be hosting.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createRuntime, type Runtime } from '@lingtai/agent'
import {
  ownerlessClient,
  PortsLive,
  currentRecipe,
  loadProjects,
  passClientOf,
  readFixFiles,
  runOnce,
  runQueue,
  runnableNow,
  selectRunnable,
  ticketsFor,
  type PassClient,
  type RunOnceResult,
  type ScheduleResult,
  type Slots,
  type Tickets,
} from '@lingtai/conductor'
import { readControl } from '@lingtai/daemon'
import {
  type ControlState,
  type ProjectState,
  passTransition,
  projectStream,
  reduceProject,
  reduceTicket,
  ticketStream,
} from '@lingtai/domain'
import { githubApp, hasGitHubApp, machineDayCeiling, repoRoot } from '@lingtai/env'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { createGitHubClient, type CreateClientOptions, type GitHubClient } from '@lingtai/github'
import type { Recipe, ResolvedRecipe } from '@lingtai/recipe'
import { baseOf, concurrencyOf, kindsOf, queueOf } from '@lingtai/recipe/settings'
import type { TokenSource } from '@lingtai/repo'
import { Effect } from 'effect'

/** Lingtai's own checkout — the hook binary and the prompt template. */
const root = repoRoot()

export interface ConductOptions {
  /** False holds every item at the merge instead of landing it. */
  merge?: boolean
  hookBinary?: string
  promptPath?: string
  /** How many items one pass may take. One, so completion drives the loop. */
  max?: number
  /** The daemon's in-flight set and where a started pass is handed (0122); absent, every pass is awaited. */
  slots?: Pick<PassSlots, 'set' | 'started'>
  /**
   * The commit this process was loaded from, read once at its start and never
   * per pass — the checkout is exactly what moves under loaded modules. Carried
   * on a `ProjectRefused`, so the log can tell a broken recipe from a process
   * too old for a good one (#148).
   */
  codeSha?: string | null
  /**
   * Whether the conductor is paused *now*, as a sentence, or null — asked
   * before each project and before each ticket, not once for the pass (#210).
   *
   * The control read below is once per pass, and a pass walks every registered
   * project: a run that meets an account-wide wall appends the conductor's own
   * pause (0031 §3), and without this the next project was claimed in the same
   * pass, straight into the same wall. Scoped by the caller to what was
   * appended while it runs (#159), which is why it is handed in.
   */
  paused?: () => Promise<string | null>
  log?: (line: string) => void
  /** The resolved recipe each project's pass actually used. */
  onRecipe?: (project: string, recipe: Recipe) => void
}

export interface PassOutcome {
  /** Projects looked at. */
  projects: number
  /** Items run across all of them. */
  ran: number
  /** Projects that could not be looked at, and why. */
  refused: { project: string; detail: string }[]
}

/**
 * What one project's share of a pass reaches outside the process:
 * `createGitHubClient`, `currentRecipe`, `ticketsFor`, `selectRunnable`
 * (which reads `task_view`), `runOnce` and `runQueue` (`#355`).
 *
 * `conductProjects` was already a seam (`conduct-pause.test.ts`), but `work` —
 * what each project's share of a pass does — was a closure inside
 * `conductorPass` with no way to drive it under the unit half. `ConductWorld`
 * is that seam, following `apps/cli/src/run.ts`'s `RunWorld`/`liveRunWorld`.
 */
export interface ConductWorld {
  createGitHubClient: (options: CreateClientOptions) => Promise<GitHubClient>
  currentRecipe: (project: ProjectState, client?: GitHubClient, base?: string) => Promise<ResolvedRecipe>
  ticketsFor: (project: ProjectState, recipe: Recipe, client: Tickets) => Promise<Tickets>
  selectRunnable: typeof selectRunnable
  runOnce: typeof runOnce
  runQueue: typeof runQueue
}

/** The real one. */
export function liveConductWorld(): ConductWorld {
  return { createGitHubClient, currentRecipe, ticketsFor, selectRunnable, runOnce, runQueue }
}

/**
 * What a look needs to keep several passes of a project in flight (0122): the
 * installation's in-flight set, and where a started pass is handed so a drain
 * waits for it. `ceilingSet` is whether a daily ceiling is configured — while
 * none is, the installation runs one pass in all and a look awaits its pass.
 */
export interface PassSlots {
  set: Slots
  started: (pass: Promise<void>) => void
  ceilingSet: boolean
}

/** What `conductWork` needs beside `ConductWorld` — everything a pass already read once. */
export interface ConductWorkOptions {
  hookBinary: string
  prompt: string
  /** The control stream, read once for the whole pass (#210). */
  control: ControlState
  outcome: PassOutcome
  max?: number
  merge?: boolean
  paused?: () => Promise<string | null>
  /** Absent, every pass is awaited, as it always was. */
  slots?: PassSlots
  log: (line: string) => void
  onRecipe?: (project: string, recipe: Recipe) => void
  /**
   * Read fresh to settle whether a `control.continuing` row is still live
   * (`#465`, below) — never to decide what to run with, which `common`
   * already carries. Injectable so a test does not need a real store.
   */
  store?: EventStore
}

/** What a run hands `runOnce`/`runQueue` beside `prompt`, `recipe` and `issue`/`max`. */
interface CommonPassOptions {
  project: ProjectState
  client: PassClient
  runtime: Runtime
  token?: TokenSource
  merge?: boolean
  hookBinary: string
  prompt: string
  promptVersion: string
  log: (line: string) => void
  /** Set only for a project with no owner — `ownerlessClient`'s own remote (`#352`, `#355`). */
  remote?: string
}

/**
 * One project's share of a pass — asking what it offers, and taking either
 * what was asked for by name or the top of its queue.
 *
 * **Branches on `project.owner`, before anything is built** (`#355`). A
 * project with no owner has no App to check and no `GitHubClient` to build:
 * `ownerlessClient` is `apps/cli/src/run.ts`'s own assembly, called with
 * `world.ticketsFor` as its seam so a test needs no `processTicketSql()`.
 * Everything from `runnableNow` on is shared — what differs is only how
 * `common` was built.
 */
export function conductWork(
  options: ConductWorkOptions,
  world: ConductWorld = liveConductWorld(),
): (project: ProjectState, where: Where) => Promise<'looked' | 'looked-away'> {
  const store = options.store ?? eventStore
  return async (project, where) => {
    const name = project.project!

    // `max: 0` means "look at the project and take nothing". Returned here
    // rather than through `runQueue({ max: 0 })` because a nominated issue
    // would otherwise still jump the queue and run. Nothing was read, so it
    // says nothing about whether the project would be refused.
    if (options.max === 0) return 'looked-away'

    let common: CommonPassOptions
    let resolved: ResolvedRecipe

    if (project.owner === null) {
      // A local registration always records `base` (`first-project.ts`). If it
      // did not, the fallback is the recipe's own `repo.base` — never
      // `client.defaultBranch()`, which there is no client to ask.
      where.ref = project.base
      resolved = await world.currentRecipe(project, undefined, where.ref ?? undefined)
      options.onRecipe?.(name, resolved.recipe)
      if (where.ref === null) where.ref = baseOf(resolved.recipe)

      // Both before `where.looked()`: a refusal here — no `source.tickets:
      // db`, no `repo.remote`, a `TicketSourceConflict` — is recorded as a
      // `ProjectRefused` rather than a mid-run failure (#148).
      const { client, remote } = await ownerlessClient(project, resolved.recipe, world.ticketsFor)
      await where.looked()

      common = {
        project,
        client,
        runtime: createRuntime(resolved.recipe.runtime.agent),
        hookBinary: options.hookBinary,
        prompt: options.prompt,
        promptVersion: `ticket@${options.prompt.length}`,
        remote,
        ...(options.merge === undefined ? {} : { merge: options.merge }),
        log: options.log,
      }
    } else {
      const client = await world.createGitHubClient({ auth: githubApp(), owner: project.owner, repo: name })
      where.ref = project.base ?? (await client.defaultBranch())
      resolved = await world.currentRecipe(project, client, where.ref)
      options.onRecipe?.(name, resolved.recipe)
      // Where this project's tickets actually live (`ticketsFor`, `#382`) —
      // **before `where.looked()`**, so a refusal here (a `db` project whose
      // log already has GitHub-numbered work items) is durable: a throw after
      // `looked()` is not recorded as a `ProjectRefused` (see below).
      const tickets = await world.ticketsFor(project, resolved.recipe, client)
      // Looked at, now — not when the run below returns, which can be an hour
      // away, all of it with a refusal on record for a project being worked.
      await where.looked()

      common = {
        project,
        client: passClientOf(client, tickets),
        // **The runtime the recipe named** (`#313`).
        runtime: createRuntime(resolved.recipe.runtime.agent),
        // A function, not a snapshot: an installation token lasts an hour and a
        // run's wall limit is two.
        token: () => client.token(),
        hookBinary: options.hookBinary,
        prompt: options.prompt,
        promptVersion: `ticket@${options.prompt.length}`,
        ...(options.merge === undefined ? {} : { merge: options.merge }),
        log: options.log,
      }
    }

    // **An approval owed a continuation jumps the queue too, and before a
    // hand-picked issue does** (#465, 0120 §6). `continueTicket` is the
    // authority on whether this is still good — `not-approved`, `wrong-run`
    // and `lost-race` are all read off the store at the moment of the claim,
    // inside `runOnce` — so this is a dispatch rather than a second check:
    // a stale row (the item was closed, requeued or already continued by
    // another pass) is simply a `runOnce` that claims nothing, logged and
    // moved past like any other `notClaimed`.
    //
    // **The row never expires on its own** — `ContinueRequested` has no
    // "consumed" counterpart, the same choice `RunRequested` makes, so
    // `control.continuing` only ever grows and a row an earlier pass already
    // continued stays on the stream forever. Bounding it here costs one
    // `runOnce` per pass per stranded row, which is cheap next to a second
    // state machine that marks one "consumed" — and a row's ticket leaving
    // `approved` (landed, requeued, moved to a new wait) already makes the
    // next pass's fresh read skip it, so the only rows this loop spends
    // anything on are ones genuinely still owed a continuation.
    //
    // **A declined claim must fall through to this project's own queue in
    // the same pass**, not end the pass pretending nothing is runnable: a row
    // whose ticket is still `approved` on the log but that GitHub stops
    // offering (closed, `agent:hold` added, a new open blocker, a reassigned
    // `take: mine`) matches on every pass for ever otherwise, since declining
    // at claim appends nothing and releases nothing (`stage: 'claim'`, above)
    // — the lifecycle stays `approved` and the row stays live. So this walks
    // **every** live row for the project, in order, filtered the same way as
    // before — the first for this project whose ticket is **still**
    // `approved` on this run, read fresh rather than trusted from the fold —
    // and only a `runOnce` that actually claimed something ends the pass.
    // One that declined at claim is logged and passed over, same as any other
    // `notClaimed`, and the walk continues to the next row.
    //
    // **Detached** (0122 §1) only where a ceiling is configured and this project
    // asks for more than one slot, or another project already has a pass in
    // flight: every other look awaits its pass, which is today's behaviour.
    const limit = concurrencyOf(resolved.recipe)
    const slots = options.slots
    if (slots && limit > 1 && !slots.ceilingSet) {
      options.log(`${name}: runtime.concurrency ${limit} is ignored — no daily ceiling is set, so one pass runs in all`)
    }
    const detached = slots !== undefined && slots.ceilingSet && (limit > 1 || slots.set.size > 0)
    const full = detached && slots.set.of(name).length >= limit

    const report = (result: RunOnceResult): void => {
      if (result.ok === true) options.log(`landed ${result.mergeCommit.slice(0, 7)}`)
      else if (result.ok === 'held') options.log(`held at ${result.step}`)
      else options.log(`stopped at ${result.stage}: ${result.detail}`)
    }
    /** Starts one pass into a slot and does not wait for it. */
    const launch = async (issue: number, continuing?: { runId: string }): Promise<void> => {
      const files = await readFixFiles(common.client, issue)
      const leave = slots!.set.enter({ project: name, issue: String(issue), files })
      options.outcome.ran += 1
      const pass = Effect.runPromise(
        world.runOnce({ ...common, issue, ...(continuing ? { continuing } : {}) }).pipe(Effect.provide(PortsLive)),
      ).then(report, (err: unknown) =>
        options.log(`${name}: #${issue} failed — ${err instanceof Error ? err.message : String(err)}`),
      )
      slots!.started(pass.finally(leave))
    }

    for (const c of options.control.continuing) {
      if (c.project !== name) continue
      if (full || (detached && slots.set.of(name).some((f) => f.issue === c.issue))) continue
      const ticket = reduceTicket(await store.read(ticketStream(name, Number(c.issue))))
      if (ticket.lifecycle.status !== 'approved' || ticket.lifecycle.runId !== c.runId) continue
      options.log(`${name}: continuing #${c.issue} — asked for by ${c.by}`)
      if (detached) {
        await launch(Number(c.issue), { runId: c.runId })
        return 'looked'
      }
      const result: RunOnceResult = await Effect.runPromise(
        world
          .runOnce({
            ...common,
            issue: Number(c.issue),
            continuing: { runId: c.runId },
          })
          .pipe(Effect.provide(PortsLive)),
      )
      if (result.ok === false && result.stage === 'claim') {
        options.log(`${name}: continuation of #${c.issue} declined at claim — ${result.detail}`)
        continue
      }
      options.outcome.ran += 1
      if (result.ok === true) options.log(`landed ${result.mergeCommit.slice(0, 7)}`)
      else if (result.ok === 'held') options.log(`held at ${result.step}`)
      else options.log(`stopped at ${result.stage}: ${result.detail}`)
      return 'looked'
    }

    // A hand-picked issue jumps the queue.
    //
    // `lingtai now` used to append `RunRequested` and only *wake* the loop, which
    // then took whatever was at the top — so the command's name promised
    // something it did not do, and would have been wrong the moment the queue
    // held more than one item.
    //
    // A request needs no separate "consumed" event: it is satisfied when the
    // task stops being queued, which claiming it does. Filtering on that is
    // what keeps the control stream from growing a second state machine.
    // Asked, not read back: GitHub says what it is offering right now, so a
    // request for an issue that was closed or relabelled by hand since it was
    // made simply does not match.
    //
    // **`backoffMs: 0` — the command is called `now`** (0028). The backoff
    // stops *blind* retries, and a person naming an issue is not blind; every
    // other subtraction still applies, so a request for something already
    // claimed or landed still matches nothing. Until #95 this said
    // `source.backoff` like the pass below, and the two failures it produced
    // were both silent: the request matched nothing, so the daemon ran
    // whatever was at the top of the queue instead, and the request stayed
    // pending — because the only thing that consumes one is the item ceasing
    // to be queued.
    const offered = await runnableNow({ client: common.client, queue: queueOf(resolved.recipe) })
    // The rows and not a set of numbers. `selectRunnable` already carries the
    // kind and the title, and the line below is read by somebody watching a
    // pass decide what to spend an agent on: `taking #123` is a number they
    // have to go and look up before it means anything (#258).
    const queued = new Map(
      (
        await world.selectRunnable({
          project: name,
          offered: offered.runnable,
          kinds: kindsOf(resolved.recipe),
          backoffMs: 0,
        })
      )
        // The projection lags a claim: what is in flight here is taken already.
        .filter((t) => !(detached && slots.set.of(name).some((f) => f.issue === t.issue)))
        .map((t) => [t.issue, t] as const),
    )
    const asked = full ? undefined : options.control.requested.find((r) => r.project === name && queued.has(r.issue))

    if (asked) {
      // Non-null because `queued.has` is what matched it. The shape is
      // `lingtai status`'s — `#123  bug  the title`.
      const task = queued.get(asked.issue)!
      options.log(`${name}: taking #${asked.issue}  ${task.kind}  ${task.title} — asked for by ${asked.by}`)
      if (detached) {
        await launch(Number(asked.issue))
        return 'looked'
      }
      const result: RunOnceResult = await Effect.runPromise(
        world.runOnce({ ...common, issue: Number(asked.issue) }).pipe(Effect.provide(PortsLive)),
      )
      options.outcome.ran += 1
      if (result.ok === true) options.log(`landed ${result.mergeCommit.slice(0, 7)}`)
      else if (result.ok === 'held') options.log(`held at ${result.step}`)
      else options.log(`stopped at ${result.stage}: ${result.detail}`)
    } else {
      const ran: ScheduleResult = await Effect.runPromise(
        world
          .runQueue({
            ...common,
            recipe: resolved.recipe,
            ...(detached ? { slots: { set: slots.set, limit, started: slots.started } } : { max: options.max ?? 1 }),
            // One ticket today, so the loop's own check comes first; handed in
            // anyway so a `max` above one cannot walk into a wall the ticket
            // before it just met.
            ...(options.paused ? { paused: options.paused } : {}),
          })
          .pipe(Effect.provide(PortsLive)),
      )
      options.outcome.ran += ran.started ?? ran.ran.length
    }
    return 'looked'
  }
}

/**
 * Which registered projects a pass may look at, and the `'*'` refusal pushed
 * when some are skipped — **no App is a reason to skip every GitHub project,
 * not every project** (`#355`). A project with no owner has no App to check:
 * it goes through `conductWork`'s no-owner branch regardless, so the list
 * returned is every registered project with an App, and only the no-owner
 * ones without. No refusal is pushed when nothing was skipped — either
 * because there is an App, or because every registered project is
 * owner-less already.
 */
export function projectsForPass(
  registered: readonly ProjectState[],
  hasApp: boolean,
  outcome: PassOutcome,
): readonly ProjectState[] {
  const projects = hasApp ? registered : registered.filter((p) => p.owner === null)
  if (!hasApp && registered.some((p) => p.owner !== null)) {
    outcome.refused.push({ project: '*', detail: 'no GitHub App configured' })
  }
  return projects
}

/**
 * A pass, with the world provided around each item it takes.
 *
 * `runOnce` and `runQueue` ask for `Repo` and `AgentHost`
 * ([0026](../../../doc/decisions-archive/0026-the-conversion-past-the-seam.md)), so a
 * pass is a host as much as `lingtai run` is: it provides `PortsLive` and calls
 * `runPromise` at its own edge. The projector is the daemon's, held for as long
 * as the daemon runs, which is why there is no scope of that kind here.
 */
export async function conductorPass(options: ConductOptions = {}): Promise<PassOutcome> {
  const log = options.log ?? (() => {})
  const outcome: PassOutcome = { projects: 0, ran: 0, refused: [] }

  const hookBinary = options.hookBinary ?? resolve(root, 'packages/hook/bin/lingtai-hook')
  try {
    await readFile(hookBinary)
  } catch {
    // A run that records nothing must not start. Refusing the pass rather than
    // the daemon: the projections stay current, which is what makes the reason
    // visible on the board.
    const detail = `no lingtai-hook binary at ${hookBinary}`
    outcome.refused.push({ project: '*', detail })
    log(detail)
    return outcome
  }

  const promptPath = options.promptPath ?? resolve(root, 'prompts/ticket.md')
  const prompt = await readFile(promptPath, 'utf8')

  // Read once for the whole pass. A request that arrives mid-pass is answered
  // by the next one — which the append itself triggers.
  const control = await readControl()

  const registered = await loadProjects()
  const projects = projectsForPass(registered, hasGitHubApp(), outcome)

  return conductProjects({
    projects,
    codeSha: options.codeSha ?? null,
    outcome,
    log,
    ...(options.paused ? { paused: options.paused } : {}),
    work: conductWork({
      hookBinary,
      prompt,
      control,
      outcome,
      max: options.max,
      ...(options.merge === undefined ? {} : { merge: options.merge }),
      ...(options.paused ? { paused: options.paused } : {}),
      ...(options.slots ? { slots: { ...options.slots, ceilingSet: machineDayCeiling() !== undefined } } : {}),
      log,
      ...(options.onRecipe ? { onRecipe: options.onRecipe } : {}),
    }),
  })
}

/** How far a project's work got before it refused: the branch, once known. */
export interface Where {
  ref: string | null
  /**
   * The project was looked at without refusing: records the recovery now, while
   * the rest of the work — a run, up to `runtime.limits.wall` — is still ahead.
   * Idempotent, since `passTransition` appends nothing once nothing is on record.
   */
  looked: () => Promise<void>
}

export interface ProjectsOptions {
  projects: readonly ProjectState[]
  /**
   * One project's share of the pass. Throwing before `where.looked` is refusing
   * it; throwing after is a failure the outcome reports and the log does not
   * record as a refusal. `"looked-away"`
   * is returning before anything was read, which is neither a refusal nor a
   * recovery. Sets `where.ref` once it knows the branch, and calls `where.looked`
   * once it has read enough to know it does not refuse; `"looked"` calls it on
   * return if the work did not.
   */
  work: (project: ProjectState, where: Where) => Promise<'looked' | 'looked-away'>
  codeSha: string | null
  outcome: PassOutcome
  log: (line: string) => void
  /**
   * Asked before each project, and a sentence back ends the pass there (#210).
   * A pause one project's run appended stands for every project after it: the
   * wall it met is the account's, not the repository's.
   */
  paused?: () => Promise<string | null>
  store?: EventStore
}

/**
 * Every registered project, each in isolation — and a refusal's start and end
 * on the project's stream.
 *
 * Split from `conductorPass` so the part that decides what reaches the log runs
 * without a GitHub App: that record is the claim of `#148`, and a claim about
 * the log is tested against the log.
 */
export async function conductProjects(options: ProjectsOptions): Promise<PassOutcome> {
  const { outcome, log, store = eventStore } = options

  for (const project of options.projects) {
    const name = project.project
    // **No `!project.owner`** (`#355`) — `owner: null` is an ordinary,
    // registered project now, not one this pass skips.
    if (!name) continue
    if (options.paused) {
      const why = await options.paused()
      if (why !== null) {
        log(`${name}: not looked at — ${why}`)
        break
      }
    }
    outcome.projects += 1
    let looked = false
    const where: Where = {
      ref: null,
      looked: () => {
        looked = true
        return record(project, { refused: false, ref: where.ref, codeSha: options.codeSha }, { store, log })
      },
    }

    try {
      if ((await options.work(project, where)) === 'looked') await where.looked()
    } catch (err) {
      // One project's problem is not the pass's. A misconfigured repository
      // must not stop the others from being worked.
      outcome.refused.push({ project: name, detail: (err as Error).message })
      log(`${name}: ${(err as Error).message}`)
      // **And on the log** (#148): this line was the whole record for hours
      // while a daemon too old for its recipe refused every sweep. Appended on
      // the transition only — `passTransition` compares with what the stream
      // already holds, so the next identical sweep appends nothing.
      //
      // **Only before the project was looked at.** A throw after `looked()` —
      // an issue listing GitHub refuses, a merge lane's 502 — comes from a
      // project that was read and worked, which is not what `ProjectRefused`
      // says. Recorded, it would follow this sweep's `ProjectRecovered` with a
      // refusal, and every later sweep would append the same pair again.
      if (looked) continue
      await record(
        project,
        { refused: true, detail: (err as Error).message, ref: where.ref, codeSha: options.codeSha },
        { store, log },
      )
    }
  }

  return outcome
}

/**
 * Append what `passTransition` decides, if anything. Never throws: a record that
 * could not be written must not become the refusal of every project after this
 * one, and the next pass re-reads the stream and decides again.
 */
async function record(
  project: ProjectState,
  seen: Parameters<typeof passTransition>[1],
  options: { store: EventStore; log: (line: string) => void },
): Promise<void> {
  const { store, log } = options
  const name = project.project!
  try {
    // Re-read rather than trusting the state the pass began with: a run can
    // last an hour, and what matters is what the stream holds now.
    const current = reduceProject(await store.read(projectStream(name)))
    const next = passTransition(current, seen)
    if (next) await store.append(projectStream(name), current.version, [next])
  } catch (err) {
    log(`${name}: could not record the pass on the log — ${(err as Error).message}`)
  }
}
