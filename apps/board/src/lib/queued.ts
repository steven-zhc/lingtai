import { runnableNow, type SkipReason } from '@lingtai/conductor/discover'
import { projectFilter, type StepPlan } from '@lingtai/conductor/filter'
import { loadProject } from '@lingtai/conductor/projects'
import { backingOff, heldUntil, selectRunnable } from '@lingtai/conductor/queue'
import { held as heldBy } from '@lingtai/daemon/control'
/**
 * What a queued item is waiting for, and what happens if you press the button.
 *
 * **`queued` is the one state no event carries.** An issue nobody has run has
 * no stream, so there is nothing to reduce — being queued is a fact about GitHub
 * and not about the log ([0012](../../../../doc/decisions-archive/0012-one-task-view.md),
 * `board.ts`). The board's Queued column has asked GitHub since 0022 deleted
 * the cache; this asks the same question about one item, because the detail
 * page had no way to ask it at all and answered every card in that column with
 * a 404 (#113).
 *
 * Two questions, and they are different:
 *
 * - **Where is it in line** — `selectRunnable`'s own order, and whatever is
 *   holding it: the recipe's backoff, or a conductor somebody stopped. Three
 *   states read alike inside Queued (`#100`) and the page had none of them.
 * - **What will happen** — the recipe's gate plan and its limits. It is the
 *   only question a queued page really has, every field of it already exists,
 *   and nothing was showing any of them.
 *
 * The rules are borrowed and never restated. `heldUntil` decides the backoff,
 * `selectRunnable` decides the order, `runnableNow` decides whether GitHub is
 * offering it at all — this file asks them and arranges the answers. A board
 * that had its own version of any of the three would be the second copy of a
 * rule that `#95`, `#100` and 0028 each spent a ticket removing.
 *
 * Everything that can fail says why rather than going blank, the way
 * `TicketView.problem` and `OutgoingView.problem` do. An unregistered project,
 * a recipe that will not parse and a GitHub that will not answer all render as
 * *no queue position*, and only the reason tells them apart (#76).
 */
import { reduceTicket, STEPS, type Envelope } from '@lingtai/domain'
import { plannedAt } from '@lingtai/recipe/defaults'
import type { TurnLimit } from '@lingtai/recipe/duration'
import { ceilingOf, queueOf } from '@lingtai/recipe/settings'

/** One of the ten steps, and what the recipe runs there. */
export interface PlannedStep {
  step: string
  /** The action names, in the order they run. Empty when nothing is configured. */
  actions: string[]
  /**
   * Nothing is configured here.
   *
   * A first-class state and not an absence, for the reason the attempt's own
   * `StepState` `skipped` is (ADR 0016 §4): a step that is merely left out looks
   * exactly like a step that was configured and silently did not run, and only
   * the second is Lingtai's bug. It has to be said *before* a run as well as
   * after one — an operator deciding whether to press the button is deciding
   * about the plan, and a plan with two of its ten steps missing from the
   * page is one nobody can audit.
   */
  skipped: boolean
}

/**
 * The recipe's answer to *what happens if I press the button*.
 *
 * Every field of it already existed — the gate plan `projectFilter` lifts out
 * of the recipe, and the limits beside it — and the page showed none of them.
 */
export interface PlanView {
  /** All ten, in pass order, including the ones nothing is configured at. */
  steps: PlannedStep[]
  /** `runtime.limits.turns`: a count, or `unbounded`. */
  turns: TurnLimit
  /** `runtime.limits.wall`, in the recipe's own words rather than milliseconds. */
  wall: string
  /** `runtime.tier` — how contained the run must be (0007). */
  tier: string
  /**
   * How many times a pass sends the agent back, `runtime.limits.rounds`
   * ([0039](../../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
   *
   * Rendered whether it buys anything or not, like a skipped point: a default
   * that spends money and only appears when it is doing something is a default
   * nobody can audit. Zero is the whole of what `repair.on: false` used to say,
   * and since `#143` the whole of what this repository buys for a refusal.
   */
  rounds: number
  /**
   * How many passes one ticket may buy, `runtime.limits.restarts`
   * ([0040](../../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §5).
   *
   * **Beside `rounds` because the two multiply**, and a footer built from the
   * depth ceiling alone advertises the wrong number: `rounds: 0, restarts: 2`
   * — 0040's *never patch, start over twice* — buys three agent runs on the
   * ticket while `rounds` says it buys none. This page is where somebody
   * decides whether to press the button, so it is the last place a ceiling
   * should be invisible.
   *
   * Rendered when it is zero too, for `rounds`' reason and `attemptCeiling`'s.
   */
  restarts: number
}

