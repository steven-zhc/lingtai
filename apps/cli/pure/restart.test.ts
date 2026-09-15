/**
 * What `lingtai restart` refuses, and what it does instead of starting.
 *
 * Against `planRestart` rather than the command, because the rules are the part
 * worth asserting and asserting them must not need a daemon, a drain or an hour.
 * The command around it gathers the facts and does what this says — which is
 * why the facts are the argument.
 *
 * The shape is the evening of 2026-09-09: a daemon started from `582a0f8`, a
 * commit that had not been pushed, and twenty minutes later a rebase rewrote it
 * out of existence while the process held that code for the rest of its life
 * ([0042](../../../doc/decisions/0042-the-restart-is-a-command.md)).
 */
import type { Identity, ShutdownRequest } from "@lingtai/daemon";
import { describe, expect, it } from "vitest";
import { describeRefusal } from "../src/doctor.ts";
import {
  attributeStart,
  gatingFailures,
  parseRestartArgs,
  startSupervised,
  planRestart,
  waitForTheLock,
  type Before,
  type Waivers,
} from "../src/restart.ts";

const pushed: Identity = {
  sha: "2926f2d0f0e2a0b1c2d3e4f5a6b7c8d9e0f1a2b3",
  dirty: false,
  base: "origin/main",
  pushed: true,
  unknown: null,
};

const none: Waivers = { dirty: false, despiteDoctor: false };
const every: Waivers = { dirty: true, despiteDoctor: true };

/** Everything fine: a pushed commit, a clean tree, a green doctor, a daemon up. */
function before(over: Partial<Before> = {}): Before {
  return {
    by: "human:steven",
    identity: pushed,
    doctorFailed: 0,
    conducting: "lingtai daemon pid 5123",
    daemonUp: true,
    shutdown: null,
    loaded: null,
    ...over,
  };
}

describe("what a restart does when nothing is wrong", () => {
  it("drains the daemon that is up", () => {
    expect(planRestart(before(), none)).toEqual({ go: "drain", overridden: [], adopted: null });
  });

  /**
   * The lock held with no fresh beacon: a `lingtai run` in a terminal (#93), or
   * a daemon whose beacon writes are failing while it keeps its lock. The plan
   * says `wait`, and `prepareRestart` asks the drain for it anyway — a stale
   * beacon is not proof that nothing will read one.
   */
  it("waits on a conductor with no fresh beacon", () => {
    expect(planRestart(before({ daemonUp: false }), none)).toEqual({ go: "wait", overridden: [], adopted: null });
  });

  it("starts straight away when nobody is conducting", () => {
    const plan = planRestart(before({ daemonUp: false, conducting: null }), none);
    expect(plan).toEqual({ go: "start", overridden: [], adopted: null });
  });
});

