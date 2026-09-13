/**
 * `lingtai service` — the supervisor around the daemon (#50).
 *
 * No database, and no real `launchctl` or `systemctl`: the supervisor is a
 * script of answers, and every call the command makes is recorded. What these
 * pin is what the command *says*, because the last attempt at this was refused
 * for saying more than it knew — "it is taking work" on the strength of a job
 * launchd had loaded and was failing to spawn.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHCTL_NO_SUCH_SERVICE,
  LAUNCHD_LABEL,
  NO_SUPERVISOR,
  launchdPlist,
  lingering,
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

function command(platform: NodeJS.Platform, exec: Exec, extra: { env?: NodeJS.ProcessEnv; liveness?: () => Promise<string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const go = (verb: string) =>
    serviceCommand([verb], {
      liveness: extra.liveness ?? (async () => "last seen 3000s ago (pid 41) — not running"),
      platform,
      env: extra.env ?? { HOME: home, USER: "lingtai" },
      root: ROOT,
      uid: 501,
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
    expect(s.calls).toContain(`launchctl bootstrap gui/501 ${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
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
