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
import { repoRoot } from "@lingtai/env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHCTL_NO_SUCH_SERVICE,
  LAUNCHD_LABEL,
  NO_SUPERVISOR,
  keeper,
  launchdPlist,
  lingering,
  platformFor,
  serviceCommand,
  systemdUnit,
  type Exec,
} from "../src/service.ts";

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

/** Whoever runs the suite, so the checkout `install` stats is theirs. */
const UID = process.getuid!();

function command(
  platform: NodeJS.Platform,
  exec: Exec,
  extra: {
    env?: NodeJS.ProcessEnv;
    liveness?: () => Promise<string>;
    /** `"default"` leaves `root` unset, so the command resolves it as it would for real. */
    root?: string | "default";
    uid?: number;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const go = (verb: string) =>
    serviceCommand([verb], {
      liveness: extra.liveness ?? (async () => "last seen 3000s ago (pid 41) — not running"),
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
  it("unloads, waits until launchd says it is gone, and loads the file again — not kickstart -k", async () => {
    let prints = 0;
    const s = supervisor([
      // loaded, still loaded after bootout, then gone
      ["launchctl print", () => (++prints <= 2 ? { status: 0, out: "\tstate = running\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
    ]);
    const { go } = command("darwin", s.exec);
    await launchdFile();
    expect(await go("restart")).toBe(0);
    const verbs = s.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(verbs).toEqual(["launchctl print", "launchctl bootout", "launchctl print", "launchctl print", "launchctl bootstrap"]);
    expect(s.calls.join("\n")).not.toContain("kickstart");
  });

  /**
   * `shutdown` is not what it offers: under a supervisor a shutdown is itself
   * a restart, with no check of the commit it starts (`0045`). `restart` is.
   */
  it("offers lingtai restart instead, which waits for the pass and checks the commit", async () => {
    let prints = 0;
    const s = supervisor([
      ["launchctl print", () => (++prints <= 1 ? { status: 0, out: "\tstate = running\n" } : { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" })],
    ]);
    const { go, out } = command("darwin", s.exec);
    await launchdFile();
    expect(await go("restart")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain('`pnpm lingtai restart "why"` instead');
    expect(text).not.toContain("lingtai resume");
  });
});

/**
 * **Nothing here refuses over a standing shutdown request** (`0045`). Every verb
 * that starts used to, because a request outlived the daemon it was aimed at: a
 * daemon started while one stood read it and exited, and `KeepAlive` started it
 * again every thirty seconds until `lingtai resume`. A start reads nothing said
 * before it now and ends the request for every other reader, so there is no
 * such state to refuse over — and the options that read the control stream for
 * it are gone, which is what these assert by not being able to pass one.
 */
describe("starting, whatever was said to the daemon before", () => {
  it("starts on Linux", async () => {
    const s = supervisor([]);
    const { go } = command("linux", s.exec);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config/systemd/user"), { recursive: true });
    await writeFile(join(home, ".config/systemd/user/lingtai.service"), "");
    expect(await go("start")).toBe(0);
    expect(s.calls).toEqual(["systemctl --user start lingtai.service"]);
  });

  /**
   * And a resume after the stop: the next start does not hear that pause, and
   * every whole-stream reader — the board, `doctor`, the quota stand-down —
   * would go on saying *paused* over a daemon taking work.
   */
  it("stop names a pause, not a shutdown, as the way to wait for the pass — a shutdown here is a restart", async () => {
    const s = supervisor([["launchctl print", { status: LAUNCHCTL_NO_SUCH_SERVICE, out: "" }]]);
    const { go, out } = command("darwin", s.exec);
    await launchdFile();
    expect(await go("stop")).toBe(0);
    const text = out.join("\n");
    expect(text).toContain('`pnpm lingtai pause "why"` first');
    expect(text).toMatch(/pause "why"` first.*then `pnpm lingtai resume`/);
    expect(text).not.toContain("lingtai shutdown");
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

  it("does not, for a file somebody `service stop`ped — nothing would start from it", async () => {
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
