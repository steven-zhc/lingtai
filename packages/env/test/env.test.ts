/**
 * Where configuration values come from. No database, no network.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  databaseUrl,
  directDatabaseUrl,
  directUrlIfSet,
  envFiles,
  githubApp,
  githubWebhookSecret,
  hasGitHubApp,
  machineDatabaseUrl,
  renamedDatabaseUrl,
  resolvePath,
  sqliteLogPath,
  storeChoice,
} from "../src/index.ts";

describe("resolvePath", () => {
  /**
   * The README documented `~/.lingtai-app.pem` before this existed. Nothing
   * else expands `~` there — a shell does not read a `.env` file, dotenv takes
   * the value literally, and `path.resolve` would have produced a directory
   * *named* `~` inside the repository. The failure would have been a bare ENOENT
   * naming a path nobody wrote.
   */
  it("expands a leading tilde", () => {
    expect(resolvePath("~/.lingtai-app.pem")).toBe(resolve(homedir(), ".lingtai-app.pem"));
    expect(resolvePath("~")).toBe(homedir());
  });

  it("does not expand a tilde that is not the whole first segment", () => {
    // `~backup` is a file called that, not another user's home.
    expect(resolvePath("~backup.pem")).toContain("~backup.pem");
  });

  it("leaves an absolute path alone", () => {
    expect(resolvePath("/etc/lingtai/key.pem")).toBe("/etc/lingtai/key.pem");
  });

  it("resolves a relative path against the repository root, not the cwd", () => {
    // The same rule the environment file itself follows: a command's directory
    // must not change what configuration means.
    const fromRoot = resolvePath("../lingtai-app.pem");
    expect(fromRoot.endsWith("lingtai-app.pem")).toBe(true);
    expect(fromRoot.startsWith("/")).toBe(true);
    expect(fromRoot).not.toContain("packages/env");
  });
});

/**
 * #176. Two URLs are Supabase's; a plain Postgres writes one. Each case hands
 * an environment rather than touching `process.env`, which under vitest would
 * always take the `TEST_` side.
 */
describe("the direct URL falls back to the pooled one", () => {
  const POOLED = "postgresql://u:p@db.example.com:6543/postgres?pgbouncer=true";
  const DIRECT = "postgresql://u:p@db.example.com:5432/postgres";

  it("uses the pooled URL when the direct one is absent", () => {
    expect(directDatabaseUrl({ LINGTAI_DATABASE_URL: DIRECT })).toBe(DIRECT);
    // Empty is absent, as it is for every other name here.
    expect(directDatabaseUrl({ LINGTAI_DATABASE_URL: DIRECT, LINGTAI_DIRECT_DATABASE_URL: "" })).toBe(DIRECT);
  });

  it("never overrides a direct URL that is set", () => {
    // On Supabase the two genuinely differ, and the pooled one is the
    // connection that loses a NOTIFY without saying so.
    expect(directDatabaseUrl({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT })).toBe(DIRECT);
  });

  it("refuses by name when neither is set", () => {
    expect(() => directDatabaseUrl({})).toThrow(/LINGTAI_DIRECT_DATABASE_URL is not set/);
  });

  it("falls back within the TEST_ pair, and never across to the operator's", () => {
    const test = { LINGTAI_TEST: "1" };
    expect(directDatabaseUrl({ ...test, LINGTAI_TEST_DATABASE_URL: DIRECT })).toBe(DIRECT);
    expect(
      directDatabaseUrl({ ...test, LINGTAI_TEST_DATABASE_URL: POOLED, LINGTAI_TEST_DIRECT_DATABASE_URL: DIRECT }),
    ).toBe(DIRECT);
    expect(() =>
      directDatabaseUrl({ ...test, LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT }),
    ).toThrow(/LINGTAI_TEST_DIRECT_DATABASE_URL is not set/);
  });
});

/**
 * #179. Absence is the choice, and there is no second setting to fall out of
 * step with it. Each case hands an environment rather than touching
 * `process.env`, which under vitest would always take the `TEST_` side — which
 * is the whole point of the third block.
 */
