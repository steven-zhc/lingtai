/**
 * Whether a failure buys an agent, and — before that — whose failure it is.
 *
 * `nextloom-ai-admin#112` sat in **Waiting on you** for four days holding one
 * line of git output and no button, because the approval it had already been
 * granted was consumed by the merge that then hit a conflict. Nothing analysed
 * it, nothing tried to fix it, and `approve()` accepts only
 * `awaiting-approval`, so the item could never be approved again. Two of
 * Lingtai's own items reached the identical state within an hour of each other.
 *
 * [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) is the
 * decision this file implements. Its shape, in one line: **the five gate points
 * stay closed and a failure gains an outcome** — a failure releases the item
 * with its reason, the next attempt is told what went wrong, it produces a
 * commit, and the person approves *that diff*.
 *
 * Everything here is a decision and nothing here does I/O, which is why it is a
 * module of its own rather than a condition inline at the two call sites that
 * need it (`run-once.ts`'s merge lane, and `approve.ts`'s). The ticket asked
 * for the classification to be *a named function with tests* for exactly that
 * reason: a rule about spending money that lives inside an `if` in a 1,000-line
 * file is a rule nobody can check.
 */
import type {
  BlockDiagnosis,
  BlockRecommendation,
  RefusalReason,
  RunFailureKind,
  WorkItemState,
} from "@lingtai/domain";
import { createHash } from "node:crypto";

/**
 * Who owns a failure — which decides whether an agent could do anything at all
 * about it.
 *
 * Three values, not two, because there are three things a refusal can be:
 *
 *   `repository`  a defect in the managed repository. The agent gets a worktree
 *                 and can act: a red build, failing tests, a merge conflict.
 *   `lingtai`     Lingtai's own. No GitHub App, a recipe that will not parse, a
 *                 required env value missing, no hook binary, an unreachable
 *                 database. An agent pointed at one of these has no access to
 *                 the thing that is broken and nothing it could change; it
 *                 would spend money to report that it cannot see anything, and
 *                 address the report to the one person who did not need it.
 *   `person`      not a failure. A hold somebody meant: a pending migration is
 *                 applied by a human who has looked at it, and an agent sent to
 *                 "fix" one would delete it.
 *
 * The third exists so the second stays honest. Folding a migration hold into
 * `lingtai` would say Lingtai is broken when it is working exactly as designed,
 * and folding it into `repository` would buy an agent to undo a deliberate
 * safeguard. Only `repository` ever buys one; the other two differ in what the
 * card should say, which is `#84`'s "never left with no path forward".
 */
export type FailureOwner = "repository" | "lingtai" | "person";

/**
 * A failure, as something that could buy a repair.
 *
 * Two of the three sources are the two the seam already draws (0025 §1):
 * project-level refusals are Lingtai's, and `IntegrationRefused` is the
 * repository's. A **gate** verdict needs no source of its own — a diff whose
 * gates refused reaches the integrator with `gatesPassed: false` and comes back
 * out as `gate-failed`, so the gates arrive here already in this vocabulary.
 *
 * A **run** failure was deliberately not modelled, and that was the gap
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) closed. The
 * reasoning had not changed — a run that timed out or crashed is released and
 * retried under the queue's backoff, and calling that a repair would make it a
 * re-run wearing a better name, which is the one thing 0025 says a repair must
 * not be. What had changed is that nothing here *said* so: a quota burned six
 * tickets and bought no agent by luck, because no clause named a run failure as
 * anything. Modelling the source is what turns that into a rule.
 */
export interface Failure {
  source: "integration" | "project" | "run";
  /**
   * A `RefusalReason` for `integration`, a `RunFailed.kind` for `run`; free
   * text for `project`.
   */
  reason: string;
  detail: string;
}

/**
 * Every refusal the integrator can make, and whose it is.
 *
 * A total record rather than a `switch` with a default: a seventh
 * `RefusalReason` will not compile until somebody decides who owns it, which is
 * the property that keeps this from silently defaulting new failures into
 * spending money.
 */
