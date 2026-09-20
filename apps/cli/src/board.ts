import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { constants, Script } from "node:vm";
import { boardPort, machineConfigPath, repoRoot } from "@lingtai/env";
import { createFileLocker, type FileLocker, type HeldLock } from "@lingtai/env/lock";

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
 * Where `pnpm build` put the board, relative to the running CLI.
 *
 * Beside the file this was bundled into. Run from source there is no `board/`
 * beside `apps/cli/src`, which is why `boardPlace` has a second answer.
 */
export function builtBoardDir(self: string = import.meta.filename): string {
  // Bundled, `import.meta.filename` is the bundle's — or the binary's, which
  // `apps/release/src/build.ts` makes it inside a SEA.
  return join(dirname(self), "board");
}

/**
 * Which board this CLI has to serve, and **there are two** (#187).
 *
 * A from-source install has no `dist/board`. The supervisor's job is
 * `lingtai board start --no-open`, and on this repository — which runs unbuilt
 * (0010) — `builtBoardDir()` resolves to `apps/cli/src/board`, where nothing
 * has ever been written. A `start` that could only serve a built board would
 * exit 1 there and be respawned every thirty seconds for ever, under an
 * `install` that had already reported success. So the checkout's own
 * `apps/board` is the second place, run by the `next` in its `node_modules`:
 * `pnpm --filter @lingtai/board dev` without pnpm and without a shell, which is
 * the command this ticket exists to stop anybody needing.
 *
 * Resolved here and not inside `serveBoard`, so that `service install` can ask
 * the same question **before** it writes the board's job — in a process whose
 * `import.meta.filename` is the one that job will have.
 */
export type BoardPlace =
  /** What `pnpm build` wrote: the directory holding `apps/board/server.js`. */
  | { readonly built: string }
  /** A checkout's `apps/board`, to be served by its own `next`. */
  | { readonly source: string };

/** Next's own binary under the board's `node_modules` — what `pnpm dev` runs. */
export function nextBin(dir: string): string {
  return join(dir, "node_modules", "next", "dist", "bin", "next");
}

export interface BoardPlaceOptions {
  /** `--dir`: a built board somewhere else — and then never the checkout's. */
  dir?: string | undefined;
  /** Where `pnpm build` put one. Named only by a test. */
  built?: string;
  /** Lingtai's own checkout. Named only by a test. */
  root?: string;
}

/**
 * The built board beside this CLI, else the checkout's — and a sentence saying
 * what is not there when it is neither.
 *
 * `--dir` names one board and one only: falling back to the checkout would
 * quietly serve something other than what was asked for.
 */
export function boardPlace(options: BoardPlaceOptions = {}): BoardPlace | { missing: string } {
  if (options.dir !== undefined && options.dir !== "") {
    return existsSync(boardEntry(options.dir))
      ? { built: options.dir }
      : { missing: `--dir ${options.dir}: no built board at ${boardEntry(options.dir)}` };
  }
  const built = options.built ?? builtBoardDir();
  if (existsSync(boardEntry(built))) return { built };
  const source = join(options.root ?? repoRoot(), "apps", "board");
  if (existsSync(nextBin(source))) return { source };
  return {
    missing: `no board to serve: nothing built at ${boardEntry(built)}, which pnpm build writes, and no ${nextBin(source)}, which pnpm install in the checkout writes`,
  };
}

export interface BoardOptions {
  place: BoardPlace;
  port: number;
  host: string;
}

/**
 * Serve it. Resolves once the port is answered; what keeps the process alive
 * after that is the server — this one's, or the child's handle.
 *
 * **The port is taken and let go first, whichever place it is.** Neither way of
 * starting reports `EADDRINUSE` at a moment this function could turn into a
 * sentence: the built board's `startServer` is not awaited, so `import()`
 * settles before the bind, and the development server's failure arrives in a
 * child's stderr. A refusal before anything is loaded is the one that reads.
 */
export async function serveBoard(options: BoardOptions): Promise<void> {
  await portIsFree(options.host, options.port);
  if ("source" in options.place) await serveFromSource(options.place.source, options.port, options.host);
  else await loadBuilt(options.place.built, options.port, options.host);
  await listening(options.host, options.port);
}

/**
 * The built board, loaded into this process.
 *
 * `server.js` reads `PORT` and `HOSTNAME` from the environment and nothing
 * else, and `chdir`s into its own directory. The host is always set: 0008's
 * board has no auth, and Next's default is `0.0.0.0`.
 */
