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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_PATTERNS,
  ProductionValueError,
  filterEnv,
  hostLooksProduction,
  parseEnvFile,
  projectEnvPath,
  renderEnvFile,
  resolveAgentEnv,
  runnableEnv,
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