describe("what a restart refuses", () => {
  it("refuses a commit that is not on the tracking remote, and names it", () => {
    const plan = planRestart(
      before({ identity: { ...pushed, sha: "582a0f8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", pushed: false } }),
      none,
    );

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because[0]?.line).toContain("582a0f8");
    expect(plan.because[0]?.line).toContain("origin/main");
  });

  /**
   * The finding against the previous attempt: one `--anyway` waived this and an
   * unrelated doctor failure together, so the flag that disables the check this
   * command exists for was the one a flaky doctor trained you to type.
   */
  it("has no flag that starts an unpushed commit, or one that could not be checked", () => {
    for (const identity of [
      { ...pushed, pushed: false },
      { ...pushed, pushed: null, unknown: "unknown revision origin/main" },
    ]) {
      const plan = planRestart(before({ identity }), every);
      expect(plan.go).toBe("refuse");
      if (plan.go !== "refuse") continue;
      expect(plan.because).toHaveLength(1);
      expect(plan.because[0]?.waiver).toBeNull();
    }
  });

  it("names a dirty worktree in the same refusal, not a second one", () => {
    const plan = planRestart(before({ identity: { ...pushed, pushed: false, dirty: true } }), none);

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because).toHaveLength(2);
    expect(plan.because[1]?.line).toContain("uncommitted changes");
    expect(plan.because[1]?.waiver).toBe("--dirty");
  });

  /**
   * The exit code at `lingtai doctor`'s call site says it exists to gate a
   * restart, and until 0042 it had no caller.
   */
  it("refuses what doctor failed on, and says how many", () => {
    const plan = planRestart(before({ doctorFailed: 2 }), none);

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because[0]?.line).toContain("2 failed check(s)");
    expect(plan.because[0]?.waiver).toBe("--despite-doctor");
  });

  it("waives exactly what each flag names, and still says what it waved through", () => {
    const dirtyAndSick = before({ identity: { ...pushed, dirty: true }, doctorFailed: 1 });

    // One flag is one refusal: --dirty leaves the doctor standing.
    const onlyDirty = planRestart(dirtyAndSick, { dirty: true, despiteDoctor: false });
    expect(onlyDirty.go).toBe("refuse");
    if (onlyDirty.go === "refuse") expect(onlyDirty.because.map((r) => r.waiver)).toEqual(["--despite-doctor"]);

    const both = planRestart(dirtyAndSick, every);
    expect(both.go).toBe("drain");
    if (both.go === "refuse") return;
    // Waved through and still printed: a flag means *I have read this*, not
    // *do not tell me*.
    expect(both.overridden).toHaveLength(2);
  });
});

/**
 * The finding against the first fix: the process imported its code when the
 * command was typed, and the check after the drain compared two reads of the
 * disk. A `git pull` during the drain brought in a pushed, clean commit, both
 * reads agreed on it, and `ConductorStarted` named code that was not running.
 */
describe("the code this process loaded", () => {
  const pulled: Identity = { ...pushed, sha: "b88b88b88b88b88b88b88b88b88b88b88b88b88b" };

  it("refuses, with no flag, when the disk moved on from what was loaded during the drain", () => {
    for (const waivers of [none, every]) {
      const plan = planRestart(
        before({ identity: pulled, loaded: { sha: pushed.sha, dirty: false }, daemonUp: false, conducting: null }),
        waivers,
      );

      expect(plan.go).toBe("refuse");
      if (plan.go !== "refuse") continue;
      expect(plan.because[0]?.waiver).toBeNull();
      expect(plan.because[0]?.line).toContain("2926f2d");
      expect(plan.because[0]?.line).toContain("b88b88b");
    }
  });

  it("refuses a worktree that became dirty after loading, even with --dirty", () => {
    const plan = planRestart(
      before({ identity: { ...pushed, dirty: true }, loaded: { sha: pushed.sha, dirty: false }, conducting: null, daemonUp: false }),
      every,
    );
    expect(plan.go).toBe("refuse");
  });

  it("starts when the disk is still what was loaded", () => {
    const plan = planRestart(
      before({ loaded: { sha: pushed.sha, dirty: false }, conducting: null, daemonUp: false }),
      none,
    );
    expect(plan).toEqual({ go: "start", overridden: [], adopted: null });
  });
});

/**
 * The #148 shape: a daemon started at `cc6e856` refuses every sweep over a key
 * its frozen schema does not know, a pull brings in the fix, and doctor fails
 * with *that process is too old for it — restart it*. The restart it asks for
 * must not be the command that refuses on it.
 */
