/**
 * What holds a project, read for the board (#994, 0126 §8).
 *
 * One read of the registered projects per render, shared by every caller that
 * asks (`cache`, as `readConductor` does in `task.ts`), and the locks taken
 * through `locksOn` — **no reduce here**: `ProjectState.paused` is the domain's.
 *
 * **A failed read is said.** `readProjectLocks` answers `{ ok: false }` and
 * never `[]` for a failure: a banner fed an empty list would say "nothing is
 * paused", which is the silence #77 was about.
 */
import { accountsFor, liftAccountLimit } from '@lingtai/conductor'
import { loadProjects } from '@lingtai/conductor/projects'
import { pauseProject, raiseDayCeiling, readControl, resumeProject } from '@lingtai/daemon/control'
import {
  RAISE_REFUSALS,
  NO_ACCOUNTS,
  ceilingFacts,
  isRegistered,
  lockSentence,
  locksOn,
  projectStream,
  reduceProject,
  type CeilingFacts,
  type Envelope,
  type Lock,
  RuntimeId,
  whenLabel,
  untilFromWords,
} from '@lingtai/domain'
import { machineDayCeiling } from '@lingtai/env'
import { type EventStore, eventStore } from '@lingtai/event-store'
import { Context, Effect } from 'effect'
import { cache } from 'react'

import type { ActionResult } from './diff.ts'
import { accountsHolding, ceilingToday, isPaused } from './lock-marks.ts'
import { boardWriterOrNone } from './snapshot-writer.ts'

const run = Effect.runPromiseWith(Context.empty())

/** The registered projects, read once however many places of one render ask. */
export const readRegistered = cache(() => loadProjects())

/**
 * `ctl-conductor`, read once however many places of one render ask (#1006).
 * Not caught: a caller that cannot say what it failed to read must not draw
 * "nothing holds" from it (#77). `readProjectLocks` catches it for itself.
 */
export const readControlOnce = cache(async () => readControl(undefined, 0, { writer: await boardWriterOrNone() }))

export type HeldProject = { project: string; locks: readonly Lock[] }
export type ProjectLocks =
  | {
      ok: true
      held: readonly HeldProject[]
      /**
       * The runtimes each registered project's recipe uses, held or not (#1010);
       * a project whose recipe does not resolve has no entry.
       */
      uses?: ReadonlyMap<string, readonly RuntimeId[]>
      /** Today's ceiling as every reader says it; undefined when the control read failed or nothing is set. */
      ceiling: CeilingFacts | undefined
      /** Set when the control stream could not be read: the banner says so rather than drawing no ceiling. */
      controlProblem?: string
    }
  | { ok: false; problem: string }

const problemOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The configured figure, or undefined when it cannot be read: that must never take the control read down. */
function configuredCeiling(): number | undefined {
  try {
    return machineDayCeiling()
  } catch {
    return undefined
  }
}

/** Every registered project that something holds, ordered by name. Never `[]` for a failure. */
export const readProjectLocks = cache(async (): Promise<ProjectLocks> => {
  try {
    const [projects, control] = await Promise.all([
      readRegistered(),
      readControlOnce().then(
        (state) => ({ state }),
        (err: unknown) => ({ problem: problemOf(err) }),
      ),
    ])
    const state = 'state' in control ? control.state : undefined
    const held: HeldProject[] = []
    const uses = new Map<string, readonly RuntimeId[]>()
    for (const project of projects) {
      // A failed `acct-` read fails the whole read: unknown is never *not limited*.
      const accounts = await run(accountsFor(eventStore, project))
      const locks = locksOn({ project, control: state, accounts })
      if (project.project !== null && accounts.size > 0) uses.set(project.project, [...accounts.keys()].sort())
      if (project.project !== null && locks.length > 0) held.push({ project: project.project, locks })
    }
    held.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0))
    return {
      ok: true,
      held,
      uses,
      ceiling: state === undefined ? undefined : ceilingFacts(state, new Date(), configuredCeiling()),
      ...('problem' in control ? { controlProblem: control.problem } : {}),
    }
  } catch (err) {
    return { ok: false, problem: problemOf(err) }
  }
})

export type BannerRow =
  | { kind: 'ceiling'; facts: NonNullable<CeilingFacts['reached']> }
  | { kind: 'control-unread'; problem: string }
  | { kind: 'paused'; project: string; by: string; since: Date }
  | {
      kind: 'account'
      runtime: RuntimeId
      /** `until` as the row says it, and the phrase for its `title`. */
      until: Date
      untilLabel: string
      title: string
      passed: boolean
      /** The projects in scope this limit holds, by name. */
      waiting: string[]
      /** *All projects* only: the projects nothing holds, with the runtimes their recipes use. */
      others: { project: string; runtimes: readonly RuntimeId[] }[]
    }

