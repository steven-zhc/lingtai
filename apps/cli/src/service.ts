/**
 * `lingtai service` — the supervisor around the two processes, per platform
 * (#50, #187).
 *
 * `lingtai daemon` and `lingtai board start` are the processes and stay exactly
 * what they were: foreground processes that run until they are told to stop.
 * This file writes the things that keep them running — a LaunchAgent each on
 * macOS, a systemd **user** unit each on Linux — and passes start, stop and
 * status through to them. It replaces `scripts/launchd.sh`, and installs the
 * daemon under the same label.
 *
 * ## Two jobs, and the CLI does not become a supervisor (#187)
 *
 * `launchd` supervises two jobs as easily as one, so there are two: `JOBS`, and
 * `Job` is everything that differs between them. Merging the board into the
 * daemon to avoid supervising two would be this file taking on exactly the role
 * the next paragraph declines.
 *
 * **Each job is reported on its own.** One summary saying *running* would hide
 * a board that is up beside a conductor launchd respawns every thirty seconds,
 * which is the failure two jobs make likelier rather than rarer.
 *
 * **The board gets `stop` and never `shutdown`.** `shutdown` here means *finish
 * the pass in flight*, and waits as long as `runtime.limits.wall`. A board has
 * no pass to finish, so a verb that waited for one would make somebody wait for
 * nothing — or believe the conductor was draining when it was not.
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
import { repoRoot, stateDir } from "@lingtai/env";
import { WALL_LIMIT } from "./wall-limit.ts";

/** Unchanged from `scripts/launchd.sh`, so the agent it installed is the one this replaces. */
export const LAUNCHD_LABEL = "ai.nextloom.lingtai.daemon";
export const SYSTEMD_UNIT = "lingtai.service";

/** The board's, beside it (#187). A second job, never a second definition of the first. */
export const BOARD_LAUNCHD_LABEL = "ai.nextloom.lingtai.board";
export const BOARD_SYSTEMD_UNIT = "lingtai-board.service";

export type ServicePlatform = "launchd" | "systemd";

/**
 * One of the two jobs this installs (#187), and everything that differs
 * between them.
 *
 * **A field rather than a shared comment block.** The daemon's file says why
 * `KillMode=process` and why no `TimeoutStopSec` — both about the agent it
 * detaches and the pass it drains — and neither is true of the board, which
 * serves in its own process and has nothing to finish. A generated file is the
 * first thing anybody reads when a job did not come back, so each one carries
 * its own reasons or none.
 */
export interface Job {
  id: "daemon" | "board";
  /** launchd's label. */
  label: string;
  /** systemd's unit file name. */
  unit: string;
  /** What `lingtai.ts` is asked to do. */
  argv: readonly string[];
  /** `<logs>/<log>.log` and `.err`. */
  log: string;
  /** systemd's `Description=`, and what `service status` calls this job. */
  what: string;
  /**
   * Why the supervisor's own stop timeout is left at its default, in each
   * supervisor's own words. Both are true of the daemon and neither is true of
   * the board, so the text is the job's rather than the file's.
   */
  stopNote: { launchd: readonly string[]; systemd: readonly string[] };
  /** systemd's `KillMode=`, or null to leave the default, with why either way. */
  kill: { mode: string; why: string } | null;
}

export const DAEMON_JOB: Job = {
  id: "daemon",
  label: LAUNCHD_LABEL,
  unit: SYSTEMD_UNIT,
  argv: ["daemon"],
  log: "daemon",
  what: "Lingtai daemon",
  stopNote: {
    launchd: [
      "No ExitTimeOut, deliberately: launchd's 20 seconds stands. Set to the",
      "wall limit it would make bootout, logout and machine shutdown block",
      "for an hour. The pass is waited for through the log instead —",
      "lingtai service shutdown drains first and unloads after (#174).",
    ],
    systemd: [
      "No TimeoutStopSec, deliberately: systemd's 90s stands. The wall limit here",
      "would make logout and machine shutdown block for an hour. The pass is waited",
      "for through the log — lingtai service shutdown drains first, stops after (#174).",
    ],
  },
  // The default kills the whole cgroup, agent included. 0030 put the agent in
  // its own process group so the signal that begins a drain does not kill the
  // run being drained; launchd signals only the daemon, and this is systemd
  // doing the same.
  kill: { mode: "process", why: "Signal the daemon, not the agent it detached (0030)." },
};

