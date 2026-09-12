/**
 * The WorkItem aggregate: `wi-{project}-{n}`, alive for weeks.
 *
 * The failure this replaces is specific. In the old loop a ticket's state was
 * the set of `agent:*` labels on its GitHub issue, and `--add-label` is set
 * union, not a transition — nothing forbade a contradictory pair and nothing
 * reconciled one. #35 carried `agent:blocked` **and** `agent:review` at the same
 * time, and no code was wrong; the model was.
 *
 * So `lifecycle` here is a discriminated union rather than a bag of flags. There
 * is no value of `WorkItemState` in which an item is both claimed and blocked,
 * because there is no way to write one down. The facts that outlive a
 * transition — title, labels, links — sit outside the union, where they belong.
 *
 * One thing this reducer deliberately cannot see: gates, approvals and merges.
 * Those are events on the Run and Integration streams, because a run emits
 * hundreds of events while a work item lives for weeks and one stream would make
 * every read expensive (design.md §4). The lifecycle drawn in design.md §4 spans
 * all three aggregates; assembling it is the board projection's job, not this
 * function's.
 */
import type { Envelope } from "./envelope.ts";
import type { BlockDiagnosis, PayloadOf, Tier } from "./events.ts";

export type WorkItemLifecycle =
  | { status: "backlog" }
  /**
   * Held. There is no expiry in this shape and that is the whole of 0027: a
   * fold cannot read a clock, so a lifecycle that lapsed on its own would make
   * `lingtai projection rebuild task_view` disagree with the incremental fold.
   * What returns a claim is a `WorkItemReleased`, appended by a conductor that
   * holds the lock.
   */
  | { status: "claimed"; runId: string; worker: string }
  | {
      status: "blocked";
      /** The question, not just the fact. `agent:blocked` carried no question. */
      question: string;
      needsFrom: "human" | "schema" | "external";
      runId: string | null;
      /**
       * Whether a person's judgement is required, or a failure needs
       * acknowledging. Two opposite kinds of hold that were one event with a
       * string on it (#83). Null on a block written before the field existed.
       */
      needs: "judgement" | "acknowledgement" | null;
      /** What happened, what was done, what is recommended. Null when undiagnosed. */
      diagnosis: BlockDiagnosis | null;
    }
  | { status: "landed"; mergeCommit: string; base: string };

export type WorkItemStatus = WorkItemLifecycle["status"];

/**
 * An approach this ticket abandoned, as `PassRestarted` recorded it.
 *
 * `after` is the pass whose rounds were spent, not the pass that will try the
 * next approach — the second does not exist yet when this is written down.
 *
 * `findings` is the arm's own, and the reason this is a record rather than a
 * count: the person asked when the last restart is spent is shown every arm
 * (0040 §3), and each arm's refusal lives on a run stream no later pass reads.
 */
export interface RestartRecord {
  after: string;
  restart: number;
  of: number;
  action: string;
  rounds: number;
  branch: string;
  headSha: string;
  findings: PayloadOf<"PassRestarted">["findings"];
}

/** How this item is connected to another — a filed bug to the merge that caused it. */
export interface WorkItemLink {
  relation: "caused-by" | "follows-up" | "duplicates";
  otherRef: string;
}

export interface WorkItemState {
  lifecycle: WorkItemLifecycle;

  /** Null until `WorkItemDiscovered`; a stream can be read before it exists. */
  project: string | null;
  source: "github-issue" | "manual" | "agent-followup" | null;
  externalRef: string | null;
  title: string | null;
  /** Whatever label the recipe's `source.kinds` matched. Null until discovered. */
  kind: string | null;
  labels: readonly string[];

  links: readonly WorkItemLink[];

  /**
   * Every dispatch the scheduler refused, kept rather than counted. A tier is
   * never silently downgraded, so the refusals are the record of what could not
   * run and why.
   */
  dispatchRefusals: readonly { requiredTier: Tier; runtime: string; missing: readonly string[] }[];

  /** Runs that have held this item, oldest first. A re-run appends. */
  runs: readonly string[];

