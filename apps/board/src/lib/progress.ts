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
 * and `RunFinished` closes it, `GatesResolved` names all five points, and the
 * last `GateStarted` with no matching verdict is the point the run is at. The
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
import { GATE_POINTS, type Envelope, type GatePoint } from "@lingtai/domain";
import type { GatePlan } from "@lingtai/conductor/filter";

/**
 * What a point has come to on *this* run.
 *
 * `skipped` is a state and not an absence (ADR 0016 §4): a point nobody
 * configured does not run, which is the user's decision, and a point that was
 * configured and did not run is Lingtai's bug. Only showing all five keeps them
 * apart. `pending` is the honest third thing — configured, not reached yet.
 */
export type PointState =
  | "skipped"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  /** The point was reached and its agent never started, so it judged nothing
   *  (#133). Not `failed` — a refusal is a sentence about the diff — and not
   *  `running`, which is what a point with no verdict line used to read as. */
  | "never-ran"
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
  state: PointState;
}

export interface PointProgress {
  point: GatePoint;
  /** What the recipe put here. Empty is what makes the point `skipped`. */
  planned: readonly string[];
  state: PointState;
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
  /** `agent`, or `proposed:build` — the point and the action, as the log keys them. */
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
  /** All five, in loop order. */
  points: readonly PointProgress[];
}

/** The label the agent phase carries. Not a gate point, and not spelled like one. */
export const AGENT = "agent";

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

function budgetOf(plan: GatePlan, data: Record<string, unknown>): number | null {
  const point = plan.get(String(data["gate"]) as GatePoint);
  return point?.find((a) => a.name === String(data["action"]))?.budgetMs ?? null;
}

/**
 * One point's state, from what the plan said and what the log reports.
 *
 * Ordered worst-first, the way the card's stripe is: a failure is the answer
 * even when something after it also ran, and a point still running outranks the
 * ones that have already passed.
 */
function stateOf(
  point: GatePoint,
  planned: readonly string[],
  seen: readonly PointState[],
  /**
   * The item landed, **and** `GatesResolved` is what named `planned`.
   *
   * Both halves, because both are `landedWithoutGatePoints`'s, and the check
   * below is meant to be its comparison and not a looser one. Its `planned` CTE
   * selects from `GatesResolved` rows, so a run whose stream has none
   * contributes nothing to it — and here such a run is folded against the
   * recipe being read *now*, which may not be the one it got. Calling a point
   * that recipe configures `never-ran` would invent Lingtai's bug out of a
   * recipe the run never saw.
   */
  onRecord: boolean,
): PointState {
  if (planned.length === 0 && seen.length === 0) return "skipped";
  // Above `failed`, because it is always the ending: the pipeline and the pass
  // both stop there (0041 §4), so a `failed` beside it on the same point is a
  // refusal from an earlier round, about a commit that is no longer the head.
  if (seen.includes("never-ran")) return "never-ran";
  // **`lingtai doctor`'s comparison, made where a person is already looking.**
  // The log's own plan named actions here, the run recorded nothing at all — no
  // request, no verdict, no approval, no waiver — and the item landed, so there
  // was no later moment for it to run in. `landedWithoutGatePoints` asks exactly
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
  // **Four points and not five**, which is the same exclusion
  // `landedWithoutGatePoints` makes in as many words: `end`'s record is
  // `EndActionsResolved` on the *work item's* stream (`end-point.ts`), and this
  // fold reads the run's. A silent `end` here is a question this stream cannot
  // answer, not a point that did not run — `lingtai doctor` has its own check
  // for that one, against the stream that holds it.
  if (onRecord && point !== "end" && seen.length === 0) return "never-ran";
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
  plan: GatePlan = new Map(),
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
   * because nothing should have run in them. `landedWithoutGatePoints` is
   * anchored on `WorkItemLanded` for that reason and so is this — see
   * `RailCandidate.over`, which is the caller holding the same line.
   */
  over = false,
): RunProgress | null {
  const first = events[0];
  if (!first) return null;

  /** `point:action` → where that action got to. */
  const verdicts = new Map<string, PointState>();
  let now: Phase | null = null;
  /** The plan as the log recorded it, once `GatesResolved` has landed. */
  let resolved: Map<string, readonly string[]> | null = null;

  const close = (data: Record<string, unknown>, state: PointState) => {
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
        now = { label: AGENT, since: event.at.toISOString(), budgetMs: limits?.wallMs ?? null };
        break;
      }

      case "RunFinished":
      case "RunFailed":
        // The agent phase is over; the next one announces itself. Guarded on the
        // label because a `proposed` gate can outlive the event that ended the
        // agent, and clearing unconditionally would lose it.
        if (now?.label === AGENT) now = null;
        break;

      case "GatesResolved": {
        const points = (data["points"] ?? []) as { gate: string; actions: string[] }[];
        resolved = new Map(points.map((p) => [p.gate, p.actions]));
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

  const points = GATE_POINTS.map((point) => {
    // The log first, the recipe second. `GatesResolved` is appended after the
    // `prepared` gates have already run, so for the first seconds of a run it
    // is the only thing that can say a point exists — and once it lands it is
    // the record, because a recipe read now may not be the one this run got.
    const recorded = resolved?.get(point);
    const planned = recorded ?? (plan.get(point) ?? []).map((a) => a.name);
    const mine = [...verdicts]
      .filter(([k]) => k.startsWith(`${point}:`))
      .map(([k, v]) => [k.slice(point.length + 1), v] as const);
    const state = stateOf(
      point,
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
    return { point, planned, state, actions };
  });

  return { since: first.at.toISOString(), now, points };
}
