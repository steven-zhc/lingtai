/**
 * The Claude Code adapter.
 *
 * `claude -p` in the worktree, with the hook wiring the conductor rendered
 * outside it, and `--output-format stream-json` so the receipt is parsed rather
 * than scraped. That last choice is the direct answer to a measured failure: the
 * old loop wrote cost records into a `.jsonl` that also contained raw `pnpm
 * build` output, so 9,555 of its 42,147 lines were not JSON and the file would
 * not parse. A receipt you cannot read is not a receipt.
 *
 * **The receipt is the last line rather than the only one** (`#109`). `json`
 * emitted one object when the process ended, so nothing existed to watch and
 * everything the agent said about its own work was read for `result` and thrown
 * away. `stream-json` emits the same object last, preceded by every message as
 * it happens — and `parseResult` is what keeps the accounting identical across
 * that change: it takes the line that says `type: "result"` and no other, so a
 * stream cut off before that line has no receipt at all rather than a receipt
 * made of an assistant message.
 *
 * **The session id is supplied, not observed.** `claude --session-id <uuid>`
 * takes one, so the conductor derives it deterministically from the run id.
 * design.md assumed the binding would be learned from the `SessionStart` hook
 * and stored; deriving it means there is nothing to store and nothing to lose —
 * given a run id, its transcript is computable forever.
 *
 * **Every ending produces an event.** Timeout, crash, non-zero exit and clean
 * completion each map to a kind. The old loop's failures produced no log line,
 * no comment and no label, and that silence is what `RunFailed` exists to end.
 *
 * Five kinds now rather than four: `crash` used to absorb every ending that was
 * not a clean result, so a quota, a segfault and a bad flag were one word and
 * six tickets burned in ninety-two seconds looked like six crashes
 * ([0031](../../../doc/decisions/0031-a-run-that-never-started.md)). What told
 * them apart was never the message — it is `neverStarted`'s three facts.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
  AuthStatus,
  Invocable,
  RunOutcome,
  RunRequest,
  Runtime,
  RuntimeCapabilities,
  Spawned,
} from "./runtime.ts";
import { neverStarted } from "./runtime.ts";
import { NO_RUN_LOG } from "./run-log.ts";

export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  id: "claude-code",
  hooks: [
    // The intersection both runtimes have.
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    // Claude Code's extras. Bonus signal: `PreCompact` reveals a work item that
    // was scoped too large, `Notification` lights the board up instead of the
    // run burning to the wall clock.
    "SessionEnd",
    "PreCompact",
    "Notification",
  ],
  canBlockToolUse: true,
  // Codex can rewrite a call; Claude Code refuses or allows.
  canRewriteToolCall: false,
  // No filesystem sandbox of its own. `guarded` is what the worktree plus the
  // filtered environment plus PreToolUse interception add up to, and it is what
  // carried the old loop's 73 runs.
  providesTier: "guarded",
};

/**
 * A stable UUID for a run.
 *
 * Deterministic so the binding between a run and its Claude Code transcript
 * needs no event field: given a run id, the session id is computable. Shaped as
 * a v4 UUID because `--session-id` requires a valid one.
 */
