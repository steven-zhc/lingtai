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
  // `DATABASE_URL` too: the pre-#63 name is a connection somebody named, and
  // `storeChoice` refuses rather than choosing SQLite past it (0055 §2). A
  // developer who has one exported would otherwise get that refusal here
  // instead of this file's subject, which is a machine that named nothing.
  const env = {
    ...process.env,
    HOME: home,
    LINGTAI_HOME: home,
    LINGTAI_DATABASE_URL: "",
    LINGTAI_DIRECT_DATABASE_URL: "",
    DATABASE_URL: "",
  };
  delete env["VITEST"];
  delete env["LINGTAI_TEST"];
  return env;
}

async function lingtai(args: string[], env = sqliteMachine()): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], { env, timeout: 120_000 });
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

  /**
   * **`board` appends nothing and serves the page that does.** The board runs
   * in this same process, and `/setup/github-app`'s first screen is a Create
   * button: pressing it runs `create-app.ts`'s `append(...GitHubAppCreated)`
   * through the singleton, with no projector and no Postgres in the way, so a
   * SQLite machine got its App minted and recorded at seq 1 in
   * `~/.lingtai/lingtai.db` — and the page said so, on the one machine every
   * other command tells the operator to abandon. `lingtai init` stops before
   * this screen (0055 §7); this is the other door to it.
   *
   * Before `serveBoard`, so what is asserted is the store and not a missing
   * `dist/board`: there is no built board in this worktree, and the refusal
   * that arrives is the one naming the variable.
   */
  it("lingtai board refuses before it serves the wizard that appends", async () => {
    const { code, out } = await lingtai(["board", "--port", "3271"]);

    expect(code).not.toBe(0);
    expect(out).toContain("LINGTAI_DATABASE_URL is not set");
    expect(out).toContain("GitHubAppCreated");
    // Not the board's own refusal — the store's, which comes first.
    expect(out).not.toContain("no built board at");
    expect(out).not.toContain("board on http://");
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

/**
 * **The machine next door, which chose nothing either** (#63). `DATABASE_URL`
 * is what `LINGTAI_DATABASE_URL` used to be called, and it is what every
 * provider's dashboard still calls the variable — so the operator who has one
 * and no prefixed line is either a pre-#63 install or one keystroke from being
 * right. `storeChoice` refuses there rather than reading the absence as a
 * decision, and `lingtai doctor` has to say the same thing the refusal says.
 *
 * Through the real command, because `doctorReport` assembles the environment
 * `runDoctor` sees and writes the *resolved* URLs back under the unprefixed
 * names — deleting them where nothing resolved. A `store` row that read
 * `DATABASE_URL` out of that copy would find it gone on exactly the machine it
 * exists to recognise, and a unit test handing `runDoctor` an environment
 * directly would never notice.
 */
describe("a machine that names only the pre-#63 name (#63, #179)", () => {
  const renamed = (): NodeJS.ProcessEnv => ({ ...sqliteMachine(), DATABASE_URL: URL_ });

  it("lingtai doctor calls it no store at all, names the rename, and does not call it SQLite", async () => {
    const { out } = await lingtai(["doctor"], renamed());

    expect(out).toContain("DATABASE_URL names a connection");
    expect(out).toContain("#63");
    // The two sentences that were false about this machine.
    expect(out).not.toContain("absence is the choice");
    expect(out).not.toContain("no Postgres URL to check");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);

  it("lingtai add refuses with the rename rather than with the store", async () => {
    const { code, out } = await lingtai(["add", "steven/foo"], renamed());

    expect(code).not.toBe(0);
    expect(out).toContain("it was renamed to LINGTAI_DATABASE_URL (#63)");
    expect(out).not.toContain("this machine's log is SQLite");
    expect(out).not.toContain("added steven/foo");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);
});
