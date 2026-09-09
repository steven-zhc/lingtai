/**
 * The board's data: one table, plus one question put to GitHub.
 *
 * The table is the answer for everything Lingtai has touched. **Queued is the
 * exception**, and it is not an inconsistency: an issue nobody has run has no
 * events, so there is nothing to fold — being queued is a fact about GitHub,
 * not about the log. It used to be cached in `task_view` by a writer that was
 * not the projection, which is how a queue change reached nobody (#56) and how
 * two entry points came to disagree about refreshing it (#57);
 * [0022](../../../../doc/decisions/0022-the-seams.md) deleted the cache, so the
 * question is asked here instead, once per render.
 *
 * `task_view` holds what a card shows and nothing else
 * ([0012](../../../../doc/decisions/0012-one-task-view.md)). Gate evidence,
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
  readTaskProjects,
  readTasks,
  type TaskCard,
  type TaskState,
} from "@lingtai/projector/task-view";
import type { BlockDiagnosis, ProjectState } from "@lingtai/domain";
import { eventStore } from "@lingtai/event-store";
import { heldUntil, selectRunnable } from "@lingtai/conductor/queue";
import { runnableNow } from "@lingtai/conductor/discover";
import { loadProjects } from "@lingtai/conductor/projects";
import { projectFilter, type GatePlan } from "@lingtai/conductor/filter";
import { foldProgress, type RunProgress } from "./progress.ts";

/**
 * Four, not five. `gates` folded into `running` (ADR 0016 §8).
 *
 * From an operator's seat "the agent is working" and "the build is running" are
 * the same fact — the machine is busy and you are not needed — so two lanes for
 * them made the board wider without making it say more. `waiting` is the lane
 * the board exists for, and keeping it distinct is the whole point.
 */
export type ColumnId = "queued" | "running" | "waiting" | "landed";

export interface BoardCard {
  taskId: string;
  /**
   * Which repository this is from.
   *
   * Carried because an issue number is only unique *within* a project. Two
   * projects both having a #122 renders as two cards that look identical and
   * are not — which a board full of `esctest*` fixtures made obvious: eight
   * cards reading `#122`, one per project, none of them duplicates.
   */
  project: string;
  column: ColumnId;
  ref: string;
  kind: string;
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
  kindColor: string | null;
  title: string;
  tier: string;
  /** What the last run produced. The diff a person reads is this one. */
  headSha: string | null;
  /**
   * What the run is *asking* about, for the controls that are bound to a
   * commit. Not `headSha`: a branch repaired and re-offered moves this and
   * leaves that where it was, and sending the wrong one is an Approve that
   * refuses what `lingtai approve` accepts (#92).
   */
  awaitingSha: string | null;
  /**
   * Counts, not verdicts, and only from the run this card names — the verdicts
   * themselves are on the task's own page. Waived and approved are separate
   * from passed because they are a person's word standing in for a gate's, and
   * folding them together made an override read as a green build (#78).
   */
  gatesPassed: number;
  gatesFailed: number;
  gatesWaived: number;
  gatesApproved: number;
  turns: number | null;
  costUsd: number | null;
  /** One line: what it is waiting on, or why it stopped, or what it merged as. */
  note: string | null;
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
  updatedAt: string | null;
  /** Attempts so far, so a card that keeps failing reads as one. */
  attempts: number;
  /**
   * Whether a person is holding a question at all. The waiting lane also holds
   * a refused dispatch and a run that asked something mid-flight, and neither
   * is an item anybody can hand back.
   */
  blocked: boolean;
  /**
   * Which kind of hold this is — `judgement` when the decision is a person's,
   * `acknowledgement` when something failed and nobody has decided what to do.
   *
   * Null on every block written before #83, and the card renders one of those
   * exactly as it did then: the question, and the move it actually has.
   */
  needs: "judgement" | "acknowledgement" | null;
  /**
   * What happened, what was done about it, and what is recommended.
   *
   * The card's own sentence used to be whatever string a conductor put in
   * `question`, which on a conflict was a git error with a colon in it — an
   * operator being asked to diagnose, in a UI with no diagnosis in it (#83).
   * Null when nobody has written one, which is most blocks.
   */
  diagnosis: BlockDiagnosis | null;
  /**
   * What diagnosis has cost, separately from the work. Null on the cards that
   * have never bought one, which is nearly all of them.
   */
  repairCostUsd: number | null;
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
  runnableAt: string | null;
  /**
   * Where the run is *now*: the phase, its elapsed, and all five points.
   *
   * Only on a running card, and null everywhere else. A card in any other lane
   * is describing something that is over, and the accumulated numbers beside it
   * are the whole truth about it; this is the one lane where they are not
   * (#79). Folded from the run's own stream rather than held in `task_view` —
   * see `progress.ts` for why that does not make the list expensive.
   */
  progress: RunProgress | null;
}

