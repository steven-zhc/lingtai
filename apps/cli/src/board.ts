import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { constants, Script } from "node:vm";
import { boardPort, repoRoot } from "@lingtai/env";
import type { FileLocker, HeldLock } from "@lingtai/env/lock";
import { BOARD_JOB, BOARD_WAIT_MS, UNLOAD_WAIT_MS, type Exec, type Keeper } from "./service.ts";

/**
 * The built board, served from this process (#183).
 *
 * `pnpm build` puts the board beside the CLI bundle as Next's `standalone`
 * output — `dist/lingtai.cjs` and `dist/board/` — and a monorepo keeps the
 * workspace path, so the entry is `board/apps/board/server.js`.
 *
 * **`import()`, never `require()`.** The board's `server.js` is ESM (its
 * package is `"type": "module"`) and the bundle is CJS, because a SEA's main is.
 * A dynamic `import()` is the one way across that Node promises, and it is what
 * `apps/release/test/build.test.ts` runs rather than asserts.
 */
export function boardEntry(dir: string): string {
  return join(dir, "apps", "board", "server.js");
}

/**
 * Where `pnpm build` put the board — **two places, because there are two ways
 * to be running**.
 *
 * Beside the file this was bundled into, first: bundled,
 * `import.meta.filename` is the bundle's — or the binary's, which
 * `apps/release/src/build.ts` makes it inside a SEA.
 *
 * **Then `<root>/dist/board`, which is the only one a source checkout has**
 * (#187). Run from source there is nothing beside `apps/cli/src`, and
 * `lingtai service`'s board job runs exactly that path — `keeper` asserts
 * `<root>/apps/cli/src/lingtai.ts` — so a `builtBoardDir` that looked only
 * beside itself made the installed job a thing that exits at once and is
 * respawned every thirty seconds for ever. `pnpm build` writes `dist/` at the
 * checkout root (`apps/release/src/build.ts`), and a board there is a board.
 *
 * Where neither holds one, the first is returned: `serveBoard` names it, and
 * beside-the-CLI is what a reader of a shipped install expects to be told.
 */
export function builtBoardDir(self: string = import.meta.filename, root: string = repoRoot()): string {
  const beside = join(dirname(self), "board");
  if (existsSync(boardEntry(beside))) return beside;
  const built = join(root, "dist", "board");
  return existsSync(boardEntry(built)) ? built : beside;
}

/**
 * The board's port, or why there is none — **a value and never a throw**.
 *
 * `boardPort()` refuses a `board.port` that is not a port number, which is
 * right for `lingtai board`, whose whole subject is the board, and wrong for
 * everything else. Read where a `ServiceOptions` is built, one typo in a UI
 * setting threw before `serviceCommand` was entered (#187): `lingtai service
 * shutdown "moving the database"` drained nothing, unloaded nothing, and said
 * one thing, about the board's port. The conductor is not held up by the UI's
 * port, so the refusal is carried as a fact for the board's own leg to report.
 */
export function boardPortOrWhy(env: NodeJS.ProcessEnv = process.env): { port: number } | { why: string } {
  try {
    return { port: boardPort(env) };
  } catch (err) {
    return { why: (err as Error).message };
  }
}

export interface BoardOptions {
  dir: string;
  port: number;
  host: string;
}

/**
 * Start the board in this process. Resolves once the server is listening; the
 * server keeps the process alive after that.
 *
 * `server.js` reads `PORT` and `HOSTNAME` from the environment and nothing
 * else, and `chdir`s into its own directory. The host is always set: 0008's
 * board has no auth, and Next's default is `0.0.0.0`.
 *
 * **Loading `server.js` is not listening.** Its `startServer` is not awaited, so
 * `import()` settles before the port is bound, and a port somebody else holds
 * only surfaces afterwards, as Next's own `EADDRINUSE` and `process.exit(1)`.
 * So the port is taken and let go first — a refusal before anything is loaded —
 * and this resolves only once a connection to it is answered.
 */
