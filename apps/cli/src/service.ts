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
 * ## A start is what the daemon records, not what the supervisor answers (#167)
 *
 * `launchctl bootstrap` and `systemctl start` exit 0 when the job was asked
 * for. The daemon that runs may then lose the conductor lock, or read a drain,
 * record nothing, and exit 0 — and the supervisor starts it again every thirty
 * seconds, with the queue idle behind a command that said it succeeded. So
 * every verb that starts — `start`, `restart`, `install` — waits for the
 * `ConductorStarted` the daemon appends before its first pass, says which start
 * it was, and exits non-zero when none arrives.
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
import type { Asking, RecordedStart, Withdrawal } from "@lingtai/daemon";
import { boardPort, repoRoot, stateDir } from "@lingtai/env";
import { createFileLocker } from "@lingtai/env/lock";
import { BOARD_LOCK, type BoardPlace, boardPlace, parseBoardHolder, portAnswers } from "./board.ts";
import { WALL_LIMIT } from "./wall-limit.ts";

/** Unchanged from `scripts/launchd.sh`, so the agent it installed is the one this replaces. */
export const LAUNCHD_LABEL = "ai.nextloom.lingtai.daemon";
export const SYSTEMD_UNIT = "lingtai.service";

/** The board's own job (#187). A second label and a second unit, never a second process under the first. */
export const LAUNCHD_BOARD_LABEL = "ai.nextloom.lingtai.board";
export const SYSTEMD_BOARD_UNIT = "lingtai-board.service";

/**
 * What the supervisor keeps: one of the two processes (#187).
 *
 * **`launchd` supervises two jobs as easily as one.** Merging the board into
 * the conductor to avoid supervising two would be the CLI taking on exactly the
 * role the header of this file declines. So each process is a job of its own,
 * with its own label, its own unit and its own log — and `status` reports them
 * separately, because one summary saying *running* would hide a board that is
 * up beside a conductor launchd respawns every thirty seconds.
 */
export interface Job {
  /** What it is called in this command's output, and the stem of its two log files. */
  id: "daemon" | "board";
  label: string;
  unit: string;
  /** What the supervisor runs, after `node …/lingtai.ts`. */
  argv: readonly string[];
  /** systemd's `Description=`. */
  description: string;
  /**
   * How this job is stopped, and why — the `KillMode`/`TimeoutStopSec` lines
   * of the unit and the `ExitTimeOut` note in the plist.
   *
   * **Per job, because the daemon's reasons are false about the board.** The
   * generated file is the first thing anybody debugging one opens, and the
   * daemon's *signal the daemon, not the agent it detached* and *the pass is
   * waited for through the log* describe a drain the board has neither half
   * of: it detaches nothing and finishes no pass, and what `KillMode=process`
   * would spare here is its own `next dev` child.
   */
  systemdStop: string;
  launchdStop: string;
}

export const DAEMON_JOB: Job = {
  id: "daemon",
  label: LAUNCHD_LABEL,
  unit: SYSTEMD_UNIT,
  argv: ["daemon"],
  description: "Lingtai daemon",
  systemdStop: `# Signal the daemon, not the agent it detached (0030).
KillMode=process
# No TimeoutStopSec, deliberately: systemd's 90s stands. The wall limit here
# would make logout and machine shutdown block for an hour. The pass is waited
# for through the log — lingtai service shutdown drains first, stops after (#174).`,
  launchdStop: `  <!-- No ExitTimeOut, deliberately: launchd's 20 seconds stands. Set to the
       wall limit it would make bootout, logout and machine shutdown block
       for an hour. The pass is waited for through the log instead —
       lingtai service shutdown drains first and unloads after (#174). -->`,
};

/**
 * `--no-open`, because the supervisor's job has nobody at a browser: launchd
 * starts it at login and systemd at boot, and `open`ing a tab from there is a
 * window appearing at a moment nobody asked for one.
 */
