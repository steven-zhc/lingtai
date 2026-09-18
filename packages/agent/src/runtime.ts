/**
 * The legacy run interface. Role-aware calls use InvocationRuntime (#200).
 *
 * Kept until #204/#205 connect the process flows. Its settings path and numeric
 * turn count describe the implemented Claude Code adapter. The Codex stub's
 * hook/capability declarations are historical assumptions, not verified support.
 *
 * **Containment is Lingtai's responsibility, not the runtime's.** Codex ships
 * a filesystem sandbox and Claude Code does not, and a project's safety level
 * must not depend on which agent happens to be running today. A runtime may
 * *provide* containment; the scheduler matches capabilities before dispatching
 * and records `DispatchRefused` when the combination cannot meet the tier — it
 * never silently downgrades. See doc/decisions/0007-dual-runtime.md.
 */
import type { RunFailureKind, RuntimeId, Tier } from "@lingtai/domain";
import type { InvocationObservation } from "@lingtai/domain";
import type { RunTrace } from "./run-log.ts";

/**
 * The bounds a recipe may put on a run, by name.
 *
 * A value rather than a union written out, so `lingtai doctor` can walk it: a
 * third limit added to `runtime.limits` and not here is one doctor never asks
 * about, which is `#89` again one field along.
 */
export const RUN_LIMITS = ["turns", "wall"] as const;

export type RunLimit = (typeof RUN_LIMITS)[number];

export interface RuntimeCapabilities {
  id: RuntimeId;
  /** The lifecycle hooks this runtime actually emits. */
  hooks: readonly string[];
  /**
   * Whether a refusal from the `UserPromptSubmit` hook stops the run, so the
 * record can fail closed. That is the hook to check: `PreToolUse` is not wired
 * (`INTERSECTION_HOOKS`) and `PostToolUse` fires after the tool already ran, so
 * honouring a refusal before tool calls says nothing about this.
   *
   * Not mediation — the hook refuses nothing it is not forced to (ADR 0016 §6).
   * It is for the other half of `run-once.ts`'s step 6: *"a hook that cannot
   * reach the conductor must stop the run rather than let it produce nothing
   * and look like it produced everything."* A runtime that only notifies its
   * hook cannot stop anything. Both declare it; a future one might not.
   */
  canFailClosed: boolean;
  /** Codex can rewrite a call as well as refuse it. Claude Code cannot. */
  canRewriteToolCall: boolean;
  /** The strongest containment this runtime provides on its own. */
  providesTier: Tier;
  /**
   * Which of `RUN_LIMITS` this adapter actually stops a run at (`#89`).
   *
   * Declared, because for weeks it was assumed: both numbers were in the
   * recipe, typed onto `RunRequest` and carried into `RunStarted`, and only
   * `wall` was read. `#84` ran 172 turns against a declared 150. This is where
   * an adapter says which half it honours, answerable before a run rather than
   * inferred from one that overspent.
   */
  enforces: readonly RunLimit[];
}