/** Why GitHub is not offering this issue to the conductor, in words. */
const NOT_OFFERED: Record<SkipReason, string> = {
  closed: 'the issue is closed',
  epic: 'it has open sub-issues, so it is an epic and is never taken',
  'no-kind': 'it carries no label this recipe takes',
  'excluded-label': 'it carries a label this recipe excludes',
  'already-discovered': 'the log already has it',
  // Said as the thing that has to change, not as a state it is in: the ticket
  // moves the moment the last blocker closes, with nothing to clear here (#131).
  'blocked-by': 'an issue it is blocked by is still open',
  // The assignee, as the recipe's `runtime.assignee` reads it (#181, #373).
  'assigned-elsewhere': 'it is assigned to somebody else',
  unassigned: 'it is assigned to nobody, and this machine takes only its own',
  'assigned-to-me': 'it is assigned to you, and this machine takes only unassigned work',
  // No login to compare with, so it is not said whose it is.
  assigned: 'it is assigned, and this machine takes only unassigned work',
}

/**
 * Where one item stands in the queue, and what taking it would run.
 *
 * Only ever built for an item the reducer calls `queued`. Every other state is
 * describing something that is running or over, and neither the order nor the
 * backoff says anything about those.
 */
export interface QueuedView {
  /**
   * 1-based place in the order the conductor claims — `selectRunnable`'s own
   * sort, so *4th in line* means the same thing the column's grouping does.
   *
   * Null when it is not in that list: GitHub is not offering it, or something
   * is holding it. Which of those is the next two fields.
   */
  position: number | null
  /** How many are in line, so `4th of 11` can be said. */
  inLine: number
  /**
   * Why GitHub is not offering this issue at all, and null when it is.
   *
   * A different fact from `runnableAt`: an item GitHub is offering and the
   * backoff is holding comes back on its own, and one carrying `agent:hold`
   * does not. Both were a card that read as *simply next* (`#100`).
   */
  notOffered: string | null
  /**
   * When the backoff stops holding it, ISO, and null when nothing is.
   *
   * `heldUntil`'s answer and not this file's arithmetic — the rule is the
   * recipe's (0028) and the board does not get to have its own version of it.
   */
  runnableAt: string | null
  /**
   * Whether the conductor has been told to take nothing.
   *
   * **A pause outranks a backoff**, the same reading `queuedStanding` makes for
   * the card: an item whose backoff lifts in a minute still does not move while
   * the conductor is stopped, so promising a time would be the more precise of
   * two answers and the wrong one.
   */
  paused: boolean
  /**
   * `runnableNow`'s sentence when some listed issues were not checked for a
   * blocker, and null when every one was.
   *
   * Beside `holding` rather than inside it: nothing is holding the item, so
   * *simply next* is still true — but it is true of an order nobody checked
   * against a chain, and a page that said only *next* would be the reading
   * #131 exists to remove.
   */
  dependenciesUnread: string | null
  /** What pressing the button runs. Null when the recipe could not be read. */
  plan: PlanView | null
  /**
   * This issue's kind as GitHub offers it — taken from the offer rather than
   * the runnable list, so an item the backoff holds still has one. Null when
   * GitHub is not offering it or could not be asked.
   */
  kind: string | null
  /** The kind order `selectRunnable` sorted by (`['bug']` where the recipe names none). Empty on `problem`. */
  kinds: string[]
  /** The entry after this one in line, null when last, not in line or on `problem`. */
  behind: { issue: string; title: string; kind: string } | null
  /** Why none of this could be answered, when it could not. */
  problem: string | null
}

