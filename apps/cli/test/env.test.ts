/**
 * `lingtai env list` — the one thing it must never do.
 *
 * The rule is `doctor`'s, and it is here as an assertion rather than a comment
 * because this is the function a screen share is pointed at: a command that
 * echoes a secret is one somebody runs while recording (`#62`).
 *
 * No database and no App: the listing is two files and a sort.
 */
import { projectEnvNames, setProjectEnv } from "@lingtai/agent-env";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatEnvList } from "../src/env.ts";

const PROJECT = "listcheck";
const SECRET = "postgres://user:hunter2@db.abcdef.supabase.co/app";
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-env-list-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("lingtai env list", () => {
  it("prints every name and its layer, and no value of either", async () => {
    await setProjectEnv({ project: PROJECT, name: "DATABASE_URL", value: SECRET, home });
    await setProjectEnv({ project: PROJECT, name: "API_KEY", value: "sk-live-abc123", home });

    const out = formatEnvList(
      await projectEnvNames({ project: PROJECT, home, machine: { FROM_MACHINE: "machine-value" } }),
    );

    expect(out).toContain("API_KEY");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("project file");
    expect(out).toContain("FROM_MACHINE");
    expect(out).toContain("machine file");

    // The assertion the ticket asks for, and the reason this file exists.
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-live-abc123");
    expect(out).not.toContain("machine-value");
  });

  it("says so plainly when a project has nothing, rather than printing a header over nothing", async () => {
    const out = formatEnvList(await projectEnvNames({ project: "nothinghere", home, machine: {} }));
    expect(out).toContain("no names");
    expect(out).toContain("nothinghere.env");
  });
});
