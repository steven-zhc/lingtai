import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformName } from "../../cli/src/version.ts";
import { buildBinary, canBuildSea } from "../src/binary.ts";
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
 *
 * Then the binary (#185), run the same way: a binary nobody executed is not a
 * binary that works, and CI runs this file on each of the four platforms. It
 * needs `node --build-sea`, so on an older Node those tests are skipped and say
 * why in their names.
 */
const work = mkdtempSync(join(tmpdir(), "lingtai-release-"));
const first = join(work, "first");
const second = join(work, "second");
const boards: ChildProcess[] = [];
const sea = canBuildSea();

beforeAll(async () => {
  // The URL is in `.env.local` beside the build and nowhere else, as it is in a
  // checkout that ran `pnpm build`: the bundle — and the binary — have to find
  // the file themselves. Refused at once: the setup page renders without the
  // log, and nothing here may reach the operator's or the test database.
  writeFileSync(join(work, ".env.local"), "LINGTAI_DATABASE_URL=postgres://127.0.0.1:1/none\n");
  await buildRelease({ out: first });
  await buildRelease({ out: second });
});

afterAll(() => {
  for (const board of boards) board.kill();
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
    await servesAPage(process.execPath, [join(first, "lingtai.cjs")]);
  });
});

describe(`pnpm binary${sea ? "" : " (skipped: node --build-sea needs Node 25.5)"}`, () => {
  it.runIf(sea)("builds one executable beside the board, which reports its version and platform", () => {
    const binary = buildBinary({ dist: first });
    expect(binary).toBe(join(first, "lingtai"));

    const version = spawnSync(binary, ["version"], { cwd: work, env: childEnv(), encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    const workspace = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"));
    expect(version.stdout).toContain(`lingtai ${workspace.version} ${platformName()} (binary,`);
  });

  it.runIf(sea)("serves a page from the built board, started by the binary", async () => {
    await servesAPage(join(first, "lingtai"), []);
  });

  // The kernel's refusal, not Gatekeeper's: an unsigned arm64 Mach-O is killed
  // at exec with SIGKILL and nothing on stderr. If the signing step in
  // `buildBinary` were dropped, the tests above would fail on a Mac the same way;
  // this one says that it is the signature, so nobody "fixes" it elsewhere.
  it.runIf(sea && process.platform === "darwin" && process.arch === "arm64")(
    "is killed at exec on Apple Silicon when it is not signed",
    () => {
      const unsigned = buildBinary({ dist: first, output: join(work, "unsigned"), sign: false });
      const run = spawnSync(unsigned, ["version"], { cwd: work, env: childEnv(), encoding: "utf8" });
      expect(run.signal).toBe("SIGKILL");
      expect(run.stdout).toBe("");
    },
  );
});

/**
 * Start `lingtai board` from a build and fetch a page and its stylesheet.
 */
async function servesAPage(command: string, args: string[]): Promise<void> {
  const port = await freePort();

  const board = spawn(command, [...args, "board", "--port", String(port)], {
    cwd: work,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  boards.push(board);
  let output = "";
  board.stdout?.on("data", (chunk) => (output += chunk));
  board.stderr?.on("data", (chunk) => (output += chunk));

  try {
    const page = await fetchWhenUp(board, `http://127.0.0.1:${port}/setup/github-app`, () => output);
    expect(page.status, output).toBe(200);
    const html = await page.text();
    expect(html).toContain("<title>Lingtai</title>");

    // Next leaves `.next/static` out of standalone; a page whose stylesheet
    // 404s is a board that answers and does not render.
    const stylesheet = html.match(/\/_next\/static\/[^"]+\.css/)?.[0];
    expect(stylesheet).toBeDefined();
    expect((await fetch(`http://127.0.0.1:${port}${stylesheet}`)).status).toBe(200);
    // Nothing between the person and the board's own lines.
    expect(output).not.toContain("ExperimentalWarning");
  } finally {
    board.kill();
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LINGTAI_HOME: join(work, "home") };
  delete env["LINGTAI_DATABASE_URL"];
  delete env["NODE_ENV"];
  for (const name of Object.keys(env)) if (name.startsWith("VITEST")) delete env[name];
  return env;
}

async function fetchWhenUp(board: ChildProcess, url: string, output: () => string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await fetch(url);
    } catch (err) {
      // Killed by a signal — as an unsigned binary is at exec on Apple Silicon —
      // `exitCode` stays null and only `signalCode` says so.
      if (board.exitCode !== null || board.signalCode !== null) {
        throw new Error(`the board exited ${board.exitCode ?? board.signalCode}:\n${output()}`);
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
