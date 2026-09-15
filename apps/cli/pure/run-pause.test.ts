/**
 * `lingtai run` is a conductor, and a pause stops conductors (#166).
 *
 * The lock (#93) is about concurrency and says nothing about consent, so a
 * `lingtai pause` taken with no daemon up left the lock free and a `lingtai run`
 * took work anyway. What has to be true is that a pause on the log stops the
 * command **before it takes the lock** — and that the sentence `lingtai pause`
 * and `lingtai doctor` print about `run` is the one the behaviour bears out.
 *
 * No database: the pause is appended to a memory store, and a run that got past
 * it would reach for the conductor lock and say so — which the first test
 * asserts it does not.
 */
import { pauseConductor, readControl } from "@lingtai/daemon/control";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { describe, expect, it } from "vitest";
import { daemonLiveness } from "../src/doctor.ts";
import { RUN_UNDER_A_PAUSE, run } from "../src/run.ts";

describe("lingtai run under a standing pause", () => {
  it("takes nothing, and never reaches the lock", async () => {
    const store = createMemoryEventStore();
    await pauseConductor("human:ops", "migrating the database", store);

    const lines: string[] = [];
    const code = await run({ project: "esctest-never-looked-up", lockKey: "lingtai:test:paused", store }, (l) =>
      lines.push(l),
    );
    const said = lines.join("\n");

    // Exit 0: a person decided this, and nothing went wrong.
    expect(code).toBe(0);
    expect(said).toContain("paused by human:ops — migrating the database");
    // Every one of these is a stage past the pause. Their absence is the claim.
    expect(said).not.toContain("conductor lock");
    expect(said).not.toContain("GitHub App");
    expect(said).not.toContain("no project named");
    expect(said).not.toContain("run(s)");

    // **The sentence, pinned against the behaviour above** — not against a copy
    // of itself. It claims a run takes no work while a pause stands; the run
    // above is that claim tested, and a sentence saying it proceeds would fail.
    expect(RUN_UNDER_A_PAUSE).toMatch(/takes no work/);
    expect(said).toContain(RUN_UNDER_A_PAUSE);
  });

  it("is what lingtai doctor reports beside the pause", async () => {
    const store = createMemoryEventStore();
    await pauseConductor("human:ops", "migrating the database", store);

    const liveness = await daemonLiveness(
      async () => null,
      () => readControl(store),
    );
    expect(liveness.detail).toContain("paused by human:ops (migrating the database)");
    expect(liveness.detail).toContain(RUN_UNDER_A_PAUSE);
  });
});