export async function serveBoard(options: BoardOptions): Promise<void> {
  const entry = boardEntry(options.dir);
  if (!existsSync(entry)) {
    throw new Error(
      `no built board at ${entry}. pnpm build writes one into dist/; from the source, pnpm --filter @lingtai/board dev`,
    );
  }
  await portIsFree(options.host, options.port);
  process.env["PORT"] = String(options.port);
  process.env["HOSTNAME"] = options.host;
  await importFile(pathToFileURL(entry).href);
  await listening(options.host, options.port);
}

/**
 * `import()`, from wherever this is running.
 *
 * **Inside a SEA (#185) a plain `import()` only reaches built-in modules** — the
 * embedder's loader answers `No such built-in module: file:///…/server.js` — so
 * there it is compiled in a script that asks for the main context's default
 * loader, which reads the file system as `node lingtai.cjs` does. Still an
 * `import()`, never a `require()`. The option is experimental in Node, and
 * `apps/release/src/binary.ts` turns that warning off in the binary.
 */
function importFile(url: string): Promise<unknown> {
  if (!isSea()) return import(url);
  const load = new Script("(url) => import(url)", {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext() as (url: string) => Promise<unknown>;
  return load(url);
}

function portIsFree(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === "EADDRINUSE"
            ? `${host}:${port} is already in use; lingtai board --port <n> picks another`
            : `cannot listen on ${host}:${port}: ${err.message}`,
        ),
      );
    });
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

