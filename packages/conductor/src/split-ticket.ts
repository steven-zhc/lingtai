/**
 * Turning an approved split plan into GitHub issues and links (#601, #603, 0118 §12).
 *
 * **A reconciliation of a frozen plan against GitHub.** GitHub has no
 * transaction, so what this guarantees is that running it twice is running it
 * once, that running it again after a failure converges on the whole plan, and
 * that it never touches an issue it did not create.
 *
 * - **The plan freezes at the first `SplitStarted`** for the wait. Every later
 *   call uses that plan and ignores `options.plan`.
 * - **A child is known by its marker (`splitMarker`) and nothing else** — never
 *   by title. Found by listing the issues created since the first
 *   `SplitStarted` (`listIssuesSince`, which is complete or throws; never
 *   search, whose index lags a create). An issue without the marker is never
 *   adopted, edited, attached or linked, and a child found keeps GitHub's title
 *   and body.
 * - **One child at a time:** create, attach, `SplitChildWritten`, then the next
 *   child. A crash between a create and its record is accepted: a retry finds
 *   the child by marker.
 * - **`TicketSplit` is the outcome read back:** its `blockedBy` is what GitHub
 *   returned, mapped to keys.
 *
 * The page's *writing* is not read off this log alone: `splitProgressOf` takes
 * whether a writer is running in the asker's process, so a writer whose last
 * append threw reads as interrupted, with Retry.
 *
 * The last step is `resolveWaitHolding`, still the only writer of
 * `WaitResolved`; it appends `TicketSplit` ahead of it in the same
 * transaction, so a retry after a lost race re-reads and lands only that.
 */
import {
  PUBLISHING_LABEL,
  reduceTicket,
  splitProgressOf,
  ticketStream,
  type PayloadOf,
  type WaitId,
} from '@lingtai/domain'
import { allowedResolutions, splitPlanProblems, describeSplitProblem } from '@lingtai/domain/wait'
import { type EventStore, eventStore } from '@lingtai/event-store'
import type { GitHubClient, LinkedIssue } from '@lingtai/github'
import { Cause, Effect } from 'effect'

import { upsertSection } from './body-section.ts'
import { decidingEffect } from './deciding.ts'
import { asFailure } from './port-face.ts'
import { describeReason, resolveWaitHoldingEffect } from './resolve-wait.ts'
import { BodyChanged } from './ticket-store.ts'
import { recordSplitProgress } from './ticket/commands.ts'

/** What the writer needs of GitHub — narrower than `GitHubClient`, and not `Tickets` (#599 kept links off it). */
export type SplitClient = Pick<
  GitHubClient,
  | 'getIssue'
  | 'createIssue'
  | 'updateBody'
  | 'addSubIssue'
  | 'listSubIssues'
  | 'addBlockedBy'
  | 'listBlockedBy'
  | 'listIssuesSince'
  | 'addLabels'
  | 'removeLabel'
  | 'createLabel'
>

export interface SplitPlanInput {
  /** `covers` is the parent's `## Done when` items a child takes, where the plan names them. */
  children: readonly { key: string; title: string; body: string; kind: string; covers?: readonly string[] }[]
  blockedBy: readonly { ticket: string; blockedBy: string }[]
  /** The parent's items no child covers. */
  uncovered?: readonly string[]
}

/** The key of the parent's `## Split into` section (`upsertSection`). */
const SPLIT_INTO_KEY = 'split-into'

/** A child's marker, matched whatever its wait and key: a body carrying one is a child and is never split (#1261). */
const ANY_SPLIT_MARKER = /<!-- lingtai:split \S+ \S+ -->/

/** Done-when items are a person's text; one that quotes a section marker would make `upsertSection` refuse. */
const defuse = (text: string) => text.replaceAll('lingtai:answer', 'lingtai:\u200banswer')

