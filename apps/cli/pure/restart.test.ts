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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, RecordedStart, ShutdownRequest } from "@lingtai/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeRefusal } from "../src/doctor.ts";
import {
  RESTART_GUARDS,
  SUPERVISED_ONLY,
  attributeStart,
  gatingFailures,
  openDaemon,
  parseRestartArgs,
  planRestart,
  prepareRestart,
  restartSupervised,
  startRecorder,
  startRefusals,
  waitForTheLock,
  type Before,
  type RestartArgs,
  type RestartFacts,
  type Waivers,
} from "../src/restart.ts";
import { LAUNCHCTL_NO_SUCH_SERVICE, LAUNCHD_LABEL, serviceCommand, type Exec } from "../src/service.ts";

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
    startedSince: null,
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
  const asked: ShutdownRequest = { by: "human:ops", reason: "the importer is flaky", timeoutMs: null, version: 7, force: false };

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
 * Whose start the log records (0042 §5). The evening this closes is a start
 * nobody can name; the failure to avoid on the way is a start the log names
 * *wrongly* — a person for launchd's respawn.
 */
describe("whose start it is", () => {
  const base = { restart: null, control: { shutdown: null }, tty: false, user: "ops" };

  it("records nothing for a start into a standing drain", () => {
    const shutdown: ShutdownRequest = { by: "human:steven", reason: "restarting", timeoutMs: null, version: 3, force: false };
    expect(attributeStart({ ...base, control: { shutdown } })).toMatchObject({ record: false });
  });

  it("names nobody for a start with no terminal, and the typist for one at a terminal", () => {
    expect(attributeStart(base)).toEqual({ record: true, by: "daemon", reason: null });
    expect(attributeStart({ ...base, tty: true })).toEqual({ record: true, by: "human:ops", reason: null });
  });

  it("names the restart that started it in this process", () => {
    expect(attributeStart({ ...base, restart: { by: "human:steven", reason: "picking up #88" } })).toEqual({
      record: true,
      by: "human:steven",
      reason: "picking up #88",
    });
  });
});

describe("the read a start is recorded from", () => {
  const drain: ShutdownRequest = { by: "human:steven", reason: "restarting", timeoutMs: null, version: 3, force: false };

  it("records once, off the first read the daemon acts on", async () => {
    const recorded: unknown[] = [];
    const note = startRecorder({ restart: null, tty: false, user: "s", record: async (a) => void recorded.push(a), log: () => {} });
    await note({ shutdown: null });
    await note({ shutdown: null });
    expect(recorded).toEqual([{ record: true, by: "daemon", reason: null }]);
  });

  it("records nothing off a read that finds the drain, which is the read the daemon exits on", async () => {
    const recorded: unknown[] = [];
    const lines: string[] = [];
    const note = startRecorder({ restart: null, tty: false, user: "s", record: async (a) => void recorded.push(a), log: (l) => lines.push(l) });
    await note({ shutdown: drain });
    expect(recorded).toEqual([]);
    expect(lines.join("\n")).toContain("not recorded as a start");
  });

  it("says a record that failed, and does not throw into the loop that would then take no work", async () => {
    const lines: string[] = [];
    const note = startRecorder({
      restart: null,
      tty: false,
      user: "s",
      record: async () => {
        throw new Error("version race, five times");
      },
      log: (l) => lines.push(l),
    });
    await expect(note({ shutdown: null })).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("version race");
  });
});

describe("the refusals only a started daemon can be asked", () => {
  const examined = { sha: pushed.sha, dirty: false };
  const ops: ShutdownRequest = { by: "human:ops", reason: "moving the database", timeoutMs: null, version: 15, force: false };

  it("refuses a daemon running another commit than the one checked", () => {
    const r = startRefusals({ examined, running: { sha: "c0ffee".padEnd(40, "0"), dirty: false }, standing: null, unreadThrough: 20 });
    expect(r.map((x) => x.line).join("\n")).toContain("c0ffee0");
  });

  it("refuses a drain it will never read, and not one it will", () => {
    expect(startRefusals({ examined, running: examined, standing: ops, unreadThrough: 20 })).toHaveLength(1);
    expect(startRefusals({ examined, running: examined, standing: ops, unreadThrough: 14 })).toEqual([]);
    expect(startRefusals({ examined, running: examined, standing: null, unreadThrough: 20 })).toEqual([]);
  });
});

// ------------------------------------------------------------ both paths ----

