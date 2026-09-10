/**
 * `lingtai attach` — the command, as somebody at a terminal meets it.
 *
 * What is asserted here is the *sentences*, because the mechanism is already
 * proved in `packages/conductor/pure/run-log.test.ts` and the sentences are
 * the part a person meets. Two of them carry the whole of what makes this
 * command honest: it says the log ended without saying how the *run* went
 * ([0034](../../../doc/decisions/0034-the-run-log.md) §8), and its refusal
 * names both of the things it cannot tell apart — a run id nobody has heard
 * of, and a run that landed and took its log with it (§4).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRunLog } from "@lingtai/agent";
import { RUN_LOG_END, runLogEnd, runLogPath } from "@lingtai/conductor/run-log";
import { attach } from "../src/attach.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-attach-cli-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function recorder() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sinks: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("lingtai attach", () => {
  it("prints a finished run whole and says the log ends, not how the run went", async () => {
    const path = runLogPath(home, "lingtai", "run-9");
    const log = await openRunLog({ path });
    log.note("Read", "packages/conductor/src/run-once.ts");
    log.note(RUN_LOG_END, runLogEnd(false));
    await log.close("keep");

    const { out, sinks } = recorder();
    expect(await attach({ runId: "run-9", home, ...sinks })).toBe(0);

    expect(out[0]).toBe(`attached to lingtai · ${path}`);
    expect(out.some((l) => l.includes("packages/conductor/src/run-once.ts"))).toBe(true);
    expect(out.at(-1)).toContain("the run log ends here");
    expect(out.at(-1)).toContain(path);
    // Never a verdict. `lingtai status` and the board answer that from
    // `events`, and a second source of truth is what the outbox was deleted for.
    expect(out.join("\n")).not.toContain("failed");
  });

  it("names both reasons a log is missing, and offers the ones that are there", async () => {
    const there = await openRunLog({ path: runLogPath(home, "lingtai", "run-here") });
    await there.close("keep");

    const { err, sinks } = recorder();
    // Non-zero, because nothing was shown. That is the only thing this
    // command's exit status is ever about — never what the run did.
    expect(await attach({ runId: "run-elsewhere", home, ...sinks })).toBe(1);

    const said = err.join("\n");
    expect(said).toContain("no run log for run-elsewhere");
    expect(said).toContain("the run landed");
    expect(said).toContain("run-here");
  });

  it("says so plainly when no run has ever left a log here", async () => {
    const { err, sinks } = recorder();
    expect(await attach({ runId: "run-9", home, ...sinks })).toBe(1);
    expect(err.join("\n")).toContain("There are no run logs on this machine.");
  });

  it("detaches without claiming the run ended", async () => {
    // Ctrl-C. The run carries on and the log is still being written; a command
    // that printed an ending here would be inventing one.
    const path = runLogPath(home, "lingtai", "run-going");
    const log = await openRunLog({ path });
    log.note("Bash", "pnpm test");

    const detach = new AbortController();
    const { out, sinks } = recorder();
    const running = attach({ runId: "run-going", home, signal: detach.signal, ...sinks });
    await new Promise((r) => setTimeout(r, 60));
    detach.abort();

    expect(await running).toBe(0);
    expect(out.at(-1)).toBe(`— detached. The run is still going; its log is at ${path}`);
    await log.close("keep");
  });
});