/**
 * The parent's body with a `## Split into` section of its own: each child, and under it the
 * items it covers. `## Done when` is never touched (#1261). Applying it twice is a no-op.
 */
export function splitIntoSection(
  body: string,
  children: readonly { number: number; title: string; covers?: readonly string[] }[],
  uncovered: readonly string[] = [],
): string {
  const lines = ['## Split into', '']
  for (const c of children) {
    lines.push(`- #${c.number} — ${defuse(c.title.trim())}`)
    for (const item of c.covers ?? []) lines.push(`  - ${defuse(item.trim())}`)
  }
  if (uncovered.length > 0) {
    lines.push('', 'Not covered by any child:', '')
    for (const item of uncovered) lines.push(`- ${defuse(item.trim())}`)
  }
  return upsertSection(body, SPLIT_INTO_KEY, lines.join('\n'))
}

/** How a child says which wait and plan entry made it. Invisible when rendered. */
export function splitMarker(waitId: string, key: string): string {
  return `<!-- lingtai:split ${waitId} ${key} -->`
}

/** Clocks disagree; see `SKEW_MS` in `ticket-store.ts`. */
const SKEW_MS = 60 * 60_000

export type StepStatus = 'done' | 'skipped' | 'failed' | 'not-reached'

/** One row of the progress the board draws: `skipped` is a write a retry found already made. */
export interface SplitStep {
  name: string
  status: StepStatus
  detail?: string
}

export interface SplitTicketOptions {
  project: string
  issue: number
  waitId: WaitId
  /**
   * Required on the first call only: the plan is frozen by the first
   * `SplitStarted`, and a call after it ignores whatever is passed here.
   */
  plan?: SplitPlanInput
  /** The recipe's `source.kinds`. */
  kinds: readonly string[]
  /** `owner/repo` of the project — a sub-issue from another repository is not this split's. */
  repository: string
  by: string
  /**
   * This board process's id, for `SplitStarted`: a writer whose instance is not
   * the asker's has gone, and the reducer reads it as interrupted. Make it once per
   * process and cache it on `globalThis` — a module-level `randomUUID()` is
   * re-evaluated by Next's dev HMR, and a running write would read as
   * interrupted to its own page.
   */
  instance: string
  note?: string
  /** Called straight after this attempt's `SplitStarted` is appended — the write is running from here. */
  onStarted?: () => void
  github: SplitClient
  store?: EventStore
}

export interface SplitTicketResult {
  ok: boolean
  ticketId: string
  detail: string
  steps: SplitStep[]
  /** Every child known so far, in plan order. */
  children: { key: string; number: number }[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A promise call lifted so its rejection is the failure itself, message and class intact. */
const lift = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: () => f(), catch: asFailure })

type Settled<A> = { ok: true; value: A } | { ok: false; error: unknown }

/**
 * Run `eff` and answer its whole cause, so a thrown error lifted as a defect is
 * a verdict like a failure is. An interruption is neither: it is re-raised, and
 * the step that was running is left as a crash leaves it.
 */
function settled<A, E>(eff: Effect.Effect<A, E>): Effect.Effect<Settled<A>> {
  return Effect.exit(eff).pipe(
    Effect.flatMap((exit): Effect.Effect<Settled<A>> => {
      if (exit._tag === 'Success') return Effect.succeed({ ok: true, value: exit.value })
      if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause as Cause.Cause<never>)
      return Effect.succeed({ ok: false, error: Cause.squash(exit.cause) })
    }),
  )
}

type StepOutcome = StepStatus | { detail: string }

/** One decision at a time — the lock `editBodyAndRequeue` takes, held through every write. */
export function splitTicket(options: SplitTicketOptions): Promise<SplitTicketResult> {
  return Effect.runPromise(splitTicketEffect(options))
}

