/**
 * `lingtai service` — the supervisor around the daemon (#50).
 *
 * No database, and no real `launchctl` or `systemctl`: the supervisor is a
 * script of answers, and every call the command makes is recorded. What these
 * pin is what the command *says*, because the last attempt at this was refused
 * for saying more than it knew — "it is taking work" on the strength of a job
 * launchd had loaded and was failing to spawn.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LockPlace, RecordedStart } from "@lingtai/daemon";
import { controlWatermark, readControl, requestShutdown, requestShutdownUnlessStanding, withdrawShutdown } from "@lingtai/daemon/control";
import { repoRoot } from "@lingtai/env";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHCTL_NO_SUCH_SERVICE,
  LAUNCHD_LABEL,
  NO_SUPERVISOR,
  SYSTEMD_UNIT,
  keeper,
  launchdPlist,
  lingering,
  platformFor,
  serviceCommand,
  systemdUnit,
  type Exec,
  type ServiceDrain,
} from "../src/service.ts";
import { queueForTheLock } from "../src/restart.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-service-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const ROOT = "/srv/lingtai";
const NODE = "/usr/bin/node";

/** A supervisor that answers by the first matching prefix, and remembers what it was asked. */
function supervisor(answers: [string, { status: number; out: string } | (() => { status: number; out: string })][]) {
  const calls: string[] = [];
  const exec: Exec = (call) => {
    const line = call.join(" ");
    calls.push(line);
    const hit = answers.find(([prefix]) => line.startsWith(prefix));
    if (!hit) return { status: 0, out: "" };
    return typeof hit[1] === "function" ? hit[1]() : hit[1];
  };
  return { calls, exec };
}

/**
 * A drain with nothing in flight: the place in the queue is the lock at once,
 * and the request is appended. `said` is what it was asked, in order.
 */
function quietDrain() {
  const said: string[] = [];
  let version = 0;
  const drain: ServiceDrain = {
    ask: async (by, reason) => (said.push(`ask ${by} ${reason}`), { asked: true, version: ++version }),
    holding: async () => "nothing in flight",
    queue: async () => (said.push("queue"), { wait: async () => (said.push("held"), "held"), holds: async () => true, leave: async () => {} }),
    withdraw: async (by, v) => (
      said.push(`withdraw ${v}`),
      { withdrew: true, version: v + 1, request: { by, reason: "", timeoutMs: null, force: false, version: v } as never }
    ),
  };
  return { drain, said };
}

/** What a daemon the supervisor started appends before its first pass, when it takes work (#167). */
const RECORDED: RecordedStart = {
  by: "daemon",
  reason: null,
  sha: "2926f2d0f0e2a0b1c2d3e4f5a6b7c8d9e0f1a2b3",
  dirty: false,
  worker: "mac:4242",
  version: 9,
  at: new Date("2026-09-16T10:00:00Z"),
};

/** A start confirmed at once — every test but those about a start nothing recorded. */
const recordedAtOnce = { watermark: async () => 8, after: async () => RECORDED };

/** Whoever runs the suite, so the checkout `install` stats is theirs. */
const UID = process.getuid!();

