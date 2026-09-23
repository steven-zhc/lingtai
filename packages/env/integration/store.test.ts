/**
 * Which store this machine runs, read from the one place it is written
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md), #215).
 *
 * Every case here hands in an environment with a `LINGTAI_HOME` of its own, so
 * the file being read is the test's and never the operator's — and the four
 * answers are asserted as four, because three of them are refusals and a
 * refusal that nobody can tell apart from the others is a refusal that names
 * nothing.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SQLITE_LOG, type StoreChoice, describeStore, repoRoot, storeChoice } from "../src/index.ts";

const URL_ = "postgresql://me:secret@db.example:5432/lingtai";

async function home(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lingtai-store-"));
  if (config !== undefined) await writeFile(join(dir, "config.yml"), config);
  return dir;
}

describe("the four answers", () => {
  it("refuses a machine that was never set up, and names the command that sets it up", async () => {
    const dir = await home();
    const choice = storeChoice({ LINGTAI_HOME: dir });
    expect(choice).toMatchObject({ because: "nothing chosen" });
    expect(describeStore(choice)).toContain("lingtai init");

    // Written by #186, before the store was a value: a URL and no choice. It is
    // still *not set up* — the two states must not collapse into one (0016 §4)
    // — and the refusal says the URL is there, or it reads as a lie.
    const older = storeChoice({ LINGTAI_HOME: await home(`database:\n  url: ${URL_}\n`) });
    expect(older).toMatchObject({ because: "nothing chosen" });
    expect(describeStore(older)).toContain("database.url");
    expect(describeStore(older)).toContain("lingtai init");
  });

  it("is SQLite where SQLite is written, under the machine's own directory", async () => {
    const dir = await home("database:\n  store: sqlite\n");
    expect(storeChoice({ LINGTAI_HOME: dir })).toEqual({
      store: "sqlite",
      path: join(dir, SQLITE_LOG),
      where: "config.yml",
      from: join(dir, "config.yml"),
    });
  });

  it("is Postgres where Postgres is written with a URL", async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`);
    expect(storeChoice({ LINGTAI_HOME: dir })).toMatchObject({ store: "postgres", url: URL_, where: "config.yml" });
  });

  it("refuses Postgres with no URL anywhere, saying where one is looked for", async () => {
    const dir = await home("database:\n  store: postgres\n");
    const choice = storeChoice({ LINGTAI_HOME: dir });
    expect(choice).toMatchObject({ because: "no url" });
    const said = describeStore(choice);
    expect(said).toContain("LINGTAI_DATABASE_URL");
    expect(said).toContain("database.url");
    expect(said).toContain(".env.local does not decide this");
  });

  it("refuses SQLite beside a URL by quoting both, and never the password", async () => {
    const dir = await home(`database:\n  store: sqlite\n  url: ${URL_}\n`);
    const choice = storeChoice({ LINGTAI_HOME: dir });
    expect(choice).toMatchObject({ because: "two keys" });
    const said = describeStore(choice);
    expect(said).toContain("database.store: sqlite");
    expect(said).toContain("database.url");
    expect(said).toContain("db.example");
    expect(said).not.toContain("secret");
  });

  it("refuses a store it has never heard of rather than picking one", async () => {
    const dir = await home("database:\n  store: mysql\n");
    expect(describeStore(storeChoice({ LINGTAI_HOME: dir }))).toContain("neither postgres nor sqlite");
  });
});

/**
 * **A refusal is data, never an exception** — the rule #213 settled one layer
 * down. `lingtai upgrade` and `lingtai uninstall` are the commands that repair
 * a broken install, and a `config.yml` truncated mid-write must not be what
 * stops them.
 */
describe("a file that cannot be read", () => {
  it("is a refusal naming the file, and nothing thrown", async () => {
    const dir = await home('database:\n  store: "postgres');
    let choice: StoreChoice | null = null;
    expect(() => {
      choice = storeChoice({ LINGTAI_HOME: dir });
    }).not.toThrow();
    expect(choice).toMatchObject({ because: "unreadable" });
    expect(describeStore(choice!)).toContain(join(dir, "config.yml"));
  });

  it("is no file at all, answered without reading any machine's", () => {
    // An environment naming no home of its own reads nothing — which is what
    // lets a test assert this case at all.
    expect(storeChoice({})).toMatchObject({ because: "nothing chosen" });
  });
});

/**
 * 0056 §3: an exported `LINGTAI_DATABASE_URL` decides and supplies the URL,
 * which is what makes CI, launchd and a container work with no file at all.
 */
