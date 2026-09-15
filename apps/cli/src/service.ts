/**
 * `lingtai service` — the supervisor around `lingtai daemon`, per platform (#50).
 *
 * `lingtai daemon` is the process and stays exactly what it was: a foreground
 * process that runs until it is told to stop. This file writes the thing that
 * keeps it running — a LaunchAgent on macOS, a systemd **user** unit on Linux —
 * and passes start, stop and status through to it. It replaces
 * `scripts/launchd.sh`, and installs under the same label.
 *
 * ## Thin, and it says only what it was told
 *
 * Wrapping a service manager means inheriting its version churn (openclaw#40550).
 * So each verb is one or two calls to `launchctl` or `systemctl --user`, each
 * printed before it runs, and the file it installs comes from a pure function a
 * test reads.
 *
 * The same thinness applies to what it *claims*. "The supervisor has the job
 * loaded" and "a daemon is up and taking work" are different facts, and a job
 * can be loaded while launchd fails to spawn it every thirty seconds. So no verb
 * concludes the second from the first: `install` and `status` end by printing
 * the supervisor's own words beside `daemon_status`, the beacon outside the log
 * (#46), and leave the reading to whoever ran it.
 *
 * ## No service manager is not an error to work around
 *
 * A container, an init that is not systemd (openclaw#14078, #36137): the answer
 * is `lingtai daemon` in the foreground, under whatever supervises that box.
 *
 * ## Generated, never committed
 *
 * Both files carry absolute paths — this checkout, `node`, the log directory —
 * which differ per machine and per user. That is also what makes a dedicated
 * unprivileged user work: install *as* that user and every path is theirs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot, stateDir } from "@lingtai/env";

/** Unchanged from `scripts/launchd.sh`, so the agent it installed is the one this replaces. */
export const LAUNCHD_LABEL = "ai.nextloom.lingtai.daemon";
export const SYSTEMD_UNIT = "lingtai.service";

export type ServicePlatform = "launchd" | "systemd";

export interface ServiceInputs {
  /** Absolute path to `node`. */
  node: string;
  /** The checkout the daemon runs from. */
  root: string;
  env: NodeJS.ProcessEnv;
}

export interface ServiceFile {
  platform: ServicePlatform;
  path: string;
  content: string;
  logs: string;
}

export function platformFor(platform: NodeJS.Platform): ServicePlatform | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

function home(env: NodeJS.ProcessEnv): string {
  const h = env["HOME"];
  if (!h) throw new Error("HOME is not set — the unit is written under it, and the daemon reads credentials from it");
  return h;
}

/**
 * The environment the daemon gets. Both supervisors start a job with almost
 * nothing: no PATH worth the name, nothing from a shell profile. `git` and
 * `pnpm` are needed for a run, HOME for the credentials the runtime reads, and
 * USER because the macOS keychain looks it up by account name — without it
 * Claude Code reported "Not logged in" with a valid subscription.
 * `LINGTAI_HOME` is carried when set: a daemon that logs to one state directory
 * and works in another is two installs.
 */