describe("a doctor failure whose remedy is the restart", () => {
  const OLD = "cc6e856".padEnd(40, "0");
  const NEW = "be9fd26".padEnd(40, "0");
  const refusal = {
    project: "lingtai",
    detail: 'env: Unrecognized key: "refuseHosts"',
    ref: "main",
    codeSha: OLD,
    seq: 4242n,
    at: new Date("2026-09-12T10:00:00.000Z"),
  };

  it("does not gate the restart, while a refusal by the code here still does", () => {
    const stale = describeRefusal("lingtai", refusal, { daemonUp: true, here: NEW, behind: true });
    expect(stale.status).toBe("fail");
    expect(stale.restartAnswers).toBe(true);
    const sameCode = describeRefusal("lingtai", refusal, { daemonUp: true, here: OLD });
    expect(sameCode.restartAnswers).toBe(false);

    const failed = gatingFailures([
      { status: "fail", restartAnswers: stale.restartAnswers },
      { status: "ok" },
    ]);
    expect(failed).toBe(0);
    expect(planRestart(before({ doctorFailed: failed }), none).go).toBe("drain");

    // A refusal by code *newer* than this checkout — which only differs from it
    // — is not answered by starting older code, and still gates the restart.
    const newer = describeRefusal("lingtai", { ...refusal, codeSha: NEW }, { daemonUp: true, here: OLD, behind: false });
    expect(newer.status).toBe("fail");
    expect(newer.restartAnswers).toBe(false);
    expect(gatingFailures([{ status: "fail", restartAnswers: newer.restartAnswers }])).toBe(1);
    expect(describeRefusal("lingtai", refusal, { daemonUp: true, here: NEW }).restartAnswers).toBe(false);

    // Anything else that failed still refuses, and still needs its flag.
    expect(gatingFailures([{ status: "fail", restartAnswers: true }, { status: "fail" }])).toBe(1);
    expect(gatingFailures([{ status: "fail", restartAnswers: sameCode.restartAnswers }])).toBe(1);
  });
});

describe("a drain that is already standing", () => {
  const asked: ShutdownRequest = {
    by: "human:ops",
    reason: "the importer is flaky",
    timeoutMs: null,
    version: 7,
    force: false,
    handoff: null,
  };

  /**
   * Somebody has asked this system to stop. Restarting over that is this command
   * deciding for them, so it does not, and no flag covers it.
   */
  it("is a refusal no flag covers, when somebody else asked for it", () => {
    for (const waivers of [none, every]) {
      const plan = planRestart(before({ shutdown: asked }), waivers);

      expect(plan.go).toBe("refuse");
      if (plan.go !== "refuse") continue;
      expect(plan.because[0]?.waiver).toBeNull();
      expect(plan.because[0]?.line).toContain("human:ops");
      expect(plan.because[0]?.line).toContain("lingtai resume");
    }
  });

  it("is named beside whatever else was wrong, so one reading gets all of it", () => {
    const plan = planRestart(before({ shutdown: asked, identity: { ...pushed, dirty: true } }), none);

    expect(plan.go).toBe("refuse");
    if (plan.go !== "refuse") return;
    expect(plan.because).toHaveLength(2);
    expect(plan.because[1]?.line).toContain("uncommitted changes");
  });

  /**
   * The other finding: Ctrl+C during the wait says the request is left standing
   * and `lingtai restart` starts again — and the previous attempt then refused
   * that very request as somebody else's. Your own is taken over, not refused
   * and not asked for twice.
   */
  it("is taken over, not refused, when it is your own", () => {
    const mine = { ...asked, by: "human:steven", reason: "restarting: picking up #88" };
    expect(planRestart(before({ shutdown: mine }), none)).toEqual({ go: "drain", overridden: [], adopted: mine });
    expect(planRestart(before({ shutdown: mine, daemonUp: false, conducting: null }), none)).toEqual({
      go: "start",
      overridden: [],
      adopted: mine,
    });
  });
});

/**
 * The finding against the second fix: a lock query that threw once was read as
 * "nobody holds it", so a network blip ten minutes into a pass withdrew the
 * drain while the old daemon was still conducting — and it carried on from the
 * stale commit with nothing asking it to stop.
 */