async function loadBuilt(dir: string, port: number, host: string): Promise<void> {
  const entry = boardEntry(dir);
  if (!existsSync(entry)) throw new Error(`no built board at ${entry}. pnpm build writes one into dist/`);
  process.env["PORT"] = String(port);
  process.env["HOSTNAME"] = host;
  await importFile(pathToFileURL(entry).href);
}

/**
 * The development server this process started, or null — module scope for the
 * reason `serving` is, that it outlives the call that made it.
 */
let server: ChildProcess | null = null;

/**
 * Signal it, so that stopping this CLI stops the board and not only the CLI.
 *
 * `board stop` sends `SIGTERM` to **one pid**, and SIGTERM's default action
 * would take this process and leave the server it started orphaned, still on
 * the port and now holding no lock — a board nothing in this file can find.
 */
export function stopServer(): void {
  server?.kill("SIGTERM");
}

/**
 * The checkout's board, as a child: `node <next> dev --turbopack` in
 * `apps/board`.
 *
 * **`--port` and `--hostname` as arguments**, never `PORT` in the environment:
 * `apps/board/package.json` carries no port at all now, so the number this
 * serves on comes from `board.port` and its default and from nowhere else
 * (#187), and the flags are what `next --help` documents.
 *
 * The child is this process's whole reason to be alive, so the two go together
 * in both directions — a server that exits exits this one with its code, since
 * a CLI left holding the board lock over a dead server is a board that `status`
 * calls up and `stop` signals into nothing.
 */
function serveFromSource(dir: string, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const next = nextBin(dir);
    if (!existsSync(next)) {
      reject(new Error(`no ${next} — pnpm install in the checkout writes it`));
      return;
    }
    const child = spawn(process.execPath, [next, "dev", "--turbopack", "--port", String(port), "--hostname", host], {
      cwd: dir,
      stdio: "inherit",
    });
    // Before `spawn`, a failure is this call's to reject; after it, the child's
    // exit is this process's exit. Registered in that order so that a `next`
    // that never started is one refusal rather than a refusal and an exit(1).
    child.once("error", (err: Error) => reject(new Error(`could not start ${next}: ${err.message}`)));
    child.once("spawn", () => {
      server = child;
      process.once("SIGTERM", stopServer);
      child.once("exit", (code, signal) => {
        server = null;
        process.exit(code ?? (signal === null ? 0 : 1));
      });
      resolve();
    });
  });
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
            ? `${host}:${port} is already in use; lingtai board start --port <n> picks another`
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

// ------------------------------------------------------------- the verbs --

/**
 * `lingtai board start|stop|restart|status` — the UI's lifecycle (#187).
 *
 * Twenty-eight CLI commands and not one of them started the board: it needed
 * `pnpm --filter @lingtai/board dev`, which an installed Lingtai has no way to
 * run. So the UI gets the lifecycle the conductor has, and `lingtai service`
 * installs both jobs.
 *
 * ## `stop`, and deliberately not `shutdown`
 *
 * `shutdown` means *finish the pass in flight first*, and waits as long as
 * `runtime.limits.wall` — an hour here. **A board has no pass to finish.**
 * Borrowing the word would make somebody wait for nothing, or believe the
 * conductor was draining when it was not. `restart` is the same distinction:
 * `lingtai restart` refuses a `HEAD` the tracking remote does not have, a dirty
 * worktree and a red `doctor` before it drains (0042); `board restart` is
 * stop-then-start and claims nothing more.
 *
 * ## One board per machine, and the lock is how `stop` finds it
 *
 * A port cannot be asked who is behind it, so the board takes the same file
 * lock everything else here takes (`@lingtai/env/lock`, 0052) and writes its
 * port and pid into it. That is what makes `stop` safe **without**
 * `killWorker`'s argv guard: the kernel drops a file lock when its holder dies,
 * so a pid read from a lock that is still held is a live board by
 * construction — where `reconcile.ts`'s recorded worker is a pid somebody wrote
 * down, which may since have been reused.
 */
export const BOARD_LOCK = "board";

/** How long `stop` waits for the board to let the lock go after the signal. */
const STOP_WAIT_MS = 10_000;

/**
 * The lock this process holds while it serves, kept at module scope on purpose:
 * it is what the lock is *for* — a local that went out of scope when `start`
 * returned would leave nothing referring to the open SQLite handles behind it.
 */
let serving: HeldLock | null = null;

/**
 * Take the board lock for a board this process is about to serve, and hold it
 * for as long as the process lives.
 *
 * **`board start` is not the only path that serves one.** `lingtai init`
 * serves the board on the machine it is installing, in its own process, and a
 * board that holds no lock is a board `board stop` cannot find, `board status`
 * reports as `nobody`, and the next `board start` names as *something that is
 * not a board of this machine's*. So every path that serves takes it here, and
 * there is one answer to *who is serving* however the board was started.
 */
