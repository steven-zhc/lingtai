/**
 * Reading a run's log — `#110`, the other half of
 * [0034](../../../doc/decisions/0034-the-run-log.md).
 *
 * **In `pure/`, and that is the claim.** This config has no `globalSetup` and
 * opens no connection, so a test that passes here is a proof that following a
 * run needs neither the daemon nor Postgres — which is `Done when`'s *it works
 * while the daemon is down*, and is the whole reason 0034 chose a file. Moving
 * any of this into `test/` would make it prove nothing, because the harness
 * would have opened a database on its behalf.
 *
 * The writer is the real one throughout. A follower matched against a fixture
 * of what the log *ought* to look like is a test of the fixture, and the one
 * line the reader is allowed to act on (`RUN_LOG_END`) is written by
 * `run-once.ts` at the far side of two packages.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRunLog } from "@lingtai/agent";
import {
  RUN_LOG_END,
  findRunLog,
  followRunLog,
  listRunLogs,
  runLogEnd,
  runLogPath,
  type RunLogEnding,
} from "../src/run-log.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-attach-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A quarter of a second per line would make this suite a minute long. */
const QUICK = { pollMs: 5 };

/** Everything the follower said, in order, until it stopped. */
async function drain(
  path: string,
  signal?: AbortSignal,
): Promise<{ lines: string[]; ended: RunLogEnding | null }> {
  const lines: string[] = [];
  let ended: RunLogEnding | null = null;
  for await (const seen of followRunLog({ path, ...QUICK, ...(signal ? { signal } : {}) })) {
    if ("line" in seen) lines.push(seen.line);
    else ended = seen.ended;
  }
  return { lines, ended };
}

describe("finding the log for a run id", () => {
  it("looks the project up rather than asking for one", async () => {
    await mkdir(join(home, "runs", "lingtai"), { recursive: true });
    await mkdir(join(home, "runs", "other"), { recursive: true });
    await writeFile(join(home, "runs", "other", "run-7.log"), "");

    // A run id names a run and not a project: every id anybody types comes off
    // the board or off `lingtai status` with no project beside it.
    expect(await findRunLog("run-7", home)).toEqual({
      project: "other",
      runId: "run-7",
      path: runLogPath(home, "other", "run-7"),
    });
    expect(await findRunLog("run-nobody-has-heard-of", home)).toBeNull();
  });

  it("is null on a machine no run has ever left a log on", async () => {
    expect(await findRunLog("run-7", home)).toBeNull();
    expect(await listRunLogs(home)).toEqual([]);
  });

  it("lists the logs, newest first, and never the settings directory", async () => {
    await mkdir(join(home, "runs", "lingtai"), { recursive: true });
    // `runs/` holds `settingsPathFor`'s `runs/<runId>/settings.json` too — a
    // directory named for a run. The two shapes share a parent and the walk
    // must see only the second.
    await mkdir(join(home, "runs", "lingtai", "run-old"), { recursive: true });
    await writeFile(join(home, "runs", "lingtai", "run-old", "settings.json"), "{}");

    await writeFile(join(home, "runs", "lingtai", "run-old.log"), "");
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(home, "runs", "lingtai", "run-new.log"), "");

    expect((await listRunLogs(home)).map((l) => l.runId)).toEqual(["run-new", "run-old"]);
  });
});

