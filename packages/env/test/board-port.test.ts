/**
 * The board's port (#187): 17820, `board.port` in `~/.lingtai/config.yml`
 * overriding it, and `17821` reserved and bound by nothing.
 *
 * The last of those is the one that needs a test. A reserved port is a comment
 * until something starts listening on it, and the day something does, the
 * comment saying *nothing binds this* is still there and is now a lie. So the
 * source is read, and every mention of the number has to be a comment or a
 * string — never an argument to `listen`.
 */
import { readFileSync, readdirSync, writeFile } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_PORT, RESERVED_PORT, boardPort, boardUrl, machineBoardPort, repoRoot } from "../src/index.ts";

const write = async (path: string, text: string): Promise<void> =>
  new Promise((resolve, reject) => writeFile(path, text, (err) => (err ? reject(err) : resolve())));

describe("the board's port", () => {
  it("is 17820 with no configuration at all, and the URL is loopback", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    expect(BOARD_PORT).toBe(17820);
    expect(boardPort({ LINGTAI_HOME: home })).toBe(17820);
    expect(boardUrl({ LINGTAI_HOME: home })).toBe("http://127.0.0.1:17820");
  });

  it("is below both kernels' ephemeral ranges, so it never collides at random", () => {
    // macOS hands out 49152–65535 and Linux 32768–60999. A default in either is
    // one the kernel also gives to other processes.
    expect(BOARD_PORT).toBeLessThan(32768);
    expect(RESERVED_PORT).toBeLessThan(32768);
    expect(BOARD_PORT).toBeGreaterThanOrEqual(10000);
  });

  it("comes from board.port in the machine file when that names one", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    expect(machineBoardPort({ LINGTAI_HOME: home })).toBeUndefined();
    await write(join(home, "config.yml"), "runtime:\n  agent: claude-code\nboard:\n  port: 18080\n");
    expect(machineBoardPort({ LINGTAI_HOME: home })).toBe(18080);
    expect(boardPort({ LINGTAI_HOME: home })).toBe(18080);
    expect(boardUrl({ LINGTAI_HOME: home })).toBe("http://127.0.0.1:18080");
  });

  it("refuses a board.port that is not a port, rather than serving on one nobody chose", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await write(join(home, "config.yml"), "board:\n  port: the usual one\n");
    expect(() => boardPort({ LINGTAI_HOME: home })).toThrow(/not a port number/);
    await write(join(home, "config.yml"), "board:\n  port: 99999\n");
    expect(() => boardPort({ LINGTAI_HOME: home })).toThrow(/not a port number/);
  });

  it("refuses a file that does not parse by its path, rather than falling back to the default", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await write(join(home, "config.yml"), "board: [unclosed\n");
    expect(() => machineBoardPort({ LINGTAI_HOME: home })).toThrow(join(home, "config.yml"));
  });
});

/**
 * Every `.ts` under each workspace package's `src`. The generated board and
 * anything installed are skipped: this is about what this repository binds.
 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
    }
  };
  for (const workspace of ["apps", "packages"]) {
    let packages;
    try {
      packages = readdirSync(join(repoRoot(), workspace), { withFileTypes: true });
    } catch {
      continue;
    }
    // `src` alone: a test that names the port — this one does, four times — is
    // not a process listening on it.
    for (const pkg of packages) if (pkg.isDirectory()) walk(join(repoRoot(), workspace, pkg.name, "src"));
  }
  return out;
}

describe("17821, reserved", () => {
  it("is not the board's, and nothing is served on it", () => {
    expect(RESERVED_PORT).not.toBe(BOARD_PORT);
  });

  it("is bound by nothing — every mention of it in the source is prose", () => {
    const files = sources();
    // Or the scan found nothing and the assertion below is vacuous: this file's
    // own package is in it, and so is the declaration.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => readFileSync(f, "utf8").includes("export const RESERVED_PORT = 17821;"))).toBe(true);
    const mentions: string[] = [];
    for (const path of files) {
      for (const line of named(readFileSync(path, "utf8"))) mentions.push(`${path}: ${line}`);
    }
    expect(mentions).toEqual([]);
  });

  /**
   * The scan, against the line it exists for. A scan that finds nothing
   * because it can see nothing passes the test above for ever, and the day
   * something binds the port the comment saying otherwise is still there.
   */
  it("sees a listener written without the digits, which is how one would actually be written", () => {
    expect(named(`  createServer().listen(RESERVED_PORT, "127.0.0.1");\n`)).toEqual([
      'createServer().listen(RESERVED_PORT, "127.0.0.1");',
    ]);
    expect(named(`import { RESERVED_PORT } from "@lingtai/env";\n`)).toEqual(['import { RESERVED_PORT } from "@lingtai/env";']);
    expect(named(`  server.listen(17821);\n`)).toEqual(["server.listen(17821);"]);
    // And prose is still prose, or the test above never passes at all.
    expect(named(" * `17821` is reserved, and `RESERVED_PORT` is where it is written down.\n")).toEqual([]);
    expect(named("export const RESERVED_PORT = 17821;\n")).toEqual([]);
  });
});

/**
 * Every line of `text` that names the reserved port and is not prose.
 *
 * **The identifier as well as the number**, which is the whole of it: a
 * `createServer().listen(RESERVED_PORT)` carries no `17821`, so a scan for the
 * digits alone passed it and left the comment beside `RESERVED_PORT` —
 * *bound by nothing* — standing over a port that was now bound. An `import` of
 * the name counts too: importing it is the only way to bind it without the
 * number, and there is nothing else in this repository to import it for.
 */
const NAMES = /17821|RESERVED_PORT/;

function named(text: string): string[] {
  if (!NAMES.test(text)) return [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!NAMES.test(line)) continue;
    // A comment, or the declaration itself. Anything else — a `listen`, a
    // default, a URL, an import — is a port that is no longer reserved, and the
    // comment beside `RESERVED_PORT` saying so is no longer true.
    const prose = /^\s*(\/\/|\*|\/\*)/.test(line) || /^export const RESERVED_PORT = 17821;$/.test(line.trim());
    if (!prose) out.push(line.trim());
  }
  return out;
}
