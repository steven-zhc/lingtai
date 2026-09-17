import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMS as INSTALLS } from "../../cli/src/install.ts";
import { buildRelease, layout, nativeFiles } from "../src/build.ts";
import { PLATFORMS, packRelease } from "../src/pack.ts";

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
let installed: ChildProcess | undefined;

beforeAll(async () => {
  await buildRelease({ out: first });
  await buildRelease({ out: second });
});

afterAll(() => {
  board?.kill();
  installed?.kill();
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
    // The URL is in `.env.local` beside the build and nowhere else, as it is in
    // a checkout that ran `pnpm build`: the bundle has to find the file itself.
    // Refused at once: the setup page renders without the log, and nothing
    // here may reach the operator's or the test database.
    writeFileSync(join(work, ".env.local"), "LINGTAI_DATABASE_URL=postgres://127.0.0.1:1/none\n");
    const env: NodeJS.ProcessEnv = { ...process.env, LINGTAI_HOME: join(work, "home") };
    delete env["LINGTAI_DATABASE_URL"];
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

    const page = await fetchWhenUp(board, `http://127.0.0.1:${port}/setup/github-app`, () => output);
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

/**
 * `install.sh`, run as `curl | sh` runs it, over the tarballs `pnpm release`
 * packs from the build above (#184). `file://` stands in for GitHub Releases:
 * the script fetches with `curl` either way.
 */
describe("install.sh", () => {
  const installer = join(import.meta.dirname, "..", "..", "site", "public", "install.sh");
  const releases = join(work, "releases");
  const user = join(work, "user");
  const shim = join(user, ".local", "bin", "lingtai");

  function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...process.env, HOME: user, LINGTAI_RELEASES_URL: `file://${releases}`, ...extra };
    for (const name of ["LINGTAI_HOME", "LINGTAI_BIN_DIR", "LINGTAI_DATABASE_URL", "LINGTAI_DIRECT_DATABASE_URL", "NODE_ENV"]) {
      if (!(name in extra)) delete out[name];
    }
    for (const name of Object.keys(out)) if (name.startsWith("VITEST")) delete out[name];
    return out;
  }
  function install(version: string, extra: NodeJS.ProcessEnv = {}) {
    const ran = spawnSync("sh", [installer], { env: env({ LINGTAI_VERSION: version, ...extra }), encoding: "utf8", cwd: work });
    return { code: ran.status, said: `${ran.stdout}${ran.stderr}` };
  }
  function lingtai(...args: string[]) {
    const ran = spawnSync(shim, args, { env: env(), encoding: "utf8", cwd: work });
    return { code: ran.status, said: `${ran.stdout}${ran.stderr}`.trim() };
  }

  beforeAll(() => {
    for (const v of ["1.0.0", "1.0.1"]) packRelease({ dist: first, out: join(releases, `v${v}`), version: v });
  });

  it("packs one artifact for each platform the CLI installs, and checksums for all of them", () => {
    expect([...PLATFORMS]).toEqual([...INSTALLS]);
    const sums = readFileSync(join(releases, "v1.0.0", "SHA256SUMS"), "utf8");
    for (const p of PLATFORMS) expect(sums).toContain(`lingtai-1.0.0-${p}.tar.gz`);
  });

  it("installs into versions/<v>, shims ~/.local/bin/lingtai, and says so again, changing nothing, when run twice", () => {
    const once = install("1.0.0");
    expect(once.code, once.said).toBe(0);
    expect(once.said).toContain("checksum verified");
    expect(existsSync(join(user, ".lingtai", "versions", "1.0.0", "board", "apps", "board", "server.js"))).toBe(true);
    expect(lingtai("version").said).toBe("lingtai 1.0.0");

    const twice = install("1.0.0");
    expect(twice.code, twice.said).toBe(0);
    expect(twice.said).toContain("is already in");
    expect(twice.said).toContain("already runs 1.0.0");
  });

  it("refuses an artifact whose checksum does not match, before unpacking it", () => {
    const bad = join(releases, "v1.0.2");
    mkdirSync(bad, { recursive: true });
    for (const p of PLATFORMS) cpSync(join(releases, "v1.0.0", `lingtai-1.0.0-${p}.tar.gz`), join(bad, `lingtai-1.0.2-${p}.tar.gz`));
    writeFileSync(join(bad, "SHA256SUMS"), PLATFORMS.map((p) => `${"0".repeat(64)}  lingtai-1.0.2-${p}.tar.gz`).join("\n"));

    const ran = install("1.0.2");
    expect(ran.code).toBe(1);
    expect(ran.said).toContain("does not match its checksum");
    expect(existsSync(join(user, ".lingtai", "versions", "1.0.2"))).toBe(false);
    expect(existsSync(join(user, ".lingtai", "versions", ".1.0.2.partial"))).toBe(false);
  });

  it("refuses a platform nothing is built for by name", () => {
    const bin = join(work, "fake-uname");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "uname"), '#!/bin/sh\ncase "$1" in -s) echo FreeBSD ;; *) echo amd64 ;; esac\n');
    chmodSync(join(bin, "uname"), 0o755);
    const ran = install("1.0.1", { PATH: `${bin}:${process.env["PATH"]}` });
    expect(ran.code).toBe(1);
    expect(ran.said).toContain("no Lingtai is built for FreeBSD amd64");
  });

  it("moves the shim to a newer version, and lingtai rollback moves it back to a directory that still serves the board", async () => {
    const upgrade = install("1.0.1");
    expect(upgrade.code, upgrade.said).toBe(0);
    expect(upgrade.said).toContain("now runs 1.0.1 (was 1.0.0");
    expect(lingtai("version").said).toBe("lingtai 1.0.1");

    const back = lingtai("rollback");
    expect(back.code, back.said).toBe(0);
    expect(lingtai("version").said).toBe("lingtai 1.0.0");

    // Bundled, the CLI reads `.env.local` one directory above itself (0049),
    // which for an installed copy is `versions/`.
    writeFileSync(join(user, ".lingtai", "versions", ".env.local"), "LINGTAI_DATABASE_URL=postgres://127.0.0.1:1/none\n");
    const port = await freePort();
    installed = spawn(shim, ["board", "--port", String(port)], { env: env(), cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    installed.stdout?.on("data", (chunk) => (output += chunk));
    installed.stderr?.on("data", (chunk) => (output += chunk));
    const page = await fetchWhenUp(installed, `http://127.0.0.1:${port}/setup/github-app`, () => output);
    expect(page.status, output).toBe(200);
  });
});

async function fetchWhenUp(child: ChildProcess, url: string, output: () => string): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await fetch(url);
    } catch (err) {
      if (child.exitCode !== null) {
        throw new Error(`the board exited ${child.exitCode}:\n${output()}`);
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
