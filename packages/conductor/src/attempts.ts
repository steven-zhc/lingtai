/**
 * What the earlier attempts at a work item did, as a block for the next one's
 * prompt.
 *
 * `#82`: a second attempt ran the same template filled from the same ticket and
 * knew nothing of the first. `RunPrompted` on the second attempt at `#59`
 * recorded `promptVersion: "ticket@1911"` — byte-identical to the first — while
 * the log beside it already held that run's `prepared:install` verdict and the
 * `WorkItemReleased.reason` that ended it. So `attempts: 2` on a card meant *we
 * paid twice*, not *we learned once*, and the loop's `exhausted` stop exists
 * precisely because a blind retry is expensive. The cheaper fix is to stop the
 * retry being blind.
 *
 * **No new events.** Everything read here is already on the work item's stream
 * and the previous run's, which is why this is a module of pure functions
 * beside `repair.ts` rather than more code inside `run-once.ts`: it is a
 * decision about what an attempt is told, and a decision about that belongs
 * somewhere it can be tested without a database.
 *
 * It is the same seam `repairBrief` sits on and deliberately not the same
 * block. A repair is one specific ending — the integrator refused a diff that
 * exists — and it carries an instruction about what to produce. This is the
 * *history*, which every second attempt has whether or not one was bought.
 *
 * **Both bounds are structural**, which is the ticket's last criterion: one
 * earlier run's evidence is quoted and it is truncated (`budget.evidence`), and
 * the rest of the history is one table row each, of which only the last
 * `budget.attempts` are printed. A work item on its fifth attempt cannot paste
 * four gate logs into a prompt, because there is no path here that reads four.
 *
 * **The numbers themselves are the recipe's** (`runtime.budget`,
 * [0029](../../../doc/decisions/0029-the-prompt-budget-is-the-recipes.md)).
 * They were three constants here, and being well commented where they lived was
 * not the same as being a policy anybody could find: nothing in `doc/` named
 * them. They are passed in rather than defaulted here so that the value has
 * exactly one home — the schema — and this file states the shape of the bound
 * without also deciding it.
 */
import type { Envelope, PayloadOf } from "@lingtai/domain";
import { createHash } from "node:crypto";

/**
 * How much an attempt is told about the ones before it.
 *
 * `Recipe["runtime"]["budget"]` minus `diff`, which belongs to the review agent
 * and never reaches here. Declared as its own shape rather than imported so
 * that this module keeps costing nothing but `@lingtai/domain` — the reason it
 * is a module of pure functions in the first place.
 */
export interface PromptBudget {
  /** Characters of one earlier failure's output quoted verbatim. */
  evidence: number;
  /** Rows the table names before it says "and N earlier". */
  attempts: number;
  /** Findings of a review gate that are listed. */
  findings: number;
}

/**
 * What the previous run's own stream says it did.
 *
 * Read from the run and not from the work item because that is where it is: the
 * work item stream knows an attempt happened and how it ended, and nothing
 * else. Both halves matter to the next attempt and they answer different
 * questions — `produced` is *is there anything to build on*, `evidence` is
 * *what exactly refused*.
 */
export interface AttemptOutcome {
  /** From `RunProducedDiff`. Null when the run committed nothing. */
  produced: {
    branch: string;
    headSha: string;
    files: number;
    insertions: number;
    deletions: number;
  } | null;
  /**
   * What refused, and what it said.
   *
   * `what` names the gate point and action (`proposed:build`) or the run's own
   * ending (`the run itself (timeout)`); `text` is that output verbatim, up to
   * `budget.evidence`. Null for a run with no recorded refusal at all.
   */
  evidence: { what: string; text: string } | null;
  /** From `RunFinished`. Null for a run that never got that far. */
  receipt: { turns: number; costUsd: number | null } | null;
}

/**
 * One earlier attempt, as the work item's stream records it.
 *
 * `outcome` is null until a caller fills it from that run's stream. That is the
 * shape the bound takes: the history of *every* attempt costs one stream read
 * because it is already in hand, and reading a run costs one more each — so
 * `run-once` fills exactly the last.
 */
export interface PriorAttempt {
  /** 1 for the first attempt at this item. The table's left column. */
  n: number;
  runId: string;
  /**
   * How it ended, in the log's own words: `WorkItemReleased.reason`, or the
   * question it was blocked with. Null while a run still holds the item — which
   * a caller reading before its own claim will never see for itself.
   */
  ended: string | null;
  /** The integrator's refusal, when a repair was requested or declined for it. */
  refusal: { reason: string; detail: string } | null;
  outcome: AttemptOutcome | null;
}

/**
 * Every attempt this item has already had, oldest first.
 *
 * A claim is an attempt: `WorkItemClaimed` ×N is what "attempts: N" on a card
 * counts, so it is what this counts. Called **before** the claim this run is
 * about to make, exactly as `pendingRepair` is, so the run asking does not
 * appear in its own history.
 */
