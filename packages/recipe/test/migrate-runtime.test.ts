import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLocker } from "@lingtai/env/lock";
import {
  applyRuntimeMigration, previewRuntimeMigration, legacyRuntimeFields, parseMachineConfig,
  resolveSource, resolveLocalRecipe, recipePath, machinePath, RuntimeMigrationRequired,
  type RuntimeMigrationOptions,
  PRESETS,
} from "../src/index.ts";

let home: string;
const recipe = `# project comment
version: 1
repo: {base: main}
source: {kinds: [bug]}
env: {plantAt: .env.local}
runtime:
  tier: guarded # containment comment
`;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "lingtai-runtime-migration-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function setup(machine: string | null, projects = ["a", "b"]) {
  for (const project of projects) {
    await mkdir(join(home, project)); await writeFile(recipePath(project, home), recipe);
  }
  if (machine !== null) await writeFile(machinePath(home), machine);
  return { home, registered: async () => projects.map((project) => ({ project, base: "main" })), signedIn: async () => ["claude-code"] as const } satisfies RuntimeMigrationOptions;
}
const text = (path: string) => readFile(path, "utf8");
const journal = async () => JSON.parse(await text(join(home, "migrations", "runtime-v1.json")));
const machine = async () => parseMachineConfig(await text(machinePath(home)), machinePath(home), "a", home);

