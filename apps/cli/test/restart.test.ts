/**
 * What `lingtai restart` refuses, and what it does instead of starting.
 *
 * Against `planRestart` rather than the command, because the rules are the part
 * worth asserting and asserting them must not need a daemon, a drain or an hour.
 * The command around it gathers four facts and does what this says — which is
 * why the four facts are the argument.
 *
 * The shape is the evening of 2026-09-09: a daemon started from `582a0f8`, a
 * commit that had not been pushed, and twenty minutes later a rebase rewrote it
 * out of existence while the process held that code for the rest of its life
 * ([0038](../../../doc/decisions/0038-the-restart-is-a-command.md)).
 */
import type { Identity, ShutdownRequest } from "@lingtai/daemon";
import { describe, expect, it } from "vitest";
import { planRestart, type Before } from "../src/restart.ts";

const pushed: Identity = {
  sha: "2926f2d0f0e2a0b1c2d3e4f5a6b7c8d9e0f1a2b3",
  dirty: false,
  base: "origin/main",
  pushed: true,
  unknown: null,
};

/** Everything fine: a pushed commit, a clean tree, a green doctor, a daemon up. */
function before(over: Partial<Before> = {}): Before {
  return {
    identity: pushed,
    doctorFailed: 0,
    conducting: "lingtai daemon pid 5123",
    daemonUp: true,
    shutdown: null,
    ...over,
  };
}

describe("what a restart does when nothing is wrong", () => {
  it("drains the daemon that is up", () => {
    expect(planRestart(before(), { anyway: false })).toEqual({ go: "drain", overridden: [] });
  });

  /**
   * A `lingtai run` in a terminal is a conductor and holds the same lock (#93),
   * and it reads no control stream at all — so there is nothing to ask and the
   * only honest thing to do is wait for it.
   */
  it("waits out a conductor that is not a daemon, rather than asking it to stop", () => {
    const plan = planRestart(before({ daemonUp: false }), { anyway: false });
    expect(plan).toEqual({ go: "wait", overridden: [] });
  });

  it("starts straight away when nobody is conducting", () => {
    const plan = planRestart(before({ daemonUp: false, conducting: null }), { anyway: false });
    expect(plan).toEqual({ go: "start", overridden: [] });
  });
});

describe("what a restart refuses", () => {
  it("refuses a commit that is not on the tracking remote, and names it", () => {
    const plan = planRestart(
      before({ identity: { ...pushed, sha: "582a0f8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pushed: false } }),
      { anyway: false },
    );

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because[0]).toContain("582a0f8");
    expect(plan.because[0]).toContain("origin/main");
    expect(plan.waivable).toBe(true);
  });

  it("names a dirty worktree in the same refusal, not a second one", () => {
    const plan = planRestart(
      before({ identity: { ...pushed, pushed: false, dirty: true } }),
      { anyway: false },
    );

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because).toHaveLength(2);
    expect(plan.because[1]).toContain("uncommitted changes");
  });

  /**
   * The exit code at `lingtai doctor`'s call site says it exists to gate a
   * restart, and until 0038 it had no caller.
   */
  it("refuses what doctor failed on, and says how many", () => {
    const plan = planRestart(before({ doctorFailed: 2 }), { anyway: false });

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because[0]).toContain("2 failed check(s)");
  });

  it("starts anyway when told to, and still says what it waved through", () => {
    const plan = planRestart(
      before({ identity: { ...pushed, pushed: false, dirty: true }, doctorFailed: 1 }),
      { anyway: true },
    );

    expect(plan.go).toBe("drain");
    if (plan.go === "refuse") return;
    // Three refusals, waved through and still printed: `--anyway` means *I have
    // read these*, not *do not tell me*.
    expect(plan.overridden).toHaveLength(3);
  });
});

describe("a drain somebody else asked for", () => {
  const asked: ShutdownRequest = { by: "human:ops", reason: "the importer is flaky", timeoutMs: null };

  /**
   * Somebody has asked this system to stop. Restarting over that is this command
   * deciding for them, so it does not — and `--anyway` deliberately does not
   * cover it, because the flag is about the code and this is about a person.
   */
  it("is a refusal --anyway does not cover", () => {
    for (const anyway of [false, true]) {
      const plan = planRestart(before({ shutdown: asked }), { anyway });

      expect(plan.go).toBe("refuse");
      if (plan.go !== "refuse") continue;
      expect(plan.waivable).toBe(false);
      expect(plan.because[0]).toContain("human:ops");
      expect(plan.because[0]).toContain("lingtai resume");
    }
  });

  it("is named beside whatever else was wrong, so one reading gets all of it", () => {
    const plan = planRestart(
      before({ shutdown: asked, identity: { ...pushed, dirty: true } }),
      { anyway: false },
    );

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because).toHaveLength(2);
    expect(plan.because[1]).toContain("uncommitted changes");
  });
});
