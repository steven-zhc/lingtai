/**
 * Whether a pass whose rounds are spent starts the work over, or asks a person.
 *
 * [0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)
 * is the decision and
 * [experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)
 * is the evidence. The shape it adds is one line long:
 *
 *     refusal         → round      patch, same worktree, bounded by `rounds`
 *     rounds spent    → restart    fresh pass from the base, findings carried
 *     restarts spent  → a person
 *
 * **Why the middle line is not more rounds.** A round buys another attempt at
 * *this* approach. Every refusal in 011's patching arm was about the code the
 * round before it had written — the third was a deadlock round 2 created — so
 * when the approach is the defect, each round pays to get further from a fix and
 * the ceiling's only contribution is choosing when to stop paying. `rounds`
 * bounds depth; that failure was breadth, and no value of `rounds` reaches it.
 *
 * **Why the last line is not more restarts.** A loop that restarts without a
 * bound is a money pump on a ticket that is simply wrong. The person is not
 * removed; they are moved to where their judgement is worth something, which is
 * after the *second* approach has failed rather than after the first.
 *
 * **Beside `fix.ts` and `repair.ts` and not inside either.** The three answer
 * the same question — does this refusal buy an agent — at three extents, and
 * the extent is the whole of what differs:
 *
 *   `fix.ts`     inside this pass, same worktree. The diff is still the thing
 *                everybody is talking about.
 *   here         the next pass, cut fresh from the base. The diff is what is in
 *                doubt, so it is the thing thrown away.
 *   `repair.ts`  the next run, after the *merge lane* refused. A question about
 *                blame more than about money since 0039 §Consequences.
 *
 * Everything here is a decision and nothing here does I/O, for `repair.ts`'s
 * reason: a rule about spending money that lives inside an `if` in a
 * 2,000-line file is a rule nobody can check.
 */
import type { WorkItemState } from "@lingtai/domain";
import type { FixOn } from "./fix.ts";

export type RestartDecision =
  | { restart: true; n: number; of: number }
  /** `why` is a sentence for the card, naming the rule that refused. */
  | { restart: false; why: string };

export interface RestartInput {
  /** What still refuses now that the rounds are over. */
  refusal: {
    action: string;
    /**
     * Which shape of refusal stopped the pass.
     *
     * Load-bearing rather than informational: only `findings` is a judgement,
     * and only a judgement is worth a second approach. See `decideRestart`.
     */
    on: FixOn;
    /**
     * True when the **ceiling** is what stopped the rounds.
     *
     * `FixRule` is where this comes from, and it comes from there rather than
     * from reading `decideFix`'s sentence: a fixing agent that declined, or a
     * gate that refused with nothing to hold one to, also ends a pass with a
     * live refusal and neither is answered by starting over.
     */
    exhausted: boolean;
  };
  /** `runtime.limits.restarts`. Zero is the default and is today's behaviour. */
  restarts: number;
  /** The work item, folded. Carries the bound: `restarts`. */
  item: WorkItemState;
  /**
   * What else on this pass is asking for a person, named, or null.
   *
   * A `human:` action, a `watch:` that saw a migration, or a repair. Releasing
   * the item would throw their question away, and none of them is a question a
   * fresh pass answers — so they win, and the sentence says who.
   */
  alsoAsked: string | null;
}

/**
 * Whether this spent pass buys another approach.
 *
 * **Every rule that can refuse is here, in order, and each names itself**, as in
 * `decideFix` — the first refusal wins, so the sentence on the card is the most
 * fundamental reason and not the last one checked. The
 * order is the order an operator would want to read it: does this repository
 * restart at all, is this the kind of refusal a restart answers, was the ceiling
 * what stopped it, is anybody else waiting, and only then the bound.
 */