describe("waiting for the lock", () => {
  it("does not read a failed query as a free lock, and keeps waiting", async () => {
    const answers: (() => Promise<string | null>)[] = [
      async () => "lingtai daemon pid 5123",
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
      async () => "lingtai daemon pid 5123",
      async () => null,
    ];
    let asked = 0;
    const lines: string[] = [];

    const waited = await waitForTheLock("draining", null, (l) => lines.push(l), {
      ask: () => answers[Math.min(asked++, answers.length - 1)]!(),
      pollMs: 1,
    });

    expect(waited).toBe("free");
    // Free only on the answer that said nobody, not on the one that failed.
    expect(asked).toBe(4);
    expect(lines.join("\n")).toContain("ECONNREFUSED");
  });

  /**
   * Under a supervisor the respawn can take the lock between two polls, so a
   * wait for it to be free never ends. A recorded start ends it too.
   */
  it("ends on a recorded start, when the lock is never seen free", async () => {
    let polls = 0;
    const waited = await waitForTheLock("draining", null, () => {}, {
      ask: async () => (polls < 2 ? "lingtai daemon pid 5123" : "lingtai daemon pid 5200"),
      started: async () => ++polls >= 3,
      pollMs: 1,
    });
    expect(waited).toBe("started");
  });

  it("gives up on its timeout rather than calling a lock it cannot read free", async () => {
    const waited = await waitForTheLock("draining", 5, () => {}, {
      ask: async () => {
        throw new Error("the pooler restarted");
      },
      pollMs: 2,
    });
    expect(waited).toBe("gave-up");
  });
});

describe("the command line", () => {
  /**
   * A flag written before the reason used to take the reason's first word as
   * its value, and the reason `ConductorStarted` carries lost it.
   */
  it("never lets a boolean flag swallow the reason", () => {
    const parsed = parseRestartArgs(["--dirty", "picking", "up", "#88", "--no-merge"]);
    expect(parsed).toEqual({
      ok: true,
      args: {
        reason: "picking up #88",
        timeoutMs: null,
        dirty: true,
        despiteDoctor: false,
        noConduct: false,
        noMerge: true,
        force: false,
      },
    });
  });

  it("takes a value where a flag has one", () => {
    const parsed = parseRestartArgs(["--timeout", "90s", "deploying"]);
    expect(parsed.ok && parsed.args).toMatchObject({ reason: "deploying", timeoutMs: 90_000 });
  });

  it("refuses a flag it does not have, --anyway included, rather than keeping it silently", () => {
    // `--force` has left this list: it is a flag now (`#159`), the one that
    // says do not wait for the pass. What stays is a flag that was removed on
    // purpose and a value flag given nothing usable.
    for (const argv of [["--anyway"], ["--nonsense"], ["--timeout"], ["--timeout", "soon"]]) {
      expect(parseRestartArgs(argv).ok, argv.join(" ")).toBe(false);
    }
  });
});

/**
 * Whose start the log records (0042 §5, §8). The evening this closes is a start
 * nobody can name; the failure to avoid on the way is a start the log names
 * *wrongly* — a person for launchd's respawn, or a restart for a daemon running
 * a commit that restart never checked.
 *
 * `control` is the fold of the stream the start lands on, so `shutdown` is the
 * request this start ends — and a supervised restart's handoff rides on it.
 */
