/**
 * `lingtai run` is a conductor, and a pause stops conductors (#166).
 *
 * The lock (#93) is about concurrency and says nothing about consent, so a
 * `lingtai pause` taken with no daemon up left the lock free and a `lingtai run`
 * took work anyway. What has to be true is that a pause on the log stops the
 * command **before it takes the lock** — and that what `lingtai pause`,
 * `lingtai doctor` and `--help` print about `run` is what the behaviour bears
 * out.
 *
 * No database: the pause is appended to a memory store, and a run that got past
 * it would reach for the conductor lock and say so — which the first test
 * asserts it does not. A pause heard *between* tickets is `runQueue`'s, and is
 * held in `packages/conductor` (`pure/schedule-pause.test.ts`, and the
 * whole-queue case in `test/run-once.test.ts`).
 */
import { readControl } from "@lingtai/daemon/control";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { repoRoot } from "@lingtai/env";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonLiveness } from "../src/doctor.ts";
import { pauseCommand } from "../src/pause.ts";
import { RUN_UNDER_A_PAUSE, run } from "../src/run.ts";

describe("lingtai run under a standing pause", () => {
  it("is refused as lingtai pause says it will be, and never reaches the lock", async () => {
    const store = createMemoryEventStore();
    const printed: string[] = [];
    // The command itself, not the constant: what a person reads after pausing.
    await pauseCommand("human:ops", "migrating the database", { store, log: (l) => printed.push(l) });
    const told = printed.join("\n");
    expect(told).toContain("paused by human:ops — migrating the database");
    // Spelled out rather than compared with `RUN_UNDER_A_PAUSE`, so a sentence
    // edited into saying something else fails here.
    expect(told).toContain("lingtai run takes no ticket while it stands, daemon or none");
    expect(told).toContain("one already working finishes the ticket in hand and takes no other");

    const lines: string[] = [];
    const code = await run({ project: "esctest-never-looked-up", lockKey: "lingtai:test:paused", store }, (l) =>
      lines.push(l),
    );
    const said = lines.join("\n");

    // Exit 0: a person decided this, and nothing went wrong.
    expect(code).toBe(0);
    expect(said).toContain("paused by human:ops — migrating the database");
    expect(said).toContain(`nothing was taken: ${RUN_UNDER_A_PAUSE}`);
    // Every one of these is a stage past the pause. Their absence is the claim.
    expect(said).not.toContain("conductor lock");
    expect(said).not.toContain("GitHub App");
    expect(said).not.toContain("no project named");
    expect(said).not.toContain("run(s)");
  });

  it("is what --help says about lingtai run under lingtai pause", async () => {
    // Read from the source: `lingtai.ts` runs `main` on import.
    const source = await readFile(join(repoRoot(), "apps/cli/src/lingtai.ts"), "utf8");
    const entry = source.slice(source.indexOf("  lingtai pause <why>"), source.indexOf("  lingtai resume"));
    expect(entry.replace(/\s+/g, " ")).toContain(
      "lingtai run, which takes no ticket while a pause stands, daemon or none: one already working finishes the ticket in hand and takes no other",
    );
  });

  it("is what lingtai doctor reports beside the pause", async () => {
    const store = createMemoryEventStore();
    await pauseCommand("human:ops", "migrating the database", { store, log: () => {} });

    const liveness = await daemonLiveness(
      async () => null,
      () => readControl(store),
    );
    expect(liveness.detail).toContain("paused by human:ops (migrating the database)");
    expect(liveness.detail).toContain(RUN_UNDER_A_PAUSE);
  });
});