describe("absence chooses the store", () => {
  const URL = "postgresql://u:p@db.example.com:5432/postgres";

  it("selects postgres where a URL is set", () => {
    expect(storeChoice({ LINGTAI_DATABASE_URL: URL })).toEqual({ kind: "postgres", url: URL });
    expect(databaseUrl({ LINGTAI_DATABASE_URL: URL })).toBe(URL);
  });

  it("selects sqlite under ~/.lingtai where nothing names one", () => {
    // No flag was passed and no prompt was answered: the configuration is the
    // decision, and an empty one decides too.
    expect(storeChoice({ LINGTAI_HOME: "/tmp/lingtai-home" })).toEqual({
      kind: "sqlite",
      path: "/tmp/lingtai-home/lingtai.db",
    });
    expect(sqliteLogPath({ HOME: "/home/someone" })).toBe("/home/someone/.lingtai/lingtai.db");
    // Empty is absent, as it is for every other name here.
    expect(storeChoice({ LINGTAI_HOME: "/tmp/lingtai-home", LINGTAI_DATABASE_URL: "" }).kind).toBe("sqlite");
  });

  it("refuses a machine that named only the direct URL, rather than choosing sqlite", () => {
    // A missing line, not a decision — and an empty log started beside a
    // database somebody plainly configured is the silent version of that.
    expect(() => storeChoice({ LINGTAI_DIRECT_DATABASE_URL: URL, LINGTAI_HOME: "/tmp/lingtai-home" })).toThrow(
      /LINGTAI_DATABASE_URL is not set/,
    );
  });

  /**
   * **The pre-#63 name is the other way to plainly name a connection**, and the
   * one an operator arrives at by accident: every provider's dashboard calls
   * the variable `DATABASE_URL`, and an install older than the rename has it
   * under that name for Lingtai itself. Before #179 `databaseUrl()` ended at
   * `required()` and said so — *it was renamed to LINGTAI_DATABASE_URL (#63) …
   * Rename the line* — which is the only sentence on that machine naming the
   * one-word repair. Choosing SQLite past it reports a deliberate choice
   * nobody made and takes that sentence off the screen.
   */
  it("refuses the pre-#63 name too, and names the rename rather than choosing sqlite", () => {
    const renamed = { DATABASE_URL: URL, LINGTAI_HOME: "/tmp/lingtai-home" };

    expect(() => storeChoice(renamed)).toThrow(/DATABASE_URL is set — it was renamed to LINGTAI_DATABASE_URL \(#63\)/);
    expect(() => storeChoice(renamed)).toThrow(/Rename the line/);
    expect(() => databaseUrl(renamed)).toThrow(/it was renamed to LINGTAI_DATABASE_URL/);
    // And `renamedDatabaseUrl` — which `lingtai doctor` asks, having its own
    // `config.yml` URL to fold in — answers the same question the same way.
    expect(renamedDatabaseUrl(renamed)).toBe("DATABASE_URL");
    // The prefixed name set is an ordinary Postgres machine: the old one is not
    // consulted, so an operator with a `DATABASE_URL` of their own is not asked
    // about it.
    expect(storeChoice({ ...renamed, LINGTAI_DATABASE_URL: URL })).toEqual({ kind: "postgres", url: URL });
    expect(renamedDatabaseUrl({ ...renamed, LINGTAI_DATABASE_URL: URL })).toBeNull();
    expect(renamedDatabaseUrl({ LINGTAI_HOME: "/tmp/lingtai-home" })).toBeNull();
  });

  /**
   * **The rule must not reach the test variables.** A fallback to SQLite here
   * would leave `pnpm test:db` green against a file while claiming to assert
   * Postgres — the projections, `LISTEN`/`NOTIFY`, two clients racing — and the
   * refusal `testUrl` has carried since `#63` would have been quietly deleted
   * by a change nobody read as deleting it.
   */
  it("refuses in a test run rather than falling through to sqlite", () => {
    const test = { LINGTAI_TEST: "1", LINGTAI_HOME: "/tmp/lingtai-home" };
    expect(() => storeChoice(test)).toThrow(/LINGTAI_TEST_DATABASE_URL is not set/);
    expect(() => databaseUrl(test)).toThrow(/LINGTAI_TEST_DATABASE_URL is not set/);
    // Not even with the operator's own URL set, which is the log the refusal is
    // about: the suite writes real events, and only deleting from an
    // append-only table would remove them again.
    expect(() => storeChoice({ ...test, LINGTAI_DATABASE_URL: URL })).toThrow(
      /LINGTAI_TEST_DATABASE_URL is not set/,
    );
    // Vitest's own variable, not just the explicit override.
    expect(() => storeChoice({ VITEST: "true", LINGTAI_HOME: "/tmp/lingtai-home" })).toThrow(
      /LINGTAI_TEST_DATABASE_URL is not set/,
    );
    expect(storeChoice({ ...test, LINGTAI_TEST_DATABASE_URL: URL })).toEqual({ kind: "postgres", url: URL });
  });
});

/**
 * #169. The board's setup page writes `LINGTAI_GITHUB_APP_ID` into `.env.local`
 * while the board — and a daemon — are already running. The key was always
 * re-read per call; the id came from `process.env`, fixed at start, so the page
 * that had just written the App was answered *no GitHub App configured* by its
 * own next click. The id is now read the way the key is.
 */
describe("the App is read from the env file as it is now", () => {
  it("sees an App written to the file after this module was loaded", async () => {

    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    const key = join(dir, "app.pem");
    const env = {};

    expect(hasGitHubApp(env, [envLocal])).toBe(false);

    await writeFile(key, "not a real key");
    await writeFile(envLocal, `LINGTAI_GITHUB_APP_ID=4242\nLINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=${key}\n`);

    expect(hasGitHubApp(env, [envLocal])).toBe(true);
    expect(githubApp(env, [envLocal])).toEqual({ appId: "4242", privateKey: "not a real key", keySource: key });
  });

  it("lets a variable in the environment win over the file", async () => {

    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    await writeFile(envLocal, "LINGTAI_GITHUB_APP_ID=1\nLINGTAI_GITHUB_APP_PRIVATE_KEY=from-file\n");

    const app = githubApp({ LINGTAI_GITHUB_APP_ID: "2" }, [envLocal]);
    expect(app.appId).toBe("2");
    expect(app.privateKey).toBe("from-file");
  });

  /**
   * `.env.example` ships the key path filled in and the id blank, so a copied
   * `.env.local` puts a key path in `process.env` at start. The setup page then
   * writes the new App's key aside and points the file at it — and a key path
   * taken from that snapshot beside an id taken from the file signs the new
   * App's JWT with somebody else's key.
   */
  it("takes the key from the file that names the id, not from a key path the environment started with", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");
    const oldKey = join(dir, "lingtai-agent.private-key.pem");
    const newKey = join(dir, "lingtai-agent.private-key.222.pem");
    await writeFile(oldKey, "app 111's key");
    await writeFile(newKey, "app 222's key");
    await writeFile(envLocal, `LINGTAI_GITHUB_APP_ID=222\nLINGTAI_GITHUB_APP_PRIVATE_KEY_PATH=${newKey}\n`);
    const started = { LINGTAI_GITHUB_APP_ID: "", LINGTAI_GITHUB_APP_PRIVATE_KEY_PATH: oldKey };

    expect(githubApp(started, [envLocal])).toEqual({ appId: "222", privateKey: "app 222's key", keySource: newKey });
  });

  /** The setup page writes the secret while the board runs; the receiver must see it. */
  it("reads the webhook secret from the file as it is now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-env-"));
    const envLocal = join(dir, ".env.local");

    expect(githubWebhookSecret({}, [envLocal])).toBeUndefined();
    await writeFile(envLocal, "LINGTAI_GITHUB_APP_ID=222\nLINGTAI_GITHUB_WEBHOOK_SECRET=from-setup\n");
    expect(githubWebhookSecret({}, [envLocal])).toBe("from-setup");
    expect(githubWebhookSecret({ LINGTAI_GITHUB_WEBHOOK_SECRET: "set" }, [envLocal])).toBe("from-setup");
  });

  it("reads no file for an environment it was handed, unless told which", async () => {
    // `lingtai doctor` reports on the environment it is given (see `githubApp`).
    expect(hasGitHubApp({})).toBe(false);
    expect(envFiles().map((f) => f.split("/").pop())).toEqual([".env.local", ".env"]);
  });
});

