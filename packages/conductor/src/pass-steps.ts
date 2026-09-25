/**
 * The six bodies of T4a — `claim`, `admit`, `prepared`, `design`, `implement`
 * and `end` — against the contract [`pass.ts`](pass.ts) already fixed.
 *
 * **Still wired to nothing** (`#259`, and `#253` before it). `runPass` takes the
 * ten bodies as a seam and defaults to `NOT_BUILT_YET`; this file is what a
 * caller hands it instead, and no caller does yet. T5 is the ticket that wires
 * it, and `pass.test.ts`'s *nothing in the conductor imports it* is the test
 * that fails the day anything but the pass's own files does.
 *
 * ## What a body is, and why these six are not empty
 *
 * [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §2b
 * divides this file from the one beside it in one sentence — *the core is the
 * sequence and the outcome rules; everything that acts is a plugin.* The loop
 * owns the sequence. **A body owns the outcome rules for one step**: it asks for
 * the step's own work and says which of the six endings that answer is, in the
 * vocabulary 0057 and 0058 §3c fix — and *which ending* is the whole of what a
 * caller downstream acts on, because a refusal buys a fix round and a
 * `did-not-finish` buys none of it.
 *
 * So the bodies here are thin on purpose and the thinness is the point: every
 * line of them is a mapping from *what happened* to *what that costs*. Nothing
 * in them spawns a process, reads GitHub, cuts a worktree or pays an agent —
 * `PassPorts` does, and it is handed in. That is why this file's tests are in
 * `unit/` and the `build` point runs them
 * ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1).
 *
 * **Why a port and not a plugin.** 0061 §3 puts `queue:` at `claim`,
 * `worktree:` at `admit` and `agent:` at `design` and `implement`, and those
 * four plugin names exist — `PLUGINS` in `@lingtai/recipe` carries them. What
 * does not exist is a cell for any of them: `KINDS_AT.claim`, `.admit`,
 * `.design` and `.implement` are all `[]`, and `whyNoKindAt` refuses every one
 * by name, saying where that code is called from instead. **Naming a thing is
 * not wiring it**, and until the cells open, the step's own work is its body's.
 * A port is what keeps that honest: the body still cannot act, so the day a cell
 * opens the body loses the call and keeps the rule.
 *
 * **Why plain promises rather than [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)'s
 * `Effect`.** `ports.ts`'s two are Effect-shaped because `run-once.ts` is, and
 * the conversion is at the boundary the *caller* stands on. `runPass` is plain,
 * its `actionsAt` and `emit` seams are plain, and a second calling convention
 * inside one file would be a thing to learn for no gain. The caller that builds
 * a live `PassPorts` from `Repo` and `AgentHost` runs the conversion there,
 * once, where it already has a runtime.
 *
 * ## What travels between the six, and how
 *
 * Three facts are made at one step and needed at a later one, and `StepWork`
 * carries none of them:
 *
 * ```
 * the item        claim → design, implement, end     the ticket's own text
 * the worktree    admit → design, implement          where an agent works
 * the design      design → implement                 and `""` is an answer
 * ```
 *
 * They are held by `bodiesFor` — one closure per pass, made where the pass is —
 * rather than on the ports, which stay stateless and therefore fakeable one
 * method at a time. The head is the exception and is the loop's: a step that
 * moved the tree says so on its ending (`LeftTheTreeAt`) and `runPass` carries
 * it to every visit after, which is why `admit` and `implement` return one and
 * nothing here reads `onSha` back.
 *
 * **What does not travel is the worktree's path into `ActionContext.cwd`.** The
 * pass rebuilds three fields of the context per visit — `onSha`, `round`,
 * `recheck` — and `cwd` is the caller's throughout (`PassOptions.context`). So a
 * declared `run:` at `prepared` or `build` runs where the *caller* said, and
 * `admit` cutting a worktree does not move it. That is T5's to close, and it is
 * named here rather than worked around: a body cannot write the context, and
 * inventing a fourth moving field is a change to the skeleton this ticket is
 * filling in.
 */
import type { ActionContext } from "@lingtai/actions";
import type { Envelope, ToAppend } from "@lingtai/domain";
// Type-only, and the shape is imported rather than redeclared for the reason
// `ports.ts` gives: a worktree's path and base sha are data, and a second
// definition of them is a drift nobody would notice.
import type { Worktree } from "@lingtai/repo";
import { resolveEndActions } from "./end-step.ts";
import {
  NEEDS_INPUT,
  NOT_BUILT_YET,
  type StepBodies,
  type StepDidNotFinish,
  type StepNeverRan,
  type StepPassed,
} from "./pass.ts";