describe("an exported variable", () => {
  it("wins over the file, and says that it did", async () => {
    const dir = await home("database:\n  store: sqlite\n");
    const choice = storeChoice({ LINGTAI_HOME: dir, LINGTAI_DATABASE_URL: URL_ });
    expect(choice).toMatchObject({ store: "postgres", url: URL_, where: "environment" });
    expect(describeStore(choice)).toContain("exported into this process");
    // And the password is not in the line somebody reads.
    expect(describeStore(choice)).not.toContain("secret");
  });

  it("is the test side for a test, so a suite is never answered by the operator's machine", async () => {
    const dir = await home("database:\n  store: sqlite\n");
    const test = { LINGTAI_TEST: "1", LINGTAI_HOME: dir };
    expect(storeChoice({ ...test, LINGTAI_DATABASE_URL: URL_ })).toMatchObject({ store: "sqlite" });
    expect(storeChoice({ ...test, LINGTAI_TEST_DATABASE_URL: URL_ })).toMatchObject({ store: "postgres", url: URL_ });
  });
});

/**
 * **0056 §4, and the sentence the whole ADR exists for**: a `.env.local` found
 * by walking up from `packages/env/src` may carry a convenience and may not
 * decide, for a machine, which store that machine runs.
 *
 * In a child process, because the distinction is made at import: `index.ts`
 * snapshots the real environment and *then* dotenv merges the files into
 * `process.env`. The probe below writes the variable in exactly that position
 * — after the import, as dotenv does — so what it proves is the ordering the
 * real file gets, without a test writing an env file into the repository that
 * every other test would then read.
 */
describe("a value the env files supplied", () => {
  function probe(script: string, env: NodeJS.ProcessEnv): StoreChoice {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-store-probe-"));
    const index = pathToFileURL(join(repoRoot(), "packages", "env", "src", "index.ts")).href;
    const file = join(dir, "probe.mjs");
    writeFileSync(file, `import { storeChoice } from ${JSON.stringify(index)};\n${script}`);
    const ran = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, LINGTAI_HOME: dir, ...env },
    });
    expect(ran.stderr, ran.stderr).toBe("");
    return JSON.parse(ran.stdout.trim().split("\n").at(-1)!) as StoreChoice;
  }

  const say = 'console.log(JSON.stringify(storeChoice()));\n';

  it("does not decide the store, though it is in process.env by the time anything asks", () => {
    const read = probe(`process.env.LINGTAI_DATABASE_URL = ${JSON.stringify(URL_)};\n${say}`, {});
    expect(read).toMatchObject({ because: "nothing chosen" });
  });

  it("while the same name, really exported, does", () => {
    expect(probe(say, { LINGTAI_DATABASE_URL: URL_ })).toMatchObject({
      store: "postgres",
      url: URL_,
      where: "environment",
    });
  });

  /**
   * **And the test side is the other way round, because it is not a machine's.**
   *
   * 0056 §4 keeps `.env.local` out of *this machine's* selection — a fact four
   * processes have to agree about cannot come from a file whose visibility
   * depends on the directory a process started in. `LINGTAI_TEST_DATABASE_URL`
   * is not that fact: §4 names it as a value the file goes on supplying, and
   * `.env.example` is where a checkout is told to put it. Reading the snapshot
   * for it would refuse `pnpm test:db` on every machine that followed those
   * instructions, while `postgresUrl()` beside it answered — the two stores
   * disagreeing about one process, which is the failure this whole ADR is
   * about, in miniature.
   *
   * What 0046 forbids is a *fallback to the operator's log*, and there is
   * none: with no test URL anywhere, a test run is still refused by name.
   */
  it("does decide a test's store, which is the one name that file is told to hold", () => {
    const read = probe(
      `process.env.LINGTAI_TEST_DATABASE_URL = ${JSON.stringify(URL_)};\n${say}`,
      { LINGTAI_TEST: "1", LINGTAI_TEST_DATABASE_URL: "" },
    );
    expect(read).toMatchObject({ store: "postgres", url: URL_, where: "environment" });
    // Said as it is, rather than claiming the stronger of the two.
    expect(describeStore(read)).toContain("in this process's environment");
    expect(describeStore(read)).not.toContain("exported into this process");
  });

  it("and with none anywhere, a test run is still refused rather than fallen back", () => {
    expect(probe(say, { LINGTAI_TEST: "1", LINGTAI_TEST_DATABASE_URL: "" })).toMatchObject({
      because: "nothing chosen",
    });
  });
});

