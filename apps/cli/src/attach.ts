/**
 * `lingtai attach <runId>` — watch a run, or read the one that failed.
 *
 * The reading half of [0034](../../../doc/decisions/0034-the-run-log.md), and
 * it is a `tail` and nothing more. Everything that makes it possible was
 * decided by the file: `#108` put a run's trace at
 * `~/.lingtai/runs/<project>/<runId>.log`, `#109` put the agent's own output in
 * it, and this opens it.
 *
 * **Three properties follow from it being a file, and each is a `Done when`.**
 *
 * It works on a run that is over, which is the main use — the log worth reading
 * is always the one from the run that just failed, and 0034 §4 keeps exactly
 * those. It works with the daemon down, and with Postgres down: **no query on
 * this path**, so a stopped system — the moment you most want to know what the
 * last run was doing — answers as readily as a busy one. And it starts at byte
 * zero however late you attach, which is the whole reason 0034 chose a file
 * over a socket: somebody attaching four minutes in wants the four minutes.
 *
 * **It never says how the run went.** The log is a trace and not a record
 * (§8) — `lingtai status` and the board answer that from `events`, and a second
 * source of truth is what the outbox was deleted for. What this reports on the
 * way out is narrower and is about the file: the writer let go, so there is
 * nothing more coming.
 *
 * No colour, on purpose. `#107` owns the vocabulary for every surface and the
 * ticket puts this outside it rather than have one more command invent its own.
 */
import { findRunLog, followRunLog, listRunLogs } from "@lingtai/conductor/run-log";

export interface AttachOptions {
  runId: string;
  /** Overridable for a test; `findRunLog` defaults it to `stateDir()`. */
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Ends the follow the way Ctrl-C does. */
  signal?: AbortSignal;
}

export async function attach(options: AttachOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));

  const found = await findRunLog(options.runId, options.home);
  if (!found) {
    // Deliberately not "no such run". This command knows about files and not
    // about runs, so the two things it cannot tell apart — a run id nobody has
    // heard of, and a run that landed and took its log with it (0034 §4) — are
    // named as the one question it can answer, with the list somebody wanting
    // to attach almost always actually wanted.
    err(`no run log for ${options.runId}`);
    err("Either the run landed — a log is deleted when its diff reaches the base branch — or the id is not one.");
    const logs = await listRunLogs(options.home);
    if (logs.length === 0) {
      err("There are no run logs on this machine.");
    } else {
      err("");
      err("Logs that are here, newest first:");
      for (const log of logs.slice(0, ATTACH_LIST_MAX)) err(`  ${log.runId}\t${log.project}`);
      if (logs.length > ATTACH_LIST_MAX) err(`  … and ${logs.length - ATTACH_LIST_MAX} more`);
    }
    return 1;
  }

  out(`attached to ${found.project} · ${found.path}`);

  for await (const seen of followRunLog({
    path: found.path,
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if ("line" in seen) {
      out(seen.line);
      continue;
    }
    // The file's ending, which is not the run's verdict — see the header.
    out(
      seen.ended === "removed"
        ? "— the log is gone. Its run landed, or its work item did, and a landed run has nothing left to explain (0034 §4, §5)"
        : `— the run log ends here. ${seen.ended === "landed" ? "It is about to be deleted" : `It is kept at ${found.path}`}`,
    );
    return 0;
  }

  // Only reachable through the signal: the loop above returns on an ending and
  // otherwise waits. Said out loud because a `tail` that simply stops looks the
  // same as a run that simply stopped, and only one of those is happening.
  out(`— detached. The run is still going; its log is at ${found.path}`);

  // Zero for a follow that worked, whatever the run did. A viewer's exit status
  // is about the viewing: making it carry the run's verdict would be this file
  // settling something, which is the one thing 0034 §8 forbids it.
  return 0;
}

/** Enough of a list to recognise the one you meant, and not a page of scroll. */
const ATTACH_LIST_MAX = 20;