/** The recipe's plan, as the page states it. Pure, and asserted as such. */
export function planOf(
  plan: StepPlan,
  runtime: {
    limits: { turns: TurnLimit; wall: string; rounds: number; restarts: number }
    tier: string
  },
): PlanView {
  return {
    steps: STEPS.map((step) => {
      const actions = [
        ...plannedAt(
          step,
          (plan.get(step) ?? []).map((a) => a.name),
        ),
      ]
      return { step, actions, skipped: actions.length === 0 }
    }),
    turns: runtime.limits.turns,
    wall: runtime.limits.wall,
    tier: runtime.tier,
    rounds: runtime.limits.rounds,
    restarts: runtime.limits.restarts,
  }
}

/**
 * When the backoff stops holding this item, from its own stream.
 *
 * The one input `heldUntil` reads off this stream — `reduceTicket`'s
 * `lastAttemptAt`, which counts a continuation of an unclaimed run as an
 * attempt (D11) — rather than
 * read back off `task_view`: the projection writes `last_attempt_at` from the
 * claim's own timestamp, so this reduce and that row cannot disagree (the
 * projection learns `TicketContinued` in its own ticket under #681). `repair
 * Pending` is always `false` since #502 — nothing buys a repair since `#143`,
 * and the event the old exemption read (`RepairRequested`) is gone from the
 * catalogue with the log reset this ticket's merge runs, so there is no log
 * left for a pending repair to be read off. The *rule* is still imported —
 * this supplies its arguments and nothing else, which is the split every
 * reduce in `task.ts` makes.
 */
export function backoffOf(own: readonly Envelope[], backoffMs: number, now: number = Date.now()): Date | null {
  return heldUntil({ lastAttemptAt: reduceTicket(own).lastAttemptAt, repairPending: false }, backoffMs, now)
}

function pickBehind(r: { issue: string; title: string; kind: string }): NonNullable<QueuedView['behind']> {
  return { issue: r.issue, title: r.title, kind: r.kind }
}

export function refused(problem: string, plan: PlanView | null, paused: boolean): QueuedView {
  return {
    position: null,
    inLine: 0,
    notOffered: null,
    runnableAt: null,
    paused,
    dependenciesUnread: null,
    plan,
    kind: null,
    kinds: [],
    behind: null,
    problem,
  }
}

/**
 * Ask GitHub where this item is in line, and the recipe what taking it does.
 *
 * Never throws, for `projectFilter`'s reason: a caller asking *why is this not
 * moving* always gets an answer, and "it could not be asked, because …" is one
 * of the answers rather than an exception somebody has to remember to catch.
 *
 * The default resolve, exactly as `askProject` does — the machine's file.
 */
