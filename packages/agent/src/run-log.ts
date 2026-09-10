/**
 * A run's log file: what the agent is doing, while it is doing it.
 *
 * [0034](../../../doc/decisions/0034-the-run-log.md). Before this the only
 * observable of a running agent was `ps` — `#105` ran for four minutes and the
 * whole of what could be known about it was a pid and a truncated command line.
 * The live picture already existed: the hook socket sees every tool call and
 * every lifecycle hook as it happens and calls `onDecision` / `onLifecycle`
 * with it, and nothing consumed either. This is where it goes.
 *
 * **It is a trace, not a record** (0034 §8). Decisions live on the event log
 * and only there; this file explains and never settles. The distinction has a
 * test: if some behaviour would change depending on this file's contents, the
 * design is wrong. So `reconcile` looks at whether one exists, never at what is
 * in it, and `followRunLog` below — the reading half, `#110` — takes exactly one
 * thing from the contents and it is not about the run: `RUN_LOG_END` says the
 * writer has let go, so a tail may stop waiting. Everything else it does is
 * hand a line to a person unread.
 *
 * **The path is chosen by the conductor and handed here** (0034 §1). This
 * module knows how to write a log; it does not know where `~/.lingtai` is, and
 * a runtime adapter that learned the home layout would have crossed the seam
 * 0022 drew.
 *
 * **Writing never gates a tool call.** `note` returns immediately and the write
 * happens on a queue behind it, which is the same rule `hook-socket.ts` states
 * for persistence: the verdict is synchronous, everything else is not. A slow
 * or full disk must not stall an agent, and a log that cannot be written must
 * not be able to fail a run — every failure in here is swallowed on purpose.
 */
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Effect } from "effect";
import { AgentHostFailed } from "./hook-config.ts";

/**
 * The mode the file is created with, and then asserted.
 *
 * It holds **whatever the agent printed** — values it read from its filtered
 * environment, contents of files it opened, the commands it ran. That output
 * was parsed and discarded until `#109`, so persisting it is a *new* exposure
 * and not a wider view of one that already existed. `agent-env`'s
 * `ENV_FILE_MODE` set
 * the standard for a file of Lingtai's that holds somebody's secrets, and this
 * is the same instinct applied to the same class of content.
 *
 * Unlike `ENV_FILE_MODE` this *is* enforced on an existing file, because there
 * is no case where the file is the operator's: it is named for a run id, it is
 * written by one process, and it is deleted when that run lands.
 */
export const RUN_LOG_MODE = 0o600;

/** `~/.lingtai/runs/<project>/`, created with the same instinct as the files in it. */
export const RUN_LOG_DIR_MODE = 0o700;

/**
 * Where one run's log stops.
 *
 * A trace line is about sixty bytes, so eight megabytes is something like
 * 130,000 tool calls — far past any run that has ever happened. The cap is not
 * for the trace: `#109` put the agent's own stream in the same file, and a
 * single run can produce tens of megabytes of that. What the number has to
 * protect is the disk and the person: this is a file somebody opens to find out
 * why a run failed, and past this it stops being one.
 *
 * The file says where it truncated, in itself, so a short answer read out of a
 * capped log cannot be mistaken for the whole of one. Written down in
 * `doc/reference.md`'s policy section, which is what `#96` exists to make
 * unskippable.
 */
export const RUN_LOG_MAX_BYTES = 8_000_000;

/**
 * The half of a run log a *writer* gets: a line, and no say in when it ends.
 *
 * `RunRequest.log` is this rather than `RunLog` because the two halves belong to
 * different people. The adapter has the agent's stream and nothing else; the
 * keep-or-delete is the conductor's, taken where the worktree is removed and
 * only knowable there (0034 §4). Handing over the narrower type is what makes
 * that structural rather than a rule somebody remembers.
 *
 * **One writer, not two.** 0034 §1 says the conductor names the file and the
 * adapter is handed it, and `#108` landed that as a path. `#109` hands the
 * writer instead, for two reasons the path could not give: §7's cap is then one
 * number about one file rather than one per open handle — and the agent's
 * stream is what makes the file large, so a second handle would have doubled
 * exactly the thing the cap is for — and a multi-megabyte line and a trace line
 * arriving from two descriptors can interleave *within* a line, which is the
 * one thing `runLogLine` exists to prevent. The seam 0022 drew is unmoved and
 * is drawn tighter: the adapter now does not learn the path either.
 */
export type RunTrace = Pick<RunLog, "note">;

/**
 * What a run's log is, to the conductor holding one.
 *
 * `close` takes the decision rather than making it: **landed → delete, did not
 * land → keep** (0034 §4) is the caller's to know, and the caller is the scoped
 * release in `run-once.ts` that already runs on every outcome. What survives is
 * then exactly the investigable set, with no timer, no sweeper and no retention
 * period.
 */
export interface RunLog {
  /** Empty for `NO_RUN_LOG`, so a caller can tell there is nothing to hand on. */
  readonly path: string;
  /** One timestamped line. Returns immediately; the write is behind it. */
  note(label: string, detail?: string): void;
  close(fate: "keep" | "delete"): Promise<void>;
}

