import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { constants, Script } from "node:vm";
import { parse as parseYaml } from "yaml";
import { repoRoot, stateDir } from "@lingtai/env";

/**
 * The board's port when nothing says otherwise (#187).
 *
 * In `10000–32767` on purpose: below both kernels' ephemeral ranges — macOS
 * hands out `49152–65535`, Linux `32768–60999` — where a default would collide
 * at random, intermittently, and mostly not at all. `doc/design/installing.md`
 * *Ports* is the whole argument.
 */
export const BOARD_PORT = 17820;

/**
 * **Reserved, and bound by nothing.** The daemon listens on nothing at all —
 * everything reaches it through the log, and its hook socket is a unix path —
 * so there is no second listener today. This line exists so that one, if it is
 * ever needed (the webhook receiver moving off the board is the likely one),
 * has an obvious home instead of a port chosen wherever it was written. Binding
 * it now, with no use, would be a port the next reader has to explain.
 */
export const RESERVED_PORT = 17821;

/** 0008's board has no auth, and Next's default host is `0.0.0.0`. */
export const BOARD_HOST = "127.0.0.1";

export function boardUrl(port: number): string {
  return `http://${BOARD_HOST}:${port}`;
}

/**
 * The port, and where it came from: `--port`, then `board.port` in
 * `~/.lingtai/config.yml`, then `BOARD_PORT`. **Not `apps/board/package.json`**,
 * which is where it was: somebody who installed Lingtai does not edit that.
 * The file need not exist; one that names a port that is not one is refused by
 * name rather than read as the default.
 */
export function boardPort(
  env: NodeJS.ProcessEnv,
  flag?: string,
): { port: number; from: string } | { refused: string } {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65536;
  if (flag !== undefined) {
    const n = Number(flag);
    return valid(n) ? { port: n, from: "--port" } : { refused: `--port takes a port number, not ${JSON.stringify(flag)}` };
  }
  const path = join(stateDir(env), "config.yml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { port: BOARD_PORT, from: "the default" };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    return { refused: `${path} does not parse as YAML, so board.port could not be read — ${(err as Error).message}` };
  }
  const board = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>)["board"] : undefined;
  const port = board !== null && typeof board === "object" ? (board as Record<string, unknown>)["port"] : undefined;
  if (port === undefined || port === null) return { port: BOARD_PORT, from: "the default" };
  return valid(port)
    ? { port, from: `board.port in ${path}` }
    : { refused: `board.port in ${path} is ${JSON.stringify(port)}, which is not a port number` };
}

/** Where to change it, in the words every refusal about the port ends with. */
export function whereThePortIsSet(env: NodeJS.ProcessEnv, from: string): string {
  const path = join(stateDir(env), "config.yml");
  return from.startsWith("board.port")
    ? `the port is board.port in ${path} — change it there, or pass --port`
    : `the port is ${from} — set board.port in ${path}, or pass --port`;
}

/** What answers on the port: this machine's board, something else, or nothing. */
export type PortAnswer = "board" | "other" | "nothing";

/**
 * Asked before a board is started and after one is. A connection refused is
 * nothing; a connection that is answered is a board only if it says so at
 * `/api/whoami`, so a port some other server holds is not mistaken for it —
 * and not the page's title, which a board with no database cannot render.
 * Generous with the wait, because `next dev` compiles a route on first request.
 */
export async function boardAnswers(port: number, host = BOARD_HOST): Promise<PortAnswer> {
  if (!(await accepts(host, port))) return "nothing";
  try {
    const res = await fetch(`http://${host}:${port}/api/whoami`, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => null)) as { lingtai?: unknown } | null;
    return body?.lingtai === "board" ? "board" : "other";
  } catch {
    return "other";
  }
}

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
 * `next`, in a checkout — what the board runs as when nothing was built.
 *
 * `lingtai service` runs the CLI from its checkout and never from a build, so
 * without this a supervised board would be a job that fails every thirty
 * seconds on *no built board*.
 */
export function sourceNext(root: string = repoRoot()): string | null {
  const bin = join(root, "apps", "board", "node_modules", "next", "dist", "bin", "next");
  return existsSync(bin) ? bin : null;
}

/**
 * Where `pnpm build` put the board, relative to the running CLI.
 *
 * Beside the file this was bundled into. Run from source there is no
 * `board/` beside `apps/cli/src`, and `serveBoard` says so by name.
 */
export function builtBoardDir(self: string = import.meta.filename): string {
  // Bundled, `import.meta.filename` is the bundle's — or the binary's, which
  // `apps/release/src/build.ts` makes it inside a SEA.
  return join(dirname(self), "board");
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
export async function serveBoard(options: BoardOptions & { fromSource?: string | null }): Promise<void> {
  const entry = boardEntry(options.dir);
  if (!existsSync(entry)) {
    const next = options.fromSource === undefined ? sourceNext() : options.fromSource;
    if (next === null) {
      throw new Error(`no built board at ${entry}, and no checkout to run one from. pnpm build writes one into dist/`);
    }
    await portIsFree(options.host, options.port);
    return serveSource(next, options);
  }
  await portIsFree(options.host, options.port);
  process.env["PORT"] = String(options.port);
  process.env["HOSTNAME"] = options.host;
  await importFile(pathToFileURL(entry).href);
  await listening(options.host, options.port);
}

/**
 * `next dev` from the checkout, as a child that lives and dies with this
 * process: a signal to this one is passed on, and the child's exit is this
 * one's. The port and the host are passed here, so they are never
 * `package.json`'s.
 */
async function serveSource(next: string, options: BoardOptions): Promise<void> {
  const child = spawn(
    process.execPath,
    [next, "dev", "--turbopack", "--port", String(options.port), "--hostname", options.host],
    { cwd: dirname(dirname(dirname(dirname(dirname(next))))), stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? 1;
      reject(new Error(`the board exited ${code ?? signal} before it listened on ${options.host}:${options.port}`));
      // Once listening, this process has nothing else to do.
      process.exit(code ?? (signal ? 0 : 1));
    });
  });
  await Promise.race([listening(options.host, options.port), exited]);
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
            ? `${host}:${port} is already in use, by something that is not answering as a Lingtai board`
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
    if (await accepts(host, port)) return;
    if (Date.now() > deadline) throw new Error(`the board never listened on ${host}:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}
