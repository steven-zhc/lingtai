import { passedOver, runnableNow } from '@lingtai/conductor/discover'
import { attemptCeiling } from '@lingtai/conductor/filter'
import { projectFilter, type StepPlan, type ProjectFilter } from '@lingtai/conductor/filter'
import { currentRecipe, loadAllProjects } from '@lingtai/conductor/projects'
import { backingOff, heldUntil, selectRunnable } from '@lingtai/conductor/queue'
import { readState } from '@lingtai/conductor/snapshot-state'
import { readStatus } from '@lingtai/daemon/control'
import {
  CONFLICT_ROUND_HUNKS,
  type AttemptState,
  type BlockDiagnosis,
  type Lock,
  type ProjectState,
  type RuntimeId,
  type WaitId,
  whenLabel,
  agentBranchOf,
  isPending,
  isRegistered,
  attemptReducer,
  ticketStream,
  waitWords,
} from '@lingtai/domain'
import {
  acceptedTriageNote,
  recommendedResolution,
  triageStatus,
  type Resolution,
  type TriageStatus,
} from '@lingtai/domain/wait'
import { eventStore, log } from '@lingtai/event-store'
import type { LinkedIssue } from '@lingtai/github'
import type { SpendRow } from '@lingtai/projector'
/**
 * The board's data: one table, plus one question put to GitHub.
 *
 * The table is the answer for everything Lingtai has touched. **Queued is the
 * exception**, and it is not an inconsistency: an issue nobody has run has no
 * events, so there is nothing to reduce — being queued is a fact about GitHub,
 * not about the log. It used to be cached in `task_view` by a writer that was
 * not the projection, which is how a queue change reached nobody (#56) and how
 * two entry points came to disagree about refreshing it (#57);
 * [0022](../../../../doc/decisions-archive/0022-the-seams.md) deleted the cache, so the
 * question is asked here instead, once per render.
 *
 * `task_view` holds what a card shows and nothing else
 * ([0012](../../../../doc/decisions-archive/0012-one-task-view.md)). Gate evidence,
 * review findings and the diff are **not** here — they are read
 * from the event stream when somebody opens a task, because a list view and a
 * detail view have opposite economics and the list is what has to be cheap.
 *
 * That is also why the card got readable. It was heavy because the old
 * projection made everything available and what is available gets rendered;
 * moving detail behind a task id makes a card's contents a decision.
 */
// The subpath, not the barrel: importing the barrel pulls in the gate
// pipeline and its child-process types, which a page rendering cards has no
// business compiling.
import {
  describeArm,
  describeWait,
  readTaskProjects,
  readTasks,
  splitLine,
  type TaskCard,
  type TaskState,
} from '@lingtai/projector/task-view'
import type { ResolvedRecipe } from '@lingtai/recipe'
import { queueOf, ticketSourceOf, type TicketSource } from '@lingtai/recipe/settings'
import { Effect } from 'effect'

import {
  accountsHolding,
  anyCeilingToday,
  ceilingToday,
  isPaused,
  joinNames,
  type LockMap,
  pausedNames,
} from './lock-marks.ts'
import { describeHeld, progressOf, spentOf, type Granted, type AttemptProgress } from './progress.ts'
import { savedFixWorkFromState } from './saved-fix-work.ts'
import { boardWriterOrNone } from './snapshot-writer.ts'
import {
  billOf,
  currentSpend,
  emptyBill,
  grantedOf,
  withNoSpendFallback,
  type Bill,
  type SpendCurrency,
} from './spend.ts'
import { timed } from './timing.ts'
import { presentCause, type CausePresentation } from './triage-cause.ts'

/**
 * Four, not five. `verifying` reduces into `running` (ADR 0016 §8).
 *
 * From an operator's seat "the agent is working" and "the build is running" are
 * the same fact — the machine is busy and you are not needed — so two lanes for
 * them made the board wider without making it say more. `waiting` is the lane
 * the board exists for, and keeping it distinct is the whole point.
 */
export type ColumnId = 'queued' | 'running' | 'waiting' | 'landed'

export interface BoardCard {
  taskId: string
  /**
   * Which repository this is from.
   *
   * Carried because an issue number is only unique *within* a project. Two
   * projects both having a #122 renders as two cards that look identical and
   * are not — which a board full of `esctest*` fixtures made obvious: eight
   * cards reading `#122`, one per project, none of them duplicates.
   */
  project: string
  column: ColumnId
  ref: string
  kind: string
  /**
   * What colour *this repository* gives the label this kind is read from,
   * `#rrggbb`, or null when GitHub has none for it.
   *
   * Read, never invented. Kinds are unbounded since #76, so a colour Lingtai
   * generated would have to be hashed from the name and would eventually land
   * on the amber the palette reserves for "a person is being waited on" (#85) —
   * silently, and by luck. The repository's team already chose a colour in
   * GitHub's own UI, so the board reads that instead, which is 0016 §7's rule
   * about not guessing on behalf of a repository you cannot see.
   *
   * Null is the ordinary case for a kind nobody has an open issue for, and it
   * renders as the kind rendered before this existed: grey text, no dot.
   * Whether a non-null colour can actually be drawn is a separate question and
   * a separate file — `kind-colour.ts` holds the contrast floor and the one
   * hue the board refuses.
   */
  kindColor: string | null
  title: string
  tier: string
  /** What the last run produced. The diff a person reads is this one. */
  headSha: string | null
  /**
   * What the run is *asking* about, for the controls that are bound to a
   * commit. Not `headSha`: a branch repaired and re-offered moves this and
   * leaves that where it was, and sending the wrong one is an Approve that
   * refuses what `lingtai approve` accepts (#92).
   */
  awaitingSha: string | null
  /**
   * The wait this card is rendering, paired with its question in one
   * `task_view` row (#465). Null off every lane but Waiting.
   */
  waitId: WaitId | null
  /**
   * Counts, not verdicts, and only from the run this card names — the verdicts
   * themselves are on the task's own page. Waived and approved are separate
   * from passed because they are a person's word standing in for a gate's, and
   * reducing them together made an override read as a green build (#78).
   */
  passed: number
  failed: number
  waived: number
  approved: number
  turns: number | null
  /**
   * What this ticket's `Action`-round-0 runs cost — read off `spend`, grouped
   * by ticket once for the whole board and never per card (`#498`). No longer
   * `task_view.cost_usd`, which was `RunFinished`'s alone and so showed a
   * card's *last pass's implement* and nothing before it (0110 §13).
   */
  costUsd: Bill
  /** One line: what it is waiting on, or why it stopped, or what it merged as. */
  note: string | null
  /** `waitWords`' short name for the wait — `ready to land` for a hold for approval; null for every other wait. */
  short: string | null
  /** `split into #12, #13` on a parent a split wrote children for (#600); its own line, never reduced into `note`. */
  split: string | null
  /** Current wait's advised cause and summary, or null when advice is unavailable or stale. */
  cause: (CausePresentation & { summary: string }) | null
  /**
   * The one button this waiting card carries (#647): the resolution triage
   * *advised*, in `recommendedResolution`'s terms, or null. Null for every
   * triage status but `Done` with `TriageAdvised` — a wait's own default orders
   * the task page's cards but is not triage's recommendation — and null when
   * the advice is contradicted or the wait does not allow it.
   *
   * `onSha` is what the action wants: the saved fix head for `GrantFixRound`
   * (null, so no button, where the log has none), the awaited sha for
   * `Approve`, and nothing for the rest. `note` is `Approve`'s, because a
   * one-click approve over a refusing step must say whose reading it took.
   */
  move: {
    resolution: Resolution['_tag']
    onSha: string | null
    note: string | null
    /** Set on Approve for a `DiffTooLarge` wait: the characters the reviewer will read (#892). */
    clippedLimit?: number
    /** Triage's own resolution, present only where the recommendation overrides it (#652). */
    advised?: Resolution['_tag']
  } | null
  /** A triage that has not finished, for the card to say so; null once there is a result or none is owed (#576). */
  triage: 'Queued' | 'Running' | 'Interrupted' | 'Unknown' | 'RecipeUnreadable' | null
  /**
   * When the log last moved this card, ISO — the one number every lane wants
   * and none of them showed (#79). Five minutes and three days looked
   * identical, worst of all on `waiting`, which is "the lane the board exists
   * for" (0016 §8) and where how long it has waited is the whole question.
   *
   * Null for a card GitHub is offering that the log has never touched. There is
   * no timestamp for one — neither the log nor the issue list supplies it — and
   * stamping the render clock would put `queued now` on a ticket that has sat
   * open for a week.
   */
  updatedAt: string | null
  /** Attempts so far, so a card that keeps failing reads as one. */
  attempts: number
  /**
   * *restart 1 of 2*, or null on a ticket that has only ever had one approach
   * — which is every ticket until a recipe sets `runtime.limits.restarts`
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §3).
   *
   * **The sentence and not the numbers**, because `lingtai status` shows the
   * same fact and the two must not word it differently (#100). It is
   * `describeArm`'s, fed the row's `restarts` and the recipe's own
   * `limits.restarts` as the ceiling, and the board does not get to have its
   * own version of it — the same rule `runnableAt` and `describeWaitLines`
   * already follow.
   *
   * It is not `attempts`. That counts claims, so a claim after a crash, after a
   * backoff and after an approach was thrown away all read as `attempt 3`.
   */
  arm: string | null
  /**
   * The budget line a held item's rail carries — rounds spent against their
   * ceiling, restarts left against theirs (`describeHeld`, `#415`). Null
   * wherever there is no rail: the rail's own non-live readings are the only
   * place it is drawn (`rail.tsx`).
   */
  held: string | null
  /**
   * Whether a person is holding a question at all. The waiting lane also holds
   * a run that asked something mid-flight, and that is not an item anybody can
   * hand back. A refused dispatch moves an item that was merely queued
   * nowhere since `#405` (it was `queued` already, because the refusal is the
   * pass's rather than this item's) and never disturbs this column on an item
   * already holding a question — only a person's answer does that.
   */
  waiting: boolean
  /**
   * Whether this item reached its end by a person's decision rather than by
   * landing (`#151`). It shares Landed's column because both are over and
   * Landed is already the archive — but the two are not the same fact, and a
   * row that does not say which is a column heading speaking for a row it is
   * wrong about. `COLUMN_OF`'s comment promised the row would say; this is the
   * field that lets it.
   */
  closed: boolean
  /**
   * Whether that question was asked before any run (`lingtai ask`, #147) — so
   * the move is an answer, not a review and not a requeue.
   */
  asked: boolean
  /**
   * *waiting for your answer* or *waiting for your review*, or null. One brass
   * chip carried both before #147; the sentence is `describeWait`'s, which
   * `lingtai status` prints too.
   */
  wait: string | null
  /**
   * Which kind of hold this is — `judgement` when the decision is a person's,
   * `acknowledgement` when something failed and nobody has decided what to do.
   *
   * Null on every block written before #83, and the card renders one of those
   * exactly as it did then: the question, and the move it actually has.
   */
  needs: 'judgement' | 'acknowledgement' | null
  /**
   * What happened, what was done about it, and what is recommended.
   *
   * The card's own sentence used to be whatever string a conductor put in
   * `question`, which on a conflict was a git error with a colon in it — an
   * operator being asked to diagnose, in a UI with no diagnosis in it (#83).
   * Null when nobody has written one, which is most blocks.
   */
  diagnosis: BlockDiagnosis | null
  /**
   * What diagnosis has cost, separately from the work — an `Action` row at
   * round 1 or above (0039 §3). An empty bill on the cards that have never
   * bought one, which is nearly all of them.
   */
  repairCostUsd: Bill
  /**
   * When the backoff stops holding this card, ISO. Null when nothing is holding
   * it — which is every card that is not queued, and most that are.
   *
   * A card whose last attempt failed sits in Queued looking exactly like one
   * nobody has got to yet, and it is the one that will *not* be taken next
   * (`#95`). The time is the only thing that distinguishes them, so it is on
   * the card rather than derived at render: the rule that produced it is
   * `heldUntil`, and the board does not get to have its own version of it.
   */
  runnableAt: string | null
  /**
   * Where the run got to: the phase, its elapsed, and all ten steps.
   *
   * Null on a card no run has touched, and on the Landed rows the lane keeps
   * collapsed — `laneProgress` decides, and says why it stops where it does.
   *
   * It was the Running lane alone, on the argument that every other lane
   * describes something over and the accumulated numbers are the whole truth
   * about it (#79). They are not: *a point that was configured and did not run*
   * is not a number, and it is the one state 0016 §4 calls Lingtai's bug
   * (#170). Reduced from the run's own stream rather than held in `task_view` —
   * see `progress.ts` for why that does not make the list expensive.
   */
  progress: AttemptProgress | null
}