/**
 * **Every refusal the terminal path makes, the supervised path makes too** (#167).
 *
 * One scene per row of `RESTART_GUARDS`, played through both commands: the
 * terminal `lingtai restart` (`prepareRestart`, then what `daemonCommand` does
 * with it) and the supervised one (`restartSupervised`, over the real
 * `serviceCommand` and a launchd that behaves like one). Nothing here is a
 * database or a process; everything the commands read is the scene's, and
 * the scene moves on at the moments the world would — when the drain is over,
 * and when the supervisor starts the daemon.
 */
const BY = `human:${process.env["USER"] ?? "operator"}`;
const ARGS: RestartArgs = { reason: "picking up #88", timeoutMs: null, dirty: false, despiteDoctor: false, noConduct: false, noMerge: false, force: false };
const ops = (version: number): ShutdownRequest => ({ by: "human:ops", reason: "moving the database", timeoutMs: null, version, force: false });
const startOf = (id: Pick<Identity, "sha" | "dirty">, version = 21): RecordedStart => ({
  by: "daemon",
  reason: null,
  sha: id.sha,
  dirty: id.dirty,
  worker: "mac:4242",
  version,
  at: new Date("2026-09-16T10:00:00Z"),
});

interface Scene {
  /** Before anything stops. */
  identity?: Identity;
  doctorFailed?: number;
  holder?: () => Promise<string | null>;
  daemonUp?: () => Promise<boolean>;
  shutdown?: ShutdownRequest | null;
  /** A request somebody else appends between the plan and the ask. */
  askFinds?: ShutdownRequest;
  /** Once the drain is over. */
  after?: {
    identity?: Identity;
    shutdown?: ShutdownRequest | null;
    /** Version 14 is during the drain (between 10 and 30); version 35 is after it. */
    startedSince?: RecordedStart | null;
    /** Asking the stream for a start since throws, as a dropped connection does. */
    startsUnread?: boolean;
  };
  /** A drain standing when the start is asked for, or one that lands while the supervisor starts it. */
  atStart?: { standing?: ShutdownRequest; landsDuring?: ShutdownRequest };
  /** What the daemon that starts runs, when not what was checked — or null, when it takes no work and records nothing. */
  runs?: Pick<Identity, "sha" | "dirty"> | null;
}

interface Outcome {
  code: number;
  said: string;
  /** A drain this command asked for was appended. */
  askedToStop: boolean;
  /** Something was withdrawn, and which version. */
  withdrew: number[];
  /** The timeout and force every drain this command asked for carried. */
  asks: { timeoutMs: number | null; force: boolean }[];
}

