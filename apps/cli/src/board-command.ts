/**
 * `lingtai board start|stop|restart|status` — the UI's lifecycle (#187).
 *
 * Twenty-eight commands and not one started the board: it was
 * `pnpm --filter @lingtai/board dev`, which an installed Lingtai cannot run. So
 * the board gets what the conductor has, under verbs that mean what they say.
 *
 * **`stop`, not `shutdown`.** `shutdown` means *finish the pass in flight* and
 * waits as long as `runtime.limits.wall`. A board has no pass to finish, and
 * borrowing the word would make somebody wait for nothing — or believe the
 * conductor was draining when it was not. `restart` is stop-then-start and
 * claims nothing more: `lingtai restart` is the one that refuses a bad `HEAD`, a
 * dirty worktree and a red `doctor` first, and none of that is about a reader.
 *
 * **Who is stopped is whoever keeps it.** A board the supervisor keeps
 * (`lingtai service install`) comes straight back from a signal, so `stop` asks
 * the supervisor; one started in a terminal is named by the file `start` writes,
 * and a board neither can name is reported rather than hunted for.
 *
 * Everything outside this file comes through `BoardWorld`, so a test drives
 * every verb with no port bound, no process signalled and no supervisor asked.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, stateDir } from "@lingtai/env";
import { paint } from "@lingtai/env/colour";
import {
  BOARD_HOST,
  boardAnswers,
  boardPort,
  boardUrl,
  builtBoardDir,
  serveBoard,
  whereThePortIsSet,
  type PortAnswer,
} from "./board.ts";
import { askSupervisor, BOARD_JOB, boardLaunchdPlist, boardSystemdUnit, platformFor, processRunning } from "./service.ts";

export const BOARD_USAGE = "lingtai board start|stop|restart|status [--port <n>] [--dir <path>] [--no-open]";

/** What the supervisor says about the board's job — `lingtai service`'s second one. */
export type BoardJob =
  | { installed: false }
  | { installed: true; loaded: boolean; running: boolean; lines: string[]; name: string }
  | { unread: string };

export interface BoardWorld {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  error: (line: string) => void;
  answers: (port: number) => Promise<PortAnswer>;
  /** Resolves once the board listens; the process stays up for it. */
  serve: (port: number, dir: string | undefined) => Promise<void>;
  open: (url: string) => Promise<boolean>;
  /** Whether somebody is at a terminal to look at a browser — a supervisor is not. */
  interactive: boolean;
  pid: number;
  /** Whether `pid` is a live `lingtai board` process — its own argv, so a reused pid is not signalled. */
  isBoard: (pid: number) => boolean;
  signal: (pid: number) => void;
  /** Called on this process's exit. */
  onExit: (fn: () => void) => void;
  job: () => BoardJob;
  /** The supervisor's stop and start for the board's job. False, having said why, when it failed. */
  supervisorStop: () => Promise<boolean>;
  supervisorStart: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/** Where `board start` says which process it is — so `stop` signals that one and nothing else. */
export function boardPidFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "board.json");
}

function readPid(env: NodeJS.ProcessEnv): { pid: number; port: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(boardPidFile(env), "utf8")) as { pid?: unknown; port?: unknown };
    return typeof parsed.pid === "number" && typeof parsed.port === "number" ? { pid: parsed.pid, port: parsed.port } : null;
  } catch {
    return null;
  }
}

function parseArgs(argv: readonly string[]): { verb: string; flags: Record<string, string> } | null {
  const [verb, ...rest] = argv;
  if (!verb || !["start", "stop", "restart", "status"].includes(verb)) return null;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!;
    if (name === "--no-open") {
      flags["no-open"] = "";
      continue;
    }
    if (name !== "--port" && name !== "--dir") return null;
    const value = rest[i + 1];
    if (value === undefined) return null;
    flags[name.slice(2)] = value;
    i++;
  }
  return { verb, flags };
}

/** How long `stop` waits for a signalled board to go. */
const STOP_WAIT_POLLS = 50;

