/**
 * **Every command, on a machine whose log is SQLite** (#179).
 *
 * The first version of this file asserted three: `add`, `pause` and `board`,
 * the commands that hold no projector — on the reasoning that every other one
 * dies in `createProjectionRunner`, which reads `databaseUrl()` while it is
 * being built. It does not hold. `ask`, `answer`, `close`, `requeue` and
 * `approve` call `loadProject` *before* `withProjector`, and `run` reads the
 * pause off the control stream first, so each went through the event-store
 * singleton, created `~/.lingtai/lingtai.db`, read the empty log it had just
 * made, and refused with `no project named "foo"` — a sentence about the wrong
 * fault, on a machine it had just quietly given a log to. `lingtai service
 * shutdown` was worse: it reaches the identical `ConductorShutdownRequested`
 * append through `drain()` rather than `controlCommand`, so under launchd it
 * drained, wrote the request where no daemon reads, and exited 0.
 *
 * So the table is asserted, and then the commands, and then that the table
 * covers the commands — which is the assertion the first version was missing:
 * a guard nobody called is what the documents already were, and a guard called
 * for three doors out of twenty is the same thing with a test beside it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REFUSAL, refusedBecauseSqlite } from "../src/store.ts";

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

  /**
   * **The five the projector was supposed to refuse for, and did not.**
   * `withProjector` builds `createProjectionRunner`, which reads
   * `databaseUrl()` — but `loadProject` runs before it in `ask`, `answer`,
   * `close`, `requeue` and `approve`, and `run.ts`'s `heedThePause` reads the
   * control stream before the projector exists. So each reached the singleton,
   * created the log, read it back empty, and said `no project named "foo"` or
   * `no GitHub App configured`: not one of them naming the variable every
   * document says they name.
   *
   * Through the real command, because the ordering *is* the defect — a unit
   * test of any one of these functions would have agreed with the reasoning
   * that was wrong.
   */
  it.each([
    ["ask", ["ask", "foo", "--issue", "1", "a question"]],
    ["answer", ["answer", "foo", "--issue", "1", "a choice"]],
    ["close", ["close", "foo", "--issue", "1", "a reason"]],
    ["requeue", ["requeue", "foo", "--issue", "1", "--note", "why"]],
    ["approve", ["approve", "foo", "--issue", "1"]],
    ["run", ["run", "foo", "--issue", "1"]],
  ])("lingtai %s refuses by name, before it makes the log it would read", async (_name, args) => {
    const { code, out } = await lingtai(args);

    expect(code).not.toBe(0);
    expect(out).toContain("LINGTAI_DATABASE_URL is not set");
    // The two sentences that were said instead, each about a fault this
    // machine does not have and neither naming the variable.
    expect(out).not.toContain("no project named");
    expect(out).not.toContain("no GitHub App configured");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);

  /**
   * **The second door to `ConductorShutdownRequested`.** `lingtai shutdown`
   * appends it through `controlCommand`; `lingtai service shutdown`,
   * `restart` and `uninstall` append the identical event through `drain()`,
   * which is not that function and was not guarded. The lock is a file (0052)
   * so it is taken, the request is written into a fresh SQLite log the running
   * daemon reads nothing of, and the command prints `withdrew the drain` and
   * exits 0 — the drain #174 exists to perform, reported as done.
   */
  it("lingtai service shutdown refuses rather than draining into a log nobody reads", async () => {
    const { code, out } = await lingtai(["service", "shutdown", "deploying"]);

    expect(code).not.toBe(0);
    expect(out).toContain("LINGTAI_DATABASE_URL is not set");
    expect(out).not.toContain("draining");
    expect(out).not.toContain("withdrew the drain");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);

  /**
   * **A typo is still a typo.** The gate reads `REFUSAL`, and a command with no
   * row is not gated — so `lingtai add-project` says `unknown command` rather
   * than a sentence about a database, which is the one thing a blanket refusal
   * before the switch would have cost.
   */
  it("says unknown command for one it does not dispatch", async () => {
    const { out } = await lingtai(["add-project"]);

    expect(out).toContain('unknown command "add-project"');
    expect(out).not.toContain("LINGTAI_DATABASE_URL is not set");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);

  /**
   * **`--help` is a question, never an instruction** — on this machine too.
   * `lingtai shutdown --help` once took `--help` as the reason and stopped the
   * daemon, so `controlCommand` answers it before anything else, and that is
   * the whole of why the four control verbs are `within` rather than `here`.
   */
  it("answers lingtai shutdown --help rather than refusing it", async () => {
    const { code, out } = await lingtai(["shutdown", "--help"]);

    expect(code).toBe(0);
    expect(out).toContain("event-sourced scheduler");
    expect(out).not.toContain("LINGTAI_DATABASE_URL is not set");
    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
  }, 180_000);
});

/**
 * **The row with one side** (#167's rule for `RESTART_GUARDS`, applied here).
 *
 * `REFUSAL` is what `main` refuses on, so a command dispatched with no row in
 * it is a door the gate does not know about — which is precisely what `ask`,
 * `close`, `requeue`, `run` and `service shutdown` were. Reading the `case`
 * labels out of the source rather than importing them, because `lingtai.ts`
 * runs `main` at module scope: importing it would run the CLI.
 */
describe("the table covers every command lingtai.ts dispatches (#179)", () => {
  const dispatched = (): string[] => {
    const source = readFileSync(resolve(here, "../src/lingtai.ts"), "utf8");
    return [...source.matchAll(/case "([^"]*)":/g)].map((m) => m[1]!);
  };

  it("has a row for each, and rows for nothing else", () => {
    const cases = dispatched();

    // The regex is the test's own weak point: a `main` that stopped being a
    // switch would leave it asserting nothing, loudly enough to notice.
    expect(cases.length).toBeGreaterThan(20);
    expect([...cases].sort()).toEqual(Object.keys(REFUSAL).sort());
  });

  it("refuses by default: only the machine's own commands run without a log", () => {
    // Named rather than counted. Each is about the installation or the machine
    // rather than about the log, which is `entry.ts`'s rule for its five.
    const runs = Object.keys(REFUSAL).filter((c) => REFUSAL[c] === "never");
    expect(runs.sort()).toEqual(["-h", "--help", "attach", "doctor", "env", "help", "init", "version"].sort());

    // And the exception is the four control verbs, for `--help` and nothing
    // else — every other command is refused before it runs.
    const within = Object.keys(REFUSAL).filter((c) => REFUSAL[c] === "within");
    expect(within.sort()).toEqual(["now", "pause", "resume", "shutdown"]);
  });
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
