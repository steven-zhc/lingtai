/**
 * The Codex adapter.
 *
 * `codex exec --json` in the worktree, with the hook wiring the conductor
 * rendered outside it translated into Codex's own `-c` overrides, so the
 * receipt is parsed rather than scraped. It is the second implementation ADR
 * [0007](../../../doc/decisions/0007-dual-runtime.md) designed the port for, and
 * until `#313` it was a stub whose `run()` rejected.
 *
 * **Every flag below was measured against `codex-cli 0.155.1` on 2026-09-29**,
 * from `codex exec --help`, `codex sandbox` and four probe runs. That matters
 * because the stub's capabilities were measured against documentation, and a
 * capability that is wrong is worse than one that is absent. What was measured:
 *
 * - **There is no `--max-turns`, and no flag of any name bounds turns.** So
 *   `enforces` is `["wall"]` and not both — see the declaration below.
 * - **Nothing supplies a session id.** `exec resume <id>` consumes one; nothing
 *   sets one. So `sessionId` is read off the stream's `thread.started`, and
 *   `sessionIdFor`'s derive-it-from-the-run-id trick is deliberately *not*
 *   reused: the field's contract is *"for finding its transcript"*, and a
 *   computable-looking UUID that names no transcript is a worse answer than the
 *   empty string.
 * - **No cost is reported anywhere.** `turn.completed.usage` carries tokens and
 *   no dollars, so `costUsd` is `null` — never `0`, which would report unknown
 *   cost as free ([#198](https://github.com/steven-zhc/lingtai/issues/198)).
 * - **The prompt must go behind `--`.** `codex exec review` runs the `review`
 *   subcommand; `codex exec -- review` sends it as the prompt. Measured both
 *   ways. A prompt is a document somebody wrote, so the day one of them begins
 *   with a bare subcommand name is the day a run silently does something else.
 * - **stdin must be closed.** `codex exec "<prompt>"` with an inherited stdin
 *   prints *"Reading additional input from stdin…"* and waits there forever —
 *   the first probe hung for three minutes on exactly that. `stdio[0]` is
 *   `"ignore"` below, which is `/dev/null`, and it is load-bearing.
 * - **The hooks wire, so `canFailClosed` is true and proved.** See
 *   `codexHookArgs`.
 * - **`providesTier: "sandboxed"` is proved.** `codex sandbox -c
 *   sandbox_mode=read-only` refused a write inside the working root;
 *   `workspace-write` refused `$HOME` and `~/.lingtai` — Lingtai's own state
 *   directory, where the hook wiring and the run logs live. It permits `/tmp`,
 *   which is Codex's documented exception and is where `socketPathFor` puts the
 *   run's hook socket; that is not a tier correction, because the runtime Lingtai
 *   dispatches today provides no filesystem boundary at all and 0016 §6 refuses
 *   no tool call either way.
 * - **And refusing `~/.lingtai` is why a worktree needs `--add-dir`.** The git
 *   directory a worktree commits into lives there, outside `--cd`, so the
 *   boundary that makes this runtime `sandboxed` is the same one that stopped
 *   `git add` — `gitWritableRoots` names that directory and nothing else, and
 *   `$HOME` stays refused. Measured both ways; see that function.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { codexAuth } from "./auth.ts";
import { clip, lineReader, PROMPT_ELIDED, RECEIPT_TAIL_CHARS } from "./claude-code.ts";
import { NO_RUN_LOG } from "./run-log.ts";
import type {
  AuthStatus,
  Invocable,
  RunOutcome,
  RunRequest,
  Runtime,
  RuntimeCapabilities,
  Spawned,
} from "./runtime.ts";

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  id: "codex",
  /**
   * The intersection, which is the contract — and the *reason* has changed
   * (`#313`).
   *
   * This list used to be justified as *"Codex has no SessionEnd, PreCompact or
   * Notification"*. As of 0.155.1 that sentence is false: the dispatcher in the
   * binary carries `SessionEnd`, `PreCompact` and `PostCompact` as well as
   * `SubagentStart`, `SubagentStop`, `Interrupt` and `PermissionRequest`. The
   * list is still right, for the other reason: `INTERSECTION_HOOKS` is the four
   * Lingtai actually wires, and the extras are *unwired* rather than absent.
   * Widening the declaration is a different ticket and 0007's table would want a
   * superseding file rather than an edit.
   */
  hooks: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  /**
   * **Proved against the binary, not read off documentation** (`#313`).
   *
   * A `UserPromptSubmit` hook that exits 2 stops the run before the model: the
   * probe's `turn.completed` reported `input_tokens: 0` and the stream carried no
   * `agent_message` at all. That is the half of the conductor's smoke test this
   * flag is for — *a hook that cannot reach the conductor must stop the run
   * rather than let it produce nothing and look like it produced everything.*
   *
   * **The trap it leaves is in `run()`, not here:** a blocked run still exits 0
   * and still prints `turn.completed`, so a receipt read for exit code alone
   * would record the refusal as a clean run of no turns. `codexOutcome`'s
   * `billedTokens` is what tells them apart.
   */
  canFailClosed: true,
  // Codex can rewrite a tool call, not merely refuse it.
  canRewriteToolCall: true,
  /** `-s workspace-write` is a real filesystem boundary. See the module header. */
  providesTier: "sandboxed",
  /**
   * **`wall` only, and that is `#89` working rather than a regression.**
   *
   * `wall` is the `setTimeout` in `run`, which is ours. `turns` has no flag to
   * delegate to — `codex exec --help` at 0.155.1 offers none, and `strings` finds
   * no hidden one the way `claude --max-turns` was hidden — so a recipe's `turns`
   * is a bound nothing applies, and `limitsRow` turns `fail` for every Codex
   * project with its own sentence: *the recipe declares a spend nothing will
   * stop*. That is visible on purpose.
   *
   * **Counting turns off the stream is not enforcing them.** `codexOutcome`
   * counts them, for the receipt and for the never-started question, and `run()`
   * does not SIGTERM at the bound — `claude-code.ts` says why: *"A SIGTERM from
   * here would record exactly the runs that overspent as costing nothing."*
   */
  enforces: ["wall"],
};