export async function boardCommand(argv: readonly string[], world: BoardWorld): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    world.error(BOARD_USAGE);
    if (argv[0] === undefined || argv[0].startsWith("--")) {
      world.error("the board has a lifecycle now (#187) — lingtai board start serves it");
    }
    return 2;
  }
  const { verb, flags } = parsed;
  const resolved = boardPort(world.env, flags["port"]);
  if ("refused" in resolved) {
    world.error(paint.fail(resolved.refused));
    return 2;
  }
  const { port, from } = resolved;
  const url = boardUrl(port);

  const start = async (): Promise<number> => {
    const already = await world.answers(port);
    if (already === "board") {
      world.error(paint.fail(`a board is already on ${port} — ${url}`));
      world.error(`${whereThePortIsSet(world.env, from)}. lingtai board status says who keeps it`);
      return 1;
    }
    if (already === "other") {
      world.error(paint.fail(`${port} is held by something that is not a Lingtai board — nothing was started`));
      world.error(whereThePortIsSet(world.env, from));
      return 1;
    }
    try {
      await world.serve(port, flags["dir"]);
    } catch (err) {
      world.error(paint.fail(`the board did not start — ${(err as Error).message}`));
      world.error(whereThePortIsSet(world.env, from));
      return 1;
    }
    const file = boardPidFile(world.env);
    mkdirSync(stateDir(world.env), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: world.pid, port }));
    world.onExit(() => {
      // Only its own: a second start that was refused must not remove the first's.
      if (readPid(world.env)?.pid === world.pid) rmSync(file, { force: true });
    });
    world.log(paint.pass(`board on ${url}`));
    if (!("no-open" in flags) && world.interactive) {
      if (!(await world.open(url))) world.log(paint.signal(`no browser could be opened here — open ${url}`));
    }
    world.log(paint.muted("it runs in this terminal — ctrl-c stops it"));
    return 0;
  };

  /** 0 when no board is left that this could stop; 1 when one answers that nothing here names. */
  const stop = async (): Promise<number> => {
    const job = world.job();
    if ("unread" in job) {
      world.error(paint.fail(`could not ask the supervisor whether it keeps the board — ${job.unread}. Nothing was stopped`));
      return 1;
    }
    if (job.installed && job.loaded) {
      // A signal would be undone by KeepAlive in thirty seconds.
      world.log(`the supervisor keeps the board (${job.name}) — asking it to stop`);
      if (!(await world.supervisorStop())) return 1;
      world.log(paint.pass("stopped. lingtai service start brings it back"));
      return 0;
    }
    const recorded = readPid(world.env);
    if (recorded && world.isBoard(recorded.pid)) {
      world.signal(recorded.pid);
      for (let i = 0; i < STOP_WAIT_POLLS && world.isBoard(recorded.pid); i++) await world.sleep(100);
      if (world.isBoard(recorded.pid)) {
        world.error(paint.fail(`the board (pid ${recorded.pid}) was signalled and is still running`));
        return 1;
      }
      rmSync(boardPidFile(world.env), { force: true });
      world.log(paint.pass(`stopped the board on ${recorded.port} (pid ${recorded.pid})`));
      return 0;
    }
    // A file naming a process that is gone, or is no longer a board, is nobody's.
    if (recorded) rmSync(boardPidFile(world.env), { force: true });
    const now = await world.answers(port);
    if (now === "board") {
      world.error(paint.fail(`a board answers on ${url}, and neither the supervisor nor lingtai board start here names it — nothing was stopped`));
      return 1;
    }
    world.log(`no board is running on ${port}`);
    return 0;
  };

  switch (verb) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart": {
      const job = world.job();
      if (!("unread" in job) && job.installed && job.loaded) {
        world.log(`the supervisor keeps the board (${job.name}) — asking it to stop and start it`);
        return (await world.supervisorStop()) && (await world.supervisorStart()) ? 0 : 1;
      }
      const stopped = await stop();
      if (stopped !== 0) return stopped;
      return start();
    }
    default: {
      world.log(`port        ${port} — ${from}`);
      const now = await world.answers(port);
      world.log(
        now === "board"
          ? `answering   ${url} is a Lingtai board`
          : now === "other"
            ? `answering   something that is not a Lingtai board holds ${port}`
            : `answering   nothing on ${port}`,
      );
      const recorded = readPid(world.env);
      world.log(
        recorded && world.isBoard(recorded.pid)
          ? `terminal    lingtai board start, pid ${recorded.pid}, on ${recorded.port}`
          : "terminal    none started here",
      );
      const job = world.job();
      if ("unread" in job) world.log(`supervisor  could not ask — ${job.unread}`);
      else if (!job.installed) world.log("supervisor  not installed — lingtai service install writes the board's job beside the conductor's");
      else {
        world.log(`supervisor  ${job.name}${job.loaded ? "" : " — not loaded"}`);
        for (const line of job.lines) world.log(`  ${line}`);
      }
      return now === "board" ? 0 : 1;
    }
  }
}


