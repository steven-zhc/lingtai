import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelease, layout, nativeFiles } from "../src/build.ts";

/**
 * `pnpm build`, built and then run (#183).
 *
 * A build that produces files nobody started is not proven, so the board here
 * is started the way it ships: `node lingtai.cjs board`, a CommonJS file
 * reaching an ESM `server.js` through `import()`. Asserting that the path
 * exists would pass on a bundle whose `import()` esbuild had rewritten into a
 * `require()` that throws `ERR_REQUIRE_ESM`.
 *
 * Built twice, because "reproducible" is a comparison and one build has nothing
 * to compare with.
 */
const work = mkdtempSync(join(tmpdir(), "lingtai-release-"));
const first = join(work, "first");
const second = join(work, "second");
let board: ChildProcess | undefined;

beforeAll(async () => {
  await buildRelease({ out: first });
  await buildRelease({ out: second });
});

afterAll(() => {
  board?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe("pnpm build", () => {
  it("writes the CLI as one CommonJS file beside the board, and a package that is not private", () => {
    expect(readdirSync(first).sort()).toEqual(["board", "lingtai.cjs", "package.json"]);
    expect(existsSync(join(first, "board", "apps", "board", "server.js"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(first, "package.json"), "utf8"));
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ lingtai: "lingtai.cjs" });
  });

  it("leaves no native file in the board, so it is the same on every platform", () => {
    expect(nativeFiles(join(first, "board"))).toEqual([]);
  });

  it("gives the same layout on a second build", () => {
    expect(layout(second)).toEqual(layout(first));
  });

  it("serves a page from the built board, started by the bundled CLI", async () => {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Refused at once: the setup page renders without the log, and nothing
      // here may reach the operator's or the test database.
      LINGTAI_DATABASE_URL: "postgres://127.0.0.1:1/none",
      LINGTAI_HOME: join(work, "home"),
    };
    delete env["NODE_ENV"];
    for (const name of Object.keys(env)) if (name.startsWith("VITEST")) delete env[name];

    board = spawn(process.execPath, [join(first, "lingtai.cjs"), "board", "--port", String(port)], {
      cwd: work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    board.stdout?.on("data", (chunk) => (output += chunk));
    board.stderr?.on("data", (chunk) => (output += chunk));

    const page = await fetchWhenUp(`http://127.0.0.1:${port}/setup/github-app`, () => output);
    expect(page.status, output).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Lingtai</title>");

    // Next leaves `.next/static` out of standalone; a page whose stylesheet
    // 404s is a board that answers and does not render.
    const stylesheet = html.match(/\/_next\/static\/[^"]+\.css/)?.[0];
    expect(stylesheet).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${port}${stylesheet}`)).status).toBe(200);
  });
});

async function fetchWhenUp(url: string, output: () => string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await fetch(url);
    } catch (err) {
      if (board?.exitCode !== null && board?.exitCode !== undefined) {
        throw new Error(`the board exited ${board.exitCode}:\n${output()}`);
      }
      if (Date.now() > deadline) throw new Error(`the board never answered ${url}:\n${output()}`, { cause: err });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}
