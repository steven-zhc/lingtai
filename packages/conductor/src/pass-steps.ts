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
  type Resting,
  type StepBodies,
  type StepDidNotFinish,
  type StepNeverRan,
  type StepPassed,
  type StepReached,
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
   * no design*, and the other three are a question, a wall about the account,
   * and a run that left no receipt (`NeverStarted`).
   */
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
   * `end` — **the item's ending, and what the step resolved for it, in one
   * append.**
   *
   * The outcome is here rather than left to the caller, and that is the whole of
   * why this port is shaped as it is. `end-step.ts` states the rule its example
   * is written to show — *one transaction, so the outcome and its resolution
   * cannot come apart; a crash between two appends is the shape of failure this
   * system exists to make impossible, and the version check that guards the
   * outcome guards both* — and every live resolver keeps it (`run-once.ts:3423`,
   * *One transaction with the landing itself*; `:3274`, *In the same append as
   * the outcome it is about*). A port that took only the resolution could not:
   * the terminal event would be a second append at `at + 1`, and a conductor that
   * lost its connection in between would leave an item with a resolution and no
   * ending — claimed for ever to the work-item fold, silent to
   * `endedWithoutEndActions`, whose audit is the anti-join the other way, and
   * with its issue already closed by `tell.ts`.
   *
   * So an implementation appends `[<the outcome's own event>, ...resolved]` at
   * version `at`, and **the caller appends no terminal event of its own while
   * this call succeeds**: the pass's last step is where a claimed item's ending
   * is written.
   *
   * ## What goes in the event, and where each field of it comes from
   *
   * **The outcome is a word and the terminal events want evidence**, so the
   * evidence is handed down beside it. Every required field of all three events
   * has a source here and none of them is the implementation's to invent:
   *
   * ```
   * landed   WorkItemLanded      mergeCommit  `head` — the commit the walk ended at
   *                              base         the recipe's own (`baseOf`), which the
   *                                           port-owner holds and the pass does not
   * blocked  WorkItemBlocked     question     `resting.stoppedAt.ending.detail` — the
   *                                           install that failed, the question an
   *                                           agent asked — or, where nothing
   *                                           reported anything, the judge's own
   *                                           `why` on the last of `resting.routes`
   *                              runId        `runId`
   *                              needsFrom    `human`; `needs`/`diagnosis` are the
   *                                           port's to write and may be null
   * failed   WorkItemReleased    reason       the same two places as `question`:
   *                                           a `never-ran`'s `detail`, or the
   *                                           judge's `why` on a requeue
   *                              runId        `runId`
   * ```
   *
   * **An invented `question` is the failure this is shaped to prevent**, and it
   * is a failure with a history: `WorkItemBlocked`'s own doc records that *the
   * old `agent:blocked` label carried no question*, and `#197` is what fixing
   * that cost. A port handed `{ outcome: "blocked" }` and nothing else could
   * only put a placeholder on the board's *Waiting on you* card for an item
   * whose real reason — `pnpm install exited 1` — the pass was holding in memory
   * one function call away. `resting` is that memory, and `Resting` in
   * [`pass.ts`](pass.ts) is why it is the loop's to hand down rather than a
   * body's to re-derive.
   *
   * ## When the append does not succeed
   *
   * One append cannot be made to always happen, so what the shape has to decide
   * is which way it fails. A resolution with no ending is silent to both audits
   * and leaves the item claimed for ever; *neither* would be worse still —
   * nothing on the stream, nothing for `endedWithoutEndActions` to anti-join,
   * and a `PassResult` whose `outcomeOf` says `landed`. So the failure is handed
   * back as a token rather than a sentence, and the caller writes the ending.
   *
   * **There are two tokens and they are not one, because the two failures leave
   * the stream in different states.** `end` ends `did-not-finish` with:
   *
   * - `NOT_ENDED` — *no append was attempted*. `read` or `resolve` threw, this
   *   call was never made, and nothing this pass did reached the item's stream;
   * - `ENDING_UNCONFIRMED` — *this call was made and its fate is unknown*. The
   *   append may have committed and then lost its connection, which is the case
   *   a version check cannot help with: the commit is already in.
   *
   * **Neither token is an instruction to append at a remembered version.** `at`
   * is this body's read, it is stale the moment the connection is in doubt, and
   * on the `ENDING_UNCONFIRMED` path the very append in question may have moved
   * it. The caller's repair is the same two steps either way — **read the item's
   * stream, and append the bare terminal event only if this outcome is not
   * already on it, at the length that read returned.** What the token then says
   * is what finding one there *means*: under `ENDING_UNCONFIRMED` it is this
   * call's own append having landed after all, and nothing is owed; under
   * `NOT_ENDED` it is another writer having ended the item, which is a race
   * worth reporting rather than a repair. Either way the item ends in the one
   * window this system already audits and already repairs (`lingtai end
   * replay`), rather than in one with no audit on either side.
   *
   * **Resolving and doing are still two acts and neither of them is the doing**
   * (`end-step.ts`): the resolving is `resolveEndActions`, which the body calls;
   * this is the record; and carrying the effects out is I/O that must not be able
   * to undo the fact, which is `tell.ts`'s and the port-owner's.
   *
   * **`resolved` may be empty and the call is made anyway**, because the ending
   * is owed whatever the effects came to. Empty is *nothing was declared* or
   * *this outcome was already resolved* — neither is a row, and neither is a
   * reason to leave the outcome unwritten. An empty resolution in the 0016 §4
   * sense is not this: that is one `EndActionsResolved` whose own `actions` are
   * `[]`, and it arrives here *in* the list.
   */
  record(ending: {
    readonly claimed: Claimed;
    /** The version the append expects — `read`'s length, and the whole of the race. */
    readonly at: number;
    /** Where the pass came to rest, in `end-step.ts`'s vocabulary — `outcomeOf`'s. */
    readonly outcome: TerminalOutcome;
    /**
     * **Why that outcome** — the step that stopped the pass and what it
     * reported, where the router sent it, and in whose words (`Resting`).
     *
     * The table above says which field of it answers which key of which event.
     * It is the loop's own reading, handed down rather than re-derived: a body
     * computing it off the visit list would be a second implementation of the
     * rule 0058 §2b keeps in the core, and would get a pass that asked, was sent
     * back and then landed wrong.
     */
    readonly resting: Resting;
    /** The run that ended — `WorkItemBlocked.runId`, `WorkItemReleased.runId`. */
    readonly runId: string;
    /**
     * The commit the walk ended at — `WorkItemLanded.mergeCommit`.
     *
     * The caller's base until a step says it moved the tree, and then that
     * step's (`LeftTheTreeAt`): `admit`'s at the cut, `implement`'s at the
     * commit, and `merge`'s once T4b writes a body that reports one. It is the
     * one field of a landing that no port-owner can hold, because it is made
     * during the pass it records.
     */
    readonly head: string;
    readonly resolved: readonly ToAppend[];
  }): Promise<void>;
}

