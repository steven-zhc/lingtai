/**
 * **The ten bodies**, against the contract [`pass.ts`](pass.ts) already fixed —
 * `claim`, `admit`, `prepared`, `design`, `implement` and `end` from T4a
 * (`#259`), and `build`, `review`, `proposed` and `merge` from T4b (`#254`).
 *
 * **Still wired to nothing** (`#254`, `#259`, and `#253` before them). `runPass`
 * takes the ten bodies as a seam and defaults to `NOT_BUILT_YET`; this file is
 * what a caller hands it instead, and no caller does yet. T5 is the ticket that
 * wires it, and `pass.test.ts`'s *nothing in the conductor imports it* is the test
 * that fails the day anything but the pass's own two files does.
 *
 * **Three of the ten are nothing beyond their plugins** — `prepared`, `build` and
 * `review` — and that is the shape of them rather than an unfinished body: their
 * work is a `run:` carrying commands and an `agent:` reading the diff, the loop
 * has run both by the time either is called, and the step's part is the outcome
 * rules. `endingOf` is where `review`'s is, because a reviewer's `failed` verdict
 * arrives before any body could see it.
 *
 * ## What a body is, and why most of them are not empty
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
 * **Two of the ports are not waiting on a cell at all**, and they are the other
 * half of the same table: `judge:` at `proposed` and `merge:` at `merge` are two
 * of the five *columns* `KINDS_AT` carries at no step, and `CALLED_DIRECTLY` is
 * what their cells are refused with — *they name code the pass calls itself.* So
 * `ports.judge` and `ports.land` are not stand-ins for a plugin that will exist;
 * they are the seam that plugin was always going to be reached through.
 *
 * **Why plain promises rather than [0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)'s
 * `Effect`.** `ports.ts`'s two are Effect-shaped because `run-once.ts` is, and
 * the conversion is at the boundary the *caller* stands on. `runPass` is plain,
 * its `actionsAt` and `emit` seams are plain, and a second calling convention
 * inside one file would be a thing to learn for no gain. The caller that builds
 * a live `PassPorts` from `Repo` and `AgentHost` runs the conversion there, once,
 * where it already has a runtime.
 *
 * ## What travels between the steps, and how
 *
 * Three facts are made at one step and needed at a later one, and `StepWork`
 * carries none of them:
 *
 * ```
 * the item        claim → design, implement, merge, end   the ticket's own text
 * the worktree    admit → design, implement, merge         where an agent works
 * the design      design → implement                      and `""` is an answer
 * ```
 *
 * They are held by `bodiesFor`, cleared at `claim` so one closure may conduct one
 * pass after another, rather than on the ports, which stay stateless and
 * therefore fakeable one method at a time.
 *
 * **What the loop already carries is read off `StepWork` and never kept here**,
 * and there are three of those. The head: a step that moved the tree says so on
 * its ending (`LeftTheTreeAt`) and `runPass` carries it to every visit after, which
 * is why `admit` and `implement` return one and nothing here reads `onSha` back.
 * The route back: which visit sent the pass to this step and why is in
 * `reached`, so `SentBack` is computed from the visit list rather than remembered
 * — a body that remembered it would have to know how many rounds ago it was.
 * **And `review`'s findings**, which is the one a fourth closure variable would be
 * most tempting for: they are its plugins' verdicts, they are on
 * `StepReached.results`, and `proposed` reads them off the visit list one step
 * later (`reviewRefused`). A copy here would be a second source of truth for the
 * sentence the pass is already holding in memory.
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
import type { ActionContext, ActionFinding } from "@lingtai/actions";
import type { Envelope, RefusalReason, Step, ToAppend } from "@lingtai/domain";
// Type-only, and the shape is imported rather than redeclared for the reason
// `ports.ts` gives: a worktree's path and base sha are data, and a second
// definition of them is a drift nobody would notice.
import type { Worktree } from "@lingtai/repo";
import type { BuiltInJudge, JudgeWhen } from "@lingtai/recipe";
import { type TerminalOutcome, resolveEndActions } from "./end-step.ts";
import { BUILT_IN_FOR } from "./judge.ts";
import {
  NEEDS_INPUT,
  NOT_BUILT_YET,
  type Destination,
  type StepBodies,
  type StepDidNotFinish,
  type StepNeverRan,
  type StepPassed,
  type StepReached,
  type StepRefused,
  type StepRouted,
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
 * **And the same holds for the round a mechanical refusal buys**, which is where
 * the money is: a red `build` routed back to `implement` committed nothing and
 * raised no findings either — a `run:` action returns `findings: []`
 * (`process-action.ts`) — so `context.recheck` is empty too, and the compiler's
 * three errors exist nowhere on this object unless `printed` carries them. The
 * loop this replaces put them in the prompt by name (`fix.ts`, *## What
 * `${action}` printed*), and an agent sent back without them is ~31 turns and
 * ~$3.40 spent on being told only that something failed.
 *
 * Read off `StepWork.reached` rather than held in the closure, because it is the
 * *loop's* fact and not a step's: which visit routed here, with what it said and
 * why, is in the visit list the pass hands every body.
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
   * reason, and then `printed` is what that reason said.
   */
  readonly asked: string | null;
  /**
   * **What the step that did not pass printed, and which step printed it** — the
   * compiler's errors from a red `build`, the lane's `detail` from a refused
   * `merge` — or `null`.
   *
   * It is the criterion the round was bought on, in the one case findings are
   * not: *run it again; green is green* (0038 §2), which is the same bar
   * `carriesACriterion` holds the judge to one step earlier. A brief that omits
   * it asks an agent to fix a failure it has not been shown.
   *
   * `null` in the two cases where it would say nothing new. Where this step's own
   * question bought the round, `asked` is the same words. And on the way through
   * — a `review` that passed carrying findings — nothing refused and nothing
   * printed: those findings travel on `context.recheck`, which is the path 0038
   * §2 is written for.
   */
  readonly printed: { readonly step: Step; readonly detail: string } | null;
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
   * round was bought on a question or on what a step printed: see `SentBack`. An
   * implementation hands it to the agent beside the ticket — *you asked this, and
   * the judge said that*, or *`build` printed this* — and a port that ignores it
   * dispatches the brief that produced the failure.
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
 * What `merge` was asked to land, and it is the same three facts `IntegrateOptions`
 * asks for under its own names.
 *
 * There is no *did the steps pass* here, and that absence is the sequence:
 * `merge` is reached only where every step before it passed, so a lane told
 * otherwise would be a lane told something the pass cannot be in a position to
 * say. `context.onSha` is `headSha` — **the commit the steps gave their verdicts
 * about**, which is what makes the merge the one the review was of.
 */