export function sessionIdFor(runId: string): string {
  const h = createHash("sha256").update(`lingtai:session:${runId}`).digest("hex");
  const bytes = h.slice(0, 32).split("");
  // Version and variant nibbles, so it parses as a UUID rather than 32 hex.
  bytes[12] = "4";
  bytes[16] = "8";
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * The last line of the stream: the receipt.
 *
 * Every field here is read off the object `--output-format stream-json` prints
 * with `type: "result"`, which is the same object `--output-format json`
 * printed alone. `subtype` is one of `success`, `error_during_execution`,
 * `error_max_turns`, `error_max_budget_usd`,
 * `error_max_structured_output_retries` — read out of the shipped bundle on
 * 2026-09-08 (0031 §2). **Nothing branches on it**, deliberately: the
 * classification is `neverStarted`'s three checkable facts, and the prose is
 * kept whole as evidence. It is carried because a receipt that dropped the
 * runtime's own word for how it ended would be a worse receipt.
 */
interface ClaudeResult {
  /** Absent on the single object `--output-format json` prints; `"result"` in a stream. */
  type?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  subtype?: string;
  result?: string;
}

/**
 * What stands in for the prompt in a recorded argv.
 *
 * `claude -p <prompt>` carries the whole document, and the whole document is
 * already on the run's stream as `RunPrompted` (#88). Recording it twice would
 * put 4.6 KB in front of the fields somebody opened `RunStarted` to read, and
 * the two copies could then disagree.
 */
export const PROMPT_ELIDED = "<prompt: recorded as RunPrompted>";

/**
 * argv, in one place.
 *
 * `run` and `invocation` call this with the only thing that differs between
 * them, so what the log says was run and what was run are the same list.
 */
function argsFor(
  request: Invocable,
  prompt: string,
  extraArgs: readonly string[],
  permissionMode: PermissionMode,
): string[] {
  return [
    "-p",
    prompt,
    // Parsed, not scraped, and arriving as it happens. See the module header.
    "--output-format",
    "stream-json",
    // Not optional and not a preference: `--print` with
    // `--output-format=stream-json` refuses to start without it —
    // *"When using --print, --output-format=stream-json requires --verbose"*,
    // 2.1.263, which is a failure at spawn rather than a quieter stream.
    "--verbose",
    // `--include-partial-messages` is the other half of the pair and is
    // deliberately not here. It repeats each message as token deltas *and*
    // whole, which multiplies the largest thing in the run log to say the same
    // sentences twice; a line per message is already something to watch, and
    // 0034 §7's cap is the budget this would spend.
    //
    // Outside the worktree: an agent that can edit its own hook
    // configuration has no hook configuration.
    "--settings",
    request.settingsPath,
    // The guard is the gate, so the runtime's own permission layer must not
    // be a second one. Without this a run is not merely stricter, it is
    // impossible: `-p` is non-interactive, so every Write, Edit and most
    // Bash calls come back as "you haven't granted it yet" and there is no
    // prompt to grant anything. One real run spent 45 turns and $3.35
    // reading the repository, designing the change, and then reporting that
    // it could not write a single file. lingtai-hook denied none of it — none
    // of it ever reached lingtai-hook.
    //
    // Not a loosening. `guarded` has always meant the worktree plus the
    // hook (see `providesTier` above, and ADR 0007): containment is the
    // filtered environment and the disposable worktree, and the hook is
    // what makes a tool call refusable. Deferring to it is the design, and
    // leaving a second layer in front of it only hides the first.
    "--permission-mode",
    permissionMode,
    "--session-id",
    sessionIdFor(request.runId),
    ...(request.model ? ["--model", request.model] : []),
    ...extraArgs,
  ];
}

/**
 * Which permission layer the run gets.
 *
 * `bypassPermissions` is the default and is the paragraph above: for a run
 * agent the guard *is* the gate, and a second permission layer in front of the
 * hook only hides the first.
 *
 * `default` is the third kind of agent
 * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §1), which has
 * no worktree, no hook and no gates and must therefore have no tools either.
 * Under `-p` there is nothing to grant a permission with — the paragraph above
 * measured that: every Write, Edit and most Bash calls come back as *"you
 * haven't granted it yet"* and there is no prompt to answer. What ruins a run
 * agent is exactly what contains a reader.
 */
export type PermissionMode = "bypassPermissions" | "default";

export interface ClaudeCodeOptions {
  /** The `claude` executable. Overridable so a test can use a stand-in. */
  binary?: string;
  /** Extra arguments, for a project that needs one. Never used to add tools. */
  extraArgs?: readonly string[];
  /** Defaults to `bypassPermissions`. See `PermissionMode`. */
  permissionMode?: PermissionMode;
}

export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): Runtime {
  const binary = options.binary ?? "claude";
  const permissionMode: PermissionMode = options.permissionMode ?? "bypassPermissions";

  return {
    capabilities: CLAUDE_CODE_CAPABILITIES,

    /**
     * `claude auth status`, in the environment a run would actually get.
     *
     * Free — it reads the credential and does not call the API. Verified
     * against both environments: without `USER` it answers
     * `{loggedIn: false, authMethod: "none"}`, with it
     * `{loggedIn: true, authMethod: "claude.ai"}`.
     *
     * **The exit code is 0 either way**, so the field is the answer and the
     * code is not. Reading the code would have made this check pass in exactly
     * the situation it exists to catch.
     */
    async checkAuth(env: Record<string, string>): Promise<AuthStatus> {
      return new Promise<AuthStatus>((resolve) => {
        const child = spawn(binary, ["auth", "status"], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let out = "";
        let err = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString()));
        child.stderr.on("data", (c: Buffer) => (err += c.toString()));

        // A hung probe must not hang the doctor.
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ loggedIn: false, method: null, detail: "claude auth status did not answer in 20s" });
        }, 20_000);

        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ loggedIn: false, method: null, detail: e.message });
        });

        child.on("close", () => {
          clearTimeout(timer);
          // Defensive for the same reason `parseResult` is: a wrapper or a
          // warning can put a line in front of the JSON.
          const brace = out.indexOf("{");
          if (brace < 0) {
            resolve({
              loggedIn: false,
              method: null,
              detail: (err.trim() || out.trim() || "no output").slice(0, 300),
            });
            return;
          }
          try {
            const parsed = JSON.parse(out.slice(brace)) as {
              loggedIn?: boolean;
              authMethod?: string;
            };
            resolve({
              loggedIn: parsed.loggedIn === true,
              method: parsed.authMethod ?? null,
              detail: parsed.loggedIn === true ? `signed in via ${parsed.authMethod}` : "not signed in",
            });
          } catch {
            resolve({ loggedIn: false, method: null, detail: out.slice(0, 300) });
          }
        });
      });
    },

    /** The same list `run` spawns, with the prompt standing in. */
    invocation(request: Invocable): Spawned {
      return {
        command: binary,
        args: argsFor(request, PROMPT_ELIDED, options.extraArgs ?? [], permissionMode),
      };
    },

    async run(request: RunRequest): Promise<RunOutcome> {
      const sessionId = sessionIdFor(request.runId);
      const started = Date.now();
      // A run with no log — a gate agent, or `discuss` — writes to the one that
      // is not there, so there is no `?.` on the hot path (0034 §1).
      const trace = request.log ?? NO_RUN_LOG;

      const args = argsFor(request, request.prompt, options.extraArgs ?? [], permissionMode);

      return new Promise<RunOutcome>((resolve) => {
        const child = spawn(binary, args, {
          cwd: request.cwd,
          // Filtered, not inherited. The agent gets what the recipe allows plus
          // the hook's wiring, and nothing else — one of the three real
          // boundaries (doc/decisions/0007).
          env: request.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group
          // ([0030](../../../doc/decisions/0030-shutting-down-safely.md) §3).
          //
          // Ctrl+C is delivered to the whole foreground group, so without this
          // the signal that begins a shutdown killed the agent in the same
          // instant — and every message about finishing the current ticket was
          // a lie the code told. Detaching is what makes the drain true rather
          // than reassuring.
          //
          // Not `unref`ed: this run is exactly what the conductor is waiting
          // for. What detaching costs is that a conductor which dies anyway
          // leaves the agent alive, which is why recovery kills the process a
          // claim names before it releases it (§5, `daemon/reconcile.ts`).
          detached: true,
        });

        /**
         * The **end** of stdout, not all of it.
         *
         * Under `json` the whole output was one small object and holding it was
         * free. A stream is the transcript: every message, every tool call and
         * every tool result the agent read, which for one run is tens of
         * megabytes and would sit in this process's heap for the length of it.
         * What the ending needs is the last line, so that is what is kept —
         * bounded, and cut from the front, which never touches it.
         */
        let stdout = "";
        let stderr = "";
        let settled = false;

        // Whole lines only. A chunk boundary falls anywhere, and half a JSON
        // object traced as prose would be both unreadable and a lie about what
        // the agent said. What is left when the process dies mid-line is
        // dropped: it is the partial-stream case, and a fragment is not a fact.
        const stream = lineReader((line) => {
          for (const [label, detail] of traceOf(line)) trace.note(label, detail);
        });
        const errors = lineReader((line) => trace.note("stderr", line));

        // A chunk boundary can also fall inside a character. `c.toString()`
        // would turn the halves into two replacement characters, which under
        // `json` corrupted a receipt nobody read closely and now corrupts a
        // sentence somebody does. The decoder holds the first half back until
        // the second arrives.
        const outText = new StringDecoder("utf8");
        const errText = new StringDecoder("utf8");

        child.stdout.on("data", (c: Buffer) => {
          const text = outText.write(c);
          stdout = (stdout + text).slice(-RECEIPT_TAIL_CHARS);
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
          // A SIGTERM the agent ignores must not become a hang. The event is the
          // point; a process that will not die is a detail for the next line.
          const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
          hard.unref?.();
          finish({
            exitCode: null,
            turns: 0,
            durationMs: Date.now() - started,
            costUsd: null,
            text: null,
            failure: { kind, detail },
            sessionId,
          });
        };

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
            // Includes "claude is not installed", which must be an event and not
            // a stack trace nobody sees.
            failure: { kind: "crash", detail: err.message },
            sessionId,
          }),
        );

        child.on("close", (code) => {
          const parsed = parseResult(stdout);
          const durationMs = parsed?.duration_ms ?? Date.now() - started;
          const turns = parsed?.num_turns ?? 0;
          const costUsd = parsed?.total_cost_usd ?? null;

          // The last line of the log is how it ended, in the runtime's own
          // words — `subtype` included, which nothing branches on. A log kept
          // because the run did not land opens on what it was for and closes on
          // this.
          trace.note(
            "receipt",
            parsed
              ? `${parsed.subtype ?? (parsed.is_error === true ? "error" : "result")} · ` +
                  `${turns} turns · ${costUsd === null ? "cost unrecorded" : `$${costUsd.toFixed(2)}`} · ` +
                  `exit ${code}`
              : `no receipt on the stream · exit ${code}`,
          );

          if (parsed && code === 0 && parsed.is_error !== true) {
            finish({
              exitCode: code,
              turns,
              durationMs,
              costUsd,
              text: parsed.result ?? null,
              failure: null,
              sessionId,
            });
            return;
          }

          finish({
            exitCode: code,
            turns,
            durationMs,
            costUsd,
            text: parsed?.result ?? null,
            failure: {
              // A run that spent nothing and took no turns did not fail at its
              // task; it failed to begin (0031 §1). Asked of the parsed receipt
              // and only of it: `is_error` is the runtime saying so, and output
              // that would not parse leaves turns at zero for a reason that is
              // ignorance rather than evidence — which is a crash, as it was.
              kind:
                parsed &&
                neverStarted({ turns, costUsd, isError: parsed.is_error === true })
                  ? "never-started"
                  : "crash",
              // Whatever went wrong, something says so. A run that ends with no
              // detail is the failure mode being replaced. Kept whole — as whole
              // as it ever was — because for a run that never started this is
              // the only evidence there is, and 0031 §4 reads a reset time back
              // out of it.
              //
              // The fallback takes the *end* of stdout rather than the start,
              // which under `json` was the same 500 characters and under a
              // stream is not: the first line of a stream is the session
              // banner, and the last is whatever it managed to say before it
              // stopped. `exited <code>` is reachable — a process that printed
              // nothing at all had no detail before this and has one now.
              detail:
                parsed?.result?.slice(0, 500) ??
                ((stderr.trim() || stdout.trim()).slice(-500) || `exited ${code}`),
            },
            sessionId,
          });
        });
      });
    },
  };
}

