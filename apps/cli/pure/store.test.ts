/**
 * **The two commands that append without holding a projector**, on a machine
 * whose log is SQLite (#179).
 *
 * Every other appending command refuses because `createProjectionRunner` reads
 * `databaseUrl()` while it is being built, and there is nothing to read. `add`
 * and the four control verbs hold no projector — the second deliberately, so a
 * pause does not replay a backlog before it pauses anything — so they reached
 * `eventStore` directly, and the singleton opened the store absence had chosen.
 * `lingtai add steven/foo` therefore *succeeded*: `ProjectConfigured` at seq 1
 * in `~/.lingtai/lingtai.db`, `added steven/foo`, exit 0 — into a log the
 * board cannot read and `lingtai run` cannot conduct from, on a machine whose
 * own `lingtai doctor`, README and `init` line all tell the operator to name a
 * Postgres URL and start again.
 *
 * The refusals are asserted twice over: the sentence, and then the command,
 * because a guard nobody called is what the documents already were.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refusedBecauseSqlite } from "../src/store.ts";

const run = promisify(execFile);
const here = resolve(fileURLToPath(import.meta.url), "..");
const entry = resolve(here, "../src/entry.ts");
const URL_ = "postgresql://u:p@db.example.com:5432/postgres";

let home = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lingtai-store-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * The machine the finding describes: nothing names a Postgres connection, and
 * nothing is meant to. `VITEST` and the `TEST_` names are taken out because a
 * child that kept them would be asked for the suite's own database instead —
 * which is `storeChoice`'s other rule, and not this one.
 */
function sqliteMachine(): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home, LINGTAI_HOME: home, LINGTAI_DATABASE_URL: "", LINGTAI_DIRECT_DATABASE_URL: "" };
  delete env["VITEST"];
  delete env["LINGTAI_TEST"];
  return env;
}

async function lingtai(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], { env: sqliteMachine(), timeout: 120_000 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("a command that appends, on a SQLite machine (#179)", () => {
  it("refuses by name, and says nothing was written", () => {
    const said = refusedBecauseSqlite({ LINGTAI_HOME: "/tmp/lingtai-home" });

    expect(said).toContain("LINGTAI_DATABASE_URL is not set");
    expect(said).toContain("/tmp/lingtai-home/lingtai.db");
    expect(said).toContain("Nothing was written");
    // Both ways out, as the doctor row has them.
    expect(said).toContain("#175");
    expect(said).toContain("lingtai init");
  });

  it("does not refuse where a Postgres URL names the log", () => {
    expect(refusedBecauseSqlite({ LINGTAI_DATABASE_URL: URL_ })).toBeNull();
  });

  /**
   * A missing line, not a decision (0055 §2) — `storeChoice` refuses it by
   * name, and this passes that refusal through rather than answering for it.
   */
  it("lets a machine that named only the direct URL refuse by name", () => {
    expect(() => refusedBecauseSqlite({ LINGTAI_DIRECT_DATABASE_URL: URL_, LINGTAI_HOME: "/tmp/lingtai-home" })).toThrow(
      /LINGTAI_DATABASE_URL is not set/,
    );
  });

  it("lingtai add writes nothing and exits non-zero", async () => {
    const { code, out } = await lingtai(["add", "steven/foo"]);

    expect(code).not.toBe(0);
    expect(out).toContain("LINGTAI_DATABASE_URL is not set");
    expect(out).not.toContain("added steven/foo");
    // The log itself: not created, so there is none to leave behind when the
    // operator does what every one of these sentences tells them to do next.
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);

  it("lingtai pause writes nothing and exits non-zero", async () => {
    const { code, out } = await lingtai(["pause", "a reason"]);

    expect(code).not.toBe(0);
    expect(out).toContain("LINGTAI_DATABASE_URL is not set");
    expect(out).not.toContain("paused");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);
});
