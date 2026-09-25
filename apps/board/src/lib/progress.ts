/**
 * Where a run has got to *now*, folded from its own stream.
 *
 * The card described what a run had accumulated and never where it was: at
 * 17:23 one read `1 passed · attempt 2` while the truth was "the agent finished
 * three minutes ago; the build gate is 2m34s into a 20m budget" (#79). The run
 * that is over and that nobody will act on was described more fully than the one
 * burning money.
 *
 * **Nothing new is written down for this.** `RunStarted` opens the agent phase
 * and `RunFinished` closes it, `GatesResolved` names all ten steps, and the
 * last `GateStarted` with no matching verdict is the step the run is at. The
 * recipe's timeout is the denominator, and it arrives already parsed as
 * `GatePlan` so that the board has no opinion about what `20m` is.
 *
 * **Why this is a second read, when `task_view` is the one projection.** 0012's
 * rule is that a *list* is cheap, and this does not make it less so: what a
 * fold wants is the thing that changes every second, which is the worst
 * possible shape for a table. It is the same trade the Queued column already
 * makes by asking GitHub on render, and the same one the task page makes by
 * folding a detail on demand. A phase that fails to be read costs its own card
 * its detail and not the board.
 *
 * **What keeps it cheap is a bound, and the bound is not in this file.** Three
 * lanes fold since #170 — Running, Waiting and the Landed rows the lane draws
 * open — and only the first of them is small by nature, at a card per
 * conductor. The other two are cut to `WAITING_RAILS` and `LANDED_OPEN` by
 * `board.ts`'s `railCandidates`, which is pure and tested for exactly that. So
 * the question to ask of a fourth lane is not *is it small* — Waiting was
 * argued that way and the `COLUMNS` entry beside it says 45 items — but *what
 * cuts it*, and the answer has to be a number in `railCandidates`.
 */
import { STEPS, type Envelope, type Step } from "@lingtai/domain";
import type { StepPlan } from "@lingtai/conductor/filter";

/**
 * What a point has come to on *this* run.
 *
 * `skipped` is a state and not an absence (ADR 0016 §4): a step nobody
 * configured does not run, which is the user's decision, and a step that was
 * configured and did not run is Lingtai's bug. Only showing all ten keeps them
 * apart. `pending` is the honest third thing — configured, not reached yet.
 *
 * **Six of the ten are `skipped` on every run today**, because nothing
 * constructs a pipeline at `claim`, `admit`, `design`, `implement`, `build` or
 * `review` (0058 §3 names them; its own plan builds them). That is the state
 * reading correctly rather than a gap: the recipe configures nothing there, so
 * nothing ran there, so `skipped` is what the fold owes a reader.
 */
export type StepState =
  | "skipped"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  /**
   * **Nothing judged this diff here**, which this fold now reaches two ways.
   * One state, because it is one sentence to a reader and one bug to an
   * operator — but the two differ in what there is to read, so a consumer that
   * wants the account has to know which it has.
   *
   * The point was reached and its agent never started, so it judged nothing:
   * `GateNeverRan`, and the evidence is on that event (#133). Or the plan the
   * log recorded named actions here, the run recorded *none* of them, and the
   * item landed — `stateOf`'s rule since #170, which is `lingtai doctor`'s
   * `landedWithoutSteps` comparison. There is no gate event at this point
   * at all in the second, so there is nothing to read evidence off: anything
   * reaching for one must find the `GateNeverRan` and cope with its absence,
   * the way `task.ts`'s `never` line does.
   *
   * Not `failed` — a refusal is a sentence about the diff — and not `running`,
   * which is what a point with no verdict line used to read as.
   */
  | "never-ran"
  /**
   * **Nothing judged this diff here either, and for a reason that is ours and
   * not the account's** ([0057](../../../../doc/decisions/0057-a-gate-that-did-not-finish.md)).
   *
   * The point was reached, its agent started, and it ended with no receipt —
   * a crash, a timeout, a turn budget spent. The pass stopped there and the item
   * is a person's; it is run once, 0057 §4's retry having been deleted (`#234`).
   *
   * Beside `never-ran` rather than inside it: they read alike on a rail and
   * they are opposite facts to an operator, because one says *the account is
   * walled* and this one says *this machine, this action*. Not `failed`, for
   * the reason `never-ran` is not: a refusal is a sentence about the diff.
   */
  | "did-not-finish"
  | "waived";