/**
 * The receipt, if this line is one.
 *
 * **The `type` check is the whole of what `#109` changed about the
 * accounting.** Under a stream every line is a JSON object, so "the last object
 * in the output" would name an assistant message on any run that was killed
 * before it finished — and that message has no `num_turns` and no `is_error`,
 * which the close handler would have read as a clean run of zero turns. A
 * receipt is the object that says it is one.
 *
 * An object with no `type` at all is still taken, because that is what
 * `--output-format json` printed on its own and a stand-in in a test still
 * does. Nothing in a stream is typeless, so this cannot be the thing that
 * misreads one.
 */
function receiptIn(line: string): ClaudeResult | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(t) as ClaudeResult;
  } catch {
    return null;
  }
  return parsed.type === undefined || parsed.type === "result" ? parsed : null;
}

/**
 * The receipt in the output, wherever in it that is.
 *
 * A wrapper or a warning can put a line in front of the stream, and the old
 * loop's unparseable `.jsonl` is the reminder that assuming clean output is how
 * a receipt gets lost. Read backwards because the receipt is last, and because
 * a second attempt appending to the same buffer should be answered by its own
 * ending rather than the first one's.
 */
export function parseResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const whole = receiptIn(trimmed);
  if (whole) return whole;
  for (const line of trimmed.split("\n").reverse()) {
    const found = receiptIn(line);
    if (found) return found;
  }
  return null;
}