function command(
  platform: NodeJS.Platform,
  exec: Exec,
  extra: {
    env?: NodeJS.ProcessEnv;
    liveness?: () => Promise<string>;
    shutdown?: () => Promise<{ by: string; reason: string } | null>;
    pause?: () => Promise<{ by: string | null; reason: string | null; until?: Date | null } | null>;
    /** `"default"` leaves `root` unset, so the command resolves it as it would for real. */
    root?: string | "default";
    uid?: number;
    drain?: ServiceDrain;
    started?: { watermark: () => Promise<number>; after: (version: number) => Promise<RecordedStart | null> };
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const go = (verb: string, ...why: string[]) =>
    serviceCommand([verb, ...why], {
      liveness: extra.liveness ?? (async () => "last seen 3000s ago (pid 41) — not running"),
      shutdown: extra.shutdown ?? (async () => null),
      pause: extra.pause ?? (async () => null),
      drain: extra.drain ?? quietDrain().drain,
      started: extra.started ?? recordedAtOnce,
      by: "human:lingtai",
      platform,
      env: extra.env ?? { HOME: home, USER: "lingtai" },
      ...(extra.root === "default" ? {} : { root: extra.root ?? home }),
      uid: extra.uid ?? UID,
      username: "lingtai",
      exec,
      which: (bin) => (bin === "node" ? NODE : `/usr/bin/${bin}`),
      sleep: async () => {},
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
  return { go, out, err };
}

const LOADED_BUT_NOT_RUNNING = `gui/501/${LAUNCHD_LABEL} = {
	state = spawn scheduled
	runs = 214
	last exit code = 78: EX_CONFIG
}`;

describe("the files", () => {
  const inputs = (env: NodeJS.ProcessEnv) => ({ node: NODE, root: ROOT, env });

  it("writes the LaunchAgent scripts/launchd.sh wrote, KeepAlive and all", () => {
    const f = launchdPlist(inputs({ HOME: "/Users/x", USER: "x" }));
    expect(f.path).toBe(`/Users/x/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(f.content).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(f.content).toContain("<integer>30</integer>");
    expect(f.content).toContain(`<string>${ROOT}/apps/cli/src/lingtai.ts</string>`);
    // The keychain looks the login up by account name.
    expect(f.content).toContain("<key>USER</key>\n    <string>x</string>");
  });

  it("writes a systemd user unit whose Restart=always is launchd's KeepAlive", () => {
    const f = systemdUnit(inputs({ HOME: "/home/x", USER: "x" }));
    expect(f.path).toBe("/home/x/.config/systemd/user/lingtai.service");
    expect(f.content).toMatch(/^Restart=always$/m);
    expect(f.content).toMatch(/^RestartSec=30$/m);
    expect(f.content).toMatch(/^StartLimitIntervalSec=0$/m);
    expect(f.content).toMatch(/^KillMode=process$/m);
    expect(f.content).toMatch(/^WantedBy=default\.target$/m);
    expect(f.content).toMatch(new RegExp(`^ExecStart=${NODE} ${ROOT}/apps/cli/src/lingtai.ts daemon$`, "m"));
    expect(f.content).toMatch(new RegExp(`^WorkingDirectory=${ROOT}$`, "m"));
  });

  it("refuses a path systemd would split, unquote or expand, rather than writing one it ignores", () => {
    expect(() => systemdUnit({ node: NODE, root: "/home/x/my checkout", env: { HOME: "/home/x", USER: "x" } })).toThrow(
      /the checkout \("\/home\/x\/my checkout"\)/,
    );
    expect(() => systemdUnit({ node: NODE, root: ROOT, env: { HOME: "/home/100%", USER: "x" } })).toThrow(/HOME/);
  });

  it("is a dedicated user's, every path, when installed as them", () => {
    // What makes an unprivileged account work: nothing in the unit is read from
    // anywhere but the installing user's own environment.
    const env = { HOME: "/var/lib/lingtai", USER: "lingtai", LINGTAI_HOME: "/var/lib/lingtai/state" };
    const f = systemdUnit(inputs(env));
    expect(f.path).toBe("/var/lib/lingtai/.config/systemd/user/lingtai.service");
    expect(f.content).toMatch(/^Environment=HOME=\/var\/lib\/lingtai$/m);
    expect(f.content).toMatch(/^Environment=USER=lingtai$/m);
    expect(f.content).toMatch(/^Environment=LINGTAI_HOME=\/var\/lib\/lingtai\/state$/m);
    expect(f.content).toMatch(/^StandardOutput=append:\/var\/lib\/lingtai\/state\/logs\/daemon\.log$/m);
    expect(f.content).not.toMatch(/\/Users\/|\/root\b/);
  });
});

describe("no service manager", () => {
  it("says to run the daemon in the foreground, on a platform with none", async () => {
    const { go, err } = command("win32", supervisor([]).exec);
    expect(await go("install")).toBe(1);
    expect(err).toEqual([NO_SUPERVISOR]);
  });

  it("says the same on a Linux without systemctl, which is a container", async () => {
    const s = supervisor([]);
    const out: string[] = [];
    const err: string[] = [];
    const code = await serviceCommand(["status"], {
      liveness: async () => "",
      shutdown: async () => null,
      drain: quietDrain().drain,
      started: recordedAtOnce,
      platform: "linux",
      env: { HOME: home },
      which: (bin) => (bin === "node" ? NODE : null),
      exec: s.exec,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err).toEqual([NO_SUPERVISOR]);
    expect(s.calls).toEqual([]);
  });
});

describe("install on macOS", () => {
  it("loads a job that was not loaded, then reports both answers rather than concluding one", async () => {
    let loaded = false;
    const s = supervisor([
      ["launchctl print", () => (loaded ? { status: 0, out: "\tstate = running\n\tpid = 77\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "Could not find service" })],
      ["launchctl bootstrap", () => ((loaded = true), { status: 0, out: "" })],
    ]);
    const { go, out } = command("darwin", s.exec);
    expect(await go("install")).toBe(0);
    expect(s.calls).toContain(`launchctl bootstrap gui/${UID} ${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(await readFile(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`), "utf8")).toContain(LAUNCHD_LABEL);
    expect((await stat(join(home, ".lingtai/logs"))).isDirectory()).toBe(true);
    expect(out).toContain("  state = running");
    expect(out).toContain("  last seen 3000s ago (pid 41) — not running");
    expect(out.join("\n")).not.toMatch(/taking work|already running/);
  });

  it("over a loaded job launchd cannot spawn, says it is loaded and what launchd says, and never that it is running", async () => {
    // The scenario that refused attempt 1: the node the plist named is gone,
    // launchd still has the job, and `launchctl print` exits 0.
    const s = supervisor([["launchctl print", { status: 0, out: LOADED_BUT_NOT_RUNNING }]]);
    const { go, out } = command("darwin", s.exec);
    expect(await go("install")).toBe(0);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap") || c.startsWith("launchctl bootout"))).toBe(false);
    const text = out.join("\n");
    expect(text).toContain(`launchd already had ${LAUNCHD_LABEL} loaded`);
    expect(text).toContain("pnpm lingtai service restart");
    expect(out).toContain("  state = spawn scheduled");
    expect(out).toContain("  last exit code = 78: EX_CONFIG");
    expect(out).toContain("  last seen 3000s ago (pid 41) — not running");
    expect(text).not.toMatch(/taking work|already running|is running|left it running/);
  });

  it("refuses to guess when launchd does not answer, which is not the same as a job that is not there", async () => {
    const s = supervisor([["launchctl print", { status: 112, out: "Could not find domain for port identifier" }]]);
    const { go, err } = command("darwin", s.exec);
    expect(await go("install")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
    expect(err.join("\n")).toContain("launchctl print exited 112");
  });
});

describe("restart on macOS", () => {
  it("drains, unloads, waits until launchd says it is gone, and loads the file again — not kickstart -k", async () => {
    let prints = 0;
    const s = supervisor([
      // loaded, still loaded after bootout, then gone
      ["launchctl print", () => (++prints <= 2 ? { status: 0, out: "\tstate = running\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
    ]);
    const d = quietDrain();
    const { go } = command("darwin", s.exec, { drain: d.drain });
    await launchdFile();
    expect(await go("restart", "picking", "up", "#88")).toBe(0);
    const verbs = s.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(verbs).toEqual(["launchctl print", "launchctl bootout", "launchctl print", "launchctl print", "launchctl print", "launchctl bootstrap"]);
    expect(s.calls.join("\n")).not.toContain("kickstart");
    expect(d.said).toEqual(["queue", "ask human:lingtai service restart: picking up #88", "held", "withdraw 1"]);
  });

  it("on Linux, is shutdown then start — never systemctl restart, which is the signal", async () => {
    const s = supervisor([["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=active\n" }]]);
    const { go } = command("linux", s.exec);
    await systemdFile();
    expect(await go("restart")).toBe(0);
    expect(s.calls.filter((c) => !c.startsWith("systemctl --user show"))).toEqual([
      `systemctl --user stop ${SYSTEMD_UNIT}`,
      `systemctl --user start ${SYSTEMD_UNIT}`,
    ]);
  });

  it("starts nothing while a shutdown request stands, which the daemon it started would take work over", async () => {
    // `lingtai shutdown "pick up #NN"`, then `service restart`: the request is
    // still on the control stream, and a daemon started after it never reads it (#159).
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const { go, out, err } = command("darwin", s.exec, {
      shutdown: async () => ({ by: "steven", reason: "pick up #NN" }),
    });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(s.calls).toEqual([]);
    const said = err.join("\n");
    expect(said).toContain("a shutdown request stands — asked by steven (pick up #NN)");
    expect(said).toContain("pnpm lingtai resume");
    expect(said).toContain("a daemon started now would not read it");
    expect(said).not.toContain("exits again");
    expect(out.join("\n")).not.toContain("shutdown \"why\"` first");
  });

  it("restarts when whether a shutdown stands could not be read, and says what that would mean", async () => {
    let prints = 0;
    const s = supervisor([
      ["launchctl print", () => (++prints <= 1 ? { status: 0, out: "\tstate = running\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
    ]);
    const { go, out } = command("darwin", s.exec, {
      shutdown: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await launchdFile();
    expect(await go("restart")).toBe(0);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
    expect(out.join("\n")).toContain("could not read whether a shutdown request stands — connect ECONNREFUSED");
  });

  it("refuses a standing request under its own name too — lingtai restart and lingtai shutdown ask as human:$USER as well", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const d = quietDrain();
    const { go, err } = command("darwin", s.exec, { drain: d.drain, shutdown: async () => ({ by: "human:lingtai", reason: "restarting: deploy" }) });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(s.calls).toEqual([]);
    expect(d.said).toEqual([]);
    expect(err.join("\n")).toContain("a shutdown request stands — asked by human:lingtai (restarting: deploy)");
  });
});

/**
 * #174. `service stop` sent the supervisor's signal, the daemon began a drain,
 * and launchd SIGKILLed it twenty seconds in. What has to be true is not that a
 * request was appended — the old verb's daemon drained too — but that the pass
 * in flight *finished* before the supervisor was told anything.
 */
describe("shutdown", () => {
  /**
   * A daemon mid-pass, on a real control stream, under a launchd that behaves
   * as launchd does: KeepAlive starts a copy the moment a daemon exits, and
   * `bootout` SIGKILLs whatever is still running. Every daemon reads the stream
   * from its own watermark, as the work loop does since #159, so a copy started
   * after the request never sees it — and one that wins the lock claims work.
   *
   * The lock is the conductor's: one holder, and a place queued for it handed
   * it on release before any try can take it — what `pg_advisory_lock` gave,
   * and what the file lock's queue gives since #193 (`pure/lock.test.ts` in
   * `@lingtai/daemon` races it). The command's wait is the real
   * `queueForTheLock` over the real `waitForTheLock`; each poll is one step of
   * the world.
   */
  function world(
    passPolls: number,
    during?: (poll: number, store: ReturnType<typeof createMemoryEventStore>) => Promise<void>,
    /** The command's connection drops once, the moment after the lock is granted to it — and the world moves on while it goes. */
    dropOnce = false,
  ) {
    const store = createMemoryEventStore();
    const lock = { holder: null as string | null, queue: [] as string[] };
    const release = (who: string): void => {
      if (lock.holder === who) lock.holder = lock.queue.shift() ?? null;
      else lock.queue = lock.queue.filter((q) => q !== who);
    };
    type Daemon = { name: string; since: number; running: boolean; pass: "none" | "in flight" | "finished" | "killed"; polls: number };
    const first: Daemon = { name: "daemon 1", since: 0, running: true, pass: passPolls > 0 ? "in flight" : "none", polls: 0 };
    lock.holder = first.name;
    const daemons: Daemon[] = [first];
    const order: string[] = [];
    let loaded = true;
    let polls = 0;

    const tick = async (): Promise<void> => {
      await during?.(++polls, store);
      for (const d of daemons.filter((x) => x.running)) {
        if ((await readControl(store, d.since)).shutdown === null) continue;
        if (d.pass === "in flight" && ++d.polls >= passPolls) {
          d.pass = "finished";
          order.push(`${d.name}'s pass finished`);
        }
        if (d.pass !== "in flight") {
          d.running = false;
          release(d.name);
          order.push(`${d.name} exited`);
        }
      }
      // KeepAlive, with the job past its ThrottleInterval: started again at once.
      // The watermark before the lock, as `startDaemon` reads them — which is
      // what makes a request appended after any daemon holds the lock one that
      // daemon obeys. That order is `packages/daemon/pure/start.test.ts`'s to
      // pin; here it is only modelled.
      if (loaded && !daemons.some((x) => x.running)) {
        const d: Daemon = { name: `daemon ${daemons.length + 1}`, since: await controlWatermark(store), running: true, pass: "none", polls: 0 };
        daemons.push(d);
        if (lock.holder === null) {
          lock.holder = d.name;
          d.pass = "in flight";
          order.push(`${d.name} claimed work`);
        } else {
          // Losing is not an error: it exits 0, and KeepAlive tries again.
          d.running = false;
        }
      }
    };

    const s = supervisor([
      ["launchctl print", () => (loaded ? { status: 0, out: "\tstate = running\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
      [
        "launchctl bootout",
        () => {
          order.push("bootout");
          for (const d of daemons.filter((x) => x.running)) {
            // launchd's ExitTimeOut, compressed: the signal, then SIGKILL.
            if (d.pass === "in flight") d.pass = "killed";
            d.running = false;
            release(d.name);
          }
          loaded = false;
          return { status: 0, out: "" };
        },
      ],
    ]);
    const place = async (): Promise<LockPlace> => {
      if (lock.holder === null) lock.holder = "command";
      else lock.queue.push("command");
      let lost: Error | null = null;
      return {
        held: () => lock.holder === "command",
        lost: () => lost,
        confirm: async () => {
          if (dropOnce && lost === null && lock.holder === "command") {
            // `confirm`'s ten seconds run out, and Postgres lets the lock go with the session.
            dropOnce = false;
            lost = new Error("the connection holding the lock did not answer in 10s");
            release("command");
            await tick();
          }
          return lost === null && lock.holder === "command";
        },
        leave: async () => {
          if (lost === null) release("command");
        },
      };
    };
    const drain: ServiceDrain = {
      ask: (by, reason) => requestShutdownUnlessStanding(by, reason, null, store),
      holding: async () => (first.pass === "in flight" ? "1 in flight: lingtai#174" : "nothing in flight"),
      queue: () =>
        queueForTheLock({
          place,
          holder: async () => (await tick(), lock.holder),
          pollMs: 0,
        }),
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason, store),
    };
    return { store, daemons, order, lock, s, drain, stop: () => (loaded = false) };
  }

  it("lets the pass in flight finish before launchd is told anything, and the copy KeepAlive starts takes no work", async () => {
    const w = world(5);
    const { go, out } = command("darwin", w.s.exec, { drain: w.drain });
    await launchdFile();
    expect(await go("shutdown", "picking", "up", "#88")).toBe(0);

    expect(w.daemons[0]!.pass).toBe("finished");
    // The race was run: launchd started a copy between the exit and the unload.
    expect(w.daemons.length).toBeGreaterThan(1);
    expect(w.daemons.filter((d) => d.pass === "in flight" || d.pass === "killed")).toEqual([]);
    expect(w.order).toEqual(["daemon 1's pass finished", "daemon 1 exited", "bootout"]);
    // Released after the unload, and the request withdrawn, so `service start` is not refused over it.
    expect(w.lock.holder).toBeNull();
    expect((await readControl(w.store)).shutdown).toBeNull();
    const text = out.join("\n");
    expect(text).toContain("draining — 1 in flight: lingtai#174");
    expect(text).toContain("It is waiting, not hung");
  });

  it("on Linux, the same order: drained, then systemctl stop", async () => {
    const w = world(3);
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=active\n" }],
      [
        "systemctl --user stop",
        () => {
          for (const d of w.daemons.filter((x) => x.running)) {
            if (d.pass === "in flight") d.pass = "killed";
            d.running = false;
          }
          w.stop();
          return { status: 0, out: "" };
        },
      ],
    ]);
    const { go } = command("linux", s.exec, { drain: w.drain });
    await systemdFile();
    expect(await go("shutdown")).toBe(0);
    expect(w.daemons[0]!.pass).toBe("finished");
    expect(w.daemons.filter((d) => d.pass === "in flight" || d.pass === "killed")).toEqual([]);
    expect(s.calls).toContain(`systemctl --user stop ${SYSTEMD_UNIT}`);
  });

  it("is fast on a quiet daemon, and the copy started seconds later takes no work either", async () => {
    const w = world(0);
    const { go } = command("darwin", w.s.exec, { drain: w.drain });
    await launchdFile();
    const began = Date.now();
    expect(await go("shutdown")).toBe(0);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(w.daemons.length).toBeGreaterThan(1);
    expect(w.order).toEqual(["daemon 1 exited", "bootout"]);
  });

  it("tells the supervisor nothing when the wait is interrupted, withdraws its request, and says a new daemon takes work", async () => {
    const w = world(5);
    const { go, out } = command("darwin", w.s.exec, {
      drain: { ...w.drain, queue: async () => ({ wait: async () => "interrupted", holds: async () => false, leave: async () => {} }) },
    });
    await launchdFile();
    expect(await go("shutdown")).toBe(130);
    expect(w.s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(false);
    expect((await readControl(w.store)).shutdown).toBeNull();
    const text = out.join("\n");
    expect(text).toContain("the supervisor then starts one that takes work");
    expect(text).toContain("pnpm lingtai service shutdown asks again");
    expect(text).not.toContain("exits too");
  });

  it("tells the supervisor nothing while the lock it waited for has gone with its connection, and waits again", async () => {
    const w = world(0);
    const said: string[] = [];
    let waits = 0;
    const holds = [false, true];
    const { go, out } = command("darwin", w.s.exec, {
      drain: {
        ...w.drain,
        queue: async () => ({
          wait: async () => (said.push(`wait ${++waits}`), "held"),
          holds: async () => {
            const h = holds.shift()!;
            said.push(`holds ${h} ${w.s.calls.some((c) => c.startsWith("launchctl bootout")) ? "after" : "before"} bootout`);
            return h;
          },
          leave: async () => {},
        }),
      },
    });
    await launchdFile();
    expect(await go("shutdown")).toBe(0);
    expect(said).toEqual(["wait 1", "holds false before bootout", "wait 2", "holds true before bootout"]);
    expect(out.join("\n")).toContain("the conductor lock was lost with its connection before the supervisor was told anything");
  });

  it("asks again when the lock goes with its connection and a copy takes it, so the copy finishes its pass and the wait ends", async () => {
    const w = world(3, undefined, true);
    const { go, out } = command("darwin", w.s.exec, { drain: w.drain });
    await launchdFile();
    expect(await go("shutdown")).toBe(0);
    expect(w.order).toEqual([
      "daemon 1's pass finished",
      "daemon 1 exited",
      "daemon 3 claimed work",
      "daemon 3's pass finished",
      "daemon 3 exited",
      "bootout",
    ]);
    expect(w.daemons.filter((d) => d.pass === "in flight" || d.pass === "killed")).toEqual([]);
    expect(w.lock.holder).toBeNull();
    expect((await readControl(w.store)).shutdown).toBeNull();
    expect(out.join("\n")).toContain("could not ask who holds the lock — the place in the queue for the lock was lost");
  });

  it("uninstall drains before it unloads, so the pass in flight is not killed", async () => {
    const w = world(5);
    const { go } = command("darwin", w.s.exec, { drain: w.drain });
    await launchdFile();
    expect(await go("uninstall")).toBe(0);
    expect(w.daemons[0]!.pass).toBe("finished");
    expect(w.daemons.filter((d) => d.pass === "in flight" || d.pass === "killed")).toEqual([]);
    expect(w.order).toEqual(["daemon 1's pass finished", "daemon 1 exited", "bootout"]);
    expect(existsSync(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`))).toBe(false);
  });

  it("uninstall on Linux stops through the drain, then disables", async () => {
    const s = supervisor([["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=active\n" }]]);
    const d = quietDrain();
    const { go } = command("linux", s.exec, { drain: d.drain });
    await systemdFile();
    expect(await go("uninstall")).toBe(0);
    expect(d.said).toEqual(["queue", "ask human:lingtai service uninstall: no reason given", "held", "withdraw 1"]);
    expect(s.calls.filter((c) => !c.startsWith("systemctl --user show"))).toEqual([
      `systemctl --user stop ${SYSTEMD_UNIT}`,
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
    ]);
  });

  it("refuses a request already standing — anybody's, its own name included — and stops nothing", async () => {
    for (const by of ["human:ops", "human:lingtai"]) {
      const w = world(2);
      await requestShutdownUnlessStanding(by, "migrating the database", null, w.store);
      const { go, err } = command("darwin", w.s.exec, { drain: w.drain });
      await launchdFile();
      expect(await go("shutdown")).toBe(1);
      expect(w.s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(false);
      expect((await readControl(w.store)).shutdown?.by).toBe(by);
      expect(w.lock.holder).toBe("daemon 1");
      expect(w.lock.queue).toEqual([]);
      expect(err.join("\n")).toContain(`a shutdown asked by ${by} (migrating the database) is already standing. Nothing was stopped`);
    }
  });

  it("does not say nothing was stopped when a request landing during restart's wait refuses the start after the unload", async () => {
    const w = world(3, async (poll, store) => {
      // Another person's `lingtai shutdown`, which appends whatever stands.
      if (poll === 2) await requestShutdown("human:ops", "maintenance", null, store);
    });
    const { go, err } = command("darwin", w.s.exec, { drain: w.drain, shutdown: async () => (await readControl(w.store)).shutdown });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(w.s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(true);
    expect(w.s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
    const said = err.join("\n");
    expect(said).toContain("The drain above unloaded the service, and nothing was started");
    expect(said).not.toContain("Nothing was started or stopped");
    expect(said).not.toContain("exits again");
  });

  it("withdraws its own request and lets the lock go when the supervisor does not unload, so nothing is refused over it after", async () => {
    const w = world(2);
    const s = supervisor([
      ["launchctl print", { status: 0, out: "\tstate = running\n" }],
      ["launchctl bootout", { status: 5, out: "Boot-out failed: 5: Input/output error" }],
    ]);
    const { go, err } = command("darwin", s.exec, { drain: w.drain });
    await launchdFile();
    expect(await go("shutdown", "x")).toBe(1);
    expect(w.lock.holder).not.toBe("command");
    expect(w.lock.queue).toEqual([]);
    expect((await readControl(w.store)).shutdown).toBeNull();
    const said = err.join("\n");
    expect(said).toContain("the supervisor did not stop the service");
    expect(said).toContain("The request is withdrawn");
    // And the next `service shutdown` asks its own rather than refusing over this one.
    const again = command("darwin", s.exec, { drain: w.drain });
    expect(await again.go("shutdown", "again")).toBe(1);
    expect(again.err.join("\n")).toContain("the supervisor did not stop the service");
    expect(again.err.join("\n")).not.toContain("is already standing");
  });

  it("sends no signal when the request could not be appended", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const drain = { ...quietDrain().drain, ask: async () => Promise.reject(new Error("connect ECONNREFUSED")) };
    const { go, err } = command("darwin", s.exec, { drain });
    await launchdFile();
    expect(await go("shutdown")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(false);
    expect(err.join("\n")).toContain("connect ECONNREFUSED");
  });

  it("stops a job crash-looping on a database it cannot reach, between two of its starts, without the drain", async () => {
    // The project is paused: every copy KeepAlive starts fails to connect, and
    // so does the place in the lock's queue. Nothing can hold the lock.
    let booted = false;
    let prints = 0;
    const s = supervisor([
      ["launchctl print", () => (booted ? { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" } : { status: 0, out: ++prints % 3 === 2 ? "\tstate = running\n\tpid = 812\n" : LOADED_BUT_NOT_RUNNING })],
      ["launchctl bootout", () => ((booted = true), { status: 0, out: "" })],
    ]);
    for (const verb of ["shutdown", "uninstall"]) {
      booted = false;
      prints = 0;
      const drain = { ...quietDrain().drain, queue: async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:5432")) };
      const { go, out } = command("darwin", s.exec, { drain });
      await launchdFile();
      expect(await go(verb, "db is down")).toBe(0);
      expect(booted).toBe(true);
      expect(out.join("\n")).toContain("the supervisor has no daemon running");
    }
    expect(existsSync(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`))).toBe(false);
  });

  it("does the same under systemd while the unit waits to restart", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\n" }],
    ]);
    const drain = { ...quietDrain().drain, queue: async () => Promise.reject(new Error("password authentication failed")) };
    const { go } = command("linux", s.exec, { drain });
    await systemdFile();
    expect(await go("shutdown")).toBe(0);
    expect(s.calls).toContain(`systemctl --user stop ${SYSTEMD_UNIT}`);
  });

  it("stops nothing when the lock cannot be queued for and a daemon stays running, and names the supervisor's own stop", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n\tpid = 41\n" }]]);
    const drain = { ...quietDrain().drain, queue: async () => Promise.reject(new Error("connect ETIMEDOUT")) };
    const { go, err } = command("darwin", s.exec, { drain });
    await launchdFile();
    expect(await go("shutdown")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(false);
    expect(err.join("\n")).toContain("Nothing was stopped");
    expect(err.join("\n")).toContain(`launchctl bootout gui/${UID}/${LAUNCHD_LABEL}`);
  });

  it("says what is in flight could not be read, never that nothing is", async () => {
    let booted = false;
    const s = supervisor([
      ["launchctl print", () => (booted ? { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" } : { status: 0, out: "\tstate = running\n" })],
      ["launchctl bootout", () => ((booted = true), { status: 0, out: "" })],
    ]);
    const drain = { ...quietDrain().drain, holding: async () => Promise.reject(new Error("statement timeout")) };
    const { go, out } = command("darwin", s.exec, { drain });
    await launchdFile();
    expect(await go("shutdown")).toBe(0);
    expect(out.join("\n")).toContain("draining — what is in flight could not be read");
    expect(out.join("\n")).not.toContain("nothing in flight");
  });

  it("asks for no drain when the supervisor is not running the job", async () => {
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const d = quietDrain();
    const { go } = command("darwin", s.exec, { drain: d.drain });
    await launchdFile();
    expect(await go("shutdown")).toBe(0);
    expect(d.said).toEqual([]);
    expect(s.calls.some((c) => c.startsWith("launchctl bootout"))).toBe(false);
  });

  it("answers `stop` by name with the verb that replaced it, and signals nothing", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const { go, err } = command("darwin", s.exec);
    await launchdFile();
    expect(await go("stop")).toBe(2);
    expect(s.calls).toEqual([]);
    expect(err.join("\n")).toContain("pnpm lingtai service shutdown");
  });

  it("leaves ExitTimeOut and TimeoutStopSec at the supervisors' defaults, and says why", () => {
    // Set to the wall limit, a logout or a machine shutdown would block for an hour.
    const plist = launchdPlist({ node: NODE, root: ROOT, env: { HOME: "/Users/x", USER: "x" } }).content;
    expect(plist).not.toContain("<key>ExitTimeOut</key>");
    expect(plist).toContain("No ExitTimeOut, deliberately");
    const unit = systemdUnit({ node: NODE, root: ROOT, env: { HOME: "/home/x", USER: "x" } }).content;
    expect(unit).not.toMatch(/^TimeoutStopSec=/m);
    expect(unit).toContain("No TimeoutStopSec, deliberately");
  });
});

describe("while a shutdown request stands", () => {
  const STANDS = async () => ({ by: "steven", reason: "pick up #NN" });

  it("install on macOS writes the file and loads nothing, after `service uninstall` unloaded the job", async () => {
    // `shutdown "pick up #NN"`, then the old habit: uninstall && install.
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "Could not find service" }]]);
    const { go, err } = command("darwin", s.exec, { shutdown: STANDS });
    expect(await go("install")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
    expect(existsSync(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`))).toBe(true);
    const said = err.join("\n");
    expect(said).toContain("a shutdown request stands — asked by steven (pick up #NN)");
    expect(said).toContain("pnpm lingtai resume,\nthen pnpm lingtai service start");
  });

  it("install on Linux enables the unit and starts nothing", async () => {
    const s = supervisor([["systemctl --user show", { status: 0, out: "LoadState=not-found\nActiveState=inactive\n" }]]);
    const { go, err } = command("linux", s.exec, { shutdown: STANDS });
    expect(await go("install")).toBe(1);
    expect(s.calls).not.toContain("systemctl --user start lingtai.service");
    expect(err.join("\n")).toContain("nothing was started");
  });

  it("install over a job already loaded is not refused, since it starts nothing", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    let asked = false;
    const { go } = command("darwin", s.exec, { shutdown: async () => ((asked = true), { by: "steven", reason: "x" }) });
    expect(await go("install")).toBe(0);
    expect(asked).toBe(false);
  });

  it("names a pause in force, which resume would lift, and gives the order that keeps it", async () => {
    // `pause "the importer is flaky today"`, later `shutdown`, then the recipe's
    // `resume` would clear both — and the next start would take the held queue.
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const { go, err } = command("darwin", s.exec, {
      shutdown: STANDS,
      pause: async () => ({ by: "steven", reason: "the importer is flaky today" }),
    });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(s.calls).toEqual([]);
    const said = err.join("\n");
    expect(said).toContain("A pause is in force too — steven (the importer is flaky today) — and pnpm lingtai resume lifts it");
    expect(said).toContain(
      'pnpm lingtai service shutdown, pnpm lingtai resume, pnpm lingtai pause "the importer is flaky today", pnpm lingtai service start.',
    );
    expect(said).not.toContain("the supervisor's next start takes work");
  });

  it("never advises pausing again over a pause that lifts itself, which would then never lift", async () => {
    // A run never started on an account limit and the conductor paused until
    // 23:00; then `shutdown "pick up #NN"` and `service restart`. `lingtai
    // pause` carries no time, so the advice cannot be to set it again.
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n" }]]);
    const until = new Date("2026-09-13T23:00:00.000Z");
    const { go, err } = command("darwin", s.exec, {
      shutdown: STANDS,
      pause: async () => ({ by: "conductor", reason: "account limit", until }),
    });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(s.calls).toEqual([]);
    const said = err.join("\n");
    expect(said).toContain(`A pause is in force too — conductor (account limit) — until ${until.toISOString()}, when it lifts by itself`);
    expect(said).toContain(`After ${until.toISOString()}, once the daemon the shutdown was aimed at has exited`);
    expect(said).not.toContain("pnpm lingtai pause");
    expect(said).not.toContain("pnpm lingtai service shutdown");
    expect(said).not.toContain("the supervisor's next start takes work");
    expect(said).toContain("then this command again");
  });

  it("does not promise the supervisor a start after a pause that lifts itself, when service shutdown has unloaded the job", async () => {
    // `service shutdown`, the conductor's own pause still in force, then
    // `lingtai shutdown "x"`: `resume` alone starts nothing under an unloaded job.
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const until = new Date("2026-09-13T23:00:00.000Z");
    const { go, err } = command("darwin", s.exec, {
      shutdown: async () => ({ by: "human:ops", reason: "x" }),
      pause: async () => ({ by: "conductor", reason: "account limit", until }),
    });
    await launchdFile();
    expect(await go("start")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(false);
    const said = err.join("\n");
    expect(said).not.toContain("the supervisor's next start takes work");
    expect(said).toContain(`After ${until.toISOString()}, once the daemon the shutdown was aimed at has exited (pnpm lingtai service status), pnpm lingtai resume, then this command again.`);
  });
});

describe("start on Linux", () => {
  it("starts nothing while a shutdown request stands", async () => {
    const s = supervisor([]);
    const { go, err } = command("linux", s.exec, { shutdown: async () => ({ by: "steven", reason: "pick up #NN" }) });
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(join(home, ".config/systemd/user/lingtai.service"), "");
    expect(await go("start")).toBe(1);
    expect(s.calls).toEqual([]);
    expect(err.join("\n")).toContain("pnpm lingtai resume");
  });
});

describe("install, and whose checkout it names", () => {
  it("writes this checkout into the unit when the installing user owns it — repoRoot(), not a path the test chose", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=not-found\nActiveState=inactive\n" }],
      ["loginctl", { status: 0, out: "yes\n" }],
    ]);
    const { go } = command("linux", s.exec, { root: "default" });
    expect(await go("install")).toBe(0);
    const unit = await readFile(join(home, ".config/systemd/user/lingtai.service"), "utf8");
    expect(unit).toContain(`ExecStart=${NODE} ${repoRoot()}/apps/cli/src/lingtai.ts daemon`);
  });

  it("refuses a checkout another user owns, and writes and loads nothing", async () => {
    // `machinectl shell lingtai@`, then `pnpm --dir /home/admin/lingtai lingtai
    // service install`: repoRoot() is the admin's, the uid is lingtai's.
    const s = supervisor([]);
    const { go, err } = command("linux", s.exec, { root: "default", uid: UID + 1 });
    expect(await go("install")).toBe(1);
    expect(err.join("\n")).toContain(`${repoRoot()} is owned by uid ${UID}, not uid ${UID + 1}`);
    expect(s.calls).toEqual([]);
    expect(existsSync(join(home, ".config/systemd/user/lingtai.service"))).toBe(false);
  });
});

describe("the place in the queue for the lock", () => {
  it("is not held once its connection is lost, though the lock had been granted, and is taken again", async () => {
    // Granted, then the connection dropped: Postgres has let the lock go with it.
    let taken = 0;
    let first = true;
    const place = async (): Promise<LockPlace> => {
      const mine = ++taken;
      return {
        held: () => true,
        lost: () => (mine === 1 && !first ? new Error("Connection terminated unexpectedly") : null),
        confirm: async () => mine !== 1,
        leave: async () => {},
      };
    };
    const lines: string[] = [];
    const q = await queueForTheLock({ place, holder: async () => "copy", pollMs: 0 });
    first = false;
    expect(await q.holds()).toBe(false);
    expect(await q.wait((l) => lines.push(l))).toBe("held");
    expect(taken).toBe(2);
    expect(lines.join("\n")).toContain("Connection terminated unexpectedly");
    expect(await q.holds()).toBe(true);
  });

  it("says what ctrl-c does in service shutdown's wait — withdraws the request — never that it leaves it standing", async () => {
    let asks = 0;
    const place = async (): Promise<LockPlace> => ({
      held: () => asks > 2,
      lost: () => null,
      confirm: async () => true,
      leave: async () => {},
    });
    const lines: string[] = [];
    const q = await queueForTheLock({ place, holder: async () => (asks++, "daemon 1"), pollMs: 0, sayEveryMs: 0 });
    expect(await q.wait((l) => lines.push(l))).toBe("held");
    const said = lines.join("\n");
    expect(said).toContain("withdraws this command's request");
    expect(said).not.toContain("leaves whatever was asked for standing");
  });
});

async function systemdFile() {
  await mkdir(join(home, ".config/systemd/user"), { recursive: true });
  await writeFile(join(home, ".config/systemd/user", SYSTEMD_UNIT), "");
}

async function launchdFile() {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(home, "Library/LaunchAgents"), { recursive: true });
  await writeFile(join(home, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`), "");
}

describe("status", () => {
  it("prints the supervisor's answer and the beacon's, and a beacon it could not read as unread", async () => {
    const s = supervisor([["launchctl print", { status: 0, out: LOADED_BUT_NOT_RUNNING }]]);
    const { go, out } = command("darwin", s.exec, {
      liveness: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await go("status")).toBe(0);
    expect(out).toContain("  state = spawn scheduled");
    expect(out).toContain("  could not read it — connect ECONNREFUSED");
    expect(out.join("\n")).not.toContain("no daemon has run");
  });

  it.skipIf(!platformFor(process.platform))(
    "as `lingtai service status` really wires it, prints an unreachable beacon as unread, never as no daemon having run",
    async () => {
      // Through lingtai.ts, not an injected `liveness`: doctor's liveness folds
      // an unreadable beacon into "no daemon has run", and only the wiring
      // there keeps that answer out of this command. The supervisor is a
      // script on PATH; the database is a port nothing listens on.
      const bin = join(home, "bin");
      await mkdir(bin);
      const fake = (name: string, body: string) =>
        writeFile(join(bin, name), `#!/bin/sh\nprintf '${body}'\n`, { mode: 0o755 });
      await fake("launchctl", "\\tstate = running\\n");
      await fake("systemctl", "LoadState=loaded\\nActiveState=active\\n");
      const dead = "postgresql://lingtai@127.0.0.1:1/lingtai";
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        LINGTAI_DATABASE_URL: dead,
        LINGTAI_DIRECT_DATABASE_URL: dead,
      };
      const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
        execFile(
          process.execPath,
          ["--experimental-strip-types", join(repoRoot(), "apps/cli/src/lingtai.ts"), "service", "status"],
          { cwd: repoRoot(), env, timeout: 60_000 },
          (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
        );
      });
      expect(r.stdout).toContain("supervisor");
      expect(r.stdout).toMatch(/could not read it — /);
      expect(r.stdout).not.toContain("no daemon has run");
    },
    90_000,
  );

  it("does not print `not loaded` for a launchd that did not answer", async () => {
    const s = supervisor([["launchctl print", { status: 112, out: "Could not find domain" }]]);
    const { go, out } = command("darwin", s.exec);
    expect(await go("status")).toBe(1);
    expect(out.join("\n")).not.toContain("not loaded");
    expect(out.join("\n")).toContain("could not ask — launchctl print exited 112");
  });

  it("on Linux, reads systemd's own properties", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nNRestarts=9\n" }],
    ]);
    const { go, out } = command("linux", s.exec);
    expect(await go("status")).toBe(0);
    expect(out).toContain("  SubState=auto-restart");
    expect(out).toContain("  NRestarts=9");
  });
});