export const BOARD_JOB: Job = {
  id: "board",
  label: LAUNCHD_BOARD_LABEL,
  unit: SYSTEMD_BOARD_UNIT,
  argv: ["board", "start", "--no-open"],
  description: "Lingtai board",
  // `control-group` is systemd's default, and it is written out because the
  // daemon's unit beside it says the opposite for reasons that are not this
  // job's. From a checkout the board is a CLI with `next dev` under it
  // (`board.ts`), and `KillMode=process` would leave that child outside the
  // kill scope: a board killed without running its SIGTERM handler — OOM,
  // `kill -9` — would leave it on the port holding no lock, and every
  // `Restart=always` respawn would then be refused by its own orphan.
  systemdStop: `# The default, said out loud: the board's own next dev child is in this cgroup,
# and leaving it outside would orphan it on the port with no lock naming it.
KillMode=control-group
# No TimeoutStopSec: systemd's 90s stands, and nothing here waits on it. A
# board detaches nothing and has no pass to finish, so its stop is a signal
# with no drain in front of it — lingtai service shutdown drains the conductor
# and stops this (#187).`,
  launchdStop: `  <!-- No ExitTimeOut, deliberately: launchd's 20 seconds is more than a board
       needs. It detaches nothing and has no pass to finish, so nothing is
       drained before this is booted out (#187).

       launchd has no kill scope of systemd's kind, so the next dev child a
       board served from a checkout runs is not launchd's to take: the CLI
       SIGTERMs it and SIGKILLs it five seconds later (board.ts's stopServer),
       well inside that 20 seconds. Without that, a SIGKILL here would leave it
       on the port holding no lock, and every respawn would be refused by it. -->`,
};

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

/**
 * The LaunchAgent `scripts/launchd.sh` wrote, plus `LINGTAI_HOME` when it is
 * set — and, for `BOARD_JOB`, the same file with the board's label, arguments,
 * logs and stop note. The two jobs differ in those four things and in nothing
 * else; the note is one of them because the daemon's reasons for not setting
 * `ExitTimeOut` are a drain the board has no part of.
 */