/**
 * One action's own verdict, so a point holding more than one can be drawn as
 * the sequence it is.
 *
 * `proposed` holds `build` and `review`, and a single fill over the pair says
 * *half of this point* with no way to tell which half. This is what let the
 * card's `N passed` counter go: a count of actions and a position in a sequence
 * were the same fact at two granularities, and only one of them has a shape.
 */
export interface ActionProgress {
  name: string;
  state: StepState;
}

export interface StepProgress {
  step: Step;
  /** What the recipe put here. Empty is what makes the point `skipped`. */
  planned: readonly string[];
  state: StepState;
  /**
   * The planned actions in recipe order, each with its own verdict, followed by
   * anything the log recorded here that the plan did not name — an approval at
   * a point the recipe leaves empty is the ordinary case of that.
   *
   * Empty only where the point is: a `skipped` point has no cells to draw.
   */
  actions: readonly ActionProgress[];
}

/**
 * The one thing the run is doing, and what bounds it.
 *
 * `budgetMs` is null where nothing bounds it — an approval waiting on a person,
 * a reviewer, a runtime too old to have recorded its limits. Null renders as no
 * denominator rather than as zero: *slow* and *about to be killed* are the two
 * this is meant to separate, and inventing a ceiling would answer both wrongly.
 */
export interface Phase {
  /**
   * `proposed:build` — the point and the action, as the log keys them — or a
   * phase that is not a gate at all: `agent`, and `fixing round 2 of 3`.
   *
   * **Not every label is `point:action`**, which is what `pointOf` is for. A
   * reader that splits on the colon and believes the head is a point will
   * print `2 of 3` for the third of those.
   */
  label: string;
  /** When this phase began, ISO. */
  since: string;
  budgetMs: number | null;
}

export interface RunProgress {
  /**
   * When the run's first event landed, ISO — the prepare gates, which run
   * before the agent starts. This is the elapsed the card shows, and it is the
   * whole run rather than the phase.
   */
  since: string;
  /** Null between phases: the agent has finished and no gate has started yet. */
  now: Phase | null;
  /** All ten, in pass order. */
  steps: readonly StepProgress[];
}

/** The label the agent phase carries. Not a gate point, and not spelled like one. */
export const AGENT = "agent";

/**
 * The word a bought round wears, and the word `task_view`'s note opens with —
 * `fixing round 2 of 3` there, and here, so the card and the note agree about
 * what the pass is doing (`task-view.ts:559`).
 */
const FIXING = "fixing";

/**
 * The point a phase is at, or null where the phase names no point.
 *
 * **Asked rather than assumed**, because the labels are not all
 * `point:action`: `agent` is one word and a round is a sentence. A caller that
 * splits on the colon and trusts the head highlights nothing and prints
 * `2 of 3`, which is how a fixing agent came to be described as a point.
 */
export function stepOf(label: string): Step | null {
  const head = label.split(":")[0] ?? "";
  return (STEPS as readonly string[]).includes(head) ? (head as Step) : null;
}

/**
 * A stopwatch: `41s`, `2m34s`, `1h07m`.
 *
 * Not `inWords`, which answers *when* a countdown ends in the units a recipe
 * writes. "Under a minute" is the right answer about a backoff and the wrong
 * one about a gate two minutes into twenty, where the seconds are the only
 * thing moving. The denominator beside it is still `inWords`, because that
 * number *is* the recipe's word.
 */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `point:action`, the key both the log and `task_view` use for a verdict. */
