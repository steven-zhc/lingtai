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
import type { LockPlace } from "@lingtai/daemon";
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
    queue: async () => (said.push("queue"), { wait: async () => (said.push("held"), "held"), leave: async () => {} }),
    withdraw: async (by, v) => (
      said.push(`withdraw ${v}`),
      { withdrew: true, version: v + 1, request: { by, reason: "", timeoutMs: null, force: false, version: v } as never }
    ),
  };
  return { drain, said };
}

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

  it("starts nothing while a shutdown request stands, which the daemon it started would read and exit on", async () => {
    // `lingtai shutdown "pick up #NN"`, then `service restart`: the request is
    // still on the control stream, so every copy KeepAlive brings back exits.
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
   * The lock is Postgres's: one holder, and the sessions blocked in
   * `pg_advisory_lock` granted it in order on release, before a
   * `pg_try_advisory_lock` can find it free. The command's wait is the real
   * `queueForTheLock` over the real `waitForTheLock`; each poll is one step of
   * the world.
   */
  function world(passPolls: number, during?: (poll: number, store: ReturnType<typeof createMemoryEventStore>) => Promise<void>) {
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
      return { held: () => lock.holder === "command", lost: () => null, leave: async () => release("command") };
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
      withdraw: (by, version, reason) => withdrawShutdown(by, version, reason, null, store),
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
      drain: { ...w.drain, queue: async () => ({ wait: async () => "interrupted", leave: async () => {} }) },
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