/**
 * What one pass of a project may spend, as the board says so.
 *
 * Not on a card, because it is a fact about the repository and not about any
 * one ticket — and shown whether it buys anything or not, the way an
 * unconfigured gate point is shown as `skipped` rather than omitted (0025 §2). A
 * default that is invisible when it is off is a default nobody can audit.
 *
 * **On the recipe page, as an attempt, and not on the bar.** 0025 §2 asks that a repository be
 * able to see what it spends without being asked, and it is right — but
 * *visible* is not *permanently on screen*. It changes about once a quarter and
 * cost a chip per project on a rail read at a glance
 * ([the-bar.md](../../../../doc/design/the-bar.md)), so it sits on the recipe
 * page (`lib/recipe.ts`) instead: what answering refusals may spend, and the
 * standing permission that lets it (#84).
 *
 * **`summary` is `attemptCeiling`'s sentence and not the board's own**
 * ([0039](../../../doc/decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
 * Three places say what a pass costs — here, `lingtai add` and the drain — and
 * the last time two of them were written separately one of them was wrong for a
 * day without anybody being able to see it.
 */
export interface AttemptLimitsView {
  project: string
  /** `runtime.limits.rounds`. Zero means nothing patches a diff in place. */
  rounds: number
  /**
   * `runtime.limits.restarts`. Zero means a pass whose rounds are spent asks a
   * person, which is every project today
   * ([0040](../../../doc/decisions-archive/0040-rounds-bound-depth-restarts-bound-breadth.md) §5).
   *
   * **Beside `rounds` because the chip is about what a ticket costs**, and the
   * two ceilings multiply: `rounds: 0, restarts: 2` buys three agent runs on a
   * ticket while advertising a depth ceiling of none. A chip that named only
   * the first would be the 2026-09-10 drain failure on the one always-visible
   * surface — a sentence that is true of a number it is not made of.
   */
  restarts: number
  /** `attemptCeiling`'s sentence, for the chip's title. */
  summary: string
}

export interface Board {
  columns: BoardColumn[]
  /**
   * The priority order the Queued column groups by — `source.kinds`, earlier
   * first, which is the order `selectRunnable` sorts on.
   *
   * On the board rather than derived at render because it is the recipe's and
   * the board does not get to have its own version of it, the same argument
   * `runnableAt` makes. With more than one project it is the union of their
   * orders, projects in the order `loadProjects` gives and first mention
   * winning: two repositories can disagree about whether `bug` outranks
   * `feature`, and one column can only be in one order.
   *
   * Empty when no recipe could be read — every group then falls through to the
   * unordered tail, which is the honest rendering of "nothing said what comes
   * first".
   */
  queueOrder: string[]
  /**
   * Where each project's tickets live, for the reference `issueUrl` builds.
   *
   * Here rather than read in the page, for the reason `queueOrder` is here:
   * `queueFilters` already resolved every recipe this loop needs, and reading
   * one twice is how a render gets expensive.
   */
  ticketSources: Map<string, TicketSource>
  /**
   * Every project this board can be narrowed to, in the order the bar offers
   * them.
   *
   * Here rather than read in the page, for the reason `queueOrder` is here: it
   * has to be the same list whatever the board is currently showing, and a page
   * holding a filtered board has only one project's worth of cards to learn
   * from. A filter whose options are computed from what it is filtered to can
   * only ever offer the choice already made.
   */
  projects: string[]
  /**
   * The repositories that are recorded and not yet conducted — a card each,
   * with `Recheck` (#163).
   *
   * Beside the columns rather than in one: a column holds work, and a pending
   * project has none — it has not been asked GitHub for a queue and must not
   * be, because it has no recipe to be asked under.
   */
  pending: PendingProject[]
  /**
   * The projects whose recipe resolved: who GitHub is asked about, by
   * `githubQueue`, once the page has gone out (#884). `loadBoard` asks nobody.
   */
  askable: AskableFilter[]
  /** The log's task ids, which GitHub's cards must not duplicate. */
  known: Set<string>
}

/**
 * A repository on its way in, as the card needs it.
 *
 * Not a `BoardCard`, for the reason `QueueProblem` is not one: every card on
 * this board is a piece of work, and this is a repository. The fields are what
 * `Recheck` is pressed with and what the reader is owed — which repository,
 * whose, and the branch the recipe is expected on.
 */
export interface PendingProject {
  project: string
  owner: string | null
  base: string | null
}

/**
 * A project whose queue could not be listed, and why.
 *
 * Its own shape rather than a card, because it is not work: it is the absence
 * of an answer about work, and rendering it as a card would put a fake ticket
 * on a board whose whole claim is that every card is real.
 */
export interface QueueProblem {
  project: string
  reason: string
}

export interface BoardColumn {
  id: ColumnId
  label: string
  cards: BoardCard[]
  /**
   * Only ever on Queued, and only when something went wrong.
   *
   * **"Nothing is runnable" and "the queue could not be listed" are different
   * facts and used to render identically** — as an empty column (#76). A recipe
   * that would not parse, a recipe that was missing and an App that was
   * misconfigured all arrived at the same empty catch here, whose comment
   * assumed the one failure it named.
   */
  problems?: QueueProblem[]
  /**
   * Only ever on Queued: what GitHub listed and the column is not showing, per
   * project — `12 passed over — excluded-label 9, blocked-by 1` — and, when it
   * applies, which issues were not checked for a blocker.
   *
   * Not a problem, because the queue *was* listed. Its own field so the column
   * can say both without calling a held ticket a failure (#131): the reason a
   * dependent ticket is not in the column is a number on a line rather than
   * silence (0016 §4), and a repository whose GitHub will not report
   * dependencies says so here, where the operator is looking, instead of
   * rendering a queue that looks ordered and is not.
   */
  notes?: QueueProblem[]
}

/**
 * How many landed items stay open before the rest reduce away.
 *
 * Landed is the lane that needs the least attention and it was the heaviest
 * thing on the page: six full cards of finished work against one waiting card
 * that took about a twelfth of the ink (#81), on a board whose own design note
 * says `waiting` "is the lane the board exists for" (0016 §8). The most recent
 * few answer *did the last thing work*; everything under them is a record, and
 * a record is something you open rather than something you scan.
 */
export const LANDED_OPEN = 3

/**
 * How many Waiting cards draw a rail.
 *
 * `progress.ts`'s trade is that a lane holding a *handful* of cards may read a
 * stream each on a route that re-renders on every append. The Waiting lane is
 * not that lane and the `COLUMNS` entry below says so in its own words — it
 * exists "because it is where the queue actually stalls: 45 items and growing"
 * — so reducing it whole would put forty-five concurrent stream reads on every
 * render, which is the cost `#112` was about.
 *
 * A cap and not a prediction: with Running holding a card per conductor and
 * Landed opening three, a render reads under a dozen streams whatever the lane
 * holds. `readTasks` orders Waiting oldest-first *because* that is what to do
 * next, so the cards that reduce are the ones being worked through; the rest keep
 * their counters, which is what every card had before `#170`.
 */
export const WAITING_RAILS = 6

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  // Its own column rather than a label, because it is where the queue actually
  // stalls: 45 items and growing against zero processed.
  { id: 'waiting', label: 'Waiting on you' },
  { id: 'landed', label: 'Landed' },
]

