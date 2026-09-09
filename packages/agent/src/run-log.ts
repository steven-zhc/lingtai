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
 * design is wrong. So nothing reads it back — `reconcile` looks at whether one
 * exists, never at what is in it.
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
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { AgentHostFailed } from "./hook-config.ts";

/**
 * The mode the file is created with, and then asserted.
 *
 * It holds **whatever the agent printed** — values it read from its filtered
 * environment, contents of files it opened, the commands it ran. Today that
 * output is parsed and discarded, so persisting it is a *new* exposure and not
 * a wider view of one that already existed. `agent-env`'s `ENV_FILE_MODE` set
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
 * for the trace: `#109` puts the agent's own stream in the same file, and a
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
  return `${hh}:${mm}:${ss}  ${label.padEnd(8)}${flat}\n`;
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