function worldOf(scene: Scene) {
  const w = {
    phase: "before" as "before" | "drained" | "started",
    lines: [] as string[],
    askedToStop: false,
    withdrew: [] as number[],
    asks: [] as { timeoutMs: number | null; force: boolean }[],
  };
  let holderAsks = 0;
  let drainedReads = 0;
  const identityNow = (): Identity => (w.phase === "before" ? scene.identity ?? pushed : scene.after?.identity ?? scene.identity ?? pushed);
  const shutdownNow = (): ShutdownRequest | null => {
    if (w.phase === "before") return scene.shutdown ?? null;
    if (w.phase === "started") return scene.atStart?.landsDuring ?? scene.atStart?.standing ?? scene.after?.shutdown ?? null;
    // The first read after the drain is the checks'; a later one is the start's.
    return drainedReads++ === 0 ? scene.after?.shutdown ?? null : scene.atStart?.standing ?? scene.after?.shutdown ?? null;
  };
  const facts: RestartFacts = {
    identity: async () => identityNow(),
    doctor: async () => ({
      results: Array.from({ length: scene.doctorFailed ?? 0 }, (_, i) => ({ name: `check ${i}`, status: "fail", detail: "red" })),
    }),
    holder: async () => {
      if (holderAsks++ === 0) return (scene.holder ?? (async () => "lingtai daemon pid 5123"))();
      w.phase = "drained";
      return null;
    },
    daemonUp: scene.daemonUp ?? (async () => true),
    control: async () => ({ shutdown: shutdownNow() }),
    inFlight: async () => [],
    ask: async (_by, _reason, timeoutMs, force) => {
      w.asks.push({ timeoutMs, force });
      if (scene.askFinds) return { asked: false, standing: scene.askFinds };
      w.askedToStop = true;
      return { asked: true, version: 11 };
    },
    withdraw: async (by, version) => {
      w.withdrew.push(version);
      return { withdrew: true, version: version + 1, request: { by, reason: "", timeoutMs: null, version, force: false } };
    },
    // 10 before the drain, 30 once it is over; the start the command makes is 41.
    watermark: async () => (w.phase === "before" ? 10 : 30),
    startAfter: async (version) => {
      if (w.phase === "before") return null;
      if (scene.after?.startsUnread) throw new Error("the connection dropped");
      const starts = [scene.after?.startedSince ?? null, w.phase === "started" && scene.runs !== null ? startOf(scene.runs ?? identityNow(), 41) : null];
      return starts.find((s) => s !== null && s.version > version) ?? null;
    },
    pollMs: 1,
  };
  const log = (line: string): void => void w.lines.push(line);
  const outcome = (code: number): Outcome => ({ code, said: w.lines.join("\n"), askedToStop: w.askedToStop, withdrew: w.withdrew, asks: w.asks });
  return { w, facts, log, outcome, shutdownNow };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-restart-"));
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`), "");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * `lingtai restart` with nothing supervising: `prepareRestart`, then `openDaemon`
 * — the function `daemonCommand` starts every daemon through — with the lock and
 * the code the scene's.
 */
async function terminal(scene: Scene, args: RestartArgs = ARGS): Promise<Outcome> {
  const { w, facts, log, outcome } = worldOf(scene);
  const prepared = await prepareRestart(args, log, facts);
  if (!prepared.ok) return outcome(prepared.code);
  w.phase = "started";
  let stopped = false;
  const opened = await openDaemon(
    { examined: prepared.examined },
    {
      start: async () =>
        scene.runs === null
          ? { ok: false, reason: "already-running", holder: "lingtai run pid 77" }
          : {
              ok: true,
              since: 30,
              daemon: { stopped: Promise.resolve("asked"), stop: () => void (stopped = true), failure: null },
            },
      code: async () => scene.runs ?? prepared.examined,
      control: facts.control,
      log,
    },
  );
  if (opened.ok) return outcome(0);
  // A refusal after the lock was taken stops the daemon before it takes anything.
  if (scene.runs !== null && !stopped) throw new Error("the terminal restart refused and left its daemon running");
  return outcome(opened.code);
}

/** `lingtai restart` under launchd: `restartSupervised` over the real `serviceCommand`. */
async function supervised(scene: Scene, args: RestartArgs = ARGS): Promise<Outcome> {
  const { w, facts, log, outcome, shutdownNow } = worldOf(scene);
  let loaded = true;
  const exec: Exec = (call) => {
    const line = call.join(" ");
    if (line.startsWith("launchctl print")) {
      return loaded ? { status: 0, out: "\tstate = running\n\tpid = 41\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" };
    }
    if (line.startsWith("launchctl bootout")) loaded = false;
    if (line.startsWith("launchctl bootstrap")) {
      loaded = true;
      w.phase = "started";
    }
    return { status: 0, out: "" };
  };
  const service = (argv: string[], asked: { timeoutMs: number | null; force: boolean }): Promise<number> =>
    serviceCommand(argv, {
      liveness: async () => "up",
      shutdown: async () => shutdownNow(),
      pause: async () => null,
      drain: {
        ask: (by, reason) => facts.ask(by, reason, asked.timeoutMs, asked.force),
        holding: async () => "nothing in flight",
        queue: async () => ({
          wait: async () => ((w.phase = "drained"), "held"),
          holds: async () => true,
          leave: async () => {},
        }),
        withdraw: facts.withdraw,
      },
      started: { watermark: facts.watermark, after: facts.startAfter },
      // The board's job answers at once here: `lingtai restart` is about the
      // conductor, and a board that would not come up is `service`'s to report.
      board: { url: "http://127.0.0.1:17820", answering: async () => "http://127.0.0.1:17820" },
      by: BY,
      platform: "darwin",
      env: { HOME: home, USER: "lingtai" },
      root: home,
      uid: process.getuid!(),
      username: "lingtai",
      exec,
      which: (bin) => (bin === "node" ? "/usr/bin/node" : `/usr/bin/${bin}`),
      sleep: async () => {},
      log,
      error: log,
    });
  return outcome(await restartSupervised(args, { service, facts, log }));
}

type Says = string | { terminal: string; supervised: string };

/** One scene per row, and what each path must say about it. */
const SCENES: Record<string, { scene: Scene; says: Says; notSays?: string; nothingStopped: boolean }> = {
  unpushed: {
    scene: { identity: { ...pushed, sha: "582a0f8".padEnd(40, "a"), pushed: false } },
    says: "582a0f8 is not reachable from origin/main",
    nothingStopped: true,
  },
  unestablished: {
    scene: { identity: { ...pushed, pushed: null, unknown: "unknown revision origin/main" } },
    says: "could not be established against origin/main",
    nothingStopped: true,
  },
  dirty: { scene: { identity: { ...pushed, dirty: true } }, says: "uncommitted changes", nothingStopped: true },
  doctor: { scene: { doctorFailed: 2 }, says: "lingtai doctor reports 2 failed check(s)", nothingStopped: true },
  "lock-unread": {
    scene: {
      holder: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    },
    says: "who is conducting could not be asked — connect ECONNREFUSED",
    nothingStopped: true,
  },
  "beacon-unread": {
    scene: {
      daemonUp: async () => {
        throw new Error("the pooler restarted");
      },
    },
    says: "whether a daemon is up could not be read — the pooler restarted",
    nothingStopped: true,
  },
  "foreign-drain": { scene: { shutdown: ops(7) }, says: "a shutdown asked by human:ops — moving the database — is already standing", nothingStopped: true },
  "drain-landed": {
    scene: { askFinds: ops(12) },
    says: { terminal: "a shutdown asked by human:ops — moving the database — landed while this was checking", supervised: "a shutdown asked by human:ops (moving the database) is already standing. Nothing was stopped" },
    nothingStopped: true,
  },
  "after-unpushed": {
    scene: { after: { identity: { ...pushed, pushed: false } } },
    says: "is not reachable from origin/main",
    nothingStopped: false,
  },
  "after-dirty": { scene: { after: { identity: { ...pushed, dirty: true } } }, says: "uncommitted changes", nothingStopped: false },
  moved: {
    scene: { after: { identity: { ...pushed, sha: "b88b88b".padEnd(40, "b") } } },
    says: "the checkout moved while this waited",
    nothingStopped: false,
  },
  "after-foreign-drain": {
    scene: { after: { shutdown: ops(15), startedSince: startOf(pushed, 35) } },
    says: "It may be aimed at the daemon that started since",
    notSays: "lingtai resume lifts it",
    nothingStopped: false,
  },
  "started-since": {
    scene: { after: { startedSince: startOf(pushed, 35) } },
    says: "a daemon started while this waited — daemon started 2926f2d as mac:4242",
    nothingStopped: false,
  },
  "started-unread": {
    scene: { after: { shutdown: ops(15), startsUnread: true } },
    says: "whether a daemon started while this waited could not be read — the connection dropped",
    notSays: "lingtai resume lifts it",
    nothingStopped: false,
  },
  "code-at-start": {
    scene: { runs: { sha: "c0ffee0".padEnd(40, "0"), dirty: false } },
    says: "2926f2d was checked and c0ffee0 is what the daemon runs",
    nothingStopped: false,
  },
  "drain-at-start": {
    scene: { atStart: { standing: ops(15) } },
    says: { terminal: "landed between the checks and the start", supervised: "a shutdown request stands — asked by human:ops (moving the database)" },
    nothingStopped: false,
  },
  "nothing-started": {
    scene: { runs: null },
    says: { terminal: "the lock was taken first", supervised: "no daemon recorded one" },
    nothingStopped: false,
  },
};

const PATHS = { terminal, supervised } as const;

describe("the table of refusals", () => {
  it("has both sides on every row, and a scene for each — a refusal on one path only is this test failing", () => {
    expect(RESTART_GUARDS.length).toBeGreaterThan(0);
    for (const row of RESTART_GUARDS) {
      expect(row.terminal.trim(), `${row.id}: terminal`).not.toBe("");
      expect(row.supervised.trim(), `${row.id}: supervised`).not.toBe("");
      expect(SCENES[row.id], `${row.id} has no scene`).toBeDefined();
    }
    expect(Object.keys(SCENES).sort()).toEqual(RESTART_GUARDS.map((r) => r.id).sort());
    expect(new Set(RESTART_GUARDS.map((r) => r.id)).size).toBe(RESTART_GUARDS.length);
    for (const only of SUPERVISED_ONLY) expect(only.why.trim()).not.toBe("");
  });

  for (const row of RESTART_GUARDS) {
    for (const [path, run] of Object.entries(PATHS) as [keyof typeof PATHS, typeof terminal][]) {
      it(`${row.id} — ${path}: ${row.refusal}`, async () => {
        const { scene, says, notSays, nothingStopped } = SCENES[row.id]!;
        const out = await run(scene);
        expect(out.code, out.said).not.toBe(0);
        expect(out.said).toContain(typeof says === "string" ? says : says[path]);
        if (notSays) expect(out.said).not.toContain(notSays);
        if (nothingStopped) expect(out.askedToStop, "a drain was asked before the refusal").toBe(false);
        else expect(out.askedToStop, "the scene never reached the drain").toBe(true);
      });
    }
  }

  it("starts on both paths when nothing refuses, and each says so", async () => {
    const t = await terminal({});
    expect(t.code, t.said).toBe(0);
    const s = await supervised({});
    expect(s.code, s.said).toBe(0);
    expect(s.said).toContain("restarted 2926f2d as mac:4242 — the commit that was checked");
    // The drain it asked for is withdrawn on both, by its version.
    expect(t.withdrew).toEqual([11]);
    expect(s.withdrew).toEqual([11]);
  });

  it("waives exactly what the flag names, on both paths", async () => {
    // Dirty before and after, so the loaded code is what the disk still is.
    const dirty: Scene = { identity: { ...pushed, dirty: true } };
    for (const run of [terminal, supervised]) {
      expect((await run(dirty)).code).toBe(1);
      const waved = await run(dirty, { ...ARGS, dirty: true });
      expect(waved.code, waved.said).toBe(0);
      expect(waved.said).toContain("--dirty: ");
      expect((await run({ ...dirty, doctorFailed: 1 }, { ...ARGS, dirty: true })).code).toBe(1);
    }
  });
});

/**
 * The five findings two reviewers made against two attempts at #159, as the
 * scenes that reproduce them. Each is either impossible by construction or a
 * refusal — and which is written in 0048.
 */
describe("#167's five findings, on the supervised path", () => {
  /** major 1 — deleted: there is no handoff to skip; the checks after the wait are the terminal path's. */
  it("a start that takes over a drain already standing still has its code checked after the wait", async () => {
    const mine = { ...ops(7), by: BY, reason: "restarting: ctrl-c'd yesterday" };
    const out = await supervised({ shutdown: mine, after: { identity: { ...pushed, pushed: false } } });
    expect(out.code).toBe(1);
    expect(out.withdrew[0]).toBe(7);
    expect(out.said).toContain("is not reachable from origin/main");
    expect(out.said).not.toContain("restarted ");
  });

  /** major 2 — guarded: a drain landing during the start is read against the record, and said. */
  it("a drain that lands while the supervisor starts the daemon is not stepped over in silence", async () => {
    const out = await supervised({ atStart: { landsDuring: ops(15) } });
    expect(out.code).toBe(1);
    expect(out.said).toContain("a daemon started, and it is not the start that was checked");
    expect(out.said).toContain("landed between the checks and the start");
  });

  /** major 3 — guarded, and the handoff state that caused it is gone: nothing recorded is exit 1. */
  it("a start that records nothing is not reported as a success", async () => {
    const out = await supervised({ runs: null });
    expect(out.code).toBe(1);
    expect(out.said).not.toContain("restarted ");
  });

  /** minor 4 — guarded: the remote is asked again after the wait. */
  it("a force-push during the drain is refused as the terminal path refuses it", async () => {
    const scene: Scene = { after: { identity: { ...pushed, pushed: false } } };
    const [t, s] = [await terminal(scene), await supervised(scene)];
    expect([t.code, s.code]).toEqual([1, 1]);
    expect(s.said).not.toContain("launchctl bootstrap");
  });

  /**
   * The second review's finding 4: `service shutdown`'s lock connection dropped,
   * a KeepAlive copy took the lock and recorded its start, and the drain asked
   * again and unloaded it. That copy is nobody's conductor now.
   */
  it("a copy started and drained inside service shutdown is not a daemon started since", async () => {
    const out = await supervised({ after: { startedSince: startOf(pushed, 14) } });
    expect(out.code, out.said).toBe(0);
    expect(out.said).not.toContain("a daemon started while this waited");
    expect(out.said).toContain("restarted 2926f2d as mac:4242");
  });

  /** The second review's finding 5: a drain taken over is asked again as it was asked, on both paths. */
  it("a request taken over keeps its own --force and --timeout, not this invocation's", async () => {
    const mine: ShutdownRequest = { by: BY, reason: "restarting: ctrl-c'd", timeoutMs: 5_000, version: 7, force: true };
    for (const run of [terminal, supervised]) {
      const out = await run({ shutdown: mine });
      expect(out.code, out.said).toBe(0);
      expect(out.asks).toEqual([{ timeoutMs: 5_000, force: true }]);
    }
  });

  /** minor 5 — guarded: a start recorded since is named, and resume is not advised over it. */
  it("a refusal after the wait never advises lifting a drain aimed at a daemon that started since", async () => {
    const out = await supervised({ after: { shutdown: ops(15), startedSince: startOf(pushed, 35) } });
    expect(out.code).toBe(1);
    expect(out.said).toContain("a daemon started while this waited");
    expect(out.said).not.toContain("lingtai resume lifts it");
  });
});