/**
 * What `lingtai board` touches outside itself: the port, the process that
 * `board start` recorded, and the supervisor's board job.
 */
export function liveBoardWorld(): BoardWorld {
  const platform = platformFor(process.platform);
  const uid = process.getuid?.() ?? 0;
  const exec = (call: string[]) => {
    const r = spawnSync(call[0]!, call.slice(1), { encoding: "utf8" });
    return r.error ? { status: 127, out: r.error.message } : { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const file = () => {
    if (!platform) return null;
    const inputs = { node: "node", root: repoRoot(), env: process.env };
    try {
      return platform === "launchd" ? boardLaunchdPlist(inputs) : boardSystemdUnit(inputs);
    } catch {
      return null;
    }
  };
  const run = (call: string[]): boolean => {
    console.log(`$ ${call.join(" ")}`);
    const r = exec(call);
    if (r.status !== 0 && r.out.trim()) console.error(r.out.trim());
    return r.status === 0;
  };
  return {
    env: process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    answers: (port) => boardAnswers(port),
    serve: (port, dir) => serveBoard({ dir: dir || builtBoardDir(), port, host: BOARD_HOST }),
    open: (url) =>
      new Promise((resolve) => {
        const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
        child.once("error", () => resolve(false));
        child.once("spawn", () => {
          child.unref();
          resolve(true);
        });
      }),
    interactive: Boolean(process.stdout.isTTY),
    pid: process.pid,
    isBoard: (pid) => {
      // Its own command line, so a pid the kernel has since handed to something else is left alone.
      const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      // `lingtai board start` installed, `node …/entry.ts board start` or `…/lingtai.ts` from a checkout.
      return r.status === 0 && /\bboard start\b/.test(r.stdout) && /lingtai|entry\.ts/.test(r.stdout);
    },
    signal: (pid) => process.kill(pid, "SIGTERM"),
    onExit: (fn) => process.on("exit", fn),
    job: () => {
      const f = file();
      if (!platform || !f || !existsSync(f.path)) return { installed: false };
      const answer = askSupervisor(platform, exec, uid, BOARD_JOB);
      if ("unread" in answer) return answer;
      return {
        installed: true,
        loaded: platform === "launchd" ? answer.loaded : answer.loaded && !answer.lines.some((l) => l === "ActiveState=inactive" || l === "ActiveState=failed"),
        running: answer.loaded && processRunning(platform, answer.lines),
        lines: answer.lines,
        name: platform === "launchd" ? BOARD_JOB.label : BOARD_JOB.unit,
      };
    },
    // The board's job has nothing in flight, so its stop is the supervisor's own.
    supervisorStop: async () =>
      platform === "launchd" ? run(["launchctl", "bootout", `gui/${uid}/${BOARD_JOB.label}`]) : run(["systemctl", "--user", "stop", BOARD_JOB.unit]),
    supervisorStart: async () => {
      if (platform === "systemd") return run(["systemctl", "--user", "start", BOARD_JOB.unit]);
      const f = file();
      // bootout returns before the job is gone, and a bootstrap in that window fails.
      for (let i = 0; i < 60; i++) {
        const answer = askSupervisor("launchd", exec, uid, BOARD_JOB);
        if ("loaded" in answer && !answer.loaded) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return f !== null && run(["launchctl", "bootstrap", `gui/${uid}`, f.path]);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