describe("install on Linux", () => {
  it("reloads, enables and starts the unit, and reports both answers", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=not-found\nActiveState=inactive\n" }],
      ["loginctl", { status: 0, out: "yes\n" }],
    ]);
    const { go, out } = command("linux", s.exec);
    expect(await go("install")).toBe(0);
    expect(s.calls.filter((c) => !c.startsWith("systemctl --user show"))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable lingtai.service",
      "systemctl --user start lingtai.service",
      "loginctl show-user lingtai --property=Linger --value",
    ]);
    expect(await readFile(join(home, ".config/systemd/user/lingtai.service"), "utf8")).toContain("Restart=always");
    expect(out.join("\n")).not.toMatch(/lingering|taking work/);
  });

  it("does not restart a unit that is active, and says when the new one takes effect", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=active\n" }],
      ["loginctl", { status: 0, out: "yes\n" }],
    ]);
    const { go, out } = command("linux", s.exec);
    expect(await go("install")).toBe(0);
    expect(s.calls).not.toContain("systemctl --user start lingtai.service");
    expect(s.calls.join("\n")).not.toContain("restart");
    expect(out.join("\n")).toContain("until its next start: pnpm lingtai service restart");
  });

  it("tells lingering off from lingering it could not read", () => {
    expect(lingering(supervisor([["loginctl", { status: 0, out: "yes\n" }]]).exec, "x")).toBe("yes");
    expect(lingering(supervisor([["loginctl", { status: 0, out: "no\n" }]]).exec, "x")).toBe("no");
    const failed = lingering(supervisor([["loginctl", { status: 1, out: "Failed to get user: No such user" }]]).exec, "x");
    expect(failed).toEqual({ unread: expect.stringContaining("No such user") });
    const missing = lingering(supervisor([["loginctl", { status: 127, out: "spawnSync loginctl ENOENT" }]]).exec, "x");
    expect(missing).toEqual({ unread: expect.stringContaining("ENOENT") });
  });

  it("says a lingering it could not read is unread, not off", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=not-found\nActiveState=inactive\n" }],
      ["loginctl", { status: 127, out: "spawnSync loginctl ENOENT" }],
    ]);
    const { go, out } = command("linux", s.exec);
    expect(await go("install")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("could not read whether lingering is on");
    expect(text).not.toContain("lingering is off");
  });

  it("names the missing user manager, which is what `sudo -u` without a session looks like", async () => {
    const s = supervisor([["systemctl --user show", { status: 1, out: "Failed to connect to bus: No medium found" }]]);
    const { go, err } = command("linux", s.exec);
    expect(await go("install")).toBe(1);
    expect(err.join("\n")).toContain("machinectl shell");
  });
});