const INTEGRATION_OWNER: Record<RefusalReason, FailureOwner> = {
  /**
   * Staleness, not a defect — and the integrator has *already* tried the
   * mechanical fix by the time this is written down. `integrate()` merges the
   * base in before it merges out, so a `conflict` is that attempt failing, and
   * `IntegrationRefused` is the record of its exhaustion (0025 §4). A conflict
   * therefore costs nothing by default and an agent is only ever the second
   * move.
   */
  conflict: "repository",
  /** A gate refused this diff. The gates are the repository's. */
  "gate-failed": "repository",
  /** The branch holds nothing the base does not. The repository's, and rare. */
  "no-commits": "repository",
  /** A person applies a migration. Not a failure; see `person` above. */
  "pending-migration": "person",
  /** The integrator's own worktree was not clean. Lingtai cut that worktree. */
  "dirty-base": "lingtai",
  /** Lingtai's mirror and origin disagree about the base. Lingtai's mirror. */
  "unpushed-base": "lingtai",
  /** Two of Lingtai's own integrations raced. Lingtai's lane. */
  "lane-busy": "lingtai",
};

/**
 * Every way a run can end badly, and whose it is.
 *
 * A total record for the reason `INTEGRATION_OWNER` is one, and this is the
 * record 0031 says was missing: `decideRepair` had no clause about a run at
 * all, so *nothing bought a repair* was true by luck and would have stayed true
 * only for as long as nobody added a call site.
 *
 * None of them is the repository's, and each is not for its own reason.
 * `never-started` is 0031 §2: the agent could not begin, so a second agent sent
 * at the same wall cannot either — it would be a second charge for a report
 * addressed to the one person who did not need it. The other four are 0025's
 * older point: an ending the queue already answers with a backoff and a better
 * prompt (#82) is not a thing to buy an analysis of, and a repair for one would
 * be a re-run wearing a better name.
 *
 * `lingtai` rather than `person` because none of these is a hold anybody meant
 * — the card should say something is wrong, and only `repository` ever buys an
 * agent, so the choice between the other two is only about what is said.
 */
const RUN_OWNER: Record<RunFailureKind, FailureOwner> = {
  "never-started": "lingtai",
  timeout: "lingtai",
  crash: "lingtai",
  aborted: "lingtai",
  "no-commits": "lingtai",
  /**
   * `out-of-turns` is the one with a real argument on the other side, and it
   * still loses it. The recipe says a run needing hundreds of turns *"is a
   * ticket that was scoped wrong"*, which reads as the repository's — and
   * `repository` is the one owner that buys an agent. Buying one here would
   * spend a second agent to explain the first one's overspending, at the
   * moment the system has just said the budget is gone. `#84` cost $26.53
   * being unbounded; the repair for that must not be another $26.53.
   */
  "out-of-turns": "lingtai",
};

/**
 * Whose failure this is.
 *
 * An unrecognised reason — of either kind that has a vocabulary — is Lingtai's,
 * not the repository's. The safe default for a rule that spends money is the
 * one that spends none, and a reason this build does not know is a reason it
 * cannot claim an agent could act on.
 */
export function whoseFailure(failure: Failure): FailureOwner {
  if (failure.source === "project") return "lingtai";
  if (failure.source === "run") return RUN_OWNER[failure.reason as RunFailureKind] ?? "lingtai";
  return INTEGRATION_OWNER[failure.reason as RefusalReason] ?? "lingtai";
}

/**
 * The same failure, twice, hashed to the same string.
 *
 * This is what makes the bound *one agent per **distinct** failure* rather than
 * one per pass. The reason and the detail together are the identity: a
 * `conflict` on `page.tsx` and a `conflict` on `globals.css` are two failures
 * and each may buy an attempt, but the same conflict seen again on the next lap
 * buys nothing.
 *
 * Truncated because it is read on a card and in a log line, and because
 * collisions between two of one work item's handful of failures are not a
 * thing that happens.
 */
export function repairFingerprint(failure: Failure): string {
  return createHash("sha256")
    .update(`${failure.source}\n${failure.reason}\n${failure.detail}`)
    .digest("hex")
    .slice(0, 12);
}

/** What the recipe says about repairing. See `Recipe.repair`. */
export interface RepairPolicy {
  on: boolean;
  maxAttempts: number;
}

export type RepairDecision =
  | { repair: true; fingerprint: string; attempt: number }
  /** `why` is a sentence for the card, naming the rule that refused. */
  | { repair: false; fingerprint: string; why: string };

