/**
 * *Is a log configured* is never answered by catching *what is the Postgres URL*
 * (#213).
 *
 * The three instances in `apps/cli/src/entry.ts` were each one line, each
 * correct while every log was Postgres, and each invisible to `tsc` — the
 * answer was a thrown error and a `catch`. #179 spent five passes and about
 * $100 on them: its reviewer named the conflation in round one and was still
 * finding fresh instances in round four, because nothing enumerated what
 * *done* was. This does.
 *
 * So the source is read, the way `board-port.test.ts` reads it for a port that
 * nothing may bind. A `try` around `postgresUrl()` is not always wrong — it is
 * wrong when what the `catch` produces is an answer about *configuration*, and
 * the cheapest rule that catches every instance this repository has had is: do
 * not wrap the getter in a `try` at all. `logConfigured()` is a boolean.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { logConfigured, postgresUrl, postgresUrlIfSet, repoRoot } from "../src/index.ts";

/**
 * Every `.ts` under each workspace package's `src`. Tests are not scanned: a
 * test that asserts `postgresUrl` refuses has to call it inside a `try`, and
 * this file is one of them.
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
    for (const pkg of packages) if (pkg.isDirectory()) walk(join(repoRoot(), workspace, pkg.name, "src"));
  }
  return out;
}

/**
 * A `try` whose body calls a getter and whose failure is caught.
 *
 * `[^{}]` and not `.`: the body has to be the straight-line kind — which every
 * instance was, `try { databaseUrl(); } catch { return null; }` — so a
 * connection opened inside a `try` that happens to build an object is not
 * named. This is a scan for the shape that hid the question, not for every
 * exception anybody handles.
 */
const CAUGHT = /\btry\s*\{[^{}]*\b(?:postgresUrl|directPostgresUrl)\s*\([^{}]*\}\s*catch\b/;

function catching(text: string): boolean {
  return CAUGHT.test(text);
}

describe("the two questions", () => {
  it("are two, and the boolean one does not throw where the other does", () => {
    expect(() => postgresUrl({})).toThrow();
    expect(logConfigured({})).toBe(false);
    expect(postgresUrlIfSet({})).toBeUndefined();
  });

  it("is a scan that sees the shape it exists for", () => {
    // Verbatim from `entry.ts` before this landed, with the name updated —
    // or the assertion below passes for ever because it can see nothing.
    expect(catching("    try {\n      postgresUrl();\n    } catch {\n      return null;\n    }\n")).toBe(true);
    expect(catching("try { return Boolean(postgresUrl()); } catch { return false; }")).toBe(true);
    expect(catching("  try {\n    env['DIRECT_DATABASE_URL'] = directPostgresUrl();\n  } catch {\n    delete x;\n  }")).toBe(
      true,
    );
    // And the shapes that are not it: the plain call, and the boolean.
    expect(catching("const pool = new pg.Pool({ connectionString: postgresUrl() });")).toBe(false);
    expect(catching("if (!logConfigured(env)) return null;")).toBe(false);
  });

  it("is asked of no source file: nothing catches a URL getter to learn whether a log exists", () => {
    const files = sources();
    // Or the scan walked nothing at all.
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((path) => catching(readFileSync(path, "utf8")))).toEqual([]);
  });
});

/**
 * **A boolean that throws is the `catch` in a different shape**, and the place
 * it would land is `~/.lingtai/config.yml`: `machineDatabaseUrl` refuses a file
 * it cannot parse (#186), and both reads fall back to that file.
 *
 * `lingtai upgrade` and `lingtai uninstall` are the two commands that repair a
 * broken install, and both begin by asking where this machine's log is —
 * `storeChoice()`, which is total, beside a look for the `lingtai.db` that may
 * be sitting under `stateDir()` whatever that choice says, with
 * `logConfigured()` answering the other half: is there also a log somewhere
 * else (#214) — so a `config.yml` truncated mid-write must not be what
 * stops them. What it does stop is a connection: `postgresUrl()` still names
 * the file, which is the one remedy that works.
 *
 * **In a child process, because this question cannot be asked in-process.**
 * The machine file is read only for `process.env` and only outside a test
 * (`machineUrl`), which is #186's rule and not a thing to weaken for a test —
 * so the probe is a real process that is not one. `LINGTAI_DATABASE_URL=` is
 * passed empty on purpose: dotenv does not overwrite a name that is already
 * there, so the checkout's own `.env.local` cannot answer for the machine.
 */
describe("a config.yml that cannot be parsed", () => {
  interface Probe {
    configured: boolean;
    ifSet: string | null;
    direct: string | null;
    url: string | null;
    refusal: string | null;
  }

  function probe(config: string): { home: string; read: Probe } {
    const home = mkdtempSync(join(tmpdir(), "lingtai-two-questions-"));
    writeFileSync(join(home, "config.yml"), config);
    const script = join(home, "probe.mjs");
    const index = pathToFileURL(join(repoRoot(), "packages", "env", "src", "index.ts")).href;
    writeFileSync(
      script,
      `import { directUrlIfSet, logConfigured, postgresUrl, postgresUrlIfSet } from ${JSON.stringify(index)};\n` +
        `const out = { configured: logConfigured(), ifSet: postgresUrlIfSet() ?? null, direct: directUrlIfSet() ?? null, url: null, refusal: null };\n` +
        `try { out.url = postgresUrl(); } catch (err) { out.refusal = err.message; }\n` +
        `console.log(JSON.stringify(out));\n`,
    );
    const ran = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        LINGTAI_HOME: home,
        // Empty is absent to `optional`, and present to dotenv.
        LINGTAI_DATABASE_URL: "",
        LINGTAI_DIRECT_DATABASE_URL: "",
      },
    });
    expect(ran.stderr).not.toContain("could not be parsed as YAML");
    expect(ran.status).toBe(0);
    return { home, read: JSON.parse(ran.stdout.trim().split("\n").at(-1)!) as Probe };
  }

  it("is no log, and not an exception — so the commands that repair an install still run", () => {
    // Truncated mid-write, which is how a machine arrives in this state.
    const { home, read } = probe('database:\n  url: "postgres://u:p@h/db');
    expect(read.configured).toBe(false);
    expect(read.ifSet).toBeNull();
    expect(read.direct).toBeNull();
    // And the refusal is not lost: it is the caller about to connect that gets
    // it, naming the file rather than the variable nobody set.
    expect(read.url).toBeNull();
    expect(read.refusal).toContain(join(home, "config.yml"));
    expect(read.refusal).toContain("could not be parsed as YAML");
  });

  it("is the same process reading the same file, where the file is whole", () => {
    const url = "postgresql://u:p@db.example.com:5432/postgres";
    const { read } = probe(`database:\n  url: ${url}\n`);
    expect(read.configured).toBe(true);
    expect(read.ifSet).toBe(url);
    expect(read.url).toBe(url);
    // #176's stand-in, from the file too.
    expect(read.direct).toBe(url);
    expect(read.refusal).toBeNull();
  });
});