describe("following one", () => {
  it("reads a finished run from the beginning and stops where it ends", async () => {
    // The main use, and the one a command that only worked live would miss:
    // the log worth reading is always the one from the run that just failed.
    const path = runLogPath(home, "lingtai", "run-over");
    const log = await openRunLog({ path });
    log.note("Read", "packages/agent/src/run-log.ts");
    log.note("Bash", "pnpm typecheck");
    log.note(RUN_LOG_END, runLogEnd(false));
    await log.close("keep");

    const { lines, ended } = await drain(path);
    expect(ended).toBe("did not land");
    // The header, two facts, and the line that says the writer let go — from
    // byte zero, with nothing skipped and nothing waited for.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("lingtai run log");
    expect(lines[2]).toContain("pnpm typecheck");
  });

  it("gives a late joiner the file from the start, not from when they attached", async () => {
    // The whole reason 0034 chose a file over a socket: somebody attaching four
    // minutes into a run wants the four minutes.
    const path = runLogPath(home, "lingtai", "run-late");
    const log = await openRunLog({ path });
    log.note("Read", "before anybody was watching");

    const follow = drain(path);
    await new Promise((r) => setTimeout(r, 30));
    log.note("Edit", "after they attached");
    log.note(RUN_LOG_END, runLogEnd(false));
    await log.close("keep");

    const { lines, ended } = await follow;
    expect(ended).toBe("did not land");
    expect(lines.some((l) => l.includes("before anybody was watching"))).toBe(true);
    expect(lines.some((l) => l.includes("after they attached"))).toBe(true);
  });

  it("treats the file going away as an ending, because it is one", async () => {
    // 0034 §4 deletes the log when the run landed and §5 when its work item
    // did. Either way there is nothing left to explain and nothing more coming.
    const path = runLogPath(home, "lingtai", "run-landed");
    const log = await openRunLog({ path });
    log.note("Read", "a run that is about to land");

    const follow = drain(path);
    await new Promise((r) => setTimeout(r, 30));
    await log.close("delete");

    const { lines, ended } = await follow;
    // `removed` rather than `landed`: the file said nothing on its way out, so
    // this is what a reader actually knows. Both mean the same thing and only
    // one of them was witnessed, which is the distinction worth keeping.
    expect(ended).toBe("removed");
    expect(lines.some((l) => l.includes("about to land"))).toBe(true);
  });

  it("says landed when the last line does, before the file goes", async () => {
    const path = runLogPath(home, "lingtai", "run-said");
    const log = await openRunLog({ path });
    log.note(RUN_LOG_END, runLogEnd(true));
    await log.close("keep");

    expect((await drain(path)).ended).toBe("landed");
  });

  it("is an ending and not a failure when there is no file at all", async () => {
    expect(await drain(runLogPath(home, "lingtai", "never-was"))).toEqual({
      lines: [],
      ended: "removed",
    });
  });

  it("stops on an abort without claiming the run ended", async () => {
    // Ctrl-C, and the tab closing. A reader leaving says nothing about the run,
    // so there is no ending to report — the caller knows it detached.
    const path = runLogPath(home, "lingtai", "run-going");
    const log = await openRunLog({ path });
    log.note("Read", "still going");

    const detach = new AbortController();
    const follow = drain(path, detach.signal);
    await new Promise((r) => setTimeout(r, 30));
    detach.abort();

    const { lines, ended } = await follow;
    expect(ended).toBeNull();
    expect(lines.some((l) => l.includes("still going"))).toBe(true);
    await log.close("keep");
  });

  it("never mistakes what an agent printed for the line that ends the log", async () => {
    // Everything an agent controls arrives as a *detail*; the end is matched on
    // the label column, which nothing it types can reach. An agent that prints
    // this sentence verbatim must not hang up on its own reader.
    const path = runLogPath(home, "lingtai", "run-liar");
    const log = await openRunLog({ path });
    log.note("agent", runLogEnd(true));
    log.note("Edit", "and the run carried on");
    log.note(RUN_LOG_END, runLogEnd(false));
    await log.close("keep");

    const { lines, ended } = await drain(path);
    expect(ended).toBe("did not land");
    expect(lines.some((l) => l.includes("and the run carried on"))).toBe(true);
  });

  it("keeps a line whole however the disk hands it over", async () => {
    // A `read` lands wherever the writer left it, so both a partial line and a
    // partial UTF-8 character are ordinary. Half a line yielded as a line is a
    // fragment of a fact read as the whole one.
    const path = runLogPath(home, "lingtai", "run-split");
    const log = await openRunLog({ path });

    const follow = drain(path);
    for (const chunk of ["日本語のプロンプト", "— и кириллица", "…"]) {
      log.note("agent", chunk.repeat(400));
      await new Promise((r) => setTimeout(r, 8));
    }
    log.note(RUN_LOG_END, runLogEnd(false));
    await log.close("keep");

    const { lines } = await follow;
    expect(lines.filter((l) => l.includes("agent"))).toHaveLength(3);
    expect(lines.some((l) => l.includes("日本語のプロンプト".repeat(400)))).toBe(true);
    expect(lines.every((l) => !l.includes("�"))).toBe(true);
  });
});