/**
 * Which filesystem boundary the run gets.
 *
 * The Codex half of [0054](../../../doc/decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md):
 * a caller says what the agent is *for* — act, or read and answer — and each
 * adapter turns that into its own vocabulary. Claude Code's is
 * `--permission-mode`; this is `-s`.
 *
 * `danger-full-access` is deliberately absent. It is what
 * `--dangerously-bypass-approvals-and-sandbox` amounts to, and the whole of what
 * makes this runtime `sandboxed` rather than `guarded` is that Lingtai does not
 * pass it.
 */
export type CodexSandbox = "workspace-write" | "read-only";

export interface CodexOptions {
  /** The `codex` executable. Overridable so a test can use a stand-in. */
  binary?: string;
  /** Defaults to `workspace-write`. See `CodexSandbox`. */
  sandbox?: CodexSandbox;
  /** Extra arguments, for a project that needs one. Never used to widen the sandbox. */
  extraArgs?: readonly string[];
}

/** One line of `codex exec --json`. Every field here was read off a real stream. */
interface CodexEvent {
  type?: string;
  /** On `thread.started`: the session id, which nothing supplies. */
  thread_id?: string;
  item?: {
    id?: string;
    /** `agent_message`, `reasoning`, `command_execution`, `error`, … */
    type?: string;
    /** `agent_message`, `reasoning`. */
    text?: string;
    /** `error`. */
    message?: string;
    /** `command_execution`. */
    command?: string;
  };
  /** On `turn.completed`. Tokens, and no dollars. */
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

/**
 * What the stream said, as a fold over its lines.
 *
 * Pure, and exported, because `pnpm test` is the `build` gate and runs the
 * **unit** project only: a test that spawns a stand-in binary is in the
 * 803-second half no agent can reach inside a pass. So everything except
 * `spawn` lives here, and the accounting is answerable against fixture lines.
 */
export interface CodexReceipt {
  /** `thread.started`'s id, or `""` where the stream was cut before it. */
  sessionId: string;
  /**
   * Model responses, counted as `agent_message` items.
   *
   * **Not the same unit as Claude Code's `num_turns`**, which counts every
   * agentic round trip; this counts the messages the agent produced, because
   * that is what Codex's stream lets you count. It is evidence and never a
   * bound — see `enforces`.
   */
  turns: number;
  /** The last `agent_message`, which is the model's final message. */
  text: string | null;
  /**
   * Whether a `turn.completed` arrived at all — *whether there is a receipt*.
   *
   * The gate on ever answering `never-started`. Without it an unparseable
   * stream leaves `turns` at zero and `billedTokens` at zero by ignorance rather
   * than by evidence, and `neverStarted`'s docstring forbids exactly that:
   * *"a caller has to have actually seen the runtime say so."*
   */
  completed: boolean;
  /**
   * Input plus output tokens off the last `turn.completed`.
   *
   * **This is the cost leg, and it is why `neverStarted` is not called.** That
   * function treats `costUsd: null` as zero spend, which is sound for a runtime
   * that reports cost — null there means *no receipt*. Codex never reports cost,
   * so null means *this runtime does not say*, a different fact wearing the same
   * value: routing through it would make the cost leg vacuous and classify every
   * failed Codex run with at most one message as `never-started`, which is
   * [0031](../../../doc/decisions/0031-a-run-that-never-started.md)'s bug
   * reproduced in the second adapter.
   *
   * Tokens are strictly better evidence than dollars anyway, being what dollars
   * are computed from: a turn that reached a model billed input tokens, and zero
   * is the runtime answering for itself.
   */
  billedTokens: number;
  /**
   * `error` items, in order.
   *
   * **An `error` item is not a failure.** `--dangerously-bypass-hook-trust`
   * emits two of them on every hooked run — *"Enabled hooks may run without
   * review for this invocation"* — so classifying on their presence would make
   * every run Lingtai dispatches a failed one. They are detail, and the
   * classification is `completed`, `billedTokens` and the exit code.
   */
  errors: readonly string[];
}

/** A receipt being written. `CodexReceipt` is the readable face of it. */
interface Tally {
  sessionId: string;
  turns: number;
  text: string | null;
  completed: boolean;
  billedTokens: number;
  errors: string[];
}

function emptyTally(): Tally {
  return { sessionId: "", turns: 0, text: null, completed: false, billedTokens: 0, errors: [] };
}

/** One line, folded in. Everything the receipt knows is decided here. */
function foldLine(receipt: Tally, line: string): void {
  const t = line.trim();
  if (!t.startsWith("{")) return;
  let event: CodexEvent;
  try {
    event = JSON.parse(t) as CodexEvent;
  } catch {
    return;
  }

  if (event.type === "thread.started" && event.thread_id) receipt.sessionId = event.thread_id;

  if (event.type === "turn.completed") {
    receipt.completed = true;
    receipt.billedTokens = (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    receipt.turns += 1;
    if (event.item.text) receipt.text = event.item.text;
  }
  if (event.type === "item.completed" && event.item?.type === "error" && event.item.message) {
    receipt.errors.push(event.item.message);
  }
}

export function codexOutcome(lines: readonly string[]): CodexReceipt {
  const receipt = emptyTally();
  for (const line of lines) foldLine(receipt, line);
  return receipt;
}

/**
 * The same fold, **over a stream that is never all in memory at once**.
 *
 * `run()` used to keep the last `RECEIPT_TAIL_CHARS` of stdout and hand
 * `codexOutcome` that window at close, the way `claude-code.ts` does. That is
 * sound there and wrong here, and the difference is what the two adapters read:
 * `parseResult` looks for **one final `result` object**, which is in the tail by
 * construction, while this receipt *accumulates* — `turns` counts every
 * `agent_message` and `sessionId` comes off `thread.started`, the very first
 * line. A Codex implementer streams tens of kilobytes of `aggregated_output` per
 * `pnpm test`, so a real run passes 256 KB and the head goes over the side: the
 * receipt then reported 4 turns of 37 and no session id, `RunFinished.turns`
 * recorded a spend that did not happen, and nothing anywhere said the number was
 * a fragment.
 *
 * So the fold happens **as the bytes arrive** and the window is gone. What is
 * still bounded is the *tail kept for a failure's detail*, which is a quotation
 * and not an accounting.
 */
export interface CodexAccount {
  /** A chunk of stdout, at any boundary — inside a line, inside a character. */
  chunk(text: string): void;
  /**
   * No more is coming.
   *
   * An unterminated final line is folded rather than dropped: mid-stream a
   * fragment is a fragment, but at close it is the last thing the runtime said,
   * and a `turn.completed` without a trailing newline is a receipt.
   */
  end(): void;
  /** What the stream has said so far. */
  readonly receipt: CodexReceipt;
}

export function codexAccount(): CodexAccount {
  const receipt = emptyTally();
  let pending = "";
  return {
    chunk(text: string) {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) foldLine(receipt, line);
    },
    end() {
      if (pending === "") return;
      foldLine(receipt, pending);
      pending = "";
    },
    get receipt(): CodexReceipt {
      return receipt;
    },
  };
}

/**
 * What one line of the stream is worth saying in the run log.
 *
 * `traceOf`'s rules, applied to Codex's vocabulary: **the agent's own output and
 * nothing else.** A tool *call* is traced from `item.started`, never from
 * `item.completed` — the completed item carries `aggregated_output`, which is the
 * tool result, and tool results are the volume in a stream and the least the
 * agent's own.
 */
export function codexTrace(
  line: string,
  options: { tools?: boolean } = {},
): readonly (readonly [string, string])[] {
  const t = line.trim();
  if (!t) return [];
  if (!t.startsWith("{")) return [["stdout", clip(t)]];

  let event: CodexEvent;
  try {
    event = JSON.parse(t) as CodexEvent;
  } catch {
    return [["stdout", clip(t)]];
  }

  const item = event.item;
  if (item === undefined) return [];

  if (event.type === "item.started") {
    return options.tools && item.type === "command_execution" && item.command
      ? [["Bash", clip(item.command).replace(/\s*\r?\n\s*/g, " ")]]
      : [];
  }
  if (event.type !== "item.completed") return [];

  if (item.type === "agent_message" && item.text?.trim()) return [["agent", clip(item.text)]];
  // Its reasoning, which is often the only account of why it did the thing the
  // tool trace shows it doing.
  if (item.type === "reasoning" && item.text?.trim()) return [["think", clip(item.text)]];
  // Codex talking about the invocation rather than the work — the bypass notice,
  // a refused flag. Kept, because it is the only place it would have survived.
  if (item.type === "error" && item.message?.trim()) return [["codex", clip(item.message)]];
  return [];
}

/**
 * The hook wiring, translated — **and this is the answer to the ticket's one
 * sentence: Codex is pointed at `lingtai-hook` its own way, and `canFailClosed`
 * stays `true`.**
 *
 * The *wire protocol* is Claude Code's and needed no translation. Measured: the
 * payload Codex handed the probe's `UserPromptSubmit` hook was
 * `{session_id, turn_id, transcript_path, cwd, hook_event_name, model,
 * permission_mode, prompt}` — the same JSON `lingtai-hook` already reads, which
 * is what 0007 predicted when it said *"the hook models are isomorphic … so the
 * adapter needs one contract and a field normaliser, not two code paths."*
 *
 * What is Claude Code's is only how the binary gets *pointed at*. `renderSettings`
 * emits `{hooks: {<Event>: [{matcher, hooks: [{type, command}]}]}}` in a
 * `settings.json`, and Codex takes no `--settings`: its `hooks` config key is a
 * struct, not a path — `-c hooks=<path>` is refused with *"invalid type: string
 * …, expected struct HooksToml"*. So the file is read here and re-emitted as
 * `-c` overrides, whose values are parsed as TOML. The matcher group shape is
 * identical, which is why this is a re-encoding and not a mapping.
 *
 * **`CODEX_HOME` is not the lever**, though it looks like one:
 * `--ignore-user-config`'s own help reads *"auth still uses `CODEX_HOME`"*, so a
 * per-run `CODEX_HOME` holding only our hooks is a run that is not signed in —
 * `checkAuth` passing and the run failing.
 *
 * **Filtering to the hooks Codex serves is required, not tidiness.** An event
 * name Codex does not know makes `config.toml` fail to load, which kills the run
 * at spawn — and `renderSettings` includes `Notification`, which Codex has no
 * dispatcher for.
 *
 * `--dangerously-bypass-hook-trust` rides along only when there is a hook to
 * trust: *"Intended only for automation that already vets hook sources"*, and
 * Lingtai compiles `lingtai-hook` itself. An unhooked reviewer's settings are
 * `{}` (`writeUnhookedSettings`), so it gets no overrides and no bypass flag,
 * which is the right answer rather than a special case.
 */
export function codexHookArgs(settings: unknown): string[] {
  const hooks = (settings as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const args: string[] = [];
  for (const event of CODEX_CAPABILITIES.hooks) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    const rendered = groups
      .map((group) => {
        const g = group as { matcher?: unknown; hooks?: unknown };
        const handlers = Array.isArray(g.hooks) ? g.hooks : [];
        const inner = handlers
          .map((handler) => {
            const h = handler as { type?: unknown; command?: unknown };
            return typeof h.command === "string"
              ? `{type=${toml(String(h.type ?? "command"))},command=${toml(h.command)}}`
              : null;
          })
          .filter((one): one is string => one !== null);
        return inner.length === 0
          ? null
          : `{matcher=${toml(typeof g.matcher === "string" ? g.matcher : "*")},hooks=[${inner.join(",")}]}`;
      })
      .filter((one): one is string => one !== null);
    if (rendered.length > 0) args.push("-c", `hooks.${event}=[${rendered.join(",")}]`);
  }

  // Only where something is actually wired. Passing it with no hooks would be a
  // dangerous-sounding flag that buys nothing, which is how one stops being read.
  return args.length > 0 ? [...args, "--dangerously-bypass-hook-trust"] : [];
}

/**
 * A TOML basic string.
 *
 * Quoted rather than interpolated because the value of `-c` is parsed as TOML and
 * a path may hold a quote or a backslash. There is no shell in between — `spawn`
 * takes an argv — so this is TOML's escaping and not a shell's.
 */
function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * The hook wiring the conductor rendered, read from disk.
 *
 * Synchronous because `invocation()` is, and `argsFor` is the one argv builder
 * both it and `run` call so *"the two cannot drift"*. It is a sub-kilobyte file
 * the conductor wrote moments earlier, beside the socket it just opened.
 *
 * `null` rather than a throw, and the two callers answer it differently on
 * purpose: `run` refuses, because a Codex run with no hook records nothing and
 * would look exactly like one that recorded everything; `invocation` records an
 * argv with no hook flags in it, which is what would actually have been spawned
 * and is therefore not a lie. Throwing would take out `conduct.ts`'s bare
 * `runtime.invocation?.(…)` before `RunStarted` was ever appended.
 */
function hookWiringAt(settingsPath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Where a worktree's commits actually land, **because it is not inside the
 * worktree** (`#313`).
 *
 * `-s workspace-write` makes `--cd` the writable root, and a Lingtai worktree's
 * git directory is outside it: `cutTree()` gives
 * `~/.lingtai/worktrees/<project>/<runId>`, whose `.git` is a *file* pointing at
 * `~/.lingtai/repos/<project>.git/worktrees/<runId>`, with the objects and refs
 * a level up again. So the agent could edit files and not commit them — the one
 * thing the pass is bought for — and the run would end `0057 §2`'s *committed
 * nothing* after a whole agent was spent.
 *
 * **Measured, both ways, on `codex-cli 0.155.1`.** Against exactly that layout,
 * `codex exec -s workspace-write --cd <worktree>` asked to `git add -A && git
 * commit` answered `fatal: Unable to create
 * '/Users/…/.lingtai/repos/<p>.git/worktrees/<runId>/index.lock': Operation not
 * permitted`, and `git log` was unmoved. With `--add-dir` naming the common
 * directory the same prompt committed (`1 file changed`), and a `touch $HOME/…`
 * in the same run still answered *Operation not permitted* — so the sandbox is
 * still a sandbox and this widens it by one directory that is already Lingtai's.
 *
 * **Why `/tmp` hid it**, and why a reviewer may measure the opposite: Codex's
 * `workspace-write` permits `$TMPDIR` and `/tmp` unconditionally, so the same
 * probe against a bare repo under `/tmp` commits happily. The layout has to be
 * the real one for the refusal to appear.
 *
 * `[]` for an ordinary checkout, where `.git` is a directory under `--cd` and
 * therefore already writable, and `[]` for anything this cannot read — a path
 * that is not a worktree is not a reason to refuse to run.
 */
export function gitWritableRoots(cwd: string): readonly string[] {
  let gitDir: string;
  try {
    const dotGit = join(cwd, ".git");
    // A directory means an ordinary checkout: it is under `--cd` already.
    if (statSync(dotGit).isDirectory()) return [];
    const said = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (said === null) return [];
    gitDir = resolve(cwd, said[1]!.trim());
  } catch {
    return [];
  }

  // The worktree's own git directory, and the repository it borrows objects and
  // refs from — `git commit` writes in both, and `commondir` is how the first
  // names the second. Usually the second contains the first, and naming both is
  // cheaper than reasoning about when it does not.
  const roots = [gitDir];
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (common !== "") roots.push(resolve(gitDir, common));
  } catch {
    // No `commondir`: this git directory is the whole of it.
  }
  return roots;
}

/**
 * argv, in one place — `run` and `invocation` call this with the only thing that
 * differs between them, so what the log says was run and what was run agree.
 *
 * **Pure, and exported, so the whole command line is a unit-level claim.** It
 * takes the *parsed* wiring rather than a path for exactly that reason: the one
 * `readFileSync` is the caller's, so every flag below — the sandbox, the `--`, the
 * hook overrides, the absence of `--dangerously-bypass-approvals-and-sandbox` —
 * is answerable by `pnpm test`, which is what the `build` gate runs.
 */
export function codexArgv(
  request: Invocable,
  prompt: string,
  options: {
    settings: unknown;
    sandbox: CodexSandbox;
    /** See `gitWritableRoots`. Empty for a reader, which commits nothing. */
    writable?: readonly string[];
    extraArgs?: readonly string[];
  },
): string[] {
  return argsFor(
    request,
    prompt,
    codexHookArgs(options.settings),
    options.sandbox,
    options.writable ?? [],
    options.extraArgs ?? [],
  );
}

function argsFor(
  request: Invocable,
  prompt: string,
  hookArgs: readonly string[],
  sandbox: CodexSandbox,
  writable: readonly string[],
  extraArgs: readonly string[],
): string[] {
  return [
    "exec",
    // Parsed, not scraped, and arriving as it happens.
    "--json",
    // The working root, and therefore the sandbox's writable root: the blast
    // radius stated to the runtime rather than inherited from `spawn`'s cwd.
    "--cd",
    request.cwd,
    "--sandbox",
    sandbox,
    // Nothing is watching to approve anything. Without this a command needing
    // escalation waits for an answer that never comes and the run burns to the
    // wall clock — the Codex shape of `claude-code.ts`'s `--permission-mode`
    // paragraph. `never` is a member of Codex's own closed set: `untrusted`,
    // `on-failure`, `on-request`, `granular`, `never`.
    "-c",
    "approval_policy=never",
    // **The git directory, or the agent cannot commit what it wrote.** See
    // `gitWritableRoots` — this is the one widening of the sandbox Lingtai asks
    // for, and it is asked for by path rather than by turning the sandbox down.
    ...writable.flatMap((dir) => ["--add-dir", dir]),
    ...hookArgs,
    ...(request.model ? ["--model", request.model] : []),
    ...extraArgs,
    // **Behind `--`, and it is load-bearing.** `codex exec` takes subcommands —
    // `resume`, `fork`, `review` — in the same position as the prompt, and
    // measured at 0.155.1 a bare `review` runs the subcommand while `-- review`
    // is the prompt. A prompt is a document somebody wrote.
    "--",
    prompt,
  ];
}

/**
 * Asked only where something may be written.
 *
 * `read-only` commits nothing, so naming a directory it could write in would be
 * a widening bought for nothing — and the sandbox is the whole of what that mode
 * is for.
 */
function writableFor(sandbox: CodexSandbox, cwd: string): readonly string[] {
  return sandbox === "workspace-write" ? gitWritableRoots(cwd) : [];
}

export function createCodexRuntime(options: CodexOptions = {}): Runtime {
  const binary = options.binary ?? "codex";
  const sandbox: CodexSandbox = options.sandbox ?? "workspace-write";
  const extraArgs = options.extraArgs ?? [];

  return {
    capabilities: CODEX_CAPABILITIES,

    /** `codex login status` — `auth.ts`. */
    checkAuth(env: Record<string, string>): Promise<AuthStatus> {
      return codexAuth(binary, env);
    },

    /** The same list `run` spawns, with the prompt standing in. */
    invocation(request: Invocable): Spawned {
      return {
        command: binary,
        args: codexArgv(request, PROMPT_ELIDED, {
          settings: hookWiringAt(request.settingsPath),
          sandbox,
          writable: writableFor(sandbox, request.cwd),
          extraArgs,
        }),
      };
    },

    async run(request: RunRequest): Promise<RunOutcome> {
      const started = Date.now();
      // A run with no log writes to the one that is not there, so there is no
      // `?.` on the hot path (0034 §1).
      const trace = request.log ?? NO_RUN_LOG;

      const wiring = hookWiringAt(request.settingsPath);
      if (wiring === null) {
        // Before the spawn, and an event rather than a throw. A Codex run with
        // no hook produces no events and looks exactly like one that produced
        // all of them, which is the failure `smokeTestFailClosed` exists for one
        // layer down.
        const detail =
          `the hook wiring at ${request.settingsPath} could not be read, so nothing would have ` +
          "recorded this run's tool calls or stopped it when the conductor went away";
        trace.note("codex", detail);
        return {
          exitCode: null,
          turns: 0,
          durationMs: Date.now() - started,
          costUsd: null,
          text: null,
          failure: { kind: "crash", detail },
          sessionId: "",
        };
      }

      const args = codexArgv(request, request.prompt, {
        settings: wiring,
        sandbox,
        writable: writableFor(sandbox, request.cwd),
        extraArgs,
      });

      return new Promise<RunOutcome>((resolve) => {
        const child = spawn(binary, args, {
          cwd: request.cwd,
          // Filtered, not inherited (0007).
          env: request.env as NodeJS.ProcessEnv,
          // **`"ignore"` on stdin is load-bearing**, not tidiness: `codex exec`
          // reads stdin even when a prompt was given as an argument — *"if stdin
          // is piped and a prompt is also provided, stdin is appended as a
          // `<stdin>` block"* — and an inherited stdin makes it sit on
          // *"Reading additional input from stdin…"* until the wall clock. Node's
          // `"ignore"` is `/dev/null`, which is an immediate EOF.
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group (0030 §3), so the Ctrl+C that begins a
          // shutdown does not kill the agent the drain promised to finish.
          detached: true,
        });

        /**
         * The receipt, **folded as the bytes arrive** — see `codexAccount`.
         *
         * Not read off a tail at close: this accounting is cumulative, so a
         * window would drop `thread.started` and most of the turns on any run
         * long enough to matter.
         */
        const account = codexAccount();
        /**
         * The **end** of stdout, kept only to quote in a failure's `detail`.
         *
         * A bound on what one event may carry (0034 §7), and nothing reads an
         * accounting off it: the sentence *"the receipt is its last lines"* is
         * `claude-code.ts`'s and is true there, where `parseResult` looks for one
         * final `result` object.
         */
        let stdoutTail = "";
        let stderr = "";
        let settled = false;

        // Whole lines only: a chunk boundary falls anywhere, and half a JSON
        // object traced as prose would be both unreadable and a lie.
        const stream = lineReader((line) => {
          for (const [label, detail] of codexTrace(line, { tools: request.traceTools === true })) {
            trace.note(label, detail);
          }
        });
        const errors = lineReader((line) => trace.note("stderr", line));

        // A chunk boundary can also fall inside a character.
        const outText = new StringDecoder("utf8");
        const errText = new StringDecoder("utf8");

        child.stdout.on("data", (c: Buffer) => {
          const text = outText.write(c);
          account.chunk(text);
          stdoutTail = (stdoutTail + text).slice(-RECEIPT_TAIL_CHARS);
          stream(text);
        });
        child.stderr.on("data", (c: Buffer) => {
          const text = errText.write(c);
          stderr += text;
          errors(text);
        });

        const finish = (outcome: RunOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(wall);
          request.signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };

        const kill = (kind: "timeout" | "aborted", detail: string) => {
          child.kill("SIGTERM");
          const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
          hard.unref?.();
          finish({
            exitCode: null,
            turns: 0,
            durationMs: Date.now() - started,
            costUsd: null,
            text: null,
            failure: { kind, detail },
            sessionId: account.receipt.sessionId,
          });
        };

        // Ours, and the only one of the recipe's two bounds anything applies.
        const wall = setTimeout(
          () => kill("timeout", `no result within ${request.limits.wallMs}ms`),
          request.limits.wallMs,
        );
        const onAbort = () => kill("aborted", "the conductor aborted the run");
        request.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) =>
          finish({
            exitCode: null,
            turns: 0,
            durationMs: Date.now() - started,
            costUsd: null,
            text: null,
            // Includes "codex is not installed", which must be an event and not
            // a stack trace nobody sees.
            failure: { kind: "crash", detail: err.message },
            sessionId: "",
          }),
        );

        child.on("close", (code) => {
          // The last line may have arrived without its newline, and at close
          // that is the runtime's final word rather than a fragment.
          account.end();
          const receipt = account.receipt;
          // Codex reports no duration, so the wall clock is the answer rather
          // than a field read off a receipt.
          const durationMs = Date.now() - started;

          trace.note(
            "receipt",
            receipt.completed
              ? `${receipt.turns} turns · ${receipt.billedTokens} tokens · cost unrecorded · exit ${code}`
              : `no receipt on the stream · exit ${code}`,
          );

          const reachedAModel = receipt.billedTokens > 0;
          if (receipt.completed && code === 0 && reachedAModel && receipt.turns > 0) {
            finish({
              exitCode: code,
              turns: receipt.turns,
              durationMs,
              // Never `0`: unknown cost is not free (#198), and the type honours it.
              costUsd: null,
              text: receipt.text,
              failure: null,
              sessionId: receipt.sessionId,
            });
            return;
          }

          finish({
            exitCode: code,
            turns: receipt.turns,
            durationMs,
            costUsd: null,
            text: receipt.text,
            failure: {
              /**
               * 0031's three facts, with Codex's own evidence for each: **a
               * receipt exists, nothing was billed, no message was produced.**
               *
               * `receipt.completed` is the gate, and it is what keeps this from
               * being 0031's bug again: a stream that never reached
               * `turn.completed` is a `crash`, because zeros from a stream that
               * stopped are ignorance and not evidence. The measured case this
               * catches is the hook refusing the prompt — `input_tokens: 0`, no
               * `agent_message`, and **exit 0**, which classified on the exit
               * code alone would have been a clean run of no turns.
               *
               * `out-of-turns` is not reachable here and that is correct:
               * nothing bounds turns, so no run can be stopped at one.
               */
              kind:
                receipt.completed && !reachedAModel && receipt.turns === 0
                  ? "never-started"
                  : "crash",
              /**
               * Whatever went wrong, something says so. Codex's `error` items
               * first, because they are the runtime's own words about the
               * invocation; then the end of stderr or stdout, which under a
               * stream is whatever it managed to say before it stopped.
               */
              detail:
                (receipt.errors.length > 0 ? receipt.errors.join(" · ").slice(0, 500) : "") ||
                receipt.text?.slice(0, 500) ||
                (stderr.trim() || stdoutTail.trim()).slice(-500) ||
                `exited ${code}`,
            },
            sessionId: receipt.sessionId,
          });
        });
      });
    },
  };
}