export interface RepairInput {
  failure: Failure;
  policy: RepairPolicy;
  /** The work item, folded. Carries the bound: `repairs` and `repairRun`. */
  item: WorkItemState;
  /** The run that just failed. */
  runId: string;
}

/**
 * Whether this failure buys an agent.
 *
 * **Every rule that can refuse is here, in order, and each names itself.** The
 * order is the order an operator would want to read: whose failure it is, then
 * whether this repository repairs at all, then the three bounds. The first
 * refusal wins, so the sentence on the card is the most fundamental reason and
 * not the last one checked.
 *
 * The three bounds are 0025 §3, and all three are needed — drop any one and a
 * single bad ticket spawns an agent per lap:
 *
 *   **no recursion**  a repair whose own run failed does not buy an analysis of
 *                     the analysis. Checked first of the three, because it is
 *                     the one that would compound.
 *   **distinct**      a failure already answered by an agent buys nothing,
 *                     however many passes later it is seen again.
 *   **a ceiling**     from the recipe, counted against the repairs on the log.
 */
export function decideRepair(input: RepairInput): RepairDecision {
  const { failure, policy, item, runId } = input;
  const fingerprint = repairFingerprint(failure);
  const no = (why: string): RepairDecision => ({ repair: false, fingerprint, why });

  const owner = whoseFailure(failure);
  if (owner === "lingtai") {
    return no(
      "this is Lingtai's own failure, not the repository's — an agent has no access " +
        "to the thing that is broken and nothing it could change",
    );
  }
  if (owner === "person") {
    return no("this is a hold somebody meant, not a failure — it is yours to answer");
  }

  if (!policy.on) {
    return no("this project's recipe says it does not repair (repair.on: false)");
  }

  if (item.repairRun?.runId === runId) {
    return no(
      "the run that failed was itself a repair, and a repair that fails does not " +
        "buy an analysis of the analysis",
    );
  }

  if (item.repairs.some((r) => r.fingerprint === fingerprint)) {
    return no(`this exact failure has already bought an agent (${fingerprint})`);
  }

  if (item.repairs.length >= policy.maxAttempts) {
    return no(
      `the ceiling of ${policy.maxAttempts} repair attempt(s) for this item is spent`,
    );
  }

  return { repair: true, fingerprint, attempt: item.repairs.length + 1 };
}

/**
 * What the repair attempt is told, as a block for its prompt.
 *
 * **This is the difference between a repair and a re-run**, and the ticket
 * calls it the one hard dependency: an agent that is not told what the conflict
 * was is just the same agent again, at the same price, arriving at the same
 * place. `prompts/ticket.md` carries a `{{failure}}` slot which is empty for
 * every ordinary run.
 *
 * It says three things and stops: what failed, verbatim; that the mechanical
 * remedy is already spent; and that the answer is a commit rather than advice.
 * The last is load-bearing — an approval in this system means *merge what the
 * held run actually produced*, so a repair that writes only a recommendation
 * produces nothing anyone can approve (0025).
 */
export function repairBrief(record: {
  reason: string;
  detail: string;
  attempt: number;
}): string {
  return [
    "## The last attempt failed, and this one is the repair",
    "",
    `Lingtai could not land the previous run's branch. This is repair attempt ${record.attempt};`,
    "the mechanical remedy has already been tried and did not work — for a conflict",
    "that means the integrator merged the base branch in, and it still would not merge.",
    "",
    `The refusal was **${record.reason}**, verbatim:`,
    "",
    "```",
    record.detail.trim(),
    "```",
    "",
    "Fix it and **commit**. A recommendation is not enough: what a person is asked to",
    "approve is a diff, so an attempt that ends with advice and no commit produces",
    "nothing they can act on. If it cannot be fixed from here, say so plainly in your",
    "final message and do not commit something you have not verified — the item is",
    "handed back with your reason rather than merged.",
  ].join("\n");
}

// ------------------------------------------------------------- diagnosing ----