export const BOARD_JOB: Job = {
  id: "board",
  label: BOARD_LAUNCHD_LABEL,
  unit: BOARD_SYSTEMD_UNIT,
  // `--no-open`: nobody is at a browser when launchd starts this at login, and
  // a job that crash-loops would open a tab every thirty seconds.
  argv: ["board", "start", "--no-open"],
  log: "board",
  what: "Lingtai board",
  stopNote: {
    launchd: [
      "No ExitTimeOut: launchd's 20 seconds is far more than this needs. The",
      "board serves in this process and detaches nothing, so there is no pass to",
      "finish and no drain to wait for — which is why the board gets stop and",
      "not shutdown (#187).",
    ],
    systemd: [
      "No TimeoutStopSec: systemd's 90s is far more than this needs. The board serves",
      "in this process and detaches nothing, so there is no pass to finish and no drain",
      "to wait for — which is why the board gets stop and not shutdown (#187).",
    ],
  },
  // Nothing to spare from the signal: `lingtai board start` serves the built
  // board inside its own process, so the default group kill takes the server
  // and nothing else.
  kill: null,
};

export const JOBS: readonly Job[] = [DAEMON_JOB, BOARD_JOB];

/**
 * `service shutdown`'s exit where **the conductor drained and unloaded and the
 * board's job did not stop** (#187).
 *
 * Two legs report through one number, and its one other caller reads that
 * number as a single fact: `lingtai restart` under a supervisor delegates the
 * drain to `service shutdown`, and a non-zero there means *nothing was started:
 * the drain above did not finish*. A `launchctl bootout` that answers
 * `Boot-out failed: 36: Operation now in progress` — the ordinary way a job
 * mid-start refuses one — used to end there: the daemon drained and unloaded,
 * the restart abandoned, the conductor down and unsupervised, the operator told
 * the wrong reason and pointed at the wrong job.
 *
 * So the two answers stay two. Non-zero, because a verb that did not do what it
 * says did not succeed, and distinguishable, because the drain is what its
 * caller asked about.
 */
export const SHUTDOWN_BOARD_ONLY = 3;

/**
 * The exit of `start`, `restart` and `install` where **every leg of the
 * conductor's did what it says and the board's did not** (#187): the daemon
 * started and recorded it, and the board's job would not start, or nothing
 * answers on its port, or the supervisor could not be asked about it.
 *
 * The other half of `SHUTDOWN_BOARD_ONLY`, made for the same caller and against
 * the same mistake. `lingtai restart` under a supervisor delegates its start to
 * `service start` and reads that number as *did the conductor start*: a 1 there
 * means no daemon recorded one, and the restart stops on it — without reading
 * the record back, without `startRefusals` (the #167 check that the daemon
 * running is the commit the guards examined and that no shutdown landed during
 * the start), and without its confirmation. A board whose port a squatter holds
 * used to end there: the daemon up, supervised and claiming tickets, the last
 * thing on screen the board's failure, `lingtai restart` exiting non-zero, and
 * the operator sent back to drain a healthy daemon for an hour and get the same
 * answer.
 *
 * Non-zero, because a verb that did not do all it says did not succeed, and
 * distinguishable, because the conductor is what its caller asked about.
 */
export const START_BOARD_ONLY = 4;

/**
 * Not an exit code: `start`'s own answer for **a shutdown request stands, so
 * nothing was started or stopped**, told apart from the 1 of a start that was
 * made and failed.
 *
 * The refusal's own last sentence is *Nothing was started or stopped*, and
 * `service start` runs the board's leg after the daemon's — so without this it
 * printed that sentence and then bootstrapped the board's job under it. It
 * never leaves `serviceCommand`: the two call sites answer 1 for it, which is
 * what `install` and `restart` already return in the same case.
 */