export function priorAttempts(itemEvents: readonly Envelope[]): PriorAttempt[] {
  const attempts: PriorAttempt[] = [];
  const byRun = new Map<string, PriorAttempt>();

  for (const event of itemEvents) {
    switch (event.type) {
      case "WorkItemClaimed": {
        const d = event.data as PayloadOf<"WorkItemClaimed">;
        // A second claim by the same run is the same attempt claiming again,
        // not a new one — the same reason `WorkItemState.runs` will not list it
        // twice. Nothing writes one today; the guard is about the fold, not
        // about a caller.
        if (byRun.has(d.runId)) break;
        const attempt: PriorAttempt = {
          n: attempts.length + 1,
          runId: d.runId,
          ended: null,
          refusal: null,
          outcome: null,
        };
        attempts.push(attempt);
        byRun.set(d.runId, attempt);
        break;
      }

      case "WorkItemReleased": {
        const d = event.data as PayloadOf<"WorkItemReleased">;
        const attempt = byRun.get(d.runId);
        if (attempt) attempt.ended = d.reason;
        break;
      }

      case "WorkItemBlocked": {
        const d = event.data as PayloadOf<"WorkItemBlocked">;
        const attempt = d.runId === null ? undefined : byRun.get(d.runId);
        // An attempt that ended by asking a person ended just as much as one
        // that was released, and the question is the reason.
        if (attempt) attempt.ended = `blocked, asking: ${d.question}`;
        break;
      }

      case "RepairRequested":
      case "RepairDeclined": {
        const d = event.data as PayloadOf<"RepairRequested">;
        const attempt = byRun.get(d.runId);
        // The integrator's own words, which the release reason only summarises.
        if (attempt) attempt.refusal = { reason: d.reason, detail: d.detail };
        break;
      }

      default:
        break;
    }
  }

  return attempts;
}

/**
 * What one earlier run produced and what refused it.
 *
 * Read from the envelopes rather than through `reduceRun` because the two facts
 * wanted here are not both in that fold: `RunState.gates` keeps the latest
 * verdict per gate and the last *refusal* is what this attempt needs, and a
 * gate that started and never returned a verdict — the run died inside it — has
 * no verdict to keep.
 */
export function attemptOutcome(
  runEvents: readonly Envelope[],
  budget: PromptBudget,
): AttemptOutcome {
  let produced: AttemptOutcome["produced"] = null;
  let receipt: AttemptOutcome["receipt"] = null;
  let evidence: AttemptOutcome["evidence"] = null;
  let failed: AttemptOutcome["evidence"] = null;
  const unfinished = new Set<string>();

  for (const event of runEvents) {
    switch (event.type) {
      case "RunProducedDiff": {
        const d = event.data as PayloadOf<"RunProducedDiff">;
        produced = d;
        break;
      }

      case "RunFinished": {
        const d = event.data as PayloadOf<"RunFinished">;
        receipt = { turns: d.turns, costUsd: d.costUsd };
        break;
      }

      case "RunFailed": {
        const d = event.data as PayloadOf<"RunFailed">;
        failed = { what: `the run itself (${d.kind})`, text: d.detail };
        break;
      }

      case "GateStarted": {
        const d = event.data as PayloadOf<"GateStarted">;
        unfinished.add(`${d.gate}:${d.action}`);
        break;
      }

      case "GatePassed":
      case "GateWaived": {
        const d = event.data as PayloadOf<"GateStarted">;
        unfinished.delete(`${d.gate}:${d.action}`);
        break;
      }

      case "GateFailed": {
        const d = event.data as PayloadOf<"GateFailed">;
        const what = `${d.gate}:${d.action}`;
        unfinished.delete(what);
        // A gate's refusal is the most specific thing on the stream, so the last
        // one wins over anything else recorded here.
        evidence = { what, text: findingsAppended(d.evidence, d.findings, budget.findings) };
        break;
      }

      default:
        break;
    }
  }

  if (evidence === null) evidence = failed;
  if (evidence === null) {
    // The ticket's "which point it died at": a gate that started and never
    // returned a verdict. There is no output to quote — the fact is the finding.
    const [died] = [...unfinished];
    if (died !== undefined) {
      evidence = { what: died, text: "it started and never returned a verdict." };
    }
  }

  return { produced, evidence, receipt };
}

/** A review gate's findings, under its output. Bounded by `budget.findings`. */
function findingsAppended(
  output: string,
  findings: PayloadOf<"GateFailed">["findings"],
  max: number,
): string {
  if (findings.length === 0) return output;
  const shown = findings.slice(0, max).map((f) => {
    const at = f.line === null ? f.file : `${f.file}:${f.line}`;
    return `- [${f.severity}] ${at} — ${f.claim} (${f.failureScenario})`;
  });
  const more = findings.length > max ? [`- …and ${findings.length - max} more`] : [];
  return [output.trimEnd(), "", ...shown, ...more].join("\n");
}