describe("whose start it is", () => {
  const code = { sha: "2926f2d", dirty: false };
  const handed: ShutdownRequest = {
    by: "human:steven",
    reason: "restarting: picking up #88",
    timeoutMs: null,
    version: 4,
    force: false,
    handoff: { sha: "2926f2d", dirty: false },
  };
  const plain: ShutdownRequest = { ...handed, reason: "stopping for the day", handoff: null };
  const pushed = (sha: string, dirty = false) => ({ sha, dirty, base: "origin/main", pushed: true, unknown: null });
  const base = { restart: null, control: { shutdown: null }, code, identity: pushed("2926f2d"), tty: false, user: "ops" };

  /**
   * There used to be a start that was not recorded: one into a standing drain,
   * which read it and exited, every thirty seconds under a supervisor. A start
   * reads nothing said before it now (`0045`), so it starts and is recorded.
   */
  it("records a start into a standing drain, which that start ends", () => {
    expect(attributeStart({ ...base, control: { shutdown: plain } })).toMatchObject({ record: true, by: "daemon", handoff: null });
  });

  it("names nobody for a start with no terminal and no handoff, and the typist for one at a terminal", () => {
    expect(attributeStart(base)).toMatchObject({ record: true, by: "daemon", handoff: null });
    expect(attributeStart({ ...base, tty: true })).toMatchObject({ record: true, by: "human:ops", handoff: null });
  });

  it("gives a supervisor's start the restart's name, when it runs the commit that restart checked", () => {
    expect(attributeStart({ ...base, control: { shutdown: handed } })).toEqual({
      record: true,
      by: "human:steven",
      reason: "restarting: picking up #88",
      handoff: 4,
      note: null,
    });
  });

  it("does not, on another commit — it is `daemon`, says why, and still names the request", () => {
    // A merge landed in the checkout during the drain: pushed, clean, and not
    // what was checked.
    const a = attributeStart({ ...base, code: { sha: "582a0f8", dirty: false }, identity: pushed("582a0f8"), control: { shutdown: handed } });
    expect(a).toMatchObject({ record: true, by: "daemon", handoff: 4 });
    expect(a.record && a.reason).toContain("582a0f8");
  });

  /**
   * The finding against the third round. Under launchd a restart at 2926f2d
   * asks its drain with the handoff; during the fifty-minute pass somebody
   * amends, so HEAD is 582a0f8 and the remote does not have it. The respawn
   * must not conduct from it — the check after the wait, run where the start is.
   */
  it("declines a supervisor's start on a commit the remote does not have, which the restart's check would refuse", () => {
    const amended = { sha: "582a0f8", dirty: false, base: "origin/main", pushed: false, unknown: null };
    const a = attributeStart({ ...base, code: { sha: "582a0f8", dirty: false }, identity: amended, control: { shutdown: handed } });
    expect(a.record).toBe(false);
    expect(!a.record && a.why).toContain("582a0f8");
    expect(!a.record && a.why).toContain("service stop");
  });

  it("declines one on a dirty worktree the restart did not waive, and not one it did", () => {
    const dirty = { code: { sha: "2926f2d", dirty: true }, identity: pushed("2926f2d", true) };
    expect(attributeStart({ ...base, ...dirty, control: { shutdown: handed } }).record).toBe(false);
    const waived: ShutdownRequest = { ...handed, handoff: { sha: "2926f2d", dirty: true } };
    expect(attributeStart({ ...base, ...dirty, control: { shutdown: waived } })).toMatchObject({ record: true, by: "human:steven" });
  });

  it("declines nothing where there is no handoff, whatever the checkout — only a restart's checks refuse", () => {
    const amended = { sha: "582a0f8", dirty: true, base: "origin/main", pushed: false, unknown: null };
    expect(attributeStart({ ...base, identity: amended, control: { shutdown: plain } })).toMatchObject({ record: true, by: "daemon" });
    expect(attributeStart({ ...base, identity: amended, tty: true, control: { shutdown: handed } })).toMatchObject({ record: true });
  });

  it("does not give a typed start the restart's name", () => {
    expect(attributeStart({ ...base, tty: true, control: { shutdown: handed } })).toMatchObject({
      by: "human:ops",
      handoff: null,
    });
  });

  it("gives a restart in this process its own name, over the drain it asked for", () => {
    const restart = { by: "human:steven", reason: "picking up #88", request: 4 };
    expect(attributeStart({ ...base, restart, control: { shutdown: plain } })).toEqual({
      record: true,
      by: "human:steven",
      reason: "picking up #88",
      handoff: null,
      note: null,
    });
    expect(attributeStart({ ...base, restart, control: { shutdown: null } })).toMatchObject({ record: true, by: "human:steven" });
  });

  /**
   * The check after the wait reads the stream, and then the lock is won; a
   * drain somebody asks for between the two would be ended by the start without
   * anybody reading it. The restart is the one start that declines, because it
   * is the one whose checks promised not to start over somebody else's drain.
   */
  it("records nothing for a restart in this process over a drain it did not ask for", () => {
    const ops: ShutdownRequest = { ...plain, by: "human:ops", reason: "moving the database", version: 5 };
    for (const request of [4, null]) {
      const a = attributeStart({ ...base, restart: { by: "human:steven", reason: "x", request }, control: { shutdown: ops } });
      expect(a.record).toBe(false);
      expect(!a.record && a.why).toContain("human:ops");
    }
  });

  /**
   * `lingtai restart` asks v4 and waits; the same person's `shutdown --force`
   * lands as v5. The check after the wait adopts it, and so must the start —
   * declining left the system down and told the operator to `resume`.
   */
  it("records a restart in this process over a newer drain the same person asked for, as planRestart adopts it", () => {
    const mine: ShutdownRequest = { ...plain, reason: "stuck", force: true, version: 5 };
    expect(attributeStart({ ...base, restart: { by: "human:steven", reason: "x", request: 4 }, control: { shutdown: mine } })).toMatchObject({
      record: true,
      by: "human:steven",
    });
  });
});