/**
 * Whether a project repairs, as the board says so.
 *
 * On the bar rather than on a card, because it is a fact about the repository
 * and not about any one ticket — and shown whether it is on or off, the way an
 * unconfigured gate point is shown as `skipped` rather than omitted (0025 §2).
 * A default that is invisible when it is off is a default nobody can audit.
 */
export interface RepairPolicyView {
  project: string;
  on: boolean;
  maxAttempts: number;
}

export interface Board {
  columns: BoardColumn[];
  /** One per project whose recipe could be read. */
  repair: RepairPolicyView[];
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
  queueOrder: string[];
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
  projects: string[];
}

/**
 * A project whose queue could not be listed, and why.
 *
 * Its own shape rather than a card, because it is not work: it is the absence
 * of an answer about work, and rendering it as a card would put a fake ticket
 * on a board whose whole claim is that every card is real.
 */
export interface QueueProblem {
  project: string;
  reason: string;
}

export interface BoardColumn {
  id: ColumnId;
  label: string;
  cards: BoardCard[];
  /**
   * Only ever on Queued, and only when something went wrong.
   *
   * **"Nothing is runnable" and "the queue could not be listed" are different
   * facts and used to render identically** — as an empty column (#76). A recipe
   * that would not parse, a recipe that was missing and an App that was
   * misconfigured all arrived at the same empty catch here, whose comment
   * assumed the one failure it named.
   */
  problems?: QueueProblem[];
}

/**
 * How many landed items stay open before the rest fold away.
 *
 * Landed is the lane that needs the least attention and it was the heaviest
 * thing on the page: six full cards of finished work against one waiting card
 * that took about a twelfth of the ink (#81), on a board whose own design note
 * says `waiting` "is the lane the board exists for" (0016 §8). The most recent
 * few answer *did the last thing work*; everything under them is a record, and
 * a record is something you open rather than something you scan.
 */
export const LANDED_OPEN = 3;

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  // Its own column rather than a label, because it is where the queue actually
  // stalls: 45 items and growing against zero processed.
  { id: "waiting", label: "Waiting on you" },
  { id: "landed", label: "Landed" },
];

/**
 * What an empty column says.
 *
 * "Nothing here yet" under Running is false in the way that matters while the
 * conductor is paused (#77): there is plenty to run, and the reason none of it
 * is running is a decision somebody made and the log remembers. The empty
 * column is where a person looks when a lane is bare, so it is the one place
 * that has to know.
 *
 * **Under a filter it says whose emptiness it is.** "Nothing here yet" is a
 * claim about the log, and with one project selected the log may be full of
 * another project's work: the lane is bare because of a choice the reader made,
 * and saying so is the difference between a filter that is working and a board
 * that has nothing on it (#86). The pause is not narrowed — `ctl-` is one
 * stream for the whole installation — so that sentence is the filter's to leave
 * alone.
 */
export function emptyNote(column: ColumnId, paused: boolean, project?: string): string {
  if (column === "running" && paused) return "Paused — nothing will start.";
  if (column === "waiting") {
    return project === undefined
      ? "Nothing is waiting on you."
      : `Nothing in ${project} is waiting on you.`;
  }
  return project === undefined ? "Nothing here yet." : `Nothing here for ${project}.`;
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
  queued: "queued",
  running: "running",
  // `gates` is a task state and no longer a lane; it belongs with `running`.
  gates: "running",
  waiting: "waiting",
  landed: "landed",
};

