/**
 * Running one command in a worktree, and coming back with something a person
 * can act on.
 *
 * This was inside `process-gate.ts`, and it is out here because the prepare
 * stage needs exactly the same execution and none of the same meaning. A gate's
 * result is a **verdict about a commit**, bound to `onSha` and invalidated by a
 * force-push. A prepare step runs before the agent has written anything and
 * holds no verdict about anything. Sharing the runner is right; sharing the
 * result type would have quietly given prepare an `onSha` that means nothing.
 *
 * It lives in `@lingtai/actions` rather than in a package of its own because
 * the dependency already runs that way — the conductor imports the gates — and a
 * package with one file in it is a worse answer than a slightly wide name.
 *
 * It is also the extension mechanism, and there is no other one:
 * [0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §2 —
 * *"There is no plugin system. An extension is a command."* §4 fixes the shape
 * of the conversation with that command, and this file is where it is spoken:
 * **context in on stdin, verdict out by the exit code and optionally a file.**
 * The constraint that shapes all of it is that every `run:` in every recipe
 * today reads no stdin and writes no file, and must go on behaving exactly as
 * it does — so both halves are opt-in by the caller and invisible without it.
 *
 * The three things this does that a bare `spawn` does not:
 *
 * **A failure carries its log tail.** The board's promise is that a card is
 * workable without leaving it, and "it failed" with no output is a link to
 * somewhere else wearing a disguise.
 *
 * **A timeout is a distinct outcome.** A command that ran out of time and one
 * that ran and refused are different problems with different fixes, and the
 * caller should not have to guess which it got.
 *
 * **The buffer is bounded, not just the evidence.** A runaway process can print
 * faster than anything reads it.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

/** How much of the output a card gets. Enough to act on, bounded. */
export const EVIDENCE_LINES = 60;
export const EVIDENCE_BYTES = 8_000;

/** Above this, older output is dropped while the command is still running. */
const BUFFER_BYTES = 2_000_000;

export interface CommandOutcome {
  ok: boolean;
  /** What a person reads. On failure, the log tail. */
  evidence: string;
  /** Distinguished from a non-zero exit, deliberately. */
  timedOut: boolean;
  durationMs: number;
  /** Null when the process never ran, or was killed before exiting. */
  exitCode: number | null;
  /**
   * What the command wrote to `LINGTAI_RESULT`, parsed. Absent unless the
   * caller named a `resultPath` *and* the command wrote valid JSON to it —
   * which no plain `run:` does, and which never decides `ok` on its own.
   */
  result?: unknown;
}

export interface RunCommandOptions {
  /** Through a shell: a recipe writes `pnpm lint && pnpm test`, and splitting
   *  that correctly is not this file's job. */
  run: string;
  timeoutMs: number;
  /** How the timeout is written in the recipe, for the message. `15m`, not `900000`. */
  timeoutLabel?: string;
  /** The worktree. Commands run where the agent worked, never anywhere else. */
  cwd: string;
  /** Filtered, exactly as the agent's was. */
  env: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Handed to the command as JSON on stdin, which is then closed. Omitted, the
   * child gets `/dev/null` exactly as before.
   *
   * On stdin rather than in the environment because of size: a real
   * `RunPrompted` in this log carried `bytes: 4555`, and an environment is both
   * size-limited and legible to anyone running `ps` (0037 §4).
   */
  payload?: unknown;
  /**
   * Where the command may write an answer richer than its exit code. Named to
   * the child in `LINGTAI_RESULT`, and read back into `result`.
   *
   * The path is the caller's to choose and must be one nothing else wrote:
   * this reads whatever is there when the command exits and cannot tell a stale
   * file from a fresh one. Absent, the child sees no `LINGTAI_RESULT` at all —
   * so a command cannot inherit a meaning from a run it was not part of.
   */
  resultPath?: string;
}

/** The last N lines, capped — a build log can be megabytes. */
export function tail(text: string, lines = EVIDENCE_LINES, bytes = EVIDENCE_BYTES): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  const kept = trimmed.split("\n").slice(-lines).join("\n");
  return kept.length <= bytes ? kept : `…${kept.slice(-bytes)}`;
}

/**
 * Run the command and wait for it. A gate action's exit code is a verdict, so
 * this is the caller a gate uses.
 */
export function runCommand(options: RunCommandOptions): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => spawnCommand(options, resolve));
}

/**
 * Run the command and do not wait for it — 0037 §3's other caller. *"The whole
 * taxonomy is: a command, and whether the core waits for it."* A subscriber's
 * exit code is discarded, so the loop that started it goes on immediately.
 *
 * Not waiting is not the same as not looking. The timeout is enforced exactly
 * as it is for a gate, because 0037 §6's point is that an ignored failure and a
 * bounded one are different guarantees and only the second keeps the loop
 * moving — and the outcome, when it arrives, is handed to `report`.
 * `work-loop.ts` already appends `PluginFailed` when an in-process subscriber
 * fails, for §7's reason: a subscriber whose failure is a console line is a
 * notifier that has silently stopped notifying. Nothing reads the exit code of
 * a subscriber that is a command, so this callback is the only place that
 * event could come from.
 *
 * It returns nothing to await, deliberately: a caller that could wait for this
 * is a caller a subscriber can stall.
 *
 * **`report` is held here, and that is a boundary rather than a courtesy.** It
 * is called from a `close` handler and from a timer, so a throw out of it is an
 * uncaught exception and a rejection out of it an unhandled one — in whichever
 * process started the command, which for a subscriber is the process that
 * follows the log. `work-loop.ts`'s `deliver` makes exactly this call for the
 * in-process subscribers and makes it for the same reason: a guarantee held by
 * the callee is one every future caller has to re-honour. What is lost is one
 * outcome nobody could be told about, by the thing whose job was to tell them —
 * there is no third place to put that, and the log's follower staying up is
 * worth more than it.
 */
