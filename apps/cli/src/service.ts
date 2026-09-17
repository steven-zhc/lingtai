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
 * ## Stopping it is a drain, and the supervisor is told last (#174)
 *
 * The supervisor's own stop is a signal and a deadline: launchd SIGKILLs at its
 * default `ExitTimeOut`, twenty seconds, and systemd at `TimeoutStopSec`,
 * ninety. The daemon drains on that signal, and a pass takes up to an hour —
 * so a `service stop` that sent it killed the agent it claimed to be waiting
 * for. `service shutdown` queues for the conductor lock, appends the request
 * `lingtai shutdown` appends, waits until the lock is its own, and only then
 * unloads, when there is nothing left for a SIGKILL to take — holding the lock,
 * so the copy KeepAlive starts after the drained daemon exits cannot take work
 * the unload would kill (a copy reads no request older than itself, #159). The daemon's SIGTERM handler still
 * drains, for whatever else signals it; nothing here depends on it finishing.
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
import type { Asking, Withdrawal } from "@lingtai/daemon";
import { repoRoot, stateDir } from "@lingtai/env";
import { WALL_LIMIT } from "./wall-limit.ts";

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

  <!-- No ExitTimeOut, deliberately: launchd's 20 seconds stands. Set to the
       wall limit it would make bootout, logout and machine shutdown block
       for an hour. The pass is waited for through the log instead —
       lingtai service shutdown drains first and unloads after (#174). -->

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
# No TimeoutStopSec, deliberately: systemd's 90s stands. The wall limit here
# would make logout and machine shutdown block for an hour. The pass is waited
# for through the log — lingtai service shutdown drains first, stops after (#174).
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

type Verb = "install" | "start" | "shutdown" | "restart" | "status" | "uninstall";
const VERBS: readonly Verb[] = ["install", "start", "shutdown", "restart", "status", "uninstall"];

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

/**
 * How long to wait for launchd to say the job is gone after `bootout`.
 *
 * Longer than launchd's default `ExitTimeOut`, so a job that ignored SIGTERM
 * has been SIGKILLed by the end of it. That is not a pass lost: `bootout` is
 * only ever reached after a drain has left this command holding the conductor
 * lock — `service shutdown`, `restart` and `uninstall` each drain first.
 * A copy KeepAlive started after the drained daemon exited reads nothing
 * appended before it started (#159), so it is not the request that keeps it
 * from work — it is that it cannot take the lock, and a daemon that loses the
 * lock claims nothing.
 */
const UNLOAD_WAIT_MS = 60_000;

/**
 * The drain, through the log — the mechanism that waits for a pass (0030).
 * Injected, as `liveness` is, so this file loads without a database.
 */
export interface ServiceDrain {
  /** `requestShutdownUnlessStanding`: never appended over a request already standing. */
  ask: (by: string, reason: string) => Promise<Asking>;
  /** What is in flight, in words, said before the wait. */
  holding: () => Promise<string>;
  /**
   * A place in the queue for the conductor lock — `queueForDaemonLock` — taken
   * before the request is appended, so that whoever holds the lock now hands
   * it to this command and not to a copy the supervisor starts after it exits.
   */
  queue: () => Promise<LockQueue>;
  /** `withdrawShutdown`: the request at `version`, and nothing else. */
  withdraw: (by: string, version: number, reason: string) => Promise<Withdrawal>;
}

/** What `ServiceDrain.queue` returns. */
export interface LockQueue {
  /**
   * Until this command holds the conductor lock — `waitForTheLock`. Polled,
   * never a fixed sleep: a quiet daemon reads the request and lets go at once.
   * `retaken` runs each time a place lost with its connection is taken again.
   */
  wait: (log: (line: string) => void, retaken?: () => Promise<void>) => Promise<"held" | "interrupted" | "gave-up">;
  /**
   * Whether the lock is still this command's, asked on its own connection. A
   * wait that ended held is not proof a moment later: Postgres releases the
   * lock with a dropped session, and a copy the supervisor starts can take it.
   */
  holds: () => Promise<boolean>;
  /** Releases the lock when held, and leaves the queue when not. Safe to call twice. */
  leave: () => Promise<void>;
}

export interface ServiceOptions {
  /** `daemon_status`, the beacon outside the log (#46). Injected so this file loads without a database. */
  liveness: () => Promise<string>;
  /**
   * The shutdown request in force, off the control stream, or null. Injected
   * for the same reason. A daemon started while one stands does not read it —
   * it reads nothing asked before it started (#159) — so it would take work
   * over a stop somebody asked for, and a start is refused until `lingtai resume`.
   */
  shutdown: () => Promise<{ by: string; reason: string } | null>;
  /**
   * The pause in force, or null. `lingtai resume` lifts it along with the
   * shutdown, so advice that ends in `resume` has to say how to keep it.
   * `until` is when it lifts by itself (0031 §3), and null for a person's.
   */
  pause?: () => Promise<{ by: string | null; reason: string | null; until?: Date | null } | null>;
  /** What `shutdown` and `restart` wait on before the supervisor is told anything. */
  drain: ServiceDrain;
  /** Who asks for the drain — `human:$USER`, as `lingtai shutdown` records it. */
  by?: string;
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
 * file that is on disk after `service shutdown` is not a keeper: nothing will start
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
  if (args[0] === "stop") {
    // Gone rather than kept as an alias. It sent the supervisor's signal, and
    // launchd SIGKILLed the drain that began twenty seconds in (#174); a name
    // that used to return in seconds and now waits a pass should be chosen.
    error("lingtai service stop is gone — it was the supervisor's signal, which kills a pass in flight 20 seconds in.");
    error('pnpm lingtai service shutdown "why" drains through the log, waits for the pass, then unloads.');
    return 2;
  }
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
  const by = options.by ?? `human:${env["USER"] ?? "operator"}`;
  const reason = args.slice(1).join(" ").trim() || "no reason given";
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
   * Whether a start would override a stop somebody asked for. A daemon started
   * now reads nothing asked before it started (#159), so it would not exit on a
   * standing request — it would take work over it, and that is not this
   * command's to decide.
   * A request that could not be read is said and not treated as none — nor as
   * one, since a restart is often what somebody reaches for when the database
   * is the trouble.
   */
  const shutdownStands = async (
    /** Whether this command has already unloaded the service, so "nothing was stopped" would be false. */
    unloaded = false,
  ): Promise<boolean> => {
    let asked: { by: string; reason: string } | null;
    try {
      asked = await options.shutdown();
    } catch (err) {
      log(`note  could not read whether a shutdown request stands — ${(err as Error).message}`);
      log("      if one does, the daemon this starts takes work over it — it reads nothing asked before it started. pnpm lingtai resume lifts it (a pause too)");
      return false;
    }
    if (!asked) return false;
    error(`a shutdown request stands — asked by ${asked.by} (${asked.reason}) — and a daemon started now would not read it:`);
    error(
      unloaded
        ? "it reads nothing asked before it started (#159), and would take work over that stop. The drain above unloaded the service, and nothing was started: nothing supervised runs until pnpm lingtai service start."
        : "it reads nothing asked before it started (#159), and would take work over that stop. Nothing was started or stopped.",
    );
    // `resume` is the only thing that lifts a shutdown, and it lifts a pause in
    // the same event — so a pause somebody set on purpose is named here, with
    // the order that keeps it: nothing supervised is up between the resume and
    // the pause again, so nothing takes work in that window.
    let paused: { by: string | null; reason: string | null; until?: Date | null } | null | undefined;
    try {
      paused = await options.pause?.();
    } catch {
      paused = undefined;
    }
    if (paused?.until) {
      // A pause that lifts itself cannot be set again by hand — `lingtai pause`
      // carries no time, so it would hold past this one's end until somebody
      // noticed. Waiting it out keeps it: after its time `resume` lifts only
      // the shutdown.
      const at = paused.until.toISOString();
      error(`A pause is in force too — ${paused.by ?? "somebody"} (${paused.reason ?? "no reason given"}) — until ${at}, when it lifts by itself,`);
      error("and pnpm lingtai resume lifts it now, along with the shutdown. To keep it, do not pause again — that pause would never lift.");
      error(
        verb === "install" || unloaded
          ? `After ${at}, once the daemon the shutdown was aimed at has exited (pnpm lingtai service status), pnpm lingtai resume, then pnpm lingtai service start.`
          : `After ${at}, once the daemon the shutdown was aimed at has exited (pnpm lingtai service status), pnpm lingtai resume, then this command again.`,
      );
      // Not "the supervisor's next start takes work": an unloaded job starts
      // nothing after a resume, and a loaded one is not held down by the request.
      if (verb !== "install" && !unloaded) error("Under a supervisor that request does not hold the service down: a copy started after it takes work regardless.");
      return true;
    }
    if (paused) {
      error(`A pause is in force too — ${paused.by ?? "somebody"} (${paused.reason ?? "no reason given"}) — and pnpm lingtai resume lifts it`);
      error("along with the shutdown. To keep it, once the daemon the shutdown was aimed at has exited (pnpm lingtai service status):");
      error(
        `pnpm lingtai service shutdown, pnpm lingtai resume, pnpm lingtai pause ${JSON.stringify(paused.reason ?? "why")}, pnpm lingtai service start.`,
      );
      return true;
    }
    if (paused === undefined) error("Whether a pause is in force could not be read — if one is, pnpm lingtai resume lifts it as well.");
    if (verb === "install" || unloaded) {
      error("Once the daemon it was aimed at has exited (pnpm lingtai service status), pnpm lingtai resume,");
      error("then pnpm lingtai service start, which takes work on the code at HEAD.");
      return true;
    }
    error("Under a supervisor that request does not hold the service down: a copy started after it takes work regardless.");
    error("Once the daemon it was aimed at has exited (pnpm lingtai service status), pnpm lingtai resume, then this command again.");
    return true;
  };

  /** The supervisor's start, refused while a shutdown request stands. */
  const start = async (unloaded = false): Promise<number> => {
    if (await shutdownStands(unloaded)) return 1;
    if (platform === "systemd") return run(["systemctl", "--user", "start", SYSTEMD_UNIT]) ? 0 : 1;
    const answer = ask();
    if (!answer) return 1;
    // `shutdown` unloads, and `kickstart` cannot find a job that is not loaded.
    // Plain `kickstart` starts a loaded job that is not running and leaves a
    // running one alone, which is `systemctl start`. A job unloaded and loaded
    // again, not `kickstart -k`, is also what applies a rewritten plist.
    const ok = answer.loaded ? run(["launchctl", "kickstart", target]) : run(["launchctl", "bootstrap", `gui/${uid}`, file.path]);
    return ok ? 0 : 1;
  };

  /**
   * The drain, then the supervisor — in that order, and the order is the fix.
   *
   * 1. a place in the queue for the conductor lock. Under KeepAlive the daemon
   *    that drains and exits is started again at once, and since #159 that copy
   *    reads nothing appended before it started — so the request does not keep
   *    it from work. The lock does: Postgres hands a released lock to the
   *    session already waiting, before the copy can try for it.
   * 2. the request, on the log: the daemon finishes the pass in flight, the
   *    gates and the merge lane with it, and exits. Only this command's own —
   *    one already standing is refused, since whether the daemon running now
   *    reads it depends on when that daemon started, and it is not ours to lift.
   * 3. the wait, until this command holds the lock. Bounded by the pass — by
   *    the recipe's runtime.limits — and not by anything here.
   * 4. the unload, still holding the lock. A copy the supervisor started
   *    meanwhile lost the lock and claimed nothing, so there is nothing left
   *    for the supervisor's SIGKILL to take.
   * 5. the lock released, and the request withdrawn by its version, so the
   *    next `service start` is not refused over it.
   */
  const drain = async (): Promise<number> => {
    const queue = await options.drain.queue().catch((err: unknown) => err as Error);
    if (queue instanceof Error) {
      error(`the conductor lock could not be queued for — ${queue.message}. Nothing was stopped:`);
      error("without a place in its queue, the copy the supervisor starts after the drain could take work that the unload kills.");
      return 1;
    }
    try {
      const asked = await options.drain.ask(by, `service ${verb}: ${reason}`).catch((err: unknown) => err as Error);
      if (asked instanceof Error) {
        error(`the shutdown could not be asked for — ${asked.message}. Nothing was stopped:`);
        error("the supervisor's signal would kill a pass in flight, so it is not sent without the drain.");
        return 1;
      }
      if (!asked.asked) {
        // Never adopted, even under this person's name: `lingtai shutdown` and
        // `lingtai restart` ask as `human:$USER` too, and a restart waiting on
        // its own request would find it lifted under it.
        error(`a shutdown asked by ${asked.standing.by} (${asked.standing.reason}) is already standing. Nothing was stopped:`);
        error("a daemon reads only a request asked after it started (#159), so this one may never exit on it, and it is not this command's to lift.");
        error("pnpm lingtai resume lifts it (a pause too); pnpm lingtai service shutdown then asks its own.");
        return 1;
      }
      let mine = asked.version;
      log(`draining — ${await options.drain.holding().catch(() => "what is in flight could not be read")}.`);
      log(`the pass in flight finishes first: its agent, the gates and the merge lane. What one may spend is ${WALL_LIMIT}. It is waiting, not hung.`);

      // A lock gone with its connection can be taken, in the gap, by a copy the
      // supervisor started after `mine` — which never reads it, and would take
      // work while this waited for ever. So the request is withdrawn and asked
      // again once the place is taken again: whatever holds the lock then read
      // its watermark before that append, and obeys it.
      const askAgain = async (): Promise<void> => {
        const lifted = await options.drain.withdraw(by, mine, `service ${verb}: asked again, the lock was lost with its connection`);
        if (!lifted.withdrew) return;
        const again = await options.drain.ask(by, `service ${verb}: ${reason}`);
        if (!again.asked) throw new Error(`a shutdown asked by ${again.standing.by} (${again.standing.reason}) landed first`);
        mine = again.version;
      };
      let waited = await queue.wait(log, askAgain);
      // Asked again right before the supervisor is told: the lock is only worth
      // anything while its session lasts, and a wait that ended held says
      // nothing about a connection that dropped since. After `bootout` or
      // `systemctl stop` the supervisor starts no copy, so this is the last
      // moment a lost lock could be handed to one.
      while (waited === "held" && !(await queue.holds().catch(() => false))) {
        log("the conductor lock was lost with its connection before the supervisor was told anything — its place is taken again, the drain asked again, and the wait goes on");
        waited = await queue.wait(log, askAgain);
      }
      if (waited !== "held") {
        await queue.leave();
        const lifted = await options.drain.withdraw(by, mine, `service ${verb}: stopped waiting`).catch((err: unknown) => err as Error);
        log(
          `${waited === "interrupted" ? "stopped waiting" : "gave up waiting"}, and the supervisor was told nothing. ` +
            (lifted instanceof Error
              ? `The request could not be withdrawn — ${lifted.message} — and service start refuses while it stands: pnpm lingtai resume lifts it. `
              : lifted.withdrew
                ? "The request is withdrawn. "
                : "") +
            "A daemon that had already read it still finishes its pass and exits, and the supervisor then starts one that takes work — " +
            "it reads nothing asked before it started. pnpm lingtai service shutdown asks again.",
        );
        return waited === "interrupted" ? 130 : 1;
      }
      log("this command holds the conductor lock — the pass is over, and nothing the supervisor starts now can take work");

      // Unloaded, not killed: KeepAlive would bring a killed job straight back.
      const stopped = platform === "launchd" ? await unload() : run(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
      await queue.leave();
      if (!stopped) {
        // The job is still the supervisor's, so the copy it starts once the lock
        // is let go takes work, and reads nothing asked before it started. The
        // request is this command's own, and left standing it would only refuse
        // the next `service shutdown` and `start` over nothing.
        const lifted = await options.drain.withdraw(by, mine, `service ${verb}: the supervisor did not stop`).catch((err: unknown) => err as Error);
        error(
          "the supervisor did not stop the service, above — it may still be running it, and a daemon it starts takes work. " +
            (lifted instanceof Error
              ? `The request could not be withdrawn — ${lifted.message} — and service start and shutdown refuse while it stands: pnpm lingtai resume lifts it.`
              : lifted.withdrew
                ? "The request is withdrawn; pnpm lingtai service shutdown asks again."
                : "pnpm lingtai service shutdown asks again."),
        );
        return 1;
      }

      const lifted = await options.drain.withdraw(by, mine, `service ${verb}: unloaded`).catch((err: unknown) => err as Error);
      if (lifted instanceof Error) {
        error(`unloaded, and the drain could not be withdrawn — ${lifted.message}. service start refuses while it stands: pnpm lingtai resume lifts it`);
        return 1;
      }
      if (lifted.withdrew) log(`withdrew the drain — nothing supervised is running to read it`);
      return 0;
    } finally {
      await queue.leave();
    }
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
        } else if (await shutdownStands()) {
          error("the file is written and nothing was loaded");
          return 1;
        } else if (!run(["launchctl", "bootstrap", `gui/${uid}`, file.path])) {
          return 1;
        } else {
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
        } else if (await shutdownStands()) {
          error("the unit is written and enabled, and nothing was started");
          return 1;
        } else if (!run(["systemctl", "--user", "start", SYSTEMD_UNIT])) {
          return 1;
        } else {
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

    case "start":
      if (!installed) return notInstalled();
      return start();

    case "shutdown":
    case "restart": {
      if (!installed) return notInstalled();
      if (verb === "restart" && (await shutdownStands())) return 1;
      const answer = ask();
      if (!answer) return 1;
      const kept =
        platform === "launchd"
          ? answer.loaded
          : answer.loaded && !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed");
      if (kept) {
        const drained = await drain();
        if (drained !== 0) return drained;
      } else {
        log(`the supervisor is not running ${platform === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT} — nothing of its to drain`);
      }
      if (verb === "shutdown") return 0;
      return start(kept);
    }

    case "uninstall": {
      const answer = ask();
      if (!answer) return 1;
      if (answer.loaded) {
        // Drained first, as `shutdown` is (#174): `bootout` or `disable --now`
        // on its own is the supervisor's signal, and kills a pass in flight.
        const kept =
          platform === "launchd" || !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed");
        if (kept) {
          const drained = await drain();
          if (drained !== 0) return drained;
        }
        // The drain unloaded a launchd job; a systemd unit is stopped and still enabled.
        if (platform === "systemd" && !run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT])) return 1;
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
