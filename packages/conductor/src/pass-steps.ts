/**
 * The six bodies of T4a — `claim`, `admit`, `prepared`, `design`, `implement`
 * and `end` — against the contract [`pass.ts`](pass.ts) already fixed.
 *
 * **Still wired to nothing** (`#259`, and `#253` before it). `runPass` takes the
 * ten bodies as a seam and defaults to `NOT_BUILT_YET`; this file is what a
 * caller hands it instead, and no caller does yet. T5 is the ticket that wires
 * it, and `pass.test.ts`'s *nothing in the conductor imports it* is the test that
 * fails the day anything but the pass's own two files does.
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
 * `worktree:` at `admit` and `agent:` at `design` and `implement`, and those four
 * plugin names exist — `PLUGINS` in `@lingtai/recipe` carries them. What does
 * not exist is a cell for any of them: `KINDS_AT.claim`, `.admit`, `.design` and
 * `.implement` are all `[]` (`recipe.ts:769`), and `whyNoKindAt` refuses every
 * one by name, saying where that code is called from instead. **Naming a thing
 * is not wiring it**, and until the cells open, the step's own work is its
 * body's. A port is what keeps that honest: the body still cannot act, so the
 * day a cell opens the body loses the call and keeps the rule.
 *
 * **Why plain promises rather than [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)'s
 * `Effect`.** `ports.ts`'s two are Effect-shaped because `run-once.ts` is, and
 * the conversion is at the boundary the *caller* stands on. `runPass` is plain,
 * its `actionsAt` and `emit` seams are plain, and a second calling convention
 * inside one file would be a thing to learn for no gain. The caller that builds
 * a live `PassPorts` from `Repo` and `AgentHost` runs the conversion there, once,
 * where it already has a runtime.
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
 * They are held by `bodiesFor`, cleared at `claim` so one closure may conduct one
 * pass after another, rather than on the ports, which stay stateless and
 * therefore fakeable one method at a time.
 *
 * **What the loop already carries is read off `StepWork` and never kept here**,
 * and there are two of those. The head: a step that moved the tree says so on its
 * ending (`LeftTheTreeAt`) and `runPass` carries it to every visit after, which
 * is why `admit` and `implement` return one and nothing here reads `onSha` back.
 * And the route back: which visit sent the pass to this step and why is in
 * `reached`, so `SentBack` is computed from the visit list rather than remembered
 * — a body that remembered it would have to know how many rounds ago it was.
 *
 * **What does not travel is the worktree's path into `ActionContext.cwd`.** The
 * pass rebuilds three fields of the context per visit — `onSha`, `round`,
 * `recheck` — and `cwd` is the caller's throughout (`PassOptions.context`). So a
 * declared `run:` at `prepared` or `build` runs where the *caller* said, and
 * `admit` cutting a worktree does not move it. That is T5's to close, and it is
 * named here rather than worked around: a body cannot write the context, and
 * inventing a fourth moving field is a change to the skeleton this ticket is
 * filling in.
 *
 * ## What the pass does not write
 *
 * **The item's ending.** `outcomeOf` says which of the four it is and
 * `PassResult` reports it, and appending `WorkItemLanded`, `WorkItemBlocked` or
 * `WorkItemReleased` belongs to whoever holds the claim — `run-once.ts` today,
 * T5's caller after it. `end` here resolves the declared effects against that
 * outcome and records the resolution, which is 0058 §3's *runs on every ending*
 * and the whole of what the ticket asks for; the effects never decide whether
 * the ending happened, and neither does this file's failure to resolve them.
 */
import type { ActionContext } from "@lingtai/actions";
import type { Envelope, Step, ToAppend } from "@lingtai/domain";
// Type-only, and the shape is imported rather than redeclared for the reason
// `ports.ts` gives: a worktree's path and base sha are data, and a second
// definition of them is a drift nobody would notice.
import type { Worktree } from "@lingtai/repo";
import { type TerminalOutcome, resolveEndActions } from "./end-step.ts";
import {
  NEEDS_INPUT,
  NOT_BUILT_YET,
  type StepBodies,
  type StepDidNotFinish,
  type StepNeverRan,
  type StepPassed,
  type StepReached,
} from "./pass.ts";