/**
 * What an empty column says.
 *
 * "Nothing here yet" under Running is false in the way that matters while the
 * conductor is paused (#77): there is plenty to run, and the reason none of it
 * is running is a decision somebody made and the log remembers. The empty
 * column is where a person looks when a lane is bare, so it is the one place
 * that has to know.
 *
 * **A person's pause is per project** (#995), and follows the filter: with
 * `locksInScope` (the locks of the projects in the selected scope) an empty Running
 * column names them. `everyProjectPaused` is the caller's to say — only it knows
 * how many projects are registered. **Today's ceiling outranks them** (#1007):
 * it holds every project, and says so once, pointing at the banner.
 *
 * **Under a filter it says whose emptiness it is.** "Nothing here yet" is a
 * claim about the log, and with one project selected the log may be full of
 * another project's work: the lane is bare because of a choice the reader made,
 * and saying so is the difference between a filter that is working and a board
 * that has nothing on it (#86). The conductor-wide pause is not narrowed —
 * `ctl-` is one stream for the whole installation — so that sentence is the
 * filter's to leave alone; only that one.
 */
export function emptyNote(
  column: ColumnId,
  paused: boolean,
  project?: string,
  locksInScope: LockMap = new Map(),
  everyProjectPaused = false,
  now: Date = new Date(),
  uses: ReadonlyMap<string, readonly RuntimeId[]> = new Map(),
): string {
  if (column === 'running' && paused) return 'Paused — nothing will start.'
  const ceiling = column === 'running' ? anyCeilingToday(locksInScope, now) : null
  if (ceiling !== null) {
    return `Nothing here yet. Today's spend reached the $${ceiling.ceilingUsd} ceiling — see the banner.`
  }
  const pausedInScope = pausedNames(locksInScope, undefined)
  if (column === 'running') {
    const accounts = accountWaits(locksInScope, now)
    if (accounts.size > 0) return accountNote(accounts, pausedInScope, project, uses, locksInScope, now)
  }
  if (column === 'running' && pausedInScope.length > 0) {
    if (project !== undefined) return `Nothing here yet. ${project} is paused.`
    if (everyProjectPaused) return 'Nothing here yet. Every project is paused.'
    const names = [...pausedInScope]
    const last = names.pop()
    const list = names.length === 0 ? last : `${names.join(', ')} and ${last}`
    return `Nothing here yet. ${list} ${pausedInScope.length === 1 ? 'is' : 'are'} paused; the others are taking work.`
  }
  if (column === 'waiting') {
    return project === undefined ? 'Nothing is waiting on you.' : `Nothing in ${project} is waiting on you.`
  }
  return project === undefined ? 'Nothing here yet.' : `Nothing here for ${project}.`
}

