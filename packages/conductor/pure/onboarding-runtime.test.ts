import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectStream } from "@lingtai/domain";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import type { GitHubClient } from "@lingtai/github";
import { resolveSource, resolveLocalRecipe, machinePath, recipePath } from "@lingtai/recipe";
import { startOnboarding } from "../src/wizard.ts";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "lingtai-onboard-runtime-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const recipe = resolveSource("version: 1\nrepo: {base: main}\nsource: {kinds: [bug]}\nenv: {plantAt: .env}\nruntime: {agent: claude-code, limits: {wall: 1h}}\ngates: {}\n", "main", "onboarding fixture").recipe;
// Onboarding uses only the identity. It must never call GitHub to write files.
const client = { owner: "owner", repo: "app" } as GitHubClient;

describe("new onboarding writes runtime only in its project recipe", () => {
  it("records a pending project whose recipe resolves without detection and creates no machine file", async () => {
    const store = createMemoryEventStore();
    expect(await startOnboarding({ client, recipe, home, store, by: "human:test" })).toEqual({ ok: true, path: recipePath("app", home) });
    expect(await readdir(home)).toEqual(["app"]);
    const resolved = await resolveLocalRecipe("app", { home, signedIn: async () => { throw new Error("explicit choice must not be detected"); } });
    expect(resolved.recipe).toEqual(recipe);
    expect((await store.read(projectStream("app"))).map((e) => e.type)).toEqual(["ProjectOnboardingStarted"]);
  });
  it("keeps machine assignees and unrelated settings byte-for-byte", async () => {
    const store = createMemoryEventStore();
    const before = "# private machine\nboard: {port: 3200}\nruntime: {assignee: {login: alice, take: mine}}\n";
    await writeFile(machinePath(home), before);
    expect((await startOnboarding({ client, recipe, home, store, by: "human:test" })).ok).toBe(true);
    expect(await readFile(machinePath(home), "utf8")).toBe(before);
    expect((await resolveLocalRecipe("app", { home, signedIn: async () => [] })).recipe.runtime.assignee).toEqual({login: "alice", take: "mine"});
  });
  it("refuses unrelated legacy choices before writing or recording onboarding", async () => {
    const store = createMemoryEventStore();
    const before = "projects:\n  other:\n    runtime: {agent: codex}\n";
    await writeFile(machinePath(home), before);
    const result = await startOnboarding({ client, recipe, home, store, by: "human:test" });
    expect(result).toMatchObject({ ok: false, refusal: expect.stringContaining("migrate-runtime") });
    expect(await readdir(home)).toEqual(["config.yml"]);
    expect(await readFile(machinePath(home), "utf8")).toBe(before);
    expect(await store.read(projectStream("app"))).toEqual([]);
  });
});
