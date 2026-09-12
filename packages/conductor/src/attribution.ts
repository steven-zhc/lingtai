/**
 * Whose failure it is.
 *
 * `nextloom-ai-admin#112` sat in **Waiting on you** for four days holding one
 * line of git output and no button, because the approval it had already been
 * granted was consumed by the merge that then hit a conflict. Nothing analysed
 * it, nothing tried to fix it, and `approve()` accepts only
 * `awaiting-approval`, so the item could never be approved again. Two of
 * Lingtai's own items reached the identical state within an hour of each other.
 *
 * [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md) answered that
 * by making a failure *buy an agent*: a whole new run, told what went wrong,
 * which the next claim became. This file was where that purchase was decided.
 *
 * **It decides nothing about money now.**
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
 * moves the worktree's scope out around the merge lane, so every refusal is
 * answered *where it happened* by a round in the run that was refused, and
 * "a new run" stops being the answer to anything except a run that ended. Its
 * §Consequences says what is left here, and `#143` is that sentence carried
 * out:
 *
 * > **`decideRepair` loses most of its work.** What is left is *whose* failure
 * > it is — `RUN_OWNER`, `source: "project"` — which is a question about blame,
 * > not about spending, and needs no recipe key.
 *
 * So: `whoseFailure` is the whole of it, `diagnoseRefusal` is what a person is
 * handed, and there is no ceiling, no fingerprint and no recipe key in the
 * file. `RepairRequested` and `RepairDeclined` are retired in the catalogue —
 * readable for ever, appended never.
 *
 * Everything here is a decision and nothing here does I/O, which is why it is a
 * module of its own rather than a condition inline at the two call sites that
 * need it (`run-once.ts`'s merge lane, and `approve.ts`'s). 0025's ticket asked
 * for the classification to be *a named function with tests* for a reason that
 * outlived the spending it was written for: a rule a card's only sentence comes
 * out of, living inside an `if` in a 1,000-line file, is a rule nobody can
 * check.
 */
import type {
  BlockDiagnosis,
  BlockRecommendation,
  RefusalReason,
  RunFailureKind,
} from "@lingtai/domain";

/**
 * Who owns a failure — and so what a card can honestly say about it.
 *
 * Three values, not two, because there are three things a refusal can be:
 *
 *   `repository`  a defect in the managed repository. A red build, failing
 *                 tests, a branch that does not merge. Something with a
 *                 worktree could act on it — but by the time one reaches this
 *                 file it has reached the merge lane or an approval, where no
 *                 round runs.
 *   `lingtai`     Lingtai's own. No GitHub App, a recipe that will not parse, a
 *                 required env value missing, no hook binary, an unreachable
 *                 database. Nothing in the repository is broken, so nothing a
 *                 pass could have done would have helped.
 *   `person`      not a failure. A hold somebody meant: a pending migration is
 *                 applied by a human who has looked at it.
 *
 * The third exists so the second stays honest. Folding a migration hold into
 * `lingtai` would say Lingtai is broken when it is working exactly as designed,
 * and folding it into `repository` would blame a deliberate safeguard.
 *
 * **None of the three buys anything.** They differ in what the card says, which
 * is `#84`'s "never left with no path forward" — and since `#143` that is the
 * whole of the distinction rather than half of it.
 */
export type FailureOwner = "repository" | "lingtai" | "person";

/**
 * A failure, as something to attribute.
 *
 * Two of the three sources are the two the seam already draws (0025 §1):
 * project-level refusals are Lingtai's, and `IntegrationRefused` is the
 * repository's. A **gate** verdict needs no source of its own — a diff whose
 * gates refused reaches the integrator with `gatesPassed: false` and comes back
 * out as `gate-failed`, so the gates arrive here already in this vocabulary.
 *
 * A **run** failure was deliberately not modelled, and that was the gap
 * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) closed. The
 * reasoning was about spending — a run that timed out or crashed is released
 * and retried under the queue's backoff, and calling that a repair would make
 * it a re-run wearing a better name. Nothing spends now, and the source stays
 * because the *attribution* is still a real question: a quota that stopped six
 * tickets is Lingtai's account and not the repository's code, and that is what
 * a card has to say.
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
 * A total record rather than a `switch` with a default: an eighth
 * `RefusalReason` will not compile until somebody decides who owns it, which is
 * the property that keeps a new failure from silently reaching a person with
 * the wrong sentence on it.
 */