/**
 * #186. `lingtai init` writes the URL it verified to `~/.lingtai/config.yml`,
 * and a URL written where nothing reads it is a choice that did nothing.
 */
describe("the machine file's database.url", () => {
  const URL_ = "postgresql://me:secret@localhost:5432/lingtai";

  it("is read from config.yml under LINGTAI_HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    expect(machineDatabaseUrl({ LINGTAI_HOME: home })).toBeUndefined();
    await writeFile(join(home, "config.yml"), `runtime:\n  agent: claude-code\ndatabase:\n  url: ${URL_}\n`);
    expect(machineDatabaseUrl({ LINGTAI_HOME: home })).toBe(URL_);
  });

  it("refuses a file that does not parse by its path, rather than calling the URL unset", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await writeFile(join(home, "config.yml"), "database: [unclosed\n");
    expect(() => machineDatabaseUrl({ LINGTAI_HOME: home })).toThrow(join(home, "config.yml"));
  });

  it("is never asked for an environment handed in, or for a test — only this process's own", async () => {
    const home = await mkdtemp(join(tmpdir(), "lingtai-home-"));
    await writeFile(join(home, "config.yml"), `database:\n  url: ${URL_}\n`);
    expect(() => databaseUrl({ LINGTAI_HOME: home })).toThrow(/LINGTAI_DATABASE_URL is not set.*lingtai init/);
    expect(directUrlIfSet({ LINGTAI_HOME: home })).toBeUndefined();
    // This process is a test run, so its own environment never reaches the file.
    expect(() => databaseUrl({ LINGTAI_HOME: home, VITEST: "true" })).toThrow(/LINGTAI_TEST_DATABASE_URL is not set/);
  });
});