// ------------------------------------------------------------ what a pass is about ----

/** The issue, as an agent is briefed on it. `#` and the body, and nothing else. */
export interface Ticket {
  /** The issue number, as a string — `discover.ts`'s `ref`. */
  readonly ref: string;
  readonly title: string;
  readonly body: string;
}

/** The item `claim` took, and the three things every step after it needs. */
export interface Claimed {
  /** `wi-<project>-<issue>` — `workItemStream`, and where `end` appends. */
  readonly workItemId: string;
  readonly ticket: Ticket;
  /** Which kind the recipe matched it as, which is what ordered the queue. */
  readonly kind: string;
}

/**
 * **A step stopped and asked** — 0058 §3c's `needs-input`, and the only
 * `did-not-finish` with anywhere to go.
 *
 * One shape rather than a case written three times, because exactly three steps
 * can produce it — `admit`, `design` and `implement`
 * ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §3b's
 * second drawing) — and the judge at `proposed` answers all three the same way:
 * `waiting` with the question, or that step again with *state your assumption*.
 *
 * It is on `Cut` though nothing cuts a worktree and asks a question today, and
 * that is deliberate rather than the `#61` shape it resembles: this is the
 * contract for a port **somebody else writes**, not a record of what has
 * happened. Leaving the case off `admit` would make one of 0058's own edges
 * unreachable by construction, which is a worse silence than an unused case —
 * a port cannot report what its type cannot say.
 */
export interface Asked {
  /** What the step wants answered, in words a person reads (0043). */
  readonly asked: string;
}

/**
 * **The step started and left no receipt** — 0057 §2, and the pass stops.
 *
 * A crash, a spent turn budget, an agent that ran and committed nothing. There
 * is no question in it for anybody to answer and nothing for a judge to route,
 * which is the whole of what separates it from `Asked`.
 */
export interface Stopped {
  readonly stopped: string;
}

// ----------------------------------------------------------------- the ports ----

/** What `claim` found when it asked whether it may take the item. */
export type Taken =
  | { readonly taken: Claimed }
  /**
   * GitHub is no longer offering it, with `considerIssue`'s own reason —
   * `excluded-label`, `blocked-by`, `assigned-elsewhere`. Asked rather than
   * looked up, because nothing was appended when the issue was first seen
   * ([0012](../../../doc/decisions/0012-one-task-view.md)) and a label edit
   * takes effect through this read or through nothing.
   */
  | { readonly passedOver: string }
  /**
   * Somebody else holds it, or this append lost the race — `ClaimRefusal`, and
   * losing is an ordinary outcome of two schedulers reading one queue.
   */
  | { readonly notClaimed: string };

/** What `admit` got when it cut the tree to work in. */
export type Cut =
  | { readonly worktree: Worktree }
  | Asked
  /** `RepoFailed`'s words: no mirror, no base ref, a clone that did not finish. */
  | { readonly notCut: string };

/**
 * What `design` produced — **and `""` is an answer rather than a skip.**
 *
 * 0058 §3: the step always runs and its plugin may return an empty document,
 * which is how *does this need designing* gets answered without a branch in the
 * workflow. Every pass today is the empty one: nothing writes a design yet (T9),
 * and this repository's own recipe omits the step.
 */
export type Drafted = { readonly document: string } | Asked | Stopped;

/** What the one agent at `implement` did in that worktree. */
export type Worked =
  /** The commit it left the worktree at — the whole of what moves `onSha`. */
  | { readonly committed: string }
  | Asked
  /**
   * The agent never started: a quota, a signed-out runtime — the wall that is
   * about the *account* rather than about the diff
   * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §3), whose
   * consequence is that the conductor stands down and the item is released.
   * `agent` is which runtime refused, because 0041 §3 asks for it by name.
   */
  | { readonly neverStarted: { readonly agent: string; readonly detail: string } }
  | Stopped;

/** What an agent at `design` or `implement` is handed. */
export interface Brief {
  readonly ticket: Ticket;
  /**
   * The design, and `""` where `design` produced none.
   *
   * **`implement` works from the issue when this is empty, and there is no
   * conditional step** (0058 §3): the sequence stays fixed and the judgement
   * sits in the one thing that could make it. A typo fix costs no design.
   */
  readonly design: string;
  readonly worktree: Worktree;
  /**
   * This visit's — the head it is working from, the round it is in, and the
   * findings that round was bought on (0038 §2), which an agent on a fix round
   * is asked about by name.
   */
  readonly context: ActionContext;
}

