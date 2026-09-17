import { existsSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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
 * Beside the file this was bundled into. Run from source there is no
 * `board/` beside `apps/cli/src`, and `serveBoard` says so by name.
 */
export function builtBoardDir(self: string = import.meta.filename): string {
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
  await import(pathToFileURL(entry).href);
  await listening(options.host, options.port);
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