export interface Landing {
  readonly claimed: Claimed;
  readonly worktree: Worktree;
  readonly context: ActionContext;
}

/**
 * What the merge lane answered — `IntegrateResult`'s two cases, and no third.
 *
 * **`notMerged` is a report and not a verdict**, which is the whole of *`merge`
 * reports a `reason` and a `detail` and decides nothing*: over the whole log it
 * has refused 32 times, **26 `gate-failed` and 6 `conflict`**, and the common
 * failure is that somebody else's work landed and the diff stopped being true.
 * That is a fact about the world. Whether it is worth another agent or a person
 * is the judge's at `proposed`, and the lane is not asked.
 *
 * `reason` is `RefusalReason` because those are the lane's own words and they are
 * already on the log — two of them, `conflict` and `gate-failed`, are also
 * `JudgeWhen` values, and the other five are directions no judge is offered
 * (`JudgeWhen`'s own doc: they stop the lane before the diff is what is in
 * doubt).
 */
export type Landed =
  /** The merge commit on the base branch. Not a worktree head: nothing local moved. */
  | { readonly merged: string }
  | { readonly notMerged: { readonly reason: RefusalReason; readonly detail: string } };

/**
 * **What a judge is asked, and it is everything except the numbers.**
 *
 * `JudgeBrief` in [`judge.ts`](judge.ts) is the same object for the same reason,
 * and the reason is the safety property rather than tidiness: a judge that could
 * see `rounds` could answer *back to `implement`* for ever at ~$3.40 a round and
 * nothing would report a fault. So there is no ceiling and no count here — the
 * workflow has already counted, and `offering` is what is left of the arithmetic.
 *
 * **A judge answers *which of these*, never *what is legal*.** `offering` is
 * `onOffer`'s, computed from how far the pass got as well as from what is left to
 * spend (0061 §3): `prepared`'s refusal happens before any agent has run, so
 * `implement` is not in it there and a judge that knows nothing about `prepared`
 * still cannot choose wrongly.
 */
