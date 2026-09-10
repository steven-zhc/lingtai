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

/** Which containment a project demands. See doc/decisions/0005. */
export const Tier = z.enum(["open", "guarded", "sandboxed"]);
export type Tier = z.infer<typeof Tier>;

/**
 * The five points in the loop where the conductor waits for a verdict.
 *
 * **Closed forever** ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §3). Four of them name a branch the loop already had — dispatch, preparation,
 * the gate pipeline, the merge hold — and `end` was added for the things that
 * must happen once an item is finished, which had nowhere to be declared before.
 *
 * A gate is a *place*, not a kind of check. What runs there is open and comes
 * from the recipe; where it can run is not. That is what lets extension be
 * unbounded while the core stays finite.
 *
 * `end` is the one that cannot refuse — nothing can be stopped once a merge has
 * landed. Recorded as an imprecision rather than smoothed over: a separate
 * concept for it would cost more than the imprecision does.
 *
 * `proposed` was called `diff` until
 * [ADR 0018](../../../doc/decisions/0018-the-proposed-point.md). Stored events
 * still carry the old value and are upcast on read; a reader who finds `diff`
 * in the log or in an old recipe is looking at history, not at a bug.
 */
export const GatePoint = z.enum(["admit", "prepared", "proposed", "merge", "end"]);
export type GatePoint = z.infer<typeof GatePoint>;

/**
 * The five, in the order the loop reaches them.
 *
 * Exported as a tuple because "every point, in order" is a thing several places
 * need to iterate — `GatesResolved`, the board, `lingtai add` — and each writing its
 * own list is how one of them ends up missing a point and nobody notices.
 */
export const GATE_POINTS = GatePoint.options;

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
 * (#83). The three values are exactly the three moves a card has: `approve` and
 * `reject` answer an `ApprovalRequested`, and `requeue` is what is left when
 * there is no diff to answer about. A recommendation the board cannot carry out
 * would be a sentence rather than a recommendation.
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
  /** Who has to answer. `needs` says *what* of them. */
  needsFrom: z.enum(["human", "schema", "external"]),
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

export const WorkItemUnblocked = z.object({ by: z.string(), note: z.string() });

/**
 * How "merged is not correct" becomes queryable. #134 and #136 were bugs filed
 * against code that #58 had already merged, and nothing connected them.
 */
export const WorkItemLinked = z.object({
  relation: z.enum(["caused-by", "follows-up", "duplicates"]),
  otherRef: z.string(),
});

export const WorkItemLanded = z.object({ mergeCommit: z.string(), base: z.string() });

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
 * Additive to the enum. No stored event is rewritten and no version is bumped —
 * every payload a previous build wrote still parses against this.
 */
export const RUN_FAILURE_KINDS = [
  "timeout",
  "crash",
  "no-commits",
  "aborted",
  "never-started",
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
 * `gate` is the point; `action` is what ran there.
 *
 * Two fields rather than one because "the build failed" and "something at the
 * `proposed` point failed" are different questions, and a single name could not
 * answer both. `onSha` binds the verdict to a commit, which is what makes a force-push
 * invalidate it by arithmetic rather than by anybody noticing.
 */
const gateBase = { gate: GatePoint, action: z.string(), runId: z.string(), onSha: z.string() };

/**
 * The plan for a run: all five points, and what will run at each.
 *
 * One event, appended before anything is claimed. It exists because the log
 * could not otherwise say what was *supposed* to happen — `ProjectConfigured`
 * carries a `configHash`, not the configuration, so a point with nothing
 * configured was indistinguishable from a point that did not exist.
 *
 * That distinction is what the whole model rests on ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4). A gate nobody configured is skipped, and that is the user's decision; a
 * gate that *was* configured and did not run is Lingtai's bug. Comparing this
 * to the verdicts that follow is how the second is detectable, and rendering it
 * is how the board shows an empty point as `skipped` rather than omitting it.
 */
export const GatesResolved = z.object({
  runId: z.string(),
  configHash: z.string(),
  /** Every point, in order, with the ordered action names resolved for it. */
  points: z.array(z.object({ gate: GatePoint, actions: z.array(z.string()) })).length(5),
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
  outcome: z.enum(["landed", "blocked", "failed"]),
  actions: z.array(
    z.union([
      z.object({ name: z.string(), close: z.literal(true) }),
      z.object({ name: z.string(), labels: z.array(z.string()) }),
    ]),
  ),
});

export const GateRequested = z.object(gateBase);
export const GateStarted = z.object(gateBase);
export const GatePassed = z.object({ ...gateBase, evidence: z.string() });
export const GateFailed = z.object({
  ...gateBase,
  evidence: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().nullable(),
      claim: z.string(),
      /** No failure scenario, no finding. An observation without one is an opinion. */
      failureScenario: z.string(),
      severity: z.enum(["blocker", "major", "minor"]),
    }),
  ),
});

