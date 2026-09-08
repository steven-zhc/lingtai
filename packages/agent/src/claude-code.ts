/**
 * The Claude Code adapter.
 *
 * `claude -p` in the worktree, with the hook wiring the conductor rendered
 * outside it, and `--output-format json` so the receipt is parsed rather than
 * scraped. That last choice is the direct answer to a measured failure: the old
 * loop wrote cost records into a `.jsonl` that also contained raw `pnpm build`
 * output, so 9,555 of its 42,147 lines were not JSON and the file would not
 * parse. A receipt you cannot read is not a receipt.
 *
 * **The session id is supplied, not observed.** `claude --session-id <uuid>`
 * takes one, so the conductor derives it deterministically from the run id.
 * design.md assumed the binding would be learned from the `SessionStart` hook
 * and stored; deriving it means there is nothing to store and nothing to lose —
 * given a run id, its transcript is computable forever.
 *
 * **Every ending produces an event.** Timeout, turn limit, crash, non-zero exit
 * and clean completion each map to a kind. The old loop's failures produced no
 * log line, no comment and no label, and that silence is what `RunFailed`
 * exists to end.
 *
 * **Both declared limits are applied here, and neither by the CLI.** The wall
 * is a timer; the turns are counted off the stream. `claude` has no
 * `--max-turns` and — the reason this is worth stating — accepts flags it does
 * not know without a word, so handing it one would have produced exactly the
 * failure #89 records: a limit declared, carried, printed on every screen, and
 * bounding nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type {
  AuthStatus,
  Invocable,
  RunOutcome,
  RunRequest,
  Runtime,
  RuntimeCapabilities,
  Spawned,
} from "./runtime.ts";

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
  // Both, and both applied by `run` rather than by the CLI. See the header.
  enforcesLimits: ["turns", "wall"],
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

/** What `--output-format json` prints when the run ends. */
interface ClaudeResult {
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
 * How much of the stream's end is kept for a failure that has no receipt.
 *
 * A detail is read on a card and in a log line. The whole transcript is not a
 * detail, and holding one to quote 500 characters of it is how a conductor
 * running several runs ends up carrying tens of megabytes it never reads.
 */
const TAIL_LIMIT = 8_000;

/**
 * argv, in one place.
 *
 * `run` and `invocation` call this with the only thing that differs between
 * them, so what the log says was run and what was run are the same list.
 */
function argsFor(request: Invocable, prompt: string, extraArgs: readonly string[]): string[] {
  return [
    "-p",
    prompt,
    // Parsed, not scraped. See the module header.
    //
    // `stream-json` rather than `json` because a turn limit cannot be applied
    // to a receipt: `json` prints one object when the process is already gone,
    // by which time 172 turns have been bought (#89). The stream carries the
    // same object as its last line — so the receipt is unchanged, and
    // `parseResult` still reads it — and carries each assistant message as it
    // happens, which is the only thing that arrives while there is still a run
    // to stop.
    "--output-format",
    "stream-json",
    // Required: `claude -p --output-format stream-json` refuses without it.
    "--verbose",
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
    "bypassPermissions",
    "--session-id",
    sessionIdFor(request.runId),
    ...(request.model ? ["--model", request.model] : []),
    ...extraArgs,
  ];
}

export interface ClaudeCodeOptions {
  /** The `claude` executable. Overridable so a test can use a stand-in. */
  binary?: string;
  /** Extra arguments, for a project that needs one. Never used to add tools. */
  extraArgs?: readonly string[];
}

export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): Runtime {
  const binary = options.binary ?? "claude";

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
      return { command: binary, args: argsFor(request, PROMPT_ELIDED, options.extraArgs ?? []) };
    },

    async run(request: RunRequest): Promise<RunOutcome> {
      const sessionId = sessionIdFor(request.runId);
      const started = Date.now();

      const args = argsFor(request, request.prompt, options.extraArgs ?? []);

      return new Promise<RunOutcome>((resolve) => {
        const child = spawn(binary, args, {
          cwd: request.cwd,
          // Filtered, not inherited. The agent gets what the recipe allows plus
          // the hook's wiring, and nothing else — one of the three real
          // boundaries (doc/decisions/0007).
          env: request.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        let settled = false;
        /** The last line that parsed as an object: the receipt is the last of them. */
        let receipt = "";
        /** The end of the stream, for a failure with no receipt to quote. */
        let tail = "";
        /** Assistant messages seen. This is what the receipt calls `num_turns`. */
        let turns = 0;
        let unterminated = "";

        /**
         * One line of the stream, and only what is kept from it.
         *
         * Three things come off it and the transcript itself is dropped: the
         * turn count, the last object (the receipt), and a bounded tail. A
         * 172-turn transcript held in a string to read one number back off the
         * end of it would be megabytes of the conductor's memory per run.
         */
        const consume = (line: string) => {
          const text = line.trim();
          if (!text) return;
          tail = `${tail}${text}\n`.slice(-TAIL_LIMIT);
          if (!text.startsWith("{")) return;
          let event: { type?: string };
          try {
            event = JSON.parse(text) as { type?: string };
          } catch {
            // A line that is not JSON is noise from a wrapper, exactly as
            // `parseResult` assumes. It counts as nothing and hides nothing.
            return;
          }
          receipt = text;
          // Verified against a real run: two assistant messages, and a receipt
          // reading `num_turns: 2`. The tool result between them is a `user`
          // message and is not a turn.
          if (event.type === "assistant") turns += 1;
        };

        child.stdout.on("data", (c) => {
          unterminated += c.toString();
          for (let nl = unterminated.indexOf("\n"); nl !== -1; nl = unterminated.indexOf("\n")) {
            consume(unterminated.slice(0, nl));
            unterminated = unterminated.slice(nl + 1);
          }
          /**
           * Stopped as it takes the turn past its budget, not as it finishes
           * the last one it was allowed.
           *
           * The difference is a whole run. A run that spends its final allowed
           * turn on its *answer* emits that message and its receipt one after
           * the other, and stopping between them would report a finished run —
           * commits, diff and all — as one that went on too long. A run that is
           * still working says so by starting another turn, and that is the
           * only signal that distinguishes the two.
           */
          if (turns > request.limits.turns) {
            kill(
              "turn-limit",
              `stopped at turn ${turns}: the turn limit is ${request.limits.turns}`,
            );
          }
        });
        child.stderr.on("data", (c) => (stderr += c.toString()));

        const finish = (outcome: RunOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(wall);
          request.signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };

        const kill = (kind: "timeout" | "turn-limit" | "aborted", detail: string) => {
          if (settled) return;
          child.kill("SIGTERM");
          // A SIGTERM the agent ignores must not become a hang. The event is the
          // point; a process that will not die is a detail for the next line.
          const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
          hard.unref?.();
          finish({
            exitCode: null,
            // What it got through before it was stopped. The receipt never
            // arrives on this path, and "0 turns" would read as a run that
            // never started rather than one that ran too long.
            turns,
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
          // A last line with no newline behind it — the receipt itself, when a
          // runtime does not terminate it. Counted, never killed on: the
          // process is already gone, and stopping what has stopped is a lie
          // about why.
          consume(unterminated);
          const parsed = parseResult(receipt);
          const durationMs = parsed?.duration_ms ?? Date.now() - started;
          const costUsd = parsed?.total_cost_usd ?? null;
          // The receipt's own number when there is one, and the count off the
          // stream when there is not.
          const reported = parsed?.num_turns ?? turns;

          if (parsed && code === 0 && parsed.is_error !== true) {
            finish({
              exitCode: code,
              turns: reported,
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
            turns: reported,
            durationMs,
            costUsd,
            text: parsed?.result ?? null,
            failure: {
              kind: "crash",
              // Whatever went wrong, something says so. A run that ends with no
              // detail is the failure mode being replaced.
              detail:
                parsed?.result?.slice(0, 500) ??
                (stderr.trim() || tail.trim()).slice(0, 500) ??
                `exited ${code}`,
            },
            sessionId,
          });
        });
      });
    },
  };
}

/**
 * The last JSON object in the output.
 *
 * `--output-format json` prints one, but a wrapper or a warning can put a line
 * in front of it, and the old loop's unparseable `.jsonl` is the reminder that
 * assuming clean output is how a receipt gets lost.
 */
export function parseResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    // Fall through to the last line that is an object.
  }
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t) as ClaudeResult;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** A run id. ULIDs are not in the dependency budget; a UUID sorts well enough. */
export function newRunId(): string {
  return `run-${randomUUID()}`;
}