export async function queuedFor(input: {
  project: string
  /** The issue number, as GitHub numbers it. */
  issue: string
  /** The item's own events, for the backoff. Empty for one that has never run. */
  own: readonly Envelope[]
  paused: boolean
}): Promise<QueuedView> {
  const { project, issue, paused } = input

  const state = await loadProject(project).catch(() => null)
  if (!state) return refused(`${project} is not a registered project`, null, paused)

  const filter = await projectFilter(state)
  if (!filter.ok) {
    return refused(`the recipe could not be read: ${filter.problem}`, null, paused)
  }

  // The plan survives a GitHub that will not answer. Losing *what will happen*
  // to a rate limit would be the same thing #76 removed from the Queued
  // column: one failure costing an answer it had nothing to do with.
  const plan = planOf(filter.plan, {
    // **The ceiling, and not `implement`'s reduction from it** (`#314`).
    // `PlanView.turns` and `.wall` are documented as `runtime.limits.turns` and
    // `runtime.limits.wall`, and `Plan`'s own footer promises *`runtime.limits`
    // in the recipe's own words … so the line reads back against the file it
    // came from*. Since `limitsFor` started reading its step, that call answered
    // a narrowed `implement` instead — two numbers for one documented field, and
    // the next reader comparing the panel against `~/.lingtai/config.yml` looks
    // for a bug in the machine-file merge. A step's own bound is named on the
    // `agent:` row, which is where it belongs.
    limits: ceilingOf(filter.recipe),
    tier: filter.recipe.runtime.tier,
  })
  const until = backoffOf(input.own, filter.backoffMs)

  try {
    const offered = await runnableNow({ client: filter.tickets, queue: queueOf(filter.recipe) })
    const runnable = await selectRunnable({
      project,
      offered: offered.runnable,
      kinds: filter.kinds,
      backoffMs: filter.backoffMs,
    })

    const at = runnable.findIndex((r) => r.issue === issue)
    // Offered is one question and in-line is another. An item GitHub offers and
    // the backoff holds is missing from `runnable` and is being offered all the
    // same, so the reason is the hold rather than the offer — saying otherwise
    // is how a held card came to read as one nobody had got to (#95).
    const listed = offered.runnable.some((o) => o.ref === issue)
    const skipped = offered.skipped.find((s) => String(s.ref) === issue)

    return {
      position: at < 0 ? null : at + 1,
      inLine: runnable.length,
      notOffered: listed
        ? null
        : skipped
          ? NOT_OFFERED[skipped.reason]
          : 'GitHub is not listing it among the open issues',
      runnableAt: until === null ? null : until.toISOString(),
      paused,
      dependenciesUnread: offered.dependenciesUnread,
      plan,
      kind: offered.runnable.find((o) => o.ref === issue)?.kind ?? null,
      // `selectRunnable`'s own fallback (`queue.ts`), so this describes the order it used.
      kinds: filter.kinds.length > 0 ? [...filter.kinds] : ['bug'],
      behind: at >= 0 && runnable[at + 1] ? pickBehind(runnable[at + 1]!) : null,
      problem: null,
    }
  } catch (err) {
    // The recipe resolved and GitHub still would not answer — a rate limit, a
    // revoked installation. Named rather than dropped, and the plan and the
    // backoff are kept, because neither of them needed the answer.
    return {
      ...refused((err as Error).message, plan, paused),
      runnableAt: until === null ? null : until.toISOString(),
    }
  }
}

/**
 * What is holding this item, in one phrase — or null when nothing is.
 *
 * **Three states sat in the Queued column reading identically** (`#100`,
 * 0031's closing table), and the detail page could not be opened at all, so it
 * had all three and said none of them. Null is the answer for the item that is
 * simply next, and it is the point rather than an omission: a card with nothing
 * holding it back has nothing to say about when it starts.
 *
 * The precedence is the one a person acts on, most permanent first.
 *
 * 1. **Not offered outranks everything.** An issue GitHub is not offering is
 *    one `selectRunnable` subtracts, so `Run it now` would append a request
 *    that matches nothing and expires unread — that is the fact to say, and it
 *    survives a resume and a backoff lifting.
 * 2. **A pause outranks a backoff**, exactly as `queuedStanding` reads it: an
 *    item whose backoff lifts in a minute still does not move while the
 *    conductor is taking nothing, so promising a time would be the more precise
 *    of two answers and the wrong one.
 * 3. **The backoff, with its time on it.** `backingOff` is `lingtai status`'s
 *    own phrase, from the package that owns the rule, so the three places this
 *    is asked cannot come to word it differently again.
 */
export function holding(view: QueuedView, now: number = Date.now()): string | null {
  if (view.notOffered !== null) return `GitHub is not offering it — ${view.notOffered}`
  if (view.paused) return 'paused — nothing will start'
  if (view.runnableAt !== null) return backingOff(new Date(view.runnableAt), now)
  return null
}

/**
 * What the Run-now click does under each hold, in `holding`'s order — null when
 * nothing holds it. `holding` states the hold once; this says the click's effect.
 */
export function runNowCaption(view: QueuedView): string | null {
  if (view.problem !== null) return null
  if (view.notOffered !== null) return 'GitHub is not offering it, so a request now would match nothing'
  if (view.paused) return 'the request waits until the conductor is resumed'
  if (view.runnableAt !== null) return 'skips the backoff'
  return null
}