/**
 * `runnableAt`, `progress` and `kindColor` are passed in rather than computed:
 * one needs the project's `source.backoff`, one the run's own stream and one
 * the repository's labels, and all three are a call away — this function is
 * the pure part.
 */
export function toCard(
  t: TaskCard,
  runnableAt: Date | null = null,
  progress: RunProgress | null = null,
  kindColor: string | null = null,
): BoardCard {
  return {
    taskId: t.taskId,
    project: t.project,
    column: COLUMN_OF[t.state],
    ref: t.issue,
    kind: t.kind,
    kindColor,
    title: t.title,
    tier: t.tier,
    headSha: t.headSha,
    awaitingSha: t.awaitingSha,
    gatesPassed: t.gatesPassed,
    gatesFailed: t.gatesFailed,
    gatesWaived: t.gatesWaived,
    gatesApproved: t.gatesApproved,
    turns: t.turns,
    costUsd: t.costUsd,
    note: t.note,
    updatedAt: t.updatedAt.toISOString(),
    attempts: t.attempts,
    blocked: t.blocked,
    needs: t.needs,
    diagnosis: t.diagnosis,
    repairCostUsd: t.repairCostUsd,
    runnableAt: runnableAt === null ? null : runnableAt.toISOString(),
    progress,
  };
}

/**
 * The Queued column: what GitHub is offering that the log has not taken, and
 * what could not be asked.
 *
 * Still per project — a repository whose token expired costs you its queue and
 * not the whole board — but no longer *silent*. This used to end in an empty
 * catch whose comment named one failure ("a project whose GitHub is
 * unreachable") and swallowed four: that, a recipe that will not parse, a
 * recipe that is missing, and an App that is misconfigured. All of them
 * rendered as an empty Queued column, which is also what a repository with
 * nothing to do renders as (#76). The operator's report was "I still don't know
 * why the issues weren't picked up."
 *
 * `projectFilter` is the shared answer: resolved, or refused with the reason,
 * in the same wording `lingtai daemon` and `lingtai status` use.
 *
 * Takes the projects rather than loading them. It used to load them and apply
 * the filter itself, which put the only unfiltered list of projects behind the
 * filter — and left the bar naming what it was showing instead of what it could
 * show (#86).
 */