export function launchdPlist(inputs: ServiceInputs, job: Job = DAEMON_JOB): ServiceFile {
  const logs = join(stateDir(inputs.env), "logs");
  const env = Object.entries(serviceEnv(inputs))
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${job.label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xml(inputs.node)}</string>
    <string>${xml(join(inputs.root, "apps/cli/src/lingtai.ts"))}</string>
${job.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
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

${job.launchdStop}

  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>

  <key>StandardOutPath</key>
  <string>${xml(join(logs, `${job.id}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, `${job.id}.err`))}</string>
</dict>
</plist>
`;
  return {
    platform: "launchd",
    path: join(home(inputs.env), "Library/LaunchAgents", `${job.label}.plist`),
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
 * - `KillMode=process` **for the daemon**, because the default kills the whole
 *   cgroup, agent included. 0030 put the agent in its own process group so the
 *   signal that begins a drain does not kill the run being drained; launchd
 *   signals only the daemon, and this is systemd doing the same. The board
 *   wants the opposite and says so in its own unit — `Job.systemdStop` is per
 *   job so that neither file carries the other's reasons.
 * - `WantedBy=default.target` is `RunAtLoad`: up when the user's manager is.
 */
export function systemdUnit(inputs: ServiceInputs, job: Job = DAEMON_JOB): ServiceFile {
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
Description=${job.description}
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${inputs.node} ${join(inputs.root, "apps/cli/src/lingtai.ts")} ${job.argv.join(" ")}
WorkingDirectory=${inputs.root}
${Object.entries(vars)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
# launchd's KeepAlive: crash, logout, reboot — it comes back.
Restart=always
# launchd's ThrottleInterval.
RestartSec=30
${job.systemdStop}
StandardOutput=append:${join(logs, `${job.id}.log`)}
StandardError=append:${join(logs, `${job.id}.err`)}

[Install]
WantedBy=default.target
`;
  return {
    platform: "systemd",
    path: join(home(inputs.env), ".config/systemd/user", job.unit),
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

export function askSupervisor(platform: ServicePlatform, exec: Exec, uid: number, job: Job = DAEMON_JOB): Supervised {
  if (platform === "launchd") {
    const r = exec(["launchctl", "print", `gui/${uid}/${job.label}`]);
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
    job.unit,
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
 * Seconds `service shutdown` watches the supervisor for a moment with no daemon
 * running, when the database the drain goes through cannot be reached. Longer
 * than two of the 30-second restarts either supervisor is given, so a copy that
 * crash-loops on the connection is seen between two starts.
 */
const IDLE_WAIT_POLLS = 90;

/**
 * Seconds a start waits for the board to answer on its port. It is Next's
 * `standalone` server starting, not a reconcile, so it is well short of the
 * daemon's — and past two of the supervisor's thirty-second restarts.
 */
const BOARD_WAIT_POLLS = 90;

/**
 * Seconds a start waits for the daemon's `ConductorStarted`. The record lands
 * after the reconcile, which reads a recipe per project and writes GitHub
 * labels and crossed fifteen seconds in #144 — so well past that, and past two
 * of the supervisor's thirty-second restarts.
 */
const START_WAIT_POLLS = 120;

/** Whether the supervisor reports a process for the job — not just a job loaded or a restart scheduled. */
function processRunning(platform: ServicePlatform, lines: readonly string[]): boolean {
  if (platform === "launchd") return lines.some((l) => l === "state = running" || /^pid = [1-9]/.test(l));
  const pid = lines.find((l) => l.startsWith("MainPID="))?.slice("MainPID=".length);
  return pid === undefined ? lines.includes("SubState=running") : pid !== "0";
}

/**
 * The pid the supervisor reports for the job, or null where it reports none —
 * a job loaded with no process, or a restart merely scheduled.
 *
 * Whether a process exists is `processRunning`'s question; this is *which
 * process*, which is what tells a board the supervisor keeps from a board
 * somebody started in a terminal on the same port.
 */
function processPid(platform: ServicePlatform, lines: readonly string[]): number | null {
  const raw =
    platform === "launchd"
      ? lines.find((l) => /^pid = \d+$/.test(l))?.slice("pid = ".length)
      : lines.find((l) => l.startsWith("MainPID="))?.slice("MainPID=".length);
  if (raw === undefined) return null;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

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
  /**
   * How a start is confirmed: where `ctl-conductor` is before the supervisor is
   * asked, and the first `ConductorStarted` after it (`startAfter`). Not
   * optional — a start that could be confirmed by nothing is the one that
   * reported success over an idle queue (#167).
   */
  started: {
    watermark: () => Promise<number>;
    after: (version: number) => Promise<RecordedStart | null>;
  };
  /**
   * The board's half of "loaded is not up" (#187): its address, whether
   * anything answers there, and **who is serving it** — the pid the board lock
   * names, which is what tells this job's board from any other. Injected for
   * the same reason `liveness` is — this file connects to nothing and reads no
   * lock by itself — and defaulted to the port `lingtai board start` serves on.
   */
  board?: {
    url: string;
    answers: () => Promise<boolean>;
    serving: () => Promise<{ port: number; pid: number; host: string } | null>;
  };
  /**
   * What the board's job would serve, instead of asking `boardPlace()` — the
   * built board beside this CLI, or the checkout's own. Injected so a test can
   * be a machine with neither.
   */
  servable?: BoardPlace | { missing: string };
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

export type BoardKeeper =
  /** No supervisor has the board's job, or none exists here: whoever starts one is the board. */
  | { kept: false }
  /** The supervisor has it, and would start it again by itself. `job` is the label or the unit. */
  | { kept: true; job: string }
  /** It could not be told. Refused before anything is stopped, never guessed as `false`. */
  | { unread: string };

/**
 * Whether a supervisor keeps **the board**, asked before `board restart` stops
 * one (#187, and the review of it).
 *
 * `keeper` above is the daemon's, and the board needs the same question asked
 * of its own job: `board restart` frees the board lock, and the `start` behind
 * it is a few milliseconds of SQLite against launchd's respawn. A terminal
 * that wins that race leaves the installed job exiting 1 on a lock it cannot
 * take, respawned every thirty seconds behind a board that goes when the
 * terminal closes — the state `confirmBoard` refuses to call a start, reached
 * through the documented restart verb.
 *
 * **Loaded is kept, crash-looping included**, which is the case that matters:
 * a job launchd is respawning is a job about to want this lock. A job booted
 * out, or a unit `inactive` or `failed`, is not — there a terminal board is
 * the only board, and `board restart` restarts it as it always did.
 *
 * **No checkout check, unlike `keeper`.** A board job written from another
 * checkout still serves a board this machine keeps, and starting a second one
 * beside it is exactly what this is asked to prevent; which checkout it renders
 * is not this question.
 */
export function boardKeeper(
  options: Pick<ServiceOptions, "platform" | "env" | "root" | "uid" | "exec" | "which"> = {},
): BoardKeeper {
  const platform = platformFor(options.platform ?? process.platform);
  const which = options.which ?? whichBin;
  if (!platform || !which(platform === "launchd" ? "launchctl" : "systemctl")) return { kept: false };
  const env = options.env ?? process.env;
  const root = options.root ?? repoRoot();
  let path: string;
  try {
    path = (platform === "launchd" ? launchdPlist : systemdUnit)({ node: "node", root, env }, BOARD_JOB).path;
  } catch {
    // A HOME-less environment, or a checkout path systemd cannot carry:
    // `service install` refuses both, so nothing was installed from here.
    return { kept: false };
  }
  if (!existsSync(path)) return { kept: false };

  const answer = askSupervisor(platform, options.exec ?? execCall, options.uid ?? process.getuid?.() ?? 0, BOARD_JOB);
  if ("unread" in answer) return { unread: `could not ask the supervisor whether it keeps the board — ${answer.unread}` };
  const kept =
    platform === "launchd"
      ? answer.loaded
      : answer.loaded && !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed");
  return kept ? { kept: true, job: platform === "launchd" ? BOARD_JOB.label : BOARD_JOB.unit } : { kept: false };
}

/** Where the board answers, who is serving it, and how to ask — the default when nothing is injected. */
function liveBoard(env: NodeJS.ProcessEnv): NonNullable<ServiceOptions["board"]> {
  const port = boardPort(env);
  return {
    url: `http://127.0.0.1:${port}`,
    answers: () => portAnswers("127.0.0.1", port),
    serving: async () => {
      const who = await createFileLocker().holder(BOARD_LOCK);
      return who === null ? null : parseBoardHolder(who);
    },
  };
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
  const write = platform === "launchd" ? launchdPlist : systemdUnit;
  let file: ServiceFile;
  let boardFile: ServiceFile;
  try {
    file = write(inputs, DAEMON_JOB);
    boardFile = write(inputs, BOARD_JOB);
  } catch (err) {
    error((err as Error).message);
    return 1;
  }
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const boardTarget = `gui/${uid}/${LAUNCHD_BOARD_LABEL}`;
  const named = (job: Job) => (platform === "launchd" ? job.label : job.unit);
  /**
   * **Whether there is a board for the board's job to serve at all**, asked
   * here — in a process whose `import.meta.filename` is the one that job will
   * have, so the answer is the job's and not a guess about it.
   *
   * A job written where there is neither a built board nor a checkout exits 1
   * the instant it starts and is respawned every thirty seconds for ever,
   * under an `install` that reported success. So it is not written, and the
   * sentence saying what is missing is printed instead.
   */
  const servable = options.servable ?? boardPlace();
  let board: NonNullable<ServiceOptions["board"]>;
  try {
    board = options.board ?? liveBoard(env);
  } catch (err) {
    // A `board.port` the machine file cannot mean. Refused by name rather than
    // guessed at: every verb here would otherwise report the wrong address.
    error((err as Error).message);
    return 1;
  }

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
  const ask = (job: Job = DAEMON_JOB): { loaded: boolean; lines: string[] } | null => {
    const answer = askSupervisor(platform, exec, uid, job);
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
  const unload = async (job: Job = DAEMON_JOB): Promise<boolean> => {
    if (!run(["launchctl", "bootout", `gui/${uid}/${job.label}`])) return false;
    const until = Date.now() + UNLOAD_WAIT_MS;
    for (;;) {
      const answer = askSupervisor(platform, exec, uid, job);
      if ("loaded" in answer && !answer.loaded) return true;
      if (Date.now() > until) {
        error(
          "unread" in answer
            ? `could not ask launchd whether ${job.label} unloaded — ${answer.unread}`
            : `${job.label} is still loaded ${UNLOAD_WAIT_MS / 1000}s after bootout`,
        );
        return false;
      }
      await sleep(500);
    }
  };

  /**
   * Two answers to two questions, neither folded into the other — **and once
   * per job**, never once for both (#187). One summary saying *running* would
   * hide a board that is up beside a conductor launchd respawns every thirty
   * seconds, which is the same mistake as concluding *taking work* from
   * *loaded*, one level up.
   */
  const report = async (): Promise<number> => {
    log(`supervisor  (${platform === "launchd" ? `launchctl, ${target}` : `systemctl --user, ${SYSTEMD_UNIT}`})`);
    const answer = askSupervisor(platform, exec, uid);
    const lines = "unread" in answer ? [`could not ask — ${answer.unread}`] : answer.lines;
    for (const l of lines.length > 0 ? lines : ["loaded, and said nothing about the process"]) log(`  ${l}`);
    log("daemon      (daemon_status, the beacon — whether it is beating, which loaded does not say)");
    log(`  ${await options.liveness().catch((err: unknown) => `could not read it — ${(err as Error).message}`)}`);

    log("");
    log(`supervisor  (${platform === "launchd" ? `launchctl, ${boardTarget}` : `systemctl --user, ${SYSTEMD_BOARD_UNIT}`})`);
    const boardAnswer = askSupervisor(platform, exec, uid, BOARD_JOB);
    const boardLines = "unread" in boardAnswer ? [`could not ask — ${boardAnswer.unread}`] : boardAnswer.lines;
    for (const l of boardLines.length > 0 ? boardLines : ["loaded, and said nothing about the process"]) log(`  ${l}`);
    log(`board       (${board.url} — whether the UI answers there, which loaded does not say)`);
    log(`  ${(await board.answers().catch(() => false)) ? "answers" : "nothing answers"}`);
    return "unread" in answer || "unread" in boardAnswer ? 1 : 0;
  };

  /**
   * What is not yet true about **this job's** board, or `""` when it is up.
   *
   * **A port that answers is not a start that worked.** `pnpm lingtai board
   * start` in a terminal takes the board lock and answers on the same port; the
   * job the supervisor starts then finds the lock held, writes `a board is
   * already on 17820` to `board.err` and exits 1, and launchd respawns it every
   * thirty seconds behind a board that is somebody else's and goes when that
   * terminal closes. Asking only *does something answer* reports that as a
   * start that worked — the hazard `status` refuses to hide, reintroduced in
   * the confirm step. So three facts have to be one board: the supervisor has a
   * pid for this job, the board lock names that pid, and the port answers.
   */
  const boardNotUp = async (): Promise<string> => {
    const answer = askSupervisor(platform, exec, uid, BOARD_JOB);
    if ("unread" in answer) return `the supervisor could not be asked about ${named(BOARD_JOB)} — ${answer.unread}`;
    const pid = answer.loaded ? processPid(platform, answer.lines) : null;
    if (pid === null) return `the supervisor reports no process for ${named(BOARD_JOB)}`;
    const held = await board.serving().catch((err: unknown) => (err as Error).message);
    if (typeof held === "string") return `who holds the board lock could not be read — ${held}`;
    if (held === null) return `${named(BOARD_JOB)} is pid ${pid}, and no board of this machine's holds the board lock`;
    if (held.pid !== pid) {
      return `${board.url} is served by pid ${held.pid}, and ${named(BOARD_JOB)} is pid ${pid} — that job did not take the board lock, so what answers there is not it`;
    }
    if (!(await board.answers().catch(() => false))) return `nothing answers on ${board.url}`;
    return "";
  };

  /** The board's start, confirmed as the job's own board and not as a port that answers. */
  const confirmBoard = async (): Promise<number> => {
    log(`waiting for ${named(BOARD_JOB)} to be serving ${board.url} — up to ${BOARD_WAIT_POLLS}s. It is waiting, not hung.`);
    let why = `nothing answers on ${board.url}`;
    for (let i = 0; i < BOARD_WAIT_POLLS; i++) {
      why = await boardNotUp();
      if (why === "") {
        log(`the board answers on ${board.url}`);
        return 0;
      }
      await sleep(1_000);
    }
    error(`the supervisor accepted the board's start, and ${BOARD_WAIT_POLLS}s later: ${why}.`);
    error(`${join(file.logs, "board.err")} says why — a port somebody else holds is refused there by name.`);
    return 1;
  };

  /**
   * Whether the board's own file is on disk.
   *
   * **Absent is a note and not a failure.** A Lingtai installed before #187 has
   * the daemon's file and not the board's, and these verbs are the conductor's
   * first: a `lingtai restart` that exited 1 over a board job nobody had yet
   * installed would report a daemon restart that worked as one that did not.
   */
  const boardInstalled = (): boolean => {
    if (existsSync(boardFile.path)) return true;
    if ("missing" in servable) log(`no board job is installed, and there is none to install — ${servable.missing}`);
    else log(`no board job is installed — nothing of the board's was started. pnpm lingtai service install writes both (#187)`);
    return false;
  };

  /**
   * The board's start. No `ConductorStarted` to wait for and no lock to lose: a
   * board takes no work, so the only thing that could be false here is that it
   * is not listening, and `confirmBoard` asks exactly that.
   */
  const startBoard = async (): Promise<number> => {
    if (!boardInstalled()) return 0;
    const answer = ask(BOARD_JOB);
    if (!answer) return 1;
    if (answer.loaded && processRunning(platform, answer.lines)) {
      log(`the supervisor already has a process for ${named(BOARD_JOB)}, so nothing was started`);
      return 0;
    }
    if (platform === "systemd") {
      if (!run(["systemctl", "--user", "start", SYSTEMD_BOARD_UNIT])) return 1;
    } else if (!run(answer.loaded ? ["launchctl", "kickstart", boardTarget] : ["launchctl", "bootstrap", `gui/${uid}`, boardFile.path])) {
      return 1;
    }
    return confirmBoard();
  };

  /**
   * The board's stop — the supervisor's own, with no drain in front of it.
   *
   * **That is the difference the verb names.** The daemon's stop waits for the
   * pass in flight because a SIGKILL twenty seconds in would take the agent
   * with it (#174). A board holds no claim and no pass: it renders the log and
   * issues control events (0013), so a signal costs nothing to finish. It does
   * hold one thing — the board lock (`board.ts`, 0052) that names its port and
   * pid — and the kernel drops that with the process, so there is nothing to
   * hand over and nothing to wait for either.
   */
  const stopBoard = async (): Promise<number> => {
    const answer = ask(BOARD_JOB);
    if (!answer) return 1;
    if (!answer.loaded) {
      log(`the supervisor is not running ${named(BOARD_JOB)} — nothing of its to stop`);
      return 0;
    }
    const stopped = platform === "launchd" ? await unload(BOARD_JOB) : run(["systemctl", "--user", "stop", SYSTEMD_BOARD_UNIT]);
    return stopped ? 0 : 1;
  };

  /**
   * The board's half of `install`, after the daemon's. Its file is already
   * written — both are, before either supervisor is asked — so this is the
   * load, and the same refusal to restart a job the supervisor already has.
   *
   * No `shutdownStands` check: a shutdown request is the conductor's, and a
   * board that reads the log takes no work over it.
   */
  const installBoard = async (): Promise<number> => {
    const before = ask(BOARD_JOB);
    if (!before) return 1;
    if (platform === "launchd") {
      if (before.loaded) {
        log(`note  launchd already had ${LAUNCHD_BOARD_LABEL} loaded, and keeps using the definition it loaded,`);
        log("      respawns included, until: pnpm lingtai service restart");
        return 0;
      }
      if (!run(["launchctl", "bootstrap", `gui/${uid}`, boardFile.path])) return 1;
      return confirmBoard();
    }
    if (!run(["systemctl", "--user", "enable", SYSTEMD_BOARD_UNIT])) return 1;
    if (before.lines.includes("ActiveState=active")) {
      log("note  systemd has reloaded the board unit, and the process it already had keeps the one it started with");
      log("      until its next start: pnpm lingtai service restart");
      return 0;
    }
    if (!run(["systemctl", "--user", "start", SYSTEMD_BOARD_UNIT])) return 1;
    return confirmBoard();
  };

  /** The board's half of `uninstall`: stopped, disabled, and its file removed. */
  const uninstallBoard = async (): Promise<number> => {
    const answer = ask(BOARD_JOB);
    if (!answer) return 1;
    if (answer.loaded) {
      const stopped = await stopBoard();
      if (stopped !== 0) return stopped;
      if (platform === "systemd" && !run(["systemctl", "--user", "disable", SYSTEMD_BOARD_UNIT])) return 1;
    }
    if (!existsSync(boardFile.path)) return 0;
    await rm(boardFile.path, { force: true });
    log(`removed ${boardFile.path} (logs kept in ${boardFile.logs})`);
    return 0;
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

  /**
   * One supervisor call that starts the daemon, and then the daemon's own word
   * for it: 0 only once a `ConductorStarted` is on the log after the call.
   */
  const startAndConfirm = async (call: string[]): Promise<number> => {
    const mark = await options.started.watermark().catch((err: unknown) => err as Error);
    if (!run(call)) return 1;
    if (mark instanceof Error) {
      error(`the supervisor was asked to start the daemon, and where the control stream is could not be read — ${mark.message}.`);
      error("So whether a daemon took work is not known: pnpm lingtai service status says what the supervisor did, and lingtai doctor whether a daemon is up.");
      return 1;
    }
    log(`waiting for the daemon to record its start — up to ${START_WAIT_POLLS}s, since it records after its reconcile. It is waiting, not hung.`);
    /**
     * Why the last read failed, or null when it answered. A read that failed is
     * not a read that found nothing: the daemon may have recorded its start and
     * be taking work while this cannot see the stream.
     */
    let unread: string | null = null;
    for (let i = 0; i < START_WAIT_POLLS; i++) {
      let record: RecordedStart | null = null;
      try {
        record = await options.started.after(mark);
        unread = null;
      } catch (err) {
        unread = (err as Error).message;
      }
      if (record !== null) {
        log(
          `a daemon recorded its start — ${record.sha ? record.sha.slice(0, 7) : "an unrecorded commit"}` +
            `${record.dirty ? " (worktree dirty)" : ""} as ${record.worker}, recorded as ${record.by}`,
        );
        return 0;
      }
      await sleep(1_000);
    }
    if (unread !== null) {
      error(`the supervisor accepted the start, and the control stream could not be read to see whether a daemon recorded one — ${unread}.`);
      error("So whether a daemon took work is not known: a daemon may be running a pass now.");
      error("pnpm lingtai service status says what the supervisor did, and lingtai doctor whether a daemon is up and who holds the lock.");
      return 1;
    }
    error(`the supervisor accepted the start, and no daemon recorded one in ${START_WAIT_POLLS}s — so no work is being taken on its account.`);
    error("A daemon that loses the conductor lock, reads a shutdown, or fails on its way up records nothing, and may exit 0 for the supervisor to start again.");
    error("pnpm lingtai service status says what the supervisor did, and lingtai doctor whether a daemon is up and who holds the lock.");
    return 1;
  };

  /** The supervisor's start, refused while a shutdown request stands, and confirmed by the daemon's record. */
  const start = async (unloaded = false): Promise<number> => {
    if (await shutdownStands(unloaded)) return 1;
    const answer = ask();
    if (!answer) return 1;
    // A daemon the supervisor is already running is not started again — and is
    // not a start to wait for, which would be a wait for nothing.
    if (answer.loaded && processRunning(platform, answer.lines)) {
      log(
        "the supervisor is already running a daemon, so nothing was started — and nothing was confirmed either: that process " +
          "may have lost the lock and be taking no work. lingtai doctor says who holds the lock",
      );
      return 0;
    }
    if (platform === "systemd") return startAndConfirm(["systemctl", "--user", "start", SYSTEMD_UNIT]);
    // `shutdown` unloads, and `kickstart` cannot find a job that is not loaded.
    // Plain `kickstart` starts a loaded job that is not running and leaves a
    // running one alone, which is `systemctl start`. A job unloaded and loaded
    // again, not `kickstart -k`, is also what applies a rewritten plist.
    return startAndConfirm(answer.loaded ? ["launchctl", "kickstart", target] : ["launchctl", "bootstrap", `gui/${uid}`, file.path]);
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
      // The database is what the drain goes through, and it is also what a
      // daemon needs to hold the lock or claim anything. So when it cannot be
      // reached — a paused project, a wrong URL, and the supervisor restarting
      // copy after copy that fails to connect — the supervisor is asked instead
      // whether a process is running at all. A moment with none is a moment
      // with no pass for its signal to kill, and the unload goes ahead then.
      log(`the conductor lock could not be queued for — ${queue.message}.`);
      log(`asking the supervisor whether a daemon is running, for up to ${IDLE_WAIT_POLLS}s: with none, there is no pass to drain`);
      for (let i = 0; i < IDLE_WAIT_POLLS; i++) {
        const now = ask();
        if (!now) return 1;
        if (!now.loaded) {
          log(`the supervisor no longer has ${platform === "launchd" ? LAUNCHD_LABEL : SYSTEMD_UNIT} loaded — nothing to drain or unload`);
          return 0;
        }
        if (!processRunning(platform, now.lines)) {
          log("the supervisor has no daemon running, so nothing holds the conductor lock or a pass — stopped without the drain");
          const stopped = platform === "launchd" ? await unload() : run(["systemctl", "--user", "stop", SYSTEMD_UNIT]);
          return stopped ? 0 : 1;
        }
        await sleep(1_000);
      }
      error(`a daemon stayed running for ${IDLE_WAIT_POLLS}s while the conductor lock could not be queued for. Nothing was stopped:`);
      error("it may be in a pass the supervisor's signal would kill, and without a place in the lock's queue the copy started after a drain could take work that the unload kills.");
      error(
        platform === "launchd"
          ? `To stop it regardless, and kill whatever it is running: launchctl bootout ${target}`
          : `To stop it regardless, and kill whatever it is running: systemctl --user stop ${SYSTEMD_UNIT}`,
      );
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
      // Both files before either supervisor call, so systemd's one
      // `daemon-reload` below covers the board's unit as well as the daemon's.
      if ("missing" in servable) {
        log(`note  no board job was written — ${servable.missing}`);
        log("      the conductor's job is installed; run this again once there is a board to serve");
      } else {
        await mkdir(dirname(boardFile.path), { recursive: true });
        await writeFile(boardFile.path, boardFile.content);
        log(`wrote ${boardFile.path}`);
        log(`logs  ${join(boardFile.logs, "board.log")}`);
      }

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
        } else if ((await startAndConfirm(["launchctl", "bootstrap", `gui/${uid}`, file.path])) !== 0) {
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
        } else if ((await startAndConfirm(["systemctl", "--user", "start", SYSTEMD_UNIT])) !== 0) {
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
      if (!("missing" in servable)) {
        const boardCode = await installBoard();
        if (boardCode !== 0) return boardCode;
      }
      log("");
      const code = await report();
      // After the start's record, so the beacon has had its first beat — but a
      // beacon is five seconds apart, and the record is what said it started.
      if (started) log("the beacon above may be one beat behind the start recorded before it — pnpm lingtai service status");
      return code;
    }

    case "start": {
      if (!installed) return notInstalled();
      const started = await start();
      if (started !== 0) return started;
      // **This verb's exit code is the conductor's, as `shutdown`'s is.**
      // `lingtai restart` reads a non-zero here as *the daemon did not start*
      // and returns without `startRefusals` — the check that the daemon now
      // running is the commit it examined (`restart.ts:1093`). A board that
      // never answered would take that check with it and report a conductor
      // that started fine as a restart that failed. The board's own outcome is
      // said above, in its own words, and `service status` reports the two
      // jobs separately for exactly this reason. `install` is the other way
      // about: nothing chains off it, and a board nobody can reach is worth
      // refusing at the moment somebody is installing one.
      await startBoard();
      return 0;
    }

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
      // **The board's stop is the board's, and never the drain's.** A board job
      // that will not boot out used to return from here — before `start(kept)`
      // — so a board-only failure left the conductor drained and unloaded, and
      // `lingtai restart`, which reads a non-zero `service shutdown` as "the
      // drain above did not finish", started nothing and blamed a drain that
      // had finished (restart.ts:1068). The conductor's outcome is this verb's
      // exit code, as an absent board job already is; the board's is said here
      // in its own words.
      const boardStopped = await stopBoard();
      if (boardStopped !== 0) {
        error(`the board's job could not be stopped — the conductor's drain finished, and this is not that.`);
        error(`It is still whatever the supervisor has of it: pnpm lingtai service status, then pnpm lingtai service restart.`);
      }
      if (verb === "shutdown") return 0;
      const started = await start(kept);
      if (started !== 0) return started;
      return startBoard();
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
      // **The board's job is removed whether or not the daemon's file is still
      // there**, so this sits in front of the `!installed` note and not behind
      // it. Behind it, a first `uninstall` whose board bootout failed — a
      // transient `Boot-out failed: 36: Operation now in progress`, or the 60s
      // `unload` — had already removed the daemon's file, so the obvious second
      // run found `installed` false, printed `nothing at …daemon.plist` and
      // exited 0 over a board job still loaded and still starting at every
      // login. An `uninstall` that reports success names everything it left.
      const boardWritten = existsSync(boardFile.path);
      if (installed) await rm(file.path, { force: true });
      const boardCode = await uninstallBoard();
      if (platform === "systemd" && (installed || boardWritten) && !run(["systemctl", "--user", "daemon-reload"])) return 1;
      if (!installed) {
        log(`nothing at ${file.path}${answer.loaded ? ", and the job it named is unloaded" : ""}`);
        return boardCode;
      }
      log(`removed ${file.path} (logs kept in ${file.logs})`);
      return boardCode;
    }
  }
}