// ---------------------------------------------------------------- the bodies ----

/**
 * **The two `because` values a caller of the pass reads**, and the reason they
 * are constants rather than sentences spelled out at one call site.
 *
 * `NEEDS_INPUT` is the token the *workflow* reads; these are the tokens the
 * *caller* reads, and between them they say one thing: **`end` did not confirm
 * this item's ending, so writing it is yours.** A pass whose `end` visit carries
 * either still reports the outcome it actually reached — `PassResult.stoppedAt`
 * is never `end`, a merge that landed has landed — and that is exactly what
 * makes them necessary: without them a caller reading `outcomeOf(result) ===
 * "landed"` and obeying `PassPorts.record`'s *the caller appends no terminal
 * event of its own* writes nothing, and the item is left claimed for ever with
 * `main` moved and no event of any kind to find it by.
 *
 * Prose would not do. `detail` carries the store's own words for a person
 * (0043), and a caller that had to read them to decide whether to append would
 * be the second reader of a sentence `StepNeverRan` already refuses to create.
 *
 * **Nothing at all reached the item's stream** — the `read` that should have
 * given the expected version threw, or `resolveEndActions` did, so `record` was
 * never called and this pass appended nothing anywhere.
 *
 * A caller that reads the stream and finds a terminal event there anyway has
 * found a **race**, not this pass's own append: something else ended the item
 * while the pass was running, which is worth saying out loud rather than
 * quietly repairing.
 */