async function queuedCards(projects: readonly ProjectState[]): Promise<{
  cards: BoardCard[];
  problems: QueueProblem[];
  repair: RepairPolicyView[];
  /** `source.backoff` per project, for the held cards `loadBoard` folds from the log. */
  backoffMs: Map<string, number>;
  /**
   * The recipe's gates per project, for the running cards `loadBoard` folds.
   * Gathered here for the reason `backoffMs` is: this loop already resolved
   * every recipe, and reading one twice is how a render gets expensive.
   */
  plans: Map<string, GatePlan>;
  /**
   * What each project's repository calls each kind's colour, keyed by project
   * and then by kind. Off the issues `runnableNow` has already read, for the
   * reason above: it is a fact that arrived with an answer this loop needed
   * anyway, so carrying it costs no request.
   */
  kindColors: Map<string, Record<string, string>>;
  /** The kinds each project prioritises, in order, for the Queued grouping. */
  kindOrder: string[];
}> {
  const cards: BoardCard[] = [];
  const problems: QueueProblem[] = [];
  // Gathered here rather than by a second pass over the projects: this loop
  // already resolves every recipe, and asking GitHub twice for a fact that
  // arrived with the first answer is how a render gets expensive.
  const repair: RepairPolicyView[] = [];
  const backoffMs = new Map<string, number>();
  const plans = new Map<string, GatePlan>();
  const kindColors = new Map<string, Record<string, string>>();
  // First mention wins, so two projects that order their kinds differently give
  // one column one order rather than an order that changes as rows arrive.
  const kindOrder: string[] = [];
  for (const p of projects) {
    const filter = await projectFilter(p);
    if (!filter.ok) {
      problems.push({ project: filter.project, reason: filter.problem });
      continue;
    }
    repair.push({
      project: filter.project,
      on: filter.repair.on,
      maxAttempts: filter.repair.maxAttempts,
    });
    backoffMs.set(filter.project, filter.backoffMs);
    plans.set(filter.project, filter.plan);
    for (const kind of filter.kinds) if (!kindOrder.includes(kind)) kindOrder.push(kind);
    try {
      const offered = await runnableNow({ client: filter.client, recipe: filter.recipe });
      // What the repository says each of its kinds looks like. A project whose
      // queue could not be listed contributes none, and its cards render the
      // way every card did before #85 — the failure costs a dot, not a card.
      kindColors.set(filter.project, offered.kindColors);
      const runnable = await selectRunnable({
        project: filter.project,
        offered: offered.runnable,
        kinds: filter.kinds,
        backoffMs: filter.backoffMs,
      });
      for (const r of runnable) {
        cards.push({
          taskId: r.taskId,
          project: filter.project,
          column: "queued",
          ref: r.issue,
          kind: r.kind,
          kindColor: offered.kindColors[r.kind] ?? null,
          title: r.title,
          // The column default the deleted cache also relied on. Which tier it
          // will actually run at is decided when it runs, not now.
          tier: "guarded",
          headSha: null,
          awaitingSha: null,
          gatesPassed: 0,
          gatesFailed: 0,
          gatesWaived: 0,
          gatesApproved: 0,
          turns: null,
          costUsd: null,
          note: null,
          attempts: 0,
          blocked: false,
          // Nothing has run, so nothing is held and nothing has been diagnosed.
          needs: null,
          diagnosis: null,
          repairCostUsd: null,
          // Nothing in the log has touched this one, so there is no time to
          // show. See the field: the render clock is not an answer.
          updatedAt: null,
          // These are the ones `selectRunnable` just said *are* runnable.
          runnableAt: null,
          // Nothing has run, so there is nothing to be part-way through.
          progress: null,
        });
      }
    } catch (err) {
      // The recipe resolved and GitHub still would not answer — a rate limit, a
      // revoked installation. Named rather than dropped, for the same reason.
      problems.push({ project: filter.project, reason: (err as Error).message });
    }
  }
  return { cards, problems, repair, backoffMs, plans, kindColors, kindOrder };
}

/**
 * Where each running card's run has got to, keyed by task id.
 *
 * Only the Running lane, and only the cards that name a run. Every other lane
 * is describing something that is over, and the numbers `task_view` already
 * carries are the whole truth about it — this is the one lane where "what it
 * accumulated" is not the answer to "what is it doing" (#79).
 *
 * A stream that will not read costs that card its detail and nothing else. The
 * card is still on the board with its counts, which is what it had before.
 */
async function runningProgress(
  tasks: readonly TaskCard[],
  plans: ReadonlyMap<string, GatePlan>,
): Promise<Map<string, RunProgress>> {
  const live = tasks.filter((t) => COLUMN_OF[t.state] === "running" && t.runId !== null);
  const folded = await Promise.all(
    live.map(async (t) => {
      try {
        const events = await eventStore.read(t.runId as string);
        return [t.taskId, foldProgress(events, plans.get(t.project))] as const;
      } catch {
        return [t.taskId, null] as const;
      }
    }),
  );
  return new Map(folded.filter((e): e is readonly [string, RunProgress] => e[1] !== null));
}

/**
 * Reads `task_view` into columns, and asks GitHub for the queue.
 *
 * An unbuilt projection is reported as empty rather than as a crash: it is a
 * state the system can be in, and it is the state it is in before the first
 * run. Showing fictional work would be worse than showing none.
 */