export function startCommand(
  options: RunCommandOptions,
  report?: (outcome: CommandOutcome) => void | Promise<void>,
): void {
  spawnCommand(options, (outcome) => {
    try {
      void Promise.resolve(report?.(outcome)).catch(() => {});
    } catch {
      // A `report` that throws before its promise exists. Same fate, one line
      // earlier.
    }
  });
}

/**
 * The spawning both callers share. Whether the core waits is the only
 * difference between them, so it is the only thing above this line.
 */
function spawnCommand(
  options: RunCommandOptions,
  report: (outcome: CommandOutcome) => void,
): void {
  const started = Date.now();
  const child = spawnChild(options);

  let out = "";
  let settled = false;
  /** When the process ended, so reading the result file is not billed to it. */
  let endedAt: number | null = null;
  const collect = (chunk: Buffer) => {
    out += chunk.toString();
    if (out.length > BUFFER_BYTES) out = out.slice(-BUFFER_BYTES / 2);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const finish = (outcome: Omit<CommandOutcome, "durationMs">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    report({ ...outcome, durationMs: (endedAt ?? Date.now()) - started });
  };

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    // A process that ignores SIGTERM still has to go, or the run leaks it.
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    finish({
      ok: false,
      timedOut: true,
      exitCode: null,
      evidence: `timed out after ${options.timeoutLabel ?? `${options.timeoutMs}ms`}\n\n${tail(out)}`,
    });
  }, options.timeoutMs);

  const onAbort = () => {
    child.kill("SIGTERM");
    finish({ ok: false, timedOut: false, exitCode: null, evidence: `aborted\n\n${tail(out)}` });
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  child.on("error", (err) =>
    finish({
      ok: false,
      timedOut: false,
      exitCode: null,
      // The command not existing is the most common version of this, and
      // saying which command is the whole difference from "spawn ENOENT".
      evidence: `could not run "${options.run}": ${err.message}`,
    }),
  );

  const settleOnExit = async (code: number | null) => {
    const took = `${(((endedAt ?? Date.now()) - started) / 1000).toFixed(1)}s`;
    const { result, problem } = await readResult(options.resultPath);
    const note = problem ? `\n\n${problem}` : "";
    if (code === 0) {
      finish({
        ok: true,
        timedOut: false,
        exitCode: 0,
        result,
        evidence: `${options.run} exited 0 in ${took}${note}`,
      });
      return;
    }
    finish({
      ok: false,
      timedOut: false,
      exitCode: code,
      result,
      // stdout is still what a person reads, unchanged. The result file is the
      // structured channel precisely so that taking one does not cost the other.
      evidence: `${options.run} exited ${code} after ${took}${note}\n\n${tail(out)}`,
    });
  };

  child.on("close", (code) => {
    if (settled) return;
    endedAt = Date.now();
    // The clock stops when the process does: a slow disk is not a timeout.
    clearTimeout(timer);
    void settleOnExit(code);
  });
}

/**
 * The child, and the one decision that changes its shape: whether there is a
 * payload for it.
 *
 * Two spawns rather than one with a computed `stdio`, because the shape of that
 * array is what tells the caller whether `stdout` exists. A ternary inside it
 * collapses the tuple to a union, `spawn` falls back to the signature that
 * promises nothing, and every read of `child.stdout` below becomes a possible
 * null the compiler is right to refuse. Said as two literals, each branch keeps
 * its streams — and the no-payload branch stays byte-for-byte the spawn every
 * `run:` in every recipe already gets, which is the constraint (0037 §4).
 */
function spawnChild(
  options: RunCommandOptions,
): ChildProcessByStdio<Writable | null, Readable, Readable> {
  const env = options.resultPath
    ? { ...options.env, LINGTAI_RESULT: options.resultPath }
    : options.env;

  if (options.payload === undefined) {
    // stdin is `/dev/null`, as it has always been: a reader gets EOF, not a hang.
    return spawn(options.run, {
      shell: true,
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const child = spawn(options.run, {
    shell: true,
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A command that never reads stdin closes the pipe under us — that is every
  // `run:` in every recipe today, and it is not a failure of anything. The exit
  // code is still the exit code.
  child.stdin.on("error", () => {});
  child.stdin.end(`${JSON.stringify(options.payload)}\n`);
  return child;
}

/**
 * 0037 §4's second half. The exit code carries pass/fail; anything richer —
 * findings, `request-approval` — is JSON at the path the core named, because
 * taking stdout for structured output would take the failure output of every
 * `pnpm test` with it.
 *
 * Nothing there is the ordinary case and says nothing. Garbage there is a bug
 * in an extension, so it is reported as evidence rather than swallowed. Neither
 * changes the verdict: the exit code already gave one, and falling back to it
 * is what keeps a broken writer from turning a passing command into a failing
 * one.
 */
async function readResult(path?: string): Promise<{ result?: unknown; problem?: string }> {
  if (!path) return {};

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // Never written is the normal case, not an error to report.
    return {};
  }
  if (!text.trim()) return {};

  try {
    return { result: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      problem: `LINGTAI_RESULT (${path}) is not JSON, so the exit code decides: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