export function serviceEnv({ node, env }: ServiceInputs): Record<string, string> {
  const out: Record<string, string> = {
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home(env),
    USER: env["USER"] ?? env["LOGNAME"] ?? userInfo().username,
    LANG: "en_US.UTF-8",
  };
  if (env["LINGTAI_HOME"]) out["LINGTAI_HOME"] = env["LINGTAI_HOME"];
  return out;
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The LaunchAgent `scripts/launchd.sh` wrote, plus `LINGTAI_HOME` when it is set. */
export function launchdPlist(inputs: ServiceInputs): ServiceFile {
  const logs = join(stateDir(inputs.env), "logs");
  const env = Object.entries(serviceEnv(inputs))
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xml(inputs.node)}</string>
    <string>${xml(join(inputs.root, "apps/cli/src/lingtai.ts"))}</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xml(inputs.root)}</string>

  <key>RunAtLoad</key>
  <true/>

  <!-- The whole point. Crash, logout, sleep — it comes back.
       systemd's Restart=always is the same rule. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Long enough that a crash loop does not spin. Short enough that a
       restart after a transient database blip is not a coffee break. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>

  <key>StandardOutPath</key>
  <string>${xml(join(logs, "daemon.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, "daemon.err"))}</string>
</dict>
</plist>
`;
  return {
    platform: "launchd",
    path: join(home(inputs.env), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    content,
    logs,
  };
}

/**
 * What a systemd unit cannot carry verbatim. Whitespace and quotes are split or
 * unquoted by some directives and taken literally by others (`WorkingDirectory=`
 * does not unquote), `%` is a specifier, `$` expands in `ExecStart=`, and `\`
 * is an escape. Rather than get each directive's rules right, a path with any
 * of them is refused by name.
 */
const UNIT_UNSAFE = /[\s"'\\%$;]/;

/**
 * The systemd user unit, line for line the plist's counterpart.
 *
 * - `Restart=always` is `KeepAlive`, and `RestartSec=30` is `ThrottleInterval`.
 *   `StartLimitIntervalSec=0` because launchd never gives up on a KeepAlive job
 *   and systemd, by default, does after five quick failures.
 * - `KillMode=process`, because the default kills the whole cgroup, agent
 *   included. 0030 put the agent in its own process group so the signal that
 *   begins a drain does not kill the run being drained; launchd signals only
 *   the daemon, and this is systemd doing the same.
 * - `WantedBy=default.target` is `RunAtLoad`: up when the user's manager is.
 */
export function systemdUnit(inputs: ServiceInputs): ServiceFile {
  const logs = join(stateDir(inputs.env), "logs");
  const vars = serviceEnv(inputs);
  const unsafe = [
    ["node", inputs.node],
    ["the checkout", inputs.root],
    ["the log directory", logs],
    ...Object.entries(vars),
  ].filter(([, v]) => UNIT_UNSAFE.test(v!));
  if (unsafe.length > 0) {
    throw new Error(
      `a systemd unit cannot carry ${unsafe.map(([k, v]) => `${k} (${JSON.stringify(v)})`).join(", ")} verbatim — ` +
        "move it to a path without spaces, quotes, %, $ or \\, or run `lingtai daemon` in the foreground",
    );
  }
  const content = `# Generated by \`lingtai service install\`. The absolute paths are this machine's —
# regenerate rather than edit, and never commit it.
[Unit]
Description=Lingtai daemon
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${inputs.node} ${join(inputs.root, "apps/cli/src/lingtai.ts")} daemon
WorkingDirectory=${inputs.root}
${Object.entries(vars)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
# launchd's KeepAlive: crash, logout, reboot — it comes back.
Restart=always
# launchd's ThrottleInterval.
RestartSec=30
# Signal the daemon, not the agent it detached (0030).
KillMode=process
StandardOutput=append:${join(logs, "daemon.log")}
StandardError=append:${join(logs, "daemon.err")}

[Install]
WantedBy=default.target
`;
  return {
    platform: "systemd",
    path: join(home(inputs.env), ".config/systemd/user", SYSTEMD_UNIT),
    content,
    logs,
  };
}

export const NO_SUPERVISOR =
  "no service manager Lingtai knows here — run `lingtai daemon` in the foreground, under whatever supervises this machine. That is a first-class way to run it, not a fallback.";

type Verb = "install" | "start" | "stop" | "restart" | "status" | "uninstall";
const VERBS: readonly Verb[] = ["install", "start", "stop", "restart", "status", "uninstall"];

export type Exec = (call: string[]) => { status: number; out: string };

function execCall(call: string[]): { status: number; out: string } {
  const r = spawnSync(call[0]!, call.slice(1), { encoding: "utf8" });
  if (r.error) return { status: 127, out: r.error.message };
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Where the shell finds `bin`, or `null`. Only ever called with a literal name. */
function whichBin(bin: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * `launchctl print`'s exit when the domain exists and the job is not in it.
 * Anything else non-zero is launchd not answering — 112 is "Could not find
 * domain", which is SSH with no gui session — and is not a job that is absent.
 */
export const LAUNCHCTL_NO_SUCH_SERVICE = 113;

/**
 * What the supervisor says, in its own words: `loaded` is whether it has the
 * definition, and `lines` are what it reports about the process. Neither is
 * whether a daemon is up — that is the beacon's to say.
 */
type Supervised = { loaded: boolean; lines: string[] } | { unread: string };

export function askSupervisor(platform: ServicePlatform, exec: Exec, uid: number): Supervised {
  if (platform === "launchd") {
    const r = exec(["launchctl", "print", `gui/${uid}/${LAUNCHD_LABEL}`]);
    if (r.status === LAUNCHCTL_NO_SUCH_SERVICE) return { loaded: false, lines: ["not loaded"] };
    if (r.status !== 0) return { unread: `launchctl print exited ${r.status}: ${r.out.trim() || "no output"}` };
    const lines = r.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(state|pid|runs|last exit code|last exit reason) =/.test(l));
    return { loaded: true, lines };
  }
  const r = exec([
    "systemctl",
    "--user",
    "show",
    SYSTEMD_UNIT,
    "--property=LoadState,ActiveState,SubState,MainPID,NRestarts,ExecMainStatus",
  ]);
  if (r.status !== 0) return { unread: `systemctl --user show exited ${r.status}: ${r.out.trim() || "no output"}` };
  const lines = r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  const load = lines.find((l) => l.startsWith("LoadState="))?.slice("LoadState=".length);
  if (!load) return { unread: `systemctl --user show gave no LoadState: ${r.out.trim() || "no output"}` };
  return { loaded: load === "loaded", lines };
}

/** Whether systemd's user manager outlives this user's last logout, in three answers rather than two. */
export function lingering(exec: Exec, username: string): "yes" | "no" | { unread: string } {
  const r = exec(["loginctl", "show-user", username, "--property=Linger", "--value"]);
  const value = r.out.trim();
  if (r.status === 0 && value === "yes") return "yes";
  if (r.status === 0 && value === "no") return "no";
  return { unread: `loginctl show-user ${username} exited ${r.status}: ${value || "no output"}` };
}

/** Longer than launchd's default ExitTimeOut, after which it has SIGKILLed the job anyway. */
const UNLOAD_WAIT_MS = 60_000;

export interface ServiceOptions {
  /** `daemon_status`, the beacon outside the log (#46). Injected so this file loads without a database. */
  liveness: () => Promise<string>;
  /**
   * The shutdown request in force, off the control stream, or null. Injected
   * for the same reason. Said beside a start, never a reason to refuse one: a
   * daemon reads nothing said before its own start (0045).
   */
  shutdown: () => Promise<{ by: string; reason: string } | null>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  root?: string;
  uid?: number;
  username?: string;
  exec?: Exec;
  which?: (bin: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Whether launchd or systemd keeps a daemon here, as `lingtai restart` needs to know it (0042 §8). */
export type Keeper =
  /** No supervisor has the job, or none exists here: whoever restarts starts it. */
  | { kept: false }
  /** The supervisor has it, and it runs this checkout. The start is the supervisor's. */
  | { kept: true; platform: ServicePlatform; path: string }
  /** It could not be told, or the unit runs a different checkout. Refused before anything stops. */
  | { unread: string };

/**
 * Whether a supervisor keeps the daemon, asked before a restart stops anything.
 *
 * **Kept means the supervisor would start one again by itself** — the job is
 * loaded under launchd, or the unit is active or restarting under systemd. A
 * file that is on disk after `service stop` is not a keeper: nothing will start
 * from it, and the daemon somebody is restarting is in a terminal.
 *
 * A unit written from another checkout is refused rather than started: the
 * restart would check this checkout's commit and the supervisor would start
 * that one's.
 */
export function keeper(
  options: Pick<ServiceOptions, "platform" | "env" | "root" | "uid" | "exec" | "which"> = {},
): Keeper {
  const platform = platformFor(options.platform ?? process.platform);
  const which = options.which ?? whichBin;
  if (!platform || !which(platform === "launchd" ? "launchctl" : "systemctl")) return { kept: false };
  const env = options.env ?? process.env;
  const root = options.root ?? repoRoot();
  let path: string;
  try {
    path = (platform === "launchd" ? launchdPlist : systemdUnit)({ node: "node", root, env }).path;
  } catch {
    // A HOME-less environment, or a checkout path systemd cannot carry: `service
    // install` refuses both, so nothing was installed from here to keep it.
    return { kept: false };
  }
  if (!existsSync(path)) return { kept: false };

  const answer = askSupervisor(platform, options.exec ?? execCall, options.uid ?? process.getuid?.() ?? 0);
  if ("unread" in answer) return { unread: `could not ask the supervisor whether it keeps the daemon — ${answer.unread}` };
  const kept =
    platform === "launchd"
      ? answer.loaded
      : answer.loaded && !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed");
  if (!kept) return { kept: false };

  const entry = join(root, "apps/cli/src/lingtai.ts");
  if (!readFileSync(path, "utf8").includes(entry)) {
    return {
      unread:
        `${path} runs a different checkout than this one (${root}) — a restart here would check this commit and ` +
        "the supervisor would start that one's. Restart from that checkout, or pnpm lingtai service install from this one",
    };
  }
  return { kept: true, platform, path };
}

export async function serviceCommand(args: string[], options: ServiceOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const exec = options.exec ?? execCall;
  const which = options.which ?? whichBin;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const verb = args[0] as Verb | undefined;
  if (!verb || !VERBS.includes(verb)) {
    error(`lingtai service ${VERBS.join("|")}`);
    return 2;
  }

  const platform = platformFor(options.platform ?? process.platform);
  // Not just the OS: a Linux container has `linux` and no `systemctl`.
  if (!platform || !which(platform === "launchd" ? "launchctl" : "systemctl")) {
    error(NO_SUPERVISOR);
    return 1;
  }

  const env = options.env ?? process.env;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const username = options.username ?? userInfo().username;
  const inputs: ServiceInputs = {
    // The `node` on PATH, as `scripts/launchd.sh` used, rather than
    // `process.execPath` — under Homebrew a versioned Cellar path that the next
    // `brew upgrade` deletes out from under the unit.
    node: which("node") ?? process.execPath,
    root: options.root ?? repoRoot(),
    env,
  };
  let file: ServiceFile;
  try {
    file = platform === "launchd" ? launchdPlist(inputs) : systemdUnit(inputs);
  } catch (err) {
    error((err as Error).message);
    return 1;
  }
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;

  const noUserManager = (out: string): void => {
    if (platform === "systemd" && /bus|XDG_RUNTIME_DIR/i.test(out)) {
      // The usual cause under `sudo -u`: no user session, so no user manager.
      error("no systemd user manager for this user — log in as them, or `machinectl shell <user>@`; see doc/operating.md");
    }
  };

  /** Runs one supervisor call, printed first. False, with its output on stderr, when it failed. */
  const run = (call: string[]): boolean => {
    log(`$ ${call.join(" ")}`);
    const r = exec(call);
    if (r.status === 0) return true;
    if (r.out.trim()) error(r.out.trim());
    noUserManager(r.out);
    return false;
  };

  /** The supervisor's answer, or null with the reason on stderr — never guessed as "not loaded". */
  const ask = (): { loaded: boolean; lines: string[] } | null => {
    const answer = askSupervisor(platform, exec, uid);
    if ("unread" in answer) {
      error(`could not ask the supervisor about the service — ${answer.unread}`);
      noUserManager(answer.unread);
      return null;
    }
    return answer;
  };

  /**
   * `bootout` returns while the job is still going, and a `bootstrap` in that
   * window fails — so wait until launchd says it is gone.
   */
  const unload = async (): Promise<boolean> => {
    if (!run(["launchctl", "bootout", target])) return false;
    const until = Date.now() + UNLOAD_WAIT_MS;
    for (;;) {
      const answer = askSupervisor(platform, exec, uid);
      if ("loaded" in answer && !answer.loaded) return true;
      if (Date.now() > until) {
        error(
          "unread" in answer
            ? `could not ask launchd whether ${LAUNCHD_LABEL} unloaded — ${answer.unread}`
            : `${LAUNCHD_LABEL} is still loaded ${UNLOAD_WAIT_MS / 1000}s after bootout`,
        );
        return false;
      }
      await sleep(500);
    }
  };

  /** Two answers to two questions, neither folded into the other. */
  const report = async (): Promise<number> => {
    log(`supervisor  (${platform === "launchd" ? `launchctl, ${target}` : `systemctl --user, ${SYSTEMD_UNIT}`})`);
    const answer = askSupervisor(platform, exec, uid);
    const lines = "unread" in answer ? [`could not ask — ${answer.unread}`] : answer.lines;
    for (const l of lines.length > 0 ? lines : ["loaded, and said nothing about the process"]) log(`  ${l}`);
    log("daemon      (daemon_status, the beacon — whether it is beating, which loaded does not say)");
    log(`  ${await options.liveness().catch((err: unknown) => `could not read it — ${(err as Error).message}`)}`);
    return "unread" in answer ? 1 : 0;
  };

  const installed = existsSync(file.path);
  const notInstalled = (): number => {
    error(`${file.path} does not exist — pnpm lingtai service install`);
    return 1;
  };

  /**
   * Say a shutdown request that stands, and start anyway.
   *
   * This used to refuse, because a daemon started while a request stood read it
   * and exited, and the supervisor started it again, until `lingtai resume`.
   * Since 0045 a daemon reads nothing said before its own start and a start ends
   * the request in the fold, so the start is exactly what the operator asked
   * for, and refusing it made starting two commands (`#159`). What is still
   * worth saying is who the request was aimed at: a daemon still draining on it
   * is not waited for by the supervisor.
   */
  const noteShutdown = async (): Promise<void> => {
    let asked: { by: string; reason: string } | null;
    try {
      asked = await options.shutdown();
    } catch {
      return;
    }
    if (!asked) return;
    log(`note  a shutdown asked by ${asked.by} (${asked.reason}) was aimed at the daemon running when it was made —`);
    log("      the daemon this starts reads nothing said before it, and takes work. Its start ends the request.");
  };

  switch (verb) {
    case "status":
      return report();

    case "install": {
      // The checkout is `repoRoot()` — wherever this command was run from, not
      // the installing user's. `pnpm --dir /home/admin/lingtai` as the service
      // user would write a unit that runs another user's code, or cannot.
      const owner = (await stat(inputs.root)).uid;
      if (owner !== uid) {
        error(
          `${inputs.root} is owned by uid ${owner}, not uid ${uid}, who would run it — ` +
            "install from a checkout this user owns (see doc/operating.md)",
        );
        return 1;
      }
      let started = false;
      await mkdir(file.logs, { recursive: true });
      await mkdir(dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content);
      log(`wrote ${file.path}`);
      log(`logs  ${join(file.logs, "daemon.log")}`);

      if (platform === "launchd") {
        const before = ask();
        if (!before) {
          error("the file is written and nothing was loaded");
          return 1;
        }
        if (before.loaded) {
          // Not reloaded: that would signal a pass in flight. launchd reads the
          // plist only when it loads the job — a KeepAlive respawn reuses the
          // definition already loaded — so this file is not in effect yet.
          log(`note  launchd already had ${LAUNCHD_LABEL} loaded, and keeps using the definition it loaded,`);
          log("      respawns included, until: pnpm lingtai service restart");
        } else {
          await noteShutdown();
          if (!run(["launchctl", "bootstrap", `gui/${uid}`, file.path])) return 1;
          started = true;
        }
      } else {
        const before = ask();
        if (!before) return 1;
        if (!run(["systemctl", "--user", "daemon-reload"])) return 1;
        if (!run(["systemctl", "--user", "enable", SYSTEMD_UNIT])) return 1;
        const active = before.lines.includes("ActiveState=active");
        if (active) {
          log("note  systemd has reloaded the unit, and the process it already had keeps the one it started with");
          log("      until its next start: pnpm lingtai service restart");
        } else {
          await noteShutdown();
          if (!run(["systemctl", "--user", "start", SYSTEMD_UNIT])) return 1;
          started = true;
        }
        const linger = lingering(exec, username);
        if (linger === "no") {
          log(`note  lingering is off for ${username}, so the user manager, and the daemon, stop at their last logout:`);
          log(`      sudo loginctl enable-linger ${username}`);
        } else if (linger !== "yes") {
          log(`note  could not read whether lingering is on — ${linger.unread}. Without it the daemon stops at ${username}'s last logout`);
        }
      }
      log("");
      const code = await report();
      // Asked the moment after the start, so the beacon may not have beaten yet.
      if (started) log("a daemon started just now takes a few seconds to beat — pnpm lingtai service status");
      return code;
    }

    case "start": {
      if (!installed) return notInstalled();
      await noteShutdown();
      if (platform === "systemd") return run(["systemctl", "--user", "start", SYSTEMD_UNIT]) ? 0 : 1;
      const answer = ask();
      if (!answer) return 1;
      // `stop` unloads, and `kickstart` cannot find a job that is not loaded.
      // Plain `kickstart` starts a loaded job that is not running and leaves a
      // running one alone, which is `systemctl start`.
      const ok = answer.loaded ? run(["launchctl", "kickstart", target]) : run(["launchctl", "bootstrap", `gui/${uid}`, file.path]);
      return ok ? 0 : 1;
    }

    case "stop":
    case "restart": {
      if (!installed) return notInstalled();
      if (verb === "restart") await noteShutdown();
      // The supervisor's signal drains the pass as Ctrl+C does, but it waits
      // seconds, not a pass, before SIGKILL (0030). A shutdown waits for the
      // pass, and under a supervisor it is a restart by itself: the copy the
      // supervisor brings back reads nothing said before it (0045) — so it is
      // offered instead of `restart`, never before it.
      log(
        verb === "stop"
          ? 'the supervisor waits seconds, not a pass, before SIGKILL — to wait for the pass in flight, `pnpm lingtai shutdown "why"` first'
          : 'the supervisor waits seconds, not a pass, before SIGKILL — to wait for the pass in flight, `pnpm lingtai restart "why"` instead, or `pnpm lingtai shutdown "why"`: the supervisor\'s next start takes work, with nothing to lift',
      );
      if (platform === "systemd") return run(["systemctl", "--user", verb, SYSTEMD_UNIT]) ? 0 : 1;
      const answer = ask();
      if (!answer) return 1;
      // Unloaded, not killed: KeepAlive would bring a killed job straight back.
      // And for `restart`, unloaded and loaded again rather than `kickstart -k`,
      // which would reuse the definition launchd already had.
      if (answer.loaded && !(await unload())) return 1;
      if (verb === "stop") {
        if (!answer.loaded) log(`${LAUNCHD_LABEL} was not loaded`);
        return 0;
      }
      return run(["launchctl", "bootstrap", `gui/${uid}`, file.path]) ? 0 : 1;
    }

    case "uninstall": {
      const answer = ask();
      if (!answer) return 1;
      if (answer.loaded) {
        const ok =
          platform === "launchd" ? await unload() : run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
        if (!ok) return 1;
      }
      if (!installed) {
        log(`nothing at ${file.path}${answer.loaded ? ", and the job it named is unloaded" : ""}`);
        return 0;
      }
      await rm(file.path, { force: true });
      if (platform === "systemd" && !run(["systemctl", "--user", "daemon-reload"])) return 1;
      log(`removed ${file.path} (logs kept in ${file.logs})`);
      return 0;
    }
  }
}