export async function loadBoard(project?: string): Promise<Board> {
  let tasks: TaskCard[] = [];
  try {
    tasks = await readTasks(project === undefined ? {} : { project });
  } catch (err) {
    // `relation "task_view" does not exist` — nothing has run the projection.
    if (!/does not exist/i.test((err as Error).message)) throw err;
  }

  // Loaded once, here, and read twice: every registered project names a filter
  // the bar can offer, and only the ones the filter admits are asked for their
  // queue.
  const registered = await loadProjects().catch(() => []);
  const names = registered.map((p) => p.project).filter((p): p is string => p !== null);

  // Before the fold, because the fold needs what it learned: a card the backoff
  // is holding is a card the log wrote, and how long it is held for is in the
  // recipe this just read (0028).
  const queued = await queuedCards(
    registered.filter((p) => project === undefined || p.project === project),
  );
  // After the recipes too, and for the same reason: a gate's timeout is the
  // denominator a running card measures against, and it is in the recipe this
  // just read.
  const progress = await runningProgress(tasks, queued.plans);
  const now = Date.now();
  const fromLog = tasks.map((t) =>
    toCard(
      t,
      t.state === "queued" ? heldUntil(t, queued.backoffMs.get(t.project) ?? 0, now) : null,
      progress.get(t.taskId) ?? null,
      // By kind and by project, because a label's colour is the repository's:
      // two projects can both have a `bug` and colour it differently, and the
      // cards say which repository they are from for the same reason.
      queued.kindColors.get(t.project)?.[t.kind] ?? null,
    ),
  );
  // A task released back to the queue has a row *and* is offered by GitHub, so
  // it would otherwise appear twice. The row wins: it carries the attempts.
  const known = new Set(fromLog.map((c) => c.taskId));
  const cards = [...fromLog, ...queued.cards.filter((c) => !known.has(c.taskId))];

  return {
    columns: toColumns(cards, queued.problems),
    repair: queued.repair,
    queueOrder: queued.kindOrder,
    // Unfiltered, deliberately. This is the list the filter is chosen *from*,
    // so narrowing it to the current choice would remove every way back to the
    // rest — including "all".
    projects: filterOptions(names, await onBoardProjects()),
  };
}

/**
 * Which projects the log has cards from, or none when there is no projection.
 *
 * The same `does not exist` `loadBoard` reads as an empty board: before the
 * first run there is no table, and that is a state rather than a fault.
 */