/**
 * `lingtai restart` asks this before anything stops (0042 §8): whether the
 * start is the supervisor's to make, or this terminal's.
 */
describe("whether a supervisor keeps the daemon, for a restart", () => {
  const env = () => ({ HOME: home, USER: "lingtai" });
  const which = (bin: string) => `/usr/bin/${bin}`;
  const install = async (platform: "launchd" | "systemd", root: string) => {
    const f = (platform === "launchd" ? launchdPlist : systemdUnit)({ node: NODE, root, env: env() });
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.content);
  };

  it("does not, with nothing installed — the restart starts one here", () => {
    const { exec, calls } = supervisor([]);
    expect(keeper({ platform: "darwin", env: env(), root: ROOT, uid: UID, exec, which })).toEqual({ kept: false });
    expect(calls).toEqual([]);
  });

  it("does, when launchd has this checkout's job loaded", async () => {
    await install("launchd", ROOT);
    const { exec } = supervisor([["launchctl print", { status: 0, out: LOADED_BUT_NOT_RUNNING }]]);
    expect(keeper({ platform: "darwin", env: env(), root: ROOT, uid: UID, exec, which })).toMatchObject({ kept: true, platform: "launchd" });
  });

  it("does not, for a file somebody `service shutdown` unloaded — nothing would start from it", async () => {
    await install("launchd", ROOT);
    const { exec } = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    expect(keeper({ platform: "darwin", env: env(), root: ROOT, uid: UID, exec, which })).toEqual({ kept: false });
  });

  it("does not, for a systemd unit that is inactive", async () => {
    await install("systemd", ROOT);
    const { exec } = supervisor([["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=inactive\n" }]]);
    expect(keeper({ platform: "linux", env: env(), root: ROOT, uid: UID, exec, which })).toEqual({ kept: false });
  });

  it("refuses a supervisor it could not ask, rather than guessing either way", async () => {
    await install("launchd", ROOT);
    const { exec } = supervisor([["launchctl print", { status: 112, out: "Could not find domain" }]]);
    expect(keeper({ platform: "darwin", env: env(), root: ROOT, uid: UID, exec, which })).toHaveProperty("unread");
  });

  it("refuses a unit that runs another checkout: the restart would check one commit and start another", async () => {
    await install("systemd", "/srv/other");
    const { exec } = supervisor([["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=active\n" }]]);
    const kept = keeper({ platform: "linux", env: env(), root: ROOT, uid: UID, exec, which });
    expect("unread" in kept && kept.unread).toContain("different checkout");
  });
});