// -------------------------------------------------- what a pass is about ----

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
 * unreachable by construction, which is a worse silence than an unused case — a
 * port cannot report what its type cannot say.
 */
export interface Asked {
  /** What the step wants answered, in words a person reads (0043). */
  readonly asked: string;
}

/**
 * **The judge's other answer, as it reaches the step it was written for.**
 *
 * `Asked` above says the judge at `proposed` may answer a question with `waiting`
 * *or that step again with* state your assumption. The second of those spends a
 * round — `onOffer` puts the asking step back on the offer, and `runPass` walks
 * into it again — and a round costs an agent run. So the step must be run
 * *differently* the second time, and the only thing that can make it different is
 * what the judge said: `context.recheck` is empty on this edge, because a
 * question raised no findings, and `context.onSha` is unchanged, because nothing
 * was committed. A second byte-identical brief buys the same question back and
 * burns every round in `ceilings.rounds` arriving at the answer the first one did.
 *
 * Read off `StepWork.reached` rather than held in the closure, because it is the
 * *loop's* fact and not a step's: which visit routed here, and why, is in the
 * visit list the pass hands every body.
 */
export interface SentBack {
  /**
   * The judge's own words — *state your assumption* — verbatim, and 0043's rule
   * again: it is prose for an agent and a person, never a token to parse.
   */
  readonly why: string;
  /**
   * The question this step asked, where the round was bought on its own
   * `needs-input`. `null` where the judge sent the pass back for some other
   * reason — a refusal downstream, whose evidence is `context.recheck`'s.
   */
  readonly asked: string | null;
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

/**
 * **The agent never started** — 0031 §1's `never-started`, and the wall that is
 * about the *account* rather than about the diff: a quota, a signed-out runtime,
 * `You've hit your session limit`. Zero turns and zero cost.
 *
 * One shape shared by the two steps that dispatch an agent, for the reason
 * `Asked` is shared by the three that can ask: **a port cannot report what its
 * type cannot say**, and leaving it off one of them makes the difference
 * disappear at exactly that step. 0061 §3's table puts `agent:` at `design` as
 * well as at `implement`, so a design agent meets this wall identically — and
 * without this case the port's only truthful answer there was `Stopped`, which
 * the body maps to `did-not-finish`: the item is held for a person, nothing
 * signals the account-wide condition, and the next queue pass claims the next
 * ticket and walks into the same wall. That is 0031's own incident — eighty
 * events and six claims in ninety-two seconds — and it is the silence this
 * file's `Asked` calls worse than an unused case.
 *
 * What it costs instead is 0031 §3: the conductor stands down and the item is
 * **released**, because every queued item would meet this identically. The pass
 * reports `never-ran`, `outcomeOf` reads `failed`, and the claim goes back.
 *
 * `agent` is which runtime refused, because 0041 §3 asks for it by name.
 */
export interface NeverStarted {
  readonly neverStarted: { readonly agent: string; readonly detail: string };
}

// ----------------------------------------------------------- the ports ----

/** What `claim` found when it asked whether it may take the item. */
export type Taken =
  | { readonly taken: Claimed }
  /**
   * GitHub is no longer offering it, with `considerIssue`'s own reason —
   * `excluded-label`, `blocked-by`, `assigned-elsewhere`. Asked rather than
   * looked up, because nothing was appended when the issue was first seen
   * ([0012](../../../doc/decisions/0012-one-task-view.md)) and a label edit takes
   * effect through this read or through nothing.
   */
  | { readonly passedOver: string }
  /**
   * Somebody else holds it, or this append lost the race — `ClaimRefusal`, and
   * losing is an ordinary outcome of two schedulers reading one queue.
   */
  | { readonly notClaimed: string }
  /**
   * **The claim may have committed** — the one answer that is neither taking it
   * nor leaving it alone, and the reason there are four cases rather than three.
   *
   * `claimWorkItem` appends `WorkItemClaimed` at an expected version and answers
   * a `ConcurrencyError` with `lost-race`; every other failure of that append
   * **throws**, and an append that committed and then lost its connection throws
   * the same way. So there is a state in which the item is held by this run and
   * the port has no result to show for it, and the pass is the only component
   * that knows which item that was.
   *
   * A port that lets the throw escape gets `runStep`'s generic `did-not-finish`,
   * which names no item: `PassResult` then says `claim` threw and nothing —
   * including the caller that would append the ending — can say what is held.
   * Reported here instead, so the pass stops with the item named, `end` resolves
   * against the stream it may be on, and a person or the next conductor's
   * reconcile has something to act on.
   */
  | { readonly mayHold: { readonly workItemId: string; readonly detail: string } };

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
 * workflow. Every pass today is the empty one: nothing writes a design yet, and
 * this repository's own recipe declares nothing at the step.
 */
export type Drafted = { readonly document: string } | Asked | NeverStarted | Stopped;

/** What the one agent at `implement` did in that worktree. */
export type Worked =
  /** The commit it left the worktree at — the whole of what moves `onSha`. */
  | { readonly committed: string }
  | Asked
  | NeverStarted
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
   * **Why this step is being run a second time**, or `null` on the way through.
   *
   * The whole of what makes a re-run brief different from the first one when the
   * round was bought on a question: see `SentBack`. An implementation hands it to
   * the agent beside the ticket — *you asked this, and the judge said that* — and
   * a port that ignores it dispatches the brief that produced the question.
   */
  readonly again: SentBack | null;
  /**
   * This visit's — the head it is working from, the round it is in, and the
   * findings that round was bought on (0038 §2), which an agent on a fix round is
   * asked about by name.
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
   * taking is `claimWorkItem`'s append at an expected version, which is the whole
   * of the mutual exclusion (`claim.ts`).
   */
  take(): Promise<Taken>;
  /**
   * `admit` — cut the worktree, at the base the recipe names. `repo.provision`.
   *
   * `again` is beside the item rather than inside a `Brief` because there is no
   * brief at `admit`: the worktree an agent is briefed on is what this step
   * makes. It carries the same thing for the same reason — a step routed back to
   * must be run differently, and `admit` is one of the three that can ask
   * (`SentBack`).
   */
  cut(claimed: Claimed, again: SentBack | null): Promise<Cut>;
  /**
   * `design` — a document, before any code, or nothing.
   *
   * The same four answers as `dispatch` below, because 0061 §3 puts `agent:` at
   * both steps and an agent meets the same walls at either: `""` is *this needs
   * no design*, and the other three are a question, a wall about the account, and
   * a run that left no receipt (`NeverStarted`).
   */
  draft(brief: Brief): Promise<Drafted>;
  /** `implement` — one agent, in that worktree, and what it committed. */
  dispatch(brief: Brief): Promise<Worked>;
  /**
   * `end` — the work item's own stream.
   *
   * Read rather than handed in, and read at `end` rather than at `claim`, because
   * `resolveEndActions` asks it two questions that are only answerable this late:
   * has this item already resolved `end` **for this outcome**, and what version
   * does the append expect. The step is also the last thing a pass does, so a
   * stream read at the claim would be nine steps stale.
   */
  readEnd(workItemId: string): Promise<readonly Envelope[]>;
  /**
   * `end` — **what the step resolved, on the item's own stream, at the version
   * the read gave.**
   *
   * `appendEndActions` in [`end-step.ts`](end-step.ts) is a live implementation
   * of this and nothing else: it is that module's own entry point *for the one
   * caller that cannot batch*, and the pass is one. Batching is the caller's
   * because the *ending* is the caller's — the pass says which outcome was
   * reached and does not append it (see this file's opening) — so a port here
   * that took a store and a terminal event would be the pass writing an item's
   * ending on the way past.
   *
   * It is handed a plan rather than an outcome, and that is the wiring the ticket
   * asks for rather than a rewrite: what `when:` matches and what has already
   * been resolved are `resolveEndActions`'s, called by the body against the
   * events this port just returned. **The two rules that live in that call are
   * the two a port would get wrong.** It filters by `when:`, which is the whole
   * safety of `refs:` (`#240`) — a `when: landed` that met a block resolves to
   * nothing, and for an item that did not land those refs are the only surviving
   * account of what was tried. And it resolves once per outcome, so an item that
   * was blocked, came back and then landed resolves twice for two different
   * outcomes and never twice for one.
   *
   * Carrying the list out is `tell.ts`'s and is deliberately not here: resolving
   * is a fact and belongs on the log, and doing is I/O that must not be able to
   * undo it.
   */
  recordEnd(workItemId: string, at: number, plan: readonly ToAppend[]): Promise<void>;
}