async function onBoardProjects(): Promise<string[]> {
  try {
    return await readTaskProjects();
  } catch (err) {
    if (!/does not exist/i.test((err as Error).message)) throw err;
    return [];
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
export function filterOptions(
  registered: readonly string[],
  onBoard: readonly string[],
): string[] {
  const all = [...registered];
  for (const project of onBoard) if (!all.includes(project)) all.push(project);
  return all;
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
 * rather than a fold of the log, and therefore the one that can fail to be
 * answered.
 */
export function toColumns(cards: BoardCard[], problems: QueueProblem[] = []): BoardColumn[] {
  return COLUMNS.map((c) => {
    const mine = cards.filter((card) => card.column === c.id);
    return {
      ...c,
      // Landed only. `readTasks` orders the other lanes deliberately — waiting
      // by how long it has waited, the rest by ticket number — and none of that
      // is this function's to undo. Landed is the one lane whose question is
      // *what just happened*, and it is also the one that folds away past the
      // most recent few (#81): "the most recent" is only a sentence the order
      // can make true.
      cards: c.id === "landed" ? mine.sort(newestFirst) : mine,
      ...(c.id === "queued" && problems.length > 0 ? { problems } : {}),
    };
  });
}

/**
 * One kind's worth of the Queued column, and whether it is the group the next
 * claim comes out of.
 */
export interface QueueGroup {
  kind: string;
  cards: BoardCard[];
  /**
   * Whether the conductor's next claim comes from here.
   *
   * The first group in priority order that holds a card nothing is holding
   * back — not simply the first group. A kind whose only queued items are
   * backing off is not the kind that gets taken next, and saying it was would
   * be the same lie #95 removed from the cards themselves: a held item looks
   * exactly like one nobody has got to yet, and the difference is the whole
   * point of showing it.
   *
   * It says nothing about *when*. A paused conductor takes nothing at all, and
   * the bar says so (#77).
   */
  next: boolean;
}

/**
 * The Queued column, grouped by kind in the order the recipe prioritises them.
 *
 * **In Queued, order beats colour.** `source.kinds` is the priority order —
 * earlier wins — so within this column the kind *is* the position, and a
 * grouping says what a hue cannot: which work gets taken next. Nothing here is
 * a new rule; it is `selectRunnable`'s own sort, rendered. The kinds come from
 * the recipes (`Board.queueOrder`) rather than from the cards, so a kind with
 * nothing queued does not silently reorder the ones that have.
 *
 * A kind the order does not name goes after the ones it does, in the order the
 * cards arrived. That is a real case rather than a defensive one: a recipe that
 * drops a kind leaves the items already claimed under it in the log, and they
 * return to the queue named by a label the recipe no longer prioritises.
 *
 * Within a group, by issue number — `selectRunnable`'s own tiebreak, so the
 * card at the top of a group is the one that would actually be claimed first.
 */
export function groupQueue(
  cards: readonly BoardCard[],
  order: readonly string[],
): QueueGroup[] {
  const byKind = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const group = byKind.get(card.kind);
    if (group) group.push(card);
    else byKind.set(card.kind, [card]);
  }

  const named = order.filter((kind) => byKind.has(kind));
  const rest = [...byKind.keys()].filter((kind) => !order.includes(kind));

  const groups = [...named, ...rest].map((kind) => ({
    kind,
    cards: [...(byKind.get(kind) ?? [])].sort(byIssueNumber),
    next: false,
  }));

  const takenNext = groups.find((g) => g.cards.some((c) => c.runnableAt === null));
  if (takenNext) takenNext.next = true;
  return groups;
}

/**
 * Numerically, not lexically: #402 comes before #409 and both before #4100 —
 * `selectRunnable` says the same thing about the same refs, and the column is
 * only readable as a priority if the two agree.
 */
function byIssueNumber(a: BoardCard, b: BoardCard): number {
  const n = (c: BoardCard) => (Number.isFinite(Number(c.ref)) ? Number(c.ref) : Number.MAX_SAFE_INTEGER);
  return n(a) - n(b);
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
  const when = (c: BoardCard) => (c.updatedAt === null ? 0 : Date.parse(c.updatedAt));
  return when(b) - when(a);
}

/**
 * What the board in front of you has cost.
 *
 * The cards on the screen and nothing else — not a window over the log, not the
 * project's lifetime. Every card has carried its own dollars since 0012 and
 * nobody ever added them up (#81), so the one number an operator acts on was on
 * the page eleven times and stated once, never.
 *
 * Repair is a second number for the reason the card keeps it as one: it is
 * default-on and spends an agent without being asked again, and folding it into
 * the figure beside it makes it an invisible bill (#84).
 */
export interface Spend {
  /** What the work itself cost, over every card on the board. */
  work: number;
  /** What diagnosing it cost, over the same cards. */
  repair: number;
  /** How many cards that is, so the total can say what it totals. */
  cards: number;
}

export function spend(columns: readonly BoardColumn[]): Spend {
  const cards = columns.flatMap((c) => c.cards);
  return {
    work: cards.reduce((n, c) => n + (c.costUsd ?? 0), 0),
    repair: cards.reduce((n, c) => n + (c.repairCostUsd ?? 0), 0),
    cards: cards.length,
  };
}

/**
 * Where a ticket lives on GitHub, or null when the project predates `owner`
 * being recorded.
 *
 * Built rather than asked for: it needs no answer from GitHub, so a card can
 * carry it without the board spending a request per card per render. The card's
 * title goes to the task page and its reference comes here — two destinations,
 * because *what Lingtai did* and *what was asked, and what people said about
 * it* are different questions and the second one had no link at all (#81).
 */
export function issueUrl(owner: string | null, project: string, ref: string): string | null {
  if (owner === null) return null;
  return `https://github.com/${owner}/${project}/issues/${encodeURIComponent(ref)}`;
}