/**
 * A log that is not there.
 *
 * Handed back when the file could not be opened, so the run continues and the
 * call sites stay free of `?.`. A run without its log is worse observed and is
 * not worse off — the events are unaffected, and that is the half that settles
 * anything.
 */
export const NO_RUN_LOG: RunLog = {
  path: "",
  note: () => {},
  close: async () => {},
};

/**
 * Where the label starts, and how wide it is — `HH:MM:SS` and two spaces.
 *
 * Named because `runLogEnded` is the inverse of `runLogLine` and the two have
 * to agree; a reader that counted the columns for itself would be a second copy
 * of the format, in the one place where being wrong looks like a run that never
 * ends.
 */
const LABEL_AT = 8 + 2;
const LABEL_WIDTH = 8;

/**
 * One line: `14:22:31  Edit    allow  packages/agent/src/claude-code.ts`.
 *
 * Local time and seconds only, because the file is read while it is being
 * written and against a person's own clock; the date is on the header line the
 * file opens with. One line per fact, always — a `Bash` command with a newline
 * in it would otherwise break `tail -f` and every reader after it.
 */
export function runLogLine(at: Date, label: string, detail: string): string {
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const ss = String(at.getSeconds()).padStart(2, "0");
  const flat = detail.replace(/\s*\r?\n\s*/g, " ⏎ ").trimEnd();
  return `${hh}:${mm}:${ss}  ${label.padEnd(LABEL_WIDTH)}${flat}\n`;
}

/**
 * The label on the last line a log ever gets.
 *
 * **The only thing a reader may take from this file's contents** (0034 §8). The
 * file is a trace and never settles anything, so nothing here says how the run
 * *went* — that is `events`, and `lingtai status` is how you ask. What this
 * line settles is narrower and is not about the run at all: **the writer has let
 * go**, so a `tail` may stop waiting. A viewer returning your prompt is not a
 * behaviour of Lingtai's, and §8's test — would some behaviour change with the
 * contents — is about the system, not about when a terminal comes back.
 *
 * It is matched on the *label* and never on the detail. Everything an agent
 * controls arrives as a detail (`traceOf` labels its prose `agent` and its
 * reasoning `think`), so an agent that prints this sentence verbatim writes it
 * into a column where it cannot be mistaken for this line.
 */
export const RUN_LOG_END = "end";

/**
 * How a follow stopped.
 *
 * `removed` is an ending too, and the same one: 0034 §4 deletes the file when
 * the run landed and §5 when its work item did, so a file that is gone is a
 * file with nothing left to explain.
 */
export type RunLogEnding = "landed" | "did not land" | "removed";

/**
 * The sentence the log closes on, written by whoever took the keep-or-delete.
 *
 * Here rather than at that call site because the reader below is the inverse of
 * it — one module, so the two cannot drift into a `tail` that never returns.
 */
export function runLogEnd(didLand: boolean): string {
  return didLand
    ? "landed — the diff is on the branch and the events are on the log, so this file goes"
    : "did not land — this file is kept, and is the only account of why";
}

/** `runLogEnd`'s inverse, and it reads the label column only. See `RUN_LOG_END`. */
export function runLogEnded(line: string): Exclude<RunLogEnding, "removed"> | null {
  if (line.slice(LABEL_AT, LABEL_AT + LABEL_WIDTH) !== RUN_LOG_END.padEnd(LABEL_WIDTH)) return null;
  const detail = line.slice(LABEL_AT + LABEL_WIDTH);
  if (detail.startsWith("landed")) return "landed";
  if (detail.startsWith("did not land")) return "did not land";
  return null;
}

export interface OpenRunLogOptions {
  /** Absolute, and chosen by the conductor. See the module header. */
  path: string;
  /** Overridable so a test can fix the header. */
  started?: Date;
}

