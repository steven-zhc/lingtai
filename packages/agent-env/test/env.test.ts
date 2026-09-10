/**
 * What reaches an agent, and what refuses a run before anything is claimed.
 *
 * These tests were in `repo`, testing this package's functions from the package
 * that plants the file they produce. `#68` split the source and left the tests
 * where they were; this is the other half.
 *
 * The table is 0021's, and there is a case per row because the rows are the
 * decision — `allow` absent and `allow: []` mean different things, and the one
 * pair most likely to be "helpfully" rejected later (`required` *and* `deny`)
 * has a case of its own.
 */
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_PATTERNS,
  ProductionValueError,
  SecretSourceError,
  extensionEnv,
  filterEnv,
  hostLooksProduction,
  parseEnvFile,
  projectEnvNames,
  projectEnvPath,
  renderEnvFile,
  resolveAgentEnv,
  runnableEnv,
  setEnvLine,
  setProjectEnv,
  unsetEnvLine,
  unsetProjectEnv,
} from "../src/index.ts";

const PROJECT = "envcheck";
let home: string;

/** The project's own file — layer 3. */
async function project(text: string): Promise<void> {
  const path = projectEnvPath(PROJECT, home);
  await mkdir(join(home, "env"), { recursive: true });
  await writeFile(path, text);
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-env-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("filterEnv — 0021's table, a case per row", () => {
  const data = { A: "1", B: "2", C: "3" };

  it("passes everything when neither is set", () => {
    expect(filterEnv(data)).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("passes only what `allow` names", () => {
    expect(filterEnv(data, { allow: ["A", "C"] })).toEqual({ A: "1", C: "3" });
  });

  it("passes everything except `deny`", () => {
    expect(filterEnv(data, { deny: ["B"] })).toEqual({ A: "1", C: "3" });
  });

  it("passes `allow` minus `deny`", () => {
    expect(filterEnv(data, { allow: ["A", "B"], deny: ["B"] })).toEqual({ A: "1" });
  });

  /**
   * Absent and empty are different, and that is why `allow` is `optional` in
   * the schema rather than `.default([])`. An empty allowlist means the
   * repository said "nothing", which is a thing a repository may say.
   */
  it("passes nothing when `allow` is present and empty", () => {
    expect(filterEnv(data, { allow: [] })).toEqual({});
  });
});

/**
 * The same two files, asked the other way round — 0021's second consumer
 * ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
 *
 * `filterEnv` starts from everything and takes away; this starts from nothing
 * and adds only what was named. The pair of tests below is that sentence: a
 * declaration of one name out of three yields one, and a declaration of none
 * yields none rather than three.
 */
describe("extensionEnv — the declared set is the whole set", () => {
  const merged = { TELEGRAM_TOKEN: "bot", CLERK_SECRET_KEY: "sk", LINGTAI_DATABASE_URL: "postgres://log" };

  it("gives an extension exactly what it declared", () => {
    expect(extensionEnv(merged, ["TELEGRAM_TOKEN"])).toEqual({
      values: { TELEGRAM_TOKEN: "bot" },
      missing: [],
    });
  });

  it("gives nothing to an extension that declared nothing", () => {
    expect(extensionEnv(merged, [])).toEqual({ values: {}, missing: [] });
  });

  /**
   * Reported rather than silently absent. This is what `lingtai doctor` says
   * before a run: an extension started with a name it asked for and did not
   * get is a bot that exits, and a subscriber's exit code is discarded.
   */
  it("names what it could not answer for", () => {
    expect(extensionEnv(merged, ["TELEGRAM_TOKEN", "SLACK_TOKEN"])).toEqual({
      values: { TELEGRAM_TOKEN: "bot" },
      missing: ["SLACK_TOKEN"],
    });
  });

  /** The tripwire is over what reaches a process, and an extension is one. */
  it("refuses a production-looking value, naming the variable", () => {
    expect(() => extensionEnv({ DB: "postgres://db.prod.example.com/x" }, ["DB"])).toThrow(
      ProductionValueError,
    );
  });
});

describe("resolveAgentEnv — merge first, filter second", () => {
  it("lets the project's file beat the machine's, and says which answered", async () => {
    await project("SHARED=from-project\nONLY_FILE=x\n");
    const env = await resolveAgentEnv({
      project: PROJECT,
      home,
      machine: { SHARED: "from-machine", ONLY_MACHINE: "y" },
    });

    expect(env.values).toEqual({ SHARED: "from-project", ONLY_FILE: "x", ONLY_MACHINE: "y" });
    expect(env.names).toEqual([
      { name: "ONLY_FILE", layer: "project file" },
      { name: "ONLY_MACHINE", layer: "machine file" },
      { name: "SHARED", layer: "project file" },
    ]);
    expect(env.refusal).toBeNull();
  });

  /**
   * The one pair worth its own case. `required` is a check against the merged
   * data; `deny` is a filter over what reaches the agent. Two questions, and
   * neither answers for the other — so this resolves, refuses nothing, and the
   * agent does not see it.
   */
  it("allows a name that is both required and denied", async () => {
    await project("SECRET=present\n");
    const env = await resolveAgentEnv({
      project: PROJECT,
      home,
      required: ["SECRET"],
      deny: ["SECRET"],
      machine: {},
    });

    expect(env.refusal).toBeNull();
    expect(env.missing).toEqual([]);
    expect(env.values["SECRET"]).toBeUndefined();
  });

  it("refuses the project when a required name is in neither file", async () => {
    await project("PRESENT=1\n");
    const env = await resolveAgentEnv({
      project: PROJECT,
      home,
      required: ["PRESENT", "ABSENT"],
      machine: {},
    });

    expect(env.missing).toEqual(["ABSENT"]);
    expect(env.refusal).toContain("ABSENT");
    expect(env.refusal).toContain("Nothing was claimed");
  });

  /**
   * The machine's file holds this system's own log and the key that signs its
   * tokens. A managed repository never receives those, whatever it declares —
   * one prefix rule since `#63`, not the `RESERVED` list 0021 deleted.
   */
  it("never passes a LINGTAI_ name out of the machine's file", async () => {
    await project("");
    const env = await resolveAgentEnv({
      project: PROJECT,
      home,
      machine: { LINGTAI_DATABASE_URL: "postgres://the-system-itself", ORDINARY: "ok" },
    });

    expect(env.values).toEqual({ ORDINARY: "ok" });
    expect(env.names.map((n) => n.name)).not.toContain("LINGTAI_DATABASE_URL");
  });

  /**
   * …and the asymmetry that keeps self-hosting working: a `LINGTAI_` name the
   * operator wrote into *this project's* file is the operator handing Lingtai's
   * own test database to Lingtai's own run.
   */
  it("passes a LINGTAI_ name the project's own file supplies", async () => {
    await project("LINGTAI_TEST_DATABASE_URL=postgres://the-test-one\n");
    const env = await resolveAgentEnv({
      project: PROJECT,
      home,
      required: ["LINGTAI_TEST_DATABASE_URL"],
      machine: {},
    });

    expect(env.refusal).toBeNull();
    expect(env.values["LINGTAI_TEST_DATABASE_URL"]).toBe("postgres://the-test-one");
  });

  it("refuses a value that looks like production, from either file", async () => {
    await project("DB=postgres://user:pw@db.prod.example.com/app\n");
    await expect(resolveAgentEnv({ project: PROJECT, home, machine: {} })).rejects.toBeInstanceOf(
      ProductionValueError,
    );
  });

  /** A denied value never reaches an agent, so it is not the tripwire's business. */
  it("does not refuse a production value the recipe denies", async () => {
    await project("DB=postgres://user:pw@db.prod.example.com/app\n");
    const env = await resolveAgentEnv({ project: PROJECT, home, deny: ["DB"], machine: {} });
    expect(env.values).toEqual({});
  });
});

describe("the pieces the layers are built from", () => {
  it("reads names, values and the deferred secret source", () => {
    const parsed = parseEnvFile('A=1\n# comment\nB="two words"\nC=!op read op://x\n');
    expect(parsed.values).toEqual({ A: "1", B: "two words" });
    expect(parsed.commands).toEqual({ C: "op read op://x" });
  });

  it("quotes what it renders, so a # or a space cannot truncate a value", () => {
    expect(renderEnvFile({ A: "a b # c" })).toContain('A="a b # c"');
  });

  it("names a production host and passes an opaque one", () => {
    expect(hostLooksProduction("db.prod.example.com", DEFAULT_PRODUCTION_PATTERNS)).toBe("prod");
    expect(hostLooksProduction("db.abcdef.supabase.co", DEFAULT_PRODUCTION_PATTERNS)).toBeNull();
  });

  /** Layer 1 is what a process needs to be a process, and is not the recipe's. */
  it("adds what a command needs to run at all, without letting it win", () => {
    const out = runnableEnv({ PATH: "/from/recipe" }, { PATH: "/from/os", HOME: "/h" });
    expect(out["PATH"]).toBe("/from/recipe");
    expect(out["HOME"]).toBe("/h");
  });
});

/**
 * `lingtai env set` — the four chances to get it wrong, closed (`#62`).
 *
 * A separate project name in the same home, because these write the file the
 * cases above read and a shared one would make the order load-bearing.
 */
describe("writing the project's file", () => {
  const WRITTEN = "envwrite";
  const file = () => projectEnvPath(WRITTEN, home);

  it("creates the file 0600, and never touches the mode of one that exists", async () => {
    // Asked for outright rather than left to `writeFile`'s `mode`, which a
    // umask can narrow on the way past.
    const { created } = await setProjectEnv({ project: WRITTEN, name: "FIRST", value: "1", home });
    expect(created).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o600);

    await setProjectEnv({ project: WRITTEN, name: "SECOND", value: "2", home });
    expect((await stat(file())).mode & 0o777).toBe(0o600);

    // The mode of a file that already exists is the operator's, either way. A
    // command that widened one while claiming to secure it would be worse than
    // one that never touched it — so this asserts it is not touched at all.
    await chmod(file(), 0o640);
    await setProjectEnv({ project: WRITTEN, name: "THIRD", value: "3", home });
    expect((await stat(file())).mode & 0o777).toBe(0o640);
    await chmod(file(), 0o600);
  });

  it("replaces one line and leaves the comments and the neighbours alone", async () => {
    await writeFile(
      file(),
      "# the one the application reads\nDATABASE_URL=postgres://old\n\n# keep me\nOTHER=untouched\n",
      { mode: 0o600 },
    );
    const { replaced } = await setProjectEnv({
      project: WRITTEN,
      name: "DATABASE_URL",
      value: "postgres://new",
      home,
    });

    expect(replaced).toBe(true);
    const text = await readFile(file(), "utf8");
    expect(text).toContain("# the one the application reads");
    expect(text).toContain("# keep me");
    expect(text).toContain("OTHER=untouched");
    expect(text).not.toContain("postgres://old");
    expect(parseEnvFile(text).values["DATABASE_URL"]).toBe("postgres://new");
  });

  /**
   * The file stays the dumb data store 0021 says it is: nothing expands and
   * nothing truncates, so a password holding a `$` or a `#` survives being
   * written and read back as itself.
   */
  it("writes a value literally, through a round trip", async () => {
    const value = 'p@ss $HOME # not-a-comment "quoted" \\ end';
    await setProjectEnv({ project: WRITTEN, name: "PASSWORD", value, home });
    expect(parseEnvFile(await readFile(file(), "utf8")).values["PASSWORD"]).toBe(value);

    const env = await resolveAgentEnv({ project: WRITTEN, home, machine: {} });
    expect(env.values["PASSWORD"]).toBe(value);
  });

  /**
   * Layer 4 does not exist, so writing one plants a literal `!op read …` where
   * a connection string should be — a line that looks correct and refuses.
   */
  it("refuses a !-prefixed value, and writes nothing", async () => {
    const before = await readFile(file(), "utf8");
    await expect(
      setProjectEnv({ project: WRITTEN, name: "TOKEN", value: "!op read op://x", home }),
    ).rejects.toBeInstanceOf(SecretSourceError);
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  it("refuses a name that is not one, and a project that is a path", async () => {
    await expect(setProjectEnv({ project: WRITTEN, name: "not a name", value: "x", home })).rejects.toThrow();
    await expect(setProjectEnv({ project: "../escape", name: "OK", value: "x", home })).rejects.toThrow();
  });

  it("unsets one name and keeps the rest of the file", async () => {
    await setProjectEnv({ project: WRITTEN, name: "GOING", value: "x", home });
    const { removed } = await unsetProjectEnv({ project: WRITTEN, name: "GOING", home });
    expect(removed).toBe(true);

    const text = await readFile(file(), "utf8");
    expect(text).not.toContain("GOING");
    expect(text).toContain("# keep me");
    expect((await unsetProjectEnv({ project: WRITTEN, name: "GOING", home })).removed).toBe(false);
  });

  it("lists names and their layer, and knows a secret source when it sees one", async () => {
    await writeFile(file(), "# a comment\nFROM_FILE=x\nASKED=!op read op://x\n", { mode: 0o600 });
    const listing = await projectEnvNames({
      project: WRITTEN,
      home,
      machine: { FROM_MACHINE: "y", LINGTAI_DATABASE_URL: "postgres://the-system-itself" },
    });

    expect(listing.names).toEqual([
      { name: "ASKED", layer: "not set" },
      { name: "FROM_FILE", layer: "project file" },
      { name: "FROM_MACHINE", layer: "machine file" },
    ]);
    expect(listing.deferred).toEqual(["ASKED"]);
  });

  /** The pieces, so a duplicate line and a `#` in a value are settled here. */
  it("drops a duplicate line rather than writing a value the file will not report", () => {
    const text = setEnvLine("A=one\nB=b\nA=two\n", "A", "three");
    expect(text).toBe('A="three"\nB=b\n');
    expect(parseEnvFile(text).values["A"]).toBe("three");
  });

  it("removes every line declaring the name", () => {
    expect(unsetEnvLine("# c\nA=1\nB=2\nA=3\n", "A")).toEqual({ text: "# c\nB=2\n", removed: true });
  });
});

/**
 * The refusal an operator actually reads. It named a file, a directory to
 * create, a syntax and a mode; it names the command that does all four (`#62`).
 */
describe("what the refusal tells you to do", () => {
  it("points at lingtai env set <project> <NAME>, not at a path and a format", async () => {
    const env = await resolveAgentEnv({
      project: "refuser",
      home,
      required: ["MISSING_ONE"],
      machine: {},
    });

    expect(env.refusal).toContain("lingtai env set refuser MISSING_ONE");
    expect(env.refusal).toContain("unechoed");
  });
});