/** Until `host:port` answers. A server that fails to start exits the process. */
async function listening(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (up) return;
    if (Date.now() > deadline) throw new Error(`the board never listened on ${host}:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------- the lifecycle --

/**
 * `lingtai board start|stop|restart|status` (#187) — the UI's lifecycle, beside
 * the conductor's.
 *
 * ## `stop`, and deliberately not `shutdown`
 *
 * `lingtai shutdown` means *finish the pass in flight*, and waits as long as
 * `runtime.limits.wall` — an hour here. **A board has no pass to finish.**
 * Giving it the same verb would make somebody wait for nothing, or believe the
 * conductor was draining when it was not. So the board stops at once, and the
 * word for it is `stop`.
 *
 * The same for `restart`: `lingtai restart` refuses a `HEAD` the tracking
 * remote does not have, a dirty worktree and a red `lingtai doctor` before it
 * drains (0042). `lingtai board restart` is stop-then-start and claims nothing
 * more — there is nothing to lose by restarting a UI at the wrong commit.
 *
 * ## Which board, and how it is stopped
 *
 * There is no log to send a request down, so the board is found the way
 * everything else on this machine is found: **the file lock under
 * `~/.lingtai/locks/` (#193)**, the same locker the conductor and a decision
 * take. `board start` holds `board` while it serves, and the
 * holder's name carries its pid and host — so `stop` has something to signal
 * and `status` has something to report, and a killed board leaves nothing
 * behind, because the kernel drops a file lock with the process.
 *
 * **The supervisor is asked first, and that is the whole of the race.** A board
 * launchd keeps would be signalled here and respawned thirty seconds later,
 * behind whatever this terminal started in the meantime — so when a supervisor
 * keeps the job, `stop` and `restart` are its calls and not a signal of ours.
 * `start` needs no such check: a supervised board holds the lock, and a second
 * one is refused by it in words.
 */
export type BoardVerb = "start" | "stop" | "restart" | "status";
const VERBS: readonly BoardVerb[] = ["start", "stop", "restart", "status"];

/**
 * The lock `board start` holds while it serves, **one per port**.
 *
 * The port and not the word `board`, because the port is what a second board
 * would collide over: two on different ports share nothing and are refused by
 * nothing, and `apps/release/test/build.test.ts` starts exactly that pair.
 * `stop` and `status` take a port too, so all three name the same lock.
 */
export function boardLock(port: number): string {
  return `board:${port}`;
}

/**
 * How long `stop` waits for a signalled board to let the lock go: ten seconds.
 *
 * Counted in polls rather than measured against the clock, so the wait is the
 * injected `sleep`'s and a test that makes it a no-op does not sit here for ten
 * real seconds.
 */
const STOP_POLL_MS = 100;
const STOP_POLLS = 100;

/**
 * How long `restart` waits for a board to answer again — **`service`'s own
 * `BOARD_WAIT_MS`, because it is the same Next standalone boot**.
 *
 * It was ten seconds of its own, and a cold machine — a fresh login, a `pnpm
 * build` running beside it — takes longer than that to bind: the command
 * reported failure and exited 1 for a board that came up two seconds later,
 * while `service install` was budgeting 75s for the same boot (#187). One
 * estimate, in one place. (`serveBoard`'s `listening` allows less, and is a
 * different question: that one waits on a server this process started, and
 * gives up because nothing is coming.)
 *
 * **Counted and also timed**, because an ask is not free: `answering` carries
 * its own five-second timeout, so against something that accepts TCP and never
 * replies the polls alone would be far longer than the seconds this reports.
 * The count still bounds a test's loop, where nothing takes any time; the
 * deadline bounds the wait, where each ask takes all of its own.
 */
const ANSWER_POLL_MS = 250;
const ANSWER_WAIT_MS = BOARD_WAIT_MS;
const ANSWER_POLLS = ANSWER_WAIT_MS / ANSWER_POLL_MS;

/**
 * How long a supervised `stop` waits for the supervisor to say the job is gone
 * — **`service`'s own `UNLOAD_WAIT_MS`, because it is the same `bootout`**.
 *
 * `launchctl bootout` returns once it has *asked* for the job's termination,
 * which `service.ts`'s `unloadJob` waits past for exactly this reason. Counted
 * as well as timed, for the reason `ANSWER_POLLS` is: the count bounds a test's
 * loop, where a no-op `sleep` takes no time, and the clock bounds the wait.
 */
const GONE_POLL_MS = 500;
const GONE_POLLS = UNLOAD_WAIT_MS / GONE_POLL_MS;

/** What was typed. `port` and `dir` are null where nothing was, and the caller resolves them. */
export interface BoardArgs {
  verb: BoardVerb;
  port: number | null;
  dir: string | null;
  /** False under a supervisor, which has nobody at a browser (`BOARD_JOB.argv`). */
  open: boolean;
}

/** What `boardCommand` runs: the same, with the port and the directory decided. */
export interface BoardCommand extends BoardArgs {
  port: number;
  dir: string;
}

export interface BoardWorld {
  host: string;
  /** This machine's name, as the lock records it — so a holder elsewhere is not signalled here. */
  hostname: string;
  /** Whether a Lingtai board answers on this port — its URL, or null. Never "is the port bound". */
  answering: (port: number) => Promise<string | null>;
  /** Whether *anything* holds the port, which a board that is still starting also does. */
  bound: (port: number) => Promise<boolean>;
  locker: Pick<FileLocker, "tryLock" | "holder">;
  /**
   * Whether a supervisor keeps a board **on this port** — `keeper(…,
   * BOARD_JOB)`, asked only where the job would be serving the port named.
   *
   * **The port is the argument, and that is the whole of it.** The job runs
   * `lingtai board start --no-open` with no `--port`, so the board a supervisor
   * keeps is on `boardPort()` and on no other. Asked without the port, a
   * `board stop --port 18080` beside a supervised board on 17820 answered
   * *kept*, booted the 17820 job out, reported it stopped, and left the board
   * that was named on the command line running (#187).
   */
  keeper: (port: number) => Keeper;
  exec: Exec;
  serve: (options: BoardOptions) => Promise<void>;
  open: (url: string) => Promise<boolean>;
  /** SIGTERM to `pid`. False when there is no such process to signal. */
  signal: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  /**
   * The clock a wait is measured against, beside the `sleep` it is spent in.
   * `restart`'s wait for an answer needs both — see `ANSWER_WAIT_MS`.
   */
  now: () => number;
  /** Where the port is set, said wherever the port is the trouble. */
  whereThePortIsSet: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * The lock, held for as long as this process serves.
 *
 * Module scope and not a local: a `HeldLock` dropped on the floor is a SQLite
 * handle nothing references, and the lock it stands for is not this process's
 * to lose to a collector.
 */
let held: HeldLock | null = null;

export function parseBoardArgs(args: readonly string[]): BoardArgs | { refused: string } {
  const usage = "lingtai board start|stop|restart|status [--port <n>] [--dir <path>] [--no-open]";
  const rest = [...args];
  // `lingtai board` on its own is `start`, which is what it did before it had
  // verbs (#183) and what the wizard's last line still tells people to run.
  const first = rest[0];
  if (first === "shutdown") {
    return {
      refused:
        "lingtai board shutdown does not exist — shutdown means finish the pass in flight, and waits as long as the " +
        "wall limit for it. A board has no pass to finish: pnpm lingtai board stop, which returns at once",
    };
  }
  const named = first !== undefined && !first.startsWith("-");
  const verb = (named ? first : "start") as BoardVerb;
  if (named) rest.shift();
  if (!VERBS.includes(verb)) return { refused: `${usage} — no ${verb}` };
  const out: { port?: number; dir?: string; open: boolean } = { open: true };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!;
    if (name === "--no-open") {
      out.open = false;
      continue;
    }
    const value = rest[i + 1];
    if (name === "--port") {
      if (value === undefined) return { refused: `${usage} — --port takes a port number` };
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return { refused: `${usage} — --port takes a port number` };
      out.port = port;
      i++;
      continue;
    }
    if (name === "--dir") {
      if (value === undefined) return { refused: `${usage} — --dir takes a path` };
      out.dir = value;
      i++;
      continue;
    }
    return { refused: `${usage} — no ${name}` };
  }
  return { verb, port: out.port ?? null, dir: out.dir ?? null, open: out.open };
}

/** The pid in a lock holder's name — `board on 17820 pid 500 on host` — with the host it is on. */
export function holdingProcess(holder: string): { pid: number; host: string } | null {
  const said = /\bpid (\d+) on (\S+)/.exec(holder);
  return said ? { pid: Number(said[1]), host: said[2]! } : null;
}

export async function boardCommand(command: BoardCommand, world: BoardWorld): Promise<number> {
  const { log, error } = world;
  const url = `http://${world.host}:${command.port}`;

  /** Where the port is set, said at every refusal the port causes. */
  const sayWhereThePortIsSet = (): void => error(`the port is ${world.whereThePortIsSet}`);

  /** Whoever holds the board lock, or null. Throws are the caller's: *unread* is not *nobody*. */
  const holder = (): Promise<string | null> => world.locker.holder(boardLock(command.port));

  const start = async (): Promise<number> => {
    const taken = await world.locker.tryLock(boardLock(command.port), `board on ${command.port}`);
    if (!taken.ok) {
      // The sentence the ticket asked for, and the holder beside it: a second
      // board on this machine is the ordinary case, not a bare EADDRINUSE.
      error(`a board is already on ${command.port} — ${url}`);
      error(`  held by ${taken.holder ?? "a holder that has not named itself"}`);
      sayWhereThePortIsSet();
      return 1;
    }
    held = taken.lock;
    // The lock says nothing about the port: something that is not a board of
    // this machine's can hold it, and Next would exit(1) on its own EADDRINUSE
    // long after `serveBoard` resolved.
    if (await world.bound(command.port)) {
      const answers = await world.answering(command.port).catch(() => null);
      error(
        answers === null
          ? `${world.host}:${command.port} is held by something that is not a Lingtai board — nothing was started`
          : `a board is already on ${command.port} — ${answers}. It is not this machine's, since no lock names it`,
      );
      sayWhereThePortIsSet();
      await held.release();
      held = null;
      return 1;
    }
    try {
      await world.serve({ dir: command.dir, port: command.port, host: world.host });
    } catch (err) {
      await held.release();
      held = null;
      error((err as Error).message);
      return 1;
    }
    log(`board on ${url}`);
    if (command.open && !(await world.open(url))) log(`no browser could be opened here — open ${url}`);
    log("it serves in this terminal — ctrl-c stops it. Under lingtai service it is a job: pnpm lingtai board stop");
    return 0;
  };

  /**
   * The supervisor's own stop or restart, when it keeps the board's job. One
   * call each, printed first — this file wraps no more of a service manager
   * than `service.ts` does.
   */
  const throughSupervisor = async (kept: Extract<Keeper, { kept: true }>, what: "stop" | "restart"): Promise<number> => {
    const call =
      kept.platform === "launchd"
        ? what === "stop"
          ? ["launchctl", "bootout", `gui/${kept.uid}/${BOARD_JOB.label}`]
          : ["launchctl", "kickstart", "-k", `gui/${kept.uid}/${BOARD_JOB.label}`]
        : ["systemctl", "--user", what === "stop" ? "stop" : "restart", BOARD_JOB.unit];
    log(`${kept.platform} keeps the board (${kept.path}), so this is its call and not a signal of ours —`);
    log(`$ ${call.join(" ")}`);
    const r = world.exec(call);
    if (r.status !== 0) {
      if (r.out.trim()) error(r.out.trim());
      error(`the supervisor refused to ${what} the board's job — pnpm lingtai service status says what it has`);
      return 1;
    }
    if (what === "stop") {
      // The call returning is not the job being gone, and saying so would be
      // the one thing this verb is asked for.
      if (!(await gone())) return 1;
      log("stopped the board's job. It stays stopped: pnpm lingtai service start starts it again with the conductor");
      return 0;
    }
    return (await answers()) ? 0 : 1;
  };

  /**
   * Whether the supervisor has let the board's job go, **waited for rather than
   * read off the call's own exit**.
   *
   * `launchctl bootout` exits 0 once it has asked for the termination, while
   * the job is still running — `service.ts`'s `unloadJob` polls past exactly
   * that. Reported without the wait, `stop` said *stopped the board's job* over
   * a process that still held the port and the board lock: the next `board
   * status` called it `serving`, and the next `board start` was refused by the
   * lock the dying process had not dropped yet. (`systemctl --user stop`
   * blocks, so there the first ask is the answer and this costs one.)
   */
  const gone = async (): Promise<boolean> => {
    const until = world.now() + UNLOAD_WAIT_MS;
    for (let i = 0; i < GONE_POLLS; i++) {
      if (i > 0 && world.now() >= until) break;
      const kept = world.keeper(command.port);
      if ("unread" in kept) {
        error(`the supervisor was asked to stop the board's job, and whether it has could not be read — ${kept.unread}`);
        return false;
      }
      if (!kept.kept) return true;
      await world.sleep(GONE_POLL_MS);
    }
    error(
      `the supervisor still has the board's job ${UNLOAD_WAIT_MS / 1000}s after the stop — ` +
        "it may still be answering. pnpm lingtai service status says what the supervisor has",
    );
    return false;
  };

  /** Whether a board answers again after a restart, waited for rather than assumed. */
  const answers = async (): Promise<boolean> => {
    const until = world.now() + ANSWER_WAIT_MS;
    for (let i = 0; i < ANSWER_POLLS; i++) {
      // The clock beside the count: one ask can cost its own timeout, and a
      // wait that outlives the seconds it reports looks hung.
      if (i > 0 && world.now() >= until) break;
      const at = await world.answering(command.port).catch(() => null);
      if (at !== null) {
        log(`the board answers on ${at}`);
        return true;
      }
      await world.sleep(ANSWER_POLL_MS);
    }
    error(
      `nothing answers on ${url} ${ANSWER_WAIT_MS / 1000}s after the restart — ` +
        "pnpm lingtai service status says what the supervisor has",
    );
    return false;
  };

  const stop = async (): Promise<number> => {
    const kept = world.keeper(command.port);
    if ("unread" in kept) {
      error(`${kept.unread}. Nothing was signalled: a board the supervisor keeps comes back in thirty seconds, and a`);
      error("signal sent without knowing that leaves two of them racing for the port");
      return 1;
    }
    if (kept.kept) return throughSupervisor(kept, "stop");

    let who: string | null;
    try {
      who = await holder();
    } catch (err) {
      error(`the board lock could not be read — ${(err as Error).message}. Nothing was signalled`);
      return 1;
    }
    if (who === null) {
      const at = await world.answering(command.port).catch(() => null);
      log(
        at === null
          ? "no board of this machine's is running, and nothing answers on the port — there was nothing to stop"
          : `no board of this machine's is running, and something answers on ${at} — this signalled nothing, since no lock names it`,
      );
      return 0;
    }
    const process_ = holdingProcess(who);
    if (process_ === null) {
      error(`the board lock is held by ${who}, which names no pid — this signalled nothing`);
      return 1;
    }
    if (process_.host !== world.hostname) {
      error(`the board lock is held by ${who}, on another machine — a signal from here would reach a different process`);
      return 1;
    }
    if (!world.signal(process_.pid)) {
      error(`pid ${process_.pid} holds the board lock and is not there to signal — ${who}`);
      return 1;
    }
    for (let i = 0; i < STOP_POLLS; i++) {
      let now: string | null;
      try {
        now = await holder();
      } catch (err) {
        error(`signalled pid ${process_.pid}, and the lock could not be read afterwards — ${(err as Error).message}`);
        return 1;
      }
      if (now === null) {
        log(`stopped the board on ${command.port} — pid ${process_.pid}`);
        return 0;
      }
      await world.sleep(STOP_POLL_MS);
    }
    error(
      `pid ${process_.pid} still holds the board lock ${(STOP_POLLS * STOP_POLL_MS) / 1000}s after SIGTERM — ` +
        `kill -9 ${process_.pid} is the blunt way, and it takes the server with it: the board serves in that process`,
    );
    return 1;
  };

  const status = async (): Promise<number> => {
    // Three facts, none concluded from another: who serves it, whether a board
    // answers, and whether anything would start one again by itself.
    let who: string;
    try {
      who = (await holder()) ?? "nobody — no board of this machine's holds the lock";
    } catch (err) {
      who = `could not be read — ${(err as Error).message}`;
    }
    log(`serving     ${who}`);
    const at = await world.answering(command.port).catch((err: unknown) => err as Error);
    log(
      `answering   ${
        at instanceof Error ? `could not be asked — ${at.message}` : at === null ? `nothing answers on ${url}` : `answers on ${at}`
      }`,
    );
    const kept = world.keeper(command.port);
    log(
      `supervisor  ${
        "unread" in kept ? kept.unread : kept.kept ? `${kept.platform} keeps it (${kept.path})` : "none keeps it — a board here is a terminal's"
      }`,
    );
    log(`port        ${command.port}, set in ${world.whereThePortIsSet}`);
    return 0;
  };

  switch (command.verb) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "status":
      return status();
    case "restart": {
      const kept = world.keeper(command.port);
      if ("unread" in kept) {
        error(`${kept.unread}. Nothing was stopped or started`);
        return 1;
      }
      // One call, not stop-then-start: this terminal racing the supervisor's
      // respawn for the port is how a `board restart` ends with launchd
      // crash-looping a job behind a board that goes when the terminal closes.
      if (kept.kept) return throughSupervisor(kept, "restart");
      const stopped = await stop();
      if (stopped !== 0) return stopped;
      return start();
    }
  }
}