/**
 * **`end` did not get its resolution onto the stream** — and the pass reached
 * its ending anyway.
 *
 * A token rather than a sentence, because a caller acts on it: this is the one
 * way the last step can fail, and what it means is *the outcome stands and the
 * declared effects have not been recorded*. It is a `did-not-finish`, so it buys
 * no fix round and reaches no judge, and `PassResult.stoppedAt` is never `end` —
 * a `close:` that could not be resolved does not turn a landing into a block.
 *
 * Which of the step's three acts threw is on `detail`, for a person; nothing
 * branches on it, because the item's own stream says what was resolved and what
 * was not, and that is what `lingtai end replay` reads.
 */
export const END_UNRESOLVED = "end-unresolved";

/**
 * The ten bodies, six of them written.
 *
 * `NOT_BUILT_YET`'s four are kept for `build`, `review`, `proposed` and `merge`,
 * which are T4b — including its router, which sends every refusal to a person
 * while no `judge:` is built. So a pass run with these ports walks the whole
 * spine, and a refusal at `prepared` travels to `proposed` and rests with
 * somebody, which is the correct behaviour for a system with no judge in it.
 *
 * One closure conducts one pass at a time: the three facts below are the pass's,
 * and `claim` clears them.
 */
export function bodiesFor(ports: PassPorts): StepBodies {
  /** The item, from `claim`. Null until it has taken one. */
  let claimed: Claimed | null = null;
  /**
   * The stream `end` resolves onto, or null where the pass is about no item.
   *
   * Beside `claimed` rather than read off it, because the two are not the same
   * question: a `mayHold` gives the pass a stream and no ticket, and `end` needs
   * only the first of those.
   */
  let onStream: string | null = null;
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
   * A programming error about the workflow rather than something that happened to
   * a diff: `implement` is reached only after `admit` passed, and `admit` passes
   * only with a worktree. `runStep` catches it and reports it as the visit's own
   * `did-not-finish`, so the pass still reaches `end` — which is the rule the
   * whole skeleton is arranged around.
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

  /**
   * **Why the pass is at this step a second time, read off the visits** — or
   * `null`, which is every visit on the way through.
   *
   * The route is the last visit when a body is re-entered: `runPass` records
   * `proposed`'s decision and then walks straight into the step it chose. The
   * question is the visit before that one, and only where *this* step asked it —
   * a route back to `implement` from a `build` that refused carries findings
   * rather than a question, and `context.recheck` is where those are.
   */
  const sentBackTo = (step: Step, reached: readonly StepReached[]): SentBack | null => {
    const judged = reached.at(-1);
    if (judged === undefined || judged.step !== "proposed") return null;
    const route = judged.ending;
    if (route.ending !== "routed" || route.to !== step) return null;
    const arrived = reached.at(-2);
    const asked =
      arrived !== undefined &&
      arrived.step === step &&
      arrived.ending.ending === "did-not-finish" &&
      arrived.ending.because === NEEDS_INPUT
        ? arrived.ending.detail
        : null;
    return { why: route.why, asked };
  };

  const briefOn = (
    step: Step,
    work: { context: ActionContext; reached: readonly StepReached[] },
  ): Brief => ({
    ticket: madeBy(step, "item", claimed).ticket,
    design,
    worktree: madeBy(step, "worktree", worktree),
    again: sentBackTo(step, work.reached),
    context: work.context,
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

  /**
   * 0031 §3, at whichever of the two steps dispatched the agent.
   *
   * Shared rather than written twice, because the whole value of the case is
   * that `design` and `implement` answer the same wall the same way: a body that
   * spelled it out at one of them is a body that can be changed at one of them.
   */
  const stoodDown = (wall: NeverStarted["neverStarted"]): StepNeverRan => ({
    ending: "never-ran",
    at: wall.agent,
    detail: wall.detail,
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
     * **It cannot refuse**, and 0058 §2 is why rather than an omission: a refusal
     * buys a fix round, holds the work item and reaches a person, and `claim` has
     * picked nothing — there is no item to hold and no diff to fix. So the
     * answers are *took it* and three ways of *did not*, and none of those
     * reaches the router either (`ARRIVE_AT_THE_ROUTER`).
     *
     * **It is also where a pass begins**, which is why the four facts are cleared
     * here and not left from the pass before: see `bodiesFor`.
     */
    claim: async (): Promise<StepPassed | StepDidNotFinish> => {
      // Before the answer, not after it — the three ways `take` can decline set
      // no item, and it was exactly those that would let `end` resolve onto the
      // item the pass before had landed.
      claimed = null;
      onStream = null;
      worktree = null;
      design = "";
      const answer = await ports.take();
      if ("taken" in answer) {
        claimed = answer.taken;
        onStream = answer.taken.workItemId;
        return { ending: "passed" };
      }
      if ("mayHold" in answer) {
        // The one decline that leaves a stream behind: `end` still resolves
        // against it, because an item this run may be holding is one somebody
        // has to be told about.
        onStream = answer.mayHold.workItemId;
        return {
          ending: "did-not-finish",
          because: "claim-unconfirmed",
          at: null,
          detail: `${answer.mayHold.workItemId} may be claimed by this run: ${answer.mayHold.detail}`,
        };
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
    admit: async ({ context, reached }): Promise<StepPassed | StepDidNotFinish> => {
      const answer = await ports.cut(madeBy("admit", "item", claimed), sentBackTo("admit", reached));
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
     * `KINDS_AT.prepared` is the one row of these six that is open
     * (`recipe.ts:775`): the recipe this repository is conducted by declares one
     * command there and nothing else — `pnpm install --frozen-lockfile`, with a
     * `10m` timeout (`.lingtai/config.yaml:113`). The loop has already run that
     * list by the time this is called, and `endingOf` has already read a `failed`
     * verdict at a refusing step as a **refusal** — so there is nothing left for
     * the body to do, and a second install written here would be the
     * reimplementation 0061 §3 exists to prevent.
     *
     * **That is why it is the step that proves the refusal path, and why the
     * proof is a test rather than a line of code.** `prepared` is the first step
     * in the pass that may refuse, a failed install is the cheapest refusal there
     * is — *refuse before money is spent* — and the refusal has to travel: to
     * `proposed`, carrying its reason, answered there, with the person shown the
     * install that failed rather than the router that sent it to them. Every one
     * of those joins is the skeleton's, and `pass-steps.test.ts`'s *a failed
     * install refuses, and the refusal reports like any other* is what says they
     * carry something real rather than a fixture.
     *
     * The day something at `prepared` is not declarable — a check the recipe has
     * no key for — this body gets a port and an ending, and the type already
     * permits the refusal: `prepared` is one of `REFUSING_STEPS`.
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
     * It cannot refuse — a design is not a judgement about a diff, there being no
     * diff yet — but it can ask, and 0058 §3b draws that edge.
     *
     * **And it stands the conductor down on the same wall `implement` does.**
     * `agent:` is declared at both steps (0061 §3), so a design agent meets
     * `You've hit your session limit` identically, and the answer has to be the
     * same one: `never-ran`, released, 0031 §3. Reported as `did-not-finish` it
     * would hold the item for a person and leave the account-wide condition
     * unsaid, and the next queue pass would claim the next ticket and meet the
     * same wall — which is 0031's own incident.
     */
    design: async ({ context, reached }): Promise<StepPassed | StepDidNotFinish | StepNeverRan> => {
      const answer = await ports.draft(briefOn("design", { context, reached }));
      if ("document" in answer) {
        design = answer.document;
        return { ending: "passed" };
      }
      if ("asked" in answer) return asking(answer.asked);
      if ("neverStarted" in answer) return stoodDown(answer.neverStarted);
      return noReceipt(answer.stopped);
    },

    /**
     * One agent, in that worktree — **and it reports the `head` it committed**,
     * which is the whole of what moves `onSha` on a fix round.
     *
     * Three ways not to pass, and the money is the reason they are three and not
     * one. An agent that **asked** buys a decision at `proposed` and nothing else
     * (0058 §3c). An agent that **started and left no receipt** buys nothing and
     * stands the pass down (0057 §2) — a crash, a spent turn budget, or a run
     * that committed nothing, since the commit *is* the receipt. An agent that
     * **never started** stands the *conductor* down and releases the item,
     * because what it met is about the account rather than the diff and every
     * queued item would meet it identically (0031 §3).
     *
     * It cannot refuse, and that is 0058 §3b's rectangle: arriving at the router
     * and refusing are different things, and only one of them is charged for.
     */
    implement: async ({
      context,
      reached,
    }): Promise<StepPassed | StepDidNotFinish | StepNeverRan> => {
      const answer = await ports.dispatch(briefOn("implement", { context, reached }));
      if ("committed" in answer) return { ending: "passed", head: answer.committed };
      if ("asked" in answer) return asking(answer.asked);
      if ("neverStarted" in answer) return stoodDown(answer.neverStarted);
      return noReceipt(answer.stopped);
    },

    /**
     * Runs on every ending and cannot refuse — **and the effects never decide
     * whether the ending happened.**
     *
     * That rule is `end-step.ts`'s reason for existing and it survives the move.
     * The outcome is the loop's: `outcomeOf` computes it from where the pass came
     * to rest, before this is called. This body reads it and resolves the
     * declared list against it; it does not compute it, it cannot change it, and
     * `PassResult.stoppedAt` is never `end` — so a `close:` that could not be
     * resolved after a merge landed does not turn a landing into a block.
     *
     * **`resolveEndActions` is called rather than reimplemented**, which is the
     * wiring this ticket asks for. What it knows — which cells `when:` matches,
     * and that a point resolves once per outcome — is named on
     * `PassPorts.recordEnd`, where the seam is.
     *
     * **A pass with no stream behind it resolves nothing.** `EndActionsResolved`
     * lives on the work item's stream, and a `claim` that took no item leaves
     * none to append to; a `claim` that may have taken one leaves a stream and no
     * ticket, and that is enough for this step (`Taken`'s `mayHold`). What the
     * body must not do either way is throw, because the ending it is running for
     * has already happened.
     *
     * An empty plan is not an append. Both of the ways it can be empty are
     * already decisions the log holds: nothing declared, which `GatesResolved`
     * records, and this outcome already resolved, which the item's own
     * `EndActionsResolved` records.
     */
    end: async ({ actions, outcome }): Promise<StepPassed | StepDidNotFinish> => {
      const workItemId = onStream;
      if (workItemId === null) return { ending: "passed" };
      // Which of the step's three acts did not finish, for the person reading
      // `detail`. The plan is empty until `resolveEndActions` has answered, so a
      // `read` that threw cannot be mistaken for a recorded nothing.
      let act = "read";
      try {
        const events = await ports.readEnd(workItemId);
        act = "resolve";
        const plan = resolveEndActions(events, actions, outcome);
        if (plan.length === 0) return { ending: "passed" };
        act = "record";
        await ports.recordEnd(workItemId, events.length, plan);
        return { ending: "passed" };
      } catch (error) {
        return {
          ending: "did-not-finish",
          because: END_UNRESOLVED,
          // No action asked it: the step's own work did — the same reason
          // `asking` and `noReceipt` above are `null` here.
          at: null,
          detail:
            `${workItemId} reached \`${outcome}\` and its \`end\` effects were not resolved — ` +
            `\`${act}\` threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