/**
 * A refusal, read as a sentence and as the move it implies.
 *
 * The block a refusal produced used to carry `${reason}: ${detail}` and nothing
 * else — a reason code and a git message, in front of an operator who was being
 * asked to work out what to do with them (#83). What went missing between the
 * integrator and that card is not information: this file already knows whose
 * failure each reason is, whether the mechanical remedy is spent, and whether an
 * agent could act on it. It simply never said any of it in words.
 *
 * A total record over `RefusalReason`, for the reason `INTEGRATION_OWNER` is
 * one: an eighth reason will not compile until somebody writes the sentence and
 * decides whether it has a move. A reason with no move is the normal case and
 * not an oversight — `gate-failed` is a red diff, which is a judgement, and
 * `dirty-base` is Lingtai's own checkout, which requeueing walks straight back
 * into.
 */
const REFUSAL_READING: Record<
  RefusalReason,
  {
    says: (where: { branch: string; base: string }) => string;
    /** The move this refusal implies, or null when nobody can name one. */
    move: BlockRecommendation | null;
  }
> = {
  conflict: {
    says: ({ branch, base }) => `${branch} does not merge into ${base}.`,
    move: {
      action: "requeue",
      why:
        "the mechanical remedy is already spent, so the next attempt is the fix: " +
        "it is cut from a base that has since moved",
    },
  },
  "gate-failed": {
    says: ({ branch, base }) => `a gate refused ${branch}, so it was not merged into ${base}.`,
    // Nothing is recommended, deliberately. A red diff is the one case where
    // the judgement is genuinely a person's — approve it anyway, waive the
    // gate, or reject it — and a default here would be picking for them.
    move: null,
  },
  "no-commits": {
    says: ({ branch, base }) => `${branch} holds nothing ${base} does not, so there was nothing to merge.`,
    move: {
      action: "requeue",
      why: "there is no diff to approve; a fresh attempt starts from the current base",
    },
  },
  "pending-migration": {
    says: ({ branch }) =>
      `${branch} carries a migration, which a person applies. This is a hold Lingtai means, not a failure.`,
    // A person reads the migration. An agent sent to "fix" one would delete it
    // (0025), and requeueing would reach this same hold again.
    move: null,
  },
  "dirty-base": {
    says: ({ branch, base }) =>
      `Lingtai's own checkout of ${base} was not clean, so the merge was refused. Nothing is wrong with ${branch}.`,
    move: null,
  },
  "unpushed-base": {
    says: ({ branch, base }) =>
      `Lingtai's mirror of ${base} and origin disagree, so the merge was refused. Nothing is wrong with ${branch}.`,
    move: null,
  },
  "lane-busy": {
    says: ({ branch, base }) =>
      `another integration held the merge lane, so ${branch} was not merged into ${base}.`,
    move: {
      action: "requeue",
      why: "the lane was busy rather than wrong — the next pass merges it",
    },
  },
};

/**
 * What a person is told about a refusal that bought no agent.
 *
 * `raw` is the refusal verbatim and is never summarised away: the sentence is
 * this file's reading of the failure, and a reading that hides the output it was
 * made from is worse than the output (#83).
 *
 * A reason this build does not know still gets a diagnosis — the reason itself,
 * said plainly — and no recommendation. That is the same default `whoseFailure`
 * takes: an unknown failure is one nothing here can claim to have a move for.
 */
export function diagnoseRefusal(input: {
  /** A `RefusalReason`, or anything an older build wrote. */
  reason: string;
  detail: string;
  branch: string;
  base: string;
  /** Why no agent was bought, in `decideRepair`'s own words. */
  why: string;
}): BlockDiagnosis {
  const reading = REFUSAL_READING[input.reason as RefusalReason] ?? null;
  const where = { branch: input.branch, base: input.base };
  return {
    what: reading ? reading.says(where) : `${input.branch} was refused: ${input.reason}.`,
    // What was *done* about it, which for a conflict is more than nothing: the
    // integrator merges the base in before it merges out, so by the time this
    // is written the mechanical fix has already been tried and exhausted
    // (0025 §4). The decline belongs here too — a card must be able to say why
    // no agent was bought, not only that none was.
    done:
      (input.reason === "conflict"
        ? `${input.base} was merged in first and it still would not merge. `
        : "") + `No agent was bought: ${input.why}`,
    raw: input.detail,
    recommendation: reading?.move ?? null,
  };
}