/**
 * The banner's rows in 0126 §8's order: the ceiling once (it holds every
 * project, so it is one row however many projects are held), the could-not-read
 * row, then one row per limited runtime (#1010 — the lock is per project, the row
 * per runtime), then each paused project in scope. Pure.
 */
export function bannerRows(
  read: {
    held: readonly HeldProject[]
    uses?: ReadonlyMap<string, readonly RuntimeId[]>
    ceiling: CeilingFacts | undefined
    controlProblem?: string
  },
  scope: string | undefined,
  now: Date = new Date(),
): readonly BannerRow[] {
  const rows: BannerRow[] = []
  if (read.ceiling?.reached) rows.push({ kind: 'ceiling', facts: read.ceiling.reached })
  if (read.controlProblem !== undefined) rows.push({ kind: 'control-unread', problem: read.controlProblem })
  const scoped = inScope(read.held, scope)
  const accountRows = new Map<RuntimeId, Extract<BannerRow, { kind: 'account' }>>()
  for (const h of scoped) {
    for (const lock of h.locks) {
      if (lock.kind !== 'account') continue
      const existing = accountRows.get(lock.runtime)
      if (existing !== undefined) {
        existing.waiting.push(h.project)
        continue
      }
      accountRows.set(lock.runtime, {
        kind: 'account',
        runtime: lock.runtime,
        until: lock.until,
        untilLabel: whenLabel(lock.until, now),
        title: `${untilFromWords(lock.untilFrom)} — "${lock.said}"`,
        passed: lock.until.getTime() <= now.getTime(),
        waiting: [h.project],
        others: [],
      })
    }
  }
  if (scope === undefined && accountRows.size > 0) {
    const heldBy = new Map(read.held.map((h) => [h.project, h.locks]))
    const others = [...(read.uses ?? [])]
      .filter(([name]) => {
        const locks = heldBy.get(name)
        return !isPaused(locks) && ceilingToday(locks, now) === null && accountsHolding(locks, now).length === 0
      })
      .map(([project, runtimes]) => ({ project, runtimes }))
      .sort((a, b) => (a.project < b.project ? -1 : 1))
    // A ceiling holds every project, so nobody is left taking work; and when the
    // control stream could not be read, whether one does is unknown, never "no".
    const anyCeiling = read.ceiling?.reached != null && !read.ceiling.reached.passed
    const unknown = read.controlProblem !== undefined
    for (const r of accountRows.values()) r.others = anyCeiling || unknown ? [] : others
  }
  for (const runtime of RuntimeId.options) {
    const r = accountRows.get(runtime)
    if (r !== undefined) rows.push(r)
  }
  for (const h of scoped) {
    for (const lock of h.locks) {
      if (lock.kind === 'paused') rows.push({ kind: 'paused', project: h.project, by: lock.by, since: lock.since })
    }
  }
  return rows
}

/**
 * The figure offered for *continue today*: a quarter over the larger of the
 * ceiling that was reached and what was spent, in whole dollars. $200 → $250.
 */
export function suggestedRaise(reachedUsd: number, spentUsd: number): number {
  return Math.ceil((Math.round(Math.max(reachedUsd, spentUsd) * 100) * 1.25) / 100)
}