/** Each runtime whose limit still holds a project in scope → the names it holds, alphabetical (#1010). */
function accountWaits(locks: LockMap, now: Date): Map<RuntimeId, string[]> {
  const waits = new Map<RuntimeId, string[]>()
  for (const [name, ls] of [...locks].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const l of accountsHolding(ls, now)) waits.set(l.runtime, [...(waits.get(l.runtime) ?? []), name])
  }
  return new Map([...waits].sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The projects that use some runtime and are held by nothing at `now`. */
function takingWork(locks: LockMap, uses: ReadonlyMap<string, readonly RuntimeId[]>, now: Date): string[] {
  return [...uses.keys()]
    .filter((n) => !isPaused(locks.get(n)) && ceilingToday(locks.get(n), now) === null)
    .filter((n) => accountsHolding(locks.get(n), now).length === 0)
    .sort()
}

function accountNote(
  waits: Map<RuntimeId, string[]>,
  pausedInScope: readonly string[],
  project: string | undefined,
  uses: ReadonlyMap<string, readonly RuntimeId[]>,
  locks: LockMap,
  now: Date,
): string {
  const until = (runtime: RuntimeId): string => {
    const l = [...locks.values()].flatMap((ls) => accountsHolding(ls, now)).find((x) => x.runtime === runtime)
    return l === undefined ? '' : whenLabel(l.until, now)
  }
  const clauses = [...waits].map(
    ([runtime, names]) =>
      `${joinNames(names)} ${names.length === 1 ? 'waits' : 'wait'} for ${runtime} (limit until ${until(runtime)})`,
  )
  if (pausedInScope.length > 0) {
    clauses.push(`${joinNames(pausedInScope)} ${pausedInScope.length === 1 ? 'is' : 'are'} paused`)
  }
  if (project === undefined) {
    const working = takingWork(locks, uses, now).filter((n) => uses.has(n))
    const full = [...uses].filter(([n]) => working.includes(n))
    if (full.length > 0) {
      const runtimes = [...new Set(full.flatMap(([, r]) => r))]
      clauses.push(
        `${joinNames(working)} ${working.length === 1 ? 'runs' : 'run'} on ${joinNames(runtimes)} and ${working.length === 1 ? 'is' : 'are'} taking work`,
      )
    }
  }
  return `Nothing here yet. ${clauses.join('; ')}.`
}

/** Whether the empty line is drawn in the hold colour: all but "some are paused, the others work". */
export function emptyHeld(
  column: ColumnId,
  paused: boolean,
  project: string | undefined,
  locksInScope: LockMap,
  everyProjectPaused: boolean,
  now: Date = new Date(),
  uses: ReadonlyMap<string, readonly RuntimeId[]> = new Map(),
): boolean {
  if (column !== 'running') return false
  if (paused) return true
  if (anyCeilingToday(locksInScope, now) !== null) return true
  if (accountWaits(locksInScope, now).size > 0) {
    return project !== undefined || takingWork(locksInScope, uses, now).length === 0
  }
  const pausedInScope = pausedNames(locksInScope, undefined)
  return pausedInScope.length > 0 && (project !== undefined || everyProjectPaused)
}

/**
 * Which column a state is shown on. The whole mapping, said once.
 *
 * A record over `TaskState` rather than a ternary at the point of use, because
 * the states outnumber the columns and this is the only thing that makes the
 * board total: every state names a column, so no card can be nowhere. Written
 * as a record so a sixth state cannot be added without naming its column here
 * — which is the property #59 lacked, where bucketing on the raw state left a
 * task in `gates` off every column for the whole of its gate run.
 */
export const COLUMN_OF: Record<TaskState, ColumnId> = {
  queued: 'queued',
  running: 'running',
  // `verifying` is a task state and no longer a lane; it belongs with `running`.
  verifying: 'running',
  // Lingtai holds the next move on an approved item, not a person (#510), so
  // it belongs with `running` rather than `waiting`.
  approved: 'running',
  waiting: 'waiting',
  landed: 'landed',
  // Closed shares Landed's column and not Queued's. Both are over, and Landed
  // is already the archive — a list of one-line rows rather than a lane of
  // cards. What must not happen is the state before this existed: an item
  // nobody would ever claim, drawn where things that are going to be worked
  // are. Whether *over* deserves a column of its own is a later call, and the
  // row says which of the two it is.
  closed: 'landed',
}

/** What `triageStatus` reads besides the wait: the card and the page build it the same way. */
export interface TriageContext {
  /** Null where the project registry could not be read: the card says it does not know (#583). */
  declared: boolean | null
  daemonStartedAt: Date | null
  /** Set only with `declared: null`: the registry read, this project's recipe did not (#1014). Absent is the registry (#583). */
  unread?: 'recipe'
}

/**
 * The inputs to a wait's `TriageStatus`, in one place so the card and the task
 * page cannot derive it from different ones (#576). `status` is the beacon's
 * row, read once per render; null where no daemon has ever run.
 */
export function triageContextOf(
  declared: boolean,
  status: { startedAt: Date } | null,
): TriageContext & { declared: boolean }
export function triageContextOf(declared: boolean | null, status: { startedAt: Date } | null): TriageContext
export function triageContextOf(declared: boolean | null, status: { startedAt: Date } | null): TriageContext {
  return { declared, daemonStartedAt: status?.startedAt ?? null }
}

/** The context of a card whose project's recipe could not be read: unknown, and the recipe is why (#1014). */
export function recipeUnreadContext(status: { startedAt: Date } | null): TriageContext {
  return { ...triageContextOf(null, status), unread: 'recipe' }
}

/** The card's `TriageStatus`: the page's `currentTriageStatus` over the same wait gives the same answer. */
export function cardTriageStatus(
  t: Pick<TaskCard, 'wait' | 'triage'>,
  context: TriageContext,
): TriageStatus | 'Unknown' | null {
  if (t.wait === null) return null
  const { declared, daemonStartedAt } = context
  if (declared !== null) return triageStatus(t.wait.reason, t.triage, { declared, daemonStartedAt })
  // Only the last branch of 0118 §1 reads `declared`: where both answers agree
  // the unread registry changes nothing, and where they differ the card does
  // not know (#583).
  const ifDeclared = triageStatus(t.wait.reason, t.triage, { declared: true, daemonStartedAt })
  const ifNot = triageStatus(t.wait.reason, t.triage, { declared: false, daemonStartedAt })
  return ifDeclared._tag === ifNot._tag ? ifDeclared : 'Unknown'
}

/**
 * Whether each project's current recipe declares `triage:`, read the way the
 * task page reads it. A recipe that will not read maps to `null`, never `false`:
 * `false` would let the page, whose own read may succeed, say `Queued` about a
 * wait the card said nothing of. One project's recipe stays inside that project
 * (#1014).
 */
export async function declaredTriage(
  projects: ProjectState[],
  recipeFor: (p: ProjectState) => Promise<ResolvedRecipe> = (p) => currentRecipe(p),
): Promise<Map<string, boolean | null>> {
  const declared = await Promise.all(
    projects.map((p) =>
      recipeFor(p).then(
        (r) => r.recipe.triage !== undefined,
        () => null,
      ),
    ),
  )
  return new Map(projects.flatMap((p, i) => (p.project !== null ? [[p.project, declared[i] ?? null] as const] : [])))
}

/** One card's triage inputs: the registry's unknown, or this project's recipe's (#1014). */
function triageContextFor(
  declared: Map<string, boolean | null> | null,
  project: string,
  daemon: { startedAt: Date } | null,
): TriageContext {
  if (declared === null) return triageContextOf(null, daemon)
  const v = declared.get(project)
  if (v === undefined) return triageContextOf(null, daemon)
  return v === null ? recipeUnreadContext(daemon) : triageContextOf(v, daemon)
}

/** What the card's one button does, decided from the same `status` as its cause line (#647). */
function moveOf(
  t: Pick<TaskCard, 'wait' | 'awaitingSha'>,
  status: TriageStatus | 'Unknown' | null,
  fixHead: string | null,
): BoardCard['move'] {
  if (t.wait === null || status === null || status === 'Unknown') return null
  // The card holds the crash wait's own triage; the standing wait's advice is the
  // person's to read on the task page (#654).
  if (t.wait.reason._tag === 'AgentCrashed' && t.wait.reason.standing !== undefined) return null
  if (status._tag !== 'Done' || status.result._tag !== 'TriageAdvised') return null
  const resolution = recommendedResolution(t.wait.reason, status, { savedHead: fixHead !== null })
  if (resolution === null) return null
  switch (resolution) {
    case 'GrantFixRound':
      return fixHead === null
        ? null
        : {
            resolution,
            onSha: fixHead,
            note: null,
            ...(status.result.resolution === resolution ? {} : { advised: status.result.resolution }),
          }
    case 'Approve':
      return t.awaitingSha === null
        ? null
        : {
            resolution,
            onSha: t.awaitingSha,
            note: acceptedTriageNote(status.result.summary),
            ...(t.wait.reason._tag === 'ProposedEscalated' && t.wait.reason.proposal._tag === 'DiffTooLarge'
              ? { clippedLimit: t.wait.reason.proposal.limit }
              : {}),
          }
    default:
      return { resolution, onSha: null, note: null }
  }
}

/**
 * `runnableAt`, `progress` and `kindColor` are passed in rather than computed:
 * one needs the project's `source.backoff`, one the run's own stream and one
 * the repository's labels, and all three are a call away — this function is
 * the pure part.
 */
export function toCard(
  t: TaskCard,
  runnableAt: Date | null = null,
  progress: AttemptProgress | null = null,
  kindColor: string | null = null,
  /**
   * The project's own ceilings, for `held`'s fallback when the run's stream
   * named none of its own — a round never bought, a restart never spent. Null
   * where the recipe could not be read; `held` then reads the log alone.
   */
  limits: Pick<AttemptLimitsView, 'rounds' | 'restarts'> | null = null,
  /**
   * This ticket's `spend`, already split by `billOf` — read once for the whole
   * board and handed in here, never read per card (`#498`). Empty bills on
   * every card until a caller has `spend` to give: the queued-card stub never
   * does, because nothing has run.
   */
  costUsd: Bill = emptyBill(),
  repairCostUsd: Bill = emptyBill(),
  /**
   * What `triageStatus` reads besides the wait. The queued-card stub has no
   * wait, so it never reaches `triageStatus` and the default is never used.
   */
  triage: TriageContext = triageContextOf(false, null),
  /**
   * The saved fix head, from the run's own stream, for the waiting cards
   * `laneProgress` reads. Null is "not known", which drops `GrantFixRound`
   * from `move` exactly as `savedHead: false` does on the task page.
   */
  fixHead: string | null = null,
  /**
   * The rounds `held` is worded from: spent off the run's state and granted off
   * `spend` (#826). Null where the run has no progress, and `held` is null then.
   */
  rounds: { spent: number; granted: Granted } | null = null,
): BoardCard {
  const words =
    t.wait === null ? null : waitWords(t.wait.reason, { branch: agentBranchOf(t.issue), base: '', findings: [] })
  const status = cardTriageStatus(t, triage)
  return {
    taskId: t.taskId,
    project: t.project,
    column: COLUMN_OF[t.state],
    closed: t.state === 'closed',
    ref: t.issue,
    kind: t.kind,
    kindColor,
    title: t.title,
    tier: t.tier,
    headSha: t.headSha,
    awaitingSha: t.awaitingSha,
    waitId: t.wait?.waitId ?? null,
    passed: t.passed,
    failed: t.failed,
    waived: t.waived,
    approved: t.approved,
    turns: t.turns,
    costUsd,
    note: words?.line ?? t.note,
    short: words?.short ?? null,
    split: t.split === null ? null : splitLine(t.split),
    cause:
      status !== 'Unknown' && status?._tag === 'Done' && status.result._tag === 'TriageAdvised'
        ? { ...presentCause(status.result.cause), summary: status.result.summary }
        : null,
    move: moveOf(t, status, fixHead),
    triage:
      status === 'Unknown'
        ? triage.unread === 'recipe'
          ? 'RecipeUnreadable'
          : 'Unknown'
        : status?._tag === 'Queued' || status?._tag === 'Running' || status?._tag === 'Interrupted'
          ? status._tag
          : null,
    updatedAt: t.updatedAt.toISOString(),
    attempts: t.attempts,
    arm: describeArm(t, limits?.restarts ?? null),
    held:
      rounds === null
        ? null
        : describeHeld({
            spent: rounds.spent,
            granted: rounds.granted,
            roundsOf: limits?.rounds ?? null,
            restarts: t.restarts,
            restartsOf: t.restartsOf > 0 ? t.restartsOf : (limits?.restarts ?? null),
          }),
    waiting: t.wait !== null,
    asked: t.wait?.reason._tag === 'OwnQuestion',
    wait: describeWait({
      waiting: t.wait !== null,
      asked: t.wait?.reason._tag === 'OwnQuestion',
      awaitingSha: t.awaitingSha,
      needs: words?.needs ?? null,
    }),
    needs: words?.needs ?? null,
    diagnosis: words?.diagnosis ?? null,
    repairCostUsd,
    runnableAt: runnableAt === null ? null : runnableAt.toISOString(),
    progress,
  }
}

/**
 * One project's answer about its own queue, or the reason it has none.
 *
 * Three outcomes rather than two, because the middle one used to be silent:
 * `unreadable` is a recipe that would not resolve, `unanswered` is a recipe that
 * did and a GitHub that would not, and only the second still has a filter to
 * contribute — its kinds, its backoff, its gates. Losing those on a rate limit
 * would take the Queued column's ordering and a running card's timeout with it.
 */
export type AskableFilter = Extract<ProjectFilter, { ok: true }>

/**
 * One `blocked-by` skip as the board is told of it (#954): data only.
 *
 * `blockers: null` is two things, told apart by `unread`: false means no link
 * reader was available and nothing was asked; true means the skip was past
 * `BLOCKERS_READ_MOST` and was counted rather than read. A failure is the
 * error's message, because this crosses into a client component.
 */
export type BlockedSkip = {
  project: string
  ref: number
  title: string
  kind: string | null
  blockedBy: number | null
  blockers: { ok: true; issues: LinkedIssue[] } | { ok: false; problem: string } | null
  unread: boolean
}

/** A `BlockedSkip` with the colour its repository gives its kind, taken as cards take theirs (#960). */
export type BlockedTicket = BlockedSkip & { kindColor: string | null }

/** The most `blocked-by` skips per project whose blockers are read, lowest number first. */
export const BLOCKERS_READ_MOST = 20
/** How long a read blocker list is trusted while the count is unchanged. */
const BLOCKERS_FRESH_MS = 60_000

type BlockerRead = NonNullable<BlockedSkip['blockers']>
const blockerCache = new Map<string, { blockedBy: number | null; at: number; blockers: BlockerRead }>()

/** Forgets every cached blocker list, so a test can start from *nothing read*. */
export function forgetBlockers(): void {
  blockerCache.clear()
}

/**
 * Reads the blockers of each `blocked-by` skip, through the per-process cache.
 * Never throws: one failed read is that skip's `ok: false`.
 */
async function readBlockers(
  filter: AskableFilter,
  skipped: Awaited<ReturnType<typeof runnableNow>>['skipped'],
  now: () => number,
): Promise<BlockedSkip[]> {
  const blocked = skipped.filter((s) => s.reason === 'blocked-by').sort((a, b) => a.ref - b.ref)
  const links = filter.links ?? null
  const out: BlockedSkip[] = blocked.map((s, i) => ({
    project: filter.project,
    ref: s.ref,
    title: s.title,
    kind: s.kind,
    blockedBy: s.blockedBy,
    blockers: null,
    unread: links !== null && i >= BLOCKERS_READ_MOST,
  }))
  if (links === null) return out
  const at = now()
  const reads = out.slice(0, BLOCKERS_READ_MOST).map((entry) => {
    const key = `${filter.project}#${entry.ref}`
    const hit = blockerCache.get(key)
    if (hit && hit.blockedBy === entry.blockedBy && at - hit.at < BLOCKERS_FRESH_MS) {
      entry.blockers = hit.blockers
      return Effect.void
    }
    return Effect.tryPromise({
      try: () => links.listBlockedBy(entry.ref),
      catch: (e) => (e instanceof Error ? e.message : String(e)),
    }).pipe(
      Effect.match({
        onSuccess: (issues): BlockerRead => ({ ok: true, issues }),
        onFailure: (problem): BlockerRead => ({ ok: false, problem }),
      }),
      Effect.map((blockers) => {
        entry.blockers = blockers
        blockerCache.set(key, { blockedBy: entry.blockedBy, at, blockers })
      }),
    )
  })
  await Effect.runPromise(Effect.all(reads, { concurrency: 'unbounded' }))
  return out
}

export type ProjectQueue =
  | { state: 'unanswered'; filter: AskableFilter; problem: string }
  | {
      state: 'listed'
      filter: AskableFilter
      offered: Awaited<ReturnType<typeof runnableNow>>
      runnable: Awaited<ReturnType<typeof selectRunnable>>
      /** The `blocked-by` skips with their blockers read (#954). Never cards. */
      blocked: BlockedSkip[]
    }

/**
 * What GitHub says about one project whose recipe has already resolved.
 *
 * Its own function so the loader below can be a `Promise.all` rather than a
 * queue of `await`s. Never throws: a failure is one of the two answers, which
 * is what lets the caller fan out without a rejection taking the whole column
 * down with the one project whose token expired.
 *
 * Takes the *filter*, not the project: resolving the recipe is `queueFilters`'
 * business and happens once per render, before the page is sent. This half is
 * what the page waits for after it (#884).
 *
 * `select` defaults to `selectRunnable` — which reads `task_view` — and exists
 * only so a unit test can reach this without a database (#354).
 */
export async function askProject(
  filter: AskableFilter,
  options: { select?: typeof selectRunnable; now?: () => number } = {},
): Promise<ProjectQueue> {
  const select = options.select ?? selectRunnable
  try {
    const offered = await runnableNow({ client: filter.tickets, queue: queueOf(filter.recipe) })
    const runnable = await select({
      project: filter.project,
      offered: offered.runnable,
      kinds: filter.kinds,
      backoffMs: filter.backoffMs,
    })
    const blocked = await readBlockers(filter, offered.skipped, options.now ?? Date.now)
    return { state: 'listed', filter, offered, runnable, blocked }
  } catch (err) {
    // The recipe resolved and GitHub still would not answer — a rate limit, a
    // revoked installation. Named rather than dropped, for the same reason.
    return { state: 'unanswered', filter, problem: (err as Error).message }
  }
}

/**
 * What the log's cards need from each recipe, and the projects whose recipes
 * resolved — the half of the Queued column that does not wait for GitHub.
 *
 * Still per project — a repository whose recipe will not read costs you its
 * queue and not the whole board — but no longer *silent*. This used to end in
 * an empty catch that swallowed four failures and rendered them as an empty
 * Queued column, which is also what a repository with nothing to do renders as
 * (#76). `projectFilter` is the shared answer: resolved, or refused with the
 * reason, in the same wording `lingtai daemon` and `lingtai status` use.
 *
 * Takes the projects rather than loading them, so the bar names what it could
 * show (#86).
 *
 * **It asks GitHub nothing** (#884). The recipe is a local file; what GitHub
 * offers is `githubQueue`'s, started after the page has gone out. The filters
 * that resolved are handed on as `askable`, so a recipe is still read once per
 * project per render — reading one twice is how a render gets expensive.
 *
 * `filterFor` is a seam so a test can prove the projects overlap.
 */
export async function queueFilters(
  projects: readonly ProjectState[],
  filterFor: (state: ProjectState) => Promise<ProjectFilter> = projectFilter,
): Promise<{
  /** The projects whose recipe resolved, in project order: who GitHub is asked about. */
  askable: AskableFilter[]
  /** A recipe that would not resolve, known before GitHub is asked. */
  problems: QueueProblem[]
  limits: AttemptLimitsView[]
  /** `source.backoff` per project, for the held cards `loadBoard` reduces from the log. */
  backoffMs: Map<string, number>
  /** The recipe's gates per project, for the running cards `loadBoard` reduces. */
  plans: Map<string, StepPlan>
  /** Where each project's tickets live, for the reference `loadBoard` carries onto `Board`. */
  ticketSources: Map<string, TicketSource>
  /** The kinds each project prioritises, in order, for the Queued grouping. */
  kindOrder: string[]
}> {
  const askable: AskableFilter[] = []
  const problems: QueueProblem[] = []
  const limits: AttemptLimitsView[] = []
  const backoffMs = new Map<string, number>()
  const plans = new Map<string, StepPlan>()
  const ticketSources = new Map<string, TicketSource>()
  // First mention wins, so two projects that order their kinds differently give
  // one column one order rather than an order that changes as rows arrive.
  const kindOrder: string[] = []

  // **All of them at once** (#112): nothing one project is asked depends on
  // another's answer, and the reducer below stays in project order.
  const filters = await Promise.all(projects.map((p) => filterFor(p)))

  for (const filter of filters) {
    if (!filter.ok) {
      problems.push({ project: filter.project, reason: filter.problem })
      continue
    }
    askable.push(filter)
    limits.push({
      project: filter.project,
      rounds: filter.limits.rounds,
      restarts: filter.limits.restarts,
      summary: attemptCeiling(filter.limits),
    })
    backoffMs.set(filter.project, filter.backoffMs)
    plans.set(filter.project, filter.plan)
    ticketSources.set(filter.project, ticketSourceOf(filter.recipe))
    for (const kind of filter.kinds) if (!kindOrder.includes(kind)) kindOrder.push(kind)
  }
  return { askable, problems, limits, backoffMs, plans, ticketSources, kindOrder }
}

/**
 * What each project's repository last said each of its kinds' colour is, keyed
 * by project and then by kind (#884).
 *
 * The log's queued cards are drawn without waiting for GitHub, and a dot's
 * colour is the repository's, learned from the issues `runnableNow` reads. So
 * the colours are the previous render's: the one GitHub answer this board keeps
 * across renders. Per process — a restart, or HMR, forgets them, and the cards
 * draw the neutral dot until the first queue answer.
 */
const lastKindColors = new Map<string, Record<string, string>>()

/** Forgets every colour, so a test can start from *no answer seen*. */
export function forgetKindColors(): void {
  lastKindColors.clear()
}

/** The last colour a project's repository gave a kind, or null if none has been seen. */
export function lastKindColor(project: string, kind: string): string | null {
  return lastKindColors.get(project)?.[kind] ?? null
}

/**
 * How many cards GitHub offered each project at its last answer (#897), so the
 * Queued column's skeletons can be as many as will replace them. Per process,
 * like the colours above: a restart forgets it, and `skeletonCount` says 2.
 */
const lastOffered = new Map<string, number>()

/** Forgets every count, so a test can start from *no answer seen*. */
export function forgetSkeletonCounts(): void {
  lastOffered.clear()
}

/** The most skeletons the column draws, and what it draws before any answer. */
const SKELETON_MOST = 3
const SKELETON_UNKNOWN = 2

/**
 * How many card skeletons to draw for the projects in view: what they offered
 * last time, summed and capped at 3; 2 when none of them has answered yet.
 */
export function skeletonCount(projects: readonly string[]): number {
  let sum = 0
  let seen = false
  for (const p of projects) {
    const n = lastOffered.get(p)
    if (n === undefined) continue
    seen = true
    sum += n
  }
  return seen ? Math.min(sum, SKELETON_MOST) : SKELETON_UNKNOWN
}

export interface HeldTicket {
  project: string
  ref: number
  title: string
  kind: string | null
  kindColor: string | null
  /** The `source.exclude` label that holds it, as the recipe spells it. */
  label: string
}

export interface EpicTicket {
  project: string
  ref: number
  title: string
  kind: string | null
  kindColor: string | null
  closed: number
  total: number
}

/** The skips the Queued column draws itself, so its note leaves them out. */
const DRAWN_SKIPS: ReadonlySet<string> = new Set(['blocked-by', 'excluded-label', 'epic'])

export interface GithubQueue {
  /** What GitHub offers that the log has no card for. */
  cards: BoardCard[]
  /** A project whose GitHub would not answer. */
  problems: QueueProblem[]
  /** What each listed project passed over and what it could not check. See `BoardColumn.notes`. */
  notes: QueueProblem[]
  /** The `blocked-by` skips and their blockers (#954). Not cards: nothing counts them. */
  blocked: BlockedTicket[]
  /**
   * The `excluded-label` skips (#955): a blocker among them reads *held* (#960),
   * and the foot of the column names each with the label that holds it.
   */
  held: HeldTicket[]
  /** The `epic` skips (#955): an epic with nothing queued, with how much of it is closed. */
  epics: EpicTicket[]
  /**
   * Each child's parent issue (#956), keyed `project#ref` to the parent's
   * number. Only a parent in the project's own repository: another
   * repository's issue number means nothing here.
   */
  parents: Map<string, number>
  /** How many projects were asked, and how many of them answered. */
  asked: number
  answered: number
  /**
   * What `selectRunnable` returned, summed over the projects that answered —
   * the figure `lingtai status` calls `Queue N runnable`, counted before the
   * log's cards are taken out. Null when a project did not answer and the sum
   * is 0: unknown is never 0. A positive sum is a lower bound.
   */
  runnable: number | null
}

/**
 * The Queued column's other half: what GitHub is offering that the log has not
 * taken, for the projects whose recipe resolved.
 *
 * **Never rejects.** `askProject` turns a throw into `unanswered`, and an `ask`
 * that throws anyway is turned into the same: the page awaits this from two
 * boundaries and has no error boundary, so a rejection would take it down.
 *
 * `known` is the log's task ids. A task released back to the queue has a row
 * *and* is offered by GitHub, so it would otherwise appear twice. The row wins:
 * it carries the attempts.
 *
 * `ask` is a seam so a test can prove the projects overlap. Nothing else
 * passes it.
 */
export async function githubQueue(
  askable: readonly AskableFilter[],
  known: ReadonlySet<string>,
  ask: (filter: AskableFilter) => Promise<ProjectQueue> = askProject,
): Promise<GithubQueue> {
  const cards: BoardCard[] = []
  const problems: QueueProblem[] = []
  const notes: QueueProblem[] = []
  const blocked: BlockedTicket[] = []
  const held: HeldTicket[] = []
  const epics: EpicTicket[] = []
  const parents = new Map<string, number>()
  let answered = 0
  let runnable = 0

  // All of them at once, for the reason `queueFilters` gives (#112).
  const asked = await Promise.all(
    askable.map((filter) =>
      ask(filter).catch((err: unknown): ProjectQueue => ({
        state: 'unanswered',
        filter,
        problem: err instanceof Error ? err.message : String(err),
      })),
    ),
  )

  for (const answer of asked) {
    const filter = answer.filter
    if (answer.state === 'unanswered') {
      problems.push({ project: filter.project, reason: answer.problem })
      continue
    }
    answered += 1
    runnable += answer.runnable.length
    const offered = answer.offered
    const links = filter.links ?? null
    const own = links === null ? null : `${links.owner}/${links.repo}`.toLowerCase()
    const adopt = (ref: string | number, parent: { repository: string; number: number } | null) => {
      if (parent === null || own === null || parent.repository.toLowerCase() !== own) return
      parents.set(`${filter.project}#${ref}`, parent.number)
    }
    for (const r of offered.runnable) adopt(r.ref, r.parent)
    for (const s of offered.skipped) adopt(s.ref, s.parent)
    // The row wins, as for the runnable cards below: a blocked ticket the log
    // already has a card for is drawn there and not counted here.
    for (const s of answer.blocked) {
      if (known.has(ticketStream(filter.project, s.ref))) continue
      blocked.push({ ...s, kindColor: s.kind === null ? null : (offered.kindColors[s.kind] ?? null) })
    }
    for (const s of offered.skipped) {
      const kindColor = s.kind === null ? null : (offered.kindColors[s.kind] ?? null)
      if (s.reason === 'excluded-label') {
        held.push({
          project: filter.project,
          ref: s.ref,
          title: s.title,
          kind: s.kind,
          kindColor,
          label: s.label ?? 'held',
        })
      } else if (s.reason === 'epic' && s.subIssues !== null) {
        epics.push({
          project: filter.project,
          ref: s.ref,
          title: s.title,
          kind: s.kind,
          kindColor,
          closed: s.subIssues.completed,
          total: s.subIssues.total,
        })
      }
    }
    // What the repository says each of its kinds looks like. A project whose
    // queue could not be listed contributes none, and its cards render the
    // way every card did before #85 — the failure costs a dot, not a card.
    lastKindColors.set(filter.project, offered.kindColors)
    const before = cards.length
    // `lingtai status` prints every skip; the column draws the `blocked-by` ones
    // as cards (#960) and the held and epic ones as its fold (#955), so its note
    // counts only the skips it does not.
    const passed = passedOver(offered.skipped.filter((s) => !DRAWN_SKIPS.has(s.reason)))
    if (passed !== null) notes.push({ project: filter.project, reason: passed })
    if (offered.dependenciesUnread !== null) {
      notes.push({ project: filter.project, reason: offered.dependenciesUnread })
    }
    for (const r of answer.runnable) {
      if (known.has(r.taskId)) continue
      cards.push({
        taskId: r.taskId,
        project: filter.project,
        column: 'queued',
        ref: r.issue,
        kind: r.kind,
        kindColor: offered.kindColors[r.kind] ?? null,
        title: r.title,
        // The column default the deleted cache also relied on. Which tier it
        // will actually run at is decided when it runs, not now.
        tier: 'guarded',
        headSha: null,
        awaitingSha: null,
        // Nothing has run, so there is no wait to resolve.
        waitId: null,
        passed: 0,
        failed: 0,
        waived: 0,
        approved: 0,
        turns: null,
        // Nothing has run, so there is nothing to bill.
        costUsd: emptyBill(),
        note: null,
        short: null,
        split: null,
        cause: null,
        move: null,
        triage: null,
        attempts: 0,
        // Nothing has run, so no approach has been abandoned.
        arm: null,
        // Nothing has run, so there is no rail and nothing held on it.
        held: null,
        waiting: false,
        // Never, and by construction rather than by luck: these cards are the
        // queue's own answer — what GitHub offers *minus* what the log says
        // Lingtai is doing — and `selectRunnable` drops every row whose state
        // is not `queued`, a closed one included. An item that reaches here has
        // no closing on the log to carry.
        closed: false,
        asked: false,
        wait: null,
        // Nothing has run, so nothing is held and nothing has been diagnosed.
        needs: null,
        diagnosis: null,
        repairCostUsd: emptyBill(),
        // Nothing in the log has touched this one, so there is no time to
        // show. See the field: the render clock is not an answer.
        updatedAt: null,
        // These are the ones `selectRunnable` just said *are* runnable.
        runnableAt: null,
        // Nothing has run, so there is nothing to be part-way through.
        progress: null,
      })
    }
    lastOffered.set(filter.project, cards.length - before)
  }
  return {
    cards,
    problems,
    notes,
    blocked,
    held,
    epics,
    parents,
    asked: askable.length,
    answered,
    runnable: answered < askable.length && runnable === 0 ? null : runnable,
  }
}

/**
 * Where each card's run got to, keyed by task id.
 *
 * **Three lanes, not one.** It was the Running lane alone, on the argument that
 * every other lane describes something that is over and the counts carry that
 * whole truth (#79). The counts were the thing that turned out not to be true:
 * a point that was *configured and did not run* is invisible in them, which is
 * the one state 0016 §4 calls Lingtai's bug, and `lingtai doctor` has been
 * failing on three of this repository's own items while the board said nothing
 * (#170). So Waiting reduces too — it is the lane asking for a person — and the
 * Landed lane reduces the rows it draws open.
 *
 * **And every one of the three is bounded.** `progress.ts`'s trade is that only
 * a lane holding a handful of cards may read a stream each, on a route that
 * re-renders on every append, and neither of the two lanes added here is that
 * lane on its own: Landed grows without bound and Waiting is documented at 45
 * items. `railCandidates` is where both are cut — `LANDED_OPEN` rows and
 * `WAITING_RAILS` cards — and it is a separate, pure function because the cut
 * is the whole of what makes this cheap. Everything past it keeps the counts it
 * has always had: a rail that is absent on a card is a smaller lie than a list
 * view that reads fifty streams to draw it.
 *
 * A stream that will not read costs that card its detail and nothing else. The
 * card is still on the board with its counts, which is what it had before.
 */
async function laneProgress(
  tasks: readonly TaskCard[],
  plans: ReadonlyMap<string, StepPlan>,
): Promise<{
  progress: Map<string, AttemptProgress>
  fixHeads: Map<string, string>
  roundsOpened: Map<string, readonly number[]>
}> {
  const railed = railCandidates(tasks)
  const railedIds = new Set(railed.map((c) => c.task.taskId))
  // A waiting card past the rail cap still gets its one button (#647), so the
  // saved head is read for it too — but only where `GrantFixRound` can be
  // recommended: triage advised it, or a small conflict swaps it in (#652). No rail is reduced.
  const headOnly = tasks.filter(
    (t) =>
      t.runId !== null &&
      t.wait !== null &&
      !railedIds.has(t.taskId) &&
      t.triage.result?._tag === 'TriageAdvised' &&
      (t.triage.result.resolution === 'GrantFixRound' ||
        (t.triage.result.cause._tag === 'ConflictingHunks' && t.triage.result.cause.total <= CONFLICT_ROUND_HUNKS)),
  )
  const headOf = (task: TaskCard, state: AttemptState) => {
    const saved = task.wait === null ? null : savedFixWorkFromState(task.runId as string, state)
    return saved !== null && 'head' in saved ? saved.head : null
  }
  // Both branches need only the attempt's state, so it is read through a snapshot (0124, #878). The board
  // offers snapshots through its writer; one lookup for all the cards.
  const read = { snapshots: log.snapshots, writer: await boardWriterOrNone() }
  const reduced = await Promise.all([
    ...railed.map(async ({ task, over }) => {
      try {
        const state = await readState(eventStore, attemptReducer, task.runId as string, 'all', read)
        // The saved head rides on the read already made, for the waiting cards
        // only; the remote-ref check stays in the action (#647).
        const progress = progressOf(state, plans.get(task.project), over)
        // The rounds ride only where the rail does: a stream with no progress has no held line.
        const opened = progress === null ? null : state.roundsOpened
        return [task.taskId, progress, headOf(task, state), opened] as const
      } catch {
        return [task.taskId, null, null, null] as const
      }
    }),
    ...headOnly.map(async (task) => {
      try {
        const state = await readState(eventStore, attemptReducer, task.runId as string, 'all', read)
        return [task.taskId, null, headOf(task, state), null] as const
      } catch {
        return [task.taskId, null, null, null] as const
      }
    }),
  ])
  return {
    progress: new Map(reduced.flatMap(([id, p]) => (p === null ? [] : [[id, p] as const]))),
    fixHeads: new Map(reduced.flatMap(([id, , head]) => (head === null ? [] : [[id, head] as const]))),
    roundsOpened: new Map(reduced.flatMap(([id, , , opened]) => (opened === null ? [] : [[id, opened] as const]))),
  }
}

/** A card that draws a rail, and whether this run's pass landed. */
export interface RailCandidate {
  task: TaskCard
  /**
   * The item **landed** — not merely that it is over.
   *
   * This is `progressOf`'s third argument and the only thing that turns a
   * point that recorded nothing from `pending` into `never-ran`, so it is held
   * to the strict anchor: *an item that landed is the case with no excuse — a
   * change on the base branch went past every point on its way there*. A **closed** item has that excuse and shares
   * this lane anyway (`COLUMN_OF`): the pipeline stops at the first refusal
   * (0041 §4), so a run refused at `prepared` and then closed by a person has
   * later points that correctly did not run, and marking them our bug would
   * draw the hatch on exactly the outcome the rail exists to report truthfully.
   */
  over: boolean
}

/**
 * Which cards draw a rail, in the order their lane draws them.
 *
 * Pure, and split from the read above, because both things it decides are
 * claims a test can hold and neither is visible in a reduced stream: **how many
 * streams one render may read**, and **which cards may be called landed**.
 *
 * **The head of each lane, as that lane renders it.** `Landed` opens
 * `LANDED_OPEN` rows of `toColumns`'s newest-first order and collapses the
 * rest, so the same sort and the same count are taken here — and `runId` is
 * filtered *after* the slice, not before, or a ticket closed on GitHub before
 * any run was claimed would push the reducer onto a row inside the `older`
 * disclosure. Waiting is `readTasks`'s oldest-first order, which is what to do
 * next, so its head is the head of the work.
 */
export function railCandidates(tasks: readonly TaskCard[]): RailCandidate[] {
  const lane = (id: ColumnId) => tasks.filter((t) => COLUMN_OF[t.state] === id)
  const open = [
    ...lane('running'),
    ...lane('waiting').slice(0, WAITING_RAILS),
    ...lane('landed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, LANDED_OPEN),
  ]
  return open.filter((t) => t.runId !== null).map((t) => ({ task: t, over: t.state === 'landed' }))
}

/**
 * Reads `task_view` into columns, and asks GitHub for the queue.
 *
 * An unbuilt projection is reported as empty rather than as a crash: it is a
 * state the system can be in, and it is the state it is in before the first
 * run. Showing fictional work would be worse than showing none.
 */
export async function loadBoard(project?: string): Promise<Board> {
  // Three reads, none of which is an argument to another, so they wait
  // together. In series they were three round trips laid end to end before the
  // first question had been put to GitHub (#112) — and the last of them,
  // `onBoardProjects`, used to sit at the very bottom of this function, after
  // everything, which is the most expensive place a table read can be.
  //
  // `registered` is loaded once and read twice: every registered project names
  // a filter the bar can offer, and only the ones the filter admits are asked
  // for their queue.
  const [tasks, all, onBoard] = await Promise.all([
    timed('tasks.read', () => readTasks(project === undefined ? {} : { project })).catch(emptyIfUnbuilt),
    // Null is not `[]`: the queue goes quiet on a failed read as it always
    // did, but triage's status must not be derived from projects it was never
    // told about (#583).
    loadAllProjects().catch(() => null),
    onBoardProjects(),
  ])
  const { registered, pending } = splitRegister(all ?? [])
  const names = registered.map((p) => p.project).filter((p): p is string => p !== null)

  // Before the reducer, because the reducer needs what it learned: a card the backoff
  // is holding is a card the log wrote, and how long it is held for is in the
  // recipe this just read (0028).
  //
  // `spend` beside it rather than after, for `#112`'s own reason: it is one
  // more read that is nobody's argument. Read once, by exactly the tickets on
  // this board — never a read per card, and never the whole table — and
  // `currentSpend` reads the table and reports its lag, the way `task_view` is
  // read: the board holds no projector, and the conductor lock's holder
  // follows `spend` (0100 §13; #786, reversing #498's reducer).
  const [queued, spend, daemon, triageDeclared] = await Promise.all([
    timed('board.recipes', () =>
      queueFilters(registered.filter((p) => project === undefined || p.project === project)),
    ),
    // Not measured, so not claimed: a skipped read has no lag to report, and
    // `{ lag: 0 }` would say it checked. `skipped: true` tells `spendChip`
    // this is a board with nothing to bill rather than a lag read that
    // failed — the two used to read identically as a bare `lag: null`
    // (`#498`'s review).
    tasks.length === 0
      ? Promise.resolve({ rows: [] as SpendRow[], currency: { lag: null, skipped: true } as SpendCurrency })
      : timed('spend.read', () => currentSpend({ ticket: tasks.map((t) => t.taskId) })),
    // The beacon's row, once for the board: the page reads the same one, and
    // a failed read reaches the board as an error there as it does on the page,
    // rather than leaving the cards to say less than the page will.
    readStatus(),
    // Which projects declare `triage:`, read from the recipe as the page reads
    // it (`loadCurrentTriageStatus`) and not off the queue filter, whose GitHub
    // client can fail for a project whose recipe is perfectly readable.
    all === null
      ? Promise.resolve(null)
      : declaredTriage(registered.filter((p) => project === undefined || p.project === project)),
  ])
  // After the recipes too, and for the same reason: a gate's timeout is the
  // denominator a running card measures against, and it is in the recipe this
  // just read.
  const { progress, fixHeads, roundsOpened } = await laneProgress(tasks, queued.plans)
  // Keyed by project, for `held`'s fallback when a run's own stream named no
  // ceiling of its own — this loop already resolved every recipe, and reading
  // one twice is how a render gets expensive (`queued.limits`'s own doc).
  const limitsByProject = new Map(queued.limits.map((l) => [l.project, l]))
  // Keyed by ticket, so every card's bill is a lookup rather than a scan of
  // the whole board's spend on every card.
  const spendByTicket = new Map<string, SpendRow[]>()
  for (const row of spend.rows) {
    if (row.ticket === null) continue
    const rows = spendByTicket.get(row.ticket)
    if (rows) rows.push(row)
    else spendByTicket.set(row.ticket, [row])
  }
  const now = Date.now()
  const fromLog = tasks.map((t) => {
    // A ticket whose runs predate `RunSpent` contributes not one row here —
    // `billOf` would reduce it to five empty bills, which reads as nothing
    // spent rather than as unknown (0110 §7, `#498`'s review).
    const rowsForTicket = spendByTicket.get(t.taskId) ?? []
    const bills = withNoSpendFallback(billOf(rowsForTicket), t.attempts, rowsForTicket)
    const opened = roundsOpened.get(t.taskId)
    const granted = grantedOf(rowsForTicket.filter((row) => row.pass === t.runId))
    return toCard(
      t,
      t.state === 'queued' ? heldUntil(t, queued.backoffMs.get(t.project) ?? 0, now) : null,
      progress.get(t.taskId) ?? null,
      // By kind and by project, because a label's colour is the repository's:
      // two projects can both have a `bug` and colour it differently, and the
      // cards say which repository they are from for the same reason.
      // The last colours a queue answer gave (#884): this render does not
      // wait for GitHub, so a colour is the previous render's, or none.
      lastKindColor(t.project, t.kind),
      limitsByProject.get(t.project) ?? null,
      bills.Work,
      bills.Answering,
      triageContextFor(triageDeclared, t.project, daemon),
      fixHeads.get(t.taskId) ?? null,
      opened === undefined ? null : { spent: spentOf(opened, granted), granted },
    )
  })
  // A task released back to the queue has a row *and* is offered by GitHub, so
  // it would otherwise appear twice. The row wins: it carries the attempts —
  // `githubQueue` applies that with this set (#884).
  const known = new Set(fromLog.map((c) => c.taskId))

  return {
    columns: toColumns(fromLog, queued.problems),
    askable: queued.askable,
    known,
    queueOrder: queued.kindOrder,
    ticketSources: queued.ticketSources,
    // Unfiltered, deliberately. This is the list the filter is chosen *from*,
    // so narrowing it to the current choice would remove every way back to the
    // rest — including "all".
    projects: filterOptions(names, onBoard),
    // Narrowed like the columns are: a filter on one repository is a reader
    // saying which repository they are looking at, and another one arriving is
    // as much a distraction here as a card would be.
    pending: pending.filter((p) => project === undefined || p.project === project),
  }
}

/**
 * The register, split into what can be conducted and what is on its way in.
 *
 * **The whole of #163's "must not break", in one place.** A pending project has
 * no registration, so `currentRecipe` has nothing to answer for it — and
 * `projectFilter` answers a throw as `unreadable`, which the Queued column renders
 * as *the queue could not be listed*. One repository waiting for `Recheck`
 * (#182) would therefore have put a
 * red line on the board, which is the failure the design names: **one card that
 * is not ready must not redden the page.** So the pending half never reaches
 * `queueFilters` and is asked nothing at all.
 *
 * Exported and pure for that reason: the property worth pinning is *who gets
 * asked*, and a test can hold it without a database or a GitHub.
 */
export function splitRegister(projects: readonly ProjectState[]): {
  registered: ProjectState[]
  pending: PendingProject[]
} {
  return {
    registered: projects.filter(isRegistered),
    pending: projects.filter(isPending).map((p) => ({ project: p.project as string, owner: p.owner, base: p.base })),
  }
}

/**
 * An unbuilt projection is an empty board; anything else is a fault.
 *
 * `relation "task_view" does not exist` is the state the system is in before
 * the first run, and showing fictional work would be worse than showing none.
 * Its own function only so the read can sit inside a `Promise.all` and still
 * rethrow everything that is not that.
 */
export function emptyIfUnbuilt(err: unknown): TaskCard[] {
  if (!/does not exist/i.test((err as Error).message)) throw err
  return []
}

/**
 * Which projects the log has cards from, or none when there is no projection.
 *
 * The same `does not exist` `loadBoard` reads as an empty board: before the
 * first run there is no table, and that is a state rather than a fault.
 */
export async function onBoardProjects(): Promise<string[]> {
  try {
    return await readTaskProjects()
  } catch (err) {
    if (!/does not exist/i.test((err as Error).message)) throw err
    return []
  }
}

/**
 * Every project the filter can offer, in the order the bar shows them.
 *
 * The union, and neither half on its own. The registered list alone loses a
 * project that has been unregistered while its work is still on the board —
 * **a card can outlive its project**, which is the distinction the page already
 * draws when it decides whether to print a project name on a card, and the
 * filter must not be the one control that cannot reach it (#86). The board's
 * own projects alone would lose a registered repository whose queue is all it
 * has: nothing of a project is in `task_view` until something has run.
 *
 * Registered first and in their own order, so the names an operator reads every
 * day keep their places; an unregistered project falls to the tail, where its
 * work is being wound down anyway.
 */
export function filterOptions(registered: readonly string[], onBoard: readonly string[]): string[] {
  const all = [...registered]
  for (const project of onBoard) if (!all.includes(project)) all.push(project)
  return all
}

/**
 * The project the board is showing: the URL's own choice, else the only one
 * there is (#993). With several there is nothing to default to, and `all` is
 * not a project.
 */
export function selectedProject(param: string | undefined, filters: readonly string[]): string | undefined {
  return param ?? (filters.length === 1 ? filters[0] : undefined)
}

/**
 * Buckets cards into the four columns, by the column each card already knows.
 *
 * Never by the task's raw state: a state the columns do not carry then matches
 * nothing and the card is dropped silently, which is precisely how a card
 * disappeared for the length of its gates (#59). The placement is `COLUMN_OF`'s
 * to make, and this only reads it back off the card.
 *
 * `problems` land on Queued, the one column that is a question put to GitHub
 * rather than a reducer of the log, and therefore the one that can fail to be
 * answered.
 */
export interface WaitingNeighbour {
  taskId: string
  issue: string
  title: string
}

/**
 * The neighbours of `taskId` in the Waiting lane, in the order `cards` already
 * has — which is `readTasks`'s, by how long each has waited. It never sorts:
 * the rule lives in the store's SQL and this is a second reader of it (#584).
 *
 * A ticket that is not in the lane (resolved, landed, queued, running) has no
 * previous, and its next is the lane's first card, which is already "other than
 * this one" because it is absent. Its old position is never reconstructed.
 */
export function waitingNeighbours(
  cards: readonly TaskCard[],
  taskId: string,
): { previous: WaitingNeighbour | null; next: WaitingNeighbour | null } {
  const lane = cards.filter((c) => COLUMN_OF[c.state] === 'waiting')
  const at = lane.findIndex((c) => c.taskId === taskId)
  const of = (c: TaskCard | undefined): WaitingNeighbour | null =>
    c === undefined ? null : { taskId: c.taskId, issue: c.issue, title: c.title }
  if (at < 0) return { previous: null, next: of(lane[0]) }
  return { previous: of(lane[at - 1]), next: of(lane[at + 1]) }
}

export function toColumns(
  cards: BoardCard[],
  problems: QueueProblem[] = [],
  notes: QueueProblem[] = [],
): BoardColumn[] {
  return COLUMNS.map((c) => {
    const mine = cards.filter((card) => card.column === c.id)
    return {
      ...c,
      // Landed only. `readTasks` orders the other lanes deliberately — waiting
      // by how long it has waited, the rest by ticket number — and none of that
      // is this function's to undo. Landed is the one lane whose question is
      // *what just happened*, and it is also the one that reduces away past the
      // most recent few (#81): "the most recent" is only a sentence the order
      // can make true.
      cards: c.id === 'landed' ? mine.sort(newestFirst) : mine,
      ...(c.id === 'queued' && problems.length > 0 ? { problems } : {}),
      ...(c.id === 'queued' && notes.length > 0 ? { notes } : {}),
    }
  })
}

/**
 * Why a Queued card is not moving, when something is stopping it.
 *
 * Typed alongside the sentence rather than only as one, for the reason
 * `describeWaitLines` gives about a hold: what it *is* has to be assertable without
 * a test depending on the wording, and the wording has to be decided in one
 * place so two readers of the same row cannot be told different things.
 */
export interface QueuedStanding {
  state: 'paused' | 'backing-off'
  /** What the card says. The whole of what is rendered. */
  text: string
  /** The hover, carrying the instant the phrase rounds off. */
  title: string
}

/**
 * Which of the three a Queued card is, said in one phrase — or null when it is
 * simply next.
 *
 * Three states sat in this column reading identically (`#100`, 0031's closing
 * table): one nobody has tried, one whose last attempt failed and which comes
 * back at 23:45, and one that is not going anywhere because the conductor has
 * been stopped. `board.ts` admitted the first pair in its own comment for the
 * whole of #95, and the third had no owner until 0031 §3 gave it one.
 *
 * **Null is the answer for the card that is simply next**, and it is the point
 * rather than an omission: a card with nothing holding it back has nothing to
 * say about when it starts, and `runnable now` on every ordinary queued card
 * would bury the two that mean something.
 *
 * **A pause outranks a backoff.** They can both hold at once and only one of
 * them decides anything: an item whose backoff lifts in a minute still does not
 * move while the conductor is taking nothing, so promising a time would be the
 * more precise of two answers and the wrong one.
 *
 * The conductor-wide pause's wording is `emptyNote`'s, because it is the same
 * fact the empty Running column already says (#77) — and its who, why and Resume
 * stay on the chip in the bar, which is where 0031 §5 leaves them. A project's
 * pause is only marked (0126 §8): its who, since and Resume are the banner's. Nothing here is new UI;
 * it is a fact reaching the column it was missing from.
 */
export function queuedStanding(
  card: Pick<BoardCard, 'column' | 'runnableAt' | 'project'>,
  paused: boolean,
  now: number = Date.now(),
  projectLocks: readonly Lock[] = [],
): QueuedStanding | null {
  // Only Queued. Every other lane is describing something that is running or
  // over, and neither the backoff nor the pause says anything about those.
  if (card.column !== 'queued') return null
  if (paused) {
    return {
      state: 'paused',
      text: 'paused — nothing will start',
      title: 'the conductor has been told to take no new work; this card keeps its place',
    }
  }
  // Today's ceiling (#1007, 0126 §8): it holds every project, so after the
  // conductor-wide pause and before a person's. A passed day's is not marked.
  if (ceilingToday(projectLocks, new Date(now)) !== null) {
    return {
      state: 'paused',
      text: "today's spend reached the ceiling — nothing will start",
      title: 'no new work starts until midnight or until today’s ceiling is raised; this card keeps its place',
    }
  }
  // A runtime at its usage limit (#1010): after the ceiling, before a person's
  // pause. A passed `until` marks nothing; the first by runtime when there are two.
  const limit = accountsHolding(projectLocks, new Date(now))[0]
  if (limit !== undefined) {
    return {
      state: 'paused',
      text: `${limit.runtime} is at its usage limit until ${whenLabel(limit.until, new Date(now))} — nothing will start`,
      title: `${card.project}'s recipe uses ${limit.runtime}; this card keeps its place`,
    }
  }
  // The project's own pause (#995): after the ceiling, before a backoff.
  if (isPaused(projectLocks)) {
    return {
      state: 'paused',
      text: `${card.project} is paused — nothing will start`,
      title: `${card.project} takes no new work until it is resumed; this card keeps its place`,
    }
  }
  if (card.runnableAt === null) return null
  return {
    state: 'backing-off',
    // `lingtai status`'s own phrase, from the package that owns the rule, so
    // the two places this is asked cannot come to word it differently again.
    text: backingOff(new Date(card.runnableAt), now),
    title: `backing off until ${card.runnableAt}`,
  }
}

/** One thing the Queued column draws, in render order (#956). */
export type QueueEntry =
  | { type: 'card'; card: BoardCard }
  | { type: 'epic'; epic: EpicTicket; cards: BoardCard[]; blocked: BlockedTicket[] }
  | { type: 'blocked'; ticket: BlockedTicket }

export interface QueueLayout {
  entries: QueueEntry[]
  /** The task id of the card *taken first*, or null. */
  next: string | null
  /** `project#ref` of every epic that heads a group, so the fold leaves it out. */
  headed: Set<string>
}

/**
 * The Queued column in `selectRunnable`'s own order — kind by the recipe's
 * `order`, then issue number — over runnable cards and the blocked cards that
 * belong to an epic. The first time a member of an epic appears, the whole
 * epic's group is placed there: its runnable cards, then its blocked ones.
 * Blocked cards with no epic come last, below every card and group (#960).
 *
 * A kind the order does not name goes after the ones it does, in the order
 * they first appear; a recipe that drops a kind leaves claimed items under it.
 *
 * *Taken first* is the first runnable card nothing holds back, in that same
 * order, wherever its group places it.
 */
export function groupQueue(
  cards: readonly BoardCard[],
  blocked: readonly BlockedTicket[],
  order: readonly string[],
  parents: ReadonlyMap<string, number>,
  epics: readonly EpicTicket[],
  markNext = true,
): QueueLayout {
  const epicOf = new Map(epics.map((e) => [`${e.project}#${e.ref}`, e]))
  const rank = new Map<string, number>()
  const rankOf = (kind: string | null): number => {
    const named = kind === null ? -1 : order.indexOf(kind)
    if (named >= 0) return named
    const key = kind ?? ''
    let r = rank.get(key)
    if (r === undefined) {
      r = order.length + rank.size
      rank.set(key, r)
    }
    return r
  }
  for (const item of [...cards, ...blocked]) rankOf(item.kind)
  const number = (ref: string | number) => (Number.isFinite(Number(ref)) ? Number(ref) : Number.MAX_SAFE_INTEGER)
  const compare = (
    a: { kind: string | null; ref: string | number },
    b: { kind: string | null; ref: string | number },
  ) => rankOf(a.kind) - rankOf(b.kind) || number(a.ref) - number(b.ref)
  const groupOf = (project: string, ref: string | number): string | null => {
    const parent = parents.get(`${project}#${ref}`)
    if (parent === undefined) return null
    const key = `${project}#${parent}`
    return epicOf.has(key) ? key : null
  }

  type Member = { card: BoardCard } | { ticket: BlockedTicket }
  const memberOf = (m: Member) => ('card' in m ? m.card : m.ticket)
  const pool: Member[] = [
    ...cards.map((card): Member => ({ card })),
    ...blocked.filter((t) => groupOf(t.project, t.ref) !== null).map((ticket): Member => ({ ticket })),
  ].sort((a, b) => compare(memberOf(a), memberOf(b)))

  const entries: QueueEntry[] = []
  const headed = new Set<string>()
  for (const m of pool) {
    const item = memberOf(m)
    const key = groupOf(item.project, item.ref)
    if (key === null) {
      if ('card' in m) entries.push({ type: 'card', card: m.card })
      continue
    }
    if (headed.has(key)) continue
    headed.add(key)
    const epic = epicOf.get(key)!
    entries.push({
      type: 'epic',
      epic,
      cards: cards.filter((c) => groupOf(c.project, c.ref) === key).sort(compare),
      blocked: blocked.filter((t) => groupOf(t.project, t.ref) === key).sort(compare),
    })
  }
  for (const ticket of blocked.filter((t) => groupOf(t.project, t.ref) === null).sort(compare)) {
    entries.push({ type: 'blocked', ticket })
  }

  const first = markNext
    ? pool.find((m): m is { card: BoardCard } => 'card' in m && m.card.runnableAt === null)
    : undefined
  return { entries, next: first === undefined ? null : first.card.taskId, headed }
}

/**
 * Newest first, by when the log last moved the card.
 *
 * A card with no `updatedAt` sorts last. Only a queued card can be missing one
 * — GitHub is offering it and the log has never touched it — so this never
 * fires on Landed; it is here so the comparator is total rather than because
 * the case arises.
 */
function newestFirst(a: BoardCard, b: BoardCard): number {
  const when = (c: BoardCard) => (c.updatedAt === null ? 0 : Date.parse(c.updatedAt))
  return when(b) - when(a)
}

/**
 * Where a ticket lives on GitHub, or null when the project predates `owner`
 * being recorded, or its tickets are not on GitHub at all (`tickets` is not
 * known to be `'github'`, #384).
 *
 * Built rather than asked for: it needs no answer from GitHub, so a card can
 * carry it without the board spending a request per card per render. The card's
 * title goes to the task page and its reference comes here — two destinations,
 * because *what Lingtai did* and *what was asked, and what people said about
 * it* are different questions and the second one had no link at all (#81).
 *
 * `tickets` is `null` where the board does not know where a project's tickets
 * live — a project that is `'unreadable'` (`queueFilters`) included, which is
 * exactly the project likeliest to be a `db` one with no GitHub App. A dead
 * link is worse than none, so an unknown source gets no link rather than the
 * `'github'` one it would have gotten before this field existed.
 */
export function issueUrl(
  owner: string | null,
  project: string,
  ref: string,
  tickets: TicketSource | null,
): string | null {
  if (owner === null || tickets !== 'github') return null
  return `https://github.com/${owner}/${project}/issues/${encodeURIComponent(ref)}`
}

/**
 * GitHub's compare view of `base` against `branch`, for a merge-conflict wait's
 * page (#590). The same rule as `issueUrl`, for the same reason: no owner, or
 * tickets that are not known to be on GitHub, get no link. A `base` of `null`
 * gets none either — there is nothing to compare against. Each `/`-separated
 * segment is encoded and the slashes kept, because `agent%2F590` is not a branch.
 */
export function compareUrl(
  owner: string | null,
  project: string,
  base: string | null,
  branch: string,
  tickets: TicketSource | null,
): string | null {
  if (owner === null || tickets !== 'github' || base === null) return null
  const ref = (r: string) => r.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${owner}/${project}/compare/${ref(base)}...${ref(branch)}`
}