/** Humans need an escape hatch. It is recorded, never silent. */
export const GateWaived = z.object({ ...gateBase, by: z.string(), reason: z.string() });

export const ApprovalRequested = z.object({ ...gateBase, question: z.string(), artifacts: z.array(z.string()) });
export const ApprovalGranted = z.object({ ...gateBase, by: z.string(), note: z.string() });
export const ApprovalRevoked = z.object({ ...gateBase, by: z.string(), reason: z.string() });

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
 * A failure of the managed repository's bought one agent.
 *
 * **Not a sixth gate point** ([0025](../../../doc/decisions/0025-a-failure-buys-one-agent.md)).
 * The five stay closed; this is what happens *after* a failure, and the repair
 * it buys is an ordinary run — same claim, same worktree, same gates. The only
 * thing that distinguishes it is that its prompt was told what went wrong.
 *
 * On the **work item's** stream, immediately before the release that puts it
 * back in the queue, because that ordering is the whole mechanism: the fold
 * sees a repair pending, and the next claim is that repair.
 *
 * Three fields carry the bound, and all three are needed (0025 §3):
 *
 *   `fingerprint`  the failure, hashed. One agent per **distinct** failure, not
 *                  one per pass — a second `conflict` on the same files is the
 *                  same failure and buys nothing.
 *   `attempt`      1-based, against the recipe's ceiling.
 *   `runId`        the run that failed. A repair whose own run fails is
 *                  recognisable from this, and does not buy an analysis of the
 *                  analysis.
 *
 * `detail` is the refusal verbatim, not a summary of it: the raw failure has to
 * stay reachable, which is the `#112` complaint inverted.
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
 * A failure that bought nothing, and why.
 *
 * Appended beside the block rather than instead of it, because **an item whose
 * integration failed must never be left with no path forward**. A card that
 * says only `conflict: agent/112 does not merge into develop` is the thing
 * `#84` is about; one that also says *no repair: this is Lingtai's own failure
 * and an agent has nothing it could change* tells an operator what is left to
 * do.
 *
 * Every decline is recorded, including the ordinary one where a recipe simply
 * does not repair. "Nothing happened because nobody asked for it" and "nothing
 * happened and we do not know why" are the two things a log exists to keep
 * apart.
 */
export const RepairDeclined = z.object({
  runId: z.string(),
  reason: RefusalReason,
  detail: z.string(),
  fingerprint: z.string(),
  /** The sentence the card shows. Names the rule that refused, not just "no". */
  why: z.string(),
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
 * than an event type each, which would have been eight once the failures are
 * counted.
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
  change: z.enum(["comment", "labels", "closed", "body"]),
  /** Whatever identifies what happened: a comment id, the labels that were set. */
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
  change: z.enum(["comment", "labels", "closed", "body"]),
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
  /** Which subscriber, as the daemon names it: `notify`, `discuss`. */
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
  DispatchRefused,
  RunStarted,
  RunPrompted,
  RunTouchedFile,
  RunContextExhausted,
  RunAwaitingInput,
  RunProducedDiff,
  RunProposedCompletion,
  RunFinished,
  RunFailed,
  GatesResolved,
  EndActionsResolved,
  GateRequested,
  GateStarted,
  GatePassed,
  GateFailed,
  GateWaived,
  ApprovalRequested,
  ApprovalGranted,
  ApprovalRevoked,
  IntegrationAttempted,
  IntegrationRefused,
  IntegrationSucceeded,
  RepairRequested,
  RepairDeclined,
  ConductorPaused,
  ConductorResumed,
  ConductorShutdownRequested,
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
  ProjectConfigured,
  Reconciled,
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
  // 2: the `diff` gate point became `proposed` (ADR 0018). Nine types carry a
  // `GatePoint`, so nine of them move together — a payload whose `gate` is
  // still `diff` would fail the enum rather than pass wrongly, which is why
  // every one of them needs the step and none of them can be skipped.
  GatesResolved: 2,
  GateRequested: 2,
  GateStarted: 2,
  GatePassed: 2,
  GateFailed: 2,
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
export const RETIRED: ReadonlySet<EventType> = new Set<EventType>(["OutboxDelivered", "OutboxFailed"]);

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