  /**
   * Every approach this item has abandoned, oldest first
   * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
   *
   * **The ceiling is counted here rather than remembered anywhere**, which is
   * the shape `repairs` had before `#143` deleted it: a length against a number
   * from the recipe is structural rather than aspirational, a rebuild
   * recomputes it, and there is no counter to forget to increment.
   *
   * There is deliberately no `pendingRestart`. A restart is told nothing extra:
   * `attempts.ts` already writes the abandoned branch, its sha and the findings
   * into every second prompt, so the next claim is an ordinary pass and the
   * only thing this list decides is whether there is one left to buy. The one
   * thing that ever needed a pending record was a repair, because the next
   * claim had to *become* one — and nothing buys a repair any more (0039
   * §Consequences).
   */
  restarts: readonly RestartRecord[];

  /**
   * A sentence somebody added for the next run, and not yet consumed.
   *
   * The whole of how a `PromptEdited` reaches an agent
   * ([0032](../../../doc/decisions/0032-the-page-is-organised-by-attempt.md)
   * §5). It applies to the **next run only**, whoever starts it — the next
   * `WorkItemClaimed` clears it.
   *
   * One-shot rather than durable, and that removes a failure mode rather than
   * mitigating one: a lasting override would need the page to guard against a
   * stale instruction being sent unseen, and something meant to last belongs in
   * the GitHub ticket where everybody can see it (§6).
   */
  pendingPrompt: { text: string; by: string } | null;

  /** Version of the last event applied — the `expectedVersion` for the next append. */
  version: number;
  /** Global position of the last event applied. */
  lastSeq: bigint | null;
}

export const emptyWorkItem: WorkItemState = {
  lifecycle: { status: "backlog" },
  project: null,
  source: null,
  externalRef: null,
  title: null,
  kind: null,
  labels: [],
  links: [],
  dispatchRefusals: [],
  runs: [],
  restarts: [],
  pendingPrompt: null,
  version: 0,
  lastSeq: null,
};