/**
 * The six steps' own work, as the pass asks for it.
 *
 * Stateless by construction: everything one step makes and another needs is held
 * by `bodiesFor`, so a test fakes one method without arranging the rest and a
 * live implementation is a wrapper over code that already exists — which is the
 * `#226` rule T2 is held to as well, *a plugin should wrap, not reimplement*.
 */
export interface PassPorts {
  /**
   * `claim` — whether this machine may take the item the pass is about, and
   * taking it.
   *
   * **The decision is not reimplemented here.** Which item is taken, by kind and
   * by label and by whether this machine may take it, is `runnableNow` and
   * `considerIssue` (`discover.ts`) over the recipe's `queue:` values, and the
   * taking is `claimWorkItem`'s append at an expected version, which is the
   * whole of the mutual exclusion (`claim.ts`).
   */
  take(): Promise<Taken>;
  /** `admit` — cut the worktree, at the base the recipe names. `repo.provision`. */
  cut(claimed: Claimed): Promise<Cut>;
  /** `design` — a document, before any code, or nothing. */
  draft(brief: Brief): Promise<Drafted>;
  /** `implement` — one agent, in that worktree, and what it committed. */
  dispatch(brief: Brief): Promise<Worked>;
  /**
   * `end` — the work item's own stream.
   *
   * Read rather than handed in, and read at `end` rather than at `claim`,
   * because `resolveEndActions` asks it two questions that are only answerable
   * this late: has this item already resolved `end` **for this outcome**, and
   * what version does the append expect. The step is also the last thing a pass
   * does, so a stream read at the claim would be nine steps stale.
   */
  read(claimed: Claimed): Promise<readonly Envelope[]>;
  /**
   * `end` — record what the step resolved, on the item's own stream.
   *
   * **Resolving and doing are two acts and neither of them is this**
   * (`end-step.ts`): the resolving is `resolveEndActions`, which the body calls;
   * this is the record of that decision, at an expected version; and carrying
   * the effects out is I/O that must not be able to undo the fact, which is
   * `tell.ts`'s and the port-owner's.
   *
   * Called only with a non-empty list, so an implementation never has to decide
   * what an empty one means. **An empty resolution is still a resolution** and is
   * *in* the list — one `EndActionsResolved` whose own `actions` are `[]`, which
   * is the row that keeps *nothing was configured* apart from *something was
   * configured and did not run* (0016 §4).
   */
  record(recording: {
    readonly claimed: Claimed;
    /** The version the append expects — `read`'s length, and the whole of the race. */
    readonly at: number;
    readonly resolved: readonly ToAppend[];
  }): Promise<void>;
}

// ---------------------------------------------------------------- the bodies ----

/**
 * The ten bodies: these six, and `NOT_BUILT_YET`'s four.
 *
 * `build`, `review`, `proposed` and `merge` are T4b and are left exactly as the
 * skeleton has them, which for `proposed` means **every refusal goes to a
 * person**: that is the correct decision while no `judge:` exists, not a
 * placeholder, because `passed` would carry a refused change to `merge` and any
 * step back would be the workflow inventing the judgement 0061 §3 reserves for a
 * plugin.
 *
 * One call per pass. The three facts that travel between steps are this
 * closure's, and a second pass wants a second closure — sharing one would let a
 * pass be briefed on the worktree of the pass before it.
 */
