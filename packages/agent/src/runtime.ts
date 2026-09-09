/**
 * One interface, two implementations — one of which is a stub, on purpose.
 *
 * The contract is the **intersection** of what Claude Code and Codex CLI both
 * have: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.
 * Claude Code's extra three (`SessionEnd`, `PreCompact`, `Notification`) are
 * bonus signal — better when present, never required, and the adapter works
 * without them. Both runtimes are designed for from day one because retrofitting
 * this interface later is a refactor; only `claude-code` is implemented, because
 * writing the second adapter before the first interface has survived real use is
 * guessing at the wrong abstractions.
 *
 * **Containment is Lingtai's responsibility, not the runtime's.** Codex ships
 * a filesystem sandbox and Claude Code does not, and a project's safety level
 * must not depend on which agent happens to be running today. A runtime may
 * *provide* containment; the scheduler matches capabilities before dispatching
 * and records `DispatchRefused` when the combination cannot meet the tier — it
 * never silently downgrades. See doc/decisions/0007-dual-runtime.md.
 */
import type { RunFailureKind, RuntimeId, Tier } from "@lingtai/domain";

export interface RuntimeCapabilities {
  id: RuntimeId;
  /** The lifecycle hooks this runtime actually emits. */
  hooks: readonly string[];
  /** Whether `PreToolUse` can refuse a call. Both can; a future one might not. */
  canBlockToolUse: boolean;
  /** Codex can rewrite a call as well as refuse it. Claude Code cannot. */
  canRewriteToolCall: boolean;
  /** The strongest containment this runtime provides on its own. */
  providesTier: Tier;
}

export interface RunRequest {
  runId: string;
  /** The worktree. Its directory is the blast radius. */
  cwd: string;
  prompt: string;
  model?: string;
  /** Rendered by the conductor, outside the worktree. */
  settingsPath: string;
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
 * Whether a receipt describes a run that failed to **begin** rather than to
 * finish ([0031](../../../doc/decisions/0031-a-run-that-never-started.md) §1).
 *
 * Three facts and nothing else: **zero turns, zero cost, an error**. Not one
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
 */
export function neverStarted(receipt: {
  turns: number;
  costUsd: number | null;
  isError: boolean;
}): boolean {
  return receipt.isError && receipt.turns === 0 && (receipt.costUsd ?? 0) === 0;
}

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
 * Whether this runtime can carry a project at that containment tier.
 *
 * `guarded` is what the first project runs at and what carried the old loop's 73
 * runs; `sandboxed` needs a hard filesystem boundary that Lingtai has not
 * built yet.
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
  if (required === "guarded" && !capabilities.canBlockToolUse) {
    return ["pre-tool-use-interception"];
  }
  return [`tier-${required}`];
}