describe("explicit all-project runtime migration", () => {
  it("resolves ambiguous old choices through migration input and retains old discussion", async () => {
    const base = await setup(null, ["a"]);
    const options = { ...base, signedIn: async () => ["claude-code", "codex"] as const };
    expect((await previewRuntimeMigration(options)).problems.join("\n")).toContain("--agent a=<claude-code|codex>");
    expect(await text(recipePath("a", home))).toBe(recipe);
    const selected = { ...options, agents: { a: "codex" as const } };
    expect((await previewRuntimeMigration(selected)).problems).toEqual([]);
    await expect(applyRuntimeMigration({ ...selected, written: async () => { throw new Error("power loss"); } })).rejects.toThrow("power loss");
    await applyRuntimeMigration(options); // Journaled explicit choice survives without repeating flags.
    const resolved = await resolveLocalRecipe("a", options);
    expect(resolved.runtimes?.development.agent).toBe("codex");
    expect(resolved.runtimes?.discussion).toMatchObject({ agent: "claude-code", limits: { turns: 40, wall: "5m" } });
  });
  it("explicit migration input never replaces a conflicting recorded machine choice", async () => {
    const options = await setup("runtime: {agent: claude-code}\n", ["a"]);
    await expect(applyRuntimeMigration({ ...options, agents: { a: "codex" } })).rejects.toThrow("conflicts with recorded machine agent");
    expect(await text(recipePath("a", home))).toBe(recipe);
  });
  it("reports conflicting preset discussion limits instead of replacing its role", async () => {
    const options = await setup("runtime: {agent: claude-code}\n", ["a"]);
    PRESETS["migration-discussion-test"] = { runtime: {}, discussion: { runtime: { agent: "claude-code", model: "configured-discussion", limits: { turns: 20, wall: "1m" } } } };
    try {
      const source = `${recipe}extends: migration-discussion-test\n`;
      await writeFile(recipePath("a", home), source);
      const plan = await previewRuntimeMigration(options);
      expect(plan.problems.join("\n")).toContain("discussion.runtime.limits.turns");
      await expect(applyRuntimeMigration(options)).rejects.toThrow("conflicts with");
      expect(await text(recipePath("a", home))).toBe(source);
      expect(resolveSource(plan.files[0]!.after!, "main", "fixture").runtimes?.discussion).toMatchObject({ model: "configured-discussion", limits: {turns: 20, wall: "1m"} });
    } finally { delete PRESETS["migration-discussion-test"]; }
  });
  it("preserves a matching preset discussion model while materializing legacy fields", async () => {
    const options = await setup("runtime: {agent: claude-code}\n", ["a"]);
    PRESETS["migration-discussion-test"] = { runtime: {}, discussion: { runtime: { model: "configured-discussion" } } };
    try {
      await writeFile(recipePath("a", home), `${recipe}extends: migration-discussion-test\n`);
      await applyRuntimeMigration(options);
      expect((await resolveLocalRecipe("a", options)).runtimes?.discussion).toMatchObject({ model: "configured-discussion", agent: "claude-code", limits: { turns: 40, wall: "5m" } });
    } finally { delete PRESETS["migration-discussion-test"]; }
  });
  it("materializes a model-only preset with the detected agent instead of resetting its model", async () => {
    const options = await setup(null, ["a"]);
    PRESETS["migration-model-test"] = { runtime: {model: "preset-model"} };
    try {
      await writeFile(recipePath("a", home), `${recipe}extends: migration-model-test\n`);
      await applyRuntimeMigration(options);
      expect((await resolveLocalRecipe("a", options)).runtimes?.development.model).toBe("preset-model");
    } finally { delete PRESETS["migration-model-test"]; }
  });
  it("retains recorded detection across a crash even if the available logins later change", async () => {
    const options = await setup(null);
    await expect(applyRuntimeMigration({ ...options, written: async () => { throw new Error("power loss"); } })).rejects.toThrow("power loss");
    const resume = { ...options, signedIn: async () => { throw new Error("must not redetect a journaled choice"); } };
    await expect(resolveLocalRecipe("a", resume)).rejects.toThrow("unfinished migration for projects: a, b");
    expect((await previewRuntimeMigration(resume)).problems).toEqual([]);
    await applyRuntimeMigration(resume);
    expect((await journal()).complete).toBe(true);
    expect((await resolveLocalRecipe("b", resume)).recipe.runtime.agent).toBe("claude-code");
  });
  it("refuses machine aliases whose cleanup would change an unrelated setting", async () => {
    const original = "runtime: &runtime {agent: claude-code}\nother: *runtime\n";
    const options = await setup(original);
    expect((await previewRuntimeMigration(options)).problems.join("\n")).toContain("YAML aliases");
    await expect(applyRuntimeMigration(options)).rejects.toThrow("YAML aliases");
    expect(await text(machinePath(home))).toBe(original);
    expect(await text(recipePath("a", home))).toBe(recipe);
  });
  it("previews every source without creating files and preserves project-over-global priority", async () => {
    const original = `# machine comment
database: {url: postgres://local/db}
ports: {board: 3200}
runtime:
  agent: claude-code
  limits: {wall: 1h, rounds: 3}
  assignee: {login: alice}
projects:
  a:
    runtime:
      limits: {turns: 12, wall: 15m}
      assignee: {take: mine} # assignee comment
  b:
    runtime: {agent: codex}
`;
    const options = await setup(original);
    options.signedIn = async () => { throw new Error("recorded agent must not be detected"); };
    const plan = await previewRuntimeMigration(options);
    expect(plan.problems).toEqual([]);
    expect(plan.projects).toEqual(["a", "b"]);
    expect(await readdir(home)).toEqual(["a", "b", "config.yml"]);
    expect(await text(machinePath(home))).toBe(original);
    expect(await text(recipePath("a", home))).toBe(recipe);
    expect(plan.changes).toContainEqual(expect.objectContaining({ project: "a", field: "runtime.limits.wall", after: "15m", source: `${machinePath(home)}:projects.a.runtime.limits.wall` }));
    await applyRuntimeMigration(options);
    const a = await resolveLocalRecipe("a", options);
    const b = await resolveLocalRecipe("b", options);
    expect(a.runtimes?.development).toMatchObject({ agent: "claude-code", limits: { turns: 12, wall: "15m" } });
    expect(b.runtimes?.development).toMatchObject({ agent: "codex", limits: { turns: null, wall: "1h" } });
    expect(b.runtimes?.discussion).toMatchObject({ agent: "claude-code", limits: { turns: 40, wall: "5m" } });
    expect(a.recipe.runtime.assignee).toEqual({ login: "alice", take: "mine" });
    const after = await text(machinePath(home));
    expect(after).toContain("# machine comment"); expect(after).toContain("# assignee comment");
    expect(parse(after)).toMatchObject({ database: { url: "postgres://local/db" }, ports: { board: 3200 } });
    expect(legacyRuntimeFields(await machine())).toEqual([]);
    expect(await text(recipePath("a", home))).toContain("# containment comment");
    const saved = await journal();
    for (const [i, file] of saved.files.entries()) {
      expect((await stat(join(home, "migrations", saved.id, `${i}.bak`))).mode & 0o777).toBe(0o600);
      expect(await text(join(home, "migrations", saved.id, `${i}.bak`))).toBe(file.before);
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(home, "migrations", "runtime-v1.json"))).mode & 0o777).toBe(0o600);
    const snapshots = await Promise.all(saved.files.map((f: {path: string}) => text(f.path)));
    await applyRuntimeMigration(options);
    expect(await Promise.all(saved.files.map((f: {path: string}) => text(f.path)))).toEqual(snapshots);
    expect((await journal()).id).toBe(saved.id);
  });

  it.each([{ ids: [] }, { ids: ["claude-code", "codex"] }] as const)("refuses missing/ambiguous fallback $ids without overwriting anything", async ({ ids }) => {
    const options = await setup(null);
    let probes = 0;
    const plan = await previewRuntimeMigration({ ...options, signedIn: async () => { probes++; return ids; } });
    expect(plan.problems).toHaveLength(2);
    expect(probes).toBe(1);
    await expect(stat(join(home, "migrations"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await text(recipePath("a", home))).toBe(recipe);
  });

  it("only a uniquely detected agent fills the old fallback, preserving fixed discussion", async () => {
    const options = await setup(null, ["a"]);
    const codexOptions = { ...options, signedIn: async () => ["codex"] as const };
    const plan = await previewRuntimeMigration(codexOptions);
    expect(plan.problems).toEqual([]);
    await applyRuntimeMigration(codexOptions);
    expect(await resolveLocalRecipe("a", codexOptions)).toMatchObject({ runtimes: {
      development: { agent: "codex", limits: { turns: null, wall: "2h" } },
      discussion: { agent: "claude-code", limits: { turns: 40, wall: "5m" } },
    } });
    await expect(stat(machinePath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports conflicting recorded recipe values and both source paths", async () => {
    const options = await setup("runtime: {agent: codex, limits: {wall: 1h}}\n", ["a"]);
    const own = `${recipe}  agent: claude-code\n  limits: {wall: 30m}\n`;
    await writeFile(recipePath("a", home), own);
    const plan = await previewRuntimeMigration(options);
    expect(plan.changes.filter((c) => c.disposition === "conflict").map((c) => c.field)).toEqual(["runtime.agent", "runtime.limits.wall"]);
    expect(plan.problems.join("\n")).toContain(`${machinePath(home)}:runtime.agent`);
    await expect(applyRuntimeMigration(options)).rejects.toThrow("conflicts");
    expect(await text(recipePath("a", home))).toBe(own);
    expect((await machine()).runtime?.agent).toBe("codex");
  });

  it("keeps new recipe intent without injecting legacy discussion defaults", async () => {
    const options = await setup(null, ["a"]);
    const own = `${recipe}  agent: codex\ndiscussion: {runtime: {agent: codex, model: my-model}}\n`;
    await writeFile(recipePath("a", home), own);
    expect((await previewRuntimeMigration(options)).problems).toEqual([]);
    await applyRuntimeMigration(options);
    expect(await text(recipePath("a", home))).toBe(own);
    await expect(stat(join(home, "migrations"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains explicit/inherited unsupported Codex turns and refuses activation", async () => {
    const original = "runtime: {agent: codex, limits: {turns: 50}}\n";
    const options = await setup(original);
    const plan = await previewRuntimeMigration(options);
    expect(plan.problems.join("\n")).toMatch(/Codex cannot enforce explicit\/inherited turns 50/);
    expect(parse(plan.files[0]!.after!).runtime.limits.turns).toBe(50);
    await expect(applyRuntimeMigration(options)).rejects.toThrow("turns 50");
    expect(await text(machinePath(home))).toBe(original);
    await expect(resolveLocalRecipe("a", options)).rejects.toThrow(RuntimeMigrationRequired);
  });

  it.each(["recipe", "machine"])("resumes a crash after a %s write without duplicating YAML or losing global fields", async (kind) => {
    const original = "runtime: {agent: claude-code, limits: {turns: 17}}\n";
    const options = await setup(original);
    await expect(applyRuntimeMigration({ ...options, written: async (path) => {
      if (kind === "machine" ? path === machinePath(home) : path === recipePath("a", home)) throw new Error("simulated crash");
    } })).rejects.toThrow("simulated crash");
    const saved = await journal();
    expect(saved.complete).toBe(false);
    if (kind === "recipe") {
      expect(await text(machinePath(home))).toBe(original);
      await expect(resolveLocalRecipe("a", options)).rejects.toThrow(RuntimeMigrationRequired);
    }
    await expect(resolveLocalRecipe("a", options)).rejects.toThrow(RuntimeMigrationRequired);
    const preview = await previewRuntimeMigration(options);
    expect(preview.resuming).toBe(true); expect(preview.problems).toEqual([]);
    await applyRuntimeMigration(options);
    expect((await journal()).id).toBe(saved.id); expect((await journal()).complete).toBe(true);
    expect(legacyRuntimeFields(await machine())).toEqual([]);
    for (const p of ["a", "b"]) {
      expect((await text(recipePath(p, home))).match(/^discussion:/gm)).toHaveLength(1);
      expect((await resolveLocalRecipe(p, options)).runtimes?.development.limits.turns).toBe(17);
    }
  });

  it("refuses edited files on resume instead of overwriting them or deleting the source", async () => {
    const original = "runtime: {agent: claude-code}\n";
    const options = await setup(original);
    await expect(applyRuntimeMigration({ ...options, written: async () => { throw new Error("crash"); } })).rejects.toThrow("crash");
    await writeFile(recipePath("a", home), "# intervening edit\n" + await text(recipePath("a", home)));
    await expect(applyRuntimeMigration(options)).rejects.toThrow("changed since migration began");
    expect(await text(machinePath(home))).toBe(original);
  });

  it("read-back corruption and membership changes retain the global source", async () => {
    const original = "runtime: {agent: claude-code}\n";
    const options = await setup(original);
    await expect(applyRuntimeMigration({ ...options, written: async (path) => {
      await writeFile(path, await text(path) + "# intervening write\n");
    } })).rejects.toThrow("read-back validation");
    expect(await text(machinePath(home))).toBe(original);
  });

  it("rechecks registered membership before removing any machine fields", async () => {
    const original = "runtime: {agent: claude-code}\n";
    const options = await setup(original);
    let reads = 0;
    await expect(applyRuntimeMigration({ ...options, registered: async () => ++reads === 1
      ? [{ project: "a" }, { project: "b" }] : [{ project: "a" }, { project: "b" }, { project: "c" }] })).rejects.toThrow("registered projects changed");
    expect(await text(machinePath(home))).toBe(original);
  });

  it("does not race a live conductor or another apply", async () => {
    const options = await setup("runtime: {agent: claude-code}\n");
    const held = await createFileLocker({ dir: join(home, "locks") }).tryLock("lingtai:daemon", "live conductor");
    if (!held.ok) throw new Error("expected lock");
    try {
      await expect(applyRuntimeMigration(options)).rejects.toThrow("live conductor");
      expect(await text(recipePath("a", home))).toBe(recipe);
    } finally { await held.lock.release(); }
  });

  it("lists missing recipes and unregistered machine choices before any recipe mutation", async () => {
    const original = "runtime: {agent: claude-code}\nprojects: {absent: {runtime: {agent: codex}}}\n";
    const options = await setup(original);
    await rm(recipePath("b", home));
    const plan = await previewRuntimeMigration(options);
    expect(plan.problems.join("\n")).toContain("missing registered project recipe");
    expect(plan.problems.join("\n")).toContain("absent is not registered");
    await expect(applyRuntimeMigration(options)).rejects.toThrow("not registered");
    expect(await text(recipePath("a", home))).toBe(recipe);
    expect(await text(machinePath(home))).toBe(original);
  });

  it("supports dotted project names without changing unrelated machine fields", async () => {
    const options = await setup("projects: {a.runtime.b: {runtime: {agent: codex, assignee: {take: both}}}}\n", ["a.runtime.b"]);
    await applyRuntimeMigration(options);
    expect((await machine()).projects?.["a.runtime.b"]?.runtime).toEqual({ assignee: { take: "both" } });
    expect((await resolveLocalRecipe("a.runtime.b", options)).runtimes?.development.agent).toBe("codex");
  });
});