/** All of them for *all projects*, and only that project's row for one. */
export function inScope(held: readonly HeldProject[], project: string | undefined): readonly HeldProject[] {
  return project === undefined ? held : held.filter((h) => h.project === project)
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM` when `since` is on `now`'s local day, otherwise the date and the time. */
export function sinceLabel(since: Date, now: Date): string {
  const time = `${two(since.getHours())}:${two(since.getMinutes())}`
  const sameDay =
    since.getFullYear() === now.getFullYear() &&
    since.getMonth() === now.getMonth() &&
    since.getDate() === now.getDate()
  return sameDay ? time : `${since.getFullYear()}-${two(since.getMonth() + 1)}-${two(since.getDate())} ${time}`
}

/**
 * Pause or resume one project, for the board's two actions.
 *
 * A name that is not a registered project is refused by name before the
 * appender is asked: `pauseProject` on a stream that does not exist has no
 * `paused` to name in its `already` answer. Read from the store the appender
 * writes to, so the check and the write cannot disagree about which log.
 */
export const setProjectPaused = (
  store: EventStore,
  verb: 'pause' | 'resume',
  project: string,
  by: string,
  now: Date = new Date(),
) =>
  Effect.gen(function* () {
    const read = () => Effect.tryPromise(() => store.read(projectStream(project))).pipe(Effect.map(reduceProject))
    const state = yield* read()
    if (!isRegistered(state)) {
      return { ok: false, detail: `"${project}" is not a registered project` } satisfies ActionResult
    }
    const answer = yield* verb === 'pause' ? pauseProject(project, by, store) : resumeProject(project, by, store)
    switch (answer.kind) {
      case 'appended':
        return {
          ok: true,
          detail: verb === 'pause' ? `${project} paused` : `${project} resumed`,
        } satisfies ActionResult
      case 'already': {
        const paused = (yield* read()).paused
        const who = paused === null ? '' : ` by ${paused.by}`
        return {
          ok: true,
          detail: `${project} is already paused${who} since ${sinceLabel(answer.since, now)}`,
        } satisfies ActionResult
      }
      case 'not-paused':
        return { ok: true, detail: `${project} is not paused` } satisfies ActionResult
    }
  })

/**
 * Why a new question may not be asked of this project, or null (#996).
 *
 * A reader's refusal (0126 §5), not the gate: the board does not hold the
 * conductor lock, and the daemon's `locked` still decides whether a turn
 * starts. `read` is the project's stream, or the error reading it failed with —
 * unknown is not unlocked.
 */
// `NO_ACCOUNTS` below is deliberate: this is a synchronous, pause-only read, and its
// remedy sentence (`resume it`) is wrong for an account lock. The daemon's `locked`
// still stops the turn; the board's account rows are #1010.
export function askRefusal(project: string, read: readonly Envelope[] | Error): string | null {
  if (read instanceof Error) return `could not read whether ${project} is paused — ${read.message}`
  const sentence = lockSentence(project, locksOn({ project: reduceProject(read), accounts: NO_ACCOUNTS }))
  return sentence === null ? null : `${sentence} — resume it, then ask`
}

/**
 * A person raises today's ceiling from the board (#1006, 0126 §7).
 *
 * The figure is the person's and is never adjusted: one that is not a finite
 * positive number is refused before anything is read. Today's spend comes from
 * `readSpend` (`readDayReading` in production); if it cannot be read nothing
 * is raised. **The board does not check that the `spend` projection is stalled
 * or being rebuilt**, as `lingtai ceiling raise` does: the rebuild hold is the
 * conductor process's own memory and cannot be seen from here. That is safe
 * because the guard compares the raised figure with its own trusted spend before
 * every claim (#1004): a raise accepted against a stale, low spend that is
 * below the true spend is locked again at the guard's next look, with a
 * `DayCeilingReached` naming that figure, and nothing was spent past it.
 */
export const continueTodayWith = (input: {
  store: EventStore
  toUsd: number
  by: string
  now?: Date
  readSpend: () => Promise<{ day: { reportedCents: number; estimatedCents: number } | null }>
}) =>
  Effect.gen(function* () {
    const { toUsd } = input
    if (typeof toUsd !== 'number' || !Number.isFinite(toUsd) || toUsd <= 0) {
      return {
        ok: false,
        detail: 'the figure must be a positive number of dollars — nothing raised',
      } satisfies ActionResult
    }
    const { day } = yield* Effect.tryPromise(() => input.readSpend())
    if (day === null) {
      return { ok: false, detail: "today's spend could not be read — nothing raised" } satisfies ActionResult
    }
    const raising = yield* raiseDayCeiling({
      toUsd,
      by: input.by,
      spentCents: day.reportedCents + day.estimatedCents,
      store: input.store,
      now: input.now,
    })
    if (!raising.raised) return { ok: false, detail: RAISE_REFUSALS[raising.refused] } satisfies ActionResult
    return { ok: true, detail: `today's ceiling raised to $${toUsd}` } satisfies ActionResult
  })

/**
 * Lift one runtime's usage limit for the board's *lift* (#1010, 0126 §7).
 *
 * `runtime` is `unknown` because it arrives over the wire: a value that is not
 * a `RuntimeId` is refused by name before the appender is asked. The appender
 * appends on the transition only, so a stale or doubled click answers
 * `not limited` and appends nothing.
 */
export const liftAccountWith = (store: EventStore, runtime: unknown, by: string) =>
  Effect.gen(function* () {
    const parsed = RuntimeId.safeParse(runtime)
    if (!parsed.success) {
      return {
        ok: false,
        detail: `unknown runtime "${String(runtime)}" — runtimes: ${RuntimeId.options.join(', ')}`,
      } satisfies ActionResult
    }
    const answer = yield* liftAccountLimit(store, parsed.data, by)
    return answer.kind === 'appended'
      ? ({ ok: true, detail: `${parsed.data}'s usage limit lifted` } satisfies ActionResult)
      : ({ ok: true, detail: `${parsed.data} is not at its usage limit — nothing to lift` } satisfies ActionResult)
  })