/**
 * How much of the stream's end is kept for `parseResult`.
 *
 * The receipt is one line and the largest one seen is about four kilobytes —
 * `modelUsage` and `permission_denials` grow with the run. This is sixty-four
 * times that, and it is bounded memory rather than a judgement about content:
 * a run's stdout is now the transcript, and holding all of it to read the last
 * line of it would be tens of megabytes in the daemon's heap per run.
 */
export const RECEIPT_TAIL_CHARS = 262_144;

/**
 * Where one traced line stops.
 *
 * The log is a file somebody reads (0034 §8), not the transcript — and the
 * transcript is not lost: `sessionIdFor` makes it computable from a run id
 * forever. Four thousand characters is a long paragraph of the agent's prose
 * and about as much as a person reads in one line of a `tail -f`; past that,
 * more of it in the file is not more of it read. Bounding the *line* is also
 * what keeps a single runaway one from spending the whole of 0034 §7's file
 * cap in one go.
 */
export const TRACE_LINE_CHARS = 4_000;

/** `…` and the count, so a clipped line says it was clipped. */
function clip(text: string): string {
  const t = text.trim();
  return t.length <= TRACE_LINE_CHARS
    ? t
    : `${t.slice(0, TRACE_LINE_CHARS)} … (${t.length - TRACE_LINE_CHARS} more characters; the transcript has all of it)`;
}

