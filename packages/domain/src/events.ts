/**
 * The event catalogue.
 *
 * This file is the one thing in the project worth over-building. Everything
 * else — the board, the scheduler, every projection — is derived from these
 * shapes and can be thrown away in an afternoon. A wrong event name or a
 * missing payload field costs a migration over real history.
 *
 * Two rules hold for every entry:
 *
 *   1. Past tense. An event is something that happened, never an intention.
 *   2. Self-contained. A reader a year from now must not need to join against
 *      GitHub, a log file, or a worktree that no longer exists.
 *
 * Bump `SCHEMA_VER` for a type and add an upcaster rather than changing a
 * payload in place.
 */
import { z } from "zod";

// ---------------------------------------------------------------- shared ----

/**
 * There is no `WorkKind` here any more, and its absence is the point.
 *
 * It was `z.enum(["bug", "feature", "enhancement", "tech-debt"])` — a
 * vocabulary guessed at in the core about repositories it cannot see. Nothing
 * ever branched on a specific value: `kind` decides whether an issue is wanted
 * (`recipe.source.kinds.includes`) and where it sits in the priority order (the
 * array's order), and both of those are the recipe's. The enum bought no
 * behaviour and cost a whole queue — a recipe naming `documentation` stopped
 * parsing, so every issue in the project vanished, including the two `bug`s
 * (#76). The same argument 0016 §7 made about the hardcoded `agent:*` skip in
 * `discover.ts`, one field along.
 *
 * `WorkItemDiscovered.kind` is therefore `z.string()`. That is a *widening*: no
 * upcaster is needed because every stored event still parses. Old code reading
 * a new event will refuse a kind outside its enum, which is the
 * forward-compatibility limit this catalogue already documents.
 */

/**
 * What a project asks its runtime to be able to do. See doc/decisions/0007.
 *
 * `guarded`: the runtime stops the run when the `UserPromptSubmit` hook refuses
 * the prompt — so a hook that cannot reach the conductor stops the run at its
 * first prompt rather than let it record nothing. No hook runs before a tool use. Not "Lingtai guards the tools", which
 * it does not (ADR 0016 §6); containment is the worktree and the filtered
 * environment. `sandboxed` adds a filesystem boundary the runtime enforces.
 */
export const Tier = z.enum(["open", "guarded", "sandboxed"]);
export type Tier = z.infer<typeof Tier>;

/**
 * The ten steps a pass goes through, in the order it reaches them.
 *
 * **Closed forever** ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §3, widened by [0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md)
 * §3). It was five until 2026-09-23 and every one of those five is still here
 * under its own name; what the five could not say is that a pass also *claims*,
 * *designs*, *implements*, *builds* and *reviews* — five things the loop has
 * always done and the model had no word for, so they appeared in no recipe, no
 * event and no column. 0058's Context is that sentence: *the board cannot draw
 * what the model does not name.*
 *
 * A step is a *place*, not a kind of check. What runs there is open and comes
 * from the recipe; where it can run is not. That is what lets extension be
 * unbounded while the core stays finite, and it is why widening the set is a
 * decision with an ADR rather than a convenience.
 *
 * **Four of them may refuse, and every refusal goes to `proposed`** — 0058 §3:
 * `prepared`, `build`, `proposed`, `merge`. `end` is the one that cannot refuse
 * — nothing can be stopped once a merge has landed. Recorded as an imprecision
 * rather than smoothed over: a separate concept for it would cost more than the
 * imprecision does.
 *
 * **Five of the ten have code behind them today and five do not.** `claim`,
 * `design`, `implement`, `build` and `review` name work a pass already does and
 * no pipeline is constructed at any of them — today's build and review run as
 * actions at `proposed`. A recipe that names an action at one of the five is
 * refused when it resolves, which is `KINDS_AT`'s rule and not an exception to
 * it: the vocabulary is what the model may *say*, and the matrix is what the
 * code will *run*. The two are allowed to differ only in the direction that is
 * loud.
 *
 * `proposed` was called `diff` until
 * [ADR 0018](../../../doc/decisions/0018-the-proposed-point.md). Stored events
 * still carry the old value and are upcast on read; a reader who finds `diff`
 * in the log or in an old recipe is looking at history, not at a bug. 0061 §7
 * spends that history rather than upcasting it to ten steps — by **resetting**
 * the log (`the-pipeline.md`'s T5), which has not happened, so the step that
 * walks it is still load-bearing.
 */
export const Step = z.enum([
  "claim",
  "admit",
  "prepared",
  "design",
  "implement",
  "build",
  "review",
  "proposed",
  "merge",
  "end",
]);
export type Step = z.infer<typeof Step>;

/**
 * The ten, in the order the loop reaches them.
 *
 * Exported as a tuple because "every step, in order" is a thing several places
 * need to iterate — `GatesResolved`, the board, `lingtai add` — and each writing
 * its own list is how one of them ends up missing a step and nobody notices.
 */
export const STEPS = Step.options;