export const NOT_ENDED = "not-ended";

/**
 * **The append was made and its fate is unknown** — `record` threw.
 *
 * Kept apart from `NOT_ENDED` because the two are opposite facts about the
 * stream, and one of them is the case a version check cannot save anybody from:
 * a transaction that **committed** and then lost its connection is already in,
 * and the client that raises is the one that cannot tell. `PassPorts.record`'s
 * own doc names it. Folded into one token, a caller obeying *write the bare
 * terminal event at the expected version* would append a second
 * `WorkItemLanded` for one merge whenever it guessed a version the committed
 * append had already moved past — and it could only guess, the version never
 * having been handed back.
 *
 * So the repair is a read and not a remembered number: **read the item's stream,
 * and append only if this outcome is not already on it.** Finding it there under
 * this token is the ordinary case — the append landed after all, and nothing is
 * owed.
 */
export const ENDING_UNCONFIRMED = "ending-unconfirmed";

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
 * The three facts that travel between steps are this closure's, and **`claim`
 * clears all three before it takes anything** — so one `StepBodies` may conduct
 * one pass after another, which is how a daemon that builds its ports once at
 * startup will hold them. Without that clearing a `claim` that took nothing left
 * the last pass's item in place and `end` resolved onto it: a `blocked` ending
 * appended to an issue that had landed and closed, and `implement` briefed on a
 * worktree from a pass that finished hours ago.
 *
 * `claim` is where the clearing goes because it is the one step every pass runs
 * first and exactly once — a restart is `proposed`'s route to `claim`, and that
 * requeues and *ends* the pass (`runPass`'s `take`) rather than re-entering the
 * spine.
 *
 * **Two passes at once still want two closures.** The clearing makes a second
 * pass safe *after* the first, not beside it, and nothing here can catch an
 * overlapping one — which is no worse than the lock that stops it: one conductor
 * takes work at a time (`#93`).
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

  const briefOn = (step: Step, work: { context: ActionContext; reached: readonly StepReached[] }): Brief => ({
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
     * **It cannot refuse**, and 0058 §2 is why rather than an omission: a
     * refusal buys a fix round, holds the work item and reaches a person, and
     * `claim` has picked nothing — there is no item to hold and no diff to fix.
     * So the three answers are *took it* and two ways of *did not*, and neither
     * of those reaches the router either (`ARRIVE_AT_THE_ROUTER`).
     *
     * A pass that took nothing still runs `end`, which resolves nothing because
     * there is no stream to resolve it onto.
     *
     * **It is also where a pass begins**, which is why the three facts are
     * cleared here and not left from the pass before: see `bodiesFor`.
     */
    claim: async (): Promise<StepPassed | StepDidNotFinish> => {
      // Before the answer, not after it — the two ways `take` can decline write
      // nothing, and it was exactly those that let `end` resolve onto the item
      // the pass before had landed.
      claimed = null;
      worktree = null;
      design = "";
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
     *
     * **And it stands the conductor down on the same wall `implement` does.**
     * `agent:` is declared at both steps (0061 §3), so a design agent meets
     * `You've hit your session limit` identically, and the answer has to be the
     * same one: `never-ran`, released, 0031 §3. Reported as `did-not-finish` it
     * would hold the item for a person and leave the account-wide condition
     * unsaid, and the next queue pass would claim the next ticket and meet the
     * same wall — which is 0031's own incident. `EndingAt<"design">` permits
     * `never-ran` already, `design` being a `SettlingStep`; what was missing was
     * a way for the port to say it (`NeverStarted`).
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
    implement: async ({ context, reached }): Promise<StepPassed | StepDidNotFinish | StepNeverRan> => {
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
     *
     * **And the outcome goes down with the resolution, in one append.** The port
     * is handed both because `end-step.ts`'s rule is that they cannot come apart:
     * a resolution recorded at one version and a `WorkItemLanded` at the next is
     * a window in which an item can be left resolved and never ended. See
     * `PassPorts.record`, which is why it is called on a pass that claimed
     * whether anything resolved or not.
     *
     * **And the outcome is not the only thing the port is handed, because the
     * events want evidence.** `WorkItemBlocked` requires a `question`,
     * `WorkItemLanded` a `mergeCommit`, `WorkItemReleased` a `reason`, and the
     * word `blocked` answers none of them. The loop reads the outcome off two
     * facts and hands both down (`Resting`), so the port writes the install that
     * failed rather than a placeholder — the whole of what `#197` bought. The
     * run and the head travel with them: `runId` is on every block and every
     * release, and the head is the commit the walk ended at, which is the one
     * field of a landing nobody outside the pass can hold.
     *
     * **And the one append that cannot be retried from here is reported rather
     * than swallowed** — as one of *two* tokens, because the two ways it fails
     * are opposite facts about the stream. A `read` or a `resolve` that threw
     * leaves the item with nothing on it: no ending for the work-item fold,
     * nothing for `endedWithoutEndActions` to anti-join, and a `PassResult` that
     * still says `landed` — `NOT_ENDED`. A `record` that threw may have
     * committed first and lost the connection afterwards, which no version check
     * can undo — `ENDING_UNCONFIRMED`, and the caller reads the stream before it
     * writes anything. Letting either reach `runStep`'s generic `threw` would
     * make it indistinguishable from any other crash in this body; folding them
     * into one token would make a committed append indistinguishable from an
     * empty stream, which is a duplicate `WorkItemLanded` for one merge. Named,
     * the item sits in the window that has an audit and a repair.
     */
    end: async ({ actions, outcome, resting, context }): Promise<StepPassed | StepDidNotFinish> => {
      if (claimed === null) return { ending: "passed" };
      const item = claimed;
      // Which of the step's own three acts did not finish — and at the third it
      // is the signal and not just a person's detail: `read` and `resolve` leave
      // the stream untouched and `record` may not have.
      let act = "read";
      /** The version the append expected, once the read has given one. */
      let at = 0;
      try {
        const events = await ports.read(item);
        at = events.length;
        // An empty list is *nothing declared* or *already resolved for this
        // outcome*, and neither is a row — but the ending is owed either way, so
        // the call is made either way. A step that resolved a declared list down
        // to no effects is not empty here: that is one row whose own `actions`
        // are `[]`.
        act = "resolve";
        const resolved = resolveEndActions(events, actions, outcome);
        act = "record";
        await ports.record({
          claimed: item,
          at,
          outcome,
          // Why that outcome, so the port writes a question rather than invents
          // one. The loop's own reading, never re-derived here — `Resting`.
          resting,
          runId: context.runId,
          // The head the walk reached: `admit`'s cut, `implement`'s commit, and
          // `merge`'s once it reports one. `WorkItemLanded.mergeCommit`.
          head: context.onSha,
          resolved,
        });
        return { ending: "passed" };
      } catch (error) {
        // The third act is the one that may have committed. Everything before it
        // certainly did not, and the caller acts on that difference.
        const attempted = act === "record";
        return {
          ending: "did-not-finish",
          because: attempted ? ENDING_UNCONFIRMED : NOT_ENDED,
          // No action asked it: the step's own work did — the same reason
          // `asking` and `noReceipt` above are `null` here.
          at: null,
          detail: attempted
            ? `${item.workItemId} may or may not have its \`${outcome}\` — the append was made ` +
              `at version ${at} and \`record\` threw: ${String(error)}. Read the stream before ` +
              "writing anything: an append that committed and then lost its connection throws here too."
            : `${item.workItemId} has no \`${outcome}\` on its stream — \`${act}\` threw: ` +
              `${String(error)}. No append was attempted, so the pass reached that ending and ` +
              "nothing was written about it.",
        };
      }
    },
  };
}