export async function holdBoardLock(
  port: number,
  locker: FileLocker = createFileLocker(),
): Promise<{ ok: true } | { held: string | null }> {
  const taken = await locker.tryLock(BOARD_LOCK, lockName(port));
  if (!taken.ok) return { held: taken.holder ?? null };
  serving = taken.lock;
  return { ok: true };
}

/** Give it up: the path that took it and then could not serve after all. */
export async function dropBoardLock(): Promise<void> {
  const held = serving;
  serving = null;
  await held?.release();
}

export interface BoardWorld {
  env?: NodeJS.ProcessEnv;
  /** The machine's locks. Injected so a test locks a directory of its own. */
  locker?: FileLocker;
  /** Which board to serve, instead of asking `boardPlace`. */
  place?: BoardPlace | { missing: string };
  /** Serves it, and resolves once the port is answered. */
  serve?: (options: BoardOptions) => Promise<void>;
  /** Whether anything answers on `host:port` — which is not whether it is a board. */
  answers?: (host: string, port: number) => Promise<boolean>;
  /** Open a browser. False when none could be. */
  open?: (url: string) => Promise<boolean>;
  /** `process.kill`, so a test signals nothing. */
  signal?: (pid: number, sig: NodeJS.Signals | 0) => void;
  host?: string;
  /** What runs when Ctrl+C reaches a board this command is serving. */
  onInterrupt?: (stop: () => void) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

type BoardVerb = "start" | "stop" | "restart" | "status";
const BOARD_VERBS: readonly BoardVerb[] = ["start", "stop", "restart", "status"];

/** Who holds the board lock, as `lockName` writes it. Null for anything else. */
export function parseBoardHolder(who: string): { port: number; pid: number; host: string } | null {
  const m = /^board on (\d+) pid (\d+) on (.+)$/.exec(who.trim());
  return m ? { port: Number(m[1]), pid: Number(m[2]), host: m[3]! } : null;
}

/** What the holder calls itself, so a refusal can name the port the running board is on. */
function lockName(port: number): string {
  return `board on ${port}`;
}

/** Whether anything answers on `host:port`, asked once. Shared with `service status`. */
export function portAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => resolve(false));
  });
}