export function splitTicketEffect(options: SplitTicketOptions): Effect.Effect<SplitTicketResult, Error> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)
  return decidingEffect<SplitTicketResult, Error, never>(
    ticketId,
    () =>
      refused(
        options.plan,
        ticketId,
        `${ticketId} is being decided by someone else right now. Reload and read it again.`,
      ),
    splitTicketHoldingEffect(options, store, ticketId),
  )
}

function stepNames(plan: SplitPlanInput | undefined): string[] {
  if (plan === undefined) return []
  return [
    'read GitHub',
    ...plan.children.map((c) => `write ${c.key}`),
    ...plan.blockedBy.map((d) => `chain ${d.ticket}←${d.blockedBy}`),
    ...plan.children.map((c) => `hold parent ← ${c.key}`),
    'split into',
    'record the split',
    ...plan.children.map((c) => `publish ${c.key}`),
    'end the wait',
  ]
}

function refused(plan: SplitPlanInput | undefined, ticketId: string, detail: string): SplitTicketResult {
  return {
    ok: false,
    ticketId,
    detail,
    steps: stepNames(plan).map((name) => ({ name, status: 'not-reached' as const })),
    children: [],
  }
}

/** Exported for the unit half alone — the lock is the filesystem. */
export function splitTicketHolding(
  options: SplitTicketOptions,
  store: EventStore,
  ticketId: string,
): Promise<SplitTicketResult> {
  return Effect.runPromise(splitTicketHoldingEffect(options, store, ticketId))
}