export interface RunRequest {
  runId: string;
  /** The worktree. Its directory is the blast radius. */
  cwd: string;
  prompt: string;
  model?: string;
  /** Rendered by the conductor, outside the worktree. */
  settingsPath: string;
  /**
   * The run's log, opened by the conductor and written to from here.
   *
   * Beside `cwd`, `env` and `settingsPath` because it is the same kind of
   * thing: something the conductor decided and the adapter is handed
   * ([0034](../../../doc/decisions/0034-the-run-log.md) §1). `packages/agent`
   * must not learn where `~/.lingtai` is — a runtime adapter that computed the
   * path would have crossed the seam 0022 drew, and this one is not even told
   * it.
   *
   * **The file is outside the worktree, for a reason that is not the one
   * `settingsPath` has.** Settings are outside it because an agent that can
   * edit its own hook configuration has no hook configuration. The log is
   * outside it because the worktree is removed *before* the merge, so a log
   * inside one dies before the run has an outcome — and the log worth reading
   * is always the one from the run that just failed. The agent also commits
   * from there, and a `git add -A` would sweep its own log into the diff
   * (0034 §2).
   *
   * Two things write here and one file receives them, in time order: the hook
   * socket's trace of every tool call, from the conductor, and — since `#109` —
   * the agent's own prose off `--output-format stream-json`. `RunTrace` rather
   * than `RunLog` because closing it carries the keep-or-delete decision, which
   * is the conductor's and is not knowable here.
   *
   * A gate's agent and a fixer write here too since `#153`, through
   * `taggedTrace`, so their lines carry who wrote them. A discussion turn has
   * one since `#132`: its trace is named for the chat and lives for one turn
   * (`answerDiscussion`), so the board can show the answer being written.
   */
  log?: RunTrace;
  /**
   * Whether the agent's tool calls are this adapter's to trace.
   *
   * Off by default, because for the implementer the hook socket writes every
   * call with the verdict it got, and the stream writing it again would make
   * the file say it happened twice. **An agent run under unhooked settings — a
   * reviewer at a gate, a fixer — has no socket to write them**, so without
   * this its whole run would be prose and silence (#153).
   */
  traceTools?: boolean;
  /** Filtered — only what the recipe allows, plus the hook's wiring. */
  env: Record<string, string>;
  limits: { turns: number; wallMs: number };
  /** Killed when this aborts, producing a `timeout` failure rather than silence. */
  signal?: AbortSignal;
}

/**
 * The command line a runtime would spawn, without spawning it.
 *
 * Separate from `run` because the conductor records *how* a run was invoked
 * before it invokes it, and rebuilding argv at the call site would be a second
 * place that has to agree with the adapter about every flag. This is the
 * adapter's own answer, built by the same function `run` uses — so the two
 * cannot drift.
 */
export interface Spawned {
  /** The executable, as spawned. */
  command: string;
  /**
   * argv as applied, except for the prompt: it stands in as `PROMPT_ELIDED`,
   * because the document itself is on the run's stream as `RunPrompted` and
   * does not want to be there twice (#88).
   */
  args: readonly string[];
}

/** What `invocation` is asked about: a run request, before it is a run. */
export type Invocable = Omit<RunRequest, "prompt" | "signal">;

/** What the adapter knows when the process is gone. */
export interface RunOutcome {
  /** Native evidence for the role-aware interface. Legacy callers may omit it. */
  observation?: InvocationObservation;
  /** Full native failure detail; the legacy receipt keeps its old display cap. */
  originalFailureDetail?: string;
  exitCode: number | null;
  turns: number;
  durationMs: number;
  costUsd: number | null;
  /**
   * Set when the run did not complete normally. **Never null and silent** — the
   * old loop's failures produced no event at all, which is the thing this type
   * exists to make impossible.
   */
  failure: { kind: RunFailureKind; detail: string } | null;
  /**
   * The model's final message.
   *
   * Kept because a gate that asks an agent a question needs the answer, and the
   * runtime was throwing it away — cost and turn counts survived, the actual
   * output did not. Null when the run produced nothing parseable.
   */
  text: string | null;
  /** The runtime's own session identifier, for finding its transcript. */
  sessionId: string;
}

/**
 * Whether a Claude Code receipt describes a run that failed to **begin** rather than to
 * finish ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §1).
 *
 * Three facts and nothing else: **at most one turn, zero cost, an error**. Not one
 * word of the message is read, and that is the decision rather than an
 * omission. Claude Code 2.1.263's result subtypes carry no quota member —
 * `success`, `error_during_execution`, `error_max_turns`,
 * `error_max_budget_usd`, `error_max_structured_output_retries` — and the
 * sentence a person sees is assembled from a table of prefixes ("You've hit
 * your", "You've reached your", "You're out of usage credits", …). Codex is
 * worse: `rate_limits` is always null in exec mode. A classification resting on
 * any of that is one re-wording away from being wrong, and being wrong here
 * means either spending an agent at a wall or stopping a conductor that was
 * fine.
 *
 * `costUsd` null counts as zero: a receipt that recorded no cost recorded no
 * spend, and a run with an error and no turns has nothing it could have spent
 * it on. What must **not** be inferred is the error — an unparseable receipt
 * leaves turns at zero and cost at null by ignorance rather than by evidence,
 * so a caller has to have actually seen the runtime say so.
 *
 * **One turn, not zero, because that is what the wall actually reports**
 * ([0041](../../../doc/decisions/0041-a-gate-that-never-ran.md)). 0031's
 * fixture said `num_turns: 0`; the receipt Claude Code printed at the session
 * limit on 2026-09-10 — after this function existed — was
 * `success · 1 turns · $0.00 · exit 1`, recorded in the run log, and every one
 * of those runs and `#123`'s reviewer went down as a `crash`. The runtime counts
 * its own refusal message as the turn. Cost is what carries the fact: a turn
 * that reached a model is billed, and a turn that cost nothing was the runtime
 * answering for itself. A second turn would need a model to have replied, so
 * the bound stays at one.
 */