function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function boardCommand(args: string[], world: BoardWorld = {}): Promise<number> {
  const log = world.log ?? ((line: string) => console.log(line));
  const error = world.error ?? ((line: string) => console.error(line));
  const env = world.env ?? process.env;
  const host = world.host ?? "127.0.0.1";
  const locker = world.locker ?? createFileLocker();
  const answers = world.answers ?? portAnswers;
  const sleep = world.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const verb = args[0] as BoardVerb | undefined;
  if (!verb || !BOARD_VERBS.includes(verb)) {
    error(`lingtai board ${BOARD_VERBS.join("|")} [--port <n>] [--dir <path>] [--no-open]`);
    return 2;
  }
  const rest = args.slice(1);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "";
    else {
      flags[a.slice(2)] = next;
      i++;
    }
  }

  let port: number;
  try {
    port = "port" in flags && flags["port"] !== "" ? Number(flags["port"]) : boardPort(env);
  } catch (err) {
    error((err as Error).message);
    return 1;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    error(`--port takes a port between 1 and 65535, not ${JSON.stringify(flags["port"])}`);
    return 2;
  }
  const url = `http://${host}:${port}`;
  /** Where the port is set, named in every refusal that is about the port. */
  const wherePortIsSet = `board.port in ${machineConfigPath(env)} changes it, and lingtai board start --port <n> is the one-off`;

  /** Who holds the board lock, or the reason it could not be asked — never guessed as nobody. */
  const holding = async (): Promise<{ who: string | null } | { unread: string }> => {
    try {
      return { who: await locker.holder(BOARD_LOCK) };
    } catch (err) {
      return { unread: (err as Error).message };
    }
  };

  const stop = async (): Promise<number> => {
    const held = await holding();
    if ("unread" in held) {
      error(`could not read who is serving the board — ${held.unread}`);
      return 1;
    }
    if (held.who === null) {
      // Not a board of ours, then — but something may still hold the port, and
      // a `stop` that said "nothing is running" over it would be wrong twice.
      if (await answers(host, port)) {
        log(`no board of this machine's is running, and something is listening on ${host}:${port} — this did not signal it`);
        return 0;
      }
      log("no board is running");
      return 0;
    }
    const named = parseBoardHolder(held.who);
    if (!named) {
      error(`the board lock is held by "${held.who}", which names no process — nothing was signalled`);
      return 1;
    }
    if (named.host !== hostname()) {
      error(`the board lock is held by pid ${named.pid} on ${named.host}, not this machine — nothing was signalled`);
      return 1;
    }
    if (named.pid === process.pid) {
      error(`the board lock is held by this process — nothing was signalled`);
      return 1;
    }
    // SIGTERM and not SIGKILL: a board is a reader, so there is nothing to lose
    // by letting Next close its sockets, and the lock goes with the process
    // either way.
    try {
      (world.signal ?? ((pid: number, sig: NodeJS.Signals | 0) => void process.kill(pid, sig)))(named.pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        log(`the board that held the lock (pid ${named.pid}) is already gone`);
        return 0;
      }
      error(`pid ${named.pid} could not be signalled: ${(err as Error).message}`);
      return 1;
    }
    const until = Date.now() + STOP_WAIT_MS;
    for (;;) {
      const now = await holding();
      if ("unread" in now) {
        error(`signalled pid ${named.pid}, and whether it let the board lock go could not be read — ${now.unread}`);
        return 1;
      }
      if (now.who === null) {
        log(`stopped the board on ${named.port} — pid ${named.pid}`);
        log("under a supervisor it comes back: pnpm lingtai service status says whether one keeps it");
        return 0;
      }
      if (Date.now() > until) {
        error(`pid ${named.pid} still holds the board lock ${STOP_WAIT_MS / 1000}s after SIGTERM — kill -9 ${named.pid} is the blunt way`);
        return 1;
      }
      await sleep(100);
    }
  };

  const start = async (): Promise<number> => {
    const held = await holding();
    if ("unread" in held) {
      error(`could not read whether a board is already running — ${held.unread}`);
      return 1;
    }
    if (held.who !== null) {
      const named = parseBoardHolder(held.who);
      const on = named ? named.port : port;
      error(`a board is already on ${on} — http://${host}:${on}`);
      error(`pnpm lingtai board stop stops it; ${wherePortIsSet}`);
      return 1;
    }
    // **What is going to be served, before the lock is taken.** A board this
    // machine has no copy of is a refusal and not a board that failed to start:
    // taking the lock first would leave one to release on the way out, and a
    // `board status` run in the same instant would say a board was serving.
    const place = world.place ?? boardPlace({ dir: flags["dir"] });
    if ("missing" in place) {
      error(place.missing);
      return 1;
    }
    // A port held by something that is not a board of ours: said as that, and
    // never as `EADDRINUSE` — which names no owner and no remedy.
    if (await answers(host, port)) {
      error(`${host}:${port} is held by something that is not a board of this machine's — nothing was started`);
      error(wherePortIsSet);
      return 1;
    }
    const taken = await holdBoardLock(port, locker);
    if (!("ok" in taken)) {
      error(`a board took the lock in the same instant — ${taken.held ?? "it has not named itself"}`);
      return 1;
    }
    try {
      await (world.serve ?? serveBoard)({ place, port, host });
    } catch (err) {
      await dropBoardLock();
      error((err as Error).message);
      return 1;
    }
    log(`board on ${url}`);
    if ("no-open" in flags) log("--no-open: no browser was opened");
    else if (!(await (world.open ?? openBrowser)(url))) log("no browser could be opened — the address is above");
    log("ctrl-c stops it. It holds nothing and renders the log, so stopping it costs no work (0013)");
    (world.onInterrupt ?? ((fn: () => void) => void process.on("SIGINT", fn)))(() => {
      console.log("");
      console.log(`stopped the board on ${url}`);
      // The development server, where there is one. A Ctrl+C at this terminal
      // reached it too — it is in the group — but `kill -INT` at this pid does
      // not, and an orphaned server would hold the port with no lock naming it.
      // `kill(2)` is delivered here and not when the child next runs, so the
      // exit below does not race it.
      stopServer();
      // The kernel would drop the lock a moment later anyway; given up by name
      // so the next `board start` is never refused by one on its way out.
      void serving?.release();
      process.exit(0);
    });
    return 0;
  };

  switch (verb) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "restart": {
      const stopped = await stop();
      if (stopped !== 0) return stopped;
      return start();
    }
    case "status": {
      // Two answers to two questions, neither folded into the other — the rule
      // `service status` keeps between a loaded job and a beating daemon.
      const held = await holding();
      log(`serving     (the board lock under ~/.lingtai/locks — who is holding it)`);
      log(`  ${"unread" in held ? `could not read it — ${held.unread}` : (held.who ?? "nobody")}`);
      log(`answering   (${url} — whether anything answers there, which a lock does not say)`);
      log(`  ${(await answers(host, port)) ? "answers" : "nothing answers"}`);
      return "unread" in held ? 1 : 0;
    }
  }
}