export function bodiesFor(ports: PassPorts): StepBodies {
  /** The item, from `claim`. Null until it has taken one. */
  let claimed: Claimed | null = null;
  /** The tree, from `admit`. Null until it has been cut. */
  let worktree: Worktree | null = null;
  /**
   * What `design` produced. `""` is the answer *this needs no design*, and is
   * every pass today — so it starts as the answer rather than as `null`, because
   * a `design` the recipe left empty never ran and `implement` is briefed the
   * same way either way.
   */
  let design = "";

  /**
   * What a step needs and the step before it made — or a throw naming which.
   *
   * A programming error about the workflow rather than something that happened
   * to a diff: `implement` is reached only after `admit` passed, and `admit`
   * passes only with a worktree. `runStep` catches it and reports it as the
   * visit's own `did-not-finish`, so the pass still reaches `end` — which is the
   * rule the whole skeleton is arranged around.
   */
  const madeBy = <T>(what: string, at: string, value: T | null): T => {
    if (value === null) {
      throw new Error(
        `the \`${what}\` step has no ${at} — the step that makes it did not run, ` +
          "and the spine says it did. This is the pass's own bookkeeping and not a " +
          "judgement about the change.",
      );
    }
    return value;
  };

  const briefOn = (step: string, context: ActionContext): Brief => ({
    ticket: madeBy(step, "item", claimed).ticket,
    design,
    worktree: madeBy(step, "worktree", worktree),
    context,
  });

  /** 0057 §2, at whichever of the three steps reported it. */
  const noReceipt = (detail: string): StepDidNotFinish => ({
    ending: "did-not-finish",
    // The pipeline's own word for the same class one layer down (`endingOf`),
    // and deliberately not `NEEDS_INPUT`: nobody was asked anything, so there is
    // nothing for the router to route and *the pass stops* is the rule.
    because: "did-not-finish",
    at: null,
    detail,
  });

  /** 0058 §3c, and the one `because` the workflow itself reads. */
  const asking = (question: string): StepDidNotFinish => ({
    ending: "did-not-finish",
    because: NEEDS_INPUT,
    // No action asked it: the step's own work did, which is why `at` is null
    // here and an action's name where `endingOf` builds one.
    at: null,
    detail: question,
  });

  return {
    ...NOT_BUILT_YET,

    /**
     * Pick the ticket.
     *
     * **It cannot refuse**, and 0058 §2 is why rather than an omission: a
     * refusal buys a fix round, holds the work item and reaches a person, and
     * `claim` has picked nothing — there is no item to hold and no diff to fix.
     * So the three answers are *took it* and two ways of *did not*, and neither
     * of those reaches the router either (`ARRIVE_AT_THE_ROUTER`).
     *
     * A pass that took nothing still runs `end`, which resolves nothing because
     * there is no stream to resolve it onto.
     */
    claim: async (): Promise<StepPassed | StepDidNotFinish> => {
      const answer = await ports.take();
      if ("taken" in answer) {
        claimed = answer.taken;
        return { ending: "passed" };
      }
      // Two tokens rather than one, because they clear differently: an issue
      // GitHub passed over comes back when a label or a blocker changes, and one
      // somebody else holds comes back when that run ends.
      return "passedOver" in answer
        ? { ending: "did-not-finish", because: "passed-over", at: null, detail: answer.passedOver }
        : { ending: "did-not-finish", because: "not-claimed", at: null, detail: answer.notClaimed };
    },

    /**
     * Start work on it — **and the worktree is cut here, so this is where the
     * `head` a pass is judged against first has a value.**
     *
     * The base sha is returned on the ending rather than kept in the closure
     * beside the worktree, because it is the loop's business and not this file's:
     * `onSha` is *the commit this verdict is about*, `stepsOn()` shows a verdict
     * only where it equals the item's head, and a pass that judged the wrong one
     * has paid for every verdict and can show none of them.
     *
     * It cannot refuse. A clone that did not finish is not a judgement about the
     * change — nothing has been written yet — so it is 0057's class and the pass
     * stops rather than buying a round to fix a repository.
     */
    admit: async ({ context }): Promise<StepPassed | StepDidNotFinish> => {
      const answer = await ports.cut(madeBy("admit", "item", claimed));
      if ("worktree" in answer) {
        worktree = answer.worktree;
        return { ending: "passed", head: answer.worktree.baseSha };
      }
      if ("asked" in answer) return asking(answer.asked);
      return {
        ending: "did-not-finish",
        because: "worktree",
        at: null,
        // The head is the caller's base still, so the detail is all a person has.
        detail: `${answer.notCut} (nothing was cut at ${context.onSha.slice(0, 12)})`,
      };
    },

    /**
     * The tree is ready to be worked in — **and this is the one of the six whose
     * work is entirely declarable today, so its body is nothing beyond its
     * plugins.**
     *
     * `prepared`'s plugin is `run:` carrying the command (0061 §3), and
     * `KINDS_AT.prepared` is the one row of these six that is open: this
     * repository declares `pnpm install --frozen-lockfile` with a `10m` timeout
     * and nothing else. The loop has already run that list by the time this is
     * called, and `endingOf` has already read a `failed` verdict at a refusing
     * step as a **refusal** — so there is nothing left for the body to do, and
     * writing a second install here would be the reimplementation 0061 §3 exists
     * to prevent.
     *
     * **That is why it is the body that proves the refusal path**, and why the
     * proof is a test rather than a line of code: `prepared` is the first step in
     * the pass that may refuse, a failed install is the cheapest refusal there
     * is — *refuse before money is spent* — and the refusal has to travel, to
     * `proposed`, carrying its reason, and be answered there. Nothing between the
     * install and the person is this body's; all of it is the skeleton's, and the
     * test is what says the skeleton carries something real rather than a fixture.
     */
    prepared: async (): Promise<StepPassed> => ({ ending: "passed" }),

    /**
     * A document, before any code — **or nothing, which is an answer** (0058 §3).
     *
     * An empty document is `passed`, not a skip and not a failure: the step ran,
     * it decided this change needs no design, and `implement` is briefed with
     * `""` and works from the issue. A conditional step would have put that
     * judgement in the workflow, where nothing knows enough to make it.
     *
     * It cannot refuse — a design is not a judgement about a diff, there being
     * no diff yet — but it can ask, and 0058 §3b draws that edge.
     */
    design: async ({ context }): Promise<StepPassed | StepDidNotFinish> => {
      const answer = await ports.draft(briefOn("design", context));
      if ("document" in answer) {
        design = answer.document;
        return { ending: "passed" };
      }
      if ("asked" in answer) return asking(answer.asked);
      return noReceipt(answer.stopped);
    },

    /**
     * One agent, in that worktree — **and it reports the `head` it committed**,
     * which is the whole of what moves `onSha` on a fix round.
     *
     * Three ways not to pass, and the money is the reason they are three and not
     * one. An agent that **asked** buys a decision at `proposed` and nothing
     * else (0058 §3c). An agent that **started and left no receipt** buys
     * nothing and stands the pass down (0057 §2) — a crash, a spent turn budget,
     * or a run that committed nothing, since the commit *is* the receipt. An
     * agent that **never started** stands the *conductor* down and releases the
     * item, because what it met is about the account rather than the diff and
     * every queued item would meet it identically (0031 §3) — six of them did,
     * eighty events in ninety-two seconds.
     *
     * It cannot refuse, and that is 0058 §3b's rectangle: arriving at the router
     * and refusing are different things, and only one of them is charged for.
     */
    implement: async ({ context }): Promise<StepPassed | StepDidNotFinish | StepNeverRan> => {
      const answer = await ports.dispatch(briefOn("implement", context));
      if ("committed" in answer) return { ending: "passed", head: answer.committed };
      if ("asked" in answer) return asking(answer.asked);
      if ("neverStarted" in answer) {
        return {
          ending: "never-ran",
          at: answer.neverStarted.agent,
          detail: answer.neverStarted.detail,
        };
      }
      return noReceipt(answer.stopped);
    },

    /**
     * Runs on every ending and cannot refuse — **and the effects never decide
     * whether the ending happened.**
     *
     * That rule is `end-step.ts`'s reason for existing and it survives the move:
     * the outcome is `outcomeOf`'s, computed by the loop before this is called,
     * off where the pass came to rest. This body reads it and resolves the
     * declared list against it; it does not compute it, it cannot change it, and
     * `PassResult.stoppedAt` is never `end` — so a `close:` that fails to resolve
     * after a merge landed does not turn a landing into a block.
     *
     * **`resolveEndActions` is called rather than reimplemented**, and the two
     * things it knows are exactly the two a port would get wrong. It filters by
     * `when:`, which is the whole safety of `refs:` (`#240`): a `when: landed`
     * that met a block resolves to nothing, and for an item that did not land
     * those refs are the only surviving account of what was tried. And it
     * resolves **once per outcome**, off the item's own stream, so an item that
     * was blocked, came back and then landed resolves twice for two different
     * outcomes and never twice for one.
     *
     * **A pass that claimed nothing resolves nothing**, and that is not the skip
     * 0016 §4 refuses: `EndActionsResolved` lives on the work item's stream, and
     * a pass whose `claim` took no item has no stream to append it to. There is
     * no item for the audit to find either, so nothing goes quiet.
     */
    end: async ({ actions, outcome }): Promise<StepPassed> => {
      if (claimed === null) return { ending: "passed" };
      const events = await ports.read(claimed);
      const resolved = resolveEndActions(events, actions, outcome);
      // Empty is *nothing declared* or *already resolved for this outcome*, and
      // neither is a row. A step that resolved a declared list down to no effects
      // is not empty here: that is one row whose own `actions` are `[]`.
      if (resolved.length > 0) await ports.record({ claimed, at: events.length, resolved });
      return { ending: "passed" };
    },
  };
}