export const RuntimeId = z.enum(["claude-code", "codex"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

/**
 * Why an integration did not happen. Every one of these was a silent
 * `return 1` in the old loop's `integrate()` — no log line, no comment, no
 * label, and five re-runs of the same ticket before anyone noticed.
 */
export const RefusalReason = z.enum([
  "conflict",
  "dirty-base",
  "unpushed-base",
  "pending-migration",
  "gate-failed",
  "no-commits",
  /**
   * Two integrations computed against one base, found where git finds it: the
   * ref update is atomic, one push lands and the other is rejected as not a
   * fast-forward. It is what `lane-busy` below was, discovered one step later
   * and by the thing that was always the guarantee (#194).
   */
  "push-rejected",
  /**
   * **Never written since #194, and never removable.**
   *
   * The merge lane used to take a lock and tell the loser this before it cut a
   * worktree. Git's ref update was the guarantee all along, on one machine and
   * across them, so the lock went and the loser is now told `push-rejected`.
   *
   * The value stays in the enum because events on this log carry it: a reader
   * that can no longer parse it cannot read this repository's own history.
   * There is no `RETIRED` set for a refusal reason as there is for an event
   * type — this comment is the whole of the marking, and `attribution.ts` still
   * has a sentence and a move for it.
   */
  "lane-busy",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

// ------------------------------------------------------------- work item ----

export const WorkItemDiscovered = z.object({
  project: z.string(),
  source: z.enum(["github-issue", "manual", "agent-followup"]),
  externalRef: z.string(),
  title: z.string(),
  /** A label of the repository's, not a member of a set this file keeps. */
  kind: z.string(),
  labels: z.array(z.string()),
});

export const WorkItemClaimed = z.object({
  runId: z.string(),
  /**
   * Host and pid, and the reason this outlived the lease
   * ([0027](../../../doc/decisions/0027-the-lease-is-deleted.md)): recovery
   * asks *whose* claim this is, not *when* it lapses. A conductor holding
   * `lingtai:daemon` knows no other conductor exists, so a claim naming any
   * other worker is a claim nobody is coming back for.
   */
  worker: z.string(),
  /**
   * What the task is, recorded at the moment Lingtai takes responsibility
   * for it.
   *
   * Here because the queue left the log (0012). `WorkItemDiscovered` used to be
   * where a title entered, and without it a rebuilt projection had no row at
   * all for anything claimed — every running and landed task simply vanished,
   * since GitHub's *open* issue list cannot supply a title for work that has
   * already merged.
   *
   * Null for a v1 event, and for a claim made without the queue entry to hand.
   * The projection falls back to the issue number, which is honest about not
   * knowing rather than inventing something.
   */
  title: z.string().nullable(),
  kind: z.string().nullable(),
});

export const WorkItemReleased = z.object({ runId: z.string(), reason: z.string() });

/**
 * What to do about a block, in the vocabulary of the controls that exist.
 *
 * **`approve` is a legitimate value, and most of the time it is the right one**
 * (#83). A card has two moves since #150: `approve` answers an
 * `ApprovalRequested`, and `requeue` ends the wait with a new run, with or
 * without a diff to answer about. `reject` stays in the enum because the log
 * holds it, and has no button of its own: the board reads it as `requeue`
 * (`primaryMove` in `apps/board/src/app/decide.tsx`), so a diagnosis that means
 * *run it again* should say `requeue`. A recommendation the board cannot carry
 * out would be a sentence rather than a recommendation.
 */
export const BlockRecommendation = z.object({
  action: z.enum(["approve", "reject", "requeue"]),
  /** Why that is the move. The half that makes it a recommendation and not a guess. */
  why: z.string(),
});
export type BlockRecommendation = z.infer<typeof BlockRecommendation>;

/**
 * What happened, what was done about it, and what to do now.
 *
 * The whole of what a block could say used to be `question`, and #112 is what
 * that costs: `conflict: agent/112 does not merge into develop: apps/web/…` sat
 * in *Waiting on you* for four days — a git message with a colon in it, in
 * front of an operator who was being asked to diagnose it themselves.
 *
 * The recommendation lives **inside** the diagnosis rather than beside it,
 * because nothing can be recommended without saying what happened first. The
 * other direction is ordinary: a diagnosis with no recommendation is a failure
 * somebody has explained and not yet decided about.
 *
 * `raw` is why this is a widening and not a replacement. A summary that hides
 * the git output is worse than the git output, so the output stays — beside the
 * sentence, not instead of it.
 */
export const BlockDiagnosis = z.object({
  /** The failure, stated in a sentence rather than as a git error. */
  what: z.string(),
  /** What was already done about it and what that produced. Null when nothing was. */
  done: z.string().nullable(),
  /** The failure as it arrived, untouched. Null when there was no raw output. */
  raw: z.string().nullable(),
  recommendation: BlockRecommendation.nullable(),
});
export type BlockDiagnosis = z.infer<typeof BlockDiagnosis>;

export const WorkItemBlocked = z.object({
  /** The question, not just the fact. The old `agent:blocked` label carried no question. */
  question: z.string(),
  /**
   * Who has to answer. `needs` says *what* of them.
   *
   * **`schema` was deleted (#147)**, having never been written. It was the
   * model's half of `agent:needs-schema-approval`, a label that appeared once in
   * the repository — in an excludes list — and that nothing applied or removed.
   * A schema approval is not a third audience: it is a person's judgement,
   * asked before a run (`lingtai ask`) or held at the merge lane for a
   * migration, and both of those are `human`. An enum value with no writer is
   * a legal state nobody can reach, which is how the need went unmet for as
   * long as it did.
   */
  needsFrom: z.enum(["human", "external"]),
  /**
   * The run that asked, or null for a question asked **before any run** — by
   * `lingtai ask`, which is the one appender that has no run to name (#147).
   * Null is what a queue pass and the prompt both read as *this was asked of a
   * person about the ticket, not about an attempt at it*.
   */
  runId: z.string().nullable(),
  /**
   * Which kind of block this is — the distinction #83 found the log could not
   * make. Both of these were `WorkItemBlocked` with a string, and they are
   * opposite kinds of thing:
   *
   *   `judgement`       a decision that is genuinely a person's, as a `human:`
   *                     gate asks for. *held at the merge gate: agent/112 into
   *                     develop.*
   *   `acknowledgement` something failed and nobody has decided what to do.
   *                     *conflict: agent/112 does not merge into develop.*
   *
   * One wants judgement; the other wants a diagnosis nobody has written yet.
   * Null on a v1 event, which recorded neither — and guessing which of the two
   * a historical block was would be worse than saying so.
   */
  needs: z.enum(["judgement", "acknowledgement"]).nullable(),
  /** Null when nobody has diagnosed it, which is every block written before #83. */
  diagnosis: BlockDiagnosis.nullable(),
});

/**
 * A person answered the block. `note` **is** the answer — `lingtai answer`'s
 * choice, or `lingtai requeue`'s why — and the fold keeps it (#147): a record
 * that can say what was asked and never what was decided is not a record.
 *
 * **`withdrawn`, when a question asked before any run is taken back** rather
 * than answered — `lingtai requeue` on it. `note` is then why it was withdrawn,
 * and the fold keeps no answer: *asked by mistake, ignore* is not a decision
 * any attempt should be told to build. Absent on every other unblock, which is
 * every one written before it existed.
 */
export const WorkItemUnblocked = z.object({
  by: z.string(),
  note: z.string(),
  withdrawn: z.literal(true).optional(),
});

/**
 * How "merged is not correct" becomes queryable. #134 and #136 were bugs filed
 * against code that #58 had already merged, and nothing connected them.
 */
export const WorkItemLinked = z.object({
  relation: z.enum(["caused-by", "follows-up", "duplicates"]),
  otherRef: z.string(),
});

export const WorkItemLanded = z.object({ mergeCommit: z.string(), base: z.string() });

/**
 * A person decided nobody is going to do this — the second terminal, and the
 * first one that is not an outcome of work (#151).
 *
 * Before it, a lifecycle had two ends: `landed`, and `blocked` forever. Closing
 * a ticket was `gh issue close` by hand, which appends nothing, so the fold went
 * on saying `backlog` and the board went on offering the card as *Queued* — an
 * item nobody would ever claim, sitting where things that are going to be worked
 * sit. `wi-lingtai-32` sat there for two days.
 *
 * **Appended, not deleted.** Every event before it stays where it was and a
 * replay reaches the same place; what changes is that the item now has an end,
 * so the queue passes over it *because the log says it is over* rather than
 * because GitHub stopped offering it — which is the offer side, and an accident.
 *
 * **Nothing lifts it.** Reopening the issue does not un-close the item: a work
 * item's stream is the story of one ticket, and grafting a second onto it would
 * carry the attempt count, the findings and the spend of work done under an
 * intent that is no longer the intent, into every prompt after it. If the work
 * is wanted again, open a new ticket.
 */
export const WorkItemClosed = z.object({ by: z.string(), reason: z.string() });

/** Capability matching refused the dispatch. Never silently downgrade a tier. */
export const DispatchRefused = z.object({
  requiredTier: Tier,
  runtime: RuntimeId,
  missing: z.array(z.string()),
});

// --------------------------------------------------------------- prepare ----




// ------------------------------------------------------------------- run ----

/**
 * How a runtime was actually invoked — not merely which one.
 *
 * `RunStarted` said `runtime: "claude-code"` and stopped there, so *"what
 * command did we run"* had no answer: no argv, no flags, no tier as applied and
 * no limits as applied. Every one of those is something a run can be explained
 * by, and none of them was written down (#88).
 *
 * **The prompt is elided from `args`, deliberately.** `claude -p <prompt>` puts
 * the whole document in argv, and the whole document is already on this stream
 * as `RunPrompted`. One copy is the record; a second one in the event that is
 * read first is 4.6 KB of noise in front of the seven fields somebody opened
 * this to see.
 */
export const Invocation = z.object({
  /** The executable, as spawned. */
  command: z.string(),
  /** argv as applied, with a placeholder where the prompt itself went. */
  args: z.array(z.string()),
  /** The containment this run executed at: the recipe's, matched before dispatch. */
  tier: Tier,
  /** The limits in force, in the units the runtime was handed them. */
  limits: z.object({ turns: z.number().int(), wallMs: z.number().int() }),
});
export type Invocation = z.infer<typeof Invocation>;

export const RunStarted = z.object({
  workItemId: z.string(),
  runtime: RuntimeId,
  model: z.string(),
  promptVersion: z.string(),
  baseSha: z.string(),
  /** Hash of the recipe as read from origin/<base>, never from the agent's branch. */
  configHash: z.string(),
  worktree: z.string(),
  /**
   * Added in v2 (#88). Null for a v1 event, which recorded the runtime's name
   * and nothing about how it was called — and null for a runtime that cannot
   * describe its own invocation, because recording nothing is better than
   * recording a reconstruction that might not be what ran.
   */
  invocation: Invocation.nullable(),
});

/**
 * The prompt an agent was handed. The whole of it.
 *
 * This was `{ promptVersion, bytes }`: two numbers about a document, and not
 * the document. Every other input to a run is reconstructible from the log —
 * the recipe by `configHash`, the code by `baseSha`, the environment by the
 * names the recipe required — and the prompt was the only one that was neither
 * recorded nor recoverable. `promptVersion: "ticket@1911"` is a template name
 * and a length, and the ticket body it was filled with can be edited on GitHub
 * afterwards. So the single most expensive thing this system does could not be
 * explained afterwards, which is #88.
 *
 * **Retention, measured rather than assumed.** `#59`'s prompt was 4,593 bytes
 * and this log holds a few hundred events; a thousand runs of that is about
 * 5 MB, against a table whose other rows are already tens of thousands of
 * bytes of gate evidence. There is therefore no retention policy for this
 * field, and inventing one now would be guessing at a shape nothing has. The
 * number that would change that is the share of `events` it accounts for:
 *
 *     select pg_size_pretty(sum(pg_column_size(data))) from events
 *      where type = 'RunPrompted';
 *
 * If that ever rivals the rest of the table the answer is to truncate at append
 * time and say in the payload that it was truncated — never to delete, which
 * the log's no-delete rule forbids in any case.
 */
export const RunPrompted = z.object({
  promptVersion: z.string(),
  bytes: z.number().int(),
  /**
   * Added in v2 (#88). Null for a v1 event, which recorded only the length.
   *
   * `bytes` stays rather than being derived from this, so a v1 event and a v2
   * event answer "how big was it" the same way.
   */
  prompt: z.string().nullable(),
});

export const RunTouchedFile = z.object({ path: z.string(), op: z.enum(["edit", "write", "delete"]) });

/** Compaction means the ticket was scoped too large. That is a metric, not noise. */
export const RunContextExhausted = z.object({ turn: z.number().int() });

export const RunAwaitingInput = z.object({ prompt: z.string() });

export const RunProducedDiff = z.object({
  branch: z.string(),
  headSha: z.string(),
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
});

/**
 * What a claim left on origin, appended whichever way that went
 * ([0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md) §1, `#251`).
 *
 * **Because the absence of a ref had four meanings and nothing could tell them
 * apart.** `#250` ran out of turns with two commits in its worktree, pushed
 * neither `agent/250` nor `agent/250-attempt-1`, and was collected — $26.84
 * recovered from unreachable git objects by luck. The only account the
 * finalizer that publishes could give was `runLog.note`, and a run log is a
 * **trace and never a record** (0034 §8): it is deleted when the run lands, it
 * is not on the log a claim is settled by, and a *successful* push wrote
 * nothing to it at all. So *it found nothing*, *it was refused*, *it succeeded*
 * and *it never ran* were one silence, and which of them happened on `#250` is
 * a question no observation can now answer.
 *
 * One type rather than four, and appended on **every** outcome including the
 * ones that are not failures: what the incident needed was not a record of
 * pushes but the answer to *did this happen at all*, and only an event that is
 * always there answers that. It settles nothing and nothing reads it to decide
 * anything — `run.ts` has no case for it — which is 0034 §8's test passed on
 * purpose, in the other direction: the account belongs on the log because it
 * outlives the file, not because anything branches on it.
 *
 * **Every outcome of the publish, which is not every run.** A run that *landed*
 * has none of these and is meant to: the finalizer that publishes is skipped on
 * a landing (0062 §4 would only have to take the arm ref back off), and the
 * merge lane's own push to the base writes no row. So a stream with
 * `RunStarted`, a terminal event and no `RunRefsPublished` says the publish
 * never ran **only where the run did not land** — read without that, every
 * successful run in the log comes back as a publish that did not fire, which
 * buries the signal this type exists to make.
 *
 * **And it is the store's word for it, so the absence is evidence and not
 * proof.** The append that writes this row is made with its own defect handler
 * and a store that refuses the row is swallowed there on purpose: raising it
 * would abort the publish before the `RunProducedDiff` the next attempt's brief
 * reads, and a ref nobody will fetch is a worse ending than a ref nobody
 * explained. So a publish that ran, pushed, and could not say so leaves the
 * sentence in the run log and in the conductor's output instead, and a reader
 * who finds no row on a run that did not land should look in both before
 * concluding the finalizer never fired.
 */
export const RunRefsPublished = z.object({
  /** `agent/<n>` — the ref the next attempt's prompt tells an agent to fetch. */
  branch: z.string(),
  /**
   * `agent/<n>-attempt-<k>` — this claim's own, written by nothing else
   * (0062 §2), so it is still there when `agent/<n>` has moved on.
   */
  arm: z.string(),
  /**
   * The head the refs this outcome names point at, or null when nothing was
   * pushed. On `arm-only` it is the arm's, and `branch` is somebody else's.
   */
  headSha: z.string().nullable(),
  /**
   * Which of the five it was.
   *
   * `nothing-committed` is an ending with no commits, which publishes nothing on
   * purpose — a ref to an empty branch is a worse lie than the absence (0062
   * §1). `already-published` is this pass's own second call: a stop publishes
   * before it asks a person, and the finalizer then finds the head already
   * where it wanted it — which is the row that says the finalizer ran.
   *
   * **`arm-only` is there because `git push` is not atomic** (`#251`). The two
   * refspecs go in one command and origin judges them one at a time: the arm is
   * forced and nothing else writes it, while `agent/<n>` carries a
   * `--force-with-lease` a sibling claim can invalidate between the cut and the
   * push. Origin then takes the arm, rejects the branch, and `git push` exits
   * non-zero — one bit about two refs. Read as `refused` that is a row saying
   * *nothing was pushed* over commits that are on origin, and the next attempt
   * is told *Nothing* while the one ref that survived goes unfetched, which is
   * the loss this type exists to end. So the publish confirms the arm before it
   * decides, and where the arm is up `RunProducedDiff` names **the arm** rather
   * than a `agent/<n>` that is no longer this run's.
   */
  outcome: z.enum([
    "published",
    "nothing-committed",
    "already-published",
    "arm-only",
    "refused",
  ]),
  /** Git's own words when `refused` or `arm-only`, and null otherwise. */
  detail: z.string().nullable(),
});

/** The moment the gate pipeline fires. */
export const RunProposedCompletion = z.object({ headSha: z.string() });

export const RunFinished = z.object({
  exitCode: z.number().int(),
  turns: z.number().int(),
  durationMs: z.number().int(),
  costUsd: z.number().nullable(),
});

/**
 * How a run ended when it did not end well.
 *
 * The list is the value and the type is read off it, for the reason
 * `LABEL_STATES` is: a kind that has to be enumerated at runtime — by
 * `repair.ts`'s total record of whose failure each one is — cannot be a bare
 * union written out twice.
 *
 * `never-started` is [0031](../../../doc/decisions/0031-a-run-that-never-started.md)
 * §1, and it is **named for what is checkable and not for the cause we
 * inferred**: zero turns, zero cost, `is_error`. A run that spent nothing and
 * took no turns did not fail at its task, it failed to begin — which covers a
 * quota, a signed-out runtime and an expired credential alike, in a way no
 * wording can take away. Naming it `quota` would put a reading of English prose
 * in the log, and the first re-worded message would turn the name into a lie.
 * The prose is kept whole in `detail`: evidence, not a verdict.
 *
 * `out-of-turns` is `#89`: the runtime stopped the run at the recipe's
 * `runtime.limits.turns`. It is not `timeout`, because *"it ran out of turns"*
 * and *"it ran out of time"* are different findings about a ticket, and it is
 * not `crash`, which is where `error_max_turns` used to land beside a segfault.
 *
 * Additive to the enum. No stored event is rewritten and no version is bumped —
 * every payload a previous build wrote still parses against this.
 */
export const RUN_FAILURE_KINDS = [
  "timeout",
  "crash",
  "no-commits",
  "aborted",
  "never-started",
  "out-of-turns",
] as const;

export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

export const RunFailed = z.object({
  kind: z.enum(RUN_FAILURE_KINDS),
  detail: z.string(),
});

// ------------------------------------------------------------------ gate ----

/**
 * Verification, code review and human approval are one primitive: a named
 * check that produces a verdict about a specific diff. `onSha` is what makes a
 * verdict about a diff rather than about a ticket — so a force-push invalidates
 * an approval instead of inheriting it, which a label could never do.
 */
/**
 * `gate` is the step; `action` is what ran there.
 *
 * Two fields rather than one because "the build failed" and "something at the
 * `proposed` step failed" are different questions, and a single name could not
 * answer both. `onSha` binds the verdict to a commit, which is what makes a force-push
 * invalidate it by arithmetic rather than by anybody noticing.
 *
 * **The field is still spelled `gate` for the four steps that gate and for the
 * six that do not.** Renaming it would be a payload change on nine event types
 * bought for nothing: what the field holds is a `Step`, the schema says so, and
 * the only reader that could be misled is one who took the field's name for the
 * model rather than its type.
 */
const gateBase = { gate: Step, action: z.string(), runId: z.string(), onSha: z.string() };

/**
 * The plan for a run: all ten steps, and what will run at each.
 *
 * One event, appended before anything is claimed. It exists because the log
 * could not otherwise say what was *supposed* to happen — `ProjectConfigured`
 * carries a `configHash`, not the configuration, so a step with nothing
 * configured was indistinguishable from a step that did not exist.
 *
 * That distinction is what the whole model rests on ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4). A step nobody configured is skipped, and that is the user's decision; a
 * step that *was* configured and did not run is Lingtai's bug. Comparing this
 * to the verdicts that follow is how the second is detectable, and rendering it
 * is how the board shows an empty step as `skipped` rather than omitting it.
 *
 * **Ten since 2026-09-23, and the count is asserted rather than described.**
 * `.length(10)` is the whole of 0047's claim — *what a run was given is on the
 * log* — made checkable: if the recipe configured `claim` by tag and the log
 * recorded five steps, whether it picked by tag or by assignee would be
 * nowhere ([0058](../../../doc/decisions/0058-lingtai-is-a-development-pipeline.md) §5).
 *
 * **It is `schemaVer: 4`, and the step from 3 is the whole of what widening
 * this field cost.** 0061 §7 spends this history by *resetting* it, and that
 * reset is [the-pipeline](../../../doc/design/the-pipeline.md)'s T5, which has
 * not run — so every `GatesResolved` this log holds names five steps, and a
 * `.length(10)` reached with no step in between refuses all of them. Not at
 * the margin either: the refusal escapes `decodeRow` as a bare `ZodError`, so
 * the projectors stop at the first such seq and never advance past it, and
 * every reader of a run's stream dies with them. The step widens a stored plan
 * to all ten and gives the five that did not exist `[]` — which is what those
 * runs were given, because the vocabulary had no word for them and nothing
 * could have been configured there. **`schemaVer` is where that is paid, and
 * only there**: the nine `1 → 2` steps below are about the `diff` rename, they
 * still walk the rows the log holds, and lowering *them* buys nothing.
 *
 * Since v3 it also carries `recipe`, the canonical recipe `configHash` is the
 * hash of ([ADR 0047](../../../doc/decisions/0047-the-recipe-a-run-got-is-on-the-log.md)),
 * so a past run is explicable after the file has moved and after the recipe has
 * no commits to read it at. **It is a record, never a source**: nothing in
 * `conductor`, `recipe` or `actions` reads it back to decide anything — the next
 * run's recipe is read from the base branch, as ever (0005) — and
 * `conductor/unit/recorded-recipe.test.ts` holds that line.
 */
export const GatesResolved = z.object({
  runId: z.string(),
  configHash: z.string(),
  /** Every step, in order, with the ordered action names resolved for it. */
  points: z.array(z.object({ gate: Step, actions: z.array(z.string()) })).length(10),
  /**
   * `canonical(recipe)` as an object: parsed, `undefined` dropped, keys sorted —
   * exactly what `hashRecipe` hashes, so `hashRecipe(recipe) === configHash` and
   * a reader can verify it without trusting the writer.
   *
   * **Absent, not empty, on a v1 or v2 event**: nothing recorded it, and today's
   * recipe read back onto it would be the log claiming a configuration nobody
   * ran. Names environment variables and never their values (0021, 0047 §4).
   */
  recipe: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What the `end` point resolved to, and the outcome it resolved against.
 *
 * `end` is the point that cannot refuse: its actions run for effect.
 *
 * This event exists because **resolving them is a decision and carrying them
 * out is not**. The conductor reads the recipe — which is what the conductor
 * does — and appends what it resolved; `tell.ts` then does it, inline, and
 * appends whether GitHub took it.
 *
 * The original reason was narrower: the outbox that carried the effects was a
 * projection, and a projection may read the log and nothing else, so it could
 * never read a recipe. 0022 deleted the outbox and the reason outlived it — a
 * rebuild that had to re-resolve `end` would depend on a recipe that has since
 * changed, and would produce a different answer for the same history.
 */
export const EndActionsResolved = z.object({
  /**
   * The four endings. `closed` joined them with `#151` (0044): `end` is the
   * point that fires on every terminal outcome, so a fourth outcome that this
   * schema refused was a point that could not resolve for it — the refusal a
   * test found rather than a reader, which is the argument for the enum being
   * here at all.
   */
  outcome: z.enum(["landed", "blocked", "failed", "closed"]),
  /**
   * `refs` is the third, and it is the one that **deletes** (`#240`): the
   * `agent/<n>-attempt-<k>` refs a landed ticket's abandoned approaches left on
   * `origin`, and `branch` says whether `agent/<n>` goes with them. It carries
   * no ref names, for the reason the other two carry no issue number — the
   * stream says which work item this is, and a list resolved minutes before the
   * delete would be a list that can disagree with what is actually there.
   *
   * **Additive to the union**, so no stored event is rewritten and no version
   * is bumped.
   */
  actions: z.array(
    z.union([
      z.object({ name: z.string(), close: z.literal(true) }),
      z.object({ name: z.string(), labels: z.array(z.string()) }),
      z.object({ name: z.string(), refs: z.literal(true), branch: z.boolean() }),
    ]),
  ),
});

export const GateRequested = z.object(gateBase);
export const GateStarted = z.object(gateBase);

/**
 * How bad a defect is, **worst first**.
 *
 * The order is the rubric's own, and it is load-bearing rather than
 * presentational: *at or below the bar* is a comparison of two positions in
 * this list, so a `backlog:` bar of `minor` files a minor and lets a major
 * refuse. `severest` in `packages/conductor/src/fix.ts` walks it in this
 * direction for the same reason.
 *
 * **Exported because it is the only copy of the ladder, and that is a claim
 * tests hold rather than a comment** (`#237`). Five places used to spell the
 * three names out and none of them linked here: `parseFindings` and
 * `verdictFor` in `packages/actions/src/agent-action.ts`, `severest`, and the
 * `GateFinding` interfaces in `packages/domain/src/run.ts` and
 * `packages/actions/src/action.ts`. Each reads this array, or the `Severity` it
 * yields, so a fourth severity added here reaches all of them at once —
 * `packages/actions/unit/agent-action.test.ts` and
 * `packages/conductor/unit/fix.test.ts` walk the array against those
 * consumers, so a copy re-introduced is a red test.
 *
 * What a new member does **not** reach by arithmetic is a **bar**, because a
 * bar is a position in this list somebody chose. There are two of them today
 * and they are one rule read twice: `verdictFor`'s, which says what refuses,
 * and `backlogProjection`'s in `packages/projector/src/backlog.ts`, which says
 * what is filed. `decideBacklog` in `packages/conductor/src/backlog.ts` is
 * that one comparison as a function, and the `backlog:` plugin's schema in
 * `packages/recipe/src/recipe.ts` is this array again.
 */
export const SEVERITIES = ["blocker", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * One finding, as a reviewer reported it.
 *
 * Named and shared because a finding now travels: it is the evidence on a
 * `GateFailed`, it is what a fixing agent is handed verbatim, and it is what the
 * re-review is asked to re-check
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
 * Three copies of the shape would be three places for `failureScenario` to be
 * summarised away, and the whole mechanism is that it is not.
 */
const Finding = z.object({
  file: z.string(),
  line: z.number().int().nullable(),
  claim: z.string(),
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: z.string(),
  severity: z.enum(SEVERITIES),
});

export type Finding = z.infer<typeof Finding>;

/**
 * A pass carries its findings too (`#135`).
 *
 * A `minor` does not refuse, so a review whose worst finding is one passes —
 * and before this field everything it said was flattened into `evidence`, on a
 * gate nobody opens because it passed. `evidence` is what a person reads and
 * `findings` is what a program reads; neither replaces the other. A pass with
 * nothing to say carries an empty array, never an absent field
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §5).
 */
export const GatePassed = z.object({
  ...gateBase,
  evidence: z.string(),
  findings: z.array(Finding),
});

export const GateFailed = z.object({
  ...gateBase,
  evidence: z.string(),
  findings: z.array(Finding),
});

/**
 * The gate's agent never started, so the point produced no verdict about the
 * diff — [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §1,
 * one layer up.
 *
 * `RunFailed.kind = "never-started"` says this about a run; this says it about
 * the agent inside a gate, and the two are the same finding at two depths. A
 * quota is met by whichever agent asks next, and the second agent in a pass is
 * a reviewer: the build passed, the reviewer never ran, and what the log said
 * was that a review gate refused the diff (`#133`).
 *
 * **It is not `GateFailed` and must never be folded into one.** A failure is a
 * sentence about this diff and this is a sentence about the account — the
 * distinction the whole ticket turns on. Nor is it `GatePassed`: a green gate
 * for a diff nobody assessed is the other way to be wrong.
 *
 * `detail` is the runtime's own words, kept whole for the reason
 * `RunFailed.detail` is: it is the evidence the classification refused to read,
 * and 0031 §4 reads a reset time back out of it.
 *
 * Version 1, and it stays there. The **nine** types ADR 0018's rename moved —
 * `GatesResolved`, the four `Gate*` verdicts, `GateWaived` and the three
 * `Approval*` — are at 2 or above because each needed a step from 1; nothing
 * ever wrote one of *these* with the old name, so there is nothing to upcast.
 * `GateDidNotFinish` is younger still and never carried the old name either; it
 * is at 2 for a reason of its own, which is `#234` dropping the two fields
 * 0057 §4's retry wrote and nothing to do with the rename. 0061 §7
 * will spend those nine steps along with the log they walk — **when the reset
 * happens**, which is `the-pipeline.md`'s T5 and has not: a reader lowering
 * those numbers before then makes every stored row of those nine unreadable
 * and blames the writer for it.
 */
export const GateNeverRan = z.object({ ...gateBase, detail: z.string() });

/**
 * The gate's agent **started**, ended without a receipt, and so judged nothing
 * — [0057](../../../doc/decisions/0057-a-gate-that-did-not-finish.md) §1.
 *
 * The third of the three ways a gate's agent can end, and until this event the
 * log had two. A reviewer that crashed after twenty turns wrote `GateFailed`,
 * which is the event a reviewer that read the diff and refused it writes, and
 * everything downstream believed it: `run-once.ts` bought a fix round, and a
 * fixing agent was paid to answer a question nobody asked (`#196`,
 * `run-9e510ffc`). The difference existed only inside the `evidence` sentence,
 * and a sentence is not something `decideFix` or the board reads.
 *
 * **It is not `GateNeverRan` either, and that is 0057 §3.** *Never started*
 * means an account-wide wall and stands the conductor down (0041); a crash is
 * local — a bad settings path, a broken binary, a reused session id (`#195`) —
 * and stopping the queue for it would be the same category error pointed the
 * other way.
 *
 * `detail` is the runtime's own words, whole, for the reason `GateNeverRan`'s
 * is: they are about the machinery and never about the diff.
 *
 * **`attempt` and `retrying` are gone, and the retry they described with them**
 * (`#234`, `schemaVer: 2`). 0057 §4 ran the action once more and said which
 * attempt each event was; the retry recomputed the crashed attempt's session id
 * — `sessionIdFor` hashes `<runId>:review:<action>:<sha>`, which a second
 * attempt does not move (`agent-gate.ts:356`, `claude-code.ts:93`) — so
 * `claude` refused it in zero seconds, twice on this machine's logs and never
 * once reaching a reviewer. What the two fields bought the reader was a *second
 * attempt that never ran*: an event saying `attempt: 2, retrying: false` about a
 * pass in which the action was tried once. So the action is run once, one of
 * these is appended, and there is no number to carry.
 *
 * The rows already written keep both fields and the upcaster drops them on read,
 * for `WorkItemClaimed`'s `leaseUntilMs` reason: no event is rewritten, so the
 * reader is what has to stop believing them.
 */
export const GateDidNotFinish = z.object({ ...gateBase, detail: z.string() });

/** Humans need an escape hatch. It is recorded, never silent. */
export const GateWaived = z.object({ ...gateBase, by: z.string(), reason: z.string() });

export const ApprovalRequested = z.object({ ...gateBase, question: z.string(), artifacts: z.array(z.string()) });
export const ApprovalGranted = z.object({ ...gateBase, by: z.string(), note: z.string() });
export const ApprovalRevoked = z.object({ ...gateBase, by: z.string(), reason: z.string() });

// --------------------------------------------------------------- backlog ----

/**
 * A person accepted a minor finding
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5, `#137`).
 *
 * **This is the decision, not the issue.** *Lingtai proposes; a person decides
 * it exists* — and a person's decision is a fact the log can hold, where an
 * issue is a fact only the repository can. So it is appended first, at version
 * 0 of the finding's own stream, before the store is asked for anything: a
 * decline or a second accept that races it loses at the append, and it is the
 * only accept there will ever be for this finding.
 *
 * What the ticket will say is fixed here too (`kind`, `labels`), so that
 * opening it again after a failure opens the same ticket and not whatever the
 * retry happened to type.
 *
 * Followed by `FindingProposed` once the store has the ticket. Until then the
 * entry is *accepted, not yet opened*, and opening it is safe to repeat: the
 * store's `propose` is idempotent on the finding's key.
 */
export const FindingAccepted = z.object({
  project: z.string(),
  /** `findingKey` — stable across attempts of one ticket. */
  key: z.string(),
  by: z.string(),
  kind: z.string(),
  labels: z.array(z.string()),
});

/**
 * The ticket store has the ticket an accepted finding asked for (`#137`).
 *
 * Appended after the store answered, never before, and only onto a stream whose
 * last event is `FindingAccepted` — so there is one of these per finding, and
 * the ref it records is *the* ticket. An opener that loses the append to
 * another one with a different ref closes its own as a duplicate: the log
 * decides which issue is the finding's, and nothing is left open that the log
 * does not name.
 *
 * The finding itself is not repeated: it is on the `GatePassed` the backlog
 * folded, and `key` is how the two are joined.
 */
export const FindingProposed = z.object({
  project: z.string(),
  key: z.string(),
  by: z.string(),
  /** The store's own identity for the ticket: `"212"` on GitHub. */
  externalRef: z.string(),
  url: z.string().nullable(),
});

/**
 * A person declined a minor finding.
 *
 * Recorded because *a decision nobody can see is one that gets asked twice*:
 * the next attempt's review will very likely say the same thing, and the
 * backlog keys it to the same entry, which this has already closed. Only ever
 * at version 0 — an accepted finding is not declined afterwards.
 */
export const FindingDeclined = z.object({
  project: z.string(),
  key: z.string(),
  by: z.string(),
  reason: z.string(),
});

// ----------------------------------------------------------- integration ----

export const IntegrationAttempted = z.object({ workItemId: z.string(), branch: z.string(), headSha: z.string() });
export const IntegrationRefused = z.object({
  workItemId: z.string(),
  branch: z.string(),
  reason: RefusalReason,
  detail: z.string(),
});
export const IntegrationSucceeded = z.object({
  workItemId: z.string(),
  branch: z.string(),
  base: z.string(),
  mergeCommit: z.string(),
});

// -------------------------------------------------------------- repair ----

/**
 * **Retired** (`#143`). Readable for ever, appended never: `RETIRED` below,
 * refused by `store.append`.
 *
 * It recorded that a failure of the managed repository's had bought one agent —
 * a whole new run, told what went wrong, which the next claim became. That was
 * [0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md), and
 * [0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md)
 * §Consequences takes the purchase away: the worktree lives as long as the
 * pass, so **a refusal is answered where it happened** and a new run stops
 * being the answer to anything except a run that ended. `FixRequested` below
 * is what a refusal buys now.
 *
 * `#142` had already taken the conflict, which was the whole of what this was
 * for. What was left reaching it was a `gate-failed` — either a `proposed`
 * refusal carrying no criterion, the one `decideFix` declines to buy for, so
 * buying a whole *run* for it was the same decision made twice with opposite
 * answers, or a `merge:` gate, which runs after the round loop and reaches the
 * lane without `decideFix` ever being asked — and a
 * `no-commits`, which is a branch holding nothing the base does not, and a new
 * run from scratch is 0039's expensive wrong answer stated as a definition.
 * Both now block for a person carrying `diagnoseRefusal`'s reading of them.
 *
 * The rows stay because [0019](../../../doc/decisions/0019-a-second-reset.md)
 * says they must, for the reasons written out on `OutboxDelivered` below: a
 * type the log still holds can be neither deleted nor skipped on read.
 * `priorAttempts` still folds both of these into an earlier attempt's refusal,
 * which is the *keep reading them for ever* half of retirement.
 *
 * The three fields that carried the bound are described as they were written,
 * and nothing reads them to decide anything now. `fingerprint` is the failure
 * hashed, so one agent was bought per **distinct** failure; `attempt` was
 * 1-based against a ceiling from the recipe; `runId` is the run that failed,
 * which is how a repair whose own run failed was recognised. `detail` is the
 * refusal verbatim, which is the `#112` complaint inverted and the reason these
 * rows are still worth reading.
 */
export const RepairRequested = z.object({
  /** The run whose failure bought this. */
  runId: z.string(),
  reason: RefusalReason,
  detail: z.string(),
  fingerprint: z.string(),
  attempt: z.number().int().positive(),
});

/**
 * **Retired** with `RepairRequested` above, and for the same reasons.
 *
 * It recorded a failure that bought nothing and named the rule that refused,
 * so that a card was never left saying only `conflict: agent/112 does not
 * merge into develop` (`#84`). Every lane refusal is that now, so there is no
 * longer a pair for the event to keep apart: the sentence it carried is the
 * block's own `diagnosis.done`, written from `whoseFailure` rather than from a
 * decision about money.
 */
export const RepairDeclined = z.object({
  runId: z.string(),
  reason: RefusalReason,
  detail: z.string(),
  fingerprint: z.string(),
  /** The sentence the card shows. Names the rule that refused, not just "no". */
  why: z.string(),
});

// ------------------------------------------------------------------ fix ----

/**
 * A review refusal bought an agent, inside the run that was refused
 * ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §1).
 *
 * On the **run's** stream and not the work item's, which is the difference
 * between this and `RepairRequested`: a repair is the next run, told what went
 * wrong, and the item goes back to the queue to get it. A fix happens while the
 * worktree is still there and the diff is still the thing under discussion, so
 * nothing is released and no second claim is involved — the gates simply run
 * again on a head that moved.
 *
 * **`findings` is the acceptance contract and the reason this event exists.**
 * It is what the fixer was handed, `failureScenario` verbatim, written before
 * anybody knew what the fix would be (§2). The re-review is asked whether those
 * sequences still produce those outcomes, so the log has to hold the question
 * that was asked rather than a summary of it — a deleted line makes a finding's
 * *text* go away, and this is what it cannot make go away.
 */
export const FixRequested = z.object({
  /** The run whose review refused. The fixer runs inside it. */
  runId: z.string(),
  /** 1-based, against `runtime.limits.rounds` (0039 §3 — `repair.fix` is gone). */
  round: z.number().int().positive(),
  /**
   * That ceiling, so *round 2 of 3* is readable from the event.
   *
   * A projection is a fold and may not read a recipe, so a card carrying
   * `round` alone carries a numerator with no denominator — and with `#146`'s
   * second ceiling beside it, *which arm is this* becomes a question the log
   * has to be able to answer on its own. Zero on every event written before the
   * field existed, and the reading of zero is *not recorded*, which is why the
   * note says `round 2` rather than `round 2 of 0` for one of those.
   */
  of: z.number().int().nonnegative().default(0),
  /** The action whose refusal bought this — the reviewer's name. */
  action: z.string(),
  /** The head the findings were made against. */
  onSha: z.string(),
  findings: z.array(Finding),
});

/**
 * What the fixing agent produced, and what it cost.
 *
 * A spend is a fact the log has to hold whichever way it went, so
 * `headSha` is nullable rather than absent: a fixer that committed nothing
 * ran, cost money and moved nothing, and that is a different ending from one
 * whose commit the re-review then refused.
 */
export const FixApplied = z.object({
  runId: z.string(),
  round: z.number().int().positive(),
  /** The head after the fixer committed, or null when it committed nothing. */
  headSha: z.string().nullable(),
  turns: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  /** The runtime's own ending, when it did not finish. Null when it did. */
  failure: z.string().nullable(),
});

/**
 * A review refusal that bought no fixer, and why — including the round that ran
 * out of budget, which is the ordinary ending.
 *
 * `RepairDeclined`'s argument, for the other purse: "nothing happened because
 * nobody asked for it" and "nothing happened and we do not know why" are the two
 * things a log exists to keep apart. This is also the event behind the sentence
 * a person is shown — **two agents disagreed** — so the findings still live are
 * on it rather than only in prose.
 */
export const FixDeclined = z.object({
  runId: z.string(),
  /** Rounds already spent when this was decided. Zero when none was bought. */
  round: z.number().int().nonnegative(),
  action: z.string(),
  /** The sentence the card shows. Names the rule that refused, not just "no". */
  why: z.string(),
  /** What is still live, as the reviewer last said it. */
  findings: z.array(Finding),
});

// ------------------------------------------------------------- restart ----

/**
 * A pass spent its rounds, and the recipe bought another **approach** rather
 * than a person's attention
 * ([0040](../../../doc/decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)).
 *
 * On the **work item's** stream, immediately before the release that puts it
 * back in the queue — the same ordering as `RepairRequested`, and for a
 * related reason. There it is what the *next claim becomes*; here it is only
 * what the next claim is *allowed to be*, because a restart is told nothing a
 * second attempt is not already told. `attempts.ts` writes the abandoned
 * branch, its sha, the fetch command and the findings into every second prompt
 * already, which is what made
 * [experiment 011](../../../doc/experiments/011-patching-versus-starting-over.md)'s
 * second arm work at all — so there is no pending record to consume and no
 * prompt of its own. The next pass is an ordinary one.
 *
 * **The second ceiling is counted off these rather than remembered**, exactly
 * as `repairs` is (0025 §3): a length against a number from the recipe survives
 * a rebuild and has no counter to forget to increment.
 *
 * `findings` is what was still refused when this arm ended, and it is why the
 * event is worth its bytes. Each later arm's findings are on that arm's own run
 * stream; this arm's are on a stream no later pass reads, so a person handed the
 * item when the last restart is spent would otherwise see only the final
 * refusal — and the claim being tested is precisely that the arms disagree.
 */
export const PassRestarted = z.object({
  /** The pass whose rounds were spent. */
  runId: z.string(),
  /** 1-based, against `runtime.limits.restarts`. */
  restart: z.number().int().positive(),
  /** That ceiling, so a card can say *restart 1 of 2* without reading a recipe. */
  of: z.number().int().positive(),
  /** The action that refused — the reviewer's name. */
  action: z.string(),
  /** Rounds this arm spent before the ceiling stopped it. */
  rounds: z.number().int().nonnegative(),
  /**
   * The branch the abandoned approach is on, and the head it left there.
   *
   * **On origin, because this is appended after the pass pushes it.** A pass
   * that spent its rounds never reached its own push, so these two named
   * commits that lived in a deleted worktree and nowhere else — while
   * `attempts.ts` told the next agent to fetch them. The conductor publishes
   * the approach before it records the arm; an arm on the log is therefore an
   * arm that can be read.
   *
   * **This arm's own ref — `agent/<n>-attempt-<k>` — and not `agent/<n>`**
   * (`armBranch`; `k` is the claim's attempt ordinal since
   * [0062](../../../doc/decisions/0062-what-a-claim-leaves-behind.md) §2, because
   * a restart ordinal is not defined for the endings that now publish too).
   * The working branch is what the next prompt names, so each
   * restart takes it over, force, from a history with no ancestor in common
   * with the last: recording it here would make every arm but the newest name
   * a sha origin no longer has, which is the reading a person gets exactly
   * when they are shown all of them at once. One name per arm, so the
   * paragraph above is true of every one of them.
   */
  branch: z.string(),
  headSha: z.string(),
  /** What was still refused when this arm ended, as the reviewer last said it. */
  findings: z.array(Finding),
});

// --------------------------------------------------------------- control ----

/**
 * What an operator told the conductor to do.
 *
 * In the log because it is a decision somebody made, and `ApprovalGranted` is
 * already exactly that shape — "who stopped the conductor at four o'clock"
 * should not need a different mechanism than "who approved this merge"
 * ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)).
 *
 * It also means a command issued while the daemon is restarting is *waiting*
 * when it comes back, rather than being a race somebody has to handle.
 *
 * Liveness deliberately does **not** go here. A heartbeat every few seconds
 * fails the log's admission test — is this worth remembering later — and would
 * bury everything that is.
 */
export const ConductorPaused = z.object({
  by: z.string(),
  reason: z.string(),
  /**
   * When this pause lifts by itself, as an ISO instant — or null, which is
   * every pause a person makes.
   *
   * [0031](../../../doc/decisions/0031-a-run-that-never-started.md) §5: a run
   * that never started is an account-wide condition with a *time* attached, and
   * the alternative to folding that time is what happened — the limit lifted at
   * 23:00 and the queue was still idle at 23:12, waiting out a guess. A
   * person's pause carries no expiry and must not start carrying one: the whole
   * point of it is that it holds until they say otherwise.
   *
   * Defaulted rather than required, so that every `ConductorPaused` written
   * before this field existed still parses as the pause it was.
   */
  until: z.string().nullable().default(null),
});

export const ConductorResumed = z.object({ by: z.string() });

/**
 * Stop, once the pass in flight has finished.
 *
 * A command and not a signal, and that is the whole of
 * [0030](../../../doc/decisions/0030-shutting-down-safely.md): Ctrl+C reaches
 * the foreground *group*, so the signal that begins the shutdown kills the
 * agent at the same instant, and `kill <pid>` reaches the daemon alone and
 * orphans it. Neither can mean *finish what you are holding*. An append can,
 * and it lands the way a pause does — at the daemon's next opportunity, with no
 * restart, and waiting in the stream when the daemon is down.
 *
 * `timeoutMs` is null by default and that is a decision rather than an
 * omission (0030 §6): a drain that gives up after some minutes recreates the
 * orphan it exists to prevent, silently, at the moment it matters most. When
 * somebody sets one, what it does when it trips is stop taking work, leave the
 * agent running and exit — deliberately creating the orphan the next
 * conductor's reconcile kills.
 *
 * `ConductorResumed` lifts it, as it lifts a pause: a request nothing can
 * withdraw would be one that stopped every daemon started after it, for ever.
 */
export const ConductorShutdownRequested = z.object({
  by: z.string(),
  reason: z.string(),
  timeoutMs: z.number().int().positive().nullable(),
  /**
   * Stop without letting the ticket in flight finish (`#159`).
   *
   * **Safe is the default, and the flag is the loud one.** A drain is what
   * anybody wants nine times in ten — the pass, not the agent, so the gates and
   * the merge lane run too — and a command whose ordinary form throws away work
   * in progress is a command people learn to fear. `--force` is for the tenth:
   * a pass that is going nowhere, a machine that has to stop now.
   *
   * What it does is exactly what `--timeout` already did when it tripped, and
   * what a second Ctrl+C does: stop taking work, leave the agent running, exit.
   * The orphan is deliberate and is already somebody's job — the next
   * conductor's `reconcile` kills it and releases the claim, guarded on the host
   * and the process's own argv. So this adds a way to ask for that state, not
   * the state itself.
   *
   * Defaulted rather than required, so every request written before this reads
   * as the drain it was.
   */
  force: z.boolean().default(false),
});

/**
 * A conductor started, from this commit, at this person's hand.
 *
 * **Stopping was an event and starting was state**, and the asymmetry cost an
 * answer. A daemon was restarted at 23:06 on 2026-09-09 and nobody can say by
 * whom: a start left a beacon, and a beacon says *a daemon is running now* — not
 * that one started, from what code, or who asked for it.
 *
 * `sha` is the whole reason this is worth remembering later, and it is the field
 * `daemon_status` could never carry honestly. That evening's daemon started from
 * `582a0f8`, a commit that had not been pushed; a `git pull --rebase` twenty
 * minutes later rewrote it to `2926f2d` and `582a0f8` stopped existing anywhere
 * but in that process's memory. The beacon is one mutable row, so the next start
 * overwrote what the last one was running; a row in the log cannot be
 * overwritten, and [0042](../../../doc/decisions/0042-the-restart-is-a-command.md)
 * is what keeps the commit it names pushed.
 *
 * It does **not** withdraw a standing `ConductorShutdownRequested`. Starting and
 * being told to stop are independent facts — a daemon started while a request
 * stands reads it and stops again, deliberately. `ConductorShutdownWithdrawn`
 * is the withdrawal, and it names the request it lifts.
 */
export const ConductorStarted = z.object({
  /**
   * `human:<user>` only where a person's hand is actually on it: `lingtai
   * restart`, or `lingtai daemon` typed at a terminal. A daemon whose stdin is
   * not a terminal — launchd's `KeepAlive`, a script, `nohup` — is recorded as
   * `daemon`, because the log saying a person started what launchd started by
   * itself is the unattributable 23:06 again, only confidently wrong.
   */
  by: z.string(),
  /** Why, when whoever started it said. `lingtai restart` carries its reason. */
  reason: z.string().nullable().default(null),
  /**
   * The commit `HEAD` pointed at, frozen for the life of the process.
   *
   * Null only where there was no checkout to read — an installed copy or a
   * tarball. 0010's *the source runs unbuilt* removes the build and not the
   * restart, so this is the deployed version of Lingtai, recorded at the one
   * moment it is decided.
   */
  sha: z.string().nullable(),
  dirty: z.boolean(),
  /**
   * `host:pid`, spelled the way `WorkItemClaimed.worker` spells it.
   *
   * One string, so a claim and the start of the process that made it join
   * without anybody translating between two conventions.
   */
  worker: z.string(),
  /**
   * Never written since #167, and kept so the starts already on the log parse.
   *
   * It named the `ConductorShutdownWithdrawn` a supervisor's start answered,
   * when a `lingtai restart` handed its start to launchd or systemd (0042 §8).
   * Since #159 a daemon folds only what was appended after it started, so the
   * daemon the supervisor started never read the handoff it was to answer, and
   * recorded itself as `daemon` with null here. [0048](../../../doc/decisions/0048-a-signal-is-aimed-at-one-daemon.md)
   * deleted the handoff; the restart now compares this event's `sha` with the
   * commit it checked instead.
   */
  handoff: z.number().int().positive().nullable().default(null),
});

/**
 * One shutdown request lifted — the one named, and nothing else.
 *
 * `ConductorResumed` lifts a request too, and it lifts a pause with it, which
 * is right for `lingtai resume` and wrong for `lingtai restart`: a restart has
 * to withdraw the drain *it* asked for, so the daemon it starts does not read
 * the request and stop again, and a pause somebody else made is none of its
 * business. The first attempt at this resumed and then re-appended the pause —
 * two appends, so an append landing between them destroyed a person's pause —
 * and resumed whatever request stood, so a drain a second person asked for
 * during the wait was lifted too.
 *
 * `version` is that request's position on `ctl-conductor`. The fold lifts the
 * standing request only when it is at that version, so a withdrawal that lost a
 * race to a newer request is a no-op in the log rather than an overruling of it.
 */
export const ConductorShutdownWithdrawn = z.object({
  by: z.string(),
  version: z.number().int().positive(),
  reason: z.string(),
  /**
   * Never written since #167, and kept so the withdrawals already on the log
   * parse. It carried the commit a supervised restart checked, for the daemon
   * the supervisor started — which, since #159, never read it (0048).
   */
  handoff: z
    .object({ sha: z.string().nullable(), dirty: z.boolean() })
    .nullable()
    .default(null),
});

/**
 * Run this one now, ahead of the queue.
 *
 * The same mechanism rather than a second channel: a person asking for a
 * specific ticket is a decision, and it belongs beside the pause that came
 * before it.
 */
/**
 * GitHub said something about the queue changed.
 *
 * The queue is not in the log (0012), so a webhook cannot append the change
 * itself — what it can do is say that one happened, which is enough to wake the
 * daemon into asking GitHub. That keeps one mechanism instead of two: the loop
 * already wakes on appends, and this is an append.
 *
 * `delivery` is GitHub's own id for the delivery. It makes a retry — which
 * GitHub does, several times, on any non-2xx — cheap to recognise and drop.
 */
/**
 * **Retired** ([0022](../../../doc/decisions/0022-the-seams.md)). Readable for
 * ever, appended never: `RETIRED` below, refused by `store.append`.
 *
 * It recorded a delivery the outbox worker made. There is no outbox — three
 * calls to GitHub did not need a table, a projection, a worker, a backoff and a
 * dead-letter, and the failure all of that retried was never once observed.
 * `IssueUpdated` records the same fact without the queue.
 *
 * The rows stay because [0019](../../../doc/decisions/0019-a-second-reset.md)
 * says they must. Deleting a type the log still holds makes every stream
 * carrying it unreadable from its first row — that is what took
 * `projection rebuild` out and forced the second reset — and skipping rows on
 * read is not an option at any price: `run-once` computes `expectedVersion` as
 * `(await store.read(id)).length`, so a read that drops rows makes every later
 * append fail a concurrency check.
 */
export const OutboxDelivered = z.object({
  /** `<seq>:<kind>` — stable across replay, because seq is. */
  ref: z.string(),
  kind: z.string(),
  target: z.string(),
  /** Whatever identifies the thing that was created, when there is one. */
  detail: z.string(),
});

/** **Retired** with `OutboxDelivered` above, and for the same reasons. */
export const OutboxFailed = z.object({
  ref: z.string(),
  kind: z.string(),
  target: z.string(),
  error: z.string(),
  permanent: z.boolean(),
});

/**
 * Lingtai told GitHub something about an issue, and it landed.
 *
 * The noun is the issue rather than the outbox that used to carry it: a queue
 * is an implementation detail and an event name must not spend the log's
 * vocabulary on one ([0022](../../../doc/decisions/0022-the-seams.md)) — which
 * this pair outlived by two commits, as intended. The kind is a field rather
 * than an event type each, which would have been ten once the failures are
 * counted.
 *
 * **`refs` is the fifth and the only one that is not a write to the issue**
 * (`#240`): it deletes the `agent/<n>-attempt-<k>` refs a landed ticket left
 * behind. It is recorded here rather than under a noun of its own because it
 * is one of `end`'s effects and `tell.ts` is what carries those out — a second
 * carrier is a path that forgets one, which is the failure `end-point.ts`'s own
 * header is about. `detail` is the refs that went, so *nothing was there* and
 * *thirteen were deleted* are different rows.
 *
 * `body` is the fourth, and it is
 * [0032](../../../doc/decisions/0032-the-page-is-organised-by-attempt.md) §6:
 * an instruction meant to outlive one attempt is edited into the issue body,
 * where it versions as `ticket@NNNN`, everybody can see it, and every
 * subsequent attempt reads it. **Additive to the enum**, so no stored event is
 * rewritten and no version is bumped — the same widening `RUN_FAILURE_KINDS`
 * made for `never-started`.
 *
 * `conductor` decides *which* labels, from the work item's state; `github`
 * takes the union with whatever labels somebody else put on the issue, because
 * that needs GitHub's current state and a decision must not.
 *
 * Appended by `conductor`'s `tell.ts`, at the moment it tells GitHub. It was
 * added one commit ahead of that so the commit which deleted the outbox was
 * only about the deletion.
 */
export const IssueUpdated = z.object({
  project: z.string(),
  issue: z.string(),
  change: z.enum(["comment", "labels", "closed", "body", "refs"]),
  /** Whatever identifies what happened: a comment id, the labels that were set, the refs deleted. */
  detail: z.string(),
});

/**
 * The same attempt, refused.
 *
 * There is no retry behind this, and that is the point. The old loop called
 * `gh` inline and a failed call left nothing at all, so afterwards nobody could
 * tell *we never commented* from *we commented and it did not help*. This keeps
 * the record without keeping the machine: what did not land, `reconcile`
 * converges by comparing what the log says an issue should look like against
 * what GitHub says it does.
 */
export const IssueUpdateFailed = z.object({
  project: z.string(),
  issue: z.string(),
  change: z.enum(["comment", "labels", "closed", "body", "refs"]),
  error: z.string(),
});

export const QueueChanged = z.object({
  project: z.string(),
  /** `issues.opened`, `issues.labeled`, and so on. */
  reason: z.string(),
  delivery: z.string(),
});

export const RunRequested = z.object({
  project: z.string(),
  issue: z.string(),
  by: z.string(),
});

/**
 * Somebody asked a question about one work item.
 *
 * On the control stream, beside `pause` and `now`, because it is the same kind
 * of thing: the UI controls and the daemon holds
 * ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md),
 * [0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §3). It spends
 * money, and everything that spends money in this system starts in one place.
 *
 * **No `consumed` event, for the reason `RunRequested` has none.** A request is
 * satisfied when `chat-<id>` carries an answer for it, so the count of asks
 * against the count of answers is the whole state machine — and a daemon that
 * was down when the question was asked finds it waiting rather than losing it.
 *
 * `chatId` is supplied by whoever asks, so a follow-up turn is another
 * `DiscussionRequested` carrying the same one. The conversation is a stream and
 * not a session; nothing has to still be running between two questions.
 */
export const DiscussionRequested = z.object({
  /** `chat-<uuid>`, which is also the stream the exchange lands on. */
  chatId: z.string(),
  workItemId: z.string(),
  /** The attempt being asked about, 1-based, or null for the item as a whole. */
  attempt: z.number().int().nullable(),
  question: z.string(),
  by: z.string(),
});


// ------------------------------------------------------------ discussion ----


/**
 * A question put to the discussion assistant, and what it was given to answer
 * with.
 *
 * On `chat-<id>`, which holds the whole exchange (0033 §6). Self-contained like
 * everything else here: `workItemId` is on every ask, so the stream is readable
 * without joining against the control stream that asked for it.
 *
 * **`reading` is Lingtai's sentence, not the assistant's**, and that is the
 * point of the field. `worktree.ts` resets an attempt's branch with `-B` on
 * every run, so an attempt that committed nothing never had one — `#89`'s
 * second attempt is exactly that case, and reading `main` silently instead is
 * what killed the repair. Recorded before the assistant speaks, so the blind
 * spot cannot be hidden by an answer that does not mention it.
 */
export const DiscussionAsked = z.object({
  workItemId: z.string(),
  attempt: z.number().int().nullable(),
  by: z.string(),
  question: z.string(),
  /** What was actually readable, in words — including the branch that was not there. */
  reading: z.array(z.string()),
});

/**
 * What the assistant said, what it read to say it, and what it cost.
 *
 * **Every ending appends one**, `failure` included — the rule `RunFailed`
 * exists for, one agent along. 0033 §4 gives this agent a meter rather than a
 * limit, and a meter that can miss a spend is not one: a run that cost money
 * and then failed has to leave the money on the log.
 *
 * `proposal` is the artefact the assistant is proposing, and null when it is
 * only answering. It is *not* the artefact being adopted — a person clicks for
 * that, and the click is what appends `PromptEdited` or writes the ticket
 * (0033 §2). The two kinds are the two that already exist; there is no third.
 *
 * `cannot` is §5, made a field so it survives skimming: what the assistant
 * could not establish, in its own words. Reading the shipped bundle reaches
 * *"`error_max_turns` is among the subtypes"* and no further, and an assistant
 * that laundered that into *the binary accepts the flag* would repeat exactly
 * what cost `#89` two attempts.
 */
export const DiscussionAnswered = z.object({
  text: z.string(),
  /** `main:packages/agent/src/claude-code.ts` — every file served, in order. */
  read: z.array(z.string()),
  /** What it said it could not establish without a command it does not have. */
  cannot: z.array(z.string()),
  /** What it proposes writing down, and where. Null when it only answered. */
  proposal: z
    .object({ kind: z.enum(["prompt", "ticket"]), text: z.string() })
    .nullable(),
  turns: z.number().int(),
  durationMs: z.number().int(),
  costUsd: z.number().nullable(),
  /** Set when the assistant did not finish. Null on an ordinary answer. */
  failure: z.string().nullable(),
});

/**
 * One line on the work item for a whole conversation.
 *
 * The pointer 0033 §6 decides on. A forty-turn exploration appended to the work
 * item would drown the history the detail page exists to show, and the log is
 * append-only, so it would drown it permanently. Discarding the conversation
 * instead would leave *"why does this prompt say that?"* unanswerable and — the
 * meter being the only bound — money spent with no record.
 *
 * `outcome` names which of the two artefacts it produced, and `none` is an
 * ordinary answer: a question that was answered and needed nothing written down
 * is the commonest discussion there is.
 */
export const DiscussionHeld = z.object({
  chatId: z.string(),
  /** The whole conversation's spend. Null when nothing reported a cost. */
  costUsd: z.number().nullable(),
  outcome: z.enum(["prompt", "ticket", "none"]),
  by: z.string(),
});

/**
 * A sentence added to the next run's prompt, and to that one only.
 *
 * [0032](../../../doc/decisions/0032-the-page-is-organised-by-attempt.md) §5.
 * On the **work item** stream and not on an approval: `approve()` binds to
 * `onSha` and a force-push voids it by arithmetic, while an edit is about *what
 * to do* and not about which diff to merge.
 *
 * It applies to the next run only, whoever starts it — `reduceWorkItem` holds
 * it as `pendingPrompt` and the next `WorkItemClaimed` consumes it. Something
 * meant to last belongs in the GitHub ticket, where everybody can see it and it
 * versions as `ticket@NNNN`; a durable override living only inside Lingtai
 * would be a shadow ticket body (§6).
 *
 * `#104` owns the editable prompt box on the board. This is the carrier it and
 * the discussion assistant share, and it is here because `#105`'s first output
 * is exactly this event.
 *
 * **schemaVer 2 — `hash` and `basedOn`.** `#104` asks this event to carry *the
 * text, the hash, who wrote it and what it was based on*, and the two that were
 * missing are the two that make it auditable. Without `hash` the number in the
 * next run's `promptVersion` is recomputed by a reader and believed; without
 * `basedOn` an edit is a sentence with no statement of what it was a change to,
 * which for a *yes, but* is most of the meaning.
 */
export const PromptEdited = z.object({
  /**
   * The text the next run's prompt carries, whole.
   *
   * **Empty is the removal.** `reduceWorkItem` clears `pendingPrompt` on a blank
   * one, so *Remove the edit* is an append like every other decision here and
   * who withdrew it is on the log rather than only its absence being.
   */
  text: z.string(),
  /**
   * The digest of `text` — the `human@…` half of the next run's `promptVersion`.
   *
   * Recorded and not merely derivable: the version is what the log uses to say
   * two runs were told different things, and a number the event carries can be
   * checked against the one the run recorded. Null on a removal, which has no
   * text to hash, and on a schemaVer 1 event, which recorded neither.
   */
  hash: z.string().nullable(),
  by: z.string(),
  /**
   * The composed version this was written against — `ticket@1924+failure@1c5708ba`.
   *
   * What the person was looking at when they typed. Null when there was no
   * composed prompt in front of them, which is every edit a discussion
   * concludes with: the assistant proposes a sentence, not a change to a
   * document.
   */
  basedOn: z.string().nullable(),
  /** The discussion it came out of, when one did. */
  chatId: z.string().nullable(),
});


// --------------------------------------------------------------- project ----


/**
 * A repository is on its way in: recorded, visible, and not yet conducted.
 *
 * **The stream's first event, and the only thing pending is** (`#163`). There
 * is no projects table and no `pending` column: a project is the fold of
 * `prj-{project}`, and `isRegistered` is `project !== null && configHash !==
 * null`. `configHash` arrives with `ProjectConfigured`, which is appended only
 * after a recipe has been read — so *this repository has a recipe* was already
 * the line between registered and not, and pending is the other side of a line
 * that has been there all along ([0022](../../../doc/decisions/0022-the-seams.md)).
 *
 * The wizard ends on this machine: it writes `~/.lingtai/<project>/recipe.yml`
 * and nothing to the repository, so there is no pull request and nothing to
 * merge (0046 §3, #182). Pending waits for `Recheck` on the board's card, which
 * is what finishes it: the board is a render and the daemon does not know
 * repositories it has not onboarded, so nothing finishes it automatically.
 *
 * `slug` is `owner/repo` as it was given, because the owner is what a later
 * `lingtai add` has to be told and the repository name alone cannot be reached.
 * `base` is the wizard's reading of the default branch, and only a hint to
 * `add`: `Recheck` passes it unnamed (`resumeOnboarding`), so a recipe that
 * declares another branch is adopted. **Neither `Recheck` nor anything else
 * reads the repository's `base` for a recipe** — the recipe is the machine's.
 *
 * `by` is `human:<id>`, as every decision here is recorded
 * ([0007](../../../doc/decisions/0007-dual-runtime.md)). It is an OS username today and
 * a verified identity later — recorded now so the line becomes trustworthy
 * without being rewritten.
 */
export const ProjectOnboardingStarted = z.object({
  /** `owner/repo`, as the wizard was given it. */
  slug: z.string(),
  /** The default branch the wizard saw — a hint to `add`, never where a recipe is read from. */
  base: z.string(),
  /** Who asked for it — `human:<id>`. */
  by: z.string(),
});

/**
 * The recipe as resolved from origin/<base>, hashed so replays can be compared.
 *
 * Two fields were added after the fact, and both for the same reason: what was
 * recorded turned out not to be enough to find the recipe again.
 *
 * `owner` is **schemaVer 2**. Version 1 recorded only the repository name, so
 * `lingtai status` could not reach GitHub for a project it had itself registered.
 *
 * `base` is **schemaVer 3**. Without it a run had to fall back to the
 * repository's *default* branch to find the recipe — which is only the same
 * branch by convention. `nextloom-ai-admin`'s default was a feature branch, so a
 * run would have read its rules from one branch and merged into another. The
 * base a project is governed from is a decision made once, at onboarding, and it
 * belongs in the log rather than in whatever GitHub happens to point HEAD at.
 *
 * Both are nullable because events written before the field existed genuinely
 * did not record it, and inventing a value for them would be worse than saying
 * so.
 */
export const ProjectConfigured = z.object({
  project: z.string(),
  owner: z.string().nullable(),
  base: z.string().nullable(),
  configHash: z.string(),
  fromSha: z.string(),
});

/**
 * A conductor's pass could not look at this project, and said why — **on the
 * transition, never while it lasts**.
 *
 * `#148`. A daemon started at `cc6e856` read a recipe from `main` that `be9fd26`
 * had just given `env.refuseHosts`, and its frozen schema refused the key on
 * every sweep for hours. The pass kept the other projects going, which is right,
 * and wrote one console line per sweep, which was the whole of the record.
 * `DispatchRefused` looks as if it covers this and does not: it is about tiers,
 * and it is appended after a claim that a pass unable to read its recipe never
 * reaches.
 *
 * It is `PassOutcome.refused` on the log — the catch in `conduct.ts`, and
 * nothing else — for a throw before the pass had looked at the project. A throw
 * after, from a project whose recipe resolved and whose queue was being worked,
 * stays in the outcome and is not this. A run that `runOnce` stops before its
 * claim is not this either.
 *
 * **`ref` and `codeSha` are what make it worth having.** The same message means
 * *this repository's recipe is broken* when the process is current, and *this
 * process is too old for a recipe that is fine* when it is not. Without the
 * commit beside it the event records a symptom nobody can act on.
 *
 * Appended only when it differs from the refusal already on record — see
 * `passTransition` — so a sweep on a loop does not write the same row every few
 * seconds into a log that keeps it for ever.
 */
export const ProjectRefused = z.object({
  project: z.string(),
  /** The error, as the pass caught it. */
  detail: z.string(),
  /** The branch the recipe was read from. Null when the pass failed before it knew. */
  ref: z.string().nullable(),
  /** The commit the refusing process was loaded from. Null when it recorded none. */
  codeSha: z.string().nullable(),
});

/**
 * A pass looked at a project it had refused, and did not refuse it.
 *
 * The other half of `ProjectRefused`, and the reason neither needs a clock
 * (0027): *it is refusing* is a refusal with no recovery after it, and *it was
 * refusing and stopped* is one with. Without it a reader would have to guess from
 * the age of the last refusal — the lease, back again.
 */
export const ProjectRecovered = z.object({
  project: z.string(),
  ref: z.string().nullable(),
  codeSha: z.string().nullable(),
});

/**
 * What a restarted daemon found that the log did not predict, and what it did.
 *
 * **Recorded, not quietly repaired.** A system that silently tidies up after
 * itself cannot tell you it has been crashing: the disk gets cleaner, the
 * symptom disappears, and you find out six weeks later. The old harness's
 * integrate step had six silent `return 1` paths and this is the same failure
 * wearing a different hat.
 *
 * A batch rather than one event per finding, because "what did the restart at
 * 04:12 find" is the question people actually ask — a startup that found
 * nothing appends nothing at all.
 */
export const Reconciled = z.object({
  findings: z.array(
    z.object({
      stream: z.string(),
      expected: z.string(),
      actual: z.string(),
      /**
       * What was done about it: `removed`, or `reported` when nothing was.
       *
       * Added in v2. Without it the event says a divergence existed and leaves
       * you to guess whether it still does, which is most of what you wanted
       * to know.
       */
      action: z.string(),
    }),
  ),
});

// ------------------------------------------------------------ github app ----


/**
 * The team's GitHub App was minted from a manifest (`#169`).
 *
 * **Two fields, and the rest of that response is the reason this schema is
 * this short.** GitHub's conversion hands back six values in one message, and
 * three of them are secrets: the private key, the webhook secret, and an OAuth
 * client secret Lingtai has no flow for. The log is append-only and permanent,
 * and `lingtai projection rebuild` replays it faithfully — so a secret written
 * here cannot be taken back out, and would be read aloud by every rebuild
 * for ever. The key goes to a `0600` file, the webhook secret to the env file,
 * the OAuth pair is dropped at the seam (`@lingtai/github`'s `CreatedApp`), and
 * what is recorded is **the id and the slug and nothing else**.
 *
 * Both of the two earn their place. `appId` is what
 * `LINGTAI_GITHUB_APP_ID` was set to, so *which App is this installation's* is
 * a question the log answers rather than a file on one machine. `slug` builds
 * the install link — `https://github.com/apps/<slug>/installations/new` — which
 * is creation's only handover to installing it (`#168`).
 *
 * **It says an App was minted, and never that one is configured.** It is
 * appended the moment the conversion returns — before the key file and the env
 * file — so that a write which fails still leaves a record of the App it failed
 * for. Folded into *configured*, it would report exactly those failures as
 * finished Apps. What is configured is what the environment and the env files
 * say, and `hasGitHubApp()` reads those files per call, so nothing needs a
 * restart to see a written App. This event names an App of ours on GitHub whose
 * key may never have landed; the setup page names it and **keeps offering
 * creation beside it**, and only a form posted before it was minted is refused.
 */
export const GitHubAppCreated = z.object({
  /** The App ID, as `LINGTAI_GITHUB_APP_ID` now carries it. */
  appId: z.string(),
  /** `lingtai-…` — what the person named it, as GitHub slugged it. */
  slug: z.string(),
});

// ------------------------------------------------------------- extension ----


/**
 * An event subscriber was handed an event and did not come back from it.
 *
 * [0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md) gave a
 * subscriber's failure one outcome — *logged and dropped* — and dropping is
 * what makes the one failure a subscriber must not have invisible: a notifier
 * that has silently stopped notifying looks exactly like a quiet week. This is
 * the same argument 0016 §4 makes for `GatesResolved`, that a thing you cannot
 * see is a thing you forget you never had.
 *
 * **It is a record and not a retry.** 0015's other rule stands: a subscriber is
 * for effects that are worthless late, so nothing here is tried again. What the
 * event buys is that `lingtai doctor` can say a subscriber is failing, which is
 * the whole of the difference between a broken notifier and a silent one.
 *
 * `project` is null for the events that belong to no repository — everything on
 * the control stream, which is where a pause, a shutdown and a question live.
 */
export const PluginFailed = z.object({
  /**
   * Which subscriber: the `name:` of a recipe's `subscribers:` entry — this
   * repository's is `desktop` — or `discuss`, the one the daemon still names
   * for itself. Rows appended before #123 say `notify`, which was the daemon's
   * name for the notifier it built by hand.
   */
  name: z.string(),
  /** The type it was given. Not the payload: a failure is not a place to copy one. */
  eventType: z.string(),
  project: z.string().nullable(),
  /**
   * What it did instead of returning — the message, or that it never returned.
   *
   * A hang reads as `did not return within …`, because from the boundary's side
   * a subscriber that never settles and one that rejects are the same failure:
   * whatever it was going to do, nobody was told.
   */
  reason: z.string(),
});

// -------------------------------------------------------------- registry ----

export const EVENTS = {
  WorkItemDiscovered,
  WorkItemClaimed,
  WorkItemReleased,
  WorkItemBlocked,
  WorkItemUnblocked,
  WorkItemLinked,
  WorkItemLanded,
  WorkItemClosed,
  DispatchRefused,
  RunStarted,
  RunPrompted,
  RunTouchedFile,
  RunContextExhausted,
  RunAwaitingInput,
  RunProducedDiff,
  RunRefsPublished,
  RunProposedCompletion,
  RunFinished,
  RunFailed,
  GatesResolved,
  EndActionsResolved,
  GateRequested,
  GateStarted,
  GatePassed,
  GateFailed,
  GateNeverRan,
  GateDidNotFinish,
  GateWaived,
  ApprovalRequested,
  ApprovalGranted,
  ApprovalRevoked,
  FindingAccepted,
  FindingProposed,
  FindingDeclined,
  IntegrationAttempted,
  IntegrationRefused,
  IntegrationSucceeded,
  RepairRequested,
  RepairDeclined,
  FixRequested,
  FixApplied,
  FixDeclined,
  PassRestarted,
  ConductorPaused,
  ConductorResumed,
  ConductorShutdownRequested,
  ConductorStarted,
  ConductorShutdownWithdrawn,
  OutboxDelivered,
  OutboxFailed,
  IssueUpdated,
  IssueUpdateFailed,
  QueueChanged,
  RunRequested,
  DiscussionRequested,
  DiscussionAsked,
  DiscussionAnswered,
  DiscussionHeld,
  PromptEdited,
  ProjectOnboardingStarted,
  ProjectConfigured,
  ProjectRefused,
  ProjectRecovered,
  Reconciled,
  GitHubAppCreated,
  PluginFailed,
} as const;

export type EventType = keyof typeof EVENTS;
export type PayloadOf<T extends EventType> = z.infer<(typeof EVENTS)[T]>;

/**
 * Current payload shape per type. Everything starts at 1; a type that has moved
 * on is listed here, and the same commit adds its upcaster in `upcast.ts`.
 */
const BUMPED: Partial<Record<EventType, number>> = {
  // 2: added `owner`. 3: added `base`. See ProjectConfigured above.
  ProjectConfigured: 3,
  // 2: added `title` and `kind`, because the queue left the log. 3: dropped
  // `leaseUntilMs` — the lease is deleted (0027). The field is still in every
  // historical row and the upcaster drops it on read; no event is rewritten.
  WorkItemClaimed: 3,
  // 2: added `needs` and `diagnosis`. A block could say only *what is your
  // question*, so a conflict and a `human:` gate reached a person as the same
  // event with a string on it (#83).
  WorkItemBlocked: 2,
  // 2: added `invocation` — the command, the tier and the limits as applied,
  // where there had only been the runtime's name (#88).
  RunStarted: 2,
  // 2: carries the prompt text and not only its length (#88). See above.
  RunPrompted: 2,
  // 2: added `hash` and `basedOn`, so an edit says which number it contributed
  // to the next run's `promptVersion` and what it was a change to (#104).
  PromptEdited: 2,
  // 2: each finding gained `action`. See Reconciled above.
  Reconciled: 2,
  // 2: added `of` — the `rounds` ceiling the round is counted against, so a
  // fold can say *round 2 of 3* without reading a recipe (`#146`).
  FixRequested: 2,
  // 2: the `diff` gate point became `proposed` (ADR 0018). Nine types carried
  // a gate point when that landed, so nine of them move together — a payload
  // whose `gate` is still `diff` would fail the enum rather than pass wrongly,
  // which is why every one of them needs the step and none can be skipped.
  //
  // **These numbers may not come down while the log holds rows at them.**
  // 0061 §7 spends this history — the `diff` rename's — and the thing that
  // spends it is the *reset*, `the-pipeline.md`'s T5, with T5b's fold before
  // it, neither of them landed. A version lowered ahead of the reset
  // sends every stored row down `upcast`'s `schemaVer > supported` branch,
  // where the message says the writer is newer than the reader and the cause
  // is that the reader's number was lowered.
  //
  // 3: added `recipe`, the canonical recipe the run was resolved against (0047).
  // 4: `points` names all ten steps where it named five (0058 §3). The reset
  // that was to have spent this history has not run, so the log is still full
  // of five-step plans and `.length(10)` would refuse every one of them on
  // read; the step from 3 widens them, giving the five steps that did not
  // exist the `[]` those runs were in fact given.
  GatesResolved: 4,
  GateRequested: 2,
  GateStarted: 2,
  // 3: added `findings`, the shape `GateFailed` carries, so a minor on a
  // passing review is structured rather than prose inside `evidence` (#135).
  GatePassed: 3,
  GateFailed: 2,
  // 2: dropped `attempt` and `retrying` with the retry they described (`#234`,
  // 0057 §4). Nothing carried the `diff` point here — this type is younger than
  // that rename — so 1 → 2 is the drop and not the rename's step.
  GateDidNotFinish: 2,
  GateWaived: 2,
  ApprovalRequested: 2,
  ApprovalGranted: 2,
  ApprovalRevoked: 2,
};

export const SCHEMA_VER: Record<EventType, number> = Object.fromEntries(
  (Object.keys(EVENTS) as EventType[]).map((k) => [k, BUMPED[k] ?? 1]),
) as Record<EventType, number>;

/**
 * Types the log holds and nothing appends again.
 *
 * The refusal is on the write side because the read side has no honest way to
 * decline a row — see the note on `OutboxDelivered`. Retiring is therefore two
 * things and only the second can be enforced: stop writing them, and keep
 * reading them for ever.
 */
export const RETIRED: ReadonlySet<EventType> = new Set<EventType>([
  "OutboxDelivered",
  "OutboxFailed",
  // A lane refusal buys nothing, so nothing decides whether it bought an agent
  // (`#143`, 0039 §Consequences). See the note on `RepairRequested`.
  "RepairRequested",
  "RepairDeclined",
]);

export function isRetiredEventType(t: string): boolean {
  return isEventType(t) && RETIRED.has(t);
}

export function isEventType(t: string): t is EventType {
  return Object.hasOwn(EVENTS, t);
}

/** Parse a stored payload, or throw. The store never hands out unvalidated data. */
export function parsePayload<T extends EventType>(type: T, data: unknown): PayloadOf<T> {
  return EVENTS[type].parse(data) as PayloadOf<T>;
}