export interface Judging {
  /** The direction — the reason the step that did not pass gave. */
  readonly when: JudgeWhen;
  /** The destinations on offer. Never empty: `waiting` is always one of them. */
  readonly offering: readonly Destination[];
  /** The reviewer's findings, verbatim — the whole of the `findings` direction. */
  readonly findings: readonly ActionFinding[];
  /** What the step printed when it did not pass; the question, for `needs-input`. */
  readonly evidence: string;
}

/**
 * What the recipe's `judge:` for that direction answered, or that it declared
 * none.
 *
 * **`noJudge` is not a failure and is the ordinary answer for four of the five.**
 * `BUILT_IN_FOR` is what the body falls back to — the mechanical directions are
 * answered there, synchronously, spending nothing — and where that is `null` too,
 * the pass reaches a person. So a direction nobody configured costs no agent and
 * is never silently let past.
 */
export type Judged =
  | {
      /** Which of the offered steps is next. Held to `offering` by the body. */
      readonly next: Destination;
      /** The name a recipe wrote, so a refusal can say which entry to fix. */
      readonly named: string;
      /** The judge's own words, which is what `waiting` displays (0043). */
      readonly why: string;
    }
  | { readonly noJudge: true };

/**
 * A step's own work, as the pass asks for it — for the **seven** steps that have
 * any, in eight methods: `end` is the one step with two, because reading the
 * item's stream and appending to it are separate calls for the reason its own
 * rows give.
 *
 * **`build` and `review` are not here, and that is the shape of them rather than
 * an omission.** Both are entirely their plugins' — a `run:` carrying the checks
 * and an `agent:` reading the diff (0061 §3) — so the loop has run them by the
 * time either body is called, and a port beside them would be the
 * reimplementation the rule below exists to prevent. `prepared` is the third of
 * the three and has been since `#259`.
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
   * `proposed` — **which of the offered steps the recipe's `judge:` for this
   * direction answers**, or that it declared none.
   *
   * 0061 §3 in one sentence, and the two halves of it are on either side of this
   * call: *`judge:` decides which step is next. The workflow decides which steps
   * it may choose from.* The set is already computed — it is on `Judging.offering`
   * — and the body holds the answer to it, so a judge that answers outside the set
   * is refused by name rather than obeyed (0061 §8).
   *
   * **It is a port and not a plugin for the reason `queue:` and `worktree:` are.**
   * `judge:` is one of the five columns `KINDS_AT` carries at no step at all, and
   * `CALLED_DIRECTLY` is what its fifty cells are refused with: the plugin names
   * code the pass calls itself. So `actionsAt` will not build one, and this is
   * where a caller that has resolved the recipe's entries answers instead.
   *
   * **Answering costs money for one of the five and must not for the other four.**
   * A live implementation returns `noJudge` for a direction the recipe declared
   * nothing for, and the body falls back to `BUILT_IN_FOR` — so `red` and
   * `gate-failed` are mechanical by default and no agent is paid to reach a
   * conclusion a `switch` reaches. What a recipe *did* declare is asked, whichever
   * direction it is, because a declared judge nothing calls is `#61` again.
   */
  judge(on: Judging): Promise<Judged>;
  /**
   * `merge` — the merge lane, and `integrate` is what one is.
   *
   * Not reimplemented and not decided: the lane merges the base in, re-verifies
   * against what landed in the meantime, merges out and pushes, and answers with
   * the merge commit or with its own `reason` and `detail`. The step reports that
   * answer and the judge at `proposed` decides what it costs.
   */
  land(on: Landing): Promise<Landed>;
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
   * A live implementation is `store.append(workItemId, at, plan)` and nothing
   * else — the same append `appendEndActions` makes, that function being the
   * three acts at once for a caller that holds a store, which a body does not.
   * Its doc is also why the append stands alone here: it is that module's entry
   * point *for the one caller that cannot batch*, and the pass is one. Batching
   * is the caller's because the *ending* is the caller's — the pass says which
   * outcome was reached and does not append it (see this file's opening) — so a
   * port here that took a store and a terminal event would be the pass writing
   * an item's ending on the way past.
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
 * was not, and a repair reads that rather than a token.
 */
export const END_UNRESOLVED = "end-unresolved";

// --------------------------------------------------------- what refused ----

/**
 * **Which of the five directions an arrival at `proposed` is**, or null where it
 * is none of them.
 *
 * `when:` is *the reason the last step gave* (`JudgeWhen`), and the reason is read
 * off **which step arrived** rather than off the ending's `because`: the pipeline
 * knows only that *something the recipe declared refused* and says
 * `action-refused` at every step alike, on purpose — writing `gate-failed` there
 * would put a retired word back on a list that may only shrink (`endingOf`). So
 * the direction is the pass's to name, and it is named where the pass knows it:
 *
 * ```
 * needs-input   a step that stopped and asked, at any of the three that can
 * red           a command said no — `build`'s checks, and `prepared`'s install,
 *               which is the same kind of evidence one step earlier
 * conflict      the merge lane's own word
 * gate-failed   the merge lane's other one: the base moved and the re-verify
 *               went red
 * findings      **not here.** `review` refuses nothing, so it never arrives —
 *               its findings are judged on `proposed`'s own way through
 * ```
 *
 * **Null is the lane's other five reasons** — `dirty-base`, `unpushed-base`,
 * `pending-migration`, `no-commits`, `push-rejected` — and `JudgeWhen`'s own doc
 * is why they are not directions: they stop the lane before the diff is what is
 * in doubt, and *offering a judge a direction nothing can arrive by is the same
 * mistake as offering it a step nothing can run.* A person is next, which is
 * where they go today.
 */
function directionOf(arriving: StepReached): JudgeWhen | null {
  const ending = arriving.ending;
  // The only `did-not-finish` with anywhere to go, and the loop has already
  // decided that: `goesToTheRouter` lets no other one arrive here.
  if (ending.ending === "did-not-finish") return ending.because === NEEDS_INPUT ? NEEDS_INPUT : null;
  if (ending.ending !== "refused") return null;
  if (arriving.step !== "merge") return "red";
  if (ending.because === "conflict") return "conflict";
  return ending.because === "gate-failed" ? "gate-failed" : null;
}

/**
 * **The mechanical answers, and the whole of what keeps `proposed` from buying a
 * model to answer a question a `switch` answers.**
 *
 * The rule is `BUILT_IN["same-worktree"]`'s in [`judge.ts`](judge.ts) and the
 * argument is there: `red` and `gate-failed` were seen sixty times between them
 * in fourteen days and not one of them was a judgement. A build that went red
 * says *this line is wrong* by construction; a merge whose re-verify went red on
 * the new base says *the base moved and the result is wrong*; in both the work is
 * still there (0039 §2) and the remedy is to fix it where it stands. **And it
 * falls to a person rather than reaching for `claim`** — when `implement` is not
 * on offer the rounds are spent or no agent has run, and neither is answered by
 * starting over.
 *
 * **It is that function's rule written again rather than that function called,
 * and the reason is the two files' `Destination`s.** `judge.ts`'s has three
 * values and calls a person `human`; the pass's is `Step | "waiting"`, because the
 * loop offers `build` from `merge` and the asking step back to itself, neither of
 * which the three can say. Reconciling them is T5's, which deletes the caller
 * `judge.ts` was written for; until then `pass-steps.test.ts`'s *the mechanical
 * answer is `judge.ts`'s, cell for cell* is what makes a divergence a failing
 * test rather than a surprise.
 *
 * A **total** record over `BuiltInJudge`, so a name added to `BUILT_IN_JUDGES`
 * with no answer here does not compile — the same argument `BUILT_IN` makes.
 */
const MECHANICALLY: Record<BuiltInJudge, (offering: readonly Destination[]) => Destination> = {
  "same-worktree": (offering) => (offering.includes("implement") ? "implement" : "waiting"),
};

/**
 * Whether the arrival carries something an agent could be held to.
 *
 * `stepsOnOffer`'s first rule and `decideFix`'s before it (0038 §2, 0039 §2): the
 * bar is not *has findings*, it is *carries something the fixer could not have
 * authored* — a `failureScenario` a reviewer wrote before anybody knew what the
 * fix would be, or a command's own output and *run it again; green is green*.
 * **A refusal with neither buys nothing at either extent**, so no judge is asked
 * and no round is offered: asking an agent to address an opinion is the unbounded
 * rewriting 0038 §2 is about.
 *
 * It is `review`'s own measurement that makes this the rule rather than a
 * precaution: **10% of its refusals in fourteen days carried no findings at
 * all** — 24 of them ([012](../../../doc/experiments/012-where-the-turns-go.md)
 * §4). Under the old pass each bought a fix round with nothing in it.
 *
 * The shape is decided by `when` rather than inferred from what arrived, which is
 * `carriesACriterion`'s reason there: a `findings` arrival that came back with
 * none is an absent criterion rather than a command with no output, which is the
 * more useful of the two truths.
 */
function carriesACriterion(on: Judging): boolean {
  return on.when === "findings"
    ? on.findings.some((finding) => finding.failureScenario.trim() !== "")
    : on.evidence.trim() !== "";
}

/**
 * **What `review` came back with, where the reviewer said it stops the change** —
 * or null, where nothing did.
 *
 * Read off the visit rather than off an ending, because `review`'s ending says
 * nothing: a reviewer's `failed` verdict is its findings and not a verdict about
 * the step, so `endingOf` reports the step as `passed` and leaves the verdict on
 * `results` where it belongs. That is the whole of *`review` returns findings and
 * judges nothing*, and this is the reader it leaves them for.
 *
 * The last `review` visit and not the first: a pass that took a round has two, and
 * what the way-through `proposed` is judging is the review that has just run. A
 * pass that never reached `review` — a red `build` routed straight here — has no
 * visit at all and is not this function's case: it arrives with a direction.
 *
 * Findings from the passing results are carried too, and deliberately: a reviewer
 * that refused on a blocker and also filed two minors has said three things about
 * one diff, and the agent that is sent back should be told all three.
 */
function reviewRefused(reached: readonly StepReached[]): Pick<Judging, "findings" | "evidence"> | null {
  const reviewed = reached.findLast((visit) => visit.step === "review");
  if (reviewed === undefined) return null;
  // By verdict rather than by position, which is `evidenceFrom`'s reason: the
  // pipeline stops at the first action that did not pass, so the one that refused
  // is the only result with that verdict and is also the last.
  const refused = reviewed.results.filter((result) => result.verdict === "failed").at(-1);
  if (refused === undefined) return null;
  return { findings: reviewed.results.flatMap((result) => result.findings), evidence: refused.evidence };
}

/** What the step that did not pass said, as the judge is shown it. */
function whatArrived(arriving: StepReached): Pick<Judging, "findings" | "evidence"> {
  const ending = arriving.ending;
  return {
    findings: arriving.results.flatMap((result) => result.findings),
    // Every arriving ending has one — `StepRefused` and `StepDidNotFinish` are the
    // only two the loop routes — and it is the words a person reads beside the
    // judge's (0043).
    evidence: "detail" in ending ? ending.detail : "",
  };
}

/** The reason the arriving step gave, for a sentence about it. */
function reasonOf(arriving: StepReached): string {
  const ending = arriving.ending;
  return "because" in ending ? ending.because : ending.ending;
}

/** `waiting`, which `onOffer` offers on every arrival, so this can never be refused. */
function toAPerson(why: string): StepRouted {
  return { ending: "routed", to: "waiting", why };
}

/** The offered steps, for a sentence a person or a judge reads. */
function listing(offering: readonly Destination[]): string {
  return offering.map((step) => `"${step}"`).join(", ");
}

/**
 * The ten bodies, all of them written.
 *
 * It is still spread over `NOT_BUILT_YET`, and that is not a leftover: the spread
 * is what makes *every* row of `StepBodies` present by construction, so a step
 * added to the vocabulary arrives here as a pass rather than as a type error
 * somebody answers under time pressure.
 *
 * A pass run with these ports walks the whole spine, and every refusal on it
 * reaches `proposed`, where a judge is asked and a person is the floor.
 *
 * One closure conducts one pass at a time: the four facts below are the pass's,
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
    // And what it printed, where that is not the question `asked` already holds.
    // The evidence the judge weighed is on the arriving visit's ending, and this
    // is the only thing that carries it as far as the agent buying the round:
    // `context.recheck` is empty on a mechanical route, because a command's
    // refusal raises no findings.
    const printed =
      asked === null && arrived !== undefined && "detail" in arrived.ending && arrived.ending.detail !== ""
        ? { step: arrived.step, detail: arrived.ending.detail }
        : null;
    return { why: route.why, asked, printed };
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

  /**
   * **One arrival at `proposed`, answered** — and the only place a round is bought.
   *
   * Four answers in order, and the order is what makes the cheap ones cheap:
   *
   * 1. **nothing to hold an agent to** — `carriesACriterion`, and a person. Asked
   *    before any judge, because a refusal with no criterion buys nothing at either
   *    extent and paying a model to discover that is paying twice;
   * 2. **what the recipe declared** for this direction, whichever it is. A judge a
   *    person wrote down and nothing calls is `#61` arriving through the one door
   *    this repository has decided it will not leave open;
   * 3. **the mechanical answer**, where it declared none — `BUILT_IN_FOR`, which is
   *    `same-worktree` for `red` and `gate-failed` and nothing for the other three.
   *    So the sixty refusals a year that are not judgements cost no agent;
   * 4. **a person**, for a direction with neither. `needs-input` is that today:
   *    0061 §3's yaml names `ask-or-assume` and nothing implements it, so a
   *    question reaches somebody rather than a name the schema would accept and no
   *    code answers.
   *
   * And a judge held to the set: **an answer outside `offering` is refused by
   * name**, and the fallback is the one destination that cannot loop. An overruled
   * judge is not one to ask for a second opinion, so the answer is not the next
   * cheapest step — it is a person, with the refusal on the card (`askJudge`).
   */
  const judged = async (on: Judging, about: string): Promise<StepRouted> => {
    if (!carriesACriterion(on)) {
      return toAPerson(
        `${about} carries nothing an agent could be held to — ` +
          `${on.when === "findings" ? "no finding with a failure scenario" : "no output"} — so no ` +
          "round is worth buying and the pass is held for a person (0038 §2)",
      );
    }
    const answer = await ports.judge(on);
    if ("noJudge" in answer) {
      const built = BUILT_IN_FOR[on.when];
      if (built === null) {
        return toAPerson(
          `no \`judge:\` is declared for a "${on.when}" and there is no built-in that answers one, ` +
            `so ${about} is held for a person rather than the workflow choosing from ` +
            `${listing(on.offering)} on its own (0061 §3)`,
        );
      }
      const next = MECHANICALLY[built](on.offering);
      return {
        ending: "routed",
        to: next,
        why:
          `the "${built}" judge on ${about}: a "${on.when}" is mechanical — the work is still ` +
          `there and the remedy is to fix it where it stands — and of ${listing(on.offering)} it ` +
          `chose \`${next}\``,
      };
    }
    if (!on.offering.includes(answer.next)) {
      return toAPerson(
        `the "${answer.named}" judge answered "${answer.next}" for ${about}, and that is not one ` +
          `of the steps it was offered — ${listing(on.offering)}. A judge chooses which of the ` +
          "offered steps is next; which steps are on offer is the workflow's, and it counts the " +
          "rounds and restarts spent to work them out (0061 §3). The pass is held for a person, " +
          "because a judge that answered outside the set is not one to ask a second time",
      );
    }
    return { ending: "routed", to: answer.next, why: answer.why };
  };

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
     * (`recipe.ts:775`): this repository's own recipe file declares one command
     * there and nothing else — `pnpm install --frozen-lockfile`, with a `10m`
     * timeout (`.lingtai/config.yaml:113`). The loop has already run that
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
     * **Its own step, and a red one skips `review`.**
     *
     * The skip is the loop's rather than this body's: `build` is one of
     * `REFUSING_STEPS`, so `endingOf` reads a `failed` verdict here as a
     * **refusal**, and the loop takes a refusal to `proposed`. `review` is never
     * reached, and no agent is paid to read a diff that does not compile.
     *
     * **It goes before `review` and not because it is quick** — median 313s
     * against review's 149s. It goes first because it spends no tokens where a
     * review spends an agent.
     *
     * Its work is entirely its plugins', which is `prepared`'s argument again: the
     * build is `run:` carrying the commands (0061 §3), the loop has run them by
     * the time this is called, and a second build written here would be the
     * reimplementation 0061 §3 exists to prevent. `KINDS_AT.build` is still `[]`,
     * and it stays that way until the conductor runs this file — turning a
     * declared list into a runnable action is `actionsAt`'s, at the caller, which
     * is why this body needs no row opened.
     */
    build: async (): Promise<StepPassed> => ({ ending: "passed" }),

    /**
     * Reads the diff, returns findings — **and judges nothing** (0058 §3).
     *
     * The findings are its plugins': an `agent:` reviewer returns them with a
     * severity, the pipeline carries them on `StepReached.results`, and
     * `reviewRefused` is what reads them one step later. So the body is nothing
     * beyond them, exactly as `build`'s and `prepared`'s are.
     *
     * **Where *no verdict of its own* is enforced is `endingOf`**, and it has to
     * be: a reviewer that finds a blocker returns `failed`, and a body is never
     * called after its own plugins did not pass. `review` is not one of
     * `REFUSING_STEPS`, so that verdict is the reviewer's findings rather than a
     * verdict about the step, the step passes carrying them, and the judgement is
     * made at `proposed` — where there is a round to buy with it.
     *
     * **Why it stopped judging**: 10% of its refusals in fourteen days carried no
     * findings at all — 24 of them
     * ([012](../../../doc/experiments/012-where-the-turns-go.md) §4). A step that
     * refuses without saying what is wrong is a step whose judgement is worth
     * nothing to the round it buys, and `carriesACriterion` is where that is now
     * answered instead.
     */
    review: async (): Promise<StepPassed> => ({ ending: "passed" }),

    /**
     * **The only step that routes** (0058 §3), and the one that spends what a
     * round costs.
     *
     * Its two jobs are told apart by `arriving`, which is the whole of what
     * `StepWork` carries it for:
     *
     * - **`null` — the way through.** `build` and `review` have passed, and what is
     *   left to judge is what the reviewer said: `findings`, the direction 0061 §3
     *   measured at 231 refusals and calls *the one judgement worth an agent*. A
     *   reviewer that refused nothing lets the change through to `merge`, which is
     *   a recorded decision saying so rather than an absence (0058 §3b);
     * - **a visit — a routing arrival.** The step that did not pass, carrying its
     *   reason intact (0058 §3c), and `directionOf` is which of the five that is.
     *
     * **Every arrival is answered, and four things can answer it, in this order.**
     * A direction no judge is written for is a person; a refusal carrying nothing
     * an agent could be held to is a person, whatever is declared; what the recipe
     * declared for the direction is asked; and where it declared nothing, the
     * mechanical answer is given without paying for one. **A judge that answers
     * outside `offering` is refused by name and the pass is held for a person**,
     * which is 0061 §8 again and the asymmetry `judge.ts` opens with — *a
     * misconfiguration that fails is cheap; one that loops is not.*
     *
     * So the floor `#253` set holds: **an arrival no judge can answer still reaches
     * a person**, as it did when no judge existed at all.
     */
    proposed: async ({ arriving, offering, reached }): Promise<StepPassed | StepRouted> => {
      if (arriving === null) {
        const said = reviewRefused(reached);
        // Nothing the reviewer said stops this. The findings at or below the bar
        // are on `review`'s own visit and are the `backlog:` plugin's business,
        // not a reason to hold a change back.
        if (said === null) return { ending: "passed" };
        return await judged({ when: "findings", offering, ...said }, "`review`'s findings");
      }
      const when = directionOf(arriving);
      if (when === null) {
        return toAPerson(
          `the \`${arriving.step}\` step reported "${reasonOf(arriving)}", which is not a ` +
            "direction any `judge:` answers — it stops the lane before the diff is what is in " +
            "doubt — so the pass is held for a person rather than buying a round for it",
        );
      }
      return await judged(
        { when, offering, ...whatArrived(arriving) },
        `the \`${arriving.step}\` step's ${arriving.ending.ending}`,
      );
    },

    /**
     * **Reports a `reason` and a `detail`, and decides nothing.**
     *
     * The lane is `ports.land` — merge the base in, re-verify against what landed
     * in the meantime, merge out, push — and its two answers are the step's two
     * endings. Over the whole log it has refused 32 times, **26 `gate-failed` and
     * 6 `conflict`**: the common failure is that somebody else's work landed and
     * the diff stopped being true, which is a fact about the world rather than a
     * verdict about the change. So the words travel and the decision does not
     * happen here — `proposed` is where a `conflict` is weighed and where a
     * `gate-failed` buys the mechanical round.
     *
     * **It is one of `REFUSING_STEPS` all the same**, and the refusal is what pays
     * for the edge back: `onOffer` offers `build` from here, so an agent that
     * resolves a conflict writes code *after* the review passed and goes through
     * both again. That is what buys *every path into `end` has been through
     * `build` and `review`*.
     *
     * It reports no `head`. A merge commit is on the base branch and the worktree
     * did not move, and `LeftTheTreeAt` is a fact about the tree.
     */
    merge: async ({ context }): Promise<StepPassed | StepRefused> => {
      const answer = await ports.land({
        claimed: madeBy("merge", "item", claimed),
        worktree: madeBy("merge", "worktree", worktree),
        context,
      });
      if ("merged" in answer) return { ending: "passed" };
      return {
        ending: "refused",
        // The lane's own word, on the log already — and two of the five values it
        // can be are directions a judge answers (`directionOf`).
        because: answer.notMerged.reason,
        // No action refused: the step's own work did, which is why `at` is null
        // here and an action's name where `endingOf` builds one.
        at: null,
        detail: answer.notMerged.detail,
      };
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