/**
 * What one line of the stream is worth saying in the log.
 *
 * **The agent's own output and nothing else.** A tool call is already a line in
 * this file — the hook socket writes it with the verdict it got, which is more
 * than the stream knows — and writing it again would make the file say it
 * happened twice. Tool *results* are the volume in a stream and are the least
 * the agent's own: a file it read is a file, and it is still on disk.
 *
 * What is left is what `#109` was filed for: the prose and the reasoning, which
 * `--output-format json` read for `result` and threw away.
 *
 * A line that is not a stream event at all — a wrapper's warning, a truncated
 * object at the end of a killed run — is kept as `stdout` rather than dropped.
 * It is the only place it would have survived, and it is what a person opens
 * this file for when nothing else explains the ending.
 */
export function traceOf(line: string): readonly (readonly [string, string])[] {
  const t = line.trim();
  if (!t) return [];
  if (!t.startsWith("{")) return [["stdout", clip(t)]];

  let event: {
    type?: string;
    message?: { content?: readonly { type?: string; text?: string; thinking?: string }[] };
  };
  try {
    event = JSON.parse(t) as typeof event;
  } catch {
    return [["stdout", clip(t)]];
  }

  if (event.type !== "assistant") return [];
  const said: (readonly [string, string])[] = [];
  for (const block of event.message?.content ?? []) {
    if (block.type === "text" && block.text?.trim()) said.push(["agent", clip(block.text)]);
    // Its reasoning, which is often the only account of why it did the thing
    // the tool trace shows it doing.
    if (block.type === "thinking" && block.thinking?.trim()) said.push(["think", clip(block.thinking)]);
  }
  return said;
}

/**
 * Chunks in, whole lines out.
 *
 * A `data` event is a chunk of a pipe and has nothing to do with where lines
 * end, so a naive `chunk.split("\n")` traces half an object as prose about
 * every eight kilobytes. What is still pending when the process dies stays
 * pending: an unterminated line is a fragment of a fact, and the partial-stream
 * case is exactly where a fragment would be read as the whole.
 */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl >= 0) {
      onLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      nl = pending.indexOf("\n");
    }
  };
}

/** A run id. ULIDs are not in the dependency budget; a UUID sorts well enough. */
export function newRunId(): string {
  return `run-${randomUUID()}`;
}