function keyOf(data: Record<string, unknown>): string {
  return `${String(data["gate"])}:${String(data["action"])}`;
}

function budgetOf(plan: StepPlan, data: Record<string, unknown>): number | null {
  const step = plan.get(String(data["gate"]) as Step);
  return step?.find((a) => a.name === String(data["action"]))?.budgetMs ?? null;
}

/**
 * One point's state, from what the plan said and what the log reports.
 *
 * Ordered worst-first, the way the card's stripe is: a failure is the answer
 * even when something after it also ran, and a point still running outranks the
 * ones that have already passed.
 */
function stateOf(
  step: Step,
  planned: readonly string[],
  seen: readonly StepState[],
  /**
   * The item landed, **and** `GatesResolved` is what named `planned`.
   *
   * Both halves, because both are `landedWithoutSteps`'s, and the check
   * below is meant to be its comparison and not a looser one. Its `planned` CTE
   * selects from `GatesResolved` rows, so a run whose stream has none
   * contributes nothing to it — and here such a run is folded against the
   * recipe being read *now*, which may not be the one it got. Calling a point
   * that recipe configures `never-ran` would invent Lingtai's bug out of a
   * recipe the run never saw.
   */
  onRecord: boolean,
): StepState {
  if (planned.length === 0 && seen.length === 0) return "skipped";
  // Above `failed`, because it is always the ending: the pipeline and the pass
  // both stop there (0041 §4), so a `failed` beside it on the same point is a
  // refusal from an earlier round, about a commit that is no longer the head.
  if (seen.includes("never-ran")) return "never-ran";
  // Above `failed` for the same reason and with the same ordering argument: the
  // pipeline and the pass both stop here (0057 §4), so a `failed` beside it on
  // the same point came from an earlier round and a commit that has moved.
  if (seen.includes("did-not-finish")) return "did-not-finish";
  // **`lingtai doctor`'s comparison, made where a person is already looking.**
  // The log's own plan named actions here, the run recorded nothing at all — no
  // request, no verdict, no approval, no waiver — and the item landed, so there
  // was no later moment for it to run in. `landedWithoutSteps` asks exactly
  // this and fails the doctor for it; until now it reached the board as
  // `pending`, which is the word for *configured, not reached yet* and is the
  // one thing this is not (0016 §4).
  //
  // `onRecord` is why this is safe, and it is narrow on purpose — see its own
  // doc. A run still in flight legitimately has points it has not got to, and a
  // refusal stops the pipeline where it stands, so anything looser than *this
  // landed, against the plan this run was given* puts the fail colour on a
  // pipeline that was working.
  //
  // **Every step but `end`**, which is the same exclusion `landedWithoutSteps`
  // makes in as many words: `end`'s record is `EndActionsResolved` on the *work
  // item's* stream (`end-step.ts`), and this fold reads the run's. A silent
  // `end` here is a question this stream cannot answer, not a step that did not
  // run — `lingtai doctor` has its own check for that one, against the stream
  // that holds it.
  //
  // It read *four and not five* until the vocabulary widened, and the exclusion
  // is still exactly one name. The six steps nothing constructs a pipeline for
  // are reached by the line above rather than by this one: their `planned` is
  // empty, so they are `skipped` before this rule is asked — which is the same
  // guard `landedWithoutSteps` has in SQL (`jsonb_array_length(...) > 0`).
  if (onRecord && step !== "end" && seen.length === 0) return "never-ran";
  if (seen.includes("failed")) return "failed";
  if (seen.includes("running")) return "running";
  const settled = seen.filter((s) => s === "passed" || s === "waived");
  // Fewer verdicts than actions means the point is part-way through, which is
  // not the same as done — the pipeline stops at the first refusal, so a point
  // can also end here having never reached its later actions.
  if (settled.length < planned.length || settled.length === 0) return "pending";
  return seen.includes("waived") ? "waived" : "passed";
}

