/**
 * The run log, as a file on a real disk.
 *
 * Three claims, and each is a thing that is cheap to assert and expensive to be
 * wrong about ([0034](../../../doc/decisions/0034-the-run-log.md) §7):
 *
 * - **it is `0600`**, because it holds whatever the agent printed — values it
 *   read from its filtered environment, contents of files it opened. That
 *   output is parsed and discarded today, so persisting it is a *new* exposure;
 * - **it stops where it says it stops**, so a short log cannot be mistaken for
 *   the whole of one;
 * - **`delete` means gone**, which is the half of keep-or-delete that leaves
 *   evidence behind if it silently does not happen.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_RUN_LOG, RUN_LOG_MAX_BYTES, openRunLog, runLogLine } from "../src/index.ts";

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-run-log-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("a run's log file", () => {
  it("is 0600, and creates the directory it needs", async () => {
    const path = join(home, "runs", "purecheck", "run-mode.log");
    const log = await openRunLog({ path });
    log.note("Read", "packages/agent/src/claude-code.ts");
    await log.close("keep");

    // `& 0o777` because the mode carries the file type bits too.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The directory the conductor never made: `openRunLog` is handed a path and
    // is expected to be able to write to it.
    expect((await stat(join(home, "runs", "purecheck"))).isDirectory()).toBe(true);
  });

  it("writes one line per fact, timestamped, whatever the agent typed", async () => {
    const path = join(home, "runs", "purecheck", "run-lines.log");
    const log = await openRunLog({ path, started: new Date("2026-09-09T14:22:03.145Z") });
    log.note("Read", "packages/agent/src/claude-code.ts");
    // A `Bash` command with a newline in it would otherwise break `tail -f` and
    // every reader after it — including `#110`, which is a person.
    log.note("Bash", "pnpm typecheck\n  && pnpm test");
    await log.close("keep");

    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    expect(lines[0]).toContain("2026-09-09T14:22:03.145Z");
    expect(lines[0]).toContain(String(RUN_LOG_MAX_BYTES));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d {2}Read {4}packages\/agent\/src\/claude-code\.ts$/);
    expect(lines[2]).toContain("pnpm typecheck ⏎ && pnpm test");
  });

  it("stops at the cap and says so on the line it stops at", async () => {
    const path = join(home, "runs", "purecheck", "run-cap.log");
    const log = await openRunLog({ path });
    // Nine megabytes of `Read`, against an eight megabyte cap.
    const fat = "x".repeat(90_000);
    for (let i = 0; i < 100; i += 1) log.note("Read", fat);
    log.note("Bash", "this line is past the end and must not be here");
    await log.close("keep");

    const text = await readFile(path, "utf8");
    expect(text).toContain(`truncated: this log reached RUN_LOG_MAX_BYTES (${RUN_LOG_MAX_BYTES} bytes)`);
    expect(text).not.toContain("this line is past the end");
    // The notice is deliberately written *past* the cap rather than squeezed
    // under it: a file that stopped silently at a round number is a file whose
    // last line is a lie by omission. So it overshoots by one line and no more.
    expect(text.length).toBeLessThan(RUN_LOG_MAX_BYTES + 200);
  });

  it("deletes the file when the run landed, and keeps it when it did not", async () => {
    const kept = join(home, "runs", "purecheck", "run-kept.log");
    const gone = join(home, "runs", "purecheck", "run-gone.log");

    const a = await openRunLog({ path: kept });
    await a.close("keep");
    const b = await openRunLog({ path: gone });
    await b.close("delete");

    expect((await stat(kept)).isFile()).toBe(true);
    await expect(stat(gone)).rejects.toThrow();
  });

  /**
   * A run whose log could not be opened is worse observed and is not worse off.
   *
   * The events are the half that settles anything and they are unaffected, so
   * `run-once.ts` takes this rather than refusing — and takes it as an object
   * rather than a `null`, so no call site has to remember a `?.`.
   */
  it("has a shape that does nothing, for when there is no file", async () => {
    expect(NO_RUN_LOG.path).toBe("");
    NO_RUN_LOG.note("Read", "nowhere");
    await NO_RUN_LOG.close("delete");
  });

  it("formats a line the way 0034 §3 draws one", () => {
    expect(runLogLine(new Date(2026, 8, 9, 14, 22, 31), "Edit", "packages/agent/src/x.ts")).toBe(
      "14:22:31  Edit    packages/agent/src/x.ts\n",
    );
  });
});