export function claudeCodeNeverStarted(receipt: {
  turns: number;
  costUsd: number | null;
  isError: boolean;
}): boolean {
  return receipt.isError && receipt.turns <= 1 && (receipt.costUsd ?? 0) === 0;
}

/** @deprecated Claude Code receipts only. Codex null cost is not evidence of no execution. */
export const neverStarted = claudeCodeNeverStarted;

/**
 * Whether the runtime can authenticate **in a given environment**.
 *
 * The environment is the point. Asking "is the operator logged in" is not the
 * question and answering it is worse than not asking: the first real run failed
 * with "Not logged in · Please run /login" while the operator was perfectly
 * logged in, because the filtered environment a run gets had no `USER` and
 * macOS finds a keychain item by who is asking.
 */
export interface AuthStatus {
  loggedIn: boolean;
  /** `claude.ai`, `apiKey`, `none` — whatever the runtime calls it. */
  method: string | null;
  /** Said back verbatim when something could not be asked at all. */
  detail: string;
}

export interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  run(request: RunRequest): Promise<RunOutcome>;
  /**
   * How this request would be spawned, for the log to record before it is.
   *
   * Optional for the same reason `checkAuth` is: a runtime that cannot say must
   * not pretend. `RunStarted.invocation` is null when it does not answer, which
   * reads as "not recorded" rather than as a reconstruction nobody ran.
   */
  invocation?(request: Invocable): Spawned;
  /**
   * Optional: a runtime that cannot be asked cheaply should not pretend.
   * `lingtai doctor` reports an absent check as deferred rather than as passing.
   */
  checkAuth?(env: Record<string, string>): Promise<AuthStatus>;
}

/**
 * Whether this runtime can be asked to do what the tier names.
 *
 * The tiers are about the runtime, not a policy on the tools: containment is
 * the worktree and the filtered environment, at every tier. `guarded` is a
 * runtime that stops the run when the `UserPromptSubmit` hook refuses the
 * prompt (`canFailClosed`) — not a hook before tool use, which Lingtai does not
 * install (`INTERSECTION_HOOKS`) — and it is what the first project runs at and what carried
 * the old loop's 73 runs. `sandboxed` adds a filesystem boundary the runtime
 * enforces itself, which nothing implemented provides.
 */
export function meetsTier(capabilities: RuntimeCapabilities, required: Tier): boolean {
  const rank: Record<Tier, number> = { open: 0, guarded: 1, sandboxed: 2 };
  return rank[capabilities.providesTier] >= rank[required];
}

/** What is missing, so `DispatchRefused` can name it rather than say "no". */
export function missingForTier(capabilities: RuntimeCapabilities, required: Tier): string[] {
  if (meetsTier(capabilities, required)) return [];
  if (required === "sandboxed") {
    return ["filesystem-sandbox"];
  }
  // A stated precondition, not a branch that fires today: both runtimes declare
  // `canFailClosed`. The name predates 0016 and is kept because `DispatchRefused`
  // records it.
  if (required === "guarded" && !capabilities.canFailClosed) {
    return ["pre-tool-use-interception"];
  }
  return [`tier-${required}`];
}