/**
 * The fold. Events in seq order, as the store returns them.
 *
 * Returns null for a stream with nothing on it — a run whose first event has
 * not landed has no progress to describe, and a card saying `0s` about one
 * would be inventing a start.
 */
export function foldProgress(
  events: readonly Envelope[],
  plan: StepPlan = new Map(),
  /**
   * Whether this item **landed**. Not whether it is over.
   *
   * It cannot be read off the run's own stream: the merge lane appends
   * `IntegrationSucceeded` to its own stream and `WorkItemLanded` goes on the
   * work item's, so the caller is the only one holding the fact. Passing it is
   * what turns *a point that recorded nothing* from `pending` into `never-ran`,
   * and it is the whole of the difference between the two.
   *
   * A **closed** item is not this, however finished it is: the pipeline stops
   * at the first refusal (0041 §4), so its later points recorded nothing
   * because nothing should have run in them. `landedWithoutSteps` is
   * anchored on `WorkItemLanded` for that reason and so is this — see
   * `RailCandidate.over`, which is the caller holding the same line.
   */
  over = false,
): RunProgress | null {
  const first = events[0];
  if (!first) return null;

  /** `point:action` → where that action got to. */
  const verdicts = new Map<string, StepState>();
  let now: Phase | null = null;
  /** The plan as the log recorded it, once `GatesResolved` has landed. */
  let resolved: Map<string, readonly string[]> | null = null;
  /**
   * The wall clock this run's agents are launched under, as `RunStarted`
   * recorded it applied.
   *
   * Kept because a round's own event does not carry it and the fixer is
   * launched under the same `runtime.limits.wall` the implementer was — one
   * recipe, read once, inside one pass (`run-once.ts:1088`, `:1697`). Null for
   * a v1 `RunStarted`, and null renders as no denominator.
   */
  let wallMs: number | null = null;
  /** The round in flight, if the pass bought one and it has not come back. */
  let fixing: string | null = null;

  const close = (data: Record<string, unknown>, state: StepState) => {
    const key = keyOf(data);
    verdicts.set(key, state);
    // Only the phase this verdict is about. A verdict for something else means
    // the log is out of order, and clearing on it would blank a live gate.
    if (now?.label === key) now = null;
  };

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "RunStarted": {
        // The wall clock as *applied*, which is what the run will actually be
        // killed at. Null for a v1 `RunStarted`, which recorded no limits (#88).
        const limits = (data["invocation"] as { limits?: { wallMs?: number } } | null)?.limits;
        wallMs = limits?.wallMs ?? null;
        now = { label: AGENT, since: event.at.toISOString(), budgetMs: wallMs };
        break;
      }

      /**
       * **A bought round is an agent running inside the pass**, and it is the
       * ordinary path here — `.lingtai/config.yaml`'s `rounds: 3`.
       *
       * It appends `FixRequested`, runs a fixing agent against the findings,
       * and appends `FixApplied` when that agent is done (`run-once.ts:1631`,
       * `:1721`). No `RunStarted` between them, because a round is a step
       * inside a run and not a run of its own — so without this the fold had
       * nothing in flight for the whole of that agent's run, and a card
       * spending money to answer a refusal said the refusal was what the pass
       * came to and that a person was being waited on. `task_view` has said
       * `running` on this event since the day it was added (`task-view.ts:554`).
       */
      case "FixRequested": {
        // `of` is zero on every event written before the field existed, and the
        // reading of zero is *not recorded* — the same reading, and the same
        // sentence, as the note `task_view` writes from it.
        const of = Number(data["of"] ?? 0);
        fixing = `${FIXING} round ${String(data["round"])}${of > 0 ? ` of ${of}` : ""}`;
        now = { label: fixing, since: event.at.toISOString(), budgetMs: wallMs };
        break;
      }

      case "FixApplied":
        // Guarded on the label for the reason `RunFinished` is: only the phase
        // this event is about. What follows is the point being asked again, or
        // the refusal standing — both announce themselves.
        if (fixing !== null && now?.label === fixing) now = null;
        break;

      case "RunFinished":
      case "RunFailed":
        // The agent phase is over; the next one announces itself. Guarded on the
        // label because a `proposed` gate can outlive the event that ended the
        // agent, and clearing unconditionally would lose it.
        if (now?.label === AGENT) now = null;
        break;

      case "GatesResolved": {
        const steps = (data["points"] ?? []) as { gate: string; actions: string[] }[];
        resolved = new Map(steps.map((p) => [p.gate, p.actions]));
        break;
      }

      case "GateRequested": {
        const key = keyOf(data);
        // Never over a verdict: requested and started are appended back to back,
        // and a re-request after a force-push carries its own start.
        if (!verdicts.has(key)) verdicts.set(key, "pending");
        break;
      }

      case "GateStarted": {
        const key = keyOf(data);
        verdicts.set(key, "running");
        now = { label: key, since: event.at.toISOString(), budgetMs: budgetOf(plan, data) };
        break;
      }

      case "GatePassed":
        close(data, "passed");
        break;

      case "GateFailed":
        close(data, "failed");
        break;

      case "GateNeverRan":
        close(data, "never-ran");
        break;

      case "GateDidNotFinish":
        // One of these per action, because the action is run once (`#234`). A
        // point that ends here is one whose last word was this, which is what
        // the pass stopped on.
        close(data, "did-not-finish");
        break;

      case "GateWaived":
        close(data, "waived");
        break;

      case "ApprovalRequested":
        // A person is what this is waiting on, and a person has no timeout. The
        // phase is still named, because "waiting, on the merge point" is the
        // answer somebody opened the card for.
        verdicts.set(keyOf(data), "pending");
        now = { label: keyOf(data), since: event.at.toISOString(), budgetMs: null };
        break;

      case "ApprovalGranted":
        close(data, "passed");
        break;

      case "ApprovalRevoked":
        verdicts.set(keyOf(data), "pending");
        break;

      default:
        break;
    }
  }

  const steps = STEPS.map((step) => {
    // The log first, the recipe second. `GatesResolved` is appended after the
    // `prepared` gates have already run, so for the first seconds of a run it
    // is the only thing that can say a point exists — and once it lands it is
    // the record, because a recipe read now may not be the one this run got.
    const recorded = resolved?.get(step);
    const planned = recorded ?? (plan.get(step) ?? []).map((a) => a.name);
    const mine = [...verdicts]
      .filter(([k]) => k.startsWith(`${step}:`))
      .map(([k, v]) => [k.slice(step.length + 1), v] as const);
    const state = stateOf(
      step,
      planned,
      mine.map(([, v]) => v),
      // Landed, *and* against the plan the log says this run was given. A
      // stream with no `GatesResolved` — one that died before it landed, one
      // predating the event — falls back to today's recipe above, and today's
      // recipe cannot accuse a run of skipping a point it was never given.
      over && recorded !== undefined,
    );
    const byAction = new Map(mine);
    // The plan's order first, because that is the order they run in; then
    // anything the log has that the plan does not name. An approval at a point
    // the recipe leaves empty is that case, and dropping it would draw a point
    // a person is being asked about as having nothing in it.
    const extra = mine.map(([name]) => name).filter((name) => !planned.includes(name));
    const actions = [...planned, ...extra].map((name) => ({
      name,
      // A point that ran nothing at all says so in every cell rather than
      // leaving them reading as *not reached yet*, which is the distinction
      // the point's own state was just made to carry.
      state: byAction.get(name) ?? (state === "never-ran" ? "never-ran" : "pending"),
    }));
    return { step, planned, state, actions };
  });

  return { since: first.at.toISOString(), now, steps };
}