const REFUSED_OVER_SHUTDOWN = -1;

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
export function launchdPlist(inputs: ServiceInputs, job: Job = DAEMON_JOB): ServiceFile {
  const logs = join(stateDir(inputs.env), "logs");
  const env = Object.entries(serviceEnv(inputs))
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const argv = [join(inputs.root, "apps/cli/src/lingtai.ts"), ...job.argv]
    .map((a) => `    <string>${xml(a)}</string>`)
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
${argv}
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

  <!-- ${job.stopNote.launchd.join("\n       ")} -->

  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>

  <key>StandardOutPath</key>
  <string>${xml(join(logs, `${job.log}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, `${job.log}.err`))}</string>
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
 * - `KillMode=` is the job's, with its reason — `process` for the daemon,
 *   because the default kills the whole cgroup and the agent 0030 detached with
 *   it, and systemd's own default for the board, which detaches nothing.
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
Description=${job.what}
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${[inputs.node, join(inputs.root, "apps/cli/src/lingtai.ts"), ...job.argv].join(" ")}
WorkingDirectory=${inputs.root}
${Object.entries(vars)
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join("\n")}
# launchd's KeepAlive: crash, logout, reboot — it comes back.
Restart=always
# launchd's ThrottleInterval.
RestartSec=30
${job.kill ? `# ${job.kill.why}\nKillMode=${job.kill.mode}\n` : ""}# ${job.stopNote.systemd.join("\n# ")}
StandardOutput=append:${join(logs, `${job.log}.log`)}
StandardError=append:${join(logs, `${job.log}.err`)}

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
 *
 * Exported because `lingtai board stop` runs the same `bootout` against the
 * board's job and has to wait past the same early return (#187) — one estimate
 * of one thing.
 */
export const UNLOAD_WAIT_MS = 60_000;

/**
 * Seconds `service shutdown` watches the supervisor for a moment with no daemon
 * running, when the database the drain goes through cannot be reached. Longer
 * than two of the 30-second restarts either supervisor is given, so a copy that
 * crash-loops on the connection is seen between two starts.
 */
const IDLE_WAIT_POLLS = 90;

/**
 * How long a start waits for the board to answer. Next's standalone server binds
 * in a second or two on a warm machine; this is long enough for a cold one and
 * past two of the supervisor's thirty-second restarts, and far short of the
 * daemon's, which waits on a reconcile that talks to GitHub.
 *
 * **A clock and a poll count, because either alone lies.** The count alone was
 * the wait: 75 asks, a second apart, said to be 75 seconds — and an `answering`
 * that carries its own five-second timeout makes each ask cost six against
 * something that accepts TCP and never replies, so the command sat for seven
 * and a half minutes having stated 75 seconds. The clock alone would make a
 * test with an instant `answering` and a no-op `sleep` spin for 75 real
 * seconds. So the count bounds the asks and the clock bounds the wait; an ask
 * already in flight when the deadline passes is not cut short.
 *
 * Exported because `lingtai board restart` waits for the same Next standalone
 * boot and had its own ten seconds for it — two estimates of one thing, and a
 * cold machine reported failure for a board that came up seconds later (#187).
 */
export const BOARD_WAIT_MS = 75_000;
const BOARD_WAIT_POLLS = 75;

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
   * The board job's own two facts, beside the daemon's (#187): where it should
   * answer, and whether a Lingtai board does. Injected for the reason `liveness`
   * is — this file holds no HTTP client and loads without a board.
   *
   * **`answering` is the board's `ConductorStarted`.** A job launchd has loaded
   * is not a UI anybody can open, exactly as a loaded daemon is not a daemon
   * taking work, so no verb here concludes the second from the first.
   */
  board: {
    /**
     * Where a board would answer. The default's address where the port could
     * not be read at all — `missing` carries that, and nothing here serves on
     * a number nobody chose.
     */
    url: string;
    answering: () => Promise<string | null>;
    /**
     * Why `lingtai board start` would serve nothing on this machine, and what
     * to do about it — or null where it would serve a board.
     *
     * **Asked before a job is written, and that is the whole of it.** The job
     * runs `<root>/apps/cli/src/lingtai.ts board start` — from the source, and
     * `keeper` asserts exactly that path — while `board start` serves what
     * `pnpm build` wrote. On a checkout nobody has built there is no board, a
     * job installed over that exits at once, and `KeepAlive`/`Restart=always`
     * respawn it every thirty seconds for ever. So it is not installed, and
     * the reason is said instead: a supervisor with no job is a board that is
     * missing, which is true, and better than one that crash-loops.
     *
     * **`remedy` is the job of the caller and not of this file**, because the
     * reasons differ: an unbuilt checkout wants `pnpm build`, and a `board.port`
     * that is not a port number wants the line taken out of `config.yml`. A
     * board that cannot be served is never a refusal of the verb — the conductor
     * is drained, unloaded or started either way, and a UI setting does not
     * hold up the drain.
     */
    missing: () => { why: string; remedy: readonly string[] } | null;
    /**
     * Who holds the board's port lock, or null when nobody does — the key
     * `lingtai board start` takes, read without taking it.
     *
     * **Asked before the supervisor is told to start the board.** A board
     * somebody started in a terminal holds that lock, so the job would be
     * refused by it, exit 1 at once, and be respawned every thirty seconds for
     * ever — while `answering` found that same terminal board on the URL and
     * called the start good. Throws where the lock cannot be read: *unread* is
     * not *nobody*, and a start over an unread lock is the crash loop again.
     */
    heldBy: () => Promise<string | null>;
  };
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
  /**
   * The clock a wait is measured against, beside the `sleep` it is spent in.
   * A wait that says how long it is has to be both: see `BOARD_WAIT_MS`.
   */
  now?: () => number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Whether launchd or systemd keeps a job here, as `lingtai restart` needs to know it (0042 §8). */
export type Keeper =
  /** No supervisor has the job, or none exists here: whoever restarts starts it. */
  | { kept: false }
  /** The supervisor has it, and it runs this checkout. The start is the supervisor's. */
  | { kept: true; platform: ServicePlatform; path: string; uid: number }
  /** It could not be told, or the unit runs a different checkout. Refused before anything stops. */
  | { unread: string };

/**
 * Whether a supervisor keeps `job`, asked before a restart stops anything.
 *
 * **Kept means the supervisor would start one again by itself** — the job is
 * loaded under launchd, or the unit is active or restarting under systemd. A
 * file that is on disk after `service shutdown` is not a keeper: nothing will start
 * from it, and the process somebody is restarting is in a terminal.
 *
 * A unit written from another checkout is refused rather than started: the
 * restart would check this checkout's commit and the supervisor would start
 * that one's.
 */
export function keeper(
  options: Pick<ServiceOptions, "platform" | "env" | "root" | "uid" | "exec" | "which"> = {},
  job: Job = DAEMON_JOB,
): Keeper {
  const platform = platformFor(options.platform ?? process.platform);
  const which = options.which ?? whichBin;
  if (!platform || !which(platform === "launchd" ? "launchctl" : "systemctl")) return { kept: false };
  const env = options.env ?? process.env;
  const root = options.root ?? repoRoot();
  const uid = options.uid ?? process.getuid?.() ?? 0;
  let path: string;
  try {
    path = (platform === "launchd" ? launchdPlist : systemdUnit)({ node: "node", root, env }, job).path;
  } catch {
    // A HOME-less environment, or a checkout path systemd cannot carry: `service
    // install` refuses both, so nothing was installed from here to keep it.
    return { kept: false };
  }
  if (!existsSync(path)) return { kept: false };

  const answer = askSupervisor(platform, options.exec ?? execCall, uid, job);
  if ("unread" in answer) return { unread: `could not ask the supervisor whether it keeps the ${job.id} — ${answer.unread}` };
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
  return { kept: true, platform, path, uid };
}

export async function serviceCommand(args: string[], options: ServiceOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const exec = options.exec ?? execCall;
  const which = options.which ?? whichBin;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
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
  const fileFor = (job: Job): ServiceFile => (platform === "launchd" ? launchdPlist(inputs, job) : systemdUnit(inputs, job));
  let file: ServiceFile;
  let boardFile: ServiceFile;
  try {
    file = fileFor(DAEMON_JOB);
    boardFile = fileFor(BOARD_JOB);
  } catch (err) {
    error((err as Error).message);
    return 1;
  }
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
  const boardTarget = `gui/${uid}/${BOARD_JOB.label}`;
  const named = (job: Job): string => (platform === "launchd" ? job.label : job.unit);

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
  const askJob = (job: Job): { loaded: boolean; lines: string[] } | null => {
    const answer = askSupervisor(platform, exec, uid, job);
    if ("unread" in answer) {
      error(
        job.id === "daemon"
          ? `could not ask the supervisor about the service — ${answer.unread}`
          : `could not ask the supervisor about the board's job — ${answer.unread}`,
      );
      noUserManager(answer.unread);
      return null;
    }
    return answer;
  };
  const ask = () => askJob(DAEMON_JOB);

  /**
   * `bootout` returns while the job is still going, and a `bootstrap` in that
   * window fails — so wait until launchd says it is gone.
   */
  const unloadJob = async (job: Job): Promise<boolean> => {
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
  const unload = () => unloadJob(DAEMON_JOB);

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

  // ------------------------------------------------------------ the board --
  //
  // The second job (#187), and everything below is deliberately shorter than
  // the daemon's. The board takes no place in the conductor lock's queue,
  // claims no ticket and finishes no pass, so its stop is the supervisor's
  // signal and nothing waits on the log for it — which is why it is `stop` and
  // never `shutdown`. (It does hold a lock of its own, per port, so that
  // `lingtai board stop` has a pid to signal; nothing here reads it.)

  const boardInstalled = (): boolean => existsSync(boardFile.path);

  /**
   * Said wherever a board job would have been written or started, and there is
   * no board for it to serve. Not a refusal: the verb was about the conductor,
   * and the conductor is fine.
   */
  const sayNoBoard = (missing: { why: string; remedy: readonly string[] }, what: "written" | "started"): void => {
    log(`${missing.why}, so no board job was ${what}`);
    for (const line of missing.remedy) log(`      ${line}`);
  };

  /** Whether a Lingtai board answers where it should — the board's own word, not the supervisor's. */
  const boardAnswers = async (): Promise<string | null | { unread: string }> => {
    try {
      return await options.board.answering();
    } catch (err) {
      return { unread: (err as Error).message };
    }
  };

  /** Waits for a board to answer after a start. False when none did, having said so. */
  const confirmBoard = async (): Promise<boolean> => {
    const seconds = BOARD_WAIT_MS / 1000;
    log(`waiting for the board to answer on ${options.board.url} — up to ${seconds}s. It is waiting, not hung.`);
    // The clock as well as the count: an `answering` that waits out its own
    // timeout on every ask makes 75 of them far longer than the 75 seconds
    // said above, and a wait that outlives its own sentence looks hung.
    const until = now() + BOARD_WAIT_MS;
    let unread: string | null = null;
    for (let i = 0; i < BOARD_WAIT_POLLS; i++) {
      if (i > 0 && now() >= until) break;
      const asked = await boardAnswers();
      if (typeof asked === "string") {
        log(`the board answers on ${asked}`);
        return true;
      }
      unread = asked === null ? null : asked.unread;
      await sleep(1_000);
    }
    error(
      unread === null
        ? `the supervisor accepted the board's start, and nothing answered on ${options.board.url} in ${seconds}s — so the UI is not up on its account.`
        : `the supervisor accepted the board's start, and ${options.board.url} could not be asked whether a board answers — ${unread}.`,
    );
    error(`${join(boardFile.logs, `${BOARD_JOB.log}.err`)} is what the job wrote; a port somebody else holds is named there in words.`);
    return false;
  };

  /** The supervisor's start for the board job, then the board's own answer. */
  const startBoard = async (): Promise<number> => {
    // Before the job is asked about: a checkout that has never been built has
    // no board to serve, and starting a job over that is the crash loop this
    // command exists to keep off the machine.
    const missing = options.board.missing();
    if (missing !== null) {
      sayNoBoard(missing, "started");
      return 0;
    }
    if (!boardInstalled()) {
      // An install from before the board had a job (#187), and not a failure of
      // whatever verb is running: the daemon it was really about did start.
      log(`no board job at ${boardFile.path}, so nothing was started for the board — pnpm lingtai service install writes one`);
      return 0;
    }
    const answer = askJob(BOARD_JOB);
    if (!answer) return 1;
    if (answer.loaded && processRunning(platform, answer.lines)) {
      // Not started again, and not confirmed either — the same rule the daemon's
      // start follows. A process the supervisor is running may be failing to
      // bind, and `service status` is where that shows.
      log("the supervisor has a process for the board's job, so nothing was started for it — and nothing confirmed either: service status says whether a board answers");
      return 0;
    }
    // The port, before the supervisor is told anything. The lock is held by a
    // board this machine is serving, and the supervisor has just said the
    // process is not its job's — so it is a terminal's. Bootstrapped over that,
    // the job is refused by the lock, exits 1, and is respawned every thirty
    // seconds for ever, while `confirmBoard` finds the terminal's board on the
    // same URL and calls the start good. That is the one state two jobs make
    // likelier, and the only place that can see it coming.
    let holder: string | null;
    try {
      holder = await options.board.heldBy();
    } catch (err) {
      error(`the board lock could not be read — ${(err as Error).message}. Nothing was started for the board:`);
      error("a board already on the port would make the supervisor's job exit at once, and be respawned every thirty seconds for ever");
      return 1;
    }
    if (holder !== null) {
      error(`a board is already on ${options.board.url}, and it is not the supervisor's — held by ${holder}`);
      error("nothing was started for the board: that lock would refuse the job, which would exit and be respawned every thirty seconds for ever");
      error("pnpm lingtai board stop stops that one, and pnpm lingtai service start hands the board to the supervisor");
      return 1;
    }
    if (platform === "systemd") {
      if (!run(["systemctl", "--user", "start", BOARD_SYSTEMD_UNIT])) return 1;
    } else if (!run(answer.loaded ? ["launchctl", "kickstart", boardTarget] : ["launchctl", "bootstrap", `gui/${uid}`, boardFile.path])) {
      return 1;
    }
    return (await confirmBoard()) ? 0 : 1;
  };

  /**
   * The supervisor's stop for the board job — a signal, and that is the whole
   * of it. There is no drain: nothing is in flight to lose, and a verb that
   * waited would be `shutdown` wearing the board's name.
   */
  const stopBoard = async (): Promise<number> => {
    const answer = askJob(BOARD_JOB);
    if (!answer) return 1;
    if (!answer.loaded) {
      log(`the supervisor is not running ${named(BOARD_JOB)} — nothing of its to stop`);
      return 0;
    }
    const stopped = platform === "launchd" ? await unloadJob(BOARD_JOB) : run(["systemctl", "--user", "stop", BOARD_SYSTEMD_UNIT]);
    if (!stopped) {
      error(`the supervisor did not stop ${named(BOARD_JOB)} — the board may still be answering on ${options.board.url}`);
      return 1;
    }
    log(`stopped ${named(BOARD_JOB)}`);
    return 0;
  };

  /**
   * One job stopped, unloaded and removed. `drains` is the daemon's alone: it
   * is the one with a pass in flight, and `bootout` on its own would kill it
   * (#174). The board has nothing to finish, so its own stop is the signal.
   */
  const uninstallJob = async (job: Job, jobFile: ServiceFile, drains: boolean): Promise<number> => {
    const answer = askJob(job);
    if (!answer) return 1;
    let code = 0;
    if (answer.loaded) {
      const kept =
        platform === "launchd" || !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed");
      if (kept && drains) {
        const drained = await drain();
        if (drained !== 0) return drained;
      } else if (kept && platform === "launchd" && !(await unloadJob(job))) {
        error(`${job.label} is still loaded — ${jobFile.path} is left in place, since removing it would leave a job nothing can name`);
        return 1;
      }
      // The drain, or the unload above, took a launchd job; a systemd unit is
      // stopped and still enabled.
      //
      // **A `disable --now` that failed keeps the file**, exactly as the
      // launchd branch above does. Removing it and reloading leaves the unit
      // `not-found` while the process is still running, so nothing can name it
      // to stop it — a worse end than the one this verb was asked for.
      if (platform === "systemd" && !run(["systemctl", "--user", "disable", "--now", job.unit])) {
        error(`${job.unit} is still loaded — ${jobFile.path} is left in place, since removing it would leave a job nothing can name`);
        return 1;
      }
    }
    if (!existsSync(jobFile.path)) {
      log(`nothing at ${jobFile.path}${answer.loaded ? ", and the job it named is unloaded" : ""}`);
      return code;
    }
    await rm(jobFile.path, { force: true });
    if (platform === "systemd" && !run(["systemctl", "--user", "daemon-reload"])) code = 1;
    log(`removed ${jobFile.path} (logs kept in ${jobFile.logs})`);
    return code;
  };

  /** The board's two answers, beside the daemon's two and folded into neither. */
  const reportBoard = async (): Promise<number> => {
    log(`supervisor  (${platform === "launchd" ? `launchctl, ${boardTarget}` : `systemctl --user, ${BOARD_SYSTEMD_UNIT}`})`);
    const answer = askSupervisor(platform, exec, uid, BOARD_JOB);
    const lines = "unread" in answer ? [`could not ask — ${answer.unread}`] : answer.lines;
    for (const l of lines.length > 0 ? lines : ["loaded, and said nothing about the process"]) log(`  ${l}`);
    log(`board       (${options.board.url} — whether a board answers there, which loaded does not say)`);
    const asked = await boardAnswers();
    log(`  ${typeof asked === "string" ? `answers on ${asked}` : asked === null ? "nothing answers" : `could not ask — ${asked.unread}`}`);
    // Where there is no board to serve, the address above is the default's and
    // nothing is on it — said here, or a `board.port` that is not a port number
    // reads as a board that is merely down.
    const missing = options.board.missing();
    if (missing !== null) {
      log(`  ${missing.why}, so this machine has no board job to keep`);
      for (const line of missing.remedy) log(`  ${line}`);
    }
    return "unread" in answer ? 1 : 0;
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

  /**
   * The supervisor's start, refused while a shutdown request stands, and
   * confirmed by the daemon's record.
   *
   * The refusal answers `REFUSED_OVER_SHUTDOWN` and not 1, so that a caller can
   * tell *nothing was started* from *the start failed*: the sentence it prints
   * is **Nothing was started or stopped**, and `service start` going on to
   * bootstrap the board's job under it would make that false in the same
   * output. Never returned from `serviceCommand` — both call sites below turn
   * it into the 1 the operator sees.
   */
  const start = async (unloaded = false): Promise<number> => {
    if (await shutdownStands(unloaded)) return REFUSED_OVER_SHUTDOWN;
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
    case "status": {
      // Two jobs, two reports, and never one summary: a board that is up beside
      // a conductor launchd respawns every thirty seconds is the exact state a
      // single word for both would hide.
      log("the conductor");
      const daemon = await report();
      log("");
      log("the board");
      const board = await reportBoard();
      return daemon !== 0 ? daemon : board;
    }

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
      // The board's file is written only where there is a board to serve. A
      // plist for `board start` on an unbuilt checkout is a job that exits at
      // once and is respawned every thirty seconds for ever, and this command
      // is the one place that can see it coming.
      const noBoard = options.board.missing();
      // Both files before either job is touched: under systemd one
      // `daemon-reload` then has both units to read, and a refusal below leaves
      // two files written and nothing loaded, which is what it says.
      await writeFile(file.path, file.content);
      if (noBoard === null) await writeFile(boardFile.path, boardFile.content);
      log(`wrote ${file.path}`);
      if (noBoard === null) {
        log(`wrote ${boardFile.path}`);
        log(`logs  ${join(file.logs, `${DAEMON_JOB.log}.log`)} and ${join(boardFile.logs, `${BOARD_JOB.log}.log`)}`);
      } else {
        log(`logs  ${join(file.logs, `${DAEMON_JOB.log}.log`)}`);
        sayNoBoard(noBoard, "written");
      }

      if (platform === "launchd") {
        const before = ask();
        if (!before) {
          error("the files are written and nothing was loaded");
          return 1;
        }
        if (before.loaded) {
          // Not reloaded: that would signal a pass in flight. launchd reads the
          // plist only when it loads the job — a KeepAlive respawn reuses the
          // definition already loaded — so this file is not in effect yet.
          log(`note  launchd already had ${LAUNCHD_LABEL} loaded, and keeps using the definition it loaded,`);
          log("      respawns included, until: pnpm lingtai service restart");
        } else if (await shutdownStands()) {
          error("the files are written and nothing was loaded");
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
          error("the units are written, the daemon's is enabled, and nothing was started");
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

      // The board's job, after the daemon's and never instead of it: everything
      // above refuses by returning, and each of those refusals says that nothing
      // was loaded — which a board loaded first would make false.
      //
      // A standing shutdown request is one of those returns, above, under *the
      // files are written and nothing was loaded* — so no board job is started
      // under that sentence here, and none is in `start` below either.
      // A failure here is the board's and exits as the board's: returning 1
      // gave the conductor's number to a conductor that had installed, started
      // and recorded its start, and skipped both reports on the way out, so
      // nothing on screen said the daemon was up (#187).
      const boardEnabled =
        noBoard !== null || platform !== "systemd" || run(["systemctl", "--user", "enable", BOARD_SYSTEMD_UNIT]);
      if (!boardEnabled) error(`${BOARD_SYSTEMD_UNIT} could not be enabled, so nothing was started for the board`);
      // Said once, above, where there is nothing to serve — so the start is not
      // asked to say it again.
      const boardCode = noBoard === null && boardEnabled ? await startBoard() : 0;

      log("");
      log("the conductor");
      const code = await report();
      // After the start's record, so the beacon has had its first beat — but a
      // beacon is five seconds apart, and the record is what said it started.
      if (started) log("the beacon above may be one beat behind the start recorded before it — pnpm lingtai service status");
      log("");
      log("the board");
      const boardReport = await reportBoard();
      // Every leg of the conductor's has returned above or is `code`; the three
      // left are the board's alone, and say so by their number.
      return code !== 0 ? code : !boardEnabled || boardCode !== 0 || boardReport !== 0 ? START_BOARD_ONLY : 0;
    }

    case "start": {
      if (!installed) return notInstalled();
      const daemon = await start();
      // A standing shutdown request refuses both legs, and that is the one
      // failure of the daemon's that stops the board's start: the refusal says
      // *Nothing was started or stopped*, so a `launchctl bootstrap` of the
      // board's job after it would contradict it in the same output. `install`
      // and `restart` both return before their board start in that case.
      if (daemon === REFUSED_OVER_SHUTDOWN) return 1;
      // Otherwise both legs run — a `service start` that exited 0 over a board
      // nobody can open is the claim #167 took out of the daemon's start — and
      // the number says which one failed, since `lingtai restart` asks this
      // about the conductor. The daemon's answer wins where both failed: *the
      // board did not come up* is not a thing to tell a restart whose daemon
      // never started either.
      const board = await startBoard();
      return daemon !== 0 ? daemon : board === 0 ? 0 : START_BOARD_ONLY;
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
      // The board goes last, both ways, and the order is the daemon's refusals.
      // On the way down the UI is what watches the drain, and it is worth
      // having through it. On the way up `start` may still refuse over a
      // request that landed during the wait, and its refusal says *nothing was
      // started* — which a board started first would make false.
      const boardStopped = await stopBoard();
      // The drain finished; the board's job is its own answer, and never the
      // drain's. `lingtai restart` reads this number as *did the conductor
      // stop*, so a board the supervisor would not bootout exits
      // `SHUTDOWN_BOARD_ONLY` — non-zero, since the verb did not do all it
      // says, and not 1, since the conductor is drained and unloaded and a
      // restart has no reason to abandon its start over the UI.
      if (verb === "shutdown") return boardStopped === 0 ? 0 : SHUTDOWN_BOARD_ONLY;
      const daemonStarted = await start(kept);
      // The sentinel stays inside this file: what a refused start is worth to
      // anybody outside is 1.
      if (daemonStarted !== 0) return daemonStarted === REFUSED_OVER_SHUTDOWN ? 1 : daemonStarted;
      const boardStarted = await startBoard();
      // The conductor drained, unloaded, started and recorded it; both numbers
      // left are the board's, and one exit says that rather than reading like a
      // restart that failed.
      return boardStarted !== 0 || boardStopped !== 0 ? START_BOARD_ONLY : 0;
    }

    case "uninstall": {
      /**
       * **Both legs run, whatever either answers, and the worst is returned.**
       * Every other verb stops at its first refusal; this one must not. A
       * `service uninstall` that gave up at the daemon — because its file was
       * already gone, or its unload failed — used to exit 0 with the board's job
       * still loaded and its plist still on disk, and launchd went on starting a
       * board at every login under a command that reported success. The whole
       * point of the verb is that nothing is left behind, so nothing is skipped
       * and anything that could not be removed is named.
       */
      const daemonGone = await uninstallJob(DAEMON_JOB, file, true);
      const boardGone = await uninstallJob(BOARD_JOB, boardFile, false);
      return daemonGone !== 0 ? daemonGone : boardGone;
    }
  }
}