/**
 * **A Postgres choice carries both its connections**, and the second one is
 * the reason this is part of the choice rather than a lookup beside it.
 *
 * `LISTEN`/`NOTIFY` needs a session-mode connection (0009), and the obvious
 * way to get one — `directPostgresUrl()`, asked when a waker is built — reads
 * this process's *merged* environment. That is a different question from
 * *which store does this machine run*, and on this very repository the two
 * answer differently: `~/.lingtai/config.yml` names one database and the
 * checkout's `.env.local` names another. A log opened that way appends to the
 * first and registers its `LISTEN` on the second, so every subscriber drains
 * once on connect and is never nudged again while the board goes on rendering
 * that one drain — silent, and the split-log failure 0056 exists to remove.
 */
describe("the session-mode connection that goes with a choice", () => {
  it("is the chosen URL itself, where nothing else was exported", async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`);
    expect(storeChoice({ LINGTAI_HOME: dir })).toMatchObject({ url: URL_, directUrl: URL_ });
  });

  it("is the exported session-mode name where there is one, which is 0009's case", async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`);
    const direct = "postgresql://me:secret@db.example:5433/lingtai";
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: direct })).toMatchObject({
      url: URL_,
      directUrl: direct,
    });
  });

  /**
   * The scenario itself, in a child process for the reason the block above is:
   * a value an env file supplied is in `process.env` by the time anything
   * asks, and only a real process can put it there in that position.
   *
   * `directPostgresUrl()` goes on answering the other question — it is what
   * `lingtai doctor` reports and what a caller asking *this process's merged
   * environment* wants — and the assertion is that the two differ here and
   * that the choice is not the one that moved.
   */
  it("is not the merged environment's, which is how the store and the waker came apart", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-store-probe-"));
    writeFileSync(join(dir, "config.yml"), `database:\n  store: postgres\n  url: ${URL_}\n`);
    const index = pathToFileURL(join(repoRoot(), "packages", "env", "src", "index.ts")).href;
    const file = join(dir, "probe.mjs");
    const supplied = "postgresql://me:secret@db.elsewhere:5432/other";
    writeFileSync(
      file,
      `import { storeChoice, directPostgresUrl } from ${JSON.stringify(index)};\n` +
        // Where dotenv puts one: after the import, into the merged environment.
        // The direct name is emptied in the same position, so that a checkout
        // which happens to carry one cannot answer for this case.
        `process.env.LINGTAI_DIRECT_DATABASE_URL = "";\n` +
        `process.env.LINGTAI_DATABASE_URL = ${JSON.stringify(supplied)};\n` +
        `console.log(JSON.stringify({ choice: storeChoice(), merged: directPostgresUrl() }));\n`,
    );
    const ran = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, LINGTAI_HOME: dir },
    });
    expect(ran.stderr, ran.stderr).toBe("");
    const read = JSON.parse(ran.stdout.trim().split("\n").at(-1)!) as {
      choice: { url: string; directUrl: string };
      merged: string;
    };

    // The file supplied a URL, and it is what the merged-environment reader says.
    expect(read.merged).toBe(supplied);
    // And it decided neither half of the choice.
    expect(read.choice).toMatchObject({ url: URL_, directUrl: URL_ });
  });

  /**
   * **And the direct name an env file supplied *is* the waker's**, which is the
   * other half and the one a checkout actually has.
   *
   * 0056 §4 is about *which store this machine runs* — a fact four processes
   * must agree about, so it may not come from a file whose visibility depends
   * on where a process started. The session-mode URL is not that fact: the
   * store is already chosen, and this only says how to reach **the same
   * database** in a mode that can hold a `LISTEN` (0009). On Supabase the two
   * strings genuinely differ, and `.env.example` is what tells an operator to
   * put `LINGTAI_DIRECT_DATABASE_URL` in `.env.local`.
   *
   * Read from the snapshot instead, this machine's waker silently lost it:
   * `init` writes whatever connects, the dashboard offers the transaction
   * pooler first (#157), and through a pooler the `LISTEN` registration is
   * handed away between statements. No notification ever arrives, every
   * subscriber drains once at connect, `task_view` stops folding, the board
   * renders stale cards, and nothing errors.
   */
  it("is the direct name the env files supplied, which is where a checkout keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-store-probe-"));
    // 0009's pair, as 0009 writes it: "the same host and credentials on port
    // 5432 with the `pgbouncer` flag dropped". One database, two ports — which
    // is also the only shape `lingtai doctor`'s environment row passes.
    const pooled = "postgresql://me:secret@db.abcdef.supabase.co:6543/postgres?pgbouncer=true";
    writeFileSync(join(dir, "config.yml"), `database:\n  store: postgres\n  url: ${pooled}\n`);
    const index = pathToFileURL(join(repoRoot(), "packages", "env", "src", "index.ts")).href;
    const file = join(dir, "probe.mjs");
    const direct = "postgresql://me:secret@db.abcdef.supabase.co:5432/postgres";
    writeFileSync(
      file,
      `import { storeChoice, directPostgresUrl } from ${JSON.stringify(index)};\n` +
        // Where dotenv puts one: after the import, into the merged environment.
        `process.env.LINGTAI_DIRECT_DATABASE_URL = ${JSON.stringify(direct)};\n` +
        `console.log(JSON.stringify({ choice: storeChoice(), merged: directPostgresUrl() }));\n`,
    );
    const ran = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, LINGTAI_HOME: dir },
    });
    expect(ran.stderr, ran.stderr).toBe("");
    const read = JSON.parse(ran.stdout.trim().split("\n").at(-1)!) as {
      choice: { url: string; directUrl: string };
      merged: string;
    };

    // The store is the file's, as §4 requires — the env file decided nothing there.
    expect(read.choice.url).toBe(pooled);
    // And the waker is on 5432 and not on the pooler, which is the whole of 0009.
    expect(read.choice.directUrl).toBe(direct);
    // `lingtai doctor`'s session-mode check reads this one; the two agree, so a
    // green row is a report on the connection the waker actually opens.
    expect(read.merged).toBe(direct);
  });

  /**
   * **And a direct name on a *different* database decides nothing**, which is
   * what makes the case above a rule rather than a hope.
   *
   * 0009 is "two variables, **one database**", and reading the merged
   * environment for the second one is exactly what lets a stale pair answer for
   * a machine that has been pointed somewhere else: `lingtai init
   * --database-url …@db.NEW…` writes `config.yml` and never touches the
   * checkout, whose `.env.local` still holds the OLD pair `.env.example` told
   * it to keep. The store opens on NEW and the `LISTEN` registers on OLD, where
   * nothing is ever appended — every subscriber drains once at connect and is
   * never nudged again, `task_view` stops folding, the board renders stale
   * cards, and nothing errors. It is the split-log failure 0056 exists to
   * remove, reached through the one name that was still read the merged way.
   *
   * Handed in rather than spawned: an exported variable and one an env file
   * supplied reach `sessionUrlFor` in the same position, and what is asserted
   * here is the comparison, which the case above already proves is reached from
   * a file.
   */
  it("is not a direct name on another database, however this process came by it", async () => {
    const dir = await home(`database:\n  store: postgres\n  url: ${URL_}\n`);
    const elsewhere = "postgresql://me:secret@db.elsewhere:5432/lingtai";
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: elsewhere })).toMatchObject({
      url: URL_,
      directUrl: URL_,
    });

    // Nor the same host with another database on it — a second log is a second
    // log whichever half of the string names it.
    const otherDb = "postgresql://me:secret@db.example:5432/other";
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: otherDb })).toMatchObject({
      url: URL_,
      directUrl: URL_,
    });

    // And a string nothing can parse is not a match either: the waker falls
    // back to the store's own database rather than to a guess.
    expect(storeChoice({ LINGTAI_HOME: dir, LINGTAI_DIRECT_DATABASE_URL: "not a url" })).toMatchObject({
      directUrl: URL_,
    });
  });

  /**
   * The same rule where the store came from an exported variable rather than
   * from the file — one function answers both, and a pair that disagrees there
   * is the same split.
   */
  it("holds for a store the environment named, not only one the file did", () => {
    const direct = "postgresql://me:secret@db.example:5433/lingtai";
    expect(
      storeChoice({ LINGTAI_DATABASE_URL: URL_, LINGTAI_DIRECT_DATABASE_URL: direct }),
    ).toMatchObject({ url: URL_, directUrl: direct });

    expect(
      storeChoice({
        LINGTAI_DATABASE_URL: URL_,
        LINGTAI_DIRECT_DATABASE_URL: "postgresql://me:secret@db.elsewhere:5432/lingtai",
      }),
    ).toMatchObject({ url: URL_, directUrl: URL_ });
  });
});