export function splitTicketHoldingEffect(
  options: SplitTicketOptions,
  store: EventStore,
  ticketId: string,
): Effect.Effect<SplitTicketResult, Error> {
  return Effect.gen(function* () {
    const { github, waitId, repository } = options

    // **Refuse before writing**, with no GitHub call until every check passed.
    const events = yield* lift(() => store.read(ticketId))
    const first = events.find((e) => e.type === 'SplitStarted' && (e.data as { waitId?: string }).waitId === waitId)
    // The plan is the one the first Create all froze, whatever this call was handed.
    const plan: SplitPlanInput | undefined =
      first === undefined ? options.plan : (first.data as PayloadOf<'SplitStarted'>).plan
    const stop = (detail: string) => refused(plan, ticketId, detail)
    const item = reduceTicket(events)
    if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== waitId)
      return stop(`${ticketId} is not waiting on ${waitId} — nothing was written. Reload and read it again.`)
    if (!allowedResolutions(item.lifecycle.reason).includes('Split'))
      return stop(`Split is not offered for ${describeReason(item.lifecycle.reason)} — nothing was written.`)
    if (plan === undefined) return stop('there is no split plan to write — nothing was written.')
    if (first === undefined) {
      const problems = splitPlanProblems(plan, { kinds: options.kinds })
      if (problems.length > 0)
        return stop(
          `the split plan is refused — nothing was written: ${problems.map(describeSplitProblem).join('; ')}.`,
        )
    }
    // **Once per root** (#1261): a `SplitStarted` for another wait has spent the split; one for this wait is this split resuming.
    const spent = events.some((e) => e.type === 'SplitStarted' && (e.data as { waitId?: string }).waitId !== waitId)
    if (spent) return stop(`${ticketId} was already split once — nothing was written.`)
    if (first === undefined) {
      // A read, so nothing is written: a child is known by its marker, and a child is never split.
      const parent = yield* settled(lift(() => github.getIssue(options.issue)))
      if (!parent.ok)
        return stop(`the ticket's body could not be read — nothing was written: ${errorMessage(parent.error)}`)
      if (ANY_SPLIT_MARKER.test(parent.value.body))
        return stop(
          `${ticketId} carries a split marker, so it is a split's child and is not split — nothing was written.`,
        )
    }
    // Before this attempt's own `SplitStarted`: a read that threw after it would leave a start with nothing terminal after it.
    const since = new Date((first?.at ?? new Date()).getTime() - SKEW_MS)

    const prior = splitProgressOf(events, { waitId, instance: options.instance, running: true })
    const known = new Map(prior.state === 'idle' ? [] : prior.children.map((c) => [c.key, c.number] as const))
    const linked = new Set(prior.state === 'idle' ? [] : prior.links.map((l) => `${l.ticket}\u0000${l.blockedBy}`))

    /** Facts about GitHub, not decisions about the stream; the owner appends them. */
    const note = <T extends 'SplitStarted' | 'SplitFailed' | 'SplitChildWritten' | 'SplitLinkWritten'>(
      type: T,
      data: PayloadOf<T>,
    ): Effect.Effect<void, Error> =>
      recordSplitProgress(store, ticketId, type, data, options.by).pipe(Effect.mapError(asFailure))
    yield* note('SplitStarted', {
      waitId,
      plan: {
        children: plan.children.map((c) => ({ ...c, covers: c.covers === undefined ? undefined : [...c.covers] })),
        blockedBy: [...plan.blockedBy],
        ...(plan.uncovered === undefined ? {} : { uncovered: [...plan.uncovered] }),
      },
      instance: options.instance,
    })
    options.onStarted?.()

    /** The terminal event. If it cannot be appended the caller's running set still says the writer is gone. */
    const noteFailed = (step: string, detail: string): Effect.Effect<void> =>
      note('SplitFailed', { waitId, step, detail }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.sync(() => console.error(`could not record SplitFailed for ${ticketId}:`, Cause.squash(cause))),
        ),
      )
    const failedAt = (step: string, detail: string): Effect.Effect<SplitTicketResult> =>
      noteFailed(step, detail).pipe(Effect.map(() => stop(detail)))

    // The children GitHub has, by marker alone: never by title, never by search.
    const found = new Map<string, number>()
    const findMarked: Effect.Effect<void, Error> = Effect.gen(function* () {
      const listed = (yield* lift(() => github.listIssuesSince(since))).sort((a, b) => a.number - b.number)
      for (const child of plan.children) {
        if (found.has(child.key)) continue
        const marker = splitMarker(waitId, child.key)
        const hit = listed.find((i) => i.body.includes(marker))
        if (hit !== undefined) found.set(child.key, hit.number)
      }
    })
    const read = yield* settled(findMarked)
    if (!read.ok)
      return yield* failedAt(
        'read GitHub',
        `the issues opened since this wait started could not be listed: ${errorMessage(read.error)}`,
      )

    const here = (l: LinkedIssue) => l.repository === repository
    const numberOf = (key: string) => found.get(key)!
    const links = (list: readonly LinkedIssue[], number: number) => list.some((l) => here(l) && l.number === number)

    /** Add a link only if absent (GitHub answers a duplicate with a 422), and read it back. */
    const ensure = (
      list: () => Promise<LinkedIssue[]>,
      add: () => Promise<void>,
      number: number,
    ): Effect.Effect<StepStatus, Error> =>
      Effect.gen(function* () {
        if (links(yield* lift(list), number)) return 'skipped' as const
        const lost = yield* lift(add).pipe(
          Effect.as(false),
          Effect.catchIf(
            () => true,
            (err) =>
              lift(list).pipe(
                // the response was lost, not the write
                Effect.flatMap((l) => (links(l, number) ? Effect.succeed(true) : Effect.fail(err))),
              ),
          ),
        )
        if (lost) return 'done' as const
        if (!links(yield* lift(list), number))
          return yield* Effect.fail(new Error(`#${number} was not linked on read-back`))
        return 'done' as const
      })

    const expectedBody = (child: SplitPlanInput['children'][number]) =>
      `${child.body.trimEnd()}\n\n${splitMarker(waitId, child.key)}\n`

    /** Whether the whole split is already on GitHub, so a child without the label was published rather than half-written. Read once. */
    let publishedRead: boolean | undefined
    const alreadyPublished: Effect.Effect<boolean, Error> = Effect.gen(function* () {
      if (publishedRead !== undefined) return publishedRead
      let all = plan.children.every((c) => found.has(c.key) && known.has(c.key))
      if (all) {
        const parentHolds = yield* lift(() => github.listBlockedBy(options.issue))
        const subs = yield* lift(() => github.listSubIssues(options.issue))
        all = plan.children.every((c) => links(parentHolds, numberOf(c.key)) && links(subs, numberOf(c.key)))
        for (const d of plan.blockedBy) {
          if (!all) break
          all = links(yield* lift(() => github.listBlockedBy(numberOf(d.ticket))), numberOf(d.blockedBy))
        }
      }
      publishedRead = all
      return all
    })

    /** Create (unless a marker answers), attach, record — and only then is the next child started. */
    // Uninterruptible: a create already sent cannot be taken back, so an interruption
    // must not release the decide lock before the child is found and recorded.
    const writeChild = (child: SplitPlanInput['children'][number]): Effect.Effect<StepStatus, Error> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          let status: StepStatus = 'skipped'
          if (!found.has(child.key)) {
            const create = lift(() =>
              github.createIssue({
                title: child.title.trim(),
                body: expectedBody(child),
                labels: [child.kind, PUBLISHING_LABEL],
              }),
            )
            yield* create.pipe(
              Effect.map((opened) => {
                found.set(child.key, opened.number)
              }),
              Effect.catchIf(
                () => true,
                (err) =>
                  // A timed-out create is not proof of absence: look by marker before failing.
                  findMarked.pipe(
                    Effect.catchIf(
                      () => true,
                      () => Effect.fail(err),
                    ),
                    Effect.flatMap(() => {
                      if (found.has(child.key)) return Effect.void
                      // A repository without the label may refuse a create that names it, and GitHub says only
                      // `Validation Failed` with the detail in `errors`, which the client drops: so the message is not
                      // read. Make the label (idempotent) and create once more; if that fails too, the first error stands.
                      return lift(() => github.createLabel(PUBLISHING_LABEL)).pipe(
                        Effect.flatMap(() => create),
                        Effect.map((opened) => {
                          found.set(child.key, opened.number)
                        }),
                        Effect.catchIf(
                          () => true,
                          () => Effect.fail(err),
                        ),
                      )
                    }),
                  ),
              ),
            )
            status = 'done'
          }
          const number = numberOf(child.key)
          // Recorded means attached, not published. Only a split whose every child, link and parent blocker is
          // already on GitHub can have had its labels lifted; any other split's child lacking the label gets it back.
          if (!(yield* alreadyPublished)) {
            const labelled = (yield* lift(() => github.getIssue(number))).labels.some(
              (l) => l.name === PUBLISHING_LABEL,
            )
            if (!labelled) yield* lift(() => github.addLabels(number, [PUBLISHING_LABEL]))
          }
          const attached = yield* ensure(
            () => github.listSubIssues(options.issue),
            () => github.addSubIssue(options.issue, number),
            number,
          )
          if (attached === 'done') status = 'done'
          // Written means attached; GitHub's `id` is only on the sub-issue listing.
          if (known.get(child.key) !== number) {
            const sub = (yield* lift(() => github.listSubIssues(options.issue))).find(
              (s) => here(s) && s.number === number,
            )
            if (sub === undefined) return yield* Effect.fail(new Error(`#${number} is not a sub-issue on read-back`))
            yield* note('SplitChildWritten', { waitId, key: child.key, number: sub.number, id: sub.id })
            // The key names another issue now, so links recorded for the old one are stale.
            if (known.has(child.key))
              for (const l of linked) if (l.split('\u0000').includes(child.key)) linked.delete(l)
            known.set(child.key, number)
          }
          return status
        }),
      )

    const writeSplitInto: Effect.Effect<StepStatus, Error> = Effect.gen(function* () {
      const listed = plan.children.map((c) => ({ number: numberOf(c.key), title: c.title, covers: c.covers }))
      for (let attempt = 0; ; attempt++) {
        const body = (yield* lift(() => github.getIssue(options.issue))).body
        const next = splitIntoSection(body, listed, plan.uncovered)
        if (next === body) return attempt === 0 ? ('skipped' as const) : ('done' as const)
        const retry = yield* lift(() => github.updateBody(options.issue, next, { ifUnchanged: body })).pipe(
          Effect.as(false),
          Effect.catchIf(
            (err) => err instanceof BodyChanged && attempt === 0,
            () => Effect.succeed(true),
          ),
        )
        if (retry) continue
        const after = (yield* lift(() => github.getIssue(options.issue))).body
        if (splitIntoSection(after, listed, plan.uncovered) !== after)
          return yield* Effect.fail(new Error('the Split into section did not land on read-back'))
        return 'done' as const
      }
    })

    let payload: unknown
    let result: SplitTicketResult | null = null

    const actions: { name: string; run: Effect.Effect<StepOutcome, unknown> }[] = [
      { name: 'read GitHub', run: Effect.succeed<StepOutcome>('done') },
      ...plan.children.map((child) => ({ name: `write ${child.key}`, run: writeChild(child) })),
      ...plan.blockedBy.map((d) => ({
        name: `chain ${d.ticket}←${d.blockedBy}`,
        run: Effect.gen(function* () {
          const status = yield* ensure(
            () => github.listBlockedBy(numberOf(d.ticket)),
            () => github.addBlockedBy(numberOf(d.ticket), numberOf(d.blockedBy)),
            numberOf(d.blockedBy),
          )
          const link = `${d.ticket}\u0000${d.blockedBy}`
          if (!linked.has(link)) {
            yield* note('SplitLinkWritten', { waitId, ticket: d.ticket, blockedBy: d.blockedBy })
            linked.add(link)
          }
          return status
        }) as Effect.Effect<StepOutcome, unknown>,
      })),
      ...plan.children.map((child) => ({
        name: `hold parent ← ${child.key}`,
        run: Effect.suspend(() =>
          ensure(
            () => github.listBlockedBy(options.issue),
            () => github.addBlockedBy(options.issue, numberOf(child.key)),
            numberOf(child.key),
          ),
        ) as Effect.Effect<StepOutcome, unknown>,
      })),
      { name: 'split into', run: writeSplitInto },
      {
        // Every read here is GitHub's answer, not the plan's: the sub-issue
        // listing is where the `id` comes from (no create call returns one), and
        // each child's own `blocked_by` is where the recorded links come from.
        name: 'record the split',
        run: Effect.gen(function* () {
          const subs = (yield* lift(() => github.listSubIssues(options.issue))).filter(here)
          const keyOf = new Map(plan.children.map((c) => [numberOf(c.key), c.key] as const))
          const parentHolds = yield* lift(() => github.listBlockedBy(options.issue))
          for (const c of plan.children)
            if (!links(parentHolds, numberOf(c.key)))
              return yield* Effect.fail(new Error(`the parent is not blocked by #${numberOf(c.key)} on read-back`))
          const children: { key: string; number: number; id: number }[] = []
          const blockedBy: { ticket: string; blockedBy: string }[] = []
          for (const c of plan.children) {
            const sub = subs.find((s) => s.number === numberOf(c.key))
            if (sub === undefined)
              return yield* Effect.fail(new Error(`#${numberOf(c.key)} is not a sub-issue on read-back`))
            children.push({ key: c.key, number: sub.number, id: sub.id })
            for (const l of (yield* lift(() => github.listBlockedBy(sub.number))).filter(here)) {
              const blocker = keyOf.get(l.number)
              if (blocker !== undefined && blocker !== c.key) blockedBy.push({ ticket: c.key, blockedBy: blocker })
            }
          }
          for (const d of plan.blockedBy)
            if (!blockedBy.some((b) => b.ticket === d.ticket && b.blockedBy === d.blockedBy))
              return yield* Effect.fail(new Error(`${d.ticket}←${d.blockedBy} was not linked on read-back`))
          payload = { waitId, children, blockedBy }
          // Not done until the append lands: marked when 'end the wait' succeeds.
          return 'not-reached' as const
        }) as Effect.Effect<StepOutcome, unknown>,
      },
      // Only now, with every child, link and blocked-by read back, is the label lifted: one DELETE per
      // child, never `setLabels`, so an `agent:hold` a person added survives. Idempotent on a retry.
      ...plan.children.map((child) => ({
        name: `publish ${child.key}`,
        run: Effect.gen(function* () {
          const number = numberOf(child.key)
          const before = yield* lift(() => github.getIssue(number))
          const had = before.labels.some((l) => l.name === PUBLISHING_LABEL)
          if (had) yield* lift(() => github.removeLabel(number, PUBLISHING_LABEL))
          const after = yield* lift(() => github.getIssue(number))
          if (after.labels.some((l) => l.name === PUBLISHING_LABEL))
            return yield* Effect.fail(new Error(`#${number} still carries ${PUBLISHING_LABEL} on read-back`))
          return (had ? 'done' : 'skipped') as StepOutcome
        }),
      })),
      {
        name: 'end the wait',
        run: Effect.suspend(() =>
          resolveWaitHoldingEffect(
            {
              ticketId,
              waitId,
              resolution: {
                _tag: 'Split',
                children: plan.children.map(({ covers: _covers, ...c }) => c),
                blockedBy: [...plan.blockedBy],
              },
              by: options.by,
              note: options.note,
              kinds: options.kinds,
              split: payload,
              store,
            },
            ticketId,
          ),
        ).pipe(Effect.map((resolved): StepOutcome => (resolved.ok ? 'done' : { detail: resolved.detail }))),
      },
    ]

    const steps: SplitStep[] = actions.map((a) => ({ name: a.name, status: 'not-reached' as const }))
    const knownChildren = () =>
      plan.children.filter((c) => found.has(c.key)).map((c) => ({ key: c.key, number: numberOf(c.key) }))
    steps[0]!.status = 'done'
    const recordAt = actions.findIndex((a) => a.name === 'record the split')

    let failedStep = ''
    for (const [i, action] of actions.entries()) {
      if (i === 0) continue
      const run = yield* settled(action.run)
      if (run.ok) {
        const outcome = run.value
        if (typeof outcome === 'string') {
          steps[i]!.status = outcome
          if (action.name === 'end the wait') steps[recordAt]!.status = 'done'
        } else {
          steps[i]!.status = 'failed'
          steps[i]!.detail = outcome.detail
          if (action.name === 'end the wait') {
            steps[recordAt]!.status = 'failed'
            steps[recordAt]!.detail = outcome.detail
          }
          result = {
            ok: false,
            ticketId,
            detail: `${action.name}: ${outcome.detail}`,
            steps,
            children: knownChildren(),
          }
          failedStep = action.name
          break
        }
      } else {
        const message = errorMessage(run.error)
        steps[i]!.status = 'failed'
        steps[i]!.detail = message
        if (action.name === 'end the wait') {
          steps[recordAt]!.status = 'failed'
          steps[recordAt]!.detail = message
        }
        failedStep = action.name
        result = {
          ok: false,
          ticketId,
          detail: `${action.name} failed: ${message}. Nothing was finished — call again to write what is missing.`,
          steps,
          children: knownChildren(),
        }
        break
      }
    }

    // One place on the way out. If this append is lost the board's running set still says the writer is gone, so the page reads interrupted, with Retry.
    if (result !== null) yield* noteFailed(failedStep, result.detail)

    return (
      result ?? { ok: true, ticketId, detail: 'split written, and back in the queue', steps, children: knownChildren() }
    )
  })
}