/**
 * #167's third finding. `launchctl bootstrap` and `systemctl start` exit 0 when
 * the job was asked for, and the daemon then lost the lock — or read a drain —
 * recorded nothing, and exited 0, for the supervisor to start again every thirty
 * seconds. The queue idled behind a command that had said it succeeded. What
 * these pin is what the operator is told in exactly that state.
 */
describe("a start the daemon never recorded", () => {
  /** The daemon runs, takes no work, appends nothing, and exits 0 — every time it is started. */
  const nothingRecorded = { watermark: async () => 8, after: async () => null };
  const TOOK_WORK = /recorded its start|daemon takes work|taking work|a daemon is running|started \S+ as/;

  it("start on macOS exits 1 and never says work was taken", async () => {
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const { go, out, err } = command("darwin", s.exec, { started: nothingRecorded });
    await launchdFile();
    expect(await go("start")).toBe(1);
    expect(s.calls.some((c) => c.startsWith("launchctl bootstrap"))).toBe(true);
    expect(out.join("\n")).not.toMatch(TOOK_WORK);
    expect(err.join("\n")).toContain("no daemon recorded one in 120s — so no work is being taken on its account");
    expect(err.join("\n")).toContain("records nothing, and may exit 0");
  });

  it("start on Linux exits 1 and never says work was taken", async () => {
    const s = supervisor([["systemctl --user show", { status: 0, out: "LoadState=loaded\nActiveState=inactive\nMainPID=0\n" }]]);
    const { go, out, err } = command("linux", s.exec, { started: nothingRecorded });
    await systemdFile();
    expect(await go("start")).toBe(1);
    expect(s.calls).toContain(`systemctl --user start ${SYSTEMD_UNIT}`);
    expect(out.join("\n")).not.toMatch(TOOK_WORK);
    expect(err.join("\n")).toContain("no daemon recorded one");
  });

  it("restart exits 1 after its drain, and says no work is taken", async () => {
    let prints = 0;
    const s = supervisor([
      ["launchctl print", () => (++prints <= 1 ? { status: 0, out: "\tstate = running\n\tpid = 41\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
    ]);
    const { go, out, err } = command("darwin", s.exec, { started: nothingRecorded });
    await launchdFile();
    expect(await go("restart")).toBe(1);
    expect(out.join("\n")).not.toMatch(TOOK_WORK);
    expect(err.join("\n")).toContain("no daemon recorded one");
  });

  it("install exits 1, and prints no report that could be read as a start", async () => {
    const s = supervisor([
      ["systemctl --user show", { status: 0, out: "LoadState=not-found\nActiveState=inactive\n" }],
      ["loginctl", { status: 0, out: "yes\n" }],
    ]);
    const { go, out, err } = command("linux", s.exec, { started: nothingRecorded });
    expect(await go("install")).toBe(1);
    expect(out.join("\n")).not.toMatch(TOOK_WORK);
    expect(err.join("\n")).toContain("no daemon recorded one");
  });

  it("says which start answered, when one is recorded — and only one after the supervisor was asked", async () => {
    const asked: number[] = [];
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const { go, out } = command("darwin", s.exec, {
      started: { watermark: async () => 8, after: async (v) => (asked.push(v), asked.length < 3 ? null : RECORDED) },
    });
    await launchdFile();
    expect(await go("start")).toBe(0);
    expect(asked.every((v) => v === 8)).toBe(true);
    expect(out.join("\n")).toContain("a daemon recorded its start — 2926f2d as mac:4242, recorded as daemon");
  });

  it("does not wait on a start it did not make, over a daemon the supervisor is already running", async () => {
    let asked = false;
    const s = supervisor([["launchctl print", { status: 0, out: "\tstate = running\n\tpid = 41\n" }]]);
    const { go, out } = command("darwin", s.exec, { started: { watermark: async () => 8, after: async () => ((asked = true), null) } });
    await launchdFile();
    expect(await go("start")).toBe(0);
    expect(asked).toBe(false);
    expect(s.calls.some((c) => c.includes("kickstart") || c.includes("bootstrap"))).toBe(false);
    expect(out.join("\n")).toContain("nothing was started");
  });

  /**
   * The second review's finding 1: the CLI's connection drops, launchd's daemon
   * wins the lock, records its start and takes work, and every read of the
   * record fails. That is not a start nothing recorded.
   */
  it("does not say no work is taken when every read of the record failed", async () => {
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const { go, out, err } = command("darwin", s.exec, {
      started: {
        watermark: async () => 8,
        after: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
      },
    });
    await launchdFile();
    expect(await go("start")).toBe(1);
    expect(out.join("\n")).not.toMatch(TOOK_WORK);
    expect(err.join("\n")).not.toContain("no work is being taken");
    expect(err.join("\n")).toContain("whether a daemon took work is not known");
    expect(err.join("\n")).toContain("Connection terminated unexpectedly");
  });

  it("does not claim a start it could not confirm, when the control stream cannot be read", async () => {
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const { go, err } = command("darwin", s.exec, {
      started: {
        watermark: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        after: async () => RECORDED,
      },
    });
    await launchdFile();
    expect(await go("start")).toBe(1);
    expect(err.join("\n")).toContain("whether a daemon took work is not known");
  });
});

/**
 * The complaint `#159` was opened for: stopping and starting were not one
 * command each. A shutdown outlived its daemon, so starting again meant
 * `lingtai resume` first — a command about taking work, used to let a process
 * stay up. Here it is one command to stop and one to start, and nothing lifted
 * in between, on a real control stream.
 */
describe("one command to stop, one to start", () => {
  it("service shutdown, then service start — and the start is not refused over the stop", async () => {
    const store = createMemoryEventStore();
    let loaded = true;
    const s = supervisor([
      ["launchctl print", () => (loaded ? { status: 0, out: "\tstate = running\n\tpid = 41\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
      ["launchctl bootout", () => ((loaded = false), { status: 0, out: "" })],
      ["launchctl bootstrap", () => ((loaded = true), { status: 0, out: "" })],
    ]);
    const drain: ServiceDrain = {
      ask: (by, reason) => requestShutdownUnlessStanding(by, reason, null, store),
      holding: async () => "nothing in flight",
      queue: async () => ({ wait: async () => "held", holds: async () => true, leave: async () => {} }),
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason, store),
    };
    const { go, err } = command("darwin", s.exec, {
      drain,
      shutdown: async () => (await readControl(store)).shutdown,
      started: {
        watermark: () => controlWatermark(store),
        // The daemon launchd starts reads where the stream is, and records itself.
        after: async (v) => {
          const { recordStart, startAfter } = await import("@lingtai/daemon/control");
          if ((await startAfter(v, store)) === null) await recordStart("daemon", null, { sha: RECORDED.sha, dirty: false }, store);
          return startAfter(v, store);
        },
      },
    });
    await launchdFile();

    expect(await go("shutdown", "for the night")).toBe(0);
    expect(loaded).toBe(false);
    expect(await go("start")).toBe(0);
    expect(loaded).toBe(true);
    expect(err).toEqual([]);
    expect((await readControl(store)).shutdown).toBeNull();
    // Nothing was resumed: the two commands were the whole of it.
    expect((await store.read("ctl-conductor")).map((e) => e.type)).toEqual([
      "ConductorShutdownRequested",
      "ConductorShutdownWithdrawn",
      "ConductorStarted",
    ]);
  });
});
