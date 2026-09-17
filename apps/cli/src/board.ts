import { existsSync } from "node:fs";
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
 * Start the board in this process. Resolves once `server.js` has been loaded;
 * the server keeps the process alive after that.
 *
 * `server.js` reads `PORT` and `HOSTNAME` from the environment and nothing
 * else, and `chdir`s into its own directory. The host is always set: 0008's
 * board has no auth, and Next's default is `0.0.0.0`.
 */
export async function serveBoard(options: BoardOptions): Promise<void> {
  const entry = boardEntry(options.dir);
  if (!existsSync(entry)) {
    throw new Error(
      `no built board at ${entry}. pnpm build writes one into dist/; from the source, pnpm --filter @lingtai/board dev`,
    );
  }
  process.env["PORT"] = String(options.port);
  process.env["HOSTNAME"] = options.host;
  await import(pathToFileURL(entry).href);
}