/**
 * The history, as the block a prompt carries.
 *
 * Empty for a first attempt, and that is the criterion "attempt 1 is
 * unchanged": there is no history to say nothing about, so nothing is said. A
 * `{{failure}}` slot filled with an empty string is a template that renders
 * byte-identically to the one this feature never touched.
 *
 * The last attempt is the one quoted, because it is the one whose state the
 * worktree is next to. The earlier ones are a row each — how many there were and
 * what ended them is the fact that matters, and their output is not worth what
 * it costs.
 */
export function attemptBrief(attempts: readonly PriorAttempt[], budget: PromptBudget): string {
  if (attempts.length === 0) return "";

  const last = attempts[attempts.length - 1]!;
  const n = attempts.length;
  const shown = attempts.slice(-budget.attempts);
  const hidden = attempts.length - shown.length;

  const lines = [
    `## This ticket has been attempted ${n === 1 ? "once" : `${n} times`} already`,
    "",
    `This is attempt ${n + 1}. The ${n === 1 ? "one before it" : "ones before it"} ran this same prompt, filled from`,
    "this same ticket, and produced what follows. Read it before you plan anything:",
    "repeating the previous attempt costs what it cost and ends where it ended.",
    "",
    "| # | run | how it ended |",
    "| --- | --- | --- |",
    ...(hidden > 0 ? [`| … | | ${hidden} earlier attempt(s), omitted |`] : []),
    ...shown.map(
      (a) => `| ${a.n} | \`${a.runId}\` | ${cell(a.ended ?? "no ending recorded")} |`,
    ),
  ];

  if (last.refusal) {
    lines.push(
      "",
      `The integrator refused attempt ${last.n} with **${last.refusal.reason}**:`,
      "",
      "```",
      clamp(last.refusal.detail, budget.evidence),
      "```",
    );
  }

  // Only when the run's own stream was read. A caller that did not read it does
  // not know the attempt produced nothing — it knows nothing — and saying the
  // first would be an invention in a prompt.
  const produced = last.outcome === null ? undefined : last.outcome.produced;
  if (produced !== undefined) {
    lines.push("", `### What attempt ${last.n} produced`, "");
  }
  if (produced === null) {
    lines.push(
      "Nothing. It committed no change, so there is no branch to build on and this",
      "attempt starts where the first one did.",
    );
  } else if (produced !== undefined) {
    lines.push(
      `${produced.files} file(s), +${produced.insertions} −${produced.deletions}, committed on \`${produced.branch}\` at \`${produced.headSha.slice(0, 7)}\`.`,
      "",
      "**Your worktree is cut fresh from the base branch, so those commits are not in it.**",
      `If building on them beats starting over, \`git fetch origin ${produced.branch}\` and take`,
      `what is worth keeping from \`${produced.headSha.slice(0, 7)}\`; if it does not, ignore them. Either way`,
      "what you push replaces that branch.",
    );
  }

  const receipt = last.outcome?.receipt ?? null;
  if (receipt) {
    lines.push(
      "",
      `It spent ${receipt.turns} turn(s)${receipt.costUsd === null ? "" : ` and $${receipt.costUsd.toFixed(2)}`} getting there.`,
    );
  }

  const evidence = last.outcome?.evidence ?? null;
  if (evidence) {
    lines.push(
      "",
      `### What refused attempt ${last.n}`,
      "",
      `\`${evidence.what}\`:`,
      "",
      "```",
      clamp(evidence.text, budget.evidence),
      "```",
      "",
      "That output is the thing to answer. If it names what an earlier attempt has",
      "already named, the obvious fix is the one that did not work — say so plainly in",
      "your final message rather than spending a third attempt on it.",
    );
  }

  return lines.join("\n");
}

/** Verbatim, up to the bound. Truncation says so rather than trailing off. */
function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…truncated at ${max} characters.`;
}

/** One line, so a reason with a newline in it cannot break the table. */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim().slice(0, 200);
}

/**
 * The version a prompt carrying this block was rendered at.
 *
 * Two attempts whose failure context differs must be distinguishable on the log
 * rather than both reading `ticket@1911` — which is `#82`'s fourth criterion,
 * and the thing that made the defect invisible in the first place. The base is
 * the template's own version and is returned unchanged when there is no block,
 * so a first attempt's `RunStarted` and `RunPrompted` read exactly as they did.
 *
 * A hash and not a length: two different failures can be the same size, and the
 * question this answers is *was this attempt told something different*.
 */
export function promptVersionFor(base: string, failure: string): string {
  if (failure === "") return base;
  const digest = createHash("sha256").update(failure).digest("hex").slice(0, 12);
  return `${base}+failure@${digest}`;
}