export function applyWorkItem(state: WorkItemState, event: Envelope): WorkItemState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {
    case "WorkItemDiscovered": {
      const d = event.data as PayloadOf<"WorkItemDiscovered">;
      return {
        ...state,
        ...at,
        project: d.project,
        source: d.source,
        externalRef: d.externalRef,
        title: d.title,
        kind: d.kind,
        labels: d.labels,
      };
    }

    case "WorkItemClaimed": {
      const d = event.data as PayloadOf<"WorkItemClaimed">;
      return {
        ...state,
        ...at,
        // Replaces whatever lifecycle was there. A claim while blocked is not an
        // error to represent — it is the unblock-and-retry path — and it cannot
        // leave the block behind, because the union has room for only one.
        lifecycle: {
          status: "claimed",
          runId: d.runId,
          worker: d.worker,
        },
        runs: state.runs.includes(d.runId) ? state.runs : [...state.runs, d.runId],
        // The claim consumes whatever sentence a person added for the next run:
        // `PromptEdited` applies to one run, and this is the run (0032 §5).
        //
        // It used to consume a *pending repair* here too, and that clause is the
        // one `#143` deleted. `RepairRequested` is retired, so nothing puts a
        // repair on an item and no claim can become one — a log that still holds
        // the event folds through the default below and changes nothing but the
        // version.
        pendingPrompt: null,
      };
    }

    case "PassRestarted": {
      const d = event.data as PayloadOf<"PassRestarted">;
      // The lifecycle is untouched: a restart is not a state an item is in — the
      // release that follows this puts it back in the queue, and being queued is
      // the state.
      return {
        ...state,
        ...at,
        restarts: [
          ...state.restarts,
          {
            after: d.runId,
            restart: d.restart,
            of: d.of,
            action: d.action,
            rounds: d.rounds,
            branch: d.branch,
            headSha: d.headSha,
            findings: d.findings,
          },
        ],
      };
    }

    case "PromptEdited": {
      const d = event.data as PayloadOf<"PromptEdited">;
      // The lifecycle is untouched. An edit is about *what to do*, not about
      // which state the item is in — the next claim is what consumes it, and a
      // second edit before that claim replaces the first rather than stacking:
      // two sentences nobody re-read is a prompt nobody approved.
      //
      // **Blank is the removal**, which is why the page's *Remove the edit* is
      // an append and not a deletion. It also closes a gap the version had: an
      // edit of nothing but whitespace produced no block in the prompt —
      // `humanBrief` trims — and still a `human@…` in `promptVersion`, so the
      // log claimed a difference the agent was never told about.
      return {
        ...state,
        ...at,
        pendingPrompt: d.text.trim() === "" ? null : { text: d.text, by: d.by },
      };
    }

    case "WorkItemReleased":
      // The only way back to the queue. A claim does not lapse (0027), so every
      // return is an append somebody made — including the one a conductor makes
      // at startup for a claim its predecessor died holding.
      return { ...state, ...at, lifecycle: { status: "backlog" } };

    case "WorkItemBlocked": {
      const d = event.data as PayloadOf<"WorkItemBlocked">;
      return {
        ...state,
        ...at,
        lifecycle: {
          status: "blocked",
          question: d.question,
          needsFrom: d.needsFrom,
          runId: d.runId,
          needs: d.needs,
          diagnosis: d.diagnosis,
        },
      };
    }

    case "WorkItemUnblocked":
      return { ...state, ...at, lifecycle: { status: "backlog" } };

    case "WorkItemLinked": {
      const d = event.data as PayloadOf<"WorkItemLinked">;
      const already = state.links.some(
        (l) => l.relation === d.relation && l.otherRef === d.otherRef,
      );
      return { ...state, ...at, links: already ? state.links : [...state.links, d] };
    }

    case "WorkItemLanded": {
      const d = event.data as PayloadOf<"WorkItemLanded">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "landed", mergeCommit: d.mergeCommit, base: d.base },
      };
    }

    case "DispatchRefused": {
      const d = event.data as PayloadOf<"DispatchRefused">;
      return { ...state, ...at, dispatchRefusals: [...state.dispatchRefusals, d] };
    }

    default:
      // Unknown to this build, or belonging to another aggregate. Ignored rather
      // than rejected: a projection compiled against an older catalogue has to
      // survive a newer conductor's events instead of wedging on the first one.
      //
      // Note where the real forward-compatibility boundary sits. `@lingtai/event-store`
      // currently *throws* on an event type it does not recognise, so in practice
      // it refuses one before a reducer ever sees it. This tolerance is what
      // makes the reducer itself safe to reuse — over a replay, a fixture, or a
      // relaxed reader — not a claim that the whole pipeline is tolerant today.
      return { ...state, ...at };
  }
}

export function reduceWorkItem(events: readonly Envelope[]): WorkItemState {
  return events.reduce(applyWorkItem, emptyWorkItem);
}

/**
 * A repair the old code bought and no claim has consumed yet — **read off a log
 * written before `#143`**, and never produced by this build.
 *
 * Deliberately not a field of `WorkItemState`. The fold treats the retired
 * `RepairRequested` as a version bump, so nothing new can depend on it; this is
 * the one question that still has to be asked of an old stream, and only at the
 * seam a deploy crosses: the old code appended the request and released the
 * item, and the new code is what claims it. Without this that claim is an
 * ordinary pass — backed off, told nothing it was bought to be told, and free
 * to merge unattended where the repair it was released for would have asked.
 *
 * The last `RepairRequested` after the last `WorkItemClaimed`, or null.
 */
export function retiredRepairPending(
  events: readonly Envelope[],
): { after: string; reason: string; detail: string; attempt: number } | null {
  let pending: { after: string; reason: string; detail: string; attempt: number } | null = null;
  for (const event of events) {
    if (event.type === "WorkItemClaimed") pending = null;
    if (event.type === "RepairRequested") {
      const d = event.data as PayloadOf<"RepairRequested">;
      pending = { after: d.runId, reason: d.reason, detail: d.detail, attempt: d.attempt };
    }
  }
  return pending;
}