export function decideRestart(input: RestartInput): RestartDecision {
  const { refusal, restarts, item, alsoAsked } = input;
  const no = (why: string): RestartDecision => ({ restart: false, why });

  if (restarts === 0) {
    return no(
      "this project's recipe hands a pass whose rounds are spent to a person " +
        "(runtime.limits.restarts: 0)",
    );
  }

  /**
   * **The rule 0039 §2 keeps, and the reason this extends it rather than
   * contradicting it.**
   *
   * 0039 §2 rests on *the work is still there*. For a conflict and for a red
   * build that is a fact: the branch is finished, the remedy is mechanical, and
   * throwing it away to re-implement it is the expensive wrong answer that
   * decision exists to stop. It was extended to a refused review without
   * noticing that a review says one of two very different things — *this line
   * is wrong* or *this approach is wrong* — and only for the second is the work
   * not still there.
   *
   * So the split is by what the refusal *is*, and it is in code rather than in
   * the recipe: no number a project writes down should be able to make a
   * typecheck error buy a fresh worktree.
   */
  if (refusal.on !== "findings") {
    // Named as what it is rather than as *not a judgement*, because the two
    // are read by a person and they are not the same failure: a build that
    // stayed red is a fact, and a base that keeps moving is a race.
    return no(
      (refusal.on === "conflict"
        ? `\`${refusal.action}\` is a base that moved rather than a judgement`
        : `\`${refusal.action}\` is a check that stayed red rather than a judgement`) +
        ", and for one of those the work is still there — starting over would throw " +
        "away a branch whose remedy is mechanical (0039 §2)",
    );
  }

  /**
   * **A decline is an objection, and burying it under a fresh start is the one
   * thing this must not do.**
   *
   * 0039 §5 gave the fixing agent exactly one way to say *this refusal is wrong
   * or is not this change's*: commit nothing. That ends the pass with the
   * refusal live and the objection in the agent's final message, and it reaches
   * a person through the same branch a spent ceiling does. Restarting on it
   * would spend money to discard the one verdict the loop was built to carry.
   *
   * The other refusal this excludes is a gate that produced findings with no
   * failure scenario. `decideFix` buys nothing for that because there is no
   * criterion; buying a whole pass for it here would be incoherent in the same
   * way, one extent up.
   */
  if (!refusal.exhausted) {
    return no(
      "the rounds were not spent — an agent declined, or the refusal carried nothing " +
        "to hold one to — and a second approach answers neither",
    );
  }

  if (alsoAsked !== null) {
    return no(
      `${alsoAsked} is asking for a person as well, and releasing the item would ` +
        "throw that question away",
    );
  }

  if (item.restarts.length >= restarts) {
    return no(
      `the ceiling of ${restarts} restart(s) for this item is spent, and the ` +
        `${refusal.action} reviewer still refuses`,
    );
  }

  return { restart: true, n: item.restarts.length + 1, of: restarts };
}

/**
 * Why the item is going back to the queue, as the release says it.
 *
 * This sentence has two readers and that is why it is a function rather than a
 * literal at the call site. It becomes the card's line, and it becomes the
 * `how it ended` cell in the next attempt's own prompt (`attempts.ts`) — so the
 * agent that picks the ticket up is told, in the history it is already given,
 * that the last approach was abandoned rather than merely failing. That is the
 * whole of what a restart adds to a prompt: nothing new, one honest row.
 */
export function restartReason(input: {
  action: string;
  rounds: number;
  n: number;
  of: number;
}): string {
  return (
    `the ${input.action} reviewer still refused after ${input.rounds} round(s), so this ` +
    `approach is abandoned and the ticket starts over — restart ${input.n} of ${input.of}`
  );
}

/**
 * Where an abandoned approach is published, so a later one cannot overwrite it.
 *
 * **A ref per arm, because `agent/<n>` is one ref and there are as many arms as
 * the ceiling allows.** The restart pushes the branch it is abandoning, and
 * that push is what makes the next prompt's `git fetch origin agent/<n>` true
 * (0040 §2) — but the arm after it pushes the same name, force, from a history
 * with no ancestor in common. So `agent/<n>` is the *newest* arm and this is
 * every arm: `PassRestarted` names one of these, and the claim that an arm on
 * the log is an arm that can be read is then true of all of them and not only
 * the last.
 *
 * A sibling of `agent/<n>` rather than a child of it, because git cannot hold
 * `refs/heads/agent/7` and `refs/heads/agent/7/restart-1` at once — a ref
 * cannot also be a directory. The name says which arm rather than which sha,
 * so a pass that pushed and then failed to record its arm re-pushes the same
 * name on the retry instead of stranding one.
 */
export function armBranch(branch: string, n: number): string {
  return `${branch}-restart-${n}`;
}