export async function openRunLog(options: OpenRunLogOptions): Promise<RunLog> {
  const path = options.path;
  const started = options.started ?? new Date();

  await mkdir(dirname(path), { recursive: true, mode: RUN_LOG_DIR_MODE });
  // Append, because a second attempt at the same run id is a thing that should
  // add to the story rather than erase it. The mode argument only applies at
  // creation and umask can only narrow it further, so the `chmod` below is what
  // actually makes 0600 a claim rather than a hope.
  const handle: FileHandle = await open(path, "a", RUN_LOG_MODE);
  await handle.chmod(RUN_LOG_MODE).catch(() => {});

  let bytes = 0;
  let truncated = false;
  /** Writes in order, one at a time, with nobody waiting for them. */
  let tail: Promise<unknown> = Promise.resolve();

  // The `catch` is what keeps the queue alive: a line that could not be written
  // must not take every line after it with it.
  const push = (text: string) => {
    tail = tail.then(() => handle.write(text)).catch(() => {});
  };

  const header =
    `lingtai run log · started ${started.toISOString()} · times below are local, HH:MM:SS · ` +
    `capped at ${RUN_LOG_MAX_BYTES} bytes\n`;
  bytes += Buffer.byteLength(header);
  push(header);

  return {
    path,

    note(label, detail = "") {
      // The line that says the file is over is written past the cap, exactly
      // as the notice that says where the cap was is. A follower has nothing
      // else that tells *the writer has finished* from *the writer is thinking*
      // (`#110`), so leaving it out would hang a reader for ever on precisely
      // the runs that produced the most to read.
      if (label === RUN_LOG_END) {
        push(runLogLine(new Date(), label, detail));
        return;
      }
      if (truncated) return;
      const line = runLogLine(new Date(), label, detail);
      const size = Buffer.byteLength(line);
      if (bytes + size > RUN_LOG_MAX_BYTES) {
        truncated = true;
        // Deliberately written past the cap. A file that stopped silently at a
        // round number is a file whose last line is a lie by omission, and the
        // whole reason for a cap that is written down is that somebody reading
        // a short log should be able to tell which kind of short it is.
        push(
          runLogLine(
            new Date(),
            "——",
            `truncated: this log reached RUN_LOG_MAX_BYTES (${RUN_LOG_MAX_BYTES} bytes) and stops here`,
          ),
        );
        return;
      }
      bytes += size;
      push(line);
    },

    async close(fate) {
      await tail.catch(() => {});
      await handle.close().catch(() => {});
      if (fate === "delete") await rm(path, { force: true }).catch(() => {});
    },
  };
}

/**
 * The same, in the channel the ports speak.
 *
 * Deliberately **not** `acquireRelease`: the close carries the keep-or-delete
 * decision (0034 §4) and only the caller knows it, at the moment its scope
 * closes. `run-once.ts` is where that pair is made, beside the worktree's.
 */
export const openRunLogEffect = (
  options: OpenRunLogOptions,
): Effect.Effect<RunLog, AgentHostFailed> =>
  Effect.tryPromise({
    try: () => openRunLog(options),
    catch: (err) => new AgentHostFailed({ operation: "runLog", detail: (err as Error).message }),
  });

/**
 * How often a follower looks for more.
 *
 * There is no notification to wait on: the writer is a queue behind a file
 * handle in another process, and 0034 chose a file over a socket precisely so
 * that reading one needs nothing from the process that wrote it. `tail -f`
 * polls for the same reason. A quarter of a second is under the threshold at
 * which a person reading a scrolling log perceives a delay, and costs one
 * `read` returning zero bytes when nothing happened.
 *
 * In `doc/reference.md`'s policy section, which 0034 §7 makes unskippable.
 */
export const RUN_LOG_POLL_MS = 250;

/** A line of the file, or the writer letting go of it. */
export type RunLogFollowed = { readonly line: string } | { readonly ended: RunLogEnding };

export interface FollowRunLogOptions {
  /** Absolute. The caller resolved a run id to it; this module knows no layout. */
  path: string;
  /** Overridable so a test does not wait a quarter of a second per line. */
  pollMs?: number;
  /** The reader went away. Ends the follow without an ending, which is the truth. */
  signal?: AbortSignal;
}

/**
 * The file, from the beginning, and then as it grows.
 *
 * **From byte zero, always** — that is the whole of why 0034 chose a file over
 * a socket. Somebody who attaches four minutes into a run wants the four
 * minutes, and a stream that started when they did would have thrown away the
 * part that explains the part they can see.
 *
 * It reads a file and nothing else, so it works while the daemon is down and on
 * a run that ended weeks ago. The writer is not consulted, does not know it is
 * being read, and cannot be blocked by a reader.
 *
 * **Whole lines only.** A `read` lands wherever the disk left it, so both a
 * partial line and a partial UTF-8 character are ordinary, and half a line
 * yielded as a line is a fragment of a fact read as the whole one —
 * `lineReader` in `claude-code.ts` states the same rule for the same reason.
 */
export async function* followRunLog(options: FollowRunLogOptions): AsyncGenerator<RunLogFollowed> {
  const pollMs = options.pollMs ?? RUN_LOG_POLL_MS;

  let handle: FileHandle;
  try {
    handle = await open(options.path, "r");
  } catch {
    // Not there to begin with. `findRunLog` is how a caller tells this apart
    // from a run id nobody has heard of; here it is simply an ending.
    yield { ended: "removed" };
    return;
  }

  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(64 * 1024);
  let pending = "";

  try {
    for (;;) {
      if (options.signal?.aborted) return;

      // Everything since the last pass. `position: null` advances the handle's
      // own cursor, which is what makes this a tail and not a re-read.
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        pending += decoder.write(buffer.subarray(0, bytesRead));
      }

      for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        yield { line };
        const ended = runLogEnded(line);
        if (ended) {
          yield { ended };
          return;
        }
      }

      // Read first, then ask. A run that landed writes its last line and then
      // deletes the file, and in that order the last line is never lost — the
      // handle above outlives the unlink, so the drain just above has already
      // taken everything the writer wrote.
      try {
        await stat(options.path);
      } catch {
        yield { ended: "removed" };
        return;
      }

      await pause(pollMs, options.signal);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `setTimeout`, cut short by an abort, because a reader leaving should not wait. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