/** `4th`, `1st`, `22nd`. */
function ordinal(n: number): string {
  const rest = n % 100
  if (rest >= 11 && rest <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

/**
 * Where it is in line, in words — `4th of 11 in line`.
 *
 * `of N` for the reason `from attempt 2 of 2` carries one: the position alone
 * reads as the whole story, and *4th* means something different in a queue of
 * five than in a queue of forty.
 *
 * Null when it is not in the list at all, which is not a gap: `holding` is then
 * the answer, and a position invented for an item nothing would claim would be
 * a place in a line it is not standing in.
 */
export function place(view: QueuedView): string | null {
  if (view.position === null) return null
  return `${ordinal(view.position)} of ${view.inLine} in line`
}

/** The first fact's label: the head of the line is there *first*, anyone else *here*. */
export function whyLabel(position: number | null): string {
  return position === 1 ? 'why first' : 'why here'
}

/** The attempts the conductor is holding, and how many it will hold at once. */
export interface InFlight {
  /** `since` is the row's `lastAttemptAt`; null is unknown, never 0. */
  running: { project: string; issue: string; since: Date | null }[]
  slots: number
}

/**
 * What is in flight, and the slots, as the conductor counts them.
 *
 * **`runtime.concurrency` is ignored without a daily ceiling** (`conduct.ts`):
 * then one slot, filled by any project's attempt. With one, `concurrency` slots
 * and this project's attempts only. `held` stays the one definition of "in
 * flight". Null when a ceiling is set and the recipe was not read — unknown is not 1;
 * without one the slots are 1 whatever the recipe says.
 */
export function inFlightOf(
  rows: readonly { project: string; issue: string; state: string; lastAttemptAt?: Date | null }[],
  project: string,
  concurrency: number | undefined,
  ceilingSet: boolean,
): InFlight | null {
  if (ceilingSet && concurrency === undefined) return null
  const running = heldBy(rows as Parameters<typeof heldBy>[0]).map((id) => {
    const at = id.lastIndexOf('#')
    const project = id.slice(0, at)
    const issue = id.slice(at + 1)
    const row = rows.find((r) => r.project === project && r.issue === issue)
    return { project, issue, since: row?.lastAttemptAt ?? null }
  })
  return ceilingSet
    ? { running: running.filter((r) => r.project === project), slots: concurrency! }
    : { running, slots: 1 }
}

/** The panel's chip: the place without *in line*, or what holds it. */
export function queuedChip(view: QueuedView, _inFlight: InFlight | null, now: number = Date.now()): string {
  if (view.problem !== null) return 'unknown'
  if (view.position !== null) return `${ordinal(view.position)} of ${view.inLine}`
  if (view.notOffered !== null) return 'not offered'
  if (view.paused) return 'paused'
  if (view.runnableAt !== null && holding(view, now) !== null) return 'backing off'
  return 'unknown'
}

/** The panel's sentence about its place and its hold. */
export function queuedSentence(view: QueuedView, inFlight: InFlight | null, now: number = Date.now()): string {
  if (view.problem !== null) return `Its place in the queue could not be read: ${view.problem}`
  const hold = holding(view, now)
  if (hold !== null) return hold
  if (view.position === null) return 'It is not in line.'
  if (view.position === 1) {
    if (inFlight === null) return 'Taken next, when a slot is free.'
    const n = inFlight.running.length
    if (n < inFlight.slots) return "Taken on the conductor's next turn."
    return n === 1
      ? 'Taken next, as soon as the running attempt finishes.'
      : `Taken next, as soon as one of the ${n} running attempts finishes.`
  }
  const ahead = view.position - 1
  return ahead === 1 ? '1 ahead of it; it is taken after it.' : `${ahead} ahead of it; it is taken after them.`
}

/** *bug → tech-debt → feature, then by number*; null when the order is unknown. */
export function kindOrder(view: QueuedView): string | null {
  if (view.kinds.length === 0) return null
  return `${view.kinds.join(' → ')}, then by number`
}
