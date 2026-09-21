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
});
