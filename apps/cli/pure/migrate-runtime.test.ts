import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateRuntimeCommand, migrationProjects, type MigrationWorld } from "../src/migrate-runtime.ts";
import { isPending, projectStream, reduceProject } from "@lingtai/domain";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { resolveLocalRecipe } from "@lingtai/recipe";

let home: string;
let lines: string[];
let world: MigrationWorld;
const recipe = "version: 1\nrepo: {base: main}\nsource: {kinds: [bug]}\nenv: {plantAt: .env}\nruntime: {}\n";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "lingtai-migrate-cli-"));
  await mkdir(join(home, "app"));
  await writeFile(join(home, "app", "recipe.yml"), recipe);
  await writeFile(join(home, "config.yml"), "database: {url: postgres://user:private@localhost/db}\nruntime: {agent: claude-code, limits: {wall: 1h}}\n");
  lines = [];
  world = { home, registered: async () => [{ project: "app", base: "main" }],
    signedIn: async () => { throw new Error("recorded choice must not be detected"); }, log: (line) => lines.push(line) };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("runtime migration CLI", () => {
  it("migrates old pending onboarding files and releases its registration recipe read without scheduling", async () => {
    const store = createMemoryEventStore();
    const stream = projectStream("app");
    await store.append(stream, 0, [{type: "ProjectOnboardingStarted", actor: "human:test", data: {slug: "owner/app", base: "main", by: "human:test"}}]);
    const states = [reduceProject(await store.read(stream)), reduceProject([])];
    expect(isPending(states[0]!)).toBe(true);
    world.registered = async () => migrationProjects(states);
    expect(await world.registered()).toEqual([{project: "app", base: "main"}]);
    await writeFile(join(home, "config.yml"), "projects: {app: {runtime: {agent: codex}}}\n");
    await expect(resolveLocalRecipe("app", world)).rejects.toThrow("migrate-runtime");
    expect(await migrateRuntimeCommand(["--apply"], world)).toBe(0);
    expect((await resolveLocalRecipe("app", world)).runtimes?.development.agent).toBe("codex");
    expect((await store.read(stream)).map((e) => e.type)).toEqual(["ProjectOnboardingStarted"]);
    expect(isPending(reduceProject(await store.read(stream)))).toBe(true);
  });
  it("accepts per-project migration choices without requiring users to edit recipe intent", async () => {
    await rm(join(home, "config.yml"));
    world.signedIn = async () => ["claude-code", "codex"];
    expect(await migrateRuntimeCommand([], world)).toBe(1);
    expect(lines.join("\n")).toContain("--agent app=<claude-code|codex>");
    expect(await migrateRuntimeCommand(["--agent", "app=codex"], world)).toBe(0);
    expect(await readFile(join(home, "app", "recipe.yml"), "utf8")).toBe(recipe);
    expect(await migrateRuntimeCommand(["--agent", "app=codex", "--apply"], world)).toBe(0);
    expect((await resolveLocalRecipe("app", world)).runtimes?.discussion).toMatchObject({agent: "claude-code", limits: {turns: 40, wall: "5m"}});
  });
  it("rejects malformed, duplicate and unknown project choices without writing", async () => {
    expect(await migrateRuntimeCommand(["--agent"], world)).toBe(2);
    expect(await migrateRuntimeCommand(["--agent", "app=unknown"], world)).toBe(2);
    expect(await migrateRuntimeCommand(["--agent", "app=codex", "--agent", "app=claude-code"], world)).toBe(2);
    expect(await migrateRuntimeCommand(["--agent", "unknown=codex", "--apply"], world)).toBe(1);
    expect(await readdir(home)).toEqual(["app", "config.yml"]);
  });
  it("defaults to a read-only preview with source paths and never prints machine credentials", async () => {
    const before = await readFile(join(home, "config.yml"), "utf8");
    expect(await migrateRuntimeCommand([], world)).toBe(0);
    expect(await readdir(home)).toEqual(["app", "config.yml"]);
    expect(await readFile(join(home, "config.yml"), "utf8")).toBe(before);
    expect(await readFile(join(home, "app", "recipe.yml"), "utf8")).toBe(recipe);
    expect(lines.join("\n")).toContain(`${join(home, "config.yml")}:runtime.agent`);
    expect(lines.join("\n")).toContain("dry-run: nothing was written");
    expect(lines.join("\n")).not.toContain("private");
  });
  it("applies only when explicitly requested and reports where backups live", async () => {
    expect(await migrateRuntimeCommand(["--apply"], world)).toBe(0);
    expect(await readFile(join(home, "app", "recipe.yml"), "utf8")).toContain("agent: claude-code");
    expect(await readFile(join(home, "config.yml"), "utf8")).not.toContain("agent:");
    expect(lines.at(-1)).toContain("backups are under migrations/");
  });
  it("lists unresolved conflicts, returns failure and leaves all source files unchanged", async () => {
    const source = recipe.replace("runtime: {}", "runtime: {agent: codex}");
    await writeFile(join(home, "app", "recipe.yml"), source);
    expect(await migrateRuntimeCommand(["--apply"], world)).toBe(1);
    expect(lines.join("\n")).toContain("conflicts with");
    expect(await readdir(home)).toEqual(["app", "config.yml"]);
    expect(await readFile(join(home, "app", "recipe.yml"), "utf8")).toBe(source);
  });
  it("help and invalid arguments do not read registration or detect an agent", async () => {
    world.registered = async () => { throw new Error("must not read registration"); };
    expect(await migrateRuntimeCommand(["--help"], world)).toBe(0);
    expect(await migrateRuntimeCommand(["--apply", "--dry-run"], world)).toBe(2);
    expect(await migrateRuntimeCommand(["--yes"], world)).toBe(2);
  });
  it.each([["migrate-runtime", "--help"], ["upgrade", "--migrate-runtime", "--help"]])(
    "entry answers migration help without loading the event store: %s", async (...args) => {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        [new URL("../src/entry.ts", import.meta.url).pathname, ...args],
        { cwd: home, env: { PATH: process.env["PATH"], LINGTAI_HOME: home, LINGTAI_DATABASE_URL: "" } });
      expect(stdout).toContain("lingtai migrate-runtime [--dry-run | --apply]");
      expect(stderr).not.toContain("LINGTAI_DATABASE_URL");
    },
  );
});