describe("a start the supervisor makes", () => {
  const prepared = { by: "human:steven", request: 4, examined: { sha: "2926f2d", dirty: false } };
  const start = { by: "human:steven", reason: "restarting", sha: "2926f2d", dirty: false, worker: "h:9", handoff: 4, at: new Date() };

  it("succeeds on the recorded start that answered this restart's request, and says so", async () => {
    const lines: string[] = [];
    let polls = 0;
    const code = await startSupervised(prepared, {
      start: async () => 0,
      recorded: async () => (++polls < 3 ? null : start),
      up: async () => true,
      pollMs: 1,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("human:steven's restart");
  });

  /** The respawn does not wait for this command, and usually gets there first. */
  it("asks the supervisor for nothing when the start is already recorded", async () => {
    let asked = false;
    const code = await startSupervised(prepared, {
      start: async () => ((asked = true), 0),
      recorded: async () => start,
      up: async () => true,
      log: () => {},
    });
    expect(code).toBe(0);
    expect(asked).toBe(false);
  });

  it("fails on a start that was not this one's, naming what did start", async () => {
    const lines: string[] = [];
    const code = await startSupervised(prepared, {
      start: async () => 0,
      recorded: async () => ({ ...start, by: "daemon", sha: "582a0f8" }),
      up: async () => true,
      pollMs: 1,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("582a0f8");
  });

  /**
   * The record comes before the reconcile. The respawn records this restart's
   * start and dies in its reconcile; `KeepAlive` brings back a copy that finds no
   * request and records `daemon`. That copy is what conducts, so it is judged.
   */
  it("does not succeed on a recorded start that died before it came up, and judges the one that replaced it", async () => {
    const lines: string[] = [];
    const respawn = { ...start, by: "daemon", reason: null, handoff: null, worker: "h:10", at: new Date(start.at.getTime() + 30_000) };
    let polls = 0;
    const code = await startSupervised(prepared, {
      start: async () => 0,
      // v11 is the only start for a few polls, then v12 is recorded after it.
      recorded: async () => (++polls < 4 ? start : respawn),
      // v11 never says up; v12 does.
      up: async (s) => s.worker === "h:10",
      pollMs: 1,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("h:10");
    expect(lines.join("\n")).not.toContain("human:steven's restart");
  });

  it("does not succeed on a recorded start that never comes up", async () => {
    const lines: string[] = [];
    const code = await startSupervised(prepared, {
      start: async () => 0,
      recorded: async () => start,
      up: async () => false,
      waitMs: 5,
      pollMs: 1,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("not up");
  });

  it("fails, and says where to look, when nothing is recorded in time", async () => {
    const code = await startSupervised(prepared, { start: async () => 0, recorded: async () => null, waitMs: 5, pollMs: 1, log: () => {} });
    expect(code).toBe(1);
  });

  it("does not wait on a supervisor that refused the start", async () => {
    let asked = 0;
    const code = await startSupervised(prepared, {
      start: async () => 1,
      recorded: async () => {
        asked += 1;
        return null;
      },
      log: () => {},
    });
    expect(code).toBe(1);
    // Once, before asking the supervisor, and never after it refused.
    expect(asked).toBe(1);
  });
});