const INTEGRATION_OWNER: Record<RefusalReason, FailureOwner> = {
  /**
   * Staleness, not a defect — and by the time this is written the mechanical
   * fix is spent twice over. `integrate()` merges the base in before it merges
   * out, so a `conflict` is that attempt failing (0025 §4); and since `#142`
   * the pass then stages the conflict in its own worktree and sends the agent
   * back into the markers, up to `rounds` times. A conflict that still reaches
   * a person has had every cheap answer.
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
 * record 0031 says was missing.
 *
 * None of them is the repository's, and each is not for its own reason.
 * `never-started` is 0031 §2: the agent could not begin, so nothing in the
 * repository was reached, let alone broken. The other four are endings the
 * queue already answers with a backoff and a better prompt (#82) — the ticket
 * is coming back, and a card that blamed the repository for a quota would send
 * somebody to read a diff that is not the problem.
 *
 * `lingtai` rather than `person` because none of these is a hold anybody meant.
 */
const RUN_OWNER: Record<RunFailureKind, FailureOwner> = {
  "never-started": "lingtai",
  timeout: "lingtai",
  crash: "lingtai",
  aborted: "lingtai",
  "no-commits": "lingtai",
};

/**
 * Whose failure this is.
 *
 * An unrecognised reason — of either kind that has a vocabulary — is Lingtai's,
 * not the repository's. A reason this build does not know is one it cannot
 * claim to have read, and the honest sentence for that is *something here is
 * wrong and it is not the diff*.
 */
export function whoseFailure(failure: Failure): FailureOwner {
  if (failure.source === "project") return "lingtai";
  if (failure.source === "run") return RUN_OWNER[failure.reason as RunFailureKind] ?? "lingtai";
  return INTEGRATION_OWNER[failure.reason as RefusalReason] ?? "lingtai";
}

// ------------------------------------------------------------- diagnosing ----

/**
 * A refusal, read as a sentence and as the move it implies.
 *
 * The block a refusal produced used to carry `${reason}: ${detail}` and nothing
 * else — a reason code and a git message, in front of an operator who was being
 * asked to work out what to do with them (#83). What went missing between the
 * integrator and that card is not information: this file already knows whose
 * failure each reason is, whether the mechanical remedy is spent, and whether
 * anything could have acted on it. It simply never said any of it in words.
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
    // A person reads the migration. Requeueing would reach this same hold
    // again, and there is nothing else to name.
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
 * Why no agent was bought, which since `#143` is one answer per owner rather
 * than one per rule.
 *
 * It used to be `decideRepair`'s sentence, and there were five of them: whose
 * failure it was, whether the recipe repaired at all, and three bounds. A lane
 * refusal buys nothing now, so there is no rule to name and the only thing left
 * to say is *why nothing could have been*. `whoseFailure` is the whole of that,
 * which is the same claim 0039 §Consequences makes about this file.
 *
 * Said out loud on every card, including the `repository` one where the reason
 * is least obvious: the branch is the repository's and a person may well ask
 * why it did not get another agent. Because a refusal reaches this sentence
 * only from the merge lane or from `approve()`, and **neither is a place a
 * round runs** — a `merge:` gate goes from `integrate()` straight to a block,
 * and an approval that meets a moved base has no pass at all. So the sentence
 * must not point at `runtime.limits.rounds`: raising it buys nothing here, and
 * a card that implied otherwise would send an operator to change a key that
 * the next identical refusal still ignores.
 */
const OWNER_SAYS: Record<FailureOwner, string> = {
  repository:
    "No agent was bought: a refusal at the merge lane or at approval buys none, and " +
    "no fix round runs there, so no recipe key would have changed this. Re-implementing " +
    "a branch that already exists is the expensive wrong answer (0039)",
  lingtai:
    "No agent was bought: this is Lingtai's own failure, not the repository's — an " +
    "agent has no access to the thing that is broken and nothing it could change",
  person: "No agent was bought: this is a hold somebody meant, not a failure — it is yours to answer",
};

/**
 * What a person is told about a refusal — which is now all of them.
 *
 * `raw` is the refusal verbatim and is never summarised away: the sentence is
 * this file's reading of the failure, and a reading that hides the output it was
 * made from is worse than the output (#83).
 *
 * **There is no `why` argument any more, and that is the point of `#143`.** It
 * used to be `decideRepair`'s words, handed in by whichever call site had just
 * asked about money. Nothing asks, so the sentence is composed here from
 * `whoseFailure` — one function, so a refusal cannot be explained one way by
 * the pass and another by an approval that failed on the same conflict.
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
}): BlockDiagnosis {
  const reading = REFUSAL_READING[input.reason as RefusalReason] ?? null;
  const where = { branch: input.branch, base: input.base };
  const owner = whoseFailure({ source: "integration", reason: input.reason, detail: input.detail });
  return {
    what: reading ? reading.says(where) : `${input.branch} was refused: ${input.reason}.`,
    // What was *done* about it, which for a conflict is more than nothing: the
    // integrator merges the base in before it merges out, so by the time this
    // is written the mechanical fix has already been tried and exhausted
    // (0025 §4). Then the sentence saying no agent is coming — a card must be
    // able to say why nothing was bought, not only that nothing was.
    done:
      (input.reason === "conflict"
        ? `${input.base} was merged in first and it still would not merge. `
        : "") + `${OWNER_SAYS[owner]}.`,
    raw: input.detail,
    recommendation: reading?.move ?? null,
  };
}
